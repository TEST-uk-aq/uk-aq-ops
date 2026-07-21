import type {
  IntegritySourceAdapterBlockedRowReconciliation,
  IntegritySourceAdapterBlockedRowReconciliationInput,
} from "./types.ts";

function envValue(name: string): string {
  return (Deno.env.get(name) || "").trim();
}

function envBoolean(name: string): boolean {
  switch (envValue(name).toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "y":
    case "on":
      return true;
    default:
      return false;
  }
}

/**
 * The specialist wrapper loads the repository .env after the Integrity
 * coordinator has supplied its run-specific phase flags. Repository defaults
 * can therefore replace prepare/finalize before run_job.ts evaluates its
 * complete connector-day guard.
 *
 * Source-evidence-only is an explicit coordinator-owned phase. It exits before
 * proposal publication or R2 mutation, but it still needs the complete-day
 * prepare/finalize guard shape so that the worker can enumerate and write its
 * local immutable detector evidence. Restore that narrow phase here without
 * weakening normal complete connector-day calls.
 */
export function normaliseIntegritySourceEvidencePhase(): void {
  if (
    !envBoolean("UK_AQ_BACKFILL_INTEGRITY_SOURCE_EVIDENCE_ONLY") ||
    !envBoolean("UK_AQ_BACKFILL_INTEGRITY_COMPLETE_CONNECTOR_DAY")
  ) {
    return;
  }

  if (envValue("UK_AQ_BACKFILL_INTEGRITY_PROPOSAL_MODE").toLowerCase() !== "prepare") {
    Deno.env.set("UK_AQ_BACKFILL_INTEGRITY_PROPOSAL_MODE", "prepare");
  }
  if (!envBoolean("UK_AQ_BACKFILL_INTEGRITY_PROPOSAL_FINALIZE")) {
    Deno.env.set("UK_AQ_BACKFILL_INTEGRITY_PROPOSAL_FINALIZE", "true");
  }
}

/**
 * UK-AIR annual CSVs can contain valid source rows for site/pollutant groups
 * which do not yet have a canonical SOS timeseries mapping. For a complete SOS
 * historical connector-day repair, retain those rows in the evidence counters
 * and samples but do not let them block mapped observations from being repaired.
 *
 * Missing files, ambiguous configured mappings, duplicate canonical identities
 * and invalid canonical rows are checked elsewhere and remain fail-closed.
 */
export function isSosHistoricalCompleteConnectorDay(): boolean {
  if (!envBoolean("UK_AQ_BACKFILL_INTEGRITY_COMPLETE_CONNECTOR_DAY")) {
    return false;
  }
  if (!envValue("UK_AQ_BACKFILL_SOS_FLAT_FILE_ROOT")) {
    return false;
  }

  const connectorIds = envValue("UK_AQ_BACKFILL_CONNECTOR_IDS").replace(/\s+/g, "");
  const sosConnectorId = envValue("UK_AQ_BACKFILL_SOS_CONNECTOR_ID_FALLBACK") || "1";
  return /^\d+$/.test(sosConnectorId) && connectorIds === sosConnectorId;
}

normaliseIntegritySourceEvidencePhase();

export function reconcileIntegritySourceAdapterBlockedRows(
  args: IntegritySourceAdapterBlockedRowReconciliationInput,
): IntegritySourceAdapterBlockedRowReconciliation {
  const raw = Number(args.raw || 0);

  if (args.scoped) {
    return {
      selected: 0,
      outOfScope: raw,
      ambiguous: 0,
      blocking: 0,
    };
  }

  if (isSosHistoricalCompleteConnectorDay()) {
    return {
      selected: raw,
      outOfScope: 0,
      ambiguous: 0,
      blocking: 0,
    };
  }

  return {
    selected: raw,
    outOfScope: 0,
    ambiguous: 0,
    blocking: raw,
  };
}
