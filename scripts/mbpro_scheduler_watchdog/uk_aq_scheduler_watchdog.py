#!/usr/bin/env python3
"""Run authenticated UK AQ scheduler watchdog calls on each UTC minute."""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import json
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
import signal
import threading
import time
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib import error, parse, request


DEFAULT_OFFSET_SECONDS = 30
DEFAULT_REQUEST_TIMEOUT_SECONDS = 900
DEFAULT_MAX_IN_FLIGHT_PER_WORKER = 4
CRON_OUTAGE_THRESHOLD_SLOTS = 10
CRON_OBSERVATION_RETENTION_SLOTS = 120
DROPBOX_REQUEST_TIMEOUT_SECONDS = 30
RESPONSE_PREVIEW_LIMIT = 1_000
LOG_MAX_BYTES = 1_000_000
LOG_BACKUP_COUNT = 7
DROPBOX_TOKEN_URL = "https://api.dropbox.com/oauth2/token"
DROPBOX_UPLOAD_URL = "https://content.dropboxapi.com/2/files/upload"
REQUIRED_SETTINGS = (
    "UKAQ_ENV_NAME",
    "UK_AQ_SCHEDULER_TRIGGER_SECRET",
    "UK_AQ_INGEST_SCHEDULER_URL",
    "UK_AQ_OPS_SCHEDULER_URL",
)
DROPBOX_SETTINGS = (
    "DROPBOX_APP_KEY",
    "DROPBOX_APP_SECRET",
    "DROPBOX_REFRESH_TOKEN",
    "UK_AQ_DROPBOX_ROOT",
)
OPTIONAL_SETTINGS = (
    *DROPBOX_SETTINGS,
    "UK_AQ_SCHEDULER_WATCHDOG_OFFSET_SECONDS",
    "UK_AQ_SCHEDULER_WATCHDOG_REQUEST_TIMEOUT_SECONDS",
    "UK_AQ_SCHEDULER_WATCHDOG_MAX_IN_FLIGHT_PER_WORKER",
)
ALLOWED_SETTINGS = frozenset((*REQUIRED_SETTINGS, *OPTIONAL_SETTINGS))


def load_env_file(path: Path) -> dict[str, str]:
    settings: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        key, separator, value = stripped.partition("=")
        if not separator or not key.strip():
            raise ValueError(f"Invalid configuration line in {path.name}")
        normalized_key = key.strip()
        if normalized_key in settings:
            raise ValueError(f"Duplicate configuration key: {normalized_key}")
        settings[normalized_key] = value.strip()
    missing = [key for key in REQUIRED_SETTINGS if not settings.get(key)]
    if missing:
        raise ValueError(f"Missing required configuration keys: {', '.join(missing)}")
    return settings


def canonical_environment(settings: dict[str, str]) -> str:
    environment = settings["UKAQ_ENV_NAME"].strip().upper()
    if environment not in {"TEST", "LIVE"}:
        raise ValueError("UKAQ_ENV_NAME must be TEST or LIVE")
    return environment


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


def normalize_dropbox_path(value: str) -> str:
    cleaned = value.strip().replace("\\", "/")
    while "//" in cleaned:
        cleaned = cleaned.replace("//", "/")
    if not cleaned:
        raise ValueError("UK_AQ_DROPBOX_ROOT must not be empty")
    path = cleaned if cleaned.startswith("/") else f"/{cleaned}"
    return path.rstrip("/") or "/"


def dropbox_reporting_configured(settings: dict[str, str]) -> bool:
    return all(settings.get(key, "").strip() for key in DROPBOX_SETTINGS)


