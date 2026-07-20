#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  hasRequiredR2Config,
  r2DeleteObjects,
  r2GetObject,
  r2ListAllObjects,
  r2PutObject,
  sha256Hex,
} from "../../workers/shared/r2_sigv4.mjs";
import { resolveR2HistoryIndexConfig } from "../../workers/shared/uk_aq_r2_history_index.mjs";

const TEST_BUCKET = "uk-aq-history-cic-test";

function parseArgs(argv) {
  const args = { runStateJson: "", writeR2: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--run-state-json") args.runStateJson = String(argv[++index] || "");
    else if (arg === "--write-r2") args.writeR2 = true;
    else throw new Error(`Unknown arg: ${arg}`);
  }
  if (!args.runStateJson) throw new Error("--run-state-json is required");
  if (!args.writeR2) throw new Error("canonical apply requires --write-r2");
  return args;
}

function safeKey(rawKey) {
  const key = String(rawKey || "").replace(/^\/+/, "");
  if (!key || key.split("/").some((part) => part === "..")) {
    throw new Error(`Unsafe canonical object key: ${rawKey}`);
  }
  return key;
}

function atomicWriteJson(filePath, value) {
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function contentTypeForKey(key) {
  if (key.endsWith(".json")) return "application/json; charset=utf-8";
  if (key.endsWith(".parquet")) return "application/vnd.apache.parquet";
  return "application/octet-stream";
}

function objectDomain(key) {
  if (key.includes("/aqilevels_") || key.includes("/aqilevels/")) return "aqilevels";
  return "observations";
}

function objectRank(key) {
  const domainOffset = objectDomain(key) === "aqilevels" ? 100 : 0;
  if (key.endsWith(".parquet")) return domainOffset + 10;
  if (/\/pollutant_code=[^/]+\/manifest\.json$/.test(key)) return domainOffset + 20;
  if (/\/connector_id=\d+\/manifest\.json$/.test(key)) return domainOffset + 30;
  if (/\/day_utc=\d{4}-\d{2}-\d{2}\/manifest\.json$/.test(key)) return domainOffset + 40;
  if (/\/pollutant_code=[^/]+\.json$/.test(key)) return domainOffset + 50;
  if (key.endsWith("/latest.json")) return domainOffset + 60;
  return domainOffset + 55;
}

const CANONICAL_CONNECTOR_DAY_PREFIX_PATTERNS = Object.freeze([
  /^history\/v2\/observations\/day_utc=(\d{4}-\d{2}-\d{2})\/connector_id=([1-9]\d*)$/,
  /^history\/v2\/aqilevels\/hourly\/data\/day_utc=(\d{4}-\d{2}-\d{2})\/connector_id=([1-9]\d*)$/,
  /^history\/v2\/aqilevels\/hourly\/debug\/day_utc=(\d{4}-\d{2}-\d{2})\/connector_id=([1-9]\d*)$/,
]);

function assertCanonicalConnectorDayPrefix(prefix) {
  const match = CANONICAL_CONNECTOR_DAY_PREFIX_PATTERNS
    .map((pattern) => prefix.match(pattern))
    .find(Boolean);
  if (!match) {
    throw new Error(`Deletion prefix is outside the canonical connector-day allowlist: ${prefix}`);
  }
  const [, dayUtc, connectorIdRaw] = match;
  const parsedDay = new Date(`${dayUtc}T00:00:00.000Z`);
  if (Number.isNaN(parsedDay.getTime()) || parsedDay.toISOString().slice(0, 10) !== dayUtc) {
    throw new Error(`Deletion prefix has an invalid UTC day: ${prefix}`);
  }
  const connectorId = Number(connectorIdRaw);
  if (!Number.isSafeInteger(connectorId) || connectorId <= 0 || String(connectorId) !== connectorIdRaw) {
    throw new Error(`Deletion prefix has an invalid connector ID: ${prefix}`);
  }
}

function dependencyIdentity(entry, dependencyKey) {
  const identities = entry?.dependency_identities;
  if (!identities || typeof identities !== "object" || Array.isArray(identities)) return null;
  const identity = identities[dependencyKey];
  if (!identity || typeof identity !== "object") return null;
  const sha256 = String(identity.sha256 || "").trim().toLowerCase();
  const bytes = Number(identity.bytes);
  if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(bytes) || bytes < 0) return null;
  return { sha256, bytes };
}

