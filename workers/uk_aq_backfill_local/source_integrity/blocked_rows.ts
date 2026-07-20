import type {
  IntegritySourceAdapterBlockedRowReconciliation,
  IntegritySourceAdapterBlockedRowReconciliationInput,
} from "./types.ts";

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

  return {
    selected: raw,
    outOfScope: 0,
    ambiguous: 0,
    blocking: raw,
  };
}
