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


_ORIGINAL_SINGLE_LINE_PROGRESS = SingleLineProgress
_PROGRESS_COUNTS_RE = re.compile(r"(?:files=)?(?P<completed>\d+)/(?P<total>\d+)")
_PROGRESS_LOG_INTERVAL_SECONDS = 30.0
_PROGRESS_LOG_CHECKPOINTS = 20


class DurableSingleLineProgress:
    """Preserve terminal progress and add durable INFO log checkpoints."""

    def __init__(self, label: str, *args: Any, **kwargs: Any) -> None:
        self._label = str(label)
        self._delegate = _ORIGINAL_SINGLE_LINE_PROGRESS(label, *args, **kwargs)
        self._last_logged_at = 0.0
        self._last_logged_message: str | None = None
        self._next_completed_checkpoint = 0

    @staticmethod
    def _clean_message(message: Any) -> str:
        return " ".join(str(message).replace("\r", " ").replace("\n", " ").split())

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

    def update(self, message: Any, *args: Any, **kwargs: Any) -> Any:
        result = self._delegate.update(message, *args, **kwargs)
        text = self._clean_message(message)
        force = bool(kwargs.get("force", False))
        now = time.monotonic()
        if text and text != self._last_logged_message and self._should_log(text, force=force, now=now):
            logging.getLogger("uk_aq_history_integrity.progress").info(
                "%s: %s",
                self._label,
                text,
            )
            self._last_logged_at = now
            self._last_logged_message = text
        return result

    def finish(self, *args: Any, **kwargs: Any) -> Any:
        return self._delegate.finish(*args, **kwargs)


SingleLineProgress = DurableSingleLineProgress


if _PUBLIC_MODULE_NAME == "__main__":
    _wrapper_sys.exit(main(_wrapper_sys.argv[1:]))
