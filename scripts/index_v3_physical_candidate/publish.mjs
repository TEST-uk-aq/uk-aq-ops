#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { hasRequiredR2Config, r2HeadObject } from "../../workers/shared/r2_sigv4.mjs";
import {
  buildR2ChecksumAwarePutIntent,
  putAndVerifyR2ObjectWithSha256,
  verifyR2StoredSha256Head,
} from "../../workers/shared/uk_aq_r2_checksum_publication.mjs";
import { assertAlignedV2TestR2Identity } from "../index_v3_aligned_candidate/test_r2_identity.mjs";

const PREFIX = "history/_prototype/observation-history/timeseries-aligned-v2/candidate=physical-index-v1";
const INDEX_ROOT = `${PREFIX}/observations_timeseries`;

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
    endpoint: required(env.CFLARE_R2_ENDPOINT),
    bucket: required(env.CFLARE_R2_BUCKET),
    region: required(env.CFLARE_R2_REGION || "auto"),
    access_key_id: required(env.CFLARE_R2_ACCESS_KEY_ID),
    secret_access_key: required(env.CFLARE_R2_SECRET_ACCESS_KEY),
  };
}

function required(value) {
  return String(value || "").trim();
}

export function classifyExistingPhysicalCandidateObject({ head, intent }) {
  if (!head || head.exists === false) return null;
  return Object.freeze({
    action: "unchanged",
    ...verifyR2StoredSha256Head({ head, intent, requireStoredByteSize: false }),
  });
}

async function main() {
  const options = parse(process.argv.slice(2));
  assertAlignedV2TestR2Identity(process.env);
  if (!options.plan) throw new Error("--plan is required");
  const planPath = path.resolve(options.plan);
  const root = path.dirname(planPath);
  const plan = JSON.parse(fs.readFileSync(planPath));
  if (
    plan.environment !== "TEST" || plan.prototype_prefix !== PREFIX ||
    plan.index_root !== INDEX_ROOT || plan.aligned_row_cap !== 2048 ||
    plan.reuses_aligned_parquet !== true || plan.parquet_objects?.length !== 0
  ) throw new Error("publication plan is not the exact TEST physical-index candidate plan");
  if (options.confirm !== PREFIX) throw new Error(`--confirm-test-prefix must exactly equal ${PREFIX}`);
  const r2 = r2Config(process.env);
  if (!hasRequiredR2Config(r2)) throw new Error("incomplete CFLARE_R2_* credentials/configuration");
  const seen = new Set();
  const intents = plan.objects.map((entry) => {
    if (
      seen.has(entry.key) || !entry.key.startsWith(`${INDEX_ROOT}/`) || !entry.key.endsWith(".json") ||
      entry.content_type !== "application/json; charset=utf-8" ||
      entry.local_path !== path.join("objects", entry.key) ||
      /(?:history\/v2|_index_v3|_latest|backup|checkpoint|live|\.parquet$)/i.test(entry.key)
    ) throw new Error(`unsafe or duplicate physical-candidate publication key: ${entry.key}`);
    seen.add(entry.key);
    const body = fs.readFileSync(path.join(root, entry.local_path));
    const digest = crypto.createHash("sha256").update(body).digest("hex");
    if (body.byteLength !== entry.byte_size || digest !== entry.sha256) {
      throw new Error(`local object identity changed: ${entry.key}`);
    }
    return buildR2ChecksumAwarePutIntent({ key: entry.key, body, contentType: entry.content_type });
  }).sort((left, right) => {
    const stage = (key) => key.endsWith("/manifest.json") ? 2 : 1;
    return stage(left.key) - stage(right.key) || left.key.localeCompare(right.key);
  });
  const results = [];
  for (const intent of intents) {
    const existing = await r2HeadObject({ r2, key: intent.key });
    if (existing?.exists !== false) {
      try {
        const unchanged = classifyExistingPhysicalCandidateObject({ head: existing, intent });
        if (unchanged) { results.push(unchanged); continue; }
      } catch (error) {
        if (!options.replaceExisting) {
          throw new Error(`candidate object differs; review then pass --replace-existing: ${intent.key}`, { cause: error });
        }
      }
    }
    const verified = await putAndVerifyR2ObjectWithSha256({
      r2, intent, requireStoredByteSize: false,
    });
    results.push({ key: intent.key, action: "put", ...verified });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, environment: "TEST", prototype_prefix: PREFIX, results }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
