import fs from "node:fs";

import {
  evaluateLatestCurrentValue,
} from "../../../../../workers/uk_aq_latest_snapshot_cloud_run/latest_value_policy.mjs";

const payload = JSON.parse(fs.readFileSync(0, "utf8"));
if (!Array.isArray(payload)) {
  throw new Error("Latest Snapshot eligibility input must be an array.");
}

const decisions = payload.map((row) => evaluateLatestCurrentValue({
  matrixPollutant: row?.pollutant_code,
  value: row?.value,
}));

process.stdout.write(JSON.stringify(decisions));
