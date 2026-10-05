#!/usr/bin/env python3
"""Acquire verification source evidence through active Integrity adapters.

This helper deliberately emits semantic candidate inputs separately from the
volatile acquisition audit consumed by the Node coordinator.
"""

from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import json
import logging
import os
from pathlib import Path
import sys
import time
from typing import Any, Mapping


REPO_ROOT = Path(__file__).resolve().parents[3]
INTEGRITY_IMPL = (
    REPO_ROOT
    / "scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3_impl.py"
)
INTEGRITY_BIN_DIR = INTEGRITY_IMPL.parent
if str(INTEGRITY_BIN_DIR) not in sys.path:
    sys.path.insert(0, str(INTEGRITY_BIN_DIR))

from integrity import official_network_rdata
from integrity.timeseries_binding_provider import (
    STABLE_BINDING_HISTORY_VERSION,
    STABLE_BINDING_INDEX_KIND,
    STABLE_BINDING_SCHEMA_VERSIONS,
    authenticated_packed_binding_generation,
)


OFFICIAL_VERIFICATION_POLLUTANTS = frozenset(("no2", "o3", "pm10", "pm25"))


def load_integrity() -> Any:
    bin_dir = str(INTEGRITY_IMPL.parent)
    if bin_dir not in sys.path:
        sys.path.insert(0, bin_dir)
    spec = importlib.util.spec_from_file_location(
        "uk_aq_integrity_verification_source", INTEGRITY_IMPL
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load Integrity implementation: {INTEGRITY_IMPL}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _reject_duplicate_object_keys(
    pairs: list[tuple[str, Any]],
) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate binding JSON key: {key}")
        result[key] = value
    return result


def _positive_integer(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{label} must be a positive integer")
    return value


def retained_official_binding_members(
    authenticated_members: Mapping[int, bytes],
    *,
    connector_id: int,
    selected_pollutants: frozenset[str] = OFFICIAL_VERIFICATION_POLLUTANTS,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Validate and select retained physical bindings from authenticated bytes."""
    retained: list[dict[str, Any]] = []
    connector_member_count = 0
    excluded_pollutant_count = 0
    seen_selected_ids: set[int] = set()
    for packed_timeseries_id, body in sorted(authenticated_members.items()):
        try:
            raw = json.loads(
                body.decode("utf-8"),
                object_pairs_hook=_reject_duplicate_object_keys,
            )
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            raise ValueError(
                f"authenticated binding member {packed_timeseries_id} is invalid JSON"
            ) from exc
        if not isinstance(raw, Mapping):
            raise ValueError(
                f"authenticated binding member {packed_timeseries_id} must be an object"
            )
        member_connector_id = _positive_integer(
            raw.get("connector_id"),
            f"binding {packed_timeseries_id} connector_id",
        )
        if member_connector_id != connector_id:
            continue
        connector_member_count += 1
        schema_version = raw.get("schema_version")
        if (
            isinstance(schema_version, bool)
            or not isinstance(schema_version, int)
            or schema_version not in STABLE_BINDING_SCHEMA_VERSIONS
        ):
            raise ValueError(
                f"binding {packed_timeseries_id} has unsupported stable schema_version: "
                f"{schema_version!r}"
            )
        if raw.get("history_version") != STABLE_BINDING_HISTORY_VERSION:
            raise ValueError(
                f"binding {packed_timeseries_id} has unsupported stable history_version: "
                f"{raw.get('history_version')!r}"
            )
        if raw.get("index_kind") != STABLE_BINDING_INDEX_KIND:
            raise ValueError(
                f"binding {packed_timeseries_id} has unsupported stable index_kind: "
                f"{raw.get('index_kind')!r}"
            )
        pollutant_code = str(raw.get("pollutant_code") or "").strip().lower()
        if not pollutant_code:
            raise ValueError(
                f"binding {packed_timeseries_id} pollutant_code must be non-empty"
            )
        if pollutant_code not in selected_pollutants:
            excluded_pollutant_count += 1
            continue
        timeseries_id = _positive_integer(
            raw.get("timeseries_id"),
            f"binding {packed_timeseries_id} timeseries_id",
        )
        if timeseries_id != int(packed_timeseries_id):
            raise ValueError(
                f"binding {packed_timeseries_id} timeseries identity is contradictory"
            )
        if timeseries_id in seen_selected_ids:
            raise ValueError(
                f"duplicate retained selected timeseries identity: {timeseries_id}"
            )
        seen_selected_ids.add(timeseries_id)
        identity = {
            "connector_id": member_connector_id,
            "timeseries_id": timeseries_id,
            "station_id": _positive_integer(
                raw.get("station_id"),
                f"binding {timeseries_id} station_id",
            ),
            "pollutant_code": pollutant_code,
        }
        for field in ("phenomenon_id", "observed_property_id"):
            if raw.get(field) is not None:
                identity[field] = _positive_integer(
                    raw.get(field), f"binding {timeseries_id} {field}"
                )
        retained.append(identity)
    retained.sort(key=lambda item: item["timeseries_id"])
    return retained, {
        "retained_connector_timeseries_count": connector_member_count,
        "retained_selected_timeseries_count": len(retained),
        "retained_unselected_timeseries_count": excluded_pollutant_count,
    }


def resolve_retained_station_identities(
    conn: Any,
    retained_bindings: list[dict[str, Any]],
    *,
    connector_id: int,
) -> list[dict[str, Any]]:
    """Resolve every retained station through the already pinned core snapshot."""
    resolved: list[dict[str, Any]] = []
    for binding in retained_bindings:
        rows = conn.execute(
            "SELECT id, connector_id, station_ref "
            "FROM core_stations_snapshot WHERE id = ?",
            (binding["station_id"],),
        ).fetchall()
        if len(rows) != 1:
            raise ValueError(
                "retained binding station identity is missing or ambiguous: "
                f"timeseries_id={binding['timeseries_id']} "
                f"station_id={binding['station_id']} matches={len(rows)}"
            )
        station_id, station_connector_id, station_ref = rows[0]
        resolved_station_id = _positive_integer(
            station_id, f"retained binding {binding['timeseries_id']} core station id"
        )
        resolved_connector_id = _positive_integer(
            station_connector_id,
            f"retained binding {binding['timeseries_id']} core station connector_id",
        )
        if resolved_station_id != binding["station_id"]:
            raise ValueError(
                f"retained binding {binding['timeseries_id']} station identity is contradictory"
            )
        if resolved_connector_id != connector_id:
            raise ValueError(
                f"retained binding {binding['timeseries_id']} station connector is contradictory"
            )
        site_code = str(station_ref or "").strip().upper()
        if not site_code:
            raise ValueError(
                f"retained binding {binding['timeseries_id']} station_ref is blank"
            )
        resolved.append({**binding, "site_code": site_code})
    return resolved


def active_selected_core_timeseries_ids(
    active_bindings: Mapping[str, Mapping[str, Mapping[str, Any]]],
) -> list[int]:
    """Return a deterministic, contradiction-free active selected core set."""
    timeseries_ids: list[int] = []
    seen: set[int] = set()
    for site_code, pollutant_bindings in sorted(active_bindings.items()):
        if not str(site_code or "").strip():
            raise ValueError("active selected core binding has a blank site identity")
        for pollutant_code, binding in sorted(pollutant_bindings.items()):
            normalized_pollutant = str(pollutant_code or "").strip().lower()
            if normalized_pollutant not in OFFICIAL_VERIFICATION_POLLUTANTS:
                raise ValueError(
                    "active selected core binding has contradictory pollutant identity: "
                    f"{pollutant_code!r}"
                )
            timeseries_id = _positive_integer(
                binding.get("timeseries_id"), "active binding timeseries_id"
            )
            _positive_integer(
                binding.get("station_id"),
                f"active binding {timeseries_id} station_id",
            )
            if timeseries_id in seen:
                raise ValueError(
                    f"duplicate active selected core timeseries identity: {timeseries_id}"
                )
            seen.add(timeseries_id)
            timeseries_ids.append(timeseries_id)
    return sorted(timeseries_ids)


def retained_scope_coverage_readiness(
    *,
    provider_audit: Mapping[str, Any],
    connector_id: int,
    scope_counts: Mapping[str, int],
    retained_timeseries_ids: list[int],
    station_identity_timeseries_ids: list[int],
    metadata_identity_timeseries_ids: list[int],
    candidate_timeseries_ids: list[int],
    active_selected_timeseries_ids: list[int],
) -> dict[str, Any]:
    retained_set = set(retained_timeseries_ids)
    station_set = set(station_identity_timeseries_ids)
    metadata_set = set(metadata_identity_timeseries_ids)
    candidate_set = set(candidate_timeseries_ids)
    active_set = set(active_selected_timeseries_ids)
    active_retained_intersection = active_set.intersection(retained_set)
    active_missing_from_retained = sorted(active_set - retained_set)
    reasons: list[str] = []
    if provider_audit.get("authenticated_generation_complete") is not True:
        reasons.append("complete packed binding generation was not authenticated")
    if provider_audit.get("observation_generation") != "v3":
        reasons.append("authenticated binding generation is not v3")
    if len(retained_timeseries_ids) != len(retained_set):
        reasons.append("retained selected scope contains duplicate timeseries IDs")
    if len(active_selected_timeseries_ids) != len(active_set):
        reasons.append("active selected core scope contains duplicate timeseries IDs")
    if active_missing_from_retained:
        reasons.append(
            "active core timeseries are missing from retained binding authority: "
            + ",".join(str(value) for value in active_missing_from_retained)
        )
    if station_set != retained_set:
        reasons.append("pinned-core station identity does not cover retained selected scope")
    if metadata_set != retained_set:
        reasons.append("official metadata identity does not cover retained selected scope")
    if len(candidate_timeseries_ids) != len(candidate_set) or candidate_set != retained_set:
        reasons.append("candidate scope does not exactly equal retained selected scope")
    retained_count = len(retained_set)
    if int(scope_counts.get("retained_selected_timeseries_count", -1)) != retained_count:
        reasons.append("retained selected scope count is contradictory")
    evidence = {
        "binding_scope": "authenticated_retained_v3_binding_pack",
        "observation_generation": "v3",
        "binding_source_root_hash": provider_audit.get("source_root_hash"),
        "pack_root_relative_path": provider_audit.get("pack_root_relative_path"),
        "pack_root_sha256": provider_audit.get("pack_root_sha256"),
        "ranges_verified": provider_audit.get("ranges_verified"),
        "total_pack_members_verified": provider_audit.get(
            "total_pack_members_verified"
        ),
        "connector_id": connector_id,
        "retained_connector_timeseries_count": int(
            scope_counts.get("retained_connector_timeseries_count", 0)
        ),
        "retained_selected_timeseries_count": retained_count,
        "active_selected_timeseries_count": len(active_set),
        "active_selected_retained_intersection_count": len(
            active_retained_intersection
        ),
        "active_selected_missing_from_retained_count": len(
            active_missing_from_retained
        ),
        "active_selected_missing_from_retained_timeseries_ids": (
            active_missing_from_retained
        ),
        "inactive_retained_selected_timeseries_count": (
            retained_count - len(active_retained_intersection)
        ),
        "station_identity_resolved_count": len(station_set),
        "metadata_identity_resolved_count": len(metadata_set),
        "candidate_timeseries_count": len(candidate_timeseries_ids),
    }
    return {
        "publishable": not reasons,
        "reason": "; ".join(reasons) if reasons else None,
        **evidence,
    }


def build_official_retained_verification_scope(
    *,
    conn: Any,
    source_key: str,
    connector_id: int,
    authenticated_members: Mapping[int, bytes],
    provider_audit: Mapping[str, Any],
    active_selected_timeseries_ids: list[int],
    metadata_rows: list[Mapping[str, Any]],
) -> tuple[
    list[dict[str, Any]],
    list[dict[str, Any]],
    dict[str, Any],
    dict[str, Any],
]:
    retained, scope_counts = retained_official_binding_members(
        authenticated_members,
        connector_id=connector_id,
    )
    if not retained:
        raise ValueError(
            f"{source_key} authenticated binding generation has no retained selected scope"
        )
    resolved = resolve_retained_station_identities(
        conn, retained, connector_id=connector_id
    )
    candidate_rows: list[dict[str, Any]] = []
    boundaries: list[dict[str, Any]] = []
    metadata_resolved_ids: list[int] = []
    for binding in resolved:
        pollutant_code = binding["pollutant_code"]
        try:
            boundary, raw = official_network_rdata.metadata_boundary(
                metadata_rows,
                site_code=binding["site_code"],
                pollutant_code=pollutant_code,
            )
        except (KeyError, ValueError) as exc:
            raise ValueError(
                f"{source_key} retained binding metadata identity failed: "
                f"timeseries_id={binding['timeseries_id']} "
                f"site_id={binding['site_code']} pollutant={pollutant_code}: {exc}"
            ) from exc
        canonical_boundary = boundary.isoformat() if boundary else None
        candidate_rows.append({
            "connector_id": connector_id,
            "station_id": binding["station_id"],
            "timeseries_id": binding["timeseries_id"],
            "pollutant_code": pollutant_code,
            "site_id": binding["site_code"],
            "parameter": official_network_rdata.POLLUTANT_TO_METADATA_PARAMETER[
                pollutant_code
            ],
            "ratified_to": canonical_boundary,
        })
        boundary_audit = {
            "site_id": binding["site_code"],
            "parameter": official_network_rdata.POLLUTANT_TO_METADATA_PARAMETER[
                pollutant_code
            ],
            "station_id": binding["station_id"],
            "timeseries_id": binding["timeseries_id"],
            "pollutant_code": pollutant_code,
            "raw_ratified_to": raw,
            "canonical_ratified_to": canonical_boundary,
        }
        for field in ("phenomenon_id", "observed_property_id"):
            if field in binding:
                boundary_audit[field] = binding[field]
        boundaries.append(boundary_audit)
        metadata_resolved_ids.append(binding["timeseries_id"])

    candidate_rows.sort(key=lambda item: item["timeseries_id"])
    boundaries.sort(key=lambda item: item["timeseries_id"])
    retained_ids = [item["timeseries_id"] for item in retained]
    resolved_ids = [item["timeseries_id"] for item in resolved]
    candidate_ids = [item["timeseries_id"] for item in candidate_rows]
    readiness = retained_scope_coverage_readiness(
        provider_audit=provider_audit,
        connector_id=connector_id,
        scope_counts=scope_counts,
        retained_timeseries_ids=retained_ids,
        station_identity_timeseries_ids=resolved_ids,
        metadata_identity_timeseries_ids=metadata_resolved_ids,
        candidate_timeseries_ids=candidate_ids,
        active_selected_timeseries_ids=active_selected_timeseries_ids,
    )
    retained_scope_audit = {
        **{
            key: value
            for key, value in readiness.items()
            if key not in {"publishable", "reason"}
        },
        "retained_unselected_timeseries_count": scope_counts[
            "retained_unselected_timeseries_count"
        ],
        "retained_selected_bindings": boundaries,
    }
    return candidate_rows, boundaries, readiness, retained_scope_audit


def iso_days(first: str, last: str) -> list[str]:
    start = dt.date.fromisoformat(first)
    end = dt.date.fromisoformat(last)
    if start > end:
        raise ValueError("--from-day must not be after --to-day")
    return [
        (start + dt.timedelta(days=offset)).isoformat()
        for offset in range((end - start).days + 1)
    ]


def property_mappings(conn: Any) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT connector_id, source_label, source_uom, observed_property_id,
               observed_property_code, mapping_kind, is_aqi_eligible, is_active
        FROM core_observed_property_mappings_snapshot
        WHERE connector_id = 1
        ORDER BY source_label, id
        """
    ).fetchall()
    return [
        {
            "connector_id": int(row[0]),
            "source_label": str(row[1] or ""),
            "source_uom": row[2],
            "observed_property_id": int(row[3]) if row[3] is not None else None,
            "observed_property_code": row[4],
            "mapping_kind": str(row[5] or "unknown"),
            "is_aqi_eligible": bool(row[6]),
            "is_active": bool(row[7]),
        }
        for row in rows
    ]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, choices=("sos", "waqn", "saqn"))
    parser.add_argument("--env", required=True, choices=("TEST", "LIVE"))
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--from-day")
    parser.add_argument("--to-day")
    args = parser.parse_args()

    run_dir = Path(args.run_dir).resolve()
    run_dir.mkdir(parents=True, exist_ok=True)
    log = logging.getLogger("observation-verification-source")
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(levelname)s %(message)s")
    integrity = load_integrity()
    environment = dict(os.environ)
    environment.setdefault(
        "UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR", str(run_dir / "source-cache")
    )
    core_root = integrity.resolve_core_snapshot_root("v3", environment)
    if not core_root:
        raise RuntimeError(
            "generation-aware core root is unavailable; configure the existing "
            "UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT or R2 history local-root setting"
        )
    selected = integrity.select_latest_complete_core_snapshot(Path(core_root), log)
    conn = integrity.open_db(str(run_dir / "pinned-core.sqlite"))
    try:
        imported = integrity.import_core_snapshot(
            conn,
            args.env,
            core_root,
            False,
            False,
            log,
            selected_snapshot=selected,
        )
        if imported.get("status") not in {"imported", "reused"}:
            raise RuntimeError(
                f"pinned core import failed: status={imported.get('status')} "
                f"error={imported.get('error')}"
            )
        core_identity = imported.get("core_snapshot_identity")
        if not isinstance(core_identity, dict):
            raise RuntimeError("pinned core import returned no authenticated identity")

        if args.source in {"waqn", "saqn"}:
            config = integrity.OFFICIAL_RDATA_NETWORKS[args.source]
            (
                active_bindings,
                active_mapping_hash,
                active_observed_property_hash,
                active_mapping_audit,
            ) = integrity._official_rdata_bindings(
                conn,
                source_key=args.source,
                selected_pollutants=sorted(OFFICIAL_VERIFICATION_POLLUTANTS),
            )
            active_selected_timeseries = active_selected_core_timeseries_ids(
                active_bindings
            )
            pack_root = str(
                environment.get("UK_AQ_R2_HISTORY_DROPBOX_ROOT") or ""
            ).strip()
            if not pack_root:
                raise RuntimeError(
                    "R2 history Dropbox root is unavailable for retained binding authentication"
                )
            authenticated_members, binding_provider_audit = (
                authenticated_packed_binding_generation(
                    Path(pack_root), observation_generation="v3"
                )
            )
            metadata_url = config.base_url.rstrip("/") + "/" + config.metadata_filename
            metadata_path = run_dir / "source" / config.metadata_filename
            pinned = integrity.download_official_rdata_pinned(
                metadata_url, metadata_path
            )
            metadata_rows = integrity.extract_official_rdata_metadata(
                metadata_path, config=config
            )
            decoder = integrity.official_rdata_rscript_identity()
            (
                candidate_rows,
                boundaries,
                coverage_readiness,
                retained_scope_audit,
            ) = build_official_retained_verification_scope(
                conn=conn,
                source_key=args.source,
                connector_id=config.connector_id,
                authenticated_members=authenticated_members,
                provider_audit=binding_provider_audit,
                active_selected_timeseries_ids=active_selected_timeseries,
                metadata_rows=metadata_rows,
            )
            result = {
                "schema_version": 1,
                "source": args.source,
                "connector_id": config.connector_id,
                "core_identity": core_identity,
                "semantic_source_identity": {
                    "source_system": "official-network-rdata",
                    "network": args.source,
                    "connector_id": config.connector_id,
                    "metadata_url_family": metadata_url,
                    "metadata_object": config.metadata_object,
                    "verification_model": "ratification-boundary-v1",
                },
                "timeseries": candidate_rows,
                "coverage_readiness": coverage_readiness,
                "acquisition_audit": {
                    "connector_id": config.connector_id,
                    "network": args.source,
                    "metadata_url": pinned["url"],
                    "retrieved_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
                    "metadata_byte_size": pinned["bytes"],
                    "metadata_sha256": pinned["sha256"],
                    "etag": pinned.get("etag"),
                    "last_modified": pinned.get("last_modified"),
                    "temporary_path": pinned["path"],
                    "decoder_execution_identity": decoder,
                    "metadata_object": config.metadata_object,
                    "mapped_timeseries_count": len(candidate_rows),
                    "active_binding_mapping_sha256": active_mapping_hash,
                    "active_observed_property_mapping_sha256": (
                        active_observed_property_hash
                    ),
                    "active_mapping_diagnostics": active_mapping_audit,
                    "ratified_to_values": boundaries,
                    "retained_binding_provider": binding_provider_audit,
                    "retained_scope": retained_scope_audit,
                    "pinned_core_identity": core_identity,
                },
            }
        else:
            if not args.from_day or not args.to_day:
                raise RuntimeError("SOS diagnostic build requires --from-day and --to-day")
            days = iso_days(args.from_day, args.to_day)
            limits = integrity.LimitTracker(None, None, time.monotonic())
            acquisition = integrity.check_sos_flat_files(
                conn,
                args.env,
                environment,
                args.from_day,
                args.to_day,
                selected_days=days,
                dry_run=False,
                run_backfill=False,
                limits=limits,
                log=log,
                concurrency=integrity.DEFAULT_CONCURRENCY,
                history_version="v3",
            )
            if not acquisition.get("ran") or acquisition.get("errors"):
                raise RuntimeError(
                    "SOS annual CSV acquisition did not complete: "
                    + json.dumps(acquisition, sort_keys=True)
                )
            bridge_path = run_dir / "source" / "sos-site-ref-bridge.json"
            registry_path = run_dir / "source" / "sos-source-label-registry.json"
            bridge = integrity.write_sos_site_ref_bridge_snapshot(
                conn=conn, connector_id=1, snapshot_path=bridge_path
            )
            registry = integrity.write_uk_air_source_label_registry_snapshot(
                conn=conn,
                connector_id=1,
                cache_root=Path(environment["UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR"])
                / "sos",
                snapshot_path=registry_path,
            )
            result = {
                "schema_version": 1,
                "source": "sos",
                "connector_id": 1,
                "core_identity": core_identity,
                "semantic_source_identity": {
                    "source_system": "uk-air-annual-csv",
                    "connector_id": 1,
                    "verification_model": "per-observation-status-v1",
                },
                "requested_days": days,
                "requested_pollutants": ["no2", "o3", "pm10", "pm25"],
                "source_root": str(
                    Path(environment["UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR"])
                    / "sos"
                ),
                "bridge_file": str(bridge_path),
                "registry_file": str(registry_path),
                "property_mappings": property_mappings(conn),
                "coverage_readiness": {
                    "publishable": False,
                    "reason": (
                        "connector-1 retained canonical history completeness cannot "
                        "yet be authenticated from an existing retained-scope index; "
                        "this range is diagnostic only"
                    ),
                    "selected_from_day": args.from_day,
                    "selected_to_day": args.to_day,
                },
                "acquisition_audit": {
                    "pinned_core_identity": core_identity,
                    "integrity_sos_acquisition": acquisition,
                    "bridge_snapshot": bridge,
                    "source_label_registry_snapshot": registry,
                },
            }
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