export function validateLocalProposal(runState) {
  if (!runState || typeof runState !== "object") throw new Error("run state must be an object");
  if (runState.environment !== "CIC-Test") {
    throw new Error(`Refusing canonical apply outside CIC-Test: ${runState.environment || "(unset)"}`);
  }
  const objects = Object.entries(runState.objects || {}).sort(([left], [right]) => left.localeCompare(right));
  const prefixes = Array.isArray(runState.tombstone_prefixes) ? runState.tombstone_prefixes : [];
  if (!objects.length && !prefixes.length) throw new Error("canonical proposal has no planned operations");
  const normalizedObjects = [];
  const proposedPrefixes = prefixes
    .filter((entry) => entry?.proposed)
    .map((entry) => `${safeKey(entry.prefix).replace(/\/+$/, "")}/`);
  for (const [rawKey, entry] of objects) {
    const key = safeKey(rawKey);
    if (!(key.startsWith("history/v2/") || key.startsWith("history/_index_v2/"))
      || /\/(?:generation(?:=)|transactions\/)/.test(`/${key}`)) {
      throw new Error(`Non-canonical Integrity proposal key: ${key}`);
    }
    if (!entry?.proposed || !entry?.built || !entry?.structurally_validated) {
      throw new Error(`Local structural validation is incomplete: ${key}`);
    }
    const localPath = String(entry.local_path || "");
    if (!localPath || !fs.statSync(localPath, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Local proposal body is missing: ${key}`);
    }
    const body = fs.readFileSync(localPath);
    if (body.byteLength !== Number(entry.bytes) || sha256Hex(body) !== entry.sha256) {
      throw new Error(`Local proposal identity changed after validation: ${key}`);
    }
    for (const dependency of entry.dependencies || []) {
      const dependencyKey = safeKey(dependency);
      const stagedDependency = runState.objects?.[dependencyKey];
      if (stagedDependency) {
        if (!stagedDependency.structurally_validated
          || !fs.statSync(String(stagedDependency.local_path || ""), { throwIfNoEntry: false })?.isFile()) {
          throw new Error(`Local proposal dependency is not structurally validated: ${key} -> ${dependencyKey}`);
        }
      } else {
        const expectedIdentity = dependencyIdentity(entry, dependencyKey);
        if (!expectedIdentity) {
          throw new Error(`Dropbox baseline dependency identity is not pinned: ${key} -> ${dependencyKey}`);
        }
        if (proposedPrefixes.some((prefix) => dependencyKey.startsWith(prefix))) {
          throw new Error(`Proposed deletion would remove an unstaged dependency: ${key} -> ${dependencyKey}`);
        }
        const baselinePath = path.join(String(runState.base_dropbox_root || ""), dependencyKey);
        if (!fs.statSync(baselinePath, { throwIfNoEntry: false })?.isFile()) {
          throw new Error(`Dropbox baseline dependency is unavailable: ${key} -> ${dependencyKey}`);
        }
        const baselineBody = fs.readFileSync(baselinePath);
        if (baselineBody.byteLength !== expectedIdentity.bytes || sha256Hex(baselineBody) !== expectedIdentity.sha256) {
          throw new Error(`Dropbox baseline dependency identity changed after planning: ${key} -> ${dependencyKey}`);
        }
      }
    }
    normalizedObjects.push({ key, entry, localPath, body, domain: objectDomain(key) });
  }
  const normalizedPrefixes = prefixes.map((entry) => {
    const prefix = safeKey(entry?.prefix).replace(/\/+$/, "");
    if (!entry?.proposed) throw new Error(`Deletion prefix is not proposed: ${prefix}`);
    assertCanonicalConnectorDayPrefix(prefix);
    return { entry, prefix, domain: objectDomain(prefix) };
  });
  return {
    objects: normalizedObjects.sort((left, right) => objectRank(left.key) - objectRank(right.key) || left.key.localeCompare(right.key)),
    prefixes: normalizedPrefixes.sort((left, right) => left.domain.localeCompare(right.domain) || left.prefix.localeCompare(right.prefix)),
  };
}

async function deleteAndVerifyPrefix({ r2, runState, runStatePath, prefixEntry, adapters }) {
  const prefix = `${prefixEntry.prefix}/`;
  prefixEntry.entry.remote_attempted = true;
  prefixEntry.entry.status = "deleting";
  atomicWriteJson(runStatePath, runState);
  try {
    const entries = await adapters.listAllObjects({ r2, prefix, max_keys: 1000 });
    const keys = entries.map((entry) => safeKey(entry.key)).filter((key) => key.startsWith(prefix)).sort();
    for (let index = 0; index < keys.length; index += 1000) {
      const batch = keys.slice(index, index + 1000);
      const result = await adapters.deleteObjects({ r2, keys: batch });
      if (Array.isArray(result?.errors) && result.errors.length) {
        throw new Error(`R2 prefix delete returned errors for ${prefixEntry.prefix}: ${JSON.stringify(result.errors)}`);
      }
    }
    const remaining = await adapters.listAllObjects({ r2, prefix, max_keys: 1000 });
    if (remaining.length) throw new Error(`R2 prefix deletion verification failed: ${prefixEntry.prefix}`);
    Object.assign(prefixEntry.entry, {
      deleted: true,
      deletion_verified: true,
      remote_completed: true,
      completed_at_utc: new Date().toISOString(),
      deleted_object_count: keys.length,
      deleted_object_keys: keys,
      status: "deletion_verified",
    });
    atomicWriteJson(runStatePath, runState);
    return keys.length;
  } catch (error) {
    Object.assign(prefixEntry.entry, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    atomicWriteJson(runStatePath, runState);
    throw error;
  }
}

async function putAndVerifyObject({ r2, runState, runStatePath, object, adapters }) {
  const entry = object.entry;
  Object.assign(entry, { remote_attempted: true, status: "uploading" });
  atomicWriteJson(runStatePath, runState);
  try {
    await adapters.putObject({ r2, key: object.key, body: object.body, content_type: contentTypeForKey(object.key) });
    Object.assign(entry, { uploaded: true, uploaded_at_utc: new Date().toISOString(), status: "uploaded" });
    atomicWriteJson(runStatePath, runState);
    const fresh = await adapters.getObject({ r2, key: object.key });
    if (Number(fresh.bytes) !== object.body.byteLength || sha256Hex(fresh.body) !== entry.sha256) {
      throw new Error(`R2 GET verification identity mismatch: ${object.key}`);
    }
    Object.assign(entry, {
      r2_verified: true,
      r2_verified_at_utc: new Date().toISOString(),
      remote_completed: true,
      status: "get_verified",
    });
    atomicWriteJson(runStatePath, runState);
  } catch (error) {
    Object.assign(entry, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    atomicWriteJson(runStatePath, runState);
    throw error;
  }
}

export async function applyValidatedProposal({ runStatePath, r2, adapters = {} }) {
  const resolvedAdapters = {
    deleteObjects: adapters.deleteObjects || r2DeleteObjects,
    getObject: adapters.getObject || r2GetObject,
    listAllObjects: adapters.listAllObjects || r2ListAllObjects,
    putObject: adapters.putObject || r2PutObject,
  };
  const runState = JSON.parse(fs.readFileSync(runStatePath, "utf8"));
  const proposal = validateLocalProposal(runState);
  const counts = { planned_deletions: proposal.prefixes.length, planned_writes: proposal.objects.length, deleted_objects: 0, completed_deletions: 0, completed_writes: 0, get_verified_writes: 0 };
  runState.apply = { status: "running", started_at_utc: new Date().toISOString(), ...counts };
  atomicWriteJson(runStatePath, runState);
  try {
    for (const domain of ["observations", "aqilevels"]) {
      for (const prefixEntry of proposal.prefixes.filter((entry) => entry.domain === domain)) {
        counts.deleted_objects += await deleteAndVerifyPrefix({ r2, runState, runStatePath, prefixEntry, adapters: resolvedAdapters });
        counts.completed_deletions += 1;
      }
      for (const object of proposal.objects.filter((entry) => entry.domain === domain)) {
        await putAndVerifyObject({ r2, runState, runStatePath, object, adapters: resolvedAdapters });
        counts.completed_writes += 1;
        counts.get_verified_writes += 1;
      }
    }
    runState.apply = { ...runState.apply, ...counts, status: "succeeded", finished_at_utc: new Date().toISOString() };
    atomicWriteJson(runStatePath, runState);
    return { ok: true, status: "succeeded", ...counts };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runState.apply = { ...runState.apply, ...counts, status: "failed", error: message, finished_at_utc: new Date().toISOString() };
    atomicWriteJson(runStatePath, runState);
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runStatePath = path.resolve(args.runStateJson);
  const config = resolveR2HistoryIndexConfig(process.env);
  if (!hasRequiredR2Config(config.r2)) throw new Error("canonical apply requires complete R2 configuration");
  if (config.r2.bucket !== TEST_BUCKET) throw new Error(`Refusing canonical apply for non-TEST bucket: ${config.r2.bucket || "(unset)"}`);
  return applyValidatedProposal({ runStatePath, r2: config.r2 });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().then((result) => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
