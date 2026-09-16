import {
  validateIntegrityCoreSnapshotIdentityPayload,
} from "./run_job.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `assertEquals failed: actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
    );
  }
}

function assertThrows(fn: () => unknown, pattern: RegExp): void {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!pattern.test(message)) {
      throw new Error(`Expected ${pattern}, got ${message}`);
    }
    return;
  }
  throw new Error(`Expected ${pattern}, but no error was thrown`);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const selectedGeneration = String(
  Deno.env.get("UK_AQ_R2_HISTORY_VERSION") || "",
).trim();
if (selectedGeneration !== "v2" && selectedGeneration !== "v3") {
  throw new Error("Focused core identity test requires v2 or v3");
}
const configuredV2CorePrefix = String(
  Deno.env.get("UK_AQ_R2_HISTORY_V2_CORE_PREFIX") || "",
).trim().replace(/^\/+|\/+$/g, "");
const expectedCorePrefix = selectedGeneration === "v2"
  ? configuredV2CorePrefix || "history/v2/core"
  : "history/v3/core";
const otherGeneration = selectedGeneration === "v2" ? "v3" : "v2";
const dayUtc = "2026-09-15";
const manifestHash = "a".repeat(64);
const manifestText = JSON.stringify({
  day_utc: dayUtc,
  manifest_hash: manifestHash,
  tables: [],
});
const manifestBody = new TextEncoder().encode(manifestText);
const manifestSha256 = await sha256(manifestText);
const identity = {
  core_snapshot_day_utc: dayUtc,
  core_snapshot_manifest_key:
    `${expectedCorePrefix}/day_utc=${dayUtc}/manifest.json`,
  core_snapshot_manifest_hash: manifestHash,
  core_snapshot_manifest_sha256: manifestSha256,
};

Deno.test(`${selectedGeneration} resolves its expected core prefix`, () => {
  const validated = validateIntegrityCoreSnapshotIdentityPayload({
    coordinatorIdentity: identity,
    recordedIdentity: identity,
    manifestBody,
    stage: "focused_generation_acceptance",
  });
  assertEquals(validated, identity);
  assertEquals(
    validated.core_snapshot_manifest_key,
    `${expectedCorePrefix}/day_utc=${dayUtc}/manifest.json`,
  );
});

Deno.test(`${selectedGeneration} rejects ${otherGeneration} core identity`, () => {
  const crossGeneration = {
    ...identity,
    core_snapshot_manifest_key:
      `history/${otherGeneration}/core/day_utc=${dayUtc}/manifest.json`,
  };
  assertThrows(
    () => validateIntegrityCoreSnapshotIdentityPayload({
      coordinatorIdentity: crossGeneration,
      recordedIdentity: crossGeneration,
      manifestBody,
      stage: "focused_cross_generation_rejection",
    }),
    /integrity_core_snapshot_manifest_key_noncanonical/,
  );
});

Deno.test(`${selectedGeneration} preserves coordinator-child equality`, () => {
  assertThrows(
    () => validateIntegrityCoreSnapshotIdentityPayload({
      coordinatorIdentity: identity,
      recordedIdentity: {
        ...identity,
        core_snapshot_manifest_hash: "b".repeat(64),
      },
      manifestBody,
      stage: "focused_coordinator_child_mismatch",
    }),
    /integrity_core_snapshot_identity_mismatch/,
  );
});

Deno.test(`${selectedGeneration} preserves manifest byte SHA-256 validation`, () => {
  const wrongShaIdentity = {
    ...identity,
    core_snapshot_manifest_sha256: "c".repeat(64),
  };
  assertThrows(
    () => validateIntegrityCoreSnapshotIdentityPayload({
      coordinatorIdentity: wrongShaIdentity,
      recordedIdentity: wrongShaIdentity,
      manifestBody,
      stage: "focused_manifest_sha_mismatch",
    }),
    /integrity_core_snapshot_manifest_byte_identity_mismatch/,
  );
});

Deno.test(`${selectedGeneration} preserves immutable manifest-hash validation`, () => {
  const wrongHashIdentity = {
    ...identity,
    core_snapshot_manifest_hash: "d".repeat(64),
  };
  assertThrows(
    () => validateIntegrityCoreSnapshotIdentityPayload({
      coordinatorIdentity: wrongHashIdentity,
      recordedIdentity: wrongHashIdentity,
      manifestBody,
      stage: "focused_manifest_hash_mismatch",
    }),
    /integrity_core_snapshot_manifest_identity_mismatch/,
  );
});
