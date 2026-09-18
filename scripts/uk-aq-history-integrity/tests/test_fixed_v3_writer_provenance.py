#!/usr/bin/env python3
"""Focused checks for fixed-v3 writer provenance pinning and propagation."""
from __future__ import annotations

import datetime as dt
import importlib.util
import logging
import os
import tempfile
from pathlib import Path
import subprocess
import unittest


REPO_ROOT = Path(__file__).resolve().parents[3]
ENTRYPOINT = REPO_ROOT / "scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3.py"
WRAPPER = REPO_ROOT / "scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill_v3.sh"


def load_integrity_module():
    spec = importlib.util.spec_from_file_location("fixed_v3_integrity", ENTRYPOINT)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load fixed-v3 Integrity module")
    module = importlib.util.module_from_spec(spec)
    import sys
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class FixedV3WriterProvenanceTest(unittest.TestCase):
    def test_repo_head_is_resolved_with_explicit_repository_and_pinned(self) -> None:
        integrity = load_integrity_module()
        expected = subprocess.run(
            ["git", "-C", str(REPO_ROOT), "rev-parse", "HEAD"],
            check=True, capture_output=True, text=True,
        ).stdout.strip().lower()
        old = os.environ.pop(integrity.INTEGRITY_TARGET_WRITER_GIT_SHA_ENV, None)
        env = {"UK_AQ_OPS_REPO_ROOT": str(REPO_ROOT)}
        try:
            self.assertEqual(
                integrity.resolve_and_pin_integrity_target_writer_git_sha(env),
                expected,
            )
            self.assertEqual(env[integrity.INTEGRITY_TARGET_WRITER_GIT_SHA_ENV], expected)
            self.assertEqual(os.environ[integrity.INTEGRITY_TARGET_WRITER_GIT_SHA_ENV], expected)
        finally:
            if old is None:
                os.environ.pop(integrity.INTEGRITY_TARGET_WRITER_GIT_SHA_ENV, None)
            else:
                os.environ[integrity.INTEGRITY_TARGET_WRITER_GIT_SHA_ENV] = old

    def test_valid_inherited_pin_is_reused_and_invalid_pin_fails_closed(self) -> None:
        integrity = load_integrity_module()
        name = integrity.INTEGRITY_TARGET_WRITER_GIT_SHA_ENV
        old = os.environ.get(name)
        try:
            expected = subprocess.run(
                ["git", "-C", str(REPO_ROOT), "rev-parse", "HEAD"],
                check=True, capture_output=True, text=True,
            ).stdout.strip().lower()
            os.environ[name] = expected
            self.assertEqual(
                integrity.resolve_and_pin_integrity_target_writer_git_sha({}),
                expected,
            )
            os.environ[name] = "A" * 40
            with self.assertRaisesRegex(RuntimeError, "must exactly match"):
                integrity.resolve_and_pin_integrity_target_writer_git_sha({})
        finally:
            if old is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = old

    def test_all_backfill_children_receive_the_same_pinned_sha(self) -> None:
        integrity = load_integrity_module()
        name = integrity.INTEGRITY_TARGET_WRITER_GIT_SHA_ENV
        old = os.environ.get(name)
        captured = []
        original_run = integrity.subprocess.run
        class Proc:
            returncode = 0
            stdout = ""
            stderr = ""
        try:
            os.environ[name] = "b" * 40
            integrity.subprocess.run = lambda *_args, **kwargs: (
                captured.append(dict(kwargs.get("env") or {})) or Proc()
            )
            with tempfile.TemporaryDirectory() as temp_raw:
                wrapper = Path(temp_raw) / "backfill.sh"
                wrapper.write_text("#!/usr/bin/env bash\n", encoding="utf-8")
                for day in (1, 2):
                    result = integrity.run_narrow_backfill(
                        wrapper_path=str(wrapper), env_file_path=None, env_name="TEST",
                        timeseries_ids=[day], day=dt.date(2026, 6, day),
                        log=logging.getLogger("writer-pin-test"), history_version="v3",
                        worker_purpose="repair_proposal", canonical_writes_allowed=False,
                        extra_env={"UK_AQ_BACKFILL_INTEGRITY_PROPOSAL_MODE": "prepare"},
                    )
                    self.assertEqual(result["status"], "ok")
            self.assertEqual(
                [child[name] for child in captured],
                ["b" * 40, "b" * 40],
            )
        finally:
            integrity.subprocess.run = original_run
            if old is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = old

    def test_specialist_wrapper_reexports_pin_after_env_loading(self) -> None:
        source = WRAPPER.read_text(encoding="utf-8")
        capture = source.index("INCOMING_TARGET_WRITER_GIT_SHA=")
        load = source.index('apply_env_file_safe "${ENV_FILE}"')
        reexport = source.index('export UK_AQ_INTEGRITY_TARGET_WRITER_GIT_SHA=')
        self.assertLess(capture, load)
        self.assertLess(load, reexport)
        self.assertIn('^[0-9a-f]{40}$', source)


if __name__ == "__main__":
    unittest.main()
