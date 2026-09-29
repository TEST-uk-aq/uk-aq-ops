import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  deprecatedR2HistoryVersionVarsPresent,
  parseR2HistoryVersion,
} from "../workers/shared/uk_aq_r2_history_version.mjs";
import {
  getObservationHistoryGeneration,
} from "../workers/shared/uk_aq_observation_history_generation.mjs";

const RPC_SCHEMA = "uk_aq_public";
const R2_HISTORY_DROPBOX_TASK_KEY = "ops.r2_history_dropbox_backup";
const RPC_ATTEMPT_TIMEOUT_MS = 15_000;
const RPC_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
const ALWAYS_RETRYABLE_RPCS = new Set([
  "uk_aq_rpc_daily_task_finished",
  "uk_aq_rpc_daily_task_failed",
  "uk_aq_rpc_recompute_daily_task_status",
]);
const RESERVED_SUMMARY_FIELDS = new Set([
  "github_repository",
  "github_workflow",
  "github_run_id",
  "github_run_number",
  "github_run_attempt",
  "github_sha",
  "github_ref_name",
  "github_event_name",
  "github_actor",
  "job_status",
  "trigger",
  "__proto__",
  "constructor",
  "prototype",
]);

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

function requiredEnv(name, env = process.env) {
  const value = String(env[name] || "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name, env = process.env) {
  return String(env[name] || "").trim();
}

function buildLogUrl(env = process.env) {
  const repository = optionalEnv("GITHUB_REPOSITORY", env);
  const runId = optionalEnv("GITHUB_RUN_ID", env);
  const serverUrl = optionalEnv("GITHUB_SERVER_URL", env) || "https://github.com";
  if (!repository || !runId) {
    return null;
  }
  return `${serverUrl}/${repository}/actions/runs/${runId}`;
}

async function writeGithubOutputs(values, env = process.env) {
  const outputFile = optionalEnv("GITHUB_OUTPUT", env);
  if (!outputFile) {
    return;
  }
  const lines = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    lines.push(`${key}=${value}`);
  }
  if (lines.length === 0) {
    return;
  }

  const fs = await import("node:fs/promises");
  await fs.appendFile(outputFile, `${lines.join("\n")}\n`, { encoding: "utf-8" });
}

