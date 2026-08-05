import assert from "node:assert/strict";
import test from "node:test";

import {
  executeObservationsManifestHierarchy,
} from "../scripts/backup_r2/uk_aq_observations_manifest_hierarchy.mjs";

const PREFIX = "history/v2/observations";
const TEST_BUCKET = "uk-aq-history-cic-test";

function dayPayload(dayUtc, hashCharacter) {
  const key = `${PREFIX}/day_utc=${dayUtc}/manifest.json`;
  return {
    day_utc: dayUtc,
    manifest_key: key,
    manifest_kind: "day",
    domain: "observations",
    manifest_hash: hashCharacter.repeat(64),
  };
}

function createR2Fixture(dayPayloads) {
  const objects = new Map();
  const writes = [];
  for (const payload of dayPayloads) {
    objects.set(payload.manifest_key, Buffer.from(JSON.stringify(payload), "utf8"));
  }
  const adapter = {
    async listAllCommonPrefixes({ prefix }) {
      const prefixes = new Set();
      for (const key of objects.keys()) {
        if (!key.startsWith(prefix)) continue;
        const remainder = key.slice(prefix.length);
        const first = remainder.split("/", 1)[0];
        if (first) prefixes.add(`${prefix}${first}/`);
      }
      return [...prefixes].sort();
    },
    async listAllObjects({ prefix }) {
      return [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, body]) => ({ key, size: body.byteLength, etag: null }));
    },
    async getObject({ key }) {
      if (!objects.has(key)) {
        throw new Error(`R2 GET failed (404) key=${key}: missing fixture object`);
      }
      const body = objects.get(key);
      return { key, bytes: body.byteLength, body, etag: null };
    },
    async putObject({ key, body }) {
      const buffer = Buffer.from(body);
      objects.set(key, buffer);
      writes.push(key);
      return { key, bytes: buffer.byteLength, etag: null };
    },
  };
  return {
    r2: { bucket: TEST_BUCKET, adapter },
    objects,
    writes,
  };
}

test("hierarchy command plans no writes, writes bottom-up, and becomes byte-stable", async () => {
  const fixture = createR2Fixture([
    dayPayload("2026-07-31", "a"),
    dayPayload("2026-08-01", "b"),
  ]);

  const dryRun = await executeObservationsManifestHierarchy({
    r2: fixture.r2,
    observationsPrefix: PREFIX,
    mode: "dry-run",
  });
  assert.equal(dryRun.status, "changes_planned");
  assert.equal(dryRun.planning.create, 4);
  assert.equal(dryRun.execution.wrote_object_count, 0);
  assert.deepEqual(fixture.writes, []);

  const written = await executeObservationsManifestHierarchy({
    r2: fixture.r2,
    observationsPrefix: PREFIX,
    mode: "write-r2",
  });
  assert.equal(written.status, "written");
  assert.deepEqual(fixture.writes, [
    `${PREFIX}/_manifests/year=2026/month=07/manifest.json`,
    `${PREFIX}/_manifests/year=2026/month=08/manifest.json`,
    `${PREFIX}/_manifests/year=2026/manifest.json`,
    `${PREFIX}/_manifests/manifest.json`,
  ]);

  fixture.writes.length = 0;
  const unchanged = await executeObservationsManifestHierarchy({
    r2: fixture.r2,
    observationsPrefix: PREFIX,
    mode: "dry-run",
  });
  assert.equal(unchanged.status, "up_to_date");
  assert.equal(unchanged.planning.unchanged, 4);
  assert.deepEqual(fixture.writes, []);

  const changedDay = dayPayload("2026-07-31", "c");
  fixture.objects.set(changedDay.manifest_key, Buffer.from(JSON.stringify(changedDay), "utf8"));
  const changed = await executeObservationsManifestHierarchy({
    r2: fixture.r2,
    observationsPrefix: PREFIX,
    mode: "dry-run",
  });
  assert.equal(changed.planning.update, 3);
  assert.equal(changed.planning.unchanged, 1);
  assert.equal(changed.execution.wrote_object_count, 0);
});
