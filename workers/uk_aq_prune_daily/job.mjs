import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { withDailyTaskRun } from "../shared/daily_task_health.mjs";
import { resolveR2HistoryIndexConfig } from "../shared/uk_aq_r2_history_index.mjs";
import {
  finalizeR2HistoryV2ObservationsManifestHierarchy,
} from "../shared/uk_aq_r2_observations_manifest_hierarchy_finalizer.mjs";
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

function exactPruneObservationAffectedDays(summary) {
  const days = summary?.phase_b_history?.global_index_finalization?.affected_days_utc;
  return Array.isArray(days) ? days : [];
}

export async function finalizePruneObservationsManifestHierarchy({
  summary,
  env = process.env,
  dryRun = false,
  resolveR2HistoryIndexConfigAdapter = resolveR2HistoryIndexConfig,
  finalizerAdapter = finalizeR2HistoryV2ObservationsManifestHierarchy,
}) {
  const affectedDaysUtc = exactPruneObservationAffectedDays(summary);
  if (dryRun || summary?.mode === "dry-run" || summary?.phase_b_history?.dry_run === true) {
    return {
      ok: true,
      status: "skipped",
      reason: "prune_daily_dry_run",
      affected_days_utc: affectedDaysUtc,
    };
  }
  if (affectedDaysUtc.length === 0) {
    return {
      ok: true,
      status: "skipped",
      reason: "no_finalized_observation_days",
      affected_days_utc: [],
    };
  }

  const indexConfig = resolveR2HistoryIndexConfigAdapter(env);
  return await finalizerAdapter({
    r2: indexConfig.r2,
    observationsPrefix: indexConfig.observations_prefix_v2,
    affectedDaysUtc,
    maxKeys: indexConfig.max_keys || 1000,
    writeR2: true,
  });
}

export function createPruneDailyHierarchyTaskRunAdapter({
  env = process.env,
  dryRun = false,
  withDailyTaskRunAdapter = withDailyTaskRun,
  resolveR2HistoryIndexConfigAdapter = resolveR2HistoryIndexConfig,
  finalizerAdapter = finalizeR2HistoryV2ObservationsManifestHierarchy,
} = {}) {
  return (options, callback) => withDailyTaskRunAdapter(options, async () => {
    const summary = await callback();
    const hierarchy = await finalizePruneObservationsManifestHierarchy({
      summary,
      env,
      dryRun,
      resolveR2HistoryIndexConfigAdapter,
      finalizerAdapter,
    });
    return {
      ...summary,
      observations_manifest_hierarchy: hierarchy,
    };
  });
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
  withDailyTaskRunAdapter = withDailyTaskRun,
  resolveR2HistoryIndexConfigAdapter = resolveR2HistoryIndexConfig,
  finalizerAdapter = finalizeR2HistoryV2ObservationsManifestHierarchy,
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
    const hierarchyTaskRunAdapter = createPruneDailyHierarchyTaskRunAdapter({
      env,
      dryRun: config.dryRun === true,
      withDailyTaskRunAdapter,
      resolveR2HistoryIndexConfigAdapter,
      finalizerAdapter,
    });
    const summary = await executePruneDailyAdapter(config, {
      withDailyTaskRun: hierarchyTaskRunAdapter,
    });
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
