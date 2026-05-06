import { createServer } from "node:http";
import {
  DEFAULT_DATABASE_ORDER,
  SERVICE_NAME,
  logStructured,
  resolveRequestedDatabases,
  runBackupWorkflow,
} from "./core.mjs";

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
    const report = await runBackupWorkflow({
      triggerMode,
      requestedDatabases,
    });
    sendJson(response, report.ok ? 200 : 500, report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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
