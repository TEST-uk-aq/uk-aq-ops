const RPC_SCHEMA = "uk_aq_public";

function parseBoolean(raw, fallback = false) {
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const value = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(value)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(value)) {
    return false;
  }
  return fallback;
}

function currentUtcDate() {
  return new Date().toISOString().slice(0, 10);
}

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name) {
  return String(process.env[name] || "").trim();
}

function buildLogUrl() {
  const repository = optionalEnv("GITHUB_REPOSITORY");
  const runId = optionalEnv("GITHUB_RUN_ID");
  const serverUrl = optionalEnv("GITHUB_SERVER_URL") || "https://github.com";
  if (!repository || !runId) {
    return null;
  }
  return `${serverUrl}/${repository}/actions/runs/${runId}`;
}

async function readResponseText(response, limit = 2000) {
  const text = await response.text();
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

async function postRpc({ supabaseUrl, serviceRoleKey, rpcName, body }) {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${rpcName}`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      "Accept-Profile": RPC_SCHEMA,
      "Content-Profile": RPC_SCHEMA,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await readResponseText(response);
    throw new Error(`RPC ${rpcName} failed (${response.status}): ${text}`);
  }

  const text = await response.text();
  return text.trim() ? JSON.parse(text) : null;
}

function mapJobStatus(jobStatus) {
  return String(jobStatus || "").trim().toLowerCase() === "success"
    ? "Finished"
    : "Failed";
}

async function main() {
  const disabled = parseBoolean(process.env.DAILY_TASK_HEALTH_DISABLED, false);
  const strict = parseBoolean(process.env.DAILY_TASK_HEALTH_STRICT, false);
  if (disabled) {
    console.log("Daily task health reporting disabled by DAILY_TASK_HEALTH_DISABLED=true.");
    return;
  }

  try {
    const supabaseUrl = requiredEnv("SUPABASE_URL").replace(/\/+$/, "");
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const taskKey = requiredEnv("DAILY_TASK_KEY");
    const jobStatus = requiredEnv("JOB_STATUS");
    const scheduledForDate = optionalEnv("DAILY_TASK_SCHEDULED_FOR_DATE") || currentUtcDate();
    const now = new Date().toISOString();
    const status = mapJobStatus(jobStatus);
    const logUrl = buildLogUrl();

    const summary = {
      github_repository: optionalEnv("GITHUB_REPOSITORY") || null,
      github_workflow: optionalEnv("GITHUB_WORKFLOW") || null,
      github_run_id: optionalEnv("GITHUB_RUN_ID") || null,
      github_run_attempt: optionalEnv("GITHUB_RUN_ATTEMPT") || null,
      github_sha: optionalEnv("GITHUB_SHA") || null,
      github_ref_name: optionalEnv("GITHUB_REF_NAME") || null,
      github_event_name: optionalEnv("GITHUB_EVENT_NAME") || null,
      github_actor: optionalEnv("GITHUB_ACTOR") || null,
      job_status: jobStatus,
      trigger: "github_actions",
    };

    const reportPayload = {
      task_key: taskKey,
      status,
      scheduled_for_date: scheduledForDate,
      finished_at: status === "Finished" ? now : undefined,
      failed_at: status === "Failed" ? now : undefined,
      summary,
      error_message: status === "Failed"
        ? `GitHub Actions job ended with status: ${jobStatus}`
        : undefined,
      error: status === "Failed"
        ? {
          job_status: jobStatus,
          github_run_id: optionalEnv("GITHUB_RUN_ID") || null,
          log_url: logUrl,
        }
        : undefined,
      source_repo: optionalEnv("GITHUB_REPOSITORY") || null,
      source_worker: optionalEnv("GITHUB_WORKFLOW") || null,
      platform_run_id: optionalEnv("GITHUB_RUN_ID") || null,
      log_url: logUrl,
    };

    Object.keys(reportPayload).forEach((key) => {
      if (reportPayload[key] === undefined) {
        delete reportPayload[key];
      }
    });

    await postRpc({
      supabaseUrl,
      serviceRoleKey,
      rpcName: "uk_aq_rpc_daily_task_report_final",
      body: { p: reportPayload },
    });
    console.log(`Reported daily task health: task_key=${taskKey}, status=${status}, date=${scheduledForDate}`);

    await postRpc({
      supabaseUrl,
      serviceRoleKey,
      rpcName: "uk_aq_rpc_recompute_daily_task_status",
      body: { p_date: scheduledForDate },
    });
    console.log(`Recomputed daily task status for ${scheduledForDate}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (strict) {
      throw error;
    }
    console.warn(`Daily task health reporting warning: ${message}`);
  }
}

await main();
