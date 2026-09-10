#!/usr/bin/env python3
"""TEST dashboard API facade with hierarchical Dropbox v2 backup coverage."""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

import uk_aq_dashboard_api_core as core


HIERARCHICAL_STATE_PREFIX_DEFAULT = "_ops/checkpoints/r2_history_backup_state_v2"
HIERARCHICAL_STATE_ROOT_KIND = "uk_aq_r2_history_backup_state_v2_root"
HIERARCHICAL_MONTH_STATE_KIND = "uk_aq_r2_history_backup_state_observations_month"
DROPBOX_LOCAL_STATE_FRESH_AFTER_UTC_HOUR_DEFAULT = 6


def _dropbox_local_state_fresh_after_utc_hour() -> int:
    raw = str(
        os.getenv("UK_AQ_DROPBOX_LOCAL_STATE_FRESH_AFTER_UTC_HOUR")
        or DROPBOX_LOCAL_STATE_FRESH_AFTER_UTC_HOUR_DEFAULT
    ).strip()
    try:
        hour = int(raw)
    except ValueError:
        return DROPBOX_LOCAL_STATE_FRESH_AFTER_UTC_HOUR_DEFAULT
    return max(0, min(23, hour))


def _expected_local_checkpoint_day(now_utc: Optional[datetime] = None) -> date:
    current = (now_utc or datetime.now(timezone.utc)).astimezone(timezone.utc)
    cutoff = current.replace(
        hour=_dropbox_local_state_fresh_after_utc_hour(),
        minute=0,
        second=0,
        microsecond=0,
    )
    if current >= cutoff:
        return current.date()
    return current.date() - timedelta(days=1)


def _resolve_dropbox_state_path_info() -> Dict[str, Any]:
    read_version_info = core._resolve_r2_history_read_version()
    if not read_version_info.get("valid"):
        warning = str(
            read_version_info.get("warning")
            or "Invalid R2 history read version; hierarchical Dropbox state disabled."
        )
        return {
            "path": None,
            "source": "disabled_invalid_read_version",
            "cache_key": f"invalid:{read_version_info.get('raw') or ''}:dropbox_hierarchical_disabled",
            "warning": warning,
            "error": warning,
            "fallback_attempted": False,
            "read_version": read_version_info,
            "attempted_paths": [],
            "state_file_override": None,
            "ignored_state_file_override": None,
        }

    version = str(read_version_info.get("version") or "")
    if version != "v2":
        warning = (
            "Dropbox storage coverage is sourced only from the hierarchical v2 backup state; "
            f"active R2 history version is {version or 'unknown'}."
        )
        return {
            "path": None,
            "source": "disabled_non_v2",
            "cache_key": f"{version or 'unknown'}:dropbox_hierarchical_disabled",
            "warning": warning,
            "error": warning,
            "fallback_attempted": False,
            "read_version": read_version_info,
            "attempted_paths": [],
            "state_file_override": None,
            "ignored_state_file_override": None,
        }

    state_prefix = str(
        os.getenv("UK_AQ_R2_HISTORY_HIERARCHICAL_STATE_PREFIX")
        or HIERARCHICAL_STATE_PREFIX_DEFAULT
    ).strip().strip("/")
    if not state_prefix:
        warning = "UK_AQ_R2_HISTORY_HIERARCHICAL_STATE_PREFIX resolved to an empty path."
        return {
            "path": None,
            "source": "hierarchical_v2",
            "cache_key": "v2:dropbox_hierarchical_empty_path",
            "warning": warning,
            "error": warning,
            "fallback_attempted": False,
            "read_version": read_version_info,
            "attempted_paths": [],
            "state_file_override": None,
            "ignored_state_file_override": None,
        }

    root_path = f"{state_prefix}/root.json"
    return {
        "path": root_path,
        "source": "hierarchical_v2",
        "cache_key": f"v2:hierarchical:{root_path}",
        "warning": None,
        "error": None,
        "fallback_attempted": False,
        "read_version": read_version_info,
        "attempted_paths": [root_path],
        "state_file_override": None,
        "ignored_state_file_override": None,
    }


