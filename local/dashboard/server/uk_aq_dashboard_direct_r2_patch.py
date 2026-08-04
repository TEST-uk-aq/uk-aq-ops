#!/usr/bin/env python3
"""Add direct, version-aware R2 day discovery to the TEST dashboard.

R2 presence and Dropbox backup presence remain independent:
- R2 presence comes from the normal history-days source plus direct R2 listings.
- Dropbox presence comes from backup_inventory_v1/v2.json via the inventory patch.

The direct listing runs at most once per six-hour coverage cache period, unless
Force Refresh explicitly requests a current result.
"""

from __future__ import annotations

import os
import re
import subprocess
import threading
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Optional, Set, Tuple

import uk_aq_dashboard_api as dashboard
import uk_aq_dashboard_inventory_patch as inventory_patch


DIRECT_R2_ROOT_ENV = "UK_AQ_R2_HISTORY_DIRECT_RCLONE_ROOT"
DIRECT_R2_CACHE_TTL_ENV = "UK_AQ_R2_HISTORY_DIRECT_DAY_CACHE_TTL_SECONDS"
DIRECT_R2_ROOT_DEFAULTS = {
    "v1": "uk_aq_r2_test:uk-aq-history-cic-test/history/v1",
    "v2": "uk_aq_r2_test:uk-aq-history-cic-test/history/v2",
}
DAY_DIR_RE = re.compile(r"^day_utc=(\d{4}-\d{2}-\d{2})/?$")

_DIRECT_CACHE_LOCK = threading.Lock()
_DIRECT_CACHE: Dict[str, Any] = {
    "day_sets": None,
    "error": None,
    "generated_at": None,
    "cache_key": None,
}

_ORIGINAL_GET_R2_HISTORY_DAYS_CACHED = dashboard._get_r2_history_days_cached


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
    version = str(version_info.get("version") or "").strip().lower()
    if not version_info.get("valid") or version not in DIRECT_R2_ROOT_DEFAULTS:
        warning = str(
            version_info.get("warning")
            or "Invalid R2 history version; direct R2 day discovery disabled."
        )
        return None, None, warning

    override = str(os.getenv(DIRECT_R2_ROOT_ENV) or "").strip().rstrip("/")
    root = override or DIRECT_R2_ROOT_DEFAULTS[version]
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

    rclone_bin = inventory_patch._find_rclone()
    if not rclone_bin:
        error = "direct R2 day discovery unavailable because rclone was not found"
        return None, error, root

    observations, observations_error = _list_domain_days(
        rclone_bin,
        root,
        "observations",
    )
    aqilevels, aqilevels_error = _list_domain_days(
        rclone_bin,
        root,
        "aqilevels",
    )

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

    return day_sets, error, root


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

    if not isinstance(normal_days, dict) and not isinstance(direct_days, dict):
        return normal_days, r2_window, bucket, _merge_errors(normal_error, direct_error)

    merged = {
        "observations": set(
            (normal_days or {}).get("observations") or set()
        ),
        "aqilevels": set(
            (normal_days or {}).get("aqilevels") or set()
        ),
    }
    if isinstance(direct_days, dict):
        merged["observations"].update(direct_days.get("observations") or set())
        merged["aqilevels"].update(direct_days.get("aqilevels") or set())

    source = str(bucket or "").strip()
    direct_label = f"rclone-direct:{direct_root}" if direct_root else "rclone-direct"
    merged_source = f"{source}+{direct_label}" if source else direct_label

    return merged, r2_window, merged_source, _merge_errors(normal_error, direct_error)


def main() -> None:
    dashboard._get_r2_history_days_cached = _get_r2_history_days_cached
    inventory_patch.main()


if __name__ == "__main__":
    main()
