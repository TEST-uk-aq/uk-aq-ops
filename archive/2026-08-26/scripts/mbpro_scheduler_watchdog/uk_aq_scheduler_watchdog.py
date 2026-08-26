#!/usr/bin/env python3
"""Run authenticated UK AQ TEST scheduler watchdog calls on each UTC minute."""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
import signal
import threading
import time
from datetime import UTC, datetime
from typing import Any
from urllib import error, request


DEFAULT_OFFSET_SECONDS = 10
DEFAULT_REQUEST_TIMEOUT_SECONDS = 900
DEFAULT_MAX_IN_FLIGHT_PER_WORKER = 4
RESPONSE_PREVIEW_LIMIT = 1_000
LOG_MAX_BYTES = 1_000_000
LOG_BACKUP_COUNT = 7
REQUIRED_SETTINGS = (
    "UK_AQ_SCHEDULER_TRIGGER_SECRET",
    "UK_AQ_INGEST_SCHEDULER_URL",
    "UK_AQ_OPS_SCHEDULER_URL",
)


def load_env_file(path: Path) -> dict[str, str]:
    settings: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        key, separator, value = stripped.partition("=")
        if not separator or not key.strip():
            raise ValueError(f"Invalid configuration line in {path.name}")
        settings[key.strip()] = value.strip()
    missing = [key for key in REQUIRED_SETTINGS if not settings.get(key)]
    if missing:
        raise ValueError(f"Missing required configuration keys: {', '.join(missing)}")
    return settings


def positive_int(settings: dict[str, str], key: str, default: int) -> int:
    raw = settings.get(key, str(default)).strip()
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{key} must be a positive integer") from exc
    if value <= 0:
        raise ValueError(f"{key} must be a positive integer")
    return value


def normalize_worker_url(value: str) -> str:
    url = value.strip().rstrip("/")
    if not url.startswith("https://"):
        raise ValueError("Scheduler Worker URLs must use https")
    return url if url.endswith("/run-if-due") else f"{url}/run-if-due"


