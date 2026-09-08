from __future__ import annotations

import importlib.util
import json
import os
import subprocess
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

CONFIG_SYNC_WORKFLOW = ROOT / ".github/workflows/uk_aq_cloudflare_scheduler_ops_config_sync.yml"
DEPLOY_WORKFLOW = ROOT / ".github/workflows/uk_aq_cloudflare_scheduler_ops_deploy.yml"


def extract_workflow_run_step(workflow_text: str, step_name: str) -> str:
    lines = workflow_text.splitlines()
    step_marker = f"      - name: {step_name}"
    try:
        step_start = lines.index(step_marker)
    except ValueError as exc:
        raise AssertionError(f"Missing workflow step {step_name!r}") from exc

    run_start = next(
        index for index in range(step_start + 1, len(lines)) if lines[index] == "        run: |"
    )
    script_lines: list[str] = []
    for line in lines[run_start + 1 :]:
        if line.startswith("      - name: "):
            break
        script_lines.append(line[10:] if line.startswith("          ") else "")
    return "\n".join(script_lines) + "\n"


def commit_all(repo: Path, message: str) -> str:
    subprocess.run(["git", "add", "."], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(
        ["git", "commit", "-q", "-m", message],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    )
    return subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def run_sync_scope_step(
    script: str,
    repo: Path,
    *,
    event_name: str,
    before_sha: str,
    after_sha: str,
) -> dict[str, str]:
    output_path = repo / ".git/github-output.txt"
    output_path.write_text("", encoding="utf-8")
    env = {
        **os.environ,
        "EVENT_NAME": event_name,
        "BEFORE_SHA": before_sha,
        "AFTER_SHA": after_sha,
        "JOBS_FILE": "cloudflare/scheduler/jobs.toml",
        "GITHUB_OUTPUT": str(output_path),
    }
    subprocess.run(
        ["bash", "-c", script],
        cwd=repo,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    return dict(
        line.split("=", 1)
        for line in output_path.read_text(encoding="utf-8").splitlines()
        if "=" in line
    )


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
                set(manifest["scheduler_jobs_required_columns"]),
                set(sync_jobs.SQL_COLUMNS + ["updated_at"]),
            )
            self.assertEqual(
                manifest["deployment_managed_cloud_run_url_job_keys"],
                [],
            )
            core_snapshot = next(
                job for job in manifest["jobs"] if job["job_key"] == "uk_aq_r2_core_snapshot"
            )
            self.assertEqual(core_snapshot["cloud_run_method"], "POST")

    def test_schema_compatibility_uses_manifest_shape_and_detects_missing_columns(self) -> None:
        manifest = sync_jobs.validate_jobs_config(sync_jobs.load_jobs_config(self.jobs_file))
        expected = sync_jobs.build_expected_manifest(manifest)
        required_columns = sync_jobs.required_scheduler_jobs_columns(expected)
        compatible_schema = [{"results": [{"name": name} for name in sorted(required_columns)]}]

        self.assertEqual(sync_jobs.missing_scheduler_jobs_columns(expected, compatible_schema), [])

        missing_worker_columns = {
            "worker_http_url",
            "worker_http_secret_binding",
            "worker_http_body_json",
        }
        old_schema = [
            {
                "results": [
                    {"name": name}
                    for name in sorted(required_columns - missing_worker_columns)
                ]
            }
        ]
        self.assertEqual(
            sync_jobs.missing_scheduler_jobs_columns(expected, old_schema),
            sorted(missing_worker_columns),
        )

        expected["jobs"][0]["cloud_run_url"] = "https://runtime-owned.example.test/run"
        self.assertEqual(sync_jobs.missing_scheduler_jobs_columns(expected, compatible_schema), [])

    def test_push_scope_detects_script_only_and_multi_commit_jobs_changes(self) -> None:
        workflow_text = CONFIG_SYNC_WORKFLOW.read_text(encoding="utf-8")
        script = extract_workflow_run_step(
            workflow_text,
            "Determine whether remote job sync is required",
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            repo = Path(tmpdir)
            subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=repo, check=True)
            jobs_path = repo / "cloudflare/scheduler/jobs.toml"
            script_path = repo / "cloudflare/scheduler/scripts/sync_jobs.py"
            workflow_path = repo / ".github/workflows/config-sync.yml"
            jobs_path.parent.mkdir(parents=True)
            script_path.parent.mkdir(parents=True)
            workflow_path.parent.mkdir(parents=True)
            jobs_path.write_text("config_version = 1\n", encoding="utf-8")
            script_path.write_text("# initial\n", encoding="utf-8")
            workflow_path.write_text("# initial\n", encoding="utf-8")
            base_sha = commit_all(repo, "base")

            script_path.write_text("# implementation only\n", encoding="utf-8")
            script_only_sha = commit_all(repo, "script only")
            outputs = run_sync_scope_step(
                script,
                repo,
                event_name="push",
                before_sha=base_sha,
                after_sha=script_only_sha,
            )
            self.assertEqual(outputs["remote_sync"], "false")
            self.assertIn("jobs.toml did not change", outputs["reason"])

            jobs_path.write_text("config_version = 1\n# changed\n", encoding="utf-8")
            commit_all(repo, "jobs change")
            workflow_path.write_text("# later implementation commit\n", encoding="utf-8")
            multi_commit_after_sha = commit_all(repo, "later workflow change")
            outputs = run_sync_scope_step(
                script,
                repo,
                event_name="push",
                before_sha=script_only_sha,
                after_sha=multi_commit_after_sha,
            )
            self.assertEqual(outputs["remote_sync"], "true")
            self.assertIn("jobs.toml changed", outputs["reason"])

            outputs = run_sync_scope_step(
                script,
                repo,
                event_name="push",
                before_sha="0" * 40,
                after_sha=multi_commit_after_sha,
            )
            self.assertEqual(outputs["remote_sync"], "true")

            outputs = run_sync_scope_step(
                script,
                repo,
                event_name="workflow_dispatch",
                before_sha="",
                after_sha=multi_commit_after_sha,
            )
            self.assertEqual(outputs["remote_sync"], "true")
            self.assertEqual(outputs["reason"], "explicit workflow_dispatch")

    def test_workflow_remote_steps_are_gated_and_schema_guard_is_read_only(self) -> None:
        workflow = CONFIG_SYNC_WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("fetch-depth: 0", workflow)
        self.assertGreaterEqual(
            workflow.count("if: steps.sync-scope.outputs.remote_sync == 'true'"),
            4,
        )
        self.assertIn("No remote D1 mutation or verification is required.", workflow)
        self.assertIn('command "pragma table_info(scheduler_jobs)"', workflow)
        self.assertIn("max_attempts=8", workflow)
        self.assertIn("retry_seconds=10", workflow)
        self.assertIn("missing_scheduler_jobs_columns", workflow)
        self.assertIn("refusing to apply canonical jobs", workflow)
        self.assertNotIn("d1 migrations apply", workflow)

    def test_scheduler_workflows_pin_node24_actions_and_wrangler_v4_consistently(self) -> None:
        config_sync = CONFIG_SYNC_WORKFLOW.read_text(encoding="utf-8")
        deploy = DEPLOY_WORKFLOW.read_text(encoding="utf-8")
        checkout_sha = "3d3c42e5aac5ba805825da76410c181273ba90b1"
        setup_python_sha = "5fda3b95a4ea91299a34e894583c3862153e4b97"
        action_sha = "ebbaa1584979971c8614a24965b4405ff95890e0"
        retired_action_sha = "da0e0dfe58b7a431659754fdf3f186c529afbe65"

        for workflow in [config_sync, deploy]:
            self.assertEqual(workflow.count(f"actions/checkout@{checkout_sha}"), 1)
            self.assertNotIn("actions/checkout@v4", workflow)
            self.assertIn('WRANGLER_VERSION: "4.130.0"', workflow)
            self.assertNotIn("wrangler@4 ", workflow)

        self.assertEqual(config_sync.count(f"actions/setup-python@{setup_python_sha}"), 1)
        self.assertNotIn("actions/setup-python@v5", config_sync)
        self.assertNotIn("actions/setup-python@", deploy)
        self.assertIn("fetch-depth: 0", config_sync)
        self.assertIn('python-version: "3.12"', config_sync)
        self.assertEqual(
            config_sync.count('npx --yes "wrangler@${WRANGLER_VERSION}"'),
            3,
        )
        self.assertEqual(
            deploy.count('npx --yes "wrangler@${WRANGLER_VERSION}"'),
            2,
        )
        self.assertEqual(
            deploy.count(f"cloudflare/wrangler-action@{action_sha}"),
            2,
        )
        self.assertEqual(deploy.count("wranglerVersion: ${{ env.WRANGLER_VERSION }}"), 2)
        self.assertNotIn(retired_action_sha, deploy)

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
