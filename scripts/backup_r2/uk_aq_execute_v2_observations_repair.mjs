#!/usr/bin/env node
// Ordered metadata executor for v2 observations and AQI data.
// It never rewrites parquet data or invokes either data backfill wrapper.
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
  buildHistoryV2PollutantManifest,
  buildHistoryV2ConnectorManifest,
  buildHistoryV2DayManifest,
} from "../../workers/uk_aq_prune_daily/phase_b_history_r2.mjs";
import {
  resolveR2HistoryIndexConfig,
  updateR2HistoryIndexesTargeted,
} from "../../workers/shared/uk_aq_r2_history_index.mjs";
import { assertV2ObservationsChildManifest } from "./lib/uk_aq_v2_observations_manifest_validation.mjs";

const TEST_R2_BUCKET = "uk-aq-history-cic-test";
const SUPPORTED_ACTIONS = new Set([
  "observation_pollutant_manifest_repair",
  "observation_connector_manifest_repair",
  "observation_day_manifest_repair",
  "observation_index_repair",
  "rebuild_v2_observations_index_only",
  "aqi_pollutant_manifest_repair",
  "aqi_connector_manifest_repair",
  "aqi_day_manifest_repair",
  "aqi_index_repair",
  "rebuild_v2_aqi_index_only",
]);

function parseArgs(argv) {
  const args = { repairPlanJson: null, repairPlanStdin: false, writeR2: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repair-plan-json") args.repairPlanJson = String(argv[++index] || "");
    else if (arg === "--repair-plan-stdin") args.repairPlanStdin = true;
    else if (arg === "--write-r2") args.writeR2 = true;
    else if (arg === "--dry-run") args.writeR2 = false;
    else throw new Error(`Unknown arg: ${arg}`);
  }
  if (!args.repairPlanJson && !args.repairPlanStdin) throw new Error("--repair-plan-json or --repair-plan-stdin is required");
  if (args.repairPlanJson && args.repairPlanStdin) throw new Error("pass only one repair plan input");
  return args;
}

function jsonObject(object, key) {
  try {
    return JSON.parse(object.body.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in ${key}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readChildren({ r2, prefix, dayUtc, connectorId, kind, domain = "observations" }) {
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
    if (domain === "observations") {
      assertV2ObservationsChildManifest(payload, { key, kind, dayUtc, connectorId });
    } else if (payload?.domain !== "aqilevels" || payload?.manifest_kind !== kind) {
      throw new Error(`Invalid AQI ${kind} manifest: ${key}`);
    }
    children.push(payload);
    identities.set(key, { sha256: sha256Hex(object.body), etag: object.etag || null });
  }
  return { children, identities };
}

function objectFromBody({ key, body, etag = null }) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  return { key, body: buffer, bytes: buffer.byteLength, etag };
}

async function getObjectIfExists({ r2, key }) {
  try {
    return await r2GetObject({ r2, key });
  } catch (error) {
    if (String(error).includes("(404)")) return null;
    throw error;
  }
}

function proposalView(proposal) {
  return {
    key: proposal.key,
    kind: proposal.kind,
    day_utc: proposal.day_utc,
    bytes: proposal.bytes,
    old_sha256: proposal.old_sha256,
    old_etag: proposal.old_etag,
    new_sha256: proposal.new_sha256,
    changed: proposal.changed,
    status: proposal.changed ? "planned" : "skipped_unchanged",
    dependencies: proposal.dependencies,
    expected_verification: proposal.changed ? "exact_body_and_bytes" : "not_required",
    proposed_body: proposal.body,
  };
}

function childGuardSnapshot({ child, proposals, prefix, dayUtc, connectorId, kind, domain = "observations" }) {
  return {
    prefix,
    dayUtc,
    connectorId,
    kind,
    domain,
    expected_children: child.children.map((payload) => {
      const key = payload.manifest_key;
      const staged = proposals.get(key);
      const identity = child.identities.get(key);
      return {
        key,
        sha256: staged?.new_sha256 || identity.sha256,
        // A staged child has no stable live ETag until it is written. Its exact
        // proposed body remains the required comparison in that case.
        etag: staged ? null : identity.etag,
      };
    }).sort((left, right) => left.key.localeCompare(right.key)),
  };
}

async function assertCompleteChildrenUnchanged({ r2, guard }) {
  const current = await readChildren({
    r2,
    prefix: guard.prefix,
    dayUtc: guard.dayUtc,
    connectorId: guard.connectorId,
    kind: guard.kind,
    domain: guard.domain,
  });
  const expected = new Map(guard.expected_children.map((child) => [child.key, child]));
  const actualKeys = [...current.identities.keys()].sort();
  const expectedKeys = [...expected.keys()].sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`Blocked dependency: ${guard.kind} child key set changed before parent write under ${guard.prefix}`);
  }
  for (const key of expectedKeys) {
    const currentIdentity = current.identities.get(key);
    const expectedIdentity = expected.get(key);
    if (currentIdentity.sha256 !== expectedIdentity.sha256) {
      throw new Error(`Blocked dependency: ${guard.kind} child body changed before parent write: ${key}`);
    }
    if (expectedIdentity.etag && currentIdentity.etag && expectedIdentity.etag !== currentIdentity.etag) {
      throw new Error(`Blocked dependency: ${guard.kind} child ETag changed before parent write: ${key}`);
    }
  }
}

