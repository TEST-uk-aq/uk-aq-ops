#!/usr/bin/env python3
"""UK-AQ History Integrity entrypoint with durable progress checkpoints.

The implementation lives in the sibling ``uk-aq-history-integrity_impl.py``
file. It is executed in this module's namespace so the established command
path, imports, monkeypatches and public symbols continue to behave as before.
"""

from pathlib import Path as _WrapperPath
import sys as _wrapper_sys


_PUBLIC_MODULE_NAME = __name__
_IMPLEMENTATION_MODULE_NAME = f"{_PUBLIC_MODULE_NAME}._implementation"
_CURRENT_MODULE = _wrapper_sys.modules.get(_PUBLIC_MODULE_NAME)
if _CURRENT_MODULE is None:
    raise RuntimeError(f"Integrity entrypoint module is not registered: {_PUBLIC_MODULE_NAME}")
_wrapper_sys.modules[_IMPLEMENTATION_MODULE_NAME] = _CURRENT_MODULE

_IMPLEMENTATION_PATH = _WrapperPath(__file__).with_name("uk-aq-history-integrity_impl.py")
_IMPLEMENTATION_SOURCE = _IMPLEMENTATION_PATH.read_text(encoding="utf-8")

globals()["__name__"] = _IMPLEMENTATION_MODULE_NAME
try:
    exec(
        compile(_IMPLEMENTATION_SOURCE, str(_IMPLEMENTATION_PATH), "exec"),
        globals(),
        globals(),
    )
finally:
    globals()["__name__"] = _PUBLIC_MODULE_NAME


_ORIGINAL_CONSOLE_NOISE_FILTER = ConsoleNoiseFilter
_PROGRESS_LOGGER_NAME = "uk_aq_history_integrity.progress"
_PROGRESS_COUNTS_RE = re.compile(r"(?:files=)?(?P<completed>\d+)/(?P<total>\d+)")
_PROGRESS_LOG_INTERVAL_SECONDS = 30.0
_PROGRESS_LOG_CHECKPOINTS = 20


class ProgressAwareConsoleNoiseFilter(_ORIGINAL_CONSOLE_NOISE_FILTER):
    """Keep durable progress checkpoints out of the logging console handler."""

    def filter(self, record: logging.LogRecord) -> bool:
        if record.levelno < logging.WARNING:
            if record.name == _PROGRESS_LOGGER_NAME:
                return False
            if record.getMessage().startswith("sos flat-file progress "):
                return False
        return super().filter(record)


class DurableSingleLineProgress:
    """Write live progress directly to stderr and durable INFO checkpoints."""

    def __init__(self, label: str, *args: Any, **kwargs: Any) -> None:
        self._label = str(label)
        self._stream = kwargs.pop("stream", None) or _wrapper_sys.stderr
        self._last_logged_at = 0.0
        self._last_logged_message: str | None = None
        self._last_live_message: str | None = None
        self._next_completed_checkpoint = 0
        self._last_rendered_width = 0
        self._live_line_active = False

    @staticmethod
    def _clean_message(message: Any) -> str:
        return " ".join(str(message).replace("\r", " ").replace("\n", " ").split())

    def _stream_is_tty(self) -> bool:
        try:
            return bool(self._stream.isatty())
        except (AttributeError, OSError, ValueError):
            return False

    def _live_text(self, text: str) -> str:
        """Keep the SOS terminal line compact while preserving full log detail."""
        if self._label != "sos flat-file progress":
            return text

        counts_match = _PROGRESS_COUNTS_RE.search(text)
        if counts_match is None:
            return text

        parts = [f"{counts_match.group('completed')}/{counts_match.group('total')}"]
        for source_name, live_name in (
            ("downloaded", "downloaded"),
            ("cached", "cached"),
            ("mapped_rows", "rows"),
            ("missing", "missing"),
            ("errors", "errors"),
        ):
            value_match = re.search(
                rf"(?:^|\s){re.escape(source_name)}=([^\s]+)",
                text,
            )
            if value_match is not None:
                parts.append(f"{live_name}={value_match.group(1)}")
        return " ".join(parts)

    def _should_log(self, text: str, *, force: bool, now: float) -> bool:
        if force or self._last_logged_message is None:
            return True
        if now - self._last_logged_at >= _PROGRESS_LOG_INTERVAL_SECONDS:
            return True

        match = _PROGRESS_COUNTS_RE.search(text)
        if match is None:
            return False
        completed = int(match.group("completed"))
        total = int(match.group("total"))
        interval = max(1, math.ceil(max(total, 1) / _PROGRESS_LOG_CHECKPOINTS))
        if completed == 0 or completed >= total or completed >= self._next_completed_checkpoint:
            self._next_completed_checkpoint = completed + interval
            return True
        return False

    def _write_live(self, text: str, *, checkpoint: bool) -> None:
        line = f"{self._label}: {text}"
        try:
            if self._stream_is_tty():
                padded = line.ljust(max(self._last_rendered_width, len(line)))
                self._stream.write(f"\r{padded}")
                self._last_rendered_width = len(line)
                self._live_line_active = True
            elif checkpoint:
                self._stream.write(f"{line}\n")
            self._stream.flush()
        except (BrokenPipeError, OSError, ValueError):
            return

    def update(self, message: Any, *args: Any, **kwargs: Any) -> None:
        text = self._clean_message(message)
        if not text:
            return

        force = bool(kwargs.get("force", False))
        now = time.monotonic()
        checkpoint = (
            text != self._last_logged_message
            and self._should_log(text, force=force, now=now)
        )
        live_text = self._live_text(text)

        if force or live_text != self._last_live_message:
            self._write_live(live_text, checkpoint=checkpoint)
            self._last_live_message = live_text

        if checkpoint:
            logging.getLogger(_PROGRESS_LOGGER_NAME).info(
                "%s: %s",
                self._label,
                text,
            )
            self._last_logged_at = now
            self._last_logged_message = text

    def finish(self, *args: Any, **kwargs: Any) -> None:
        if self._live_line_active:
            try:
                self._stream.write("\n")
                self._stream.flush()
            except (BrokenPipeError, OSError, ValueError):
                pass
            self._live_line_active = False


