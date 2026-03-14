import test from "node:test";
import assert from "node:assert/strict";
import {
  buildIndexManifestRelativePath,
  buildIndexManifestTargets,
  planIndexManifestCopy,
} from "../scripts/backup_r2/sync_history_to_dropbox.mjs";

test("buildIndexManifestRelativePath normalizes the configured prefix", () => {
  assert.equal(
    buildIndexManifestRelativePath("observations", "/history/_index/"),
    "history/_index/observations_latest.json",
  );
  assert.equal(
    buildIndexManifestRelativePath("aqilevels", "history/_index"),
    "history/_index/aqilevels_latest.json",
  );
});

test("buildIndexManifestTargets keeps only indexed domains and de-dupes them", () => {
  assert.deepEqual(
    buildIndexManifestTargets(
      ["observations", "core", "aqilevels", "observations"],
      "history/_index",
    ),
    [
      {
        domain: "observations",
        relative_path: "history/_index/observations_latest.json",
      },
      {
        domain: "aqilevels",
        relative_path: "history/_index/aqilevels_latest.json",
      },
    ],
  );
});

test("planIndexManifestCopy reports missing source cleanly", () => {
  assert.deepEqual(
    planIndexManifestCopy({ sourceText: "", destText: "" }),
    {
      status: "missing_source",
      copy_required: false,
      source_hash: null,
      dest_hash: null,
    },
  );
});

test("planIndexManifestCopy skips unchanged destination files", () => {
  const plan = planIndexManifestCopy({
    sourceText: '{"ok":true}\n',
    destText: '{"ok":true}\n',
  });

  assert.equal(plan.status, "existing");
  assert.equal(plan.copy_required, false);
  assert.equal(plan.source_hash, plan.dest_hash);
});

test("planIndexManifestCopy requires copy when destination differs", () => {
  const plan = planIndexManifestCopy({
    sourceText: '{"domain":"observations"}\n',
    destText: '{"domain":"aqilevels"}\n',
  });

  assert.equal(plan.status, "copy_required");
  assert.equal(plan.copy_required, true);
  assert.notEqual(plan.source_hash, plan.dest_hash);
});
