#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  buildConnectorManifestKey,
  buildDayManifestKey,
  resolvePhaseBRuntimeConfig,
} from "../../workers/uk_aq_prune_daily/phase_b_backup_r2.mjs";
import {
  hasRequiredR2Config,
  r2GetObject,
} from "../../workers/shared/r2_sigv4.mjs";

function usage() {
  console.log(
    "Usage: node scripts/backup_r2/download_day.mjs --day YYYY-MM-DD [--connector N] --out <dir>",
  );
}

function parseArgs(argv) {
  const args = {
    day: "",
    connector: null,
    out: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--day") {
      args.day = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--connector") {
      const raw = String(argv[i + 1] || "").trim();
      args.connector = raw ? Number(raw) : null;
      i += 1;
      continue;
    }
    if (arg === "--out") {
      args.out = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.day)) {
    throw new Error("--day must be YYYY-MM-DD");
  }
  if (!args.out) {
    throw new Error("--out is required");
  }
  if (args.connector !== null && (!Number.isFinite(args.connector) || args.connector < 1)) {
    throw new Error("--connector must be a positive integer");
  }

  return args;
}

function toOutPath(outDir, objectKey) {
  const normalizedKey = String(objectKey).replace(/\\/g, "/").replace(/^\/+/, "");
  const targetPath = path.resolve(outDir, normalizedKey);
  const relative = path.relative(outDir, targetPath);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Unsafe object key path: ${objectKey}`);
  }
  return targetPath;
}

async function downloadObject(r2, objectKey, outDir) {
  const object = await r2GetObject({ r2, key: objectKey });
  const targetPath = toOutPath(outDir, objectKey);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, object.body);
  return {
    key: objectKey,
    bytes: object.bytes,
    path: targetPath,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = resolvePhaseBRuntimeConfig(process.env);

  if (!hasRequiredR2Config(config.r2)) {
    throw new Error("Missing R2 config. Set endpoint, bucket, region, access key id, and secret.");
  }

  const outDir = path.resolve(args.out);
  fs.mkdirSync(outDir, { recursive: true });

  const manifestKey = args.connector === null
    ? buildDayManifestKey(config.committed_prefix, args.day)
    : buildConnectorManifestKey(config.committed_prefix, args.day, args.connector);

  const manifestObject = await r2GetObject({ r2: config.r2, key: manifestKey });
  const manifest = JSON.parse(manifestObject.body.toString("utf8"));

  const manifestTarget = toOutPath(outDir, manifestKey);
  fs.mkdirSync(path.dirname(manifestTarget), { recursive: true });
  fs.writeFileSync(manifestTarget, manifestObject.body);

  const parquetKeys = Array.isArray(manifest.parquet_object_keys)
    ? manifest.parquet_object_keys.map((key) => String(key))
    : [];

  if (parquetKeys.length === 0) {
    throw new Error(`Manifest has no parquet_object_keys: ${manifestKey}`);
  }

  let totalBytes = 0;
  for (const objectKey of parquetKeys) {
    const result = await downloadObject(config.r2, objectKey, outDir);
    totalBytes += result.bytes;
  }

  console.log(JSON.stringify({
    ok: true,
    day_utc: args.day,
    connector_id: args.connector,
    manifest_key: manifestKey,
    downloaded_files: parquetKeys.length,
    downloaded_bytes: totalBytes,
    output_dir: outDir,
  }, null, 2));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
});
