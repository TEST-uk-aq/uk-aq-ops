#!/usr/bin/env node

import {
  deprecatedR2HistoryVersionVarsPresent,
  parseR2HistoryVersion,
} from "../../workers/shared/uk_aq_r2_history_version.mjs";

function resolveR2HistoryReadVersion(env = process.env) {
  const deprecated = deprecatedR2HistoryVersionVarsPresent(env);
  if (deprecated.length > 0) {
    return {
      version: null,
      label: "R2 invalid",
      source: "invalid_env",
      warning: `Deprecated R2 history version env var(s) ${deprecated.join(", ")} are no longer supported. Use UK_AQ_R2_HISTORY_VERSION=v1|v2.`,
      valid: false,
      raw: "",
    };
  }
  const raw = String(env.UK_AQ_R2_HISTORY_VERSION || "").trim();
  try {
    const version = parseR2HistoryVersion(raw);
    return { version, label: `R2_${version}`, source: "env", warning: null, valid: true, raw };
  } catch (error) {
    return {
      version: null,
      label: "R2 invalid",
      source: raw ? "invalid_env" : "missing_env",
      warning: error instanceof Error ? error.message : String(error),
      valid: false,
      raw,
    };
  }
}

const cases = [
  ["v1", { UK_AQ_R2_HISTORY_VERSION: "v1" }, { version: "v1", label: "R2_v1", valid: true, source: "env" }],
  ["v2", { UK_AQ_R2_HISTORY_VERSION: "v2" }, { version: "v2", label: "R2_v2", valid: true, source: "env" }],
  ["missing", {}, { version: null, label: "R2 invalid", valid: false, source: "missing_env" }],
  ["invalid", { UK_AQ_R2_HISTORY_VERSION: "v3" }, { version: null, label: "R2 invalid", valid: false, source: "invalid_env" }],
  ["deprecated", { UK_AQ_R2_HISTORY_READ_VERSION: "v2", UK_AQ_R2_HISTORY_VERSION: "v2" }, { version: null, label: "R2 invalid", valid: false, source: "invalid_env" }],
];

for (const [name, env, expected] of cases) {
  const actual = resolveR2HistoryReadVersion(env);
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) {
      console.error(`${name}: expected ${key}=${value}, got ${actual[key]}`);
      process.exit(1);
    }
  }
  console.log(`${name}: ${actual.label} (${actual.source})`);
}
