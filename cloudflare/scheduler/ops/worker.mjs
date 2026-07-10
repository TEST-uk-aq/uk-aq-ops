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
const UPSTREAM_AUTH_HEADER = "x-uk-aq-upstream-auth";

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
    dispatch_kind: "cloud_run",
    service_url_env: "UK_AQ_PRUNE_DAILY_SERVICE_URL",
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
    dispatch_kind: "cloud_run",
    service_url_env: "UK_AQ_OBSERVS_PARTITION_MAINTENANCE_SERVICE_URL",
  },
  {
    job_key: "ops.r2_core_snapshot",
    label: "R2 core snapshot",
    target_label: "uk_aq_r2_core_snapshot.yml",
    state_source: "daily_task_runs",
    task_key: "ops.r2_core_snapshot",
    cron: "20 12 * * *",
    scheduled_time_utc: "12:55",
    due_after_minutes: 0,
    min_gap_minutes: 60,
    stale_after_minutes: 180,
    enabled: true,
    owner: "YOUR_GITHUB_OWNER",
    repo: "uk-aq-ops",
    workflow_file: "uk_aq_r2_core_snapshot.yml",
    ref: "main",
    dispatch_kind: "github_workflow",
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

function jobsForCron(cronExpression) {
  return OPS_JOBS.filter((job) => job.cron === cronExpression);
}

function workflowDispatchUrl(job) {
  const owner = encodeURIComponent(job.owner);
  const repo = encodeURIComponent(job.repo);
  const workflow = encodeURIComponent(job.workflow_file);
  return `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`;
}

function cloudRunDispatchUrl(serviceUrl) {
  return `${normalizeBaseUrl(serviceUrl)}/run`;
}

async function dispatchWorkflow(job, token) {
  const url = workflowDispatchUrl(job);
  const label = `${job.owner}/${job.repo}:${job.workflow_file}@${job.ref}`;
  const body = {
    ref: job.ref,
  };

  logJson(WORKER_NAME, "github_dispatch_attempt", {
    job_key: job.job_key,
    workflow: label,
    body,
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "uk-aq-scheduler-ops",
    },
    body: JSON.stringify(body),
  });

  logJson(WORKER_NAME, "github_dispatch_response", {
    job_key: job.job_key,
    workflow: label,
    status: response.status,
  });

  if (!response.ok) {
    const errorBody = (await response.text()).slice(0, 4000);
    logJson(WORKER_NAME, "github_dispatch_error", {
      job_key: job.job_key,
      workflow: label,
      status: response.status,
      error_body: errorBody,
    });
    throw new Error(`GitHub dispatch failed for job_key=${job.job_key} workflow=${label} (status ${response.status})`);
  }
}

async function dispatchCloudRun(job, env) {
  const serviceUrl = normalizeBaseUrl(await readSecret(env[job.service_url_env]));
  if (!serviceUrl) {
    throw new Error(`Missing required Worker var: ${job.service_url_env}`);
  }

  const upstreamSecret = await readSecret(env.UK_AQ_EDGE_UPSTREAM_SECRET);
  if (!upstreamSecret) {
    throw new Error("Missing required Worker secret: UK_AQ_EDGE_UPSTREAM_SECRET");
  }

  const url = cloudRunDispatchUrl(serviceUrl);
  logJson(WORKER_NAME, "cloud_run_dispatch_attempt", {
    job_key: job.job_key,
    target_label: job.target_label,
    url,
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      [UPSTREAM_AUTH_HEADER]: upstreamSecret,
      "User-Agent": "uk-aq-scheduler-ops",
    },
    body: "{}",
  });

  logJson(WORKER_NAME, "cloud_run_dispatch_response", {
    job_key: job.job_key,
    target_label: job.target_label,
    status: response.status,
  });

  if (!response.ok) {
    const errorBody = (await response.text()).slice(0, 4000);
    logJson(WORKER_NAME, "cloud_run_dispatch_error", {
      job_key: job.job_key,
      target_label: job.target_label,
      status: response.status,
      error_body: errorBody,
    });
    throw new Error(`Cloud Run dispatch failed for job_key=${job.job_key} target=${job.target_label} (status ${response.status})`);
  }
}

