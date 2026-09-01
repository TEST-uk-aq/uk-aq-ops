#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { hasRequiredR2Config, r2GetObject } from "../../workers/shared/r2_sigv4.mjs";
import { assertAlignedV2TestR2Identity } from "./test_r2_identity.mjs";

const PARTITIONS = [
  { directory: "aurn_2026-08-20_pm25", day: "2026-08-20", connector: 1, pollutant: "pm25" },
  { directory: "sensorcommunity_normal_2026-08-20_pm25", day: "2026-08-20", connector: 7, pollutant: "pm25" },
  { directory: "sensorcommunity_dense_2026-04-03_pm25", day: "2026-04-03", connector: 7, pollutant: "pm25" },
];

function parse(argv) {
  const index = argv.indexOf("--output-root");
  if (index < 0 || !argv[index + 1]) throw new Error("--output-root is required");
  return { output: path.resolve(argv[index + 1]), replace: argv.includes("--replace") };
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

function sha256(body) {
  return crypto.createHash("sha256").update(body).digest("hex");
}

async function main() {
  assertAlignedV2TestR2Identity(process.env);
  const options = parse(process.argv.slice(2));
  if (options.output === path.parse(options.output).root || options.output.split(path.sep).length < 4) {
    throw new Error("refusing broad local staging target");
  }
  if (fs.existsSync(options.output)) {
    if (!options.replace) throw new Error("staging target exists; pass --replace for this exact local target");
    fs.rmSync(options.output, { recursive: true });
  }
  fs.mkdirSync(options.output, { recursive: true });
  const r2 = r2Config(process.env);
  if (!hasRequiredR2Config(r2)) throw new Error("incomplete CFLARE_R2_* credentials/configuration");
  const report = [];
  for (const partition of PARTITIONS) {
    const canonicalPrefix = `history/v2/observations/day_utc=${partition.day}/connector_id=${partition.connector}/pollutant_code=${partition.pollutant}`;
    const manifestKey = `${canonicalPrefix}/manifest.json`;
    const manifestObject = await r2GetObject({ r2, key: manifestKey });
    const manifest = JSON.parse(manifestObject.body);
    if (manifest.day_utc !== partition.day || Number(manifest.connector_id) !== partition.connector || manifest.pollutant_code !== partition.pollutant) {
      throw new Error(`canonical manifest scope mismatch: ${manifestKey}`);
    }
    const directory = path.join(options.output, partition.directory);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "manifest.json"), manifestObject.body, { flag: "wx" });
    const files = [];
    for (const descriptor of manifest.files || []) {
      if (!String(descriptor.key).startsWith(`${canonicalPrefix}/part-`) || !String(descriptor.key).endsWith(".parquet")) {
        throw new Error(`canonical manifest contains an unexpected source key: ${descriptor.key}`);
      }
      const object = await r2GetObject({ r2, key: descriptor.key });
      const actualSha = sha256(object.body);
      if (actualSha !== descriptor.etag_or_hash || object.body.byteLength !== Number(descriptor.bytes)) {
        throw new Error(`canonical source object identity mismatch: ${descriptor.key}`);
      }
      fs.writeFileSync(path.join(directory, path.basename(descriptor.key)), object.body, { flag: "wx" });
      files.push({ key: descriptor.key, byte_size: object.body.byteLength, sha256: actualSha });
    }
    report.push({ ...partition, manifest_key: manifestKey, row_count: manifest.row_count, observation_content_hash: manifest.observation_content_hash, files });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, environment: "TEST", source_read_only: true, output_root: options.output, partitions: report }, null, 2)}\n`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
