#!/usr/bin/env python3
"""Archive TEST Cloud Logging entries into deterministic daily gzip JSONL files."""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import gzip
import hashlib
import json
import logging
import os
from pathlib import Path
import signal
import sys
import tempfile
import threading
import time
import uuid

from google.cloud.logging_v2.services.logging_service_v2 import LoggingServiceV2Client
from google.protobuf.json_format import MessageToDict

UTC = dt.timezone.utc
LOG = logging.getLogger("uk_aq_gcp_log_archive")
MAX_REPORTED_WINDOWS = 100
MAX_REPORTED_FILES_PER_WINDOW = 100
ARCHIVE_MANIFEST_SCHEMA_VERSION = 1


class InterruptedRun(Exception):
    """Raised by the main-thread signal handler so final evidence is written."""

    def __init__(self, signum: int):
        super().__init__(f"interrupted by signal {signum}")
        self.signum = signum


def utc(value: str) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError(f"timestamp needs an offset: {value}")
    return parsed.astimezone(UTC)


def stamp(value: dt.datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, sort_keys=True, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(name)


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def source_identity(config: dict) -> dict:
    source = {"project_id": config["project_id"], "log_filter": config["log_filter"]}
    filter_sha256 = hashlib.sha256(config["log_filter"].encode()).hexdigest()
    return {
        "project_id": config["project_id"],
        "filter_sha256": filter_sha256,
        "source_fingerprint": hashlib.sha256(canonical(source)).hexdigest(),
    }


def archive_identity(config: dict) -> dict:
    return {
        "archive_id": config["archive_id"],
        "archive_path": str(
            (Path(os.path.expanduser(config["archive_root"])) / "GCP Logs/TEST/raw").resolve()
        ),
    }


def redaction_identity(config: dict) -> dict:
    paths = sorted(set(config.get("redact_paths", [])))
    return {
        "paths": paths,
        "redaction_fingerprint": hashlib.sha256(canonical(paths)).hexdigest(),
    }


def expected_archive_manifest(config: dict) -> dict:
    return {
        "schema_version": ARCHIVE_MANIFEST_SCHEMA_VERSION,
        "environment": "TEST",
        "source": source_identity(config),
        "archive": archive_identity(config),
        "redaction": redaction_identity(config),
    }


def validate_archive_manifest(path: Path, actual: object, expected: dict) -> None:
    if not isinstance(actual, dict):
        raise RuntimeError(f"archive identity manifest is not a JSON object: {path}")
    mismatches = [key for key in ("schema_version", "environment", "source", "archive", "redaction")
                  if actual.get(key) != expected[key]]
    if mismatches:
        raise RuntimeError(
            f"archive identity manifest mismatch at {path} for {', '.join(mismatches)}; "
            "do not merge into this archive—restore the matching configuration, complete a verified archive "
            "relocation, or rebuild history into a new empty archive_id/destination"
        )


def ensure_archive_manifest(config: dict) -> Path:
    raw_path = Path(archive_identity(config)["archive_path"])
    manifest_path = raw_path.parent / "archive-identity.json"
    expected = expected_archive_manifest(config)
    if manifest_path.exists():
        validate_archive_manifest(manifest_path, json.loads(manifest_path.read_text(encoding="utf-8")), expected)
        return manifest_path
    if raw_path.exists() and any(item.is_file() for item in raw_path.rglob("*")):
        raise RuntimeError(
            f"refusing to initialise missing archive identity manifest {manifest_path}: raw archive "
            f"{raw_path} is not empty; quarantine/rebuild it or restore its reviewed manifest"
        )
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(expected, sort_keys=True, indent=2) + "\n"
    try:
        descriptor = os.open(manifest_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        validate_archive_manifest(manifest_path, json.loads(manifest_path.read_text(encoding="utf-8")), expected)
        return manifest_path
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        directory_fd = os.open(manifest_path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            manifest_path.unlink()
        raise
    return manifest_path


def identity(entry: dict) -> str:
    insert_id = entry.get("insertId")
    if insert_id:
        # insertId is scoped by log; resource identity avoids collisions from copied logs.
        basis = [entry.get("logName"), entry.get("resource"), insert_id]
        return "insert:" + hashlib.sha256(canonical(basis)).hexdigest()
    # The fallback deliberately excludes receiveTimestamp: redelivery must remain identical.
    basis = {key: value for key, value in entry.items() if key != "receiveTimestamp"}
    return "sha256:" + hashlib.sha256(canonical(basis)).hexdigest()


def delete_path(value: object, path: str) -> None:
    parts = path.split(".")
    cursor = value
    for part in parts[:-1]:
        if not isinstance(cursor, dict) or part not in cursor:
            return
        cursor = cursor[part]
    if isinstance(cursor, dict):
        cursor.pop(parts[-1], None)


class Heartbeat:
    def __init__(self, phase: str):
        self.phase = phase
        self.started = time.monotonic()
        self.done = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def __enter__(self):
        LOG.info("phase_start phase=%s", self.phase)
        self.thread.start()
        return self

    def _run(self):
        while not self.done.wait(15):
            LOG.info("phase_progress phase=%s elapsed_seconds=%d ETA=unknown", self.phase, time.monotonic() - self.started)

    def __exit__(self, kind, _value, _traceback):
        self.done.set()
        self.thread.join()
        LOG.info("phase_%s phase=%s elapsed_seconds=%.1f", "failed" if kind else "complete", self.phase, time.monotonic() - self.started)


class TeeHandler(logging.Handler):
    def __init__(self, path: Path):
        super().__init__()
        self.file = path.open("a", encoding="utf-8")

    def emit(self, record):
        line = self.format(record)
        print(line, file=sys.stderr, flush=True)
        self.file.write(line + "\n")
        self.file.flush()

    def close(self):
        if not self.file.closed:
            self.file.close()
        super().close()


class Collector:
    def __init__(self, config: dict):
        self.config = config
        self.project = config["project_id"]
        self.archive = Path(os.path.expanduser(config["archive_root"])) / "GCP Logs/TEST/raw"
        self.state = Path(os.path.expanduser(config["state_dir"]))
        self.redact = config.get("redact_paths", [])
        self.client = LoggingServiceV2Client()

    def filter(self, start: dt.datetime | None, end: dt.datetime | None, field: str) -> str:
        clauses = [f"({self.config['log_filter']})"]
        if start:
            clauses.append(f'{field} >= "{stamp(start)}"')
        if end:
            clauses.append(f'{field} < "{stamp(end)}"')
        return " AND ".join(clauses)

    def read(self, start: dt.datetime | None, end: dt.datetime | None, field="receiveTimestamp", limit=None):
        request = {
            "resource_names": [f"projects/{self.project}"],
            "filter": self.filter(start, end, field),
            "order_by": "timestamp asc",
            "page_size": int(self.config.get("page_size", 1000)),
        }
        iterator = self.client.list_log_entries(request=request)
        count = 0
        for proto in iterator:
            entry = MessageToDict(proto._pb, preserving_proto_field_name=False)
            for path in self.redact:
                delete_path(entry, path)
            yield entry
            count += 1
            if limit and count >= limit:
                return

    def daily_path(self, day: str) -> Path:
        parsed = dt.date.fromisoformat(day)
        return self.archive / f"{parsed:%Y/%m}/{day}.jsonl.gz"

    def publish(self, grouped: dict[str, list[dict]]) -> list[dict]:
        result = []
        for day in sorted(grouped):
            path = self.daily_path(day)
            existing: dict[str, dict] = {}
            if path.exists():
                with gzip.open(path, "rt", encoding="utf-8") as stream:
                    for line in stream:
                        item = json.loads(line)
                        existing[identity(item)] = item
            before_ids = set(existing)
            incoming = grouped[day]
            incoming_by_id = {identity(item): item for item in incoming}
            for item_id, item in incoming_by_id.items():
                existing[item_id] = item
            path.parent.mkdir(parents=True, exist_ok=True)
            fd, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
            try:
                with os.fdopen(fd, "wb") as raw:
                    with gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=0) as zipped:
                        for key in sorted(existing):
                            zipped.write(canonical(existing[key]) + b"\n")
                    raw.flush()
                    os.fsync(raw.fileno())
                os.replace(name, path)
                directory_fd = os.open(path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            finally:
                with contextlib.suppress(FileNotFoundError):
                    os.unlink(name)
            new_entries = len(set(incoming_by_id) - before_ids)
            result.append({
                "archive_date": day,
                "path": str(path),
                "source_entries": len(incoming),
                "unique_source_entries": len(incoming_by_id),
                "new_entries": new_entries,
                "duplicate_source_entries": len(incoming) - len(incoming_by_id),
                "already_present_entries": len(set(incoming_by_id) & before_ids),
                "duplicate_or_already_present_entries": len(incoming) - new_entries,
                "resulting_entries": len(existing),
                "bytes_written": path.stat().st_size,
            })
        return result

    def window(self, start: dt.datetime, end: dt.datetime, field: str) -> dict:
        grouped: dict[str, list[dict]] = {}
        count = 0
        with Heartbeat(f"retrieve_{stamp(start)}_{stamp(end)}"):
            for entry in self.read(start, end, field):
                count += 1
                event = entry.get("timestamp") or entry.get("receiveTimestamp")
                if not event:
                    LOG.warning("entry_without_timestamp identity=%s", identity(entry))
                    continue
                grouped.setdefault(utc(event).date().isoformat(), []).append(entry)
        with Heartbeat("publish_daily_files"):
            published = self.publish(grouped)
        return {
            "source_field": field,
            "start": stamp(start),
            "end": stamp(end),
            "source_entries_returned": count,
            "unique_source_entries": sum(item["unique_source_entries"] for item in published),
            "new_entries": sum(item["new_entries"] for item in published),
            "duplicate_source_entries": sum(item["duplicate_source_entries"] for item in published),
            "already_present_entries": sum(item["already_present_entries"] for item in published),
            "duplicate_or_already_present_entries": sum(item["duplicate_or_already_present_entries"] for item in published),
            "affected_file_count": len(published),
            "bytes_written": sum(item["bytes_written"] for item in published),
            "affected_files": published[:MAX_REPORTED_FILES_PER_WINDOW],
            "affected_files_omitted": max(0, len(published) - MAX_REPORTED_FILES_PER_WINDOW),
        }


def checkpoint(path: Path, expected_source: dict, expected_archive: dict, expected_redaction: dict) -> dict:
    if not path.exists():
        return {}
    value = json.loads(path.read_text(encoding="utf-8"))
    actual = value.get("source", {})
    if actual.get("source_fingerprint") != expected_source["source_fingerprint"]:
        raise RuntimeError(
            f"checkpoint source mismatch at {path}: expected TEST project "
            f"{expected_source['project_id']} and filter SHA-256 {expected_source['filter_sha256']}; "
            "move the checkpoint aside and restart from an explicit safe boundary after reviewing source coverage"
        )
    actual_archive = value.get("archive", {})
    if actual_archive != expected_archive:
        raise RuntimeError(
            f"checkpoint archive mismatch at {path}: expected archive ID "
            f"{expected_archive['archive_id']} at {expected_archive['archive_path']}; "
            "complete and verify an archive move before updating the checkpoint, or use a new state directory "
            "and rebuild history into the new archive"
        )
    actual_redaction = value.get("redaction", {})
    if actual_redaction.get("redaction_fingerprint") != expected_redaction["redaction_fingerprint"]:
        raise RuntimeError(
            f"checkpoint redaction mismatch at {path}: archived entries were produced under a different "
            "redaction policy; do not continue or edit the fingerprint—re-sanitise by rebuilding into a "
            "new archive identity and state directory, verify it, then retire the old archive"
        )
    return value


def new_report(config: dict, args: argparse.Namespace, run_id: str, run_start: dt.datetime) -> dict:
    return {
        "schema_version": 3,
        "run_id": run_id,
        "environment": "TEST",
        "mode": args.mode,
        "started_at": stamp(run_start),
        "status": "running",
        "project_id": config["project_id"],
        "source": source_identity(config),
        "archive": archive_identity(config),
        "redaction": redaction_identity(config),
        "archive_root": config["archive_root"],
        "overlap_seconds": int(config.get("overlap_seconds", 7200)) if args.mode == "incremental" else None,
        "query_summary": {
            "window_count": 0,
            "source_entries_returned": 0,
            "unique_source_entries": 0,
            "new_entries": 0,
            "duplicate_source_entries": 0,
            "already_present_entries": 0,
            "duplicate_or_already_present_entries": 0,
            "affected_file_count": 0,
            "bytes_written": 0,
        },
        "windows": [],
        "windows_omitted": 0,
    }


def record_window(report: dict, window: dict) -> None:
    summary = report["query_summary"]
    summary["window_count"] += 1
    summary.setdefault("first_start", window["start"])
    summary["last_end"] = window["end"]
    summary["source_field"] = window["source_field"]
    for key in (
        "source_entries_returned", "unique_source_entries", "new_entries",
        "duplicate_source_entries", "already_present_entries",
        "duplicate_or_already_present_entries", "affected_file_count", "bytes_written",
    ):
        summary[key] += window[key]
    if len(report["windows"]) < MAX_REPORTED_WINDOWS:
        report["windows"].append(window)
    else:
        report["windows_omitted"] += 1
        report["last_omitted_window"] = {
            key: window[key] for key in ("source_field", "start", "end", "source_entries_returned")
        }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    sub = parser.add_subparsers(dest="mode", required=True)
    sub.add_parser("incremental")
    backfill = sub.add_parser("backfill")
    backfill.add_argument("--start", help="optional known UTC lower boundary")
    backfill.add_argument("--end", help="defaults to current UTC time")
    bounded = sub.add_parser("range")
    bounded.add_argument("--start", required=True)
    bounded.add_argument("--end", required=True)
    args = parser.parse_args()
    config = json.loads(args.config.read_text(encoding="utf-8"))
    for key in ("project_id", "log_filter", "archive_id", "archive_root", "state_dir", "run_evidence_root"):
        if not config.get(key):
            parser.error(f"config requires {key}")

    run_start = dt.datetime.now(UTC)
    run_id = f"{run_start:%Y%m%dT%H%M%SZ}_{args.mode}_{uuid.uuid4().hex[:8]}"
    run_dir = Path(os.path.expanduser(config["run_evidence_root"])) / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    handler = TeeHandler(run_dir / "run.log")
    formatter = logging.Formatter("%(asctime)sZ %(levelname)s %(message)s", datefmt="%Y-%m-%dT%H:%M:%S")
    formatter.converter = time.gmtime
    handler.setFormatter(formatter)
    LOG.addHandler(handler)
    LOG.setLevel(logging.INFO)
    LOG.info("run_start run_id=%s mode=%s environment=TEST pid=%d work_dir=%s", run_id, args.mode, os.getpid(), run_dir)

    report = new_report(config, args, run_id, run_start)
    report_path = run_dir / "run-report.json"
    atomic_json(report_path, report)
    state_dir = Path(os.path.expanduser(config["state_dir"]))
    state_dir.mkdir(parents=True, exist_ok=True)
    lock_stream = (state_dir / "collector.lock").open("a")
    try:
        fcntl.flock(lock_stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        LOG.error("another collector invocation holds %s", state_dir / "collector.lock")
        finished = dt.datetime.now(UTC)
        report.update({
            "status": "not_run_lock_contention",
            "finished_at": stamp(finished),
            "elapsed_seconds": round((finished - run_start).total_seconds(), 3),
            "exit_code": 75,
            "error_type": "LockContention",
            "error": "another collector invocation holds the exclusive lock",
        })
        atomic_json(report_path, report)
        LOG.info("run_complete status=%s exit_code=75 report=%s", report["status"], report_path)
        LOG.removeHandler(handler)
        handler.close()
        return 75

    try:
        now = dt.datetime.now(UTC)
        manifest_path = ensure_archive_manifest(config)
        report["archive_manifest"] = str(manifest_path)
        atomic_json(report_path, report)
        if args.mode == "incremental":
            cp_path = state_dir / "incremental.json"
            cp = checkpoint(cp_path, report["source"], report["archive"], report["redaction"])
            collector = Collector(config)
            overlap = dt.timedelta(seconds=int(config.get("overlap_seconds", 7200)))
            start = utc(cp["receive_through"]) - overlap if cp else now - dt.timedelta(seconds=int(config.get("initial_lookback_seconds", 86400)))
            end = now - dt.timedelta(seconds=int(config.get("settling_delay_seconds", 120)))
            if start >= end:
                LOG.info("no settled incremental interval is available")
            else:
                window = collector.window(start, end, "receiveTimestamp")
                record_window(report, window)
                watermark = stamp(end)
                atomic_json(cp_path, {"schema_version": 3, "source": report["source"], "archive": report["archive"],
                                      "redaction": report["redaction"], "receive_through": watermark,
                                      "updated_at": stamp(dt.datetime.now(UTC)), "last_run_id": run_id})
                report["resulting_watermark"] = {"field": "receiveTimestamp", "through": watermark}
        elif args.mode == "range":
            start, end = utc(args.start), utc(args.end)
            if start >= end:
                raise ValueError("--start must be before --end")
            collector = Collector(config)
            record_window(report, collector.window(start, end, "timestamp"))
        else:
            cp_path = state_dir / "backfill.json"
            cp = checkpoint(cp_path, report["source"], report["archive"], report["redaction"])
            collector = Collector(config)
            if cp.get("event_through"):
                start = utc(cp["event_through"])
            elif args.start:
                start = utc(args.start)
            else:
                LOG.info("discovering earliest retained matching TEST log entry")
                first = next(collector.read(None, None, "timestamp", limit=1), None)
                if not first:
                    raise RuntimeError("no matching retained log entries; historical boundary cannot be discovered")
                start = utc(first.get("timestamp") or first["receiveTimestamp"])
                report["discovered_historical_boundary"] = stamp(start)
                LOG.info("discovered_historical_boundary=%s", stamp(start))
            end_limit = utc(args.end) if args.end else now
            hours = int(config.get("backfill_window_hours", 6))
            while start < end_limit:
                end = min(start + dt.timedelta(hours=hours), end_limit)
                window = collector.window(start, end, "timestamp")
                record_window(report, window)
                # Window publication is complete before this resumable cursor advances.
                watermark = stamp(end)
                atomic_json(cp_path, {"schema_version": 3, "source": report["source"], "archive": report["archive"],
                                      "redaction": report["redaction"], "event_through": watermark,
                                      "updated_at": stamp(dt.datetime.now(UTC)), "last_run_id": run_id})
                report["resulting_watermark"] = {"field": "timestamp", "through": watermark}
                atomic_json(report_path, report)
                LOG.info("backfill_window_complete through=%s entries=%d", watermark, window["source_entries_returned"])
                start = end
        report["status"] = "succeeded"
        return_code = 0
    except InterruptedRun as error:
        LOG.error("collector_interrupted: %s", error)
        report["status"] = "interrupted"
        report["error_type"] = type(error).__name__
        report["error"] = str(error)[:1000]
        report["signal"] = error.signum
        return_code = 128 + error.signum
    except KeyboardInterrupt:
        LOG.error("collector_interrupted: keyboard interrupt")
        report["status"] = "interrupted"
        report["error_type"] = "KeyboardInterrupt"
        report["error"] = "interrupted by operator"
        return_code = 130
    except Exception as error:
        LOG.exception("collector_failed: %s", error)
        report["status"] = "failed"
        report["error_type"] = type(error).__name__
        report["error"] = str(error)[:1000]
        return_code = 1
    finally:
        finished = dt.datetime.now(UTC)
        report["finished_at"] = stamp(finished)
        report["elapsed_seconds"] = round((finished - run_start).total_seconds(), 3)
        report["exit_code"] = locals().get("return_code", 1)
        atomic_json(report_path, report)
        LOG.info("run_complete status=%s exit_code=%d report=%s", report["status"], report["exit_code"], report_path)
        LOG.removeHandler(handler)
        handler.close()
    return return_code


def handle_sigterm(signum, _frame) -> None:
    raise InterruptedRun(signum)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, handle_sigterm)
    raise SystemExit(main())
