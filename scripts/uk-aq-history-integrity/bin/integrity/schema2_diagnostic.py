"""Explicit TEST-only coordinator integration; no writer or alternate lock."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import signal
import time

CONTRACT = "uk_aq_integrity_schema2_read_only_diagnostic_v1"
RESULT_LIMIT = 64 * 1024
HANDOFF_LIMIT = 8 * 1024 * 1024


def run_protected_diagnostic_command(command, *, cwd, env):
    """Forward outer cancellation and await holder cleanup before scratch exits."""
    process = None
    cancelled = None

    def stop(signum, _frame):
        nonlocal cancelled
        cancelled = signum
        if process is not None and process.poll() is None:
            try:
                process.send_signal(signum)
            except ProcessLookupError:
                pass

    previous = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)}
    try:
        for sig in previous:
            signal.signal(sig, stop)
        process = subprocess.Popen(command, cwd=cwd, env=env)
        if cancelled is not None:
            stop(cancelled, None)
        code = process.wait()
        return subprocess.CompletedProcess(command, code if not cancelled or code else 128 + cancelled)
    finally:
        try:
            if process is not None and process.poll() is None:
                stop(signal.SIGTERM, None)
                # The existing holder owns bounded TERM/KILL group shutdown,
                # reaping and PostgreSQL finally-release. Never remove scratch
                # while that protected lifetime is still running.
                process.wait()
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)


def diagnostic_flags():
    return dict(read_only=True, evidence_scope="completed_call_only", reusable_currentness=False,
                repair_apply_eligible=False, publication_eligible=False, repair_completed=False,
                writer_finalisation_completed=False, r2_mutation_attempted=False,
                current_object_authority=None, conditional_publication_authority=None,
                source_deletion_eligible=False)


def _read(path, maximum):
    path = Path(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        if not 0 < before.st_size <= maximum:
            raise ValueError("diagnostic artifact exceeds finite size limit")
        with os.fdopen(os.dup(fd), "rb") as handle:
            body = handle.read(maximum + 1)
        after = os.fstat(fd)
        if len(body) != before.st_size or (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
            raise ValueError("diagnostic artifact changed")
        return body
    finally:
        os.close(fd)


def _persist(path, value):
    path = Path(path)
    body = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    if len(body) > RESULT_LIMIT:
        raise ValueError("diagnostic result exceeds finite size limit")
    temporary = path.with_name(path.name + f".partial-{os.getpid()}")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(body)
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)


def run_schema2_diagnostic(*, args, env, run_compact, dropbox_root, dropbox_currentness,
                           ingest_boundary, global_operation_lock, original_channel,
                           repo_root, started_mono, log):
    """Called only after the existing locked Step 0; always returns before repair."""
    report_dir = Path(env["UK_AQ_HISTORY_INTEGRITY_REPORT_DIR"])
    report_dir.mkdir(parents=True, exist_ok=True)
    report = report_dir / f"{run_compact}-schema2-diagnostic.json"
    result = dict(contract_version=CONTRACT, status="diagnostic_interrupted", **diagnostic_flags(),
                  run_id=global_operation_lock.get("run_id"), original_session_continuity_lost=None,
                  original_session_continuity="unconfirmed", reason="Protected diagnostic did not complete")
    _persist(report, result)
    process = None
    try:
        if not (args.schema2_read_only_diagnostic and args.env == "TEST" and args.profile == "manual"
                and original_channel.metadata is not None and not original_channel.claimed
                and ingest_boundary.get("allowed") is True and dropbox_currentness.get("allowed") is True
                and dropbox_currentness.get("checkpoint_live_root_match") is True):
            raise ValueError("complete original protected TEST diagnostic preconditions required")
        workspace = Path(args.schema2_diagnostic_work_root)
        expected_parent = Path(env["UK_AQ_HISTORY_INTEGRITY_TMP_DIR"]).resolve()
        if (workspace.is_symlink() or workspace.resolve().parent != expected_parent
                or not workspace.name.startswith(f"schema2-{run_compact}-") or not workspace.is_dir()):
            raise ValueError("diagnostic workspace is not the outer invocation's private scratch")
        connectors = ingest_boundary.get("connectors") or []
        if not connectors or any(c.get("allowed") is not True or not isinstance(c.get("connector_id"), int) or c["connector_id"] <= 0 for c in connectors):
            raise ValueError("authenticated request-wide connector scope unavailable")
        scopes = [dict(day_utc=args.from_day, connector_id=c, pollutant_code=p)
                  for c in sorted({c["connector_id"] for c in connectors}) for p in args.diagnostic_pollutants]
        if not 0 < len(scopes) <= 16:
            raise ValueError("diagnostic affected scope limit exceeded")
        seed = dict(contract_version=CONTRACT, environment="TEST", run_id=global_operation_lock["run_id"],
                    operation_nonce=os.environ.get("UK_AQ_OBSERVATIONS_GLOBAL_OPERATION_LOCK_NONCE"),
                    execution_path="sos_light" if args.source == "sos" else "generic_integrity",
                    original_root=str(dropbox_root), dropbox_currentness=dropbox_currentness, scopes=scopes)
        bootstrap = workspace / "bootstrap.json"
        body = json.dumps(seed, sort_keys=True, separators=(",", ":")).encode()
        if len(body) > RESULT_LIMIT:
            raise ValueError("diagnostic bootstrap exceeds finite limit")
        bootstrap.write_bytes(body)
        bootstrap.chmod(0o600)
        script = Path(repo_root) / "scripts/backup_r2/uk_aq_schema2_read_only_diagnostic.mjs"
        node = str(env.get("UK_AQ_BACKFILL_NODE_BIN") or "node")
        child_env = {**os.environ, **{str(k): str(v) for k, v in env.items()}}
        child_env.pop("UK_AQ_INTEGRITY_ORIGINAL_OPERATION_CHANNEL", None)
        deadline = started_mono + args.max_runtime_minutes * 60

        def wait(child):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired("schema2 diagnostic", args.max_runtime_minutes * 60)
            return child.wait(timeout=remaining)

        prepared_result = workspace / "preparation-result.json"
        command = [node, str(script), "--prepare-only", "--handoff-json", str(bootstrap),
                   "--sha256", hashlib.sha256(body).hexdigest(), "--bytes", str(len(body)), "--result-json", str(prepared_result)]
        process = subprocess.Popen(command, cwd=repo_root, env=child_env, close_fds=True,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        code = wait(process)
        preparation = json.loads(_read(prepared_result, RESULT_LIMIT))
        if code != 0 or preparation.get("status") != "diagnostic_prepared_only":
            result.update(status="diagnostic_blocked", reason_code=preparation.get("reason_code", "preparation_blocked"),
                          reason=str(preparation.get("reason") or "Unsupported/incomplete preparation")[:512])
            _persist(report, result)
            return 2
        pin = preparation["handoff"]
        if pin.get("key") != "prepared-request.json":
            raise ValueError("unexpected preparation artifact")
        handoff = workspace / pin["key"]
        prepared_body = _read(handoff, HANDOFF_LIMIT)
        if len(prepared_body) != pin["byte_size"] or hashlib.sha256(prepared_body).hexdigest() != pin["sha256"]:
            raise ValueError("preparation handoff SHA/size mismatch")
        command = [node, str(script), "--admit-only", "--handoff-json", str(handoff),
                   "--sha256", pin["sha256"], "--bytes", str(pin["byte_size"]), "--result-json", str(report)]
        process = original_channel.popen_diagnostic(command, repo_root=repo_root, cwd=repo_root, env=child_env,
                                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        code = wait(process)
        result = json.loads(_read(report, RESULT_LIMIT))
        if (result.get("contract_version") != CONTRACT or any(result.get(k) != v for k, v in diagnostic_flags().items())
                or result.get("run_id") != global_operation_lock["run_id"]):
            raise ValueError("invalid bounded diagnostic result")
        log.info("schema2 diagnostic status=%s report=%s", result.get("status"), report)
        return 0 if code == 0 and result.get("status") == "diagnostic_authenticated" else 2
    except subprocess.TimeoutExpired:
        result.update(status="diagnostic_timeout", reason_code="runtime_limit", reason="Finite diagnostic runtime exceeded; no resume",
                      original_session_continuity_lost=None, original_session_continuity="lost_or_uncertain")
        _persist(report, result)
        return 2
    except Exception as exc:
        # Do not serialize arbitrary environment/exception objects. Detailed
        # admitted preparation/current-object failures come from the child.
        result.update(status="diagnostic_blocked", reason_code="diagnostic_handoff_or_lifecycle_failure",
                      reason=(str(exc)[:512] if isinstance(exc, ValueError) else f"Diagnostic artifact/process failure ({type(exc).__name__})"),
                      original_session_continuity_lost=None, original_session_continuity="unconfirmed")
        _persist(report, result)
        return 2
    finally:
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def finish_schema2_diagnostic(report_dir, run_compact, code):
    """Outer caller runs only after holder group cleanup/release has returned."""
    report = Path(report_dir) / f"{run_compact}-schema2-diagnostic.json"
    if code != 0 and report.exists():
        result = json.loads(_read(report, RESULT_LIMIT))
        if result.get("status") == "diagnostic_authenticated":
            result.update(status="diagnostic_failed_cleanup", reason_code="protected_lifecycle_failed",
                          reason="Admission returned but protected lifecycle did not succeed",
                          original_session_continuity_lost=None, original_session_continuity="unconfirmed")
            _persist(report, result)
