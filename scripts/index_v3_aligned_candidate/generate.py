#!/usr/bin/env python3
"""Generate bounded TEST-only timeseries-aligned-v2 candidate objects locally."""

from __future__ import annotations

import argparse
import hashlib
import heapq
import json
import math
import re
import shutil
import struct
import tempfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

import pyarrow as pa
import pyarrow.parquet as pq


LAYOUT = "timeseries-aligned-v2"
WRITER = "pyarrow-zstd-timeseries-aligned-candidate-v1"
PARQUET_CREATED_BY = "parquet-cpp-arrow version 25.0.1"
HISTORY_SCHEMA = 3
ALLOWED_CAPS = (1024, 2048, 4096)
MAX_ROW_GROUPS = 128
TARGET_FILE_ROWS = 65_536
MAX_FILE_ROWS = 131_072
TARGET_FILE_BYTES = 4 * 1024 * 1024
MAX_FILE_BYTES = 8 * 1024 * 1024
SHARD_WIDTH = 1000
DEFAULT_PREFIX = "history/_prototype/observation-history/timeseries-aligned-v2"
CONTENT_HASH_PREFIX = b"uk-aq-observation-content-hash:v1\n"
ROLES = {
    "aurn": "aurn_2026-08-20_pm25",
    "sensorcommunity_normal": "sensorcommunity_normal_2026-08-20_pm25",
    "sensorcommunity_dense": "sensorcommunity_dense_2026-04-03_pm25",
}
COLS = [
    "connector_id", "station_id", "timeseries_id", "pollutant_code",
    "observed_at_utc", "value", "verification_status",
]
SCHEMA = pa.schema(
    [
        pa.field("connector_id", pa.int32()), pa.field("station_id", pa.int32()),
        pa.field("timeseries_id", pa.int32()), pa.field("pollutant_code", pa.string()),
        pa.field("observed_at_utc", pa.timestamp("ms")), pa.field("value", pa.float64()),
        pa.field("verification_status", pa.string()),
    ],
    metadata={
        b"uk_aq_history_schema_version": b"3",
        b"uk_aq_writer_version": WRITER.encode(),
        b"uk_aq_physical_layout_version": LAYOUT.encode(),
    },
)


def canonical_bytes(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=False) + "\n").encode()


def sha_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def iso(value: Any) -> str:
    if isinstance(value, str):
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    else:
        parsed = value
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    parsed = parsed.astimezone(timezone.utc)
    if parsed.microsecond % 1000:
        raise ValueError("timestamp is not millisecond aligned")
    return parsed.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def normalize(raw: dict[str, Any]) -> dict[str, Any]:
    status = raw.get("verification_status")
    if status not in (None, "P", "R"):
        raise ValueError(f"unsupported verification_status: {status!r}")
    value = float(raw["value"])
    if not math.isfinite(value):
        raise ValueError("non-finite observation value")
    return {
        "connector_id": int(raw["connector_id"]),
        "station_id": None if raw.get("station_id") is None else int(raw["station_id"]),
        "timeseries_id": int(raw["timeseries_id"]),
        "pollutant_code": str(raw["pollutant_code"]),
        "observed_at_utc": iso(raw["observed_at_utc"]),
        "value": 0.0 if value == 0 else value,
        "verification_status": status,
    }


def encoded(row: dict[str, Any]) -> str:
    return json.dumps([
        row["connector_id"], row["station_id"], row["timeseries_id"],
        row["pollutant_code"], row["observed_at_utc"],
        struct.pack(">d", row["value"]).hex(), row["verification_status"],
    ], separators=(",", ":"), ensure_ascii=False)


def table(rows: list[dict[str, Any]]) -> pa.Table:
    return pa.Table.from_pylist([
        {**row, "observed_at_utc": datetime.fromisoformat(
            row["observed_at_utc"].replace("Z", "+00:00")
        ).replace(tzinfo=None)} for row in rows
    ], schema=SCHEMA)


def safe_prefix(raw: str) -> str:
    prefix = raw.strip().strip("/")
    if not re.fullmatch(
        r"history/_prototype/observation-history/timeseries-aligned-v2"
        r"(?:/candidate=[a-z0-9][a-z0-9-]{0,31})?",
        prefix,
    ):
        raise ValueError("destination must use the isolated aligned-v2 prototype scheme")
    forbidden = ("history/v2", "history/_index_v3", "_latest", "backup", "checkpoint", "live")
    if any(token in prefix.lower() for token in forbidden):
        raise ValueError(f"unsafe candidate destination prefix: {prefix}")
    return prefix


