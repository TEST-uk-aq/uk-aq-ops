import { jsonResponse, logJson, nowIso, readSecret } from "./shared.mjs";
import { retryD1 } from "./d1.mjs";

export const SCHEDULER_NAME = "uk-aq-cron-scheduler-ops";
export const WORKER_NAME = "uk-aq-cron-scheduler-ops";
export const D1_BINDING_NAME = "SCHEDULER_DB";
export const MINUTE_MS = 60_000;
export const DISPATCH_LEAD_MINUTES = 0.5;
export const DISPATCH_LEAD_MS = DISPATCH_LEAD_MINUTES * MINUTE_MS;
export const RESPONSE_PREVIEW_LIMIT = 1_000;
export const GITHUB_USER_AGENT = "uk-aq-cloudflare-cron-scheduler";
export const TRIGGER_SOURCE_CLOUDFLARE_CRON = "cloudflare_cron";
export const TRIGGER_SOURCE_EXTERNAL_WATCHDOG = "external_watchdog";
export const WORKER_HTTP_SECRET_BINDING_PATTERN = /^UK_AQ_[A-Z0-9_]*WORKER_HTTP_SECRET$/;

const SCHEDULER_GRACE_MS = 10 * MINUTE_MS;
const MAX_RECOVERY_LOOKBACK_MINUTES = 360;
const RECOVERY_HTTP_TIMEOUT_MS = 5_000;
const HEALTH_ROW_LIMIT = 100;
const MAX_RECORDED_FAILURES = 8;
const SCHEDULER_TRIGGER_HEADER = "x-uk-aq-scheduler-trigger";
const SCHEDULER_TRIGGER_SECRET_MAX_LENGTH = 512;
const ALLOWED_TRIGGER_SOURCES = new Set([
  TRIGGER_SOURCE_CLOUDFLARE_CRON,
  TRIGGER_SOURCE_EXTERNAL_WATCHDOG,
]);

const MONTH_NAME_TO_NUMBER = Object.freeze({
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
});

const DOW_NAME_TO_NUMBER = Object.freeze({
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
});

function trimText(value) {
  return String(value ?? "").trim();
}

function boundedText(value, maxLength) {
  const text = trimText(value);
  return text && text.length <= maxLength ? text : "";
}

export function canonicalMinuteSlot(nowMs) {
  const timestamp = Number(nowMs);
  if (!Number.isFinite(timestamp)) {
    throw new Error("Invalid scheduler invocation time");
  }
  return nowIso(Math.floor(timestamp / MINUTE_MS) * MINUTE_MS);
}

export function currentMinuteEvaluationWindow(minuteSlot) {
  const endMs = Date.parse(minuteSlot);
  if (!Number.isFinite(endMs)) {
    throw new Error("Invalid scheduler minute slot");
  }
  return {
    startMs: endMs - MINUTE_MS,
    endMs,
    start: nowIso(endMs - MINUTE_MS),
    end: nowIso(endMs),
  };
}

function normalizeTriggerSource(value) {
  const source = boundedText(value, 64);
  if (!ALLOWED_TRIGGER_SOURCES.has(source)) {
    throw new Error("Invalid scheduler trigger source");
  }
  return source;
}

async function hasValidSchedulerTriggerSecret(request, env) {
  const provided = boundedText(
    request.headers.get(SCHEDULER_TRIGGER_HEADER),
    SCHEDULER_TRIGGER_SECRET_MAX_LENGTH,
  );
  const expected = boundedText(
    await readSecret(env?.UK_AQ_SCHEDULER_TRIGGER_SECRET),
    SCHEDULER_TRIGGER_SECRET_MAX_LENGTH,
  );
  return Boolean(provided && expected && provided === expected);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseInteger(value, fieldName) {
  const parsed = Number(trimText(value));
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid ${fieldName}: expected an integer`);
  }
  return parsed;
}

function parseBinaryFlag(value, fieldName) {
  const parsed = parseInteger(value, fieldName);
  if (parsed !== 0 && parsed !== 1) {
    throw new Error(`Invalid ${fieldName}: expected 0 or 1`);
  }
  return parsed;
}

function parseJsonValue(text, fieldName, { allowEmptyObject = false } = {}) {
  const raw = trimText(text);
  if (!raw) {
    return allowEmptyObject ? {} : null;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${fieldName}: ${message}`);
  }
}

function parseJsonObject(text, fieldName) {
  const parsed = parseJsonValue(text, fieldName, { allowEmptyObject: true });
  if (!isPlainObject(parsed)) {
    throw new Error(`Invalid JSON in ${fieldName}: expected a JSON object`);
  }
  return parsed;
}

function parseJsonBody(text, fieldName) {
  const parsed = parseJsonValue(text, fieldName, { allowEmptyObject: true });
  return parsed === null ? {} : parsed;
}

function normalizeTimezone(value) {
  const normalized = trimText(value);
  if (!normalized) {
    return "UTC";
  }
  if (normalized === "UTC" || normalized === "Etc/UTC") {
    return normalized;
  }
  throw new Error(`Unsupported timezone ${JSON.stringify(normalized)}; expected UTC`);
}

