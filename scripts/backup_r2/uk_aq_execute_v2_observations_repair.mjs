#!/usr/bin/env node
// Ordered metadata executor for v2 observations and AQI data.
// It never rewrites parquet data or invokes either data backfill wrapper.
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import {
  parquetMetadataAsync,
  parquetRead,
  parquetSchema,
  compressors,
} from "./lib/uk_aq_parquet_dependencies.mjs";
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

// Scope is part of the repair-action contract.  In particular, a day
// manifest is above the connector hierarchy: giving it a connector ID would
// rebuild a parent from a subset of its children.  Keep those actions as a
// distinct, connector-less scope so the day builder reads every final child
// manifest from the combined overlay/Dropbox view.
const ACTION_SCOPE_RULES = {
  observation_pollutant_manifest_repair: { connector: "required", pollutant: "required", needsConnector: true, needsDay: true, pollutantRepair: true },
  observation_connector_manifest_repair: { connector: "required", needsConnector: true, needsDay: true },
  observation_day_manifest_repair: { connector: "absent", needsDay: true },
  observation_index_repair: { connector: "required", pollutant: "required" },
  rebuild_v2_observations_index_only: { connector: "required" },
  aqi_pollutant_manifest_repair: { connector: "required", pollutant: "required", needsConnector: true, needsDay: true, pollutantRepair: true },
  aqi_connector_manifest_repair: { connector: "required", needsConnector: true, needsDay: true },
  aqi_day_manifest_repair: { connector: "absent", needsDay: true },
  aqi_index_repair: { connector: "required", pollutant: "required" },
  rebuild_v2_aqi_index_only: { connector: "required" },
};

function parseArgs(argv) {
  const args = { repairPlanJson: null, repairPlanStdin: false, writeR2: false, overlayRoot: null, dropboxRoot: null, runStateJson: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repair-plan-json") args.repairPlanJson = String(argv[++index] || "");
    else if (arg === "--repair-plan-stdin") args.repairPlanStdin = true;
    else if (arg === "--write-r2") args.writeR2 = true;
    else if (arg === "--dry-run") args.writeR2 = false;
    else if (arg === "--overlay-root") args.overlayRoot = String(argv[++index] || "");
    else if (arg === "--dropbox-root") args.dropboxRoot = String(argv[++index] || "");
    else if (arg === "--run-state-json") args.runStateJson = String(argv[++index] || "");
    else throw new Error(`Unknown arg: ${arg}`);
  }
  if (!args.repairPlanJson && !args.repairPlanStdin) throw new Error("--repair-plan-json or --repair-plan-stdin is required");
  if (args.repairPlanJson && args.repairPlanStdin) throw new Error("pass only one repair plan input");
  if (!args.overlayRoot || !args.dropboxRoot || !args.runStateJson) throw new Error("--overlay-root, --dropbox-root and --run-state-json are required for the combined local resolver");
  return args;
}

function jsonObject(object, key) {
  try {
    return JSON.parse(object.body.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in ${key}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readChildren({
  store,
  prefix,
  dayUtc,
  connectorId,
  kind,
  domain = "observations",
  identityOnlyKeys = new Set(),
}) {
  const entries = await store.listAllObjects({ prefix });
  const keyPattern = kind === "connector"
    ? /\/connector_id=\d+\/manifest\.json$/
    : /\/pollutant_code=[^/]+\/manifest\.json$/;
  const keys = entries.map((entry) => entry.key).filter((key) => keyPattern.test(key)).sort();
  if (!keys.length && identityOnlyKeys.size === 0) {
    throw new Error(`Blocked dependency: no ${kind} manifests under ${prefix}`);
  }
  const children = [];
  const identities = new Map();
  for (const key of keys) {
    // readChildren is used only with R2-compatible adapters (the staged view
    // during planning and the live race guard during writes).
    const object = await store.getObject({ key });
    identities.set(key, {
      content_sha256: object.content_sha256 || sha256Hex(object.body),
      r2_etag: object.r2_etag || object.etag || null,
      source: object.source || "live_r2",
      last_modified: object.last_modified || null,
    });
    // Initial whole-plan preflight may inspect the old live identity of an
    // exact child that has already passed canonical staged-proposal
    // validation. Its replacement body, not the malformed/absent old body,
    // is the schema dependency. Normal planning and per-write guards never
    // receive this exemption.
    if (identityOnlyKeys.has(key)) continue;
    const payload = jsonObject(object, key);
    if (domain === "observations") {
      assertV2ObservationsChildManifest(payload, { key, kind, dayUtc, connectorId });
    } else if (payload?.domain !== "aqilevels" || payload?.manifest_kind !== kind) {
      throw new Error(`Invalid AQI ${kind} manifest: ${key}`);
    }
    children.push(payload);
  }
  return { children, identities };
}

function safeLocalKey(key) {
  const normalized = String(key || "").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => part === "..")) throw new Error(`Unsafe local object key: ${key}`);
  return normalized;
}

function walkLocalObjects(root, prefixes = []) {
  const found = new Map();
  if (!root || !fs.existsSync(root)) return found;
  const visit = (directory, relative = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const fullPath = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(fullPath, nextRelative);
      else if (entry.isFile()) found.set(nextRelative, fullPath);
    }
  };
  for (const prefix of prefixes) {
    const normalized = safeLocalKey(prefix).replace(/\/$/, "");
    const scopedRoot = `${root}/${normalized}`;
    if (fs.existsSync(scopedRoot)) visit(scopedRoot, normalized);
  }
  return found;
}