def source_manifest_key(manifest: dict[str, Any]) -> str:
    return (
        f"history/v2/observations/day_utc={manifest['day_utc']}"
        f"/connector_id={int(manifest['connector_id'])}"
        f"/pollutant_code={manifest['pollutant_code']}/manifest.json"
    )


def iter_source_rows(root: Path, manifest: dict[str, Any]) -> Iterator[dict[str, Any]]:
    previous: tuple[Any, ...] | None = None
    for descriptor in manifest["files"]:
        path = root / Path(descriptor["key"]).name
        if sha_file(path) != descriptor["etag_or_hash"]:
            raise ValueError(f"source SHA-256 mismatch: {path}")
        parquet = pq.ParquetFile(path)
        for batch in parquet.iter_batches(batch_size=8192, columns=COLS):
            for raw in batch.to_pylist():
                row = normalize(raw)
                order = (row["timeseries_id"], row["observed_at_utc"], encoded(row))
                if previous is not None and order < previous:
                    raise ValueError(f"canonical source rows are not deterministic: {path}")
                previous = order
                yield row


class LogicalVerifier:
    """Bounded logical hash verifier using sorted spill runs on local disk."""

    def __init__(self, root: Path, label: str, chunk_rows: int = 16384):
        self.root = root / label
        self.root.mkdir()
        self.chunk_rows = chunk_rows
        self.chunk: list[str] = []
        self.runs: list[Path] = []
        self.rows = 0
        self.status = Counter()
        self.timeseries = Counter()

    def add(self, row: dict[str, Any]) -> None:
        self.chunk.append(encoded(row))
        self.rows += 1
        self.status["null" if row["verification_status"] is None else row["verification_status"]] += 1
        self.timeseries[row["timeseries_id"]] += 1
        if len(self.chunk) >= self.chunk_rows:
            self.flush()

    def flush(self) -> None:
        if not self.chunk:
            return
        path = self.root / f"run-{len(self.runs):05d}.txt"
        path.write_text("\n".join(sorted(self.chunk)) + "\n")
        self.runs.append(path)
        self.chunk.clear()

    def result(self) -> dict[str, Any]:
        self.flush()
        handles = [path.open() for path in self.runs]
        digest = hashlib.sha256(CONTENT_HASH_PREFIX)
        try:
            for line in heapq.merge(*handles):
                digest.update(line.encode())
        finally:
            for handle in handles:
                handle.close()
        return {
            "row_count": self.rows,
            "observation_content_hash": digest.hexdigest(),
            "verification_status_counts": {k: self.status[k] for k in ("P", "R", "null")},
            "timeseries_row_counts": {str(k): self.timeseries[k] for k in sorted(self.timeseries)},
        }


def write_parquet(path: Path, segment_paths: list[Path]) -> None:
    with pq.ParquetWriter(
        path, SCHEMA, compression="zstd", use_dictionary=True,
        write_statistics=True, write_page_index=True, data_page_version="1.0",
    ) as writer:
        for segment_path in segment_paths:
            segment_table = pq.read_table(segment_path)
            writer.write_table(segment_table, row_group_size=segment_table.num_rows)


def spool_segment(rows: list[dict[str, Any]], spool: Path, sequence: list[int]) -> list[dict[str, Any]]:
    path = spool / f"segment-{sequence[0]:07d}.parquet"
    sequence[0] += 1
    pq.write_table(
        table(rows), path, compression="zstd", use_dictionary=True,
        write_statistics=True, write_page_index=True, row_group_size=len(rows),
    )
    if path.stat().st_size > TARGET_FILE_BYTES:
        path.unlink()
        if len(rows) <= 1:
            raise ValueError("single aligned observation exceeds the 4 MiB physical target")
        midpoint = len(rows) // 2
        return [
            *spool_segment(rows[:midpoint], spool, sequence),
            *spool_segment(rows[midpoint:], spool, sequence),
        ]
    return [{
        "path": path,
        "timeseries_id": rows[0]["timeseries_id"],
        "row_count": len(rows),
        "min_observed_at_utc": rows[0]["observed_at_utc"],
        "max_observed_at_utc": rows[-1]["observed_at_utc"],
    }]


