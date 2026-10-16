"""Run-owned file disposal. Call only after the named consumer has returned.

No directory sweeps, age policy, process-status inference or remote operations.
The monthly entry point accepts only a new coordinator-authored completion
record and the existing exact-month backup/materialisation receipt chain.
"""

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import gzip
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import stat
import zlib


POLICY = "run_owned_local_cleanup_v1"
V3_KEY = re.compile(r"history/(?:v3/observations/|_index_v3/observations_timeseries(?:/|_latest\.json$))")
WORKING_FILE = re.compile(
    r"(?:overlay/(?:detector-source-evidence/)?official-rdata-input/"
    r"(?:waqn|saqn)-\d{4}-\d{2}-\d{2}-connector-(?:9|10)\.json|"
    r"overlay/detector-source-evidence/day_utc=\d{4}-\d{2}-\d{2}/"
    r"connector_id=[1-9]\d*/(?:source-evidence|obs_history_rows|preserved_baseline_rows)\.json)"
)


def _relative(root, path):
    root, path = Path(root).absolute(), Path(path).absolute()
    relative = path.relative_to(root)
    if not relative.parts or ".." in relative.parts:
        raise ValueError("cleanup path escapes run root")
    return relative.as_posix()


@contextmanager
def _parent(root, relative, *, create=False):
    """Pin every directory component; never traverse a symlink for disposal."""
    parts = Path(relative).parts
    if not parts or Path(relative).is_absolute() or any(p in {".", ".."} for p in parts):
        raise ValueError("invalid run-relative cleanup path")
    root = Path(root).absolute()
    if root.resolve(strict=True) != root:
        raise ValueError("cleanup root has a symlink component")
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            if create:
                try:
                    os.mkdir(part, dir_fd=fd)
                    os.fsync(fd)
                except FileExistsError:
                    pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd, parts[-1]
    finally:
        os.close(fd)


@contextmanager
def _file(root, relative):
    with _parent(root, relative) as (parent, name):
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ValueError("cleanup requires a single-link regular run-owned file")
            yield stream, parent, name, info


def _identity(stream):
    digest = hashlib.sha256()
    count = 0
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(chunk)
        count += len(chunk)
    stream.seek(0)
    return digest.hexdigest(), count


def _unchanged(stream, parent, name, before):
    def token(info):
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns,
                info.st_ctime_ns, info.st_nlink)
    if (token(os.fstat(stream.fileno())) != token(before)
            or token(os.stat(name, dir_fd=parent, follow_symlinks=False)) != token(before)):
        raise ValueError("cleanup file changed after authentication")


