/** Preparation v1 is local evidence and can never enter an executable graph. */
const PREPARATION_CONTRACT = "uk_aq_integrity_v3_schema2_preparation_v1";

function rejectPreparation() {
  const error = new Error("schema2_preparation_not_executable: preparation-only state cannot authorise APPLY");
  error.classification = "schema2_preparation_not_executable";
  error.r2_mutation_possible = false;
  throw error;
}

export function requireNoSchema2PreparationExecution(runState) {
  if (!runState || typeof runState !== "object") return;
  if (Object.hasOwn(runState, "schema2_preparation")
      || Object.hasOwn(runState, "preparation_contract_version")
      || runState.contract_version === PREPARATION_CONTRACT
      || runState.state === "prepared_only") rejectPreparation();
  const pending = [runState.objects, runState.planning];
  const seen = new Set();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (Object.hasOwn(value, "schema2_preparation")
        || Object.hasOwn(value, "preparation_contract_version")
        || value.contract_version === PREPARATION_CONTRACT
        || value.state === "prepared_only") rejectPreparation();
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") pending.push(child);
    }
  }
}
