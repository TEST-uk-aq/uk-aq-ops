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
        self.assertEqual(manifest["job_count"], 5)
        self.assertEqual(
            [job["job_key"] for job in manifest["jobs"]],
            [
                "uk_aq_dropbox_prune_raw",
                "uk_aq_observs_partition_maintenance",
                "uk_aq_r2_core_snapshot",
                "uk_aq_r2_history_dropbox_backup",
                "uk_aq_r2_history_dropbox_backup_force_prune_recheck",
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
        partition_maintenance = next(
            job for job in manifest["jobs"] if job["job_key"] == "uk_aq_observs_partition_maintenance"
        )
        self.assertEqual(partition_maintenance["target_type"], "cloud_run")
        self.assertEqual(partition_maintenance["cloud_run_method"], "POST")
        self.assertEqual(partition_maintenance["cloud_run_url"], sync_jobs.DEPLOYMENT_PENDING_CLOUD_RUN_URL)
        self.assertTrue(partition_maintenance["cloud_run_url_managed_by_deploy"])
        self.assertEqual(partition_maintenance["cloud_run_body_json"], '{"source":"cloudflare_scheduler"}')
        self.assertIsNone(partition_maintenance["github_repo"])
        self.assertIsNone(partition_maintenance["github_workflow_file"])
        self.assertEqual(partition_maintenance["github_ref"], "main")
        self.assertIsNone(partition_maintenance["github_inputs_json"])
        self.assertNotIn("x-uk-aq-dispatch-secret", partition_maintenance["cloud_run_headers_json"] or "")
        self.assertTrue(all(job["enabled"] == 1 for job in manifest["jobs"]))

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

        sql = sync_jobs.render_upsert_statement(job)
        self.assertIn("NULL,\n  'POST',\n  NULL,\n  NULL,\n  1,\n  'test'", sql)

    def test_rendered_sql_uses_upserts_and_current_timestamp(self) -> None:
        manifest = sync_jobs.validate_jobs_config(sync_jobs.load_jobs_config(self.jobs_file))
        sql = sync_jobs.render_sync_sql(manifest)

        self.assertIn("insert into scheduler_jobs", sql)
        self.assertIn("on conflict(job_key) do update set", sql)
        self.assertIn("updated_at = current_timestamp", sql)
        self.assertIn("github_inputs_json = excluded.github_inputs_json", sql)
        self.assertIn("uk_aq_r2_history_dropbox_backup_force_prune_recheck", sql)
        self.assertIn("cloud_run_url = scheduler_jobs.cloud_run_url", sql)
        self.assertIn("'https://deployment-pending.invalid/run'", sql)

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
            self.assertEqual(manifest["job_count"], 5)
            self.assertEqual(len(manifest["jobs"]), 5)
            self.assertEqual(
                manifest["deployment_managed_cloud_run_url_job_keys"],
                ["uk_aq_observs_partition_maintenance"],
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

    def test_cloud_run_deploy_reconciles_service_url_and_shared_edge_secret(self) -> None:
        workflow = (
            ROOT / ".github/workflows/uk_aq_observs_partition_maintenance_cloud_run_deploy.yml"
        ).read_text(encoding="utf-8")

        self.assertIn("--format='value(status.url)'", workflow)
        self.assertIn("printf 'run_url=%s/run", workflow)
        self.assertIn("scheduler_cloud_run_url.sql", workflow)
        self.assertIn("update scheduler_jobs", workflow)
        self.assertIn("Verify deployed Cloud Run URL in D1", workflow)
        self.assertIn(
            "UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX: ${{ vars.UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX || 'history/v2/observations' }}",
            workflow,
        )
        self.assertIn(
            'upsert_secret "UK_AQ_EDGE_UPSTREAM_SECRET" "${UK_AQ_EDGE_UPSTREAM_SECRET}" 1',
            workflow,
        )
        retired_secret_name = "UK_AQ_CLOUD_RUN_" + "DISPATCH_SECRET"
        self.assertNotIn(retired_secret_name, workflow)
        self.assertNotIn(
            "UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX: ${{ vars.UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX || 'history/v1/observations' }}",
            workflow,
        )
        self.assertIn("--allow-unauthenticated", workflow)

    def test_cloud_run_workflows_map_upstream_auth_only_as_secret(self) -> None:
        workflow_paths = [
            ROOT / ".github/workflows/uk_aq_observs_partition_maintenance_cloud_run_deploy.yml",
            ROOT / ".github/workflows/uk_aq_prune_daily_cloud_run_deploy.yml",
        ]

        for workflow_path in workflow_paths:
            with self.subTest(workflow=workflow_path.name):
                workflow = workflow_path.read_text(encoding="utf-8")
                self.assertNotIn(
                    'env_updates+=("UK_AQ_EDGE_UPSTREAM_SECRET=',
                    workflow,
                )
                self.assertIn(
                    'secret_updates+=("UK_AQ_EDGE_UPSTREAM_SECRET=UK_AQ_EDGE_UPSTREAM_SECRET:latest")',
                    workflow,
                )
                self.assertIn(
                    'upsert_secret "UK_AQ_EDGE_UPSTREAM_SECRET" "${UK_AQ_EDGE_UPSTREAM_SECRET}" 1',
                    workflow,
                )
                self.assertIn(
                    'gcloud secrets describe "UK_AQ_EDGE_UPSTREAM_SECRET"',
                    workflow,
                )
                self.assertIn("group: uk-aq-cloud-run-shared-secret-deploy", workflow)
                retired_secret_name = "UK_AQ_CLOUD_RUN_" + "DISPATCH_SECRET"
                self.assertNotIn(retired_secret_name, workflow)


if __name__ == "__main__":
    unittest.main()
