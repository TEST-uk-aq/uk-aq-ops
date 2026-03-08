#!/usr/bin/env python3
"""Prune old Dropbox raw-data folders by date folder name."""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys
from dataclasses import dataclass
from typing import Any

import requests

DROPBOX_TOKEN_URL = "https://api.dropbox.com/oauth2/token"
DROPBOX_API_BASE = "https://api.dropboxapi.com/2"
DATE_FOLDER_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DEFAULT_KEEP_DAYS = 32


def normalize_dropbox_path(raw: str) -> str:
    value = (raw or "").strip()
    if not value:
        return ""
    with_slash = value if value.startswith("/") else f"/{value}"
    return with_slash.rstrip("/")


def dropbox_with_root(path: str) -> str:
    root = normalize_dropbox_path(os.getenv("UK_AQ_DROPBOX_ROOT", ""))
    cleaned = normalize_dropbox_path(path)
    if not root:
        return cleaned
    if not cleaned:
        return root
    if cleaned == root or cleaned.startswith(f"{root}/"):
        return cleaned
    return f"{root}{cleaned}"


def parse_keep_count() -> int:
    raw = (os.getenv("DROPBOX_RAWFILES_KEEP") or "").strip()
    if not raw:
        return DEFAULT_KEEP_DAYS
    try:
        keep = int(raw)
    except ValueError as exc:
        raise RuntimeError("DROPBOX_RAWFILES_KEEP must be an integer.") from exc
    if keep < 0:
        raise RuntimeError("DROPBOX_RAWFILES_KEEP must be >= 0.")
    return keep


@dataclass
class DropboxApiError(Exception):
    endpoint: str
    status_code: int
    error_summary: str
    response_body: Any

    def __str__(self) -> str:
        detail = self.error_summary or "unknown error"
        return f"Dropbox API {self.endpoint} failed ({self.status_code}): {detail}"


def is_not_found_error(error: Exception) -> bool:
    if not isinstance(error, DropboxApiError):
        return False
    summary = (error.error_summary or "").lower()
    if "not_found" in summary:
        return True
    if isinstance(error.response_body, dict):
        error_obj = error.response_body.get("error")
        if isinstance(error_obj, dict):
            path_obj = error_obj.get("path")
            if isinstance(path_obj, dict) and path_obj.get(".tag") == "not_found":
                return True
    return False


class DropboxClient:
    def __init__(self, app_key: str, app_secret: str, refresh_token: str) -> None:
        if not (app_key and app_secret and refresh_token):
            raise RuntimeError(
                "DROPBOX_APP_KEY, DROPBOX_APP_SECRET, and DROPBOX_REFRESH_TOKEN are required."
            )
        self._app_key = app_key
        self._app_secret = app_secret
        self._refresh_token = refresh_token
        self._session = requests.Session()
        self._access_token: str | None = None

    @classmethod
    def from_env(cls) -> "DropboxClient":
        return cls(
            app_key=(os.getenv("DROPBOX_APP_KEY") or "").strip(),
            app_secret=(os.getenv("DROPBOX_APP_SECRET") or "").strip(),
            refresh_token=(os.getenv("DROPBOX_REFRESH_TOKEN") or "").strip(),
        )

    def _refresh_access_token(self) -> str:
        response = self._session.post(
            DROPBOX_TOKEN_URL,
            data={
                "grant_type": "refresh_token",
                "refresh_token": self._refresh_token,
                "client_id": self._app_key,
                "client_secret": self._app_secret,
            },
            timeout=30,
        )
        if not response.ok:
            text = response.text[:800]
            raise RuntimeError(
                f"Dropbox token request failed ({response.status_code}): {text}"
            )
        payload = response.json()
        token = str(payload.get("access_token") or "")
        if not token:
            raise RuntimeError("Dropbox token response missing access_token.")
        self._access_token = token
        return token

    def _require_token(self) -> str:
        return self._access_token or self._refresh_access_token()

    def _call(self, endpoint: str, payload: dict[str, Any]) -> dict[str, Any]:
        token = self._require_token()
        response = self._session.post(
            f"{DROPBOX_API_BASE}/{endpoint}",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            data=json.dumps(payload),
            timeout=60,
        )
        if response.status_code == 401:
            token = self._refresh_access_token()
            response = self._session.post(
                f"{DROPBOX_API_BASE}/{endpoint}",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
                data=json.dumps(payload),
                timeout=60,
            )

        if response.ok:
            if not response.content:
                return {}
            return response.json()

        body: Any
        summary = ""
        try:
            body = response.json()
            summary = str(body.get("error_summary") or "")
        except ValueError:
            body = response.text[:800]
        raise DropboxApiError(
            endpoint=endpoint,
            status_code=response.status_code,
            error_summary=summary,
            response_body=body,
        )

    def list_folder_entries(self, path: str) -> list[dict[str, Any]]:
        result = self._call(
            "files/list_folder",
            {"path": path, "recursive": False, "limit": 2000},
        )
        entries = list(result.get("entries") or [])
        while result.get("has_more"):
            cursor = result.get("cursor")
            if not cursor:
                break
            result = self._call("files/list_folder/continue", {"cursor": cursor})
            entries.extend(result.get("entries") or [])
        return entries

    def delete_folder_recursive(self, path: str) -> None:
        self._call("files/delete_v2", {"path": path})