function createStagedObjectMap({ r2 }) {
  const proposals = new Map();

  async function stage({ key, body, contentType = "application/json", kind, dayUtc = null, dependencies = [], preWriteGuard = null }) {
    const bodyText = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
    const previous = proposals.get(key);
    const existing = previous || await getObjectIfExists({ r2, key });
    const oldBody = previous?.old_body ?? existing?.body?.toString("utf8") ?? null;
    const oldEtag = previous?.old_etag ?? existing?.etag ?? null;
    const proposal = {
      key,
      kind: previous?.kind || kind,
      day_utc: previous?.day_utc || dayUtc,
      content_type: contentType,
      body: bodyText,
      bytes: Buffer.byteLength(bodyText, "utf8"),
      old_body: oldBody,
      old_sha256: oldBody === null ? null : sha256Hex(oldBody),
      old_etag: oldEtag,
      new_sha256: sha256Hex(bodyText),
      changed: oldBody !== bodyText,
      dependencies: [...new Set([...(previous?.dependencies || []), ...dependencies])].sort(),
      pre_write_guard: previous?.pre_write_guard || preWriteGuard,
    };
    proposals.set(key, proposal);
    return proposal;
  }

  function stagedObject(key) {
    const proposal = proposals.get(key);
    return proposal ? objectFromBody({ key, body: proposal.body, etag: proposal.new_sha256 }) : null;
  }

  const stagedR2 = {
    ...r2,
    proposal_sink: async ({ key, body, content_type }) => {
      await stage({ key, body, contentType: content_type, kind: "observation_index" });
    },
    adapter: {
      getObject: async ({ key }) => stagedObject(key) || r2GetObject({ r2, key }),
      headObject: async ({ key }) => {
        const staged = stagedObject(key);
        if (staged) return { exists: true, key, bytes: staged.bytes, etag: staged.etag };
        return r2HeadObject({ r2, key });
      },
      listAllObjects: async ({ prefix, max_keys }) => {
        const entries = await r2ListAllObjects({ r2, prefix, max_keys });
        const byKey = new Map(entries.map((entry) => [entry.key, entry]));
        for (const proposal of proposals.values()) {
          if (proposal.key.startsWith(prefix)) {
            byKey.set(proposal.key, { key: proposal.key, size: proposal.bytes, etag: proposal.new_sha256 });
          }
        }
        return [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key));
      },
      listAllCommonPrefixes: async ({ prefix, delimiter, max_keys }) => {
        const entries = await stagedR2.adapter.listAllObjects({ prefix, max_keys });
        const prefixes = new Set();
        for (const entry of entries) {
          const suffix = entry.key.slice(prefix.length);
          const index = suffix.indexOf(delimiter);
          if (index >= 0) prefixes.add(`${prefix}${suffix.slice(0, index + delimiter.length)}`);
        }
        return [...prefixes].sort();
      },
      putObject: async ({ key, body, content_type }) => {
        const proposal = await stage({ key, body, contentType: content_type, kind: "observation_index" });
        return { key, bytes: proposal.bytes, etag: proposal.new_sha256 };
      },
    },
  };

  return { proposals, stage, stagedR2 };
}

function stableGeneratedAt({ dayUtc, dayManifest }) {
  const backedUpAt = String(dayManifest?.backed_up_at_utc || "");
  return /^\d{4}-\d{2}-\d{2}T/.test(backedUpAt) ? backedUpAt : `${dayUtc}T00:00:00.000Z`;
}

