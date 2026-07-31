from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py"
SPEC = importlib.util.spec_from_file_location("uk_aq_history_integrity", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
integrity = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = integrity
SPEC.loader.exec_module(integrity)


class V2RepairPlanningTest(unittest.TestCase):
    def test_protected_connector_configuration_is_strict_and_deterministic(self):
        self.assertEqual(integrity.resolve_protected_connector_ids({}), [1])
        self.assertEqual(
            integrity.resolve_protected_connector_ids({
                integrity.PROTECTED_CONNECTOR_IDS_ENV: "3,1,2",
            }),
            [1, 2, 3],
        )
        for value in ("", "1,,2", "0", "one", "1,1"):
            with self.subTest(value=value):
                with self.assertRaises(RuntimeError):
                    integrity.resolve_protected_connector_ids({
                        integrity.PROTECTED_CONNECTOR_IDS_ENV: value,
                    })

        args = SimpleNamespace(
            source="sos",
            run_backfill=True,
            dry_run=False,
            history_version="v2",
            from_day="2026-06-17",
            to_day="2026-07-30",
            repair_pollutants=["pm25"],
        )
        with self.assertRaisesRegex(RuntimeError, r"exactly \[1\]"):
            integrity.select_sos_historical_replacement_route(
                args,
                mutation_connector_ids=[1],
                protected_connector_ids=[2],
            )
        with self.assertRaisesRegex(RuntimeError, r"exactly \[1\]"):
            integrity.select_sos_historical_replacement_route(
                args,
                mutation_connector_ids=[1],
                protected_connector_ids=[1, 2, 3],
            )

    def test_sos_light_materialises_source_plus_dropbox_complete_day(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dropbox = root / "dropbox"
            source = root / "source"
            day = "2026-07-12"
            day_prefix = f"history/v2/observations/day_utc={day}"
            dropbox_peer = dropbox / day_prefix / "connector_id=7/pollutant_code=humidity/part-00000.parquet"
            dropbox_peer.parent.mkdir(parents=True)
            dropbox_peer.write_bytes(b"dropbox-humidity")
            old_selected = dropbox / day_prefix / "connector_id=1/pollutant_code=pm25/part-00000.parquet"
            old_selected.parent.mkdir(parents=True)
            old_selected.write_bytes(b"old-dropbox-pm25")
            run_state = integrity.create_run_overlay(
                tmp_dir=root / "runs",
                run_id="sos-light-test",
                environment="CIC-Test",
                base_dropbox_root=dropbox,
            )

            def stage(key: str, body: bytes) -> None:
                path = source / key
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(body)
                integrity.stage_overlay_object(
                    run_state,
                    object_key=key,
                    source_path=path,
                    stage="observations_data",
                )
                integrity.mark_overlay_structurally_validated(run_state, key)

            selected_part = f"{day_prefix}/connector_id=1/pollutant_code=pm25/part-00000.parquet"
            selected_manifest = f"{day_prefix}/connector_id=1/pollutant_code=pm25/manifest.json"
            connector_1_parent = f"{day_prefix}/connector_id=1/manifest.json"
            connector_7_parent = f"{day_prefix}/connector_id=7/manifest.json"
            day_parent = f"{day_prefix}/manifest.json"
            dropbox_connector_7_parent = dropbox / connector_7_parent
            dropbox_connector_7_parent.parent.mkdir(parents=True, exist_ok=True)
            dropbox_connector_7_parent.write_text(
                json.dumps({"child_manifests": []}), encoding="utf-8"
            )
            stage(selected_part, b"fresh-sos-pm25")
            stage(selected_manifest, json.dumps({"manifest_key": selected_manifest, "manifest_hash": "a" * 64}).encode())
            stage(connector_1_parent, json.dumps({
                "pollutant_manifests": [{"manifest_key": selected_manifest}],
                "child_manifests": [],
            }).encode())
            stage(day_parent, json.dumps({
                "connector_manifests": [
                    {"manifest_key": connector_1_parent},
                    {"manifest_key": connector_7_parent},
                ],
                "child_manifests": [],
            }).encode())
            run_state["tombstone_prefixes"] = [{
                "prefix": f"{day_prefix}/connector_id=1/pollutant_code=pm25",
                "proposed": True,
            }]
            run_state["sos_light"] = {
                "mode": "sos-light",
                "validation_status": "validated_local_assembly",
                "old_live_r2_observation_bodies_used": False,
                "days": [{
                    "day_utc": day,
                    "final_connector_1_child_set": [selected_manifest],
                    "final_assembled_connector_ids": [1, 7],
                    "omitted_dropbox_connector_prefixes": [],
                }],
            }
            result = integrity.assemble_sos_light_complete_days(run_state)
            self.assertEqual(run_state["mode"], "sos-light")
            self.assertEqual(
                [entry["prefix"] for entry in run_state["tombstone_prefixes"]],
                [day_prefix],
            )
            self.assertEqual(
                Path(run_state["objects"][str(dropbox_peer.relative_to(dropbox))]["local_path"]).read_bytes(),
                b"dropbox-humidity",
            )
            self.assertEqual(
                run_state["objects"][connector_7_parent]["proposal_owner"],
                "dropbox_day_baseline",
            )
            self.assertEqual(
                Path(run_state["objects"][selected_part]["local_path"]).read_bytes(),
                b"fresh-sos-pm25",
            )
            self.assertTrue(result["no_old_live_r2_body_planning_or_preservation"])
            self.assertEqual(result["complete_day_deletion_count"], 1)

    def test_sos_light_absent_dropbox_day_uses_connector_1_only_without_live_r2(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dropbox = root / "dropbox"
            source = root / "source"
            dropbox.mkdir()
            day = "2026-07-30"
            day_prefix = f"history/v2/observations/day_utc={day}"
            run_state = integrity.create_run_overlay(
                tmp_dir=root / "runs",
                run_id="sos-light-absent-dropbox-day-test",
                environment="CIC-Test",
                base_dropbox_root=dropbox,
            )

            def stage(key: str, body: bytes) -> None:
                path = source / key
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(body)
                integrity.stage_overlay_object(
                    run_state,
                    object_key=key,
                    source_path=path,
                    stage="observations_data",
                )
                integrity.mark_overlay_structurally_validated(run_state, key)

            selected_part = (
                f"{day_prefix}/connector_id=1/pollutant_code=o3/part-00000.parquet"
            )
            selected_manifest = (
                f"{day_prefix}/connector_id=1/pollutant_code=o3/manifest.json"
            )
            connector_1_parent = f"{day_prefix}/connector_id=1/manifest.json"
            day_parent = f"{day_prefix}/manifest.json"
            stage(selected_part, b"fresh-sos-o3")
            stage(
                selected_manifest,
                json.dumps({
                    "manifest_key": selected_manifest,
                    "manifest_hash": "a" * 64,
                }).encode(),
            )
            stage(
                connector_1_parent,
                json.dumps({
                    "pollutant_manifests": [{"manifest_key": selected_manifest}],
                    "child_manifests": [],
                }).encode(),
            )
            stage(
                day_parent,
                json.dumps({
                    "connector_manifests": [{"manifest_key": connector_1_parent}],
                    "child_manifests": [],
                }).encode(),
            )
            run_state["tombstone_prefixes"] = [{
                "prefix": f"{day_prefix}/connector_id=1/pollutant_code=o3",
                "proposed": True,
            }]
            run_state["sos_light"] = {
                "mode": "sos-light",
                "validation_status": "validated_local_assembly",
                "old_live_r2_observation_bodies_used": False,
                "dropbox_warning_count": 0,
                "dropbox_warnings": [],
                "days": [{
                    "day_utc": day,
                    "final_connector_1_child_set": [selected_manifest],
                    "final_assembled_connector_ids": [1],
                    "omitted_dropbox_connector_prefixes": [],
                }],
            }

            with mock.patch.object(
                integrity,
                "run_r2_cross_checks",
                side_effect=AssertionError("live-R2 planning adapter must not run"),
            ) as live_r2_adapter:
                result = integrity.assemble_sos_light_complete_days(run_state)

            live_r2_adapter.assert_not_called()
            self.assertEqual(result["dropbox_day_absent_days"], [day])
            self.assertEqual(result["dropbox_day_absent_count"], 1)
            self.assertEqual(result["dropbox_day_warning_count"], 1)
            self.assertEqual(result["dropbox_warning_count"], 1)
            self.assertEqual(result["days"][0]["dropbox_day_present"], False)
            self.assertEqual(result["days"][0]["dropbox_day_absent"], True)
            self.assertEqual(
                result["days"][0]["final_assembled_connector_ids"], [1]
            )
            self.assertEqual(
                run_state["objects"][connector_1_parent]["dependencies"],
                [selected_manifest],
            )
            self.assertEqual(
                run_state["objects"][day_parent]["dependencies"],
                [connector_1_parent],
            )
            self.assertEqual(
                result["dropbox_warnings"][0]["classification"],
                "dropbox_selected_day_absent",
            )
            self.assertEqual(
                [entry["prefix"] for entry in run_state["tombstone_prefixes"]],
                [day_prefix],
            )

    def test_observation_index_gap_plans_index_only_without_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cfg = integrity.resolve_history_path_config("v2", {})
            part = root / "history/v2/observations/day_utc=2026-06-11/connector_id=6/pollutant_code=pm25"
            part.mkdir(parents=True)
            parquet = part / "part-00000.parquet"
            parquet.write_bytes(b"parquet")
            (part / "manifest.json").write_text(
                json.dumps(
                    {
                        "history_version": "v2",
                        "domain": "observations",
                        "day_utc": "2026-06-11",
                        "connector_id": "6",
                        "pollutant_code": "pm25",
                        "row_count": 1,
                        "files": [{"key": "history/v2/observations/day_utc=2026-06-11/connector_id=6/pollutant_code=pm25/part-00000.parquet"}],
                    }
                ),
                encoding="utf-8",
            )

            result = integrity.run_v2_observations_integrity_checks(
                r2_history_root=root,
                config=cfg,
                from_day="2026-06-11",
                to_day="2026-06-11",
            )

            index_gap = next(g for g in result["gaps"] if g["gap_type"] == "index_manifest_missing")
            self.assertEqual(index_gap["suggested_repair"]["kind"], "rebuild_v2_observations_index_only")
            self.assertEqual(index_gap["suggested_repair"]["commands"], [])
            self.assertIn("command contract remains unresolved", index_gap["suggested_repair"]["notes"])

    def test_missing_v2_observations_with_local_v1_plans_confirmed_builder_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cfg = integrity.resolve_history_path_config("v2", {})
            (root / "history/v1/observations/day_utc=2026-06-11/connector_id=6").mkdir(parents=True)
            (root / cfg.observations_latest_index_key).parent.mkdir(parents=True)
            (root / cfg.observations_latest_index_key).write_text("{}", encoding="utf-8")

            result = integrity.run_v2_observations_integrity_checks(
                r2_history_root=root,
                config=cfg,
                from_day="2026-06-11",
                to_day="2026-06-11",
            )

            gap = next(g for g in result["gaps"] if g["gap_type"] == "day_dir_missing")
            repair = gap["suggested_repair"]
            self.assertEqual(repair["kind"], "v1_dropbox_to_v2_observations_backfill_plan")
            self.assertEqual(repair["commands"][0][0:2], ["node", "scripts/backup_r2/uk_aq_build_v2_observations_from_dropbox_v1.mjs"])
            self.assertIn("--write-r2", repair["commands"][0])
            self.assertIn("_index_v2 rebuild command is not listed", repair["notes"])
            self.assertTrue(gap["source_evidence"]["v1_local_dropbox_present"])

    def test_missing_v2_aqi_with_v2_observations_present_plans_aqi_rebuild_without_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cfg = integrity.resolve_history_path_config("v2", {})
            (root / "history/v2/observations/day_utc=2026-06-11/connector_id=6/pollutant_code=pm25").mkdir(parents=True)
            (root / cfg.aqilevels_latest_index_key).parent.mkdir(parents=True)
            (root / cfg.aqilevels_latest_index_key).write_text("{}", encoding="utf-8")

            result = integrity.run_v2_aqilevels_integrity_checks(
                r2_history_root=root,
                config=cfg,
                from_day="2026-06-11",
                to_day="2026-06-11",
            )

            gap = next(g for g in result["gaps"] if g["gap_type"] == "day_dir_missing")
            repair = gap["suggested_repair"]
            self.assertEqual(repair["kind"], "v2_aqi_hourly_rebuild_from_v2_observations_plan")
            self.assertEqual(repair["commands"], [])
            self.assertTrue(gap["source_evidence"]["v2_observations_present"])
            self.assertIn("commands require confirmation", repair["notes"])


if __name__ == "__main__":
    unittest.main()
