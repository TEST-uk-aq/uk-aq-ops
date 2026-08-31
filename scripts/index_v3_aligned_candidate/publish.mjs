#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  hasRequiredR2Config,
  normalizeR2Sha256Checksum,
  r2HeadObject,
} from "../../workers/shared/r2_sigv4.mjs";
import {
  buildR2ChecksumAwarePutIntent,
  putAndVerifyR2ObjectWithSha256,
} from "../../workers/shared/uk_aq_r2_checksum_publication.mjs";

const PREFIX_PATTERN = /^history\/_prototype\/observation-history\/timeseries-aligned-v2(?:\/candidate=[a-z0-9][a-z0-9-]{0,31})?$/;

function parse(argv) {
  const options = { plan: "", confirm: "", replaceExisting: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--plan") options.plan = argv[++index] || "";
    else if (argument === "--confirm-test-prefix") options.confirm = argv[++index] || "";
    else if (argument === "--replace-existing") options.replaceExisting = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function r2Config(env) {
  return {
    endpoint: String(env.CFLARE_R2_ENDPOINT || "").trim(),
    bucket: String(env.CFLARE_R2_BUCKET || "").trim(),
    region: String(env.CFLARE_R2_REGION || "auto").trim(),
    access_key_id: String(env.CFLARE_R2_ACCESS_KEY_ID || "").trim(),
    secret_access_key: String(env.CFLARE_R2_SECRET_ACCESS_KEY || "").trim(),
  };
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (String(process.env.UKAQ_ENV_NAME || "").trim().toUpperCase() !== "TEST") {
    throw new Error("refusing publication unless UKAQ_ENV_NAME=TEST");
  }
  if (!options.plan) throw new Error("--plan is required");
  const planPath = path.resolve(options.plan);
  const root = path.dirname(planPath);
  const plan = JSON.parse(fs.readFileSync(planPath));
  const prefix = String(plan.prototype_prefix || "");
  if (plan.environment !== "TEST" || !PREFIX_PATTERN.test(prefix)) {
    throw new Error("publication plan is not the supported TEST prototype plan");
  }
  if (options.confirm !== prefix) throw new Error(`--confirm-test-prefix must exactly equal ${prefix}`);
  const r2 = r2Config(process.env);
  if (!hasRequiredR2Config(r2)) throw new Error("incomplete CFLARE_R2_* credentials/configuration");
  const seen = new Set();
  const intents = plan.objects.map((entry) => {
    if (
      seen.has(entry.key) ||
      !entry.key.startsWith(`${prefix}/cap_rows=`) ||
      !new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/cap_rows=(1024|2048|4096)/`).test(entry.key) ||
      /(?:history\/v2|_index_v3|_latest|backup|checkpoint|live)/i.test(entry.key)
    ) throw new Error(`unsafe or duplicate publication key: ${entry.key}`);
    seen.add(entry.key);
    const body = fs.readFileSync(path.join(root, entry.local_path));
    const sha256 = crypto.createHash("sha256").update(body).digest("hex");
    if (body.byteLength !== entry.byte_size || sha256 !== entry.sha256) {
      throw new Error(`local object identity changed: ${entry.key}`);
    }
    return buildR2ChecksumAwarePutIntent({ key: entry.key, body, contentType: entry.content_type });
  }).sort((left, right) => {
    const stage = (key) => key.endsWith("/manifest.json") ? 2 : key.endsWith(".json") ? 1 : 0;
    return stage(left.key) - stage(right.key) || left.key.localeCompare(right.key);
  });

  const results = [];
  for (const intent of intents) {
    const existing = await r2HeadObject({ r2, key: intent.key });
    if (existing?.exists !== false) {
      const existingSha = normalizeR2Sha256Checksum(existing.sha256 ?? existing.checksums?.sha256);
      if (Number(existing.bytes ?? existing.size) === intent.byte_size && existingSha === intent.sha256) {
        results.push({ key: intent.key, action: "unchanged" });
        continue;
      }
      if (!options.replaceExisting) {
        throw new Error(`prototype object differs; review then pass --replace-existing: ${intent.key}`);
      }
    }
    const verified = await putAndVerifyR2ObjectWithSha256({ r2, intent });
    results.push({ key: intent.key, action: "put", ...verified });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, environment: "TEST", prototype_prefix: prefix, results }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