def create_segments(source_root: Path, manifest: dict[str, Any], cap: int, spool: Path):
    verifier = LogicalVerifier(spool, "source-hash")
    segments: list[dict[str, Any]] = []
    buffer: list[dict[str, Any]] = []
    sequence = [0]
    current_id = None
    scope = (int(manifest["connector_id"]), manifest["pollutant_code"], manifest["day_utc"])
    for row in iter_source_rows(source_root, manifest):
        if (row["connector_id"], row["pollutant_code"], row["observed_at_utc"][:10]) != scope:
            raise ValueError("source row escapes manifest partition scope")
        verifier.add(row)
        if current_id is not None and (row["timeseries_id"] != current_id or len(buffer) >= cap):
            segments.extend(spool_segment(buffer, spool, sequence))
            buffer = []
        current_id = row["timeseries_id"]
        buffer.append(row)
    if buffer:
        segments.extend(spool_segment(buffer, spool, sequence))
    return segments, verifier.result()


def split_index(segments: list[dict[str, Any]]) -> int:
    midpoint = sum(item["row_count"] for item in segments) / 2
    choices = []
    rows = 0
    for index, item in enumerate(segments[:-1], 1):
        rows += item["row_count"]
        choices.append((item["timeseries_id"] == segments[index]["timeseries_id"], abs(rows - midpoint), index))
    if not choices:
        raise ValueError("single row group unexpectedly exceeds physical byte target")
    return min(choices)[2]


def materialize_plan(segments: list[dict[str, Any]], trial: Path) -> list[list[dict[str, Any]]]:
    write_parquet(trial, [item["path"] for item in segments])
    size = trial.stat().st_size
    trial.unlink()
    if size <= TARGET_FILE_BYTES:
        return [segments]
    at = split_index(segments)
    return [*materialize_plan(segments[:at], trial), *materialize_plan(segments[at:], trial)]


def file_plans(segments: list[dict[str, Any]], spool: Path) -> list[list[dict[str, Any]]]:
    initial, current, rows = [], [], 0
    for item in segments:
        if current and (len(current) >= MAX_ROW_GROUPS or rows + item["row_count"] > TARGET_FILE_ROWS):
            initial.append(current); current = []; rows = 0
        current.append(item); rows += item["row_count"]
        if rows > MAX_FILE_ROWS:
            raise ValueError("candidate file plan exceeds maximum file rows")
    if current:
        initial.append(current)
    trial = spool / "candidate-trial.parquet"
    return [final for plan in initial for final in materialize_plan(plan, trial)]


def child_payload(scope, range_start, files, timeseries):
    ids = sorted(timeseries)
    selected = []
    for tsid in ids:
        segs = timeseries[tsid]
        selected.append({
            "timeseries_id": tsid, "row_count": sum(x["row_count"] for x in segs),
            "min_observed_at_utc": min(x["min_observed_at_utc"] for x in segs),
            "max_observed_at_utc": max(x["max_observed_at_utc"] for x in segs),
            "segments": segs,
        })
    referenced = {seg["file_key"] for entry in selected for seg in entry["segments"]}
    child_files = sorted((item for item in files if item["key"] in referenced), key=lambda x: x["key"])
    coverage = {
        "timeseries_count": len(ids), "timeseries_ids": ids,
        "row_count": sum(x["row_count"] for x in selected),
        "min_observed_at_utc": min(x["min_observed_at_utc"] for x in selected),
        "max_observed_at_utc": max(x["max_observed_at_utc"] for x in selected),
        "file_count": len(child_files),
    }
    return {
        "schema_version": 3, "kind": "observation_timeseries_exact_shard",
        "index_generation": "v3", "history_version": "v2", "domain": "observations",
        "history_schema_version": HISTORY_SCHEMA, "writer_version": WRITER,
        "physical_layout_version": LAYOUT, "shard_width": SHARD_WIDTH,
        "range_start": range_start, "range_end": range_start + SHARD_WIDTH - 1,
        **scope, "row_start_scope": "file", "coverage": coverage,
        "files": child_files, "timeseries": selected,
    }


