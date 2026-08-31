#!/usr/bin/env python3
"""Build and validate local observation-history timeseries-aligned-v2 prototypes.

This script is deliberately isolated from canonical writers and has no R2 client.
It reads already-staged TEST partitions, writes prototype Parquet/index artefacts
locally, and emits a structural report for the configured dense caps and file
packing bounds.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

import pyarrow as pa
import pyarrow.parquet as pq


PHYSICAL_LAYOUT_VERSION = "timeseries-aligned-v2"
PROTOTYPE_WRITER_VERSION = "pyarrow-zstd-timeseries-aligned-prototype-v1"
HISTORY_SCHEMA_VERSION = 3
CONTENT_HASH_PREFIX = b"uk-aq-observation-content-hash:v1\n"
CONTENT_HASH_COLUMNS = [
    "connector_id",
    "station_id",
    "timeseries_id",
    "pollutant_code",
    "observed_at_utc",
    "value",
    "verification_status",
]
PARQUET_COLUMNS = list(CONTENT_HASH_COLUMNS)
TARGET_FILE_ROWS = 65_536
MAX_FILE_ROWS = 131_072
TARGET_FILE_BYTES = 4 * 1024 * 1024
MAX_FILE_BYTES = 8 * 1024 * 1024
TARGET_TIMESERIES_ID = 7421
ROLE_NAMES = (
    "aurn",
    "sensorcommunity_normal",
    "sensorcommunity_dense",
)

PARQUET_SCHEMA = pa.schema(
    [
        pa.field("connector_id", pa.int32(), nullable=True),
        pa.field("station_id", pa.int32(), nullable=True),
        pa.field("timeseries_id", pa.int32(), nullable=True),
        pa.field("pollutant_code", pa.string(), nullable=True),
        pa.field("observed_at_utc", pa.timestamp("ms"), nullable=True),
        pa.field("value", pa.float64(), nullable=True),
        pa.field("verification_status", pa.string(), nullable=True),
    ],
    metadata={
        b"uk_aq_history_schema_version": str(HISTORY_SCHEMA_VERSION).encode(),
        b"uk_aq_writer_version": PROTOTYPE_WRITER_VERSION.encode(),
        b"uk_aq_physical_layout_version": PHYSICAL_LAYOUT_VERSION.encode(),
    },
)


def canonical_json_bytes(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False) + "\n").encode()


def timestamp_iso(value: Any) -> str:
    if isinstance(value, str):
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    elif isinstance(value, datetime):
        parsed = value
    else:
        raise TypeError(f"unsupported observation timestamp: {value!r}")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    parsed = parsed.astimezone(timezone.utc)
    if parsed.microsecond % 1000:
        raise ValueError("observation timestamp is not millisecond-aligned")
    return parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def timestamp_value(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def normalize_row(raw: dict[str, Any]) -> dict[str, Any]:
    status = raw.get("verification_status")
    if status not in (None, "P", "R"):
        raise ValueError(f"non-canonical verification_status: {status!r}")
    value = float(raw["value"])
    if not math.isfinite(value):
        raise ValueError("observation value must be finite")
    if value == 0:
        value = 0.0
    row = {
        "connector_id": int(raw["connector_id"]),
        "station_id": None if raw.get("station_id") is None else int(raw["station_id"]),
        "timeseries_id": int(raw["timeseries_id"]),
        "pollutant_code": str(raw["pollutant_code"]),
        "observed_at_utc": timestamp_iso(raw["observed_at_utc"]),
        "value": value,
        "verification_status": status,
    }
    if row["connector_id"] <= 0 or row["timeseries_id"] <= 0:
        raise ValueError("observation IDs must be positive")
    if row["station_id"] is not None and row["station_id"] <= 0:
        raise ValueError("station_id must be positive or null")
    return row


def encode_row(row: dict[str, Any]) -> str:
    value_hex = struct.pack(">d", row["value"]).hex()
    return json.dumps(
        [
            row["connector_id"],
            row["station_id"],
            row["timeseries_id"],
            row["pollutant_code"],
            row["observed_at_utc"],
            value_hex,
            row["verification_status"],
        ],
        separators=(",", ":"),
        ensure_ascii=False,
    )


def canonical_rows(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized = [normalize_row(row) for row in rows]
    return sorted(
        normalized,
        key=lambda row: (row["timeseries_id"], row["observed_at_utc"], encode_row(row)),
    )


def observation_content_hash(rows: Iterable[dict[str, Any]]) -> dict[str, Any]:
    normalized = [normalize_row(row) for row in rows]
    encoded = sorted(encode_row(row) for row in normalized)
    digest = hashlib.sha256()
    digest.update(CONTENT_HASH_PREFIX)
    for item in encoded:
        digest.update(item.encode())
        digest.update(b"\n")
    counts = Counter(
        "null" if row["verification_status"] is None else row["verification_status"]
        for row in normalized
    )
    return {
        "observation_content_hash": digest.hexdigest(),
        "observation_content_hash_algorithm": "sha256",
        "observation_content_hash_contract_version": 1,
        "observation_content_hash_row_count": len(normalized),
        "observation_content_hash_columns": list(CONTENT_HASH_COLUMNS),
        "verification_status_counts": {
            "P": counts["P"],
            "R": counts["R"],
            "null": counts["null"],
        },
    }


def timeseries_counts(rows: Iterable[dict[str, Any]]) -> dict[str, int]:
    counts = Counter(row["timeseries_id"] for row in rows)
    return {str(key): counts[key] for key in sorted(counts)}


def table_from_rows(rows: list[dict[str, Any]]) -> pa.Table:
    arrow_rows = [
        {
            **row,
            "observed_at_utc": timestamp_value(row["observed_at_utc"]).replace(tzinfo=None),
        }
        for row in rows
    ]
    return pa.Table.from_pylist(arrow_rows, schema=PARQUET_SCHEMA)


def footer_bytes(path: Path) -> int:
    with path.open("rb") as handle:
        handle.seek(-8, 2)
        trailer = handle.read(8)
    if len(trailer) != 8 or trailer[4:] != b"PAR1":
        raise ValueError(f"invalid Parquet trailer: {path}")
    return struct.unpack("<I", trailer[:4])[0] + 8


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_partition(role: str, root: Path) -> dict[str, Any]:
    manifest = json.loads((root / "manifest.json").read_text())
    tables = []
    source_files = []
    for descriptor in manifest.get("files", []):
        path = root / Path(descriptor["key"]).name
        if not path.is_file():
            raise FileNotFoundError(path)
        actual_sha256 = sha256_file(path)
        manifest_identity = str(descriptor.get("etag_or_hash") or "")
        if len(manifest_identity) == 64 and actual_sha256 != manifest_identity:
            raise ValueError(f"source Parquet SHA-256 mismatch: {path}")
        tables.append(pq.read_table(path, columns=PARQUET_COLUMNS))
        source_files.append(
            {
                "key": descriptor["key"],
                "byte_size": path.stat().st_size,
                "sha256": actual_sha256,
            }
        )
    if not tables:
        raise ValueError(f"source partition has no Parquet files: {root}")
    rows = canonical_rows(pa.concat_tables(tables).to_pylist())
    logical = observation_content_hash(rows)
    if len(rows) != int(manifest["row_count"]):
        raise ValueError(f"source row count disagrees with manifest: {root}")
    if logical["observation_content_hash"] != manifest["observation_content_hash"]:
        raise ValueError(f"source logical hash disagrees with manifest: {root}")
    if timeseries_counts(rows) != {
        str(key): int(value)
        for key, value in sorted(
            manifest["timeseries_row_counts"].items(), key=lambda item: int(item[0])
        )
    }:
        raise ValueError(f"source timeseries counts disagree with manifest: {root}")
    first = rows[0]
    scope = {
        "day_utc": manifest["day_utc"],
        "connector_id": int(manifest["connector_id"]),
        "pollutant_code": manifest["pollutant_code"],
    }
    if (
        first["observed_at_utc"][:10] != scope["day_utc"]
        or first["connector_id"] != scope["connector_id"]
        or first["pollutant_code"] != scope["pollutant_code"]
    ):
        raise ValueError(f"source scope mismatch: {root}")
    return {
        "role": role,
        "root": str(root),
        "scope": scope,
        "manifest": manifest,
        "rows": rows,
        "logical": logical,
        "timeseries_counts": timeseries_counts(rows),
        "source_files": source_files,
    }


def build_segments(rows: list[dict[str, Any]], cap: int) -> list[dict[str, Any]]:
    segments = []
    start = 0
    while start < len(rows):
        timeseries_id = rows[start]["timeseries_id"]
        end = start + 1
        while end < len(rows) and rows[end]["timeseries_id"] == timeseries_id:
            end += 1
        run = rows[start:end]
        for ordinal, chunk_start in enumerate(range(0, len(run), cap)):
            chunk = run[chunk_start : chunk_start + cap]
            segments.append(
                {
                    "timeseries_id": timeseries_id,
                    "chronological_segment_ordinal": ordinal,
                    "rows": chunk,
                    "row_count": len(chunk),
                    "min_observed_at_utc": chunk[0]["observed_at_utc"],
                    "max_observed_at_utc": chunk[-1]["observed_at_utc"],
                }
            )
        start = end
    return segments


def pack_files(segments: list[dict[str, Any]], max_row_groups: int) -> list[list[dict[str, Any]]]:
    files = []
    current = []
    current_rows = 0
    for segment in segments:
        must_flush = current and (
            len(current) >= max_row_groups
            or current_rows + segment["row_count"] > TARGET_FILE_ROWS
        )
        if must_flush:
            files.append(current)
            current = []
            current_rows = 0
        current.append(segment)
        current_rows += segment["row_count"]
        if current_rows > MAX_FILE_ROWS:
            raise ValueError("prototype file plan exceeds max_file_rows")
    if current:
        files.append(current)
    return files


def column_index(metadata: pq.FileMetaData, name: str) -> int:
    for index in range(metadata.num_columns):
        if metadata.schema.column(index).name == name:
            return index
    raise ValueError(f"missing Parquet column: {name}")


def validate_row_group(
    parquet_file: pq.ParquetFile,
    row_group_ordinal: int,
    intended: dict[str, Any],
) -> list[dict[str, Any]]:
    metadata = parquet_file.metadata
    row_group = metadata.row_group(row_group_ordinal)
    if row_group.num_rows != intended["row_count"]:
        raise ValueError("serialized row-group size disagrees with intended segment")
    timeseries_stats = row_group.column(column_index(metadata, "timeseries_id")).statistics
    observed_stats = row_group.column(column_index(metadata, "observed_at_utc")).statistics
    if (
        timeseries_stats is None
        or int(timeseries_stats.min) != intended["timeseries_id"]
        or int(timeseries_stats.max) != intended["timeseries_id"]
    ):
        raise ValueError("row group contains more than one timeseries identity")
    if (
        observed_stats is None
        or timestamp_iso(observed_stats.min) != intended["min_observed_at_utc"]
        or timestamp_iso(observed_stats.max) != intended["max_observed_at_utc"]
    ):
        raise ValueError("row-group timestamp statistics disagree with intended segment")
    decoded = canonical_rows(parquet_file.read_row_group(row_group_ordinal).to_pylist())
    if [encode_row(row) for row in decoded] != [
        encode_row(row) for row in intended["rows"]
    ]:
        raise ValueError("row-group logical rows changed during serialization")
    if {row["timeseries_id"] for row in decoded} != {intended["timeseries_id"]}:
        raise ValueError("row group contains unrelated timeseries rows")
    return decoded


def build_index(
    source: dict[str, Any],
    cap: int,
    max_row_groups: int,
    files: list[dict[str, Any]],
    segments: list[dict[str, Any]],
) -> dict[str, Any]:
    by_timeseries: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for segment in segments:
        by_timeseries[segment["timeseries_id"]].append(
            {
                key: value
                for key, value in segment.items()
                if key not in (
                    "timeseries_id",
                    "rows",
                    "chronological_segment_ordinal",
                )
            }
        )
    timeseries = []
    for timeseries_id in sorted(by_timeseries):
        exact_segments = by_timeseries[timeseries_id]
        timeseries.append(
            {
                "timeseries_id": timeseries_id,
                "row_count": sum(item["row_count"] for item in exact_segments),
                "min_observed_at_utc": exact_segments[0]["min_observed_at_utc"],
                "max_observed_at_utc": exact_segments[-1]["max_observed_at_utc"],
                "segments": exact_segments,
            }
        )
    return {
        "schema_version": 3,
        "kind": "observation_history_timeseries_aligned_prototype",
        "index_generation": "v3-prototype",
        "history_version": "v2",
        "history_schema_version": HISTORY_SCHEMA_VERSION,
        "writer_version": PROTOTYPE_WRITER_VERSION,
        "physical_layout_version": PHYSICAL_LAYOUT_VERSION,
        "scope": source["scope"],
        "dense_timeseries_row_cap": cap,
        "max_row_groups_per_file": max_row_groups,
        "target_file_rows": TARGET_FILE_ROWS,
        "max_file_rows": MAX_FILE_ROWS,
        "row_count": len(source["rows"]),
        "timeseries_count": len(source["timeseries_counts"]),
        "observation_content_hash": source["logical"]["observation_content_hash"],
        "files": files,
        "timeseries": timeseries,
    }


def validate_index_mapping(index_path: Path, source_rows: list[dict[str, Any]]) -> None:
    """Traverse only the encoded index coordinates back to their row groups."""
    index = json.loads(index_path.read_text())
    files = {item["key"]: item for item in index["files"]}
    parquet_files: dict[str, pq.ParquetFile] = {}
    row_group_starts: dict[str, list[int]] = {}
    decoded_rows = []
    referenced_groups = set()

    for file_key, descriptor in files.items():
        path = index_path.parent / file_key
        if (
            path.stat().st_size != descriptor["byte_size"]
            or sha256_file(path) != descriptor["sha256"]
        ):
            raise ValueError("prototype index file identity does not match Parquet")
        parquet_file = pq.ParquetFile(path)
        parquet_files[file_key] = parquet_file
        starts = []
        row_start = 0
        for ordinal in range(parquet_file.metadata.num_row_groups):
            starts.append(row_start)
            row_start += parquet_file.metadata.row_group(ordinal).num_rows
        if (
            row_start != descriptor["row_count"]
            or len(starts) != descriptor["row_group_count"]
        ):
            raise ValueError("prototype index file coordinates do not match footer")
        row_group_starts[file_key] = starts

    for timeseries in index["timeseries"]:
        timeseries_id = int(timeseries["timeseries_id"])
        previous_max = None
        timeseries_rows = 0
        for segment in timeseries["segments"]:
            file_key = segment["file_key"]
            ordinal = int(segment["row_group_ordinal"])
            group_key = (file_key, ordinal)
            if group_key in referenced_groups:
                raise ValueError("prototype row group is referenced by more than one segment")
            referenced_groups.add(group_key)
            parquet_file = parquet_files[file_key]
            row_group = parquet_file.metadata.row_group(ordinal)
            if (
                segment["row_group_row_start"] != 0
                or segment["row_start"] != row_group_starts[file_key][ordinal]
                or segment["row_count"] != row_group.num_rows
            ):
                raise ValueError("prototype index segment coordinates do not match footer")
            decoded = canonical_rows(parquet_file.read_row_group(ordinal).to_pylist())
            if (
                len(decoded) != segment["row_count"]
                or {row["timeseries_id"] for row in decoded} != {timeseries_id}
                or decoded[0]["observed_at_utc"] != segment["min_observed_at_utc"]
                or decoded[-1]["observed_at_utc"] != segment["max_observed_at_utc"]
            ):
                raise ValueError("prototype index selected the wrong row-group content")
            if previous_max is not None and decoded[0]["observed_at_utc"] < previous_max:
                raise ValueError("prototype index segments regress chronologically")
            previous_max = decoded[-1]["observed_at_utc"]
            timeseries_rows += len(decoded)
            decoded_rows.extend(decoded)
        if timeseries_rows != timeseries["row_count"]:
            raise ValueError("prototype index timeseries rows do not reconcile")

    expected_groups = sum(item["row_group_count"] for item in files.values())
    if len(referenced_groups) != expected_groups:
        raise ValueError("prototype index omits one or more physical row groups")
    if [encode_row(row) for row in decoded_rows] != [
        encode_row(row) for row in source_rows
    ]:
        raise ValueError("prototype index traversal changed canonical logical rows")


def select_request(
    rows: list[dict[str, Any]],
    segments: list[dict[str, Any]],
    timeseries_id: int,
    start: datetime,
    end: datetime,
) -> dict[str, Any]:
    requested = [
        row
        for row in rows
        if row["timeseries_id"] == timeseries_id
        and start <= timestamp_value(row["observed_at_utc"]) < end
    ]
    selected = [
        segment
        for segment in segments
        if segment["timeseries_id"] == timeseries_id
        and timestamp_value(segment["max_observed_at_utc"]) >= start
        and timestamp_value(segment["min_observed_at_utc"]) < end
    ]
    return {
        "start_utc": timestamp_iso(start),
        "end_utc": timestamp_iso(end),
        "logical_rows": len(requested),
        "selected_row_groups": len(selected),
        "physical_rows_decoded": sum(segment["row_count"] for segment in selected),
        "selection": [
            {
                key: segment[key]
                for key in (
                    "file_key",
                    "row_group_ordinal",
                    "row_count",
                    "min_observed_at_utc",
                    "max_observed_at_utc",
                )
            }
            for segment in selected
        ],
    }


def run_configuration(
    source: dict[str, Any],
    output_root: Path,
    cap: int,
    max_row_groups: int,
) -> dict[str, Any]:
    config_root = (
        output_root
        / source["role"]
        / f"cap={cap}"
        / f"max_row_groups_per_file={max_row_groups}"
    )
    config_root.mkdir(parents=True, exist_ok=True)
    intended_segments = build_segments(source["rows"], cap)
    file_plans = pack_files(intended_segments, max_row_groups)
    file_descriptors = []
    exact_segments = []
    output_rows = []
    total_footer_bytes = 0
    shared_files = 0

    for file_ordinal, file_segments in enumerate(file_plans):
        file_name = f"part-{file_ordinal:05d}.parquet"
        path = config_root / file_name
        with pq.ParquetWriter(
            path,
            PARQUET_SCHEMA,
            compression="zstd",
            use_dictionary=True,
            write_statistics=True,
            write_page_index=True,
            data_page_version="1.0",
        ) as writer:
            for segment in file_segments:
                writer.write_table(
                    table_from_rows(segment["rows"]),
                    row_group_size=segment["row_count"],
                )
        byte_size = path.stat().st_size
        if byte_size > MAX_FILE_BYTES:
            raise ValueError(f"prototype Parquet exceeds max_file_bytes: {path}")
        parquet_file = pq.ParquetFile(path)
        if parquet_file.metadata.num_row_groups != len(file_segments):
            raise ValueError("Parquet writer did not preserve explicit row-group calls")
        schema_metadata = parquet_file.schema_arrow.metadata or {}
        if (
            schema_metadata.get(b"uk_aq_physical_layout_version")
            != PHYSICAL_LAYOUT_VERSION.encode()
        ):
            raise ValueError("prototype Parquet layout identity is missing")
        file_row_start = 0
        file_timeseries = set()
        for row_group_ordinal, intended in enumerate(file_segments):
            decoded = validate_row_group(parquet_file, row_group_ordinal, intended)
            output_rows.extend(decoded)
            file_timeseries.add(intended["timeseries_id"])
            exact_segments.append(
                {
                    "timeseries_id": intended["timeseries_id"],
                    "chronological_segment_ordinal": intended[
                        "chronological_segment_ordinal"
                    ],
                    "file_key": file_name,
                    "row_group_ordinal": row_group_ordinal,
                    "row_start": file_row_start,
                    "row_group_row_start": 0,
                    "row_count": intended["row_count"],
                    "min_observed_at_utc": intended["min_observed_at_utc"],
                    "max_observed_at_utc": intended["max_observed_at_utc"],
                }
            )
            file_row_start += intended["row_count"]
        if len(file_timeseries) > 1:
            shared_files += 1
        current_footer_bytes = footer_bytes(path)
        total_footer_bytes += current_footer_bytes
        file_descriptors.append(
            {
                "key": file_name,
                "byte_size": byte_size,
                "sha256": sha256_file(path),
                "row_count": file_row_start,
                "row_group_count": len(file_segments),
                "footer_bytes": current_footer_bytes,
                "history_schema_version": HISTORY_SCHEMA_VERSION,
                "writer_version": PROTOTYPE_WRITER_VERSION,
                "physical_layout_version": PHYSICAL_LAYOUT_VERSION,
            }
        )

    if [encode_row(row) for row in output_rows] != [
        encode_row(row) for row in source["rows"]
    ]:
        raise ValueError("prototype physical order or logical rows disagree with source")
    output_logical = observation_content_hash(output_rows)
    output_timeseries_counts = timeseries_counts(output_rows)
    if output_logical != source["logical"]:
        raise ValueError("prototype observation-content hash metadata changed")
    if output_timeseries_counts != source["timeseries_counts"]:
        raise ValueError("prototype timeseries counts changed")
    if len(exact_segments) != sum(item["row_group_count"] for item in file_descriptors):
        raise ValueError("one-segment-per-row-group invariant failed")

    index = build_index(
        source,
        cap,
        max_row_groups,
        file_descriptors,
        exact_segments,
    )
    index_path = config_root / "index.json"
    index_body = canonical_json_bytes(index)
    index_path.write_bytes(index_body)
    validate_index_mapping(index_path, source["rows"])

    requests = {}
    day_start = datetime.fromisoformat(source["scope"]["day_utc"]).replace(
        tzinfo=timezone.utc
    )
    if source["role"] == "sensorcommunity_normal":
        requests["24h"] = select_request(
            source["rows"],
            exact_segments,
            TARGET_TIMESERIES_ID,
            day_start,
            day_start + timedelta(hours=24),
        )
    elif source["role"] == "sensorcommunity_dense":
        for hours in (1, 6, 12, 24):
            requests[f"{hours}h"] = select_request(
                source["rows"],
                exact_segments,
                TARGET_TIMESERIES_ID,
                day_start,
                day_start + timedelta(hours=hours),
            )

    target_segments = [
        segment
        for segment in exact_segments
        if segment["timeseries_id"] == TARGET_TIMESERIES_ID
    ]
    return {
        "cap_rows": cap,
        "max_row_groups_per_file": max_row_groups,
        "row_group_count": len(exact_segments),
        "file_count": len(file_descriptors),
        "shared_file_count": shared_files,
        "parquet_bytes": sum(item["byte_size"] for item in file_descriptors),
        "largest_file_bytes": max(item["byte_size"] for item in file_descriptors),
        "footer_bytes": total_footer_bytes,
        "largest_footer_bytes": max(item["footer_bytes"] for item in file_descriptors),
        "index_bytes": len(index_body),
        "target_file_bytes_exceeded": any(
            item["byte_size"] > TARGET_FILE_BYTES for item in file_descriptors
        ),
        "logical_equality": {
            "row_count_equal": len(output_rows) == len(source["rows"]),
            "canonical_order_equal": True,
            "values_and_status_equal": True,
            "observation_content_hash_equal": True,
            "timeseries_counts_equal": True,
            "index_to_row_group_mapping_equal": True,
            "observation_content_hash": output_logical[
                "observation_content_hash"
            ],
            "verification_status_counts": output_logical[
                "verification_status_counts"
            ],
        },
        "target_timeseries_segments": [
            {
                key: segment[key]
                for key in (
                    "chronological_segment_ordinal",
                    "file_key",
                    "row_group_ordinal",
                    "row_count",
                    "min_observed_at_utc",
                    "max_observed_at_utc",
                )
            }
            for segment in target_segments
        ],
        "requests": requests,
        "artefact_root": str(config_root),
    }


def parse_int_list(value: str) -> list[int]:
    values = [int(item.strip()) for item in value.split(",") if item.strip()]
    if not values or any(item <= 0 for item in values):
        raise argparse.ArgumentTypeError("expected comma-separated positive integers")
    return values


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    for role in ROLE_NAMES:
        parser.add_argument(f"--{role.replace('_', '-')}-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--caps", type=parse_int_list, default=[1024, 2048, 4096])
    parser.add_argument(
        "--row-groups-per-file",
        type=parse_int_list,
        default=[32, 64, 128],
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    sources = {
        role: load_partition(role, getattr(args, f"{role}_root"))
        for role in ROLE_NAMES
    }
    report = {
        "schema_version": 1,
        "environment": "TEST",
        "method": "bounded_local_read_only_source_timeseries_aligned_v2_prototype",
        "physical_layout_version": PHYSICAL_LAYOUT_VERSION,
        "prototype_writer_version": PROTOTYPE_WRITER_VERSION,
        "row_group_invariant": (
            "one row group contains one and only one chronological segment "
            "from one timeseries"
        ),
        "file_bounds": {
            "target_file_rows": TARGET_FILE_ROWS,
            "max_file_rows": MAX_FILE_ROWS,
            "target_file_bytes": TARGET_FILE_BYTES,
            "max_file_bytes": MAX_FILE_BYTES,
        },
        "caps": args.caps,
        "row_groups_per_file_bounds": args.row_groups_per_file,
        "sources": {},
        "results": {},
    }
    for role, source in sources.items():
        report["sources"][role] = {
            "scope": source["scope"],
            "row_count": len(source["rows"]),
            "timeseries_count": len(source["timeseries_counts"]),
            "observation_content_hash": source["logical"][
                "observation_content_hash"
            ],
            "verification_status_counts": source["logical"][
                "verification_status_counts"
            ],
            "source_file_count": len(source["source_files"]),
            "source_files": source["source_files"],
            "target_timeseries_rows": int(
                source["timeseries_counts"].get(str(TARGET_TIMESERIES_ID), 0)
            ),
        }
        report["results"][role] = {}
        for cap in args.caps:
            cap_key = f"cap_{cap}"
            report["results"][role][cap_key] = {}
            for max_row_groups in args.row_groups_per_file:
                bound_key = f"max_row_groups_{max_row_groups}"
                report["results"][role][cap_key][bound_key] = run_configuration(
                    source,
                    args.output_root,
                    cap,
                    max_row_groups,
                )
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_bytes(canonical_json_bytes(report))
    print(
        json.dumps(
            {
                "report": str(args.report),
                "physical_layout_version": PHYSICAL_LAYOUT_VERSION,
                "configurations": len(ROLE_NAMES)
                * len(args.caps)
                * len(args.row_groups_per_file),
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
