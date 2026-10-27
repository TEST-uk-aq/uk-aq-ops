"""TEST-only, source-neutral history cache events and independently retryable delivery.

Uses the existing retained Integrity run directory, not a new database/queue.
Planning reads only the pinned Dropbox baseline and final frozen local proposal.
Delivery uses only the immutable verified event, never R2 or reconciliation.
"""
from __future__ import annotations

from collections import defaultdict
from contextlib import contextmanager
import datetime as dt
import email.utils
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import struct
import subprocess
import tempfile
import time
from typing import Any, Callable, Mapping
import urllib.error
import urllib.request

CONTRACT = json.loads((Path(__file__).resolve().parents[4] / "config/uk_aq_history_cache.json").read_text())
SCOPE = re.compile(r"(?:^history/v[23]/observations/|^history/_index_v[23]/observations_timeseries/)(day_utc=\d{4}-\d{2}-\d{2}/connector_id=[1-9][0-9]*/pollutant_code=[a-z0-9_]+)(?:/|$)")
LAYERS = ("reader", "proxy")


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def identity(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            out.write(canonical(value) + "\n")
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def publication_identity(state: Mapping[str, Any]) -> str:
    return identity({
        "run_id": state["run_id"], "environment": state["environment"],
        # APPLY may legitimately merge day/global parents against live siblings.
        # Freeze immutable physical partition/index objects, not those finalizers.
        "objects": {key: {field: entry.get(field) for field in ("sha256", "bytes", "dependencies", "dependency_identities")}
                    for key, entry in sorted(state.get("objects", {}).items()) if SCOPE.match(key)},
        "tombstones": sorted(state.get("tombstones", {})),
        "prefixes": sorted(entry["prefix"] for entry in state.get("tombstone_prefixes", []) if entry.get("proposed")),
        "changed_scopes": state.get("changed_scopes"),
        "selected_authority": state.get("generic_integrity_selected_scope_authority"),
        "core_snapshot": state.get("core_snapshot_identity"),
    })


def _checked_body(path: Path, expected: Mapping[str, Any]) -> bytes:
    body = path.read_bytes()
    digest = expected.get("sha256", expected.get("etag_or_hash"))
    if (not re.fullmatch(r"[0-9a-f]{64}", str(digest or ""))
            or hashlib.sha256(body).hexdigest() != digest
            or len(body) != expected.get("bytes", expected.get("byte_size"))):
        raise ValueError("local_object_identity_mismatch")
    return body


def canonical_partition_metadata(*, rows: list, is_sos: bool, node_bin: str, hash_contract_version: int) -> dict:
    process = subprocess.run(
        [node_bin, str(Path(__file__).with_name("history_cache_rows.mjs"))],
        input=canonical({"rows": rows, "is_sos": is_sos, "hash_contract_version": hash_contract_version}),
        text=True, capture_output=True, timeout=60, check=False,
    )
    if process.returncode:
        raise ValueError("canonical_partition_normalization_unavailable")
    return json.loads(process.stdout)


def freeze_plan(state: Mapping[str, Any], generation: str, *, resolve_path: Callable,
                load_rows: Callable, node_bin: str = "node",
                preserved_outcomes: list | None = None) -> dict[str, Any]:
    """Compare exact per-physical content; preserve removals and empty final scopes."""
    if state.get("environment") != "TEST":
        return {"status": "skipped_not_test"}
    if generation not in {"v2", "v3"}:
        raise ValueError("invalid_history_generation")
    objects = state.get("objects", {})
    baseline = Path(state["base_dropbox_root"])
    scope_names = {match.group(1) for key in objects if (match := SCOPE.match(key))}
    scope_names.update(match.group(1) for key, entry in state.get("tombstones", {}).items()
                       if entry.get("proposed") and (match := SCOPE.match(key)))
    for entry in state.get("tombstone_prefixes", []):
        prefix = str(entry.get("prefix", ""))
        if not entry.get("proposed"):
            continue
        if match := SCOPE.match(prefix):
            scope_names.add(match.group(1))
        elif re.fullmatch(r"history/v[23]/observations/day_utc=\d{4}-\d{2}-\d{2}", prefix):
            # SOS-light complete-day removal: enumerate only this pinned local day.
            for manifest in (baseline / prefix).glob("connector_id=*/pollutant_code=*/manifest.json"):
                scope_names.add(manifest.parent.relative_to(baseline / f"history/{generation}/observations").as_posix())
    preserved = {f"day_utc={e['day_utc']}/connector_id={e['connector_id']}/pollutant_code={e['pollutant_code']}"
                 for e in (state.get("generic_integrity_selected_scope_authority") or {}).get("selected_scopes", [])
                 if e.get("outcome") == "source_artifact_unavailable_preserved"}
    for entry in preserved_outcomes or []:
        if entry.get("outcome") == "source_artifact_unavailable_preserved":
            for pollutant in entry.get("pollutant_codes", [entry.get("pollutant_code")]):
                preserved.add(f"day_utc={entry['day_utc']}/connector_id={entry['connector_id']}/pollutant_code={pollutant}")
    affected, unresolved = [], []
    if not scope_names and any(key.startswith((f"history/{generation}/observations/",
                                              f"history/_index_{generation}/observations_timeseries")) for key in objects):
        # A parent-only correction has no authenticated physical mapping here.
        # Never confuse that with a proven unchanged physical repair.
        unresolved.append({"reason": "published_parent_only_physical_mapping_unresolved"})

    def partition(scope: str, final: bool) -> tuple[dict[int, list[str]], dict[int, int | None]]:
        key = f"history/{generation}/observations/{scope}/manifest.json"
        manifest_path = resolve_path(state, key) if final else baseline / key
        if manifest_path is None or not manifest_path.is_file():
            return {}, {}
        entry = objects.get(key) if final else None
        body = _checked_body(manifest_path, entry) if entry else manifest_path.read_bytes()
        manifest = json.loads(body)
        if manifest.get("manifest_key") != key or not isinstance(manifest.get("files"), list):
            raise ValueError("partition_manifest_identity_invalid")
        row_count = manifest.get("row_count")
        if not isinstance(row_count, int) or isinstance(row_count, bool) or not 0 <= row_count <= 500000:
            raise ValueError("cache_identity_partition_row_bound_exceeded")
        if sum(int(file.get("bytes", 0)) for file in manifest["files"]) > 512 * 1024 * 1024:
            raise ValueError("cache_identity_partition_byte_bound_exceeded")
        paths = []
        requires_content_hash = False
        for file in manifest["files"]:
            file_key = str(file.get("key", ""))
            if not file_key.startswith(key.removesuffix("manifest.json")) or ".." in Path(file_key).parts:
                raise ValueError("partition_file_identity_invalid")
            path = resolve_path(state, file_key) if final else baseline / file_key
            if path is None:
                raise ValueError("partition_file_missing")
            digest = file.get("sha256", file.get("etag_or_hash"))
            if re.fullmatch(r"[0-9a-f]{64}", str(digest or "")):
                _checked_body(path, file)
            else:
                # Historical manifests may retain an opaque R2 ETag. Authenticate
                # their rows using the existing canonical partition hash instead.
                if path.stat().st_size != file.get("bytes"):
                    raise ValueError("partition_file_byte_identity_invalid")
                requires_content_hash = True
            paths.append(str(path))
        rows = load_rows(parquet_paths=paths) if paths else []
        metadata = canonical_partition_metadata(rows=rows, is_sos="connector_id=1/" in scope, node_bin=node_bin,
                                                hash_contract_version=manifest.get("observation_content_hash_contract_version", 1))
        if requires_content_hash and metadata.get("observation_content_hash") != manifest.get("observation_content_hash"):
            raise ValueError("baseline_partition_content_identity_invalid")
        rows = metadata["canonical_rows"]
        by_id, stations = defaultdict(list), {}
        day, connector, pollutant = (part.split("=", 1)[1] for part in scope.split("/"))
        for row in rows:
            ts = int(row["timeseries_id"])
            station = int(row["station_id"]) if row["station_id"] is not None else None
            timestamp = str(row["observed_at_utc"])
            value = float(row["value"])
            if (ts <= 0 or (station is not None and station <= 0) or int(row["connector_id"]) != int(connector)
                    or row["pollutant_code"] != pollutant or timestamp[:10] != day or not math.isfinite(value)):
                raise ValueError("partition_row_identity_invalid")
            if ts in stations and stations[ts] != station:
                raise ValueError("physical_station_identity_conflict")
            stations[ts] = station
            by_id[ts].append(canonical([station, timestamp, struct.pack(">d", value).hex(),
                                       row.get("verification_status", row.get("status"))]))
        if len(rows) != manifest.get("row_count"):
            raise ValueError("partition_row_count_invalid")
        return {ts: sorted(values) for ts, values in by_id.items()}, stations

    for scope in sorted(scope_names - preserved):
        day, connector, pollutant = (part.split("=", 1)[1] for part in scope.split("/"))
        try:
            before, before_stations = partition(scope, False)
            after, after_stations = partition(scope, True)
            changed = {ts for ts in before.keys() | after.keys() if before.get(ts, []) != after.get(ts, [])}
            metadata = set()
            # Index corrections can coexist with another physical member's data change.
            index_prefix = f"history/_index_{generation}/observations_timeseries/{scope}/"
            for key, entry in objects.items():
                if not key.startswith(index_prefix):
                    continue
                match = re.fullmatch(re.escape(index_prefix) + r"timeseries_id=([0-9]+)\.json", key)
                old = baseline / key
                new = _checked_body(Path(entry["local_path"]), entry)
                if old.is_file() and old.read_bytes() == new:
                    continue
                if match:
                    ts = int(match.group(1))
                    if ts not in before and ts not in after:
                        raise ValueError("index_physical_mapping_unresolved")
                    # A changed leaf may only carry a new shared source-manifest
                    # digest. Compare its reader-visible fields independently.
                    leaf = json.loads(new)
                    prior = json.loads(old.read_bytes()) if old.is_file() else {}
                    def visible(value):
                        if changed:
                            # Shared file hashes/offsets move on another member's
                            # repair; that alone does not change this member.
                            return {k: value.get(k) for k in ("timeseries_id", "row_count", "min_observed_at_utc", "max_observed_at_utc")}
                        return {k: v for k, v in value.items() if k != "source_aligned_child"}
                    if visible(leaf) != visible(prior):
                        metadata.add(ts)
                elif key.endswith("/manifest.json"):
                    if generation == "v2" and not changed:
                        metadata.update(before.keys() | after.keys())
                    elif generation == "v3":
                        root = json.loads(new).get("leaves_by_timeseries_id", {})
                        prior = json.loads(old.read_bytes()).get("leaves_by_timeseries_id", {}) if old.is_file() else {}
                        # Descriptor hashes naturally change on repair; only
                        # changed membership is an additional physical dependency.
                        for value in root.keys() ^ prior.keys():
                            ts = int(value)
                            if ts not in before and ts not in after:
                                raise ValueError("index_physical_mapping_unresolved")
                            metadata.add(ts)
            for ts in sorted(changed | metadata):
                affected.append({"day_utc": day, "connector_id": int(connector), "pollutant": pollutant,
                                 "timeseries_id": ts, "station_id": after_stations.get(ts, before_stations.get(ts)),
                                 "change": "metadata_index_correction" if ts not in changed else
                                 "authoritative_removal" if ts not in after else "data_replacement"})
        except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.SubprocessError) as exc:
            # Bounded classification only: local helper errors may contain private paths/payloads.
            unresolved.append({"scope": scope, "reason": type(exc).__name__ + ":scope_identity_unresolved"})
    plan = {"status": "unresolved" if unresolved else "frozen", "generation": generation,
            "publication_identity_sha256": publication_identity(state), "affected": affected,
            "unresolved_scopes": unresolved, "excluded_preserved_scopes": sorted(preserved)}
    return {**plan, "identity_sha256": identity(plan)}


