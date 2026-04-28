#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function stripWrappingQuotes(value) {
  let normalized = String(value ?? "");
  while (normalized.length >= 2) {
    const first = normalized[0];
    const last = normalized[normalized.length - 1];
    if (
      (first === '"' && last === '"') ||
      (first === "'" && last === "'")
    ) {
      normalized = normalized.slice(1, -1);
      continue;
    }
    break;
  }
  return normalized;
}

const outPath = process.env.UKAQ_CONFIG_OUT_PATH || "dashboard/assets/config.js";

const defaultRefreshSeconds = Number.parseInt(
  stripWrappingQuotes(process.env.UKAQ_DEFAULT_REFRESH_SECONDS || "300"),
  10,
);

const config = {
  envName: stripWrappingQuotes(process.env.UKAQ_ENV_NAME || "local"),
  apiBaseUrl: stripWrappingQuotes(process.env.UKAQ_API_BASE_URL || "/api"),
  dashboardTitle: stripWrappingQuotes(process.env.UKAQ_DASHBOARD_TITLE || "UK AQ Dashboard"),
  dashboardSubtitle: String(
    stripWrappingQuotes(process.env.UKAQ_DASHBOARD_SUBTITLE) ||
      "Live snapshot of PM2.5, PM10, and NO2 freshness using timeseries last_value_at. Data updates from your local API.",
  ),
  defaultRefreshSeconds:
    Number.isFinite(defaultRefreshSeconds) && defaultRefreshSeconds > 0
      ? defaultRefreshSeconds
      : 300,
};

const output = `window.UKAQ_OPS_CONFIG = ${JSON.stringify(config, null, 2)};\n`;
const absoluteOutPath = path.resolve(process.cwd(), outPath);
fs.mkdirSync(path.dirname(absoluteOutPath), { recursive: true });
fs.writeFileSync(absoluteOutPath, output, "utf8");
console.log(`Wrote dashboard config: ${absoluteOutPath}`);
