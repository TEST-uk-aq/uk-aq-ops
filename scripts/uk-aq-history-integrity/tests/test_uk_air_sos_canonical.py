#!/usr/bin/env python3
"""Tests for UK-AIR SOS canonical snapshot helpers."""

from __future__ import annotations

import importlib.util
import logging
import os
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path


MODULE_PATH = (
    Path(__file__).resolve().parents[1] / "bin" / "uk-aq-history-integrity.py"
)
SPEC = importlib.util.spec_from_file_location("uk_aq_history_integrity", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module at {MODULE_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class UkAirSosCanonicalTests(unittest.TestCase):
    def test_source_file_key_and_cache_path_are_deterministic(self) -> None:
        key = MODULE._uk_air_sos_source_file_key("AB/123", MODULE.dt.date(2026, 5, 11))
        self.assertEqual(key, "uk_air_sos:station_ref=AB/123:day_utc=2026-05-11")

        cache_path = MODULE._uk_air_sos_cache_path(
            Path("/tmp/cache"),
            "AB/123",
            MODULE.dt.date(2026, 5, 11),
        )
        self.assertEqual(
            str(cache_path),
            "/tmp/cache/station_ref=AB%2F123/day_utc=2026-05-11/snapshot.ndjson",
        )

    def test_keep_api_snapshots_policy_defaults_and_validates(self) -> None:
        key = MODULE.UK_AQ_HISTORY_INTEGRITY_KEEP_API_SNAPSHOTS_ENV
        original = os.environ.get(key)
        try:
            os.environ.pop(key, None)
            self.assertEqual(MODULE._resolve_keep_api_snapshots_policy(), "changed")
            os.environ[key] = "all"
            self.assertEqual(MODULE._resolve_keep_api_snapshots_policy(), "all")
            os.environ[key] = "invalid"
            self.assertEqual(MODULE._resolve_keep_api_snapshots_policy(), "changed")
        finally:
            if original is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = original

    def test_canonical_rows_are_sorted_and_stable(self) -> None:
        payloads = {
            "ts-b": {"values": [["2026-05-11T01:00:00Z", 11], ["2026-05-11T00:00:00Z", 10]]},
            "ts-a": {"values": [["2026-05-11T00:30:00Z", 3], ["2026-05-11T00:15:00Z", 2]]},
        }

        def fake_fetcher(base_url: str, day_utc: str, timeseries_ref: str, timespan: str, timeout_seconds: int):
            return {"status": "ok", "payload": payloads[timeseries_ref], "error": None}

        bindings = [
            {"timeseries_id": 9, "timeseries_ref": "ts-b"},
            {"timeseries_id": 4, "timeseries_ref": "ts-a"},
        ]
        first = MODULE.build_uk_air_sos_canonical_snapshot(
            station_ref="station-1",
            day_utc="2026-05-11",
            timeseries_bindings=bindings,
            fetcher=fake_fetcher,
        )
        second = MODULE.build_uk_air_sos_canonical_snapshot(
            station_ref="station-1",
            day_utc="2026-05-11",
            timeseries_bindings=list(reversed(bindings)),
            fetcher=fake_fetcher,
        )

        self.assertEqual(first["status"], "ok")
        self.assertEqual(first["rows"], second["rows"])
        self.assertEqual(first["ndjson_bytes"], second["ndjson_bytes"])
        ordered = [(row["timeseries_id"], row["observed_at_utc"]) for row in first["rows"]]
        self.assertEqual(
            ordered,
            [
                (4, "2026-05-11T00:15:00Z"),
                (4, "2026-05-11T00:30:00Z"),
                (9, "2026-05-11T00:00:00Z"),
                (9, "2026-05-11T01:00:00Z"),
            ],
        )

    def test_day_window_filtering_excludes_outside_rows(self) -> None:
        def fake_fetcher(base_url: str, day_utc: str, timeseries_ref: str, timespan: str, timeout_seconds: int):
            return {
                "status": "ok",
                "payload": {
                    "values": [
                        ["2026-05-10T23:59:59Z", 1],
                        ["2026-05-11T00:00:00Z", 2],
                        ["2026-05-11T23:59:59Z", 3],
                        ["2026-05-12T00:00:00Z", 4],
                    ],
                },
                "error": None,
            }

        result = MODULE.build_uk_air_sos_canonical_snapshot(
            station_ref="station-1",
            day_utc="2026-05-11",
            timeseries_bindings=[{"timeseries_id": 101, "timeseries_ref": "ts-101"}],
            fetcher=fake_fetcher,
        )
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["row_count"], 2)
        self.assertEqual(
            [row["observed_at_utc"] for row in result["rows"]],
            ["2026-05-11T00:00:00Z", "2026-05-11T23:59:59Z"],
        )

    def test_empty_successful_snapshot_returns_no_data(self) -> None:
        def fake_fetcher(base_url: str, day_utc: str, timeseries_ref: str, timespan: str, timeout_seconds: int):
            return {"status": "ok", "payload": {"values": []}, "error": None}

        result = MODULE.build_uk_air_sos_canonical_snapshot(
            station_ref="station-1",
            day_utc="2026-05-11",
            timeseries_bindings=[{"timeseries_id": 1, "timeseries_ref": "ts-1"}],
            fetcher=fake_fetcher,
        )
        self.assertEqual(result["status"], "no_data")
        self.assertEqual(result["row_count"], 0)
        self.assertEqual(result["ndjson_bytes"], b"")
        self.assertEqual(
            result["sha256"],
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        )

    def test_temporary_error_does_not_emit_snapshot_bytes(self) -> None:
        def fake_fetcher(base_url: str, day_utc: str, timeseries_ref: str, timespan: str, timeout_seconds: int):
            return {
                "status": "temporary_error",
                "payload": None,
                "error": "timeout",
            }

        result = MODULE.build_uk_air_sos_canonical_snapshot(
            station_ref="station-1",
            day_utc="2026-05-11",
            timeseries_bindings=[{"timeseries_id": 1, "timeseries_ref": "ts-1"}],
            fetcher=fake_fetcher,
        )
        self.assertEqual(result["status"], "temporary_error")
        self.assertEqual(result["row_count"], 0)
        self.assertEqual(result["ndjson_bytes"], b"")
        self.assertIsNone(result["sha256"])

    def _new_conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(":memory:")
        conn.executescript(MODULE.SCHEMA_SQL)
        return conn

    def test_collect_source_change_targets_uses_changed_files_only(self) -> None:
        conn = self._new_conn()
        conn.execute(
            "INSERT INTO core_connectors_snapshot (id, connector_code, label, display_name, service_url) VALUES (?, ?, ?, ?, ?)",
            (6, "uk_air_sos", "UK-AIR SOS", "UK-AIR SOS", None),
        )
        conn.execute(
            "INSERT INTO core_timeseries_snapshot (id, station_id, connector_id, timeseries_ref, label, phenomenon_id, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (101, 1, 6, "ts-101", None, None, None),
        )
        conn.execute(
            "INSERT INTO core_timeseries_snapshot (id, station_id, connector_id, timeseries_ref, label, phenomenon_id, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (102, 1, 6, "ts-102", None, None, None),
        )
        conn.commit()

        metrics = {
            "first_seen_files": [{"day": "2026-05-11", "timeseries_ids": [101]}],
            "changed_files": [{"day": "2026-05-11", "timeseries_ids": [101, 102]}],
        }
        targets = MODULE._collect_uk_air_sos_source_change_targets(
            conn,
            source_filter="uk_air_sos",
            uk_air_sos_metrics=metrics,
        )
        self.assertEqual(targets, {("2026-05-11", 6): [101, 102]})

    def test_merge_observation_repair_targets_dedupes_by_connector_day_timeseries(self) -> None:
        merged, origins = MODULE._merge_observation_repair_targets(
            {("2026-05-11", 6): [101, 102], ("2026-05-12", 6): [201]},
            {("2026-05-11", 6): [102, 103]},
        )
        self.assertEqual(
            merged,
            {
                ("2026-05-11", 6): [101, 102, 103],
                ("2026-05-12", 6): [201],
            },
        )
        self.assertEqual(origins[("2026-05-11", 6)], ["cross_check", "source_change"])

    def test_run_cross_check_backfills_first_seen_only_has_no_candidates(self) -> None:
        conn = self._new_conn()
        conn.execute(
            "INSERT INTO core_connectors_snapshot (id, connector_code, label, display_name, service_url) VALUES (?, ?, ?, ?, ?)",
            (6, "uk_air_sos", "UK-AIR SOS", "UK-AIR SOS", None),
        )
        conn.commit()

        with tempfile.TemporaryDirectory() as tmp:
            metrics = MODULE.run_cross_check_backfills(
                conn=conn,
                run_id=1,
                env_name="CIC-Test",
                run_compact="20260518T000000Z",
                env={"UK_AQ_HISTORY_INTEGRITY_LOG_DIR": tmp},
                source_filter="uk_air_sos",
                uk_air_sos_metrics={
                    "first_seen_files": [{"day": "2026-05-11", "timeseries_ids": [101]}],
                    "changed_files": [],
                },
                dry_run=True,
                run_backfill=True,
                limits=MODULE.LimitTracker(
                    max_download_mb=None,
                    max_runtime_minutes=None,
                    started_mono=time.monotonic(),
                ),
                log=logging.getLogger("test-first-seen-no-candidates"),
            )
        self.assertEqual(metrics["observation_backfill_candidate_days"], 0)
        self.assertEqual(metrics["observation_backfill_candidate_timeseries_ids"], 0)

    def test_run_cross_check_backfills_not_found_only_has_no_candidates(self) -> None:
        conn = self._new_conn()
        conn.execute(
            "INSERT INTO core_connectors_snapshot (id, connector_code, label, display_name, service_url) VALUES (?, ?, ?, ?, ?)",
            (6, "uk_air_sos", "UK-AIR SOS", "UK-AIR SOS", None),
        )
        conn.commit()

        with tempfile.TemporaryDirectory() as tmp:
            metrics = MODULE.run_cross_check_backfills(
                conn=conn,
                run_id=1,
                env_name="CIC-Test",
                run_compact="20260518T000000Z",
                env={"UK_AQ_HISTORY_INTEGRITY_LOG_DIR": tmp},
                source_filter="uk_air_sos",
                uk_air_sos_metrics={
                    "not_found": 1,
                    "changed_files": [],
                },
                dry_run=True,
                run_backfill=True,
                limits=MODULE.LimitTracker(
                    max_download_mb=None,
                    max_runtime_minutes=None,
                    started_mono=time.monotonic(),
                ),
                log=logging.getLogger("test-not-found-no-candidates"),
            )
        self.assertEqual(metrics["observation_backfill_candidate_days"], 0)
        self.assertEqual(metrics["observation_backfill_candidate_timeseries_ids"], 0)

    def test_run_cross_check_backfills_merges_cross_check_and_source_change(self) -> None:
        conn = self._new_conn()
        conn.execute(
            "INSERT INTO core_connectors_snapshot (id, connector_code, label, display_name, service_url) VALUES (?, ?, ?, ?, ?)",
            (6, "uk_air_sos", "UK-AIR SOS", "UK-AIR SOS", None),
        )
        conn.execute(
            "INSERT INTO core_timeseries_snapshot (id, station_id, connector_id, timeseries_ref, label, phenomenon_id, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (101, 1, 6, "ts-101", None, None, None),
        )
        conn.execute(
            "INSERT INTO core_timeseries_snapshot (id, station_id, connector_id, timeseries_ref, label, phenomenon_id, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (102, 1, 6, "ts-102", None, None, None),
        )
        conn.execute(
            "INSERT INTO core_timeseries_snapshot (id, station_id, connector_id, timeseries_ref, label, phenomenon_id, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (103, 1, 6, "ts-103", None, None, None),
        )
        conn.executemany(
            """
            INSERT INTO cross_checks (
              run_id, env_name, connector_id, day_utc, timeseries_id,
              source_row_count, r2_row_count, delta, status, checked_at_utc, notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (1, "CIC-Test", 6, "2026-05-11", 101, 10, 9, 1, "mismatch", "2026-05-18T00:00:00Z", None),
                (1, "CIC-Test", 6, "2026-05-11", 102, 3, None, 3, "source_only", "2026-05-18T00:00:00Z", None),
            ],
        )
        conn.commit()

        with tempfile.TemporaryDirectory() as tmp:
            metrics = MODULE.run_cross_check_backfills(
                conn=conn,
                run_id=1,
                env_name="CIC-Test",
                run_compact="20260518T000000Z",
                env={"UK_AQ_HISTORY_INTEGRITY_LOG_DIR": tmp},
                source_filter="uk_air_sos",
                uk_air_sos_metrics={
                    "changed_files": [{"day": "2026-05-11", "timeseries_ids": [102, 103]}],
                },
                dry_run=True,
                run_backfill=True,
                limits=MODULE.LimitTracker(
                    max_download_mb=None,
                    max_runtime_minutes=None,
                    started_mono=time.monotonic(),
                ),
                log=logging.getLogger("test-merge-candidates"),
            )

        self.assertEqual(metrics["source_change_candidate_days"], 1)
        self.assertEqual(metrics["source_change_candidate_timeseries_ids"], 2)
        self.assertEqual(metrics["observation_backfill_candidate_days"], 1)
        self.assertEqual(metrics["observation_backfill_candidate_timeseries_ids"], 3)
        self.assertEqual(len(metrics["planned_observation_backfills"]), 1)
        self.assertIn("UK_AQ_BACKFILL_OUTPUT_SCOPE=observations_only", metrics["planned_observation_backfills"][0])
        self.assertIn("UK_AQ_BACKFILL_CONNECTOR_IDS=6", metrics["planned_observation_backfills"][0])
        self.assertIn("UK_AQ_BACKFILL_TIMESERIES_IDS=101,102,103", metrics["planned_observation_backfills"][0])
        self.assertEqual(metrics["aqi_rebuilds_queued_from_obs_repair"], 1)

    def test_no_data_baselines_zero_counts(self) -> None:
        conn = self._new_conn()
        original = MODULE.build_uk_air_sos_canonical_snapshot
        try:
            MODULE.build_uk_air_sos_canonical_snapshot = lambda **kwargs: {
                "status": MODULE.UK_AIR_SOS_STATUS_NO_DATA,
                "row_count": 0,
                "rows": [],
                "ndjson_bytes": b"",
                "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            }
            result = MODULE._check_one_uk_air_sos_station_day(
                conn=conn,
                env_name="CIC-Test",
                base_url="https://example.test",
                station_ref="station-1",
                bindings=[{"timeseries_id": 101, "timeseries_ref": "ts-101"}],
                day=MODULE.dt.date(2026, 5, 11),
                cache_root=Path("/tmp/ignore"),
                keep_policy="none",
                not_found_cooldown_seconds=0,
                log=logging.getLogger("test-no-data"),
            )
        finally:
            MODULE.build_uk_air_sos_canonical_snapshot = original

        self.assertEqual(result["snapshot_status"], MODULE.UK_AIR_SOS_STATUS_NO_DATA)
        self.assertEqual(result["outcome"], "first_seen")
        state = conn.execute(
            "SELECT exists_remote, last_status FROM source_file_state WHERE source_file_key = ?",
            ("uk_air_sos:station_ref=station-1:day_utc=2026-05-11",),
        ).fetchone()
        self.assertEqual(state, (1, "first_seen"))
        row = conn.execute(
            "SELECT COUNT(*) FROM source_file_timeseries_counts WHERE source_file_key = ?",
            ("uk_air_sos:station_ref=station-1:day_utc=2026-05-11",),
        ).fetchone()
        self.assertEqual(int(row[0]), 0)

    def test_no_data_snapshot_is_not_cached_even_when_keep_policy_all(self) -> None:
        conn = self._new_conn()
        original = MODULE.build_uk_air_sos_canonical_snapshot
        with tempfile.TemporaryDirectory() as tmp:
            cache_root = Path(tmp)
            try:
                MODULE.build_uk_air_sos_canonical_snapshot = lambda **kwargs: {
                    "status": MODULE.UK_AIR_SOS_STATUS_NO_DATA,
                    "row_count": 0,
                    "rows": [],
                    "ndjson_bytes": b"",
                    "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                }
                result = MODULE._check_one_uk_air_sos_station_day(
                    conn=conn,
                    env_name="CIC-Test",
                    base_url="https://example.test",
                    station_ref="station-1",
                    bindings=[{"timeseries_id": 101, "timeseries_ref": "ts-101"}],
                    day=MODULE.dt.date(2026, 5, 11),
                    cache_root=cache_root,
                    keep_policy="all",
                    not_found_cooldown_seconds=0,
                    log=logging.getLogger("test-no-data-no-cache"),
                )
            finally:
                MODULE.build_uk_air_sos_canonical_snapshot = original

            cache_path = MODULE._uk_air_sos_cache_path(
                cache_root,
                "station-1",
                MODULE.dt.date(2026, 5, 11),
            )
            self.assertEqual(result["snapshot_status"], MODULE.UK_AIR_SOS_STATUS_NO_DATA)
            self.assertFalse(cache_path.exists())
            state = conn.execute(
                "SELECT exists_remote, content_length, local_cached_path, last_status FROM source_file_state WHERE source_file_key = ?",
                ("uk_air_sos:station_ref=station-1:day_utc=2026-05-11",),
            ).fetchone()
            self.assertEqual(state, (1, 0, None, "first_seen"))

    def test_temporary_error_does_not_overwrite_previous_baseline(self) -> None:
        conn = self._new_conn()
        original = MODULE.build_uk_air_sos_canonical_snapshot
        try:
            MODULE.build_uk_air_sos_canonical_snapshot = lambda **kwargs: {
                "status": MODULE.UK_AIR_SOS_STATUS_OK,
                "row_count": 1,
                "rows": [{
                    "timeseries_id": 101,
                    "observed_at_utc": "2026-05-11T00:00:00Z",
                    "value": 1,
                }],
                "ndjson_bytes": b'{"timeseries_id":101}\n',
                "sha256": "sha-ok",
            }
            MODULE._check_one_uk_air_sos_station_day(
                conn=conn,
                env_name="CIC-Test",
                base_url="https://example.test",
                station_ref="station-1",
                bindings=[{"timeseries_id": 101, "timeseries_ref": "ts-101"}],
                day=MODULE.dt.date(2026, 5, 11),
                cache_root=Path("/tmp/ignore"),
                keep_policy="none",
                not_found_cooldown_seconds=0,
                log=logging.getLogger("test-temp-error-initial"),
            )
            MODULE.build_uk_air_sos_canonical_snapshot = lambda **kwargs: {
                "status": MODULE.UK_AIR_SOS_STATUS_TEMP_ERROR,
                "row_count": 0,
                "rows": [],
                "ndjson_bytes": b"",
                "sha256": None,
                "error": "timeout",
            }
            result = MODULE._check_one_uk_air_sos_station_day(
                conn=conn,
                env_name="CIC-Test",
                base_url="https://example.test",
                station_ref="station-1",
                bindings=[{"timeseries_id": 101, "timeseries_ref": "ts-101"}],
                day=MODULE.dt.date(2026, 5, 11),
                cache_root=Path("/tmp/ignore"),
                keep_policy="none",
                not_found_cooldown_seconds=0,
                log=logging.getLogger("test-temp-error-second"),
            )
        finally:
            MODULE.build_uk_air_sos_canonical_snapshot = original

        self.assertEqual(result["outcome"], "temporary_error")
        state = conn.execute(
            "SELECT sha256_uncompressed, last_status FROM source_file_state WHERE source_file_key = ?",
            ("uk_air_sos:station_ref=station-1:day_utc=2026-05-11",),
        ).fetchone()
        self.assertEqual(state, ("sha-ok", "temporary_error"))

    def test_not_found_suppression_skips_refetch_with_cooldown(self) -> None:
        conn = self._new_conn()
        original = MODULE.build_uk_air_sos_canonical_snapshot
        try:
            MODULE.build_uk_air_sos_canonical_snapshot = lambda **kwargs: {
                "status": MODULE.UK_AIR_SOS_STATUS_NOT_FOUND,
                "row_count": 0,
                "rows": [],
                "ndjson_bytes": b"",
                "sha256": None,
                "error": "HTTP 404",
            }
            first = MODULE._check_one_uk_air_sos_station_day(
                conn=conn,
                env_name="CIC-Test",
                base_url="https://example.test",
                station_ref="station-1",
                bindings=[{"timeseries_id": 101, "timeseries_ref": "ts-101"}],
                day=MODULE.dt.date(2026, 5, 11),
                cache_root=Path("/tmp/ignore"),
                keep_policy="none",
                not_found_cooldown_seconds=0,
                log=logging.getLogger("test-not-found-first"),
            )
            self.assertEqual(first["outcome"], "not_found_first_seen")

            def _should_not_fetch_again(**kwargs):
                raise AssertionError("cooldown suppression should skip second fetch")

            MODULE.build_uk_air_sos_canonical_snapshot = _should_not_fetch_again
            second = MODULE._check_one_uk_air_sos_station_day(
                conn=conn,
                env_name="CIC-Test",
                base_url="https://example.test",
                station_ref="station-1",
                bindings=[{"timeseries_id": 101, "timeseries_ref": "ts-101"}],
                day=MODULE.dt.date(2026, 5, 11),
                cache_root=Path("/tmp/ignore"),
                keep_policy="none",
                not_found_cooldown_seconds=3600,
                log=logging.getLogger("test-not-found-second"),
            )
        finally:
            MODULE.build_uk_air_sos_canonical_snapshot = original

        self.assertEqual(second["outcome"], "not_found_suppressed")
        self.assertEqual(second["snapshot_status"], MODULE.UK_AIR_SOS_STATUS_NOT_FOUND)


if __name__ == "__main__":
    unittest.main()