def prepare_verified_event(state: Mapping[str, Any], *, final: Mapping[str, Any],
                           apply_result: Mapping[str, Any], dry_run: bool) -> dict[str, Any]:
    if state.get("environment") != "TEST" or dry_run or state.get("effective_mode") == "check_only":
        return {"status": "skipped_not_applicable"}
    if apply_result.get("status") != "succeeded" or final.get("ran") is not True or final.get("status") != "ok":
        return {"status": "skipped_unverified"}
    plan = dict(state.get("history_cache_plan") or {})
    plan_hash = plan.pop("identity_sha256", None)
    if plan_hash != identity(plan) or plan.get("publication_identity_sha256") != publication_identity(state):
        plan = {"generation": state.get("history_cache_generation"), "affected": [],
                "unresolved_scopes": [{"reason": "frozen_cache_plan_unavailable_or_changed"}]}
    tags = sorted({CONTRACT["tag_template"].format(generation=plan["generation"], timeseries_id=e["timeseries_id"])
                   for e in plan["affected"]})
    event = {"schema_version": 1, "environment": "TEST", "run_id": state["run_id"],
             "generation": plan["generation"], "publication_identity_sha256": publication_identity(state),
             "final_verification_identity_sha256": identity(final), "final_verification": dict(final),
             "affected": plan["affected"], "tags": tags, "unresolved_scopes": plan["unresolved_scopes"],
             "cache_layers": list(LAYERS), "created_at_utc": now()}
    path = Path(state["run_root"]) / "history-cache-invalidation.json"
    if path.exists():
        envelope = json.loads(path.read_text())
        prior = envelope["event"]
        if (identity(prior) != envelope["event_identity_sha256"] or
                {k: v for k, v in prior.items() if k != "created_at_utc"} !=
                {k: v for k, v in event.items() if k != "created_at_utc"}):
            raise ValueError("existing_cache_event_identity_conflict")
        event = prior  # Recover persistence without resetting accepted deliveries.
    else:
        envelope = {"event": event, "event_identity_sha256": identity(event), "attempts": [],
                    "layers": {layer: {"accepted_tags": [], "status": "pending", "retryable": True} for layer in LAYERS}}
        atomic_json(path, envelope)
    return {"status": envelope.get("status", "pending"), "retryable": envelope.get("retryable", True), "event_path": str(path),
            "event_identity_sha256": identity(event), "affected_timeseries_count": len(tags),
            "unresolved_scope_count": len(event["unresolved_scopes"])}


