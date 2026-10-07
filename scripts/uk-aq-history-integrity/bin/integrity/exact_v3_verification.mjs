#!/usr/bin/env node
// Read-only verification of one scope in the final local view. Reconstruct
// expected routing from the actual canonical Parquet, using the same inspector
// and exact-leaf builder as the fixed-v3 planner. Never consult remote storage.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { sha256Hex } from "../../../../workers/shared/r2_sigv4.mjs";
import {
  getObservationHistoryGeneration,
} from "../../../../workers/shared/uk_aq_observation_history_generation.mjs";
import {
  buildObservationHistoryExactLeafIndexV3ScopedHierarchy,
  OBSERVATION_HISTORY_EXACT_LEAF_MANIFEST_KIND_V3,
} from "../../../../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs";
import {
  inspectPinnedBaselinePollutantPartition,
} from "../../../backup_r2/uk_aq_plan_sos_light_v3_observation_metadata.mjs";

function fail(gapType, key, reason) {
  throw Object.assign(new Error(reason), { gap_type: gapType, key });
}

function parseObject(object, gapType) {
  try {
    const payload = JSON.parse(object.body.toString("utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("expected a JSON object");
    }
    return payload;
  } catch (error) {
    fail(gapType, object.key, error.message);
  }
}

export async function verifyExactV3Scope({
  root, allowed_real_roots = [], scope, index_prefix, data_prefix, index_key,
}) {
  const generation = getObservationHistoryGeneration("v3");
  // This entrypoint is fixed-v3: a changed/missing kind must never select the
  // legacy timeseries_row_counts check or another generation's roots.
  if (index_prefix !== generation.observations_timeseries_index_prefix ||
      data_prefix !== generation.observations_prefix) {
    fail("index_manifest_schema_mismatch", index_prefix, "expected fixed-v3 roots");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(scope?.day_utc) ||
      !Number.isSafeInteger(scope?.connector_id) || scope.connector_id <= 0 ||
      !["no2", "pm10", "pm25", "o3"].includes(scope?.pollutant_code)) {
    fail("index_manifest_schema_mismatch", index_prefix, "invalid verification scope");
  }
  const suffix = `day_utc=${scope.day_utc}/connector_id=${scope.connector_id}` +
    `/pollutant_code=${scope.pollutant_code}`;
  const indexKey = `${index_prefix}/${suffix}/manifest.json`;
  if (index_key !== indexKey) {
    fail("index_manifest_schema_mismatch", index_key, "non-canonical selected index scope");
  }
  const manifestKey = `${data_prefix}/${suffix}/manifest.json`;
  const trustedRoots = [root, ...allowed_real_roots].map((value) => fs.realpathSync(value));
  const readObject = (key, gapType) => {
    if (typeof key !== "string" || !key.startsWith("history/") ||
        key.split("/").some((part) => !part || part === "." || part === "..")) {
      fail(gapType, key, "non-canonical local object key");
    }
    try {
      const localPath = fs.realpathSync(path.join(root, key));
      if (!trustedRoots.some((trusted) => {
        const relative = path.relative(trusted, localPath);
        return relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative);
      })) throw new Error("object escapes the trusted final-view roots");
      return { key, body: fs.readFileSync(localPath) };
    } catch (error) {
      fail(gapType, key, error.message);
    }
  };
  const actual = parseObject(
    readObject(indexKey, "index_manifest_unreadable"), "index_manifest_invalid_json",
  );
  if (actual.kind !== OBSERVATION_HISTORY_EXACT_LEAF_MANIFEST_KIND_V3) {
    fail("index_manifest_schema_mismatch", indexKey, "expected exact-v3 scoped manifest kind");
  }
  let hierarchy;
  try {
    const manifestObject = readObject(manifestKey, "index_manifest_canonical_evidence_invalid");
    const inspected = await inspectPinnedBaselinePollutantPartition({
      manifest: parseObject(manifestObject, "index_manifest_canonical_evidence_invalid"),
      manifestKey,
      manifestObject,
      scope,
      getPinnedObject: (key) => readObject(key, "index_manifest_canonical_evidence_invalid"),
    });
    hierarchy = buildObservationHistoryExactLeafIndexV3ScopedHierarchy({
      metadata: inspected.target_metadata,
      canonicalManifest: inspected.canonical_manifest,
      indexRoot: index_prefix,
    });
  } catch (error) {
    fail("index_manifest_canonical_evidence_invalid", error.key || manifestKey, error.message);
  }
  const { leaves_by_timeseries_id: membership, ...metadata } = actual;
  const { leaves_by_timeseries_id: expectedMembership, ...expectedMetadata } =
    hierarchy.scoped_manifest.payload;
  if (!isDeepStrictEqual(metadata, expectedMetadata)) {
    fail("index_manifest_schema_mismatch", indexKey,
      "exact-v3 identity, coverage or source descriptor disagrees with canonical Parquet");
  }
  if (!membership || typeof membership !== "object" || Array.isArray(membership) ||
      !isDeepStrictEqual(Object.keys(membership).sort(), Object.keys(expectedMembership).sort())) {
    fail("index_manifest_membership_mismatch", indexKey,
      "exact-v3 membership must equal the non-empty canonical timeseries set");
  }
  for (const expected of hierarchy.exact_leaves) {
    const descriptor = membership[String(expected.payload.timeseries_id)];
    if (!Array.isArray(descriptor) || descriptor.length !== 3 ||
        descriptor[0] !== expected.key ||
        !Number.isSafeInteger(descriptor[1]) || descriptor[1] <= 0 ||
        typeof descriptor[2] !== "string" || !/^[0-9a-f]{64}$/.test(descriptor[2])) {
      fail("index_leaf_descriptor_invalid", indexKey, `invalid descriptor for ${expected.key}`);
    }
    const leaf = readObject(expected.key, "index_leaf_unreadable");
    if (leaf.body.byteLength !== descriptor[1] || sha256Hex(leaf.body) !== descriptor[2]) {
      fail("index_leaf_identity_mismatch", expected.key, "leaf bytes do not match scoped size/SHA-256");
    }
    if (!isDeepStrictEqual(parseObject(leaf, "index_leaf_invalid_json"), expected.payload)) {
      fail("index_leaf_schema_mismatch", expected.key,
        "leaf scope, counts, files or physical segments disagree with canonical Parquet");
    }
  }
  // Aligned JSON is derived and is not guaranteed to be in the backup/view.
  // Its descriptors are checked against reconstruction above; no dependency
  // discovery or fallback outside this selected local scope is permitted.
  return { status: "ok" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await verifyExactV3Scope(JSON.parse(fs.readFileSync(0, "utf8")));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      status: "fail",
      gap_type: error.gap_type || "index_manifest_verification_failed",
      key: error.key || null,
      reason: error.message,
    })}\n`);
    process.exitCode = 1;
  }
}