ConsoleNoiseFilter = ProgressAwareConsoleNoiseFilter
SingleLineProgress = DurableSingleLineProgress


_ORIGINAL_ASSEMBLE_SOS_LIGHT_COMPLETE_DAYS = assemble_sos_light_complete_days
_ORIGINAL_PATH_RGLOB = Path.rglob


def _is_ignored_macos_metadata_path(candidate: Path) -> bool:
    """Return true only for known Finder/AppleDouble metadata files."""
    return candidate.name == ".DS_Store" or candidate.name.startswith("._")


def assemble_sos_light_complete_days(run_state: dict[str, Any]) -> dict[str, Any]:
    """Exclude known macOS metadata while assembling the Dropbox baseline."""
    ignored_count = 0

    def filtered_rglob(
        path_instance: Path,
        pattern: str,
        *args: Any,
        **kwargs: Any,
    ) -> Iterable[Path]:
        nonlocal ignored_count
        for candidate in _ORIGINAL_PATH_RGLOB(
            path_instance,
            pattern,
            *args,
            **kwargs,
        ):
            if _is_ignored_macos_metadata_path(candidate):
                ignored_count += 1
                continue
            yield candidate

    Path.rglob = filtered_rglob
    try:
        result = _ORIGINAL_ASSEMBLE_SOS_LIGHT_COMPLETE_DAYS(run_state)
    finally:
        Path.rglob = _ORIGINAL_PATH_RGLOB

    ignored_audit = {
        "ignored_local_filesystem_metadata_count": ignored_count,
        "ignored_local_filesystem_metadata_patterns": [
            ".DS_Store",
            "._*",
        ],
    }
    result.update(ignored_audit)
    audit = run_state.get("sos_light")
    if isinstance(audit, dict):
        audit.update(ignored_audit)
        write_run_state(run_state)

    if ignored_count:
        logging.getLogger("uk-aq-history-integrity").info(
            "SOS-light ignored %d known macOS metadata files from the Dropbox baseline",
            ignored_count,
        )
    return result


_ORIGINAL_FORMAT_SUMMARY_MD = format_summary_md
_GLOBAL_FINALISATION_LOGGED_RESULT_IDS: set[int] = set()


def _v2_global_index_finalisation(result: dict[str, Any]) -> dict[str, Any] | None:
    """Return the v2 global index finalisation audit object when present."""
    history_results = result.get("history_version_results")
    if isinstance(history_results, dict):
        v2_result = history_results.get("v2")
        if isinstance(v2_result, dict):
            final_verification = v2_result.get("final_verification")
            if isinstance(final_verification, dict):
                global_finalisation = final_verification.get("global_index_finalization")
                if isinstance(global_finalisation, dict):
                    return global_finalisation

    final_verification = result.get("final_verification")
    if isinstance(final_verification, dict):
        global_finalisation = final_verification.get("global_index_finalization")
        if isinstance(global_finalisation, dict):
            return global_finalisation
    return None


def _markdown_value_list(values: Any) -> str:
    if not isinstance(values, list) or not values:
        return "none"
    return ", ".join(f"`{value}`" for value in values)


