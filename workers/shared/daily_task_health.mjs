const DEFAULT_SOURCE_REPO = "uk-aq-ops";
const DEFAULT_RPC_SCHEMA = "uk_aq_public";
const DEFAULT_ERROR_TEXT_LIMIT = 1200;
const DEFAULT_STACK_PREVIEW_LIMIT = 1800;

function nowIso() {
  return new Date().toISOString();
}

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

function truncateText(value, limit = DEFAULT_ERROR_TEXT_LIMIT) {
  const text = String(value ?? "");
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function logHealth(severity, event, details = {}) {
  const payload = {
    severity,
    event,
    timestamp: nowIso(),
    ...details,
  };
  const line = JSON.stringify(payload);
  if (severity === "ERROR") {
    console.error(line);
    return;
  }
  if (severity === "WARNING") {
    console.warn(line);
    return;
  }
  console.log(line);
}

function jsonSafe(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }
  if (depth >= 8) {
    return "[MaxDepth]";
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    if (Array.isArray(value)) {
      return value.slice(0, 100).map((entry) => jsonSafe(entry, depth + 1, seen));
    }
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = jsonSafe(entry, depth + 1, seen);
    }
    return out;
  }
  return String(value);
}

export function formatDailyTaskError(error) {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack || "" : "";
  const formatted = {
    name: truncateText(name, 200),
    message: truncateText(message, DEFAULT_ERROR_TEXT_LIMIT),
    stack_preview: stack ? truncateText(stack, DEFAULT_STACK_PREVIEW_LIMIT) : null,
  };

  const cause = error instanceof Error ? error.cause : null;
  if (cause !== undefined && cause !== null) {
    formatted.cause = cause instanceof Error
      ? {
        name: truncateText(cause.name, 200),
        message: truncateText(cause.message, DEFAULT_ERROR_TEXT_LIMIT),
      }
      : truncateText(String(cause), DEFAULT_ERROR_TEXT_LIMIT);
  }

  return formatted;
}

function currentUtcDate() {
  return new Date().toISOString().slice(0, 10);
}

function cleanObject(input) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (value === undefined || value === "") {
      continue;
    }
    out[key] = value;
  }
  return out;
}

function resolveSupabaseUrl(env, options = {}) {
  return String(
    options.supabaseUrl
    || env.DAILY_TASK_HEALTH_SUPABASE_URL
    || env.OBS_AQIDB_SUPABASE_URL
    || env.SUPABASE_URL
    || env.SB_URL
    || "",
  ).trim().replace(/\/+$/, "");
}

function resolveSupabaseKey(env, options = {}) {
  return String(
    options.supabaseKey
    || env.DAILY_TASK_HEALTH_SUPABASE_SERVICE_ROLE_KEY
    || env.OBS_AQIDB_SECRET_KEY
    || env.SUPABASE_SERVICE_ROLE_KEY
    || env.SB_SECRET_KEY
    || "",
  ).trim();
}

function resolvePlatformRunId(env) {
  return String(
    env.CLOUD_RUN_EXECUTION
    || env.CLOUD_RUN_JOB
    || env.CLOUD_RUN_TASK_INDEX
    || env.K_REVISION
    || env.K_SERVICE
    || "",
  ).trim() || null;
}

export function summarizeForDailyTaskHealth(value) {
  return jsonSafe(value ?? {});
}

