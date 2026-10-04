#!/usr/bin/env node
// @ts-nocheck -- operator CLI; build-only unless --publish is explicit.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  buildObservationVerificationRefreshInputs,
  encodeObservationVerificationJson,
  loadObservationVerificationAuthority,
  loadObservationVerificationDiscovery,
  verificationPeriodsFromObservationEvidence,
  verificationPeriodsFromRatifiedTo,
} from "../../workers/shared/uk_aq_observation_verification_overlay.mjs";
import {
  buildObservationVerificationConnectorPublication,
} from "../../workers/shared/uk_aq_observation_verification_publication.mjs";
import {
  hasRequiredR2Config,
  r2GetObject,
} from "../../workers/shared/r2_sigv4.mjs";
import {
  withHistoryWriterClient,
  withObservationsGlobalOperationLock,
} from "../../workers/shared/uk_aq_r2_history_writer.mjs";
import {
  assertPublishEnvironment,
  buildVerificationPublicationPlan,
  compareObservationVerificationCandidates,
  executeVerificationPublication,
  sourceConnectorId,
} from "./lib/observation_verification_refresh.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const options = { environment: "TEST", publish: false, source: "", fromDay: "", toDay: "", stateDir: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--publish") options.publish = true;
    else if (["--source", "--env", "--from-day", "--to-day", "--state-dir"].includes(token)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
      index += 1;
      if (token === "--source") options.source = value.toLowerCase();
      if (token === "--env") options.environment = value.toUpperCase();
      if (token === "--from-day") options.fromDay = value;
      if (token === "--to-day") options.toDay = value;
      if (token === "--state-dir") options.stateDir = value;
    } else if (token === "--help") {
      console.log("Usage: uk_aq_refresh_observation_verification.mjs --source sos|waqn|saqn --env TEST|LIVE [--from-day YYYY-MM-DD --to-day YYYY-MM-DD] [--publish]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${token}`);
  }
  sourceConnectorId(options.source);
  assertPublishEnvironment({ environment: options.environment, publish: options.publish });
  if (options.source === "sos" && (!options.fromDay || !options.toDay)) {
    throw new Error("--source sos requires --from-day and --to-day for its diagnostic retained-range build");
  }
  return options;
}

function r2Config() {
  return {
    endpoint: String(process.env.CFLARE_R2_ENDPOINT || process.env.R2_ENDPOINT || "").trim(),
    bucket: String(process.env.CFLARE_R2_BUCKET || process.env.R2_BUCKET || "").trim(),
    region: String(process.env.CFLARE_R2_REGION || process.env.R2_REGION || "auto").trim() || "auto",
    access_key_id: String(process.env.CFLARE_R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID || "").trim(),
    secret_access_key: String(process.env.CFLARE_R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY || "").trim(),
  };
}

