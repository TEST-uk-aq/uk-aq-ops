import assert from "node:assert/strict";
import test from "node:test";

import {
  buildR2HistoryV2ObservationsMonthManifest,
  buildR2HistoryV2ObservationsMonthManifestKey,
  buildR2HistoryV2ObservationsRootManifest,
  buildR2HistoryV2ObservationsRootManifestKey,
  buildR2HistoryV2ObservationsYearManifest,
  buildR2HistoryV2ObservationsYearManifestKey,
  serializeR2HistoryV2ObservationsAggregateManifest,
  validateR2HistoryV2ObservationsAggregateManifest,
} from "../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs";

const PREFIX = "history/v2/observations";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function day(dayUtc, manifestHash) {
  return {
    day_utc: dayUtc,
    manifest_key: `${PREFIX}/day_utc=${dayUtc}/manifest.json`,
    manifest_hash: manifestHash,
  };
}

test("observation aggregate manifests are byte-stable and propagate one changed day hash", () => {
  assert.equal(
    buildR2HistoryV2ObservationsRootManifestKey(PREFIX),
    `${PREFIX}/_manifests/manifest.json`,
  );
  assert.equal(
    buildR2HistoryV2ObservationsYearManifestKey(PREFIX, 2026),
    `${PREFIX}/_manifests/year=2026/manifest.json`,
  );
  assert.equal(
    buildR2HistoryV2ObservationsMonthManifestKey(PREFIX, 2026, 7),
    `${PREFIX}/_manifests/year=2026/month=07/manifest.json`,
  );

  const julyUnordered = buildR2HistoryV2ObservationsMonthManifest({
    basePrefix: PREFIX,
    year: 2026,
    month: 7,
    dayManifests: [day("2026-07-15", HASH_B), day("2026-07-14", HASH_A)],
  });
  const julyOrdered = buildR2HistoryV2ObservationsMonthManifest({
    basePrefix: PREFIX,
    year: 2026,
    month: "07",
    dayManifests: [day("2026-07-14", HASH_A), day("2026-07-15", HASH_B)],
  });

  assert.deepEqual(julyUnordered, julyOrdered);
  assert.deepEqual(
    serializeR2HistoryV2ObservationsAggregateManifest(julyUnordered),
    serializeR2HistoryV2ObservationsAggregateManifest(julyOrdered),
  );
  assert.deepEqual(
    validateR2HistoryV2ObservationsAggregateManifest(julyOrdered),
    julyOrdered,
  );

  const yearBefore = buildR2HistoryV2ObservationsYearManifest({
    basePrefix: PREFIX,
    year: 2026,
    monthManifests: [julyOrdered],
  });
  const rootBefore = buildR2HistoryV2ObservationsRootManifest({
    basePrefix: PREFIX,
    yearManifests: [yearBefore],
  });

  const julyChanged = buildR2HistoryV2ObservationsMonthManifest({
    basePrefix: PREFIX,
    year: 2026,
    month: 7,
    dayManifests: [day("2026-07-14", HASH_C), day("2026-07-15", HASH_B)],
  });
  const yearAfter = buildR2HistoryV2ObservationsYearManifest({
    basePrefix: PREFIX,
    year: 2026,
    monthManifests: [julyChanged],
  });
  const rootAfter = buildR2HistoryV2ObservationsRootManifest({
    basePrefix: PREFIX,
    yearManifests: [yearAfter],
  });

  assert.notEqual(julyChanged.content_hash, julyOrdered.content_hash);
  assert.notEqual(yearAfter.content_hash, yearBefore.content_hash);
  assert.notEqual(rootAfter.content_hash, rootBefore.content_hash);
});
