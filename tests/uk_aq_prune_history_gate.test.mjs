import assert from "node:assert/strict";
import test from "node:test";
import { isAcceptedPruneHistoryDayManifestKey } from "../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";

test("prune history day manifest gate accepts v1 observation day manifests", () => {
  assert.equal(
    isAcceptedPruneHistoryDayManifestKey("history/v1/observations/day_utc=2026-06-12/manifest.json"),
    true,
  );
});

test("prune history day manifest gate accepts v2 observation day manifests", () => {
  assert.equal(
    isAcceptedPruneHistoryDayManifestKey("history/v2/observations/day_utc=2026-06-12/manifest.json"),
    true,
  );
});

test("prune history day manifest gate rejects missing or empty keys", () => {
  assert.equal(isAcceptedPruneHistoryDayManifestKey(null), false);
  assert.equal(isAcceptedPruneHistoryDayManifestKey(undefined), false);
  assert.equal(isAcceptedPruneHistoryDayManifestKey(""), false);
  assert.equal(isAcceptedPruneHistoryDayManifestKey("   "), false);
});

test("prune history day manifest gate rejects non-day and malformed paths", () => {
  assert.equal(isAcceptedPruneHistoryDayManifestKey("history/v2/observations/manifest.json"), false);
  assert.equal(isAcceptedPruneHistoryDayManifestKey("history/v2/observations/day_utc=2026-6-12/manifest.json"), false);
  assert.equal(isAcceptedPruneHistoryDayManifestKey("history/v2/observations/day_utc=2026-06-12/not-manifest.json"), false);
  assert.equal(isAcceptedPruneHistoryDayManifestKey("history/v3/observations/day_utc=2026-06-12/manifest.json"), false);
});

test("prune history day manifest gate rejects connector and pollutant manifests", () => {
  assert.equal(
    isAcceptedPruneHistoryDayManifestKey("history/v2/observations/day_utc=2026-06-12/connector_id=1/manifest.json"),
    false,
  );
  assert.equal(
    isAcceptedPruneHistoryDayManifestKey("history/v2/observations/day_utc=2026-06-12/connector_id=1/pollutant_code=no2/manifest.json"),
    false,
  );
});