const REPAIR_STATUSES = new Set([
  "planned",
  "executing",
  "skipped_unchanged",
  "succeeded",
  "failed",
  "blocked_dependency",
  "not_run",
]);

function collectOutcomeStatuses(value, statuses = []) {
  if (!value || typeof value !== "object") return statuses;
  if (Array.isArray(value)) {
    for (const entry of value) collectOutcomeStatuses(entry, statuses);
    return statuses;
  }
  if (REPAIR_STATUSES.has(value.status)) statuses.push(value.status);
  if (REPAIR_STATUSES.has(value.verification_status)) statuses.push(value.verification_status);
  if (Number(value.blocked_dependency_count || 0) > 0) statuses.push("blocked_dependency");
  if (Number(value.failed_count || value.failure_count || 0) > 0) statuses.push("failed");
  for (const [key, entry] of Object.entries(value)) {
    if (key !== "status" && key !== "verification_status") {
      collectOutcomeStatuses(entry, statuses);
    }
  }
  return statuses;
}

function collectVerificationStatuses(value, statuses = []) {
  if (!value || typeof value !== "object") return statuses;
  if (Array.isArray(value)) {
    for (const entry of value) collectVerificationStatuses(entry, statuses);
    return statuses;
  }
  if (REPAIR_STATUSES.has(value.verification_status)) statuses.push(value.verification_status);
  if (REPAIR_STATUSES.has(value.verification?.status)) statuses.push(value.verification.status);
  for (const [key, entry] of Object.entries(value)) {
    if (key !== "verification_status" && key !== "verification") {
      collectVerificationStatuses(entry, statuses);
    }
  }
  return statuses;
}

function reduceRepairStatus(statuses, fallback = "not_run") {
  const known = statuses.filter((status) => REPAIR_STATUSES.has(status));
  if (known.includes("blocked_dependency")) return "blocked_dependency";
  if (known.includes("failed")) return "failed";
  if (known.includes("succeeded")) return "succeeded";
  if (known.includes("planned") || known.includes("executing")) return "planned";
  if (known.includes("skipped_unchanged")) return "skipped_unchanged";
  return fallback;
}

async function applyStagedProposals({ r2, proposals, writeR2 }) {
  const results = new Map();
  for (const proposal of proposals.values()) {
    if (!proposal.changed) {
      results.set(proposal.key, { key: proposal.key, status: "skipped_unchanged", verification: "not_run" });
      continue;
    }
    if (!writeR2) {
      results.set(proposal.key, { key: proposal.key, status: "planned", verification: "not_run" });
      continue;
    }
    if (proposal.pre_write_guard) {
      await assertCompleteChildrenUnchanged({ r2, guard: proposal.pre_write_guard });
    }
    await r2PutObject({ r2, key: proposal.key, body: proposal.body, content_type: proposal.content_type });
    const fresh = await r2GetObject({ r2, key: proposal.key });
    if (fresh.bytes !== proposal.bytes || fresh.body.toString("utf8") !== proposal.body) {
      throw new Error(`Verification failed for ${proposal.key}`);
    }
    results.set(proposal.key, { key: proposal.key, status: "succeeded", verification: "succeeded" });
  }
  return results;
}

function extractRepairPlan(input) {
  if (input?.history_version === "v2" && ["observations", "aqilevels"].includes(input?.domain) && Array.isArray(input.repair_plan)) {
    return { inputKind: `${input.domain}_repair_plan`, domain: input.domain, actions: input.repair_plan };
  }
  const v2 = input?.history_version_results?.v2;
  const observations = v2?.observations;
  if (input?.history_version_results) {
    if (!(["v2", "both"].includes(input.history_version_mode)
      && Array.isArray(input.checked_versions) && input.checked_versions.includes("v2")
      && v2?.history_version === "v2" && v2.checks_implemented === true
      && typeof observations?.status === "string" && Number.isInteger(observations.checked_partitions)
      && Number.isInteger(observations.gap_count) && Array.isArray(observations.gaps)
      && Array.isArray(observations.repair_plan))) {
      throw new Error("Invalid complete integrity report: expected checked v2 observations results");
    }
    return { inputKind: "integrity_report", domain: "observations", actions: observations.repair_plan };
  }
  throw new Error("Repair input must be a complete integrity report with history_version_results.v2.observations.repair_plan, or { history_version: 'v2', domain: 'observations', repair_plan: [...] }");
}

