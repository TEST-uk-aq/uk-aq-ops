#!/usr/bin/env python3
"""Apply storage-coverage accuracy fixes to the local dashboard backend.

The local IngestDB adapter checks bounded ranges of explicit UTC dates and
exposes failed checks as unavailable alongside independent source evidence.
Incomplete candidates remain diagnostic responses, never successful MySQL
calendar publications.
"""

from __future__ import annotations

import inspect
import os
import re
import threading
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Set

import requests
import uk_aq_dashboard_api as dashboard


_DIAGNOSTICS_LOCK = threading.Lock()
_MAX_PRESENCE_DAYS = 366
_UTC_TIMESTAMP = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z"
)
_INGEST_COVERAGE_DIAGNOSTICS: Dict[str, Any] = {
    "checked_day_count": 0,
    "failed_days": [],
    "warning": None,
    "updated_at": None,
}


def _iso_utc(value: Optional[datetime]) -> Optional[str]:
    if not isinstance(value, datetime):
        return None
    resolved = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
    return resolved.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _set_ingest_coverage_diagnostics(
    *,
    checked_day_count: int,
    failed_days: List[Dict[str, str]],
    warning: Optional[str],
) -> None:
    with _DIAGNOSTICS_LOCK:
        _INGEST_COVERAGE_DIAGNOSTICS.update(
            {
                "checked_day_count": int(checked_day_count),
                "failed_days": list(failed_days),
                "warning": warning,
                "updated_at": datetime.now(timezone.utc),
            }
        )


def _get_ingest_coverage_diagnostics() -> Dict[str, Any]:
    with _DIAGNOSTICS_LOCK:
        return {
            "checked_day_count": int(
                _INGEST_COVERAGE_DIAGNOSTICS.get("checked_day_count") or 0
            ),
            "failed_days": list(_INGEST_COVERAGE_DIAGNOSTICS.get("failed_days") or []),
            "warning": _INGEST_COVERAGE_DIAGNOSTICS.get("warning"),
            "updated_at": _INGEST_COVERAGE_DIAGNOSTICS.get("updated_at"),
        }


def _fetch_day_presence_object(
    url: str, headers: Dict[str, str], params: Dict[str, str],
) -> Dict[str, Any]:
    """Keep the existing GET accounting without _fetch_json's list fallback."""
    started_at = datetime.now(timezone.utc)
    response = requests.get(url, headers=headers, params=params, timeout=60)
    dashboard._record_dashboard_supabase_response(
        response.url or url,
        response,
        int((datetime.now(timezone.utc) - started_at).total_seconds() * 1000),
    )
    if not response.ok:
        raise RuntimeError(
            f"PostgREST GET error {response.status_code} at {dashboard._request_path(url)} "
            f"(params_keys={sorted(params)}): {dashboard._safe_response_text(response)}"
        )
    payload = response.json()
    if not isinstance(payload, dict):
        raise ValueError("Invalid IngestDB day-presence JSON object")
    return payload


