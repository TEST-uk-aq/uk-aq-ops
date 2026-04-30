#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import {
  hasRequiredR2Config,
  normalizePrefix,
  r2DeleteObjects,
  r2ListAllObjects,
  r2PutObject,
} from "../../workers/shared/r2_sigv4.mjs";

const DEFAULT_INPUT_DIR = String(
  process.env.UK_AQ_POSTCODE_LOOKUP_OUTPUT_DIR
    || process.env.UK_AQ_POSTCODE_OUTPUT_DIR
    || "tmp/postcode_lookup_v1",
).trim();
const DEFAULT_PREFIX = normalizePrefix(process.env.UK_AQ_POSTCODE_R2_PREFIX || "v1");
const DEFAULT_CACHE_PURGE_PATHS = ["/api/aq/postcode_suggest", "/api/aq/postcode-suggest"];

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/postcodes/upload_postcode_lookup_to_r2.mjs [options]",
      "",
      "Options:",
      "  --input-dir <dir>            Directory with manifest.json + shard JSON files",
      "  --prefix <r2-prefix>         R2 key prefix (default: from manifest.json, else UK_AQ_POSTCODE_R2_PREFIX, else v1)",
      "  --bucket <bucket>            Override bucket name",
      "  --endpoint <url>             Override R2 endpoint URL",
      "  --skip-clear-prefix          Do not clear existing objects under prefix before upload",
      "  --skip-cache-purge           Do not purge cache-proxy postcode suggest cache after upload",
      "  --cache-zone-id <zone-id>    Cloudflare zone id for targeted purge",
      "  --cache-purge-origin <url>   Origin to purge (repeatable). Example: https://cic-test.chronicillnesschannel.co.uk",
      "  --cache-purge-path <path>    Prefix path to purge (repeatable). Default: /api/aq/postcode_suggest and /api/aq/postcode-suggest",
      "  --dry-run                    Validate and print plan only",
      "  -h, --help",
      "",
      "Supported env vars (preferred order):",
      "  UK_AQ_POSTCODE_R2_BUCKET",
      "  CFLARE_R2_BUCKET / R2_BUCKET",
      "  UK_AQ_POSTCODE_R2_PREFIX",
      "  UK_AQ_POSTCODE_R2_ENDPOINT",
      "  CFLARE_R2_ENDPOINT / R2_ENDPOINT",
      "  CLOUDFLARE_ACCOUNT_ID (used to derive endpoint when not explicitly set)",
      "  CLOUDFLARE_R2_ACCESS_KEY_ID / CFLARE_R2_ACCESS_KEY_ID / R2_ACCESS_KEY_ID",
      "  CLOUDFLARE_R2_SECRET_ACCESS_KEY / CFLARE_R2_SECRET_ACCESS_KEY / R2_SECRET_ACCESS_KEY",
      "  UK_AQ_POSTCODE_R2_REGION / CFLARE_R2_REGION / R2_REGION (default: auto)",
      "",
      "Optional cache purge env vars:",
      "  UK_AQ_DOMAIN_CLOUDFLARE_API_TOKEN / UK_AQ_CACHE_CLOUDFLARE_API_TOKEN / CLOUDFLARE_API_TOKEN",
      "  UK_AQ_CACHE_ALLOWED_ORIGINS (fallback origin list for purge hosts)",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = {
    input_dir: DEFAULT_INPUT_DIR,
    prefix_override: "",
    bucket_override: "",
    endpoint_override: "",
    skip_clear_prefix: false,
    skip_cache_purge: false,
    cache_zone_id: "",
    cache_purge_origins: [],
    cache_purge_paths: [],
    dry_run: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input-dir") {
      args.input_dir = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--prefix") {
      args.prefix_override = normalizePrefix(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg === "--bucket") {
      args.bucket_override = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--endpoint") {
      args.endpoint_override = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--dry-run") {
      args.dry_run = true;
      continue;
    }
    if (arg === "--skip-cache-purge") {
      args.skip_cache_purge = true;
      continue;
    }
    if (arg === "--skip-clear-prefix") {
      args.skip_clear_prefix = true;
      continue;
    }
    if (arg === "--cache-zone-id") {
      args.cache_zone_id = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--cache-purge-origin") {
      const origin = String(argv[i + 1] || "").trim();
      if (origin) {
        args.cache_purge_origins.push(origin);
      }
      i += 1;
      continue;
    }
    if (arg === "--cache-purge-path") {
      const purgePath = String(argv[i + 1] || "").trim();
      if (purgePath) {
        args.cache_purge_paths.push(purgePath);
      }
      i += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  if (!args.input_dir) {
    throw new Error("Input directory is required. Set --input-dir or UK_AQ_POSTCODE_LOOKUP_OUTPUT_DIR.");
  }
  return args;
}

function resolveR2Endpoint(accountId, override, explicitEnv) {
  const endpoint = String(override || explicitEnv || "").trim();
  if (endpoint) {
    return endpoint.replace(/\/+$/, "");
  }
  const normalizedAccountId = String(accountId || "").trim();
  if (!normalizedAccountId) {
    return "";
  }
  return `https://${normalizedAccountId}.r2.cloudflarestorage.com`;
}

function buildR2Config(args) {
  const cloudflareAccountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
  const endpoint = resolveR2Endpoint(
    cloudflareAccountId,
    args.endpoint_override,
    process.env.UK_AQ_POSTCODE_R2_ENDPOINT || process.env.CFLARE_R2_ENDPOINT || process.env.R2_ENDPOINT,
  );

  return {
    endpoint,
    bucket: String(
      args.bucket_override
        || process.env.UK_AQ_POSTCODE_R2_BUCKET
        || process.env.CFLARE_R2_BUCKET
        || process.env.R2_BUCKET
        || "",
    ).trim(),
    region: String(
      process.env.UK_AQ_POSTCODE_R2_REGION
        || process.env.CFLARE_R2_REGION
        || process.env.R2_REGION
        || "auto",
    ).trim() || "auto",
    access_key_id: String(
      process.env.CLOUDFLARE_R2_ACCESS_KEY_ID
        || process.env.CFLARE_R2_ACCESS_KEY_ID
        || process.env.R2_ACCESS_KEY_ID
        || "",
    ).trim(),
    secret_access_key: String(
      process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY
        || process.env.CFLARE_R2_SECRET_ACCESS_KEY
        || process.env.R2_SECRET_ACCESS_KEY
        || "",
    ).trim(),
  };
}

function parseCsvList(input) {
  return String(input || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeHostInput(input) {
  const value = String(input || "").trim();
  if (!value) {
    return "";
  }
  try {
    const url = new URL(value);
    return String(url.hostname || "").trim().toLowerCase();
  } catch (_err) {
    return value.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").trim().toLowerCase();
  }
}

function isLocalHost(host) {
  const normalized = String(host || "").trim().toLowerCase();
  return normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized.endsWith(".local");
}

function collectCachePurgeHosts(args) {
  const fromArgs = Array.isArray(args.cache_purge_origins) ? args.cache_purge_origins : [];
  const fromEnv = parseCsvList(process.env.UK_AQ_CACHE_ALLOWED_ORIGINS);
  const rawValues = fromArgs.length ? fromArgs : fromEnv;
  const hosts = new Set();
  for (const value of rawValues) {
    const host = normalizeHostInput(value);
    if (!host || isLocalHost(host)) {
      continue;
    }
    hosts.add(host);
  }
  return Array.from(hosts).sort();
}

function collectCachePurgePaths(args) {
  const fromArgs = Array.isArray(args.cache_purge_paths) ? args.cache_purge_paths : [];
  const rawValues = fromArgs.length ? fromArgs : DEFAULT_CACHE_PURGE_PATHS;
  const paths = new Set();
  for (const value of rawValues) {
    let normalized = String(value || "").trim();
    if (!normalized) {
      continue;
    }
    if (!normalized.startsWith("/")) {
      normalized = `/${normalized}`;
    }
    paths.add(normalized);
  }
  return Array.from(paths).sort();
}

function resolveCloudflareApiToken() {
  return String(
    process.env.UK_AQ_DOMAIN_CLOUDFLARE_API_TOKEN
      || process.env.UK_AQ_CACHE_CLOUDFLARE_API_TOKEN
      || process.env.CLOUDFLARE_API_TOKEN
      || "",
  ).trim();
}

function resolveCloudflareZoneId(args) {
  return String(
    args.cache_zone_id || "",
  ).trim();
}

function buildZoneNameCandidates(host) {
  const normalized = String(host || "").trim().toLowerCase();
  if (!normalized) {
    return [];
  }
  const labels = normalized.split(".").filter(Boolean);
  const candidates = [];
  for (let i = 0; i <= labels.length - 2; i += 1) {
    const value = labels.slice(i).join(".");
    if (!value) {
      continue;
    }
    candidates.push(value);
  }
  return Array.from(new Set(candidates));
}

async function cfApiRequest({ token, method, pathWithQuery, body }) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${pathWithQuery}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) {
    const errorMessage = payload?.errors?.[0]?.message || payload?.messages?.[0]?.message || `HTTP ${response.status}`;
    throw new Error(`Cloudflare API ${method} ${pathWithQuery} failed: ${errorMessage}`);
  }
  return payload;
}

async function autoResolveZoneId(token, hosts) {
  const zoneCandidates = new Set();
  for (const host of hosts) {
    for (const candidate of buildZoneNameCandidates(host)) {
      zoneCandidates.add(candidate);
    }
  }
  for (const zoneName of zoneCandidates) {
    // eslint-disable-next-line no-await-in-loop
    const payload = await cfApiRequest({
      token,
      method: "GET",
      pathWithQuery: `/zones?name=${encodeURIComponent(zoneName)}&status=active&match=all&per_page=1`,
    });
    const zone = Array.isArray(payload?.result) ? payload.result[0] : null;
    const zoneId = String(zone?.id || "").trim();
    if (zoneId) {
      return { zone_id: zoneId, zone_name: String(zone?.name || zoneName) };
    }
  }
  return { zone_id: "", zone_name: "" };
}

function buildPurgePrefixes(hosts, paths) {
  const prefixes = [];
  for (const host of hosts) {
    for (const routePath of paths) {
      prefixes.push(`${host}${routePath}`);
    }
  }
  return Array.from(new Set(prefixes));
}

async function purgePostcodeSuggestCache(args) {
  const hosts = collectCachePurgeHosts(args);
  if (!hosts.length) {
    return {
      attempted: false,
      reason: "no_hosts_configured",
    };
  }

  const token = resolveCloudflareApiToken();
  if (!token) {
    return {
      attempted: false,
      reason: "missing_cloudflare_api_token",
      hosts,
    };
  }

  let zoneId = resolveCloudflareZoneId(args);
  let resolvedZoneName = "";
  if (!zoneId) {
    const resolved = await autoResolveZoneId(token, hosts);
    zoneId = resolved.zone_id;
    resolvedZoneName = resolved.zone_name;
  }
  if (!zoneId) {
    return {
      attempted: false,
      reason: "zone_id_not_found",
      hosts,
    };
  }

  const paths = collectCachePurgePaths(args);
  const prefixes = buildPurgePrefixes(hosts, paths);
  if (!prefixes.length) {
    return {
      attempted: false,
      reason: "no_prefixes_to_purge",
      hosts,
      zone_id: zoneId,
      zone_name: resolvedZoneName,
    };
  }

  const maxBatchSize = 30;
  let batches = 0;
  for (let i = 0; i < prefixes.length; i += maxBatchSize) {
    const batch = prefixes.slice(i, i + maxBatchSize);
    // eslint-disable-next-line no-await-in-loop
    await cfApiRequest({
      token,
      method: "POST",
      pathWithQuery: `/zones/${encodeURIComponent(zoneId)}/purge_cache`,
      body: { prefixes: batch },
    });
    batches += 1;
  }

  return {
    attempted: true,
    success: true,
    zone_id: zoneId,
    zone_name: resolvedZoneName || null,
    host_count: hosts.length,
    prefix_count: prefixes.length,
    batch_count: batches,
    prefixes,
  };
}

async function readJsonFile(filePath) {
  const text = await fs.promises.readFile(filePath, "utf8");
  return JSON.parse(text);
}

async function readFileBuffer(filePath) {
  const data = await fs.promises.readFile(filePath);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function inferPrefixFromManifest(manifest) {
  function stripKnownSuffix(key) {
    const normalized = String(key || "").trim().replace(/^\/+|\/+$/g, "");
    if (!normalized) {
      return "";
    }
    const suffixes = [
      "/area_town_index.json",
      "/postcode_prefix_hints.json",
      "/manifest.json",
      "/shards",
      "/suggest",
    ];
    for (const suffix of suffixes) {
      if (normalized.endsWith(suffix)) {
        return normalizePrefix(normalized.slice(0, -suffix.length));
      }
    }
    return normalizePrefix(normalized);
  }

  const objectCandidates = [
    manifest?.objects?.area_town_index,
    manifest?.objects?.postcode_prefix_hints,
    manifest?.objects?.exact_shards_prefix,
    manifest?.objects?.suggest_shards_prefix,
  ].filter(Boolean);

  for (const objectKey of objectCandidates) {
    const inferred = stripKnownSuffix(objectKey);
    if (inferred) {
      return inferred;
    }
  }

  const exactShards = manifest?.exact_shards;
  const legacyShards = manifest?.shards;
  const shardMap = exactShards && typeof exactShards === "object" ? exactShards : legacyShards;
  if (!shardMap || typeof shardMap !== "object") {
    return "";
  }

  for (const [shard, info] of Object.entries(shardMap)) {
    const objectKey = String(info?.object_key || "").trim();
    if (!objectKey) {
      continue;
    }
    const shardCode = String(shard || "").trim().toUpperCase();
    const cleanedKey = objectKey.replace(/^\/+|\/+$/g, "");
    const fallbackSuffixes = [
      `/shards/${shardCode}.json`,
      `/suggest/${shardCode}.json`,
      `/${shardCode}.json`,
    ];
    for (const suffix of fallbackSuffixes) {
      if (shardCode && cleanedKey.toUpperCase().endsWith(suffix.toUpperCase())) {
        return normalizePrefix(cleanedKey.slice(0, -suffix.length));
      }
    }
  }
  return "";
}

function buildObjectKey(prefix, relativePath) {
  const normalizedPrefix = normalizePrefix(prefix);
  const normalizedRelativePath = String(relativePath || "").trim().replace(/^\/+/, "");
  if (!normalizedPrefix || !normalizedRelativePath) {
    return "";
  }
  return `${normalizedPrefix}/${normalizedRelativePath}`;
}

function addPlanEntry(plan, seen, type, code, relativePath) {
  const normalizedRelativePath = String(relativePath || "").trim().replace(/^\/+/, "");
  if (!normalizedRelativePath) {
    return;
  }
  if (seen.has(normalizedRelativePath)) {
    return;
  }
  seen.add(normalizedRelativePath);
  plan.push({ type, code, relative_path: normalizedRelativePath });
}

function buildUploadPlan(manifest) {
  const plan = [];
  const seen = new Set();

  const exactShards = manifest?.exact_shards && typeof manifest.exact_shards === "object"
    ? manifest.exact_shards
    : manifest?.shards && typeof manifest.shards === "object"
      ? manifest.shards
      : null;
  if (exactShards) {
    for (const [shard, info] of Object.entries(exactShards).sort((a, b) => a[0].localeCompare(b[0]))) {
      const relativePath = String(info?.relative_path || `shards/${shard}.json`).trim();
      addPlanEntry(plan, seen, "exact_shard", shard, relativePath);
    }
  }

  const suggestShards = manifest?.suggest_shards && typeof manifest.suggest_shards === "object"
    ? manifest.suggest_shards
    : null;
  if (suggestShards) {
    for (const [shard, info] of Object.entries(suggestShards).sort((a, b) => a[0].localeCompare(b[0]))) {
      const relativePath = String(info?.relative_path || `suggest/${shard}.json`).trim();
      addPlanEntry(plan, seen, "suggest_shard", shard, relativePath);
    }
  }

  const areaTownRelativePath = String(
    manifest?.objects?.area_town_index_relative_path
      || "area_town_index.json",
  ).trim();
  addPlanEntry(plan, seen, "area_town_index", null, areaTownRelativePath);

  const prefixHintsRelativePath = String(
    manifest?.objects?.postcode_prefix_hints_relative_path
      || "postcode_prefix_hints.json",
  ).trim();
  addPlanEntry(plan, seen, "postcode_prefix_hints", null, prefixHintsRelativePath);

  if (plan.length === 0) {
    throw new Error("manifest.json does not describe any upload objects.");
  }
  return plan;
}

async function assertFilesExist(inputDir, plan) {
  for (const item of plan) {
    const filePath = path.join(inputDir, item.relative_path);
    // eslint-disable-next-line no-await-in-loop
    const stat = await fs.promises.stat(filePath).catch(() => null);
    if (!stat || !stat.isFile()) {
      throw new Error(`Missing expected file from manifest: ${filePath}`);
    }
  }
}

function buildUploadManifest(manifest, prefix, plan, generatedAt) {
  const uploadedManifest = {
    ...manifest,
    generated_at_utc: manifest.generated_at_utc || generatedAt,
    uploaded_at_utc: generatedAt,
    source: manifest.source || "ONSPD",
    objects: {
      ...(manifest.objects || {}),
      area_town_index: buildObjectKey(prefix, "area_town_index.json"),
      area_town_index_relative_path: "area_town_index.json",
      postcode_prefix_hints: buildObjectKey(prefix, "postcode_prefix_hints.json"),
      postcode_prefix_hints_relative_path: "postcode_prefix_hints.json",
      exact_shards_prefix: buildObjectKey(prefix, "shards/") || `${normalizePrefix(prefix)}/shards/`,
      suggest_shards_prefix: buildObjectKey(prefix, "suggest/") || `${normalizePrefix(prefix)}/suggest/`,
    },
    shards: {},
    exact_shards: {},
    suggest_shards: {},
  };

  for (const item of plan) {
    const objectKey = buildObjectKey(prefix, item.relative_path);
    if (item.type === "exact_shard") {
      uploadedManifest.shards[item.code] = {
        ...(manifest?.shards?.[item.code] || manifest?.exact_shards?.[item.code] || {}),
        object_key: objectKey,
        relative_path: item.relative_path,
      };
      uploadedManifest.exact_shards[item.code] = {
        ...(manifest?.exact_shards?.[item.code] || manifest?.shards?.[item.code] || {}),
        object_key: objectKey,
        relative_path: item.relative_path,
      };
      continue;
    }
    if (item.type === "suggest_shard") {
      uploadedManifest.suggest_shards[item.code] = {
        ...(manifest?.suggest_shards?.[item.code] || {}),
        object_key: objectKey,
        relative_path: item.relative_path,
      };
    }
  }

  uploadedManifest.shard_count = Number(uploadedManifest.shard_count || Object.keys(uploadedManifest.shards).length);
  uploadedManifest.exact_shard_count = Number(
    uploadedManifest.exact_shard_count || Object.keys(uploadedManifest.exact_shards).length,
  );
  uploadedManifest.suggest_shard_count = Number(
    uploadedManifest.suggest_shard_count || Object.keys(uploadedManifest.suggest_shards).length,
  );

  return uploadedManifest;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputDir = path.resolve(args.input_dir);
  const manifestPath = path.join(inputDir, "manifest.json");
  const r2 = buildR2Config(args);

  if (!hasRequiredR2Config(r2)) {
    throw new Error(
      "Missing R2 config. Set bucket, endpoint/account id, access key id, and secret access key.",
    );
  }

  const manifest = await readJsonFile(manifestPath);
  const prefix = args.prefix_override || inferPrefixFromManifest(manifest) || DEFAULT_PREFIX;
  if (!prefix) {
    throw new Error("R2 prefix cannot be empty.");
  }

  const plan = buildUploadPlan(manifest);
  await assertFilesExist(inputDir, plan);

  const generatedAt = new Date().toISOString();
  let totalUploadedBytes = 0;
  let uploadedObjects = 0;
  let clearedObjects = 0;
  let cachePurge = {
    attempted: false,
    reason: "not_requested",
  };

  const clearPrefix = normalizePrefix(prefix);
  if (!args.skip_clear_prefix) {
    const clearPrefixPath = `${clearPrefix}/`;
    if (!args.dry_run) {
      const existingObjects = await r2ListAllObjects({ r2, prefix: clearPrefixPath });
      const keysToDelete = existingObjects.map((entry) => String(entry?.key || "").trim()).filter(Boolean);
      const chunkSize = 1000;
      for (let i = 0; i < keysToDelete.length; i += chunkSize) {
        const chunk = keysToDelete.slice(i, i + chunkSize);
        // eslint-disable-next-line no-await-in-loop
        const deleteResult = await r2DeleteObjects({ r2, keys: chunk });
        if (Array.isArray(deleteResult.errors) && deleteResult.errors.length > 0) {
          const firstError = deleteResult.errors[0];
          throw new Error(
            `R2 prefix clear failed for key=${firstError.key} code=${firstError.code} message=${firstError.message}`,
          );
        }
        clearedObjects += Number(deleteResult.deleted_count || 0);
      }
    } else {
      const existingObjects = await r2ListAllObjects({ r2, prefix: clearPrefixPath });
      clearedObjects = existingObjects.length;
    }
  }

  for (const item of plan) {
    const filePath = path.join(inputDir, item.relative_path);
    const objectKey = buildObjectKey(prefix, item.relative_path);
    const buffer = await readFileBuffer(filePath);

    if (!args.dry_run) {
      // eslint-disable-next-line no-await-in-loop
      const uploadResult = await r2PutObject({
        r2,
        key: objectKey,
        body: buffer,
        content_type: "application/json; charset=utf-8",
      });
      totalUploadedBytes += uploadResult.bytes;
      uploadedObjects += 1;
    } else {
      totalUploadedBytes += buffer.byteLength;
      uploadedObjects += 1;
    }
  }

  const uploadManifest = buildUploadManifest(manifest, prefix, plan, generatedAt);
  const manifestObjectKey = `${normalizePrefix(prefix)}/manifest.json`;
  const manifestBuffer = Buffer.from(`${JSON.stringify(uploadManifest, null, 2)}\n`, "utf8");

  if (!args.dry_run) {
    const uploadResult = await r2PutObject({
      r2,
      key: manifestObjectKey,
      body: manifestBuffer,
      content_type: "application/json; charset=utf-8",
    });
    totalUploadedBytes += uploadResult.bytes;
    uploadedObjects += 1;
  } else {
    totalUploadedBytes += manifestBuffer.byteLength;
    uploadedObjects += 1;
  }

  if (!args.dry_run && !args.skip_cache_purge) {
    // Temporarily disabled: cache purge is being handled manually in Cloudflare.
    cachePurge = {
      attempted: false,
      reason: "disabled_manual_purge",
    };
    // cachePurge = await purgePostcodeSuggestCache(args);
    // if (!cachePurge.attempted) {
    //   console.warn(`cache purge skipped: ${cachePurge.reason}`);
    // }
  } else if (args.dry_run) {
    cachePurge = {
      attempted: false,
      reason: "dry_run",
    };
  } else if (args.skip_cache_purge) {
    cachePurge = {
      attempted: false,
      reason: "skip_cache_purge_flag",
    };
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        dry_run: args.dry_run,
        bucket: r2.bucket,
        prefix,
        exact_shard_count: Number(uploadManifest.exact_shard_count || 0),
        suggest_shard_count: Number(uploadManifest.suggest_shard_count || 0),
        postcode_count: Number(uploadManifest.postcode_count || 0),
        area_town_index_count: Number(uploadManifest.area_town_index_count || 0),
        cleared_objects_before_upload: clearedObjects,
        uploaded_objects: uploadedObjects,
        uploaded_bytes: totalUploadedBytes,
        cache_purge: cachePurge,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`upload_postcode_lookup_to_r2 failed: ${message}`);
  process.exit(1);
});