function validateAction(action) {
  if (!SUPPORTED_ACTIONS.has(action?.kind)) {
    throw new Error(`Unsupported Phase 4 repair action: ${String(action?.kind || "unknown")}`);
  }
  if (action.status !== "planned" || action.executes !== false
    || action.data_changes_required !== false || action.operator_action_required !== false) {
    throw new Error(`Unsafe Phase 4 repair action: ${action.kind}`);
  }
  if (action.history_version !== undefined && action.history_version !== "v2") {
    throw new Error(`Unsupported history version for Phase 4 repair action: ${action.history_version}`);
  }
  if (action.domain !== undefined && !["observations", "aqilevels"].includes(action.domain)) {
    throw new Error(`Unsupported domain for Phase 4 repair action: ${action.domain}`);
  }
  if (typeof action.requires_index_rebuild !== "boolean" || !Array.isArray(action.gap_types)
    || action.gap_types.some((gapType) => typeof gapType !== "string" || !gapType.trim())) {
    throw new Error(`Invalid Phase 4 repair action contract: ${action.kind}`);
  }
}

function normalizePlan(input) {
  const { inputKind, domain, actions } = extractRepairPlan(input);
  const scopes = new Map();
  for (const action of actions) {
    validateAction(action);
    const dayUtc = String(action.day_utc || "");
    const connectorId = Number(action.connector_id);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayUtc) || !Number.isInteger(connectorId) || connectorId <= 0) {
      throw new Error("Every repair action must have day_utc and positive connector_id");
    }
    const key = `${dayUtc}|${connectorId}`;
    const scope = scopes.get(key) || { dayUtc, connectorId, needsConnector: false, needsDay: false, needsIndex: false, pollutantRepair: false, pollutantCodes: new Set(), gapTypes: new Set() };
    scope.needsConnector ||= action.kind.endsWith("connector_manifest_repair") || action.kind.endsWith("pollutant_manifest_repair");
    scope.needsDay ||= scope.needsConnector || action.kind.endsWith("day_manifest_repair");
    scope.needsIndex ||= Boolean(action.requires_index_rebuild) || action.kind.includes("index");
    scope.pollutantRepair ||= action.kind.endsWith("pollutant_manifest_repair");
    if (typeof action.pollutant_code === "string" && action.pollutant_code.trim()) {
      scope.pollutantCodes.add(action.pollutant_code.trim().toLowerCase());
    }
    for (const gapType of action.gap_types) scope.gapTypes.add(gapType);
    scopes.set(key, scope);
  }
  return {
    inputKind,
    domain,
    scopes: [...scopes.values()]
      .sort((left, right) => left.dayUtc.localeCompare(right.dayUtc) || left.connectorId - right.connectorId)
      .map(({ gapTypes, pollutantCodes, ...scope }) => ({
        ...scope,
        gap_types: [...gapTypes].sort(),
        pollutant_codes: [...pollutantCodes].sort(),
      })),
  };
}

