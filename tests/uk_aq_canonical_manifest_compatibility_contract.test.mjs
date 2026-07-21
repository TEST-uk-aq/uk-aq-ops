import assert from "node:assert/strict";
import test from "node:test";

import {
  validateV2ObservationsChildManifest,
} from "../scripts/backup_r2/lib/uk_aq_v2_observations_manifest_validation.mjs";

const DAY = "2026-07-12";
const KEY = "history/v2/observations/day_utc=2026-07-12/connector_id=7/pollutant_code=pm10/manifest.json";

function earlyCanonicalManifest() {
  const payload = {
    manifest_schema_version: 2,
    history_schema_version: 2,
    history_version: "v2",
    domain: "observations",
    manifest_kind: "pollutant",
    manifest_key: KEY,
    day_utc: DAY,
    connector_id: 7,
    pollutant_code: "pm10",
    source_row_count: 24,
    row_count: 24,
    file_count: 1,
    total_bytes: 100,
    pollutant_codes: ["pm10"],
    parquet_object_keys: [KEY.replace("manifest.json", "part-00000.parquet")],
    files: [],
    child_manifests: [],
    columns: [],
    timeseries_row_counts: undefined,
    backed_up_at_utc: "2026-07-17T14:07:48Z",
  };
  return payload;
}

test("early canonical child exposes only the supported compatibility fields", () => {
  const result = validateV2ObservationsChildManifest(earlyCanonicalManifest(), {
    key: KEY,
    kind: "pollutant",
    dayUtc: DAY,
    connectorId: 7,
  });
  assert.deepEqual(
    result.failures.filter((value) => value !== "manifest_hash_missing"),
    [
      "grain_not_explicit_null",
      "profile_not_explicit_null",
      "timeseries_row_counts_not_object_or_null",
    ],
  );
});
