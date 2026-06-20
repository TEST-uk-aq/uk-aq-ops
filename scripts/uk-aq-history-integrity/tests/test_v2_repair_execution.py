#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
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
        self.env = {"UK_AQ_HISTORY_INTEGRITY_LOG_DIR": str(self.root / "logs"), "UK_AQ_BACKFILL_ENV_FILE": str(self.root / "backfill.env")}
        self.log = logging.getLogger("v2-repair-test")

    def tearDown(self) -> None:
        self.conn.close()
        self.tmp.cleanup()

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
        self.assertIn("UK_AQ_R2_HISTORY_WRITE_VERSION=v2", repair)
        self.assertIn("UK_AQ_R2_HISTORY_BACKUP_VERSION=v2", repair)
        self.assertIn("UK_AQ_R2_HISTORY_INDEX_VERSION=v2", repair)
        self.assertIn("UK_AQ_BACKFILL_CONNECTOR_IDS=6", repair)
        self.assertIn("UK_AQ_BACKFILL_TIMESERIES_IDS=101,102", repair)
        self.assertNotIn("v1_dropbox_to_v2_observations_backfill_plan", repair)
        self.assertIn("--history-version v2 --targeted --kind observations", metrics["planned_v2_observation_index_rebuilds"][0])
        self.assertEqual(metrics["aqi_rebuilds_queued_from_obs_repair"], 1)

    def test_v2_execution_invokes_wrapper_with_history_version_v2(self) -> None:
        with mock.patch.object(MODULE, "resolve_integrity_backfill_wrapper", return_value=str(self.root / "wrapper.sh")), \
             mock.patch.object(MODULE, "run_narrow_backfill", return_value={"status": "ok"}) as run_bf:
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


if __name__ == "__main__":
    unittest.main()
