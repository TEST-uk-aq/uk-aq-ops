import { createServer } from "node:http";
import {
  DEFAULT_DATABASE_ORDER,
  SERVICE_NAME,
  logStructured,
  resolveRequestedDatabases,
  runBackupWorkflow,
} from "./core.mjs";
import {
  dailyTaskFailed,
  dailyTaskFinished,
  dailyTaskStarted,
} from "../shared/daily_task_health.mjs";

const PORT = Number(process.env.PORT || "8080");
const ALLOWED_TRIGGER_MODES = new Set(["manual", "scheduler"]);

let inFlight = false;

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return null;
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return null;
  }
  return JSON.parse(raw);
}

function resolveTriggerMode(requestUrl, request, body) {
  const queryMode = String(requestUrl.searchParams.get("trigger_mode") || "")
    .trim()
    .toLowerCase();
  if (ALLOWED_TRIGGER_MODES.has(queryMode)) {
    return queryMode;
  }

  const headerMode = String(request.headers["x-uk-aq-trigger-mode"] || "")
    .trim()
    .toLowerCase();
  if (ALLOWED_TRIGGER_MODES.has(headerMode)) {
    return headerMode;
  }

  const bodyMode = typeof body?.trigger_mode === "string"
    ? body.trigger_mode.trim().toLowerCase()
    : "";
  if (ALLOWED_TRIGGER_MODES.has(bodyMode)) {
    return bodyMode;
  }

  return "manual";
}

function resolveRequestedDatabaseSelection(requestUrl, body) {
  const queryDatabase = String(requestUrl.searchParams.get("database") || "").trim();
  if (queryDatabase) {
    return queryDatabase;
  }

  if (typeof body?.database === "string" && body.database.trim()) {
    return body.database;
  }

  if (Array.isArray(body?.databases)) {
    return body.databases;
  }

  return null;
}

function compactDbDumpHealthSummary(report = {}) {
  const databases = Array.isArray(report.databases) ? report.databases : [];
  const dumpCount = databases.reduce((total, entry) => total + (Array.isArray(entry.dumps) ? entry.dumps.length : 0), 0);
  const successfulDatabases = databases.filter((entry) => entry.ok).length;
  const failedDatabases = databases.filter((entry) => !entry.ok).length;
  const totalBytes = databases.reduce((dbTotal, entry) => {
    const dumps = Array.isArray(entry.dumps) ? entry.dumps : [];
    return dbTotal + dumps.reduce((dumpTotal, dump) => dumpTotal + Number(dump.gzip_bytes || 0), 0);
  }, 0);
  const startedMs = Date.parse(report.started_at || "");
  const finishedMs = Date.parse(report.finished_at || "");

  return {
    ok: report.ok,
    trigger_mode: report.trigger_mode,
    databases_backed_up: databases.map((entry) => entry.database),
    requested_databases: report.requested_databases,
    dump_count: dumpCount,
    successful_dump_count: report.ok ? dumpCount : databases
      .filter((entry) => entry.ok)
      .reduce((total, entry) => total + (Array.isArray(entry.dumps) ? entry.dumps.length : 0), 0),
    failed_dump_count: report.ok ? 0 : Math.max(0, (report.requested_databases?.length || databases.length) * 3 - dumpCount),
    successful_database_count: successfulDatabases,
    failed_database_count: failedDatabases,
    bytes_written: totalBytes,
    total_bytes: totalBytes,
    destination: {
      type: "dropbox",
      root: report.dropbox_backup_root,
    },
    elapsed_seconds: Number.isFinite(startedMs) && Number.isFinite(finishedMs)
      ? Math.max(0, Math.round((finishedMs - startedMs) / 1000))
      : undefined,
    error: report.error,
    warnings: failedDatabases > 0 ? [`failed databases: ${failedDatabases}`] : [],
  };
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  if (request.method === "GET" && (requestUrl.pathname === "/" || requestUrl.pathname === "/healthz")) {
    sendJson(response, 200, {
      ok: true,
      service: SERVICE_NAME,
      endpoint: "/run-backup",
      databases: DEFAULT_DATABASE_ORDER,
    });
    return;
  }

  if (request.method !== "POST" || requestUrl.pathname !== "/run-backup") {
    sendJson(response, 404, {
      ok: false,
      error: "not_found",
    });
    return;
  }

  if (inFlight) {
    sendJson(response, 409, {
      ok: false,
      error: "run_in_flight",
    });
    return;
  }

  let body = null;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: "invalid_json",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  let triggerMode = "manual";
  let requestedDatabases = null;
  let healthRunId = null;
  let healthInput = null;
  try {
    triggerMode = resolveTriggerMode(requestUrl, request, body);
    requestedDatabases = resolveRequestedDatabases(
      triggerMode,
      resolveRequestedDatabaseSelection(requestUrl, body),
    );
  } catch (error) {
    sendJson(response, 400, {
      ok: false,
      error: "invalid_database_selection",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  inFlight = true;
  try {
    healthInput = {
      task_key: "ops.supabase_db_dump_backup",
      source_repo: "uk-aq-ops",
      source_worker: "uk_aq_supabase_db_dump_backup_service",
      summary: {
        trigger_mode: triggerMode,
        requested_databases: requestedDatabases,
      },
    };
    healthRunId = await dailyTaskStarted(healthInput);
    const report = await runBackupWorkflow({
      triggerMode,
      requestedDatabases,
    });
    const healthSummary = compactDbDumpHealthSummary(report);
    if (report.ok) {
      await dailyTaskFinished(healthRunId, {
        ...healthInput,
        summary: healthSummary,
      });
    } else {
      await dailyTaskFailed(
        healthRunId,
        new Error(report.error || "Supabase DB dump backup failed."),
        {
          ...healthInput,
          summary: healthSummary,
        },
      );
    }
    sendJson(response, report.ok ? 200 : 500, report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (healthRunId) {
      await dailyTaskFailed(healthRunId, error, {
        ...healthInput,
        summary: {
          trigger_mode: triggerMode,
          requested_databases: requestedDatabases,
        },
      });
    }
    logStructured("ERROR", "supabase_db_backup_http_handler_failed", {
      error: message,
    });
    sendJson(response, 500, {
      ok: false,
      service: SERVICE_NAME,
      error: "internal_error",
      message,
    });
  } finally {
    inFlight = false;
  }
});

server.listen(PORT, () => {
  logStructured("INFO", "supabase_db_backup_http_server_started", {
    port: PORT,
    service: SERVICE_NAME,
  });
});
