import test from "node:test";
import assert from "node:assert/strict";

import {
  groupFingerprintRechecksByHour,
} from "../workers/uk_aq_prune_daily/fingerprint_recheck.mjs";

test("fingerprint rechecks are grouped into ordered one-hour windows", () => {
  const firstMismatch = {
    connector_id: "1",
    hour_start: "2026-07-01T22:00:00.000Z",
  };
  const secondConnectorSameHour = {
    connector_id: "7",
    hour_start: "2026-07-01T22:00:00.000Z",
  };
  const earlierMismatch = {
    connector_id: "3",
    hour_start: "2026-07-01T21:00:00.000Z",
  };

  assert.deepEqual(
    groupFingerprintRechecksByHour([
      firstMismatch,
      secondConnectorSameHour,
      earlierMismatch,
    ]),
    [
      {
        window_start: "2026-07-01T21:00:00.000Z",
        window_end: "2026-07-01T22:00:00.000Z",
        mismatches: [earlierMismatch],
      },
      {
        window_start: "2026-07-01T22:00:00.000Z",
        window_end: "2026-07-01T23:00:00.000Z",
        mismatches: [firstMismatch, secondConnectorSameHour],
      },
    ],
  );
});

test("fingerprint recheck grouping rejects an invalid hour", () => {
  assert.throws(
    () => groupFingerprintRechecksByHour([{ connector_id: "1", hour_start: "invalid" }]),
    /Invalid mismatch hour_start/,
  );
});