function normalizeWorkerHttpUrl(value, jobKey) {
  const normalized = trimText(value);
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`Invalid scheduler job ${jobKey}: worker_http_url must be an absolute HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || !parsed.hostname) {
    throw new Error(`Invalid scheduler job ${jobKey}: worker_http_url must be an absolute HTTPS URL`);
  }
  return normalized;
}

function normalizeWorkerHttpSecretBinding(value, jobKey) {
  const binding = trimText(value);
  if (!WORKER_HTTP_SECRET_BINDING_PATTERN.test(binding)) {
    throw new Error(
      `Invalid scheduler job ${jobKey}: worker_http_secret_binding must match ${WORKER_HTTP_SECRET_BINDING_PATTERN}`,
    );
  }
  return binding;
}

function normalizeCronAtom(token, fieldName, min, max, names = {}) {
  const normalized = trimText(token).toUpperCase();
  if (!normalized) {
    throw new Error(`Invalid ${fieldName}: empty token`);
  }

  if (Object.prototype.hasOwnProperty.call(names, normalized)) {
    return names[normalized];
  }

  if (fieldName === "day-of-week" && normalized === "7") {
    return 0;
  }

  const parsed = Number(normalized);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid ${fieldName}: ${JSON.stringify(token)} is not a valid value`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`Invalid ${fieldName}: ${parsed} outside ${min}-${max}`);
  }
  return fieldName === "day-of-week" && parsed === 7 ? 0 : parsed;
}

function expandCronToken(token, fieldName, min, max, names = {}) {
  const parts = trimText(token).toUpperCase();
  if (!parts) {
    throw new Error(`Invalid ${fieldName}: empty cron token`);
  }

  let base = parts;
  let step = 1;
  if (parts.includes("/")) {
    const segments = parts.split("/");
    if (segments.length !== 2) {
      throw new Error(`Invalid ${fieldName}: ${JSON.stringify(token)}`);
    }
    [base] = segments;
    step = Number(trimText(segments[1]));
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`Invalid ${fieldName}: step must be a positive integer`);
    }
  }

  let start;
  let end;
  if (base === "*") {
    start = min;
    end = max;
  } else if (base.includes("-")) {
    const range = base.split("-");
    if (range.length !== 2) {
      throw new Error(`Invalid ${fieldName}: ${JSON.stringify(token)}`);
    }
    start = normalizeCronAtom(range[0], fieldName, min, max, names);
    end = normalizeCronAtom(range[1], fieldName, min, max, names);
  } else {
    start = normalizeCronAtom(base, fieldName, min, max, names);
    end = start;
  }

  if (start > end) {
    throw new Error(`Invalid ${fieldName}: range start must be <= range end`);
  }

  const values = new Set();
  for (let value = start; value <= end; value += step) {
    values.add(fieldName === "day-of-week" && value === 7 ? 0 : value);
  }

  return values;
}

function parseCronField(field, fieldName, min, max, names = {}) {
  const normalized = trimText(field).toUpperCase();
  if (!normalized) {
    throw new Error(`Invalid cron expression: missing ${fieldName}`);
  }
  if (normalized === "*") {
    return { any: true, values: null };
  }

  const values = new Set();
  for (const token of normalized.split(",")) {
    const expanded = expandCronToken(token, fieldName, min, max, names);
    for (const value of expanded) {
      values.add(value);
    }
  }

  return { any: false, values };
}

