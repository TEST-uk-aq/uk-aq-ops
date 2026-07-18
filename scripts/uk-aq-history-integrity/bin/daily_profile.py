"""UTC-only, deterministic target selection for the Integrity daily profile."""

from __future__ import annotations

import calendar
import datetime as dt
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


_DAY_DIRECTORY = re.compile(r"day_utc=(\d{4}-\d{2}-\d{2})\Z")


@dataclass(frozen=True)
class SelectedDay:
    day: dt.date
    reasons: tuple[str, ...]

    def to_dict(self) -> dict[str, object]:
        return {"day_utc": self.day.isoformat(), "reasons": list(self.reasons)}


@dataclass(frozen=True)
class DailyProfileSelection:
    logical_run_date: dt.date
    latest_r2_observations_day: dt.date
    recent_start_day: dt.date
    recent_end_day: dt.date
    historical_target_day_numbers: tuple[int, ...]
    represented_historical_month_count: int
    selected_days: tuple[SelectedDay, ...]
    caught_up_logical_dates: tuple[dt.date, ...]
    observations_prefix: str

    @property
    def from_day(self) -> str:
        return self.selected_days[0].day.isoformat()

    @property
    def to_day(self) -> str:
        return self.selected_days[-1].day.isoformat()

    def to_dict(self) -> dict[str, object]:
        return {
            "selection_mode": "daily_explicit",
            "logical_run_date": self.logical_run_date.isoformat(),
            "logical_run_timezone": "UTC",
            "latest_r2_observations_day": self.latest_r2_observations_day.isoformat(),
            "discovery_source": "local_dropbox_committed_v2_observations_tree",
            "active_observations_prefix": self.observations_prefix,
            "recent_start_day": self.recent_start_day.isoformat(),
            "recent_end_day": self.recent_end_day.isoformat(),
            "historical_target_day_numbers": list(self.historical_target_day_numbers),
            "represented_historical_month_count": self.represented_historical_month_count,
            "selected_date_count": len(self.selected_days),
            "selected_days": [entry.to_dict() for entry in self.selected_days],
            "caught_up_logical_dates": [day.isoformat() for day in self.caught_up_logical_dates],
        }


def discover_observations_days(
    r2_history_root: str | Path,
    observations_prefix: str,
) -> tuple[dt.date, ...]:
    """Return strictly parsed direct v2 observation days, oldest first.

    Only the active configured observations prefix is inspected.  This keeps
    staging, overlays, archives, and other history versions outside selection.
    """
    prefix_root = Path(r2_history_root) / observations_prefix.strip("/")
    if not prefix_root.is_dir():
        return ()
    days: set[dt.date] = set()
    for entry in prefix_root.iterdir():
        if not entry.is_dir():
            continue
        match = _DAY_DIRECTORY.fullmatch(entry.name)
        if not match:
            continue
        try:
            days.add(dt.date.fromisoformat(match.group(1)))
        except ValueError:
            continue
    return tuple(sorted(days))


def historical_target_day_numbers(logical_run_date: dt.date) -> tuple[int, ...]:
    """Allocate 1..31 exactly once across each UTC logical calendar month."""
    month_length = calendar.monthrange(logical_run_date.year, logical_run_date.month)[1]
    day = logical_run_date.day
    if day <= 25:
        return (day,)
    if month_length == 31:
        return (day,)
    if month_length == 30:
        return (30, 31) if day == 30 else (day,)
    if month_length == 29:
        return {26: (26,), 27: (27,), 28: (28, 30), 29: (29, 31)}[day]
    if month_length == 28:
        return {26: (26, 29), 27: (27, 30), 28: (28, 31)}[day]
    raise ValueError(f"unsupported logical month length: {month_length}")


def _valid_month_day(year: int, month: int, day: int) -> dt.date | None:
    try:
        return dt.date(year, month, day)
    except ValueError:
        return None


def build_daily_selection(
    *,
    logical_run_date: dt.date,
    observations_days: Iterable[dt.date],
    observations_prefix: str,
    catch_up_logical_dates: Iterable[dt.date] = (),
) -> DailyProfileSelection:
    discovered_days = tuple(sorted(set(observations_days)))
    if not discovered_days:
        raise ValueError("no strictly parsed committed v2 observations day directories were discovered")

    latest_day = discovered_days[-1]
    recent_start = latest_day - dt.timedelta(days=6)
    current_numbers = historical_target_day_numbers(logical_run_date)
    catch_up_dates = tuple(sorted(set(catch_up_logical_dates)))
    allocations: list[tuple[dt.date, tuple[int, ...], str]] = [
        (logical_run_date, current_numbers, "historical"),
    ]
    allocations.extend(
        (missed_date, historical_target_day_numbers(missed_date), "catch_up")
        for missed_date in catch_up_dates
    )

    reasons_by_day: dict[dt.date, set[str]] = {}
    for offset in range(7):
        day = recent_start + dt.timedelta(days=offset)
        reasons_by_day.setdefault(day, set()).add("recent")

    latest_month = (latest_day.year, latest_day.month)
    represented_months = sorted({(day.year, day.month) for day in discovered_days if (day.year, day.month) < latest_month})
    for year, month in represented_months:
        for allocation_date, target_numbers, allocation_kind in allocations:
            for target_day in target_numbers:
                historical_day = _valid_month_day(year, month, target_day)
                if historical_day is None:
                    continue
                if allocation_kind == "historical":
                    reason = f"historical:{target_day}"
                else:
                    reason = f"catch_up:{allocation_date.isoformat()}:{target_day}"
                reasons_by_day.setdefault(historical_day, set()).add(reason)

    selected = tuple(
        SelectedDay(day=day, reasons=tuple(sorted(reasons)))
        for day, reasons in sorted(reasons_by_day.items())
    )
    return DailyProfileSelection(
        logical_run_date=logical_run_date,
        latest_r2_observations_day=latest_day,
        recent_start_day=recent_start,
        recent_end_day=latest_day,
        historical_target_day_numbers=current_numbers,
        represented_historical_month_count=len(represented_months),
        selected_days=selected,
        caught_up_logical_dates=catch_up_dates,
        observations_prefix=observations_prefix.strip("/"),
    )


def selected_days_json(selected_days: Iterable[SelectedDay]) -> str:
    """Stable compact JSON payload suitable for the local SQLite state row."""
    import json

    return json.dumps(
        [entry.to_dict() for entry in selected_days],
        separators=(",", ":"),
        sort_keys=True,
    )


def historical_target_days_json(target_days: Iterable[int]) -> str:
    import json

    return json.dumps(list(target_days), separators=(",", ":"))
