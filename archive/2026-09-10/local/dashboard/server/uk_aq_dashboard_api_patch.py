#!/usr/bin/env python3
"""Apply storage-coverage accuracy fixes to the local dashboard backend.

This wrapper keeps the main dashboard backend unchanged while TEST validates the
behaviour. It prevents failed IngestDB day checks from becoming an inferred
continuous date range, retains confirmed days after partial failures, exposes
coverage diagnostics, and preserves IngestDB presence when R2 also exists.
"""

from __future__ import annotations

import inspect
import os
import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Set

import uk_aq_dashboard_api as dashboard


_DIAGNOSTICS_LOCK = threading.Lock()
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


def _fetch_ingest_observation_days(
    base_url: str,
    service_role_key: str,
    db_size_metrics: Optional[List[Dict[str, Any]]],
    now: datetime,
) -> Set[Any]:
    """Return only positively confirmed IngestDB days.

    A failed daily RPC no longer returns ``None`` because that made the existing
    calendar fallback infer that every day from the oldest metric through today
    contained observations. Successful day checks are retained and failures are
    reported separately.
    """

    if not base_url or not service_role_key:
        warning = "IngestDB coverage unavailable: dashboard database credentials are missing."
        _set_ingest_coverage_diagnostics(
            checked_day_count=0,
            failed_days=[],
            warning=warning,
        )
        return set()

    oldest_day = dashboard._latest_oldest_day_by_label(db_size_metrics).get("ingestdb")
    if oldest_day is None:
        _set_ingest_coverage_diagnostics(
            checked_day_count=0,
            failed_days=[],
            warning=None,
        )
        return set()

    today_utc = now.astimezone(timezone.utc).date()
    if oldest_day > today_utc:
        _set_ingest_coverage_diagnostics(
            checked_day_count=0,
            failed_days=[],
            warning=None,
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

    url = f"{safe_base_url}/rpc/uk_aq_rpc_observations_hourly_fingerprint"
    headers = dashboard._postgrest_headers(
        service_role_key,
        schema=dashboard.PUBLIC_SCHEMA,
    )

    days_with_rows: Set[Any] = set()
    failed_days: List[Dict[str, str]] = []
    checked_day_count = 0
    cursor = oldest_day

    while cursor <= today_utc:
        next_day_utc = cursor + timedelta(days=1)
        try:
            batch = dashboard._fetch_json(
                url,
                headers,
                {
                    "window_start": f"{cursor.isoformat()}T00:00:00Z",
                    "window_end": f"{next_day_utc.isoformat()}T00:00:00Z",
                    "select": "hour_start,observation_count",
                    "order": "hour_start.asc",
                    "limit": "1",
                    "offset": "0",
                },
            )
            checked_day_count += 1
        except Exception as exc:  # noqa: BLE001
            error_text = str(exc).strip().replace("\n", " ")
            if len(error_text) > 300:
                error_text = error_text[:297] + "..."
            failed_days.append(
                {
                    "day_utc": cursor.isoformat(),
                    "error": error_text or exc.__class__.__name__,
                }
            )
            cursor = next_day_utc
            continue

        first_row = batch[0] if batch and isinstance(batch[0], dict) else None
        if first_row:
            try:
                observation_count = int(first_row.get("observation_count") or 0)
            except (TypeError, ValueError):
                observation_count = 0
            if observation_count > 0:
                days_with_rows.add(cursor)

        cursor = next_day_utc

    warning = None
    if failed_days:
        warning = (
            f"IngestDB coverage is partial: {len(failed_days)} day check(s) failed. "
            "Only positively confirmed IngestDB days are shown."
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

    # The base implementation makes the top layer mutually exclusive by clearing
    # ingest whenever R2 exists. Restore the independently confirmed IngestDB flag;
    # the front-end enhancement presents both sources together.
    for row in rows:
        parsed_day = dashboard._parse_iso_day(row.get("date"))
        row["ingest"] = parsed_day in ingest_days if parsed_day is not None else False

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
