import { resolveHistoryWriteVersionFromEnv } from "./run_job.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(
      `assertEquals failed: actual=${JSON.stringify(actual)} expected=${
        JSON.stringify(expected)
      }`,
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

const BASE_FIXED_V3_ENV: Record<string, string> = {
  UK_AQ_R2_HISTORY_VERSION: "v3",
  UK_AQ_INTEGRITY_INVOCATION: "true",
  UK_AQ_BACKFILL_OUTPUT_SCOPE: "observations_only",
  UK_AQ_BACKFILL_INTEGRITY_PROPOSAL_MODE: "prepare",
  UK_AQ_BACKFILL_REBUILD_R2_HISTORY_INDEX: "false",
  UK_AQ_INTEGRITY_CANONICAL_WRITES_ALLOWED: "false",
};

function resolveWith(overrides: Record<string, string | undefined>): string {
  const values: Record<string, string | undefined> = {
    ...BASE_FIXED_V3_ENV,
    ...overrides,
  };
  return resolveHistoryWriteVersionFromEnv((name) => values[name]);
}

const unsupportedV3 = /Unsupported UK_AQ_R2_HISTORY_VERSION=v3 invocation/;

for (
  const effectiveMode of [
    "check_only",
    "repair_dry_run",
    "repair_apply",
  ]
) {
  Deno.test(`source evidence worker is admitted in ${effectiveMode}`, () => {
    assertEquals(
      resolveWith({
        UK_AQ_INTEGRITY_EFFECTIVE_MODE: effectiveMode,
        UK_AQ_INTEGRITY_WORKER_PURPOSE: "source_evidence_only",
        UK_AQ_BACKFILL_INTEGRITY_SOURCE_EVIDENCE_ONLY: "true",
      }),
      "v3",
    );
  });

  Deno.test(`source evidence worker cannot write canonically in ${effectiveMode}`, () => {
    assertThrows(() =>
      resolveWith({
        UK_AQ_INTEGRITY_EFFECTIVE_MODE: effectiveMode,
        UK_AQ_INTEGRITY_WORKER_PURPOSE: "source_evidence_only",
        UK_AQ_BACKFILL_INTEGRITY_SOURCE_EVIDENCE_ONLY: "true",
        UK_AQ_INTEGRITY_CANONICAL_WRITES_ALLOWED: "true",
      }), unsupportedV3);
  });
}

for (const effectiveMode of ["repair_dry_run", "repair_apply"]) {
  Deno.test(`repair proposal worker is admitted in ${effectiveMode}`, () => {
    assertEquals(
      resolveWith({
        UK_AQ_INTEGRITY_EFFECTIVE_MODE: effectiveMode,
        UK_AQ_INTEGRITY_WORKER_PURPOSE: "repair_proposal",
        UK_AQ_BACKFILL_INTEGRITY_SOURCE_EVIDENCE_ONLY: "false",
      }),
      "v3",
    );
  });
}

Deno.test("repair proposal worker remains rejected in check_only", () => {
  assertThrows(() =>
    resolveWith({
      UK_AQ_INTEGRITY_EFFECTIVE_MODE: "check_only",
      UK_AQ_INTEGRITY_WORKER_PURPOSE: "repair_proposal",
      UK_AQ_BACKFILL_INTEGRITY_SOURCE_EVIDENCE_ONLY: "false",
    }), unsupportedV3);
});

Deno.test("source evidence purpose requires evidence-only execution", () => {
  assertThrows(() =>
    resolveWith({
      UK_AQ_INTEGRITY_EFFECTIVE_MODE: "repair_apply",
      UK_AQ_INTEGRITY_WORKER_PURPOSE: "source_evidence_only",
      UK_AQ_BACKFILL_INTEGRITY_SOURCE_EVIDENCE_ONLY: "false",
    }), unsupportedV3);
});

Deno.test("generic or manual v3 remains rejected", () => {
  assertThrows(() =>
    resolveWith({
      UK_AQ_INTEGRITY_INVOCATION: "false",
      UK_AQ_INTEGRITY_EFFECTIVE_MODE: "repair_apply",
      UK_AQ_INTEGRITY_WORKER_PURPOSE: "source_evidence_only",
      UK_AQ_BACKFILL_INTEGRITY_SOURCE_EVIDENCE_ONLY: "true",
    }), unsupportedV3);
});

Deno.test("fixed-v3 direct canonical source mutation remains rejected", () => {
  assertThrows(() =>
    resolveWith({
      UK_AQ_INTEGRITY_EFFECTIVE_MODE: "repair_apply",
      UK_AQ_INTEGRITY_WORKER_PURPOSE: "source_repair",
      UK_AQ_BACKFILL_INTEGRITY_SOURCE_EVIDENCE_ONLY: "false",
      UK_AQ_INTEGRITY_CANONICAL_WRITES_ALLOWED: "true",
    }), unsupportedV3);
});

Deno.test("fixed-v3 generic full-index rebuild remains rejected", () => {
  assertThrows(() =>
    resolveWith({
      UK_AQ_INTEGRITY_EFFECTIVE_MODE: "repair_apply",
      UK_AQ_INTEGRITY_WORKER_PURPOSE: "repair_proposal",
      UK_AQ_BACKFILL_INTEGRITY_SOURCE_EVIDENCE_ONLY: "false",
      UK_AQ_BACKFILL_REBUILD_R2_HISTORY_INDEX: "true",
    }), unsupportedV3);
});
