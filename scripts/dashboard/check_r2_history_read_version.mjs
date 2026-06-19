#!/usr/bin/env node

const ACCEPTED = new Set(["v1", "v2"]);
const DEFAULT_VERSION = "v1";

function resolveR2HistoryReadVersion(env = process.env) {
  const raw = String(env.UK_AQ_R2_HISTORY_READ_VERSION || "").trim();
  const normalized = raw.toLowerCase();
  if (!normalized) {
    return {
      version: DEFAULT_VERSION,
      label: `R2_${DEFAULT_VERSION}`,
      source: "default_missing_env",
      warning: `UK_AQ_R2_HISTORY_READ_VERSION is not set; defaulting to ${DEFAULT_VERSION} to preserve existing dashboard behaviour.`,
      valid: true,
      raw,
    };
  }
  if (ACCEPTED.has(normalized)) {
    return { version: normalized, label: `R2_${normalized}`, source: "env", warning: null, valid: true, raw };
  }
  return {
    version: null,
    label: "R2 invalid",
    source: "invalid_env",
    warning: `Invalid UK_AQ_R2_HISTORY_READ_VERSION=${JSON.stringify(raw)}; expected v1 or v2.`,
    valid: false,
    raw,
  };
}

const cases = [
  ["v1", { UK_AQ_R2_HISTORY_READ_VERSION: "v1" }, { version: "v1", label: "R2_v1", valid: true, source: "env" }],
  ["v2", { UK_AQ_R2_HISTORY_READ_VERSION: "v2" }, { version: "v2", label: "R2_v2", valid: true, source: "env" }],
  ["missing", {}, { version: "v1", label: "R2_v1", valid: true, source: "default_missing_env" }],
  ["invalid", { UK_AQ_R2_HISTORY_READ_VERSION: "v3" }, { version: null, label: "R2 invalid", valid: false, source: "invalid_env" }],
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
