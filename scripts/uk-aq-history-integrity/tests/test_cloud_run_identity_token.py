#!/usr/bin/env python3
"""Focused tests for Integrity Cloud Run identity-token acquisition."""

from __future__ import annotations

import importlib.util
import inspect
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


MODULE_PATH = (
    Path(__file__).resolve().parents[1] / "bin" / "uk-aq-history-integrity.py"
)
SPEC = importlib.util.spec_from_file_location(
    "uk_aq_history_integrity_cloud_run_identity_token",
    MODULE_PATH,
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module at {MODULE_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class CloudRunIdentityTokenTests(unittest.TestCase):
    def test_explicit_account_impersonation_and_audience(self) -> None:
        completed = SimpleNamespace(returncode=0, stdout="  token-value\n", stderr="")
        environment = {
            "CLOUDSDK_CORE_ACCOUNT": "operator@example.test",
            "CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT": (
                "integrity-caller@example-project.iam.gserviceaccount.com"
            ),
        }
        with mock.patch.dict(os.environ, environment, clear=True), mock.patch.object(
            MODULE.subprocess, "run", return_value=completed
        ) as run:
            token = MODULE._google_cloud_run_identity_token(
                "https://latest-snapshot.example.test"
            )

        self.assertEqual(token, "token-value")
        run.assert_called_once_with(
            [
                "gcloud",
                "auth",
                "print-identity-token",
                "--account=operator@example.test",
                "--impersonate-service-account="
                "integrity-caller@example-project.iam.gserviceaccount.com",
                "--audiences=https://latest-snapshot.example.test",
            ],
            capture_output=True,
            text=True,
            check=False,
            timeout=60,
        )

    def test_audience_is_always_present_without_optional_identity_flags(self) -> None:
        completed = SimpleNamespace(returncode=0, stdout="service-token", stderr="")
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(
            MODULE.subprocess, "run", return_value=completed
        ) as run:
            token = MODULE._google_cloud_run_identity_token(
                "https://latest-snapshot.example.test"
            )

        self.assertEqual(token, "service-token")
        run.assert_called_once_with(
            [
                "gcloud",
                "auth",
                "print-identity-token",
                "--audiences=https://latest-snapshot.example.test",
            ],
            capture_output=True,
            text=True,
            check=False,
            timeout=60,
        )

    def test_nonzero_result_fails_once_with_bounded_stderr(self) -> None:
        completed = SimpleNamespace(
            returncode=1,
            stdout="",
            stderr="useful failure detail " * 100,
        )
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(
            MODULE.subprocess, "run", return_value=completed
        ) as run, self.assertRaises(RuntimeError) as raised:
            MODULE._google_cloud_run_identity_token(
                "https://latest-snapshot.example.test"
            )

        message = str(raised.exception)
        self.assertIn("useful failure detail", message)
        self.assertLessEqual(len(message), 650)
        run.assert_called_once()
        command = run.call_args.args[0]
        self.assertIn("--audiences=https://latest-snapshot.example.test", command)

    def test_blank_stdout_fails_closed(self) -> None:
        completed = SimpleNamespace(returncode=0, stdout="  \n", stderr="")
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(
            MODULE.subprocess, "run", return_value=completed
        ) as run, self.assertRaisesRegex(RuntimeError, "empty token"):
            MODULE._google_cloud_run_identity_token(
                "https://latest-snapshot.example.test"
            )

        run.assert_called_once()

    def test_blank_audience_fails_before_subprocess(self) -> None:
        with mock.patch.object(MODULE.subprocess, "run") as run, self.assertRaisesRegex(
            RuntimeError, "audience is required"
        ):
            MODULE._google_cloud_run_identity_token("  ")

        run.assert_not_called()

    def test_route_and_audience_must_share_an_origin(self) -> None:
        settings = {
            "UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_URL": (
                "https://service.example.test/internal/integrity-reconcile"
            ),
            "UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_AUDIENCE": (
                "https://different.example.test"
            ),
            "UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_TIMEOUT_SECONDS": "300",
        }
        with self.assertRaisesRegex(RuntimeError, "same service origin"):
            MODULE.validate_latest_snapshot_auth_config(settings)

    def test_preflight_conditions_skip_non_mutating_and_o3_only_runs(self) -> None:
        base = {
            "current_state_enabled": True,
            "selected_pollutants": {"pm25"},
            "canonical_mutation_planned": True,
            "proposals_validated": True,
            "check_only": False,
            "dry_run": False,
        }
        self.assertTrue(MODULE.should_preflight_latest_snapshot_auth(**base))
        for override in (
            {"current_state_enabled": False},
            {"selected_pollutants": {"o3"}},
            {"canonical_mutation_planned": False},
            {"proposals_validated": False},
            {"check_only": True},
            {"dry_run": True},
        ):
            with self.subTest(override=override):
                self.assertFalse(
                    MODULE.should_preflight_latest_snapshot_auth(
                        **{**base, **override}
                    )
                )

    def test_final_call_acquires_a_fresh_second_token(self) -> None:
        settings = {
            "CLOUDSDK_CORE_ACCOUNT": "info@ukaq.co.uk",
            "CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT": (
                "uk-aq-ops-job@project-53835517-a266-48e3-8d9.iam."
                "gserviceaccount.com"
            ),
            "UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_URL": (
                "https://uk-aq-latest-snapshot-builder-54exhfdj4q-nw.a.run.app/"
                "internal/integrity-reconcile"
            ),
            "UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_AUDIENCE": (
                "https://uk-aq-latest-snapshot-builder-54exhfdj4q-nw.a.run.app"
            ),
            "UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_TIMEOUT_SECONDS": "30",
        }
        completed = [
            SimpleNamespace(returncode=0, stdout="preflight-token\n", stderr=""),
            SimpleNamespace(returncode=0, stdout="final-token\n", stderr=""),
        ]
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = b'{"ok":true}'
        with mock.patch.object(
            MODULE.subprocess, "run", side_effect=completed
        ) as run, mock.patch.object(
            MODULE.urllib.request, "urlopen", return_value=response
        ) as urlopen:
            preflight = MODULE.preflight_latest_snapshot_auth(settings)
            result = MODULE._post_cloud_run_reconciliation(
                url=settings[
                    "UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_URL"
                ],
                audience=settings[
                    "UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_AUDIENCE"
                ],
                body={"schema_version": 1, "integrity_run_id": "CIC-Test:1", "candidates": []},
                timeout_seconds=30,
                settings=settings,
            )
        self.assertEqual(run.call_count, 2)
        expected_command = [
            "gcloud",
            "auth",
            "print-identity-token",
            "--account=info@ukaq.co.uk",
            "--impersonate-service-account=uk-aq-ops-job@project-53835517-a266-48e3-8d9.iam.gserviceaccount.com",
            "--audiences=https://uk-aq-latest-snapshot-builder-54exhfdj4q-nw.a.run.app",
        ]
        self.assertEqual(run.call_args_list[0].args[0], expected_command)
        self.assertEqual(run.call_args_list[1].args[0], expected_command)
        self.assertFalse(preflight["token_retained"])
        self.assertNotIn("token", " ".join(map(str, preflight.values())))
        self.assertTrue(result["ok"])
        request = urlopen.call_args.args[0]
        self.assertEqual(request.get_header("Authorization"), "Bearer final-token")

    def test_coordinator_orders_preflight_before_canonical_apply(self) -> None:
        source = inspect.getsource(MODULE.run_v2_integrity_repair_flow)
        preflight_offset = source.index(
            "preflight_latest_snapshot_auth(auth_settings)"
        )
        blocked_offset = source.index("proposal_failed = True", preflight_offset)
        apply_offset = source.index("run_canonical_apply_executor", preflight_offset)
        self.assertLess(preflight_offset, blocked_offset)
        self.assertLess(blocked_offset, apply_offset)


if __name__ == "__main__":
    unittest.main()