export async function runV2ObservationsRepair({
  argv = process.argv.slice(2),
  env = process.env,
  repairPlan = null,
  updateIndexes = updateR2HistoryIndexesTargeted,
} = {}) {
  const args = repairPlan ? { writeR2: argv.includes("--write-r2") } : parseArgs(argv);
  const input = repairPlan || JSON.parse(
    args.repairPlanStdin
      ? fs.readFileSync(0, "utf8")
      : fs.readFileSync(args.repairPlanJson, "utf8"),
  );
  const { inputKind, domain, scopes } = normalizePlan(input); // Validate all actions before the first R2 request.
  const config = resolveR2HistoryIndexConfig(env);
  if (args.writeR2 && env.UK_AQ_ENV_NAME !== "CIC-Test") {
    throw new Error(`Refusing Phase 4 repair write: UK_AQ_ENV_NAME must be CIC-Test (got ${env.UK_AQ_ENV_NAME || "(empty)"})`);
  }
  if (args.writeR2 && config.r2.bucket !== TEST_R2_BUCKET) {
    throw new Error(`Refusing Phase 4 repair write: configured R2 bucket must be ${TEST_R2_BUCKET} (got ${config.r2.bucket || "(empty)"})`);
  }
  if (!hasRequiredR2Config(config.r2)) throw new Error("Missing R2 configuration");
  const byDay = new Map();
  for (const scope of scopes) {
    const dayScopes = byDay.get(scope.dayUtc) || [];
    dayScopes.push(scope);
    byDay.set(scope.dayUtc, dayScopes);
  }
  const staged = createStagedObjectMap({ r2: config.r2 });
  const dayPlans = [];
  const blockedScopes = [];

  for (const [dayUtc, dayScopes] of [...byDay.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const dataPrefix = domain === "observations"
      ? config.observations_prefix_v2
      : config.aqilevels_hourly_data_prefix_v2;
    const base = `${dataPrefix}/day_utc=${dayUtc}`;
    const proposalKeys = [];
    // Pollutant manifests are the leaf metadata layer.  Rebuild them before
    // connector/day manifests so a malformed child cannot be preserved by a
    // newly generated parent.  The writer records complete per-part metadata
    // in `files`; its parquet objects are the immutable data dependency.
    for (const scope of dayScopes.filter((value) => value.pollutantRepair).sort((left, right) => left.connectorId - right.connectorId)) {
      const child = await readChildren({ r2: staged.stagedR2, prefix: `${base}/connector_id=${scope.connectorId}/pollutant_code=`, dayUtc, connectorId: scope.connectorId, kind: "pollutant", domain });
      const wanted = new Set(scope.pollutant_codes || []);
      const selected = child.children.filter((payload) => !wanted.size || wanted.has(String(payload.pollutant_code || "").trim().toLowerCase()));
      if (!selected.length) {
        const blocked = { ...scope, status: "blocked_dependency", reason: "Pollutant manifest repair requires final combined parquet metadata for the requested pollutant." };
        blockedScopes.push(blocked);
        continue;
      }
      for (const payload of selected) {
        const manifestKey = String(payload.manifest_key || "").trim();
        const files = Array.isArray(payload.files) ? payload.files : [];
        if (!manifestKey || !files.length) {
          const blocked = { ...scope, pollutant_code: payload.pollutant_code || null, status: "blocked_dependency", reason: "Pollutant manifest repair is blocked because final parquet file metadata is unavailable." };
          blockedScopes.push(blocked);
          continue;
        }
        const rebuilt = buildHistoryV2PollutantManifest({
          domain,
          profile: domain === "aqilevels" ? "data" : null,
          dayUtc,
          connectorId: scope.connectorId,
          pollutantCode: payload.pollutant_code,
          runId: payload.run_id || null,
          manifestKey,
          sourceRowCount: Number(payload.source_row_count || payload.row_count || 0),
          fileEntries: files,
          writerGitSha: payload.writer_git_sha || null,
          backedUpAtUtc: payload.backed_up_at_utc || `${dayUtc}T00:00:00.000Z`,
        });
        await staged.stage({
          key: manifestKey,
          body: JSON.stringify(rebuilt, null, 2),
          kind: "pollutant_manifest",
          dayUtc,
          dependencies: files.map((entry) => String(entry?.key || "")).filter(Boolean),
        });
        proposalKeys.push(manifestKey);
      }
    }
    for (const scope of dayScopes.filter((value) => value.needsConnector).sort((left, right) => left.connectorId - right.connectorId)) {
      const child = await readChildren({ r2: staged.stagedR2, prefix: `${base}/connector_id=${scope.connectorId}/pollutant_code=`, dayUtc, connectorId: scope.connectorId, kind: "pollutant", domain });
      const key = `${base}/connector_id=${scope.connectorId}/manifest.json`;
      const payload = buildHistoryV2ConnectorManifest({ domain, profile: domain === "aqilevels" ? "data" : null, dayUtc, connectorId: scope.connectorId, runId: child.children[0].run_id, manifestKey: key, pollutantManifests: child.children, writerGitSha: child.children[0].writer_git_sha, backedUpAtUtc: child.children.map((value) => value.backed_up_at_utc).sort().at(-1) || null });
      await staged.stage({
        key,
        body: JSON.stringify(payload, null, 2),
        kind: "connector_manifest",
        dayUtc,
        dependencies: [...child.identities.keys()],
        preWriteGuard: childGuardSnapshot({
          child,
          proposals: staged.proposals,
          prefix: `${base}/connector_id=${scope.connectorId}/pollutant_code=`,
          dayUtc,
          connectorId: scope.connectorId,
          kind: "pollutant",
          domain,
        }),
      });
      proposalKeys.push(key);
    }

    const needsDay = dayScopes.some((scope) => scope.needsDay);
    let dayManifest = null;
    let dayManifestKey = `${base}/manifest.json`;
    if (needsDay) {
      const child = await readChildren({ r2: staged.stagedR2, prefix: `${base}/connector_id=`, dayUtc, kind: "connector", domain });
      dayManifest = buildHistoryV2DayManifest({ domain, profile: domain === "aqilevels" ? "data" : null, dayUtc, runId: child.children[0].run_id, manifestKey: dayManifestKey, connectorManifests: child.children, writerGitSha: child.children[0].writer_git_sha, backedUpAtUtc: child.children.map((value) => value.backed_up_at_utc).sort().at(-1) || null });
      await staged.stage({
        key: dayManifestKey,
        body: JSON.stringify(dayManifest, null, 2),
        kind: "day_manifest",
        dayUtc,
        dependencies: [...child.identities.keys()],
        preWriteGuard: childGuardSnapshot({
          child,
          proposals: staged.proposals,
          prefix: `${base}/connector_id=`,
          dayUtc,
          connectorId: null,
          kind: "connector",
          domain,
        }),
      });
      proposalKeys.push(dayManifestKey);
    } else {
      const existingDay = await getObjectIfExists({ r2: staged.stagedR2, key: dayManifestKey });
      dayManifest = existingDay ? jsonObject(existingDay, dayManifestKey) : null;
    }

    let index = null;
    if (dayScopes.some((scope) => scope.needsIndex)) {
      const before = new Set(staged.proposals.keys());
      index = await updateIndexes({
        env,
        r2: staged.stagedR2,
        historyVersion: "v2",
        domains: [domain],
        fromDayUtc: dayUtc,
        toDayUtc: dayUtc,
        connectorId: null,
        generatedAt: stableGeneratedAt({ dayUtc, dayManifest }),
        writeR2: true,
      });
      for (const key of staged.proposals.keys()) {
        if (!before.has(key)) proposalKeys.push(key);
      }
    }
    dayPlans.push({ day_utc: dayUtc, status: "planned", scopes: dayScopes, blocked_scopes: [], proposal_keys: [...new Set(proposalKeys)].sort(), index });
  }

  const applied = await applyStagedProposals({ r2: config.r2, proposals: staged.proposals, writeR2: args.writeR2 });
  const proposalViews = [...staged.proposals.values()].map(proposalView).sort((left, right) => left.key.localeCompare(right.key));
  const results = dayPlans.map((plan) => {
    if (plan.status === "blocked_dependency") return plan;
    const operations = plan.proposal_keys.map((key) => applied.get(key)).filter(Boolean);
    const statuses = [
      ...operations.flatMap((operation) => collectOutcomeStatuses(operation)),
      ...collectOutcomeStatuses(plan.index),
    ];
    const verificationStatuses = operations.flatMap((operation) => {
      const status = operation.verification;
      return REPAIR_STATUSES.has(status) ? [status] : [];
    });
    collectVerificationStatuses(plan.index, verificationStatuses);
    return {
      ...plan,
      status: reduceRepairStatus(statuses, args.writeR2 ? "not_run" : "planned"),
      verification: { status: reduceRepairStatus(verificationStatuses, "not_run") },
      operations,
    };
  });
  const topLevelStatuses = results.flatMap((result) => collectOutcomeStatuses(result));
  const status = reduceRepairStatus(topLevelStatuses, args.writeR2 ? "not_run" : "planned");
  const ok = status !== "blocked_dependency" && status !== "failed";
  const executionStatus = args.writeR2
    ? reduceRepairStatus(results.map((result) => result.status), "not_run")
    : "not_run";
  const verificationStatus = args.writeR2
    ? reduceRepairStatus(results.flatMap((result) => collectOutcomeStatuses(result.verification)), "not_run")
    : "not_run";
  return {
    ok,
    status,
    dry_run: !args.writeR2,
    write_r2: args.writeR2,
    bucket: config.r2.bucket,
    planning: { status: "planned", input_kind: inputKind, domain, scopes, days: dayPlans, proposals: proposalViews, blocked_scopes: blockedScopes },
    execution: { status: executionStatus },
    verification: { status: verificationStatus },
    results,
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) runV2ObservationsRepair().then((output) => {
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!output.ok) process.exitCode = 1;
}).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); });
