#!/usr/bin/env python3
"""Focused tests for Integrity Cloud Run identity-token acquisition."""

from __future__ import annotations

import importlib.util
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


if __name__ == "__main__":
    unittest.main()
