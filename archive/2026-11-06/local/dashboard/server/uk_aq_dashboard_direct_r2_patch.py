#!/usr/bin/env python3
"""Add direct, version-aware R2 day discovery to the TEST dashboard.

R2 presence and Dropbox backup presence remain independent:
- R2 presence comes from the normal history-days source plus direct R2 listings.
- Dropbox presence comes from the hierarchical v2 backup state provided by
  uk_aq_dashboard_api.

The direct listing runs at most once per six-hour coverage cache period, unless
Force Refresh explicitly requests a current result.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Set, Tuple

import uk_aq_dashboard_api as dashboard
import uk_aq_dashboard_api_patch as coverage_patch


DIRECT_R2_ROOT_ENV = "UK_AQ_R2_HISTORY_DIRECT_RCLONE_ROOT"
DIRECT_R2_CACHE_TTL_ENV = "UK_AQ_R2_HISTORY_DIRECT_DAY_CACHE_TTL_SECONDS"
DAY_DIR_RE = re.compile(r"^day_utc=(\d{4}-\d{2}-\d{2})/?$")

_DIRECT_CACHE_LOCK = threading.Lock()
_DIRECT_CACHE: Dict[str, Any] = {
    "day_sets": None,
    "error": None,
    "generated_at": None,
    "cache_key": None,
}

_ORIGINAL_GET_R2_HISTORY_DAYS_CACHED = dashboard._get_r2_history_days_cached


def _find_rclone() -> Optional[str]:
    override = str(os.getenv("UK_AQ_RCLONE_BIN") or "").strip()
    candidates = [
        override,
        shutil.which("rclone") or "",
        "/opt/homebrew/bin/rclone",
        "/usr/local/bin/rclone",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file() and os.access(candidate, os.X_OK):
            return candidate
    return None


def _cache_ttl_seconds() -> int:
    raw = str(
        os.getenv(
            DIRECT_R2_CACHE_TTL_ENV,
            dashboard.STORAGE_COVERAGE_CACHE_TTL_SECONDS,
        )
    ).strip()
    try:
        parsed = int(raw)
    except ValueError:
        parsed = dashboard.STORAGE_COVERAGE_CACHE_TTL_SECONDS
    return max(300, parsed)


def _resolve_direct_root() -> Tuple[Optional[str], Optional[str], Optional[str]]:
    version_info = dashboard._resolve_r2_history_read_version()
    version = version_info["version"]
    configured = str(os.getenv(DIRECT_R2_ROOT_ENV) or "").strip().rstrip("/")
    if not configured:
        return None, version, None
    # Existing roots end in history/vN; only their explicit remote/bucket identity
    # is configuration. The authoritative descriptor supplies the storage path.
    match = re.fullmatch(r"(.+)/history/v[123]", configured)
    if not match:
        return None, version, "Direct R2 root must name an explicit remote/bucket/history/vN"
    root = match.group(1) + "/" + version_info["generation"]["observations_prefix"].rsplit("/", 1)[0]
    return root, version, None


def _parse_day_directories(stdout: str) -> Set[date]:
    days: Set[date] = set()
    for raw_line in str(stdout or "").splitlines():
        match = DAY_DIR_RE.fullmatch(raw_line.strip())
        if not match:
            continue
        parsed = dashboard._parse_iso_day(match.group(1))
        if parsed is not None:
            days.add(parsed)
    return days


def _list_domain_days(rclone_bin: str, root: str, domain: str) -> Tuple[Set[date], Optional[str]]:
    path = f"{root}/{domain}"
    try:
        result = subprocess.run(
            [
                rclone_bin,
                "lsf",
                path,
                "--dirs-only",
                "--max-depth",
                "1",
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return set(), f"direct R2 {domain} listing failed ({exc.__class__.__name__})"

    if result.returncode != 0:
        detail = str(result.stderr or "").strip().replace("\n", " ")
        if len(detail) > 500:
            detail = detail[:497] + "..."
        return set(), (
            f"direct R2 {domain} listing failed with exit {result.returncode}"
            + (f": {detail}" if detail else "")
        )

    return _parse_day_directories(result.stdout), None


def _get_direct_r2_days(
    *,
    force_refresh: bool,
) -> Tuple[Optional[Dict[str, Set[date]]], Optional[str], Optional[str]]:
    root, version, root_error = _resolve_direct_root()
    if root_error or not root or not version:
        return None, root_error, None

    cache_key = f"{version}|{root}"
    now = datetime.now(timezone.utc)
    ttl = timedelta(seconds=_cache_ttl_seconds())

    with _DIRECT_CACHE_LOCK:
        generated_at = _DIRECT_CACHE.get("generated_at")
        if (
            not force_refresh
            and _DIRECT_CACHE.get("cache_key") == cache_key
            and isinstance(_DIRECT_CACHE.get("day_sets"), dict)
            and isinstance(generated_at, datetime)
            and now - generated_at < ttl
        ):
            cached = _DIRECT_CACHE["day_sets"]
            return (
                {
                    "observations": set(cached.get("observations") or set()),
                    "aqilevels": set(cached.get("aqilevels") or set()),
                },
                _DIRECT_CACHE.get("error"),
                root,
            )

    rclone_bin = _find_rclone()
    if not rclone_bin:
        error = "direct R2 day discovery unavailable because rclone was not found"
        return None, error, root

    observations, observations_error = _list_domain_days(
        rclone_bin,
        root,
        "observations",
    )
    # Calculated AQI is retired; optional legacy diagnostic days come from metrics.
    aqilevels, aqilevels_error = set(), None

    errors = [
        value
        for value in (observations_error, aqilevels_error)
        if isinstance(value, str) and value.strip()
    ]
    error = "; ".join(errors) if errors else None
    day_sets = {
        "observations": observations,
        "aqilevels": aqilevels,
    }

    with _DIRECT_CACHE_LOCK:
        _DIRECT_CACHE.update(
            {
                "day_sets": day_sets,
                "error": error,
                "generated_at": now,
                "cache_key": cache_key,
            }
        )

    return (None if error else day_sets), error, root


def _merge_errors(*parts: Optional[str]) -> Optional[str]:
    values = [str(part).strip() for part in parts if str(part or "").strip()]
    return "; ".join(values) if values else None


def _get_r2_history_days_cached(
    *,
    force_refresh: bool = False,
    base_url: Optional[str] = None,
    service_role_key: Optional[str] = None,
):
    normal_days, r2_window, bucket, normal_error = (
        _ORIGINAL_GET_R2_HISTORY_DAYS_CACHED(
            force_refresh=force_refresh,
            base_url=base_url,
            service_role_key=service_role_key,
        )
    )

    direct_days, direct_error, direct_root = _get_direct_r2_days(
        force_refresh=force_refresh,
    )

    if not isinstance(normal_days, dict):
        return None, r2_window, bucket, _merge_errors(normal_error, direct_error)
    committed = {name: set(normal_days.get(name) or set()) for name in ("observations", "aqilevels")}
    if isinstance(direct_days, dict) and not direct_error:
        committed["observations"].intersection_update(direct_days.get("observations") or set())
    return committed, r2_window, bucket, _merge_errors(normal_error, direct_error)


def install():
    dashboard._get_r2_history_days_cached = _get_r2_history_days_cached
    coverage_patch._configure_cache_ttl()
    dashboard._fetch_ingest_observation_days = coverage_patch._fetch_ingest_observation_days
    dashboard._build_live_storage_coverage_days = coverage_patch._build_live_storage_coverage_days
    dashboard._build_storage_coverage_payload = coverage_patch._build_storage_coverage_payload
    return dashboard


def main() -> None:
    install().main()


if __name__ == "__main__":
    main()
