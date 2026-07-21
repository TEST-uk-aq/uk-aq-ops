#!/usr/bin/env python3
"""UK-AQ History Integrity entrypoint with durable progress checkpoints.

The full implementation remains byte-identical in the sibling
``uk-aq-history-integrity_impl.py`` file. It is executed in this module's
namespace so the established command path, imports, monkeypatches and public
symbols continue to behave as before.
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


if _PUBLIC_MODULE_NAME == "__main__":
    _wrapper_sys.exit(main(_wrapper_sys.argv[1:]))
