from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "cloudflare/scheduler/scripts/sync_jobs.py"
SPEC = importlib.util.spec_from_file_location("cloudflare_scheduler_ops_sync_jobs", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
sync_jobs = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = sync_jobs
SPEC.loader.exec_module(sync_jobs)


class CloudflareSchedulerOpsJobsSyncTests(unittest.TestCase):
    def setUp(self) -> None:
        self.jobs_file = ROOT / "cloudflare/scheduler/jobs.toml"

    def test_jobs_toml_generates_expected_rows(self) -> None:
        manifest = sync_jobs.validate_jobs_config(sync_jobs.load_jobs_config(self.jobs_file))

        self.assertEqual(manifest["config_version"], 1)
        self.assertEqual(manifest["scheduler_name"], "uk-aq-cron-scheduler-ops")
        self.assertEqual(manifest["job_count"], 4)
        self.assertEqual(
            [job["job_key"] for job in manifest["jobs"]],
            [
                "uk_aq_dropbox_prune_raw",
                "uk_aq_r2_core_snapshot",
                "uk_aq_r2_history_dropbox_backup",
                "uk_aq_r2_history_dropbox_backup_force_prune_recheck",
            ],
        )

        force_prune = next(
            job for job in manifest["jobs"] if job["job_key"] == "uk_aq_r2_history_dropbox_backup_force_prune_recheck"
        )
        self.assertEqual(force_prune["github_inputs_json"], '{"force_prune_recheck":"true"}')
        self.assertTrue(all(job["dry_run"] == 1 for job in manifest["jobs"]))
        self.assertTrue(all(job["enabled"] == 1 for job in manifest["jobs"]))

    def test_rendered_sql_uses_upserts_and_current_timestamp(self) -> None:
        manifest = sync_jobs.validate_jobs_config(sync_jobs.load_jobs_config(self.jobs_file))
        sql = sync_jobs.render_sync_sql(manifest)

        self.assertIn("insert into scheduler_jobs", sql)
        self.assertIn("on conflict(job_key) do update set", sql)
        self.assertIn("updated_at = current_timestamp", sql)
        self.assertIn("github_inputs_json = excluded.github_inputs_json", sql)
        self.assertIn("uk_aq_r2_history_dropbox_backup_force_prune_recheck", sql)

    def test_main_writes_sql_and_manifest_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir_path = Path(tmpdir)
            sql_path = tmpdir_path / "scheduler_jobs_sync.sql"
            json_path = tmpdir_path / "scheduler_jobs_expected.json"

            exit_code = sync_jobs.main(
                [
                    "--jobs-file",
                    str(self.jobs_file),
                    "--sql-file",
                    str(sql_path),
                    "--json-file",
                    str(json_path),
                ]
            )

            self.assertEqual(exit_code, 0)
            self.assertTrue(sql_path.exists())
            self.assertTrue(json_path.exists())

            manifest = json.loads(json_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["job_count"], 4)
            self.assertEqual(len(manifest["jobs"]), 4)

    def test_invalid_cron_expression_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir_path = Path(tmpdir)
            bad_jobs = tmpdir_path / "jobs.toml"
            bad_jobs.write_text(
                self.jobs_file.read_text(encoding="utf-8").replace("15 4 * * *", "61 4 * * *", 1),
                encoding="utf-8",
            )

            with self.assertRaises(sync_jobs.JobsConfigError):
                sync_jobs.validate_jobs_config(sync_jobs.load_jobs_config(bad_jobs))


if __name__ == "__main__":
    unittest.main()
