#!/usr/bin/env node
// Narrow Phase 3 executor: it repairs only the v2 observations hierarchy.
// It never enumerates parquet writes, AQI paths, or backfill commands.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import {
  hasRequiredR2Config,
  r2GetObject,
  r2HeadObject,
  r2ListAllObjects,
  r2PutObject,
  sha256Hex,
} from "../../workers/shared/r2_sigv4.mjs";
import {
  buildHistoryV2ConnectorManifest,
  buildHistoryV2DayManifest,
} from "../../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";
import {
  resolveR2HistoryIndexConfig,
  updateR2HistoryIndexesTargeted,
} from "../../workers/shared/uk_aq_r2_history_index.mjs";

const TEST_R2_BUCKET = "uk-aq-history-cic-test";
const SUPPORTED_ACTIONS = new Set([
  "observation_pollutant_manifest_repair",
  "observation_connector_manifest_repair",
  "observation_day_manifest_repair",
  "observation_index_repair",
  "rebuild_v2_observations_index_only",
]);

function parseArgs(argv) {
  const args = { repairPlanJson: null, writeR2: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repair-plan-json") args.repairPlanJson = String(argv[++index] || "");
    else if (arg === "--write-r2") args.writeR2 = true;
    else if (arg === "--dry-run") args.writeR2 = false;
    else throw new Error(`Unknown arg: ${arg}`);
  }
  if (!args.repairPlanJson) throw new Error("--repair-plan-json is required");
  return args;
}

