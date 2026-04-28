#!/usr/bin/env python3
"""
Resolve and download a GeoJSON file from Dropbox, selecting the latest version when needed.

Requires:
- DROPBOX_APP_KEY
- DROPBOX_APP_SECRET
- DROPBOX_REFRESH_TOKEN
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, Optional, Tuple

import requests


MONTH_INDEX = {
    "jan": 1,
    "january": 1,
    "feb": 2,
    "february": 2,
    "mar": 3,
    "march": 3,
    "apr": 4,
    "april": 4,
    "may": 5,
    "jun": 6,
    "june": 6,
    "jul": 7,
    "july": 7,
    "aug": 8,
    "august": 8,
    "sep": 9,
    "sept": 9,
    "september": 9,
    "oct": 10,
    "october": 10,
    "nov": 11,
    "november": 11,
    "dec": 12,
    "december": 12,
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Resolve and download GeoJSON from Dropbox.")
    parser.add_argument("--dropbox-base", help="Base folder to search for GeoJSON files.")
    parser.add_argument("--dropbox-path", help="Direct GeoJSON path in Dropbox.")
    parser.add_argument("--version", help="Target year/version to select (optional).")
    parser.add_argument("--output", required=True, help="Local output path for the GeoJSON file.")
    parser.add_argument(
        "--env-prefix",
        default="",
        help="Prefix for writing VERSION/GEOJSON_PATH into GITHUB_ENV.",
    )
    parser.add_argument(
        "--env-file",
        default=os.getenv("GITHUB_ENV", ""),
        help="Path to env file for GitHub Actions (defaults to GITHUB_ENV).",
    )
    return parser.parse_args()


def dropbox_access_token() -> str:
    app_key = os.environ.get("DROPBOX_APP_KEY")
    app_secret = os.environ.get("DROPBOX_APP_SECRET")
    refresh_token = os.environ.get("DROPBOX_REFRESH_TOKEN")
    if not all([app_key, app_secret, refresh_token]):
        raise RuntimeError("Missing DROPBOX_APP_KEY, DROPBOX_APP_SECRET, or DROPBOX_REFRESH_TOKEN.")
    token_resp = requests.post(
        "https://api.dropbox.com/oauth2/token",
        data={
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": app_key,
            "client_secret": app_secret,
        },
        timeout=30,
    )
    token_resp.raise_for_status()
    return token_resp.json()["access_token"]


def dropbox_request(access_token: str, endpoint: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    resp = requests.post(
        f"https://api.dropboxapi.com/2/{endpoint}",
        headers={"Authorization": f"Bearer {access_token}"},
        json=payload,
        timeout=30,
    )
    resp.raise_for_status()
    if not resp.content:
        return {}
    return resp.json()


def normalize_path(path: str, root_tag: str, app_folder_name: Optional[str]) -> str:
    cleaned = path.strip()
    if not cleaned.startswith("/"):
        cleaned = f"/{cleaned}"
    if root_tag == "app_folder" and cleaned.startswith("/Apps/"):
        parts = cleaned.split("/", 3)
        if len(parts) >= 4 and (not app_folder_name or parts[2] == app_folder_name):
            cleaned = f"/{parts[3]}"
    return cleaned


def list_folder_all(access_token: str, path: str, recursive: bool = False) -> Iterable[Dict[str, Any]]:
    payload: Dict[str, Any] = {"path": path}
    if recursive:
        payload["recursive"] = True
    resp = dropbox_request(access_token, "files/list_folder", payload)
    entries = resp.get("entries", [])
    while resp.get("has_more"):
        resp = dropbox_request(access_token, "files/list_folder/continue", {"cursor": resp.get("cursor")})
        entries.extend(resp.get("entries", []))
    return entries


def parse_version_tag(name: str) -> Optional[Tuple[int, int]]:
    match = re.search(r"(20\d{2})", name)
    if not match:
        return None
    year = int(match.group(1))
    lower = name.lower()
    month = 0
    for label, idx in MONTH_INDEX.items():
        if label in lower:
            month = idx
            break
    return year, month


def entry_version(entry: Dict[str, Any]) -> Optional[Tuple[int, int]]:
    path = entry.get("path_display") or entry.get("path_lower") or entry.get("name") or ""
    best = None
    for part in Path(path).parts:
        parsed = parse_version_tag(part)
        if parsed and (not best or parsed > best):
            best = parsed
    return best


def choose_geojson(entries: Iterable[Dict[str, Any]], target_year: Optional[int]) -> Optional[Dict[str, Any]]:
    candidates = [(entry_version(entry), entry) for entry in entries]
    if target_year:
        filtered = [
            (version, entry)
            for version, entry in candidates
            if version and version[0] == target_year
        ]
        if filtered:
            candidates = filtered
    if not candidates:
        return None

    def sort_key(item: Tuple[Optional[Tuple[int, int]], Dict[str, Any]]) -> Tuple[int, int, str]:
        version, entry = item
        path = entry.get("path_display") or entry.get("path_lower") or entry.get("name") or ""
        if version:
            return (version[0], version[1], path)
        return (0, 0, path)

    return sorted(candidates, key=sort_key)[-1][1]


def parse_year(value: Optional[str]) -> Optional[int]:
    if not value:
        return None
    match = re.search(r"(20\d{2})", value)
    if not match:
        return None
    return int(match.group(1))


def resolve_dropbox_geojson(
    access_token: str,
    root_tag: str,
    app_folder_name: Optional[str],
    base_path: str,
    version_hint: Optional[str],
) -> Tuple[str, str]:
    print(f"Dropbox base path (raw): {base_path}")
    base_path = normalize_path(base_path, root_tag, app_folder_name)
    print(f"Dropbox base path (normalized): {base_path}")
    target_year = parse_year(version_hint)
    inferred_version = None

    if base_path.lower().endswith(".geojson"):
        file_path = base_path
        if version_hint:
            inferred_version = parse_year(version_hint) or version_hint
        else:
            for part in Path(file_path).parts:
                match = re.search(r"(20\d{2})", part)
                if match:
                    inferred_version = match.group(1)
                    break
        if not inferred_version:
            raise RuntimeError("Version is required when using a direct GeoJSON path.")
        return file_path, str(inferred_version)

    listing = list_folder_all(access_token, base_path, recursive=False)
    print(f"Dropbox entries under {base_path}:")
    folders = []
    files = []
    for entry in listing:
        entry_name = entry.get("name") or ""
        entry_tag = entry.get(".tag")
        print(f"- {entry_name} ({entry_tag})")
        if entry_tag == "folder":
            parsed = parse_version_tag(entry_name)
            if parsed:
                folders.append((parsed[0], parsed[1], entry_name))
        elif entry_tag == "file" and entry_name.lower().endswith(".geojson"):
            files.append(entry)

    if files:
        choice = choose_geojson(files, target_year)
        if not choice:
            raise RuntimeError(f"No GeoJSON files found in {base_path}.")
        file_path = choice.get("path_display") or choice.get("path_lower")
        inferred_version = entry_version(choice)
        if inferred_version:
            return file_path, str(inferred_version[0])
        if not version_hint:
            raise RuntimeError("Failed to infer version from GeoJSON path.")
        return file_path, str(parse_year(version_hint) or version_hint)

    if not folders:
        raise RuntimeError(f"No GeoJSON files found under {base_path}.")

    if target_year:
        matching = [folder for folder in folders if folder[0] == target_year]
        year_folder = sorted(matching or folders)[-1][2]
    else:
        year_folder = sorted(folders)[-1][2]
    year_path = normalize_path(f"{base_path}/{year_folder}", root_tag, app_folder_name)
    inferred_version = str(sorted(folders)[-1][0]) if not target_year else str(target_year)

    year_listing = list_folder_all(access_token, year_path, recursive=True)
    geojson_files = [
        entry
        for entry in year_listing
        if entry.get(".tag") == "file"
        and (entry.get("name") or "").lower().endswith(".geojson")
    ]
    choice = choose_geojson(geojson_files, target_year)
    if not choice:
        raise RuntimeError(f"No GeoJSON files found under {year_path}.")
    file_path = choice.get("path_display") or choice.get("path_lower")
    if not inferred_version:
        inferred = entry_version(choice)
        if inferred:
            inferred_version = str(inferred[0])
    if not inferred_version and version_hint:
        inferred_version = str(parse_year(version_hint) or version_hint)
    if not inferred_version:
        raise RuntimeError("Failed to infer version from GeoJSON path.")
    return file_path, inferred_version


def download_geojson(access_token: str, file_path: str, output_path: Path) -> None:
    resp = requests.post(
        "https://content.dropboxapi.com/2/files/download",
        headers={
            "Authorization": f"Bearer {access_token}",
            "Dropbox-API-Arg": json.dumps({"path": file_path}),
        },
        timeout=120,
    )
    resp.raise_for_status()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(resp.content)


def write_env(env_file: str, prefix: str, version: str, output_path: Path) -> None:
    if not env_file or not prefix:
        return
    with open(env_file, "a", encoding="utf-8") as handle:
        handle.write(f"{prefix}_VERSION={version}\n")
        handle.write(f"{prefix}_GEOJSON_PATH={output_path}\n")


def main() -> int:
    args = parse_args()
    base_path = args.dropbox_base or args.dropbox_path
    if not base_path:
        print("Missing --dropbox-base or --dropbox-path.", file=sys.stderr)
        return 1

    access_token = dropbox_access_token()
    account_info = dropbox_request(access_token, "users/get_current_account")
    root_info = account_info.get("root_info", {})
    root_tag = root_info.get(".tag")
    app_folder_name = root_info.get("app_folder_name")

    file_path, version = resolve_dropbox_geojson(
        access_token,
        root_tag,
        app_folder_name,
        base_path,
        args.version,
    )
    output_path = Path(args.output)
    download_geojson(access_token, file_path, output_path)

    prefix = args.env_prefix.strip().upper()
    write_env(args.env_file, prefix, version, output_path)
    print(f"Downloaded {file_path} to {output_path} (version {version}).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