def _validated_presence_days(
    payload: Dict[str, Any], first_day: date, exclusive_end: date,
) -> Set[date]:
    expected_count = (exclusive_end - first_day).days
    if (type(payload.get("schema_version")) is not int or payload["schema_version"] != 1
            or payload.get("complete") is not True
            or payload.get("from_day_utc") != first_day.isoformat()
            or payload.get("to_day_utc_exclusive") != exclusive_end.isoformat()
            or type(payload.get("checked_day_count")) is not int
            or payload["checked_day_count"] != expected_count):
        raise ValueError("Inconsistent IngestDB day-presence metadata")

    checked_at = payload.get("checked_at_utc")
    current_day = payload.get("current_day_utc")
    if not isinstance(checked_at, str) or not _UTC_TIMESTAMP.fullmatch(checked_at):
        raise ValueError("Invalid IngestDB day-presence check timestamp")
    try:
        checked_datetime = datetime.strptime(checked_at, "%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError as exc:
        raise ValueError("Invalid IngestDB day-presence check timestamp") from exc
    if current_day != checked_datetime.date().isoformat():
        raise ValueError("Inconsistent IngestDB day-presence current UTC day")

    rows = payload.get("days")
    if not isinstance(rows, list) or len(rows) != expected_count:
        raise ValueError("Incomplete IngestDB day-presence dates")
    present_days: Set[date] = set()
    for offset, row in enumerate(rows):
        expected_day = first_day + timedelta(days=offset)
        if (not isinstance(row, dict)
                or row.get("day_utc") != expected_day.isoformat()
                or type(row.get("present")) is not bool):
            raise ValueError("Invalid or unordered IngestDB day-presence date")
        if row["present"]:
            present_days.add(expected_day)
    return present_days


def _fetch_ingest_observation_days(
    base_url: str,
    service_role_key: str,
    from_day: date,
    now: datetime,
) -> Set[Any]:
    """Return only confirmed positive days; leave failed chunks unavailable."""

    if not base_url or not service_role_key:
        warning = "IngestDB coverage unavailable: dashboard database credentials are missing."
        _set_ingest_coverage_diagnostics(
            checked_day_count=0,
            failed_days=[],
            warning=warning,
        )
        return set()

    today_utc = now.astimezone(timezone.utc).date()
    if type(from_day) is not date or from_day > today_utc:
        _set_ingest_coverage_diagnostics(
            checked_day_count=0,
            failed_days=[],
            warning="IngestDB coverage unavailable: committed R2 calendar boundary is invalid.",
        )
        return set()

    try:
        safe_base_url = dashboard._ensure_allowed_base_url(base_url)
    except Exception as exc:  # noqa: BLE001
        warning = f"IngestDB coverage unavailable: invalid dashboard database URL ({exc})."
        _set_ingest_coverage_diagnostics(
            checked_day_count=0,
            failed_days=[],
            warning=warning,
        )
        return set()

    url = f"{safe_base_url}/rpc/uk_aq_rpc_observation_day_presence_v1"
    headers = dashboard._postgrest_headers(
        service_role_key,
        schema=dashboard.PUBLIC_SCHEMA,
    )

    days_with_rows: Set[Any] = set()
    failed_days: List[Dict[str, str]] = []
    checked_day_count = 0
    cursor = from_day
    end_exclusive = today_utc + timedelta(days=1)

    while cursor < end_exclusive:
        next_day_utc = min(cursor + timedelta(days=_MAX_PRESENCE_DAYS), end_exclusive)
        try:
            payload = _fetch_day_presence_object(
                url,
                headers,
                {
                    "p_from_day_utc": cursor.isoformat(),
                    "p_to_day_utc_exclusive": next_day_utc.isoformat(),
                },
            )
            confirmed_days = _validated_presence_days(payload, cursor, next_day_utc)
            days_with_rows.update(confirmed_days)
            checked_day_count += (next_day_utc - cursor).days
        except Exception as exc:  # noqa: BLE001
            error_text = str(exc).strip().replace("\n", " ")
            if len(error_text) > 300:
                error_text = error_text[:297] + "..."
            failed_cursor = cursor
            while failed_cursor < next_day_utc:
                failed_days.append(
                    {
                        "day_utc": failed_cursor.isoformat(),
                        "error": error_text or exc.__class__.__name__,
                    }
                )
                failed_cursor += timedelta(days=1)

        cursor = next_day_utc

    warning = None
    if failed_days:
        warning = (
            f"IngestDB coverage is partial: {len(failed_days)} day check(s) failed. "
            "Failed dates are unavailable; successful day checks remain visible."
        )

    _set_ingest_coverage_diagnostics(
        checked_day_count=checked_day_count,
        failed_days=failed_days,
        warning=warning,
    )
    return days_with_rows


_original_build_live_storage_coverage_days = dashboard._build_live_storage_coverage_days


def _build_live_storage_coverage_days(*args: Any, **kwargs: Any) -> List[Dict[str, Any]]:
    rows = _original_build_live_storage_coverage_days(*args, **kwargs)

    try:
        bound = inspect.signature(_original_build_live_storage_coverage_days).bind_partial(
            *args,
            **kwargs,
        )
        day_sets = bound.arguments.get("day_sets")
    except (TypeError, ValueError):
        day_sets = kwargs.get("day_sets")

    ingest_days = day_sets.get("ingestdb") if isinstance(day_sets, dict) else None
    if not isinstance(ingest_days, set):
        return rows

    diagnostics = _get_ingest_coverage_diagnostics()
    failed_days = {item.get("day_utc") for item in diagnostics.get("failed_days", [])}
    unavailable = bool(diagnostics.get("warning")) and not failed_days
    for row in rows:
        parsed_day = dashboard._parse_iso_day(row.get("date"))
        row["ingest"] = (
            None if unavailable or row.get("date") in failed_days
            else parsed_day in ingest_days if parsed_day is not None else None
        )

    return rows


_original_build_storage_coverage_payload = dashboard._build_storage_coverage_payload


def _build_storage_coverage_payload(*args: Any, **kwargs: Any) -> Dict[str, Any]:
    payload = _original_build_storage_coverage_payload(*args, **kwargs)
    diagnostics = _get_ingest_coverage_diagnostics()

    with dashboard.CACHE_LOCK:
        next_refresh_at = dashboard.STORAGE_COVERAGE_CACHE_STATE.get("next_refresh_at")

    generated_at = None
    if isinstance(next_refresh_at, datetime):
        generated_at = next_refresh_at - timedelta(
            seconds=dashboard.STORAGE_COVERAGE_CACHE_TTL_SECONDS
        )

    payload.update(
        {
            "storage_coverage_generated_at": _iso_utc(generated_at),
            "storage_coverage_next_refresh_at": _iso_utc(next_refresh_at),
            "storage_coverage_cache_ttl_seconds": int(
                dashboard.STORAGE_COVERAGE_CACHE_TTL_SECONDS
            ),
            "ingest_coverage_warning": diagnostics.get("warning"),
            "ingest_coverage_checked_day_count": diagnostics.get("checked_day_count", 0),
            "ingest_coverage_failed_days": diagnostics.get("failed_days", []),
            "ingest_coverage_diagnostics_updated_at": _iso_utc(
                diagnostics.get("updated_at")
            ),
        }
    )
    rows = payload.get("storage_coverage_days")
    source_errors = dict(payload.get("upstream_refresh_errors") or {})
    if (payload.get("r2_history_read_version") or {}).get("version") == "v3":
        # Generation-blind legacy byte metrics are deliberately unavailable in
        # v3 and do not determine observation calendar presence.
        source_errors.pop("r2_domain_size_metrics_error", None)
    payload["storage_coverage_complete"] = (
        isinstance(rows, list) and bool(rows)
        and not diagnostics.get("warning")
        and not diagnostics.get("failed_days")
        and not source_errors
        and not payload.get("dropbox_backup_state_error")
        and all(
            isinstance(row, dict)
            and all(type(row.get(key)) is bool for key in (
                "ingest", "obs_aqi_observs", "r2_observs", "dropbox_observs"
            ))
            for row in rows
        )
    )
    return payload


def _configure_cache_ttl() -> None:
    raw_value = str(
        os.getenv(
            "UK_AQ_STORAGE_COVERAGE_CACHE_TTL_SECONDS",
            dashboard.STORAGE_COVERAGE_CACHE_TTL_SECONDS,
        )
    ).strip()
    try:
        parsed = int(raw_value)
    except ValueError:
        parsed = dashboard.STORAGE_COVERAGE_CACHE_TTL_SECONDS

    # Preserve the existing six-hour default while allowing an explicit override.
    dashboard.STORAGE_COVERAGE_CACHE_TTL_SECONDS = max(300, parsed)


def main() -> None:
    _configure_cache_ttl()
    dashboard._fetch_ingest_observation_days = _fetch_ingest_observation_days
    dashboard._build_live_storage_coverage_days = _build_live_storage_coverage_days
    dashboard._build_storage_coverage_payload = _build_storage_coverage_payload
    dashboard.main()


if __name__ == "__main__":
    main()
