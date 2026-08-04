#!/usr/bin/env python3
"""Promote inventory-backed days to R2 plus Dropbox presence in TEST."""

from __future__ import annotations

import inspect
from typing import Any, Dict, List, Optional, Set

import uk_aq_dashboard_api as dashboard
import uk_aq_dashboard_api_patch as coverage_patch
import uk_aq_dashboard_inventory_patch as inventory_patch


_BASE_BUILD_LIVE_STORAGE_COVERAGE_DAYS = (
    coverage_patch._original_build_live_storage_coverage_days
)


def _build_live_storage_coverage_days_with_inventory_presence(
    *args: Any,
    **kwargs: Any,
) -> List[Dict[str, Any]]:
    rows = _BASE_BUILD_LIVE_STORAGE_COVERAGE_DAYS(*args, **kwargs)

    try:
        bound = inspect.signature(
            _BASE_BUILD_LIVE_STORAGE_COVERAGE_DAYS
        ).bind_partial(*args, **kwargs)
        dropbox_backup_days = bound.arguments.get("dropbox_backup_days")
    except (TypeError, ValueError):
        dropbox_backup_days = kwargs.get("dropbox_backup_days")

    if not isinstance(dropbox_backup_days, dict):
        return rows

    observations_days: Set[Any] = set(
        dropbox_backup_days.get("observations") or set()
    )
    aqilevels_days: Set[Any] = set(
        dropbox_backup_days.get("aqilevels") or set()
    )

    for row in rows:
        parsed_day: Optional[Any] = dashboard._parse_iso_day(row.get("date"))
        if parsed_day is None:
            continue

        if parsed_day in observations_days:
            row["r2"] = True
            row["r2_observs"] = True
            row["dropbox_observs"] = True

        if parsed_day in aqilevels_days:
            row["r2_aqilevels"] = True
            row["dropbox_aqilevels"] = True

    return rows


def main() -> None:
    coverage_patch._original_build_live_storage_coverage_days = (
        _build_live_storage_coverage_days_with_inventory_presence
    )
    inventory_patch.main()


if __name__ == "__main__":
    main()
