#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import {
  hasRequiredR2Config,
  normalizePrefix,
  r2PutObject,
} from "../../workers/shared/r2_sigv4.mjs";
import { buildPostcodeShardObjectKey } from "../../workers/shared/postcode_lookup.mjs";

const DEFAULT_INPUT_DIR = String(
  process.env.UK_AQ_POSTCODE_LOOKUP_OUTPUT_DIR
    || process.env.UK_AQ_POSTCODE_OUTPUT_DIR
    || "tmp/postcode_lookup_v1",
).trim();
const DEFAULT_PREFIX = normalizePrefix(process.env.UK_AQ_POSTCODE_R2_PREFIX || "v1");

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/postcodes/upload_postcode_lookup_to_r2.mjs [options]",
      "",
      "Options:",
      "  --input-dir <dir>            Directory with manifest.json + shard JSON files",
      "  --prefix <r2-prefix>         R2 key prefix (default: v1)",
      "  --bucket <bucket>            Override bucket name",
      "  --endpoint <url>             Override R2 endpoint URL",
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

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input-dir") {
      args.input_dir = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--prefix") {
      args.prefix = normalizePrefix(argv[i + 1]);
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
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  if (!args.input_dir) {
    throw new Error("Input directory is required. Set --input-dir or UK_AQ_POSTCODE_LOOKUP_OUTPUT_DIR.");
  }
  if (!args.prefix) {
    throw new Error("R2 prefix cannot be empty.");
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

async function readJsonFile(filePath) {
  const text = await fs.promises.readFile(filePath, "utf8");
  return JSON.parse(text);
}

async function readFileBuffer(filePath) {
  const data = await fs.promises.readFile(filePath);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
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
  const sourceShards = manifest && typeof manifest === "object" && manifest.shards && typeof manifest.shards === "object"
    ? manifest.shards
    : null;
  if (!sourceShards) {
    throw new Error("manifest.json is missing shards object.");
  }

  const shardCodes = Object.keys(sourceShards).sort((a, b) => a.localeCompare(b));
  if (shardCodes.length === 0) {
    throw new Error("manifest.json contains no shards.");
  }

  const prefix = args.prefix;
  const generatedAt = new Date().toISOString();
  let totalUploadedBytes = 0;
  let uploadedObjects = 0;

  const uploadManifest = {
    ...manifest,
    generated_at_utc: manifest.generated_at_utc || generatedAt,
    uploaded_at_utc: generatedAt,
    source: "ONSPD",
    shards: {},
  };

  for (const shard of shardCodes) {
    const shardFilePath = path.join(inputDir, `${shard}.json`);
    const shardObjectKey = buildPostcodeShardObjectKey(prefix, shard);
    if (!shardObjectKey) {
      throw new Error(`Failed to build object key for shard ${shard}.`);
    }

    const shardFileBuffer = await readFileBuffer(shardFilePath);
    if (!args.dry_run) {
      const uploadResult = await r2PutObject({
        r2,
        key: shardObjectKey,
        body: shardFileBuffer,
        content_type: "application/json; charset=utf-8",
      });
      totalUploadedBytes += uploadResult.bytes;
      uploadedObjects += 1;
    } else {
      totalUploadedBytes += shardFileBuffer.byteLength;
      uploadedObjects += 1;
    }

    const shardInfo = sourceShards[shard];
    uploadManifest.shards[shard] = {
      postcode_count: Number(shardInfo?.postcode_count || 0),
      object_key: shardObjectKey,
    };
  }

  const manifestObjectKey = `${prefix}/manifest.json`;
  const manifestBuffer = Buffer.from(`${JSON.stringify(uploadManifest, null, 2)}\n`, "utf8");
  if (!args.dry_run) {
    const manifestUploadResult = await r2PutObject({
      r2,
      key: manifestObjectKey,
      body: manifestBuffer,
      content_type: "application/json; charset=utf-8",
    });
    totalUploadedBytes += manifestUploadResult.bytes;
    uploadedObjects += 1;
  } else {
    totalUploadedBytes += manifestBuffer.byteLength;
    uploadedObjects += 1;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        dry_run: args.dry_run,
        bucket: r2.bucket,
        prefix,
        shard_count: Number(manifest.shard_count || shardCodes.length),
        postcode_count: Number(manifest.postcode_count || 0),
        uploaded_objects: uploadedObjects,
        uploaded_bytes: totalUploadedBytes,
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
