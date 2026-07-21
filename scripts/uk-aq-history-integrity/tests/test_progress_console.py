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


class TtyBuffer(io.StringIO):
    def isatty(self) -> bool:
        return True


class ProgressConsoleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root_logger = logging.getLogger()
        self.original_handlers = list(self.root_logger.handlers)
        self.original_level = self.root_logger.level

    def tearDown(self) -> None:
        self.root_logger.handlers = self.original_handlers
        self.root_logger.setLevel(self.original_level)

    def test_tty_progress_writes_directly_to_stderr_and_logs_checkpoints(self) -> None:
        console_output = TtyBuffer()
        durable_output = io.StringIO()

        console_handler = logging.StreamHandler(console_output)
        console_handler.addFilter(MODULE.ConsoleNoiseFilter())
        durable_handler = logging.StreamHandler(durable_output)

        self.root_logger.handlers = [console_handler, durable_handler]
        self.root_logger.setLevel(logging.INFO)

        with contextlib.redirect_stderr(console_output):
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

    def test_non_tty_progress_emits_numbered_checkpoint_lines(self) -> None:
        console_output = io.StringIO()
        durable_output = io.StringIO()
        durable_handler = logging.StreamHandler(durable_output)

        self.root_logger.handlers = [durable_handler]
        self.root_logger.setLevel(logging.INFO)

        with contextlib.redirect_stderr(console_output):
            progress = MODULE.SingleLineProgress("sample progress")
            progress.update("0/100 checked=0", force=True)
            progress.update("1/100 checked=1")
            progress.update("2/100 checked=2")
            progress.update("100/100 checked=100", force=True)
            progress.finish()

        console_text = console_output.getvalue()
        self.assertIn("sample progress: 0/100 checked=0\n", console_text)
        self.assertIn("sample progress: 1/100 checked=1\n", console_text)
        self.assertNotIn("sample progress: 2/100 checked=2\n", console_text)
        self.assertIn("sample progress: 100/100 checked=100\n", console_text)

    def test_sos_tty_progress_is_compact_but_log_keeps_full_detail(self) -> None:
        console_output = TtyBuffer()
        durable_output = io.StringIO()
        durable_handler = logging.StreamHandler(durable_output)

        self.root_logger.handlers = [durable_handler]
        self.root_logger.setLevel(logging.INFO)

        detailed_message = (
            "connector_ids=1 day=2026-07-12 stations=188 files=86/188 "
            "current_site=ABCD year=2026 checked=86 downloaded=0 cached=86 "
            "mapped_rows=1152 missing=0 errors=1 planned_backfills=0"
        )
        with contextlib.redirect_stderr(console_output):
            progress = MODULE.SingleLineProgress("sos flat-file progress")
            progress.update(detailed_message, force=True)
            progress.finish()

        console_text = console_output.getvalue()
        durable_text = durable_output.getvalue()
        self.assertIn(
            "\rsos flat-file progress: 86/188 downloaded=0 cached=86 "
            "rows=1152 missing=0 errors=1",
            console_text,
        )
        self.assertNotIn("stations=188", console_text)
        self.assertNotIn("current_site=ABCD", console_text)
        self.assertNotIn("year=2026", console_text)
        self.assertIn(detailed_message, durable_text)


if __name__ == "__main__":
    unittest.main()