def generate_partition(source_root: Path, objects_root: Path, cap_root: str, cap: int, role: str, spool: Path):
    manifest_path = source_root / "manifest.json"
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    scope = {"day_utc": manifest["day_utc"], "connector_id": int(manifest["connector_id"]), "pollutant_code": manifest["pollutant_code"]}
    segments, source_logical = create_segments(source_root, manifest, cap, spool)
    expected_counts = {str(k): int(v) for k, v in manifest["timeseries_row_counts"].items()}
    if source_logical["row_count"] != int(manifest["row_count"]) or source_logical["observation_content_hash"] != manifest["observation_content_hash"] or source_logical["timeseries_row_counts"] != dict(sorted(expected_counts.items(), key=lambda x: int(x[0]))):
        raise ValueError(f"source logical identity disagrees with canonical manifest: {role}")
    if source_logical["verification_status_counts"] != manifest["verification_status_counts"]:
        raise ValueError(f"source status counts disagree with canonical manifest: {role}")

    data_prefix = f"{cap_root}/observations/day_utc={scope['day_utc']}/connector_id={scope['connector_id']}/pollutant_code={scope['pollutant_code']}"
    index_prefix = f"{cap_root}/observations_timeseries/day_utc={scope['day_utc']}/connector_id={scope['connector_id']}/pollutant_code={scope['pollutant_code']}"
    plans = file_plans(segments, spool)
    files, exact = [], []
    output_verifier = LogicalVerifier(spool, "output-hash")
    previous_output_order: tuple[Any, ...] | None = None
    for ordinal, plan in enumerate(plans):
        key = f"{data_prefix}/part-{ordinal:05d}.parquet"
        local = objects_root / key
        local.parent.mkdir(parents=True, exist_ok=True)
        write_parquet(local, [item["path"] for item in plan])
        parquet = pq.ParquetFile(local)
        if local.stat().st_size > TARGET_FILE_BYTES or local.stat().st_size > MAX_FILE_BYTES or parquet.metadata.num_row_groups != len(plan) or parquet.metadata.created_by != PARQUET_CREATED_BY:
            raise ValueError("serialized candidate violates file bounds")
        row_start = 0
        for rg, intended in enumerate(plan):
            decoded = [normalize(row) for row in parquet.read_row_group(rg, columns=COLS).to_pylist()]
            intended_rows = [
                normalize(row)
                for row in pq.read_table(intended["path"], columns=COLS).to_pylist()
            ]
            if len(decoded) != intended["row_count"] or {x["timeseries_id"] for x in decoded} != {intended["timeseries_id"]} or len(decoded) > cap:
                raise ValueError("one-timeseries-per-row-group invariant failed")
            if [encoded(row) for row in decoded] != [encoded(row) for row in intended_rows]:
                raise ValueError("serialized aligned row group changed logical rows or ordering")
            if decoded[0]["observed_at_utc"] != intended["min_observed_at_utc"] or decoded[-1]["observed_at_utc"] != intended["max_observed_at_utc"]:
                raise ValueError("aligned row-group chronological bounds changed")
            for row in decoded:
                output_order = (row["timeseries_id"], row["observed_at_utc"], encoded(row))
                if previous_output_order is not None and output_order < previous_output_order:
                    raise ValueError("candidate physical rows regress from canonical ordering")
                previous_output_order = output_order
                output_verifier.add(row)
            exact.append({
                "timeseries_id": intended["timeseries_id"], "file_key": key,
                "row_group_ordinal": rg, "row_start": row_start,
                "row_group_row_start": 0, "row_count": len(decoded),
                "min_observed_at_utc": intended["min_observed_at_utc"],
                "max_observed_at_utc": intended["max_observed_at_utc"],
            })
            row_start += len(decoded)
        files.append({
            "key": key, "byte_size": local.stat().st_size, "sha256": sha_file(local),
            "row_count": row_start, "row_group_count": len(plan),
            "history_schema_version": HISTORY_SCHEMA, "writer_version": WRITER,
            "physical_layout_version": LAYOUT,
        })
    output_logical = output_verifier.result()
    if output_logical != source_logical:
        raise ValueError(f"output logical identity changed during repack: {role}")

    by_range: dict[int, dict[int, list[dict[str, Any]]]] = defaultdict(lambda: defaultdict(list))
    for item in exact:
        tsid = item.pop("timeseries_id")
        by_range[(tsid // SHARD_WIDTH) * SHARD_WIDTH][tsid].append(item)
    children = []
    objects = []
    for range_start in sorted(by_range):
        payload = child_payload(scope, range_start, files, by_range[range_start])
        body = canonical_bytes(payload)
        token = f"{range_start:06d}-{range_start + SHARD_WIDTH - 1:06d}"
        key = f"{index_prefix}/range={token}.json"
        local = objects_root / key; local.parent.mkdir(parents=True, exist_ok=True); local.write_bytes(body)
        coverage = payload["coverage"]
        descriptor = {
            "key": key, "byte_size": len(body), "sha256": sha_bytes(body),
            "range_start": range_start, "range_end": range_start + SHARD_WIDTH - 1,
            **coverage,
            "files": [{"key": x["key"], "byte_size": x["byte_size"], "sha256": x["sha256"]} for x in payload["files"]],
        }
        children.append(descriptor); objects.append(local)
    source_descriptor = {
        "key": source_manifest_key(manifest), "byte_size": len(manifest_bytes),
        "sha256": sha_bytes(manifest_bytes), "manifest_hash": manifest["manifest_hash"],
        "row_count": int(manifest["row_count"]),
        "observation_content_hash": manifest["observation_content_hash"],
    }
    all_ids = sorted(int(k) for k in expected_counts)
    scoped = {
        "schema_version": 3, "kind": "observation_timeseries_scoped_manifest",
        "index_generation": "v3", "history_version": "v2", "domain": "observations",
        "history_schema_version": HISTORY_SCHEMA, "writer_version": WRITER,
        "physical_layout_version": LAYOUT, "shard_width": SHARD_WIDTH, **scope,
        "canonical_source_manifest": source_descriptor,
        "coverage": {
            "timeseries_count": len(all_ids), "timeseries_ids": all_ids,
            "row_count": source_logical["row_count"],
            "min_observed_at_utc": min(x["min_observed_at_utc"] for x in children),
            "max_observed_at_utc": max(x["max_observed_at_utc"] for x in children),
            "child_shard_count": len(children), "physical_file_count": len(files),
        },
        "children": children,
    }
    scoped_path = objects_root / index_prefix / "manifest.json"
    scoped_path.write_bytes(canonical_bytes(scoped)); objects.append(scoped_path)
    return {
        "role": role, "scope": scope, "cap_rows": cap, "row_count": source_logical["row_count"],
        "timeseries_count": len(all_ids), "file_count": len(files),
        "row_group_count": len(exact), "source_logical": source_logical,
        "objects": [*[(objects_root / item["key"]) for item in files], *objects],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--environment", required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    parser.add_argument("--prototype-prefix", default=DEFAULT_PREFIX)
    parser.add_argument("--caps", nargs="+", type=int, default=list(ALLOWED_CAPS))
    parser.add_argument("--replace", action="store_true")
    args = parser.parse_args()
    if args.environment.strip().upper() != "TEST":
        raise SystemExit("refusing non-TEST generation")
    prefix = safe_prefix(args.prototype_prefix)
    caps = sorted(set(args.caps))
    if not caps or any(cap not in ALLOWED_CAPS for cap in caps):
        raise SystemExit(f"caps must be selected from {ALLOWED_CAPS}")
    output = args.output_root.resolve()
    if output.exists():
        if not args.replace:
            raise SystemExit(f"output exists; pass --replace for this exact local target: {output}")
        if output == Path("/") or len(output.parts) < 4:
            raise SystemExit("refusing broad output replacement")
        shutil.rmtree(output)
    objects_root = output / "objects"; objects_root.mkdir(parents=True)
    reports = []
    with tempfile.TemporaryDirectory(prefix="uk-aq-aligned-v2-") as temp:
        temp_root = Path(temp)
        for cap in caps:
            cap_root = f"{prefix}/cap_rows={cap}"
            for role, dirname in ROLES.items():
                spool = temp_root / f"cap-{cap}-{role}"; spool.mkdir()
                reports.append(generate_partition(args.source_root / dirname, objects_root, cap_root, cap, role, spool))
    planned = []
    for path in sorted(objects_root.rglob("*")):
        if path.is_file():
            planned.append({
                "key": path.relative_to(objects_root).as_posix(),
                "local_path": path.relative_to(output).as_posix(),
                "byte_size": path.stat().st_size, "sha256": sha_file(path),
                "content_type": "application/json; charset=utf-8" if path.suffix == ".json" else "application/vnd.apache.parquet",
            })
    report = {
        "schema_version": 1, "environment": "TEST", "prototype_prefix": prefix,
        "physical_layout_version": LAYOUT, "writer_version": WRITER,
        "parquet_created_by": PARQUET_CREATED_BY,
        "caps": caps, "max_row_groups_per_file": MAX_ROW_GROUPS,
        "target_file_rows": TARGET_FILE_ROWS, "max_file_rows": MAX_FILE_ROWS,
        "target_file_bytes": TARGET_FILE_BYTES, "max_file_bytes": MAX_FILE_BYTES,
        "peak_materialisation": "one 8192-row source batch, one cap-bounded timeseries segment, and one 16384-row encoded hash chunk; candidate Parquet is written one segment at a time to local disk; logical hash uses sorted spill runs",
        "partitions": [{k: v for k, v in item.items() if k != "objects"} for item in reports],
        "object_count": len(planned),
    }
    (output / "report.json").write_bytes(canonical_bytes(report))
    (output / "publication-plan.json").write_bytes(canonical_bytes({
        "schema_version": 1, "environment": "TEST", "prototype_prefix": prefix,
        "objects": planned,
    }))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
