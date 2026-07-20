export type IntegritySourceAdapterBlockedRowReconciliationInput = {
  raw: unknown;
  scoped: boolean;
};

export type IntegritySourceAdapterBlockedRowReconciliation = {
  selected: number;
  outOfScope: number;
  ambiguous: number;
  blocking: number;
};