def _hierarchical_state_month_refs(
    raw_root: Any,
) -> Tuple[List[Tuple[str, str, str]], Optional[str]]:
    if not isinstance(raw_root, dict):
        return [], "Hierarchical Dropbox state root is not a JSON object"
    if (
        raw_root.get("kind") != HIERARCHICAL_STATE_ROOT_KIND
        or raw_root.get("backup_version") != "v2"
    ):
        return [], "Hierarchical Dropbox state root identity mismatch"

    observations = raw_root.get("observations")
    if not isinstance(observations, dict):
        return [], "Hierarchical Dropbox state root has no observations object"
    years = observations.get("years")
    if not isinstance(years, list):
        return [], "Hierarchical Dropbox state root observations.years is not an array"

    refs: List[Tuple[str, str, str]] = []
    for year_entry in years:
        if not isinstance(year_entry, dict):
            continue
        year = str(year_entry.get("year") or "").strip()
        if not re.fullmatch(r"\d{4}", year):
            return [], f"Invalid hierarchical Dropbox state year: {year!r}"
        months = year_entry.get("months")
        if not isinstance(months, list):
            continue
        for month_entry in months:
            if not isinstance(month_entry, dict):
                continue
            month = str(month_entry.get("month") or "").strip().zfill(2)
            if not re.fullmatch(r"0[1-9]|1[0-2]", month):
                return [], f"Invalid hierarchical Dropbox state month: {month!r}"
            state_key = str(month_entry.get("state_shard_key") or "").strip().strip("/")
            if (
                not state_key
                or state_key in {".", ".."}
                or state_key.startswith("../")
                or "/../" in state_key
                or "\\" in state_key
            ):
                return [], f"Invalid hierarchical Dropbox state shard key: {state_key!r}"
            refs.append((year, month, state_key))

    refs.sort(key=lambda item: (item[0], item[1], item[2]))
    return refs, None


def _hierarchical_month_days(
    raw_month: Any,
    expected_year: str,
    expected_month: str,
) -> Tuple[Set[date], Optional[str]]:
    if not isinstance(raw_month, dict):
        return set(), "Hierarchical Dropbox month state is not a JSON object"
    if (
        raw_month.get("kind") != HIERARCHICAL_MONTH_STATE_KIND
        or raw_month.get("backup_version") != "v2"
        or raw_month.get("domain") != "observations"
    ):
        return set(), "Hierarchical Dropbox month state identity mismatch"
    if str(raw_month.get("year") or "").strip() != expected_year:
        return set(), "Hierarchical Dropbox month state year mismatch"
    if str(raw_month.get("month") or "").strip().zfill(2) != expected_month:
        return set(), "Hierarchical Dropbox month state month mismatch"

    raw_days = raw_month.get("days")
    if not isinstance(raw_days, list):
        return set(), "Hierarchical Dropbox month state days is not an array"

    days: Set[date] = set()
    for entry in raw_days:
        if not isinstance(entry, dict):
            return set(), "Hierarchical Dropbox month state contains an invalid day entry"
        parsed_day = core._parse_iso_day(entry.get("day_utc"))
        if parsed_day is None:
            return set(), "Hierarchical Dropbox month state contains an invalid day_utc"
        if not parsed_day.isoformat().startswith(f"{expected_year}-{expected_month}-"):
            return set(), "Hierarchical Dropbox month state contains a day outside its month"
        days.add(parsed_day)
    return days, None


def _history_root_from_state_path(state_path: Path, state_rel_path: str) -> Path:
    history_root = state_path
    rel_parts = [
        part
        for part in str(state_rel_path or "").strip().strip("/").split("/")
        if part
    ]
    for _ in rel_parts:
        history_root = history_root.parent
    return history_root


