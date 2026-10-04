#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env

import * as path from "node:path";

function usage(): never {
  throw new Error("usage: observation_verification_sos_source.ts <source-input.json> <acquisition-root>");
}

const [inputPath, acquisitionRoot] = Deno.args;
if (!inputPath || !acquisitionRoot) usage();
const input = JSON.parse(await Deno.readTextFile(inputPath));
if (input.source !== "sos" || Number(input.connector_id) !== 1) {
  throw new Error("SOS source descriptor identity is invalid");
}

Deno.env.set("UK_AQ_BACKFILL_SOS_SITE_REF_BRIDGE_FILE", String(input.bridge_file));
Deno.env.set("UK_AQ_BACKFILL_SOS_SOURCE_LABEL_REGISTRY_FILE", String(input.registry_file));

const [{
  buildDedicatedSosSourceAcquisition,
  parseUkAirFlatFileStructure,
}, {
  assertSosAcquisitionBindingsComplete,
  normalizeAurnVerificationStatus,
}] = await Promise.all([
  import("../../../workers/uk_aq_backfill_local/run_job.ts"),
  import("./observation_verification_refresh.mjs"),
]);

const vocabulary = new Set<string>();
function readAndAdmitSource(sourceFile: string): string {
  const csvText = Deno.readTextFileSync(sourceFile);
  const structure = parseUkAirFlatFileStructure(csvText);
  for (const entry of structure.entries) {
    if (entry.is_header || entry.observed_at === null) continue;
    for (let valueIndex = 2; valueIndex < entry.cells.length; valueIndex += 3) {
      const value = Number(String(entry.cells[valueIndex] || "").trim());
      if (!Number.isFinite(value)) continue;
      const rawStatus = String(entry.cells[valueIndex + 1] || "").trim();
      vocabulary.add(rawStatus || "(blank)");
      normalizeAurnVerificationStatus(rawStatus);
    }
  }
  return csvText;
}

const runId = path.basename(path.resolve(acquisitionRoot));
const acquisition = await buildDedicatedSosSourceAcquisition({
  root: acquisitionRoot,
  runId,
  requestedDays: input.requested_days,
  requestedPollutants: input.requested_pollutants,
  sourceRoot: input.source_root,
  sourceReader: readAndAdmitSource,
  propertyMappings: input.property_mappings,
});
assertSosAcquisitionBindingsComplete(acquisition);

const byTimeseries = new Map<number, {
  connector_id: 1;
  timeseries_id: number;
  station_id: number;
  pollutant_code: string;
  site_ref: string;
  evidence: Array<{ observed_at_utc: string; status: "P" | "R" }>;
}>();
const evidenceIdentity = new Map<string, string>();
if (!Array.isArray(acquisition.partition_files)) {
  throw new Error("dedicated SOS acquisition returned no partition inventory");
}
for (const partition of acquisition.partition_files as Array<Record<string, unknown>>) {
  const payload = JSON.parse(await Deno.readTextFile(String(partition.path)));
  for (const sourceFileResult of payload.source_file_results || []) {
    if (Number(sourceFileResult.parsed?.missing_binding_rows || 0) > 0) {
      throw new Error(
        `SOS source partition has non-null rows without an authoritative binding: ${String(partition.path)}`,
      );
    }
    for (const row of sourceFileResult.parsed?.rows || []) {
      const timeseriesId = Number(row.timeseries_id);
      const stationId = Number(row.station_id);
      const pollutantCode = String(row.pollutant_code || "").trim().toLowerCase();
      const siteRef = String(sourceFileResult.site_ref || "").trim().toUpperCase();
      if (!Number.isSafeInteger(timeseriesId) || timeseriesId <= 0 ||
          !Number.isSafeInteger(stationId) || stationId <= 0 || !pollutantCode || !siteRef) {
        throw new Error("SOS canonical source row has an invalid authoritative binding");
      }
      const status = normalizeAurnVerificationStatus(row.status);
      const observedAtUtc = new Date(String(row.observed_at)).toISOString();
      const identity = `${timeseriesId}\u0000${observedAtUtc}`;
      const priorStatus = evidenceIdentity.get(identity);
      if (priorStatus && priorStatus !== status) {
        throw new Error(`SOS source evidence contradicts at ${identity}`);
      }
      evidenceIdentity.set(identity, status);
      let target = byTimeseries.get(timeseriesId);
      if (!target) {
        target = {
          connector_id: 1,
          timeseries_id: timeseriesId,
          station_id: stationId,
          pollutant_code: pollutantCode,
          site_ref: siteRef,
          evidence: [],
        };
        byTimeseries.set(timeseriesId, target);
      } else if (
        target.station_id !== stationId || target.pollutant_code !== pollutantCode ||
        target.site_ref !== siteRef
      ) {
        throw new Error(`SOS timeseries ${timeseriesId} resolves to multiple source identities`);
      }
      if (!priorStatus) target.evidence.push({ observed_at_utc: observedAtUtc, status });
    }
  }
}

const timeseries = Array.from(byTimeseries.values())
  .map((entry) => ({
    ...entry,
    evidence: entry.evidence.sort((left, right) =>
      left.observed_at_utc.localeCompare(right.observed_at_utc)
    ),
  }))
  .sort((left, right) => left.timeseries_id - right.timeseries_id);

console.log(JSON.stringify({
  timeseries,
  acquisition_audit: {
    dedicated_source_acquisition: acquisition,
    admitted_raw_status_vocabulary: Array.from(vocabulary).sort(),
  },
}));
