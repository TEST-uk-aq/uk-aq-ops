import assert from "node:assert/strict";
import test from "node:test";

import {
  deduplicateCanonicalManifestDeclarations,
} from "../workers/uk_aq_backfill_local/r2_history/canonical_manifest_declarations.mjs";

const CONNECTOR_KEY = "history/v2/observations/day_utc=2026-07-12/connector_id=1/manifest.json";
const CHILD_KEY = "history/v2/observations/day_utc=2026-07-12/connector_id=1/pollutant_code=c2h6/manifest.json";

function declaration({ key = CHILD_KEY, code = "c2h6" } = {}) {
  return {
    manifest_key: key,
    pollutant_code: code,
    row_count: 24,
  };
}

test("same child repeated in both parent arrays is one declaration", () => {
  const child = declaration();
  const result = deduplicateCanonicalManifestDeclarations({
    pollutant_manifests: [child],
    child_manifests: [{ ...child }],
  }, { connectorKey: CONNECTOR_KEY });

  assert.equal(result.duplicate_count, 1);
  assert.equal(result.parent.pollutant_manifests.length, 1);
  assert.deepEqual(result.parent.pollutant_manifests[0], child);
  assert.deepEqual(result.parent.child_manifests, []);
});

test("same manifest key with conflicting pollutant identity remains blocked", () => {
  assert.throws(
    () => deduplicateCanonicalManifestDeclarations({
      pollutant_manifests: [declaration()],
      child_manifests: [declaration({ code: "pm10" })],
    }, { connectorKey: CONNECTOR_KEY }),
    /conflicting pollutant identities/,
  );
});

test("same pollutant on different keys is preserved for downstream conflict detection", () => {
  const result = deduplicateCanonicalManifestDeclarations({
    pollutant_manifests: [declaration()],
    child_manifests: [declaration({ key: CHILD_KEY.replace("c2h6", "c2h6_duplicate") })],
  }, { connectorKey: CONNECTOR_KEY });

  assert.equal(result.duplicate_count, 0);
  assert.equal(result.parent.pollutant_manifests.length, 1);
  assert.equal(result.parent.child_manifests.length, 1);
});