function jsonObject(object, key) {
  try {
    return JSON.parse(object.body.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in ${key}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function withoutManifestHash(payload) {
  const { manifest_hash: _ignored, ...rest } = payload;
  return rest;
}

function assertManifest(payload, { key, kind, dayUtc, connectorId = null }) {
  if (!payload || payload.history_version !== "v2" || payload.domain !== "observations"
    || payload.manifest_kind !== kind || payload.manifest_key !== key
    || payload.day_utc !== dayUtc || (connectorId !== null && Number(payload.connector_id) !== connectorId)
    || typeof payload.manifest_hash !== "string"
    || payload.manifest_hash !== sha256Hex(JSON.stringify(withoutManifestHash(payload)))) {
    throw new Error(`Blocked dependency: invalid ${kind} manifest ${key}`);
  }
}

async function readChildren({ r2, prefix, dayUtc, connectorId, kind }) {
  const entries = await r2ListAllObjects({ r2, prefix, max_keys: 1000 });
  const keyPattern = kind === "connector"
    ? /\/connector_id=\d+\/manifest\.json$/
    : /\/pollutant_code=[^/]+\/manifest\.json$/;
  const keys = entries.map((entry) => entry.key).filter((key) => keyPattern.test(key)).sort();
  if (!keys.length) throw new Error(`Blocked dependency: no ${kind} manifests under ${prefix}`);
  const children = [];
  const identities = new Map();
  for (const key of keys) {
    const object = await r2GetObject({ r2, key });
    const payload = jsonObject(object, key);
    assertManifest(payload, { key, kind, dayUtc, connectorId });
    children.push(payload);
    identities.set(key, object.etag || sha256Hex(object.body));
  }
  return { children, identities };
}

async function assertUnchangedChildren({ r2, identities }) {
  for (const [key, identity] of identities) {
    const head = await r2HeadObject({ r2, key });
    if (!head?.exists || (head.etag && head.etag !== identity)) {
      throw new Error(`Blocked dependency: child identity changed before parent write: ${key}`);
    }
  }
}

async function putVerified({ r2, key, payload, writeR2 }) {
  const body = JSON.stringify(payload, null, 2);
  let current = null;
  try { current = await r2GetObject({ r2, key }); } catch (error) {
    if (!String(error).includes("(404)")) throw error;
  }
  if (current?.body.toString("utf8") === body) return { key, status: "skipped_unchanged", verification: "not_run" };
  if (!writeR2) return { key, status: "planned", verification: "not_run" };
  await r2PutObject({ r2, key, body, content_type: "application/json" });
  const fresh = await r2GetObject({ r2, key });
  if (fresh.bytes !== Buffer.byteLength(body, "utf8") || fresh.body.toString("utf8") !== body) {
    throw new Error(`Verification failed for ${key}`);
  }
  const verified = jsonObject(fresh, key);
  if (verified.manifest_hash && verified.manifest_hash !== payload.manifest_hash) {
    throw new Error(`Verification failed for manifest hash ${key}`);
  }
  return { key, status: "succeeded", verification: "succeeded" };
}

function normalizePlan(input) {
  const actions = Array.isArray(input) ? input : input?.repair_plan;
  if (!input || input.history_version !== "v2" || input.domain !== "observations" || !Array.isArray(actions)) {
    throw new Error("Repair input must be { history_version: 'v2', domain: 'observations', repair_plan: [...] }");
  }
  const scopes = new Map();
  for (const action of actions) {
    if (!SUPPORTED_ACTIONS.has(action?.kind) || action?.status !== "planned" || action?.executes === true) {
      throw new Error(`Unsupported Phase 3 repair action: ${String(action?.kind || "unknown")}`);
    }
    const dayUtc = String(action.day_utc || "");
    const connectorId = Number(action.connector_id);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayUtc) || !Number.isInteger(connectorId) || connectorId <= 0) {
      throw new Error("Every repair action must have day_utc and positive connector_id");
    }
    const key = `${dayUtc}|${connectorId}`;
    const scope = scopes.get(key) || { dayUtc, connectorId, needsConnector: false, needsDay: false, needsIndex: false, pollutantRepair: false };
    scope.needsConnector ||= action.kind === "observation_connector_manifest_repair" || action.kind === "observation_pollutant_manifest_repair";
    scope.needsDay ||= scope.needsConnector || action.kind === "observation_day_manifest_repair";
    scope.needsIndex ||= Boolean(action.requires_index_rebuild) || action.kind.includes("index");
    scope.pollutantRepair ||= action.kind === "observation_pollutant_manifest_repair";
    scopes.set(key, scope);
  }
  return [...scopes.values()].sort((left, right) => left.dayUtc.localeCompare(right.dayUtc) || left.connectorId - right.connectorId);
}

export async function runV2ObservationsRepair({ argv = process.argv.slice(2), env = process.env, repairPlan = null } = {}) {
  const args = repairPlan ? { writeR2: argv.includes("--write-r2") } : parseArgs(argv);
  const input = repairPlan || JSON.parse(fs.readFileSync(args.repairPlanJson, "utf8"));
  const scopes = normalizePlan(input); // Validate all actions before the first R2 request.
  const config = resolveR2HistoryIndexConfig(env);
  if (!hasRequiredR2Config(config.r2)) throw new Error("Missing R2 configuration");
  if (args.writeR2 && config.r2.bucket !== TEST_R2_BUCKET) throw new Error(`Refusing Phase 3 repair write outside CIC-Test: ${config.r2.bucket || "(empty)"}`);
  const results = [];
  for (const scope of scopes) {
    const base = `${config.observations_prefix_v2}/day_utc=${scope.dayUtc}`;
    if (scope.pollutantRepair) {
      results.push({ ...scope, status: "blocked_dependency", reason: "Pollutant manifests are not reconstructed without complete parquet-derived metadata." });
      continue;
    }
    let connectorResult = null;
    if (scope.needsConnector) {
      const child = await readChildren({ r2: config.r2, prefix: `${base}/connector_id=${scope.connectorId}/pollutant_code=`, dayUtc: scope.dayUtc, connectorId: scope.connectorId, kind: "pollutant" });
      await assertUnchangedChildren({ r2: config.r2, identities: child.identities });
      const key = `${base}/connector_id=${scope.connectorId}/manifest.json`;
      const payload = buildHistoryV2ConnectorManifest({ domain: "observations", dayUtc: scope.dayUtc, connectorId: scope.connectorId, runId: child.children[0].run_id, manifestKey: key, pollutantManifests: child.children, writerGitSha: child.children[0].writer_git_sha, backedUpAtUtc: child.children.map((value) => value.backed_up_at_utc).sort().at(-1) || null });
      connectorResult = await putVerified({ r2: config.r2, key, payload, writeR2: args.writeR2 });
    }
    let dayResult = null;
    if (scope.needsDay) {
      const child = await readChildren({ r2: config.r2, prefix: `${base}/connector_id=`, dayUtc: scope.dayUtc, kind: "connector" });
      await assertUnchangedChildren({ r2: config.r2, identities: child.identities });
      const key = `${base}/manifest.json`;
      const payload = buildHistoryV2DayManifest({ domain: "observations", dayUtc: scope.dayUtc, runId: child.children[0].run_id, manifestKey: key, connectorManifests: child.children, writerGitSha: child.children[0].writer_git_sha, backedUpAtUtc: child.children.map((value) => value.backed_up_at_utc).sort().at(-1) || null });
      dayResult = await putVerified({ r2: config.r2, key, payload, writeR2: args.writeR2 });
    }
    let indexResult = null;
    if (scope.needsIndex && ![connectorResult, dayResult].some((item) => item?.status === "planned")) {
      indexResult = await updateR2HistoryIndexesTargeted({ env, historyVersion: "v2", domains: ["observations"], fromDayUtc: scope.dayUtc, toDayUtc: scope.dayUtc, connectorId: scope.connectorId, writeR2: args.writeR2 });
    }
    const statuses = [connectorResult, dayResult].filter(Boolean).map((item) => item.status);
    results.push({ ...scope, status: statuses.includes("succeeded") ? "succeeded" : (statuses.every((status) => status === "skipped_unchanged") ? "skipped_unchanged" : "planned"), connector: connectorResult, day: dayResult, index: indexResult });
  }
  const blocked = results.some((result) => result.status === "blocked_dependency");
  const changed = results.some((result) => result.status === "succeeded");
  return { ok: !blocked, status: blocked ? "blocked_dependency" : (!args.writeR2 ? "planned" : (changed ? "succeeded" : "skipped_unchanged")), dry_run: !args.writeR2, write_r2: args.writeR2, bucket: config.r2.bucket, planning: { status: "planned", scopes }, execution: { status: !args.writeR2 || blocked ? "not_run" : (changed ? "succeeded" : "skipped_unchanged") }, verification: { status: args.writeR2 && !blocked ? (changed ? "succeeded" : "not_run") : "not_run" }, results };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) runV2ObservationsRepair().then((output) => process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); });
