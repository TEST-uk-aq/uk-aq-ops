#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import {
  canonicalObservationConnectorManifestKey,
  normalizeConnectorDayPair,
  setConnectorDayGateComplete,
  setConnectorDayGateIncomplete,
  withConnectorDayGateClient,
} from "../../workers/shared/uk_aq_connector_day_gate.mjs";
import {
  resolvePhaseBRuntimeConfig,
  verifyObservationConnectorHistory,
} from "../../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";

const TEST_BUCKET = "uk-aq-history-cic-test";

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || !Array.isArray(parsed.connector_days)) {
    throw new Error("stdin must contain connector_days");
  }
  return parsed;
}

export async function completeIntegrityConnectorDayGates({ payload, runtime, databaseUrl }) {
  const connectorDays = payload.connector_days.map((entry) =>
    normalizeConnectorDayPair(entry?.day_utc, entry?.connector_id)
  );
  const results = [];
  await withConnectorDayGateClient(databaseUrl, async (client) => {
    for (const pair of connectorDays) {
      try {
        const manifestKey = canonicalObservationConnectorManifestKey(
          pair.day_utc,
          pair.connector_id,
        );
        const evidence = await verifyObservationConnectorHistory({
          runtime,
          dayUtc: pair.day_utc,
          connectorId: pair.connector_id,
          manifestKey,
        });
        await setConnectorDayGateComplete(client, {
          ...pair,
          history_run_id: payload.history_run_id,
          history_manifest_key: evidence.history_manifest_key,
          history_manifest_hash: evidence.history_manifest_hash,
          history_row_count: evidence.history_row_count,
          history_file_count: evidence.history_file_count,
          history_total_bytes: evidence.history_total_bytes,
          completion_source: "history_integrity",
        });
        const { connector_manifest: _connectorManifest, ...gateEvidence } = evidence;
        results.push({ ...pair, status: "complete", ...gateEvidence });
      } catch (error) {
        await setConnectorDayGateIncomplete(client, pair);
        results.push({
          ...pair,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });
  const failed = results.filter((entry) => entry.status !== "complete");
  return {
    status: failed.length === 0 ? "succeeded" : "failed",
    connector_day_count: results.length,
    completed_connector_day_count: results.length - failed.length,
    failed_connector_day_count: failed.length,
    results,
  };
}

async function main() {
  if (String(process.env.UK_AQ_ENV_NAME || "").trim() !== "CIC-Test") {
    throw new Error("Refusing Integrity connector-day gate completion outside CIC-Test");
  }
  const payload = await readStdinJson();
  const runtime = resolvePhaseBRuntimeConfig(process.env);
  if (runtime.r2.bucket !== TEST_BUCKET) {
    throw new Error(`Refusing Integrity connector-day gate completion for non-TEST bucket: ${runtime.r2.bucket || "(unset)"}`);
  }
  const result = await completeIntegrityConnectorDayGates({
    payload,
    runtime,
    databaseUrl: process.env.SUPABASE_DB_URL || process.env.DATABASE_URL,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== "succeeded") process.exitCode = 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