def validate_watchdog_settings(settings: dict[str, str]) -> str:
    unexpected_settings = sorted(set(settings) - ALLOWED_SETTINGS)
    if unexpected_settings:
        raise ValueError(
            "Unsupported configuration keys: " + ", ".join(unexpected_settings)
        )

    environment = canonical_environment(settings)
    offset_seconds = positive_int(
        settings,
        "UK_AQ_SCHEDULER_WATCHDOG_OFFSET_SECONDS",
        DEFAULT_OFFSET_SECONDS,
    )
    if offset_seconds >= 60:
        raise ValueError("UK_AQ_SCHEDULER_WATCHDOG_OFFSET_SECONDS must be less than 60")
    positive_int(
        settings,
        "UK_AQ_SCHEDULER_WATCHDOG_REQUEST_TIMEOUT_SECONDS",
        DEFAULT_REQUEST_TIMEOUT_SECONDS,
    )
    positive_int(
        settings,
        "UK_AQ_SCHEDULER_WATCHDOG_MAX_IN_FLIGHT_PER_WORKER",
        DEFAULT_MAX_IN_FLIGHT_PER_WORKER,
    )
    normalize_worker_url(settings["UK_AQ_INGEST_SCHEDULER_URL"])
    normalize_worker_url(settings["UK_AQ_OPS_SCHEDULER_URL"])
    configured_dropbox_settings = [
        key for key in DROPBOX_SETTINGS if settings.get(key, "").strip()
    ]
    if configured_dropbox_settings and len(configured_dropbox_settings) != len(
        DROPBOX_SETTINGS
    ):
        missing = [key for key in DROPBOX_SETTINGS if key not in configured_dropbox_settings]
        raise ValueError(
            "Incomplete Dropbox error reporting configuration; missing: "
            + ", ".join(missing)
        )
    if dropbox_reporting_configured(settings):
        normalize_dropbox_path(settings["UK_AQ_DROPBOX_ROOT"])
    return environment


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


def utc_timestamp() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def canonical_response_minute_slot(value: object) -> tuple[int, str] | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    normalized = f"{raw[:-1]}+00:00" if raw.endswith("Z") else raw
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() != timedelta(0):
        return None
    parsed = parsed.astimezone(UTC)
    if parsed.second != 0 or parsed.microsecond != 0:
        return None
    epoch_minute = int(parsed.timestamp())
    return epoch_minute, minute_slot_text(epoch_minute)


def cron_health_observation(response_body: dict[str, Any]) -> str | None:
    status = str(response_body.get("status") or "").strip()
    claimed_trigger_source = str(
        response_body.get("claimed_trigger_source") or ""
    ).strip()
    if status == "triggered" and claimed_trigger_source == "cloudflare_cron":
        return None
    if claimed_trigger_source == "cloudflare_cron":
        return "cloudflare_cron"
    if status == "triggered":
        return "watchdog_takeover"
    return None


def compact_dropbox_timestamp(value: str) -> str:
    compact = value.replace("-", "").replace(":", "")
    if compact.endswith("Z") and "." in compact:
        compact = f"{compact.split('.', 1)[0]}Z"
    return compact


def dropbox_error_path(dropbox_root: str, created_at: str, error_id: str) -> str:
    root = normalize_dropbox_path(dropbox_root)
    root_prefix = "" if root == "/" else root
    date = created_at[:10]
    stamp = compact_dropbox_timestamp(created_at)
    filename = (
        "uk_aq_error_cloud_run_scheduler_watchdog_"
        f"{stamp}_{error_id}.json"
    )
    return f"{root_prefix}/error_log/{date}/{filename}"


def dropbox_access_token(settings: dict[str, str]) -> str:
    credentials = base64.b64encode(
        f"{settings['DROPBOX_APP_KEY']}:{settings['DROPBOX_APP_SECRET']}".encode(
            "utf-8"
        )
    ).decode("ascii")
    token_request = request.Request(
        DROPBOX_TOKEN_URL,
        data=parse.urlencode(
            {
                "grant_type": "refresh_token",
                "refresh_token": settings["DROPBOX_REFRESH_TOKEN"],
            }
        ).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Basic {credentials}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    try:
        with request.urlopen(
            token_request,
            timeout=DROPBOX_REQUEST_TIMEOUT_SECONDS,
        ) as response:
            token_body = json.loads(response.read(RESPONSE_PREVIEW_LIMIT))
    except error.HTTPError as exc:
        raise RuntimeError(f"Dropbox token request failed ({exc.code})") from exc
    access_token = str(
        token_body.get("access_token") if isinstance(token_body, dict) else ""
    ).strip()
    if not access_token:
        raise RuntimeError("Dropbox token response missing access_token")
    return access_token


def dropbox_upload(
    access_token: str,
    dropbox_path: str,
    payload_text: str,
) -> None:
    upload_request = request.Request(
        DROPBOX_UPLOAD_URL,
        data=payload_text.encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/octet-stream",
            "Dropbox-API-Arg": json.dumps(
                {"path": dropbox_path, "mode": "overwrite", "mute": True}
            ),
        },
    )
    try:
        with request.urlopen(
            upload_request,
            timeout=DROPBOX_REQUEST_TIMEOUT_SECONDS,
        ):
            return
    except error.HTTPError as exc:
        upload_error = RuntimeError(f"Dropbox upload failed ({exc.code})")
        setattr(upload_error, "http_status", exc.code)
        raise upload_error from exc


