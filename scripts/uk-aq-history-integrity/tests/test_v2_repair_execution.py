#!/usr/bin/env python3
from __future__ import annotations

import gzip
import hashlib
import importlib.util
import io
import json
import logging
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

MODULE_PATH = Path(__file__).resolve().parents[1] / "bin" / "uk-aq-history-integrity.py"
SPEC = importlib.util.spec_from_file_location("uk_aq_history_integrity_v2_repair", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module at {MODULE_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class DummyProgress:
    def __init__(self, *_args, **_kwargs) -> None:
        pass

    def update(self, *_args, **_kwargs) -> None:
        pass

    def finish(self) -> None:
        pass


class V2RepairExecutionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.conn = sqlite3.connect(":memory:")
        self.conn.execute("CREATE TABLE core_timeseries_snapshot (id INTEGER PRIMARY KEY, connector_id INTEGER NOT NULL, ended_at TEXT)")
        self.conn.executemany(
            "INSERT INTO core_timeseries_snapshot (id, connector_id, ended_at) VALUES (?, ?, ?)",
            [(101, 6, None), (102, 6, ""), (201, 7, None), (999, 6, "2026-01-01")],
        )
        self.conn.execute("""
            CREATE TABLE aqi_rebuild_queue (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              run_id INTEGER NOT NULL,
              env_name TEXT NOT NULL,
              history_version TEXT,
              domain TEXT,
              profile TEXT,
              pollutant_code TEXT,
              source_observations_version TEXT,
              connector_id INTEGER NOT NULL,
              day_utc TEXT NOT NULL,
              reason TEXT NOT NULL,
              source_mode TEXT NOT NULL,
              status TEXT NOT NULL,
              requested_timeseries_ids TEXT,
              notes TEXT,
              created_at_utc TEXT NOT NULL,
              started_at_utc TEXT,
              finished_at_utc TEXT,
              UNIQUE(run_id, connector_id, day_utc)
            )
        """)
        self.env = {
            "UK_AQ_ENV_NAME": "CIC-Test",
            "UK_AQ_HISTORY_INTEGRITY_DB_PATH": str(self.root / "integrity.sqlite"),
            "UK_AQ_HISTORY_INTEGRITY_LOG_DIR": str(self.root / "logs"),
            "UK_AQ_HISTORY_INTEGRITY_TMP_DIR": str(self.root / "tmp"),
            "UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR": str(self.root / "source-cache"),
            "UK_AQ_BACKFILL_ENV_FILE": str(self.root / "backfill.env"),
            "UK_AQ_R2_HISTORY_DROPBOX_ROOT": str(self.root / "R2_history_backup"),
        }
        self.log = logging.getLogger("v2-repair-test")

    def tearDown(self) -> None:
        self.conn.close()
        self.tmp.cleanup()

    def _insert_aqi_queue_row(
        self,
        *,
        run_id: int,
        connector_id: int,
        day_utc: str = "2026-06-08",
        reason: str = "obs_repaired",
    ) -> int:
        cur = self.conn.execute(
            """
            INSERT INTO aqi_rebuild_queue (
              run_id, env_name, history_version, domain, profile, pollutant_code,
              source_observations_version, connector_id, day_utc, reason,
              source_mode, status, requested_timeseries_ids, notes, created_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                "CIC-Test",
                "v2",
                "aqilevels",
                "data",
                None,
                "v2",
                connector_id,
                day_utc,
                reason,
                "live_r2",
                "queued",
                None,
                None,
                "2026-06-20T00:00:00Z",
            ),
        )
        return int(cur.lastrowid)

    def _new_source_db(self, *, timeseries_ids: tuple[int, ...] = (101,), connector_id: int = 6) -> sqlite3.Connection:
        conn = MODULE.open_db(str(self.root / "source-state.sqlite"))
        for timeseries_id in timeseries_ids:
            conn.execute(
                """
                INSERT INTO core_timeseries_snapshot (id, station_id, connector_id, timeseries_ref, label, phenomenon_id, ended_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (timeseries_id, 1, connector_id, f"parameter-{timeseries_id}", "OpenAQ PM", 1, None),
            )
            conn.execute(
                """
                INSERT INTO source_station_timeseries_lookup (
                  source_key, source_location_id, station_ref, station_id,
                  connector_id, timeseries_id, is_active
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (MODULE.OPENAQ_SOURCE_KEY, "42", "42", 1, connector_id, timeseries_id, 1),
            )
        conn.commit()
        return conn

    def _insert_openaq_prior_state(
        self,
        conn: sqlite3.Connection,
        *,
        local_cached_path: str | None,
        last_status: str = "unchanged",
    ) -> None:
        day = MODULE.dt.date(2026, 6, 8)
        conn.execute(
            """
            INSERT INTO source_file_state (
              source_file_key, env_name, source_key, remote_scheme,
              remote_url_or_key, station_ref, source_location_id, day_utc,
              exists_remote, content_length, etag, last_modified_utc,
              sha256_downloaded, sha256_uncompressed, local_cached_path,
              first_seen_at_utc, last_checked_at_utc, last_changed_at_utc,
              last_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                MODULE._openaq_source_file_key("42", day),
                "CIC-Test",
                MODULE.OPENAQ_SOURCE_KEY,
                MODULE.OPENAQ_REMOTE_SCHEME,
                MODULE._openaq_url("https://example.test", "42", day),
                "42",
                "42",
                day.isoformat(),
                1,
                32,
                '"etag-1"',
                "2026-06-09T00:00:00Z",
                "old-compressed",
                "same-uncompressed",
                local_cached_path,
                "2026-06-10T00:00:00Z",
                "2026-06-10T00:00:00Z",
                None,
                last_status,
            ),
        )
        conn.commit()

    def _write_mock_gzip(self, _url: str, path: Path) -> int:
        payload = gzip.compress(b"datetime,parameter-1\n2026-06-08T00:00:00Z,12\n")
        path.write_bytes(payload)
        return len(payload)

    def _write_v2_observation_connector_manifest(
        self,
        *,
        day_utc: str = "2026-06-08",
        connector_id: int = 6,
        timeseries_row_counts: dict[int, int] | None = None,
        pollutant_codes: list[str] | None = None,
        declared_row_count: int | None = None,
    ) -> None:
        counts = timeseries_row_counts or {101: 1}
        pollutants = pollutant_codes or ["pm25"]
        row_count = int(declared_row_count) if declared_row_count is not None else sum(int(value) for value in counts.values())
        manifest_path = (
            Path(self.env["UK_AQ_R2_HISTORY_DROPBOX_ROOT"])
            / "history/v2/observations"
            / f"day_utc={day_utc}"
            / f"connector_id={connector_id}"
            / "manifest.json"
        )
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(
            json.dumps({
                "history_version": "v2",
                "domain": "observations",
                "manifest_kind": "connector",
                "day_utc": day_utc,
                "connector_id": connector_id,
                "pollutant_codes": pollutants,
                "row_count": row_count,
                "source_row_count": row_count,
                "timeseries_row_counts": {str(key): value for key, value in counts.items()},
                "files": [{
                    "key": (
                        f"history/v2/observations/day_utc={day_utc}/connector_id={connector_id}/"
                        f"pollutant_code={pollutants[0]}/part-00000.parquet"
                    ),
                    "row_count": row_count,
                    "pollutant_codes": pollutants,
                    "timeseries_row_counts": {str(key): value for key, value in counts.items()},
                }],
            }),
            encoding="utf-8",
        )

    def _write_v2_observation_partition(
        self,
        *,
        day_utc: str = "2026-06-18",
        connector_id: int = 1,
        pollutant_code: str = "pm25",
        timeseries_row_counts: dict[int, int] | None = None,
    ) -> None:
        counts = timeseries_row_counts or {218: 13}
        row_count = sum(int(value) for value in counts.values())
        root = Path(self.env["UK_AQ_R2_HISTORY_DROPBOX_ROOT"])
        key = (
            f"history/v2/observations/day_utc={day_utc}/connector_id={connector_id}/"
            f"pollutant_code={pollutant_code}/part-00000.parquet"
        )
        part = root / f"history/v2/observations/day_utc={day_utc}/connector_id={connector_id}/pollutant_code={pollutant_code}"
        part.mkdir(parents=True, exist_ok=True)
        (root / key).write_bytes(b"PAR1")
        part_bytes = (root / key).stat().st_size
        manifest_hash = f"obs-{day_utc}-connector-{connector_id}-{pollutant_code}-hash"
        payload = {
            "manifest_kind": "pollutant",
            "history_version": "v2",
            "domain": "observations",
            "grain": None,
            "profile": None,
            "day_utc": day_utc,
            "connector_id": connector_id,
            "pollutant_code": pollutant_code,
            "row_count": row_count,
            "source_row_count": row_count,
            "file_count": 1,
            "total_bytes": part_bytes,
            "min_timeseries_id": min(counts) if counts else None,
            "max_timeseries_id": max(counts) if counts else None,
            "min_observed_at_utc": None,
            "max_observed_at_utc": None,
            "manifest_hash": manifest_hash,
            "timeseries_row_counts": {str(key): value for key, value in counts.items()},
            "files": [{
                "key": key,
                "bytes": part_bytes,
                "row_count": row_count,
                "pollutant_code": pollutant_code,
                "timeseries_row_counts": {str(key): value for key, value in counts.items()},
            }],
        }
        (part / "manifest.json").write_text(json.dumps(payload), encoding="utf-8")
        idx = root / f"history/_index_v2/observations_timeseries/day_utc={day_utc}/connector_id={connector_id}/pollutant_code={pollutant_code}"
        idx.mkdir(parents=True, exist_ok=True)
        (idx / "manifest.json").write_text(
            json.dumps({"timeseries_row_counts": {str(key): value for key, value in counts.items()}}),
            encoding="utf-8",
        )
        latest = root / "history/_index_v2/observations_timeseries_latest.json"
        latest.parent.mkdir(parents=True, exist_ok=True)
        latest.write_text(json.dumps({"latest": day_utc}), encoding="utf-8")
        self._write_v2_observation_parent_manifests(day_utc, connector_id)

    def _write_v2_observation_parent_manifests(self, day_utc: str, connector_id: int) -> None:
        root = Path(self.env["UK_AQ_R2_HISTORY_DROPBOX_ROOT"])
        day_dir = root / f"history/v2/observations/day_utc={day_utc}"
        connector_dir = day_dir / f"connector_id={connector_id}"
        children = []
        for pollutant_dir in sorted(p for p in connector_dir.glob("pollutant_code=*") if p.is_dir()):
            payload = json.loads((pollutant_dir / "manifest.json").read_text(encoding="utf-8"))
            children.append(payload)
        files = [entry for child in children for entry in child.get("files", [])]
        manifest_hash = f"obs-{day_utc}-connector-{connector_id}-hash"
        connector = {
            "manifest_kind": "connector", "history_version": "v2", "domain": "observations",
            "grain": None, "profile": None, "day_utc": day_utc, "connector_id": connector_id,
            "pollutant_codes": [child["pollutant_code"] for child in children],
            "row_count": sum(child["row_count"] for child in children),
            "source_row_count": sum(child["source_row_count"] for child in children),
            "file_count": len(files), "total_bytes": sum(entry.get("bytes", 0) for entry in files),
            "min_timeseries_id": min((int(child["min_timeseries_id"]) for child in children if child.get("min_timeseries_id") is not None), default=None),
            "max_timeseries_id": max((int(child["max_timeseries_id"]) for child in children if child.get("max_timeseries_id") is not None), default=None),
            "min_observed_at_utc": None,
            "max_observed_at_utc": None,
            "manifest_hash": manifest_hash,
            "files": files,
            "child_manifests": [{"pollutant_code": child["pollutant_code"], "manifest_hash": child["manifest_hash"]} for child in children],
            "pollutant_manifests": [{"pollutant_code": child["pollutant_code"], "manifest_hash": child["manifest_hash"]} for child in children],
        }
        (connector_dir / "manifest.json").write_text(json.dumps(connector), encoding="utf-8")
        connectors = []
        for current_connector_dir in sorted(p for p in day_dir.glob("connector_id=*") if p.is_dir()):
            manifest_path = current_connector_dir / "manifest.json"
            if manifest_path.is_file():
                connectors.append(json.loads(manifest_path.read_text(encoding="utf-8")))
        day_files = [entry for child in connectors for entry in child.get("files", [])]
        day_manifest_hash = f"obs-{day_utc}-day-hash"
        day = {
            "manifest_kind": "day", "history_version": "v2", "domain": "observations",
            "grain": None, "profile": None, "day_utc": day_utc,
            "connector_ids": [child["connector_id"] for child in connectors],
            "row_count": sum(child["row_count"] for child in connectors),
            "source_row_count": sum(child["source_row_count"] for child in connectors),
            "file_count": len(day_files), "total_bytes": sum(entry.get("bytes", 0) for entry in day_files),
            "min_timeseries_id": min((int(child["min_timeseries_id"]) for child in connectors if child.get("min_timeseries_id") is not None), default=None),
            "max_timeseries_id": max((int(child["max_timeseries_id"]) for child in connectors if child.get("max_timeseries_id") is not None), default=None),
            "min_observed_at_utc": None,
            "max_observed_at_utc": None,
            "manifest_hash": day_manifest_hash,
            "files": day_files,
            "child_manifests": [{"connector_id": child["connector_id"], "manifest_hash": child["manifest_hash"]} for child in connectors],
            "connector_manifests": [{"connector_id": child["connector_id"], "manifest_hash": child["manifest_hash"]} for child in connectors],
        }
        (day_dir / "manifest.json").write_text(json.dumps(day), encoding="utf-8")

    def _write_v2_aqi_partition(
        self,
        *,
        day_utc: str = "2026-06-08",
        connector_id: int = 6,
        pollutant_code: str = "pm25",
        timeseries_row_counts: dict[int, int] | None = None,
    ) -> None:
        counts = timeseries_row_counts or {101: 1}
        row_count = sum(int(value) for value in counts.values())
        root = Path(self.env["UK_AQ_R2_HISTORY_DROPBOX_ROOT"])
        key = (
            f"history/v2/aqilevels/hourly/data/day_utc={day_utc}/connector_id={connector_id}/"
            f"pollutant_code={pollutant_code}/part-00000.parquet"
        )
        part = root / f"history/v2/aqilevels/hourly/data/day_utc={day_utc}/connector_id={connector_id}/pollutant_code={pollutant_code}"
        part.mkdir(parents=True, exist_ok=True)
        (root / key).write_bytes(b"PAR1")
        (part / "manifest.json").write_text(json.dumps({
            "history_version": "v2",
            "domain": "aqilevels",
            "grain": "hourly",
            "profile": "data",
            "day_utc": day_utc,
            "connector_id": connector_id,
            "pollutant_code": pollutant_code,
            "row_count": row_count,
            "source_row_count": row_count,
            "file_count": 1,
            "timeseries_row_counts": {str(key): value for key, value in counts.items()},
            "files": [{
                "key": key,
                "row_count": row_count,
                "pollutant_code": pollutant_code,
                "timeseries_row_counts": {str(key): value for key, value in counts.items()},
            }],
        }), encoding="utf-8")

    def _new_current_source_db(
        self,
        *,
        day_utc: str = "2026-06-18",
        connector_id: int = 1,
        source_key: str = MODULE.SOS_SOURCE_KEY,
        source_location_id: str = "station-1",
        timeseries_pollutants: dict[int, str] | None = None,
        source_counts: dict[int, int] | None = None,
    ) -> sqlite3.Connection:
        timeseries_pollutants = timeseries_pollutants or {218: "pm25"}
        if source_counts is None:
            source_counts = {218: 24}
        conn = MODULE.open_db(str(self.root / f"current-source-{connector_id}-{day_utc}.sqlite"))
        phenomenon_ids: dict[str, int] = {}
        for pollutant in sorted(set(timeseries_pollutants.values())):
            phenomenon_id = len(phenomenon_ids) + 1
            phenomenon_ids[pollutant] = phenomenon_id
            conn.execute(
                """
                INSERT INTO core_phenomena_snapshot (
                  id, label, source_label, pollutant_label, observed_property_id, connector_id
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (phenomenon_id, pollutant, pollutant, pollutant, phenomenon_id, connector_id),
            )
        for ts_id, pollutant in sorted(timeseries_pollutants.items()):
            conn.execute(
                """
                INSERT INTO core_timeseries_snapshot (
                  id, station_id, connector_id, timeseries_ref, label, phenomenon_id, ended_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (ts_id, 1, connector_id, f"source:{source_location_id}:{pollutant}:{ts_id}", pollutant, phenomenon_ids[pollutant], None),
            )
            conn.execute(
                """
                INSERT INTO source_station_timeseries_lookup (
                  source_key, source_location_id, station_ref, station_id,
                  connector_id, timeseries_id, is_active
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (source_key, source_location_id, source_location_id, 1, connector_id, ts_id, 1),
            )
        day = MODULE.dt.date.fromisoformat(day_utc)
        source_file_key = MODULE._source_file_key_for_lookup_row(source_key, source_location_id, day) or f"{source_key}:{source_location_id}:{day_utc}"
        conn.execute(
            """
            INSERT INTO source_file_state (
              source_file_key, env_name, source_key, remote_scheme,
              remote_url_or_key, station_ref, source_location_id, day_utc,
              exists_remote, first_seen_at_utc, last_checked_at_utc, last_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                source_file_key,
                "CIC-Test",
                source_key,
                "mock",
                "mock://source",
                source_location_id,
                source_location_id,
                day_utc,
                1,
                "2026-06-24T00:00:00Z",
                "2026-06-24T00:00:00Z",
                "changed",
            ),
        )
        for ts_id, count in sorted(source_counts.items()):
            conn.execute(
                """
                INSERT INTO source_file_timeseries_counts (
                  source_file_key, day_utc, timeseries_id, row_count, counted_at_utc
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (source_file_key, day_utc, ts_id, count, "2026-06-24T00:00:00Z"),
            )
        conn.commit()
        return conn

    def _run_v2_observations_integrity_with_source(
        self,
        conn: sqlite3.Connection,
        *,
        day_utc: str = "2026-06-18",
        source: str = "sos",
        connector_ids: list[int] | None = None,
    ) -> dict[str, object]:
        def parquet_stats(files):
            paths = list(files)
            manifest = json.loads((paths[0].parent / "manifest.json").read_text(encoding="utf-8"))
            counts = {int(key): int(value) for key, value in manifest["timeseries_row_counts"].items()}
            return ({
                "row_count": sum(counts.values()), "timeseries_row_counts": counts,
                "min_timeseries_id": min(counts) if counts else None,
                "max_timeseries_id": max(counts) if counts else None,
                "min_timestamp_utc": None, "max_timestamp_utc": None,
            }, None)

        with mock.patch.object(MODULE, "_read_parquet_partition_stats", side_effect=parquet_stats):
            return MODULE.run_v2_observations_integrity_checks(
                r2_history_root=self.env["UK_AQ_R2_HISTORY_DROPBOX_ROOT"],
                config=MODULE.resolve_history_path_config("v2", {}),
                from_day=day_utc,
                to_day=day_utc,
                conn=conn,
                env_name="CIC-Test",
                allowed_connector_ids=set(connector_ids) if connector_ids else None,
                source_scope={"source": source, "connector_ids": connector_ids, "scope": "source" if connector_ids else "all"},
                log=self.log,
            )

    def _mark_source_as_sos_flat_file(
        self,
        conn: sqlite3.Connection,
        *,
        extra_day_counts: dict[str, dict[int, int]] | None = None,
    ) -> None:
        row = conn.execute(
            "SELECT source_file_key FROM source_file_state WHERE source_key = ? LIMIT 1",
            (MODULE.SOS_SOURCE_KEY,),
        ).fetchone()
        self.assertIsNotNone(row)
        source_file_key = str(row[0])
        conn.execute(
            "UPDATE source_file_state SET remote_scheme = 'uk_air_flat_file' WHERE source_file_key = ?",
            (source_file_key,),
        )
        for day_utc, counts in (extra_day_counts or {}).items():
            for timeseries_id, row_count in counts.items():
                conn.execute(
                    """
                    INSERT INTO source_file_timeseries_counts (
                      source_file_key, day_utc, timeseries_id, row_count, counted_at_utc
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                    (source_file_key, day_utc, timeseries_id, row_count, "2026-07-11T00:00:00Z"),
                )
        conn.commit()

    def _ok_obs_repair_result(
        self,
        rows: int = 1,
        *,
        source_counts: dict[int, int] | None = None,
        repaired_counts: dict[int, int] | None = None,
        pollutant_codes: list[str] | None = None,
    ) -> dict[str, object]:
        source_counts = source_counts or {}
        repaired_counts = repaired_counts or {}
        pollutant_codes = pollutant_codes or []
        return {
            "status": "ok",
            "exit_code": 0,
            "rows_observations": rows,
            "source_connector_day_complete_events": 1,
            "source_connector_day_skipped_events": 0,
            "source_connector_day_pending_events": 0,
            "source_connector_day_failed_events": 0,
            "integrity_proposal_chunk_staged_events": 0,
            "integrity_proposal_staged_rows": 0,
            "max_integrity_proposal_staged_rows": 0,
            "source_timeseries_row_counts": {str(key): value for key, value in source_counts.items()},
            "repaired_timeseries_row_counts": {str(key): value for key, value in repaired_counts.items()},
            "source_pollutant_codes": pollutant_codes,
            "source_mapped_rows": sum(source_counts.values()),
            "stdout_tail": "",
            "stderr_tail": "",
            "log_path": None,
        }

    def _staged_obs_repair_result(
        self,
        rows: int = 1,
        *,
        source_counts: dict[int, int] | None = None,
        repaired_counts: dict[int, int] | None = None,
        pollutant_codes: list[str] | None = None,
    ) -> dict[str, object]:
        source_counts = source_counts or {}
        repaired_counts = repaired_counts or {}
        pollutant_codes = pollutant_codes or []
        return {
            "status": "ok",
            "exit_code": 0,
            "rows_observations": 0,
            "source_connector_day_complete_events": 0,
            "source_connector_day_skipped_events": 0,
            "source_connector_day_pending_events": 0,
            "source_connector_day_failed_events": 0,
            "integrity_proposal_chunk_staged_events": 1,
            "integrity_proposal_staged_rows": rows,
            "max_integrity_proposal_staged_rows": rows,
            "source_timeseries_row_counts": {str(key): value for key, value in source_counts.items()},
            "repaired_timeseries_row_counts": {str(key): value for key, value in repaired_counts.items()},
            "source_pollutant_codes": pollutant_codes,
            "source_mapped_rows": sum(source_counts.values()),
            "stdout_tail": "",
            "stderr_tail": "",
            "log_path": None,
        }

    def _summary_for_cross_check(self, cross_check: dict[str, object]) -> dict[str, object]:
        return {
            "env": "CIC-Test",
            "profile": "test",
            "started_at_utc": "2026-06-20T00:00:00Z",
            "finished_at_utc": "2026-06-20T00:01:00Z",
            "status": "ok",
            "source": "test",
            "dry_run": False,
            "check_only": False,
            "run_backfill": True,
            "db_path": str(self.root / "integrity.sqlite"),
            "log_path": str(self.root / "run.log"),
            "history_path_configs": {},
            "checked_versions": [],
            "cross_check": cross_check,
        }

    def test_v2_dry_run_plans_connector_repair_with_explicit_pollutants(self) -> None:
        metrics = MODULE.run_v2_gap_backfills(
            conn=self.conn,
            run_id=1,
            env_name="CIC-Test",
            run_compact="run",
            env=self.env,
            v2_observations={"gaps": [{"day_utc": "2026-06-08", "connector_id": 6, "gap_type": "connector_dir_missing"}]},
            dry_run=True,
            run_backfill=True,
            limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
            log=self.log,
            repair_pollutants=["pm25"],
        )
        repair = metrics["planned_v2_observation_repairs"][0]
        self.assertIn("UK_AQ_R2_HISTORY_VERSION=v2", repair)
        self.assertIn("UK_AQ_R2_HISTORY_INDEX_VERSION=v2", repair)
        self.assertNotIn("UK_AQ_R2_HISTORY_WRITE_VERSION", repair)
        self.assertNotIn("UK_AQ_R2_HISTORY_BACKUP_VERSION", repair)
        self.assertIn("UK_AQ_BACKFILL_CONNECTOR_IDS=6", repair)
        self.assertIn(
            "UK_AQ_BACKFILL_INTEGRITY_REPAIR_POLLUTANTS=pm25",
            repair,
        )
        self.assertNotIn("UK_AQ_BACKFILL_TIMESERIES_IDS", repair)
        self.assertNotIn("v1_dropbox_to_v2_observations_backfill_plan", repair)
        self.assertIn("--history-version v2 --targeted --kind observations", metrics["planned_v2_observation_index_rebuilds"][0])
        self.assertFalse(any(
            item.get("reason") == "not_explicit_observation_data_repair"
            for item in metrics["skipped_v2_observation_metadata_gaps"]
        ))

    def test_v2_mismatch_uses_complete_sorted_valid_repair_ids(self) -> None:
        full_ids = list(range(1, 44))
        gap = {
            "missing_timeseries_ids": [43, "2", 1, 2, 0, -1, "bad", None],
            "source_r2_mismatches": [
                {"timeseries_id": value} for value in reversed(full_ids)
            ] + [{"timeseries_id": "bad"}, {"timeseries_id": -9}],
            "sample_missing_timeseries_ids": full_ids[:25],
        }

        resolved = MODULE._timeseries_ids_for_v2_observation_gap(
            self.conn,
            connector_id=6,
            gap=gap,
        )

        self.assertEqual(resolved, full_ids)
        self.assertEqual(len(resolved), 43)

    def test_v2_index_only_gap_plans_index_without_observation_repair(self) -> None:
        metrics = MODULE.run_v2_gap_backfills(
            conn=self.conn,
            run_id=1,
            env_name="CIC-Test",
            run_compact="run",
            env=self.env,
            v2_observations={"gaps": [{
                "day_utc": "2026-06-08",
                "connector_id": 6,
                "pollutant_code": "o3",
                "gap_type": "index_manifest_missing",
                "suggested_repair": {"kind": "rebuild_v2_observations_index_only"},
            }]},
            dry_run=True,
            run_backfill=True,
            limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
            log=self.log,
        )

        self.assertEqual(metrics["planned_v2_observation_repairs"], [])
        self.assertEqual(len(metrics["planned_v2_observation_index_rebuilds"]), 1)
        self.assertIn("--kind observations", metrics["planned_v2_observation_index_rebuilds"][0])

    def test_manifest_and_parent_repairs_never_plan_source_writer(self) -> None:
        gaps = [
            {"day_utc": "2026-05-17", "connector_id": 1, "pollutant_code": code,
             "gap_type": "data_manifest_schema_mismatch",
             "suggested_repair": {"kind": "source_to_v2_observations_backfill_planned"}}
            for code in ("no2", "pm10", "pm25")
        ]
        gaps.extend([
            {"day_utc": "2026-05-17", "connector_id": 1, "gap_type": "connector_manifest_row_count_mismatch"},
            {"day_utc": "2026-05-17", "gap_type": "day_manifest_invalid_json"},
            {"day_utc": "2026-05-17", "connector_id": 1, "pollutant_code": "o3", "gap_type": "index_manifest_missing"},
        ])
        plan = [
            {"kind": "observation_pollutant_manifest_repair", "day_utc": "2026-05-17", "connector_id": 1, "pollutant_code": code}
            for code in ("no2", "pm10", "pm25")
        ] + [
            {"kind": "observation_connector_manifest_repair", "day_utc": "2026-05-17", "connector_id": 1},
            {"kind": "observation_day_manifest_repair", "day_utc": "2026-05-17"},
            {"kind": "observation_index_repair", "day_utc": "2026-05-17", "connector_id": 1, "pollutant_code": "o3"},
        ]
        metrics = MODULE.run_v2_gap_backfills(
            conn=self.conn, run_id=90, env_name="CIC-Test", run_compact="run", env=self.env,
            v2_observations={"gaps": gaps, "repair_plan": plan}, dry_run=True, run_backfill=True,
            limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0), log=self.log,
        )
        self.assertEqual(metrics["planned_v2_observation_repairs"], [])
        self.assertEqual(metrics["planned_aqi_rebuilds"], [])
        self.assertEqual(len(metrics["planned_v2_observation_index_rebuilds"]), 1)

    def test_explicit_observation_data_repair_is_the_only_writer_eligibility(self) -> None:
        gap = {"day_utc": "2026-06-08", "connector_id": 6, "gap_type": "source_r2_timeseries_row_mismatch", "missing_timeseries_ids": [101]}
        metrics = MODULE.run_v2_gap_backfills(
            conn=self.conn, run_id=91, env_name="CIC-Test", run_compact="run", env=self.env,
            v2_observations={"gaps": [gap], "repair_plan": [{
                "kind": "observation_data_repair", "day_utc": "2026-06-08", "connector_id": 6,
                "pollutant_code": "pm25", "data_changes_required": True,
            }]}, dry_run=True, run_backfill=True,
            limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0), log=self.log,
        )
        self.assertEqual(len(metrics["planned_v2_observation_repairs"]), 1)
        self.assertIn("UK_AQ_BACKFILL_TIMESERIES_IDS=101", metrics["planned_v2_observation_repairs"][0])
        self.assertEqual(len(metrics["planned_aqi_rebuilds"]), 1)

    def test_duplicate_raw_data_gaps_produce_one_writer_plan(self) -> None:
        gap = {"day_utc": "2026-06-08", "connector_id": 6, "gap_type": "source_r2_timeseries_row_mismatch", "missing_timeseries_ids": [101]}
        metrics = MODULE.run_v2_gap_backfills(
            conn=self.conn, run_id=92, env_name="CIC-Test", run_compact="run", env=self.env,
            v2_observations={"gaps": [dict(gap), dict(gap)], "repair_plan": [{
                "kind": "observation_data_repair", "day_utc": "2026-06-08", "connector_id": 6,
                "pollutant_code": "pm25",
            }]}, dry_run=True, run_backfill=True,
            limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0), log=self.log,
        )
        self.assertEqual(len(metrics["planned_v2_observation_repairs"]), 1)
        self.assertEqual(len(metrics["planned_v2_observation_index_rebuilds"]), 1)
        self.assertEqual(len(metrics["planned_aqi_rebuilds"]), 1)

    def test_metadata_executor_uses_repository_root_not_current_directory(self) -> None:
        with mock.patch.object(MODULE.subprocess, "run", return_value=mock.Mock(
            returncode=0, stdout=json.dumps({"status": "planned", "results": []}), stderr=""
        )) as run_process:
            result = MODULE._run_v2_observation_metadata_executor(
                env={"UK_AQ_OPS_REPO_ROOT": str(MODULE_PATH.parents[3])},
                actions=[{"kind": "observation_index_repair", "day_utc": "2026-05-17", "connector_id": 1, "pollutant_code": "o3"}],
                dry_run=True,
                log=self.log,
                run_state={"overlay_root": str(self.root / "overlay"), "base_dropbox_root": str(self.root / "r2"), "run_state_path": str(self.root / "run-state.json")},
            )
        self.assertEqual(result["status"], "planned")
        self.assertEqual(run_process.call_args.kwargs["cwd"], MODULE_PATH.parents[3])
        self.assertIn("uk_aq_execute_v2_observations_repair.mjs", run_process.call_args.args[0][1])

    def test_duplicate_metadata_actions_merge_by_scope(self) -> None:
        actions = MODULE._v2_observation_metadata_actions({"repair_plan": [
            {"kind": "observation_pollutant_manifest_repair", "day_utc": "2026-05-17", "connector_id": 1, "pollutant_code": "no2", "gap_types": ["data_manifest_schema_mismatch"]},
            {"kind": "observation_pollutant_manifest_repair", "day_utc": "2026-05-17", "connector_id": 1, "pollutant_code": "no2", "gap_types": ["data_manifest_total_bytes_mismatch"]},
        ]})
        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0]["gap_types"], ["data_manifest_schema_mismatch", "data_manifest_total_bytes_mismatch"])

    def test_authoritative_metadata_bindings_come_from_imported_core_snapshot(self) -> None:
        conn = sqlite3.connect(":memory:")
        try:
            conn.executescript("""
                CREATE TABLE core_timeseries_snapshot (
                  id INTEGER PRIMARY KEY, connector_id INTEGER, label TEXT,
                  timeseries_ref TEXT, phenomenon_id INTEGER
                );
                CREATE TABLE core_phenomena_snapshot (
                  id INTEGER PRIMARY KEY, label TEXT, source_label TEXT,
                  pollutant_label TEXT, observed_property_id INTEGER
                );
            """)
            conn.execute(
                "INSERT INTO core_phenomena_snapshot VALUES (?, ?, ?, ?, ?)",
                (7, "Nitrogen dioxide", "NO2", "NO2", 12),
            )
            conn.execute(
                "INSERT INTO core_timeseries_snapshot VALUES (?, ?, ?, ?, ?)",
                (101, 1, "ignored", "ignored", 7),
            )
            self.assertEqual(
                MODULE._authoritative_v2_core_timeseries_bindings(conn),
                [{
                    "timeseries_id": 101,
                    "connector_id": 1,
                    "pollutant_code": "no2",
                    "phenomenon_id": 7,
                    "observed_property_id": 12,
                }],
            )
        finally:
            conn.close()

    def test_manifest_stage_remains_planned_when_only_index_metadata_is_blocked(self) -> None:
        run_state = {
            "changed_scopes": {"OBSERVS_CHANGED": []},
            "blocked_scopes": [],
            "overlay_root": str(self.root / "overlay"),
            "base_dropbox_root": str(self.root / "r2"),
            "run_state_path": str(self.root / "run-state.json"),
        }
        observation_metadata = {
            "status": "blocked_dependency",
            "manifest_status": "planned",
            "index_status": "blocked_dependency",
            "results": [],
        }
        with mock.patch.object(MODULE, "run_v2_gap_backfills", return_value={
            "v2_observation_repairs_failed": 0,
            "v2_observation_repairs_guard_failed": 0,
        }), mock.patch.object(MODULE, "_run_v2_observation_metadata_executor", side_effect=[
            observation_metadata,
            {"status": "not_run", "results": []},
        ]), mock.patch.object(MODULE, "_record_metadata_executor_overlay"), mock.patch.object(
            MODULE, "_phase4_aqi_work", return_value=([], [])
        ):
            result = MODULE.run_v2_integrity_repair_flow(
                run_state=run_state,
                conn=self.conn,
                run_id=1,
                env_name="CIC-Test",
                run_compact="run",
                env=self.env,
                v2_observations={"repair_plan": []},
                v2_aqilevels={"repair_plan": []},
                final_verification_config=MODULE.resolve_history_path_config("v2", self.env),
                from_day="2026-05-17",
                to_day="2026-05-17",
                allowed_connector_ids={1},
                source_scope={"source": "sos", "connector_ids": [1]},
                check_aqi_debug=False,
                require_aqi_debug=False,
                limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                dry_run=True,
                log=self.log,
            )
        stages = {entry["stage"]: entry["status"] for entry in result["stage_results"]}
        self.assertEqual(stages["observs_manifests"], "planned")
        self.assertEqual(stages["observs_indexes"], "blocked_dependency")
        self.assertEqual(stages["aqilevels"], "planned")
        self.assertEqual(result["status"], "failed")

    def test_canonical_coordinator_bridges_28_observation_backed_aqi_days_before_final_verification(self) -> None:
        self.conn.execute("""
            CREATE TABLE core_observed_property_mappings_snapshot (
              id INTEGER PRIMARY KEY, connector_id INTEGER NOT NULL,
              observed_property_code TEXT, mapping_kind TEXT NOT NULL,
              is_aqi_eligible INTEGER NOT NULL, is_active INTEGER NOT NULL
            )
        """)
        self.conn.executemany(
            """
            INSERT INTO core_observed_property_mappings_snapshot (
              id, connector_id, observed_property_code, mapping_kind,
              is_aqi_eligible, is_active
            ) VALUES (?, 1, ?, 'direct', 1, 1)
            """,
            [(1, "no2"), (2, "pm10"), (3, "pm25")],
        )
        run_state = MODULE.create_run_overlay(
            tmp_dir=self.root / "tmp",
            run_id="canonical-aqi-bridge",
            environment="CIC-Test",
            base_dropbox_root=self.root / "R2_history_backup",
        )
        gaps = []
        for day_offset in range(28):
            day_utc = (MODULE.dt.date(2026, 2, 1) + MODULE.dt.timedelta(days=day_offset)).isoformat()
            gaps.append({
                "gap_type": "day_dir_missing",
                "day_utc": day_utc,
                "connector_id": 1,
                "source_evidence": {"v2_observations_present": True},
                "suggested_repair": {"kind": MODULE.V2_AQI_OBS_REBUILD_KIND},
            })
            for pollutant_code in ("no2", "pm10", "pm25"):
                gaps.append({
                    "gap_type": "aqi_manifest_missing_after_obs_repair",
                    "day_utc": day_utc,
                    "connector_id": 1,
                    "pollutant_code": pollutant_code,
                    "source_evidence": {"v2_observations_present": True},
                    "suggested_repair": {"kind": MODULE.V2_AQI_OBS_REBUILD_KIND},
                })
        execution_order: list[str] = []

        def execute_aqi_queue(*_args, **_kwargs):
            execution_order.append("aqi")
            queued = self.conn.execute(
                "SELECT COUNT(*) FROM aqi_rebuild_queue WHERE run_id = 281"
            ).fetchone()[0]
            self.assertEqual(queued, 28)
            return {
                "aqi_rebuild_ran": True,
                "aqi_rebuilds_queued": 28,
                "aqi_rebuilds_queued_total": 28,
                "aqi_rebuilds_attempted": 28,
                "aqi_rebuilds_complete": 28,
                "aqi_rebuilds_failed": 0,
                "aqi_rebuild_results": [],
            }

        def final_verification(*_args, **_kwargs):
            execution_order.append("final_verification")
            self.assertEqual(execution_order, ["aqi", "final_verification"])
            return {
                "status": "ok",
                "remaining_gap_count": 0,
                "r2_objects_written": 0,
                "r2_objects_deleted": 0,
                "r2_objects_changed": 0,
            }

        metadata_ok = {"status": "ok", "manifest_status": "ok", "index_status": "ok", "results": []}
        with mock.patch.object(MODULE, "run_v2_gap_backfills", return_value={
            "v2_observation_repairs_failed": 0,
            "v2_observation_repairs_guard_failed": 0,
        }), mock.patch.object(MODULE, "_run_v2_observation_metadata_executor", side_effect=[metadata_ok, metadata_ok]), \
             mock.patch.object(MODULE, "_record_metadata_executor_overlay"), \
             mock.patch.object(MODULE, "record_integrity_object_operations", return_value={}), \
             mock.patch.object(MODULE, "run_aqi_rebuild_queue_execution", side_effect=execute_aqi_queue), \
             mock.patch.object(MODULE, "run_canonical_apply_executor", return_value={"status": "succeeded"}), \
             mock.patch.object(MODULE, "run_v2_final_verification", side_effect=final_verification):
            result = MODULE.run_v2_integrity_repair_flow(
                run_state=run_state,
                conn=self.conn,
                run_id=281,
                env_name="CIC-Test",
                run_compact="run",
                env=self.env,
                v2_observations={"repair_plan": []},
                v2_aqilevels={"gaps": gaps, "repair_plan": []},
                final_verification_config=MODULE.resolve_history_path_config("v2", self.env),
                from_day="2026-02-01",
                to_day="2026-02-28",
                allowed_connector_ids={1},
                source_scope={"source": "sos", "connector_ids": [1]},
                check_aqi_debug=False,
                require_aqi_debug=False,
                limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                dry_run=False,
                log=self.log,
            )

        aqi_stage = next(stage["result"] for stage in result["stage_results"] if stage["stage"] == "aqi_proposal")
        self.assertTrue(aqi_stage["v2_aqi_integrity_rebuild_bridge_ran"])
        self.assertEqual(aqi_stage["v2_aqi_rebuilds_queued_from_integrity"], 28)
        self.assertEqual(len(aqi_stage["planned_aqi_rebuild_connector_days"]), 28)
        self.assertEqual(aqi_stage["aqi_rebuilds_attempted"], 28)
        self.assertEqual(result["status"], "succeeded")

    def test_data_repair_coalesces_same_day_index_only_gap(self) -> None:
        metrics = MODULE.run_v2_gap_backfills(
            conn=self.conn,
            run_id=1,
            env_name="CIC-Test",
            run_compact="run",
            env=self.env,
            v2_observations={"gaps": [
                {
                    "day_utc": "2026-06-08", "connector_id": 6,
                    "gap_type": "source_r2_timeseries_row_mismatch",
                    "missing_timeseries_ids": [101, 102],
                },
                {
                    "day_utc": "2026-06-08", "connector_id": 6,
                    "pollutant_code": "o3", "gap_type": "index_manifest_missing",
                    "suggested_repair": {"kind": "rebuild_v2_observations_index_only"},
                },
            ]},
            dry_run=True,
            run_backfill=True,
            limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
            log=self.log,
        )

        self.assertEqual(len(metrics["planned_v2_observation_repairs"]), 1)
        self.assertEqual(len(metrics["planned_v2_observation_index_rebuilds"]), 1)

    def test_source_sos_resolves_to_connector_id_1_from_current_metadata(self) -> None:
        conn = MODULE.open_db(str(self.root / "sos-source-scope.sqlite"))
        try:
            conn.execute(
                """
                INSERT INTO source_station_timeseries_lookup (
                  source_key, source_location_id, station_ref, station_id,
                  connector_id, timeseries_id, is_active
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (MODULE.SOS_SOURCE_KEY, "station-1", "station-1", 1, 1, 1001, 1),
            )
            conn.commit()

            allowed, scope = MODULE.resolve_v2_source_scope(conn, "sos")

            self.assertEqual(allowed, {1})
            self.assertEqual(scope, {"source": "sos", "connector_ids": [1], "scope": "source"})
        finally:
            conn.close()

    def test_v2_source_r2_mismatch_detects_stale_internal_manifest_and_plans_repair(self) -> None:
        self._write_v2_observation_partition(
            day_utc="2026-06-18",
            connector_id=1,
            pollutant_code="pm25",
            timeseries_row_counts={218: 13},
        )
        conn = self._new_current_source_db(
            day_utc="2026-06-18",
            connector_id=1,
            timeseries_pollutants={218: "pm25"},
            source_counts={218: 24},
        )
        try:
            result = self._run_v2_observations_integrity_with_source(
                conn,
                day_utc="2026-06-18",
                connector_ids=[1],
            )

            gaps = [gap for gap in result["gaps"] if gap["gap_type"] == "source_r2_timeseries_row_mismatch"]
            self.assertEqual(len(gaps), 1)
            self.assertEqual(gaps[0]["connector_id"], 1)
            self.assertEqual(gaps[0]["pollutant_code"], "pm25")
            self.assertEqual(gaps[0]["source_rows"], 24)
            self.assertEqual(gaps[0]["r2_rows"], 13)
            self.assertEqual(gaps[0]["missing_timeseries_count"], 1)
            self.assertIn(218, gaps[0]["sample_missing_timeseries_ids"])
            self.assertEqual(gaps[0]["source_evidence"]["source_partition_state"], "successful_non_empty")
            self.assertTrue(gaps[0]["source_evidence"]["source_counts_present"])
            self.assertTrue(gaps[0]["source_evidence"]["source_counts_available"])

            repair_metrics = MODULE.run_v2_gap_backfills(
                conn=conn,
                run_id=218,
                env_name="CIC-Test",
                run_compact="run",
                env=self.env,
                v2_observations=result,
                dry_run=True,
                run_backfill=True,
                limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                log=self.log,
            )
            self.assertEqual(repair_metrics["observation_backfill_candidate_days"], 1)
            self.assertEqual(len(repair_metrics["planned_v2_observation_repairs"]), 1)
            self.assertIn("UK_AQ_BACKFILL_CONNECTOR_IDS=1", repair_metrics["planned_v2_observation_repairs"][0])
            self.assertIn("--history-version v2 --targeted --kind observations", repair_metrics["planned_v2_observation_index_rebuilds"][0])
        finally:
            conn.close()

    def test_v2_source_partition_evidence_distinguishes_successful_empty_from_unavailable(self) -> None:
        self._write_v2_observation_partition(
            day_utc="2026-06-18",
            connector_id=1,
            pollutant_code="pm25",
            timeseries_row_counts={218: 13},
        )
        manifest_path = Path(self.env["UK_AQ_R2_HISTORY_DROPBOX_ROOT"]) / "history/v2/observations/day_utc=2026-06-18/connector_id=1/pollutant_code=pm25/manifest.json"
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        payload["row_count"] = 999
        payload["source_row_count"] = 999
        manifest_path.write_text(json.dumps(payload), encoding="utf-8")

        empty_source_conn = self._new_current_source_db(
            day_utc="2026-06-18",
            connector_id=1,
            timeseries_pollutants={218: "pm25"},
            source_counts={},
        )
        try:
            result = self._run_v2_observations_integrity_with_source(
                empty_source_conn,
                day_utc="2026-06-18",
                connector_ids=[1],
            )
            gap = next(g for g in result["gaps"] if g["gap_type"] == "data_manifest_row_count_mismatch")
            self.assertEqual(gap["source_evidence"]["source_partition_state"], "successful_empty")
            self.assertFalse(gap["source_evidence"]["source_counts_present"])
            self.assertTrue(gap["source_evidence"]["source_counts_available"])
        finally:
            empty_source_conn.close()

        unavailable_source_conn = MODULE.open_db(str(self.root / "unavailable-current-source.sqlite"))
        try:
            result = self._run_v2_observations_integrity_with_source(
                unavailable_source_conn,
                day_utc="2026-06-18",
                connector_ids=[1],
            )
            gap = next(g for g in result["gaps"] if g["gap_type"] == "data_manifest_row_count_mismatch")
            self.assertEqual(gap["source_evidence"]["source_partition_state"], "counts_unavailable")
            self.assertFalse(gap["source_evidence"]["source_counts_present"])
            self.assertFalse(gap["source_evidence"]["source_counts_available"])
        finally:
            unavailable_source_conn.close()

    def test_v2_current_source_partition_states_remain_distinct(self) -> None:
        base_scope = {"source": "sos", "connector_ids": [1], "scope": "source"}

        non_empty_conn = self._new_current_source_db(
            day_utc="2026-06-18",
            connector_id=1,
            timeseries_pollutants={218: "pm25"},
            source_counts={218: 24},
        )
        try:
            source_counts, evidence = MODULE._current_source_counts_for_v2_partition(
                non_empty_conn,
                env_name="CIC-Test",
                source_scope=base_scope,
                day_utc="2026-06-18",
                connector_id=1,
                pollutant_code="pm25",
            )
            self.assertEqual(source_counts, {218: 24})
            self.assertEqual(evidence["source_partition_state"], "successful_non_empty")
            self.assertTrue(evidence["source_counts_present"])
            self.assertTrue(evidence["source_counts_available"])
            self.assertTrue(evidence["partition"]["source_counts_present"])
            self.assertTrue(evidence["partition"]["source_counts_available"])
        finally:
            non_empty_conn.close()

        source_counts, evidence = MODULE._current_source_counts_for_v2_partition(
            None,
            env_name="CIC-Test",
            source_scope=base_scope,
            day_utc="2026-06-19",
            connector_id=1,
            pollutant_code="pm25",
        )
        self.assertEqual(source_counts, {})
        self.assertEqual(evidence["source_partition_state"], "connection_unavailable")
        self.assertEqual(evidence["source_skip_reason"], "source_connection_unavailable")
        self.assertFalse(evidence["source_counts_present"])
        self.assertFalse(evidence["source_counts_available"])
        self.assertFalse(evidence["partition"]["source_counts_present"])
        self.assertFalse(evidence["partition"]["source_counts_available"])

        counts_unavailable_conn = MODULE.open_db(str(self.root / "counts-unavailable.sqlite"))
        try:
            source_counts, evidence = MODULE._current_source_counts_for_v2_partition(
                counts_unavailable_conn,
                env_name="CIC-Test",
                source_scope=base_scope,
                day_utc="2026-06-23",
                connector_id=1,
                pollutant_code="pm25",
            )
            self.assertEqual(source_counts, {})
            self.assertEqual(evidence["source_partition_state"], "counts_unavailable")
            self.assertFalse(evidence["source_counts_present"])
            self.assertFalse(evidence["source_counts_available"])
            self.assertFalse(evidence["partition"]["source_counts_present"])
            self.assertFalse(evidence["partition"]["source_counts_available"])
        finally:
            counts_unavailable_conn.close()

        scope_conn = self._new_current_source_db(
            day_utc="2026-06-20",
            connector_id=1,
            timeseries_pollutants={218: "pm25"},
            source_counts={218: 24},
        )
        try:
            with mock.patch.object(MODULE, "_source_keys_for_scope", return_value=()):
                source_counts, evidence = MODULE._current_source_counts_for_v2_partition(
                    scope_conn,
                    env_name="CIC-Test",
                    source_scope=base_scope,
                    day_utc="2026-06-20",
                    connector_id=1,
                    pollutant_code="pm25",
            )
            self.assertEqual(source_counts, {})
            self.assertEqual(evidence["source_partition_state"], "scope_unavailable")
            self.assertEqual(evidence["source_skip_reason"], "source_scope_has_no_source_keys")
            self.assertFalse(evidence["source_counts_present"])
            self.assertFalse(evidence["source_counts_available"])
            self.assertFalse(evidence["partition"]["source_counts_present"])
            self.assertFalse(evidence["partition"]["source_counts_available"])
        finally:
            scope_conn.close()

        metadata_conn = self._new_current_source_db(
            day_utc="2026-06-21",
            connector_id=1,
            timeseries_pollutants={218: "pm25"},
            source_counts={218: 24},
        )
        try:
            metadata_conn.execute("UPDATE core_timeseries_snapshot SET timeseries_ref = '', label = '' WHERE id = ?", (218,))
            metadata_conn.execute("UPDATE core_phenomena_snapshot SET label = '', source_label = '', pollutant_label = '' WHERE id = 1")
            metadata_conn.commit()
            source_counts, evidence = MODULE._current_source_counts_for_v2_partition(
                metadata_conn,
                env_name="CIC-Test",
                source_scope=base_scope,
                day_utc="2026-06-21",
                connector_id=1,
                pollutant_code="pm25",
            )
            self.assertEqual(source_counts, {})
            self.assertEqual(evidence["source_partition_state"], "metadata_unavailable")
            self.assertEqual(evidence["source_skip_reason"], "source_pollutant_metadata_unavailable")
            self.assertFalse(evidence["source_counts_present"])
            self.assertFalse(evidence["source_counts_available"])
            self.assertFalse(evidence["partition"]["source_counts_present"])
            self.assertFalse(evidence["partition"]["source_counts_available"])
        finally:
            metadata_conn.close()

        pollutant_conn = self._new_current_source_db(
            day_utc="2026-06-22",
            connector_id=1,
            timeseries_pollutants={218: "no2"},
            source_counts={218: 24},
        )
        try:
            source_counts, evidence = MODULE._current_source_counts_for_v2_partition(
                pollutant_conn,
                env_name="CIC-Test",
                source_scope=base_scope,
                day_utc="2026-06-22",
                connector_id=1,
                pollutant_code="pm25",
            )
            self.assertEqual(source_counts, {})
            self.assertEqual(evidence["source_partition_state"], "pollutant_absent")
            self.assertEqual(evidence["source_skip_reason"], "source_pollutant_not_present")
            self.assertFalse(evidence["source_counts_present"])
            self.assertFalse(evidence["source_counts_available"])
            self.assertFalse(evidence["partition"]["source_counts_present"])
            self.assertFalse(evidence["partition"]["source_counts_available"])
        finally:
            pollutant_conn.close()

    def test_v2_observations_integrity_propagates_connection_unavailable_evidence_when_conn_is_none(self) -> None:
        self._write_v2_observation_partition(
            day_utc="2026-06-18",
            connector_id=1,
            pollutant_code="pm25",
            timeseries_row_counts={218: 13},
        )
        manifest_path = Path(
            self.env["UK_AQ_R2_HISTORY_DROPBOX_ROOT"]
        ) / "history/v2/observations/day_utc=2026-06-18/connector_id=1/pollutant_code=pm25/manifest.json"
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        payload["row_count"] = 99
        payload["source_row_count"] = 99
        manifest_path.write_text(json.dumps(payload), encoding="utf-8")

        stats = {
            "row_count": 13,
            "non_null_timeseries_count": 1,
            "timeseries_row_counts": {218: 13},
            "null_timeseries_count": 0,
            "min_timeseries_id": 218,
            "max_timeseries_id": 218,
            "min_timestamp_utc": "2026-06-18T00:00:00+00",
            "max_timestamp_utc": "2026-06-18T01:00:00+00",
            "parquet_null_timeseries_id_rows": False,
        }
        with mock.patch.object(MODULE, "_read_parquet_partition_stats", return_value=(stats, None)):
            result = MODULE.run_v2_observations_integrity_checks(
                r2_history_root=self.env["UK_AQ_R2_HISTORY_DROPBOX_ROOT"],
                config=MODULE.resolve_history_path_config("v2", {}),
                from_day="2026-06-18",
                to_day="2026-06-18",
                conn=None,
                env_name="CIC-Test",
                allowed_connector_ids={1},
                source_scope={"source": "sos", "connector_ids": [1], "scope": "source"},
                log=self.log,
            )
        manifest_gaps = [gap for gap in result["gaps"] if gap["gap_type"].startswith("data_manifest_")]
        self.assertTrue(manifest_gaps)
        self.assertTrue(all(gap["source_evidence"]["source_partition_state"] == "connection_unavailable" for gap in manifest_gaps))
        self.assertTrue(all(gap["source_evidence"]["source_skip_reason"] == "source_connection_unavailable" for gap in manifest_gaps))
        self.assertTrue(all(gap["source_evidence"]["source_counts_present"] is False for gap in manifest_gaps))
        self.assertTrue(all(gap["source_evidence"]["source_counts_available"] is False for gap in manifest_gaps))
        self.assertTrue(all(gap["source_evidence"]["partition"]["source_counts_present"] is False for gap in manifest_gaps))
        self.assertTrue(all(gap["source_evidence"]["partition"]["source_counts_available"] is False for gap in manifest_gaps))
        self.assertFalse(any(gap["gap_type"] == "source_r2_timeseries_row_mismatch" for gap in result["gaps"]))

    def test_v2_source_r2_matching_counts_do_not_create_repair_candidate(self) -> None:
        self._write_v2_observation_partition(
            day_utc="2026-06-18",
            connector_id=1,
            pollutant_code="pm25",
            timeseries_row_counts={218: 24},
        )
        conn = self._new_current_source_db(
            day_utc="2026-06-18",
            connector_id=1,
            timeseries_pollutants={218: "pm25"},
            source_counts={218: 24},
        )
        try:
            result = self._run_v2_observations_integrity_with_source(
                conn,
                day_utc="2026-06-18",
                connector_ids=[1],
            )
            self.assertEqual(result["status"], "ok")
            self.assertFalse(any(gap["gap_type"] == "source_r2_timeseries_row_mismatch" for gap in result["gaps"]))
        finally:
            conn.close()

    def test_v2_source_r2_mismatch_is_pollutant_specific(self) -> None:
        self._write_v2_observation_partition(
            day_utc="2026-06-18",
            connector_id=1,
            pollutant_code="pm25",
            timeseries_row_counts={218: 13},
        )
        self._write_v2_observation_partition(
            day_utc="2026-06-18",
            connector_id=1,
            pollutant_code="no2",
            timeseries_row_counts={319: 24},
        )
        conn = self._new_current_source_db(
            day_utc="2026-06-18",
            connector_id=1,
            timeseries_pollutants={218: "pm25", 319: "no2"},
            source_counts={218: 24, 319: 24},
        )
        try:
            result = self._run_v2_observations_integrity_with_source(
                conn,
                day_utc="2026-06-18",
                connector_ids=[1],
            )
            mismatch_gaps = [gap for gap in result["gaps"] if gap["gap_type"] == "source_r2_timeseries_row_mismatch"]
            self.assertEqual(len(mismatch_gaps), 1)
            self.assertEqual(mismatch_gaps[0]["pollutant_code"], "pm25")
            self.assertEqual(mismatch_gaps[0]["sample_missing_timeseries_ids"], [218])
        finally:
            conn.close()

    def test_v2_source_r2_mismatch_diagnostics_include_multiple_timeseries_sample(self) -> None:
        r2_counts = {210: 13, 211: 13, 218: 13}
        source_counts = {210: 24, 211: 23, 218: 24}
        self._write_v2_observation_partition(
            day_utc="2026-06-18",
            connector_id=1,
            pollutant_code="pm25",
            timeseries_row_counts=r2_counts,
        )
        conn = self._new_current_source_db(
            day_utc="2026-06-18",
            connector_id=1,
            timeseries_pollutants={210: "pm25", 211: "pm25", 218: "pm25"},
            source_counts=source_counts,
        )
        try:
            result = self._run_v2_observations_integrity_with_source(
                conn,
                day_utc="2026-06-18",
                connector_ids=[1],
            )
            gap = next(gap for gap in result["gaps"] if gap["gap_type"] == "source_r2_timeseries_row_mismatch")
            self.assertEqual(gap["missing_timeseries_count"], 3)
            self.assertEqual(gap["sample_missing_timeseries_ids"], [210, 211, 218])
            self.assertEqual(gap["source_rows"], sum(source_counts.values()))
            self.assertEqual(gap["r2_rows"], sum(r2_counts.values()))
            self.assertTrue(any("timeseries_id=218" in item for item in gap["related_paths"]))
        finally:
            conn.close()

    def test_v2_source_r2_missing_current_source_data_does_not_create_repair_candidate(self) -> None:
        self._write_v2_observation_partition(
            day_utc="2026-06-18",
            connector_id=1,
            pollutant_code="pm25",
            timeseries_row_counts={218: 13},
        )
        conn = MODULE.open_db(str(self.root / "empty-current-source.sqlite"))
        try:
            result = self._run_v2_observations_integrity_with_source(
                conn,
                day_utc="2026-06-18",
                connector_ids=[1],
            )
            self.assertEqual(result["status"], "ok")
            self.assertFalse(any(gap["gap_type"] == "source_r2_timeseries_row_mismatch" for gap in result["gaps"]))
        finally:
            conn.close()

    def test_v2_execution_invokes_wrapper_with_history_version_v2(self) -> None:
        self._write_v2_observation_connector_manifest(timeseries_row_counts={101: 1})
        with mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=str(self.root / "wrapper.sh")), \
             mock.patch.object(MODULE, "run_narrow_backfill", return_value=self._ok_obs_repair_result()) as run_bf:
            (self.root / "wrapper.sh").write_text("#!/bin/sh\n", encoding="utf-8")
            metrics = MODULE.run_v2_gap_backfills(
                conn=self.conn,
                run_id=2,
                env_name="CIC-Test",
                run_compact="run",
                env=self.env,
                v2_observations={"gaps": [{"day_utc": "2026-06-08", "connector_id": 6}]},
                dry_run=False,
                run_backfill=True,
                limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                log=self.log,
            )
        self.assertEqual(metrics["v2_observation_repairs_attempted"], 1)
        self.assertEqual(metrics["v2_observation_repairs_ok"], 1)
        kwargs = run_bf.call_args.kwargs
        self.assertEqual(kwargs["history_version"], "v2")
        self.assertEqual(kwargs["connector_ids"], [6])
        self.assertEqual(kwargs["output_scope"], "observations_only")

    def test_v2_observation_repair_attempts_source_even_when_source_cache_failed(self) -> None:
        conn = self._new_source_db()
        try:
            self._insert_openaq_prior_state(conn, local_cached_path=None, last_status="download_failed")
            gap = {"day_utc": "2026-06-08", "connector_id": 6}
            with mock.patch.object(MODULE, "run_narrow_backfill", return_value={
                "status": "ok",
                "exit_code": 0,
                "rows_observations": 0,
                "source_connector_day_complete_events": 0,
                "source_connector_day_skipped_events": 0,
                "source_connector_day_pending_events": 1,
                "source_connector_day_failed_events": 0,
                "backfill_run_status": "stubbed",
                "source_acquisition_pending_days": ["2026-06-08"],
            }) as run_bf:
                metrics = MODULE.run_v2_gap_backfills(
                    conn=conn,
                    run_id=30,
                    env_name="CIC-Test",
                    run_compact="run",
                    env=self.env,
                    v2_observations={"gaps": [gap]},
                    dry_run=False,
                    run_backfill=True,
                    limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                    log=self.log,
                )

            run_bf.assert_called_once()
            self.assertEqual(metrics["v2_observation_repairs_attempted"], 1)
            self.assertEqual(metrics["v2_observation_repairs_source_unavailable"], 1)
            self.assertEqual(metrics["aqi_rebuilds_queued_from_obs_repair"], 0)
            self.assertEqual(metrics["planned_aqi_rebuilds"], [])
            self.assertEqual(metrics["v2_observation_repair_results"][0]["status"], "source_pending")
            self.assertEqual(gap["suggested_repair"]["kind"], "source_to_v2_observations_backfill")
            self.assertFalse(gap["suggested_repair"]["executes"])
            self.assertFalse(gap["suggested_repair"]["operator_action_required"])
            self.assertEqual(gap["source_evidence"]["source_cache_status"]["status"], "download_failed")
            queued = conn.execute("SELECT COUNT(*) FROM aqi_rebuild_queue").fetchone()[0]
            self.assertEqual(int(queued), 0)
        finally:
            conn.close()

    def test_v2_observation_repair_queues_connector_scoped_aqi_after_success(self) -> None:
        conn = self._new_source_db()
        cached = self.root / "cached-openaq.csv.gz"
        cached.write_bytes(gzip.compress(b"ok\n"))
        try:
            self._insert_openaq_prior_state(conn, local_cached_path=str(cached))
            gap = {"day_utc": "2026-06-08", "connector_id": 6}
            self._write_v2_observation_connector_manifest(timeseries_row_counts={101: 2})
            with mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=str(self.root / "wrapper.sh")), \
                 mock.patch.object(MODULE, "run_narrow_backfill", return_value=self._ok_obs_repair_result(rows=2)) as run_bf:
                metrics = MODULE.run_v2_gap_backfills(
                    conn=conn,
                    run_id=31,
                    env_name="CIC-Test",
                    run_compact="run",
                    env=self.env,
                    v2_observations={"gaps": [gap]},
                    dry_run=False,
                    run_backfill=True,
                    limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                    log=self.log,
                )

            self.assertEqual(metrics["v2_observation_repairs_attempted"], 1)
            self.assertEqual(metrics["v2_observation_repairs_ok"], 1)
            self.assertEqual(metrics["observation_backfills_attempted"], 1)
            self.assertEqual(metrics["observation_backfills_ok"], 1)
            self.assertEqual(metrics["observation_backfill_candidate_days"], 1)
            self.assertEqual(metrics["observation_backfill_candidate_timeseries_ids"], 1)
            self.assertEqual(metrics["aqi_rebuilds_queued_from_obs_repair"], 1)
            self.assertEqual(gap["suggested_repair"]["kind"], "source_to_v2_observations_backfill")
            self.assertFalse(gap["suggested_repair"]["executes"])
            self.assertFalse(gap["suggested_repair"]["operator_action_required"])
            self.assertEqual(gap["source_evidence"]["source_cache_status"]["status"], "ok")
            self.assertIn("reason=obs_repaired", metrics["planned_aqi_rebuilds"][0])
            self.assertEqual(run_bf.call_args.kwargs["connector_ids"], [6])
            queued = conn.execute(
                "SELECT connector_id, day_utc, reason, status, history_version FROM aqi_rebuild_queue"
            ).fetchone()
            self.assertEqual(queued, (6, "2026-06-08", "obs_repaired", "queued", "v2"))
        finally:
            conn.close()

    def test_v2_observation_then_aqi_queue_executes_r2_rebuild_after_rows_written(self) -> None:
        conn = self._new_source_db()
        cached = self.root / "cached-openaq-sequence.csv.gz"
        cached.write_bytes(gzip.compress(b"ok\n"))
        try:
            self._insert_openaq_prior_state(conn, local_cached_path=str(cached))
            self._write_v2_observation_connector_manifest(timeseries_row_counts={101: 3})
            self._write_v2_observation_partition(
                day_utc="2026-06-08",
                connector_id=6,
                pollutant_code="pm25",
                timeseries_row_counts={101: 3},
            )
            self._write_v2_aqi_partition(
                day_utc="2026-06-08",
                connector_id=6,
                pollutant_code="pm25",
                timeseries_row_counts={101: 3},
            )
            with mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=str(self.root / "uk_aq_integrity_backfill.sh")), \
                 mock.patch.object(MODULE, "run_narrow_backfill", return_value=self._ok_obs_repair_result(rows=3)) as run_obs, \
                 mock.patch.object(MODULE, "run_aqi_rebuild_backfill", return_value={"status": "ok", "log_path": None}) as run_aqi:
                obs_metrics = MODULE.run_v2_gap_backfills(
                    conn=conn,
                    run_id=1310,
                    env_name="CIC-Test",
                    run_compact="run",
                    env=self.env,
                    v2_observations={"gaps": [{"day_utc": "2026-06-08", "connector_id": 6}]},
                    dry_run=False,
                    run_backfill=True,
                    limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                    log=self.log,
                )
                aqi_metrics = MODULE.run_aqi_rebuild_queue_execution(
                    conn,
                    run_id=1310,
                    env_name="CIC-Test",
                    run_compact="run",
                    env=self.env,
                    dry_run=False,
                    run_backfill=True,
                    limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                    log=self.log,
                    history_version="v2",
                )

            self.assertEqual(obs_metrics["aqi_rebuilds_queued_from_obs_repair"], 1)
            self.assertEqual(aqi_metrics["aqi_rebuilds_attempted"], 1)
            self.assertEqual(aqi_metrics["aqi_rebuilds_complete"], 1)
            self.assertEqual(run_obs.call_args.kwargs["output_scope"], "observations_only")
            self.assertEqual(run_obs.call_args.kwargs["history_version"], "v2")
            self.assertEqual(run_aqi.call_args.kwargs["connector_id"], 6)
            self.assertEqual(run_aqi.call_args.kwargs["history_version"], "v2")
        finally:
            conn.close()

    def test_v2_observation_repair_zero_rows_does_not_queue_aqi(self) -> None:
        conn = self._new_source_db()
        cached = self.root / "cached-openaq-empty.csv.gz"
        cached.write_bytes(gzip.compress(b"ok\n"))
        try:
            self._insert_openaq_prior_state(conn, local_cached_path=str(cached))
            gap = {"day_utc": "2026-06-08", "connector_id": 6}
            with mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=str(self.root / "wrapper.sh")), \
                 mock.patch.object(MODULE, "run_narrow_backfill", return_value={
                     "status": "ok",
                     "exit_code": 0,
                     "rows_observations": 0,
                     "source_connector_day_complete_events": 0,
                     "source_connector_day_skipped_events": 1,
                     "stdout_tail": "",
                     "stderr_tail": "",
                     "log_path": None,
                 }) as run_bf:
                metrics = MODULE.run_v2_gap_backfills(
                    conn=conn,
                    run_id=131,
                    env_name="CIC-Test",
                    run_compact="run",
                    env=self.env,
                    v2_observations={"gaps": [gap]},
                    dry_run=False,
                    run_backfill=True,
                    limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                    log=self.log,
                )

            self.assertEqual(metrics["v2_observation_repairs_no_rows"], 1)
            self.assertEqual(metrics["v2_observation_repairs_ok"], 0)
            self.assertEqual(metrics["aqi_rebuilds_queued_from_obs_repair"], 0)
            self.assertEqual(metrics["planned_aqi_rebuilds"], [])
            self.assertEqual(metrics["v2_observation_repair_results"][0]["status"], "no_observations")
            self.assertEqual(run_bf.call_count, 1)
            queued = conn.execute("SELECT COUNT(*) FROM aqi_rebuild_queue").fetchone()[0]
            self.assertEqual(int(queued), 0)
        finally:
            conn.close()

    def test_v2_observation_repair_wrapper_failure_does_not_queue_aqi(self) -> None:
        conn = self._new_source_db()
        cached = self.root / "cached-openaq-fail.csv.gz"
        cached.write_bytes(gzip.compress(b"ok\n"))
        try:
            self._insert_openaq_prior_state(conn, local_cached_path=str(cached))
            gap = {"day_utc": "2026-06-08", "connector_id": 6}
            with mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=str(self.root / "wrapper.sh")), \
                 mock.patch.object(MODULE, "run_narrow_backfill", return_value={
                     "status": "error",
                     "exit_code": 1,
                     "error": "wrapper exit_code=1",
                     "stdout_tail": "mock stdout line",
                     "stderr_tail": "mock stderr line",
                     "log_path": str(self.root / "logs" / "mock-wrapper.log"),
                 }) as run_bf:
                metrics = MODULE.run_v2_gap_backfills(
                    conn=conn,
                    run_id=32,
                    env_name="CIC-Test",
                    run_compact="run",
                    env=self.env,
                    v2_observations={"gaps": [gap]},
                    dry_run=False,
                    run_backfill=True,
                    limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                    log=self.log,
                )

            self.assertEqual(metrics["v2_observation_repairs_attempted"], 1)
            self.assertEqual(metrics["v2_observation_repairs_failed"], 1)
            self.assertEqual(metrics["observation_backfills_attempted"], 1)
            self.assertEqual(metrics["observation_backfills_failed"], 1)
            self.assertEqual(metrics["v2_observation_index_rebuilds_failed"], 1)
            self.assertEqual(metrics["aqi_rebuilds_queued_from_obs_repair"], 0)
            self.assertEqual(metrics["planned_aqi_rebuilds"], [])
            result = metrics["v2_observation_repair_results"][0]
            self.assertEqual(result["exit_code"], 1)
            self.assertEqual(result["stdout_tail"], "mock stdout line")
            self.assertEqual(result["stderr_tail"], "mock stderr line")
            self.assertEqual(result["failed_chunks"], 1)
            self.assertEqual(gap["suggested_repair"]["kind"], "source_to_v2_observations_backfill")
            self.assertEqual(run_bf.call_args.kwargs["history_version"], "v2")
            queued = conn.execute("SELECT COUNT(*) FROM aqi_rebuild_queue").fetchone()[0]
            self.assertEqual(int(queued), 0)
        finally:
            conn.close()

    def test_v2_observation_repair_markdown_includes_wrapper_output_tail(self) -> None:
        cross_check = {
            "ran": True,
            "observation_backfills_attempted": 1,
            "observation_backfills_failed": 1,
            "v2_observation_repair_results": [
                {
                    "day_utc": "2026-06-08",
                    "connector_id": 6,
                    "history_version": "v2",
                    "status": "failed",
                    "wrapper_status": "error",
                    "exit_code": 1,
                    "error": "wrapper exit_code=1",
                    "stdout_tail": "mock stdout before failure",
                    "stderr_tail": "mock stderr explains failure",
                    "log_path": str(self.root / "logs" / "mock-wrapper.log"),
                    "chunk_count": 1,
                    "attempted_chunks": 1,
                    "failed_chunks": 1,
                    "source_cache": {"status": "ok"},
                }
            ],
        }

        markdown = MODULE.format_summary_md(self._summary_for_cross_check(cross_check))

        self.assertIn("### V2 observation repair results", markdown)
        self.assertIn("connector=6 day=2026-06-08 status=failed", markdown)
        self.assertIn("source_cache=ok", markdown)
        self.assertIn("AQI rebuild was not queued", markdown)
        self.assertIn("exit_code=1", markdown)
        self.assertIn("mock stdout before failure", markdown)
        self.assertIn("mock stderr explains failure", markdown)

    def test_v2_observation_repair_chunks_many_timeseries_and_queues_aqi_once_after_all_success(self) -> None:
        conn = self._new_source_db(timeseries_ids=(101, 102, 103, 104, 105))
        cached = self.root / "cached-openaq-chunked.csv.gz"
        cached.write_bytes(gzip.compress(b"ok\n"))
        try:
            self._insert_openaq_prior_state(conn, local_cached_path=str(cached))
            self._write_v2_observation_connector_manifest(
                timeseries_row_counts={101: 1, 102: 1, 103: 1, 104: 1, 105: 1},
                pollutant_codes=["pm25"],
            )
            ok_results = [
                self._staged_obs_repair_result(rows=2, source_counts={101: 1, 102: 1}, pollutant_codes=["pm25"]),
                self._staged_obs_repair_result(rows=4, source_counts={103: 1, 104: 1}, pollutant_codes=["pm25"]),
                self._ok_obs_repair_result(rows=5, source_counts={105: 1}, pollutant_codes=["pm25"]),
            ]
            with mock.patch.dict(os.environ, {MODULE._V2_OBSERVATION_REPAIR_CHUNK_ENV_VAR: "2"}), \
                 mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=str(self.root / "wrapper.sh")), \
                 mock.patch.object(MODULE, "run_narrow_backfill", side_effect=ok_results) as run_bf:
                metrics = MODULE.run_v2_gap_backfills(
                    conn=conn,
                    run_id=33,
                    env_name="CIC-Test",
                    run_compact="run",
                    env=self.env,
                    v2_observations={"gaps": [{"day_utc": "2026-06-08", "connector_id": 6}]},
                    dry_run=False,
                    run_backfill=True,
                    limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                    log=self.log,
                )

            self.assertEqual(run_bf.call_count, 3)
            self.assertEqual([call.kwargs["timeseries_ids"] for call in run_bf.call_args_list], [[101, 102], [103, 104], [105]])
            self.assertEqual(run_bf.call_args_list[0].kwargs["extra_env"]["UK_AQ_BACKFILL_INTEGRITY_PROPOSAL_FINALIZE"], "false")
            self.assertEqual(run_bf.call_args_list[1].kwargs["extra_env"]["UK_AQ_BACKFILL_INTEGRITY_PROPOSAL_FINALIZE"], "false")
            self.assertEqual(run_bf.call_args_list[2].kwargs["extra_env"]["UK_AQ_BACKFILL_INTEGRITY_PROPOSAL_FINALIZE"], "true")
            self.assertEqual(run_bf.call_args_list[2].kwargs["extra_env"]["UK_AQ_BACKFILL_INTEGRITY_PROPOSAL_CLEANUP"], "false")
            self.assertEqual(metrics["v2_observation_repairs_attempted"], 3)
            self.assertEqual(metrics["observation_backfills_attempted"], 3)
            self.assertEqual(metrics["v2_observation_repairs_ok"], 1)
            self.assertEqual(metrics["observation_backfills_ok"], 1)
            self.assertEqual(metrics["v2_observation_repairs_failed"], 0)
            self.assertEqual(metrics["aqi_rebuilds_queued_from_obs_repair"], 1)
            self.assertEqual(metrics["v2_observation_repair_results"][0]["chunk_count"], 3)
            self.assertEqual(metrics["v2_observation_repair_results"][0]["ok_chunks"], 3)
            self.assertTrue(metrics["v2_observation_repair_results"][0]["aqi_rebuild_guard_ok"])
            self.assertEqual(metrics["v2_observation_repair_results"][0]["integrity_proposal_chunk_staged_events"], 2)
            queued = conn.execute("SELECT COUNT(*) FROM aqi_rebuild_queue WHERE connector_id = 6 AND history_version = 'v2'").fetchone()[0]
            self.assertEqual(int(queued), 1)
        finally:
            conn.close()

    def test_v2_observation_repair_guard_blocks_aqi_when_chunked_repairs_publish_each_chunk(self) -> None:
        conn = self._new_source_db(timeseries_ids=(101, 102, 103, 104, 105))
        cached = self.root / "cached-openaq-chunked-unguarded.csv.gz"
        cached.write_bytes(gzip.compress(b"ok\n"))
        try:
            self._insert_openaq_prior_state(conn, local_cached_path=str(cached))
            with mock.patch.dict(os.environ, {MODULE._V2_OBSERVATION_REPAIR_CHUNK_ENV_VAR: "2"}), \
                 mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=str(self.root / "wrapper.sh")), \
                 mock.patch.object(MODULE, "run_narrow_backfill", side_effect=[
                     self._ok_obs_repair_result(rows=2),
                     self._ok_obs_repair_result(rows=2),
                     self._ok_obs_repair_result(rows=1),
                 ]):
                metrics = MODULE.run_v2_gap_backfills(
                    conn=conn,
                    run_id=133,
                    env_name="CIC-Test",
                    run_compact="run",
                    env=self.env,
                    v2_observations={"gaps": [{"day_utc": "2026-06-08", "connector_id": 6}]},
                    dry_run=False,
                    run_backfill=True,
                    limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                    log=self.log,
                )

            self.assertEqual(metrics["v2_observation_repairs_ok"], 0)
            self.assertEqual(metrics["v2_observation_repairs_guard_failed"], 1)
            self.assertEqual(metrics["aqi_rebuilds_queued_from_obs_repair"], 0)
            result = metrics["v2_observation_repair_results"][0]
            self.assertEqual(result["status"], "guard_failed")
            self.assertFalse(result["aqi_rebuild_guard_ok"])
            self.assertIn("integrity_proposal_chunk_staged_events=0", result["aqi_rebuild_guard_reason"])
            queued = conn.execute("SELECT COUNT(*) FROM aqi_rebuild_queue").fetchone()[0]
            self.assertEqual(int(queued), 0)
        finally:
            conn.close()

    def test_v2_observation_repair_guard_blocks_aqi_when_final_manifest_misses_repaired_timeseries(self) -> None:
        conn = self._new_source_db(timeseries_ids=(101, 102))
        cached = self.root / "cached-openaq-manifest-missing-timeseries.csv.gz"
        cached.write_bytes(gzip.compress(b"ok\n"))
        try:
            self._insert_openaq_prior_state(conn, local_cached_path=str(cached))
            self._write_v2_observation_connector_manifest(
                timeseries_row_counts={101: 1},
                pollutant_codes=["pm25"],
                declared_row_count=2,
            )
            with mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=str(self.root / "wrapper.sh")), \
                 mock.patch.object(
                     MODULE,
                     "run_narrow_backfill",
                     return_value=self._ok_obs_repair_result(
                         rows=2,
                         source_counts={101: 1, 102: 1},
                         repaired_counts={101: 1, 102: 1},
                         pollutant_codes=["pm25"],
                     ),
                 ):
                metrics = MODULE.run_v2_gap_backfills(
                    conn=conn,
                    run_id=134,
                    env_name="CIC-Test",
                    run_compact="run",
                    env=self.env,
                    v2_observations={"gaps": [{"day_utc": "2026-06-08", "connector_id": 6}]},
                    dry_run=False,
                    run_backfill=True,
                    limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                    log=self.log,
                )

            self.assertEqual(metrics["v2_observation_repairs_ok"], 0)
            self.assertEqual(metrics["v2_observation_repairs_guard_failed"], 1)
            self.assertEqual(metrics["aqi_rebuilds_queued_from_obs_repair"], 0)
            result = metrics["v2_observation_repair_results"][0]
            self.assertEqual(result["status"], "guard_failed")
            self.assertFalse(result["aqi_rebuild_manifest_guard_ok"])
            self.assertEqual(result["aqi_rebuild_manifest_guard_reason"], "manifest_missing_timeseries")
            self.assertEqual(result["aqi_rebuild_manifest_guard"]["missing_timeseries_ids"], [102])
            queued = conn.execute("SELECT COUNT(*) FROM aqi_rebuild_queue").fetchone()[0]
            self.assertEqual(int(queued), 0)
        finally:
            conn.close()

    def test_sos_one_day_guard_ignores_other_annual_csv_days_and_pollutants(self) -> None:
        conn = self._new_current_source_db(
            day_utc="2026-05-17",
            connector_id=1,
            source_key=MODULE.SOS_SOURCE_KEY,
            timeseries_pollutants={101: "pm10", 102: "pm25", 103: "no2"},
            source_counts={101: 24, 102: 24, 103: 24},
        )
        self._mark_source_as_sos_flat_file(
            conn,
            extra_day_counts={
                "2026-05-16": {101: 24, 102: 24, 103: 24},
                "2026-05-18": {101: 24, 102: 24, 103: 24},
            },
        )
        try:
            self._write_v2_observation_connector_manifest(
                day_utc="2026-05-17",
                connector_id=1,
                timeseries_row_counts={101: 24, 102: 30, 103: 30},
                pollutant_codes=["pm10", "pm25", "no2"],
            )
            with mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=str(self.root / "wrapper.sh")), \
                 mock.patch.object(
                     MODULE,
                     "run_narrow_backfill",
                     return_value=self._ok_obs_repair_result(
                         rows=24,
                         source_counts={101: 7200},
                         repaired_counts={101: 24},
                         pollutant_codes=["pm10"],
                     ),
                 ) as run_bf:
                metrics = MODULE.run_v2_gap_backfills(
                    conn=conn,
                    run_id=201,
                    env_name="CIC-Test",
                    run_compact="run",
                    env=self.env,
                    v2_observations={
                        "source_scope": {"source": "sos", "connector_ids": [1], "scope": "source"},
                        "gaps": [{"day_utc": "2026-05-17", "connector_id": 1, "pollutant_code": "pm10"}],
                    },
                    dry_run=False,
                    run_backfill=True,
                    limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                    log=self.log,
                )

            self.assertEqual(run_bf.call_args.kwargs["timeseries_ids"], [101])
            self.assertEqual(metrics["v2_observation_repairs_ok"], 1)
            self.assertEqual(metrics["aqi_rebuilds_queued_from_obs_repair"], 1)
            result = metrics["v2_observation_repair_results"][0]
            self.assertEqual(result["expected_counts_source"], "source_file_timeseries_counts")
            self.assertEqual(result["expected_source_rows_for_day"], 24)
            self.assertEqual(result["expected_timeseries_row_counts_for_day"], {"101": 24})
            self.assertEqual(result["expected_pollutant_codes"], ["pm10"])
            self.assertEqual(result["source_rows_from_counts"], 7200)
            self.assertTrue(result["aqi_rebuild_guard_ok"])
        finally:
            conn.close()

    def test_sos_chunked_guard_merges_day_counts_once(self) -> None:
        conn = self._new_current_source_db(
            day_utc="2026-05-17",
            connector_id=1,
            source_key=MODULE.SOS_SOURCE_KEY,
            timeseries_pollutants={101: "pm10", 102: "pm10"},
            source_counts={101: 24, 102: 23},
        )
        self._mark_source_as_sos_flat_file(
            conn,
            extra_day_counts={
                "2026-05-16": {101: 24, 102: 24},
                "2026-05-18": {101: 24, 102: 24},
            },
        )
        try:
            self._write_v2_observation_connector_manifest(
                day_utc="2026-05-17",
                connector_id=1,
                timeseries_row_counts={101: 24, 102: 23},
                pollutant_codes=["pm10"],
            )
            results = [
                self._staged_obs_repair_result(rows=24, source_counts={101: 7000}, pollutant_codes=["pm10"]),
                self._ok_obs_repair_result(rows=47, source_counts={102: 6900}, pollutant_codes=["pm10"]),
            ]
            with mock.patch.dict(os.environ, {MODULE._V2_OBSERVATION_REPAIR_CHUNK_ENV_VAR: "1"}), \
                 mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=str(self.root / "wrapper.sh")), \
                 mock.patch.object(MODULE, "run_narrow_backfill", side_effect=results) as run_bf:
                metrics = MODULE.run_v2_gap_backfills(
                    conn=conn,
                    run_id=202,
                    env_name="CIC-Test",
                    run_compact="run",
                    env=self.env,
                    v2_observations={
                        "source_scope": {"source": "sos", "connector_ids": [1], "scope": "source"},
                        "gaps": [{"day_utc": "2026-05-17", "connector_id": 1, "pollutant_code": "pm10"}],
                    },
                    dry_run=False,
                    run_backfill=True,
                    limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                    log=self.log,
                )

            self.assertEqual([call.kwargs["timeseries_ids"] for call in run_bf.call_args_list], [[101], [102]])
            result = metrics["v2_observation_repair_results"][0]
            self.assertEqual(result["expected_source_rows_for_day"], 47)
            self.assertEqual(result["expected_timeseries_row_counts_for_day"], {"101": 24, "102": 23})
            self.assertEqual(result["chunks"][0]["chunk_timeseries_ids"], [101])
            self.assertEqual(result["chunks"][0]["chunk_expected_counts"], {"101": 24})
            self.assertEqual(result["chunks"][0]["chunk_expected_rows"], 24)
            self.assertEqual(result["chunks"][1]["chunk_timeseries_ids"], [102])
            self.assertEqual(result["chunks"][1]["chunk_expected_counts"], {"102": 23})
            self.assertEqual(result["chunks"][1]["chunk_expected_rows"], 23)
            self.assertEqual(metrics["v2_observation_repairs_ok"], 1)
            self.assertEqual(metrics["aqi_rebuilds_queued_from_obs_repair"], 1)
        finally:
            conn.close()

    def test_backfill_emitted_source_counts_above_manifest_are_diagnostic_only(self) -> None:
        conn = self._new_source_db(timeseries_ids=(101, 102))
        cached = self.root / "cached-openaq-source-counts-above-manifest.csv.gz"
        cached.write_bytes(gzip.compress(b"ok\n"))
        try:
            self._insert_openaq_prior_state(conn, local_cached_path=str(cached))
            self._write_v2_observation_connector_manifest(
                timeseries_row_counts={101: 5100, 102: 5101},
                pollutant_codes=["no2", "pm10", "pm25"],
                declared_row_count=10201,
            )
            with mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=str(self.root / "wrapper.sh")), \
                 mock.patch.object(
                     MODULE,
                     "run_narrow_backfill",
                     return_value=self._ok_obs_repair_result(
                         rows=10201,
                         source_counts={101: 6000, 102: 4313},
                         pollutant_codes=["no2", "pm10", "pm25"],
                     ),
                 ):
                metrics = MODULE.run_v2_gap_backfills(
                    conn=conn,
                    run_id=135,
                    env_name="CIC-Test",
                    run_compact="run",
                    env=self.env,
                    v2_observations={"gaps": [{"day_utc": "2026-06-08", "connector_id": 6}]},
                    dry_run=False,
                    run_backfill=True,
                    limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                    log=self.log,
                )

            self.assertEqual(metrics["v2_observation_repairs_ok"], 1)
            self.assertEqual(metrics["v2_observation_repairs_guard_failed"], 0)
            self.assertEqual(metrics["aqi_rebuilds_queued_from_obs_repair"], 1)
            result = metrics["v2_observation_repair_results"][0]
            self.assertEqual(result["status"], "ok")
            self.assertTrue(result["aqi_rebuild_guard_ok"])
            self.assertIsNone(result["aqi_rebuild_guard_reason"])
            self.assertEqual(result["source_rows_from_counts"], 10313)
            self.assertEqual(result["expected_counts_source"], "backfill_repaired_rows")
            queued = conn.execute("SELECT COUNT(*) FROM aqi_rebuild_queue").fetchone()[0]
            self.assertEqual(int(queued), 1)
        finally:
            conn.close()

    def test_v2_observation_repair_guard_blocks_when_manifest_rows_below_repaired_rows(self) -> None:
        conn = self._new_source_db(timeseries_ids=(101,))
        cached = self.root / "cached-openaq-manifest-low-rows.csv.gz"
        cached.write_bytes(gzip.compress(b"ok\n"))
        try:
            self._insert_openaq_prior_state(conn, local_cached_path=str(cached))
            self._write_v2_observation_connector_manifest(
                timeseries_row_counts={101: 10000},
                pollutant_codes=["pm25"],
                declared_row_count=10000,
            )
            with mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=str(self.root / "wrapper.sh")), \
                 mock.patch.object(
                     MODULE,
                     "run_narrow_backfill",
                     return_value=self._ok_obs_repair_result(rows=10201, pollutant_codes=["pm25"]),
                 ):
                metrics = MODULE.run_v2_gap_backfills(
                    conn=conn,
                    run_id=136,
                    env_name="CIC-Test",
                    run_compact="run",
                    env=self.env,
                    v2_observations={"gaps": [{"day_utc": "2026-06-08", "connector_id": 6}]},
                    dry_run=False,
                    run_backfill=True,
                    limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                    log=self.log,
                )

            self.assertEqual(metrics["v2_observation_repairs_guard_failed"], 1)
            result = metrics["v2_observation_repair_results"][0]
            self.assertEqual(result["status"], "guard_failed")
            self.assertEqual(
                result["aqi_rebuild_manifest_guard_reason"],
                "manifest_total_rows_below_expected",
            )
            self.assertEqual(result["aqi_rebuild_manifest_guard"]["shortfall_rows"], 201)
            queued = conn.execute("SELECT COUNT(*) FROM aqi_rebuild_queue").fetchone()[0]
            self.assertEqual(int(queued), 0)
        finally:
            conn.close()

    def test_v2_observation_repair_guard_detects_per_timeseries_shortfall(self) -> None:
        conn = self._new_source_db(timeseries_ids=(101, 102))
        cached = self.root / "cached-openaq-timeseries-shortfall.csv.gz"
        cached.write_bytes(gzip.compress(b"ok\n"))
        try:
            self._insert_openaq_prior_state(conn, local_cached_path=str(cached))
            self._write_v2_observation_connector_manifest(
                timeseries_row_counts={101: 4, 102: 6},
                pollutant_codes=["pm25"],
                declared_row_count=10,
            )
            with mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=str(self.root / "wrapper.sh")), \
                 mock.patch.object(
                     MODULE,
                     "run_narrow_backfill",
                     return_value=self._ok_obs_repair_result(
                         rows=10,
                         source_counts={101: 5, 102: 5},
                         repaired_counts={101: 5, 102: 5},
                         pollutant_codes=["pm25"],
                     ),
                 ):
                metrics = MODULE.run_v2_gap_backfills(
                    conn=conn,
                    run_id=203,
                    env_name="CIC-Test",
                    run_compact="run",
                    env=self.env,
                    v2_observations={"gaps": [{"day_utc": "2026-06-08", "connector_id": 6}]},
                    dry_run=False,
                    run_backfill=True,
                    limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                    log=self.log,
                )

            result = metrics["v2_observation_repair_results"][0]
            self.assertEqual(result["status"], "guard_failed")
            self.assertEqual(
                result["aqi_rebuild_manifest_guard_reason"],
                "manifest_timeseries_rows_below_expected",
            )
            self.assertEqual(result["aqi_rebuild_manifest_guard"]["shortfall_rows"], 1)
            self.assertEqual(metrics["aqi_rebuilds_queued_from_obs_repair"], 0)
        finally:
            conn.close()

    def test_v2_observation_repair_guard_blocks_when_manifest_misses_emitted_pollutant(self) -> None:
        conn = self._new_source_db(timeseries_ids=(101,))
        cached = self.root / "cached-openaq-manifest-missing-pollutant.csv.gz"
        cached.write_bytes(gzip.compress(b"ok\n"))
        try:
            self._insert_openaq_prior_state(conn, local_cached_path=str(cached))
            self._write_v2_observation_connector_manifest(
                timeseries_row_counts={101: 2},
                pollutant_codes=["pm25"],
            )
            with mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=str(self.root / "wrapper.sh")), \
                 mock.patch.object(
                     MODULE,
                     "run_narrow_backfill",
                     return_value=self._ok_obs_repair_result(rows=2, pollutant_codes=["no2"]),
                 ):
                metrics = MODULE.run_v2_gap_backfills(
                    conn=conn,
                    run_id=137,
                    env_name="CIC-Test",
                    run_compact="run",
                    env=self.env,
                    v2_observations={"gaps": [{"day_utc": "2026-06-08", "connector_id": 6}]},
                    dry_run=False,
                    run_backfill=True,
                    limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                    log=self.log,
                )

            self.assertEqual(metrics["v2_observation_repairs_guard_failed"], 1)
            result = metrics["v2_observation_repair_results"][0]
            self.assertEqual(result["status"], "guard_failed")
            self.assertEqual(result["aqi_rebuild_manifest_guard_reason"], "manifest_missing_pollutant")
            queued = conn.execute("SELECT COUNT(*) FROM aqi_rebuild_queue").fetchone()[0]
            self.assertEqual(int(queued), 0)
        finally:
            conn.close()

    def test_v2_observation_repair_chunk_failure_stops_and_does_not_queue_aqi(self) -> None:
        conn = self._new_source_db(timeseries_ids=(101, 102, 103, 104, 105))
        cached = self.root / "cached-openaq-chunked-fail.csv.gz"
        cached.write_bytes(gzip.compress(b"ok\n"))
        try:
            self._insert_openaq_prior_state(conn, local_cached_path=str(cached))
            with mock.patch.dict(os.environ, {MODULE._V2_OBSERVATION_REPAIR_CHUNK_ENV_VAR: "2"}), \
                 mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=str(self.root / "wrapper.sh")), \
                 mock.patch.object(MODULE, "run_narrow_backfill", side_effect=[
                     self._ok_obs_repair_result(rows=2),
                     {
                         "status": "error",
                         "exit_code": 1,
                         "error": "wrapper exit_code=1",
                         "stdout_tail": "chunk stdout",
                         "stderr_tail": "chunk stderr",
                     },
                 ]) as run_bf:
                metrics = MODULE.run_v2_gap_backfills(
                    conn=conn,
                    run_id=34,
                    env_name="CIC-Test",
                    run_compact="run",
                    env=self.env,
                    v2_observations={"gaps": [{"day_utc": "2026-06-08", "connector_id": 6}]},
                    dry_run=False,
                    run_backfill=True,
                    limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                    log=self.log,
                )

            self.assertEqual(run_bf.call_count, 2)
            self.assertEqual(metrics["v2_observation_repairs_attempted"], 2)
            self.assertEqual(metrics["v2_observation_repairs_ok"], 0)
            self.assertEqual(metrics["v2_observation_repairs_failed"], 1)
            self.assertEqual(metrics["observation_backfills_failed"], 1)
            self.assertEqual(metrics["aqi_rebuilds_queued_from_obs_repair"], 0)
            result = metrics["v2_observation_repair_results"][0]
            self.assertEqual(result["status"], "failed")
            self.assertEqual(result["failed_chunks"], 1)
            self.assertEqual(result["stderr_tail"], "chunk stderr")
            queued = conn.execute("SELECT COUNT(*) FROM aqi_rebuild_queue").fetchone()[0]
            self.assertEqual(int(queued), 0)
        finally:
            conn.close()

    def test_v2_dry_run_plans_chunked_observation_repairs_with_connector_scope(self) -> None:
        conn = self._new_source_db(timeseries_ids=(101, 102, 103))
        try:
            with mock.patch.dict(os.environ, {MODULE._V2_OBSERVATION_REPAIR_CHUNK_ENV_VAR: "2"}):
                metrics = MODULE.run_v2_gap_backfills(
                    conn=conn,
                    run_id=35,
                    env_name="CIC-Test",
                    run_compact="run",
                    env=self.env,
                    v2_observations={"gaps": [{"day_utc": "2026-06-08", "connector_id": 6}]},
                    dry_run=True,
                    run_backfill=True,
                    limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                    log=self.log,
                )

            self.assertEqual(len(metrics["planned_v2_observation_repairs"]), 2)
            self.assertIn("UK_AQ_BACKFILL_CONNECTOR_IDS=6", metrics["planned_v2_observation_repairs"][0])
            self.assertIn("UK_AQ_BACKFILL_TIMESERIES_IDS=101,102", metrics["planned_v2_observation_repairs"][0])
            self.assertIn("UK_AQ_BACKFILL_TIMESERIES_IDS=103", metrics["planned_v2_observation_repairs"][1])
            self.assertIn("planned_after_obs_repair", metrics["planned_aqi_rebuilds"][0])
        finally:
            conn.close()

    def test_source_evidence_narrows_operator_pollutants_to_no2_and_o3(self) -> None:
        def complete_evidence(*, required_files: int) -> dict[str, object]:
            return {
                "source_partition_state": "successful_non_empty",
                "source_counts_available": True,
                "source_skip_reason": None,
                "unresolved_site_ref_groups": 0,
                "unmapped_site_ref_groups": 0,
                "ambiguous_site_ref_groups": 0,
                "timeseries_conflict_groups": 0,
                "required_source_file_count": required_files,
                "successful_source_file_count": required_files,
            }

        day_utc = "2026-07-15"
        connector_id = 1
        gaps = [
            {
                "day_utc": day_utc,
                "connector_id": connector_id,
                "pollutant_code": "no2",
                "gap_type": "source_r2_timeseries_row_mismatch",
                "source_evidence": complete_evidence(required_files=154),
            },
            {
                "day_utc": day_utc,
                "connector_id": connector_id,
                "pollutant_code": "o3",
                "gap_type": "source_r2_timeseries_row_mismatch",
                "source_evidence": complete_evidence(required_files=95),
            },
            {
                "day_utc": day_utc,
                "connector_id": connector_id,
                "pollutant_code": "pm10",
                "gap_type": "source_mapping_issue",
                "source_evidence": {
                    "source_partition_state": "mapping_unavailable",
                    "source_counts_available": False,
                    "source_skip_reason": "sos_site_ref_bridge_mapping_unresolved",
                    "unresolved_site_ref_groups": 3,
                },
            },
            {
                "day_utc": day_utc,
                "connector_id": connector_id,
                "pollutant_code": "pm25",
                "gap_type": "source_mapping_issue",
                "source_evidence": {
                    "source_partition_state": "mapping_unavailable",
                    "source_counts_available": False,
                    "source_skip_reason": "sos_site_ref_bridge_mapping_unresolved",
                    "unresolved_site_ref_groups": 2,
                },
            },
        ]
        repair_plan = [
            {
                "kind": "observation_data_repair",
                "day_utc": day_utc,
                "connector_id": connector_id,
                "pollutant_code": pollutant,
                "data_changes_required": True,
            }
            for pollutant in ("no2", "o3", "pm10", "pm25")
        ]
        scopes, executable_indexes, skipped = (
            MODULE._derive_executable_observation_repair_pollutants(
                v2_observations={"gaps": gaps, "repair_plan": repair_plan},
                requested_pollutants=["pm25", "pm10", "no2", "o3"],
            )
        )

        self.assertEqual(scopes, {(day_utc, connector_id): ["no2", "o3"]})
        self.assertEqual(executable_indexes, {0, 1})
        self.assertEqual(
            {(entry["pollutant_code"], entry["reason"]) for entry in skipped},
            {
                ("pm10", "source_mapping_issue_is_not_executable"),
                ("pm25", "source_mapping_issue_is_not_executable"),
            },
        )
        planned = MODULE._planned_backfill_command(
            self.env,
            [],
            __import__("datetime").date.fromisoformat(day_utc),
            connector_ids=[connector_id],
            output_scope="observations_only",
            history_version="v2",
            env_name="CIC-Test",
            complete_connector_day=True,
            repair_pollutants=scopes[(day_utc, connector_id)],
        )
        self.assertIn(
            "UK_AQ_BACKFILL_INTEGRITY_REPAIR_POLLUTANTS=no2,o3", planned
        )
        self.assertNotIn("pm10", planned)
        self.assertNotIn("pm25", planned)

    def test_hash_evidence_worker_receives_only_derived_pollutant_subset(self) -> None:
        complete = {
            "source_partition_state": "successful_non_empty",
            "source_counts_available": True,
            "source_skip_reason": None,
            "unresolved_site_ref_groups": 0,
            "unmapped_site_ref_groups": 0,
            "ambiguous_site_ref_groups": 0,
            "timeseries_conflict_groups": 0,
            "required_source_file_count": 2,
            "successful_source_file_count": 2,
        }
        day_utc = "2026-07-15"
        candidates = [
            {
                "day_utc": day_utc,
                "connector_id": 7,
                "pollutant_code": "no2",
                "source_row_count": 1,
                "source_timeseries_row_counts": {"101": 1},
                "source_evidence": complete,
            },
            {
                "day_utc": day_utc,
                "connector_id": 7,
                "pollutant_code": "pm10",
                "source_row_count": 1,
                "source_timeseries_row_counts": {"102": 1},
                "source_evidence": {
                    **complete,
                    "ambiguous_site_ref_groups": 1,
                },
            },
            {
                "day_utc": day_utc,
                "connector_id": 7,
                "pollutant_code": "o3",
                "source_row_count": 0,
                "source_timeseries_row_counts": {},
                "source_evidence": {
                    **complete,
                    "source_partition_state": "successful_empty",
                    "no_authoritative_timeseries_binding_groups": 1,
                },
            },
            {
                "day_utc": day_utc,
                "connector_id": 7,
                "pollutant_code": "pm25",
                "source_row_count": 1,
                "source_timeseries_row_counts": {"103": 1},
                "source_evidence": complete,
            },
        ]
        scopes, skipped = MODULE._derive_observation_hash_check_pollutants(
            candidates=candidates,
            requested_pollutants=["no2", "o3", "pm10"],
        )
        self.assertEqual(scopes, {(day_utc, 7): ["no2"]})
        self.assertEqual(
            skipped[(day_utc, 7, "pm10")],
            "ambiguous_site_ref_groups=1",
        )
        self.assertEqual(skipped[(day_utc, 7, "o3")], "no_executable_source_rows")
        self.assertEqual(
            skipped[(day_utc, 7, "pm25")],
            "outside_operator_requested_pollutant_scope",
        )

    def test_matching_hash_candidate_is_verified_without_observation_rewrite(self) -> None:
        day_utc = "2026-07-15"
        manifest_path = self.root / "manifest.json"
        content_hash = {
            "observation_content_hash": "a" * 64,
            "observation_content_hash_algorithm": "sha256",
            "observation_content_hash_contract_version": 1,
            "observation_content_hash_row_count": 1,
            "observation_content_hash_columns": MODULE.OBSERVATION_CONTENT_HASH_COLUMNS,
            "verification_status_counts": {"P": 1, "R": 0, "null": 0},
        }
        manifest_path.write_text(json.dumps(content_hash), encoding="utf-8")
        (self.root / "R2_history_backup").mkdir()
        candidate = {
            "day_utc": day_utc,
            "connector_id": 7,
            "pollutant_code": "no2",
            "manifest_path": str(manifest_path),
            "manifest_rel": "history/v2/observations/no2/manifest.json",
            "parquet_paths": [],
            "source_row_count": 1,
            "source_timeseries_row_counts": {"101": 1},
            "source_evidence": {
                "source_partition_state": "successful_non_empty",
                "source_counts_available": True,
                "source_skip_reason": None,
                "unresolved_site_ref_groups": 0,
                "unmapped_site_ref_groups": 0,
                "ambiguous_site_ref_groups": 0,
                "timeseries_conflict_groups": 0,
                "required_source_file_count": 1,
                "successful_source_file_count": 1,
            },
        }
        observations = {
            "gaps": [],
            "hash_check_candidates": [candidate],
            "hash_candidates_by_pollutant": {"no2": 1},
        }
        captured_pollutants = []

        def fake_backfill(**kwargs):
            captured_pollutants.append(kwargs.get("repair_pollutants"))
            return {"status": "ok"}

        evidence = {"observation_content_hashes": {"no2": content_hash}}
        with (
            mock.patch.object(MODULE, "run_narrow_backfill", side_effect=fake_backfill),
            mock.patch.object(
                MODULE,
                "_load_complete_connector_day_source_evidence",
                return_value=(evidence, []),
            ),
            mock.patch.object(
                MODULE,
                "_persist_complete_connector_day_source_evidence",
            ),
        ):
            metrics = MODULE.run_v2_observation_content_hash_checks(
                conn=self.conn,
                env_name="CIC-Test",
                run_compact="focused",
                env=self.env,
                v2_observations=observations,
                source_scope={"source": "sos"},
                log=self.log,
                repair_pollutants=["no2", "pm10"],
            )

        self.assertEqual(captured_pollutants, [["no2"]])
        self.assertEqual(metrics["verified"], 1)
        self.assertEqual(observations["gaps"], [])
        self.assertFalse(any(
            action.get("kind") == "observation_data_repair"
            for action in observations["repair_plan"]
        ))

    def test_all_pollutant_repair_requires_complete_source_for_every_pollutant(self) -> None:
        day_utc = "2026-07-15"
        connector_id = 1
        complete = {
            "source_partition_state": "successful_non_empty",
            "source_counts_available": True,
            "unresolved_site_ref_groups": 0,
            "unmapped_site_ref_groups": 0,
            "ambiguous_site_ref_groups": 0,
            "timeseries_conflict_groups": 0,
            "required_source_file_count": 1,
            "successful_source_file_count": 1,
        }
        incomplete = {
            **complete,
            "source_partition_state": "mapping_unavailable",
            "source_skip_reason": "mapping_unavailable",
        }
        observations = {
            "gaps": [{
                "day_utc": day_utc,
                "connector_id": connector_id,
                "gap_type": "day_dir_missing",
            }],
            "repair_plan": [{
                "kind": "observation_data_repair",
                "day_utc": day_utc,
                "connector_id": connector_id,
                "pollutant_code": None,
                "data_changes_required": True,
            }],
            "source_resolution_by_pollutant": {
                "no2": complete,
                "o3": complete,
                "pm10": incomplete,
                "pm25": complete,
            },
        }
        scopes, executable_indexes, skipped = (
            MODULE._derive_executable_observation_repair_pollutants(
                v2_observations=observations,
                requested_pollutants=["pm25", "pm10", "no2", "o3"],
            )
        )
        self.assertEqual(scopes, {})
        self.assertEqual(executable_indexes, set())
        self.assertIn("pm10:source_partition_state=mapping_unavailable", skipped[0]["reason"])

        observations["source_resolution_by_pollutant"]["pm10"] = complete
        scopes, executable_indexes, skipped = (
            MODULE._derive_executable_observation_repair_pollutants(
                v2_observations=observations,
                requested_pollutants=["pm25", "pm10", "no2", "o3"],
            )
        )
        self.assertEqual(
            scopes,
            {(day_utc, connector_id): ["no2", "o3", "pm10", "pm25"]},
        )
        self.assertEqual(executable_indexes, {0})
        self.assertEqual(skipped, [])

    def test_sos_missing_connector_enters_explicit_pollutant_scoped_repair(self) -> None:
        day_utc = "2026-07-27"
        connector_id = 1

        def source_counts(*_args, **kwargs):
            pollutant_code = kwargs["pollutant_code"]
            timeseries_id = {
                "no2": 101,
                "o3": 102,
                "pm10": 103,
                "pm25": 104,
            }[pollutant_code]
            return ({timeseries_id: 24}, {
                "source_partition_state": "successful_non_empty",
                "source_counts_present": True,
                "source_counts_available": True,
                "source_skip_reason": None,
                "source_rows": 24,
                "unresolved_site_ref_groups": 0,
                "unmapped_site_ref_groups": 0,
                "ambiguous_site_ref_groups": 0,
                "timeseries_conflict_groups": 0,
                "required_source_file_count": 1,
                "successful_source_file_count": 1,
            })

        config = MODULE.resolve_history_path_config("v2", {})
        day_dir = (
            self.root
            / config.observations_data_prefix.strip("/")
            / f"day_utc={day_utc}"
        )
        day_dir.mkdir(parents=True)
        with mock.patch.object(
            MODULE,
            "_current_source_counts_for_v2_partition",
            side_effect=source_counts,
        ) as source_counts_mock:
            observations = MODULE.run_v2_observations_integrity_checks(
                r2_history_root=self.root,
                config=config,
                from_day=day_utc,
                to_day=day_utc,
                conn=self.conn,
                env_name="CIC-Test",
                allowed_connector_ids={connector_id},
                source_scope={
                    "source": "sos",
                    "connector_ids": [connector_id],
                    "scope": "source",
                },
            )

        gap = next(
            item for item in observations["gaps"]
            if item["gap_type"] == "connector_dir_missing"
        )
        self.assertIsNone(gap.get("pollutant_code"))
        self.assertEqual(
            gap["suggested_repair"]["kind"],
            "uk_air_csv_to_v2_observations_backfill_required",
        )
        self.assertEqual(
            sorted(gap["source_evidence_by_pollutant"]),
            ["no2", "o3", "pm10", "pm25"],
        )
        self.assertEqual(source_counts_mock.call_count, 4)
        action = next(
            item for item in observations["repair_plan"]
            if item["kind"] == "observation_data_repair"
        )
        self.assertEqual(action["day_utc"], day_utc)
        self.assertEqual(action["connector_id"], connector_id)
        self.assertIsNone(action["pollutant_code"])

        scopes, executable_indexes, skipped = (
            MODULE._derive_executable_observation_repair_pollutants(
                v2_observations=observations,
                requested_pollutants=["pm25", "pm10", "no2", "o3"],
            )
        )
        self.assertEqual(
            scopes,
            {(day_utc, connector_id): ["no2", "o3", "pm10", "pm25"]},
        )
        self.assertEqual(executable_indexes, {
            observations["gaps"].index(gap),
        })
        self.assertEqual(skipped, [])
        self.assertFalse(any(
            item["reason"] == "not_explicit_observation_data_repair"
            for item in skipped
        ))
        planned = MODULE._planned_backfill_command(
            self.env,
            [],
            MODULE.dt.date.fromisoformat(day_utc),
            connector_ids=[connector_id],
            output_scope="observations_only",
            history_version="v2",
            env_name="CIC-Test",
            complete_connector_day=True,
            repair_pollutants=scopes[(day_utc, connector_id)],
        )
        self.assertIn(
            "UK_AQ_BACKFILL_INTEGRITY_REPAIR_POLLUTANTS=no2,o3,pm10,pm25",
            planned,
        )
        self.assertNotIn("source_evidence_missing", planned)

        no_scope, no_indexes, no_scope_skips = (
            MODULE._derive_executable_observation_repair_pollutants(
                v2_observations=observations,
                requested_pollutants=[],
            )
        )
        self.assertEqual(no_scope, {})
        self.assertEqual(no_indexes, set())
        self.assertEqual(
            no_scope_skips[0]["reason"],
            "explicit_repair_pollutants_required_for_wildcard_repair",
        )

        exact_pollutant_plan = MODULE.build_v2_repair_plan(
            observation_gaps=[{
                "gap_type": "pollutant_dir_missing",
                "day_utc": day_utc,
                "connector_id": connector_id,
                "pollutant_code": "pm25",
                "suggested_repair": {
                    "kind": "uk_air_csv_to_v2_observations_backfill_required",
                },
            }],
        )
        exact_action = next(
            item for item in exact_pollutant_plan
            if item["kind"] == "observation_data_repair"
        )
        self.assertEqual(exact_action["pollutant_code"], "pm25")
        ambiguous_pollutant_plan = MODULE.build_v2_repair_plan(
            observation_gaps=[{
                "gap_type": "pollutant_dir_missing",
                "day_utc": day_utc,
                "connector_id": connector_id,
                "suggested_repair": {
                    "kind": "uk_air_csv_to_v2_observations_backfill_required",
                },
            }],
        )
        self.assertFalse(any(
            item["kind"] == "observation_data_repair"
            for item in ambiguous_pollutant_plan
        ))

        current_state = MODULE.run_current_state_reconciliation(
            conn=self.conn,
            env_name="CIC-Test",
            integrity_run_id="CIC-Test:focused-missing-connector",
            env={
                "UK_AQ_INTEGRITY_CURRENT_STATE_RECONCILIATION_ENABLED": "true",
            },
            scope_entries=[],
            dry_run=False,
            final_verification={"status": "fail"},
            log=self.log,
        )
        self.assertFalse(current_state["attempted"])
        self.assertEqual(current_state["overall_status"], "blocked_dependency")

    def test_exact_pollutant_repair_requires_explicit_matching_scope(self) -> None:
        day_utc = "2026-07-27"
        connector_id = 1
        gap = {
            "gap_type": "pollutant_dir_missing",
            "day_utc": day_utc,
            "connector_id": connector_id,
            "pollutant_code": "pm25",
            "source_evidence": {
                "source_partition_state": "successful_non_empty",
                "source_counts_available": True,
                "source_skip_reason": None,
                "unresolved_site_ref_groups": 0,
                "unmapped_site_ref_groups": 0,
                "ambiguous_site_ref_groups": 0,
                "timeseries_conflict_groups": 0,
                "required_source_file_count": 1,
                "successful_source_file_count": 1,
            },
            "suggested_repair": {
                "kind": "uk_air_csv_to_v2_observations_backfill_required",
            },
        }
        repair_plan = MODULE.build_v2_repair_plan(
            observation_gaps=[gap],
        )
        action = next(
            item for item in repair_plan
            if item["kind"] == "observation_data_repair"
        )
        self.assertEqual(action["pollutant_code"], "pm25")
        observations = {"gaps": [gap], "repair_plan": repair_plan}

        scopes, executable_indexes, skipped = (
            MODULE._derive_executable_observation_repair_pollutants(
                v2_observations=observations,
                requested_pollutants=[],
            )
        )
        self.assertEqual(scopes, {})
        self.assertEqual(executable_indexes, set())
        self.assertEqual(
            skipped[0]["reason"],
            "explicit_repair_pollutants_required_for_exact_repair",
        )
        metrics = MODULE.run_v2_gap_backfills(
            conn=self.conn,
            run_id=4,
            env_name="CIC-Test",
            run_compact="run",
            env=self.env,
            v2_observations=observations,
            dry_run=True,
            run_backfill=True,
            limits=MODULE.LimitTracker(
                max_download_mb=0,
                max_runtime_minutes=0,
                started_mono=0.0,
            ),
            log=self.log,
            repair_pollutants=[],
        )
        self.assertEqual(metrics["planned_v2_observation_repairs"], [])
        self.assertEqual(metrics["observation_backfill_candidate_days"], 0)
        self.assertEqual(
            metrics["skipped_v2_observation_metadata_gaps"][0]["reason"],
            "explicit_repair_pollutants_required_for_exact_repair",
        )

        scopes, executable_indexes, skipped = (
            MODULE._derive_executable_observation_repair_pollutants(
                v2_observations=observations,
                requested_pollutants=["pm25"],
            )
        )
        self.assertEqual(scopes, {(day_utc, connector_id): ["pm25"]})
        self.assertEqual(executable_indexes, {0})
        self.assertEqual(skipped, [])

        scopes, executable_indexes, skipped = (
            MODULE._derive_executable_observation_repair_pollutants(
                v2_observations=observations,
                requested_pollutants=["no2"],
            )
        )
        self.assertEqual(scopes, {})
        self.assertEqual(executable_indexes, set())
        self.assertEqual(
            skipped[0]["reason"],
            "outside_operator_requested_pollutant_scope",
        )

    def test_v2_missing_day_gap_is_planned_with_explicit_pollutant_scope(self) -> None:
        metrics = MODULE.run_v2_gap_backfills(
            conn=self.conn,
            run_id=3,
            env_name="CIC-Test",
            run_compact="run",
            env=self.env,
            v2_observations={"gaps": [{
                "day_utc": "2026-06-08",
                "connector_id": 6,
                "gap_type": "day_dir_missing",
                "expected_path": "history/v2/observations/day_utc=2026-06-08/connector_id=6",
            }]},
            dry_run=True,
            run_backfill=True,
            limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
            log=self.log,
            repair_pollutants=["pm25"],
        )

        self.assertEqual(len(metrics["planned_v2_observation_repairs"]), 1)
        self.assertIn("UK_AQ_BACKFILL_CONNECTOR_IDS=6", metrics["planned_v2_observation_repairs"][0])
        self.assertIn(
            "UK_AQ_BACKFILL_INTEGRITY_REPAIR_POLLUTANTS=pm25",
            metrics["planned_v2_observation_repairs"][0],
        )

    def test_v2_post_repair_recheck_reports_fixed_observations_and_failed_aqi(self) -> None:
        config = MODULE.resolve_history_path_config("v2", {})
        with mock.patch.object(MODULE, "run_v2_observations_integrity_checks", return_value={
            "status": "ok",
            "checked_partitions": 1,
            "gap_count": 0,
            "gaps": [],
        }) as obs_check, mock.patch.object(MODULE, "run_v2_aqilevels_integrity_checks", return_value={
            "status": "fail",
            "checked_partitions": 0,
            "gap_count": 1,
            "gaps": [{"gap_type": "connector_dir_missing", "day_utc": "2026-06-08", "connector_id": 6}],
            "debug": {"checked": False, "required": False, "status": "skipped", "gap_count": 0, "gaps": []},
        }) as aqi_check:
            result = MODULE.run_v2_post_repair_integrity_rechecks(
                r2_history_root=self.root,
                config=config,
                from_day="2026-06-08",
                to_day="2026-06-08",
                allowed_connector_ids={6},
                source_scope={"source": "openaq", "connector_ids": [6], "scope": "source"},
                check_aqi_debug=False,
                require_aqi_debug=False,
                log=self.log,
            )

        self.assertEqual(result["status"], "fail")
        self.assertEqual(result["message"], "v2 observations fixed; v2 AQI still failing")
        self.assertEqual(result["remaining_observation_gap_count"], 0)
        self.assertEqual(result["remaining_aqi_gap_count"], 1)
        self.assertEqual(result["remaining_aqi_debug_gap_count"], 0)
        obs_check.assert_called_once()
        aqi_check.assert_called_once()
        self.assertEqual(obs_check.call_args.kwargs["allowed_connector_ids"], {6})
        self.assertEqual(aqi_check.call_args.kwargs["allowed_connector_ids"], {6})

    def test_v2_post_repair_recheck_final_status_ok_only_when_observations_and_aqi_pass(self) -> None:
        config = MODULE.resolve_history_path_config("v2", {})
        for obs_status, aqi_status, expected in (
            ("ok", "ok", "ok"),
            ("ok", "fail", "fail"),
            ("fail", "ok", "fail"),
            ("fail", "fail", "fail"),
        ):
            with self.subTest(obs_status=obs_status, aqi_status=aqi_status), \
                 mock.patch.object(MODULE, "run_v2_observations_integrity_checks", return_value={
                     "status": obs_status, "checked_partitions": 1, "gap_count": 0 if obs_status == "ok" else 1, "gaps": [],
                 }), \
                 mock.patch.object(MODULE, "run_v2_aqilevels_integrity_checks", return_value={
                     "status": aqi_status,
                     "checked_partitions": 1,
                     "gap_count": 0 if aqi_status == "ok" else 1,
                     "gaps": [],
                     "debug": {"checked": False, "required": False, "status": "skipped", "gap_count": 0, "gaps": []},
                 }):
                result = MODULE.run_v2_post_repair_integrity_rechecks(
                    r2_history_root=self.root,
                    config=config,
                    from_day="2026-06-08",
                    to_day="2026-06-08",
                    allowed_connector_ids={6},
                    source_scope={"source": "openaq", "connector_ids": [6], "scope": "source"},
                    check_aqi_debug=False,
                    require_aqi_debug=False,
                    log=self.log,
                )
            self.assertEqual(result["status"], expected)

    def test_adapter_backfill_history_version_is_v2_only_for_v2_mode(self) -> None:
        self.assertEqual(MODULE.adapter_backfill_history_version("v2"), "v2")
        with self.assertRaisesRegex(ValueError, "v2 only"):
            MODULE.adapter_backfill_history_version("v1")
        with self.assertRaisesRegex(ValueError, "v2 only"):
            MODULE.adapter_backfill_history_version("both")

    def test_openaq_unchanged_metadata_without_cache_does_not_force_download(self) -> None:
        conn = self._new_source_db()
        try:
            self._insert_openaq_prior_state(conn, local_cached_path=None)
            with mock.patch.object(MODULE, "_http_head", return_value={
                "status": 200,
                "content_length": 32,
                "etag": '"etag-1"',
                "last_modified": "2026-06-09T00:00:00Z",
            }), mock.patch.object(MODULE, "_http_get_to_file") as http_get:
                result = MODULE._check_one_openaq_file(
                    conn,
                    "CIC-Test",
                    "https://example.test",
                    "42",
                    MODULE.dt.date(2026, 6, 8),
                    self.root / "tmp",
                    self.root / "cache",
                    self.log,
                )

            self.assertEqual(result["outcome"], "unchanged_metadata")
            http_get.assert_not_called()
            state = conn.execute(
                "SELECT local_cached_path, last_status FROM source_file_state WHERE source_file_key = ?",
                (MODULE._openaq_source_file_key("42", MODULE.dt.date(2026, 6, 8)),),
            ).fetchone()
            self.assertEqual(state, (None, "unchanged"))
        finally:
            conn.close()

    def test_v2_openaq_remote_exists_without_cache_downloads_and_writes_local_cached_path(self) -> None:
        conn = self._new_source_db()
        try:
            self._insert_openaq_prior_state(conn, local_cached_path=None)
            with mock.patch.object(MODULE, "_http_head", return_value={
                "status": 200,
                "content_length": 32,
                "etag": '"etag-1"',
                "last_modified": "2026-06-09T00:00:00Z",
            }), mock.patch.object(MODULE, "_http_get_to_file", side_effect=self._write_mock_gzip) as http_get, \
                 mock.patch.object(MODULE, "_sha256_uncompressed_gzip", return_value="same-uncompressed"), \
                 mock.patch.object(MODULE, "_openaq_parse_per_timeseries_counts", return_value={}):
                result = MODULE._check_one_openaq_file(
                    conn,
                    "CIC-Test",
                    "https://example.test",
                    "42",
                    MODULE.dt.date(2026, 6, 8),
                    self.root / "tmp",
                    self.root / "cache",
                    self.log,
                    force_download_when_cache_missing=True,
                )

            self.assertEqual(result["outcome"], "unchanged_content")
            http_get.assert_called_once()
            state = conn.execute(
                "SELECT local_cached_path, last_status FROM source_file_state WHERE source_file_key = ?",
                (MODULE._openaq_source_file_key("42", MODULE.dt.date(2026, 6, 8)),),
            ).fetchone()
            self.assertIsNotNone(state[0])
            self.assertTrue(Path(state[0]).is_file())
            self.assertEqual(state[1], "unchanged")
        finally:
            conn.close()

    def test_openaq_adapter_threads_history_version_v2_to_plan_and_execution(self) -> None:
        worker_result = {
            "outcome": "changed",
            "location_id": 42,
            "day": "2026-06-08",
            "event_id": None,
            "event_type": "changed",
            "timeseries_ids": [101, 102],
            "downloaded_bytes": 0,
        }
        wrapper = str(self.root / "uk_aq_integrity_backfill.sh")
        with mock.patch.object(MODULE, "_openaq_distinct_locations", return_value=[42]), \
             mock.patch.object(MODULE, "_check_one_openaq_file_threadsafe", return_value=worker_result) as check_file, \
             mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=wrapper), \
             mock.patch.object(MODULE, "run_narrow_backfill", return_value={"status": "ok"}) as run_bf, \
             mock.patch.object(MODULE, "SingleLineProgress", DummyProgress):
            metrics = MODULE.check_openaq(
                conn=self.conn,
                env_name="CIC-Test",
                env=self.env,
                from_day="2026-06-08",
                to_day="2026-06-08",
                dry_run=False,
                run_backfill=True,
                limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                log=self.log,
                run_compact="run",
                concurrency=1,
                history_version="v2",
            )

        self.assertEqual(metrics["backfills_attempted"], 1)
        self.assertIn("UK_AQ_R2_HISTORY_VERSION=v2", metrics["planned_backfills"][0])
        self.assertIn("--history-version v2", metrics["planned_backfills"][0])
        self.assertIn("UK_AQ_BACKFILL_CONNECTOR_IDS=6", metrics["planned_backfills"][0])
        self.assertEqual(check_file.call_args.kwargs["force_download_when_cache_missing"], True)
        self.assertEqual(run_bf.call_args.kwargs["history_version"], "v2")
        self.assertEqual(run_bf.call_args.kwargs["connector_ids"], [6])

    def test_sensorcommunity_adapter_threads_history_version_v2_to_plan_and_execution(self) -> None:
        worker_result = {
            "outcome": "changed",
            "sensor_id": "12345",
            "day": "2026-06-08",
            "event_id": None,
            "event_type": "changed",
            "timeseries_ids": [201],
            "downloaded_bytes": 0,
        }
        wrapper = str(self.root / "uk_aq_integrity_backfill.sh")
        with mock.patch.object(MODULE, "_sc_distinct_sensor_ids", return_value=["12345"]), \
             mock.patch.object(MODULE, "_sc_fetch_day_index", return_value={"12345": "2026-06-08_sds011_sensor_12345.csv"}), \
             mock.patch.object(MODULE, "_check_one_sc_file_threadsafe", return_value=worker_result) as check_file, \
             mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=wrapper), \
             mock.patch.object(MODULE, "run_narrow_backfill", return_value={"status": "ok"}) as run_bf, \
             mock.patch.object(MODULE, "SingleLineProgress", DummyProgress):
            metrics = MODULE.check_sensor_community(
                conn=self.conn,
                env_name="CIC-Test",
                env=self.env,
                from_day="2026-06-08",
                to_day="2026-06-08",
                dry_run=False,
                run_backfill=True,
                limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                log=self.log,
                run_compact="run",
                concurrency=1,
                history_version="v2",
            )

        self.assertEqual(metrics["backfills_attempted"], 1)
        self.assertIn("UK_AQ_R2_HISTORY_VERSION=v2", metrics["planned_backfills"][0])
        self.assertIn("--history-version v2", metrics["planned_backfills"][0])
        self.assertEqual(check_file.call_args.kwargs["force_download_when_cache_missing"], True)
        self.assertEqual(run_bf.call_args.kwargs["history_version"], "v2")

    def test_v2_aqi_rebuild_queue_executes_connector_scoped_rebuild(self) -> None:
        self._insert_aqi_queue_row(run_id=20, connector_id=6)
        self._write_v2_observation_partition(
            day_utc="2026-06-08",
            connector_id=6,
            pollutant_code="pm25",
            timeseries_row_counts={101: 3},
        )
        self._write_v2_aqi_partition(
            day_utc="2026-06-08",
            connector_id=6,
            pollutant_code="pm25",
            timeseries_row_counts={101: 3},
        )
        with mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=str(self.root / "uk_aq_integrity_backfill.sh")), \
             mock.patch.object(MODULE, "run_aqi_rebuild_backfill", return_value={"status": "ok", "log_path": None}) as run_aqi:
            metrics = MODULE.run_aqi_rebuild_queue_execution(
                self.conn,
                run_id=20,
                env_name="CIC-Test",
                run_compact="run",
                env=self.env,
                dry_run=False,
                run_backfill=True,
                limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                log=self.log,
                history_version="v2",
            )

        self.assertEqual(metrics["aqi_rebuilds_attempted"], 1)
        self.assertEqual(metrics["aqi_rebuilds_complete"], 1)
        self.assertEqual(run_aqi.call_args.kwargs["connector_id"], 6)
        self.assertEqual(run_aqi.call_args.kwargs["history_version"], "v2")

    def test_v2_aqi_post_rebuild_validation_fails_when_manifest_missing_after_obs_repair(self) -> None:
        self._insert_aqi_queue_row(run_id=25, connector_id=6)
        self._write_v2_observation_partition(
            day_utc="2026-06-08",
            connector_id=6,
            pollutant_code="pm25",
            timeseries_row_counts={101: 3},
        )
        with mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=str(self.root / "uk_aq_integrity_backfill.sh")), \
             mock.patch.object(MODULE, "run_aqi_rebuild_backfill", return_value={"status": "ok", "log_path": None}):
            metrics = MODULE.run_aqi_rebuild_queue_execution(
                self.conn,
                run_id=25,
                env_name="CIC-Test",
                run_compact="run",
                env=self.env,
                dry_run=False,
                run_backfill=True,
                limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                log=self.log,
                history_version="v2",
            )

        self.assertEqual(metrics["aqi_rebuilds_complete"], 0)
        self.assertEqual(metrics["aqi_rebuilds_failed"], 1)
        self.assertEqual(metrics["aqi_post_rebuild_validation_failed"], 1)
        result = metrics["aqi_rebuild_results"][0]
        self.assertEqual(result["status"], "failed")
        self.assertIn("aqi_manifest_missing_after_obs_repair", result["error"])
        self.assertEqual(result["post_rebuild_validation_gaps"][0]["gap_type"], "aqi_manifest_missing_after_obs_repair")

    def test_v2_aqi_post_rebuild_validation_fails_when_rows_below_observations(self) -> None:
        self._insert_aqi_queue_row(run_id=26, connector_id=6)
        self._write_v2_observation_partition(
            day_utc="2026-06-08",
            connector_id=6,
            pollutant_code="pm25",
            timeseries_row_counts={101: 3},
        )
        self._write_v2_aqi_partition(
            day_utc="2026-06-08",
            connector_id=6,
            pollutant_code="pm25",
            timeseries_row_counts={101: 2},
        )
        with mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=str(self.root / "uk_aq_integrity_backfill.sh")), \
             mock.patch.object(MODULE, "run_aqi_rebuild_backfill", return_value={"status": "ok", "log_path": None}):
            metrics = MODULE.run_aqi_rebuild_queue_execution(
                self.conn,
                run_id=26,
                env_name="CIC-Test",
                run_compact="run",
                env=self.env,
                dry_run=False,
                run_backfill=True,
                limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                log=self.log,
                history_version="v2",
            )

        self.assertEqual(metrics["aqi_rebuilds_failed"], 1)
        result = metrics["aqi_rebuild_results"][0]
        self.assertEqual(result["post_rebuild_validation_gaps"][0]["gap_type"], "aqi_expected_hours_missing")

    def test_v2_aqi_post_rebuild_validation_passes_with_manifest_rows_covering_pm_observations(self) -> None:
        self._insert_aqi_queue_row(run_id=27, connector_id=6)
        self._write_v2_observation_partition(
            day_utc="2026-06-08",
            connector_id=6,
            pollutant_code="pm25",
            timeseries_row_counts={101: 3},
        )
        self._write_v2_aqi_partition(
            day_utc="2026-06-08",
            connector_id=6,
            pollutant_code="pm25",
            timeseries_row_counts={101: 3},
        )
        with mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=str(self.root / "uk_aq_integrity_backfill.sh")), \
             mock.patch.object(MODULE, "run_aqi_rebuild_backfill", return_value={"status": "ok", "log_path": None}):
            metrics = MODULE.run_aqi_rebuild_queue_execution(
                self.conn,
                run_id=27,
                env_name="CIC-Test",
                run_compact="run",
                env=self.env,
                dry_run=False,
                run_backfill=True,
                limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                log=self.log,
                history_version="v2",
            )

        self.assertEqual(metrics["aqi_rebuilds_complete"], 1)
        self.assertEqual(metrics["aqi_post_rebuild_validation_failed"], 0)
        self.assertEqual(metrics["aqi_rebuild_results"][0]["post_rebuild_validation_gaps"], [])

    def test_v2_aqi_post_rebuild_validation_resolves_dropbox_root_and_dir_without_absolute_root(self) -> None:
        backup_root = self.root / "dropbox-app" / "CIC-Test" / "R2_history_backup"
        self.env["UK_AQ_R2_HISTORY_DROPBOX_ROOT"] = str(backup_root)
        self._insert_aqi_queue_row(run_id=2701, connector_id=6)
        self._write_v2_observation_partition(
            day_utc="2026-06-08",
            connector_id=6,
            pollutant_code="pm25",
            timeseries_row_counts={101: 3},
        )
        self._write_v2_aqi_partition(
            day_utc="2026-06-08",
            connector_id=6,
            pollutant_code="pm25",
            timeseries_row_counts={101: 3},
        )
        execution_env = dict(self.env)
        execution_env.pop("UK_AQ_R2_HISTORY_DROPBOX_ROOT", None)
        execution_env.pop("UK_AQ_DROPBOX_ROOT", None)
        execution_env.pop("UK_AQ_R2_HISTORY_DROPBOX_DIR", None)
        with mock.patch.object(MODULE, "DROPBOX_APP_ROOT", self.root / "dropbox-app"), \
             mock.patch.dict(os.environ, {
                 "UK_AQ_R2_HISTORY_DROPBOX_ROOT": "",
                 "UK_AQ_DROPBOX_ROOT": "CIC-Test",
                 "UK_AQ_R2_HISTORY_DROPBOX_DIR": "R2_history_backup",
             }, clear=False), \
             mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=str(self.root / "uk_aq_integrity_backfill.sh")), \
             mock.patch.object(MODULE, "run_aqi_rebuild_backfill", return_value={"status": "ok", "log_path": None}):
            metrics = MODULE.run_aqi_rebuild_queue_execution(
                self.conn,
                run_id=2701,
                env_name="CIC-Test",
                run_compact="run",
                env=execution_env,
                dry_run=False,
                run_backfill=True,
                limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                log=self.log,
                history_version="v2",
            )

        self.assertEqual(metrics["aqi_rebuilds_complete"], 1)
        self.assertEqual(metrics["aqi_post_rebuild_validation_failed"], 0)
        self.assertEqual(metrics["aqi_rebuild_results"][0]["post_rebuild_validation_gaps"], [])

    def test_v2_aqi_integrity_gap_dry_run_plans_aqi_only_rebuild(self) -> None:
        v2_aqi = {
            "gaps": [{
                "gap_type": "aqi_expected_hours_missing",
                "day_utc": "2026-06-18",
                "connector_id": 1,
                "pollutant_code": "pm25",
                "source_evidence": {"v2_observations_present": True},
            }]
        }
        with mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=str(self.root / "uk_aq_integrity_backfill.sh")):
            metrics = MODULE.queue_v2_aqi_rebuilds_from_integrity_gaps(
                conn=self.conn,
                run_id=28,
                env_name="CIC-Test",
                env=self.env,
                v2_aqilevels=v2_aqi,
                dry_run=True,
                run_backfill=True,
                log=self.log,
            )

        self.assertEqual(metrics["v2_aqi_rebuilds_queued_from_integrity"], 1)
        self.assertEqual(metrics["planned_aqi_rebuild_connector_days"][0]["connector_id"], 1)
        self.assertEqual(metrics["planned_aqi_rebuild_connector_days"][0]["reasons"], [MODULE.AQI_INTEGRITY_OBS_COVERAGE_REASON])
        planned = metrics["planned_v2_aqi_rebuilds_from_integrity"][0]
        self.assertIn("--aqi-only", planned)
        self.assertIn("--history-version v2", planned)
        self.assertIn("--connector-id 1", planned)
        self.assertIn("UK_AQ_BACKFILL_RUN_MODE=r2_history_obs_to_aqilevels", planned)
        queued = self.conn.execute("SELECT COUNT(*) FROM aqi_rebuild_queue").fetchone()[0]
        self.assertEqual(int(queued), 0)

    def test_v2_aqi_integrity_dry_run_deduplicates_28_connector_days(self) -> None:
        gaps = []
        for day_offset in range(28):
            day_utc = (MODULE.dt.date(2026, 2, 1) + MODULE.dt.timedelta(days=day_offset)).isoformat()
            gaps.append({
                "gap_type": "day_dir_missing",
                "day_utc": day_utc,
                "connector_id": 1,
                "source_evidence": {"v2_observations_present": True},
                "suggested_repair": {"kind": MODULE.V2_AQI_OBS_REBUILD_KIND},
            })
            for pollutant_code in ("no2", "pm10", "pm25"):
                gaps.append({
                    "gap_type": "aqi_manifest_missing_after_obs_repair",
                    "day_utc": day_utc,
                    "connector_id": 1,
                    "pollutant_code": pollutant_code,
                    "source_evidence": {"v2_observations_present": True},
                })
        with mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=str(self.root / "uk_aq_integrity_backfill.sh")):
            metrics = MODULE.queue_v2_aqi_rebuilds_from_integrity_gaps(
                conn=self.conn,
                run_id=280,
                env_name="CIC-Test",
                env=self.env,
                v2_aqilevels={"gaps": gaps},
                dry_run=True,
                run_backfill=True,
                log=self.log,
                allowed_connector_ids={1},
            )

        self.assertTrue(metrics["v2_aqi_integrity_rebuild_bridge_ran"])
        self.assertEqual(metrics["v2_aqi_rebuilds_queued_from_integrity"], 28)
        self.assertEqual(len(metrics["planned_aqi_rebuild_connector_days"]), 28)
        queued = self.conn.execute("SELECT COUNT(*) FROM aqi_rebuild_queue").fetchone()[0]
        self.assertEqual(int(queued), 0)

    def test_v2_aqi_integrity_gap_queues_and_executes_aqi_only_rebuild(self) -> None:
        self._write_v2_observation_partition(
            day_utc="2026-06-18",
            connector_id=1,
            pollutant_code="pm25",
            timeseries_row_counts={218: 24},
        )
        self._write_v2_aqi_partition(
            day_utc="2026-06-18",
            connector_id=1,
            pollutant_code="pm25",
            timeseries_row_counts={218: 24},
        )
        v2_aqi = {
            "gaps": [{
                "gap_type": "aqi_expected_hours_missing",
                "day_utc": "2026-06-18",
                "connector_id": 1,
                "pollutant_code": "pm25",
                "source_evidence": {"v2_observations_present": True},
            }]
        }
        with mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=str(self.root / "uk_aq_integrity_backfill.sh")), \
             mock.patch.object(MODULE, "run_aqi_rebuild_backfill", return_value={"status": "ok", "log_path": None}) as run_aqi:
            queue_metrics = MODULE.queue_v2_aqi_rebuilds_from_integrity_gaps(
                conn=self.conn,
                run_id=29,
                env_name="CIC-Test",
                env=self.env,
                v2_aqilevels=v2_aqi,
                dry_run=False,
                run_backfill=True,
                log=self.log,
            )
            exec_metrics = MODULE.run_aqi_rebuild_queue_execution(
                self.conn,
                run_id=29,
                env_name="CIC-Test",
                run_compact="run",
                env=self.env,
                dry_run=False,
                run_backfill=True,
                limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                log=self.log,
                history_version="v2",
            )

        self.assertEqual(queue_metrics["v2_aqi_rebuilds_queued_from_integrity"], 1)
        self.assertEqual(exec_metrics["aqi_rebuilds_complete"], 1)
        self.assertEqual(run_aqi.call_args.kwargs["history_version"], "v2")
        self.assertEqual(run_aqi.call_args.kwargs["connector_id"], 1)
        queued = self.conn.execute("SELECT status, reason, history_version FROM aqi_rebuild_queue WHERE run_id = 29").fetchone()
        self.assertEqual(queued, ("complete", MODULE.AQI_INTEGRITY_OBS_COVERAGE_REASON, "v2"))

    def test_v2_aqi_integrity_reason_gets_post_rebuild_validation(self) -> None:
        self._insert_aqi_queue_row(run_id=30, connector_id=6, reason=MODULE.AQI_INTEGRITY_OBS_COVERAGE_REASON)
        self._write_v2_observation_partition(
            day_utc="2026-06-08",
            connector_id=6,
            pollutant_code="pm25",
            timeseries_row_counts={101: 3},
        )
        with mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=str(self.root / "uk_aq_integrity_backfill.sh")), \
             mock.patch.object(MODULE, "run_aqi_rebuild_backfill", return_value={"status": "ok", "log_path": None}):
            metrics = MODULE.run_aqi_rebuild_queue_execution(
                self.conn,
                run_id=30,
                env_name="CIC-Test",
                run_compact="run",
                env=self.env,
                dry_run=False,
                run_backfill=True,
                limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                log=self.log,
                history_version="v2",
            )

        self.assertEqual(metrics["aqi_rebuilds_failed"], 1)
        self.assertEqual(metrics["aqi_post_rebuild_validation_failed"], 1)
        self.assertEqual(metrics["aqi_rebuild_results"][0]["post_rebuild_validation_gaps"][0]["gap_type"], "aqi_manifest_missing_after_obs_repair")

    def test_v2_aqi_integrity_duplicate_gaps_queue_one_rebuild_with_all_pollutants(self) -> None:
        v2_aqi = {
            "gaps": [
                {
                    "gap_type": "aqi_expected_hours_missing",
                    "day_utc": "2026-06-18",
                    "connector_id": 1,
                    "pollutant_code": "pm25",
                    "source_evidence": {"v2_observations_present": True},
                },
                {
                    "gap_type": "aqi_manifest_missing_after_obs_repair",
                    "day_utc": "2026-06-18",
                    "connector_id": 1,
                    "pollutant_code": "no2",
                    "source_evidence": {"v2_observations_present": True},
                },
            ]
        }
        with mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=str(self.root / "uk_aq_integrity_backfill.sh")):
            metrics = MODULE.queue_v2_aqi_rebuilds_from_integrity_gaps(
                conn=self.conn,
                run_id=31,
                env_name="CIC-Test",
                env=self.env,
                v2_aqilevels=v2_aqi,
                dry_run=False,
                run_backfill=True,
                log=self.log,
            )

        self.assertEqual(metrics["v2_aqi_rebuilds_queued_from_integrity"], 1)
        row = self.conn.execute("SELECT notes FROM aqi_rebuild_queue WHERE run_id = 31").fetchone()
        self.assertIn("aqi_expected_hours_missing,aqi_manifest_missing_after_obs_repair", row[0])
        self.assertIn("pollutants=no2,pm25", row[0])

    def test_v2_aqi_integrity_gap_without_observation_evidence_does_not_queue(self) -> None:
        v2_aqi = {
            "gaps": [{
                "gap_type": "aqi_expected_hours_missing",
                "day_utc": "2026-06-18",
                "connector_id": 1,
                "pollutant_code": "pm25",
                "source_evidence": {"v2_observations_present": False},
            }]
        }
        metrics = MODULE.queue_v2_aqi_rebuilds_from_integrity_gaps(
            conn=self.conn,
            run_id=32,
            env_name="CIC-Test",
            env=self.env,
            v2_aqilevels=v2_aqi,
            dry_run=False,
            run_backfill=True,
            log=self.log,
        )

        self.assertEqual(metrics["v2_aqi_rebuilds_queued_from_integrity"], 0)
        self.assertEqual(metrics["v2_aqi_rebuilds_skipped_missing_observation_evidence"], 1)
        self.assertEqual(metrics["skipped_v2_aqi_rebuilds_from_integrity"][0]["reason"], "missing_v2_observation_evidence")
        queued = self.conn.execute("SELECT COUNT(*) FROM aqi_rebuild_queue WHERE run_id = 32").fetchone()[0]
        self.assertEqual(int(queued), 0)

    def test_v2_aqi_integrity_gap_waits_for_observation_repair_verification(self) -> None:
        v2_aqi = {
            "gaps": [{
                "gap_type": "aqi_expected_hours_missing",
                "day_utc": "2026-06-18",
                "connector_id": 1,
                "pollutant_code": "pm25",
                "source_evidence": {"v2_observations_present": True},
            }]
        }
        metrics = MODULE.queue_v2_aqi_rebuilds_from_integrity_gaps(
            conn=self.conn,
            run_id=34,
            env_name="CIC-Test",
            env=self.env,
            v2_aqilevels=v2_aqi,
            dry_run=False,
            run_backfill=True,
            log=self.log,
            blocked_connector_days={("2026-06-18", 1)},
        )

        self.assertEqual(metrics["v2_aqi_rebuilds_queued_from_integrity"], 0)
        self.assertEqual(
            metrics["v2_aqi_rebuilds_skipped_observation_repair_unverified"],
            1,
        )
        self.assertEqual(
            metrics["skipped_v2_aqi_rebuilds_from_integrity"][0]["reason"],
            "observation_repair_not_verified",
        )
        queued = self.conn.execute(
            "SELECT COUNT(*) FROM aqi_rebuild_queue WHERE run_id = 34"
        ).fetchone()[0]
        self.assertEqual(int(queued), 0)

    def test_v2_aqi_integrity_source_scope_limits_queued_connectors(self) -> None:
        v2_aqi = {
            "gaps": [
                {
                    "gap_type": "aqi_expected_hours_missing",
                    "day_utc": "2026-06-18",
                    "connector_id": 1,
                    "pollutant_code": "pm25",
                    "source_evidence": {"v2_observations_present": True},
                },
                {
                    "gap_type": "aqi_expected_hours_missing",
                    "day_utc": "2026-06-18",
                    "connector_id": 6,
                    "pollutant_code": "pm25",
                    "source_evidence": {"v2_observations_present": True},
                },
            ]
        }
        with mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=str(self.root / "uk_aq_integrity_backfill.sh")):
            metrics = MODULE.queue_v2_aqi_rebuilds_from_integrity_gaps(
                conn=self.conn,
                run_id=33,
                env_name="CIC-Test",
                env=self.env,
                v2_aqilevels=v2_aqi,
                dry_run=True,
                run_backfill=True,
                log=self.log,
                allowed_connector_ids={1},
            )

        self.assertEqual(metrics["v2_aqi_rebuilds_queued_from_integrity"], 1)
        self.assertEqual(metrics["planned_aqi_rebuild_connector_days"][0]["connector_id"], 1)
        self.assertEqual(metrics["skipped_v2_aqi_rebuilds_from_integrity"][0]["reason"], "outside_source_scope")

    def test_v2_aqi_rebuild_planned_command_includes_connector_scope(self) -> None:
        self._insert_aqi_queue_row(run_id=21, connector_id=6)
        with mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=str(self.root / "uk_aq_integrity_backfill.sh")):
            metrics = MODULE.run_aqi_rebuild_queue_execution(
                self.conn,
                run_id=21,
                env_name="CIC-Test",
                run_compact="run",
                env=self.env,
                dry_run=True,
                run_backfill=True,
                limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                log=self.log,
                history_version="v2",
            )

        self.assertEqual(len(metrics["planned_aqi_rebuild_commands"]), 1)
        planned = metrics["planned_aqi_rebuild_commands"][0]
        self.assertIn("UK_AQ_BACKFILL_CONNECTOR_IDS=6", planned)
        self.assertIn("--history-version v2", planned)
        self.assertIn("--connector-id 6", planned)
        self.assertEqual(metrics["aqi_rebuild_results"][0]["connector_id"], 6)

    def test_v2_aqi_rebuild_queue_executes_same_day_connectors_separately(self) -> None:
        self._insert_aqi_queue_row(run_id=22, connector_id=6)
        self._insert_aqi_queue_row(run_id=22, connector_id=7)
        for connector_id, timeseries_id in [(6, 101), (7, 201)]:
            self._write_v2_observation_partition(
                day_utc="2026-06-08",
                connector_id=connector_id,
                pollutant_code="pm25",
                timeseries_row_counts={timeseries_id: 2},
            )
            self._write_v2_aqi_partition(
                day_utc="2026-06-08",
                connector_id=connector_id,
                pollutant_code="pm25",
                timeseries_row_counts={timeseries_id: 2},
            )
        with mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=str(self.root / "uk_aq_integrity_backfill.sh")), \
             mock.patch.object(MODULE, "run_aqi_rebuild_backfill", return_value={"status": "ok", "log_path": None}) as run_aqi:
            metrics = MODULE.run_aqi_rebuild_queue_execution(
                self.conn,
                run_id=22,
                env_name="CIC-Test",
                run_compact="run",
                env=self.env,
                dry_run=False,
                run_backfill=True,
                limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                log=self.log,
                history_version="v2",
            )

        self.assertEqual(metrics["aqi_rebuilds_attempted"], 2)
        self.assertEqual([call.kwargs["connector_id"] for call in run_aqi.call_args_list], [6, 7])
        self.assertEqual([row["connector_id"] for row in metrics["aqi_rebuild_results"]], [6, 7])

    def test_v2_aqi_dry_run_planning_preserves_connector_ids_from_seed_rows(self) -> None:
        with mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=str(self.root / "uk_aq_integrity_backfill.sh")):
            metrics = MODULE.run_aqi_rebuild_queue_execution(
                self.conn,
                run_id=24,
                env_name="CIC-Test",
                run_compact="run",
                env=self.env,
                dry_run=True,
                run_backfill=True,
                limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                log=self.log,
                dry_run_planned_rows=[
                    {"day_utc": "2026-06-08", "connector_id": 6, "reasons": ["obs_repaired"]},
                    {"day_utc": "2026-06-08", "connector_id": 7, "reasons": ["obs_repaired"]},
                ],
                history_version="v2",
            )

        self.assertEqual(metrics["aqi_rebuilds_queued_total"], 2)
        self.assertEqual([row["connector_id"] for row in metrics["aqi_rebuild_results"]], [6, 7])
        self.assertTrue(all("--connector-id" in cmd for cmd in metrics["planned_aqi_rebuild_commands"]))


class DedicatedSosHistoricalReplacementTests(unittest.TestCase):
    def _args(self, **overrides):
        values = {
            "source": "sos",
            "run_backfill": True,
            "dry_run": False,
            "history_version": "v2",
            "from_day": "2026-06-01",
            "to_day": "2026-06-01",
            "repair_pollutants": ["no2"],
        }
        values.update(overrides)
        return MODULE.argparse.Namespace(**values)

    def test_route_selection_is_strict_and_rejects_non_connector_1_scope(self) -> None:
        selected = MODULE.select_sos_historical_replacement_route(
            self._args(), mutation_connector_ids={1},
        )
        self.assertTrue(selected["selected"])
        self.assertEqual(
            selected["execution_path"],
            MODULE.SOS_HISTORICAL_REPLACEMENT_EXECUTION_PATH,
        )
        self.assertFalse(MODULE.select_sos_historical_replacement_route(
            self._args(source="openaq"), mutation_connector_ids={6},
        )["selected"])
        self.assertFalse(MODULE.select_sos_historical_replacement_route(
            self._args(dry_run=True), mutation_connector_ids={1},
        )["selected"])
        self.assertFalse(MODULE.select_sos_historical_replacement_route(
            self._args(run_backfill=False), mutation_connector_ids={1},
        )["selected"])
        with self.assertRaisesRegex(RuntimeError, "connector_id=1"):
            MODULE.select_sos_historical_replacement_route(
                self._args(), mutation_connector_ids={1, 2},
            )

    def test_matching_baseline_still_builds_direct_replacement_and_tombstone(
        self,
    ) -> None:
        day_utc = "2026-06-01"
        pollutant_code = "no2"
        row = {
            "connector_id": 1,
            "station_id": 10,
            "timeseries_id": 101,
            "pollutant_code": pollutant_code,
            "observed_at": f"{day_utc}T00:00:00.000Z",
            "value": 12.5,
            "verification_status": "P",
        }
        rows = [row]
        rows_body = json.dumps(rows).encode("utf-8")
        hash_evidence = {
            "observation_content_hash": "a" * 64,
            "verification_status_counts": {"P": 1},
        }
        evidence = {
            "schema_version": 1,
            "evidence_contract_version": MODULE.SOURCE_EVIDENCE_CONTRACT_VERSION,
            "contract": "pollutant_scoped_authoritative_connector_day_source_rows",
            "requested_pollutant_set": [pollutant_code],
            "enumeration_complete": True,
            "day_utc": day_utc,
            "connector_id": 1,
            "source_adapter": "sos",
            "files_required": [],
            "files_read": [],
            "files_authoritatively_absent": [],
            "canonical_rows_sha256": hashlib.sha256(rows_body).hexdigest(),
            "canonical_rows_bytes": len(rows_body),
            "total_rows": 1,
            "canonical_rows_mapped": 1,
            "source_records_examined": 1,
            "missing_binding_groups": 0,
            "missing_binding_rows": 0,
            "blocked_row_count": 0,
            "inactive_identity_rows_skipped": 0,
            "per_timeseries_counts": {"101": 1},
            "per_pollutant_counts": {pollutant_code: 1},
            "pollutant_set": [pollutant_code],
            "observation_content_hashes": {
                pollutant_code: hash_evidence,
            },
        }

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dropbox = root / "dropbox"
            dropbox.mkdir()
            run_state = MODULE.create_run_overlay(
                tmp_dir=root / "tmp",
                run_id="direct-matching-baseline",
                environment="CIC-Test",
                base_dropbox_root=dropbox,
            )
            env = {
                "UK_AQ_HISTORY_INTEGRITY_LOG_DIR": str(root / "logs"),
                "UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR": str(root / "cache"),
                "UK_AQ_HISTORY_INTEGRITY_TMP_DIR": str(root / "tmp"),
                "UK_AQ_BACKFILL_SOS_CONNECTOR_ID_FALLBACK": "1",
            }
            (root / "logs").mkdir()
            (root / "cache").mkdir()
            worker_source_modes: list[str] = []

            def fake_backfill(**kwargs):
                worker_source_modes.append(
                    (kwargs.get("extra_env") or {}).get(
                        "UK_AQ_BACKFILL_SOS_SOURCE_ACQUISITION_MODE",
                        "none",
                    )
                )
                if (kwargs.get("extra_env") or {}).get(
                    "UK_AQ_BACKFILL_SOS_SOURCE_ACQUISITION_MODE"
                ) == "acquire":
                    return {"status": "ok"}
                stage_root = Path(
                    kwargs["extra_env"][
                        "UK_AQ_BACKFILL_INTEGRITY_PROPOSAL_ROOT"
                    ]
                )
                source_dir = (
                    stage_root / f"day_utc={day_utc}" / "connector_id=1"
                )
                source_dir.mkdir(parents=True, exist_ok=True)
                (source_dir / "obs_history_rows.json").write_bytes(rows_body)
                (source_dir / "source-evidence.json").write_text(
                    json.dumps(evidence), encoding="utf-8"
                )
                if "UK_AQ_BACKFILL_INTEGRITY_SOURCE_EVIDENCE_ONLY" not in (
                    kwargs.get("extra_env") or {}
                ):
                    generated = (
                        stage_root / "generated-objects"
                        / MODULE.R2_HISTORY_V2_OBSERVATIONS_PREFIX
                        / f"day_utc={day_utc}" / "connector_id=1"
                    )
                    pollutant_root = (
                        generated / f"pollutant_code={pollutant_code}"
                    )
                    pollutant_root.mkdir(parents=True, exist_ok=True)
                    (pollutant_root / "part-00000.parquet").write_bytes(b"PAR1")
                    (pollutant_root / "manifest.json").write_text(
                        json.dumps(hash_evidence), encoding="utf-8"
                    )
                    generated.mkdir(parents=True, exist_ok=True)
                    (generated / "manifest.json").write_text(json.dumps({
                        "history_version": "v2",
                        "domain": "observations",
                        "day_utc": day_utc,
                        "connector_id": 1,
                    }), encoding="utf-8")
                return {
                    "status": "ok",
                    "rows_observations": 1,
                    "source_connector_day_complete_events": 1,
                    "source_connector_day_skipped_events": 0,
                    "source_connector_day_pending_events": 0,
                    "source_connector_day_failed_events": 0,
                    "source_mapped_rows": 1,
                    "source_timeseries_row_counts": {"101": 1},
                    "source_pollutant_codes": [pollutant_code],
                    "backfill_run_status": "complete",
                }

            direct_targets = MODULE.build_dedicated_sos_selected_partitions(
                from_day=day_utc,
                to_day=day_utc,
                selected_days=None,
                repair_pollutants=[pollutant_code],
            )
            conn = sqlite3.connect(":memory:")
            try:
                with mock.patch.object(
                    MODULE, "run_narrow_backfill", side_effect=fake_backfill,
                ), mock.patch.object(
                    MODULE,
                    "_load_dedicated_sos_source_acquisition_manifest",
                    return_value={
                        "acquisition_strategy":
                            "single_run_scoped_sos_annual_csv_pass",
                        "unique_source_file_count": 1,
                        "source_files_opened": 1,
                        "maximum_source_file_open_count": 1,
                        "total_source_bytes_read": 10,
                        "total_source_rows_scanned": 1,
                        "selected_range_rows": 1,
                        "partition_dataset_count": 1,
                        "partition_row_counts": {
                            f"{day_utc}|{pollutant_code}": 1,
                        },
                        "acquisition_completion_sha256": "c" * 64,
                    },
                ), mock.patch.object(
                    MODULE,
                    "_load_complete_connector_day_source_evidence",
                    return_value=(evidence, rows),
                ), mock.patch.object(
                    MODULE,
                    "_persist_complete_connector_day_source_evidence",
                    return_value={"evidence_id": 1, "evidence_sha256": "b" * 64},
                ), mock.patch.object(
                    MODULE,
                    "write_uk_air_source_label_registry_snapshot",
                    return_value={"path": str(root / "registry.json"), "inventory": {}},
                ), mock.patch.object(
                    MODULE,
                    "write_sos_site_ref_bridge_snapshot",
                    return_value={"path": str(root / "bridge.json")},
                ), mock.patch.object(
                    MODULE,
                    "_validate_chunked_v2_observation_repair_for_aqi",
                    return_value=(True, None),
                ), mock.patch.object(
                    MODULE,
                    "_observation_rows_from_local_parquet_for_shared_hash",
                    return_value=rows,
                ), mock.patch.object(
                    MODULE,
                    "_compute_observation_hash_with_shared_javascript",
                    return_value=hash_evidence,
                ), mock.patch.object(
                    MODULE,
                    "_validate_observation_content_hash_metadata",
                    return_value=hash_evidence,
                ), mock.patch.object(
                    MODULE,
                    "_v2_observation_manifest_evidence_mismatches",
                    return_value=({}, []),
                ), mock.patch.object(
                    MODULE,
                    "resolve_integrity_backfill_wrapper",
                    return_value=str(root / "backfill.sh"),
                ):
                    metrics = MODULE.run_v2_gap_backfills(
                        conn=conn,
                        run_id=1,
                        env_name="CIC-Test",
                        run_compact="run",
                        env=env,
                        v2_observations={
                            "status": "ok",
                            "gap_count": 0,
                            "gaps": [],
                            "comparison_result": "matches_authoritative_source",
                        },
                        dry_run=False,
                        run_backfill=True,
                        limits=MODULE.LimitTracker(
                            max_download_mb=0,
                            max_runtime_minutes=0,
                            started_mono=0.0,
                        ),
                        log=logging.getLogger("dedicated-direct-target-test"),
                        run_state=run_state,
                        queue_aqi_from_observation_repairs=False,
                        repair_pollutants=[pollutant_code],
                        source_scope={"source": "sos", "connector_ids": [1]},
                        explicit_selected_partitions=direct_targets,
                    )
            finally:
                conn.close()

        expected_prefix = (
            f"{MODULE.R2_HISTORY_V2_OBSERVATIONS_PREFIX}/day_utc={day_utc}/"
            f"connector_id=1/pollutant_code={pollutant_code}"
        )
        self.assertEqual(metrics["target_authority"], "explicit_selected_scope")
        self.assertTrue(metrics["gap_detection_bypassed"])
        self.assertEqual(metrics["complete_replacements"], 1)
        self.assertEqual(metrics["exact_tombstones_created"], 1)
        self.assertEqual(worker_source_modes, ["acquire", "consume", "consume"])
        self.assertEqual(metrics["source_acquisition_invocation_count"], 1)
        self.assertEqual(metrics["source_acquisition_root_creation_count"], 1)
        self.assertEqual(
            metrics["source_acquisition_complete_from_day_utc"], day_utc,
        )
        self.assertEqual(
            metrics["source_acquisition_complete_to_day_utc"], day_utc,
        )
        self.assertEqual(
            metrics["source_acquisition_selected_pollutants"],
            [pollutant_code],
        )
        self.assertEqual(metrics["source_acquisition_selected_day_count"], 1)
        self.assertEqual(
            metrics["source_acquisition_selected_pollutant_count"], 1,
        )
        self.assertEqual(
            metrics["source_acquisition_selected_partition_dataset_count"], 1,
        )
        self.assertEqual(metrics["source_acquisition_source_years"], [2026])
        self.assertFalse(
            metrics["source_acquisition_crossed_calendar_month_boundary"]
        )
        self.assertFalse(
            metrics["source_acquisition_crossed_calendar_year_boundary"]
        )
        self.assertEqual(
            [entry["prefix"] for entry in run_state["tombstone_prefixes"]],
            [expected_prefix],
        )
        self.assertTrue(
            any(
                key.startswith(expected_prefix + "/")
                for outcome in metrics["selected_partition_outcomes"]
                for key in outcome.get("replacement_object_keys", [])
            )
        )

    def test_same_day_pollutants_retain_distinct_source_evidence(self) -> None:
        day_utc = "2026-06-01"
        pollutants = ("no2", "pm25")
        evidence_by_pollutant: dict[str, tuple[dict, list[dict], bytes]] = {}
        for offset, pollutant_code in enumerate(pollutants, start=1):
            rows = [{
                "connector_id": 1,
                "station_id": 10 + offset,
                "timeseries_id": 100 + offset,
                "pollutant_code": pollutant_code,
                "observed_at": f"{day_utc}T00:00:00.000Z",
                "value": 10.0 + offset,
                "verification_status": "P",
            }]
            rows_body = json.dumps(rows).encode("utf-8")
            evidence_by_pollutant[pollutant_code] = ({
                "schema_version": 1,
                "contract":
                    "pollutant_scoped_authoritative_connector_day_source_rows",
                "requested_pollutant_set": [pollutant_code],
                "enumeration_complete": True,
                "day_utc": day_utc,
                "connector_id": 1,
                "source_adapter": "sos",
                "canonical_rows_sha256": hashlib.sha256(rows_body).hexdigest(),
                "canonical_rows_bytes": len(rows_body),
                "total_rows": 1,
                "canonical_rows_mapped": 1,
                "source_records_examined": 1,
                "missing_binding_groups": 0,
                "missing_binding_rows": 0,
                "per_timeseries_counts": {str(100 + offset): 1},
                "per_pollutant_counts": {pollutant_code: 1},
                "pollutant_set": [pollutant_code],
                "observation_content_hashes": {pollutant_code: {
                    "observation_content_hash": str(offset) * 64,
                    "verification_status_counts": {"P": 1},
                }},
            }, rows, rows_body)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dropbox = root / "dropbox"
            dropbox.mkdir()
            run_state = MODULE.create_run_overlay(
                tmp_dir=root / "tmp",
                run_id="direct-two-pollutants",
                environment="CIC-Test",
                base_dropbox_root=dropbox,
            )
            env = {
                "UK_AQ_HISTORY_INTEGRITY_LOG_DIR": str(root / "logs"),
                "UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR": str(root / "cache"),
                "UK_AQ_HISTORY_INTEGRITY_TMP_DIR": str(root / "tmp"),
                "UK_AQ_BACKFILL_SOS_CONNECTOR_ID_FALLBACK": "1",
            }
            (root / "logs").mkdir()
            (root / "cache").mkdir()
            worker_source_modes: list[str] = []

            def fake_backfill(**kwargs):
                worker_source_modes.append(
                    (kwargs.get("extra_env") or {}).get(
                        "UK_AQ_BACKFILL_SOS_SOURCE_ACQUISITION_MODE",
                        "none",
                    )
                )
                if (kwargs.get("extra_env") or {}).get(
                    "UK_AQ_BACKFILL_SOS_SOURCE_ACQUISITION_MODE"
                ) == "acquire":
                    return {"status": "ok"}
                pollutant_code = kwargs["repair_pollutants"][0]
                evidence, rows, rows_body = evidence_by_pollutant[pollutant_code]
                stage_root = Path(
                    kwargs["extra_env"][
                        "UK_AQ_BACKFILL_INTEGRITY_PROPOSAL_ROOT"
                    ]
                )
                source_dir = (
                    stage_root / f"day_utc={day_utc}" / "connector_id=1"
                )
                source_dir.mkdir(parents=True, exist_ok=True)
                (source_dir / "obs_history_rows.json").write_bytes(rows_body)
                (source_dir / "source-evidence.json").write_text(
                    json.dumps(evidence), encoding="utf-8"
                )
                return {
                    "status": "ok",
                    "rows_observations": len(rows),
                    "source_connector_day_complete_events": 1,
                    "source_connector_day_skipped_events": 0,
                    "source_connector_day_pending_events": 0,
                    "source_connector_day_failed_events": 0,
                    "source_mapped_rows": len(rows),
                    "source_timeseries_row_counts":
                        evidence["per_timeseries_counts"],
                    "source_pollutant_codes": [pollutant_code],
                    "backfill_run_status": "complete",
                }

            def fake_load(**kwargs):
                pollutant_code = list(kwargs["repair_pollutants"])[0]
                evidence, rows, _body = evidence_by_pollutant[pollutant_code]
                return evidence, rows

            def fake_capture(**kwargs):
                pollutant_code = list(kwargs["repair_pollutants"])[0]
                prefix = (
                    f"{MODULE.R2_HISTORY_V2_OBSERVATIONS_PREFIX}/"
                    f"day_utc={day_utc}/connector_id=1/"
                    f"pollutant_code={pollutant_code}"
                )
                keys = []
                for name, body in (
                    ("part-00000.parquet", b"PAR1" + pollutant_code.encode()),
                    ("manifest.json", json.dumps({
                        "pollutant_code": pollutant_code,
                    }).encode()),
                ):
                    source = root / f"{pollutant_code}-{name}"
                    source.write_bytes(body)
                    key = f"{prefix}/{name}"
                    MODULE.stage_overlay_object(
                        run_state,
                        object_key=key,
                        source_path=source,
                        stage="observations_data",
                        dependencies=(),
                    )
                    MODULE.mark_overlay_structurally_validated(run_state, key)
                    keys.append(key)
                run_state.setdefault("tombstone_prefixes", []).append({
                    "prefix": prefix,
                    "proposed": True,
                    "deleted": False,
                    "deletion_verified": False,
                    "stage": "observations_data",
                    "repair_pollutants": [pollutant_code],
                })
                MODULE.write_run_state(run_state)
                return keys

            direct_targets = MODULE.build_dedicated_sos_selected_partitions(
                from_day=day_utc,
                to_day=day_utc,
                selected_days=None,
                repair_pollutants=pollutants,
            )
            conn = sqlite3.connect(":memory:")
            try:
                with mock.patch.object(
                    MODULE, "run_narrow_backfill", side_effect=fake_backfill,
                ), mock.patch.object(
                    MODULE,
                    "_load_dedicated_sos_source_acquisition_manifest",
                    return_value={
                        "acquisition_strategy":
                            "single_run_scoped_sos_annual_csv_pass",
                        "unique_source_file_count": 1,
                        "source_files_opened": 1,
                        "maximum_source_file_open_count": 1,
                        "total_source_bytes_read": 10,
                        "total_source_rows_scanned": 2,
                        "selected_range_rows": 2,
                        "partition_dataset_count": 2,
                        "partition_row_counts": {
                            f"{day_utc}|{pollutant}": 1
                            for pollutant in pollutants
                        },
                        "acquisition_completion_sha256": "c" * 64,
                    },
                ), mock.patch.object(
                    MODULE,
                    "_load_complete_connector_day_source_evidence",
                    side_effect=fake_load,
                ), mock.patch.object(
                    MODULE,
                    "_persist_complete_connector_day_source_evidence",
                    return_value={"evidence_id": 1, "evidence_sha256": "b" * 64},
                ), mock.patch.object(
                    MODULE,
                    "_capture_local_v2_observation_scope",
                    side_effect=fake_capture,
                ), mock.patch.object(
                    MODULE,
                    "write_uk_air_source_label_registry_snapshot",
                    return_value={"path": str(root / "registry.json"), "inventory": {}},
                ), mock.patch.object(
                    MODULE,
                    "write_sos_site_ref_bridge_snapshot",
                    return_value={"path": str(root / "bridge.json")},
                ), mock.patch.object(
                    MODULE,
                    "_validate_chunked_v2_observation_repair_for_aqi",
                    return_value=(True, None),
                ), mock.patch.object(
                    MODULE,
                    "resolve_integrity_backfill_wrapper",
                    return_value=str(root / "backfill.sh"),
                ):
                    metrics = MODULE.run_v2_gap_backfills(
                        conn=conn,
                        run_id=1,
                        env_name="CIC-Test",
                        run_compact="run",
                        env=env,
                        v2_observations={"gap_count": 0, "gaps": []},
                        dry_run=False,
                        run_backfill=True,
                        limits=MODULE.LimitTracker(
                            max_download_mb=0,
                            max_runtime_minutes=0,
                            started_mono=0.0,
                        ),
                        log=logging.getLogger("dedicated-two-pollutants-test"),
                        run_state=run_state,
                        queue_aqi_from_observation_repairs=False,
                        repair_pollutants=pollutants,
                        source_scope={"source": "sos", "connector_ids": [1]},
                        explicit_selected_partitions=direct_targets,
                    )
            finally:
                conn.close()

            retained = run_state["source_evidence_partitions"]
            self.assertEqual(len(retained), 2)
            evidence_paths = [Path(entry["evidence_path"]) for entry in retained.values()]
            rows_paths = [Path(entry["rows_path"]) for entry in retained.values()]
            self.assertEqual(len(set(evidence_paths)), 2)
            self.assertEqual(len(set(rows_paths)), 2)
            for pollutant_code in pollutants:
                identity = (
                    f"day_utc={day_utc}/connector_id=1/"
                    f"pollutant_code={pollutant_code}"
                )
                entry = retained[identity]
                self.assertEqual(
                    json.loads(Path(entry["evidence_path"]).read_text())[
                        "requested_pollutant_set"
                    ],
                    [pollutant_code],
                )

        self.assertEqual(metrics["explicit_selected_partition_count"], 2)
        self.assertEqual(metrics["complete_replacements"], 2)
        self.assertEqual(metrics["exact_tombstones_created"], 2)
        self.assertEqual(
            worker_source_modes,
            ["acquire", "consume", "consume", "consume", "consume"],
        )
        self.assertEqual(len(run_state["tombstone_prefixes"]), 2)
        replacement_keys = {
            key
            for outcome in metrics["selected_partition_outcomes"]
            for key in outcome.get("replacement_object_keys", [])
        }
        self.assertTrue(any("pollutant_code=no2/" in key for key in replacement_keys))
        self.assertTrue(any("pollutant_code=pm25/" in key for key in replacement_keys))

    def test_all_unmapped_non_empty_sos_partitions_are_left_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = MODULE.resolve_history_path_config("v2", {})
            day_utc = "2026-06-01"
            (root / config.observations_data_prefix / f"day_utc={day_utc}").mkdir(
                parents=True
            )

            def all_unmapped(*_args, **kwargs):
                pollutant = kwargs["pollutant_code"]
                return {}, {
                    "source_partition_state": "successful_empty",
                    "source_counts_present": False,
                    "source_counts_available": True,
                    "source_rows": 0,
                    "source_skip_reason": None,
                    "identity_resolution": "uk_air_site_ref_to_sos_timeseries_bridge",
                    "all_source_groups_excluded_no_authoritative_binding": True,
                    "no_authoritative_timeseries_binding_groups": 1,
                    "no_authoritative_timeseries_binding_rows": 24,
                    "no_authoritative_timeseries_binding_warnings": [{
                        "day_utc": day_utc,
                        "pollutant_code": pollutant,
                    }],
                    "partition": {
                        "state": "successful_empty",
                        "source_counts_present": False,
                        "source_counts_available": True,
                    },
                }

            with mock.patch.object(
                MODULE,
                "_current_source_counts_for_v2_partition",
                side_effect=all_unmapped,
            ):
                observations = MODULE.run_v2_observations_integrity_checks(
                    r2_history_root=root,
                    config=config,
                    from_day=day_utc,
                    to_day=day_utc,
                    conn=None,
                    env_name="CIC-Test",
                    allowed_connector_ids={1},
                    source_scope={"source": "sos", "connector_ids": [1]},
                    dedicated_sos_historical_replacement=True,
                )
            self.assertEqual(
                len(observations["all_unmapped_partitions_left_unchanged"]),
                4,
            )
            scopes, _indexes, skipped = (
                MODULE._derive_executable_observation_repair_pollutants(
                    v2_observations=observations,
                    requested_pollutants=["pm25", "pm10", "no2", "o3"],
                )
            )
            self.assertEqual(scopes, {})
            self.assertTrue(skipped)

    def test_legacy_r2_only_identity_is_diagnostic_for_complete_replacement(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = MODULE.resolve_history_path_config("v2", {})
            day_utc = "2026-06-01"
            prefix = (
                root / config.observations_data_prefix
                / f"day_utc={day_utc}" / "connector_id=1"
                / "pollutant_code=no2"
            )
            prefix.mkdir(parents=True)
            part_key = (
                f"{config.observations_data_prefix}/day_utc={day_utc}/"
                "connector_id=1/pollutant_code=no2/part-00000.parquet"
            )
            (root / part_key).write_bytes(b"PAR1")
            (prefix / "manifest.json").write_text(json.dumps({
                "history_version": "v2",
                "domain": "observations",
                "manifest_kind": "pollutant",
                "day_utc": day_utc,
                "connector_id": 1,
                "pollutant_code": "no2",
                "row_count": 2,
                "source_row_count": 2,
                "timeseries_row_counts": {"100": 2},
                "files": [{"key": part_key, "bytes": 4, "row_count": 2}],
            }))
            latest = root / config.observations_latest_index_key
            latest.parent.mkdir(parents=True)
            latest.write_text("{}")
            source_evidence = {
                "source_partition_state": "successful_non_empty",
                "source_counts_present": True,
                "source_counts_available": True,
                "source_rows": 2,
                "source_skip_reason": None,
                "expected_timeseries_ids": [200],
                "identity_resolution": "uk_air_site_ref_to_sos_timeseries_bridge",
                "partition": {
                    "state": "successful_non_empty",
                    "source_counts_present": True,
                    "source_counts_available": True,
                },
            }
            unresolved = [{
                "existing_r2_timeseries_id": 100,
                "reason": "r2_timeseries_not_in_authoritative_continuity_family",
            }]
            stats = {
                "row_count": 2,
                "timeseries_row_counts": {100: 2},
                "timeseries_min_timestamp_utc": {
                    100: f"{day_utc}T00:00:00.000Z"
                },
            }
            with mock.patch.object(
                MODULE,
                "_current_source_counts_for_v2_partition",
                return_value=({200: 2}, source_evidence),
            ), mock.patch.object(
                MODULE,
                "_append_actual_parquet_gaps",
                return_value=(stats, None),
            ), mock.patch.object(
                MODULE,
                "_classify_sos_r2_historical_identity_rollovers",
                return_value=([], unresolved),
            ):
                observations = MODULE.run_v2_observations_integrity_checks(
                    r2_history_root=root,
                    config=config,
                    from_day=day_utc,
                    to_day=day_utc,
                    conn=None,
                    env_name="CIC-Test",
                    allowed_connector_ids={1},
                    source_scope={"source": "sos", "connector_ids": [1]},
                    dedicated_sos_historical_replacement=True,
                )
            mismatch = next(
                gap for gap in observations["gaps"]
                if gap["gap_type"] == "source_r2_timeseries_row_mismatch"
            )
            self.assertEqual(
                mismatch["source_evidence"]["legacy_r2_only_identity_handling"],
                "diagnostic_only_complete_partition_replacement",
            )
            self.assertFalse(any(
                gap["gap_type"] == "source_mapping_issue"
                for gap in observations["gaps"]
            ))

    def test_dedicated_flow_bypasses_aqi_and_broad_final_scan(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run_state = MODULE.create_run_overlay(
                tmp_dir=root,
                run_id="dedicated-sos",
                environment="CIC-Test",
                base_dropbox_root=root / "dropbox",
            )
            conn = sqlite3.connect(":memory:")
            current_state = {
                "overall_status": "complete",
                "r2_history_status": "complete",
                "timeseries_reconciliation_status": "complete",
                "latest_snapshot_reconciliation_status": "complete",
                "timeseries": {},
                "latest_snapshot": {},
            }
            metadata_ok = {
                "status": "ok",
                "manifest_status": "ok",
                "index_status": "ok",
                "results": [],
            }
            first_value = {
                "status": "skipped_empty",
                "attempted": False,
                "connector_day_count": 0,
            }
            forbidden = AssertionError("AQI or broad final verification was invoked")
            verified_partition_entry = {
                "day_utc": "2026-06-01",
                "connector_id": 1,
                "pollutant_code": "no2",
                "status": "ok",
            }
            try:
                with mock.patch.object(MODULE, "run_v2_gap_backfills", return_value={
                    "v2_observation_repairs_failed": 0,
                    "v2_observation_repairs_guard_failed": 0,
                    "v2_observation_repair_results": [verified_partition_entry],
                }), mock.patch.object(
                    MODULE, "_run_v2_observation_metadata_executor", return_value=metadata_ok,
                ) as metadata_executor, mock.patch.object(
                    MODULE, "_record_metadata_executor_overlay",
                ), mock.patch.object(
                    MODULE, "record_integrity_object_operations", return_value={
                        "planned_writes": 0,
                        "planned_deletions": 0,
                        "completed_writes": 0,
                        "completed_deletions": 0,
                    },
                ), mock.patch.object(
                    MODULE, "run_first_value_at_reconciliation", return_value=first_value,
                ), mock.patch.object(
                    MODULE, "run_current_state_reconciliation", return_value=current_state,
                ) as current_state_runner, mock.patch.object(
                    MODULE, "persist_current_state_reconciliation_audit",
                ), mock.patch.object(
                    MODULE, "_phase4_aqi_work", side_effect=forbidden,
                ), mock.patch.object(
                    MODULE, "queue_v2_aqi_rebuilds_from_integrity_gaps", side_effect=forbidden,
                ), mock.patch.object(
                    MODULE, "run_aqi_rebuild_queue_execution", side_effect=forbidden,
                ), mock.patch.object(
                    MODULE, "run_v2_final_verification", side_effect=forbidden,
                ):
                    result = MODULE.run_v2_integrity_repair_flow(
                        run_state=run_state,
                        conn=conn,
                        run_id=1,
                        env_name="CIC-Test",
                        run_compact="run",
                        env={"UK_AQ_INTEGRITY_CURRENT_STATE_RECONCILIATION_ENABLED": "false"},
                        v2_observations={"repair_plan": []},
                        v2_aqilevels={"status": "bypassed", "repair_plan": []},
                        final_verification_config=MODULE.resolve_history_path_config("v2", {}),
                        from_day="2026-06-01",
                        to_day="2026-06-01",
                        allowed_connector_ids={1},
                        source_scope={"source": "sos", "connector_ids": [1]},
                        check_aqi_debug=False,
                        require_aqi_debug=False,
                        limits=MODULE.LimitTracker(
                            max_download_mb=0,
                            max_runtime_minutes=0,
                            started_mono=0.0,
                        ),
                        dry_run=False,
                        log=logging.getLogger("dedicated-sos-test"),
                        repair_pollutants=["no2"],
                        dedicated_sos_historical_replacement=True,
                    )
            finally:
                conn.close()
            self.assertEqual(metadata_executor.call_count, 1)
            self.assertEqual(result["status"], "succeeded")
            self.assertTrue(result["dedicated_sos_historical_replacement"])
            self.assertEqual(result["final_verification"]["status"], "ok")
            self.assertFalse(
                result["final_verification"]["second_broad_r2_scan_invoked"]
            )
            self.assertEqual(
                current_state_runner.call_args.kwargs[
                    "dedicated_partition_entries"
                ],
                [verified_partition_entry],
            )
            aqi_stage = next(
                stage for stage in result["stage_results"]
                if stage["stage"] == "aqi_proposal"
            )
            self.assertEqual(aqi_stage["status"], "bypassed")


class ApplyPersistenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _journal_state(
        self,
        event_types: list[str],
        *,
        completed_writes: int = 0,
        completed_gets: int = 0,
        completed_deletions: int = 0,
    ) -> tuple[dict[str, object], Path, list[dict[str, object]]]:
        previous: str | None = None
        events: list[dict[str, object]] = []
        for index, event_type in enumerate(event_types):
            event: dict[str, object] = {
                "run_id": "test-run",
                "event_hash_contract_version": (
                    MODULE.MUTATION_EVENT_HASH_CONTRACT_VERSION
                ),
                "event_type": event_type,
                "timestamp_utc": f"2026-08-01T00:00:{index:02d}Z",
                "previous_event_sha256": previous,
                "nested": {"z": index, "a": ["stable", index]},
            }
            event_sha256 = hashlib.sha256(
                MODULE.canonical_mutation_event_hash_input(event)
            ).hexdigest()
            event["event_sha256"] = event_sha256
            previous = event_sha256
            events.append(event)
        journal_path = self.root / "apply-mutation-events.jsonl"
        body = b"".join(
            json.dumps(event, separators=(",", ":"), ensure_ascii=False).encode(
                "utf-8"
            ) + b"\n"
            for event in events
        )
        journal_path.write_bytes(body)
        state: dict[str, object] = {
            "run_id": "test-run",
            "run_root": str(self.root),
            "apply": {
                "status": "succeeded",
                "completed_writes": completed_writes,
                "completed_post_put_verifications": completed_gets,
                "completed_deletions": completed_deletions,
                "persistence": {
                    "mutation_journal_path": str(journal_path),
                    "mutation_journal_bytes": len(body),
                    "mutation_journal_sha256": hashlib.sha256(body).hexdigest(),
                    "mutation_journal_event_count": len(events),
                    "mutation_journal_tail_event_sha256": previous,
                    "deleted_key_sidecar_count": 0,
                    "node_complete_run_state_write_count": 2,
                    "coordinator_complete_run_state_write_count": 1,
                    "total_complete_run_state_write_count": 3,
                },
            },
            "tombstone_prefixes": [],
        }
        return state, journal_path, events

    def _rewrite_journal_identity(
        self,
        state: dict[str, object],
        journal_path: Path,
        events: list[dict[str, object]],
    ) -> None:
        body = b"".join(
            json.dumps(event, separators=(",", ":"), ensure_ascii=False).encode(
                "utf-8"
            ) + b"\n"
            for event in events
        )
        journal_path.write_bytes(body)
        persistence = state["apply"]["persistence"]  # type: ignore[index]
        persistence["mutation_journal_bytes"] = len(body)
        persistence["mutation_journal_sha256"] = hashlib.sha256(body).hexdigest()

    def test_journal_and_deleted_key_sidecar_identities_are_verified(self) -> None:
        prefix = "history/v2/observations/day_utc=2026-07-29"
        evidence_dir = self.root / "apply-evidence" / "deletions"
        evidence_dir.mkdir(parents=True)
        sidecar_path = evidence_dir / "2026-07-29-test.json"
        sidecar_body = json.dumps([f"{prefix}/a.json"], separators=(",", ":")).encode() + b"\n"
        sidecar_path.write_bytes(sidecar_body)
        journal_path = self.root / "apply-mutation-events.jsonl"
        event = {
            "run_id": "test-run",
            "event_hash_contract_version": (
                MODULE.MUTATION_EVENT_HASH_CONTRACT_VERSION
            ),
            "event_type": "deletion_verified",
            "previous_event_sha256": None,
        }
        tail_sha256 = hashlib.sha256(
            MODULE.canonical_mutation_event_hash_input(event)
        ).hexdigest()
        event["event_sha256"] = tail_sha256
        journal_body = json.dumps(event, separators=(",", ":")).encode() + b"\n"
        journal_path.write_bytes(journal_body)
        run_state = {
            "run_id": "test-run",
            "run_root": str(self.root),
            "apply": {"persistence": {
                "mutation_journal_path": str(journal_path),
                "mutation_journal_bytes": len(journal_body),
                "mutation_journal_sha256": hashlib.sha256(journal_body).hexdigest(),
                "mutation_journal_event_count": 1,
                "mutation_journal_tail_event_sha256": tail_sha256,
                "deleted_key_sidecar_count": 1,
                "compact_checkpoint_count": 4,
                "node_complete_run_state_write_count": 2,
                "coordinator_complete_run_state_write_count": 0,
                "total_complete_run_state_write_count": 2,
                "mutation_journal_flush_count": 3,
            }},
            "tombstone_prefixes": [{
                "prefix": prefix,
                "deleted_object_count": 1,
                "deleted_keys_sidecar_path": str(sidecar_path),
                "deleted_keys_sidecar_bytes": len(sidecar_body),
                "deleted_keys_sha256": hashlib.sha256(sidecar_body).hexdigest(),
            }],
        }
        result = MODULE.verify_apply_persistence_artifacts(run_state)
        self.assertEqual(result["status"], "verified")
        self.assertEqual(result["mutation_journal_event_count"], 1)
        self.assertEqual(result["deleted_key_sidecars"][0]["deleted_object_count"], 1)

    def test_intact_multi_event_journal_recomputes_and_reconciles(self) -> None:
        fixture = {
            "z": {"b": 2, "a": [3, {"y": "✓", "x": None}]},
            "event_hash_contract_version": (
                MODULE.MUTATION_EVENT_HASH_CONTRACT_VERSION
            ),
            "previous_event_sha256": None,
            "event_type": "fixture",
            "run_id": "r",
        }
        self.assertEqual(
            hashlib.sha256(
                MODULE.canonical_mutation_event_hash_input(fixture)
            ).hexdigest(),
            "5937c9d8669a5da38e4d9170b4962b050997ff31f4df47d54f90785d853f65aa",
        )
        state, _path, _events = self._journal_state(
            ["put_completed", "post_put_get_verified"],
            completed_writes=1,
            completed_gets=1,
        )
        result = MODULE.verify_apply_persistence_artifacts(state)
        self.assertEqual(result["status"], "verified")
        self.assertEqual(result["event_type_counts"]["put_completed"], 1)
        self.assertEqual(result["total_complete_run_state_write_count"], 3)

    def test_modified_event_body_with_updated_file_identity_fails_hash(self) -> None:
        state, path, events = self._journal_state(["canonical_apply_started"])
        events[0]["nested"] = {"changed": True}
        self._rewrite_journal_identity(state, path, events)
        with self.assertRaisesRegex(ValueError, "event-hash mismatch"):
            MODULE.verify_apply_persistence_artifacts(state)

    def test_unrelated_declared_event_hash_fails_recomputation(self) -> None:
        state, path, events = self._journal_state(["canonical_apply_started"])
        events[0]["event_sha256"] = "b" * 64
        state["apply"]["persistence"][  # type: ignore[index]
            "mutation_journal_tail_event_sha256"
        ] = "b" * 64
        self._rewrite_journal_identity(state, path, events)
        with self.assertRaisesRegex(ValueError, "event-hash mismatch"):
            MODULE.verify_apply_persistence_artifacts(state)

    def test_broken_previous_event_hash_fails_chain_linkage(self) -> None:
        state, path, events = self._journal_state(
            ["canonical_apply_started", "canonical_apply_completed"]
        )
        events[1]["previous_event_sha256"] = "c" * 64
        self._rewrite_journal_identity(state, path, events)
        with self.assertRaisesRegex(ValueError, "event-chain linkage mismatch"):
            MODULE.verify_apply_persistence_artifacts(state)

    def test_event_chain_tail_mismatch_is_distinct(self) -> None:
        state, _path, _events = self._journal_state(["canonical_apply_started"])
        state["apply"]["persistence"][  # type: ignore[index]
            "mutation_journal_tail_event_sha256"
        ] = "d" * 64
        with self.assertRaisesRegex(ValueError, "event-chain tail mismatch"):
            MODULE.verify_apply_persistence_artifacts(state)

    def test_journal_event_count_mismatch_is_distinct(self) -> None:
        state, _path, _events = self._journal_state(["canonical_apply_started"])
        state["apply"]["persistence"][  # type: ignore[index]
            "mutation_journal_event_count"
        ] = 2
        with self.assertRaisesRegex(ValueError, "event-count mismatch"):
            MODULE.verify_apply_persistence_artifacts(state)

    def test_successful_put_get_count_mismatch_fails_reconciliation(self) -> None:
        state, _path, _events = self._journal_state(
            ["put_completed", "post_put_get_verified"],
            completed_writes=2,
            completed_gets=2,
        )
        with self.assertRaisesRegex(ValueError, "successful PUT/GET count mismatch"):
            MODULE.verify_apply_persistence_artifacts(state)

    def test_successful_deletion_count_mismatch_fails_reconciliation(self) -> None:
        state, _path, _events = self._journal_state(
            ["canonical_apply_started"], completed_deletions=1
        )
        with self.assertRaisesRegex(ValueError, "successful deletion count mismatch"):
            MODULE.verify_apply_persistence_artifacts(state)

    def test_complete_state_write_counts_separate_node_and_coordinator(self) -> None:
        run_state_path = self.root / "run-state.json"
        artifacts = {
            "node_complete_run_state_write_count": 2,
            "coordinator_complete_run_state_write_count": 0,
            "total_complete_run_state_write_count": 2,
            "compact_checkpoint_count": 9,
        }
        run_state = {
            "run_state_path": str(run_state_path),
            "apply": {"persistence": dict(artifacts)},
            "coordinator": {
                "final_verification": {
                    "apply_persistence_artifacts": dict(artifacts)
                }
            },
        }
        MODULE.write_run_state(run_state)
        MODULE.write_run_state(run_state)
        persistence = run_state["apply"]["persistence"]
        self.assertEqual(persistence["node_complete_run_state_write_count"], 2)
        self.assertEqual(
            persistence["coordinator_complete_run_state_write_count"], 2
        )
        self.assertEqual(persistence["total_complete_run_state_write_count"], 4)
        self.assertEqual(persistence["compact_checkpoint_count"], 9)
        self.assertEqual(
            run_state["coordinator"]["final_verification"]
            ["apply_persistence_artifacts"]
            ["total_complete_run_state_write_count"],
            4,
        )

    def test_canonical_apply_executor_streams_stderr_and_retains_stdout_json(self) -> None:
        run_state_path = self.root / "run-state.json"
        run_state = {"run_state_path": str(run_state_path), "run_root": str(self.root)}
        run_state_path.write_text(json.dumps(run_state), encoding="utf-8")

        class FakeProcess:
            def __init__(self) -> None:
                self.stdout = io.StringIO('{"ok":true}\n')
                self.stderr = io.StringIO('[canonical-apply] completed_objects=50/100\n')
                self.returncode = 0

            def wait(self) -> int:
                return self.returncode

        logger = logging.getLogger("canonical-apply-stream-test")
        with mock.patch.object(MODULE, "_repo_root_for_integrity_script", return_value=self.root), \
             mock.patch.object(MODULE.subprocess, "Popen", return_value=FakeProcess()), \
             self.assertLogs(logger, level="INFO") as captured:
            result = MODULE.run_canonical_apply_executor(
                run_state=run_state,
                env={"UK_AQ_BACKFILL_NODE_BIN": "node"},
                log=logger,
            )
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(result["output"], {"ok": True})
        self.assertTrue(any("completed_objects=50/100" in line for line in captured.output))

    def test_canonical_apply_executor_retains_final_error_after_progress(self) -> None:
        run_state_path = self.root / "run-state.json"
        run_state = {
            "run_state_path": str(run_state_path),
            "run_root": str(self.root),
            "apply": {
                "status": "failed",
                "error": "ORIGINAL APPLY ERROR",
                "failure_checkpoint": {
                    "attempted": True,
                    "succeeded": False,
                    "error": "COMPACT CHECKPOINT ERROR",
                    "last_successfully_written_checkpoint": {
                        "reason": "after_deletion_verification",
                        "timestamp_utc": "2026-08-01T00:00:00Z",
                    },
                },
                "failed_operation": {
                    "canonical_key": "history/_index_v2/failed.json",
                    "day_utc": "2026-07-29",
                    "publication_stage": "generic_targeted_index",
                },
                "last_completed_publication_level": "day_parent_verified",
                "later_selected_days_untouched": True,
                "untouched_later_selected_days": ["2026-07-30"],
            },
        }
        run_state_path.write_text(json.dumps(run_state), encoding="utf-8")

        class FakeProcess:
            def __init__(self) -> None:
                self.stdout = io.StringIO("")
                self.stderr = io.StringIO(("progress\n" * 1_000) + "FINAL NODE ERROR\n")
                self.returncode = 1

            def wait(self) -> int:
                return self.returncode

        logger = logging.getLogger("canonical-apply-error-tail-test")
        logger.addHandler(logging.NullHandler())
        logger.propagate = False
        with mock.patch.object(MODULE, "_repo_root_for_integrity_script", return_value=self.root), \
             mock.patch.object(MODULE.subprocess, "Popen", return_value=FakeProcess()):
            result = MODULE.run_canonical_apply_executor(
                run_state=run_state,
                env={"UK_AQ_BACKFILL_NODE_BIN": "node"},
                log=logger,
            )
        self.assertEqual(result["status"], "failed")
        self.assertIn("FINAL NODE ERROR", result["error"])
        self.assertEqual(result["original_apply_error"], "ORIGINAL APPLY ERROR")
        self.assertEqual(
            result["failure_checkpoint"]["error"], "COMPACT CHECKPOINT ERROR"
        )
        self.assertEqual(
            result["failed_operation"]["canonical_key"],
            "history/_index_v2/failed.json",
        )
        self.assertEqual(result["untouched_later_selected_days"], ["2026-07-30"])
        report = MODULE.format_summary_md({
            "env": "CIC-Test",
            "profile": "manual",
            "started_at_utc": "2026-08-01T00:00:00Z",
            "status": "failed",
            "source": "sos",
            "dry_run": False,
            "check_only": False,
            "run_backfill": True,
            "db_path": str(self.root / "state.sqlite"),
            "log_path": str(self.root / "run.log"),
            "repair_flow": {
                "status": "failed",
                "canonical_apply": result,
                "final_verification": {"status": "blocked_dependency"},
            }
        })
        self.assertIn("ORIGINAL APPLY ERROR", report)
        self.assertIn("COMPACT CHECKPOINT ERROR", report)
        self.assertIn("history/_index_v2/failed.json", report)


class RepoRootTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_repo_root_resolves_from_explicit_env_var_when_valid(self) -> None:
        (self.root / "workers" / "shared").mkdir(parents=True, exist_ok=True)
        (self.root / "workers" / "shared" / "r2_sigv4.mjs").touch()
        path, diag = MODULE._resolve_repo_root_with_diagnostics(env={"UK_AQ_OPS_REPO_ROOT": str(self.root)})
        self.assertEqual(path, self.root)
        self.assertEqual(diag, "ops_repo_root_explicit_valid")

    def test_repo_root_falls_back_when_explicit_dir_invalid(self) -> None:
        path, diag = MODULE._resolve_repo_root_with_diagnostics(env={"UK_AQ_OPS_REPO_ROOT": "/does/not/exist/ever"})
        self.assertEqual(path, Path(MODULE.__file__).resolve().parents[3])
        self.assertEqual(diag, "ops_repo_root_invalid")

    def test_repo_root_falls_back_when_explicit_dir_lacks_r2_sigv4(self) -> None:
        self.root.mkdir(exist_ok=True)
        path, diag = MODULE._resolve_repo_root_with_diagnostics(env={"UK_AQ_OPS_REPO_ROOT": str(self.root)})
        self.assertEqual(path, Path(MODULE.__file__).resolve().parents[3])
        self.assertEqual(diag, "r2_sigv4_missing")

    def test_repo_root_falls_back_when_explicit_env_var_missing(self) -> None:
        path, diag = MODULE._resolve_repo_root_with_diagnostics(env={})
        self.assertEqual(path, Path(MODULE.__file__).resolve().parents[3])
        self.assertEqual(diag, "ops_repo_root_inferred")


if __name__ == "__main__":
    unittest.main()