def list_connector_raw_data_paths(client: DropboxClient) -> list[str]:
    connectors_root = dropbox_with_root("/connectors")
    try:
        connector_entries = client.list_folder_entries(connectors_root)
    except Exception as exc:
        if is_not_found_error(exc):
            return []
        raise

    raw_data_paths: list[str] = []
    for entry in connector_entries:
        if entry.get(".tag") != "folder":
            continue
        connector_path = entry.get("path_display") or entry.get("path_lower")
        if not connector_path:
            continue
        raw_data_paths.append(normalize_dropbox_path(f"{connector_path}/raw_data"))
    return raw_data_paths


def parse_dated_raw_folders(entries: list[dict[str, Any]]) -> list[tuple[dt.date, str]]:
    dated_folders: list[tuple[dt.date, str]] = []
    for entry in entries:
        if entry.get(".tag") != "folder":
            continue
        name = str(entry.get("name") or "")
        if not DATE_FOLDER_RE.fullmatch(name):
            continue
        try:
            folder_date = dt.date.fromisoformat(name)
        except ValueError:
            continue
        folder_path = str(entry.get("path_display") or entry.get("path_lower") or "")
        if not folder_path:
            continue
        dated_folders.append((folder_date, folder_path))

    dated_folders.sort(key=lambda item: item[0], reverse=True)
    return dated_folders


def prune_raw_data_folders(
    client: DropboxClient,
    raw_data_path: str,
    keep_count: int,
    failures: list[tuple[str, str]],
) -> None:
    try:
        entries = client.list_folder_entries(raw_data_path)
    except Exception as exc:
        if is_not_found_error(exc):
            return
        failures.append((raw_data_path, str(exc)))
        return

    dated_folders = parse_dated_raw_folders(entries)
    for _, folder_path in dated_folders[keep_count:]:
        try:
            client.delete_folder_recursive(folder_path)
            print(folder_path)
        except Exception as exc:  # continue-on-error by design
            failures.append((folder_path, str(exc)))


def main() -> int:
    keep_count = parse_keep_count()
    client = DropboxClient.from_env()

    failures: list[tuple[str, str]] = []
    raw_data_paths = list_connector_raw_data_paths(client)
    for raw_data_path in raw_data_paths:
        prune_raw_data_folders(client, raw_data_path, keep_count, failures)

    if failures:
        print("Failed directories:", file=sys.stderr)
        for folder_path, message in failures:
            print(f"{folder_path} :: {message}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1) from exc