export function parseCronExpression(expr) {
  const fields = trimText(expr).split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Invalid cron expression ${JSON.stringify(expr)}: expected five fields`);
  }

  return {
    minute: parseCronField(fields[0], "minute", 0, 59),
    hour: parseCronField(fields[1], "hour", 0, 23),
    dayOfMonth: parseCronField(fields[2], "day-of-month", 1, 31),
    month: parseCronField(fields[3], "month", 1, 12, MONTH_NAME_TO_NUMBER),
    dayOfWeek: parseCronField(fields[4], "day-of-week", 0, 7, DOW_NAME_TO_NUMBER),
  };
}

function fieldMatches(field, value) {
  return field.any || field.values.has(value);
}

export function cronMatchesDate(parsedCron, date) {
  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const dayOfMonth = date.getUTCDate();
  const month = date.getUTCMonth() + 1;
  const dayOfWeek = date.getUTCDay();

  const minuteMatches = fieldMatches(parsedCron.minute, minute);
  const hourMatches = fieldMatches(parsedCron.hour, hour);
  const monthMatches = fieldMatches(parsedCron.month, month);
  const domMatches = fieldMatches(parsedCron.dayOfMonth, dayOfMonth);
  const dowMatches = fieldMatches(parsedCron.dayOfWeek, dayOfWeek);

  const dayMatches = parsedCron.dayOfMonth.any || parsedCron.dayOfWeek.any
    ? domMatches && dowMatches
    : domMatches || dowMatches;

  return minuteMatches && hourMatches && monthMatches && dayMatches;
}

export function cronDueTimes(expr, startExclusiveMs, endInclusiveMs) {
  const parsedCron = parseCronExpression(expr);
  const start = Math.floor(Number(startExclusiveMs) / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const end = Math.floor(Number(endInclusiveMs) / MINUTE_MS) * MINUTE_MS;

  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return [];
  }

  const dueTimes = [];
  for (let timestamp = start; timestamp <= end; timestamp += MINUTE_MS) {
    if (cronMatchesDate(parsedCron, new Date(timestamp))) {
      dueTimes.push(nowIso(timestamp));
    }
  }
  return dueTimes;
}

function truncatePreview(text, limit = RESPONSE_PREVIEW_LIMIT) {
  const raw = trimText(text);
  if (!raw) {
    return null;
  }
  if (raw.length <= limit) {
    return raw;
  }
  return `${raw.slice(0, Math.max(0, limit - 3))}...`;
}

function parseSchedulerJobRow(row) {
  const jobKey = trimText(row.job_key);
  if (!jobKey) {
    throw new Error("Invalid scheduler job: missing job_key");
  }

  const enabled = parseBinaryFlag(row.enabled, `scheduler_jobs.enabled for ${jobKey}`);
  const targetType = trimText(row.target_type);
  if (targetType !== "github_workflow" && targetType !== "cloud_run" && targetType !== "worker_http") {
    throw new Error(`Invalid scheduler job ${jobKey}: unsupported target_type ${JSON.stringify(targetType)}`);
  }

  const cronExpr = trimText(row.cron_expr);
  if (!cronExpr) {
    throw new Error(`Invalid scheduler job ${jobKey}: missing cron_expr`);
  }

  const timezone = normalizeTimezone(row.timezone);
  const dryRun = parseBinaryFlag(row.dry_run, `scheduler_jobs.dry_run for ${jobKey}`);

  const normalized = {
    job_key: jobKey,
    enabled,
    target_type: targetType,
    cron_expr: cronExpr,
    timezone,
    dry_run: dryRun,
    notes: trimText(row.notes) || null,
  };

  if (targetType === "github_workflow") {
    const githubRepo = trimText(row.github_repo);
    const githubWorkflowFile = trimText(row.github_workflow_file);
    const githubRef = trimText(row.github_ref) || "main";
    if (!githubRepo || !githubWorkflowFile || !githubRef) {
      throw new Error(`Invalid scheduler job ${jobKey}: github_workflow requires github_repo, github_workflow_file, and github_ref`);
    }

    normalized.github_repo = githubRepo;
    normalized.github_workflow_file = githubWorkflowFile;
    normalized.github_ref = githubRef;
    normalized.github_inputs = parseJsonObject(row.github_inputs_json, `scheduler_jobs.github_inputs_json for ${jobKey}`);
  } else if (targetType === "cloud_run") {
    const cloudRunUrl = trimText(row.cloud_run_url);
    if (!cloudRunUrl) {
      throw new Error(`Invalid scheduler job ${jobKey}: cloud_run requires cloud_run_url`);
    }

    normalized.cloud_run_url = cloudRunUrl;
    normalized.cloud_run_method = trimText(row.cloud_run_method) || "POST";
    normalized.cloud_run_headers = parseJsonObject(row.cloud_run_headers_json, `scheduler_jobs.cloud_run_headers_json for ${jobKey}`);
    normalized.cloud_run_body = parseJsonBody(row.cloud_run_body_json, `scheduler_jobs.cloud_run_body_json for ${jobKey}`);
  } else {
    normalized.worker_http_url = normalizeWorkerHttpUrl(row.worker_http_url, jobKey);
    normalized.worker_http_secret_binding = normalizeWorkerHttpSecretBinding(
      row.worker_http_secret_binding,
      jobKey,
    );
    normalized.worker_http_body = parseJsonObject(
      row.worker_http_body_json,
      `scheduler_jobs.worker_http_body_json for ${jobKey}`,
    );
  }

  return normalized;
}

function requireD1Db(db) {
  if (!db || typeof db.prepare !== "function") {
    throw new Error(`Missing required Worker binding: ${D1_BINDING_NAME}`);
  }
  return db;
}

function bindStatement(db, sql, params = []) {
  const statement = db.prepare(sql);
  return params.length > 0 ? statement.bind(...params) : statement;
}

async function dbAll(db, sql, params = []) {
  const result = await bindStatement(db, sql, params).all();
  if (result?.success === false || !Array.isArray(result?.results)) {
    throw new Error(result?.error ?? "D1 returned no query results");
  }
  return result.results;
}

async function dbFirst(db, sql, params = []) {
  return (await bindStatement(db, sql, params).first()) ?? null;
}

async function dbRun(db, sql, params = []) {
  const result = await bindStatement(db, sql, params).run();
  if (result?.success === false || !Number.isInteger(result?.meta?.changes)) {
    throw new Error(result?.error ?? "D1 returned no write receipt");
  }
  return result.meta;
}

export function createSchedulerStore(db) {
  const schedulerDb = requireD1Db(db);
  const read = (sql, params, context, phase) => retryD1(
    () => dbAll(schedulerDb, sql, params), { ...context, phase },
  );

  async function writeClaim(sql, params, lookup, lookupParams, context) {
    const token = crypto.randomUUID();
    const readClaim = () => dbFirst(schedulerDb, lookup, lookupParams);
    return retryD1(
      async () => {
        const result = await dbRun(schedulerDb, sql, [...params, token]);
        if (result.changes > 0 && result.last_row_id > 0) {
          return { id: result.last_row_id, claim_token: token };
        }
        return readClaim();
      },
      context,
      async () => (await readClaim()) ?? undefined,
    ).then((row) => ({ row, owned: row?.claim_token === token }));
  }

  async function transition(table, id, statusColumn, initialStatus, patch, context) {
    const fields = Object.keys(patch);
    const values = Object.values(patch);
    const verify = async () => {
      const row = await dbFirst(schedulerDb, `select ${fields.join(", ")} from ${table} where id = ?`, [id]);
      if (row?.[statusColumn] === initialStatus) {
        return undefined;
      }
      if (!row || fields.some((field) => row[field] !== patch[field])) {
        throw new Error("Scheduler D1 transition did not match durable state");
      }
      return true;
    };
    await retryD1(
      async () => {
        const result = await dbRun(
          schedulerDb,
          `update ${table} set ${fields.map((field) => `${field} = ?`).join(", ")}
           where id = ? and ${statusColumn} = ?`,
          [...values, id, initialStatus],
        );
        if (result.changes !== 1 && !await verify()) {
          throw new Error("Scheduler D1 transition was not recorded");
        }
      },
      context,
      verify,
    );
  }

  return {
    async claimMinute(run) {
      const { row, owned } = await writeClaim(
        `insert into scheduler_runs (
          scheduler_name, minute_slot, trigger_source, started_at, status,
          evaluation_window_start, evaluation_window_end, claim_token
        ) values (?, ?, ?, ?, 'started', ?, ?, ?)
        on conflict(scheduler_name, minute_slot) do nothing`,
        [
          run.scheduler_name, run.minute_slot, run.trigger_source, run.started_at,
          run.evaluation_window_start, run.evaluation_window_end,
        ],
        `select id, status, trigger_source, claim_token from scheduler_runs
         where scheduler_name = ? and minute_slot = ?`,
        [run.scheduler_name, run.minute_slot],
        { scheduler_name: run.scheduler_name, minute_slot: run.minute_slot, phase: "claim_minute" },
      );
      if (!row) throw new Error("Scheduler minute claim was not recorded");
      return {
        claimed: owned,
        scheduler_run_id: row.id,
        run_status: row.status ?? "started",
        trigger_source: row.trigger_source ?? run.trigger_source,
      };
    },

    listEnabledJobs(context) {
      return read(
        `select job_key, enabled, target_type, cron_expr, timezone,
                github_repo, github_workflow_file, github_ref, github_inputs_json,
                cloud_run_url, cloud_run_method, cloud_run_headers_json, cloud_run_body_json,
                worker_http_url, worker_http_secret_binding, worker_http_body_json,
                dry_run, recovery_lookback_minutes, updated_at
         from scheduler_jobs where enabled = 1 order by job_key`,
        [], context, "list_jobs",
      );
    },

    listRecoveryJobs(context) {
      return read(
        `select job_key, cron_expr, enabled, dry_run, recovery_lookback_minutes, updated_at
         from scheduler_jobs where recovery_lookback_minutes > 0 order by job_key`,
        [], context, "list_recovery_jobs",
      );
    },

    async claimDispatch(claim, context, recoveryPolicy) {
      const values = [
        claim.job_key, claim.due_at, claim.claimed_at, claim.target_type, claim.dry_run,
      ];
      // For recovery the policy read and claim can span a config sync. Recheck it
      // in the INSERT itself so a stale policy cannot authorise a new claim.
      const insertion = recoveryPolicy
        ? `select ?, ?, ?, ?, ?, 'claimed', 'recovery_checking_history', input.token
           from scheduler_jobs, (select ? as job_key, ? as updated_at, ? as lookback, ? as token) input
           where scheduler_jobs.job_key = input.job_key and enabled = 1 and dry_run = 0
             and scheduler_jobs.updated_at = input.updated_at
             and recovery_lookback_minutes = input.lookback`
        : "values (?, ?, ?, ?, ?, 'claimed', null, ?)";
      if (recoveryPolicy) {
        values.push(claim.job_key, recoveryPolicy.updated_at, recoveryPolicy.recovery_lookback_minutes);
      }
      const { row, owned } = await writeClaim(
        `insert into scheduler_dispatches (
          job_key, due_at, claimed_at, target_type, dry_run, dispatch_status, reason, claim_token
        ) ${insertion}
        on conflict(job_key, due_at) do nothing`,
        values,
        "select id, claim_token from scheduler_dispatches where job_key = ? and due_at = ?",
        [claim.job_key, claim.due_at],
        { ...context, phase: recoveryPolicy ? "claim_recovery" : "claim_dispatch" },
      );
      if (!row && !recoveryPolicy) throw new Error("Scheduler dispatch claim was not recorded");
      return owned ? row.id : null;
    },

    updateDispatch(dispatchId, patch, context) {
      return transition("scheduler_dispatches", dispatchId, "dispatch_status", "claimed", patch, {
        ...context, dispatch_id: dispatchId, phase: "update_dispatch",
      });
    },

    finishRun(runId, patch, context) {
      return transition("scheduler_runs", runId, "status", "started", patch, { ...context, phase: "finish_run" });
    },

    listJobDispatches(jobKey, start, end, context) {
      return read(
        `select id, due_at, claimed_at, dispatch_status, reason, response_status
         from scheduler_dispatches where job_key = ? and due_at >= ? and due_at < ?
         order by due_at limit ?`,
        [jobKey, start, end, HEALTH_ROW_LIMIT + 1], context, "list_job_dispatches",
      );
    },

    async countClaimedMinutes(start, end, context) {
      const [row] = await read(
        `select count(*) as minutes_claimed from scheduler_runs
         where scheduler_name = ? and minute_slot >= ? and minute_slot < ?`,
        [SCHEDULER_NAME, start, end], context, "count_claimed_minutes",
      );
      if (!Number.isSafeInteger(row?.minutes_claimed)) throw new Error("Scheduler minute coverage unavailable");
      return row.minutes_claimed;
    },

    listUnhealthyRuns(start, end, grace, context) {
      return read(
        `select id, minute_slot, status, jobs_failed, error_message
         from scheduler_runs
         where scheduler_name = ? and minute_slot >= ? and minute_slot < ?
           and (status = 'failed' or jobs_failed > 0 or (status = 'started' and minute_slot <= ?))
         order by minute_slot limit ?`,
        [SCHEDULER_NAME, start, end, grace, HEALTH_ROW_LIMIT + 1], context, "list_unhealthy_runs",
      );
    },

    listUnhealthyDispatches(start, end, grace, context) {
      return read(
        `select id, job_key, due_at, claimed_at, dispatched_at, dispatch_status, reason, response_status
         from scheduler_dispatches where due_at >= ? and due_at < ?
           and (dispatch_status = 'failed'
             or (dispatch_status = 'claimed' and julianday(claimed_at) <= julianday(?))
             or (dispatch_status != 'claimed' and substr(reason, 1, 9) = 'recovery_'))
         order by due_at, job_key limit ?`,
        [start, end, grace, HEALTH_ROW_LIMIT + 1], context, "list_unhealthy_dispatches",
      );
    },
  };
}

class DispatchConfigurationError extends Error {}

async function githubWorkflowRequest(job, env) {
  const token = trimText(await readSecret(env.UK_AQ_GITHUB_WORKFLOW_DISPATCH_PAT));
  if (!token) {
    throw new DispatchConfigurationError("Missing required Worker secret: UK_AQ_GITHUB_WORKFLOW_DISPATCH_PAT");
  }
  const [owner, repo, extra] = job.github_repo.split("/");
  if (!owner || !repo || extra !== undefined) {
    throw new DispatchConfigurationError("Invalid github_repo; expected owner/repo");
  }
  return {
    url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
      + `/actions/workflows/${encodeURIComponent(job.github_workflow_file)}`,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": GITHUB_USER_AGENT,
    },
    token,
  };
}

async function responsePreview(response, secret) {
  try {
    return truncatePreview((await response.text()).split(secret).join("[REDACTED]"));
  } catch {
    // The HTTP status was received even if the optional response body was lost.
    return null;
  }
}

async function dispatchGitHubWorkflow(job, env, signal) {
  const { url, headers, token } = await githubWorkflowRequest(job, env);
  const response = await fetch(`${url}/dispatches`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ ref: job.github_ref, inputs: job.github_inputs }),
    signal,
  });
  if (response.status === 204) {
    return { ok: true, response_status: 204 };
  }
  return {
    ok: false,
    uncertain: response.ok,
    response_status: response.status,
    response_preview: await responsePreview(response, token),
    reason: `GitHub dispatch failed with HTTP ${response.status}`,
  };
}

async function checkRecoveryWorkflowHistory(job, dueMs, env) {
  try {
    const { url, headers } = await githubWorkflowRequest(job, env);
    // Include manual runs, all branches and queued or failed runs. Any recent
    // run may already cover the slot. A single matching run is enough to hold.
    const start = nowIso(dueMs - MAX_RECOVERY_LOOKBACK_MINUTES * MINUTE_MS).replace(".000Z", "Z");
    const query = new URLSearchParams({ created: `>=${start}`, per_page: "1" });
    const response = await fetch(`${url}/runs?${query}`, {
      headers, signal: AbortSignal.timeout(RECOVERY_HTTP_TIMEOUT_MS), redirect: "error",
    });
    if (!response.ok) return `recovery_review_history_http_${response.status}`;
    const history = await response.json();
    const runs = history?.workflow_runs;
    if (!Array.isArray(runs) || !Number.isSafeInteger(history.total_count)
        || history.total_count < 0 || runs.length !== Math.min(1, history.total_count)) {
      return "recovery_review_history_inconclusive";
    }
    if (history.total_count === 0) {
      return response.headers.has("link") ? "recovery_review_history_inconclusive" : null;
    }
    const runId = runs[0]?.id;
    return Number.isSafeInteger(runId) && runId > 0
      ? `recovery_review_recent_workflow_run_${runId}`
      : "recovery_review_recent_workflow_run";
  } catch {
    return "recovery_review_history_unavailable";
  }
}

async function dispatchCloudRun(job, env) {
  const secret = trimText(await readSecret(env.UK_AQ_EDGE_UPSTREAM_SECRET));
  if (!secret) {
    throw new DispatchConfigurationError("Missing required Worker secret: UK_AQ_EDGE_UPSTREAM_SECRET");
  }

  const headers = new Headers();
  for (const [key, value] of Object.entries(job.cloud_run_headers)) {
    if (value !== undefined && value !== null) {
      headers.set(key, String(value));
    }
  }
  headers.set("x-uk-aq-dispatch-secret", secret);

  const method = trimText(job.cloud_run_method || "POST").toUpperCase();
  const fetchOptions = {
    method,
    headers,
  };

  if (method !== "GET" && method !== "HEAD") {
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json; charset=utf-8");
    }
    fetchOptions.body = JSON.stringify(job.cloud_run_body ?? {});
  }

  const response = await fetch(job.cloud_run_url, fetchOptions);
  const preview = await responsePreview(response, secret);
  return response.ok
    ? {
        ok: true,
        response_status: response.status,
        response_preview: preview,
      }
    : {
        ok: false,
        response_status: response.status,
        response_preview: preview,
        reason: `Cloud Run dispatch failed with HTTP ${response.status}`,
      };
}

async function dispatchWorkerHttp(job, env) {
  const binding = job.worker_http_secret_binding;
  const secret = trimText(await readSecret(env?.[binding]));
  if (!secret) {
    throw new DispatchConfigurationError(`Missing required Worker secret: ${binding}`);
  }

  const response = await fetch(job.worker_http_url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json; charset=utf-8",
      "x-uk-aq-worker-http-secret": secret,
    },
    body: JSON.stringify(job.worker_http_body ?? {}),
  });
  const preview = await responsePreview(response, secret);
  return response.ok
    ? {
        ok: true,
        response_status: response.status,
        response_preview: preview,
      }
    : {
        ok: false,
        response_status: response.status,
        response_preview: preview,
        reason: `Worker HTTP dispatch failed with HTTP ${response.status}`,
      };
}

async function dispatchTarget(job, env, signal) {
  if (job.target_type === "github_workflow") {
    return dispatchGitHubWorkflow(job, env, signal);
  }
  if (job.target_type === "cloud_run") {
    return dispatchCloudRun(job, env);
  }
  if (job.target_type === "worker_http") {
    return dispatchWorkerHttp(job, env);
  }
  throw new Error(`Unsupported target_type ${JSON.stringify(job.target_type)}`);
}

export function dueSlotsForJob(job, windowStartMs, windowEndMs) {
  return cronDueTimes(
    job.cron_expr,
    windowStartMs + DISPATCH_LEAD_MS,
    windowEndMs + DISPATCH_LEAD_MS,
  );
}

function schedulerFailure(error, context, phase) {
  return {
    phase,
    ...(context.job_key && { job_key: context.job_key }),
    ...(context.due_at && { due_at: context.due_at }),
    error_class: error?.error_class ?? "scheduler_operation_failed",
    ...(error?.error_reference && { error_reference: error.error_reference }),
  };
}

function logSchedulerFailure(error, context, phase) {
  const failure = schedulerFailure(error, context, phase);
  logJson(WORKER_NAME, "scheduler_operation_failed", { ...context, ...failure });
  return failure;
}

function dispatchClaim(job, dueAt) {
  return {
    job_key: job.job_key,
    due_at: dueAt,
    claimed_at: nowIso(),
    target_type: job.target_type,
    dry_run: job.dry_run,
  };
}

async function submitDispatch(store, dispatchId, job, env, context, recovering = false) {
  const dispatchedAt = nowIso();
  let patch;
  if (job.dry_run === 1) {
    patch = { dispatch_status: "dry_run", reason: "dry_run_enabled", dispatched_at: dispatchedAt };
  } else {
    let result;
    try {
      result = await dispatchTarget(
        job, env, recovering ? AbortSignal.timeout(RECOVERY_HTTP_TIMEOUT_MS) : undefined,
      );
    } catch (error) {
      const knownNotSubmitted = error instanceof DispatchConfigurationError;
      result = {
        ok: false,
        uncertain: !knownNotSubmitted,
        reason: knownNotSubmitted ? error.message : "external_submission_outcome_unknown",
      };
    }
    const uncertain = result.uncertain || result.response_status === 408 || result.response_status >= 500;
    const reason = recovering
      ? (result.ok ? "recovery_accepted" : uncertain ? "recovery_outcome_unknown" : "recovery_dispatch_failed")
      : (uncertain ? "external_submission_outcome_unknown" : result.reason ?? null);
    patch = {
      dispatched_at: dispatchedAt,
      dispatch_status: result.ok ? "dispatched" : "failed",
      reason,
      response_status: result.response_status ?? null,
      response_preview: result.response_preview ?? null,
    };
  }

  await store.updateDispatch(dispatchId, {
    response_status: null, response_preview: null, ...patch,
  }, context);
  logJson(WORKER_NAME, "scheduler_dispatch_result", {
    ...context,
    dispatch_id: dispatchId,
    target_type: job.target_type,
    dispatch_status: patch.dispatch_status,
    reason: patch.reason,
    response_status: patch.response_status ?? null,
  });
  return patch.dispatch_status;
}

export async function dispatchDueJobsForWindow(
  store, jobs, env, windowStartMs, windowEndMs, context = {}, failures = [],
) {
  const summary = {
    jobs_checked: jobs.length,
    jobs_due: 0,
    jobs_claimed: 0,
    jobs_dispatched: 0,
    jobs_failed: 0,
  };

  for (const rawJob of jobs) {
    const jobContext = { scheduler_name: SCHEDULER_NAME, ...context, job_key: trimText(rawJob?.job_key) };
    let job;
    let dueTimes;
    try {
      job = parseSchedulerJobRow(rawJob);
      dueTimes = dueSlotsForJob(job, windowStartMs, windowEndMs);
    } catch {
      summary.jobs_failed += 1;
      failures.push(logSchedulerFailure({ error_class: "invalid_job" }, jobContext, "evaluate_job"));
      continue;
    }

    summary.jobs_due += dueTimes.length;
    for (const dueAt of dueTimes) {
      const slotContext = { ...jobContext, due_at: dueAt };
      let phase = "claim_dispatch";
      try {
        const dispatchId = await store.claimDispatch(dispatchClaim(job, dueAt), slotContext);
        if (!dispatchId) continue;

        summary.jobs_claimed += 1;
        phase = "update_dispatch";
        const status = await submitDispatch(store, dispatchId, job, env, slotContext);
        if (status === "dispatched") summary.jobs_dispatched += 1;
        if (status === "failed") summary.jobs_failed += 1;
      } catch (error) {
        summary.jobs_failed += 1;
        failures.push(logSchedulerFailure(error, slotContext, phase));
      }
    }
  }
  return summary;
}

function recoveryPolicyStart(job) {
  // Older SQLite defaults have no time-zone suffix. Only an explicit ISO
  // timestamp from the recovery-aware sync can prove continuous eligibility.
  return typeof job.updated_at === "string" && job.updated_at.endsWith("Z")
    ? Date.parse(job.updated_at) : NaN;
}

async function recoverMissedDispatch(store, jobs, env, context, failures, nowMs) {
  for (const rawJob of jobs) {
    const lookback = rawJob.recovery_lookback_minutes;
    if (!(Number.isInteger(lookback) && lookback > 0 && lookback <= MAX_RECOVERY_LOOKBACK_MINUTES)
        || rawJob.dry_run !== 0) continue;

    let slotContext = { ...context, job_key: rawJob.job_key };
    let phase = "evaluate_recovery";
    try {
      const job = parseSchedulerJobRow(rawJob);
      if (job.target_type !== "github_workflow") continue;
      const policyStartedMs = recoveryPolicyStart(rawJob);
      if (!Number.isFinite(policyStartedMs)) continue;

      const oldestDueMs = Math.max(nowMs - lookback * MINUTE_MS - 1, policyStartedMs + DISPATCH_LEAD_MS);
      const latestDueMs = nowMs - SCHEDULER_GRACE_MS;
      const slots = cronDueTimes(job.cron_expr, oldestDueMs, latestDueMs).reverse();
      if (slots.length === 0) continue;

      phase = "list_job_dispatches";
      const prior = await store.listJobDispatches(job.job_key, slots.at(-1), nowIso(latestDueMs + 1), slotContext);
      // A truncated history must not make an existing row look absent.
      if (prior.length > HEALTH_ROW_LIMIT) throw new Error("Scheduler dispatch history truncated");
      const recorded = new Set(prior.map((row) => row.due_at));
      const dueAt = slots.find((slot) => !recorded.has(slot));
      if (!dueAt) continue;

      slotContext = { ...slotContext, due_at: dueAt };
      phase = "claim_recovery";
      const dispatchId = await store.claimDispatch(dispatchClaim(job, dueAt), slotContext, rawJob);
      if (!dispatchId) return;

      // A claimed row blocks other invocations even if history or submission
      // ends ambiguously. Release only through an explicit terminal transition.
      phase = "update_recovery_dispatch";
      const reviewReason = await checkRecoveryWorkflowHistory(job, Date.parse(dueAt), env);
      if (reviewReason) {
        await store.updateDispatch(dispatchId, {
          dispatch_status: "skipped", dispatched_at: null, reason: reviewReason,
          response_status: null, response_preview: null,
        }, slotContext);
        logJson(WORKER_NAME, "scheduler_recovery_held", {
          ...slotContext, dispatch_id: dispatchId, reason: reviewReason,
        });
      } else {
        await submitDispatch(store, dispatchId, job, env, slotContext, true);
      }
      return;
    } catch (error) {
      failures.push(logSchedulerFailure(error, slotContext, phase));
      return;
    }
  }
}

export async function runScheduler(
  store,
  env = {},
  nowMs = Date.now(),
  schedulerName = SCHEDULER_NAME,
  triggerSource = TRIGGER_SOURCE_CLOUDFLARE_CRON,
) {
  const startedAt = nowIso(nowMs);
  const minuteSlot = canonicalMinuteSlot(nowMs);
  const window = currentMinuteEvaluationWindow(minuteSlot);
  const normalizedTriggerSource = normalizeTriggerSource(triggerSource);
  const evaluationWindow = {
    previous_run_started_at: null,
    evaluation_window_start: window.start,
    evaluation_window_end: minuteSlot,
  };

  const minuteClaim = await store.claimMinute({
    scheduler_name: schedulerName,
    minute_slot: minuteSlot,
    trigger_source: normalizedTriggerSource,
    started_at: startedAt,
    status: "started",
    ...evaluationWindow,
  });
  const context = {
    scheduler_name: schedulerName,
    scheduler_run_id: minuteClaim.scheduler_run_id,
    minute_slot: minuteSlot,
    trigger_source: normalizedTriggerSource,
  };
  if (!minuteClaim.claimed) {
    return {
      ...context,
      claimed_trigger_source: minuteClaim.trigger_source,
      run_status: minuteClaim.run_status,
      status: "already_claimed",
    };
  }

  const failures = [];
  let summary = { jobs_checked: 0, jobs_due: 0, jobs_claimed: 0, jobs_dispatched: 0, jobs_failed: 0 };
  let fatal;
  try {
    const jobs = await store.listEnabledJobs(context);
    summary = await dispatchDueJobsForWindow(store, jobs, env, window.startMs, window.endMs, context, failures);
    await recoverMissedDispatch(store, jobs, env, context, failures, Date.now());
  } catch (error) {
    fatal = error;
    failures.push(logSchedulerFailure(error, context, "evaluate_minute"));
  }

  const status = failures.length ? "failed" : "finished";
  const errorMessage = failures.length ? JSON.stringify({
    total: failures.length, failures: failures.slice(0, MAX_RECORDED_FAILURES),
  }) : null;
  try {
    await store.finishRun(context.scheduler_run_id, {
      ...evaluationWindow,
      ...summary,
      status,
      finished_at: nowIso(),
      error_message: errorMessage,
    }, context);
  } catch (error) {
    logSchedulerFailure(error, context, "finish_run");
    // Preserve the existing started row if we cannot confirm its terminal write.
    throw error;
  }

  if (fatal) throw fatal;
  return {
    ...context,
    ...evaluationWindow,
    ...summary,
    started_at: startedAt,
    run_status: status,
    status: "triggered",
  };
}

async function schedulerHealth(store, startMs, endMs) {
  const nowMs = Date.now();
  const start = nowIso(startMs);
  const end = nowIso(Math.min(endMs, nowMs));
  const grace = nowIso(nowMs - SCHEDULER_GRACE_MS);
  const coverageEndMs = Math.min(endMs, nowMs - SCHEDULER_GRACE_MS + 1);
  const expectedMinutes = Math.max(0, Math.ceil(coverageEndMs / MINUTE_MS) - Math.ceil(startMs / MINUTE_MS));
  const context = { scheduler_name: SCHEDULER_NAME, window_start: start, window_end: end };
  const [runs, dispatches, policies, claimedMinutes] = await Promise.all([
    store.listUnhealthyRuns(start, end, grace, context),
    store.listUnhealthyDispatches(start, end, grace, context),
    store.listRecoveryJobs(context),
    expectedMinutes ? store.countClaimedMinutes(start, nowIso(coverageEndMs), context) : 0,
  ]);
  let complete = runs.length <= HEALTH_ROW_LIMIT && dispatches.length <= HEALTH_ROW_LIMIT;
  const diagnostics = [];
  if (claimedMinutes < expectedMinutes) {
    diagnostics.push({
      slot: start, state: "minutes_without_claims", missing_minutes: expectedMinutes - claimedMinutes,
    });
  }
  for (const run of runs.slice(0, HEALTH_ROW_LIMIT)) {
    const base = { slot: run.minute_slot, run_id: run.id };
    if (run.status === "started") {
      diagnostics.push({ ...base, state: "minute_incomplete" });
      continue;
    }

    let detail;
    try {
      detail = JSON.parse(run.error_message);
    } catch {
      // Legacy runs can contain arbitrary provider messages. Never return them.
    }
    const failures = Array.isArray(detail?.failures) ? detail.failures.slice(0, MAX_RECORDED_FAILURES) : [];
    diagnostics.push({
      ...base, state: "minute_errors", failures: detail?.total ?? run.jobs_failed,
    });
    for (const failure of failures) {
      if (!/^[a-z_]{1,40}$/.test(failure?.phase) || !/^[a-z_]{1,40}$/.test(failure?.error_class)) continue;
      diagnostics.push({
        ...base,
        slot: failure.due_at ?? base.slot,
        state: failure.error_class,
        job_key: failure.job_key,
        phase: failure.phase,
        error_reference: failure.error_reference,
      });
    }
  }
  for (const row of dispatches.slice(0, HEALTH_ROW_LIMIT)) {
    let state;
    if (row.dispatch_status === "claimed") {
      state = "claim_past_grace_outcome_unknown";
    } else if (/^recovery_[a-z_0-9]{1,80}$/.test(row.reason)) {
      state = row.reason;
    } else if (row.reason === "external_submission_outcome_unknown" || row.response_status >= 500
        || row.response_status === 408 || (row.response_status === null
          && !row.reason?.startsWith("Missing required Worker secret:"))) {
      state = "submission_outcome_unknown";
    } else {
      state = "dispatch_failed";
    }
    diagnostics.push({
      slot: row.due_at, job_key: row.job_key, state, dispatch_id: row.id,
      http_status: row.response_status, dispatched_at: row.dispatched_at,
    });
  }
  for (const job of policies) {
    if (job.enabled !== 1 || job.dry_run !== 0) continue;
    const stopMs = Math.min(endMs - 1, nowMs - SCHEDULER_GRACE_MS);
    const dueSlots = cronDueTimes(job.cron_expr, startMs - 1, stopMs);
    if (!dueSlots.length) continue;
    const receipts = await store.listJobDispatches(job.job_key, start, end, {
      ...context, job_key: job.job_key,
    });
    if (receipts.length > HEALTH_ROW_LIMIT) {
      complete = false;
      continue;
    }
    const recorded = new Set(receipts.map((row) => row.due_at));
    for (const slot of dueSlots) {
      if (recorded.has(slot)) continue;
      const dueMs = Date.parse(slot);
      const continuousPolicy = recoveryPolicyStart(job) < dueMs - DISPATCH_LEAD_MS;
      const expired = nowMs - dueMs > job.recovery_lookback_minutes * MINUTE_MS;
      const state = !continuousPolicy ? "review_policy_at_due_unconfirmed"
        : expired ? "missed_recovery_window_expired" : "missed_dispatch_no_claim";
      diagnostics.push({ slot, job_key: job.job_key, state });
    }
  }
  diagnostics.sort((left, right) => left.slot.localeCompare(right.slot));
  return {
    complete: complete && diagnostics.length <= HEALTH_ROW_LIMIT,
    grace_minutes: SCHEDULER_GRACE_MS / MINUTE_MS,
    diagnostics: diagnostics.slice(0, HEALTH_ROW_LIMIT),
  };
}

function getSchedulerStoreFromEnv(env) {
  return createSchedulerStore(env?.[D1_BINDING_NAME]);
}

export default {
  async scheduled(controller, env, ctx) {
    const scheduledTime = Number(controller?.scheduledTime ?? Date.now());
    ctx.waitUntil(
      runScheduler(
        getSchedulerStoreFromEnv(env),
        env,
        scheduledTime,
        SCHEDULER_NAME,
        TRIGGER_SOURCE_CLOUDFLARE_CRON,
      ),
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/run-if-due") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }
      if (!await hasValidSchedulerTriggerSecret(request, env)) {
        return jsonResponse({ ok: false, error: "unauthorized" }, 401);
      }
      const invokedAtMs = Date.now();
      try {
        const result = await runScheduler(
          getSchedulerStoreFromEnv(env),
          env,
          invokedAtMs,
          SCHEDULER_NAME,
          TRIGGER_SOURCE_EXTERNAL_WATCHDOG,
        );
        return jsonResponse({ ok: true, ...result });
      } catch {
        return jsonResponse({
          ok: false,
          status: "failed",
          scheduler_name: SCHEDULER_NAME,
          trigger_source: TRIGGER_SOURCE_EXTERNAL_WATCHDOG,
          minute_slot: canonicalMinuteSlot(invokedAtMs),
        }, 500);
      }
    }
    if (url.pathname === "/scheduler-health") {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      if (!await hasValidSchedulerTriggerSecret(request, env)) {
        return jsonResponse({ ok: false, error: "unauthorized" }, 401);
      }
      const startMs = Date.parse(url.searchParams.get("start"));
      const endMs = Date.parse(url.searchParams.get("end"));
      if (!(startMs < endMs) || endMs - startMs > 24 * 60 * MINUTE_MS) {
        return jsonResponse({ ok: false, error: "invalid_window" }, 400);
      }
      try {
        const evidence = await schedulerHealth(getSchedulerStoreFromEnv(env), startMs, endMs);
        return new Response(JSON.stringify({ ok: true, ...evidence }), {
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        });
      } catch {
        return jsonResponse({ ok: false, error: "scheduler_evidence_unavailable" }, 503);
      }
    }
    if (url.pathname !== "/" && url.pathname !== "/health") {
      return new Response("Not found", { status: 404 });
    }

    return jsonResponse({
      ok: true,
      worker: WORKER_NAME,
      scheduler_name: SCHEDULER_NAME,
      binding: D1_BINDING_NAME,
    });
  },
};
