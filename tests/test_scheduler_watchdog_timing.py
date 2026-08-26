from __future__ import annotations

import importlib.util
from pathlib import Path
from types import SimpleNamespace
from typing import Callable
import unittest
from unittest import mock


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "scripts"
    / "mbpro_scheduler_watchdog"
    / "uk_aq_scheduler_watchdog.py"
)
SPEC = importlib.util.spec_from_file_location(
    "uk_aq_scheduler_watchdog_timing_test_module",
    MODULE_PATH,
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Unable to load scheduler watchdog module")
WATCHDOG_MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WATCHDOG_MODULE)


class ScriptedStopEvent:
    def __init__(self, clock: SimpleNamespace, wake_times: list[float | None]) -> None:
        self.clock = clock
        self.wake_times = list(wake_times)
        self.waits: list[float] = []

    def is_set(self) -> bool:
        return False

    def wait(self, timeout: float) -> bool:
        self.waits.append(timeout)
        wake_time = self.wake_times.pop(0)
        if wake_time is None:
            return True
        self.clock.now = wake_time
        return False


class SchedulerWatchdogTimingTest(unittest.TestCase):
    minute_epoch = 1_800_000_000
    offset_seconds = 50

    def run_scripted_loop(
        self,
        *,
        initial_time: float,
        wake_times: list[float | None],
        after_request: Callable[[SimpleNamespace], None] | None = None,
    ) -> tuple[list[str], list[float], object]:
        clock = SimpleNamespace(now=initial_time)
        stop_event = ScriptedStopEvent(clock, wake_times)
        watchdog = WATCHDOG_MODULE.SchedulerWatchdog.__new__(
            WATCHDOG_MODULE.SchedulerWatchdog
        )
        watchdog.logger = mock.Mock()
        watchdog.environment = "TEST"
        watchdog.offset_seconds = self.offset_seconds
        watchdog.timeout_seconds = 900
        watchdog.max_in_flight = 4
        watchdog.cron_outage_threshold_minutes = 5
        watchdog.cron_health = SimpleNamespace(settings={})
        watchdog.stop_event = stop_event
        watchdog.last_dispatched_minute_epoch = None
        dispatched: list[str] = []

        def request_minute(minute_slot: str) -> None:
            dispatched.append(minute_slot)
            if callable(after_request):
                after_request(clock)

        watchdog.request_minute = request_minute
        watchdog.shutdown = mock.Mock()
        with (
            mock.patch.object(WATCHDOG_MODULE, "log_event"),
            mock.patch.object(WATCHDOG_MODULE.time, "time", side_effect=lambda: clock.now),
        ):
            watchdog.run_forever()
        return dispatched, stop_event.waits, watchdog

    def test_fractionally_early_wake_does_not_dispatch_same_minute_twice(self) -> None:
        dispatched, waits, watchdog = self.run_scripted_loop(
            initial_time=self.minute_epoch + 49,
            wake_times=[self.minute_epoch + 49.9998, None],
        )

        self.assertEqual(
            dispatched,
            [WATCHDOG_MODULE.minute_slot_text(self.minute_epoch)],
        )
        self.assertEqual(watchdog.last_dispatched_minute_epoch, self.minute_epoch)
        self.assertAlmostEqual(waits[1], 60.0002, places=4)
        watchdog.shutdown.assert_called_once_with(wait=False)

    def test_normal_wake_dispatches_once(self) -> None:
        dispatched, waits, _watchdog = self.run_scripted_loop(
            initial_time=self.minute_epoch + 49,
            wake_times=[self.minute_epoch + 50.0001, None],
        )

        self.assertEqual(len(dispatched), 1)
        self.assertGreater(waits[1], 59.9)

    def test_forward_jump_does_not_backfill_missed_minutes(self) -> None:
        dispatched, waits, _watchdog = self.run_scripted_loop(
            initial_time=self.minute_epoch + 49,
            wake_times=[self.minute_epoch + 620, None],
        )

        self.assertEqual(len(dispatched), 1)
        self.assertAlmostEqual(waits[1], 30.0)

    def test_backward_adjustment_does_not_redispatch_previous_minute(self) -> None:
        def move_clock_backward(clock: SimpleNamespace) -> None:
            clock.now = self.minute_epoch - 5

        dispatched, waits, _watchdog = self.run_scripted_loop(
            initial_time=self.minute_epoch + 49,
            wake_times=[self.minute_epoch + 50.0001, None],
            after_request=move_clock_backward,
        )

        self.assertEqual(len(dispatched), 1)
        self.assertAlmostEqual(waits[1], 115.0)


if __name__ == "__main__":
    unittest.main()
