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
} from "../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs";
import {
  finalizeR2HistoryV2ObservationsManifestHierarchy,
} from "../workers/shared/uk_aq_r2_observations_manifest_hierarchy_finalizer.mjs";

const PREFIX = "history/v2/observations";

function dayReference(dayUtc, character) {
  return {
    day_utc: dayUtc,
    manifest_key: `${PREFIX}/day_utc=${dayUtc}/manifest.json`,
    manifest_hash: character.repeat(64),
  };
}

function createFixture() {
  const objects = new Map();
  const writes = [];
  const adapter = {
    async listAllCommonPrefixes({ prefix }) {
      const values = new Set();
      for (const key of objects.keys()) {
        if (!key.startsWith(prefix)) continue;
        const remainder = key.slice(prefix.length);
        const segment = remainder.split("/", 1)[0];
        if (segment) values.add(`${prefix}${segment}/`);
      }
      return [...values].sort();
    },
    async getObject({ key }) {
      if (!objects.has(key)) {
        throw new Error(`R2 GET failed (404) key=${key}: NoSuchKey`);
      }
      const body = objects.get(key);
      return { key, body, bytes: body.byteLength, etag: null };
    },
    async putObject({ key, body }) {
      const bytes = Buffer.from(body);
      objects.set(key, bytes);
      writes.push(key);
      return { key, bytes: bytes.byteLength, etag: null };
    },
  };
  return {
    r2: { bucket: "uk-aq-history-cic-test" },
    adapter,
    objects,
    writes,
  };
}

function storeJson(objects, key, payload) {
  objects.set(key, Buffer.from(JSON.stringify(payload), "utf8"));
}

function seedCompleteHierarchy(fixture) {
  const days = [
    dayReference("2025-12-31", "a"),
    dayReference("2026-01-15", "b"),
    dayReference("2026-01-16", "c"),
    dayReference("2026-02-01", "d"),
  ];
  for (const day of days) {
    storeJson(fixture.objects, day.manifest_key, {
      domain: "observations",
      manifest_kind: "day",
      ...day,
    });
  }

  const december = buildR2HistoryV2ObservationsMonthManifest({
    basePrefix: PREFIX,
    year: "2025",
    month: "12",
    dayManifests: days.filter((day) => day.day_utc.startsWith("2025-12")),
  });
  const january = buildR2HistoryV2ObservationsMonthManifest({
    basePrefix: PREFIX,
    year: "2026",
    month: "01",
    dayManifests: days.filter((day) => day.day_utc.startsWith("2026-01")),
  });
  const february = buildR2HistoryV2ObservationsMonthManifest({
    basePrefix: PREFIX,
    year: "2026",
    month: "02",
    dayManifests: days.filter((day) => day.day_utc.startsWith("2026-02")),
  });
  const year2025 = buildR2HistoryV2ObservationsYearManifest({
    basePrefix: PREFIX,
    year: "2025",
    monthManifests: [december],
  });
  const year2026 = buildR2HistoryV2ObservationsYearManifest({
    basePrefix: PREFIX,
    year: "2026",
    monthManifests: [january, february],
  });
  const root = buildR2HistoryV2ObservationsRootManifest({
    basePrefix: PREFIX,
    yearManifests: [year2025, year2026],
  });

  const aggregates = [
    [buildR2HistoryV2ObservationsMonthManifestKey(PREFIX, "2025", "12"), december],
    [buildR2HistoryV2ObservationsMonthManifestKey(PREFIX, "2026", "01"), january],
    [buildR2HistoryV2ObservationsMonthManifestKey(PREFIX, "2026", "02"), february],
    [buildR2HistoryV2ObservationsYearManifestKey(PREFIX, "2025"), year2025],
    [buildR2HistoryV2ObservationsYearManifestKey(PREFIX, "2026"), year2026],
    [buildR2HistoryV2ObservationsRootManifestKey(PREFIX), root],
  ];
  for (const [key, manifest] of aggregates) {
    fixture.objects.set(
      key,
      serializeR2HistoryV2ObservationsAggregateManifest(manifest, { basePrefix: PREFIX }),
    );
  }
}

test("targeted finaliser rewrites one affected branch bottom-up and becomes stable", async () => {
  const fixture = createFixture();
  seedCompleteHierarchy(fixture);
  const changedDay = dayReference("2026-01-15", "e");
  storeJson(fixture.objects, changedDay.manifest_key, {
    domain: "observations",
    manifest_kind: "day",
    ...changedDay,
  });

  const first = await finalizeR2HistoryV2ObservationsManifestHierarchy({
    r2: fixture.r2,
    observationsPrefix: PREFIX,
    affectedDaysUtc: ["2026-01-15", "2026-01-15"],
    adapters: fixture.adapter,
  });

  assert.equal(first.status, "written");
  assert.deepEqual(first.affected_days_utc, ["2026-01-15"]);
  assert.deepEqual(first.affected_months, ["2026-01"]);
  assert.deepEqual(first.affected_years, ["2026"]);
  assert.deepEqual(fixture.writes, [
    buildR2HistoryV2ObservationsMonthManifestKey(PREFIX, "2026", "01"),
    buildR2HistoryV2ObservationsYearManifestKey(PREFIX, "2026"),
    buildR2HistoryV2ObservationsRootManifestKey(PREFIX),
  ]);
  assert.equal(first.planning.update, 3);
  assert.equal(first.execution.wrote_object_count, 3);

  fixture.writes.length = 0;
  const repeated = await finalizeR2HistoryV2ObservationsManifestHierarchy({
    r2: fixture.r2,
    observationsPrefix: PREFIX,
    affectedDaysUtc: ["2026-01-15"],
    adapters: fixture.adapter,
  });
  assert.equal(repeated.status, "up_to_date");
  assert.equal(repeated.planning.unchanged, 3);
  assert.equal(repeated.execution.wrote_object_count, 0);
  assert.deepEqual(fixture.writes, []);
});

test("targeted finaliser fails closed when an affected day prefix has no day manifest", async () => {
  const fixture = createFixture();
  seedCompleteHierarchy(fixture);
  const key = `${PREFIX}/day_utc=2026-01-15/manifest.json`;
  fixture.objects.delete(key);
  fixture.objects.set(
    `${PREFIX}/day_utc=2026-01-15/connector_id=1/part-00000.parquet`,
    Buffer.from("fixture"),
  );

  await assert.rejects(
    finalizeR2HistoryV2ObservationsManifestHierarchy({
      r2: fixture.r2,
      observationsPrefix: PREFIX,
      affectedDaysUtc: ["2026-01-15"],
      adapters: fixture.adapter,
    }),
    /R2 GET failed \(404\).*day_utc=2026-01-15\/manifest\.json/,
  );
});
