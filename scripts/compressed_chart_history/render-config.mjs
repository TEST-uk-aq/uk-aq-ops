#!/usr/bin/env node
// Local configuration rendering only. Never provisions, deploys or writes R2.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPilotConfig, parsePairs } from "./configuration.mjs";
import { canonicalText } from "../../workers/shared/uk_aq_compressed_chart_pilot.mjs";
import { requireCondition as check } from "./source_reader.mjs";
async function main() {
  const values = parsePairs(process.argv.slice(2), ["config", "worker-name", "hostname", "output"], ["enable"]);
  check(values.config && values["worker-name"] && values.hostname && path.isAbsolute(values.output || ""), "Required: --config /private/experiment.json --worker-name NAME --hostname ACCESS-PROTECTED-HOST --output /private/new.toml [--enable]");
  const { config } = await loadPilotConfig(values.config);
  check(/^[a-z0-9][a-z0-9-]{0,62}$/.test(values["worker-name"]), "Explicit Worker name required");
  const hostname = new URL(`https://${values.hostname}`);
  check(hostname.hostname === values.hostname && hostname.pathname === "/" && !hostname.port && !hostname.username && !hostname.password,
    "Supply a reviewed bare hostname with an existing Access Service Auth policy");
  const accountId = new URL(config.derived_endpoint).hostname.split(".")[0];
  check(/^[a-f0-9]{32}$/.test(accountId), "Derived endpoint must identify the approved deployment account");
  const entry = fileURLToPath(new URL("../../workers/uk_aq_compressed_chart_history/worker.mjs", import.meta.url));
  // JSON basic strings are valid TOML basic strings for these admitted values.
  const text = `account_id = ${JSON.stringify(accountId)}\nname = ${JSON.stringify(values["worker-name"])}\nmain = ${JSON.stringify(entry)}\ncompatibility_date = "2026-10-09"\nworkers_dev = false\npreview_urls = false\n\n[[r2_buckets]]\nbinding = "UK_AQ_COMPRESSED_CHART_BUCKET"\nbucket_name = ${JSON.stringify(config.derived_bucket)}\n\n[vars]\nUK_AQ_ENV_NAME = ${JSON.stringify(config.environment)}\nUK_AQ_COMPRESSED_CHART_ENABLED = ${JSON.stringify(values.enable ? "true" : "false")}\nUK_AQ_COMPRESSED_CHART_CONFIG = ${JSON.stringify(canonicalText(config).trimEnd())}\n\n[[routes]]\npattern = ${JSON.stringify(hostname.hostname)}\ncustom_domain = true\n`;
  await fs.writeFile(values.output, text, { flag: "wx", mode: 0o600 });
  console.log(`Local Worker config rendered ${values.enable ? "enabled" : "disabled"}; no remote operation. Add the existing upstream secret only after separate deployment authorisation.`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Config rendering stopped: ${error.message}`); process.exitCode = 1; });
}