def minute_slot_text(timestamp: float) -> str:
    minute = int(timestamp // 60) * 60
    return datetime.fromtimestamp(minute, UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def bounded_preview(value: bytes | str | None) -> str | None:
    if value is None:
        return None
    text = value.decode("utf-8", errors="replace") if isinstance(value, bytes) else str(value)
    text = " ".join(text.split())
    if not text:
        return None
    return text[: RESPONSE_PREVIEW_LIMIT - 3] + "..." if len(text) > RESPONSE_PREVIEW_LIMIT else text


def configure_logger(log_file: Path) -> logging.Logger:
    log_file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    handler = RotatingFileHandler(
        log_file,
        maxBytes=LOG_MAX_BYTES,
        backupCount=LOG_BACKUP_COUNT,
        encoding="utf-8",
    )
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger = logging.getLogger("uk_aq_scheduler_watchdog")
    logger.handlers.clear()
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False
    return logger


def log_event(logger: logging.Logger, event: str, **fields: Any) -> None:
    logger.info(json.dumps({"event": event, "timestamp": datetime.now(UTC).isoformat(), **fields}, sort_keys=True))


def invoke_worker(
    logger: logging.Logger,
    worker_name: str,
    url: str,
    trigger_secret: str,
    timeout_seconds: int,
    minute_slot: str,
) -> None:
    started = time.monotonic()
    log_event(logger, "scheduler_watchdog_request_started", worker=worker_name, minute_slot=minute_slot)
    http_status: int | None = None
    response_preview: str | None = None
    outcome = "request_failure"
    try:
        http_request = request.Request(
            url,
            method="POST",
            headers={
                "X-UK-AQ-Scheduler-Trigger": trigger_secret,
                "Accept": "application/json",
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 Chrome/150 Safari/537.36 "
                "UK-AQ-Scheduler-Watchdog/1.0",
            },
        )
        with request.urlopen(http_request, timeout=timeout_seconds) as response:
            http_status = response.status
            response_preview = bounded_preview(response.read(RESPONSE_PREVIEW_LIMIT))
        try:
            response_body = json.loads(response_preview or "{}")
        except json.JSONDecodeError:
            response_body = {}
        outcome = str(response_body.get("status") or "triggered")[:64]
    except error.HTTPError as exc:
        http_status = exc.code
        response_preview = bounded_preview(exc.read(RESPONSE_PREVIEW_LIMIT))
        outcome = "authentication_failure" if http_status in {401, 403} else "http_failure"
    except Exception as exc:  # standard-library network exceptions vary by platform
        outcome = "request_failure"
        response_preview = bounded_preview(str(exc))
    elapsed_ms = round((time.monotonic() - started) * 1000)
    log_event(
        logger,
        "scheduler_watchdog_request_finished",
        worker=worker_name,
        minute_slot=minute_slot,
        http_status=http_status,
        outcome=outcome,
        response_preview=response_preview,
        elapsed_ms=elapsed_ms,
    )


class SchedulerWatchdog:
    def __init__(self, settings: dict[str, str], logger: logging.Logger) -> None:
        self.logger = logger
        self.trigger_secret = settings["UK_AQ_SCHEDULER_TRIGGER_SECRET"]
        self.offset_seconds = positive_int(
            settings,
            "UK_AQ_SCHEDULER_WATCHDOG_OFFSET_SECONDS",
            DEFAULT_OFFSET_SECONDS,
        )
        if self.offset_seconds >= 60:
            raise ValueError("UK_AQ_SCHEDULER_WATCHDOG_OFFSET_SECONDS must be less than 60")
        self.timeout_seconds = positive_int(
            settings,
            "UK_AQ_SCHEDULER_WATCHDOG_REQUEST_TIMEOUT_SECONDS",
            DEFAULT_REQUEST_TIMEOUT_SECONDS,
        )
        self.max_in_flight = positive_int(
            settings,
            "UK_AQ_SCHEDULER_WATCHDOG_MAX_IN_FLIGHT_PER_WORKER",
            DEFAULT_MAX_IN_FLIGHT_PER_WORKER,
        )
        self.workers = {
            "ingest": normalize_worker_url(settings["UK_AQ_INGEST_SCHEDULER_URL"]),
            "ops": normalize_worker_url(settings["UK_AQ_OPS_SCHEDULER_URL"]),
        }
        self.stop_event = threading.Event()
        self.in_flight: dict[str, set[concurrent.futures.Future[None]]] = {
            worker_name: set() for worker_name in self.workers
        }
        self.executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=len(self.workers) * self.max_in_flight,
            thread_name_prefix="uk-aq-scheduler-watchdog",
        )

    def request_minute(self, minute_slot: str) -> None:
        for worker_name, url in self.workers.items():
            active = {future for future in self.in_flight[worker_name] if not future.done()}
            self.in_flight[worker_name] = active
            if len(active) >= self.max_in_flight:
                log_event(
                    self.logger,
                    "scheduler_watchdog_in_flight_cap_reached",
                    worker=worker_name,
                    minute_slot=minute_slot,
                    max_in_flight=self.max_in_flight,
                )
                continue
            future = self.executor.submit(
                invoke_worker,
                self.logger,
                worker_name,
                url,
                self.trigger_secret,
                self.timeout_seconds,
                minute_slot,
            )
            active.add(future)

    def run_forever(self) -> None:
        log_event(
            self.logger,
            "scheduler_watchdog_started",
            offset_seconds=self.offset_seconds,
            request_timeout_seconds=self.timeout_seconds,
            max_in_flight_per_worker=self.max_in_flight,
        )
        while not self.stop_event.is_set():
            now = time.time()
            next_trigger = int(now // 60) * 60 + self.offset_seconds
            if next_trigger <= now:
                next_trigger += 60
            if self.stop_event.wait(max(0, next_trigger - now)):
                break
            self.request_minute(minute_slot_text(next_trigger - self.offset_seconds))
        self.executor.shutdown(wait=False, cancel_futures=False)
        log_event(self.logger, "scheduler_watchdog_stopped")

    def stop(self, *_: object) -> None:
        self.stop_event.set()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--log-file", required=True, type=Path)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()

    settings = load_env_file(args.config)
    logger = configure_logger(args.log_file)
    watchdog = SchedulerWatchdog(settings, logger)
    signal.signal(signal.SIGTERM, watchdog.stop)
    signal.signal(signal.SIGINT, watchdog.stop)
    if args.once:
        watchdog.request_minute(minute_slot_text(time.time()))
        watchdog.executor.shutdown(wait=True)
        return 0
    watchdog.run_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
