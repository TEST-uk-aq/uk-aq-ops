#!/usr/bin/env python3
"""Focused SOS annual-file SQLite single-writer regression checks."""

from __future__ import annotations

import importlib.util
import logging
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = (
    Path(__file__).resolve().parents[1] / "bin" / "uk-aq-history-integrity.py"
)
SPEC = importlib.util.spec_from_file_location(
    "uk_aq_history_integrity_sos_persistence",
    MODULE_PATH,
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module at {MODULE_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

LOG = logging.getLogger("test-sos-sqlite-persistence")


class SosSqlitePersistenceTests(unittest.TestCase):
    def _state_kwargs(
        self,
        source_file_key: str,
        *,
        status: str,
        mapping_hash: str = "a" * 64,
    ) -> dict[str, object]:
        site_ref = source_file_key.split("site_ref=", 1)[1].split(":", 1)[0]
        return {
            "source_key": MODULE.SOS_SOURCE_KEY,
            "remote_scheme": "uk_air_flat_file",
            "source_file_key": source_file_key,
            "env_name": "CIC-Test",
            "remote_url_or_key": f"https://example.test/{site_ref}_2026.csv",
            "station_ref": site_ref,
            "source_location_id": site_ref,
            "day": MODULE.dt.date(2026, 1, 1),
            "exists_remote": True,
            "content_length": 10,
            "etag": '"fixture"',
            "last_modified_utc": "Wed, 15 Jul 2026 00:00:00 GMT",
            "sha256_downloaded": "f" * 64,
            "sha256_uncompressed": "f" * 64,
            "local_cached_path": None,
            "now_iso": "2026-07-25T00:00:00Z",
            "last_changed_at": None,
            "last_status": status,
            "notes": "focused persistence fixture",
            "source_count_mapping_identity": MODULE.SOS_BRIDGE_MAPPING_IDENTITY,
            "source_count_mapping_hash": mapping_hash,
        }

    def test_parallel_parse_and_serialized_complete_workers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            db_path = root / "integrity.sqlite"
            MODULE.open_db(str(db_path)).close()
            cache_root = root / "cache"
            site_refs = [f"T{i:03d}" for i in range(8)]
            grouped_mappings = {
                site_ref: {
                    "pm10": [{
                        "site_ref": site_ref,
                        "pollutant_code": "pm10",
                        "station_id": index + 1,
                        "timeseries_id": index + 1001,
                        "valid_from_day_utc": "2020-01-01",
                        "valid_to_day_utc": None,
                    }],
                }
                for index, site_ref in enumerate(site_refs)
            }
            parse_barrier = MODULE.threading.Barrier(len(site_refs))
            parse_lock = MODULE.threading.Lock()
            parse_active = 0
            max_parse_active = 0

            def fake_get(_url: str, destination: Path, **_kwargs: object) -> int:
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(b"fixture")
                return 7

            def fake_parse(
                _path: Path,
                *,
                target_pollutants: object,
            ) -> tuple[dict[tuple[str, str], int], dict[str, int]]:
                nonlocal parse_active, max_parse_active
                self.assertEqual(tuple(target_pollutants), ("pm10",))
                with parse_lock:
                    parse_active += 1
                    max_parse_active = max(max_parse_active, parse_active)
                parse_barrier.wait(timeout=5)
                MODULE.time.sleep(0.01)
                with parse_lock:
                    parse_active -= 1
                return {("2026-07-15", "pm10"): 1}, {"rows": 1}

            with mock.patch.object(MODULE, "_http_head", return_value={
                "status": 200,
                "etag": '"fixture"',
                "content_length": 7,
                "last_modified": "Wed, 15 Jul 2026 00:00:00 GMT",
            }), mock.patch.object(
                MODULE,
                "_http_get_to_file",
                side_effect=fake_get,
            ), mock.patch.object(
                MODULE,
                "_uk_air_flat_file_parse_day_pollutant_counts",
                side_effect=fake_parse,
            ):
                with MODULE.concurrent.futures.ThreadPoolExecutor(
                    max_workers=len(site_refs),
                ) as executor:
                    futures = [
                        executor.submit(
                            MODULE._check_one_sos_uk_air_flat_file_threadsafe,
                            str(db_path),
                            "CIC-Test",
                            "https://example.test",
                            site_ref,
                            2026,
                            grouped_mappings,
                            ("pm10",),
                            cache_root,
                            "all",
                            "2026-07-15",
                            "2026-07-15",
                            ("2026-07-15",),
                            MODULE.SOS_BRIDGE_MAPPING_IDENTITY,
                            "a" * 64,
                            LOG,
                        )
                        for site_ref in site_refs
                    ]
                    results = [future.result(timeout=10) for future in futures]

            conn = sqlite3.connect(db_path)
            state_count = conn.execute(
                "SELECT COUNT(*) FROM source_file_state",
            ).fetchone()[0]
            count_row_count = conn.execute(
                "SELECT COUNT(*) FROM source_file_timeseries_counts",
            ).fetchone()[0]
            conn.close()

        self.assertGreater(max_parse_active, 1)
        self.assertEqual(state_count, len(site_refs))
        self.assertEqual(count_row_count, len(site_refs))
        self.assertEqual(
            sum(result["persistence_success_count"] for result in results),
            len(site_refs),
        )
        self.assertEqual(
            sum(result["worker_database_locked_count"] for result in results),
            0,
        )

    def test_complete_file_commit_rollback_and_source_file_scoping(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "atomic.sqlite"
            conn = MODULE.open_db(str(db_path))
            source_a = "sos:site_ref=AAA:year=2026"
            source_b = "sos:site_ref=BBB:year=2026"
            MODULE._record_source_file_timeseries_counts(
                conn,
                source_a,
                {("2026-07-15", 1001): 2},
                "2026-07-25T00:00:00Z",
            )
            MODULE._record_source_file_timeseries_counts(
                conn,
                source_b,
                {("2026-07-15", 2001): 9},
                "2026-07-25T00:00:00Z",
            )
            MODULE._upsert_source_state(
                conn,
                **self._state_kwargs(source_a, status="old"),
            )
            conn.commit()

            def failed_complete_file(db: sqlite3.Connection) -> None:
                MODULE._record_source_file_timeseries_counts(
                    db,
                    source_a,
                    {("2026-07-15", 1001): 7},
                    "2026-07-25T01:00:00Z",
                )
                MODULE._upsert_source_state(
                    db,
                    **self._state_kwargs(source_a, status="new"),
                )
                MODULE._insert_source_event(
                    conn=db,
                    source_key=MODULE.SOS_SOURCE_KEY,
                    event_type="changed",
                    env_name="CIC-Test",
                    source_file_key=source_a,
                    remote_url_or_key="https://example.test/AAA_2026.csv",
                    station_ref="AAA",
                    source_location_id="AAA",
                    day=MODULE.dt.date(2026, 1, 1),
                    prior=None,
                    new_content_length=10,
                    new_etag='"fixture"',
                    new_last_modified_utc=None,
                    new_sha256_downloaded="f" * 64,
                    new_sha256_uncompressed="f" * 64,
                    downloaded_bytes=10,
                    hash_runtime_ms=0,
                    now_iso="2026-07-25T01:00:00Z",
                )
                raise RuntimeError("fixture failure after all mutations")

            with self.assertRaises(MODULE.SosSqlitePersistenceError):
                MODULE._run_sos_sqlite_persistence_transaction(
                    conn,
                    source_file_key=source_a,
                    stage="complete_file",
                    operation=failed_complete_file,
                    log=LOG,
                )

            counts_after_rollback = conn.execute(
                """
                SELECT source_file_key, timeseries_id, row_count
                FROM source_file_timeseries_counts
                ORDER BY source_file_key
                """,
            ).fetchall()
            state_after_rollback = conn.execute(
                "SELECT last_status FROM source_file_state WHERE source_file_key = ?",
                (source_a,),
            ).fetchone()[0]
            events_after_rollback = conn.execute(
                "SELECT COUNT(*) FROM source_file_events",
            ).fetchone()[0]

            def successful_complete_file(db: sqlite3.Connection) -> None:
                MODULE._record_source_file_timeseries_counts(
                    db,
                    source_a,
                    {("2026-07-15", 1001): 7},
                    "2026-07-25T02:00:00Z",
                )
                MODULE._upsert_source_state(
                    db,
                    **self._state_kwargs(source_a, status="new"),
                )
                MODULE._insert_source_event(
                    conn=db,
                    source_key=MODULE.SOS_SOURCE_KEY,
                    event_type="changed",
                    env_name="CIC-Test",
                    source_file_key=source_a,
                    remote_url_or_key="https://example.test/AAA_2026.csv",
                    station_ref="AAA",
                    source_location_id="AAA",
                    day=MODULE.dt.date(2026, 1, 1),
                    prior=None,
                    new_content_length=10,
                    new_etag='"fixture"',
                    new_last_modified_utc=None,
                    new_sha256_downloaded="f" * 64,
                    new_sha256_uncompressed="f" * 64,
                    downloaded_bytes=10,
                    hash_runtime_ms=0,
                    now_iso="2026-07-25T02:00:00Z",
                )

            result = MODULE._run_sos_sqlite_persistence_transaction(
                conn,
                source_file_key=source_a,
                stage="complete_file",
                operation=successful_complete_file,
                log=LOG,
            )
            counts_after_commit = conn.execute(
                """
                SELECT source_file_key, timeseries_id, row_count
                FROM source_file_timeseries_counts
                ORDER BY source_file_key
                """,
            ).fetchall()
            state_after_commit = conn.execute(
                "SELECT last_status FROM source_file_state WHERE source_file_key = ?",
                (source_a,),
            ).fetchone()[0]
            events_after_commit = conn.execute(
                "SELECT COUNT(*) FROM source_file_events",
            ).fetchone()[0]
            conn.close()

        self.assertEqual(counts_after_rollback, [
            (source_a, 1001, 2),
            (source_b, 2001, 9),
        ])
        self.assertEqual(state_after_rollback, "old")
        self.assertEqual(events_after_rollback, 0)
        self.assertEqual(counts_after_commit, [
            (source_a, 1001, 7),
            (source_b, 2001, 9),
        ])
        self.assertEqual(state_after_commit, "new")
        self.assertEqual(events_after_commit, 1)
        self.assertEqual(result["persistence_success_count"], 1)

    def test_busy_retry_succeeds_and_exhaustion_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "busy.sqlite"
            setup = MODULE.open_db(str(db_path))
            setup.execute("CREATE TABLE retry_fixture (value TEXT NOT NULL)")
            setup.commit()
            setup.close()

            blocker = sqlite3.connect(db_path, check_same_thread=False)
            blocker.execute("BEGIN IMMEDIATE")
            worker = MODULE._open_sos_worker_db_conn(str(db_path))
            release = MODULE.threading.Timer(0.35, blocker.commit)
            release.start()
            success = MODULE._run_sos_sqlite_persistence_transaction(
                worker,
                source_file_key="sos:site_ref=RETRY:year=2026",
                stage="complete_file",
                operation=lambda db: db.execute(
                    "INSERT INTO retry_fixture (value) VALUES ('success')",
                ),
                log=LOG,
            )
            release.join(timeout=2)
            blocker.close()
            worker.close()

            blocker = sqlite3.connect(db_path)
            blocker.execute("BEGIN IMMEDIATE")
            worker = MODULE._open_sos_worker_db_conn(str(db_path))
            with self.assertRaises(
                MODULE.SosSqlitePersistenceLockedError,
            ) as raised:
                MODULE._run_sos_sqlite_persistence_transaction(
                    worker,
                    source_file_key="sos:site_ref=EXHAUST:year=2026",
                    stage="complete_file",
                    operation=lambda db: db.execute(
                        "INSERT INTO retry_fixture (value) VALUES ('unexpected')",
                    ),
                    log=LOG,
                    max_attempts=2,
                    max_elapsed_seconds=2,
                    retry_base_seconds=0.01,
                    retry_max_seconds=0.01,
                )
            worker.close()
            blocker.rollback()
            blocker.close()

            check = sqlite3.connect(db_path)
            values = check.execute(
                "SELECT value FROM retry_fixture ORDER BY value",
            ).fetchall()
            check.close()

        self.assertGreaterEqual(success["worker_database_locked_count"], 1)
        self.assertGreaterEqual(success["worker_database_retry_count"], 1)
        self.assertEqual(success["worker_database_retry_exhausted_count"], 0)
        self.assertEqual(raised.exception.locked_count, 2)
        self.assertEqual(raised.exception.retry_count, 1)
        self.assertEqual(values, [("success",)])

    def test_current_mapping_cache_reuse_and_stale_mapping_rebuild(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            db_path = root / "mapping.sqlite"
            cache_root = root / "cache"
            cache_path = MODULE._uk_air_flat_file_cache_path(
                cache_root,
                "MAP",
                2026,
            )
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            cache_path.write_bytes(b"mapping-cache")
            cache_hash = MODULE.hashlib.sha256(cache_path.read_bytes()).hexdigest()
            current_hash = "c" * 64
            source_file_key = "sos:site_ref=MAP:year=2026"
            conn = MODULE.open_db(str(db_path))
            state = self._state_kwargs(
                source_file_key,
                status="unchanged",
                mapping_hash=current_hash,
            )
            state.update({
                "content_length": cache_path.stat().st_size,
                "sha256_downloaded": cache_hash,
                "sha256_uncompressed": cache_hash,
                "local_cached_path": str(cache_path),
            })
            MODULE._upsert_source_state(conn, **state)
            conn.commit()
            conn.close()
            grouped_mappings = {
                "MAP": {
                    "pm10": [{
                        "site_ref": "MAP",
                        "pollutant_code": "pm10",
                        "station_id": 1,
                        "timeseries_id": 1001,
                        "valid_from_day_utc": "2020-01-01",
                        "valid_to_day_utc": None,
                    }],
                },
            }
            head = {
                "status": 200,
                "etag": '"fixture"',
                "content_length": cache_path.stat().st_size,
                "last_modified": "Wed, 15 Jul 2026 00:00:00 GMT",
            }
            with mock.patch.object(
                MODULE,
                "_http_head",
                return_value=head,
            ), mock.patch.object(
                MODULE,
                "_http_get_to_file",
            ) as get_current, mock.patch.object(
                MODULE,
                "_uk_air_flat_file_parse_day_pollutant_counts",
                return_value=({("2026-07-15", "pm10"): 1}, {"rows": 1}),
            ):
                current = MODULE._check_one_sos_uk_air_flat_file_threadsafe(
                    str(db_path),
                    "CIC-Test",
                    "https://example.test",
                    "MAP",
                    2026,
                    grouped_mappings,
                    ("pm10",),
                    cache_root,
                    "all",
                    "2026-07-15",
                    "2026-07-15",
                    ("2026-07-15",),
                    MODULE.SOS_BRIDGE_MAPPING_IDENTITY,
                    current_hash,
                    LOG,
                )
            get_current.assert_not_called()

            conn = sqlite3.connect(db_path)
            conn.execute(
                """
                UPDATE source_file_state
                SET source_count_mapping_hash = ?
                WHERE source_file_key = ?
                """,
                ("b" * 64, source_file_key),
            )
            conn.commit()
            conn.close()
            with mock.patch.object(
                MODULE,
                "_http_head",
                return_value=head,
            ), mock.patch.object(
                MODULE,
                "_http_get_to_file",
            ) as get_stale, mock.patch.object(
                MODULE,
                "_uk_air_flat_file_parse_day_pollutant_counts",
                return_value=({("2026-07-15", "pm10"): 1}, {"rows": 1}),
            ):
                stale = MODULE._check_one_sos_uk_air_flat_file_threadsafe(
                    str(db_path),
                    "CIC-Test",
                    "https://example.test",
                    "MAP",
                    2026,
                    grouped_mappings,
                    ("pm10",),
                    cache_root,
                    "all",
                    "2026-07-15",
                    "2026-07-15",
                    ("2026-07-15",),
                    MODULE.SOS_BRIDGE_MAPPING_IDENTITY,
                    current_hash,
                    LOG,
                )
            get_stale.assert_not_called()

        self.assertTrue(current["cache_reused"])
        self.assertFalse(current["counts_rebuilt_for_bridge_change"])
        self.assertTrue(stale["cache_reused"])
        self.assertTrue(stale["counts_rebuilt_for_bridge_change"])

    def test_mapping_network_and_database_failures_are_reported_separately(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            db_path = root / "reporting.sqlite"
            conn = MODULE.open_db(str(db_path))
            env = {
                "UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR": str(root / "cache"),
                "UK_AQ_HISTORY_INTEGRITY_DB_PATH": str(db_path),
            }
            mapping_rows = [
                {
                    "site_ref": site_ref,
                    "pollutant_code": "pm10",
                    "station_id": index + 1,
                    "timeseries_id": index + 1001,
                    "valid_from_day_utc": "2020-01-01",
                    "valid_to_day_utc": None,
                }
                for index, site_ref in enumerate(("DBE", "MAP", "NET"))
            ]

            def fake_worker(*args: object, **_kwargs: object) -> dict[str, object]:
                site_ref = str(args[3])
                if site_ref == "DBE":
                    raise MODULE.SosSqlitePersistenceLockedError(
                        source_file_key="sos:site_ref=DBE:year=2026",
                        stage="complete_file",
                        locked_count=2,
                        retry_count=1,
                        attempts=2,
                        elapsed_seconds=0.5,
                        cause=sqlite3.OperationalError("database is locked"),
                    )
                outcome = "temporary_error" if site_ref == "NET" else "unchanged"
                mapping_issues = 2 if site_ref == "MAP" else 0
                return {
                    "site_ref": site_ref,
                    "year": 2026,
                    "outcome": outcome,
                    "snapshot_status": (
                        MODULE.SOS_STATUS_TEMP_ERROR
                        if site_ref == "NET"
                        else MODULE.SOS_STATUS_OK
                    ),
                    "unmapped_source_groups": mapping_issues,
                    "ambiguous_mapping_groups": 0,
                    "persistence_success_count": 1,
                }

            with mock.patch.object(
                MODULE,
                "_fetch_uk_air_flat_file_mapping_rows",
                return_value=mapping_rows,
            ), mock.patch.object(
                MODULE,
                "_check_one_sos_uk_air_flat_file_threadsafe",
                side_effect=fake_worker,
            ):
                result = MODULE.check_sos_flat_files(
                    conn=conn,
                    env_name="CIC-Test",
                    env=env,
                    from_day="2026-07-15",
                    to_day="2026-07-15",
                    dry_run=False,
                    run_backfill=False,
                    limits=MODULE.LimitTracker(
                        max_download_mb=None,
                        max_runtime_minutes=None,
                        started_mono=MODULE.time.monotonic(),
                    ),
                    log=LOG,
                    concurrency=3,
                )
            conn.close()

        self.assertEqual(result["mapping_issue_count"], 2)
        self.assertEqual(result["network_error_count"], 1)
        self.assertEqual(result["persistence_failed_count"], 1)
        self.assertEqual(result["persistence_success_count"], 2)
        self.assertEqual(result["worker_database_locked_count"], 2)
        self.assertEqual(result["worker_database_retry_count"], 1)
        self.assertEqual(result["worker_database_retry_exhausted_count"], 1)
        self.assertEqual(result["errors"], 4)


if __name__ == "__main__":
    unittest.main()