export function createDailyTaskHealthClient(options = {}) {
  const env = options.env || process.env;
  // Opt-in transport controls preserve existing callers' defaults.
  const fetchImpl = options.fetchImpl || ((...args) => globalThis.fetch(...args));
  const emitHealth = options.logHealth || logHealth;
  const requestTimeoutMs = options.requestTimeoutMs ?? 0;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 0) {
    throw new Error("Invalid daily task health request timeout");
  }
  const strict = parseBoolean(options.strict ?? env.DAILY_TASK_HEALTH_STRICT, false);
  const disabled = parseBoolean(options.disabled ?? env.DAILY_TASK_HEALTH_DISABLED, false);
  const recomputeDisabled = parseBoolean(
    options.recomputeDisabled ?? env.DAILY_TASK_HEALTH_RECOMPUTE_DISABLED,
    false,
  );
  // Durable supervisors can confirm terminal delivery before explicit recompute.
  // Existing callers still recompute automatically and retain the global disable.
  const recomputeAfterTerminal = parseBoolean(options.recomputeAfterTerminal, true);
  const rpcSchema = String(options.rpcSchema || env.DAILY_TASK_HEALTH_RPC_SCHEMA || DEFAULT_RPC_SCHEMA).trim();
  const supabaseUrl = resolveSupabaseUrl(env, options);
  const supabaseKey = resolveSupabaseKey(env, options);
  let disabledLogged = false;
  let missingConfigLogged = false;

  function baseInput(input = {}) {
    return cleanObject({
      scheduled_for_date: input.scheduled_for_date || input.scheduledForDate || currentUtcDate(),
      source_repo: input.source_repo || input.sourceRepo || DEFAULT_SOURCE_REPO,
      source_worker: input.source_worker || input.sourceWorker,
      platform_run_id: input.platform_run_id || input.platformRunId || resolvePlatformRunId(env),
      log_url: input.log_url || input.logUrl || env.DAILY_TASK_HEALTH_LOG_URL || null,
      summary: summarizeForDailyTaskHealth(input.summary || {}),
    });
  }

  async function rpc(name, body) {
    if (disabled) {
      if (!disabledLogged) {
        disabledLogged = true;
        emitHealth("INFO", "daily_task_health_disabled", {
          reason: "DAILY_TASK_HEALTH_DISABLED",
        });
      }
      return null;
    }
    if (!supabaseUrl || !supabaseKey) {
      const message = "Daily task health reporting skipped: missing Supabase URL or service role key.";
      if (!missingConfigLogged) {
        missingConfigLogged = true;
        emitHealth("WARNING", "daily_task_health_missing_config", {
          has_supabase_url: Boolean(supabaseUrl),
          has_supabase_key: Boolean(supabaseKey),
        });
      }
      if (strict) {
        throw new Error(message);
      }
      return null;
    }

    const url = `${supabaseUrl}/rest/v1/rpc/${name}`;
    const controller = requestTimeoutMs ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), requestTimeoutMs) : null;
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          "Content-Type": "application/json",
          "Accept-Profile": rpcSchema,
          "Content-Profile": rpcSchema,
        },
        body: JSON.stringify(jsonSafe(body)),
        ...(controller ? { signal: controller.signal } : {}),
      });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`RPC ${name} failed (${response.status}): ${truncateText(text, 1000)}`);
        error.httpStatus = response.status;
        throw error;
      }
      if (!text.trim()) {
        return null;
      }
      return JSON.parse(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emitHealth("WARNING", "daily_task_health_rpc_failed", {
        rpc: name,
        error: truncateText(message, DEFAULT_ERROR_TEXT_LIMIT),
      });
      if (strict) {
        throw error;
      }
      return null;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async function recomputeDailyTaskStatus(dateUtc) {
    if (recomputeDisabled) {
      return null;
    }
    return rpc("uk_aq_rpc_recompute_daily_task_status", {
      p_date: dateUtc || currentUtcDate(),
    });
  }

  async function dailyTaskStarted(input = {}) {
    const payload = {
      ...baseInput(input),
      task_key: input.task_key || input.taskKey,
      ...(input.started_at ? { started_at: input.started_at } : {}),
    };
    if (!payload.task_key) {
      throw new Error("daily task health task_key is required");
    }
    const runId = await rpc("uk_aq_rpc_daily_task_started", {
      p: payload,
      // A separate RPC argument fails before mutation against the old one-arg RPC.
      ...(input.run_id !== undefined ? { p_run_id: input.run_id } : {}),
    });
    return typeof runId === "string" ? runId : null;
  }

  async function dailyTaskFinished(runId, input = {}) {
    if (!runId) {
      return null;
    }
    const payload = { ...baseInput(input), ...(input.finished_at ? { finished_at: input.finished_at } : {}) };
    const result = await rpc("uk_aq_rpc_daily_task_finished", {
      p_run_id: runId,
      p: payload,
    });
    if (recomputeAfterTerminal) await recomputeDailyTaskStatus(payload.scheduled_for_date);
    return result;
  }

  async function dailyTaskFailed(runId, error, input = {}) {
    if (!runId) {
      return null;
    }
    const errorJson = formatDailyTaskError(error);
    const payload = {
      ...baseInput(input),
      ...(input.failed_at ? { failed_at: input.failed_at } : {}),
      error_message: input.error_message || input.errorMessage || errorJson.message,
      error: input.error || errorJson,
    };
    const result = await rpc("uk_aq_rpc_daily_task_failed", {
      p_run_id: runId,
      p: payload,
    });
    if (recomputeAfterTerminal) await recomputeDailyTaskStatus(payload.scheduled_for_date);
    return result;
  }

  async function withDailyTaskRun(input, fn) {
    const startedInput = {
      ...input,
      summary: input?.startSummary || input?.summary || {},
    };
    const runId = await dailyTaskStarted(startedInput);
    try {
      const result = await fn({ healthRunId: runId, scheduledForDate: startedInput.scheduled_for_date });
      const finishSummary = typeof input?.buildFinishedSummary === "function"
        ? input.buildFinishedSummary(result)
        : (input?.finishSummary ?? result);
      await dailyTaskFinished(runId, {
        ...input,
        summary: finishSummary,
      });
      return result;
    } catch (error) {
      const failureSummary = typeof input?.buildFailedSummary === "function"
        ? input.buildFailedSummary(error)
        : (input?.failureSummary || {});
      await dailyTaskFailed(runId, error, {
        ...input,
        summary: failureSummary,
      });
      throw error;
    }
  }

  return {
    dailyTaskStarted,
    dailyTaskFinished,
    dailyTaskFailed,
    recomputeDailyTaskStatus,
    withDailyTaskRun,
  };
}

const defaultClient = createDailyTaskHealthClient();

export const dailyTaskStarted = (...args) => defaultClient.dailyTaskStarted(...args);
export const dailyTaskFinished = (...args) => defaultClient.dailyTaskFinished(...args);
export const dailyTaskFailed = (...args) => defaultClient.dailyTaskFailed(...args);
export const recomputeDailyTaskStatus = (...args) => defaultClient.recomputeDailyTaskStatus(...args);
export const withDailyTaskRun = (...args) => defaultClient.withDailyTaskRun(...args);