function createCombinedLocalStore({ overlayRoot, dropboxRoot, runStateJson, prefixes, exactKeys = [], dynamicExactKeyPrefixes = [] }) {
  const state = JSON.parse(fs.readFileSync(runStateJson, "utf8"));
  const verifiedTombstones = new Set(Object.entries(state?.tombstones || {})
    .filter(([, value]) => value?.r2_delete_verified === true)
    .map(([key]) => safeLocalKey(key)));
  const dropboxPaths = walkLocalObjects(dropboxRoot, prefixes);
  for (const rawKey of exactKeys) {
    const key = safeLocalKey(rawKey);
    const candidate = `${dropboxRoot}/${key}`;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) dropboxPaths.set(key, candidate);
  }
  for (const key of verifiedTombstones) dropboxPaths.delete(key);
  const overlayPaths = new Map();
  for (const [key, entry] of Object.entries(state?.objects || {})) {
    if (entry?.r2_verified === true && typeof entry.local_path === "string" && fs.existsSync(entry.local_path)) {
      overlayPaths.set(safeLocalKey(key), entry.local_path);
    }
  }
  const liveObjects = new Map();
  const confirmedLiveMissing = new Set();
  const inventoryDiagnostics = new Map();

  function localObject(key, source) {
    const localPath = (source === "overlay" ? overlayPaths : dropboxPaths).get(key);
    if (!localPath) return null;
    const body = fs.readFileSync(localPath);
    return objectFromBody({ key, body, source, content_sha256: sha256Hex(body) });
  }

  function objectFor(key) {
    if (verifiedTombstones.has(key)) return null;
    if (overlayPaths.has(key)) return localObject(key, "overlay");
    const live = liveObjects.get(key);
    if (live) return objectFromBody({
      key,
      body: live.body,
      source: "live_r2",
      content_sha256: live.content_sha256,
      r2_etag: live.r2_etag,
      last_modified: live.last_modified,
    });
    return localObject(key, "dropbox");
  }

  return {
    overlayRoot,
    setLiveObject({ key, body, r2_etag = null, last_modified = null }) {
      const normalized = safeLocalKey(key);
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
      liveObjects.set(normalized, {
        body: buffer,
        content_sha256: sha256Hex(buffer),
        r2_etag: r2_etag || null,
        last_modified: last_modified || null,
      });
      confirmedLiveMissing.delete(normalized);
    },
    setLiveMissing({ key }) {
      const normalized = safeLocalKey(key);
      liveObjects.delete(normalized);
      confirmedLiveMissing.add(normalized);
    },
    getLiveLookupState(key) {
      const normalized = safeLocalKey(key);
      const live = liveObjects.get(normalized);
      if (live) {
        return {
          status: "existing",
          key: normalized,
          content_sha256: live.content_sha256,
          r2_etag: live.r2_etag,
          last_modified: live.last_modified,
        };
      }
      if (confirmedLiveMissing.has(normalized)) return { status: "missing", key: normalized };
      return { status: "unverified", key: normalized };
    },
    recordLiveInventory({ prefix, live_keys }) {
      const normalizedPrefix = safeLocalKey(prefix).replace(/\/$/, "");
      const backupKeys = [...dropboxPaths.keys()].filter((key) => key.startsWith(normalizedPrefix)).sort();
      const liveKeys = [...new Set(live_keys.map(safeLocalKey))].sort();
      const backup = new Set(backupKeys);
      const live = new Set(liveKeys);
      inventoryDiagnostics.set(normalizedPrefix, {
        expected_child_keys: backupKeys,
        actual_live_child_keys: liveKeys,
        missing_keys: backupKeys.filter((key) => !live.has(key)),
        unexpected_keys: liveKeys.filter((key) => !backup.has(key)),
        expected_inventory_source: "dropbox",
        state: backupKeys.length === liveKeys.length && backupKeys.every((key, index) => key === liveKeys[index])
          ? "matched"
          : "backup_drift",
      });
    },
    inventoryDiagnostic(prefix) {
      const normalized = safeLocalKey(prefix).replace(/\/$/, "");
      const direct = inventoryDiagnostics.get(normalized);
      const source = direct || [...inventoryDiagnostics.entries()]
        .filter(([candidate]) => normalized.startsWith(`${candidate}/`))
        .sort(([left], [right]) => right.length - left.length)[0]?.[1];
      if (!source) return null;
      const expectedChildKeys = source.expected_child_keys.filter((key) => key.startsWith(normalized));
      const actualLiveChildKeys = source.actual_live_child_keys.filter((key) => key.startsWith(normalized));
      const expected = new Set(expectedChildKeys);
      const actual = new Set(actualLiveChildKeys);
      return {
        expected_child_keys: expectedChildKeys,
        actual_live_child_keys: actualLiveChildKeys,
        missing_keys: expectedChildKeys.filter((key) => !actual.has(key)),
        unexpected_keys: actualLiveChildKeys.filter((key) => !expected.has(key)),
        expected_inventory_source: source.expected_inventory_source,
        state: expectedChildKeys.length === actualLiveChildKeys.length
          && expectedChildKeys.every((key, index) => key === actualLiveChildKeys[index])
          ? "matched"
          : "backup_drift",
      };
    },
    getObjectFromSourceIfExists(key, source) {
      const normalized = safeLocalKey(key);
      if (source === "live_r2") {
        const live = liveObjects.get(normalized);
        return live ? objectFromBody({ key: normalized, body: live.body, source, content_sha256: live.content_sha256, r2_etag: live.r2_etag, last_modified: live.last_modified }) : null;
      }
      return localObject(normalized, source);
    },
    getLiveTargetObjectIfExists(key) {
      const normalized = safeLocalKey(key);
      if (verifiedTombstones.has(normalized)) return null;
      if (overlayPaths.has(normalized)) return localObject(normalized, "overlay");
      const live = liveObjects.get(normalized);
      return live ? objectFromBody({ key: normalized, body: live.body, source: "live_r2", content_sha256: live.content_sha256, r2_etag: live.r2_etag, last_modified: live.last_modified }) : null;
    },
    getObject(key) {
      const normalized = safeLocalKey(key);
      let object = objectFor(normalized);
      if (!object && dynamicExactKeyPrefixes.some((prefix) => normalized.startsWith(`${safeLocalKey(prefix)}/`))) {
        const candidate = `${dropboxRoot}/${normalized}`;
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          dropboxPaths.set(normalized, candidate);
          object = objectFor(normalized);
        }
      }
      if (!object) {
        const error = new Error(`Combined local object unavailable: ${normalized}`);
        error.code = "OBJECT_NOT_FOUND";
        throw error;
      }
      return object;
    },
    getObjectIfExists(key) {
      try { return this.getObject(key); } catch (error) {
        if (error?.code === "OBJECT_NOT_FOUND") return null;
        throw error;
      }
    },
    listAllObjects({ prefix }) {
      const keys = new Set([...dropboxPaths.keys(), ...overlayPaths.keys(), ...liveObjects.keys()]);
      return [...keys]
        .filter((key) => key.startsWith(prefix) && !verifiedTombstones.has(key))
        .map((key) => {
          const object = objectFor(key);
          return { key, size: object?.bytes ?? null, source: object?.source ?? null, content_sha256: object?.content_sha256 ?? null, r2_etag: object?.r2_etag ?? null };
        })
        .sort((left, right) => left.key.localeCompare(right.key));
    },
    listLiveTargetObjects({ prefix }) {
      const keys = new Set([...overlayPaths.keys(), ...liveObjects.keys()]);
      return [...keys]
        .filter((key) => key.startsWith(prefix) && !verifiedTombstones.has(key))
        .map((key) => {
          const object = this.getLiveTargetObjectIfExists(key);
          return { key, size: object?.bytes ?? null, source: object?.source ?? null, content_sha256: object?.content_sha256 ?? null, r2_etag: object?.r2_etag ?? null };
        })
        .sort((left, right) => left.key.localeCompare(right.key));
    },
  };
}

async function hydrateLiveR2State({ store, r2, prefixes, exactKeys = [], lookupFailureReason = null }) {
  const liveKeys = new Set(exactKeys.map(safeLocalKey));
  for (const prefix of prefixes) {
    const entries = await r2ListAllObjects({ r2, prefix });
    const keys = entries.map((entry) => safeLocalKey(entry?.key || "")).filter(Boolean);
    store.recordLiveInventory({ prefix, live_keys: keys });
    for (const key of keys) liveKeys.add(key);
  }
  for (const key of [...liveKeys].sort()) {
    try {
      const object = await r2GetObject({ r2, key });
      store.setLiveObject({ key, body: object.body, r2_etag: object.etag, last_modified: object.last_modified });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error?.code === "OBJECT_NOT_FOUND" || message.includes("(404)")) {
        store.setLiveMissing({ key });
        continue;
      }
      if (lookupFailureReason) {
        throw new Error(`blocked_dependency|${lookupFailureReason}|${key}|${message}`);
      }
      throw new Error(`Unable to hydrate live R2 state for ${key}: ${message}`);
    }
  }
}

// This adapter is used only for the parent pre-write race guard.  It is not a
// planning source: all normal reads use createCombinedLocalStore above.
function createR2RaceGuardStore(r2) {
  return {
    // Keep this signature aligned with the shared R2 adapter contract.  The
    // guard calls readChildren(), which always passes an object containing the
    // canonical R2 key.  Passing that wrapper through as the key reached AWS
    // request signing as `objectKey.split is not a function`.
    getObject: async ({ key }) => await r2GetObject({ r2, key }),
    listAllObjects: async ({ prefix, max_keys = 1000 }) => await r2ListAllObjects({ r2, prefix, max_keys }),
  };
}

function objectFromBody({ key, body, source = "unknown", content_sha256 = null, r2_etag = null, last_modified = null }) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  return {
    key,
    body: buffer,
    bytes: buffer.byteLength,
    source,
    content_sha256: content_sha256 || sha256Hex(buffer),
    r2_etag: r2_etag || null,
    last_modified: last_modified || null,
  };
}

function proposalView(proposal) {
  return {
    key: proposal.key,
    kind: proposal.kind,
    day_utc: proposal.day_utc,
    bytes: proposal.bytes,
    old_sha256: proposal.old_sha256,
    old_r2_etag: proposal.old_r2_etag,
    new_sha256: proposal.new_sha256,
    changed: proposal.changed,
    status: proposal.changed ? "planned" : "skipped_unchanged",
    dependencies: proposal.dependencies,
    provenance: proposal.provenance || null,
    pre_write_guard: proposal.pre_write_guard ? {
      expected_child_keys: proposal.pre_write_guard.expected_children.map((child) => child.key),
      expected_inventory_source: proposal.pre_write_guard.expected_inventory_source,
      backup_inventory: proposal.pre_write_guard.backup_inventory,
      last_live_inventory: proposal.pre_write_guard.last_live_inventory,
    } : null,
    target_pre_write_guard: proposal.target_pre_write_guard ? {
      key: proposal.target_pre_write_guard.key,
      planned_state: proposal.target_pre_write_guard.planned_state,
      old_sha256: proposal.target_pre_write_guard.old_sha256,
      old_r2_etag: proposal.target_pre_write_guard.old_r2_etag,
      lookup_source: proposal.target_pre_write_guard.lookup_source,
      last_live_state: proposal.target_pre_write_guard.last_live_state,
    } : null,
    expected_verification: proposal.changed ? "exact_body_and_bytes" : "not_required",
    proposed_body: proposal.body,
  };
}

function manifestInventoryForKind(inventory, kind) {
  if (!inventory) return null;
  const pattern = kind === "connector"
    ? /\/connector_id=\d+\/manifest\.json$/
    : /\/pollutant_code=[^/]+\/manifest\.json$/;
  const expectedChildKeys = inventory.expected_child_keys.filter((key) => pattern.test(key));
  const actualLiveChildKeys = inventory.actual_live_child_keys.filter((key) => pattern.test(key));
  const expected = new Set(expectedChildKeys);
  const actual = new Set(actualLiveChildKeys);
  return {
    ...inventory,
    expected_child_keys: expectedChildKeys,
    actual_live_child_keys: actualLiveChildKeys,
    missing_keys: expectedChildKeys.filter((key) => !actual.has(key)),
    unexpected_keys: actualLiveChildKeys.filter((key) => !expected.has(key)),
    state: expectedChildKeys.length === actualLiveChildKeys.length
      && expectedChildKeys.every((key, index) => key === actualLiveChildKeys[index])
      ? "matched"
      : "backup_drift",
  };
}

