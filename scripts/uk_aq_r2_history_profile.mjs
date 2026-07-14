#!/usr/bin/env node
import { parseArgs } from "node:util";
import { getR2HistoryProfile } from "../workers/shared/uk_aq_r2_history_profile.mjs";
import { parseR2HistoryVersion } from "../workers/shared/uk_aq_r2_history_version.mjs";

const { values, positionals } = parseArgs({
  options: {
    version: {
      type: "string",
      short: "v",
    },
    format: {
      type: "string",
      short: "f",
      default: "show",
    },
    show: {
      type: "boolean",
    },
  },
  strict: true,
});

try {
  let format = values.format;
  if (values.show) {
    format = "show";
  }

  const version = parseR2HistoryVersion(values.version, { varName: "--version", required: true });
  const profile = getR2HistoryProfile(version);

  if (format === "json") {
    console.log(JSON.stringify(profile, null, 2));
  } else if (format === "env") {
    for (const [k, v] of Object.entries(profile)) {
      if (v === null) continue;
      console.log(`UK_AQ_R2_HISTORY_PROFILE_${k.toUpperCase()}=${v}`);
    }
  } else {
    console.log(`R2 History Profile: ${profile.version}`);
    console.log(`------------------------`);
    for (const [k, v] of Object.entries(profile)) {
      console.log(`${k.padEnd(40)} ${v === null ? "(null)" : v}`);
    }
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
