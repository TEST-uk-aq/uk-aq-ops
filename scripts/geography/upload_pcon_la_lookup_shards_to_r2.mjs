#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  hasRequiredR2Config,
  normalizePrefix,
  r2PutObject,
} from "../../workers/shared/r2_sigv4.mjs";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const API_RETRYABLE_STATUS_CODES = new Set([408, 409, 429, 500, 502, 503, 504]);
const API_REQUEST_MAX_ATTEMPTS = 5;
const API_REQUEST_RETRY_BASE_MS = 750;
const API_REQUEST_RETRY_MAX_MS = 8000;

const DEFAULT_INPUT_DIR = String(
  process.env.UK_AQ_GEO_SHARD_OUTPUT_DIR
    || path.join(os.homedir(), "tmp", "geo_lookup_v1"),
).trim();
const DEFAULT_PREFIX = normalizePrefix(process.env.UK_AQ_GEO_R2_PREFIX || "v1");

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/geography/upload_pcon_la_lookup_shards_to_r2.mjs [options]",
      "",
      "Options:",
      "  --input-dir <path>            Directory containing manifest.json and shard files (default: ~/tmp/geo_lookup_v1)",
      "  --prefix <value>              R2 key prefix (default: v1)",
      "  --bucket <value>              Override bucket",
      "  --endpoint <value>            Override endpoint",
      "  --dry-run                     Print upload plan only",
      "  -h, --help",
      "",
      "Supported env vars:",
      "  UK_AQ_GEO_R2_BUCKET (default uk-aq-pcon-la-lookup when not set)",
      "  UK_AQ_GEO_R2_PREFIX (default v1)",
      "  UK_AQ_GEO_R2_ENDPOINT",
      "  UK_AQ_GEO_R2_REGION",
      "  UK_AQ_GEO_R2_CLOUDFLARE_ACCOUNT_ID",
      "  UK_AQ_DOMAIN_CLOUDFLARE_ACCOUNT_ID / UK_AQ_POSTCODE_R2_CLOUDFLARE_ACCOUNT_ID / UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_ACCOUNT_ID",
      "  UK_AQ_DOMAIN_CLOUDFLARE_API_TOKEN / CLOUDFLARE_API_TOKEN (preferred for geo upload)",
      "  CLOUDFLARE_R2_ACCESS_KEY_ID / CFLARE_R2_ACCESS_KEY_ID / R2_ACCESS_KEY_ID",
      "  CLOUDFLARE_R2_SECRET_ACCESS_KEY / CFLARE_R2_SECRET_ACCESS_KEY / R2_SECRET_ACCESS_KEY",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = {
    input_dir: DEFAULT_INPUT_DIR,
    prefix: DEFAULT_PREFIX,
    bucket_override: "",
    endpoint_override: "",
    dry_run: false,
  };

  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    if (arg === "--input-dir") {
      args.input_dir = String(argv[idx + 1] || "").trim();
      idx += 1;
      continue;
    }
    if (arg === "--prefix") {
      args.prefix = normalizePrefix(argv[idx + 1]);
      idx += 1;
      continue;
    }
    if (arg === "--bucket") {
      args.bucket_override = String(argv[idx + 1] || "").trim();
      idx += 1;
      continue;
    }
    if (arg === "--endpoint") {
      args.endpoint_override = String(argv[idx + 1] || "").trim();
      idx += 1;
      continue;
    }
    if (arg === "--dry-run") {
      args.dry_run = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  if (!args.input_dir) {
    throw new Error("Missing input directory (--input-dir or UK_AQ_GEO_SHARD_OUTPUT_DIR).");
  }
  if (!args.prefix) {
    throw new Error("R2 prefix cannot be empty (--prefix or UK_AQ_GEO_R2_PREFIX).");
  }

  return args;
}

function resolveAccountId() {
  return String(
    process.env.UK_AQ_GEO_R2_CLOUDFLARE_ACCOUNT_ID
      || process.env.UK_AQ_DOMAIN_CLOUDFLARE_ACCOUNT_ID
      || process.env.UK_AQ_POSTCODE_R2_CLOUDFLARE_ACCOUNT_ID
      || process.env.UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID
      || process.env.CLOUDFLARE_ACCOUNT_ID
      || "",
  ).trim();
}

