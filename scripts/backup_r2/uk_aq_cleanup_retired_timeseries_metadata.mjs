#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { hasRequiredR2Config, r2DeleteObjects, r2ListAllObjects } from "../../workers/shared/r2_sigv4.mjs";

const PREFIX = "history/_index_v2/timeseries/";
const CONFIRMATION_TOKEN = "DELETE_RETIRED_TIMESERIES_METADATA";
const DELETE_BATCH_SIZE = 1000;

function r2FromEnv(env = process.env) {
  return {
    endpoint: String(env.CFLARE_R2_ENDPOINT || env.R2_ENDPOINT || "").trim(),
    bucket: String(env.CFLARE_R2_BUCKET || env.R2_BUCKET || "").trim(),
    region: String(env.CFLARE_R2_REGION || env.R2_REGION || "auto").trim() || "auto",
    access_key_id: String(env.CFLARE_R2_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID || "").trim(),
    secret_access_key: String(env.CFLARE_R2_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY || "").trim(),
  };
}

function parseArgs(argv) {
  const args = { writeR2: false, confirmationToken: "", manifestOut: path.resolve(process.cwd(), "uk_aq_retired_timeseries_metadata_cleanup_manifest.json") };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") continue;
    if (arg === "--write-r2") { args.writeR2 = true; continue; }
    if (arg === "--confirm-token" || arg === "--manifest-out") {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      index += 1;
      if (arg === "--confirm-token") args.confirmationToken = value;
      else args.manifestOut = path.resolve(value);
      continue;
    }
    throw new Error("Usage: node scripts/backup_r2/uk_aq_cleanup_retired_timeseries_metadata.mjs [--dry-run|--write-r2 --confirm-token DELETE_RETIRED_TIMESERIES_METADATA] [--manifest-out FILE]");
  }
  if (args.writeR2 && args.confirmationToken !== CONFIRMATION_TOKEN) {
    throw new Error(`Refusing deletion: --confirm-token ${CONFIRMATION_TOKEN} is required with --write-r2`);
  }
  return args;
}

function writeManifest(manifestOut, payload) {
  fs.mkdirSync(path.dirname(manifestOut), { recursive: true });
  fs.writeFileSync(manifestOut, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function batches(keys) {
  return Array.from({ length: Math.ceil(keys.length / DELETE_BATCH_SIZE) }, (_, index) =>
    keys.slice(index * DELETE_BATCH_SIZE, (index + 1) * DELETE_BATCH_SIZE));
}

export async function cleanupRetiredTimeseriesMetadata({ argv = process.argv.slice(2), env = process.env } = {}) {
  const args = parseArgs(argv);
  const r2 = r2FromEnv(env);
  if (!hasRequiredR2Config(r2)) throw new Error("Missing required R2 configuration");
  const objects = await r2ListAllObjects({ r2, prefix: PREFIX, max_keys: DELETE_BATCH_SIZE });
  const entries = objects.map((object) => ({ key: String(object.key), size: Number(object.size || 0), etag: object.etag || object.e_tag || null }));
  const base = {
    retired_prefix: PREFIX,
    bucket: r2.bucket,
    manifest_created_at: new Date().toISOString(),
    write_r2: args.writeR2,
    total_count: entries.length,
    total_bytes: entries.reduce((total, entry) => total + entry.size, 0),
    entries,
    planned_count: entries.length,
    deleted_count: 0,
    failed_count: 0,
    remaining_count: entries.length,
    delete_errors: [],
  };
  // The complete pre-delete inventory is durable before the first delete call.
  writeManifest(args.manifestOut, base);
  if (!args.writeR2 || !entries.length) {
    return { ...base, status: "planned", manifest_out: args.manifestOut };
  }

  const deletedKeys = new Set();
  const deleteErrors = [];
  for (const batch of batches(entries.map((entry) => entry.key))) {
    try {
      const result = await r2DeleteObjects({ r2, keys: batch });
      for (const key of result.deleted_keys || []) deletedKeys.add(key);
      for (const error of result.errors || []) deleteErrors.push(error);
      const returned = new Set([...(result.deleted_keys || []), ...(result.errors || []).map((error) => error.key)]);
      for (const key of batch) {
        if (!returned.has(key)) deleteErrors.push({ key, code: "missing_delete_result", message: "R2 returned no deletion result for key" });
      }
    } catch (error) {
      for (const key of batch) deleteErrors.push({ key, code: "delete_request_failed", message: error instanceof Error ? error.message : String(error) });
    }
  }
  const result = {
    ...base,
    deleted_count: deletedKeys.size,
    failed_count: deleteErrors.length,
    remaining_count: entries.length - deletedKeys.size,
    delete_errors: deleteErrors,
    status: deleteErrors.length ? "failed" : "deleted",
    manifest_out: args.manifestOut,
  };
  writeManifest(args.manifestOut, result);
  if (deleteErrors.length) throw new Error(`Retired timeseries metadata deletion was partial; failed_count=${deleteErrors.length}; manifest=${args.manifestOut}`);
  return result;
}

if (process.argv[1]?.endsWith("uk_aq_cleanup_retired_timeseries_metadata.mjs")) {
  cleanupRetiredTimeseriesMetadata().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  });
}