def _render_global_index_finalisation_md(result: dict[str, Any]) -> list[str]:
    global_finalisation = _v2_global_index_finalisation(result)
    if global_finalisation is None:
        return []

    affected_days = global_finalisation.get("affected_days_utc")
    if not isinstance(affected_days, list):
        affected_days = []

    index_finalisation = global_finalisation.get("index_finalization")
    if not isinstance(index_finalisation, dict):
        index_finalisation = {}

    hierarchy = global_finalisation.get("observations_manifest_hierarchy")
    if not isinstance(hierarchy, dict):
        hierarchy = {}

    execution = hierarchy.get("execution")
    if not isinstance(execution, dict):
        execution = {}
    writes = execution.get("writes")
    if not isinstance(writes, list):
        writes = []
    wrote_object_count = execution.get("wrote_object_count")
    if not isinstance(wrote_object_count, int):
        wrote_object_count = len(writes)

    lines = [
        "#### Global index finalisation",
        "",
        f"- Status: `{global_finalisation.get('status', 'unknown')}`",
        f"- Affected days: {len(affected_days)} ({_markdown_value_list(affected_days)})",
        f"- Index finalisation: `{index_finalisation.get('status', 'unknown')}`",
    ]

    if hierarchy:
        lines.extend(
            [
                f"- Observations hierarchy: `{hierarchy.get('status', 'unknown')}`",
                f"- Affected months: {_markdown_value_list(hierarchy.get('affected_months'))}",
                f"- Affected years: {_markdown_value_list(hierarchy.get('affected_years'))}",
                f"- Hierarchy manifests written: {wrote_object_count}",
            ]
        )

    error_value = global_finalisation.get("error") or hierarchy.get("error") or hierarchy.get("reason")
    if error_value:
        lines.append(f"- Error: `{str(error_value).replace(chr(10), ' ')[:500]}`")

    manifest_rows = [row for row in writes if isinstance(row, dict) and row.get("key")]
    if manifest_rows:
        lines.extend(["- Hierarchy manifest objects:"])
        for row in manifest_rows:
            details = [str(row.get("action", "write"))]
            if "verified" in row:
                details.append("verified" if row.get("verified") else "not verified")
            lines.append(f"  - `{row['key']}` ({', '.join(details)})")

    return lines


def _insert_finalisation_markdown(markdown: str, block: list[str]) -> str:
    if not block or "#### Global index finalisation" in markdown:
        return markdown

    lines = markdown.splitlines()
    try:
        final_verification_index = lines.index("### Final verification")
    except ValueError:
        suffix = "\n" if markdown.endswith("\n") else ""
        return f"{markdown.rstrip()}\n\n" + "\n".join(block) + suffix

    insert_at = len(lines)
    for index in range(final_verification_index + 1, len(lines)):
        if lines[index].startswith("### "):
            insert_at = index
            break

    updated_lines = lines[:insert_at] + [""] + block + [""] + lines[insert_at:]
    rendered = "\n".join(updated_lines)
    if markdown.endswith("\n"):
        rendered += "\n"
    return rendered


def _log_global_index_finalisation(result: dict[str, Any]) -> None:
    result_identity = id(result)
    if result_identity in _GLOBAL_FINALISATION_LOGGED_RESULT_IDS:
        return

    global_finalisation = _v2_global_index_finalisation(result)
    if global_finalisation is None:
        return

    hierarchy = global_finalisation.get("observations_manifest_hierarchy")
    if not isinstance(hierarchy, dict):
        hierarchy = {}
    execution = hierarchy.get("execution")
    if not isinstance(execution, dict):
        execution = {}
    writes = execution.get("writes")
    if not isinstance(writes, list):
        writes = []
    wrote_object_count = execution.get("wrote_object_count")
    if not isinstance(wrote_object_count, int):
        wrote_object_count = len(writes)

    affected_days = global_finalisation.get("affected_days_utc")
    affected_day_count = len(affected_days) if isinstance(affected_days, list) else 0
    index_finalisation = global_finalisation.get("index_finalization")
    index_status = (
        index_finalisation.get("status", "unknown")
        if isinstance(index_finalisation, dict)
        else "unknown"
    )

    message = (
        "global index finalisation status=%s affected_days=%d "
        "index_status=%s hierarchy_status=%s hierarchy_writes=%d"
    )
    values: list[Any] = [
        global_finalisation.get("status", "unknown"),
        affected_day_count,
        index_status,
        hierarchy.get("status", "not_reported"),
        wrote_object_count,
    ]

    error_value = global_finalisation.get("error") or hierarchy.get("error") or hierarchy.get("reason")
    if error_value:
        message += " error=%s"
        values.append(str(error_value).replace("\n", " ")[:500])

    logging.getLogger("uk-aq-history-integrity").info(message, *values)
    _GLOBAL_FINALISATION_LOGGED_RESULT_IDS.add(result_identity)


def format_summary_md(result: dict[str, Any], *args: Any, **kwargs: Any) -> str:
    """Add global finalisation evidence to the established Markdown summary."""
    rendered = _ORIGINAL_FORMAT_SUMMARY_MD(result, *args, **kwargs)
    block = _render_global_index_finalisation_md(result)
    if block:
        _log_global_index_finalisation(result)
        return _insert_finalisation_markdown(rendered, block)
    return rendered


if _PUBLIC_MODULE_NAME == "__main__":
    _wrapper_sys.exit(main(_wrapper_sys.argv[1:]))
