#!/usr/bin/env python3
"""Tests for the UK-AIR SOS flat-file CSV integrity adapter."""

from __future__ import annotations

import importlib.util
import io
import json
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

    def _flat_file_grouped_mappings(self) -> dict:
        return {
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

    def _run_flat_file_worker_case(
        self,
        root: Path,
        *,
        csv_text: str,
        keep_policy: str,
    ) -> tuple[dict, Path, tuple, list[tuple]]:
        db_path = root / "worker.sqlite"
        conn = MODULE.open_db(str(db_path))
        cache_root = root / "source-cache" / "sos"
        cache_path = MODULE._uk_air_flat_file_cache_path(cache_root, "EA8", 2026)
        csv_source = root / "EA8_2026.csv"
        csv_source.write_text(csv_text, encoding="utf-8")
        grouped_mappings = self._flat_file_grouped_mappings()

        def fake_head(url: str) -> dict[str, object]:
            return {
                "status": 200,
                "etag": '"flat-file-test"',
                "content_length": csv_source.stat().st_size,
                "last_modified": "Mon, 01 Jan 2024 00:00:00 GMT",
            }

        def fake_get(
            url: str,
            dest_path: Path,
            timeout: int = 120,
            chunk_size: int = 65536,
        ) -> int:
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
                keep_policy=keep_policy,
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
            SELECT exists_remote, last_status, source_location_id,
                   local_cached_path, notes
            FROM source_file_state
            WHERE source_file_key = ?
            """,
            ("sos:site_ref=EA8:year=2026",),
        ).fetchone()
        conn.commit()
        conn.close()
        if state is None:
            raise AssertionError("flat-file worker did not record source state")
        return result, cache_path, state, counts

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

    def test_flat_file_remote_metadata_match_requires_reliable_signal(self) -> None:
        prior = {
            "etag": 'W/"same"',
            "last_modified_utc": "Mon, 01 Jan 2024 00:00:00 GMT",
            "content_length": 123,
        }
        self.assertTrue(
            MODULE._uk_air_flat_file_remote_metadata_matches(
                prior,
                {
                    "etag": 'W/"same"',
                    "last_modified": "Tue, 02 Jan 2024 00:00:00 GMT",
                    "content_length": 999,
                },
            )
        )
        self.assertFalse(
            MODULE._uk_air_flat_file_remote_metadata_matches(
                prior,
                {
                    "etag": 'W/"changed"',
                    "last_modified": prior["last_modified_utc"],
                    "content_length": prior["content_length"],
                },
            )
        )
        self.assertTrue(
            MODULE._uk_air_flat_file_remote_metadata_matches(
                prior,
                {
                    "etag": None,
                    "last_modified": prior["last_modified_utc"],
                    "content_length": prior["content_length"],
                },
            )
        )
        self.assertFalse(
            MODULE._uk_air_flat_file_remote_metadata_matches(
                prior,
                {"etag": None, "last_modified": None, "content_length": 123},
            )
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

    def test_mapping_fetch_uses_ingestdb_env_and_public_rpc_window_payload(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            backfill_env = root / "backfill.env"
            backfill_env.write_text(
                "\n".join(
                    [
                        "SUPABASE_URL=https://example-ingest.supabase.co",
                        "SB_SECRET_KEY=example-ingest-service-role-key",
                        "OBS_AQIDB_SUPABASE_URL=https://example-obs.supabase.co",
                        "OBS_AQIDB_SECRET_KEY=example-obs-service-role-key",
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
                    "timeseries_id": 95,
                    "station_ref": "EA8",
                    "timeseries_ref": "pm10_new",
                    "valid_from_day_utc": "2026-05-18",
                    "valid_to_day_utc": None,
                },
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
                "https://example-ingest.supabase.co/rest/v1/rpc/uk_aq_rpc_sos_uk_air_flat_file_mappings",
            )
            self.assertEqual(kwargs["headers"]["apikey"], "example-ingest-service-role-key")
            self.assertEqual(
                kwargs["headers"]["Authorization"],
                "Bearer example-ingest-service-role-key",
            )
            self.assertEqual(kwargs["headers"]["Accept-Profile"], "uk_aq_public")
            self.assertEqual(kwargs["headers"]["Content-Profile"], "uk_aq_public")
            self.assertEqual(kwargs["headers"]["Content-Type"], "application/json")
            self.assertEqual(
                list(kwargs["body"].keys()),
                ["p_from_day", "p_to_day", "p_pollutant_codes"],
            )
            self.assertEqual(kwargs["body"]["p_from_day"], "2026-05-17")
            self.assertEqual(kwargs["body"]["p_to_day"], "2026-05-19")
            self.assertEqual(kwargs["body"]["p_pollutant_codes"], ["pm10", "no2"])

    def test_http_post_json_sends_json_content_type(self) -> None:
        class FakeResponse:
            def __enter__(self) -> "FakeResponse":
                return self

            def __exit__(self, *args: object) -> None:
                return None

            def read(self) -> bytes:
                return b"[]"

        body = {
            "p_from_day": "2026-05-17",
            "p_to_day": "2026-05-19",
            "p_pollutant_codes": ["pm10"],
        }
        with mock.patch.object(
            MODULE.urllib.request,
            "urlopen",
            return_value=FakeResponse(),
        ) as urlopen:
            result = MODULE._http_post_json(
                url="https://example-ingest.supabase.co/rest/v1/rpc/example",
                headers={"Accept-Profile": "uk_aq_public"},
                body=body,
            )

        request = urlopen.call_args.args[0]
        self.assertEqual(request.get_header("Content-type"), "application/json")
        self.assertEqual(json.loads(request.data.decode("utf-8")), body)
        self.assertEqual(result, [])

    def test_mapping_fetch_formats_pgrst202_without_exposing_secret(self) -> None:
        response = {
            "code": "PGRST202",
            "message": "Could not find the function in the schema cache",
        }
        error = MODULE.urllib.error.HTTPError(
            "https://example-ingest.supabase.co/rest/v1/rpc/uk_aq_rpc_sos_uk_air_flat_file_mappings",
            404,
            "Not Found",
            None,
            io.BytesIO(json.dumps(response).encode("utf-8")),
        )
        secret = "must-not-appear-in-error"
        with mock.patch.object(MODULE, "_http_post_json", side_effect=error):
            with self.assertRaises(RuntimeError) as raised:
                MODULE._fetch_uk_air_flat_file_mapping_rows(
                    env={
                        "SUPABASE_URL": "https://example-ingest.supabase.co",
                        "SB_SECRET_KEY": secret,
                    },
                    from_day="2026-05-17",
                    to_day="2026-05-19",
                    target_pollutants=("pm10",),
                )

        message = str(raised.exception)
        self.assertIn("database target=ingestdb", message)
        self.assertIn("rpc=uk_aq_rpc_sos_uk_air_flat_file_mappings", message)
        self.assertIn("schema/profile=uk_aq_public", message)
        self.assertIn("http_status=404", message)
        self.assertIn("PGRST202", message)
        self.assertNotIn(secret, message)

    def test_flat_file_keep_all_preserves_csv_with_target_rows(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result, cache_path, state, _ = self._run_flat_file_worker_case(
                root,
                csv_text="\n".join(
                    [
                        "preamble",
                        'Date,time,"PM<sub>10</sub> particulate matter (Hourly measured)",status,unit',
                        "17-05-2026,01:00,10,R,ugm-3",
                        "18-05-2026,01:00,11,R,ugm-3",
                        "",
                    ]
                ),
                keep_policy="all",
            )
            cache_was_file = cache_path.is_file()

        self.assertEqual(result["mapping_status"], "ok")
        self.assertEqual(result["source_rows"], 2)
        self.assertEqual(result["mapped_rows"], 2)
        self.assertEqual(result["timeseries_ids"], [66, 95])
        self.assertTrue(result["downloaded"])
        self.assertFalse(result["cache_reused"])
        self.assertTrue(cache_was_file)
        self.assertEqual(state[3], str(cache_path))
        self.assertIn("local_cache=kept", state[4])

    def test_flat_file_keep_all_preserves_no_data_csv(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result, cache_path, state, counts = self._run_flat_file_worker_case(
                root,
                csv_text="Station metadata only\n",
                keep_policy="all",
            )

            self.assertEqual(result["source_rows"], 0)
            self.assertEqual(result["snapshot_status"], MODULE.SOS_STATUS_NO_DATA)
            self.assertEqual(counts, [])
            self.assertTrue(cache_path.is_file())
            self.assertEqual(state[3], str(cache_path))
            self.assertIn("snapshot_status=no_data", state[4])
            self.assertIn("local_cache=kept", state[4])

    def test_flat_file_keep_none_deletes_csv_after_counting(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result, cache_path, state, counts = self._run_flat_file_worker_case(
                root,
                csv_text="\n".join(
                    [
                        "preamble",
                        'Date,time,"PM<sub>10</sub> particulate matter (Hourly measured)",status,unit',
                        "17-05-2026,01:00,10,R,ugm-3",
                        "18-05-2026,01:00,11,R,ugm-3",
                        "",
                    ]
                ),
                keep_policy="none",
            )

            self.assertEqual(result["mapped_rows"], 2)
            self.assertEqual(counts, [("2026-05-17", 66, 1), ("2026-05-18", 95, 1)])
            self.assertFalse(cache_path.exists())
            self.assertIsNone(state[3])
            self.assertIn("local_cache=deleted", state[4])

    def test_flat_file_keep_changed_preserves_first_seen_no_data_csv(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result, cache_path, state, _ = self._run_flat_file_worker_case(
                root,
                csv_text="Station metadata only\n",
                keep_policy="changed",
            )

            self.assertEqual(result["outcome"], "first_seen")
            self.assertEqual(result["snapshot_status"], MODULE.SOS_STATUS_NO_DATA)
            self.assertTrue(cache_path.is_file())
            self.assertEqual(state[3], str(cache_path))
            self.assertIn("keep_policy=changed", state[4])
            self.assertIn("local_cache=kept", state[4])

    def test_flat_file_second_run_reuses_unchanged_cached_csv(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _, cache_path, _, expected_counts = self._run_flat_file_worker_case(
                root,
                csv_text="\n".join(
                    [
                        "preamble",
                        'Date,time,"PM<sub>10</sub> particulate matter (Hourly measured)",status,unit',
                        "17-05-2026,01:00,10,R,ugm-3",
                        "18-05-2026,01:00,11,R,ugm-3",
                        "",
                    ]
                ),
                keep_policy="all",
            )
            conn = MODULE.open_db(str(root / "worker.sqlite"))
            head = {
                "status": 200,
                "etag": '"flat-file-test"',
                "content_length": cache_path.stat().st_size,
                "last_modified": "Mon, 01 Jan 2024 00:00:00 GMT",
            }
            with mock.patch.object(MODULE, "_http_head", return_value=head), mock.patch.object(
                MODULE,
                "_http_get_to_file",
            ) as http_get:
                result = MODULE._check_one_sos_uk_air_flat_file(
                    conn=conn,
                    env_name="CIC-Test",
                    base_url="https://uk-air.defra.gov.uk/datastore/data_files/site_data",
                    site_ref="EA8",
                    year=2026,
                    grouped_mappings=self._flat_file_grouped_mappings(),
                    target_pollutants=("pm10",),
                    cache_root=root / "source-cache" / "sos",
                    keep_policy="all",
                    log=logging.getLogger("test-sos-flat-file-cache-reuse"),
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
                SELECT local_cached_path, last_status, content_length, notes
                FROM source_file_state
                WHERE source_file_key = ?
                """,
                ("sos:site_ref=EA8:year=2026",),
            ).fetchone()
            conn.close()

            http_get.assert_not_called()
            self.assertEqual(result["outcome"], "unchanged")
            self.assertTrue(result["cache_reused"])
            self.assertFalse(result["downloaded"])
            self.assertEqual(result["downloaded_bytes"], 0)
            self.assertEqual(counts, expected_counts)
            self.assertTrue(cache_path.is_file())
            self.assertEqual(state[0], str(cache_path))
            self.assertEqual(state[1], "unchanged")
            self.assertEqual(state[2], cache_path.stat().st_size)
            self.assertIn("source_acquisition=cache_reused", state[3])

    def test_flat_file_missing_cache_is_redownloaded(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _, cache_path, _, _ = self._run_flat_file_worker_case(
                root,
                csv_text="Station metadata only\n",
                keep_policy="all",
            )
            csv_source = root / "EA8_2026.csv"
            cache_path.unlink()
            conn = MODULE.open_db(str(root / "worker.sqlite"))
            head = {
                "status": 200,
                "etag": '"flat-file-test"',
                "content_length": csv_source.stat().st_size,
                "last_modified": "Mon, 01 Jan 2024 00:00:00 GMT",
            }

            def fake_get(url: str, dest_path: Path, **kwargs: object) -> int:
                dest_path.parent.mkdir(parents=True, exist_ok=True)
                dest_path.write_bytes(csv_source.read_bytes())
                return dest_path.stat().st_size

            with mock.patch.object(MODULE, "_http_head", return_value=head), mock.patch.object(
                MODULE,
                "_http_get_to_file",
                side_effect=fake_get,
            ) as http_get:
                result = MODULE._check_one_sos_uk_air_flat_file(
                    conn=conn,
                    env_name="CIC-Test",
                    base_url="https://uk-air.defra.gov.uk/datastore/data_files/site_data",
                    site_ref="EA8",
                    year=2026,
                    grouped_mappings=self._flat_file_grouped_mappings(),
                    target_pollutants=("pm10",),
                    cache_root=root / "source-cache" / "sos",
                    keep_policy="all",
                    log=logging.getLogger("test-sos-flat-file-cache-missing"),
                )
            state = conn.execute(
                "SELECT local_cached_path, notes FROM source_file_state WHERE source_file_key = ?",
                ("sos:site_ref=EA8:year=2026",),
            ).fetchone()
            conn.close()

            http_get.assert_called_once()
            self.assertTrue(result["downloaded"])
            self.assertFalse(result["cache_reused"])
            self.assertTrue(result["cache_missing_redownloaded"])
            self.assertGreater(result["downloaded_bytes"], 0)
            self.assertTrue(cache_path.is_file())
            self.assertEqual(state[0], str(cache_path))
            self.assertIn("cache_missing_redownloaded=true", state[1])

    def test_flat_file_changed_etag_downloads_and_updates_counts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _, cache_path, _, _ = self._run_flat_file_worker_case(
                root,
                csv_text="\n".join(
                    [
                        "preamble",
                        'Date,time,"PM<sub>10</sub> particulate matter (Hourly measured)",status,unit',
                        "17-05-2026,01:00,10,R,ugm-3",
                        "",
                    ]
                ),
                keep_policy="all",
            )
            changed_csv = root / "EA8_changed_2026.csv"
            changed_csv.write_text(
                "\n".join(
                    [
                        "preamble",
                        'Date,time,"PM<sub>10</sub> particulate matter (Hourly measured)",status,unit',
                        "17-05-2026,01:00,10,R,ugm-3",
                        "17-05-2026,02:00,11,R,ugm-3",
                        "",
                    ]
                ),
                encoding="utf-8",
            )
            conn = MODULE.open_db(str(root / "worker.sqlite"))
            head = {
                "status": 200,
                "etag": '"flat-file-changed"',
                "content_length": changed_csv.stat().st_size,
                "last_modified": "Tue, 02 Jan 2024 00:00:00 GMT",
            }

            def fake_get(url: str, dest_path: Path, **kwargs: object) -> int:
                dest_path.write_bytes(changed_csv.read_bytes())
                return dest_path.stat().st_size

            with mock.patch.object(MODULE, "_http_head", return_value=head), mock.patch.object(
                MODULE,
                "_http_get_to_file",
                side_effect=fake_get,
            ) as http_get:
                result = MODULE._check_one_sos_uk_air_flat_file(
                    conn=conn,
                    env_name="CIC-Test",
                    base_url="https://uk-air.defra.gov.uk/datastore/data_files/site_data",
                    site_ref="EA8",
                    year=2026,
                    grouped_mappings=self._flat_file_grouped_mappings(),
                    target_pollutants=("pm10",),
                    cache_root=root / "source-cache" / "sos",
                    keep_policy="all",
                    log=logging.getLogger("test-sos-flat-file-etag-changed"),
                )
            counts = conn.execute(
                """
                SELECT day_utc, timeseries_id, row_count
                FROM source_file_timeseries_counts
                WHERE source_file_key = ?
                """,
                ("sos:site_ref=EA8:year=2026",),
            ).fetchall()
            state = conn.execute(
                """
                SELECT etag, content_length, sha256_uncompressed
                FROM source_file_state
                WHERE source_file_key = ?
                """,
                ("sos:site_ref=EA8:year=2026",),
            ).fetchone()
            conn.close()

            http_get.assert_called_once()
            self.assertEqual(result["outcome"], "changed")
            self.assertTrue(result["downloaded"])
            self.assertFalse(result["cache_reused"])
            self.assertEqual(result["download_reason"], "remote_metadata_changed_or_unreliable")
            self.assertEqual(counts, [("2026-05-17", 66, 2)])
            self.assertEqual(cache_path.read_bytes(), changed_csv.read_bytes())
            self.assertEqual(state[0], '"flat-file-changed"')
            self.assertEqual(state[1], changed_csv.stat().st_size)
            self.assertEqual(
                state[2],
                MODULE.hashlib.sha256(changed_csv.read_bytes()).hexdigest(),
            )

    def test_flat_file_fetch_error_preserves_prior_good_cache(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _, cache_path, initial_state, _ = self._run_flat_file_worker_case(
                root,
                csv_text="Station metadata only\n",
                keep_policy="all",
            )
            conn = MODULE.open_db(str(root / "worker.sqlite"))
            with mock.patch.object(
                MODULE,
                "_http_head",
                return_value={"status": 500},
            ):
                result = MODULE._check_one_sos_uk_air_flat_file(
                    conn=conn,
                    env_name="CIC-Test",
                    base_url="https://uk-air.defra.gov.uk/datastore/data_files/site_data",
                    site_ref="EA8",
                    year=2026,
                    grouped_mappings={},
                    target_pollutants=("pm10",),
                    cache_root=root / "source-cache" / "sos",
                    keep_policy="all",
                    log=logging.getLogger("test-sos-flat-file-fetch-error"),
                )
            error_state = conn.execute(
                """
                SELECT local_cached_path, last_status
                FROM source_file_state
                WHERE source_file_key = ?
                """,
                ("sos:site_ref=EA8:year=2026",),
            ).fetchone()
            conn.close()

            self.assertEqual(result["outcome"], "temporary_error")
            self.assertTrue(cache_path.is_file())
            self.assertEqual(initial_state[3], str(cache_path))
            self.assertEqual(error_state, (str(cache_path), MODULE.SOS_STATUS_TEMP_ERROR))


if __name__ == "__main__":
    unittest.main()
