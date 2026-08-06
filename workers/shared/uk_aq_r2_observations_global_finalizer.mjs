import {
  runCanonicalGlobalIndexFinalizer,
} from "./uk_aq_r2_history_writer.mjs";
import {
  finalizeR2HistoryV2ObservationsManifestHierarchy,
} from "./uk_aq_r2_observations_manifest_hierarchy_finalizer.mjs";

const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function normalizeDayUtc(raw) {
  const day = String(raw || "").trim();
  const parsed = new Date(`${day}T00:00:00.000Z`);
  if (!ISO_DAY_PATTERN.test(day)
    || Number.isNaN(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== day) {
    throw new Error(`Invalid observations global finaliser affected day: ${String(raw || "")}`);
  }
  return day;
}

function normalizeAffectedDays(values) {
  if (!Array.isArray(values)) {
    throw new Error("Observations global finaliser affectedDaysUtc must be an array");
  }
  return [...new Set(values.map(normalizeDayUtc))].sort();
}

function objectFields(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

export async function runCanonicalObservationsGlobalFinalizer({
  client,
  diagnosticEnvironment,
  diagnostics,
  timeoutMs,
  r2,
  observationsPrefix,
  affectedDaysUtc,
  maxKeys = 1000,
  writeR2 = true,
  finalizeExistingIndexes,
  runCanonicalGlobalIndexFinalizerAdapter = runCanonicalGlobalIndexFinalizer,
  hierarchyFinalizerAdapter = finalizeR2HistoryV2ObservationsManifestHierarchy,
}) {
  if (typeof finalizeExistingIndexes !== "function") {
    throw new Error("Observations global finaliser requires finalizeExistingIndexes");
  }
  if (!r2 || typeof r2 !== "object") {
    throw new Error("Observations global finaliser requires R2 configuration");
  }
  if (typeof runCanonicalGlobalIndexFinalizerAdapter !== "function") {
    throw new Error("Observations global finaliser lock adapter is invalid");
  }
  if (typeof hierarchyFinalizerAdapter !== "function") {
    throw new Error("Observations global finaliser hierarchy adapter is invalid");
  }

  const days = normalizeAffectedDays(affectedDaysUtc);
  if (days.length === 0) {
    return {
      ok: true,
      status: "skipped",
      reason: "no_affected_days",
      affected_days_utc: [],
      index_finalization: null,
      observations_manifest_hierarchy: {
        ok: true,
        status: "skipped",
        reason: "no_affected_days",
        affected_days_utc: [],
        affected_months: [],
        affected_years: [],
        objects: [],
        execution: { wrote_object_count: 0, writes: [] },
      },
    };
  }

  return await runCanonicalGlobalIndexFinalizerAdapter({
    client,
    diagnosticEnvironment,
    diagnostics,
    timeoutMs,
    finalize: async () => {
      const indexFinalization = await finalizeExistingIndexes();
      const hierarchyFinalization = await hierarchyFinalizerAdapter({
        r2,
        observationsPrefix,
        affectedDaysUtc: days,
        maxKeys,
        writeR2,
      });
      const existingFields = objectFields(indexFinalization);
      const combined = {
        ...existingFields,
        affected_days_utc: days,
        index_finalization: indexFinalization ?? null,
        observations_manifest_hierarchy: hierarchyFinalization,
      };
      if (!Object.hasOwn(combined, "ok")) combined.ok = true;
      if (!Object.hasOwn(combined, "status")) combined.status = "succeeded";
      return combined;
    },
  });
}