def upload_dropbox_error_record(
    settings: dict[str, str],
    payload: dict[str, Any],
) -> str | None:
    if not dropbox_reporting_configured(settings):
        return None
    created_at = str(payload["created_at"])
    error_id = str(payload["id"])
    path = dropbox_error_path(
        settings["UK_AQ_DROPBOX_ROOT"],
        created_at,
        error_id,
    )
    upload_payload = {**payload, "dropbox_path": path}
    payload_text = f"{json.dumps(upload_payload, indent=2, sort_keys=True)}\n"
    access_token = dropbox_access_token(settings)
    try:
        dropbox_upload(access_token, path, payload_text)
    except RuntimeError as exc:
        if getattr(exc, "http_status", None) != 401:
            raise
        access_token = dropbox_access_token(settings)
        dropbox_upload(access_token, path, payload_text)
    return path


class CronHealthTracker:
    def __init__(
        self,
        settings: dict[str, str],
        logger: logging.Logger,
        worker_names: tuple[str, ...],
    ) -> None:
        self.settings = settings
        self.logger = logger
        self.environment = canonical_environment(settings)
        self.lock = threading.Lock()
        self.observations: dict[str, dict[int, str]] = {
            worker_name: {} for worker_name in worker_names
        }
        self.outage_reported = {worker_name: False for worker_name in worker_names}
        self.outage_detection_slot: dict[str, int | None] = {
            worker_name: None for worker_name in worker_names
        }
        self.outage_detection_count = {worker_name: 0 for worker_name in worker_names}
        self.report_executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="uk-aq-scheduler-watchdog-dropbox",
        )

    def _consecutive_takeover_suffix(self, worker_name: str) -> tuple[int, int | None]:
        observations = self.observations[worker_name]
        if not observations:
            return 0, None
        latest_slot = max(observations)
        count = 0
        slot = latest_slot
        while observations.get(slot) == "watchdog_takeover":
            count += 1
            slot -= 60
        return count, latest_slot

    def _prune_observations(self, worker_name: str) -> None:
        observations = self.observations[worker_name]
        if not observations:
            return
        cutoff = max(observations) - CRON_OBSERVATION_RETENTION_SLOTS * 60
        self.observations[worker_name] = {
            slot: observation
            for slot, observation in observations.items()
            if slot >= cutoff
        }

    def record(
        self,
        worker_name: str,
        minute_epoch: int,
        minute_slot: str,
        observation: str,
    ) -> None:
        recovery: dict[str, Any] | None = None
        outage: dict[str, Any] | None = None
        conflict: dict[str, Any] | None = None
        with self.lock:
            observations = self.observations[worker_name]
            existing = observations.get(minute_epoch)
            if existing is not None and existing != observation:
                conflict = {
                    "environment": self.environment,
                    "worker": worker_name,
                    "minute_slot": minute_slot,
                    "existing_observation": existing,
                    "ignored_observation": observation,
                }
            else:
                observations[minute_epoch] = observation
                detection_slot = self.outage_detection_slot[worker_name]
                if (
                    self.outage_reported[worker_name]
                    and observation == "cloudflare_cron"
                    and detection_slot is not None
                    and minute_epoch > detection_slot
                ):
                    recovery = {
                        "environment": self.environment,
                        "worker": worker_name,
                        "minute_slot": minute_slot,
                        "consecutive_takeover_count": 0,
                        "previous_consecutive_takeover_count": (
                            self.outage_detection_count[worker_name]
                        ),
                        "threshold": CRON_OUTAGE_THRESHOLD_SLOTS,
                    }
                    self.outage_reported[worker_name] = False
                    self.outage_detection_slot[worker_name] = None
                    self.outage_detection_count[worker_name] = 0

                count, latest_slot_epoch = self._consecutive_takeover_suffix(
                    worker_name
                )
                if (
                    not self.outage_reported[worker_name]
                    and count >= CRON_OUTAGE_THRESHOLD_SLOTS
                    and latest_slot_epoch is not None
                ):
                    latest_slot = minute_slot_text(latest_slot_epoch)
                    outage = {
                        "environment": self.environment,
                        "worker": worker_name,
                        "minute_slot": latest_slot,
                        "consecutive_takeover_count": count,
                        "threshold": CRON_OUTAGE_THRESHOLD_SLOTS,
                        "detection_timestamp": utc_timestamp(),
                    }
                    self.outage_reported[worker_name] = True
                    self.outage_detection_slot[worker_name] = latest_slot_epoch
                    self.outage_detection_count[worker_name] = count
                self._prune_observations(worker_name)

        if conflict is not None:
            log_event(
                self.logger,
                "scheduler_watchdog_cron_health_observation_conflict",
                **conflict,
            )
        if recovery is not None:
            log_event(
                self.logger,
                "scheduler_watchdog_cloudflare_cron_recovered",
                **recovery,
            )
        if outage is not None:
            log_event(
                self.logger,
                "scheduler_watchdog_cloudflare_cron_outage_detected",
                **outage,
            )
            try:
                self.report_executor.submit(self._report_outage, outage)
            except Exception as exc:
                log_event(
                    self.logger,
                    "scheduler_watchdog_dropbox_error_upload_failed",
                    environment=self.environment,
                    worker=worker_name,
                    minute_slot=outage["minute_slot"],
                    error_type=type(exc).__name__,
                    message=str(exc)[:500],
                )

    def _report_outage(self, outage: dict[str, Any]) -> None:
        detected_at = str(outage["detection_timestamp"])
        error_id = str(uuid.uuid4())
        worker_name = str(outage["worker"])
        count = int(outage["consecutive_takeover_count"])
        message = (
            f"Cloudflare Cron has not claimed the {self.environment} "
            f"{worker_name} scheduler for {count} consecutive minutes. "
            "The MacBook Pro scheduler watchdog is currently providing "
            "scheduling continuity."
        )
        payload = {
            "id": error_id,
            "created_at": detected_at,
            "source": "scheduler_watchdog",
            "severity": "error",
            "message": message,
            "stack": None,
            "context": {
                "error_type": "cloudflare_cron_sustained_outage",
                "environment": self.environment,
                "scheduler": worker_name,
                "worker": worker_name,
                "latest_minute_slot": outage["minute_slot"],
                "consecutive_takeover_count": count,
                "threshold": CRON_OUTAGE_THRESHOLD_SLOTS,
                "watchdog_trigger_source": "external_watchdog",
                "source_file": (
                    "scripts/mbpro_scheduler_watchdog/"
                    "uk_aq_scheduler_watchdog.py"
                ),
            },
            "connector_id": None,
            "station_id": None,
            "timeseries_id": None,
            "dropbox_path": None,
        }
        try:
            path = upload_dropbox_error_record(self.settings, payload)
        except Exception as exc:
            log_event(
                self.logger,
                "scheduler_watchdog_dropbox_error_upload_failed",
                environment=self.environment,
                worker=worker_name,
                minute_slot=outage["minute_slot"],
                consecutive_takeover_count=count,
                threshold=CRON_OUTAGE_THRESHOLD_SLOTS,
                error_id=error_id,
                error_type=type(exc).__name__,
                message=str(exc)[:500],
            )
            return
        if path is None:
            log_event(
                self.logger,
                "scheduler_watchdog_dropbox_error_not_configured",
                environment=self.environment,
                worker=worker_name,
                minute_slot=outage["minute_slot"],
                consecutive_takeover_count=count,
                threshold=CRON_OUTAGE_THRESHOLD_SLOTS,
                error_id=error_id,
            )
            return
        log_event(
            self.logger,
            "scheduler_watchdog_dropbox_error_uploaded",
            environment=self.environment,
            worker=worker_name,
            minute_slot=outage["minute_slot"],
            consecutive_takeover_count=count,
            threshold=CRON_OUTAGE_THRESHOLD_SLOTS,
            error_id=error_id,
            dropbox_path=path,
        )

    def shutdown(self, wait: bool) -> None:
        self.report_executor.shutdown(wait=wait, cancel_futures=False)