function childGuardSnapshot({ child, proposals, prefix, dayUtc, connectorId, kind, domain = "observations", store = null }) {
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
        content_sha256: staged?.new_sha256 || identity.content_sha256,
        // A staged child has no stable live ETag until it is written. Its exact
        // proposed body remains the required comparison in that case.
        r2_etag: staged ? null : identity.r2_etag,
        source: staged ? "planned_overlay" : identity.source,
        staged: Boolean(staged),
      };
    }).sort((left, right) => left.key.localeCompare(right.key)),
    expected_inventory_source: "live_r2_snapshot",
    backup_inventory: manifestInventoryForKind(store?.inventoryDiagnostic(prefix), kind),
    last_live_inventory: null,
  };
}

async function assertCompleteChildrenUnchanged({
  r2,
  guard,
  allowStagedChildren = false,
  validatedStagedProposalKeys = new Set(),
}) {
  // A parent may only be planned from the live snapshot/current overlay or a
  // child staged in this plan.  Dropbox is diagnostic/reconstruction input,
  // never a valid member of a live parent inventory.  Classify this as a bad
  // plan rather than claiming that live R2 changed concurrently.
  const invalidPlannedChildren = guard.expected_children.filter((child) =>
    !child.staged && child.source !== "live_r2" && child.source !== "overlay"
  );
  if (invalidPlannedChildren.length) {
    const invalidKeys = invalidPlannedChildren.map((child) => child.key).sort();
    guard.last_live_inventory = {
      expected_child_keys: guard.expected_children.map((child) => child.key).sort(),
      actual_live_child_keys: null,
      missing_keys: invalidKeys,
      unexpected_keys: [],
      expected_inventory_source: guard.expected_inventory_source || "live_r2_snapshot",
      state: "invalid_planned_inventory",
    };
    throw new Error(`Blocked dependency: invalid_planned_inventory ${guard.kind} expected non-live child under ${guard.prefix}; invalid=${invalidKeys.join(",")}`);
  }
  const identityOnlyKeys = allowStagedChildren
    ? new Set(guard.expected_children
      .filter((child) => child.staged && validatedStagedProposalKeys.has(child.key))
      .map((child) => child.key))
    : new Set();
  const current = await readChildren({
    store: createR2RaceGuardStore(r2),
    prefix: guard.prefix,
    dayUtc: guard.dayUtc,
    connectorId: guard.connectorId,
    kind: guard.kind,
    domain: guard.domain,
    identityOnlyKeys,
  });
  const expected = new Map(guard.expected_children.map((child) => [child.key, child]));
  const actualKeys = [...current.identities.keys()].sort();
  const expectedKeys = [...expected.keys()].sort();
  const actual = new Set(actualKeys);
  const expectedKeySet = new Set(expectedKeys);
  const missingKeys = expectedKeys.filter((key) => !actual.has(key) && !(allowStagedChildren && expected.get(key)?.staged));
  const unexpectedKeys = actualKeys.filter((key) => !expectedKeySet.has(key));
  guard.last_live_inventory = {
    expected_child_keys: expectedKeys,
    actual_live_child_keys: actualKeys,
    missing_keys: missingKeys,
    unexpected_keys: unexpectedKeys,
    expected_inventory_source: guard.expected_inventory_source || "live_r2_snapshot",
    state: !missingKeys.length && !unexpectedKeys.length
      ? "matched"
      : "concurrent_live_change",
  };
  if (missingKeys.length || unexpectedKeys.length) {
    throw new Error(`Blocked dependency: concurrent_live_change ${guard.kind} child key inventory changed before parent write under ${guard.prefix}; missing=${missingKeys.join(",") || "none"}; unexpected=${unexpectedKeys.join(",") || "none"}`);
  }
  for (const key of expectedKeys) {
    const currentIdentity = current.identities.get(key);
    const expectedIdentity = expected.get(key);
    // During the full-plan preflight a parent may depend on a child proposal
    // that deliberately has not been PUT yet.  Validate its key set now, then
    // compare its exact body at the normal per-parent guard after that child
    // has been verified.  Unstaged children must match in both passes.
    if (currentIdentity && (!allowStagedChildren || !expectedIdentity.staged)
      && currentIdentity.content_sha256 !== expectedIdentity.content_sha256) {
      throw new Error(`Blocked dependency: concurrent_live_change ${guard.kind} child content changed before parent write: ${key}`);
    }
    if (expectedIdentity.r2_etag && currentIdentity.r2_etag && expectedIdentity.r2_etag !== currentIdentity.r2_etag) {
      throw new Error(`Blocked dependency: concurrent_live_change ${guard.kind} child R2 ETag changed before parent write: ${key}`);
    }
  }
}

function exactTargetGuardSnapshot({ store, key, lookupFailureReason = "live_repair_target_lookup_failed" }) {
  const state = store.getLiveLookupState(key);
  if (state.status === "existing") {
    return {
      kind: "exact_target",
      key,
      planned_state: "existing",
      old_sha256: state.content_sha256,
      old_r2_etag: state.r2_etag || null,
      lookup_source: "live_r2_exact_get",
      lookup_failure_reason: lookupFailureReason,
      last_live_state: null,
    };
  }
  if (state.status === "missing") {
    return {
      kind: "exact_target",
      key,
      planned_state: "missing",
      old_sha256: null,
      old_r2_etag: null,
      lookup_source: "confirmed_live_404",
      lookup_failure_reason: lookupFailureReason,
      last_live_state: null,
    };
  }
  throw new Error(`blocked_dependency|${lookupFailureReason}|${key}|exact live target state was not verified`);
}

async function assertExactTargetUnchanged({ r2, guard }) {
  let current = null;
  try {
    current = await r2GetObject({ r2, key: guard.key });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!(error?.code === "OBJECT_NOT_FOUND" || message.includes("(404)"))) {
      throw new Error(`Blocked dependency: ${guard.lookup_failure_reason || "live_repair_target_lookup_failed"} ${guard.key}: ${message}`);
    }
  }
  guard.last_live_state = current
    ? {
      state: "existing",
      content_sha256: current.content_sha256 || sha256Hex(current.body),
      r2_etag: current.etag || null,
    }
    : { state: "missing", content_sha256: null, r2_etag: null };
  if (guard.planned_state === "missing") {
    if (current) {
      throw new Error(`Blocked dependency: concurrent_live_change target object was created after planning: ${guard.key}`);
    }
    return;
  }
  if (!current) {
    throw new Error(`Blocked dependency: concurrent_live_change target object disappeared after planning: ${guard.key}`);
  }
  const currentSha256 = current.content_sha256 || sha256Hex(current.body);
  if (currentSha256 !== guard.old_sha256) {
    throw new Error(`Blocked dependency: concurrent_live_change target content changed before write: ${guard.key}`);
  }
  if (guard.old_r2_etag && current.etag && guard.old_r2_etag !== current.etag) {
    throw new Error(`Blocked dependency: concurrent_live_change target R2 ETag changed before write: ${guard.key}`);
  }
}

