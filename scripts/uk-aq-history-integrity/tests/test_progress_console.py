#!/usr/bin/env python3
"""Regression tests for Integrity live and durable progress output."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import logging
import sys
import unittest
from pathlib import Path


MODULE_PATH = (
    Path(__file__).resolve().parents[1] / "bin" / "uk-aq-history-integrity.py"
)
SPEC = importlib.util.spec_from_file_location(
    "uk_aq_history_integrity_progress_test",
    MODULE_PATH,
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module at {MODULE_PATH}")
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class ProgressConsoleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root_logger = logging.getLogger()
        self.original_handlers = list(self.root_logger.handlers)
        self.original_level = self.root_logger.level

    def tearDown(self) -> None:
        self.root_logger.handlers = self.original_handlers
        self.root_logger.setLevel(self.original_level)

    def test_numbered_progress_stays_live_while_checkpoints_are_logged(self) -> None:
        console_output = io.StringIO()
        durable_output = io.StringIO()

        console_handler = logging.StreamHandler(console_output)
        console_handler.addFilter(MODULE.ConsoleNoiseFilter())
        durable_handler = logging.StreamHandler(durable_output)

        self.root_logger.handlers = [console_handler, durable_handler]
        self.root_logger.setLevel(logging.INFO)

        with contextlib.redirect_stdout(console_output):
            progress = MODULE.SingleLineProgress("sample progress")
            progress.update("0/2 checked=0", force=True)
            progress.update("2/2 checked=2", force=True)
            progress.finish()

        logging.getLogger("progress-test").info(
            "sos flat-file progress connector_ids=1 files=1/2"
        )
        logging.getLogger(MODULE._PROGRESS_LOGGER_NAME).warning(
            "progress warning remains visible"
        )

        console_text = console_output.getvalue()
        durable_text = durable_output.getvalue()

        self.assertIn("\rsample progress: 0/2 checked=0", console_text)
        self.assertIn("\rsample progress: 2/2 checked=2", console_text)
        self.assertNotIn(
            "sos flat-file progress connector_ids=1 files=1/2",
            console_text,
        )
        self.assertIn("progress warning remains visible", console_text)

        self.assertIn("sample progress: 0/2 checked=0", durable_text)
        self.assertIn("sample progress: 2/2 checked=2", durable_text)
        self.assertIn(
            "sos flat-file progress connector_ids=1 files=1/2",
            durable_text,
        )


if __name__ == "__main__":
    unittest.main()