def _event(state, **event):
    """Durable intent precedes unlink; an absent file is never counted as deleted."""
    cleanup = state.setdefault("cleanup", {"policy": POLICY})
    if cleanup.get("policy") != POLICY:
        raise ValueError("unrecognised cleanup policy")
    event = {"policy": POLICY, "recorded_at_utc": datetime.now(timezone.utc).isoformat(), **event}
    # Counts follow actual operations even if writing their result receipt
    # fails. In particular a failed result write cannot erase a real unlink.
    for key, value in event.items():
        if key in {"files_removed", "bytes_removed", "evidence_bytes_written", "failures", "already_absent"}:
            cleanup[key] = cleanup.get(key, 0) + value
    cleanup["net_bytes_released"] = (
        None if cleanup.get("evidence_bytes_unmeasured") else
        cleanup.get("bytes_removed", 0) - cleanup.get("evidence_bytes_written", 0)
    )
    with _parent(state["run_root"], "cleanup-receipts.jsonl") as (parent, name):
        fd = os.open(name, os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=parent)
        with os.fdopen(fd, "a", encoding="utf-8") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise ValueError("cleanup receipt is not a single-link regular file")
            if info.st_size and os.pread(stream.fileno(), 1, info.st_size - 1) != b"\n":
                raise ValueError("cleanup receipt has an incomplete trailing record; manual review required")
            stream.write(json.dumps(event, sort_keys=True) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
            os.fsync(parent)
    cleanup["receipt_path"] = str(Path(state["run_root"]) / "cleanup-receipts.jsonl")


def _failure(state, path, error):
    state.setdefault("cleanup", {"policy": POLICY})["last_error"] = str(error)
    logging.getLogger(__name__).warning("local cleanup retained/error path=%s error=%s", path, error)
    try:
        _event(state, action="failed", path=str(path), error=str(error), failures=1)
    except (OSError, ValueError) as receipt_error:
        # Stop this file's disposal when intent cannot be recorded, but do not
        # turn optional disk cleanup into a canonical repair failure.
        state["cleanup"]["receipt_write_error"] = str(receipt_error)


def persist_cleanup_state(state, writer):
    """An optional cleanup checkpoint must not change the repair outcome.

    The normal writer increments persistence counters before replacing state.
    Restore those counters if that optional write fails. Essential proposal,
    APPLY and verification checkpoints still use the normal fail-closed writer.
    """
    counters = (
        "node_complete_run_state_write_count", "coordinator_complete_run_state_write_count",
        "total_complete_run_state_write_count", "complete_run_state_write_count",
    )
    mappings = [
        (state.get("apply") or {}).get("persistence"),
        ((state.get("coordinator") or {}).get("final_verification") or {}).get("apply_persistence_artifacts"),
    ]
    missing = object()
    snapshots = [(value, {key: value.get(key, missing) for key in counters})
                 for value in mappings if isinstance(value, dict)]
    try:
        writer(state)
        return True
    except Exception as error:
        for value, snapshot in snapshots:
            for key, original in snapshot.items():
                if original is missing:
                    value.pop(key, None)
                else:
                    value[key] = original
        state.setdefault("cleanup", {"policy": POLICY})["state_write_error"] = str(error)
        _failure(state, state.get("run_state_path"), error)
        return False


def record_cleanup_failure(state, path, error):
    """Surface a cleanup-only failure without changing canonical repair state."""
    _failure(state, path, error)


def remove_duplicates(state, object_keys, *, detector=False):
    """Capture's final consumer finished; keep the authenticated staged body."""
    root = Path(state["run_root"])
    generated = Path(state["overlay_root"])
    if detector:
        generated /= "detector-source-evidence"
    generated /= "generated-objects"
    for key in object_keys:
        entry = state["objects"][key]
        source = generated / key
        try:
            if not V3_KEY.match(key) or entry.get("structurally_validated") is not True:
                continue
            source_relative = _relative(root, source)
            retained_relative = _relative(root, entry["local_path"])
            if retained_relative != "overlay/" + key or source_relative == retained_relative:
                raise ValueError("duplicate does not have a distinct canonical retained body")
            expected = (entry["sha256"], entry["bytes"])
            with _file(root, retained_relative) as (retained, rp, rn, ri):
                if _identity(retained) != expected:
                    raise ValueError("retained staged body identity changed")
                with _file(root, source_relative) as (stream, parent, name, before):
                    if _identity(stream) != expected:
                        # A different detector serialisation is not a proven duplicate.
                        _event(state, action="retained_identity_mismatch", path=source_relative)
                        continue
                    _event(state, action="unlink_intent", path=source_relative,
                           retained_path=retained_relative, sha256=expected[0], bytes=expected[1])
                    _unchanged(retained, rp, rn, ri)
                    _unchanged(stream, parent, name, before)
                    os.unlink(name, dir_fd=parent)
                    _event(state, action="removed_duplicate", path=source_relative,
                           files_removed=1, bytes_removed=before.st_size)
        except FileNotFoundError as exc:
            if os.path.lexists(source):
                _failure(state, source, exc)
            else:
                try:
                    _event(state, action="already_absent", path=str(source), already_absent=1)
                except (OSError, ValueError) as receipt_error:
                    _failure(state, source, receipt_error)
        except (OSError, ValueError) as exc:
            _failure(state, source, exc)


def retire_working_files(state, paths):
    """Keep exact detector/proposal diagnostics as hash-addressed gzip evidence.

    This avoids inventing a reduced evidence schema. Consumers have returned;
    immutable acquisition roots and retained source evidence are excluded.
    Failure/dry-run evidence remains recoverable byte for byte.
    """
    root = Path(state["run_root"])
    for path in paths:
        try:
            relative = _relative(root, path)
            if not WORKING_FILE.fullmatch(relative):
                raise ValueError("file is outside the working-file allowlist")
            with _file(root, relative) as (stream, parent, name, before):
                digest, count = _identity(stream)
                archive = f"cleanup-evidence/{relative}.{digest}.gz"
                _event(state, action="evidence_intent", path=relative,
                       evidence_path=archive, sha256=digest, bytes=count)
                with _parent(root, archive, create=True) as (ap, an):
                    try:
                        fd = os.open(an, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=ap)
                    except FileExistsError:
                        fd = None
                    if fd is not None:
                        complete = False
                        try:
                            with os.fdopen(fd, "wb") as output:
                                with gzip.GzipFile(fileobj=output, mode="wb", mtime=0) as compressed:
                                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                                        compressed.write(chunk)
                                output.flush()
                                os.fsync(output.fileno())
                            complete = True
                        finally:
                            # Account for bytes left by a failed compression too.
                            # Partial evidence never authorises the original unlink.
                            try:
                                written = os.stat(an, dir_fd=ap, follow_symlinks=False).st_size
                            except OSError:
                                state["cleanup"]["evidence_bytes_unmeasured"] = True
                                raise
                            _event(state, action="evidence_created" if complete else "evidence_incomplete",
                                   evidence_path=archive, evidence_bytes_written=written)
                    os.fsync(ap)
                with _file(root, archive) as (compressed, ap, an, ai):
                    with gzip.GzipFile(fileobj=compressed, mode="rb") as evidence:
                        actual = hashlib.sha256()
                        size = 0
                        for chunk in iter(lambda: evidence.read(1024 * 1024), b""):
                            actual.update(chunk)
                            size += len(chunk)
                    if (actual.hexdigest(), size) != (digest, count):
                        raise ValueError("retained compressed evidence identity differs")
                    os.fsync(compressed.fileno())
                    _event(state, action="unlink_intent", path=relative,
                           evidence_path=archive, sha256=digest, bytes=count)
                    _unchanged(compressed, ap, an, ai)
                    _unchanged(stream, parent, name, before)
                    os.unlink(name, dir_fd=parent)
                    _event(state, action="retired_working_file", path=relative,
                           files_removed=1, bytes_removed=count)
        except FileNotFoundError as exc:
            if os.path.lexists(path):
                _failure(state, path, exc)
            else:
                try:
                    _event(state, action="already_absent", path=str(path), already_absent=1)
                except (OSError, ValueError) as receipt_error:
                    _failure(state, path, receipt_error)
        except (OSError, EOFError, ValueError, zlib.error) as exc:
            _failure(state, path, exc)


def staging_candidates(state):
    """Exact v3 bodies only; never source evidence, journals or recovery files."""
    result = []
    for key, entry in state["objects"].items():
        if (not V3_KEY.match(key) or entry.get("proposed") is not True
                or entry.get("structurally_validated") is not True
                or entry.get("r2_verified") is not True):
            continue
        relative = _relative(state["run_root"], entry["local_path"])
        if relative != "overlay/" + key:
            raise ValueError("staged body is outside its exact object path")
        if (not re.fullmatch(r"[a-f0-9]{64}", str(entry.get("sha256") or ""))
                or type(entry.get("bytes")) is not int or entry["bytes"] < 0):
            raise ValueError("staged body has an invalid recorded identity")
        result.append({"path": relative, "sha256": entry["sha256"], "bytes": entry["bytes"]})
    return sorted(result, key=lambda entry: entry["path"])


def _load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def accepted_month_state(marker, tmp_root, environment, source, label, from_day, to_day):
    """Validate the exact existing receipt chain plus new completion evidence."""
    marker = Path(marker)
    if marker.name != label + ".ok" or not marker.is_file():
        raise ValueError("month has not been accepted")
    def receipt(suffix, phase):
        value = _load(marker.with_name(label + suffix))
        if (value.get("source"), value.get("label"), value.get("phase")) != (source, label, phase):
            raise ValueError("monthly receipt scope differs")
        return value
    integrity = receipt(".integrity-success.json", "integrity_succeeded")
    dispatch = receipt(".backup-dispatch.json", "backup_dispatched_resolved")
    backup = receipt(".backup-success.json", "backup_succeeded")
    sync = receipt(".local-sync.json", "local_materialisation_verified")
    if (integrity.get("from_day"), integrity.get("to_day")) != (from_day, to_day):
        raise ValueError("monthly Integrity range differs")
    if (backup.get("status"), backup.get("conclusion")) != ("completed", "success"):
        raise ValueError("monthly backup was not successful")
    for key in ("caller_run_id", "run_id"):
        if not dispatch.get(key) or not dispatch[key] == backup.get(key) == sync.get(key):
            raise ValueError("monthly backup workflow identities differ")
    if not dispatch["caller_run_id"].startswith(f"integrity-monthly-{environment}-{source}-"):
        raise ValueError("monthly backup caller environment differs")
    expected = backup.get("expected_hash", "")
    if (not re.fullmatch(r"[a-f0-9]{64}", expected)
            or sync.get("expected_hash") != expected or sync.get("observed_hash") != expected
            or not backup.get("state_root_key") or sync.get("state_root_key") != backup["state_root_key"]
            or sync.get("generation") != "v3"
            or dispatch.get("requested_observation_parquet_copy_mode") != "reuse_matching"
            or backup.get("observation_parquet_copy_mode") != "reuse_matching"
            or sync.get("observation_parquet_copy_mode") != "reuse_matching"):
        raise ValueError("monthly checkpoint/materialisation identities differ")
    reports = re.findall(r"\breport_json=(\S+)", Path(integrity["log"]).read_text(encoding="utf-8"))
    if not reports:
        raise ValueError("monthly Integrity log has no report")
    report_path = str(Path(reports[-1]).absolute())
    report = _load(report_path)
    if (report.get("env"), report.get("source"), report.get("from_day"), report.get("to_day")) != (environment, source, from_day, to_day):
        raise ValueError("Integrity report scope differs")
    if (report.get("status") != "ok" or report.get("dry_run") is not False
            or report.get("check_only") is not False or report.get("run_backfill") is not True):
        raise ValueError("Integrity report is not an accepted real repair")
    state_path = Path(report["repair_flow"]["run_state_path"]).absolute()
    relative = Path(_relative(tmp_root, state_path))
    if len(relative.parts) != 2 or not relative.parts[0].startswith("run-") or relative.name != "run-state.json":
        raise ValueError("report does not identify an environment-owned run state")
    state = _load(state_path)
    if (Path(state["run_root"]).absolute() != state_path.parent
            or Path(state["overlay_root"]).absolute() != state_path.parent / "overlay"
            or Path(state["run_state_path"]).absolute() != state_path
            or state.get("environment") != environment):
        raise ValueError("run-owned paths or environment differ")
    completion = state.get("cleanup", {}).get("completion", {})
    expected_completion = {"report_json": report_path, "run_id": report["run_id"],
                           "environment": environment, "source": source,
                           "from_day": from_day, "to_day": to_day}
    if (state.get("cleanup", {}).get("policy") != POLICY
            or any(completion.get(key) != value for key, value in expected_completion.items())
            or report.get("repair_overlay_cleanup", {}).get("completion") != completion
            or not re.fullmatch(r"[a-f0-9]{64}", str(completion.get("state_fingerprint_sha256") or ""))
            or completion["state_fingerprint_sha256"] != state.get("proposal_transition_validation", {}).get("state_fingerprint_sha256")
            or state["coordinator"].get("status") != "succeeded"
            or state["coordinator"].get("final_verification", {}).get("status") != "ok"
            or completion.get("staging") != staging_candidates(state)):
        raise ValueError("new coordinator completion evidence is missing or differs")
    return state


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--accepted-month", required=True)
    parser.add_argument("--tmp-root", required=True)
    parser.add_argument("--env", choices=("TEST", "LIVE"), required=True)
    parser.add_argument("--source", choices=("sos", "waqn", "saqn"), required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--from-day", required=True)
    parser.add_argument("--to-day", required=True)
    args = parser.parse_args()
    # No scan or terminal-status fallback. Old runs without new evidence refuse.
    state = accepted_month_state(args.accepted_month, args.tmp_root, args.env,
                                 args.source, args.label, args.from_day, args.to_day)
    with _parent(state["run_root"], "cleanup.lock") as (parent, name):
        fd = os.open(name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        with os.fdopen(fd, "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            # Revalidate after exclusion against concurrent cleanup invocations.
            state = accepted_month_state(args.accepted_month, args.tmp_root, args.env,
                                         args.source, args.label, args.from_day, args.to_day)
            candidates = state["cleanup"]["completion"]["staging"]
            # Report this invocation separately. Prior phase and deferred
            # outcomes remain in the append-only receipt, without double counts.
            state["cleanup"] = {"policy": POLICY, "scope": "accepted_month_invocation"}
            for candidate in candidates:
                relative = candidate["path"]
                try:
                    with _file(state["run_root"], relative) as (stream, parent, name, before):
                        if _identity(stream) != (candidate["sha256"], candidate["bytes"]):
                            raise ValueError("completed staged body identity changed")
                        _event(state, action="unlink_intent", **candidate,
                               accepted_month=str(args.accepted_month))
                        _unchanged(stream, parent, name, before)
                        os.unlink(name, dir_fd=parent)
                        _event(state, action="removed_accepted_staging", path=relative,
                               files_removed=1, bytes_removed=before.st_size)
                except FileNotFoundError:
                    try:
                        _event(state, action="already_absent", path=relative, already_absent=1)
                    except (OSError, ValueError) as exc:
                        _failure(state, relative, exc)
                except (OSError, ValueError) as exc:
                    _failure(state, relative, exc)
    # The append-only receipt is authoritative for deferred results; do not
    # rewrite authenticated artifacts, the accepted report, or completed state.
    print(json.dumps(state["cleanup"], sort_keys=True))
    return int(state["cleanup"].get("failures", 0) > 0)


if __name__ == "__main__":
    raise SystemExit(main())
