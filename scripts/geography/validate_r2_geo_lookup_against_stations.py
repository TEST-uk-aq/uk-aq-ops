#!/usr/bin/env python3
"""Validate the PCON/LA R2 shard lookup against stored station geography codes.

This is a read-only confidence gate. It samples station rows from Supabase,
looks up the station point in the R2 shard lookup, and compares the shard
result with the stored pcon_code / la_code values already present on the row.
"""
from __future__ import annotations

import argparse
import binascii
import json
import math
import os
import random
import struct
import sys
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Any, Callable, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, quote
from urllib.request import Request, urlopen

CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4"
DEFAULT_BUCKET = "uk-aq-pcon-la-lookup"
DEFAULT_PREFIX = "v1"
DEFAULT_GRID_SIZE_DEGREES = 0.05
DEFAULT_BOUNDARY_DETAIL = "detailed"
DEFAULT_LIMIT = 100
DEFAULT_OUTPUT = "logs/geo_validate/latest.json"
RETRYABLE_STATUS_CODES = {408, 429, 500, 502, 503, 504}
RETRYABLE_ERROR_SUBSTRINGS = (
    "timed out",
    "timeout",
    "temporarily unavailable",
    "connection reset",
    "connection refused",
    "broken pipe",
    "remote end closed",
)
MAX_ATTEMPTS = 5
RETRY_BASE_MS = 750
RETRY_MAX_MS = 8000
TILE_EPSILON = 1e-12
EPSG_4326 = "EPSG:4326"


@dataclass(frozen=True)
class ValidationConfig:
    supabase_url: str
    sb_secret_key: str
    bucket: str
    prefix: str
    grid_size_degrees: float
    boundary_detail: str
    limit: int
    random_seed: int | None
    station_ids: list[int] | None
    output_path: str
    cf_account_id: str
    cf_api_token: str


class ValidationError(RuntimeError):
    pass


class LookupErrorWithContext(RuntimeError):
    pass


