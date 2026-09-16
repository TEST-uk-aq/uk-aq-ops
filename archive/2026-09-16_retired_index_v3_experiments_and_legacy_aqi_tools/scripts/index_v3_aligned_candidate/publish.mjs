#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  hasRequiredR2Config,
  r2HeadObject,
} from "../../workers/shared/r2_sigv4.mjs";
import {
  buildR2ChecksumAwarePutIntent,
  putAndVerifyR2ObjectWithSha256,
  verifyR2StoredSha256Head,
} from "../../workers/shared/uk_aq_r2_checksum_publication.mjs";
import { assertAlignedV2TestR2Identity } from "./test_r2_identity.mjs";

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

export function classifyExistingAlignedV2PrototypeObject({ head, intent }) {
  if (!head || head.exists === false) return null;
  const verified = verifyR2StoredSha256Head({
    head,
    intent,
    requireStoredByteSize: false,
  });
  return Object.freeze({ action: "unchanged", ...verified });
}

async function main() {
  const options = parse(process.argv.slice(2));
  assertAlignedV2TestR2Identity(process.env);
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
      try {
        const unchanged = classifyExistingAlignedV2PrototypeObject({
          head: existing,
          intent,
        });
        if (unchanged) {
          results.push(unchanged);
          continue;
        }
      } catch (error) {
        if (!options.replaceExisting) {
          throw new Error(
            `prototype object differs; review then pass --replace-existing: ${intent.key}`,
            { cause: error },
          );
        }
      }
    }
    const verified = await putAndVerifyR2ObjectWithSha256({
      r2,
      intent,
      requireStoredByteSize: false,
    });
    results.push({ key: intent.key, action: "put", ...verified });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, environment: "TEST", prototype_prefix: prefix, results }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
