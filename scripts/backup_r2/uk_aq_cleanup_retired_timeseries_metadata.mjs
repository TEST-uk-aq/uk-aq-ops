#!/usr/bin/env node
import { r2DeleteObjects, r2ListAllObjects } from "../../workers/shared/r2_sigv4.mjs";

const PREFIX = "history/_index_v2/timeseries/";

function r2FromEnv(env = process.env) {
  return {
    endpoint: env.CFLARE_R2_ENDPOINT || env.R2_ENDPOINT,
    bucket: env.CFLARE_R2_BUCKET || env.R2_BUCKET,
    region: env.CFLARE_R2_REGION || env.R2_REGION || "auto",
    access_key_id: env.CFLARE_R2_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID,
    secret_access_key: env.CFLARE_R2_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY,
  };
}

export async function cleanupRetiredTimeseriesMetadata({ argv = process.argv.slice(2), env = process.env } = {}) {
  const writeR2 = argv.includes("--write-r2");
  if (argv.some((arg) => !["--dry-run", "--write-r2"].includes(arg))) {
    throw new Error("Usage: node scripts/backup_r2/uk_aq_cleanup_retired_timeseries_metadata.mjs [--dry-run|--write-r2]");
  }
  const r2 = r2FromEnv(env);
  const objects = await r2ListAllObjects({ r2, prefix: PREFIX, max_keys: 1000 });
  const totalBytes = objects.reduce((total, object) => total + Number(object?.size || 0), 0);
  if (writeR2 && objects.length) await r2DeleteObjects({ r2, keys: objects.map((object) => object.key) });
  return { retired_prefix: PREFIX, object_count: objects.length, total_bytes: totalBytes, write_r2: writeR2, status: writeR2 ? "deleted" : "planned" };
}

if (process.argv[1]?.endsWith("uk_aq_cleanup_retired_timeseries_metadata.mjs")) {
  cleanupRetiredTimeseriesMetadata().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  });
}
