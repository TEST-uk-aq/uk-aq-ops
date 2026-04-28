#!/usr/bin/env python3
"""
Compare Aiven/PostGIS station geography lookup results with R2 shard lookup results.

This script is a Layer 1 validation gate and does not modify station rows.

Required env vars:
- SUPABASE_URL
- SB_SECRET_KEY
- PCON_AIVEN_PG_DSN

R2 defaults:
- UK_AQ_GEO_R2_BUCKET=uk-aq-pcon-la-lookup
- UK_AQ_GEO_R2_PREFIX=v1
"""

from __future__ import annotations

import argparse
import binascii
import csv
import hashlib
import hmac
import json
import math
import os
import struct
import sys
import time
import urllib.parse
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

try:
    import requests
except Exception:  # pragma: no cover - runtime guard
    requests = None

try:
    import psycopg2
except Exception:  # pragma: no cover - runtime guard
    psycopg2 = None


DEFAULT_COMPARE_LIMIT = 100
DEFAULT_R2_BUCKET = "uk-aq-pcon-la-lookup"
DEFAULT_R2_PREFIX = "v1"
DEFAULT_REPORT_PATH = "logs/geo_compare/latest.json"
DEFAULT_SHARD_CACHE_LIMIT = 128
HTTP_TIMEOUT_SECONDS = 30
R2_HTTP_TIMEOUT_SECONDS = 60
NEIGHBOR_TILE_DELTAS = [
    (0, 0),
    (1, 0),
    (-1, 0),
    (0, 1),
    (0, -1),
    (1, 1),
    (1, -1),
    (-1, 1),
    (-1, -1),
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compare Aiven boundary lookup vs R2 shard lookup for station geography.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=int(os.getenv("UK_AQ_GEO_COMPARE_LIMIT", str(DEFAULT_COMPARE_LIMIT))),
        help="Number of stations to compare when --station-ids is not provided.",
    )
    parser.add_argument(
        "--station-ids",
        default=os.getenv("UK_AQ_GEO_COMPARE_STATION_IDS", ""),
        help="Comma-separated station IDs to compare.",
    )
    parser.add_argument(
        "--include-already-enriched",
        action="store_true",
        default=parse_bool_env("UK_AQ_GEO_COMPARE_INCLUDE_ALREADY_ENRICHED", False),
        help="Include stations that already have both pcon_code and la_code.",
    )
    parser.add_argument(
        "--output",
        default=os.getenv("UK_AQ_GEO_COMPARE_OUTPUT", DEFAULT_REPORT_PATH),
        help="Output JSON report path.",
    )
    parser.add_argument(
        "--bucket",
        default=os.getenv("UK_AQ_GEO_R2_BUCKET", DEFAULT_R2_BUCKET),
        help=f"R2 bucket (default {DEFAULT_R2_BUCKET}).",
    )
    parser.add_argument(
        "--prefix",
        default=normalize_prefix(os.getenv("UK_AQ_GEO_R2_PREFIX", DEFAULT_R2_PREFIX)),
        help=f"R2 prefix (default {DEFAULT_R2_PREFIX}).",
    )
    parser.add_argument(
        "--endpoint",
        default=os.getenv("UK_AQ_GEO_R2_ENDPOINT", "").strip(),
        help="Optional explicit R2 endpoint.",
    )
    parser.add_argument(
        "--region",
        default=os.getenv("UK_AQ_GEO_R2_REGION", os.getenv("CFLARE_R2_REGION", "auto")).strip() or "auto",
        help="R2 region (default auto).",
    )
    parser.add_argument(
        "--pcon-version",
        default=(
            os.getenv("PCON_VERSION", "").strip()
            or os.getenv("UK_AQ_GEO_PCON_VERSION", "").strip()
        ),
        help="Optional Aiven PCON version override.",
    )
    parser.add_argument(
        "--la-version",
        default=(
            os.getenv("LA_VERSION", "").strip()
            or os.getenv("UK_AQ_GEO_LA_VERSION", "").strip()
        ),
        help="Optional Aiven LA version override.",
    )
    parser.add_argument(
        "--no-neighbor-fallback",
        action="store_true",
        help="Disable 8-neighbour fallback when exact tile has no match.",
    )
    parser.add_argument(
        "--shard-cache-limit",
        type=int,
        default=DEFAULT_SHARD_CACHE_LIMIT,
        help=f"In-memory R2 shard cache size (default {DEFAULT_SHARD_CACHE_LIMIT}).",
    )
    return parser.parse_args()


