#!/usr/bin/env python3
from __future__ import annotations

import gzip
import importlib.util
import json
import logging
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

MODULE_PATH = Path(__file__).resolve().parents[1] / "bin" / "uk-aq-history-integrity.py"
SPEC = importlib.util.spec_from_file_location("uk_aq_history_integrity_v2_repair", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module at {MODULE_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
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
            "UK_AQ_R2_HISTORY_DROPBOX_ROOT": str(self.root / "r2-history"),
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

    def _ok_obs_repair_result(
        self,
        rows: int = 1,
        *,
        source_counts: dict[int, int] | None = None,
        pollutant_codes: list[str] | None = None,
    ) -> dict[str, object]:
        source_counts = source_counts or {}
        pollutant_codes = pollutant_codes or []
        return {
            "status": "ok",
            "exit_code": 0,
            "rows_observations": rows,
            "source_connector_day_complete_events": 1,
            "source_connector_day_skipped_events": 0,
            "source_connector_day_pending_events": 0,
            "source_connector_day_failed_events": 0,
            "source_to_r2_targeted_stage_deferred_commit_events": 0,
            "targeted_stage_deferred_rows_observations": 0,
            "max_targeted_stage_deferred_rows_observations": 0,
            "source_timeseries_row_counts": {str(key): value for key, value in source_counts.items()},
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
        pollutant_codes: list[str] | None = None,
    ) -> dict[str, object]:
        source_counts = source_counts or {}
        pollutant_codes = pollutant_codes or []
        return {
            "status": "ok",
            "exit_code": 0,
            "rows_observations": 0,
            "source_connector_day_complete_events": 0,
            "source_connector_day_skipped_events": 0,
            "source_connector_day_pending_events": 0,
            "source_connector_day_failed_events": 0,
            "source_to_r2_targeted_stage_deferred_commit_events": 1,
            "targeted_stage_deferred_rows_observations": rows,
            "max_targeted_stage_deferred_rows_observations": rows,
            "source_timeseries_row_counts": {str(key): value for key, value in source_counts.items()},
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

    def test_v2_dry_run_plans_direct_source_to_v2_repair_and_index(self) -> None:
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
        )
        repair = metrics["planned_v2_observation_repairs"][0]
        self.assertIn("UK_AQ_R2_HISTORY_VERSION=v2", repair)
        self.assertIn("UK_AQ_R2_HISTORY_INDEX_VERSION=v2", repair)
        self.assertNotIn("UK_AQ_R2_HISTORY_WRITE_VERSION", repair)
        self.assertNotIn("UK_AQ_R2_HISTORY_BACKUP_VERSION", repair)
        self.assertIn("UK_AQ_BACKFILL_CONNECTOR_IDS=6", repair)
        self.assertIn("UK_AQ_BACKFILL_TIMESERIES_IDS=101,102", repair)
        self.assertNotIn("v1_dropbox_to_v2_observations_backfill_plan", repair)
        self.assertIn("--history-version v2 --targeted --kind observations", metrics["planned_v2_observation_index_rebuilds"][0])
        self.assertIn("planned_after_obs_repair", metrics["planned_aqi_rebuilds"][0])
        self.assertNotIn("reason=obs_repaired", metrics["planned_aqi_rebuilds"][0])
        self.assertEqual(metrics["aqi_rebuilds_queued_from_obs_repair"], 1)

    def test_source_uk_air_sos_resolves_to_connector_id_1_from_current_metadata(self) -> None:
        conn = MODULE.open_db(str(self.root / "sos-source-scope.sqlite"))
        try:
            conn.execute(
                """
                INSERT INTO source_station_timeseries_lookup (
                  source_key, source_location_id, station_ref, station_id,
                  connector_id, timeseries_id, is_active
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (MODULE.UK_AIR_SOS_SOURCE_KEY, "station-1", "station-1", 1, 1, 1001, 1),
            )
            conn.commit()

            allowed, scope = MODULE.resolve_v2_source_scope(conn, "uk_air_sos")

            self.assertEqual(allowed, {1})
            self.assertEqual(scope, {"source": "uk_air_sos", "connector_ids": [1], "scope": "source"})
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
            self.assertEqual(run_bf.call_args_list[0].kwargs["extra_env"]["UK_AQ_BACKFILL_TARGETED_STAGE_FINALIZE"], "false")
            self.assertEqual(run_bf.call_args_list[1].kwargs["extra_env"]["UK_AQ_BACKFILL_TARGETED_STAGE_FINALIZE"], "false")
            self.assertEqual(run_bf.call_args_list[2].kwargs["extra_env"]["UK_AQ_BACKFILL_TARGETED_STAGE_FINALIZE"], "true")
            self.assertEqual(run_bf.call_args_list[2].kwargs["extra_env"]["UK_AQ_BACKFILL_TARGETED_STAGE_CLEANUP"], "true")
            self.assertEqual(metrics["v2_observation_repairs_attempted"], 3)
            self.assertEqual(metrics["observation_backfills_attempted"], 3)
            self.assertEqual(metrics["v2_observation_repairs_ok"], 1)
            self.assertEqual(metrics["observation_backfills_ok"], 1)
            self.assertEqual(metrics["v2_observation_repairs_failed"], 0)
            self.assertEqual(metrics["aqi_rebuilds_queued_from_obs_repair"], 1)
            self.assertEqual(metrics["v2_observation_repair_results"][0]["chunk_count"], 3)
            self.assertEqual(metrics["v2_observation_repair_results"][0]["ok_chunks"], 3)
            self.assertTrue(metrics["v2_observation_repair_results"][0]["aqi_rebuild_guard_ok"])
            self.assertEqual(metrics["v2_observation_repair_results"][0]["source_to_r2_targeted_stage_deferred_commit_events"], 2)
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
            self.assertIn("targeted_stage_deferred_events=0", result["aqi_rebuild_guard_reason"])
            queued = conn.execute("SELECT COUNT(*) FROM aqi_rebuild_queue").fetchone()[0]
            self.assertEqual(int(queued), 0)
        finally:
            conn.close()

    def test_v2_observation_repair_guard_blocks_aqi_when_final_manifest_misses_source_timeseries(self) -> None:
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
            self.assertIn("manifest_missing_timeseries:1", result["aqi_rebuild_manifest_guard_reason"])
            self.assertEqual(result["aqi_rebuild_manifest_guard"]["missing_timeseries_ids"], [102])
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

    def test_v2_missing_day_gap_repairs_instead_of_skipping(self) -> None:
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
        )

        self.assertEqual(len(metrics["planned_v2_observation_repairs"]), 1)
        self.assertIn("UK_AQ_BACKFILL_CONNECTOR_IDS=6", metrics["planned_v2_observation_repairs"][0])
        self.assertEqual(metrics["aqi_rebuilds_queued_from_obs_repair"], 1)

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
        self.assertEqual(MODULE.adapter_backfill_history_version("v1"), "v1")
        self.assertEqual(MODULE.adapter_backfill_history_version("both"), "v1")

    def test_v1_openaq_unchanged_metadata_without_cache_does_not_force_download(self) -> None:
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

    def test_openaq_adapter_default_history_version_remains_v1(self) -> None:
        worker_result = {
            "outcome": "changed",
            "location_id": 42,
            "day": "2026-06-08",
            "event_id": None,
            "event_type": "changed",
            "timeseries_ids": [101],
            "downloaded_bytes": 0,
        }
        wrapper = str(self.root / "uk_aq_integrity_backfill.sh")
        with mock.patch.object(MODULE, "_openaq_distinct_locations", return_value=[42]), \
             mock.patch.object(MODULE, "_check_one_openaq_file_threadsafe", return_value=worker_result), \
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
            )

        self.assertIn("UK_AQ_R2_HISTORY_VERSION=v1", metrics["planned_backfills"][0])
        self.assertIn("--history-version v1", metrics["planned_backfills"][0])
        self.assertEqual(run_bf.call_args.kwargs["history_version"], "v1")

    def test_v2_aqi_rebuild_queue_executes_connector_scoped_rebuild(self) -> None:
        self._insert_aqi_queue_row(run_id=20, connector_id=6)
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

    def test_v1_aqi_rebuild_queue_keeps_day_wide_rebuild(self) -> None:
        self._insert_aqi_queue_row(run_id=23, connector_id=6)
        self._insert_aqi_queue_row(run_id=23, connector_id=7)
        with mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=str(self.root / "uk_aq_integrity_backfill.sh")), \
             mock.patch.object(MODULE, "run_aqi_rebuild_backfill", return_value={"status": "ok", "log_path": None}) as run_aqi:
            metrics = MODULE.run_aqi_rebuild_queue_execution(
                self.conn,
                run_id=23,
                env_name="CIC-Test",
                run_compact="run",
                env=self.env,
                dry_run=False,
                run_backfill=True,
                limits=MODULE.LimitTracker(max_download_mb=0, max_runtime_minutes=0, started_mono=0.0),
                log=self.log,
                history_version="v1",
            )

        self.assertEqual(metrics["aqi_rebuilds_attempted"], 1)
        self.assertEqual(metrics["aqi_rebuilds_skipped"], 1)
        self.assertIsNone(run_aqi.call_args.kwargs["connector_id"])
        self.assertEqual(run_aqi.call_args.kwargs["history_version"], "v1")

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


if __name__ == "__main__":
    unittest.main()
