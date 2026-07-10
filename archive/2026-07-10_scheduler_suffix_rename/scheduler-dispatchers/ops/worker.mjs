import {
  currentUtcDate,
  evaluateDailyTaskJob,
  fetchPostgrestRows,
  jsonResponse,
  logJson,
  normalizeBaseUrl,
  nowIso,
  readSecret,
  shiftUtcDate,
  summarizeDecision,
} from "../shared.mjs";

const WORKER_NAME = "uk-aq-scheduler-ops";
const OPS_SCHEMA = "uk_aq_ops";
const OPS_TABLE = "daily_task_runs_dashboard";
const OPS_SELECT = "run_id,task_key,task_name,platform,source,scheduled_for_date,scheduled_time_utc,scheduled_at_utc,attempt,raw_status,started_at,finished_at,failed_at,updated_at,duration_seconds,summary,error_message,log_url,effective_status,scheduled_or_started_at,finished_or_failed_at,is_failed,is_overdue,is_not_started,task_day_rank";
const DEFAULT_LIMIT = 10;

export const OPS_JOBS = [
  {
    job_key: "ops.prune_daily",
    label: "Prune daily",
    target_label: "uk-aq-prune-daily",
    state_source: "daily_task_runs",
    task_key: "ops.prune_daily",
    cron: "0 * * * *",
    scheduled_time_utc: "02:00",
    due_after_minutes: 45,
    min_gap_minutes: 60,
    stale_after_minutes: 180,
    enabled: true,
  },
  {
    job_key: "ops.observs_partition_maintenance",
    label: "Observs partition maintenance",
    target_label: "uk-aq-observs-partition-maintenance-service",
    state_source: "daily_task_runs",
    task_key: "ops.observs_partition_maintenance",
    cron: "0 * * * *",
    scheduled_time_utc: "03:00",
    due_after_minutes: 45,
    min_gap_minutes: 60,
    stale_after_minutes: 180,
    enabled: true,
  },
];

async function loadRowsForJob(job, env, nowMs) {
  const supabaseUrl = normalizeBaseUrl(await readSecret(env.OBS_AQIDB_SUPABASE_URL));
  const secretKey = await readSecret(env.OBS_AQIDB_SECRET_KEY);
  const dayStart = shiftUtcDate(currentUtcDate(nowMs), -7);
  return fetchPostgrestRows({
    baseUrl: supabaseUrl,
    schema: OPS_SCHEMA,
    table: OPS_TABLE,
    secretKey,
    select: OPS_SELECT,
    filters: {
      task_key: `eq.${job.task_key}`,
      scheduled_for_date: `gte.${dayStart}`,
    },
    order: "scheduled_for_date.desc,updated_at.desc.nullslast,run_id.desc",
    limit: DEFAULT_LIMIT,
  });
}

async function evaluateJob(job, env, nowMs) {
  try {
    const rows = await loadRowsForJob(job, env, nowMs);
    const decision = evaluateDailyTaskJob(job, rows, nowMs);
    const summary = summarizeDecision(job, decision, rows, nowMs);
    logJson(WORKER_NAME, "dry_run_decision", summary);
    return { ok: true, ...summary };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure = {
      job_key: job.job_key,
      label: job.label,
      target_label: job.target_label,
      state_source: job.state_source,
      enabled: job.enabled !== false,
      dry_run: true,
      cron: job.cron,
      due: false,
      reason: "state_load_failed",
      would_trigger: false,
      error: message,
      now_utc: nowIso(nowMs),
    };
    logJson(WORKER_NAME, "dry_run_error", failure);
    return { ok: false, ...failure };
  }
}

async function runDispatcher(env, nowMs = Date.now()) {
  const results = [];
  for (const job of OPS_JOBS) {
    results.push(await evaluateJob(job, env, nowMs));
  }

  logJson(WORKER_NAME, "dry_run_summary", {
    job_count: results.length,
    due_count: results.filter((result) => result.due).length,
    would_trigger_count: results.filter((result) => result.would_trigger).length,
    failed_count: results.filter((result) => !result.ok).length,
    skipped_count: results.filter((result) => !result.due && result.ok).length,
    dry_run: true,
  });

  return results;
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runDispatcher(env));
  },

  async fetch() {
    return jsonResponse({
      ok: true,
      worker: WORKER_NAME,
      dry_run: true,
      scheduled_cron: "0 * * * *",
      jobs: OPS_JOBS.map((job) => ({
        job_key: job.job_key,
        target_label: job.target_label,
        cron: job.cron,
        enabled: job.enabled !== false,
      })),
    }, 200);
  },
};

export { runDispatcher };
