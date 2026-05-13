/**
 * Cloudflare Worker scheduler for GitHub Actions workflow_dispatch.
 *
 * Edit JOBS per deployment (CIC-Test or LIVE) and keep wrangler cron triggers
 * aligned with the cron values listed here.
 */
const JOBS = [
  {
    cron: "0 3 * * *",
    owner: "YOUR_GITHUB_OWNER",
    repo: "uk-aq-ingest",
    workflow_file: "uk_aq_stations_daily.yml",
    ref: "main",
  },
  {
    cron: "15 4 * * *",
    owner: "YOUR_GITHUB_OWNER",
    repo: "uk-aq-ops",
    workflow_file: "uk_aq_r2_core_snapshot.yml",
    ref: "main",
  },
  {
    cron: "35 4 * * *",
    owner: "YOUR_GITHUB_OWNER",
    repo: "uk-aq-ops",
    workflow_file: "uk_aq_r2_history_dropbox_backup.yml",
    ref: "main",
  },
  {
    // Cron values are synchronized from wrangler.toml during deploy.
    cron: "22 9 * * *",
    owner: "YOUR_GITHUB_OWNER",
    repo: "uk-aq-ops",
    workflow_file: "uk_aq_dropbox_prune_raw.yml",
    ref: "main",
  },
];

function workflowDispatchUrl(job) {
  const owner = encodeURIComponent(job.owner);
  const repo = encodeURIComponent(job.repo);
  const workflow = encodeURIComponent(job.workflow_file);
  return `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`;
}

async function dispatchWorkflow(job, token) {
  const url = workflowDispatchUrl(job);
  const label = `${job.owner}/${job.repo}:${job.workflow_file}@${job.ref}`;

  console.log(`[workflow-scheduler] dispatching workflow=${label}`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "uk-aq-cloudflare-workflow-scheduler",
    },
    body: JSON.stringify({ ref: job.ref }),
  });

  console.log(
    `[workflow-scheduler] github response workflow=${label} status=${response.status}`,
  );

  if (!response.ok) {
    const errorBody = (await response.text()).slice(0, 4000);
    console.log(
      `[workflow-scheduler] github error workflow=${label} body=${errorBody}`,
    );
    throw new Error(`GitHub dispatch failed for ${label} (status ${response.status})`);
  }
}

async function runCron(cronExpression, env) {
  console.log(`[workflow-scheduler] received cron=${cronExpression}`);

  const token = env.GITHUB_WORKFLOW_DISPATCH_TOKEN;
  if (!token) {
    throw new Error("Missing required Worker secret: GITHUB_WORKFLOW_DISPATCH_TOKEN");
  }

  const jobsForCron = JOBS.filter((job) => job.cron === cronExpression);
  if (jobsForCron.length === 0) {
    console.log(
      `[workflow-scheduler] no configured jobs matched cron=${cronExpression}`,
    );
    return;
  }

  for (const job of jobsForCron) {
    await dispatchWorkflow(job, token);
  }
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
