/**
 * Cloudflare Worker scheduler for GitHub Actions workflow_dispatch.
 *
 * DO NOT edit schedules in this file.
 * Edit only cloudflare/workflow-scheduler/wrangler.toml.
 *
 * Notes:
 * - Cron values are generated into this file at deploy time from wrangler.toml.
 * - YOUR_GITHUB_OWNER is replaced at deploy with github.repository_owner.
 */
export const CRON_JOB_MAP = Object.freeze({
  /* DEPLOY_CRON_MAP_START */
  /* DEPLOY_CRON_MAP_END */
});

const HISTORY_VERSION_VALUES = new Set(["v1", "v2"]);

function resolveHistoryVersion(env) {
  const value = String(env?.UK_AQ_R2_HISTORY_VERSION || "").trim().toLowerCase();
  if (HISTORY_VERSION_VALUES.has(value)) {
    return value;
  }
  if (!value) {
    throw new Error("Missing required Worker var: UK_AQ_R2_HISTORY_VERSION");
  }
  throw new Error(`Invalid Worker var UK_AQ_R2_HISTORY_VERSION=${JSON.stringify(value)}; expected v1 or v2`);
}

export const JOBS = [
  // job_key: uk_aq_stations_daily
  {
    job_key: "uk_aq_stations_daily",
    owner: "YOUR_GITHUB_OWNER",
    repo: "uk-aq-ingest",
    workflow_file: "uk_aq_stations_daily.yml",
    ref: "main",
  },
];

export function workflowDispatchUrl(job) {
  const owner = encodeURIComponent(job.owner);
  const repo = encodeURIComponent(job.repo);
  const workflow = encodeURIComponent(job.workflow_file);
  return `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`;
}

export function jobsForCron(cronExpression) {
  const jobKeys = CRON_JOB_MAP[cronExpression] || [];
  if (jobKeys.length === 0) {
    return [];
  }

  const jobsByKey = new Map(JOBS.map((job) => [job.job_key, job]));
  return jobKeys.map((jobKey) => jobsByKey.get(jobKey)).filter(Boolean);
}

export function inputsForJob(job, env = {}) {
  const inputs = { ...(job.inputs || {}) };
  if (job.history_version_input) {
    inputs.history_version = resolveHistoryVersion(env);
  }
  return Object.keys(inputs).length > 0 ? inputs : null;
}

function skipReasonForJob(job, env = {}) {
  if (!job.required_history_version) {
    return null;
  }

  const activeHistoryVersion = resolveHistoryVersion(env);
  if (activeHistoryVersion === job.required_history_version) {
    return null;
  }

  return `requires history_version=${job.required_history_version}; active history_version=${activeHistoryVersion}`;
}

export async function dispatchWorkflow(job, token, env = {}) {
  const url = workflowDispatchUrl(job);
  const label = `${job.owner}/${job.repo}:${job.workflow_file}@${job.ref}`;
  const inputs = inputsForJob(job, env);
  const body = {
    ref: job.ref,
    ...(inputs ? { inputs } : {}),
  };

  console.log(
    `[workflow-scheduler] dispatching job_key=${job.job_key} workflow=${label} inputs=${JSON.stringify(inputs || {})}`,
  );

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "uk-aq-cloudflare-workflow-scheduler",
    },
    body: JSON.stringify(body),
  });

  console.log(
    `[workflow-scheduler] github response job_key=${job.job_key} workflow=${label} inputs=${JSON.stringify(inputs || {})} status=${response.status}`,
  );

  if (!response.ok) {
    const errorBody = (await response.text()).slice(0, 4000);
    console.log(
      `[workflow-scheduler] github error job_key=${job.job_key} workflow=${label} inputs=${JSON.stringify(inputs || {})} body=${errorBody}`,
    );
    throw new Error(
      `GitHub dispatch failed for job_key=${job.job_key} workflow=${label} (status ${response.status})`,
    );
  }
}

export async function dispatchCronJobs(cronExpression, jobs, token, env = {}) {
  const results = [];
  for (const job of jobs) {
    let skipReason = null;
    try {
      skipReason = skipReasonForJob(job, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        job_key: job.job_key,
        workflow_file: job.workflow_file,
        status: "failed",
        error: message,
      });
      console.log(
        `[workflow-scheduler] dispatch failed cron=${cronExpression} job_key=${job.job_key} workflow=${job.workflow_file} error=${message}`,
      );
      continue;
    }

    if (skipReason) {
      results.push({
        job_key: job.job_key,
        workflow_file: job.workflow_file,
        status: "skipped",
        reason: skipReason,
      });
      console.log(
        `[workflow-scheduler] skipping cron=${cronExpression} job_key=${job.job_key} workflow=${job.workflow_file} reason=${skipReason}`,
      );
      continue;
    }

    try {
      await dispatchWorkflow(job, token, env);
      results.push({ job_key: job.job_key, workflow_file: job.workflow_file, status: "ok" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        job_key: job.job_key,
        workflow_file: job.workflow_file,
        status: "failed",
        error: message,
      });
      console.log(
        `[workflow-scheduler] dispatch failed cron=${cronExpression} job_key=${job.job_key} workflow=${job.workflow_file} error=${message}`,
      );
    }
  }

  const failed = results.filter((result) => result.status === "failed");
  console.log(
    `[workflow-scheduler] grouped summary cron=${cronExpression} results=${JSON.stringify(results)}`,
  );

  if (failed.length > 0) {
    throw new Error(
      `Workflow scheduler partially failed for cron=${cronExpression}: ${failed.map((result) => `${result.job_key}: ${result.error}`).join("; ")}`,
    );
  }

  return results;
}

export async function runCron(cronExpression, env) {
  console.log(`[workflow-scheduler] received cron=${cronExpression}`);

  const token = env.GITHUB_WORKFLOW_DISPATCH_TOKEN;
  if (!token) {
    throw new Error("Missing required Worker secret: GITHUB_WORKFLOW_DISPATCH_TOKEN");
  }

  const jobs = jobsForCron(cronExpression);
  if (jobs.length === 0) {
    console.log(
      `[workflow-scheduler] no configured jobs matched cron=${cronExpression}; configured crons=${Object.keys(CRON_JOB_MAP).join(",")}`,
    );
    return;
  }

  console.log(
    `[workflow-scheduler] cron=${cronExpression} dispatching ${jobs.length} logical job(s): ${jobs.map((job) => job.job_key).join(",")}`,
  );

  return dispatchCronJobs(cronExpression, jobs, token, env);
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runCron(controller.cron, env));
  },

  // Manual invocation helper:
  // GET /run?cron=0%203%20*%20*%20*&key=<MANUAL_TRIGGER_KEY>
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/run") {
      return new Response("ok", { status: 200 });
    }

    const manualKey = env.MANUAL_TRIGGER_KEY;
    if (!manualKey) {
      return new Response("Manual /run endpoint disabled for this deployment.", {
        status: 403,
      });
    }
    if (url.searchParams.get("key") !== manualKey) {
      return new Response("Forbidden", { status: 403 });
    }

    const cronExpression = url.searchParams.get("cron");
    if (!cronExpression) {
      return new Response(
        "Missing cron query parameter. Example: /run?cron=0%203%20*%20*%20*",
        { status: 400 },
      );
    }

    try {
      await runCron(cronExpression, env);
      return new Response(`Triggered jobs for cron=${cronExpression}`, {
        status: 200,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(`Dispatch failed: ${message}`, { status: 500 });
    }
  },
};
