import assert from "node:assert/strict";
import test from "node:test";

import {
  isExpectedMissingAqilevelsIndex,
  normaliseOptionalAqilevelsCountsPayload,
} from "../workers/uk_aq_db_size_metrics_api_worker/optional_aqilevels.mjs";

const AQILEVELS_KEY = "history/_index_v2/aqilevels_hourly_data_timeseries_latest.json";
const OBSERVATIONS_KEY = "history/_index_v2/observations_timeseries_latest.json";

function missingKeyMessage(key) {
  return `R2 GET failed (404) key=${key}: <?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>`;
}

test("missing AQI-level index is treated as an optional domain", () => {
  const error = missingKeyMessage(AQILEVELS_KEY);
  const payload = {
    source: "cloudflare_r2_history_index_unavailable",
    error,
    warnings: [
      `aqilevels index unavailable for R2_v2: ${error}`,
      "unrelated diagnostic",
    ],
    index_keys: {
      observations: OBSERVATIONS_KEY,
      aqilevels: AQILEVELS_KEY,
    },
    domains: {
      observations: {
        day_count: 2,
        total_rows: 200,
      },
      aqilevels: {
        day_count: 0,
        total_rows: 0,
      },
    },
    connectors: [
      {
        connector_id: 1,
        observations_total_rows: 200,
        aqilevels_total_rows: 0,
        total_rows: 200,
      },
    ],
  };

  assert.equal(isExpectedMissingAqilevelsIndex(payload), true);
  const result = normaliseOptionalAqilevelsCountsPayload(payload);

  assert.notStrictEqual(result, payload);
  assert.equal(result.error, null);
  assert.equal(result.source, "cloudflare_r2_history_index_partial");
  assert.deepEqual(result.warnings, ["unrelated diagnostic"]);
  assert.deepEqual(result.connectors, payload.connectors);
  assert.equal(result.domains.aqilevels.available, false);
  assert.equal(result.domains.aqilevels.index_missing, true);
  assert.equal(result.domains.aqilevels.day_count, 0);
});

test("non-404 AQI-level failures remain errors", () => {
  const payload = {
    error: `R2 GET failed (500) key=${AQILEVELS_KEY}: upstream error`,
    index_keys: {
      observations: OBSERVATIONS_KEY,
      aqilevels: AQILEVELS_KEY,
    },
  };

  assert.equal(isExpectedMissingAqilevelsIndex(payload), false);
  assert.strictEqual(normaliseOptionalAqilevelsCountsPayload(payload), payload);
});

test("missing observations index remains an error", () => {
  const payload = {
    error: missingKeyMessage(OBSERVATIONS_KEY),
    index_keys: {
      observations: OBSERVATIONS_KEY,
      aqilevels: AQILEVELS_KEY,
    },
  };

  assert.equal(isExpectedMissingAqilevelsIndex(payload), false);
  assert.strictEqual(normaliseOptionalAqilevelsCountsPayload(payload), payload);
});