function createStagedObjectMap({ r2, store, indexPrefixes = [], dropboxSourceKeys = [] }) {
  const proposals = new Map();
  const allowedDropboxSourceKeys = new Set(dropboxSourceKeys.map(safeLocalKey));
  const exactTargetGuardKinds = new Set([
    "pollutant_manifest",
    "connector_manifest",
    "day_manifest",
    "pollutant_timeseries_index",
    "timeseries_metadata",
    "latest_timeseries_index",
  ]);
  const indexProposalKind = (key) => key.includes("/timeseries_id=")
    ? "timeseries_metadata"
    : key.endsWith("_latest.json")
      ? "latest_timeseries_index"
      : "pollutant_timeseries_index";

  async function stage({ key, body, contentType = "application/json", kind, dayUtc = null, dependencies = [], preWriteGuard = null, targetPreWriteGuard = null, provenance = null }) {
    const bodyText = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
    const previous = proposals.get(key);
    const proposalKind = previous?.kind || kind;
    const lookupFailureReason = proposalKind === "timeseries_metadata"
      ? "live_timeseries_metadata_lookup_failed"
      : "live_repair_target_lookup_failed";
    // Prefix discovery supplies exact GET bodies for existing objects, but a
    // target absent from the listing still needs an exact GET/404 before a
    // planned create can claim that it is live-missing. Do this lazily for
    // every JSON proposal kind so lookup/auth failures never become absence.
    if (!previous && exactTargetGuardKinds.has(proposalKind)
      && store.getLiveLookupState(key).status === "unverified") {
      await hydrateLiveR2State({
        store,
        r2,
        prefixes: [],
        exactKeys: [key],
        lookupFailureReason,
      });
    }
    // Proposal changed/unchanged state and its guard must share the same exact
    // live baseline. A verified overlay remains a planning/dependency source,
    // but it cannot replace the target body's current live SHA-256 and ETag.
    const existing = previous
      ? null
      : exactTargetGuardKinds.has(proposalKind)
        ? store.getObjectFromSourceIfExists(key, "live_r2")
        : store.getLiveTargetObjectIfExists(key);
    // A proposal sink can receive the same key more than once while the
    // targeted index builder derives related metadata. Preserve the first
    // live-target baseline exactly, including an intentional null for a
    // live-missing object; never turn the previously proposed body into its
    // own old value.
    const oldBody = previous ? previous.old_body : existing?.body?.toString("utf8") ?? null;
    const oldEtag = previous ? previous.old_r2_etag : existing?.r2_etag ?? null;
    const changed = oldBody !== bodyText;
    const exactTargetGuard = exactTargetGuardKinds.has(proposalKind) && changed
      ? previous?.target_pre_write_guard || targetPreWriteGuard || exactTargetGuardSnapshot({
        store,
        key,
        lookupFailureReason,
      })
      : null;
    const metadataProvenance = proposalKind === "timeseries_metadata"
      ? {
        metadata_source: exactTargetGuard?.planned_state === "existing"
          ? "existing_live_timeseries_metadata"
          : "authoritative_core_snapshot",
        live_lookup_source: exactTargetGuard?.lookup_source || "verified_unchanged_live_target",
      }
      : null;
    const proposal = {
      key,
      kind: proposalKind,
      day_utc: previous?.day_utc || dayUtc,
      content_type: contentType,
      body: bodyText,
      bytes: Buffer.byteLength(bodyText, "utf8"),
      old_body: oldBody,
      old_sha256: oldBody === null ? null : sha256Hex(oldBody),
      old_r2_etag: oldEtag,
      new_sha256: sha256Hex(bodyText),
      changed,
      dependencies: [...new Set([...(previous?.dependencies || []), ...dependencies])].sort(),
      pre_write_guard: previous?.pre_write_guard || preWriteGuard,
      target_pre_write_guard: exactTargetGuard,
      provenance: previous?.provenance || provenance || metadataProvenance,
    };
    proposals.set(key, proposal);
    return proposal;
  }

  function stagedObject(key) {
    const proposal = proposals.get(key);
    return proposal ? objectFromBody({ key, body: proposal.body, source: "planned_overlay", content_sha256: proposal.new_sha256 }) : null;
  }

  const stagedR2 = {
    ...r2,
    proposal_sink: async ({ key, body, content_type }) => {
      await stage({ key, body, contentType: content_type, kind: indexProposalKind(key) });
    },
    adapter: {
      getObject: async ({ key }) => {
        const staged = stagedObject(key);
        if (staged) return staged;
        // Parent hierarchy and index target state both use only the live
        // snapshot/current verified overlay. Dropbox can be used for an
        // explicitly requested index-only leaf source, never by discovery.
        const object = store.getLiveTargetObjectIfExists(key)
          || (allowedDropboxSourceKeys.has(safeLocalKey(key))
            ? store.getObjectFromSourceIfExists(key, "dropbox")
            : null);
        if (object) return object;
        const error = new Error(`Combined live target object unavailable: ${key}`);
        error.code = "OBJECT_NOT_FOUND";
        throw error;
      },
      headObject: async ({ key }) => {
        const staged = stagedObject(key);
        if (staged) return { exists: true, key, bytes: staged.bytes, etag: null, content_sha256: staged.content_sha256 };
        const object = store.getLiveTargetObjectIfExists(key);
        return object ? { exists: true, key, bytes: object.bytes, etag: object.r2_etag, content_sha256: object.content_sha256 } : { exists: false, key };
      },
      listAllObjects: async ({ prefix, max_keys }) => {
        const entries = store.listLiveTargetObjects({ prefix, max_keys });
        const byKey = new Map(entries.map((entry) => [entry.key, entry]));
        for (const proposal of proposals.values()) {
          if (proposal.key.startsWith(prefix)) {
            byKey.set(proposal.key, { key: proposal.key, size: proposal.bytes, source: "planned_overlay", content_sha256: proposal.new_sha256, r2_etag: null });
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
        const proposal = await stage({ key, body, contentType: content_type, kind: indexProposalKind(key) });
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

function parquetIso(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

async function parquetFileEntry({ store, key, domain, pollutantCode }) {
  const object = store.getObject(key);
  const file = new Uint8Array(object.body).slice().buffer;
  const metadata = await parquetMetadataAsync(file);
  const rowCount = Math.max(0, Number(metadata.num_rows || 0));
  if (!rowCount) throw new Error("parquet_zero_rows");
  const schemaColumns = new Set(
    parquetSchema(metadata).children.map((column) => String(column.element.name)),
  );
  const timestampCandidates = domain === "observations"
    ? ["observed_at_utc", "observed_at"]
    : ["timestamp_hour_utc"];
  const timestampColumn = timestampCandidates.find((column) => schemaColumns.has(column));
  if (!timestampColumn) throw new Error(`parquet_timestamp_column_missing:${timestampCandidates.join("|")}`);
  let rows = [];
  await parquetRead({
    file,
    metadata,
    columns: ["timeseries_id", timestampColumn],
    rowStart: 0,
    rowEnd: rowCount,
    compressors,
    onComplete: (value) => { rows = Array.isArray(value) ? value : []; },
  });
  const counts = {};
  let minTimeseriesId = null;
  let maxTimeseriesId = null;
  let minTimestamp = null;
  let maxTimestamp = null;
  for (const row of rows) {
    const timeseriesId = Number(Array.isArray(row) ? row[0] : null);
    const timestamp = parquetIso(Array.isArray(row) ? row[1] : null);
    if (!Number.isInteger(timeseriesId) || timeseriesId <= 0 || !timestamp) {
      throw new Error("parquet_required_metadata_invalid");
    }
    const id = Math.trunc(timeseriesId);
    counts[String(id)] = (counts[String(id)] || 0) + 1;
    minTimeseriesId = minTimeseriesId === null ? id : Math.min(minTimeseriesId, id);
    maxTimeseriesId = maxTimeseriesId === null ? id : Math.max(maxTimeseriesId, id);
    minTimestamp = minTimestamp === null || timestamp < minTimestamp ? timestamp : minTimestamp;
    maxTimestamp = maxTimestamp === null || timestamp > maxTimestamp ? timestamp : maxTimestamp;
  }
  if (Object.values(counts).reduce((total, count) => total + count, 0) !== rowCount) {
    throw new Error("parquet_row_count_metadata_mismatch");
  }
  return {
    key,
    row_count: rowCount,
    bytes: object.bytes,
    etag_or_hash: sha256Hex(object.body),
    pollutant_codes: [pollutantCode],
    min_timeseries_id: minTimeseriesId,
    max_timeseries_id: maxTimeseriesId,
    ...(domain === "observations"
      ? { min_observed_at_utc: minTimestamp, max_observed_at_utc: maxTimestamp }
      : { min_timestamp_hour_utc: minTimestamp, max_timestamp_hour_utc: maxTimestamp }),
    timeseries_row_counts: counts,
  };
}

function canonicalManifestMetadata(payload, {
  manifestKey,
  domain,
  grain,
  profile,
  dayUtc,
  connectorId,
  pollutantCode,
  manifestKind,
}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || payload.history_version !== "v2"
    || payload.manifest_kind !== manifestKind
    || payload.domain !== domain
    || payload.grain !== grain
    || payload.profile !== profile
    || payload.manifest_key !== manifestKey
    || payload.day_utc !== dayUtc
    || payload.connector_id !== connectorId
    || payload.pollutant_code !== pollutantCode
    || !Array.isArray(payload.files)
    || !Array.isArray(payload.parquet_object_keys)) return null;
  const { manifest_hash: manifestHash, ...withoutHash } = payload;
  if (typeof manifestHash !== "string" || manifestHash !== sha256Hex(JSON.stringify(withoutHash))) return null;
  const backedUpAtUtc = typeof payload.backed_up_at_utc === "string" && !Number.isNaN(Date.parse(payload.backed_up_at_utc))
    ? payload.backed_up_at_utc
    : null;
  if (!backedUpAtUtc) return null;
  return {
    run_id: typeof payload.run_id === "string" || payload.run_id === null ? payload.run_id : null,
    writer_git_sha: typeof payload.writer_git_sha === "string" || payload.writer_git_sha === null ? payload.writer_git_sha : null,
    backed_up_at_utc: backedUpAtUtc,
  };
}

function sourceManifestMetadata(store, source, label, manifestKey, expectation) {
  const object = store.getObjectFromSourceIfExists(manifestKey, source);
  if (!object) return null;
  try {
    const metadata = canonicalManifestMetadata(jsonObject(object, manifestKey), { manifestKey, ...expectation });
    if (!metadata) return null;
    return {
      payload: metadata,
      provenance: {
        run_id: metadata.run_id === null ? "schema_nullable" : label,
        writer_git_sha: metadata.writer_git_sha === null ? "schema_nullable" : label,
        backed_up_at_utc: label,
        source: label,
      },
    };
  } catch {
    return null;
  }
}

function existingManifestMetadata(store, {
  manifestKey,
  base,
  dayUtc,
  connectorId,
  pollutantCode,
  domain,
}) {
  const grain = domain === "aqilevels" ? "hourly" : null;
  const profile = domain === "aqilevels" ? "data" : null;
  const leafExpectation = { domain, grain, profile, dayUtc, connectorId, pollutantCode, manifestKind: "pollutant" };
  for (const [source, label] of [["overlay", "existing_overlay_manifest"], ["live_r2", "existing_live_manifest"], ["dropbox", "dropbox_manifest"]]) {
    const found = sourceManifestMetadata(store, source, label, manifestKey, leafExpectation);
    if (found) return found;
  }

  // A canonical parent can supply equivalent writer/run provenance, but it
  // cannot supply leaf file metadata. Prefer it only after a valid same-leaf
  // copy was unavailable, and never invent a historical run ID or Git SHA.
  const parentKey = `${base}/connector_id=${connectorId}/manifest.json`;
  const parentExpectation = { domain, grain, profile, dayUtc, connectorId, pollutantCode: null, manifestKind: "connector" };
  for (const [source, label] of [["live_r2", "parent_manifest_metadata"], ["dropbox", "parent_manifest_metadata"]]) {
    const found = sourceManifestMetadata(store, source, label, parentKey, parentExpectation);
    if (found) return found;
  }

  return {
    payload: {
      run_id: null,
      writer_git_sha: null,
      // The v2 schema requires a timestamp. This deterministic timestamp is
      // explicitly repair-generated provenance, never a claim about the
      // original writer's historical backup time.
      backed_up_at_utc: `${dayUtc}T00:00:00.000Z`,
    },
    provenance: {
      run_id: "schema_nullable",
      writer_git_sha: "schema_nullable",
      backed_up_at_utc: "repair_generated",
      source: "repair_generated",
    },
  };
}

async function leafManifestSourceFromCombined({ store, base, dayUtc, connectorId, pollutantCode, domain }) {
  const pollutantPrefix = `${base}/connector_id=${connectorId}/pollutant_code=${pollutantCode}`;
  const partKeys = store.listAllObjects({ prefix: `${pollutantPrefix}/` })
    .map((entry) => entry.key)
    .filter((key) => new RegExp(`^${pollutantPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/part-\\d+\\.parquet$`).test(key))
    .sort();
  if (!partKeys.length) return { blocked_reason: "final_parquet_objects_unavailable" };
  const manifestKey = `${pollutantPrefix}/manifest.json`;
  const metadata = existingManifestMetadata(store, { manifestKey, base, dayUtc, connectorId, pollutantCode, domain });
  try {
    const files = [];
    for (const key of partKeys) files.push(await parquetFileEntry({ store, key, domain, pollutantCode }));
    return { manifestKey, payload: metadata.payload, provenance: metadata.provenance, files };
  } catch (error) {
    return { blocked_reason: `final_parquet_metadata_unreadable:${error instanceof Error ? error.message : String(error)}` };
  }
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

function assertCanonicalObjectKey(value, label) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.startsWith("/")) {
    throw new Error(`Invalid canonical R2 ${label}`);
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid canonical R2 ${label}: ${value}`);
  }
  return value;
}

function assertCanonicalManifestProposal(proposal) {
  const expectedKind = {
    pollutant_manifest: "pollutant",
    connector_manifest: "connector",
    day_manifest: "day",
  }[proposal.kind];
  if (!expectedKind) return;
  let payload;
  try {
    payload = JSON.parse(proposal.body);
  } catch {
    throw new Error(`Invalid ${proposal.kind} JSON proposal: ${proposal.key}`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`Invalid ${proposal.kind} payload: ${proposal.key}`);
  }
  const isAqi = payload.domain === "aqilevels";
  const expectedGrain = isAqi ? "hourly" : null;
  const expectedProfile = isAqi ? "data" : null;
  if (!['observations', 'aqilevels'].includes(payload.domain)
    || payload.history_version !== "v2"
    || payload.manifest_kind !== expectedKind
    || payload.manifest_key !== proposal.key
    || payload.grain !== expectedGrain
    || payload.profile !== expectedProfile) {
    throw new Error(`Invalid canonical ${proposal.kind} contract: ${proposal.key}`);
  }
  if (typeof payload.backed_up_at_utc !== "string" || Number.isNaN(Date.parse(payload.backed_up_at_utc))) {
    throw new Error(`Invalid canonical ${proposal.kind} backed_up_at_utc: ${proposal.key}`);
  }
  if (!Array.isArray(payload.files) || !Array.isArray(payload.parquet_object_keys)) {
    throw new Error(`Invalid canonical ${proposal.kind} file collection: ${proposal.key}`);
  }
  for (const entry of payload.files) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Invalid canonical ${proposal.kind} files entry: ${proposal.key}`);
    }
    assertCanonicalObjectKey(entry.key, "files[].key");
  }
  for (const key of payload.parquet_object_keys) assertCanonicalObjectKey(key, "parquet_object_keys entry");
  const { manifest_hash: manifestHash, ...withoutHash } = payload;
  if (typeof manifestHash !== "string" || manifestHash !== sha256Hex(JSON.stringify(withoutHash))) {
    throw new Error(`Invalid canonical ${proposal.kind} manifest_hash: ${proposal.key}`);
  }
}

function assertCanonicalProposal(proposal) {
  if (!proposal || typeof proposal !== "object") throw new Error("Invalid metadata proposal");
  assertCanonicalObjectKey(proposal.key, "proposal key");
  if (typeof proposal.body !== "string" || Buffer.byteLength(proposal.body, "utf8") !== proposal.bytes) {
    throw new Error(`Invalid proposal body or bytes: ${proposal.key}`);
  }
  for (const dependency of proposal.dependencies || []) assertCanonicalObjectKey(dependency, "proposal dependency");
  if (proposal.pre_write_guard) {
    if (typeof proposal.pre_write_guard !== "object" || !Array.isArray(proposal.pre_write_guard.expected_children)) {
      throw new Error(`Invalid proposal pre-write guard: ${proposal.key}`);
    }
    assertCanonicalObjectKey(proposal.pre_write_guard.prefix, "pre-write guard prefix");
    for (const child of proposal.pre_write_guard.expected_children) {
      assertCanonicalObjectKey(child?.key, "pre-write guard child key");
    }
  }
  if (proposal.target_pre_write_guard) {
    const guard = proposal.target_pre_write_guard;
    if (guard.kind !== "exact_target"
      || guard.key !== proposal.key
      || !["existing", "missing"].includes(guard.planned_state)
      || !["live_r2_exact_get", "confirmed_live_404"].includes(guard.lookup_source)
      || typeof guard.lookup_failure_reason !== "string"
      || (guard.planned_state === "existing" && !/^[a-f0-9]{64}$/.test(String(guard.old_sha256 || "")))
      || (guard.planned_state === "existing" && guard.old_sha256 !== proposal.old_sha256)
      || (guard.planned_state === "existing" && guard.old_r2_etag !== proposal.old_r2_etag)
      || (guard.planned_state === "missing" && (guard.old_sha256 !== null || guard.old_r2_etag !== null))) {
      throw new Error(`Invalid proposal target pre-write guard: ${proposal.key}`);
    }
  }
  assertCanonicalManifestProposal(proposal);
  if (!proposal.kind.endsWith("manifest")) {
    try {
      const payload = JSON.parse(proposal.body);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("payload is not an object");
      }
    } catch (error) {
      throw new Error(`Invalid canonical ${proposal.kind} proposal: ${proposal.key} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
}

function assertCanonicalProposalRelationships(proposal, proposals) {
  const guard = proposal.pre_write_guard;
  if (!guard) return;
  const stagedKind = {
    pollutant: "pollutant_manifest",
    connector: "connector_manifest",
  }[guard.kind];
  for (const child of guard.expected_children) {
    if (!child?.staged) continue;
    const staged = proposals.get(child.key);
    if (!stagedKind
      || !child.key.startsWith(guard.prefix)
      || child.source !== "planned_overlay"
      || child.r2_etag !== null
      || !staged
      || staged.kind !== stagedKind
      || !/^[a-f0-9]{64}$/.test(String(child.content_sha256 || ""))
      || staged.new_sha256 !== child.content_sha256
      || !(proposal.dependencies || []).includes(child.key)) {
      throw new Error(`Invalid staged child proposal dependency: ${proposal.key} -> ${child?.key || "(missing)"}`);
    }
  }
}

function applicationFailureResults(ordered, failedProposal, error, failureStage) {
  const results = new Map();
  for (const proposal of ordered) {
    const failed = proposal === failedProposal;
    results.set(proposal.key, {
      key: proposal.key,
      kind: proposal.kind,
      status: failed ? "failed" : "not_run_due_to_dependency",
      put_attempted: false,
      put_completed: false,
      get_verification_attempted: false,
      get_verification_succeeded: false,
      verification: failed ? "failed" : "not_run",
      failure_stage: failed ? failureStage : "dependency",
      error: failed ? error : null,
    });
  }
  return results;
}

export async function applyStagedProposals({
  r2,
  proposals,
  writeR2,
  assertChildren = assertCompleteChildrenUnchanged,
  assertTarget = assertExactTargetUnchanged,
  putObject = r2PutObject,
  getObject = r2GetObject,
}) {
  const results = new Map();
  const rank = {
    pollutant_manifest: 1,
    connector_manifest: 2,
    day_manifest: 3,
    pollutant_timeseries_index: 4,
    timeseries_metadata: 5,
    latest_timeseries_index: 6,
  };
  const ordered = [...proposals.values()].sort((left, right) =>
    (rank[left.kind] || 99) - (rank[right.kind] || 99) || left.key.localeCompare(right.key)
  );
  // Pass 1: a repair plan is atomic with respect to proposal validity. Check
  // every proposal body and every staged-child relationship before any live
  // dependency guard (and therefore before the first possible PUT).
  for (const proposal of ordered) {
    try {
      assertCanonicalProposal(proposal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        results: applicationFailureResults(ordered, proposal, message, "proposal_preflight"),
        failure: { key: proposal.key, error: message },
      };
    }
  }
  for (const proposal of ordered) {
    try {
      assertCanonicalProposalRelationships(proposal, proposals);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        results: applicationFailureResults(ordered, proposal, message, "proposal_preflight"),
        failure: { key: proposal.key, error: message },
      };
    }
  }
  // Pass 2: probe every dependency against the current live inventory. Exact
  // staged children may be read as raw identities here because their canonical
  // replacement bodies passed Pass 1. The normal per-parent write guard below
  // receives no relaxation and fully validates the written child.
  const validatedStagedProposalKeys = new Set(ordered.map((proposal) => proposal.key));
  for (const proposal of ordered) {
    if (!proposal.pre_write_guard && !proposal.target_pre_write_guard) continue;
    try {
      if (proposal.pre_write_guard) {
        await assertChildren({
          r2,
          guard: proposal.pre_write_guard,
          allowStagedChildren: true,
          validatedStagedProposalKeys,
        });
      }
      if (proposal.target_pre_write_guard) {
        await assertTarget({ r2, guard: proposal.target_pre_write_guard });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        results: applicationFailureResults(ordered, proposal, message, "proposal_preflight"),
        failure: { key: proposal.key, error: message },
      };
    }
  }
  for (let position = 0; position < ordered.length; position += 1) {
    const proposal = ordered[position];
    if (!proposal.changed) {
      results.set(proposal.key, { key: proposal.key, kind: proposal.kind, status: "skipped_unchanged", put_attempted: false, put_completed: false, get_verification_attempted: false, get_verification_succeeded: false, verification: "not_run", failure_stage: null, error: null });
      continue;
    }
    if (!writeR2) {
      results.set(proposal.key, { key: proposal.key, kind: proposal.kind, status: "planned", put_attempted: false, put_completed: false, get_verification_attempted: false, get_verification_succeeded: false, verification: "not_run", failure_stage: null, error: null });
      continue;
    }
    let phase = "initial";
    let putAttempted = false;
    let putCompleted = false;
    let getVerificationAttempted = false;
    let getVerificationSucceeded = false;
    try {
      if (proposal.pre_write_guard) {
        phase = "pre_write_guard";
        await assertChildren({ r2, guard: proposal.pre_write_guard });
      }
      if (proposal.target_pre_write_guard) {
        phase = "target_pre_write_guard";
        await assertTarget({ r2, guard: proposal.target_pre_write_guard });
      }
      phase = "put";
      putAttempted = true;
      await putObject({ r2, key: proposal.key, body: proposal.body, content_type: proposal.content_type });
      putCompleted = true;
      phase = "get";
      getVerificationAttempted = true;
      const fresh = await getObject({ r2, key: proposal.key });
      phase = "body_verification";
      if (fresh.bytes !== proposal.bytes || fresh.body.toString("utf8") !== proposal.body) {
        throw new Error(`Verification failed for ${proposal.key}`);
      }
      getVerificationSucceeded = true;
      phase = "complete";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.set(proposal.key, {
        key: proposal.key,
        kind: proposal.kind,
        status: "failed",
        put_attempted: putAttempted,
        put_completed: putCompleted,
        get_verification_attempted: getVerificationAttempted,
        get_verification_succeeded: getVerificationSucceeded,
        verification: "failed",
        failure_stage: phase,
        error: message,
      });
      for (const remaining of ordered.slice(position + 1)) results.set(remaining.key, { key: remaining.key, kind: remaining.kind, status: "not_run_due_to_dependency", put_attempted: false, put_completed: false, get_verification_attempted: false, get_verification_succeeded: false, verification: "not_run", failure_stage: "dependency", error: null });
      return { results, failure: { key: proposal.key, error: error instanceof Error ? error.message : String(error) } };
    }
    results.set(proposal.key, { key: proposal.key, kind: proposal.kind, status: "succeeded", put_attempted: true, put_completed: true, get_verification_attempted: true, get_verification_succeeded: true, verification: "succeeded", failure_stage: null, error: null });
  }
  return { results, failure: null };
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

export function normalizePlan(input) {
  const { inputKind, domain, actions } = extractRepairPlan(input);
  const scopes = new Map();
  for (const action of actions) {
    validateAction(action);
    const dayUtc = String(action.day_utc || "");
    const rule = ACTION_SCOPE_RULES[action.kind];
    const hasConnector = action.connector_id !== undefined && action.connector_id !== null;
    const connectorId = hasConnector ? Number(action.connector_id) : null;
    const pollutantCode = typeof action.pollutant_code === "string"
      ? action.pollutant_code.trim().toLowerCase()
      : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayUtc)) {
      throw new Error(`Repair action ${action.kind} must have day_utc`);
    }
    if (rule.connector === "required" && (!Number.isInteger(connectorId) || connectorId <= 0)) {
      throw new Error(`Repair action ${action.kind} must have day_utc and positive connector_id`);
    }
    if (rule.connector === "absent" && hasConnector) {
      throw new Error(`Repair action ${action.kind} must have day_utc and no connector_id`);
    }
    if (rule.pollutant === "required" && !pollutantCode) {
      throw new Error(`Repair action ${action.kind} must have pollutant_code`);
    }
    const key = rule.connector === "absent" ? `${dayUtc}|day` : `${dayUtc}|${connectorId}`;
    const scope = scopes.get(key) || {
      dayUtc,
      connectorId,
      needsConnector: false,
      needsDay: false,
      needsIndex: false,
      pollutantRepair: false,
      pollutantManifestCodes: new Set(),
      indexPollutantCodes: new Set(),
      gapTypes: new Set(),
    };
    scope.needsConnector ||= Boolean(rule.needsConnector);
    scope.needsDay ||= Boolean(rule.needsDay);
    scope.needsIndex ||= Boolean(action.requires_index_rebuild) || action.kind.includes("index");
    scope.pollutantRepair ||= Boolean(rule.pollutantRepair);
    // A direct index repair can share a connector/day scope with manifest
    // repairs, but it must never promote its valid pollutant manifest into a
    // manifest rewrite.  Track leaf-manifest and index-only codes separately.
    if (pollutantCode && rule.pollutantRepair) {
      scope.pollutantManifestCodes.add(pollutantCode);
    }
    if (pollutantCode && action.kind.includes("index")) {
      scope.indexPollutantCodes.add(pollutantCode);
    }
    for (const gapType of action.gap_types) scope.gapTypes.add(gapType);
    scopes.set(key, scope);
  }
  return {
    inputKind,
    domain,
    scopes: [...scopes.values()]
      .sort((left, right) => left.dayUtc.localeCompare(right.dayUtc) || (left.connectorId ?? -1) - (right.connectorId ?? -1))
      .map(({ gapTypes, pollutantManifestCodes, indexPollutantCodes, ...scope }) => ({
        ...scope,
        gap_types: [...gapTypes].sort(),
        pollutant_codes: [...pollutantManifestCodes].sort(),
        index_pollutant_codes: [...indexPollutantCodes].sort(),
      })),
  };
}

function authoritativeTimeseriesById(input) {
  const bindings = new Map();
  for (const raw of Array.isArray(input?.authoritative_core_timeseries)
    ? input.authoritative_core_timeseries
    : []) {
    const timeseriesId = Number(raw?.timeseries_id);
    const connectorId = Number(raw?.connector_id);
    const pollutantCode = String(raw?.pollutant_code || "").trim().toLowerCase();
    if (!Number.isInteger(timeseriesId) || timeseriesId <= 0
      || !Number.isInteger(connectorId) || connectorId <= 0 || !pollutantCode) continue;
    bindings.set(String(timeseriesId), {
      timeseries_id: timeseriesId,
      connector_id: connectorId,
      pollutant_code: pollutantCode,
      phenomenon_id: raw?.phenomenon_id ?? null,
      observed_property_id: raw?.observed_property_id ?? null,
    });
  }
  return bindings;
}

export async function runV2ObservationsRepair({
  argv = process.argv.slice(2),
  env = process.env,
  repairPlan = null,
  updateIndexes = updateR2HistoryIndexesTargeted,
} = {}) {
  const args = repairPlan
    ? {
      writeR2: argv.includes("--write-r2"),
      overlayRoot: String(env.UK_AQ_HISTORY_INTEGRITY_OVERLAY_ROOT || ""),
      dropboxRoot: String(env.UK_AQ_R2_HISTORY_DROPBOX_ROOT || ""),
      runStateJson: String(env.UK_AQ_HISTORY_INTEGRITY_RUN_STATE_JSON || ""),
    }
    : parseArgs(argv);
  const input = repairPlan || JSON.parse(
    args.repairPlanStdin
      ? fs.readFileSync(0, "utf8")
      : fs.readFileSync(args.repairPlanJson, "utf8"),
  );
  const { inputKind, domain, scopes } = normalizePlan(input); // Validate all actions before the first R2 request.
  const coreTimeseries = authoritativeTimeseriesById(input);
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
  if (!args.overlayRoot || !args.dropboxRoot || !args.runStateJson) {
    throw new Error("Combined local resolver paths are required for metadata repair");
  }
  const dataPrefix = domain === "observations"
    ? config.observations_prefix_v2
    : config.aqilevels_hourly_data_prefix_v2;
  const indexPrefix = domain === "observations"
    ? config.observations_timeseries_index_prefix_v2
    : config.aqilevels_hourly_data_timeseries_index_prefix_v2;
  // Targeted index rebuilds merge the changed days into this global latest
  // summary.  Read exactly that key from the Dropbox baseline; scanning the
  // whole index tree would make the sparse overlay resolver non-deterministic.
  const latestIndexKey = domain === "observations"
    ? `${config.index_prefix_v2}/observations_timeseries_latest.json`
    : `${config.index_prefix_v2}/aqilevels_hourly_data_timeseries_latest.json`;
  // An explicit index-only action can legitimately target a historical leaf
  // which is absent from the live connector/day hierarchy. Keep that leaf
  // out of parent discovery, but allow its Dropbox manifest as a narrowly
  // scoped index source. The target index itself is still live-only.
  const additionalIndexPollutantTargets = domain === "observations"
    ? scopes.flatMap((scope) => (scope.needsIndex && Number.isInteger(scope.connectorId) && scope.connectorId > 0
      ? (scope.index_pollutant_codes || []).map((pollutantCode) => ({
        day_utc: scope.dayUtc,
        connector_id: scope.connectorId,
        pollutant_code: pollutantCode,
        manifest_key: `${dataPrefix}/day_utc=${scope.dayUtc}/connector_id=${scope.connectorId}/pollutant_code=${pollutantCode}/manifest.json`,
      }))
      : []))
    : [];
  const localStore = createCombinedLocalStore({
    ...args,
    prefixes: [...new Set(scopes.flatMap((scope) => [
      `${dataPrefix}/day_utc=${scope.dayUtc}`,
      `${indexPrefix}/day_utc=${scope.dayUtc}`,
    ]))],
    exactKeys: [latestIndexKey],
    dynamicExactKeyPrefixes: [config.timeseries_metadata_index_prefix_v2],
  });
  // The Dropbox mirror is a reconstruction/provenance source, never the
  // authority for whether a target exists or has changed. Hydrate this narrow
  // day/index view from live R2 before planning so parents retain every live
  // sibling and a live-missing index cannot be reported unchanged merely
  // because an older Dropbox copy exists.
  await hydrateLiveR2State({
    store: localStore,
    r2: config.r2,
    prefixes: [...new Set(scopes.flatMap((scope) => [
      `${dataPrefix}/day_utc=${scope.dayUtc}`,
      `${indexPrefix}/day_utc=${scope.dayUtc}`,
    ]))],
    exactKeys: [latestIndexKey],
  });
  const staged = createStagedObjectMap({
    r2: config.r2,
    store: localStore,
    indexPrefixes: [config.index_prefix_v2, indexPrefix, config.timeseries_metadata_index_prefix_v2]
      .filter(Boolean)
      .map((prefix) => `${String(prefix).replace(/\/+$/, "")}/`),
    dropboxSourceKeys: additionalIndexPollutantTargets.map((target) => target.manifest_key),
  });
  const dayPlans = [];
  const blockedScopes = [];
  const blockedConnectorScopes = new Set();
  const plannedStageStatus = args.writeR2 ? "not_run" : "planned";
  const manifestStageStatus = (proposalKeys) => proposalKeys.some((key) =>
    String(staged.proposals.get(key)?.kind || "").endsWith("manifest")
  ) ? plannedStageStatus : "not_run";

  for (const [dayUtc, dayScopes] of [...byDay.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const base = `${dataPrefix}/day_utc=${dayUtc}`;
    const proposalKeys = [];
    // Pollutant manifests are the leaf metadata layer.  Rebuild them before
    // connector/day manifests so a malformed child cannot be preserved by a
    // newly generated parent.  The writer records complete per-part metadata
    // in `files`; its parquet objects are the immutable data dependency.
    for (const scope of dayScopes.filter((value) => value.pollutantRepair).sort((left, right) => left.connectorId - right.connectorId)) {
      const wanted = new Set(scope.pollutant_codes || []);
      const partEntries = localStore.listAllObjects({ prefix: `${base}/connector_id=${scope.connectorId}/pollutant_code=` });
      const availableCodes = [...new Set(partEntries.map((entry) => {
        const match = entry.key.match(/\/pollutant_code=([^/]+)\/part-\d+\.parquet$/);
        return match ? decodeURIComponent(match[1]).toLowerCase() : null;
      }).filter(Boolean))].sort();
      const selectedCodes = availableCodes.filter((code) => !wanted.size || wanted.has(code));
      const missingRequested = [...wanted].filter((code) => !availableCodes.includes(code));
      for (const pollutantCode of missingRequested) {
        blockedScopes.push({ ...scope, pollutant_code: pollutantCode, status: "blocked_dependency", reason: "final_parquet_objects_unavailable" });
        blockedConnectorScopes.add(`${dayUtc}|${scope.connectorId}`);
      }
      if (!selectedCodes.length) {
        const blocked = { ...scope, status: "blocked_dependency", reason: "final_parquet_objects_unavailable" };
        blockedScopes.push(blocked);
        blockedConnectorScopes.add(`${dayUtc}|${scope.connectorId}`);
        continue;
      }
      for (const pollutantCode of selectedCodes) {
        const source = await leafManifestSourceFromCombined({ store: localStore, base, dayUtc, connectorId: scope.connectorId, pollutantCode, domain });
        if (source.blocked_reason) {
          const blocked = { ...scope, pollutant_code: pollutantCode, status: "blocked_dependency", reason: source.blocked_reason };
          blockedScopes.push(blocked);
          blockedConnectorScopes.add(`${dayUtc}|${scope.connectorId}`);
          continue;
        }
        const { manifestKey, payload, provenance, files } = source;
        const rebuilt = buildHistoryV2PollutantManifest({
          domain,
          grain: domain === "aqilevels" ? "hourly" : null,
          profile: domain === "aqilevels" ? "data" : null,
          dayUtc,
          connectorId: scope.connectorId,
          pollutantCode,
          runId: payload.run_id || null,
          manifestKey,
          sourceRowCount: files.reduce((total, entry) => total + Number(entry.row_count || 0), 0),
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
          provenance,
        });
        proposalKeys.push(manifestKey);
      }
    }
    for (const scope of dayScopes.filter((value) => value.needsConnector).sort((left, right) => left.connectorId - right.connectorId)) {
      if (blockedConnectorScopes.has(`${dayUtc}|${scope.connectorId}`)) {
        blockedScopes.push({ ...scope, status: "blocked_dependency", reason: "pollutant_manifest_dependency_blocked" });
        continue;
      }
      const child = await readChildren({ store: staged.stagedR2.adapter, prefix: `${base}/connector_id=${scope.connectorId}/pollutant_code=`, dayUtc, connectorId: scope.connectorId, kind: "pollutant", domain });
      const key = `${base}/connector_id=${scope.connectorId}/manifest.json`;
      const payload = buildHistoryV2ConnectorManifest({ domain, grain: domain === "aqilevels" ? "hourly" : null, profile: domain === "aqilevels" ? "data" : null, dayUtc, connectorId: scope.connectorId, runId: child.children[0].run_id, manifestKey: key, pollutantManifests: child.children, writerGitSha: child.children[0].writer_git_sha, backedUpAtUtc: child.children.map((value) => value.backed_up_at_utc).sort().at(-1) || null });
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
          store: localStore,
        }),
      });
      proposalKeys.push(key);
    }

    const needsDay = dayScopes.some((scope) => scope.needsDay);
    let dayManifest = null;
    let dayManifestKey = `${base}/manifest.json`;
    const dayBlocked = [...blockedConnectorScopes].some((scopeKey) => scopeKey.startsWith(`${dayUtc}|`));
    if (dayBlocked) {
      blockedScopes.push({ day_utc: dayUtc, status: "blocked_dependency", reason: "connector_manifest_dependency_blocked" });
      dayPlans.push({ day_utc: dayUtc, status: "blocked_dependency", manifest_status: "blocked_dependency", index_status: "blocked_dependency", scopes: dayScopes, blocked_scopes: blockedScopes.filter((scope) => scope.dayUtc === dayUtc || scope.day_utc === dayUtc), proposal_keys: [], index: null });
      continue;
    }
    if (needsDay) {
      const child = await readChildren({ store: staged.stagedR2.adapter, prefix: `${base}/connector_id=`, dayUtc, kind: "connector", domain });
      dayManifest = buildHistoryV2DayManifest({ domain, grain: domain === "aqilevels" ? "hourly" : null, profile: domain === "aqilevels" ? "data" : null, dayUtc, runId: child.children[0].run_id, manifestKey: dayManifestKey, connectorManifests: child.children, writerGitSha: child.children[0].writer_git_sha, backedUpAtUtc: child.children.map((value) => value.backed_up_at_utc).sort().at(-1) || null });
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
          store: localStore,
        }),
      });
      proposalKeys.push(dayManifestKey);
    } else {
      const existingDay = localStore.getObjectIfExists(dayManifestKey);
      dayManifest = existingDay ? jsonObject(existingDay, dayManifestKey) : null;
    }

    let index = null;
    const indexRequested = dayScopes.some((scope) => scope.needsIndex);
    // Parent manifests only describe their already-final children.  Their
    // hash is not a dependency of a pollutant timeseries index, so a
    // connector-less day-manifest repair must never expand into every
    // connector/pollutant index for that day.  Every index-producing action
    // has a connector scope; fail closed if that contract is ever broken.
    const indexConnectorIds = [...new Set(dayScopes
      .filter((scope) => scope.needsIndex)
      .map((scope) => Number(scope.connectorId))
      .filter((connectorId) => Number.isInteger(connectorId) && connectorId > 0))]
      .sort((left, right) => left - right);
    if (indexRequested && !indexConnectorIds.length) {
      blockedScopes.push({
        status: "blocked_dependency",
        day_utc: dayUtc,
        reason: "targeted_index_scope_missing_connector",
      });
      dayPlans.push({
        day_utc: dayUtc,
        status: "blocked_dependency",
        manifest_status: manifestStageStatus(proposalKeys),
        index_status: "blocked_dependency",
        scopes: dayScopes,
        blocked_scopes: blockedScopes.filter((scope) => scope.dayUtc === dayUtc || scope.day_utc === dayUtc),
        proposal_keys: [],
        index: null,
      });
      continue;
    }
    if (indexRequested) {
      const proposalSnapshot = new Map(staged.proposals);
      try {
        const results = [];
        for (const connectorId of indexConnectorIds) {
          results.push(await updateIndexes({
            env,
            r2: staged.stagedR2,
            historyVersion: "v2",
            domains: [domain],
            fromDayUtc: dayUtc,
            toDayUtc: dayUtc,
            connectorId,
            generatedAt: stableGeneratedAt({ dayUtc, dayManifest }),
            strictMissingTimeseriesCounts: true,
            timeseriesMetadataMode: "targeted",
            proposalOnly: !args.writeR2,
            writeR2: true,
            authoritativeTimeseriesById: coreTimeseries,
            prepareTimeseriesMetadataTargets: async ({ metadata_keys: metadataKeys }) => {
              await hydrateLiveR2State({
                store: localStore,
                r2: config.r2,
                prefixes: [],
                exactKeys: metadataKeys,
                lookupFailureReason: "live_timeseries_metadata_lookup_failed",
              });
            },
            additionalPollutantManifestTargets: additionalIndexPollutantTargets.filter((target) =>
              target.day_utc === dayUtc && target.connector_id === connectorId
            ),
          }));
        }
        const metadataResults = results.map((result) => result?.timeseries_metadata).filter(Boolean);
        index = {
          status: "planned",
          connector_ids: indexConnectorIds,
          results,
          timeseries_metadata: {
            status: metadataResults.some((result) => result.status === "blocked_dependency")
              ? "blocked_dependency"
              : "planned",
            blocked_scopes: metadataResults.flatMap((result) => result.blocked_scopes || []),
            metadata_object_count: metadataResults.reduce((total, result) => total + Number(result.metadata_object_count || 0), 0),
            existing_object_merged_count: metadataResults.reduce((total, result) => total + Number(result.existing_object_merged_count || 0), 0),
            new_object_count: metadataResults.reduce((total, result) => total + Number(result.new_object_count || 0), 0),
            unchanged_object_count: metadataResults.reduce((total, result) => total + Number(result.unchanged_object_count || 0), 0),
          },
        };
      } catch (error) {
        staged.proposals.clear();
        for (const [key, proposal] of proposalSnapshot) staged.proposals.set(key, proposal);
        const message = error instanceof Error ? error.message : String(error);
        const parts = message.split("|");
        blockedScopes.push({
          status: "blocked_dependency",
          day_utc: dayUtc,
          reason: parts[1] || "required_index_child_unreadable",
          path: parts[2] || null,
          detail: message,
        });
        dayPlans.push({ day_utc: dayUtc, status: "blocked_dependency", manifest_status: manifestStageStatus(proposalKeys), index_status: "blocked_dependency", scopes: dayScopes, blocked_scopes: blockedScopes.filter((scope) => scope.dayUtc === dayUtc || scope.day_utc === dayUtc), proposal_keys: [], index: null });
        continue;
      }
      if (index?.timeseries_metadata?.status === "blocked_dependency") {
        staged.proposals.clear();
        for (const [key, proposal] of proposalSnapshot) staged.proposals.set(key, proposal);
        for (const blocked of index.timeseries_metadata.blocked_scopes || []) {
          blockedScopes.push({ day_utc: dayUtc, ...blocked });
        }
        dayPlans.push({ day_utc: dayUtc, status: "blocked_dependency", manifest_status: manifestStageStatus(proposalKeys), index_status: "blocked_dependency", scopes: dayScopes, blocked_scopes: blockedScopes.filter((scope) => scope.dayUtc === dayUtc || scope.day_utc === dayUtc), proposal_keys: [], index });
        continue;
      }
      for (const key of staged.proposals.keys()) {
        if (!proposalSnapshot.has(key)) proposalKeys.push(key);
      }
    }
    dayPlans.push({
      day_utc: dayUtc,
      status: "planned",
      manifest_status: manifestStageStatus(proposalKeys),
      index_status: indexRequested ? plannedStageStatus : "not_run",
      scopes: dayScopes,
      blocked_scopes: [],
      proposal_keys: [...new Set(proposalKeys)].sort(),
      index,
    });
  }

  // The shared builder plans a latest summary while it is constructing the
  // targeted merge. Apply it last, after all lower-level index and metadata
  // proposals have completed their PUT-and-GET verification.
  const latestKeys = new Set(dayPlans.map((plan) => {
    const domainResult = domain === "observations"
      ? plan.index?.observations_timeseries
      : plan.index?.aqilevels_timeseries;
    return domainResult?.latest_index_key;
  }).filter(Boolean));
  for (const key of latestKeys) {
    const proposal = staged.proposals.get(key);
    if (proposal) {
      staged.proposals.delete(key);
      const dependencies = [...staged.proposals.values()]
        .filter((candidate) => ["pollutant_timeseries_index", "timeseries_metadata"].includes(candidate.kind))
        .map((candidate) => candidate.key)
        .sort();
      staged.proposals.set(key, {
        ...proposal,
        kind: "latest_timeseries_index",
        dependencies: [...new Set([...(proposal.dependencies || []), ...dependencies])].sort(),
      });
    }
  }
  const appliedResult = await applyStagedProposals({ r2: config.r2, proposals: staged.proposals, writeR2: args.writeR2 });
  const applied = appliedResult.results;
  const proposalViews = [...staged.proposals.values()].map(proposalView).sort((left, right) => left.key.localeCompare(right.key));
  const applicationOperations = [...applied.values()].sort((left, right) => left.key.localeCompare(right.key));
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
  const status = appliedResult.failure ? "failed" : (blockedScopes.length
    ? "blocked_dependency"
    : reduceRepairStatus(topLevelStatuses, args.writeR2 ? "not_run" : "planned"));
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
    manifest_status: reduceRepairStatus(dayPlans.map((plan) => plan.manifest_status || "not_run"), "not_run"),
    index_status: reduceRepairStatus(dayPlans.map((plan) => plan.index_status || "not_run"), "not_run"),
    bucket: config.r2.bucket,
    planning: { status: "planned", input_kind: inputKind, domain, scopes, days: dayPlans, proposals: proposalViews, blocked_scopes: blockedScopes },
    execution: { status: executionStatus },
    verification: { status: verificationStatus },
    application_failure: appliedResult.failure,
    application: {
      status: appliedResult.failure ? "partial" : (args.writeR2 ? "succeeded" : "planned"),
      operations: applicationOperations,
      failure: appliedResult.failure,
    },
    results,
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) runV2ObservationsRepair().then((output) => {
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!output.ok) process.exitCode = 1;
}).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exit(1); });