@contextmanager
def delivery_lock(path: Path):
    with path.open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def _retry_after(value: str | None) -> float:
    try:
        return max(12, min(86400, float(value or 60)))
    except ValueError:
        try:
            return max(12, min(86400, email.utils.parsedate_to_datetime(value).timestamp() - time.time()))
        except (TypeError, ValueError):
            return 60


def deliver(state_path: Path, settings: Mapping[str, str], *, max_batches: int = 10) -> dict[str, Any]:
    """One bounded invocation; accepted chunks are never unnecessarily replayed."""
    if settings.get("UK_AQ_ENV_NAME") != "TEST" or not 1 <= max_batches <= 10:
        raise ValueError("TEST operator boundary or delivery bound invalid")
    state = json.loads(state_path.read_text())
    reference = state.get("history_cache_invalidation") or {}
    if not reference.get("event_path"):
        return {"status": "skipped_no_verified_event", "retryable": False}
    path = Path(reference["event_path"])
    if path.resolve() != state_path.parent.resolve() / "history-cache-invalidation.json" or state.get("environment") != "TEST":
        raise ValueError("cache_event_run_boundary_invalid")
    with delivery_lock(path.with_suffix(".lock")):
        audit = json.loads(path.read_text())
        event = audit["event"]
        if (identity(event) != audit["event_identity_sha256"] or identity(event) != reference["event_identity_sha256"]
                or event["environment"] != "TEST" or event["run_id"] != state["run_id"]
                or event["publication_identity_sha256"] != publication_identity(state)
                or event["final_verification"].get("status") != "ok"
                or event["final_verification"].get("ran") is not True
                or identity(event["final_verification"]) != event["final_verification_identity_sha256"]):
            raise ValueError("verified_cache_event_identity_invalid")
        expected_tags = sorted({CONTRACT["tag_template"].format(generation=event["generation"], timeseries_id=e["timeseries_id"])
                                for e in event["affected"]})
        if event["generation"] not in {"v2", "v3"} or event["tags"] != expected_tags:
            raise ValueError("verified_cache_tag_set_invalid")
        if any(not set(audit["layers"][layer]["accepted_tags"]).issubset(event["tags"]) for layer in LAYERS):
            raise ValueError("cache_delivery_accepted_tag_set_invalid")
        invocation = {"started_at_utc": now(), "requests": [], "kind": "initial" if not audit["attempts"] else "retry"}
        # Retain every invocation in its own artifact; the latest aggregate stays bounded.
        attempt_number = int(audit.get("attempt_count", 0)) + 1
        audit["attempt_count"] = attempt_number
        audit["attempts"] = [invocation]
        attempt_path = path.parent / f"history-cache-invalidation-attempt-{attempt_number:06d}.json"
        atomic_json(path, audit)
        request_count = 0
        for layer in LAYERS:
            result = audit["layers"][layer]
            result["attempted_at_utc"] = now()
            requests_before = request_count
            pending = [tag for tag in event["tags"] if tag not in result["accepted_tags"]]
            zone = str(settings.get(f"UK_AQ_HISTORY_CACHE_{layer.upper()}_ZONE_ID") or "").strip()
            token = str(settings.get(f"UK_AQ_HISTORY_CACHE_{layer.upper()}_PURGE_TOKEN") or "").strip()
            if pending and (not re.fullmatch(r"[0-9a-f]{32}", zone) or not token):
                result.update(status="pending", retryable=True, error="missing_scoped_purge_configuration")
            elif pending and time.time() < float(result.get("retry_not_before_epoch", 0)):
                result.update(status="partial" if result["accepted_tags"] else "pending", retryable=True)
            else:
                for offset in range(0, len(pending), CONTRACT["purge_batch_size"]):
                    if request_count >= max_batches:
                        break
                    if offset:
                        time.sleep(12)  # Free-plan 5/minute limit, independently per owning account.
                    chunk = pending[offset:offset + CONTRACT["purge_batch_size"]]
                    attempt = {"layer": layer, "zone_id": zone, "zone_name": CONTRACT[f"{layer}_zone_name"],
                               "tags": chunk, "started_at_utc": now(), "status": "pending"}
                    invocation["requests"].append(attempt)
                    atomic_json(path, audit)
                    atomic_json(attempt_path, invocation)
                    request_count += 1
                    req = urllib.request.Request(f"https://api.cloudflare.com/client/v4/zones/{zone}/purge_cache",
                        data=canonical({"tags": chunk}).encode(), method="POST",
                        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
                    retry_delay = 12
                    try:
                        with urllib.request.urlopen(req, timeout=20) as response:
                            body = response.read(65537)
                            if len(body) > 65536:
                                raise ValueError("purge_response_too_large")
                            payload = json.loads(body)
                            if not isinstance(payload, dict):
                                raise ValueError("purge_response_not_object")
                            accepted = response.status == 200 and payload.get("success") is True and not payload.get("errors")
                            attempt["http_status"] = response.status
                            if not accepted:
                                attempt["error"] = "cloudflare_rejected_request"
                                attempt["error_codes"] = [int(e["code"]) for e in payload.get("errors", [])[:5] if isinstance(e, dict) and isinstance(e.get("code"), int)]
                    except urllib.error.HTTPError as exc:
                        accepted = False
                        attempt.update(http_status=exc.code, error="cloudflare_http_error")
                        retry_delay = _retry_after(exc.headers.get("Retry-After"))
                    except (OSError, ValueError, urllib.error.URLError):
                        accepted = False
                        attempt["error"] = "purge_transport_or_response_error"
                    attempt.update(status="accepted" if accepted else "failed", finished_at_utc=now(), retryable=not accepted)
                    result["retry_not_before_epoch"] = time.time() + retry_delay
                    if accepted:
                        result["accepted_tags"] = sorted(set(result["accepted_tags"]) | set(chunk))
                        result.pop("error", None)
                    else:
                        result["error"] = attempt["error"]
                    atomic_json(path, audit)
                    atomic_json(attempt_path, invocation)
                    if not accepted:
                        break
                remaining = set(event["tags"]) - set(result["accepted_tags"])
                result.update(status="accepted" if not remaining else "partial" if result["accepted_tags"] else "pending" if request_count == requests_before else "failed",
                              retryable=bool(remaining))
            atomic_json(path, audit)
        statuses = [audit["layers"][layer]["status"] for layer in LAYERS]
        audit["status"] = ("pending" if event["unresolved_scopes"] else "accepted" if all(s == "accepted" for s in statuses)
                           else "partial" if any(s in {"accepted", "partial"} for s in statuses) else "pending" if "pending" in statuses else "failed")
        if not event["tags"] and not event["unresolved_scopes"]:
            audit["status"] = "not_required"
        audit["retryable"] = audit["status"] not in {"accepted", "not_required"}
        invocation["finished_at_utc"] = now()
        invocation["status"] = audit["status"]
        atomic_json(attempt_path, invocation)
        atomic_json(path, audit)
        result = {"status": audit["status"], "retryable": audit["retryable"], "event_path": str(path),
                "event_identity_sha256": audit["event_identity_sha256"], "attempt_number": attempt_number,
                "affected_timeseries_count": len(event["tags"]), "unresolved_scope_count": len(event["unresolved_scopes"]),
                "layers": audit["layers"]}
        state["history_cache_invalidation"] = result
        atomic_json(state_path, state)
        return result


def deliver_after_lock(*, state_path: Path, settings: Mapping[str, str], log_path: Path,
                       report_path: Path) -> None:
    """Failures never change the already completed repair's exit status."""
    if settings.get("UK_AQ_ENV_NAME") != "TEST" or not state_path.is_file():
        return
    try:
        result = deliver(state_path, settings)
    except Exception as exc:
        result = {"status": "pending", "retryable": True, "error": type(exc).__name__ + ":cache_delivery_unavailable",
                  "run_state_path": str(state_path)}
    with log_path.open("a", encoding="utf-8") as out:
        out.write("\nHistory cache invalidation (after global-lock release): " + canonical(result) + "\n")
    print("History cache invalidation: " + result["status"] + "; audit=" + str(result.get("event_path", state_path)), flush=True)
    if report_path.is_file():
        report = json.loads(report_path.read_text())
        report["history_cache_invalidation"] = result
        atomic_json(report_path, report)
        with report_path.with_suffix(".md").open("a", encoding="utf-8") as out:
            out.write("\n## Post-lock history cache invalidation\n\n" + canonical(result) + "\n")
