#!/usr/bin/env node
// Selected only by the protected coordinator. Never an APPLY/write command.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { r2GetObjectBounded, hasRequiredR2Config } from "../../workers/shared/r2_sigv4.mjs";
import { resolveR2HistoryIndexConfig } from "../../workers/shared/uk_aq_r2_history_index.mjs";
import { INTEGRITY_CHANNEL_ENV, integrityOriginalOperationForApply } from "../operations/lib/uk_aq_integrity_original_operation.mjs";
import { SCHEMA2_DIAGNOSTIC_V1, consumeDiagnosticJson, writeDiagnosticJson,
  prepareSchema2Diagnostic, runSchema2Diagnostic, diagnosticFlags } from "./lib/schema2_diagnostic.mjs";

export function parseSchema2DiagnosticArgs(argv) {
  if (!["--prepare-only", "--admit-only"].includes(argv[0]) || argv.length !== 9 ||
      argv[1] !== "--handoff-json" || argv[3] !== "--sha256" || argv[5] !== "--bytes" || argv[7] !== "--result-json" ||
      !path.isAbsolute(argv[2]) || !path.isAbsolute(argv[8]) || !/^[a-f0-9]{64}$/.test(argv[4]) || !/^[1-9][0-9]*$/.test(argv[6])) {
    throw new Error("Only exact prepare-only/admit-only diagnostic arguments are accepted; no write mode");
  }
  return { mode: argv[0], handoffPath: argv[2], resultPath: argv[8], sha256: argv[4], byte_size: Number(argv[6]) };
}
function persistResult(filename, result) {
  const parent = path.dirname(filename);
  // Report output is small, private and atomic, including failure/cancellation.
  let current = path.parse(parent).root;
  for (const part of parent.slice(current.length).split(path.sep)) {
    current = path.join(current, part); const st = fs.lstatSync(current);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("unsafe diagnostic report directory");
  }
  const temporary = `${path.basename(filename)}.partial-${process.pid}`;
  writeDiagnosticJson(parent, temporary, result);
  fs.renameSync(path.join(parent, temporary), filename);
}
export async function schema2DiagnosticMain({ argv = process.argv.slice(2), env = process.env, r2 = null } = {}) {
  const args = parseSchema2DiagnosticArgs(argv), runRoot = path.dirname(args.handoffPath);
  if (env.UK_AQ_ENV_NAME !== "TEST") throw new Error("schema2 diagnostic is TEST-only");
  if (args.mode === "--prepare-only" && env[INTEGRITY_CHANNEL_ENV]) throw new Error("preparation must not receive the assertion descriptor");
  let result = { contract_version: SCHEMA2_DIAGNOSTIC_V1, status: "diagnostic_interrupted", ...diagnosticFlags(),
    run_id: String(env.UK_AQ_OBSERVATIONS_GLOBAL_OPERATION_LOCK_RUN_ID || "").slice(0, 256),
    original_session_continuity_lost: null, original_session_continuity: "unconfirmed" };
  const cancelled = signal => {
    if (result.status !== "diagnostic_blocked") result = { ...result, status: "diagnostic_cancelled", reason_code: signal,
      reason: "Protected diagnostic cancelled; no continuation or repair completion", original_session_continuity_lost: null,
      original_session_continuity: "lost_or_uncertain" };
    try { persistResult(args.resultPath, result); } finally { process.exit(2); }
  };
  const onTerm = () => cancelled("SIGTERM"), onInt = () => cancelled("SIGINT");
  process.once("SIGTERM", onTerm); process.once("SIGINT", onInt);
  try {
    // Admission must have the genuine original capability before opening local
    // preparation inputs; a standalone/copied-context command cannot read R2.
    if (args.mode === "--admit-only" && !integrityOriginalOperationForApply({ env })) throw new Error("original diagnostic channel missing");
    const input = consumeDiagnosticJson(runRoot, { key: path.basename(args.handoffPath), byte_size: args.byte_size, sha256: args.sha256 });
    if (args.mode === "--prepare-only") {
      const handoff = await prepareSchema2Diagnostic({ seed: input, runRoot, env });
      const pin = writeDiagnosticJson(runRoot, "prepared-request.json", handoff);
      result = { ...result, status: "diagnostic_prepared_only", handoff: pin,
        preparation_fingerprint: handoff.request.runState.schema2_preparation.fingerprint };
    } else {
      const config = r2 || resolveR2HistoryIndexConfig(env).r2;
      if (!hasRequiredR2Config(config)) throw new Error("complete existing R2 read configuration required");
      // Expose only the bounded read primitive to admission. No mutation method
      // exists on this adapter, even when ordinary credentials can write.
      const readOnly = { adapter: { getObjectBounded: options => r2GetObjectBounded({ r2: config, ...options }) } };
      result = await runSchema2Diagnostic({ handoff: input, r2: readOnly, env });
    }
    persistResult(args.resultPath, result);
    return 0;
  } catch (error) {
    result = { ...result, status: "diagnostic_blocked", reason_code: String(error.code || "diagnostic_admission_failed").slice(0, 100),
      reason: String(error.message || "Diagnostic failed").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 512),
      original_session_continuity_lost: error.code === "UK_AQ_INTEGRITY_ORIGINAL_OPERATION_LOST" ? true : null,
      original_session_continuity: "lost_or_uncertain" };
    persistResult(args.resultPath, result);
    // Do not gracefully complete uncertain admission. Closing this endpoint
    // permanently cancels the existing protected chain through Stage 2J.
    if (args.mode === "--admit-only") integrityOriginalOperationForApply({ env })?.close();
    return 2;
  } finally { process.off("SIGTERM", onTerm); process.off("SIGINT", onInt); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  schema2DiagnosticMain().then(code => { process.exitCode = code; }).catch(() => { process.exitCode = 2; });
}