def parse_bool_env(key: str, default: bool) -> bool:
    raw = os.getenv(key)
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in {"1", "true", "yes", "y", "on"}:
        return True
    if normalized in {"0", "false", "no", "n", "off"}:
        return False
    return default


def normalize_prefix(raw: str) -> str:
    return str(raw or "").strip().strip("/")


def parse_station_ids_csv(raw: str) -> List[int]:
    text = str(raw or "").strip()
    if not text:
        return []
    ids: List[int] = []
    reader = csv.reader([text])
    for row in reader:
        for value in row:
            item = value.strip()
            if not item:
                continue
            try:
                ids.append(int(item))
            except ValueError as exc:
                raise ValueError(f"Invalid station id '{item}' in --station-ids.") from exc
    return sorted(set(ids))


def normalize_iso_utc(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def infer_cloudflare_account_id() -> str:
    return (
        os.getenv("UK_AQ_GEO_R2_CLOUDFLARE_ACCOUNT_ID", "").strip()
        or os.getenv("UK_AQ_POSTCODE_R2_CLOUDFLARE_ACCOUNT_ID", "").strip()
        or os.getenv("UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID", "").strip()
        or os.getenv("UK_AQ_DOMAIN_CLOUDFLARE_ACCOUNT_ID", "").strip()
        or os.getenv("CLOUDFLARE_ACCOUNT_ID", "").strip()
    )


def infer_r2_endpoint(explicit_endpoint: str) -> str:
    endpoint = (
        explicit_endpoint.strip()
        or os.getenv("UK_AQ_POSTCODE_R2_ENDPOINT", "").strip()
        or os.getenv("CFLARE_R2_ENDPOINT", "").strip()
        or os.getenv("R2_ENDPOINT", "").strip()
    )
    if endpoint:
        return endpoint.rstrip("/")
    account_id = infer_cloudflare_account_id()
    if not account_id:
        return ""
    return f"https://{account_id}.r2.cloudflarestorage.com"


def require_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required env var: {name}")
    return value


def supabase_headers(service_role_key: str, schema: str = "uk_aq_core") -> Dict[str, str]:
    return {
        "apikey": service_role_key,
        "Authorization": f"Bearer {service_role_key}",
        "Content-Type": "application/json",
        "Accept-Profile": schema,
        "Content-Profile": schema,
    }


def request_json(
    method: str,
    url: str,
    *,
    headers: Dict[str, str],
    params: Optional[Dict[str, str]] = None,
    payload: Optional[Dict[str, Any]] = None,
    timeout_seconds: int = HTTP_TIMEOUT_SECONDS,
) -> Any:
    if requests is None:
        raise RuntimeError(
            "requests is not installed. Install dependencies (for example: python3 -m pip install requests)."
        )
    response = requests.request(
        method=method,
        url=url,
        headers=headers,
        params=params,
        json=payload,
        timeout=timeout_seconds,
    )
    if not response.ok:
        text = response.text
        preview = text if len(text) < 2000 else text[:2000]
        raise RuntimeError(f"HTTP {response.status_code} {method} {url}: {preview}")
    if not response.content:
        return None
    return response.json()


def geometry_to_lon_lat(value: Any) -> Tuple[Optional[float], Optional[float]]:
    if value is None:
        return None, None
    if isinstance(value, dict):
        coordinates = value.get("coordinates")
        if isinstance(coordinates, (list, tuple)) and len(coordinates) >= 2:
            lon = coordinates[0]
            lat = coordinates[1]
            if isinstance(lon, (int, float)) and isinstance(lat, (int, float)):
                return float(lon), float(lat)
        return None, None
    if isinstance(value, str):
        try:
            raw = binascii.unhexlify(value)
        except (binascii.Error, ValueError):
            return None, None
        if len(raw) < 21:
            return None, None
        endian_flag = raw[0]
        if endian_flag == 0:
            endian = ">"
        elif endian_flag == 1:
            endian = "<"
        else:
            return None, None
        offset = 1
        try:
            geom_type = struct.unpack(f"{endian}I", raw[offset:offset + 4])[0]
        except struct.error:
            return None, None
        offset += 4
        has_srid = bool(geom_type & 0x20000000)
        base_type = geom_type & 0xFF
        if base_type != 1:
            return None, None
        if has_srid:
            if len(raw) < offset + 4:
                return None, None
            offset += 4
        if len(raw) < offset + 16:
            return None, None
        try:
            x, y = struct.unpack(f"{endian}dd", raw[offset:offset + 16])
        except struct.error:
            return None, None
        return float(x), float(y)
    return None, None


def fetch_stations(
    *,
    supabase_url: str,
    service_role_key: str,
    station_ids: Sequence[int],
    include_already_enriched: bool,
    limit: int,
) -> List[Dict[str, Any]]:
    base_url = supabase_url.rstrip("/")
    endpoint = f"{base_url}/rest/v1/stations"
    headers = supabase_headers(service_role_key)
    select_columns = ",".join(
        [
            "id",
            "station_ref",
            "station_name",
            "geometry",
            "pcon_code",
            "pcon_version",
            "la_code",
            "la_version",
        ]
    )

    if station_ids:
        ids_literal = ",".join(str(value) for value in station_ids)
        params = {
            "select": select_columns,
            "id": f"in.({ids_literal})",
            "order": "id",
            "limit": str(max(len(station_ids), 1)),
        }
        data = request_json("GET", endpoint, headers=headers, params=params)
        rows = data if isinstance(data, list) else []
        return rows

    page_size = min(max(limit, 1), 1000) if limit > 0 else 500
    collected: List[Dict[str, Any]] = []
    last_seen_id: Optional[int] = None

    while True:
        params: Dict[str, str] = {
            "select": select_columns,
            "order": "id",
            "limit": str(page_size),
            "geometry": "not.is.null",
        }
        if not include_already_enriched:
            params["or"] = "(pcon_code.is.null,la_code.is.null)"
        if last_seen_id is not None:
            params["id"] = f"gt.{last_seen_id}"

        data = request_json("GET", endpoint, headers=headers, params=params)
        batch = data if isinstance(data, list) else []
        if not batch:
            break

        for row in batch:
            station_id = row.get("id")
            if isinstance(station_id, int):
                last_seen_id = station_id
            elif isinstance(station_id, str) and station_id.isdigit():
                last_seen_id = int(station_id)
            collected.append(row)
            if limit > 0 and len(collected) >= limit:
                return collected

        if len(batch) < page_size:
            break

    return collected


def sha256_hex(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def hmac_sha256(key: bytes, value: str) -> bytes:
    return hmac.new(key, value.encode("utf-8"), hashlib.sha256).digest()


def build_signing_key(secret_access_key: str, date_stamp: str, region: str, service: str) -> bytes:
    k_date = hmac_sha256(f"AWS4{secret_access_key}".encode("utf-8"), date_stamp)
    k_region = hmac_sha256(k_date, region)
    k_service = hmac_sha256(k_region, service)
    return hmac_sha256(k_service, "aws4_request")


def amz_date(now: datetime) -> str:
    return now.strftime("%Y%m%dT%H%M%SZ")


def aws_encode_path_component(value: str) -> str:
    return urllib.parse.quote(value, safe="-_.~")


@dataclass
class R2Config:
    endpoint: str
    bucket: str
    region: str
    access_key_id: str
    secret_access_key: str


class R2Client:
    def __init__(self, config: R2Config):
        self.config = config

    def _signed_get_request(self, object_key: str) -> Tuple[str, Dict[str, str]]:
        endpoint_url = urllib.parse.urlsplit(self.config.endpoint)
        host = endpoint_url.netloc
        now = datetime.now(timezone.utc)
        request_amz_date = amz_date(now)
        date_stamp = request_amz_date[:8]
        service = "s3"
        region = self.config.region

        path_parts = ["", self.config.bucket]
        for part in str(object_key or "").split("/"):
            if not part:
                continue
            path_parts.append(aws_encode_path_component(part))
        canonical_uri = "/".join(path_parts) or "/"

        payload_hash = sha256_hex(b"")
        canonical_headers = {
            "host": host,
            "x-amz-content-sha256": payload_hash,
            "x-amz-date": request_amz_date,
        }
        signed_headers = ";".join(sorted(canonical_headers.keys()))
        canonical_headers_text = "".join(
            f"{name}:{canonical_headers[name]}\n" for name in sorted(canonical_headers.keys())
        )

        canonical_request = "\n".join(
            [
                "GET",
                canonical_uri,
                "",
                canonical_headers_text,
                signed_headers,
                payload_hash,
            ]
        )
        credential_scope = f"{date_stamp}/{region}/{service}/aws4_request"
        string_to_sign = "\n".join(
            [
                "AWS4-HMAC-SHA256",
                request_amz_date,
                credential_scope,
                sha256_hex(canonical_request.encode("utf-8")),
            ]
        )
        signing_key = build_signing_key(self.config.secret_access_key, date_stamp, region, service)
        signature = hmac.new(signing_key, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
        authorization = (
            f"AWS4-HMAC-SHA256 Credential={self.config.access_key_id}/{credential_scope}, "
            f"SignedHeaders={signed_headers}, Signature={signature}"
        )

        headers = {
            "host": host,
            "x-amz-content-sha256": payload_hash,
            "x-amz-date": request_amz_date,
            "authorization": authorization,
        }
        request_url = urllib.parse.urlunsplit(
            (
                endpoint_url.scheme,
                endpoint_url.netloc,
                canonical_uri,
                "",
                "",
            )
        )
        return request_url, headers

    def get_json_object(self, object_key: str) -> Dict[str, Any]:
        if requests is None:
            raise RuntimeError(
                "requests is not installed. Install dependencies (for example: python3 -m pip install requests)."
            )
        request_url, headers = self._signed_get_request(object_key)
        response = requests.get(request_url, headers=headers, timeout=R2_HTTP_TIMEOUT_SECONDS)
        if response.status_code == 404:
            raise FileNotFoundError(object_key)
        if not response.ok:
            preview = response.text if len(response.text) < 2000 else response.text[:2000]
            raise RuntimeError(f"R2 GET failed ({response.status_code}) key={object_key}: {preview}")
        try:
            data = response.json()
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Invalid JSON in R2 object key={object_key}") from exc
        if not isinstance(data, dict):
            raise RuntimeError(f"Expected JSON object in R2 key={object_key}")
        return data


def normalize_signed_zero(value: float) -> float:
    return 0.0 if value == 0 else value


def grid_precision(grid_size: float) -> int:
    if grid_size <= 0:
        raise ValueError(f"Invalid grid_size {grid_size}")
    precision = 0
    scaled = grid_size
    while precision < 8 and abs(round(scaled) - scaled) > 1e-9:
        precision += 1
        scaled = grid_size * (10 ** precision)
    return precision


def round_coord(value: float, precision: int) -> float:
    rounded = round(value, precision)
    return normalize_signed_zero(rounded)


def format_coord(value: float, precision: int) -> str:
    return f"{round_coord(value, precision):.{precision}f}"


def format_grid_token(grid_size: float) -> str:
    precision = grid_precision(grid_size)
    return f"{grid_size:.{precision}f}"


class GeoShardLookup:
    def __init__(
        self,
        *,
        r2: R2Client,
        prefix: str,
        shard_cache_limit: int,
        default_boundary_detail: str = "detailed",
    ):
        self.r2 = r2
        self.prefix = normalize_prefix(prefix)
        self.shard_cache_limit = max(16, int(shard_cache_limit))
        manifest_key = f"{self.prefix}/manifest.json" if self.prefix else "manifest.json"
        self.manifest = self.r2.get_json_object(manifest_key)
        self.grid_size = float(self.manifest.get("grid_size_degrees") or 0.05)
        self.grid_precision = grid_precision(self.grid_size)
        self.grid_token = str(self.manifest.get("grid_token") or format_grid_token(self.grid_size))
        self.boundary_detail = (
            str(self.manifest.get("boundary_detail") or "").strip()
            or default_boundary_detail
        )
        self.layers = self._normalize_layers(self.manifest.get("layers"))
        self._shard_cache: OrderedDict[str, Dict[str, Any]] = OrderedDict()
        self._missing_shards: set[str] = set()

    def _normalize_layers(self, raw_layers: Any) -> Dict[str, Dict[str, Any]]:
        if not isinstance(raw_layers, dict):
            return {}
        normalized: Dict[str, Dict[str, Any]] = {}
        for key, value in raw_layers.items():
            if not isinstance(value, dict):
                continue
            normalized[str(key)] = value
        return normalized

    def tile_key(self, lon: float, lat: float) -> str:
        lat_min = round_coord(math.floor(lat / self.grid_size) * self.grid_size, self.grid_precision)
        lon_min = round_coord(math.floor(lon / self.grid_size) * self.grid_size, self.grid_precision)
        return f"{format_coord(lat_min, self.grid_precision)}_{format_coord(lon_min, self.grid_precision)}"

    def tile_neighbors(self, lon: float, lat: float, include_neighbors: bool) -> List[str]:
        lat_index = math.floor(lat / self.grid_size)
        lon_index = math.floor(lon / self.grid_size)
        deltas = NEIGHBOR_TILE_DELTAS if include_neighbors else [(0, 0)]
        keys: List[str] = []
        for d_lat, d_lon in deltas:
            tile_lat = round_coord((lat_index + d_lat) * self.grid_size, self.grid_precision)
            tile_lon = round_coord((lon_index + d_lon) * self.grid_size, self.grid_precision)
            key = f"{format_coord(tile_lat, self.grid_precision)}_{format_coord(tile_lon, self.grid_precision)}"
            if key not in keys:
                keys.append(key)
        return keys

    def shard_key(self, layer: str, tile_key: str) -> str:
        rel = f"{layer}/{self.boundary_detail}/grid_{self.grid_token}/{tile_key}.json"
        return f"{self.prefix}/{rel}" if self.prefix else rel

    def get_shard(self, layer: str, tile_key: str) -> Optional[Dict[str, Any]]:
        key = self.shard_key(layer, tile_key)
        if key in self._missing_shards:
            return None
        cached = self._shard_cache.get(key)
        if cached is not None:
            self._shard_cache.move_to_end(key)
            return cached
        try:
            data = self.r2.get_json_object(key)
        except FileNotFoundError:
            self._missing_shards.add(key)
            return None
        self._shard_cache[key] = data
        self._shard_cache.move_to_end(key)
        while len(self._shard_cache) > self.shard_cache_limit:
            self._shard_cache.popitem(last=False)
        return data

    def lookup(self, layer: str, lon: float, lat: float, include_neighbors: bool) -> Dict[str, Any]:
        tile_keys = self.tile_neighbors(lon, lat, include_neighbors)
        diagnostics: Dict[str, Any] = {
            "tile_keys_checked": tile_keys,
            "matched_tile_key": None,
            "candidate_feature_count": 0,
            "checked_feature_count": 0,
            "boundary_detail": self.boundary_detail,
            "grid_size_degrees": self.grid_size,
            "grid_token": self.grid_token,
        }
        for tile_key in tile_keys:
            shard = self.get_shard(layer, tile_key)
            if not shard:
                continue
            features = shard.get("features")
            if not isinstance(features, list):
                continue
            for feature in features:
                bbox = feature.get("bbox")
                if not point_in_bbox(lon, lat, bbox):
                    continue
                diagnostics["candidate_feature_count"] += 1
                geometry = feature.get("geometry")
                diagnostics["checked_feature_count"] += 1
                if point_in_geometry(lon, lat, geometry):
                    diagnostics["matched_tile_key"] = tile_key
                    return {
                        "code": stringify_or_none(feature.get("code")),
                        "name": stringify_or_none(feature.get("name")),
                        "version": stringify_or_none(self.layers.get(layer, {}).get("boundary_version")),
                        "diagnostics": diagnostics,
                    }
        return {
            "code": None,
            "name": None,
            "version": stringify_or_none(self.layers.get(layer, {}).get("boundary_version")),
            "diagnostics": diagnostics,
        }


def stringify_or_none(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def point_in_bbox(lon: float, lat: float, bbox: Any) -> bool:
    if not isinstance(bbox, list) or len(bbox) != 4:
        return False
    try:
        min_lon, min_lat, max_lon, max_lat = (float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3]))
    except (TypeError, ValueError):
        return False
    return min_lon <= lon <= max_lon and min_lat <= lat <= max_lat


def point_on_segment(px: float, py: float, ax: float, ay: float, bx: float, by: float, eps: float = 1e-12) -> bool:
    cross = (px - ax) * (by - ay) - (py - ay) * (bx - ax)
    if abs(cross) > eps:
        return False
    dot = (px - ax) * (px - bx) + (py - ay) * (py - by)
    return dot <= eps


def point_in_ring(lon: float, lat: float, ring: Sequence[Sequence[float]]) -> Tuple[bool, bool]:
    if not ring or len(ring) < 4:
        return False, False
    inside = False
    for index in range(len(ring) - 1):
        a = ring[index]
        b = ring[index + 1]
        try:
            ax, ay = float(a[0]), float(a[1])
            bx, by = float(b[0]), float(b[1])
        except (TypeError, ValueError, IndexError):
            continue
        if point_on_segment(lon, lat, ax, ay, bx, by):
            return True, True
        intersects = (ay > lat) != (by > lat)
        if intersects:
            slope_lon = (bx - ax) * (lat - ay) / (by - ay) + ax
            if lon < slope_lon:
                inside = not inside
    return inside, False


def point_in_polygon(lon: float, lat: float, polygon: Sequence[Sequence[Sequence[float]]]) -> bool:
    if not polygon:
        return False
    outer = polygon[0]
    inside_outer, on_outer = point_in_ring(lon, lat, outer)
    if on_outer:
        return True
    if not inside_outer:
        return False
    for hole in polygon[1:]:
        inside_hole, on_hole = point_in_ring(lon, lat, hole)
        if on_hole:
            return True
        if inside_hole:
            return False
    return True


def point_in_geometry(lon: float, lat: float, geometry: Any) -> bool:
    if not isinstance(geometry, dict):
        return False
    geom_type = str(geometry.get("type") or "")
    coordinates = geometry.get("coordinates")
    if geom_type == "Polygon":
        if not isinstance(coordinates, list):
            return False
        return point_in_polygon(lon, lat, coordinates)
    if geom_type == "MultiPolygon":
        if not isinstance(coordinates, list):
            return False
        for polygon in coordinates:
            if isinstance(polygon, list) and point_in_polygon(lon, lat, polygon):
                return True
        return False
    return False


class AivenLookupClient:
    def __init__(self, dsn: str):
        if psycopg2 is None:
            raise RuntimeError(
                "psycopg2 is not installed. Install dependencies (for example: python3 -m pip install psycopg2-binary)."
            )
        self.conn = psycopg2.connect(dsn)
        self.conn.autocommit = True

    def close(self) -> None:
        self.conn.close()

    def resolve_latest_version(self, table: str, version_column: str) -> Optional[str]:
        with self.conn.cursor() as cursor:
            cursor.execute(
                f"select {version_column} from {table} where {version_column} is not null order by {version_column} desc limit 1"
            )
            row = cursor.fetchone()
        if not row:
            return None
        return stringify_or_none(row[0])

    def lookup(
        self,
        *,
        table: str,
        code_column: str,
        name_column: str,
        version_column: str,
        lon: float,
        lat: float,
        target_version: Optional[str],
    ) -> Dict[str, Any]:
        sql = (
            f"select {code_column}, {name_column}, {version_column} "
            f"from {table} "
            f"where (%s is null or {version_column} = %s) "
            "and st_covers(geometry::geometry, st_setsrid(st_point(%s, %s), 4326)) "
            f"order by {version_column} desc "
            "limit 1"
        )
        with self.conn.cursor() as cursor:
            cursor.execute(sql, (target_version, target_version, lon, lat))
            row = cursor.fetchone()
        if not row:
            return {
                "code": None,
                "name": None,
                "version": target_version,
            }
        return {
            "code": stringify_or_none(row[0]),
            "name": stringify_or_none(row[1]),
            "version": stringify_or_none(row[2]),
        }


def compare_one_layer(
    *,
    layer: str,
    aiven: Dict[str, Any],
    r2: Dict[str, Any],
) -> Dict[str, Any]:
    aiven_code = stringify_or_none(aiven.get("code"))
    aiven_name = stringify_or_none(aiven.get("name"))
    r2_code = stringify_or_none(r2.get("code"))
    r2_name = stringify_or_none(r2.get("name"))

    code_match = aiven_code == r2_code
    name_match = normalize_name_for_compare(aiven_name) == normalize_name_for_compare(r2_name)
    both_match = code_match and name_match

    reason = "match"
    if aiven_code is None and r2_code is None:
        reason = "both_missing"
    elif aiven_code is None and r2_code is not None:
        reason = f"{layer}_missing_in_aiven"
    elif aiven_code is not None and r2_code is None:
        reason = f"{layer}_missing_in_r2"
    elif not code_match:
        reason = f"{layer}_code_mismatch"
    elif not name_match:
        reason = f"{layer}_name_mismatch"

    return {
        "layer": layer,
        "code_match": code_match,
        "name_match": name_match,
        "both_match": both_match,
        "reason": reason,
        "aiven": {
            "code": aiven_code,
            "name": aiven_name,
            "version": stringify_or_none(aiven.get("version")),
        },
        "r2": {
            "code": r2_code,
            "name": r2_name,
            "version": stringify_or_none(r2.get("version")),
            "diagnostics": r2.get("diagnostics"),
        },
    }


def normalize_name_for_compare(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    return " ".join(value.strip().lower().split())


def summarize_comparisons(layer_results: List[Dict[str, Any]]) -> Dict[str, Any]:
    summary = {
        "compared": 0,
        "code_match": 0,
        "name_match": 0,
        "both_match": 0,
        "mismatch": 0,
        "missing_in_aiven": 0,
        "missing_in_r2": 0,
        "both_missing": 0,
        "reasons": {},
    }
    for item in layer_results:
        summary["compared"] += 1
        if item.get("code_match"):
            summary["code_match"] += 1
        if item.get("name_match"):
            summary["name_match"] += 1
        if item.get("both_match"):
            summary["both_match"] += 1
        else:
            summary["mismatch"] += 1
        reason = str(item.get("reason") or "unknown")
        summary["reasons"][reason] = summary["reasons"].get(reason, 0) + 1
        if reason.endswith("missing_in_aiven"):
            summary["missing_in_aiven"] += 1
        elif reason.endswith("missing_in_r2"):
            summary["missing_in_r2"] += 1
        elif reason == "both_missing":
            summary["both_missing"] += 1
    return summary


def build_report(
    *,
    args: argparse.Namespace,
    stations: List[Dict[str, Any]],
    station_results: List[Dict[str, Any]],
    pcon_version_used: Optional[str],
    la_version_used: Optional[str],
    manifest: Dict[str, Any],
    started_at: datetime,
    finished_at: datetime,
) -> Dict[str, Any]:
    pcon_results = [row["comparison"]["pcon"] for row in station_results]
    la_results = [row["comparison"]["la"] for row in station_results]
    mismatches = [
        row for row in station_results
        if not row["comparison"]["pcon"]["both_match"] or not row["comparison"]["la"]["both_match"]
    ]

    return {
        "schema_version": 1,
        "generated_at_utc": finished_at.isoformat().replace("+00:00", "Z"),
        "started_at_utc": started_at.isoformat().replace("+00:00", "Z"),
        "source": "AIVEN_VS_R2_COMPARE",
        "inputs": {
            "bucket": args.bucket,
            "prefix": normalize_prefix(args.prefix),
            "limit": args.limit,
            "station_ids": parse_station_ids_csv(args.station_ids),
            "include_already_enriched": bool(args.include_already_enriched),
            "neighbor_fallback": not bool(args.no_neighbor_fallback),
            "pcon_version": pcon_version_used,
            "la_version": la_version_used,
        },
        "r2_manifest": {
            "schema_version": manifest.get("schema_version"),
            "generated_at_utc": manifest.get("generated_at_utc"),
            "grid_size_degrees": manifest.get("grid_size_degrees"),
            "grid_token": manifest.get("grid_token"),
            "boundary_detail": manifest.get("boundary_detail"),
            "layers": manifest.get("layers"),
            "prefix": manifest.get("prefix"),
        },
        "summary": {
            "station_input_count": len(stations),
            "station_compared_count": len(station_results),
            "station_mismatch_count": len(mismatches),
            "pcon": summarize_comparisons(pcon_results),
            "la": summarize_comparisons(la_results),
        },
        "mismatches": mismatches,
        "stations": station_results,
    }


def write_report(path_value: str, payload: Dict[str, Any]) -> Path:
    path = Path(path_value).expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, indent=2, ensure_ascii=True)
    path.write_text(f"{text}\n", encoding="utf-8")
    return path


def build_r2_config(args: argparse.Namespace) -> R2Config:
    endpoint = infer_r2_endpoint(args.endpoint)
    access_key_id = (
        os.getenv("CLOUDFLARE_R2_ACCESS_KEY_ID", "").strip()
        or os.getenv("CFLARE_R2_ACCESS_KEY_ID", "").strip()
        or os.getenv("R2_ACCESS_KEY_ID", "").strip()
    )
    secret_access_key = (
        os.getenv("CLOUDFLARE_R2_SECRET_ACCESS_KEY", "").strip()
        or os.getenv("CFLARE_R2_SECRET_ACCESS_KEY", "").strip()
        or os.getenv("R2_SECRET_ACCESS_KEY", "").strip()
    )
    if not endpoint:
        raise RuntimeError("Missing R2 endpoint/account id for compare script.")
    if not args.bucket:
        raise RuntimeError("Missing R2 bucket for compare script.")
    if not access_key_id or not secret_access_key:
        raise RuntimeError(
            "Missing R2 access credentials. Set CLOUDFLARE_R2_ACCESS_KEY_ID and CLOUDFLARE_R2_SECRET_ACCESS_KEY.",
        )
    return R2Config(
        endpoint=endpoint,
        bucket=args.bucket,
        region=args.region or "auto",
        access_key_id=access_key_id,
        secret_access_key=secret_access_key,
    )


def main() -> int:
    args = parse_args()
    started_at = datetime.now(timezone.utc)

    supabase_url = require_env("SUPABASE_URL")
    service_role_key = require_env("SB_SECRET_KEY")
    aiven_dsn = require_env("PCON_AIVEN_PG_DSN")
    station_ids = parse_station_ids_csv(args.station_ids)

    stations = fetch_stations(
        supabase_url=supabase_url,
        service_role_key=service_role_key,
        station_ids=station_ids,
        include_already_enriched=bool(args.include_already_enriched),
        limit=max(int(args.limit), 1),
    )
    if not stations:
        raise RuntimeError("No stations returned for comparison input.")

    r2_config = build_r2_config(args)
    r2_client = R2Client(r2_config)
    shard_lookup = GeoShardLookup(
        r2=r2_client,
        prefix=args.prefix,
        shard_cache_limit=args.shard_cache_limit,
    )

    aiven = AivenLookupClient(aiven_dsn)
    try:
        pcon_version_used = args.pcon_version.strip() if args.pcon_version else ""
        la_version_used = args.la_version.strip() if args.la_version else ""
        if not pcon_version_used:
            pcon_version_used = aiven.resolve_latest_version("pcon_boundaries", "pcon_version") or ""
        if not la_version_used:
            la_version_used = aiven.resolve_latest_version("la_boundaries", "la_version") or ""
        if not pcon_version_used:
            raise RuntimeError("Failed to resolve PCON version from Aiven and none provided.")
        if not la_version_used:
            raise RuntimeError("Failed to resolve LA version from Aiven and none provided.")

        station_results: List[Dict[str, Any]] = []
        compared = 0
        skipped_missing_coords = 0

        for station in stations:
            station_id = station.get("id")
            lon, lat = geometry_to_lon_lat(station.get("geometry"))
            if lon is None or lat is None:
                skipped_missing_coords += 1
                continue
            if not isinstance(station_id, int):
                try:
                    station_id = int(station_id)
                except (TypeError, ValueError):
                    continue

            aiven_pcon = aiven.lookup(
                table="pcon_boundaries",
                code_column="pcon_code",
                name_column="pcon_name",
                version_column="pcon_version",
                lon=lon,
                lat=lat,
                target_version=pcon_version_used,
            )
            aiven_la = aiven.lookup(
                table="la_boundaries",
                code_column="la_code",
                name_column="la_name",
                version_column="la_version",
                lon=lon,
                lat=lat,
                target_version=la_version_used,
            )
            r2_pcon = shard_lookup.lookup("pcon", lon, lat, include_neighbors=not args.no_neighbor_fallback)
            r2_la = shard_lookup.lookup("la", lon, lat, include_neighbors=not args.no_neighbor_fallback)

            comparison_pcon = compare_one_layer(layer="pcon", aiven=aiven_pcon, r2=r2_pcon)
            comparison_la = compare_one_layer(layer="la", aiven=aiven_la, r2=r2_la)

            station_results.append(
                {
                    "station": {
                        "id": station_id,
                        "station_ref": stringify_or_none(station.get("station_ref")),
                        "station_name": stringify_or_none(station.get("station_name")),
                        "lon": lon,
                        "lat": lat,
                        "existing_pcon_code": stringify_or_none(station.get("pcon_code")),
                        "existing_la_code": stringify_or_none(station.get("la_code")),
                        "existing_pcon_version": stringify_or_none(station.get("pcon_version")),
                        "existing_la_version": stringify_or_none(station.get("la_version")),
                    },
                    "comparison": {
                        "pcon": comparison_pcon,
                        "la": comparison_la,
                    },
                }
            )
            compared += 1

        finished_at = datetime.now(timezone.utc)
        report = build_report(
            args=args,
            stations=stations,
            station_results=station_results,
            pcon_version_used=pcon_version_used,
            la_version_used=la_version_used,
            manifest=shard_lookup.manifest,
            started_at=started_at,
            finished_at=finished_at,
        )
        report_path = write_report(args.output, report)

        summary = report.get("summary", {})
        print(
            json.dumps(
                {
                    "ok": True,
                    "bucket": args.bucket,
                    "prefix": normalize_prefix(args.prefix),
                    "station_input_count": summary.get("station_input_count", 0),
                    "station_compared_count": summary.get("station_compared_count", 0),
                    "station_mismatch_count": summary.get("station_mismatch_count", 0),
                    "skipped_missing_coords": skipped_missing_coords,
                    "pcon": summary.get("pcon"),
                    "la": summary.get("la"),
                    "report_path": str(report_path),
                },
                indent=2,
            )
        )
        return 0
    finally:
        aiven.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        message = str(exc).strip() or repr(exc)
        print(f"compare_r2_geo_lookup_with_aiven failed: {message}", file=sys.stderr)
        raise SystemExit(1)