async function readResponseText(response, limit = 2000) {
  const text = await response.text();
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isRetryableHttpStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

export function hasCompleteStartedIdentity(body) {
  const payload = body?.p;
  if (!payload || typeof payload !== "object") {
    return false;
  }
  return [
    payload.task_key,
    payload.source_repo,
    payload.platform_run_id,
    payload.summary?.github_run_attempt,
  ].every((value) => String(value ?? "").trim() !== "");
}

function rpcIsSafeToRetry(rpcName, body) {
  if (ALWAYS_RETRYABLE_RPCS.has(rpcName)) {
    return true;
  }
  return rpcName === "uk_aq_rpc_daily_task_started"
    && hasCompleteStartedIdentity(body);
}

function logRetryDiagnostic({ rpcName, attempt, maxAttempts, status, reason, willRetry }) {
  const outcome = willRetry ? "yes" : "no";
  const failure = status === undefined
    ? `reason=${JSON.stringify(reason)}`
    : `status=${status}`;
  console.warn(
    `Daily task health RPC transient failure: rpc=${rpcName} `
    + `attempt=${attempt}/${maxAttempts} ${failure} retry=${outcome}`,
  );
}

export async function postRpc({
  supabaseUrl,
  serviceRoleKey,
  rpcName,
  body,
  fetchImpl = globalThis.fetch,
  attemptTimeoutMs = RPC_ATTEMPT_TIMEOUT_MS,
  retryDelaysMs = RPC_RETRY_DELAYS_MS,
  sleepImpl = sleep,
}) {
  const retrySafe = rpcIsSafeToRetry(rpcName, body);
  const maxAttempts = retrySafe ? RPC_RETRY_DELAYS_MS.length + 1 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, attemptTimeoutMs);

    let response;
    let responseText;
    try {
      response = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/${rpcName}`, {
        method: "POST",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
          "Accept-Profile": RPC_SCHEMA,
          "Content-Profile": RPC_SCHEMA,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      responseText = await readResponseText(response);
    } catch (error) {
      clearTimeout(timeout);
      const reason = timedOut
        ? `timeout after ${attemptTimeoutMs}ms`
        : `network/fetch failure: ${error instanceof Error ? error.message : String(error)}`;
      const willRetry = retrySafe && attempt < maxAttempts;
      logRetryDiagnostic({ rpcName, attempt, maxAttempts, reason, willRetry });
      if (!willRetry) {
        if (timedOut) {
          throw new Error(
            `RPC ${rpcName} timed out after ${attemptTimeoutMs}ms`,
            { cause: error },
          );
        }
        throw error;
      }
      await sleepImpl(retryDelaysMs[attempt - 1] ?? 0);
      continue;
    }
    clearTimeout(timeout);

    if (!response.ok) {
      const retryableStatus = isRetryableHttpStatus(response.status);
      const willRetry = retrySafe && retryableStatus && attempt < maxAttempts;
      if (retryableStatus) {
        logRetryDiagnostic({
          rpcName,
          attempt,
          maxAttempts,
          status: response.status,
          willRetry,
        });
      }
      if (willRetry) {
        await sleepImpl(retryDelaysMs[attempt - 1] ?? 0);
        continue;
      }
      throw new Error(`RPC ${rpcName} failed (${response.status}): ${responseText}`);
    }

    return responseText.trim() ? JSON.parse(responseText) : null;
  }

  throw new Error(`RPC ${rpcName} exhausted its bounded retry policy`);
}

function mapJobStatus(jobStatus) {
  return String(jobStatus || "").trim().toLowerCase() === "success"
    ? "Finished"
    : "Failed";
}

function mapReportStage(rawStage) {
  const value = String(rawStage || "final").trim().toLowerCase();
  if (value === "started" || value === "final") {
    return value;
  }
  throw new Error(`Invalid DAILY_TASK_HEALTH_REPORT_STAGE: ${rawStage}`);
}

export function buildBackupVersionDetails(env = process.env) {
  const deprecated = deprecatedR2HistoryVersionVarsPresent(env);
  if (deprecated.length > 0) {
    throw new Error(
      `Daily task health no longer supports ${deprecated.join(", ")}. `
      + "Use UK_AQ_R2_HISTORY_VERSION=v1|v2|v3 and delete the old split read/write/backup vars.",
    );
  }

  const rawHistoryVersion = String(env.UK_AQ_R2_HISTORY_VERSION || "").trim();
  if (!rawHistoryVersion) {
    return null;
  }

  const normalizedHistoryVersion = rawHistoryVersion.toLowerCase();
  let historyVersion;
  let inventoryRelPath;
  if (normalizedHistoryVersion === "v1") {
    historyVersion = parseR2HistoryVersion(rawHistoryVersion);
    inventoryRelPath = "history/_index/backup_inventory_v1.json";
  } else if (
    normalizedHistoryVersion === "v2"
    || normalizedHistoryVersion === "v3"
  ) {
    const generation = getObservationHistoryGeneration(normalizedHistoryVersion);
    historyVersion = generation.version;
    inventoryRelPath = `${generation.backup_inventory_prefix}/root.json`;
  } else {
    throw new Error(
      `Invalid UK_AQ_R2_HISTORY_VERSION=${JSON.stringify(rawHistoryVersion)}; expected v1, v2, or v3.`,
    );
  }

  const details = {
    history_version: historyVersion,
    backup_version: historyVersion,
    inventory_rel_path: inventoryRelPath,
  };

  return details;
}

function readSupplementalSummary(env = process.env) {
  const filename = optionalEnv("DAILY_TASK_HEALTH_SUPPLEMENTAL_SUMMARY_FILE", env);
  if (!filename) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(filename, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("top-level JSON value must be an object");
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `Daily task health supplemental summary ignored (${filename}): ${message}`,
    );
    return null;
  }
}

function mergeSupplementalSummary(summary, env = process.env) {
  const supplemental = readSupplementalSummary(env);
  if (!supplemental) {
    return summary;
  }

  const collisions = Object.keys(supplemental).filter(
    (key) => RESERVED_SUMMARY_FIELDS.has(key)
      || Object.prototype.hasOwnProperty.call(summary, key),
  );
  if (collisions.length > 0) {
    console.warn(
      "Daily task health supplemental summary ignored because it contains "
      + `reserved or existing fields: ${collisions.sort().join(", ")}`,
    );
    return summary;
  }

  Object.assign(summary, supplemental);
  return summary;
}

function buildSummary(jobStatus, env = process.env) {
  const summary = {
    github_repository: optionalEnv("GITHUB_REPOSITORY", env) || null,
    github_workflow: optionalEnv("GITHUB_WORKFLOW", env) || null,
    github_run_id: optionalEnv("GITHUB_RUN_ID", env) || null,
    github_run_number: optionalEnv("GITHUB_RUN_NUMBER", env) || null,
    github_run_attempt: optionalEnv("GITHUB_RUN_ATTEMPT", env) || null,
    github_sha: optionalEnv("GITHUB_SHA", env) || null,
    github_ref_name: optionalEnv("GITHUB_REF_NAME", env) || null,
    github_event_name: optionalEnv("GITHUB_EVENT_NAME", env) || null,
    github_actor: optionalEnv("GITHUB_ACTOR", env) || null,
    job_status: jobStatus || null,
    trigger: "github_actions",
  };

  const backupDetails = buildBackupVersionDetails(env);
  if (backupDetails) {
    Object.assign(summary, backupDetails);
  }

  return mergeSupplementalSummary(summary, env);
}

function stripUndefined(input) {
  Object.keys(input).forEach((key) => {
    if (input[key] === undefined) {
      delete input[key];
    }
  });
  return input;
}

export async function main(options = {}) {
  const env = options.env || process.env;
  const rpcOptions = options.rpcOptions || {};
  const disabled = parseBoolean(env.DAILY_TASK_HEALTH_DISABLED, false);
  const strict = parseBoolean(env.DAILY_TASK_HEALTH_STRICT, false);
  if (disabled) {
    console.log("Daily task health reporting disabled by DAILY_TASK_HEALTH_DISABLED=true.");
    return;
  }

  try {
    const stage = mapReportStage(env.DAILY_TASK_HEALTH_REPORT_STAGE);
    const supabaseUrl = requiredEnv("SUPABASE_URL", env).replace(/\/+$/, "");
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY", env);
    const taskKey = requiredEnv("DAILY_TASK_KEY", env);
    const scheduledForDate = optionalEnv("DAILY_TASK_SCHEDULED_FOR_DATE", env) || currentUtcDate();
    const now = new Date().toISOString();
    const logUrl = buildLogUrl(env);
    const sourceRepo = optionalEnv("GITHUB_REPOSITORY", env) || null;
    const sourceWorker = optionalEnv("GITHUB_WORKFLOW", env) || null;
    const platformRunId = optionalEnv("GITHUB_RUN_ID", env) || null;

    const buildStartedPayload = () => stripUndefined({
      task_key: taskKey,
      scheduled_for_date: scheduledForDate,
      started_at: now,
      summary: buildSummary("started", env),
      source_repo: sourceRepo,
      source_worker: sourceWorker,
      platform_run_id: platformRunId,
      log_url: logUrl,
    });

    if (stage === "started") {
      const startedPayload = buildStartedPayload();

      const runId = await postRpc({
        supabaseUrl,
        serviceRoleKey,
        rpcName: "uk_aq_rpc_daily_task_started",
        body: { p: startedPayload },
        ...rpcOptions,
      });

      const healthRunId = typeof runId === "string" ? runId : "";
      await writeGithubOutputs({ health_run_id: healthRunId }, env);

      console.log(
        `Reported daily task health STARTED: task_key=${taskKey}, date=${scheduledForDate}, run_id=${healthRunId || '<none>'}`,
      );
      return;
    }

    const jobStatus = requiredEnv("JOB_STATUS", env);
    const status = mapJobStatus(jobStatus);
    let healthRunId = optionalEnv("DAILY_TASK_HEALTH_RUN_ID", env);

    if (!healthRunId && taskKey === R2_HISTORY_DROPBOX_TASK_KEY) {
      const recoveryBody = { p: buildStartedPayload() };
      if (!hasCompleteStartedIdentity(recoveryBody)) {
        throw new Error(
          "Cannot recover the R2 history Dropbox backup Daily Task Health run "
          + "without task_key, source_repo, platform_run_id and github_run_attempt.",
        );
      }
      const recoveredRunId = await postRpc({
        supabaseUrl,
        serviceRoleKey,
        rpcName: "uk_aq_rpc_daily_task_started",
        body: recoveryBody,
        ...rpcOptions,
      });
      healthRunId = typeof recoveredRunId === "string" ? recoveredRunId : "";
      if (!healthRunId) {
        throw new Error(
          "R2 history Dropbox backup Daily Task Health start recovery returned no run UUID.",
        );
      }
      console.log(
        `Recovered daily task health run_id for exact GitHub execution: ${healthRunId}`,
      );
    }

    if (healthRunId) {
      const payload = stripUndefined({
        summary: buildSummary(jobStatus, env),
        finished_at: status === "Finished" ? now : undefined,
        failed_at: status === "Failed" ? now : undefined,
        error_message: status === "Failed"
          ? `GitHub Actions job ended with status: ${jobStatus}`
          : undefined,
        error: status === "Failed"
          ? {
            job_status: jobStatus,
            github_run_id: optionalEnv("GITHUB_RUN_ID", env) || null,
            github_run_number: optionalEnv("GITHUB_RUN_NUMBER", env) || null,
            log_url: logUrl,
          }
          : undefined,
        source_repo: sourceRepo,
        source_worker: sourceWorker,
        platform_run_id: platformRunId,
        log_url: logUrl,
      });

      await postRpc({
        supabaseUrl,
        serviceRoleKey,
        rpcName: status === "Finished"
          ? "uk_aq_rpc_daily_task_finished"
          : "uk_aq_rpc_daily_task_failed",
        body: {
          p_run_id: healthRunId,
          p: payload,
        },
        ...rpcOptions,
      });

      console.log(
        `Reported daily task health via run_id: task_key=${taskKey}, status=${status}, date=${scheduledForDate}, run_id=${healthRunId}`,
      );
    } else {
      const reportPayload = stripUndefined({
        task_key: taskKey,
        status,
        scheduled_for_date: scheduledForDate,
        started_at: optionalEnv("DAILY_TASK_STARTED_AT", env) || undefined,
        finished_at: status === "Finished" ? now : undefined,
        failed_at: status === "Failed" ? now : undefined,
        summary: buildSummary(jobStatus, env),
        error_message: status === "Failed"
          ? `GitHub Actions job ended with status: ${jobStatus}`
          : undefined,
        error: status === "Failed"
          ? {
            job_status: jobStatus,
            github_run_id: optionalEnv("GITHUB_RUN_ID", env) || null,
            github_run_number: optionalEnv("GITHUB_RUN_NUMBER", env) || null,
            log_url: logUrl,
          }
          : undefined,
        source_repo: sourceRepo,
        source_worker: sourceWorker,
        platform_run_id: platformRunId,
        log_url: logUrl,
      });

      await postRpc({
        supabaseUrl,
        serviceRoleKey,
        rpcName: "uk_aq_rpc_daily_task_report_final",
        body: { p: reportPayload },
        ...rpcOptions,
      });

      console.log(
        `Reported daily task health FINAL (fallback): task_key=${taskKey}, status=${status}, date=${scheduledForDate}`,
      );
    }

    await postRpc({
      supabaseUrl,
      serviceRoleKey,
      rpcName: "uk_aq_rpc_recompute_daily_task_status",
      body: { p_date: scheduledForDate },
      ...rpcOptions,
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

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await main();
}