function utcRunId(source) {
  return `${new Date().toISOString().replace(/[-:]/g, "").replace(".", "")}-${source}`;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

function runJson(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: path.resolve(SCRIPT_DIR, "../.."),
    env: process.env,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.status}): ${String(result.stderr || result.stdout).trim().slice(0, 4000)}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label} did not return JSON`, { cause: error });
  }
}

function acquireSource(options, runDir) {
  const sourceInputPath = path.join(runDir, "source-input.json");
  const python = process.env.UK_AQ_HISTORY_INTEGRITY_PYTHON || "python3";
  const args = [
    path.join(SCRIPT_DIR, "lib/observation_verification_source.py"),
    "--source", options.source,
    "--env", options.environment,
    "--run-dir", runDir,
  ];
  if (options.fromDay) args.push("--from-day", options.fromDay);
  if (options.toDay) args.push("--to-day", options.toDay);
  const source = runJson(python, args, `${options.source} source acquisition`);
  writeJson(sourceInputPath, source);
  if (options.source !== "sos") return source;
  const acquisitionRoot = path.join(runDir, "sos-source-acquisition");
  const parsed = runJson(
    process.env.DENO_BIN || "deno",
    [
      "run", "--quiet", "--allow-read", "--allow-write", "--allow-env",
      path.join(SCRIPT_DIR, "lib/observation_verification_sos_source.ts"),
      sourceInputPath,
      acquisitionRoot,
    ],
    "SOS canonical source parsing",
  );
  return {
    ...source,
    timeseries: parsed.timeseries,
    acquisition_audit: {
      ...source.acquisition_audit,
      ...parsed.acquisition_audit,
    },
  };
}

function buildTimeseries(source) {
  if (source.source === "sos") {
    return source.timeseries.map((entry) => ({
      connector_id: 1,
      timeseries_id: entry.timeseries_id,
      station_id: entry.station_id,
      pollutant_code: entry.pollutant_code,
      ...verificationPeriodsFromObservationEvidence(entry.evidence, {
        semanticSourceProvenance: {
          source_system: "uk-air-annual-csv",
          site_ref: entry.site_ref,
          pollutant_code: entry.pollutant_code,
          verification_model: "per-observation-status-v1",
        },
      }),
    }));
  }
  return source.timeseries.map((entry) => ({
    connector_id: source.connector_id,
    timeseries_id: entry.timeseries_id,
    station_id: entry.station_id,
    pollutant_code: entry.pollutant_code,
    ...verificationPeriodsFromRatifiedTo(entry.ratified_to, {
      semanticSourceProvenance: {
        source_system: "official-network-rdata",
        network: source.source,
        site_id: entry.site_id,
        parameter: entry.parameter,
        verification_model: "ratification-boundary-v1",
      },
    }),
  }));
}

function makeBucket(r2) {
  return {
    async get(key) {
      try {
        return await r2GetObject({ r2, key });
      } catch (error) {
        if (Number(error?.status) === 404) return null;
        throw error;
      }
    },
  };
}

async function readCurrentAuthority(r2, connectorId) {
  if (!hasRequiredR2Config(r2)) {
    return {
      status: "unavailable",
      reason: "complete R2 read configuration is unavailable",
      latest: null,
      target: null,
      authenticated: [],
    };
  }
  const bucket = makeBucket(r2);
  const discovery = await loadObservationVerificationDiscovery({ bucket });
  if (!discovery.latest_present) {
    return { status: "pre_overlay", reason: null, latest: null, target: null, authenticated: [] };
  }
  const authorities = [];
  for (const identity of discovery.latest.connectors) {
    authorities.push(await loadObservationVerificationAuthority({
      bucket,
      connectorId: identity.connector_id,
      discovery,
    }));
  }
  const target = authorities.find((authority) => authority.connector_id === connectorId) || null;
  return {
    status: "authenticated",
    reason: null,
    latest: discovery.latest,
    target,
    authenticated: authorities.map((authority) => authority.manifest_identity),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const configuredEnvironment = String(
    process.env.UKAQ_ENV_NAME || process.env.UK_AQ_ENV_NAME || "",
  ).trim().toUpperCase();
  if (!configuredEnvironment) {
    throw new Error("UKAQ_ENV_NAME or UK_AQ_ENV_NAME is required to bind source/configuration resolution to --env");
  }
  if (configuredEnvironment !== options.environment) {
    throw new Error(
      `configured environment ${configuredEnvironment} does not match --env ${options.environment}`,
    );
  }
  const stateRoot = path.resolve(options.stateDir || process.env.UK_AQ_HISTORY_INTEGRITY_STATE_DIR || "");
  if (!options.stateDir && !process.env.UK_AQ_HISTORY_INTEGRITY_STATE_DIR) {
    throw new Error("UK_AQ_HISTORY_INTEGRITY_STATE_DIR or --state-dir is required");
  }
  const runsRoot = path.join(stateRoot, "verification-refresh", "runs");
  fs.mkdirSync(runsRoot, { recursive: true });
  const runDir = path.join(runsRoot, utcRunId(options.source));
  fs.mkdirSync(runDir, { recursive: false });
  const reportPath = path.join(runDir, "run-report.json");
  try {
    const source = acquireSource(options, runDir);
    const refresh = buildObservationVerificationRefreshInputs({
      connectorId: source.connector_id,
      semanticSourceIdentity: source.semantic_source_identity,
      timeseries: buildTimeseries(source),
      acquisitionEvidence: source.acquisition_audit,
    });
    const candidatePublication = await buildObservationVerificationConnectorPublication({
      manifest: refresh.canonical_manifest,
    });
    const manifestPath = path.join(runDir, "candidate-manifest.json");
    fs.writeFileSync(manifestPath, encodeObservationVerificationJson(refresh.canonical_manifest), { flag: "wx" });
    const acquisitionPath = path.join(runDir, "acquisition-audit.json");
    writeJson(acquisitionPath, refresh.acquisition_audit_evidence);
    const candidatePublicationPath = path.join(runDir, "candidate-publication.json");
    writeJson(candidatePublicationPath, {
      artifact: {
        key: candidatePublication.artifact.key,
        byte_size: candidatePublication.artifact.byte_size,
        sha256: candidatePublication.artifact.sha256,
        content_type: candidatePublication.artifact.content_type,
      },
      latest_identity: candidatePublication.latest_identity,
    });

    const r2 = r2Config();
    if (options.publish && options.environment === "TEST" && r2.bucket !== "uk-aq-history-cic-test") {
      throw new Error(`refusing TEST publication for unexpected bucket: ${r2.bucket || "(empty)"}`);
    }
    const current = await readCurrentAuthority(r2, source.connector_id);
    if (options.publish && current.status === "unavailable") {
      throw new Error(`current verification authority is unavailable: ${current.reason}`);
    }
    const publicationReadiness = current.status === "unavailable"
      ? { publishable: false, reason: current.reason }
      : source.coverage_readiness;
    const comparison = compareObservationVerificationCandidates({
      source: options.source,
      currentManifest: current.target?.manifest || null,
      currentManifestIdentity: current.target?.manifest_identity || null,
      candidateManifest: refresh.canonical_manifest,
      candidateManifestIdentity: candidatePublication.latest_identity,
      coverageReadiness: publicationReadiness,
    });
    const comparisonPath = path.join(runDir, "comparison.json");
    writeJson(comparisonPath, { ...comparison, current_authority_status: current.status });

    let plan = {
      publication_intent: false,
      connector: null,
      expected_current_target: null,
      initial_current_latest: null,
    };
    if (comparison.semantic_change && comparison.publishable) {
      plan = await buildVerificationPublicationPlan({
        comparison,
        candidatePublication,
        currentLatest: current.latest,
        authenticatedCurrentConnectorIdentities: current.authenticated,
      });
    } else if (options.publish && comparison.semantic_change) {
      throw new Error(`verification candidate is not publishable: ${comparison.blockers.join("; ")}`);
    }
    const lockDiagnostics = [];
    const publicationLockRunId = randomUUID();
    const withPublicationLock = async (callback) => {
      const databaseUrl = String(
        process.env.SUPABASE_DB_URL || process.env.UK_AQ_INGEST_DATABASE_URL ||
        process.env.DATABASE_URL || "",
      ).trim();
      if (!databaseUrl) {
        throw new Error("TEST publication requires the existing observations global operation lock database URL");
      }
      return withHistoryWriterClient(databaseUrl, async (client) =>
        withObservationsGlobalOperationLock({
          client,
          owner: "observation_verification_publication",
          runId: publicationLockRunId,
          diagnostics: lockDiagnostics,
          diagnosticEnvironment: options.environment,
        }, async (_identity, lock) => callback({
          assertHeld: () => lock.assertHeld(),
        }))
      );
    };
    const publication = await executeVerificationPublication({
      publish: options.publish,
      environment: options.environment,
      plan,
      r2,
      withPublicationLock,
      refreshCurrentAuthority: () => readCurrentAuthority(r2, source.connector_id),
    });
    const report = {
      schema_version: 1,
      status: "complete",
      environment: options.environment,
      source: options.source,
      connector_id: source.connector_id,
      publish_requested: options.publish,
      publication,
      publication_lock_diagnostics: lockDiagnostics,
      pinned_core_identity: source.core_identity,
      timeseries_count: refresh.canonical_manifest.timeseries.length,
      semantic_manifest_sha256: candidatePublication.latest_identity.sha256,
      immutable_candidate_key: candidatePublication.latest_identity.key,
      current_manifest_sha256: current.target?.manifest_identity?.sha256 || null,
      current_authority_status: current.status,
      semantic_change: comparison.semantic_change,
      p_to_r_changes: comparison.effective_p_to_r_timeseries_ids,
      r_to_p_regressions: comparison.effective_r_to_p_timeseries_ids,
      new_timeseries_ids: comparison.new_timeseries_ids,
      removed_timeseries_ids: comparison.removed_timeseries_ids,
      coverage_readiness: source.coverage_readiness,
      publication_readiness: publicationReadiness,
      publishable: comparison.publishable,
      candidate_manifest_path: manifestPath,
      candidate_publication_path: candidatePublicationPath,
      acquisition_audit_path: acquisitionPath,
      comparison_path: comparisonPath,
      run_report_path: reportPath,
    };
    writeJson(reportPath, report);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    writeJson(reportPath, {
      schema_version: 1,
      status: "failed",
      environment: options.environment,
      source: options.source,
      connector_id: sourceConnectorId(options.source),
      publish_requested: options.publish,
      error: error instanceof Error ? error.message : String(error),
      run_report_path: reportPath,
    });
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