function resolveEndpoint(args, accountId) {
  const explicit = String(
    args.endpoint_override
      || process.env.UK_AQ_GEO_R2_ENDPOINT
      || process.env.UK_AQ_POSTCODE_R2_ENDPOINT
      || process.env.CFLARE_R2_ENDPOINT
      || process.env.R2_ENDPOINT
      || "",
  ).trim();
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }
  if (!accountId) {
    return "";
  }
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

function buildR2Config(args) {
  const accountId = resolveAccountId();
  const endpoint = resolveEndpoint(args, accountId);

  return {
    account_id: accountId,
    endpoint,
    bucket: String(
      args.bucket_override
        || process.env.UK_AQ_GEO_R2_BUCKET
        || "uk-aq-pcon-la-lookup",
    ).trim(),
    region: String(
      process.env.UK_AQ_GEO_R2_REGION
        || process.env.UK_AQ_POSTCODE_R2_REGION
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

function resolveApiToken() {
  return String(
    process.env.UK_AQ_GEO_R2_CLOUDFLARE_API_TOKEN
      || process.env.UK_AQ_DOMAIN_CLOUDFLARE_API_TOKEN
      || process.env.CLOUDFLARE_API_TOKEN
      || "",
  ).trim();
}

function hasRequiredCloudflareApiConfig(config) {
  return Boolean(config && config.account_id && config.bucket && config.api_token);
}

function isRetryableApiRequestError(error) {
  const message = String(error instanceof Error ? error.message : error || "").toLowerCase();
  if (!message) {
    return false;
  }
  return [
    "connection reset",
    "connection closed",
    "broken pipe",
    "socket hang up",
    "econnreset",
    "econnrefused",
    "ehostunreach",
    "etimedout",
    "timed out",
    "timeout",
    "networkerror",
    "network error",
    "temporarily unavailable",
    "tls",
    "eof",
  ].some((token) => message.includes(token));
}

function computeApiRetryDelayMs(attempt) {
  return Math.min(
    API_REQUEST_RETRY_MAX_MS,
    API_REQUEST_RETRY_BASE_MS * (2 ** Math.max(0, attempt - 1)),
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodeObjectKeyForCloudflareApi(objectKey) {
  return String(objectKey || "")
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

async function cloudflareApiPutObject({
  accountId,
  apiToken,
  bucket,
  key,
  body,
  contentType = "application/octet-stream",
}) {
  const encodedKey = encodeObjectKeyForCloudflareApi(key);
  const url = `${CLOUDFLARE_API_BASE}/accounts/${accountId}/r2/buckets/${bucket}/objects/${encodedKey}`;
  for (let attempt = 1; attempt <= API_REQUEST_MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${apiToken}`,
          "content-type": contentType,
          "content-length": String(body.byteLength),
        },
        body,
      });
    } catch (error) {
      if (!isRetryableApiRequestError(error) || attempt === API_REQUEST_MAX_ATTEMPTS) {
        throw error;
      }
      await sleep(computeApiRetryDelayMs(attempt));
      continue;
    }

    const raw = await response.text();
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {}

    if (response.ok && payload?.success) {
      return {
        bytes: body.byteLength,
        result: payload?.result || null,
      };
    }

    const retryable = API_RETRYABLE_STATUS_CODES.has(response.status);
    if (retryable && attempt < API_REQUEST_MAX_ATTEMPTS) {
      await sleep(computeApiRetryDelayMs(attempt));
      continue;
    }

    const errorText = payload
      ? JSON.stringify(payload)
      : raw;
    throw new Error(
      `Cloudflare API upload failed for ${key}: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`,
    );
  }
  throw new Error(`Cloudflare API upload retry loop exhausted for ${key}.`);
}

function toObjectKey(prefix, relativePath) {
  return `${normalizePrefix(prefix)}/${String(relativePath || "").replace(/^\/+/, "").replace(/\\/g, "/")}`;
}

async function readJsonFile(filePath) {
  const raw = await fs.promises.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function readFileBuffer(filePath) {
  const raw = await fs.promises.readFile(filePath);
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
}

function normalizeManifestObjects(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("manifest.json must contain a JSON object.");
  }
  if (!Array.isArray(manifest.objects)) {
    throw new Error("manifest.json is missing objects array.");
  }

  const objects = [];
  for (const entry of manifest.objects) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const relativePath = String(entry.relative_path || "").trim();
    if (!relativePath) {
      continue;
    }
    objects.push({
      ...entry,
      relative_path: relativePath,
    });
  }

  if (objects.length === 0) {
    throw new Error("manifest.json objects array is empty.");
  }

  return objects.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputDir = path.resolve(args.input_dir);
  const manifestPath = path.join(inputDir, "manifest.json");
  const manifest = await readJsonFile(manifestPath);
  const objects = normalizeManifestObjects(manifest);
  const prefix = normalizePrefix(args.prefix || manifest.prefix || DEFAULT_PREFIX);

  const r2 = buildR2Config(args);
  const apiToken = resolveApiToken();
  const useCloudflareApi = hasRequiredCloudflareApiConfig({
    account_id: r2.account_id,
    bucket: r2.bucket,
    api_token: apiToken,
  });

  if (!useCloudflareApi && !hasRequiredR2Config(r2)) {
    throw new Error(
      "Missing R2 config. Provide either Cloudflare account id + API token, or S3-compatible endpoint/account id + access key id + secret access key.",
    );
  }

  const uploadedObjects = [];
  let totalUploadedBytes = 0;

  for (const entry of objects) {
    const filePath = path.join(inputDir, entry.relative_path);
    const objectKey = toObjectKey(prefix, entry.relative_path);
    const fileBuffer = await readFileBuffer(filePath);

    if (!args.dry_run) {
      const uploadResult = useCloudflareApi
        ? await cloudflareApiPutObject({
          accountId: r2.account_id,
          apiToken,
          bucket: r2.bucket,
          key: objectKey,
          body: fileBuffer,
          contentType: "application/json; charset=utf-8",
        })
        : await r2PutObject({
          r2,
          key: objectKey,
          body: fileBuffer,
          content_type: "application/json; charset=utf-8",
        });
      totalUploadedBytes += uploadResult.bytes;
    } else {
      totalUploadedBytes += fileBuffer.byteLength;
    }

    uploadedObjects.push({
      ...entry,
      object_key: objectKey,
      bytes: fileBuffer.byteLength,
    });
  }

  const uploadManifest = {
    ...manifest,
    prefix,
    uploaded_at_utc: new Date().toISOString(),
    objects: uploadedObjects,
    object_count: uploadedObjects.length + 1,
  };
  const uploadManifestBuffer = Buffer.from(`${JSON.stringify(uploadManifest, null, 2)}\n`, "utf8");
  const manifestObjectKey = toObjectKey(prefix, "manifest.json");

  if (!args.dry_run) {
    const manifestUploadResult = useCloudflareApi
      ? await cloudflareApiPutObject({
        accountId: r2.account_id,
        apiToken,
        bucket: r2.bucket,
        key: manifestObjectKey,
        body: uploadManifestBuffer,
        contentType: "application/json; charset=utf-8",
      })
      : await r2PutObject({
        r2,
        key: manifestObjectKey,
        body: uploadManifestBuffer,
        content_type: "application/json; charset=utf-8",
      });
    totalUploadedBytes += manifestUploadResult.bytes;
  } else {
    totalUploadedBytes += uploadManifestBuffer.byteLength;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        dry_run: args.dry_run,
        bucket: r2.bucket,
        account_id: r2.account_id || null,
        upload_mode: useCloudflareApi ? "cloudflare_api_token" : "s3_sigv4",
        prefix,
        shard_count: Number(manifest.shard_count || 0),
        feature_count: Number(manifest.feature_count || 0),
        uploaded_objects: uploadedObjects.length + 1,
        uploaded_bytes: totalUploadedBytes,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`upload_pcon_la_lookup_shards_to_r2 failed: ${message}`);
  process.exit(1);
});
