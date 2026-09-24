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


def create_ops_git_repository(root: Path) -> str:
    marker = root / "workers/shared/r2_sigv4.mjs"
    marker.parent.mkdir(parents=True)
    marker.write_text("export const marker = true;\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
    subprocess.run(
        ["git", "-C", str(root), "config", "user.email", "test@example.invalid"],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(root), "config", "user.name", "Integrity Test"],
        check=True,
    )
    subprocess.run(["git", "-C", str(root), "add", "."], check=True)
    subprocess.run(
        ["git", "-C", str(root), "commit", "--quiet", "-m", "fixture"],
        check=True,
    )
    return subprocess.run(
        ["git", "-C", str(root), "rev-parse", "HEAD"],
        check=True, capture_output=True, text=True,
    ).stdout.strip().lower()


class FixedV3WriterProvenanceTest(unittest.TestCase):
    def test_canonical_proposal_parquet_under_hive_paths_is_validated_as_file_schema(
        self,
    ) -> None:
        integrity = load_integrity_module()
        with tempfile.TemporaryDirectory() as temp_raw:
            parquet_path = (
                Path(temp_raw) / "day_utc=2025-01-01" / "connector_id=1" /
                "pollutant_code=no2" / "part-00000.parquet"
            )
            unsupported_path = parquet_path.with_name("part-unsupported.parquet")
            parquet_path.parent.mkdir(parents=True)
            script = """
import fs from "node:fs";
import * as arrow from "apache-arrow";
import * as parquetWasm from "parquet-wasm/esm";
import { serializeCanonicalObservationV2Parquet } from "./workers/shared/uk_aq_r2_history_canonical.mjs";
const rows = [{
  connector_id: 1,
  station_id: 10,
  timeseries_id: 100,
  pollutant_code: "no2",
  observed_at_utc: "2025-01-01T00:00:00.000Z",
  value: 12.5,
  verification_status: "P",
}];
fs.writeFileSync(process.argv[1], serializeCanonicalObservationV2Parquet(rows));
const unsupportedTable = arrow.tableFromArrays({
  connector_id: arrow.vectorFromArray([1], new arrow.Int32()),
  station_id: arrow.vectorFromArray([10], new arrow.Int32()),
  timeseries_id: arrow.vectorFromArray([100], new arrow.Int32()),
  pollutant_code: arrow.vectorFromArray(["no2"], new arrow.Utf8()),
  observed_at_utc: arrow.vectorFromArray(
    [new Date("2025-01-01T00:00:00.000Z")],
    new arrow.TimestampMillisecond(),
  ),
  value: arrow.vectorFromArray([12.5], new arrow.Float64()),
  vstatus: arrow.vectorFromArray(["P"], new arrow.Utf8()),
});
const unsupportedWasmTable = parquetWasm.Table.fromIPCStream(
  arrow.tableToIPC(unsupportedTable, "stream"),
);
fs.writeFileSync(
  process.argv[2],
  parquetWasm.writeParquet(
    unsupportedWasmTable,
    new parquetWasm.WriterPropertiesBuilder().build(),
  ),
);
"""
            subprocess.run(
                [
                    "node", "--input-type=module", "-e", script,
                    str(parquet_path), str(unsupported_path),
                ],
                cwd=REPO_ROOT,
                check=True,
                capture_output=True,
                text=True,
            )
            rows = integrity._observation_rows_from_local_parquet_for_shared_hash(
                parquet_paths=[str(parquet_path)],
                require_canonical_schema=True,
            )
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["verification_status"], "P")
            self.assertNotIn("day_utc", rows[0])
            with self.assertRaisesRegex(
                ValueError,
                r"expected_columns=.*verification_status.*actual=.*vstatus:VARCHAR",
            ):
                integrity._observation_rows_from_local_parquet_for_shared_hash(
                    parquet_paths=[str(unsupported_path)],
                    require_canonical_schema=True,
                )

    def test_repo_head_is_resolved_with_explicit_repository_and_pinned(self) -> None:
        integrity = load_integrity_module()
        old = os.environ.pop(integrity.INTEGRITY_TARGET_WRITER_GIT_SHA_ENV, None)
        try:
            with tempfile.TemporaryDirectory() as temp_raw:
                repo = Path(temp_raw)
                expected = create_ops_git_repository(repo)
                env = {"UK_AQ_OPS_REPO_ROOT": str(repo)}
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

    def test_dirty_explicit_repository_is_rejected_before_sha_is_pinned(self) -> None:
        integrity = load_integrity_module()
        name = integrity.INTEGRITY_TARGET_WRITER_GIT_SHA_ENV
        old = os.environ.pop(name, None)
        try:
            with tempfile.TemporaryDirectory() as temp_raw:
                repo = Path(temp_raw)
                create_ops_git_repository(repo)
                (repo / "workers/shared/r2_sigv4.mjs").write_text(
                    "export const marker = false;\n", encoding="utf-8",
                )
                env = {"UK_AQ_OPS_REPO_ROOT": str(repo)}
                with self.assertRaisesRegex(
                    RuntimeError,
                    "requires a clean ops repository worktree",
                ):
                    integrity.resolve_and_pin_integrity_target_writer_git_sha(env)
                self.assertNotIn(name, env)
                self.assertNotIn(name, os.environ)
        finally:
            if old is not None:
                os.environ[name] = old

    def test_valid_inherited_pin_is_reused_and_invalid_pin_fails_closed(self) -> None:
        integrity = load_integrity_module()
        name = integrity.INTEGRITY_TARGET_WRITER_GIT_SHA_ENV
        old = os.environ.get(name)
        try:
            with tempfile.TemporaryDirectory() as temp_raw:
                repo = Path(temp_raw)
                expected = create_ops_git_repository(repo)
                env = {"UK_AQ_OPS_REPO_ROOT": str(repo)}
                os.environ[name] = expected
                self.assertEqual(
                    integrity.resolve_and_pin_integrity_target_writer_git_sha(env),
                    expected,
                )
                os.environ[name] = "A" * 40
                with self.assertRaisesRegex(RuntimeError, "must exactly match"):
                    integrity.resolve_and_pin_integrity_target_writer_git_sha(env)
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
