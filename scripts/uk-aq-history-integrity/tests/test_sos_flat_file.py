#!/usr/bin/env python3
"""Tests for the UK-AIR SOS flat-file CSV integrity adapter."""

from __future__ import annotations

import importlib.util
import logging
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = (
    Path(__file__).resolve().parents[1] / "bin" / "uk-aq-history-integrity.py"
)
SPEC = importlib.util.spec_from_file_location("uk_aq_history_integrity", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module at {MODULE_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SosFlatFileTests(unittest.TestCase):
    def _new_conn(self) -> sqlite3.Connection:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "flat-file.sqlite"
            return MODULE.open_db(str(db_path))

    def _make_conn(self, db_path: Path) -> sqlite3.Connection:
        return MODULE.open_db(str(db_path))

    def test_source_mode_defaults_to_flat_files(self) -> None:
        self.assertEqual(MODULE._resolve_sos_source_mode({}), "uk_air_flat_files")
        self.assertEqual(
            MODULE._resolve_sos_source_mode({
                MODULE.UK_AQ_HISTORY_INTEGRITY_SOS_SOURCE_MODE_ENV: "sos_api",
            }),
            "sos_api",
        )

    def test_flat_file_source_key_url_and_cache_path_are_deterministic(self) -> None:
        self.assertEqual(
            MODULE._uk_air_flat_file_source_file_key("ea8", 2026),
            "sos:site_ref=EA8:year=2026",
        )
        self.assertEqual(
            MODULE._uk_air_flat_file_remote_url(
                "https://uk-air.defra.gov.uk/datastore/data_files/site_data",
                "ea8",
                2026,
            ),
            "https://uk-air.defra.gov.uk/datastore/data_files/site_data/EA8_2026.csv?v=1",
        )
        self.assertEqual(
            str(
                MODULE._uk_air_flat_file_cache_path(
                    Path("/tmp/cache"),
                    "ea8",
                    2026,
                ),
            ),
            "/tmp/cache/site_ref=EA8/year=2026/EA8_2026.csv",
        )

    def test_flat_file_parser_counts_rows_by_day_and_pollutant(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = Path(tmp) / "EA8_2026.csv"
            csv_path.write_text(
                "\n".join(
                    [
                        "Station metadata",
                        'Date,time,"PM<sub>10</sub> particulate matter (Hourly measured)",status,unit',
                        "17-05-2026,01:00,10,R,ugm-3",
                        "17-05-2026,02:00,11,R,ugm-3",
                        'Date,time,"Nitrogen dioxide (Hourly measured)",status,unit',
                        "17-05-2026,01:00,20,R,ugm-3",
                        "18-05-2026,01:00,21,R,ugm-3",
                        "",
                    ]
                ),
                encoding="utf-8",
            )
            counts, stats = MODULE._uk_air_flat_file_parse_day_pollutant_counts(
                csv_path,
                target_pollutants=("pm10", "no2"),
            )

        self.assertEqual(
            counts,
            {
                ("2026-05-17", "pm10"): 2,
                ("2026-05-17", "no2"): 1,
                ("2026-05-18", "no2"): 1,
            },
        )
        self.assertEqual(stats["rows"], 4)
        self.assertEqual(stats["days"], ["2026-05-17", "2026-05-18"])
        self.assertEqual(stats["pollutants"], ["no2", "pm10"])

    def test_mapping_resolution_respects_validity_window(self) -> None:
        rows = [
            {
                "site_ref": "EA8",
                "pollutant_code": "pm10",
                "station_id": 1,
                "timeseries_id": 66,
                "valid_from_day_utc": "2020-01-01",
                "valid_to_day_utc": "2026-05-17",
            },
            {
                "site_ref": "EA8",
                "pollutant_code": "pm10",
                "station_id": 1,
                "timeseries_id": 95,
                "valid_from_day_utc": "2026-05-18",
                "valid_to_day_utc": None,
            },
        ]
        first, first_status = MODULE._resolve_uk_air_flat_file_mapping_row(rows, "2026-05-17")
        second, second_status = MODULE._resolve_uk_air_flat_file_mapping_row(rows, "2026-05-18")
        none_row, none_status = MODULE._resolve_uk_air_flat_file_mapping_row([], "2026-05-17")
        many_row, many_status = MODULE._resolve_uk_air_flat_file_mapping_row(rows + rows, "2026-05-17")

        self.assertIsNone(first_status)
        self.assertEqual(int(first["timeseries_id"]), 66)
        self.assertIsNone(second_status)
        self.assertEqual(int(second["timeseries_id"]), 95)
        self.assertIsNone(none_row)
        self.assertEqual(none_status, "unmapped_source")
        self.assertIsNone(many_row)
        self.assertEqual(many_status, "ambiguous_mapping")

    def test_open_db_migrates_legacy_counts_table(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "legacy.sqlite"
            raw = sqlite3.connect(db_path)
            raw.execute(
                """
                CREATE TABLE source_file_timeseries_counts (
                  source_file_key TEXT NOT NULL,
                  timeseries_id INTEGER NOT NULL,
                  row_count INTEGER NOT NULL,
                  counted_at_utc TEXT NOT NULL,
                  PRIMARY KEY (source_file_key, timeseries_id)
                )
                """,
            )
            raw.execute(
                """
                CREATE TABLE source_file_state (
                  source_file_key TEXT PRIMARY KEY,
                  source_key TEXT,
                  day_utc TEXT
                )
                """,
            )
            raw.execute(
                "INSERT INTO source_file_state (source_file_key, day_utc) VALUES (?, ?)",
                ("sos:station_ref=station-1:day_utc=2026-05-17", "2026-05-17"),
            )
            raw.execute(
                "INSERT INTO source_file_timeseries_counts (source_file_key, timeseries_id, row_count, counted_at_utc) VALUES (?, ?, ?, ?)",
                ("sos:station_ref=station-1:day_utc=2026-05-17", 66, 3, "2026-05-18T00:00:00Z"),
            )
            raw.commit()
            raw.close()

            conn = MODULE.open_db(str(db_path))
            row = conn.execute(
                """
                SELECT source_file_key, day_utc, timeseries_id, row_count
                FROM source_file_timeseries_counts
                WHERE source_file_key = ?
                """,
                ("sos:station_ref=station-1:day_utc=2026-05-17",),
            ).fetchone()
            info = conn.execute(
                "PRAGMA table_info(source_file_timeseries_counts)",
            ).fetchall()
            conn.close()

        self.assertEqual(row, ("sos:station_ref=station-1:day_utc=2026-05-17", "2026-05-17", 66, 3))
        self.assertIn("day_utc", {str(col[1]) for col in info})

    def test_dry_run_plans_uk_air_csv_urls(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            env = {
                "UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR": str(root / "source-cache"),
            }
            conn = MODULE.open_db(str(root / "dry-run.sqlite"))
            mapping_rows = [
                {
                    "site_ref": "EA8",
                    "pollutant_code": "pm10",
                    "station_id": 1,
                    "timeseries_id": 66,
                    "valid_from_day_utc": "2020-01-01",
                    "valid_to_day_utc": None,
                }
            ]
            with mock.patch.object(
                MODULE,
                "_fetch_uk_air_flat_file_mapping_rows",
                return_value=mapping_rows,
            ):
                result = MODULE.check_sos_flat_files(
                    conn=conn,
                    env_name="CIC-Test",
                    env=env,
                    from_day="2026-05-17",
                    to_day="2026-05-17",
                    dry_run=True,
                    run_backfill=False,
                    limits=MODULE.LimitTracker(
                        max_download_mb=None,
                        max_runtime_minutes=None,
                        started_mono=0.0,
                    ),
                    log=logging.getLogger("test-sos-flat-file-dry-run"),
                )
            conn.close()

        self.assertEqual(result["source_mode"], "uk_air_flat_files")
        self.assertEqual(result["site_years"], 1)
        self.assertEqual(result["sample_urls"], [
            "https://uk-air.defra.gov.uk/datastore/data_files/site_data/EA8_2026.csv?v=1",
        ])

    def test_mapping_fetch_uses_public_rpc_window_payload(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            backfill_env = root / "backfill.env"
            backfill_env.write_text(
                "\n".join(
                    [
                        "OBS_AQIDB_SUPABASE_URL=https://example.supabase.co",
                        "OBS_AQIDB_SECRET_KEY=example-service-role-key",
                        "",
                    ]
                ),
                encoding="utf-8",
            )
            env = {
                "UK_AQ_BACKFILL_ENV_FILE": str(backfill_env),
            }
            rpc_rows = [
                {
                    "site_ref": "EA8",
                    "uk_air_ref": "UKA001",
                    "pollutant_code": "pm10",
                    "station_id": 1,
                    "timeseries_id": 66,
                    "station_ref": "EA8",
                    "timeseries_ref": "pm10_old",
                    "valid_from_day_utc": "2020-01-01",
                    "valid_to_day_utc": "2026-05-17",
                },
                {
                    "site_ref": "EA8",
                    "uk_air_ref": "UKA001",
                    "pollutant_code": "pm10",
                    "station_id": 1,
                    "timeseries_id": 95,
                    "station_ref": "EA8",
                    "timeseries_ref": "pm10_new",
                    "valid_from_day_utc": "2026-05-18",
                    "valid_to_day_utc": None,
                },
            ]
            with mock.patch.object(MODULE, "_http_post_json", return_value=rpc_rows) as post_json:
                rows = MODULE._fetch_uk_air_flat_file_mapping_rows(
                    env=env,
                    from_day="2026-05-17",
                    to_day="2026-05-19",
                    target_pollutants=("pm10", "no2"),
                )

            self.assertEqual([int(row["timeseries_id"]) for row in rows], [66, 95])
            self.assertEqual(len(rows), 2)
            self.assertEqual(post_json.call_count, 1)
            call = post_json.call_args
            self.assertIsNotNone(call)
            kwargs = call.kwargs
            self.assertEqual(
                kwargs["url"],
                "https://example.supabase.co/rest/v1/rpc/uk_aq_rpc_sos_uk_air_flat_file_mappings",
            )
            self.assertEqual(kwargs["headers"]["Accept-Profile"], "uk_aq_public")
            self.assertEqual(kwargs["headers"]["Content-Profile"], "uk_aq_public")
            self.assertEqual(kwargs["body"]["p_from_day"], "2026-05-17")
            self.assertEqual(kwargs["body"]["p_to_day"], "2026-05-19")
            self.assertEqual(kwargs["body"]["p_pollutant_codes"], ["pm10", "no2"])

    def test_flat_file_worker_records_day_granular_counts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            db_path = root / "worker.sqlite"
            conn = MODULE.open_db(str(db_path))
            cache_root = root / "source-cache" / "sos"
            csv_source = root / "EA8_2026.csv"
            csv_source.write_text(
                "\n".join(
                    [
                        "preamble",
                        'Date,time,"PM<sub>10</sub> particulate matter (Hourly measured)",status,unit',
                        "17-05-2026,01:00,10,R,ugm-3",
                        "18-05-2026,01:00,11,R,ugm-3",
                        "",
                    ]
                ),
                encoding="utf-8",
            )
            grouped_mappings = {
                "EA8": {
                    "pm10": [
                        {
                            "site_ref": "EA8",
                            "pollutant_code": "pm10",
                            "station_id": 1,
                            "timeseries_id": 66,
                            "valid_from_day_utc": "2020-01-01",
                            "valid_to_day_utc": "2026-05-17",
                        },
                        {
                            "site_ref": "EA8",
                            "pollutant_code": "pm10",
                            "station_id": 1,
                            "timeseries_id": 95,
                            "valid_from_day_utc": "2026-05-18",
                            "valid_to_day_utc": None,
                        },
                    ],
                },
            }

            def fake_head(url: str) -> dict[str, object]:
                return {
                    "status": 200,
                    "etag": '"flat-file-test"',
                    "content_length": csv_source.stat().st_size,
                    "last_modified": "Mon, 01 Jan 2024 00:00:00 GMT",
                }

            def fake_get(url: str, dest_path: Path, timeout: int = 120, chunk_size: int = 65536) -> int:
                dest_path.parent.mkdir(parents=True, exist_ok=True)
                dest_path.write_bytes(csv_source.read_bytes())
                return dest_path.stat().st_size

            with mock.patch.object(MODULE, "_http_head", side_effect=fake_head), mock.patch.object(
                MODULE,
                "_http_get_to_file",
                side_effect=fake_get,
            ):
                result = MODULE._check_one_sos_uk_air_flat_file(
                    conn=conn,
                    env_name="CIC-Test",
                    base_url="https://uk-air.defra.gov.uk/datastore/data_files/site_data",
                    site_ref="EA8",
                    year=2026,
                    grouped_mappings=grouped_mappings,
                    target_pollutants=("pm10",),
                    cache_root=cache_root,
                    keep_policy="none",
                    log=logging.getLogger("test-sos-flat-file-worker"),
                )

            counts = conn.execute(
                """
                SELECT day_utc, timeseries_id, row_count
                FROM source_file_timeseries_counts
                WHERE source_file_key = ?
                ORDER BY day_utc, timeseries_id
                """,
                ("sos:site_ref=EA8:year=2026",),
            ).fetchall()
            state = conn.execute(
                """
                SELECT exists_remote, last_status, source_location_id
                FROM source_file_state
                WHERE source_file_key = ?
                """,
                ("sos:site_ref=EA8:year=2026",),
            ).fetchone()
            conn.close()

        self.assertEqual(result["mapping_status"], "ok")
        self.assertEqual(result["source_rows"], 2)
        self.assertEqual(result["mapped_rows"], 2)
        self.assertEqual(result["timeseries_ids"], [66, 95])
        self.assertEqual(counts, [("2026-05-17", 66, 1), ("2026-05-18", 95, 1)])
        self.assertEqual(state, (1, "first_seen", "EA8"))


if __name__ == "__main__":
    unittest.main()
