#!/usr/bin/env python3
"""TEST dashboard API facade with hierarchical Dropbox v2 backup coverage."""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import date
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

import uk_aq_dashboard_api_core as core


HIERARCHICAL_STATE_PREFIX_DEFAULT = "_ops/checkpoints/r2_history_backup_state_v2"
HIERARCHICAL_STATE_ROOT_KIND = "uk_aq_r2_history_backup_state_v2_root"
HIERARCHICAL_MONTH_STATE_KIND = "uk_aq_r2_history_backup_state_observations_month"


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


def _load_dropbox_backup_days() -> Tuple[
    Dict[str, Set[date]], Optional[str], Optional[str], Dict[str, Any]
]:
    state_info = _resolve_dropbox_state_path_info()
    resolved_path = state_info.get("path")
    domain_days = core._empty_dropbox_backup_days()
    if not resolved_path:
        return domain_days, None, state_info.get("error"), state_info

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
        return parsed_days, str(candidate), parse_error, state_info

    access_token, token_error = core._fetch_dropbox_access_token()
    remote_root = core._resolve_dropbox_state_remote_path(resolved_path)
    path_ref = f"dropbox:{remote_root}" if remote_root else None
    if token_error:
        return domain_days, path_ref, token_error, state_info
    if not access_token:
        return (
            domain_days,
            path_ref,
            "Hierarchical Dropbox state root not found locally and Dropbox credentials are unavailable",
            state_info,
        )

    try:
        raw_root = _download_hierarchical_json(access_token, resolved_path)
    except Exception as exc:  # noqa: BLE001
        return domain_days, path_ref, str(exc), state_info

    refs, root_error = _hierarchical_state_month_refs(raw_root)
    if root_error:
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

    return domain_days, path_ref, "; ".join(errors) if errors else None, state_info


# Patch the existing dashboard implementation in-place so all existing handlers,
# tests and callers retain the same module behaviour while Dropbox coverage uses
# only the hierarchical v2 observation state.
core._resolve_dropbox_state_path_info = _resolve_dropbox_state_path_info
core._load_dropbox_backup_days = _load_dropbox_backup_days

if __name__ == "__main__":
    core.main()
else:
    sys.modules[__name__] = core
