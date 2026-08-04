#!/usr/bin/env python3
"""Run the TEST dashboard with backup coverage sourced from the active inventory.

The base dashboard reads r2_history_backup_state_v1/v2.json. That checkpoint can
lag or omit a day that is present in backup_inventory_v1/v2.json. This wrapper
makes the active version's inventory authoritative for Dropbox day coverage.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

import uk_aq_dashboard_api as dashboard
import uk_aq_dashboard_api_patch as coverage_patch


INVENTORY_REL_PATH_ENV = "UK_AQ_R2_HISTORY_BACKUP_INVENTORY_REL_PATH"
INVENTORY_FILE_ENV = "UK_AQ_R2_HISTORY_BACKUP_INVENTORY_FILE"
INVENTORY_RCLONE_PATH_ENV = "UK_AQ_R2_HISTORY_BACKUP_INVENTORY_RCLONE_PATH"
RCLONE_BIN_ENV = "UK_AQ_RCLONE_BIN"

INVENTORY_REL_PATH_DEFAULTS = {
    "v1": "history/_index/backup_inventory_v1.json",
    "v2": "history/_index_v2/backup_inventory_v2.json",
}

# TEST-only fallback. An explicit environment value always wins.
INVENTORY_RCLONE_PATH_DEFAULTS = {
    "v1": (
        "uk_aq_r2_test:uk-aq-history-cic-test/"
        "history/_index/backup_inventory_v1.json"
    ),
    "v2": (
        "uk_aq_r2_test:uk-aq-history-cic-test/"
        "history/_index_v2/backup_inventory_v2.json"
    ),
}

INVENTORY_HISTORY_PATH_RE = re.compile(
    r"(?:^|/)(?:history/)?v(?P<version>[12])/"
    r"(?P<domain>observations|aqilevels)/"
    r"day_utc=(?P<day>\d{4}-\d{2}-\d{2})(?:/|$)"
)


def _looks_like_other_version(value: str, version: str) -> bool:
    normalised = str(value or "").lower()
    other = "v1" if version == "v2" else "v2"
    return other in normalised and version not in normalised


def _resolve_backup_inventory_path_info() -> Dict[str, Any]:
    read_version = dashboard._resolve_r2_history_read_version()
    version = str(read_version.get("version") or "").strip().lower()
    if not read_version.get("valid") or version not in INVENTORY_REL_PATH_DEFAULTS:
        warning = str(
            read_version.get("warning")
            or "Invalid R2 history read version; backup inventory selection disabled."
        )
        return {
            "path": None,
            "source": "disabled",
            "attempted_paths": [],
            "cache_key": f"backup-inventory:disabled:{read_version.get('raw')}",
            "warning": warning,
            "error": warning,
            "fallback_attempted": False,
            "read_version": read_version,
            "state_file_override": "",
            "inventory_file_override": "",
            "inventory_rclone_path": "",
        }

    warnings: List[str] = []
    attempted_paths: List[str] = []

    raw_rel_path = str(os.getenv(INVENTORY_REL_PATH_ENV) or "").strip().strip("/")
    if raw_rel_path and _looks_like_other_version(raw_rel_path, version):
        warnings.append(
            f"{INVENTORY_REL_PATH_ENV} points at another history version "
            f"({raw_rel_path}); using the {version} default inventory instead."
        )
        raw_rel_path = ""

    rel_path = raw_rel_path or INVENTORY_REL_PATH_DEFAULTS[version]
    source = "env" if raw_rel_path else f"default:{version}"
    attempted_paths.append(rel_path)

    file_override = str(os.getenv(INVENTORY_FILE_ENV) or "").strip()
    if file_override and _looks_like_other_version(file_override, version):
        warnings.append(
            f"{INVENTORY_FILE_ENV} points at another history version "
            f"({file_override}); ignoring it."
        )
        file_override = ""
    if file_override:
        attempted_paths.append(file_override)

    rclone_path = str(os.getenv(INVENTORY_RCLONE_PATH_ENV) or "").strip()
    if rclone_path and _looks_like_other_version(rclone_path, version):
        warnings.append(
            f"{INVENTORY_RCLONE_PATH_ENV} points at another history version "
            f"({rclone_path}); using the TEST {version} default instead."
        )
        rclone_path = ""
    rclone_path = rclone_path or INVENTORY_RCLONE_PATH_DEFAULTS[version]
    attempted_paths.append(rclone_path)

    cache_key = "|".join(
        [
            "backup-inventory",
            version,
            rel_path,
            file_override,
            rclone_path,
        ]
    )

    return {
        "path": rel_path,
        "source": source,
        "attempted_paths": attempted_paths,
        "cache_key": cache_key,
        "warning": " ".join(warnings) if warnings else None,
        "error": None,
        "fallback_attempted": False,
        "read_version": read_version,
        # The base candidate-path helper uses this key for a direct local override.
        "state_file_override": file_override,
        "inventory_file_override": file_override,
        "inventory_rclone_path": rclone_path,
    }


def _walk_json_strings(value: Any) -> Iterable[str]:
    if isinstance(value, dict):
        for key, child in value.items():
            yield str(key)
            yield from _walk_json_strings(child)
        return
    if isinstance(value, list):
        for child in value:
            yield from _walk_json_strings(child)
        return
    if isinstance(value, str):
        yield value


def _extract_backup_inventory_days(
    raw_inventory: Any,
) -> Tuple[Dict[str, Set[Any]], Optional[str]]:
    days = dashboard._empty_dropbox_backup_days()
    if not isinstance(raw_inventory, dict):
        return days, "Backup inventory is not a JSON object"

    read_version = dashboard._resolve_r2_history_read_version()
    version = str(read_version.get("version") or "").strip().lower()
    expected_digit = version.removeprefix("v")

    for text in _walk_json_strings(raw_inventory):
        for match in INVENTORY_HISTORY_PATH_RE.finditer(text):
            if match.group("version") != expected_digit:
                continue
            parsed_day = dashboard._parse_iso_day(match.group("day"))
            domain = match.group("domain")
            if parsed_day is not None and domain in days:
                days[domain].add(parsed_day)

    total_days = sum(len(domain_days) for domain_days in days.values())
    if total_days == 0:
        return days, (
            f"Backup inventory contained no {version} observation or AQI day paths"
        )
    return days, None


def _candidate_inventory_files(
    rel_path: str,
    info: Dict[str, Any],
) -> List[Path]:
    candidates: List[Path] = []
    seen: Set[str] = set()

    def add(path: Optional[Path]) -> None:
        if path is None:
            return
        resolved = path.expanduser()
        key = str(resolved)
        if key in seen:
            return
        seen.add(key)
        candidates.append(resolved)

    override = str(info.get("inventory_file_override") or "").strip()
    if override:
        add(Path(override))

    # Reuse the dashboard's Dropbox root discovery, but point it at the inventory.
    for candidate in dashboard._candidate_dropbox_state_paths(rel_path, state_info=info):
        add(candidate)

    return candidates


def _find_rclone() -> Optional[str]:
    override = str(os.getenv(RCLONE_BIN_ENV) or "").strip()
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


def _load_inventory_with_rclone(
    rclone_path: str,
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    rclone_bin = _find_rclone()
    if not rclone_bin:
        return None, (
            f"rclone is unavailable; set {RCLONE_BIN_ENV} or install rclone"
        )

    try:
        result = subprocess.run(
            [rclone_bin, "cat", rclone_path],
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return None, f"rclone inventory read failed ({exc.__class__.__name__})"

    if result.returncode != 0:
        detail = str(result.stderr or "").strip().replace("\n", " ")
        if len(detail) > 500:
            detail = detail[:497] + "..."
        return None, (
            f"rclone inventory read failed with exit {result.returncode}"
            + (f": {detail}" if detail else "")
        )

    try:
        payload = json.loads(result.stdout)
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        return None, f"rclone inventory JSON parse failed ({exc.__class__.__name__})"
    if not isinstance(payload, dict):
        return None, "rclone inventory payload is not a JSON object"
    return payload, None


def _load_dropbox_backup_days_from_inventory(
) -> Tuple[Dict[str, Set[Any]], Optional[str], Optional[str], Dict[str, Any]]:
    info = _resolve_backup_inventory_path_info()
    rel_path = str(info.get("path") or "").strip()
    empty = dashboard._empty_dropbox_backup_days()
    if not rel_path:
        return empty, None, info.get("error"), info

    attempted: List[str] = list(info.get("attempted_paths") or [])
    for candidate in _candidate_inventory_files(rel_path, info):
        candidate_text = str(candidate)
        if candidate_text not in attempted:
            attempted.append(candidate_text)
        if not candidate.is_file():
            continue
        try:
            raw_inventory = json.loads(candidate.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            info = {
                **info,
                "attempted_paths": attempted,
                "source": "local-inventory",
            }
            return (
                empty,
                candidate_text,
                f"Backup inventory parse failed ({exc.__class__.__name__})",
                info,
            )
        days, parse_error = _extract_backup_inventory_days(raw_inventory)
        info = {
            **info,
            "attempted_paths": attempted,
            "source": "local-inventory",
        }
        return days, candidate_text, parse_error, info

    rclone_path = str(info.get("inventory_rclone_path") or "").strip()
    if rclone_path:
        payload, rclone_error = _load_inventory_with_rclone(rclone_path)
        info = {
            **info,
            "attempted_paths": attempted,
            "source": "rclone-inventory",
            "fallback_attempted": True,
        }
        if payload is not None:
            days, parse_error = _extract_backup_inventory_days(payload)
            return days, f"rclone:{rclone_path}", parse_error, info
        return empty, f"rclone:{rclone_path}", rclone_error, info

    info = {
        **info,
        "attempted_paths": attempted,
        "fallback_attempted": True,
    }
    return empty, None, "No readable backup inventory was found", info


def _trust_inventory_backup_days(
    dropbox_days: Dict[str, Set[Any]],
    _r2_history_days: Optional[Dict[str, Set[Any]]],
    _read_version_info: Dict[str, Any],
) -> Tuple[Dict[str, Set[Any]], Optional[str]]:
    """The inventory is direct backup evidence and needs no R2-day intersection."""

    return {
        "observations": set(dropbox_days.get("observations") or set()),
        "aqilevels": set(dropbox_days.get("aqilevels") or set()),
    }, None


def main() -> None:
    dashboard._resolve_dropbox_state_path_info = _resolve_backup_inventory_path_info
    dashboard._extract_dropbox_backup_days = _extract_backup_inventory_days
    dashboard._load_dropbox_backup_days = _load_dropbox_backup_days_from_inventory
    dashboard._filter_dropbox_backup_days_for_read_version = _trust_inventory_backup_days

    coverage_patch.main()


if __name__ == "__main__":
    main()