class SupabaseClient:
    def __init__(self, supabase_url: str, secret_key: str, schema: str = "uk_aq_public"):
        self.supabase_url = supabase_url.rstrip("/")
        self.secret_key = secret_key.strip()
        self.schema = schema

    def _headers(self) -> dict[str, str]:
        return {
            "apikey": self.secret_key,
            "authorization": f"Bearer {self.secret_key}",
            "accept-profile": self.schema,
            "content-profile": self.schema,
            "accept": "application/json",
        }

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        body: dict[str, Any] | None = None,
    ) -> Any:
        url = f"{self.supabase_url}/rest/v1{path}"
        if params:
            query = urlencode([(key, value) for key, value in params.items() if value is not None], doseq=True)
            if query:
                url = f"{url}?{query}"
        request_body = None
        headers = self._headers()
        if body is not None:
            request_body = json.dumps(body).encode("utf-8")
            headers["content-type"] = "application/json"
        request = Request(url, data=request_body, headers=headers, method=method)
        try:
            with urlopen(request, timeout=90) as response:
                raw = response.read().decode("utf-8")
        except HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            raise LookupErrorWithContext(f"Supabase request failed ({method} {path}): {exc.code} {exc.reason} - {raw}") from exc
        except URLError as exc:
            raise LookupErrorWithContext(f"Supabase request failed ({method} {path}): {exc}") from exc
        if not raw:
            return []
        return json.loads(raw)

    def get_rows(
        self,
        path: str,
        *,
        select: str,
        order: str = "id.asc",
        page_size: int = 1000,
        extra_params: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        offset = 0
        while True:
            params: dict[str, Any] = {
                "select": select,
                "order": order,
                "limit": page_size,
                "offset": offset,
            }
            if extra_params:
                params.update(extra_params)
            page = self._request("GET", path, params=params)
            if not isinstance(page, list):
                raise LookupErrorWithContext(f"Unexpected Supabase payload for {path}: {type(page).__name__}")
            rows.extend(page)
            if len(page) < page_size:
                break
            offset += page_size
        return rows

    def get_connectors(self) -> dict[int, str]:
        rows = self.get_rows(
            "/connectors",
            select="id,connector_code",
            order="id.asc",
            page_size=1000,
        )
        mapping: dict[int, str] = {}
        for row in rows:
            try:
                connector_id = int(row.get("id"))
            except (TypeError, ValueError):
                continue
            connector_code = normalize_text(row.get("connector_code"))
            if connector_code:
                mapping[connector_id] = connector_code
        return mapping

    def get_stations(self) -> list[dict[str, Any]]:
        return self.get_rows(
            "/stations",
            select=(
                "id,station_name,label,connector_id,geometry,pcon_code,pcon_version,"
                "la_code,la_version,removed_at"
            ),
            order="id.asc",
            page_size=1000,
        )

    def get_code_name_map(self, layer: str, version: str) -> dict[str, str]:
        version = normalize_text(version)
        if not version:
            return {}
        if layer == "pcon":
            rows = self._request(
                "POST",
                "/rpc/uk_aq_pcon_hex_rpc",
                body={"pcon_version": version, "limit_rows": 10000},
            )
            code_key = "pcon_code"
            name_key = "pcon_name"
        elif layer == "la":
            rows = self._request(
                "POST",
                "/rpc/uk_aq_la_hex_rpc",
                body={"la_version": version, "limit_rows": 10000},
            )
            code_key = "la_code"
            name_key = "la_name"
        else:
            raise ValidationError(f"Unsupported layer for code/name map: {layer}")
        if not isinstance(rows, list):
            raise LookupErrorWithContext(f"Unexpected RPC payload for {layer} version {version}: {type(rows).__name__}")
        mapping: dict[str, str] = {}
        for row in rows:
            code = normalize_text(row.get(code_key))
            name = normalize_text(row.get(name_key))
            if code and name:
                mapping[code] = name
        return mapping


class R2ObjectClient:
    def __init__(self, account_id: str, api_token: str, bucket: str):
        self.account_id = account_id.strip()
        self.api_token = api_token.strip()
        self.bucket = bucket.strip()
        self._cache: dict[str, bytes] = {}

    def object_url(self, object_key: str) -> str:
        encoded_key = "/".join(quote(part, safe="") for part in object_key.split("/") if part)
        return (
            f"{CLOUDFLARE_API_BASE}/accounts/{self.account_id}/r2/buckets/{self.bucket}/objects/{encoded_key}"
        )

    def get_bytes(self, object_key: str) -> bytes:
        object_key = normalize_object_key(object_key)
        if object_key in self._cache:
            return self._cache[object_key]

        url = self.object_url(object_key)
        for attempt in range(1, MAX_ATTEMPTS + 1):
            request = Request(
                url,
                method="GET",
                headers={
                    "authorization": f"Bearer {self.api_token}",
                    "accept": "application/octet-stream",
                },
            )
            try:
                with urlopen(request, timeout=90) as response:
                    body = response.read()
                    if response.status >= 400:
                        raise LookupErrorWithContext(
                            f"Cloudflare API GET failed for {object_key}: {response.status} {response.reason}"
                        )
                    self._cache[object_key] = body
                    return body
            except HTTPError as exc:
                raw = exc.read().decode("utf-8", errors="replace")
                retryable = exc.code in RETRYABLE_STATUS_CODES
                if retryable and attempt < MAX_ATTEMPTS:
                    sleep_ms = retry_delay_ms(attempt)
                    time.sleep(sleep_ms / 1000.0)
                    continue
                raise LookupErrorWithContext(
                    f"Cloudflare API GET failed for {object_key}: {exc.code} {exc.reason} - {raw}"
                ) from exc
            except URLError as exc:
                if attempt < MAX_ATTEMPTS and is_retryable_request_error(exc):
                    time.sleep(retry_delay_ms(attempt) / 1000.0)
                    continue
                raise LookupErrorWithContext(f"Cloudflare API GET failed for {object_key}: {exc}") from exc
        raise LookupErrorWithContext(f"Cloudflare API GET retry loop exhausted for {object_key}")

    def get_json(self, object_key: str) -> Any:
        raw = self.get_bytes(object_key)
        if not raw:
            return None
        return json.loads(raw.decode("utf-8"))


class GeoLookupValidator:
    def __init__(
        self,
        config: ValidationConfig,
        supabase_client: SupabaseClient,
        r2_client: R2ObjectClient,
    ):
        self.config = config
        self.supabase = supabase_client
        self.r2 = r2_client
        self.manifest: dict[str, Any] | None = None
        self._station_rows: list[dict[str, Any]] | None = None
        self._connectors: dict[int, str] | None = None
        self._code_name_cache: dict[tuple[str, str], dict[str, str]] = {}
        self._shard_cache: dict[str, dict[str, Any]] = {}
        self._geometry_cache: dict[str, dict[str, Any]] = {}

    def load_manifest(self) -> dict[str, Any]:
        if self.manifest is not None:
            return self.manifest
        manifest_key = f"{self.config.prefix}/manifest.json"
        payload = self.r2.get_json(manifest_key)
        if not isinstance(payload, dict):
            raise LookupErrorWithContext(f"Manifest did not parse as JSON object: {manifest_key}")
        self.manifest = payload
        return payload

    def load_stations(self) -> list[dict[str, Any]]:
        if self._station_rows is None:
            self._station_rows = self.supabase.get_stations()
        return self._station_rows

    def load_connectors(self) -> dict[int, str]:
        if self._connectors is None:
            self._connectors = self.supabase.get_connectors()
        return self._connectors

    def load_name_map(self, layer: str, version: str | None) -> dict[str, str]:
        version = normalize_text(version)
        if not version:
            return {}
        cache_key = (layer, version)
        if cache_key not in self._code_name_cache:
            self._code_name_cache[cache_key] = self.supabase.get_code_name_map(layer, version)
        return self._code_name_cache[cache_key]

    def load_shard(self, layer: str, tile_key: str) -> dict[str, Any]:
        key = f"{self.config.prefix}/{layer}/{self.config.boundary_detail}/grid_{format_grid_token(self.config.grid_size_degrees)}/{tile_key}.json"
        if key not in self._shard_cache:
            payload = self.r2.get_json(key)
            if not isinstance(payload, dict):
                raise LookupErrorWithContext(f"Shard did not parse as JSON object: {key}")
            self._shard_cache[key] = payload
        return self._shard_cache[key]

    def load_geometry(self, geometry_ref: str) -> dict[str, Any]:
        key = f"{self.config.prefix}/{normalize_object_key(geometry_ref)}"
        if key not in self._geometry_cache:
            payload = self.r2.get_json(key)
            if not isinstance(payload, dict):
                raise LookupErrorWithContext(f"Geometry did not parse as JSON object: {key}")
            self._geometry_cache[key] = payload
        return self._geometry_cache[key]

    def lookup_layer(self, layer: str, lat: float, lon: float) -> dict[str, Any]:
        grid_size = self.config.grid_size_degrees
        exact_tile = tile_for_point(lat, lon, grid_size)
        candidate_tiles = [exact_tile] + neighbour_tiles(exact_tile, grid_size)
        shard_keys_fetched: list[str] = []
        neighbour_tiles_checked: list[str] = []

        for index, tile in enumerate(candidate_tiles):
            if index > 0:
                neighbour_tiles_checked.append(tile["key"])
            shard_key = (
                f"{self.config.prefix}/{layer}/{self.config.boundary_detail}/grid_{format_grid_token(grid_size)}/{tile['key']}.json"
            )
            shard_keys_fetched.append(shard_key)
            try:
                shard = self.load_shard(layer, tile["key"])
            except LookupErrorWithContext as exc:
                raise LookupErrorWithContext(f"{layer} shard fetch failed for {tile['key']}: {exc}") from exc

            features = shard.get("features")
            if not isinstance(features, list) or not features:
                continue

            for feature in features:
                bbox = feature.get("bbox")
                if not bbox_overlap_point(bbox, lon, lat):
                    continue
                geometry_ref = normalize_text(feature.get("geometry_ref"))
                if not geometry_ref:
                    continue
                geometry_payload = self.load_geometry(geometry_ref)
                geometry = geometry_payload.get("geometry")
                if not geometry:
                    continue
                if point_in_geometry(lon, lat, geometry):
                    return {
                        "code": normalize_text(feature.get("code")) or None,
                        "name": normalize_text(geometry_payload.get("name") or feature.get("name")) or None,
                        "match_strategy": "exact_tile" if index == 0 else "neighbour_tile",
                        "tile_key": tile["key"],
                        "neighbour_tiles_checked": neighbour_tiles_checked,
                        "shard_keys_fetched": shard_keys_fetched,
                    }

        return {
            "code": None,
            "name": None,
            "match_strategy": "no_match",
            "tile_key": exact_tile["key"],
            "neighbour_tiles_checked": neighbour_tiles_checked,
            "shard_keys_fetched": shard_keys_fetched,
        }

    def validate_station(self, row: dict[str, Any], connector_code: str | None) -> dict[str, Any]:
        station_id = row.get("id")
        station_name = normalize_text(row.get("station_name") or row.get("label")) or None
        pcon_code = normalize_text(row.get("pcon_code")) or None
        la_code = normalize_text(row.get("la_code")) or None
        pcon_version = normalize_text(row.get("pcon_version")) or None
        la_version = normalize_text(row.get("la_version")) or None
        stored_pcon_name = self.load_name_map("pcon", pcon_version).get(pcon_code) if pcon_code else None
        stored_la_name = self.load_name_map("la", la_version).get(la_code) if la_code else None

        try:
            lon, lat, srid = decode_geometry_point(row.get("geometry"))
        except ValueError as exc:
            return build_station_row(
                station_id=station_id,
                station_name=station_name,
                connector_code=connector_code,
                lat=None,
                lon=None,
                stored={
                    "pcon_code": pcon_code,
                    "pcon_name": stored_pcon_name,
                    "la_code": la_code,
                    "la_name": stored_la_name,
                },
                r2={
                    "pcon_code": None,
                    "pcon_name": None,
                    "pcon_match_strategy": "invalid_coordinate",
                    "la_code": None,
                    "la_name": None,
                    "la_match_strategy": "invalid_coordinate",
                },
                diagnostics={
                    "tile_key": None,
                    "neighbour_tiles_checked": [],
                    "shard_keys_fetched": [],
                    "error": str(exc),
                },
                comparison={
                    "pcon_code_match": False,
                    "la_code_match": False,
                    "overall_match": False,
                    "classification": ["invalid_coordinates"],
                },
            )

        if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
            return build_station_row(
                station_id=station_id,
                station_name=station_name,
                connector_code=connector_code,
                lat=lat,
                lon=lon,
                stored={
                    "pcon_code": pcon_code,
                    "pcon_name": stored_pcon_name,
                    "la_code": la_code,
                    "la_name": stored_la_name,
                },
                r2={
                    "pcon_code": None,
                    "pcon_name": None,
                    "pcon_match_strategy": "invalid_coordinate",
                    "la_code": None,
                    "la_name": None,
                    "la_match_strategy": "invalid_coordinate",
                },
                diagnostics={
                    "tile_key": None,
                    "neighbour_tiles_checked": [],
                    "shard_keys_fetched": [],
                    "error": f"Coordinate out of range (srid={srid})",
                },
                comparison={
                    "pcon_code_match": False,
                    "la_code_match": False,
                    "overall_match": False,
                    "classification": ["invalid_coordinates"],
                },
            )

        try:
            pcon_lookup = self.lookup_layer("pcon", lat, lon)
            la_lookup = self.lookup_layer("la", lat, lon)
        except LookupErrorWithContext as exc:
            return build_station_row(
                station_id=station_id,
                station_name=station_name,
                connector_code=connector_code,
                lat=lat,
                lon=lon,
                stored={
                    "pcon_code": pcon_code,
                    "pcon_name": stored_pcon_name,
                    "la_code": la_code,
                    "la_name": stored_la_name,
                },
                r2={
                    "pcon_code": None,
                    "pcon_name": None,
                    "pcon_match_strategy": "error",
                    "la_code": None,
                    "la_name": None,
                    "la_match_strategy": "error",
                },
                diagnostics={
                    "tile_key": None,
                    "neighbour_tiles_checked": [],
                    "shard_keys_fetched": [],
                    "error": str(exc),
                },
                comparison={
                    "pcon_code_match": False,
                    "la_code_match": False,
                    "overall_match": False,
                    "classification": ["lookup_error"],
                },
            )

        comparison = compare_station_row(
            stored_pcon_code=pcon_code,
            stored_pcon_name=stored_pcon_name,
            stored_la_code=la_code,
            stored_la_name=stored_la_name,
            pcon_lookup=pcon_lookup,
            la_lookup=la_lookup,
        )

        diagnostics = {
            "tile_key": pcon_lookup.get("tile_key") or la_lookup.get("tile_key"),
            "neighbour_tiles_checked": unique_preserve_order(
                [
                    *pcon_lookup.get("neighbour_tiles_checked", []),
                    *la_lookup.get("neighbour_tiles_checked", []),
                ]
            ),
            "shard_keys_fetched": unique_preserve_order(
                [
                    *pcon_lookup.get("shard_keys_fetched", []),
                    *la_lookup.get("shard_keys_fetched", []),
                ]
            ),
        }

        return build_station_row(
            station_id=station_id,
            station_name=station_name,
            connector_code=connector_code,
            lat=lat,
            lon=lon,
            stored={
                "pcon_code": pcon_code,
                "pcon_name": stored_pcon_name,
                "la_code": la_code,
                "la_name": stored_la_name,
            },
            r2={
                "pcon_code": pcon_lookup.get("code"),
                "pcon_name": pcon_lookup.get("name"),
                "pcon_match_strategy": pcon_lookup.get("match_strategy"),
                "la_code": la_lookup.get("code"),
                "la_name": la_lookup.get("name"),
                "la_match_strategy": la_lookup.get("match_strategy"),
            },
            diagnostics=diagnostics,
            comparison=comparison,
        )

    def run(self) -> dict[str, Any]:
        manifest = self.load_manifest()
        stations = self.load_stations()
        connectors = self.load_connectors()

        selected, selection_stats = select_station_rows(
            stations,
            limit=self.config.limit,
            station_ids=self.config.station_ids,
            random_seed=self.config.random_seed,
        )

        rows: list[dict[str, Any]] = []
        summary = Counter()
        errors = Counter()

        for row in selected:
            connector_code = None
            connector_id = row.get("connector_id")
            try:
                connector_code = connectors.get(int(connector_id)) if connector_id is not None else None
            except (TypeError, ValueError):
                connector_code = None
            result = self.validate_station(row, connector_code)
            rows.append(result)
            if result["comparison"]["overall_match"]:
                summary["overall_matches"] += 1
            else:
                summary["overall_mismatches"] += 1
            summary["pcon_code_matches"] += int(result["comparison"]["pcon_code_match"])
            summary["pcon_code_mismatches"] += int(
                result["r2"]["pcon_match_strategy"] not in {"no_match", "invalid_coordinate", "error"}
                and not result["comparison"]["pcon_code_match"]
            )
            summary["pcon_missing_r2"] += int(result["r2"]["pcon_match_strategy"] == "no_match")
            summary["la_code_matches"] += int(result["comparison"]["la_code_match"])
            summary["la_code_mismatches"] += int(
                result["r2"]["la_match_strategy"] not in {"no_match", "invalid_coordinate", "error"}
                and not result["comparison"]["la_code_match"]
            )
            summary["la_missing_r2"] += int(result["r2"]["la_match_strategy"] == "no_match")
            if "invalid_coordinates" in result["comparison"]["classification"]:
                errors["invalid_coordinates"] += 1
            if "lookup_error" in result["comparison"]["classification"]:
                errors["lookup_error"] += 1

        report = {
            "summary": {
                "eligible": selection_stats["eligible"],
                "sampled": len(selected),
                "pcon_code_matches": summary["pcon_code_matches"],
                "pcon_code_mismatches": summary["pcon_code_mismatches"],
                "pcon_missing_r2": summary["pcon_missing_r2"],
                "la_code_matches": summary["la_code_matches"],
                "la_code_mismatches": summary["la_code_mismatches"],
                "la_missing_r2": summary["la_missing_r2"],
                "overall_matches": summary["overall_matches"],
                "overall_mismatches": summary["overall_mismatches"],
                "invalid_coordinates": errors["invalid_coordinates"],
                "lookup_errors": errors["lookup_error"],
                "total_rows_considered": selection_stats["total_rows_considered"],
                "skipped": dict(selection_stats["skipped"]),
            },
            "manifest": {
                "bucket": self.config.bucket,
                "prefix": normalize_prefix(manifest.get("prefix") or self.config.prefix),
                "grid_size_degrees": manifest.get("grid_size_degrees", self.config.grid_size_degrees),
                "pcon_version": manifest.get("layers", {}).get("pcon", {}).get("boundary_version"),
                "la_version": manifest.get("layers", {}).get("la", {}).get("boundary_version"),
            },
            "rows": rows,
        }
        return report


def normalize_prefix(raw_prefix: str | None) -> str:
    return str(raw_prefix or "").strip().strip("/")


def normalize_object_key(raw_key: str | None) -> str:
    return str(raw_key or "").strip().lstrip("/")


def normalize_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def unique_preserve_order(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        value = normalize_text(value)
        if not value or value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


def grid_precision(grid_size: float) -> int:
    value = Decimal(str(grid_size))
    precision = 0
    scaled = value
    while precision < 8 and scaled != scaled.to_integral_value(rounding=ROUND_HALF_UP):
        precision += 1
        scaled = value * (Decimal(10) ** precision)
    return precision


def round_coord(value: float, precision: int) -> float:
    quant = Decimal("1").scaleb(-precision)
    rounded = Decimal(str(value)).quantize(quant, rounding=ROUND_HALF_UP)
    result = float(rounded)
    return 0.0 if result == -0.0 else result


def format_grid_token(grid_size: float) -> str:
    precision = grid_precision(grid_size)
    return f"{grid_size:.{precision}f}"


def build_tile_key(ix: int, iy: int) -> str:
    return f"iy{iy}_ix{ix}"


def tile_for_point(lat: float, lon: float, grid_size: float) -> dict[str, Any]:
    precision = grid_precision(grid_size)
    iy = math.floor(lat / grid_size)
    ix = math.floor(lon / grid_size)
    lat_min = round_coord(iy * grid_size, precision)
    lon_min = round_coord(ix * grid_size, precision)
    lat_max = round_coord(lat_min + grid_size, precision)
    lon_max = round_coord(lon_min + grid_size, precision)
    return {
        "key": build_tile_key(ix, iy),
        "ix": ix,
        "iy": iy,
        "lat_min": lat_min,
        "lat_max": lat_max,
        "lon_min": lon_min,
        "lon_max": lon_max,
    }


def neighbour_tiles(tile: dict[str, Any], grid_size: float) -> list[dict[str, Any]]:
    precision = grid_precision(grid_size)
    out: list[dict[str, Any]] = []
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dx == 0 and dy == 0:
                continue
            ix = int(tile["ix"]) + dx
            iy = int(tile["iy"]) + dy
            lat_min = round_coord(iy * grid_size, precision)
            lon_min = round_coord(ix * grid_size, precision)
            out.append(
                {
                    "key": build_tile_key(ix, iy),
                    "ix": ix,
                    "iy": iy,
                    "lat_min": lat_min,
                    "lat_max": round_coord(lat_min + grid_size, precision),
                    "lon_min": lon_min,
                    "lon_max": round_coord(lon_min + grid_size, precision),
                }
            )
    out.sort(key=lambda item: (item["iy"], item["ix"]))
    return out


def bbox_overlap_point(bbox: Any, lon: float, lat: float) -> bool:
    if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
        return False
    try:
        min_lon, min_lat, max_lon, max_lat = [float(value) for value in bbox]
    except (TypeError, ValueError):
        return False
    return (
        min_lon - TILE_EPSILON <= lon <= max_lon + TILE_EPSILON
        and min_lat - TILE_EPSILON <= lat <= max_lat + TILE_EPSILON
    )


def point_on_segment(lon: float, lat: float, p1: list[Any], p2: list[Any]) -> bool:
    try:
        x1, y1 = float(p1[0]), float(p1[1])
        x2, y2 = float(p2[0]), float(p2[1])
    except (TypeError, ValueError, IndexError):
        return False
    cross = (lon - x1) * (y2 - y1) - (lat - y1) * (x2 - x1)
    if abs(cross) > TILE_EPSILON:
        return False
    dot = (lon - x1) * (lon - x2) + (lat - y1) * (lat - y2)
    return dot <= TILE_EPSILON


def point_in_ring(lon: float, lat: float, ring: Any) -> bool:
    if not isinstance(ring, (list, tuple)) or len(ring) < 3:
        return False
    inside = False
    for idx in range(len(ring) - 1):
        current = ring[idx]
        nxt = ring[idx + 1]
        if point_on_segment(lon, lat, current, nxt):
            return True
        try:
            x1, y1 = float(current[0]), float(current[1])
            x2, y2 = float(nxt[0]), float(nxt[1])
        except (TypeError, ValueError, IndexError):
            continue
        intersects = ((y1 > lat) != (y2 > lat)) and (
            lon < ((x2 - x1) * (lat - y1) / ((y2 - y1) if y2 != y1 else 1e-30)) + x1
        )
        if intersects:
            inside = not inside
    return inside


def point_in_polygon(lon: float, lat: float, polygon: Any) -> bool:
    if not isinstance(polygon, (list, tuple)) or not polygon:
        return False
    rings = polygon
    outer = rings[0]
    if not point_in_ring(lon, lat, outer):
        return False
    for hole in rings[1:]:
        if point_in_ring(lon, lat, hole):
            return False
    return True


def point_in_geometry(lon: float, lat: float, geometry: Any) -> bool:
    if not isinstance(geometry, dict):
        return False
    geometry_type = normalize_text(geometry.get("type"))
    coordinates = geometry.get("coordinates")
    if geometry_type == "Polygon":
        return point_in_polygon(lon, lat, coordinates)
    if geometry_type == "MultiPolygon" and isinstance(coordinates, (list, tuple)):
        return any(point_in_polygon(lon, lat, polygon) for polygon in coordinates)
    return False


def decode_geometry_point(raw_geometry: Any) -> tuple[float, float, int | None]:
    if raw_geometry is None:
        raise ValueError("missing geometry")
    if isinstance(raw_geometry, dict):
        if normalize_text(raw_geometry.get("type")) != "Point":
            raise ValueError(f"unsupported geometry type: {raw_geometry.get('type')}")
        coordinates = raw_geometry.get("coordinates") or []
        if len(coordinates) < 2:
            raise ValueError("invalid geojson point coordinates")
        lon = float(coordinates[0])
        lat = float(coordinates[1])
        srid = raw_geometry.get("srid")
        try:
            srid_value = int(srid) if srid is not None else None
        except (TypeError, ValueError):
            srid_value = None
        return lon, lat, srid_value
    if isinstance(raw_geometry, (bytes, bytearray)):
        raw_bytes = bytes(raw_geometry)
    else:
        raw_text = normalize_text(raw_geometry)
        if not raw_text:
            raise ValueError("missing geometry")
        if raw_text.startswith("{"):
            payload = json.loads(raw_text)
            return decode_geometry_point(payload)
        try:
            raw_bytes = binascii.unhexlify(raw_text)
        except (binascii.Error, ValueError) as exc:
            raise ValueError(f"invalid geometry hex: {exc}") from exc

    if len(raw_bytes) < 1 + 4 + 16:
        raise ValueError("geometry payload too short")
    byte_order = raw_bytes[0]
    if byte_order == 1:
        endian = "<"
    elif byte_order == 0:
        endian = ">"
    else:
        raise ValueError(f"unsupported byte order flag: {byte_order}")
    geom_type_with_flags = struct.unpack_from(f"{endian}I", raw_bytes, 1)[0]
    srid = None
    has_srid = bool(geom_type_with_flags & 0x20000000)
    geom_type = geom_type_with_flags & 0x0FFFFFFF
    offset = 5
    if has_srid:
        if len(raw_bytes) < offset + 4:
            raise ValueError("geometry missing SRID")
        srid = struct.unpack_from(f"{endian}I", raw_bytes, offset)[0]
        offset += 4
    if geom_type != 1:
        raise ValueError(f"unsupported geometry type id: {geom_type}")
    if len(raw_bytes) < offset + 16:
        raise ValueError("geometry point payload too short")
    lon, lat = struct.unpack_from(f"{endian}dd", raw_bytes, offset)
    return lon, lat, srid


def compare_station_row(
    *,
    stored_pcon_code: str | None,
    stored_pcon_name: str | None,
    stored_la_code: str | None,
    stored_la_name: str | None,
    pcon_lookup: dict[str, Any],
    la_lookup: dict[str, Any],
) -> dict[str, Any]:
    pcon_code_match = bool(
        stored_pcon_code
        and pcon_lookup.get("code")
        and normalize_text(stored_pcon_code) == normalize_text(pcon_lookup.get("code"))
    )
    la_code_match = bool(
        stored_la_code
        and la_lookup.get("code")
        and normalize_text(stored_la_code) == normalize_text(la_lookup.get("code"))
    )
    overall_match = pcon_code_match and la_code_match
    classification: list[str] = []

    if pcon_lookup.get("match_strategy") == "error" or la_lookup.get("match_strategy") == "error":
        classification.append("lookup_error")
    elif pcon_lookup.get("match_strategy") == "invalid_coordinate" or la_lookup.get("match_strategy") == "invalid_coordinate":
        classification.append("invalid_coordinates")
    else:
        if not pcon_lookup.get("code"):
            classification.append("pcon_no_r2_match")
        elif not pcon_code_match:
            classification.append("pcon_code_mismatch")
        if not la_lookup.get("code"):
            classification.append("la_no_r2_match")
        elif not la_code_match:
            classification.append("la_code_mismatch")

        if pcon_code_match and la_code_match:
            if pcon_lookup.get("match_strategy") == "neighbour_tile" or la_lookup.get("match_strategy") == "neighbour_tile":
                classification.append("possible_boundary_edge")
        else:
            if (
                pcon_lookup.get("code")
                and stored_pcon_name
                and pcon_lookup.get("name")
                and normalize_label(stored_pcon_name) == normalize_label(pcon_lookup.get("name"))
            ) or (
                la_lookup.get("code")
                and stored_la_name
                and la_lookup.get("name")
                and normalize_label(stored_la_name) == normalize_label(la_lookup.get("name"))
            ):
                classification.append("possible_boundary_version_difference")

    if pcon_lookup.get("match_strategy") == "neighbour_tile" or la_lookup.get("match_strategy") == "neighbour_tile":
        if "possible_boundary_edge" not in classification and overall_match:
            classification.append("possible_boundary_edge")

    if not classification and not overall_match:
        classification.append("lookup_error")

    return {
        "pcon_code_match": pcon_code_match,
        "la_code_match": la_code_match,
        "overall_match": overall_match,
        "classification": classification,
    }


def normalize_label(value: Any) -> str:
    return "".join(ch for ch in normalize_text(value).lower() if ch.isalnum())


def build_station_row(
    *,
    station_id: Any,
    station_name: str | None,
    connector_code: str | None,
    lat: float | None,
    lon: float | None,
    stored: dict[str, Any],
    r2: dict[str, Any],
    diagnostics: dict[str, Any],
    comparison: dict[str, Any],
) -> dict[str, Any]:
    return {
        "station_id": station_id,
        "station_name": station_name,
        "connector_code": connector_code,
        "lat": lat,
        "lon": lon,
        "stored": stored,
        "r2": r2,
        "comparison": comparison,
        "diagnostics": diagnostics,
    }


def select_station_rows(
    rows: list[dict[str, Any]],
    *,
    limit: int,
    station_ids: list[int] | None,
    random_seed: int | None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    considered = list(rows)
    skipped: Counter[str] = Counter()
    eligible: list[dict[str, Any]] = []
    for row in considered:
        if not has_valid_point(row):
            skipped[skip_reason_for_row(row)] += 1
            continue
        if not has_required_geography_codes(row):
            skipped[skip_reason_for_row(row)] += 1
            continue
        eligible.append(row)

    eligible.sort(key=lambda row: int(row.get("id") or 0))
    selected: list[dict[str, Any]]
    if station_ids:
        by_id: dict[int, dict[str, Any]] = {}
        for row in considered:
            row_id = safe_int(row.get("id"))
            if row_id is None:
                continue
            by_id[row_id] = row
        selected = []
        for raw_station_id in station_ids:
            row = by_id.get(raw_station_id)
            if row is None:
                skipped["missing_station_id"] += 1
                continue
            if not has_valid_point(row):
                skipped[skip_reason_for_row(row)] += 1
                continue
            if not has_required_geography_codes(row):
                skipped[skip_reason_for_row(row)] += 1
                continue
            selected.append(row)
    else:
        if random_seed is None:
            selected = eligible[: min(limit, len(eligible))]
        else:
            rng = random.Random(random_seed)
            selected = rng.sample(eligible, min(limit, len(eligible)))
            selected.sort(key=lambda row: int(row.get("id") or 0))

    return selected, {
        "total_rows_considered": len(considered),
        "eligible": len(eligible),
        "skipped": skipped,
    }


def has_valid_point(row: dict[str, Any]) -> bool:
    try:
        lon, lat, _ = decode_geometry_point(row.get("geometry"))
    except ValueError:
        return False
    return math.isfinite(lat) and math.isfinite(lon)


def has_required_geography_codes(row: dict[str, Any]) -> bool:
    return bool(normalize_text(row.get("pcon_code")) and normalize_text(row.get("la_code")))


def skip_reason_for_row(row: dict[str, Any]) -> str:
    if not normalize_text(row.get("pcon_code")):
        return "missing_pcon_code"
    if not normalize_text(row.get("la_code")):
        return "missing_la_code"
    try:
        decode_geometry_point(row.get("geometry"))
    except ValueError:
        return "invalid_geometry"
    return "unknown"


def safe_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def collect_versions(rows: list[dict[str, Any]]) -> dict[str, set[str]]:
    versions: dict[str, set[str]] = defaultdict(set)
    for row in rows:
        pcon_version = normalize_text(row.get("pcon_version"))
        la_version = normalize_text(row.get("la_version"))
        if pcon_version:
            versions["pcon"].add(pcon_version)
        if la_version:
            versions["la"].add(la_version)
    return versions


def parse_station_ids(raw_value: str | None) -> list[int] | None:
    text = normalize_text(raw_value)
    if not text:
        return None
    out: list[int] = []
    seen: set[int] = set()
    for token in text.split(","):
        token = token.strip()
        if not token:
            continue
        try:
            station_id = int(token)
        except ValueError as exc:
            raise ValidationError(f"Invalid station id in CSV list: {token!r}") from exc
        if station_id in seen:
            continue
        seen.add(station_id)
        out.append(station_id)
    return out or None


def retry_delay_ms(attempt: int) -> int:
    delay = min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** max(0, attempt - 1)))
    return int(delay)


def is_retryable_request_error(error: URLError | Exception) -> bool:
    text = str(error).lower()
    return any(token in text for token in RETRYABLE_ERROR_SUBSTRINGS)


def build_config(argv: list[str]) -> tuple[ValidationConfig, argparse.Namespace]:
    parser = argparse.ArgumentParser(
        prog="validate_r2_geo_lookup_against_stations.py",
        description="Validate the PCON/LA R2 shard lookup against station geography codes.",
    )
    parser.add_argument("--limit", type=int, default=None, help="Max eligible stations to sample")
    parser.add_argument("--station-ids", default=None, help="CSV list of exact station ids to validate")
    parser.add_argument("--seed", type=int, default=None, help="Deterministic random seed")
    parser.add_argument("--output", default=None, help="Output JSON report path")
    parser.add_argument("--bucket", default=None, help="R2 bucket name")
    parser.add_argument("--prefix", default=None, help="R2 object prefix")
    parser.add_argument("--grid-size", type=float, default=None, help="Grid size in degrees")
    parser.add_argument("--boundary-detail", default=None, help="Boundary detail label")
    parser.add_argument("--supabase-url", default=None, help="Supabase project URL")
    parser.add_argument("--sb-secret-key", default=None, help="Supabase service role key")
    parser.add_argument("--account-id", default=None, help="Cloudflare account id for R2 object reads")
    parser.add_argument("--api-token", default=None, help="Cloudflare API token for R2 object reads")
    args = parser.parse_args(argv)

    supabase_url = normalize_text(
        args.supabase_url
        or os.getenv("SUPABASE_URL")
    )
    sb_secret_key = normalize_text(
        args.sb_secret_key
        or os.getenv("SB_SECRET_KEY")
    )
    if not supabase_url:
        raise ValidationError("Missing required env var: SUPABASE_URL")
    if not sb_secret_key:
        raise ValidationError("Missing required env var: SB_SECRET_KEY")

    bucket = normalize_text(args.bucket or os.getenv("UK_AQ_GEO_R2_BUCKET") or DEFAULT_BUCKET)
    prefix = normalize_prefix(args.prefix or os.getenv("UK_AQ_GEO_R2_PREFIX") or DEFAULT_PREFIX)
    grid_size = float(args.grid_size or os.getenv("UK_AQ_GEO_GRID_SIZE_DEGREES") or DEFAULT_GRID_SIZE_DEGREES)
    boundary_detail = normalize_text(
        args.boundary_detail or os.getenv("UK_AQ_GEO_BOUNDARY_DETAIL") or DEFAULT_BOUNDARY_DETAIL
    )
    limit = int(args.limit or os.getenv("UK_AQ_GEO_VALIDATE_LIMIT") or DEFAULT_LIMIT)
    random_seed_raw = args.seed if args.seed is not None else os.getenv("UK_AQ_GEO_VALIDATE_RANDOM_SEED")
    random_seed = None if random_seed_raw in (None, "") else int(random_seed_raw)
    station_ids = parse_station_ids(args.station_ids or os.getenv("UK_AQ_GEO_VALIDATE_STATION_IDS"))
    output_path = normalize_text(args.output or os.getenv("UK_AQ_GEO_VALIDATE_OUTPUT") or DEFAULT_OUTPUT)
    account_id = normalize_text(
        args.account_id
        or os.getenv("UK_AQ_DOMAIN_CLOUDFLARE_ACCOUNT_ID")
        or os.getenv("UK_AQ_GEO_R2_CLOUDFLARE_ACCOUNT_ID")
        or os.getenv("UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID")
        or os.getenv("CLOUDFLARE_ACCOUNT_ID")
    )
    api_token = normalize_text(
        args.api_token
        or os.getenv("UK_AQ_DOMAIN_CLOUDFLARE_API_TOKEN")
        or os.getenv("UK_AQ_GEO_R2_CLOUDFLARE_API_TOKEN")
        or os.getenv("CLOUDFLARE_API_TOKEN")
    )
    if not account_id:
        raise ValidationError("Missing required Cloudflare account id: set UK_AQ_DOMAIN_CLOUDFLARE_ACCOUNT_ID")
    if not api_token:
        raise ValidationError("Missing required Cloudflare API token: set UK_AQ_DOMAIN_CLOUDFLARE_API_TOKEN")

    config = ValidationConfig(
        supabase_url=supabase_url,
        sb_secret_key=sb_secret_key,
        bucket=bucket,
        prefix=prefix,
        grid_size_degrees=grid_size,
        boundary_detail=boundary_detail,
        limit=limit,
        random_seed=random_seed,
        station_ids=station_ids,
        output_path=output_path,
        cf_account_id=account_id,
        cf_api_token=api_token,
    )
    return config, args


def main(argv: list[str] | None = None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    try:
        config, _ = build_config(argv)
        output_path = Path(config.output_path)
        if not output_path.is_absolute():
            output_path = Path.cwd() / output_path
        print(f"start env={os.getenv('UK_AQ_ENVIRONMENT', 'manual')} profile=geo-validate source=r2-stations")
        print(f"report={output_path}")
        supabase_client = SupabaseClient(config.supabase_url, config.sb_secret_key)
        r2_client = R2ObjectClient(config.cf_account_id, config.cf_api_token, config.bucket)
        validator = GeoLookupValidator(config, supabase_client, r2_client)
        report = validator.run()

        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")

        summary = report["summary"]
        print("Geo validation complete")
        print(f"  total rows considered: {summary['total_rows_considered']}")
        print(f"  eligible rows: {summary['eligible']}")
        print(f"  sampled rows: {summary['sampled']}")
        print(
            f"  PCON matches: {summary['pcon_code_matches']} mismatches: {summary['pcon_code_mismatches']} missing_r2: {summary['pcon_missing_r2']}"
        )
        print(
            f"  LA matches: {summary['la_code_matches']} mismatches: {summary['la_code_mismatches']} missing_r2: {summary['la_missing_r2']}"
        )
        print(f"  overall matches: {summary['overall_matches']} mismatches: {summary['overall_mismatches']}")
        if summary.get("invalid_coordinates"):
            print(f"  invalid coordinates: {summary['invalid_coordinates']}")
        if summary.get("lookup_errors"):
            print(f"  lookup errors: {summary['lookup_errors']}")
        print(f"  output report: {output_path}")

        top_mismatches = [
            row for row in report["rows"] if not row["comparison"]["overall_match"]
        ][:5]
        if top_mismatches:
            print("  top mismatch examples:")
            for row in top_mismatches:
                print(
                    f"    station {row['station_id']}: {', '.join(row['comparison']['classification']) or 'mismatch'}"
                )
        return 0
    except Exception as exc:
        print("Geo validation failed", file=sys.stderr)
        raise


if __name__ == "__main__":
    raise SystemExit(main())