def invoke_worker(
    logger: logging.Logger,
    environment: str,
    cron_health: CronHealthTracker,
    worker_name: str,
    url: str,
    trigger_secret: str,
    timeout_seconds: int,
    minute_slot: str,
) -> None:
    started = time.monotonic()
    log_event(
        logger,
        "scheduler_watchdog_request_started",
        environment=environment,
        worker=worker_name,
        minute_slot=minute_slot,
    )
    http_status: int | None = None
    response_preview: str | None = None
    response_minute_slot: str | None = None
    claimed_trigger_source: str | None = None
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
            response_bytes = response.read(RESPONSE_PREVIEW_LIMIT)
            response_preview = bounded_preview(response_bytes)
        try:
            decoded_body = json.loads(response_bytes)
        except (json.JSONDecodeError, UnicodeDecodeError):
            decoded_body = None
        response_body = decoded_body if isinstance(decoded_body, dict) else {}
        outcome = (
            str(response_body.get("status") or "unknown_response")[:64]
            if isinstance(decoded_body, dict)
            else "malformed_response"
        )
        claimed_trigger_source = str(
            response_body.get("claimed_trigger_source") or ""
        ).strip()[:64] or None
        parsed_minute_slot = canonical_response_minute_slot(
            response_body.get("minute_slot")
        )
        observation = cron_health_observation(response_body)
        if parsed_minute_slot is not None:
            minute_epoch, response_minute_slot = parsed_minute_slot
            if observation is not None:
                cron_health.record(
                    worker_name,
                    minute_epoch,
                    response_minute_slot,
                    observation,
                )
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
        environment=environment,
        worker=worker_name,
        minute_slot=minute_slot,
        response_minute_slot=response_minute_slot,
        claimed_trigger_source=claimed_trigger_source,
        http_status=http_status,
        outcome=outcome,
        response_preview=response_preview,
        elapsed_ms=elapsed_ms,
    )