def _local_hierarchical_state_freshness(
    state_path: Path,
    state_rel_path: str,
    now_utc: Optional[datetime] = None,
) -> Dict[str, Any]:
    current = (now_utc or datetime.now(timezone.utc)).astimezone(timezone.utc)
    expected_day = _expected_local_checkpoint_day(current)
    result: Dict[str, Any] = {
        "local_state_path": str(state_path),
        "local_state_expected_day_utc": expected_day.isoformat(),
        "local_state_fresh_after_utc_hour": _dropbox_local_state_fresh_after_utc_hour(),
        "local_state_fresh": False,
        "local_state_freshness_reason": None,
        "local_state_root_modified_at": None,
        "local_state_month_path": None,
        "local_state_month_modified_at": None,
    }

    try:
        root_modified = datetime.fromtimestamp(
            state_path.stat().st_mtime,
            tz=timezone.utc,
        )
        result["local_state_root_modified_at"] = root_modified.isoformat().replace("+00:00", "Z")
    except OSError as exc:
        result["local_state_freshness_reason"] = (
            f"Local hierarchical Dropbox state root stat failed ({exc.__class__.__name__})"
        )
        return result

    try:
        raw_root = json.loads(state_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        result["local_state_freshness_reason"] = (
            f"Local hierarchical Dropbox state root parse failed ({exc.__class__.__name__})"
        )
        return result

    refs, root_error = _hierarchical_state_month_refs(raw_root)
    if root_error:
        result["local_state_freshness_reason"] = root_error
        return result

    target_year = f"{expected_day.year:04d}"
    target_month = f"{expected_day.month:02d}"
    target_state_key = next(
        (
            state_key
            for year, month, state_key in refs
            if year == target_year and month == target_month
        ),
        None,
    )
    if not target_state_key:
        result["local_state_freshness_reason"] = (
            "Local hierarchical Dropbox state root has no checkpoint shard for "
            f"{target_year}-{target_month}"
        )
        return result

    history_root = _history_root_from_state_path(state_path, state_rel_path)
    shard_path = history_root.joinpath(*target_state_key.split("/"))
    result["local_state_month_path"] = str(shard_path)
    if not shard_path.is_file():
        result["local_state_freshness_reason"] = (
            f"Local hierarchical Dropbox month state is missing: {target_state_key}"
        )
        return result

    try:
        shard_modified = datetime.fromtimestamp(
            shard_path.stat().st_mtime,
            tz=timezone.utc,
        )
    except OSError as exc:
        result["local_state_freshness_reason"] = (
            f"Local hierarchical Dropbox month state stat failed ({exc.__class__.__name__})"
        )
        return result

    result["local_state_month_modified_at"] = shard_modified.isoformat().replace("+00:00", "Z")
    result["local_state_fresh"] = shard_modified.date() >= expected_day
    if result["local_state_fresh"]:
        result["local_state_freshness_reason"] = "current"
    else:
        result["local_state_freshness_reason"] = (
            "Local hierarchical Dropbox month state is stale: "
            f"modified {shard_modified.date().isoformat()}, "
            f"expected {expected_day.isoformat()} or later"
        )
    return result


def _load_local_hierarchical_days(
    state_path: Path,
    state_rel_path: str,
) -> Tuple[Dict[str, Set[date]], Optional[str]]:
    domain_days = core._empty_dropbox_backup_days()
    try:
        raw_root = json.loads(state_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        return domain_days, f"Hierarchical Dropbox state root parse failed ({exc.__class__.__name__})"

    refs, root_error = _hierarchical_state_month_refs(raw_root)
    if root_error:
        return domain_days, root_error

    history_root = _history_root_from_state_path(state_path, state_rel_path)
    errors: List[str] = []
    for year, month, state_key in refs:
        shard_path = history_root.joinpath(*state_key.split("/"))
        if not shard_path.is_file():
            errors.append(f"Missing hierarchical Dropbox month state {state_key}")
            continue
        try:
            raw_month = json.loads(shard_path.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            errors.append(
                f"Hierarchical Dropbox month state parse failed for {state_key} "
                f"({exc.__class__.__name__})"
            )
            continue
        month_days, month_error = _hierarchical_month_days(raw_month, year, month)
        if month_error:
            errors.append(f"{state_key}: {month_error}")
            continue
        domain_days["observations"].update(month_days)

    return domain_days, "; ".join(errors) if errors else None


def _download_hierarchical_json(access_token: str, state_rel_path: str) -> Dict[str, Any]:
    remote_path = core._resolve_dropbox_state_remote_path(state_rel_path)
    if not remote_path:
        raise RuntimeError("Unable to resolve hierarchical Dropbox state path")
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Dropbox-API-Arg": json.dumps({"path": remote_path}),
    }
    resp = core.requests.post(
        core.DROPBOX_CONTENT_API_DOWNLOAD_URL,
        headers=headers,
        timeout=core.DROPBOX_API_TIMEOUT_SECONDS,
    )
    if not resp.ok:
        detail = core._safe_response_text(resp)
        suffix = f": {detail}" if detail else ""
        raise RuntimeError(
            f"Hierarchical Dropbox state download failed ({resp.status_code}){suffix}"
        )
    try:
        payload = resp.json()
    except ValueError as exc:
        raise RuntimeError("Hierarchical Dropbox state returned invalid JSON") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("Hierarchical Dropbox state payload is not a JSON object")
    return payload


def _state_info_with_warning(
    state_info: Dict[str, Any],
    warning: Optional[str],
) -> Dict[str, Any]:
    updated = dict(state_info)
    if warning:
        current = str(updated.get("warning") or "").strip()
        updated["warning"] = f"{current} {warning}".strip() if current else warning
    return updated


def _load_dropbox_backup_days() -> Tuple[
    Dict[str, Set[date]], Optional[str], Optional[str], Dict[str, Any]
]:
    state_info = _resolve_dropbox_state_path_info()
    resolved_path = state_info.get("path")
    domain_days = core._empty_dropbox_backup_days()
    if not resolved_path:
        return domain_days, None, state_info.get("error"), state_info

    stale_local: Optional[
        Tuple[Dict[str, Set[date]], str, Optional[str], Dict[str, Any]]
    ] = None

    for candidate in core._candidate_dropbox_state_paths(
        resolved_path,
        state_info=state_info,
    ):
        if not candidate.is_file():
            continue

        parsed_days, parse_error = _load_local_hierarchical_days(
            candidate,
            resolved_path,
        )
        freshness = _local_hierarchical_state_freshness(
            candidate,
            resolved_path,
        )
        candidate_info = dict(state_info)
        candidate_info.update(freshness)
        candidate_info["attempted_paths"] = [
            *list(candidate_info.get("attempted_paths") or []),
            str(candidate),
        ]

        if not parse_error and freshness.get("local_state_fresh"):
            candidate_info["source"] = "hierarchical_v2_local"
            candidate_info["fallback_attempted"] = False
            return parsed_days, str(candidate), None, candidate_info

        local_reason = parse_error or str(
            freshness.get("local_state_freshness_reason")
            or "Local hierarchical Dropbox state is not current"
        )
        if stale_local is None:
            stale_local = (
                parsed_days,
                str(candidate),
                local_reason,
                candidate_info,
            )

    access_token, token_error = core._fetch_dropbox_access_token()
    remote_root = core._resolve_dropbox_state_remote_path(resolved_path)
    path_ref = f"dropbox:{remote_root}" if remote_root else None

    if stale_local is not None:
        stale_days, stale_path, local_reason, stale_info = stale_local
        stale_info["fallback_attempted"] = True
        stale_info["source"] = "hierarchical_v2_local_stale"
        state_info = stale_info
    else:
        stale_days = None
        stale_path = None
        local_reason = None
        state_info = dict(state_info)
        state_info["source"] = "hierarchical_v2_dropbox_api"
        state_info["fallback_attempted"] = False

    if token_error or not access_token:
        if stale_days is not None:
            api_reason = token_error or "Dropbox credentials are unavailable"
            error = (
                f"{local_reason}; Dropbox API fallback unavailable: {api_reason}"
            )
            state_info["source"] = "hierarchical_v2_local_stale_api_unavailable"
            state_info = _state_info_with_warning(state_info, error)
            return stale_days, stale_path, error, state_info

        error = token_error or (
            "Hierarchical Dropbox state root not found locally and Dropbox credentials are unavailable"
        )
        return domain_days, path_ref, error, state_info

    if stale_local is not None:
        state_info["fallback_attempted"] = True
        state_info["attempted_paths"] = [
            *list(state_info.get("attempted_paths") or []),
            path_ref,
        ]
    elif path_ref:
        state_info["attempted_paths"] = [
            *list(state_info.get("attempted_paths") or []),
            path_ref,
        ]

    try:
        raw_root = _download_hierarchical_json(access_token, resolved_path)
    except Exception as exc:  # noqa: BLE001
        api_error = str(exc)
        if stale_days is not None:
            error = f"{local_reason}; Dropbox API fallback failed: {api_error}"
            state_info["source"] = "hierarchical_v2_local_stale_api_failed"
            state_info = _state_info_with_warning(state_info, error)
            return stale_days, stale_path, error, state_info
        return domain_days, path_ref, api_error, state_info

    refs, root_error = _hierarchical_state_month_refs(raw_root)
    if root_error:
        if stale_days is not None:
            error = f"{local_reason}; Dropbox API fallback failed: {root_error}"
            state_info["source"] = "hierarchical_v2_local_stale_api_failed"
            state_info = _state_info_with_warning(state_info, error)
            return stale_days, stale_path, error, state_info
        return domain_days, path_ref, root_error, state_info

    errors: List[str] = []
    for year, month, state_key in refs:
        try:
            raw_month = _download_hierarchical_json(access_token, state_key)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{state_key}: {exc}")
            continue
        month_days, month_error = _hierarchical_month_days(raw_month, year, month)
        if month_error:
            errors.append(f"{state_key}: {month_error}")
            continue
        domain_days["observations"].update(month_days)

    remote_error = "; ".join(errors) if errors else None
    if stale_local is not None:
        state_info["source"] = "hierarchical_v2_dropbox_api_stale_local_fallback"
        warning = (
            f"{local_reason}; coverage loaded from Dropbox API instead."
        )
        state_info = _state_info_with_warning(state_info, warning)

    return domain_days, path_ref, remote_error, state_info


_ORIGINAL_NEXT_STORAGE_COVERAGE_REFRESH = core._next_storage_coverage_refresh


def _next_storage_coverage_refresh(now_utc: datetime) -> datetime:
    current = now_utc.astimezone(timezone.utc)
    normal_refresh = _ORIGINAL_NEXT_STORAGE_COVERAGE_REFRESH(current)
    freshness_boundary = current.replace(
        hour=_dropbox_local_state_fresh_after_utc_hour(),
        minute=0,
        second=0,
        microsecond=0,
    )
    if freshness_boundary <= current:
        freshness_boundary += timedelta(days=1)
    return min(normal_refresh, freshness_boundary)


# Patch the existing dashboard implementation in-place so all existing handlers,
# tests and callers retain the same module behaviour while Dropbox coverage uses
# hierarchical v2 observation state with a stale-local Dropbox API fallback.
core._resolve_dropbox_state_path_info = _resolve_dropbox_state_path_info
core._load_dropbox_backup_days = _load_dropbox_backup_days
core._next_storage_coverage_refresh = _next_storage_coverage_refresh

if __name__ == "__main__":
    core.main()
else:
    sys.modules[__name__] = core
