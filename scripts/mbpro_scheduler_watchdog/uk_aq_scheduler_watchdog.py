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
DROPBOX_REPORT_RETRY_DELAYS_SECONDS = (120, 300, 900, 1_800)
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
        self.outages: dict[str, list[dict[str, Any]]] = {
            worker_name: [] for worker_name in worker_names
        }
        self.report_executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="uk-aq-scheduler-watchdog-dropbox",
        )

    def _takeover_runs(self, worker_name: str) -> list[tuple[int, int, int]]:
        runs: list[tuple[int, int, int]] = []
        start: int | None = None
        previous: int | None = None
        for slot, observation in sorted(self.observations[worker_name].items()):
            if observation != "watchdog_takeover":
                if start is not None and previous is not None:
                    runs.append((start, previous, ((previous - start) // 60) + 1))
                start = None
                previous = None
                continue
            if previous is None or slot != previous + 60:
                if start is not None and previous is not None:
                    runs.append((start, previous, ((previous - start) // 60) + 1))
                start = slot
            previous = slot
        if start is not None and previous is not None:
            runs.append((start, previous, ((previous - start) // 60) + 1))
        return runs

    def _new_outage(
        self,
        worker_name: str,
        start_slot: int,
        end_slot: int,
        count: int,
    ) -> dict[str, Any]:
        detected_at = utc_timestamp()
        error_id = str(uuid.uuid4())
        latest_slot = minute_slot_text(end_slot)
        message = (
            f"Cloudflare Cron did not claim the {self.environment} "
            f"{worker_name} scheduler for {count} consecutive minutes. "
            "The MacBook Pro scheduler watchdog supplied scheduling continuity "
            "during this interval."
        )
        payload = {
            "id": error_id,
            "created_at": detected_at,
            "source": "scheduler_watchdog",
            "service": "scheduler_watchdog",
            "severity": "error",
            "message": message,
            "stack": None,
            "context": {
                "error_type": "cloudflare_cron_sustained_outage",
                "environment": self.environment,
                "scheduler": worker_name,
                "worker": worker_name,
                "latest_minute_slot": latest_slot,
                "consecutive_takeover_count": count,
                "threshold": CRON_OUTAGE_THRESHOLD_SLOTS,
                "watchdog_trigger_source": "external_watchdog",
                "source_file": (
                    "scripts/mbpro_scheduler_watchdog/"
                    "uk_aq_scheduler_watchdog.py"
                ),
            },
            "connector_id": None,
            "connector_code": None,
            "station_id": None,
            "timeseries_id": None,
            "dropbox_path": None,
        }
        return {
            "start_slot": start_slot,
            "end_slot": end_slot,
            "count": count,
            "identity_start_slot": start_slot,
            "identity_end_slot": end_slot,
            "active": True,
            "recovery_slot": None,
            "recovery_logged": False,
            "payload": payload,
            "report_attempts": 0,
            "report_in_flight": False,
            "report_succeeded": False,
            "report_not_configured_logged": False,
            "next_report_attempt": 0.0,
        }

    def _qualifying_outage_episodes(
        self, worker_name: str
    ) -> list[dict[str, int | bool | None]]:
        observations = self.observations[worker_name]
        cloudflare_slots = sorted(
            slot
            for slot, value in observations.items()
            if value == "cloudflare_cron"
        )
        episodes_by_recovery: dict[
            int | None, dict[str, int | bool | None]
        ] = {}
        for start_slot, end_slot, count in self._takeover_runs(worker_name):
            if count < CRON_OUTAGE_THRESHOLD_SLOTS:
                continue
            recovery_slot = next(
                (slot for slot in cloudflare_slots if slot > end_slot),
                None,
            )
            episode = episodes_by_recovery.get(recovery_slot)
            if episode is None:
                episodes_by_recovery[recovery_slot] = {
                    "start_slot": start_slot,
                    "end_slot": end_slot,
                    "count": count,
                    "identity_start_slot": start_slot,
                    "identity_end_slot": end_slot,
                    "recovery_slot": recovery_slot,
                }
                continue
            episode["start_slot"] = min(
                int(episode["start_slot"]), start_slot
            )
            episode["end_slot"] = max(int(episode["end_slot"]), end_slot)
            episode["count"] = max(int(episode["count"]), count)
        episodes = sorted(
            episodes_by_recovery.values(),
            key=lambda episode: int(episode["start_slot"]),
        )
        for episode in episodes:
            start_slot = int(episode["start_slot"])
            end_slot = int(episode["end_slot"])
            episode["unresolved_internal_gaps"] = any(
                slot not in observations
                for slot in range(start_slot, end_slot + 60, 60)
            )
        return episodes

    def _recompute_outages(
        self, worker_name: str
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        newly_detected: list[dict[str, Any]] = []
        recoveries: list[dict[str, Any]] = []
        episodes = self._qualifying_outage_episodes(worker_name)
        existing_outages = self.outages[worker_name]
        assigned_outage_ids: set[int] = set()

        # The identity range is the qualifying run that first created the
        # stable report payload. Recomputed interval boundaries may move, but
        # this anchor must not move when late Cloudflare evidence splits a
        # previously provisional episode.
        anchored_episode_by_outage_id: dict[int, int] = {}
        for outage in existing_outages:
            identity_start = int(
                outage.get("identity_start_slot", outage["start_slot"])
            )
            identity_end = int(
                outage.get("identity_end_slot", outage["end_slot"])
            )
            for episode_index, episode in enumerate(episodes):
                if (
                    int(episode["start_slot"]) <= identity_start
                    and identity_end <= int(episode["end_slot"])
                ):
                    anchored_episode_by_outage_id[id(outage)] = episode_index
                    break

        for episode_index, episode in enumerate(episodes):
            start_slot = int(episode["start_slot"])
            end_slot = int(episode["end_slot"])
            count = int(episode["count"])
            recovery_slot = episode["recovery_slot"]
            recovery_is_conclusive = (
                recovery_slot is not None
                and not bool(episode["unresolved_internal_gaps"])
            )
            matching = next(
                (
                    outage
                    for outage in existing_outages
                    if id(outage) not in assigned_outage_ids
                    and anchored_episode_by_outage_id.get(id(outage))
                    == episode_index
                ),
                None,
            )
            if matching is None:
                # Support an older retained outage whose identity anchor has
                # aged out of the observation window, without letting it steal
                # an episode from an outage anchored to another retained
                # chronological segment.
                matching = next(
                    (
                        outage
                        for outage in existing_outages
                        if id(outage) not in assigned_outage_ids
                        and id(outage) not in anchored_episode_by_outage_id
                        and outage["start_slot"] <= end_slot
                        and start_slot <= outage["end_slot"]
                    ),
                    None,
                )
            if matching is None:
                matching = self._new_outage(
                    worker_name, start_slot, end_slot, count
                )
                matching["identity_start_slot"] = int(
                    episode["identity_start_slot"]
                )
                matching["identity_end_slot"] = int(
                    episode["identity_end_slot"]
                )
                existing_outages.append(matching)
                newly_detected.append(matching)
            else:
                matching["start_slot"] = start_slot
                matching["end_slot"] = end_slot
                matching["count"] = count
            assigned_outage_ids.add(id(matching))

            matching["active"] = not recovery_is_conclusive
            matching["recovery_slot"] = (
                recovery_slot if recovery_is_conclusive else None
            )
            if recovery_is_conclusive and not matching["recovery_logged"]:
                matching["recovery_logged"] = True
                recoveries.append(matching)
        return newly_detected, recoveries

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
        recoveries: list[dict[str, Any]] = []
        newly_detected: list[dict[str, Any]] = []
        reports_to_submit: list[dict[str, Any]] = []
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
                self._prune_observations(worker_name)
                newly_detected, recoveries = self._recompute_outages(worker_name)
                now = time.monotonic()
                for outage in self.outages[worker_name]:
                    if (
                        not outage["report_succeeded"]
                        and not outage["report_in_flight"]
                        and outage["report_attempts"]
                        <= len(DROPBOX_REPORT_RETRY_DELAYS_SECONDS)
                        and now >= outage["next_report_attempt"]
                    ):
                        outage["report_in_flight"] = True
                        reports_to_submit.append(outage)

        if conflict is not None:
            log_event(
                self.logger,
                "scheduler_watchdog_cron_health_observation_conflict",
                **conflict,
            )
        for outage in newly_detected:
            log_event(
                self.logger,
                "scheduler_watchdog_cloudflare_cron_outage_detected",
                environment=self.environment,
                worker=worker_name,
                minute_slot=minute_slot_text(outage["end_slot"]),
                consecutive_takeover_count=outage["count"],
                threshold=CRON_OUTAGE_THRESHOLD_SLOTS,
                detection_timestamp=outage["payload"]["created_at"],
            )
        for outage in recoveries:
            log_event(
                self.logger,
                "scheduler_watchdog_cloudflare_cron_recovered",
                environment=self.environment,
                worker=worker_name,
                minute_slot=minute_slot_text(outage["recovery_slot"]),
                consecutive_takeover_count=0,
                previous_consecutive_takeover_count=outage["count"],
                threshold=CRON_OUTAGE_THRESHOLD_SLOTS,
            )
        for outage in reports_to_submit:
            try:
                self.report_executor.submit(self._report_outage, outage)
            except Exception as exc:
                with self.lock:
                    outage["report_in_flight"] = False
                log_event(
                    self.logger,
                    "scheduler_watchdog_dropbox_error_upload_failed",
                    environment=self.environment,
                    worker=worker_name,
                    minute_slot=minute_slot_text(outage["end_slot"]),
                    error_type=type(exc).__name__,
                    message=str(exc)[:500],
                )

    def _report_outage(self, outage: dict[str, Any]) -> None:
        payload = outage["payload"]
        error_id = str(payload["id"])
        worker_name = str(payload["context"]["worker"])
        count = int(payload["context"]["consecutive_takeover_count"])
        minute_slot = str(payload["context"]["latest_minute_slot"])
        try:
            path = upload_dropbox_error_record(self.settings, payload)
        except Exception as exc:
            with self.lock:
                outage["report_in_flight"] = False
                outage["report_attempts"] += 1
                attempt = outage["report_attempts"]
                if attempt <= len(DROPBOX_REPORT_RETRY_DELAYS_SECONDS):
                    outage["next_report_attempt"] = time.monotonic() + (
                        DROPBOX_REPORT_RETRY_DELAYS_SECONDS[attempt - 1]
                    )
            log_event(
                self.logger,
                "scheduler_watchdog_dropbox_error_upload_failed",
                environment=self.environment,
                worker=worker_name,
                minute_slot=minute_slot,
                consecutive_takeover_count=count,
                threshold=CRON_OUTAGE_THRESHOLD_SLOTS,
                error_id=error_id,
                error_type=type(exc).__name__,
                message=str(exc)[:500],
                upload_attempt=attempt,
                retry_scheduled=(
                    attempt <= len(DROPBOX_REPORT_RETRY_DELAYS_SECONDS)
                ),
            )
            return
        if path is None:
            with self.lock:
                outage["report_in_flight"] = False
                outage["report_attempts"] += 1
                outage["report_not_configured_logged"] = True
                outage["report_succeeded"] = True
            log_event(
                self.logger,
                "scheduler_watchdog_dropbox_error_not_configured",
                environment=self.environment,
                worker=worker_name,
                minute_slot=minute_slot,
                consecutive_takeover_count=count,
                threshold=CRON_OUTAGE_THRESHOLD_SLOTS,
                error_id=error_id,
            )
            return
        with self.lock:
            outage["report_in_flight"] = False
            outage["report_attempts"] += 1
            outage["report_succeeded"] = True
        log_event(
            self.logger,
            "scheduler_watchdog_dropbox_error_uploaded",
            environment=self.environment,
            worker=worker_name,
            minute_slot=minute_slot,
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