async function evaluateJob(job, env, nowMs) {
  let rows;
  try {
    rows = await loadRowsForJob(job, env, nowMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure = {
      job_key: job.job_key,
      label: job.label,
      target_label: job.target_label,
      state_source: job.state_source,
      enabled: job.enabled !== false,
      dry_run: false,
      dispatch_kind: job.dispatch_kind || "unknown",
      cron: job.cron,
      due: false,
      reason: "state_load_failed",
      would_trigger: false,
      error: message,
      now_utc: nowIso(nowMs),
    };
    logJson(WORKER_NAME, job.dispatch_kind === "github_workflow" ? "dispatch_error" : "run_error", failure);
    return { ok: false, ...failure };
  }

  const decision = evaluateDailyTaskJob(job, rows, nowMs);
  const summary = {
    ...summarizeDecision(job, decision, rows, nowMs),
    dispatch_kind: job.dispatch_kind || "unknown",
    dry_run: false,
  };

  if (job.dispatch_kind === "github_workflow" && decision.due && decision.wouldTrigger) {
    try {
      const token = await readSecret(env.GITHUB_WORKFLOW_DISPATCH_TOKEN);
      if (!token) {
        throw new Error("Missing required Worker secret: GITHUB_WORKFLOW_DISPATCH_TOKEN");
      }
      await dispatchWorkflow(job, token);
      logJson(WORKER_NAME, "dispatch_decision", {
        ...summary,
        dispatch_status: "dispatched",
      });
      return { ok: true, ...summary, dispatch_status: "dispatched" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure = {
        ...summary,
        due: false,
        reason: "dispatch_failed",
        would_trigger: false,
        error: message,
        now_utc: nowIso(nowMs),
      };
      logJson(WORKER_NAME, "dispatch_error", failure);
      return { ok: false, ...failure };
    }
  }

  if (job.dispatch_kind === "cloud_run" && decision.due && decision.wouldTrigger) {
    try {
      await dispatchCloudRun(job, env);
      logJson(WORKER_NAME, "dispatch_decision", {
        ...summary,
        dispatch_status: "dispatched",
      });
      return { ok: true, ...summary, dispatch_status: "dispatched" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure = {
        ...summary,
        due: false,
        reason: "dispatch_failed",
        would_trigger: false,
        error: message,
        now_utc: nowIso(nowMs),
      };
      logJson(WORKER_NAME, "dispatch_error", failure);
      return { ok: false, ...failure };
    }
  }

  logJson(WORKER_NAME, "dispatch_decision", {
    ...summary,
    dispatch_status: "not_due",
  });
  return { ok: true, ...summary, dispatch_status: "not_due" };
}

async function runDispatcher(env, cronExpression, nowMs = Date.now()) {
  const jobs = jobsForCron(cronExpression);
  const results = [];
  for (const job of jobs) {
    results.push(await evaluateJob(job, env, nowMs));
  }

  logJson(WORKER_NAME, "dispatch_summary", {
    cron: cronExpression,
    job_count: results.length,
    due_count: results.filter((result) => result.due).length,
    would_trigger_count: results.filter((result) => result.would_trigger).length,
    failed_count: results.filter((result) => !result.ok).length,
    skipped_count: results.filter((result) => !result.due && result.ok).length,
    real_run: true,
  });

  return results;
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runDispatcher(env, controller?.cron || ""));
  },

  async fetch() {
    return jsonResponse({
      ok: true,
      worker: WORKER_NAME,
      mode: "real",
      scheduled_crons: [...new Set(OPS_JOBS.map((job) => job.cron))],
      jobs: OPS_JOBS.map((job) => ({
        job_key: job.job_key,
        target_label: job.target_label,
        cron: job.cron,
        enabled: job.enabled !== false,
        dispatch_kind: job.dispatch_kind || "unknown",
      })),
    }, 200);
  },
};

export { runDispatcher };