class SchedulerWatchdog:
    def __init__(self, settings: dict[str, str], logger: logging.Logger) -> None:
        self.logger = logger
        self.environment = canonical_environment(settings)
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
        self.cron_health = CronHealthTracker(
            settings,
            logger,
            tuple(self.workers),
        )
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
                    environment=self.environment,
                    worker=worker_name,
                    minute_slot=minute_slot,
                    max_in_flight=self.max_in_flight,
                )
                continue
            future = self.executor.submit(
                invoke_worker,
                self.logger,
                self.environment,
                self.cron_health,
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
            environment=self.environment,
            offset_seconds=self.offset_seconds,
            request_timeout_seconds=self.timeout_seconds,
            max_in_flight_per_worker=self.max_in_flight,
            cron_outage_threshold_slots=CRON_OUTAGE_THRESHOLD_SLOTS,
            dropbox_error_reporting_configured=dropbox_reporting_configured(
                self.cron_health.settings
            ),
        )
        while not self.stop_event.is_set():
            now = time.time()
            next_trigger = int(now // 60) * 60 + self.offset_seconds
            if next_trigger <= now:
                next_trigger += 60
            if self.stop_event.wait(max(0, next_trigger - now)):
                break
            self.request_minute(minute_slot_text(next_trigger - self.offset_seconds))
        self.shutdown(wait=False)
        log_event(
            self.logger,
            "scheduler_watchdog_stopped",
            environment=self.environment,
        )

    def shutdown(self, wait: bool) -> None:
        self.executor.shutdown(wait=wait, cancel_futures=False)
        self.cron_health.shutdown(wait=wait)

    def stop(self, *_: object) -> None:
        self.stop_event.set()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--log-file", type=Path)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--validate-config", action="store_true")
    args = parser.parse_args()

    settings = load_env_file(args.config)
    environment = validate_watchdog_settings(settings)
    if args.validate_config:
        if args.once or args.log_file is not None:
            parser.error("--validate-config cannot be combined with --once or --log-file")
        print(environment)
        return 0
    if args.log_file is None:
        parser.error("--log-file is required unless --validate-config is used")
    logger = configure_logger(args.log_file)
    watchdog = SchedulerWatchdog(settings, logger)
    signal.signal(signal.SIGTERM, watchdog.stop)
    signal.signal(signal.SIGINT, watchdog.stop)
    if args.once:
        watchdog.request_minute(minute_slot_text(time.time()))
        watchdog.shutdown(wait=True)
        return 0
    watchdog.run_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
