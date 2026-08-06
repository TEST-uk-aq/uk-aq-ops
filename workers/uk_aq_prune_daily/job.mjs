import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  buildRunConfig,
  executePruneDaily,
  reportPruneDailyError,
} from "./server.mjs";

const REPORT_PATH = "tmp/uk_aq_prune_daily_report.json";

function boundedValue(value, depth = 0) {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value.length <= 4_000 ? value : `${value.slice(0, 3_997)}...`;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (depth >= 8) {
    return "[MaxDepth]";
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => boundedValue(entry, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).slice(0, 100).map(([key, entry]) => [key, boundedValue(entry, depth + 1)]),
    );
  }
  return String(value);
}

export async function writeReport(payload) {
  await mkdir("tmp", { recursive: true });
  await writeFile(REPORT_PATH, `${JSON.stringify(boundedValue(payload), null, 2)}\n`, "utf8");
}

export async function runPruneDailyJob({
  env = process.env,
  buildRunConfigAdapter = buildRunConfig,
  executePruneDailyAdapter = executePruneDaily,
  reportPruneDailyErrorAdapter = reportPruneDailyError,
  writeReportAdapter = writeReport,
  setExitCode = (code) => {
    process.exitCode = code;
  },
} = {}) {
  const url = new URL("http://localhost/");
  if (env.INPUT_DRY_RUN === "true") {
    url.searchParams.set("dryRun", "true");
  }

  try {
    const config = buildRunConfigAdapter(url);
    const summary = await executePruneDailyAdapter(config);
    const payload = { ok: true, summary };
    await writeReportAdapter(payload);
    return payload;
  } catch (error) {
    const errorReport = await reportPruneDailyErrorAdapter(error, {
      execution_mode: "github_actions",
    });
    const payload = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...errorReport,
    };
    await writeReportAdapter(payload);
    setExitCode(1);
    return payload;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  await runPruneDailyJob();
}
