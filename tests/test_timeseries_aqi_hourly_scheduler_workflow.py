import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/uk_aq_timeseries_aqi_hourly_cloud_run_deploy.yml"


class TimeseriesAqiHourlySchedulerWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.workflow = WORKFLOW.read_text(encoding="utf-8")

    def test_per_trigger_attempt_deadline_configuration(self) -> None:
        expected = {
            "SYNC_HOURLY_SCHEDULER_ATTEMPT_DEADLINE":
                "GCP_TIMESERIES_AQI_HOURLY_ATTEMPT_DEADLINE",
            "RECONCILE_SHORT_SCHEDULER_ATTEMPT_DEADLINE":
                "GCP_TIMESERIES_AQI_HOURLY_RECONCILE_SHORT_ATTEMPT_DEADLINE",
            "RECONCILE_DEEP_SCHEDULER_ATTEMPT_DEADLINE":
                "GCP_TIMESERIES_AQI_HOURLY_RECONCILE_DEEP_ATTEMPT_DEADLINE",
            "RECONCILE_DEEP_ROLLING_SCHEDULER_ATTEMPT_DEADLINE":
                "GCP_TIMESERIES_AQI_HOURLY_RECONCILE_DEEP_ROLLING_ATTEMPT_DEADLINE",
        }
        for env_name, github_var in expected.items():
            self.assertIn(f"{env_name}:", self.workflow)
            self.assertIn(github_var, self.workflow)

        rolling_line = next(
            line for line in self.workflow.splitlines()
            if line.strip().startswith(
                "RECONCILE_DEEP_ROLLING_SCHEDULER_ATTEMPT_DEADLINE:"
            )
        )
        self.assertIn("'600s'", rolling_line)

    def test_attempt_deadline_flag_is_optional_for_create_and_update(self) -> None:
        self.assertIn('local attempt_deadline="${4:-}"', self.workflow)
        self.assertIn('if [ -n "${attempt_deadline}" ]; then', self.workflow)
        self.assertIn(
            'deadline_args=(--attempt-deadline "${attempt_deadline}")',
            self.workflow,
        )
        self.assertEqual(self.workflow.count('"${deadline_args[@]}"'), 2)
        self.assertNotIn('--attempt-deadline ""', self.workflow)

    def test_no_global_mandatory_deadline_and_legacy_deep_stays_paused(self) -> None:
        global_deadline = re.compile(
            r"^\s+SCHEDULER_ATTEMPT_DEADLINE:",
            flags=re.MULTILINE,
        )
        self.assertIsNone(global_deadline.search(self.workflow))
        self.assertIn(
            'maybe_pause "${RECONCILE_DEEP_SCHEDULER_JOB_NAME}"',
            self.workflow,
        )
        self.assertNotIn(
            'ensure_or_pause_job "${RECONCILE_DEEP_SCHEDULER_ENABLED}"',
            self.workflow,
        )


if __name__ == "__main__":
    unittest.main()
