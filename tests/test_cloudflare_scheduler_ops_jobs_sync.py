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
        self.assertEqual(manifest["job_count"], 9)
        self.assertEqual(
            [job["job_key"] for job in manifest["jobs"]],
            [
                "uk_aq_chart_metrics",
                "uk_aq_dropbox_prune_raw",
                "uk_aq_observs_partition_maintenance",
                "uk_aq_prune_daily",
                "uk_aq_r2_core_snapshot",
                "uk_aq_r2_history_dropbox_backup",
                "uk_aq_r2_history_dropbox_backup_force_prune_recheck",
                "uk_aq_supabase_db_dump_backup",
                "uk_aq_who_2021_daily",
            ],
        )

        force_prune = next(
            job for job in manifest["jobs"] if job["job_key"] == "uk_aq_r2_history_dropbox_backup_force_prune_recheck"
        )
        self.assertEqual(force_prune["github_inputs_json"], '{"force_prune_recheck":"true"}')
        daily_backup = next(
            job for job in manifest["jobs"] if job["job_key"] == "uk_aq_r2_history_dropbox_backup"
        )
        self.assertEqual(daily_backup["github_inputs_json"], "{}")
        self.assertTrue(all(job["target_type"] == "github_workflow" for job in manifest["jobs"]))
        self.assertTrue(all(job["worker_http_url"] is None for job in manifest["jobs"]))
        self.assertTrue(all(job["worker_http_secret_binding"] is None for job in manifest["jobs"]))
        self.assertTrue(all(job["worker_http_body_json"] is None for job in manifest["jobs"]))

    def test_github_workflow_jobs_default_cloud_run_method_to_post(self) -> None:
        job = sync_jobs.validate_job(
            "uk_aq_r2_core_snapshot",
            {
                "enabled": True,
                "target_type": "github_workflow",
                "cron_expr": "15 4 * * *",
                "github_repo": "TEST-uk-aq/uk-aq-ops",
                "github_workflow_file": "uk_aq_r2_core_snapshot.yml",
                "dry_run": True,
                "notes": "test",
            },
        )

        self.assertEqual(job["cloud_run_method"], "POST")
        self.assertIsNone(job["worker_http_url"])
        self.assertIsNone(job["worker_http_secret_binding"])
        self.assertIsNone(job["worker_http_body_json"])

        sql = sync_jobs.render_upsert_statement(job)
        self.assertIn("NULL,\n  'POST',\n  NULL,\n  NULL,\n  NULL,\n  NULL,\n  NULL,\n  1,\n  'test'", sql)

    def test_rendered_sql_uses_upserts_and_current_timestamp(self) -> None:
        manifest = sync_jobs.validate_jobs_config(sync_jobs.load_jobs_config(self.jobs_file))
        sql = sync_jobs.render_sync_sql(manifest)

        self.assertIn("insert into scheduler_jobs", sql)
        self.assertIn("on conflict(job_key) do update set", sql)
        self.assertIn("updated_at = current_timestamp", sql)
        self.assertIn("github_inputs_json = excluded.github_inputs_json", sql)
        self.assertIn("uk_aq_r2_history_dropbox_backup_force_prune_recheck", sql)
        self.assertIn("worker_http_url = excluded.worker_http_url", sql)
        self.assertIn("worker_http_secret_binding = excluded.worker_http_secret_binding", sql)
        self.assertIn("worker_http_body_json = excluded.worker_http_body_json", sql)

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
            self.assertEqual(manifest["job_count"], 9)
            self.assertEqual(len(manifest["jobs"]), 9)
            self.assertEqual(
                manifest["deployment_managed_cloud_run_url_job_keys"],
                [],
            )
            core_snapshot = next(
                job for job in manifest["jobs"] if job["job_key"] == "uk_aq_r2_core_snapshot"
            )
            self.assertEqual(core_snapshot["cloud_run_method"], "POST")

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

    def test_cloud_run_deployment_managed_url_behavior_is_preserved(self) -> None:
        job = sync_jobs.validate_job(
            "managed_cloud_run",
            {
                "enabled": True,
                "target_type": "cloud_run",
                "cron_expr": "0 * * * *",
                "cloud_run_url_managed_by_deploy": True,
                "cloud_run_body": {"source": "scheduler"},
                "dry_run": False,
            },
        )

        self.assertEqual(job["cloud_run_url"], sync_jobs.DEPLOYMENT_PENDING_CLOUD_RUN_URL)
        self.assertTrue(job["cloud_run_url_managed_by_deploy"])
        self.assertEqual(job["cloud_run_method"], "POST")
        self.assertEqual(job["cloud_run_body_json"], '{"source":"scheduler"}')
        self.assertIsNone(job["worker_http_url"])
        sql = sync_jobs.render_upsert_statement(job)
        self.assertIn(
            "cloud_run_url = case when scheduler_jobs.target_type = 'cloud_run' "
            "then scheduler_jobs.cloud_run_url else excluded.cloud_run_url end",
            sql,
        )

    def test_worker_http_job_is_normalized_and_rendered_without_a_secret_value(self) -> None:
        job = sync_jobs.validate_job(
            "worker_target",
            {
                "enabled": True,
                "target_type": "worker_http",
                "cron_expr": "5 * * * *",
                "worker_http_url": "https://worker.example.test/run",
                "worker_http_secret_binding": "UK_AQ_EXAMPLE_WORKER_HTTP_SECRET",
                "worker_http_body": {"z": 2, "a": {"enabled": True}},
                "dry_run": False,
            },
        )

        self.assertEqual(job["worker_http_url"], "https://worker.example.test/run")
        self.assertEqual(job["worker_http_secret_binding"], "UK_AQ_EXAMPLE_WORKER_HTTP_SECRET")
        self.assertEqual(job["worker_http_body_json"], '{"a":{"enabled":true},"z":2}')
        self.assertIsNone(job["github_repo"])
        self.assertIsNone(job["cloud_run_url"])
        sql = sync_jobs.render_upsert_statement(job)
        self.assertIn("'UK_AQ_EXAMPLE_WORKER_HTTP_SECRET'", sql)
        self.assertNotIn("actual-secret-value", sql)
        self.assertIn("github_repo = excluded.github_repo", sql)
        self.assertIn("cloud_run_url = excluded.cloud_run_url", sql)
        self.assertIn("worker_http_url = excluded.worker_http_url", sql)

    def test_worker_http_defaults_body_to_an_empty_object(self) -> None:
        job = sync_jobs.validate_job(
            "worker_target",
            {
                "enabled": True,
                "target_type": "worker_http",
                "cron_expr": "5 * * * *",
                "worker_http_url": "https://worker.example.test/run",
                "worker_http_secret_binding": "UK_AQ_EXAMPLE_WORKER_HTTP_SECRET",
                "dry_run": True,
            },
        )
        self.assertEqual(job["worker_http_body_json"], "{}")

    def test_worker_http_rejects_non_https_or_non_absolute_urls(self) -> None:
        for invalid_url in ["http://worker.example.test/run", "/run", "worker.example.test/run", "https://"]:
            with self.subTest(url=invalid_url), self.assertRaises(sync_jobs.JobsConfigError):
                sync_jobs.validate_job(
                    "worker_target",
                    {
                        "enabled": True,
                        "target_type": "worker_http",
                        "cron_expr": "5 * * * *",
                        "worker_http_url": invalid_url,
                        "worker_http_secret_binding": "UK_AQ_EXAMPLE_WORKER_HTTP_SECRET",
                        "dry_run": True,
                    },
                )

    def test_worker_http_rejects_unrelated_secret_bindings(self) -> None:
        invalid_bindings = [
            "UK_AQ_GITHUB_WORKFLOW_DISPATCH_PAT",
            "UK_AQ_EDGE_UPSTREAM_SECRET",
            "UK_AQ_SCHEDULER_TRIGGER_SECRET",
            "uk_aq_example_worker_http_secret",
        ]
        for binding in invalid_bindings:
            with self.subTest(binding=binding), self.assertRaises(sync_jobs.JobsConfigError):
                sync_jobs.validate_job(
                    "worker_target",
                    {
                        "enabled": True,
                        "target_type": "worker_http",
                        "cron_expr": "5 * * * *",
                        "worker_http_url": "https://worker.example.test/run",
                        "worker_http_secret_binding": binding,
                        "dry_run": True,
                    },
                )

    def test_target_specific_fields_are_rejected_for_other_target_types(self) -> None:
        cases = [
            (
                "github_workflow",
                {
                    "github_repo": "TEST-uk-aq/uk-aq-ops",
                    "github_workflow_file": "workflow.yml",
                    "worker_http_url": "https://worker.example.test/run",
                },
            ),
            (
                "cloud_run",
                {
                    "cloud_run_url": "https://service.example.test/run",
                    "worker_http_secret_binding": "UK_AQ_EXAMPLE_WORKER_HTTP_SECRET",
                },
            ),
            (
                "worker_http",
                {
                    "worker_http_url": "https://worker.example.test/run",
                    "worker_http_secret_binding": "UK_AQ_EXAMPLE_WORKER_HTTP_SECRET",
                    "github_inputs": {"source": "scheduler"},
                },
            ),
            (
                "worker_http",
                {
                    "worker_http_url": "https://worker.example.test/run",
                    "worker_http_secret_binding": "UK_AQ_EXAMPLE_WORKER_HTTP_SECRET",
                    "cloud_run_method": "POST",
                },
            ),
        ]
        for target_type, target_fields in cases:
            with self.subTest(target_type=target_type, fields=target_fields), self.assertRaises(
                sync_jobs.JobsConfigError
            ):
                sync_jobs.validate_job(
                    "target_field_mismatch",
                    {
                        "enabled": True,
                        "target_type": target_type,
                        "cron_expr": "5 * * * *",
                        "dry_run": True,
                        **target_fields,
                    },
                )


if __name__ == "__main__":
    unittest.main()
