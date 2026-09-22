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

from google.cloud import logging_v2
from google.protobuf.json_format import MessageToDict

UTC = dt.timezone.utc
LOG = logging.getLogger("uk_aq_gcp_log_archive")


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
        self.file.close()
        super().close()


class Collector:
    def __init__(self, config: dict):
        self.config = config
        self.project = config["project_id"]
        self.archive = Path(os.path.expanduser(config["archive_root"])) / "GCP Logs/TEST/raw"
        self.state = Path(os.path.expanduser(config["state_dir"]))
        self.redact = config.get("redact_paths", [])
        self.client = logging_v2.LoggingServiceV2Client()

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

    def publish(self, grouped: dict[str, list[dict]]) -> dict:
        result = {}
        for day in sorted(grouped):
            path = self.daily_path(day)
            existing: dict[str, dict] = {}
            if path.exists():
                with gzip.open(path, "rt", encoding="utf-8") as stream:
                    for line in stream:
                        item = json.loads(line)
                        existing[identity(item)] = item
            before = len(existing)
            for item in grouped[day]:
                existing[identity(item)] = item
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
            result[day] = {"entries": len(existing), "added": len(existing) - before, "path": str(path)}
        return result

    def window(self, start: dt.datetime, end: dt.datetime, field: str) -> tuple[int, dict]:
        grouped: dict[str, list[dict]] = {}
        count = 0
        with Heartbeat(f"retrieve_{stamp(start)}_{stamp(end)}"):
            for entry in self.read(start, end, field):
                event = entry.get("timestamp") or entry.get("receiveTimestamp")
                if not event:
                    LOG.warning("entry_without_timestamp identity=%s", identity(entry))
                    continue
                grouped.setdefault(utc(event).date().isoformat(), []).append(entry)
                count += 1
        with Heartbeat("publish_daily_files"):
            published = self.publish(grouped)
        return count, published


def checkpoint(path: Path) -> dict:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


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
    for key in ("project_id", "log_filter", "archive_root", "state_dir", "run_evidence_root"):
        if not config.get(key):
            parser.error(f"config requires {key}")

    run_start = dt.datetime.now(UTC)
    run_id = f"{run_start:%Y%m%dT%H%M%SZ}_{args.mode}_{uuid.uuid4().hex[:8]}"
    run_dir = Path(os.path.expanduser(config["run_evidence_root"])) / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    handler = TeeHandler(run_dir / "run.log")
    handler.setFormatter(logging.Formatter("%(asctime)sZ %(levelname)s %(message)s", datefmt="%Y-%m-%dT%H:%M:%S"))
    LOG.addHandler(handler)
    LOG.setLevel(logging.INFO)
    LOG.info("run_start run_id=%s mode=%s environment=TEST pid=%d work_dir=%s", run_id, args.mode, os.getpid(), run_dir)

    state_dir = Path(os.path.expanduser(config["state_dir"]))
    state_dir.mkdir(parents=True, exist_ok=True)
    lock_stream = (state_dir / "collector.lock").open("a")
    try:
        fcntl.flock(lock_stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        LOG.error("another collector invocation holds %s", state_dir / "collector.lock")
        return 75

    report = {"schema_version": 1, "run_id": run_id, "environment": "TEST", "mode": args.mode,
              "started_at": stamp(run_start), "status": "running", "windows": [], "archive_root": config["archive_root"]}
    report_path = run_dir / "run-report.json"
    atomic_json(report_path, report)
    collector = Collector(config)
    try:
        now = dt.datetime.now(UTC)
        if args.mode == "incremental":
            cp_path = state_dir / "incremental.json"
            cp = checkpoint(cp_path)
            overlap = dt.timedelta(seconds=int(config.get("overlap_seconds", 7200)))
            start = utc(cp["receive_through"]) - overlap if cp else now - dt.timedelta(seconds=int(config.get("initial_lookback_seconds", 86400)))
            end = now - dt.timedelta(seconds=int(config.get("settling_delay_seconds", 120)))
            if start >= end:
                LOG.info("no settled incremental interval is available")
            else:
                count, files = collector.window(start, end, "receiveTimestamp")
                report["windows"].append({"start": stamp(start), "end": stamp(end), "entries": count, "files": files})
                atomic_json(cp_path, {"receive_through": stamp(end), "updated_at": stamp(dt.datetime.now(UTC)), "last_run_id": run_id})
        elif args.mode == "range":
            start, end = utc(args.start), utc(args.end)
            if start >= end:
                raise ValueError("--start must be before --end")
            count, files = collector.window(start, end, "timestamp")
            report["windows"].append({"start": stamp(start), "end": stamp(end), "entries": count, "files": files})
        else:
            cp_path = state_dir / "backfill.json"
            cp = checkpoint(cp_path)
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
                count, files = collector.window(start, end, "timestamp")
                report["windows"].append({"start": stamp(start), "end": stamp(end), "entries": count, "files": files})
                # Window publication is complete before this resumable cursor advances.
                atomic_json(cp_path, {"event_through": stamp(end), "updated_at": stamp(dt.datetime.now(UTC)), "last_run_id": run_id})
                atomic_json(report_path, report)
                LOG.info("backfill_window_complete through=%s entries=%d", stamp(end), count)
                start = end
        report["status"] = "succeeded"
        return_code = 0
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
        handler.close()
    return return_code


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    raise SystemExit(main())
