"""One-shot inherited descriptor handoff; Python never asserts lock ownership."""
import atexit
import json
import os
from pathlib import Path
import socket
import stat
import subprocess

CHANNEL_ENV = "UK_AQ_INTEGRITY_ORIGINAL_OPERATION_CHANNEL"
APPLY_NAMES = {"uk_aq_apply_generic_v3_proposal.mjs", "uk_aq_apply_sos_light_v3_proposal.mjs"}


class OriginalIntegrityChannel:
    def __init__(self, raw):
        self.raw = raw
        self.metadata = json.loads(raw) if raw else None
        self.claimed = False
        if self.metadata is not None:
            fd = self.metadata.get("fd")
            if fd != 3 or not stat.S_ISSOCK(os.fstat(fd).st_mode):
                raise RuntimeError("Invalid original Integrity descriptor")
            # Never implicitly inherit into planners, currentness helpers, R or
            # any other subprocess. Only the selected APPLY uses pass_fds.
            os.set_inheritable(fd, False)
            atexit.register(self.close_unused)

    def close_unused(self):
        if self.metadata is None or self.claimed:
            return
        self.claimed = True
        fd = self.metadata["fd"]
        message = {**self.metadata["binding"], "type": "uk_aq_integrity_original_end",
                   "sequence": 0, "child_lifetime": None}
        # Lifecycle completion is not an assertion or successful ownership result.
        with socket.socket(fileno=fd) as channel:
            channel.sendall((json.dumps(message, separators=(",", ":")) + "\n").encode())

    def popen_apply(self, command, *, repo_root, execution_path, **kwargs):
        expected_name = {"generic_integrity": "uk_aq_apply_generic_v3_proposal.mjs",
                         "sos_light": "uk_aq_apply_sos_light_v3_proposal.mjs"}.get(execution_path)
        expected = Path(repo_root) / "scripts/backup_r2" / (expected_name or "invalid")
        if expected_name not in APPLY_NAMES or Path(command[1]).resolve() != expected.resolve():
            raise RuntimeError("Original Integrity channel requires the selected canonical APPLY")
        child_env = dict(kwargs.pop("env"))
        child_env.pop(CHANNEL_ENV, None)
        if self.metadata is None:
            return subprocess.Popen(command, env=child_env, **kwargs)
        if self.claimed:
            raise RuntimeError("Original Integrity APPLY descriptor already consumed")
        self.claimed = True
        fd = self.metadata["fd"]
        child_env[CHANNEL_ENV] = self.raw
        try:
            return subprocess.Popen(command, env=child_env, pass_fds=(fd,), close_fds=True, **kwargs)
        finally:
            # Only the actual Node child now holds this endpoint. Unexpected
            # child exit breaks the pipe and cancels the protected process group.
            os.close(fd)

    def popen_diagnostic(self, command, *, repo_root, **kwargs):
        """One explicit non-writing child; never an alternative APPLY route."""
        expected = Path(repo_root) / "scripts/backup_r2/uk_aq_schema2_read_only_diagnostic.mjs"
        if (len(command) != 11 or Path(command[1]).resolve() != expected.resolve()
                or command[2] != "--admit-only" or command[3] != "--handoff-json"
                or command[5] != "--sha256" or command[7] != "--bytes"
                or command[9] != "--result-json"):
            raise RuntimeError("Original Integrity diagnostic requires the exact read-only child")
        if self.metadata is None or self.claimed:
            raise RuntimeError("Original Integrity diagnostic descriptor unavailable or consumed")
        child_env = dict(kwargs.pop("env"))
        child_env.pop(CHANNEL_ENV, None)
        self.claimed = True
        fd = self.metadata["fd"]
        child_env[CHANNEL_ENV] = self.raw
        try:
            return subprocess.Popen(command, env=child_env, pass_fds=(fd,), close_fds=True, **kwargs)
        finally:
            os.close(fd)


# Consume launch-only metadata before normal configuration loading or subprocess
# environment copying. A claimed descriptor cannot be recreated by a later run.
ORIGINAL_INTEGRITY_CHANNEL = OriginalIntegrityChannel(os.environ.pop(CHANNEL_ENV, None))
