import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const DROPBOX_TOKEN_URL = "https://api.dropbox.com/oauth2/token";
const DROPBOX_API_BASE_URL = "https://api.dropboxapi.com/2";
const DROPBOX_UPLOAD_URL = "https://content.dropboxapi.com/2/files/upload";

export const SERVICE_NAME = "uk_aq_supabase_db_dump_backup_service";
export const DEFAULT_DATABASE_ORDER = Object.freeze(["ingestdb", "obs_aqidb"]);
export const DEFAULT_DUMP_KINDS = Object.freeze(["roles", "schema", "data"]);
export const DEFAULT_RETENTION_DAYS = 7;
export const DEFAULT_BACKUP_DIR = "Supabase_Backup_db_dump";
const MAX_LOG_MESSAGE_LENGTH = 1200;

function nowIso() {
  return new Date().toISOString();
}

export function logStructured(severity, event, details = {}) {
  const entry = {
    severity,
    event,
    timestamp: nowIso(),
    service: SERVICE_NAME,
    ...details,
  };
  const line = JSON.stringify(entry);
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

export function parsePositiveInt(rawValue, fallback, min = 1, max = 10_000) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const intValue = Math.trunc(parsed);
  if (intValue < min) {
    return min;
  }
  if (intValue > max) {
    return max;
  }
  return intValue;
}

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function normalizeDropboxPath(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) {
    return "";
  }
  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
  return withLeadingSlash.replace(/\/+$/, "");
}

export function joinDropboxPath(...parts) {
  const joined = parts
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join("/");
  return normalizeDropboxPath(joined);
}

export function buildBackupRoot(dropboxRoot, backupDir = DEFAULT_BACKUP_DIR) {
  return joinDropboxPath(dropboxRoot, backupDir);
}

export function buildDatabaseBackupFolder(dropboxRoot, backupDir, databaseName, runDate) {
  return joinDropboxPath(buildBackupRoot(dropboxRoot, backupDir), databaseName, runDate);
}

export function formatUtcDate(dateLike = new Date()) {
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid date supplied.");
  }
  return date.toISOString().slice(0, 10);
}

export function shiftUtcDate(isoDate, dayDelta) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ISO date: ${isoDate}`);
  }
  date.setUTCDate(date.getUTCDate() + dayDelta);
  return formatUtcDate(date);
}

export function resolveOldestKeptDate(runDate, retentionDays) {
  return shiftUtcDate(runDate, -(retentionDays - 1));
}

export function planRetentionDeletes(entries, oldestKeptDate) {
  const cutoff = String(oldestKeptDate || "").trim();
  const deletes = [];
  const keeps = [];

  for (const entry of entries) {
    const entryName = String(entry?.name || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entryName)) {
      continue;
    }
    const normalized = {
      name: entryName,
      path_lower: entry?.path_lower || null,
      path_display: entry?.path_display || null,
    };
    if (entryName < cutoff) {
      deletes.push(normalized);
      continue;
    }
    keeps.push(normalized);
  }

  deletes.sort((left, right) => left.name.localeCompare(right.name));
  keeps.sort((left, right) => left.name.localeCompare(right.name));

  return { deletes, keeps };
}

export function resolveRequestedDatabases(triggerMode, requestedDatabases = null) {
  if (triggerMode === "scheduler") {
    return [...DEFAULT_DATABASE_ORDER];
  }

  if (requestedDatabases === null || requestedDatabases === undefined) {
    return [...DEFAULT_DATABASE_ORDER];
  }

  const values = Array.isArray(requestedDatabases)
    ? requestedDatabases
    : [requestedDatabases];

  const normalized = [];
  for (const value of values) {
    const databaseName = String(value || "").trim().toLowerCase();
    if (!databaseName) {
      continue;
    }
    if (!DEFAULT_DATABASE_ORDER.includes(databaseName)) {
      throw new Error(`Unsupported database selection: ${databaseName}`);
    }
    if (!normalized.includes(databaseName)) {
      normalized.push(databaseName);
    }
  }

  return normalized.length > 0 ? normalized : [...DEFAULT_DATABASE_ORDER];
}

export function buildDumpArgs({ dbUrl, outputFile, dumpKind }) {
  const args = [
    "db",
    "dump",
    "--dry-run",
    "--db-url",
    dbUrl,
    "--file",
    outputFile,
  ];

  if (dumpKind === "roles") {
    args.push("--role-only");
  } else if (dumpKind === "data") {
    args.push("--data-only");
  } else if (dumpKind !== "schema") {
    throw new Error(`Unsupported dump kind: ${dumpKind}`);
  }

  return args;
}

export function extractDryRunScript(outputText) {
  const marker = "#!/usr/bin/env bash";
  const markerIndex = String(outputText || "").indexOf(marker);
  if (markerIndex < 0) {
    throw new Error("Unable to find the Supabase dry-run bash script.");
  }
  return String(outputText).slice(markerIndex).trim();
}

function redactSensitiveText(rawValue) {
  return String(rawValue || "")
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, "postgresql://[REDACTED]")
    .replace(/PGPASSWORD="[^"]*"/g, 'PGPASSWORD="[REDACTED]"')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [REDACTED]")
    .replace(/client_secret=[^&\s]+/g, "client_secret=[REDACTED]")
    .replace(/refresh_token=[^&\s]+/g, "refresh_token=[REDACTED]");
}

function sanitizeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = redactSensitiveText(message).trim();
  if (redacted.length <= MAX_LOG_MESSAGE_LENGTH) {
    return redacted;
  }
  return `${redacted.slice(0, MAX_LOG_MESSAGE_LENGTH - 3)}...`;
}

async function readResponseText(response, limit = MAX_LOG_MESSAGE_LENGTH) {
  const raw = await response.text();
  return raw.length <= limit ? raw : `${raw.slice(0, limit - 3)}...`;
}

async function spawnAndCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: Number(code ?? 0),
        stdout,
        stderr,
      });
    });
  });
}

async function executeDumpScriptToFile({ bashBin, scriptText, scriptPath, outputFile }) {
  await fs.writeFile(scriptPath, `${scriptText}\n`, { mode: 0o700 });
  const outputHandle = await fs.open(outputFile, "w", 0o600);

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(bashBin, [scriptPath], {
        cwd: path.dirname(scriptPath),
        env: process.env,
        stdio: ["ignore", outputHandle.fd, "pipe"],
      });

      let stderr = "";
      if (child.stderr) {
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
      }

      child.on("error", reject);
      child.on("close", (code) => {
        if (Number(code ?? 0) !== 0) {
          reject(
            new Error(
              `Dump script failed with exit ${code}: ${sanitizeErrorMessage(stderr)}`,
            ),
          );
          return;
        }
        resolve();
      });
    });
  } finally {
    await outputHandle.close();
    await fs.rm(scriptPath, { force: true });
  }
}

async function gzipFile(gzipBin, filePath) {
  const result = await spawnAndCapture(gzipBin, ["-f", filePath]);
  if (result.code !== 0) {
    throw new Error(
      `gzip failed (${result.code}): ${sanitizeErrorMessage(result.stderr || result.stdout)}`,
    );
  }
  return `${filePath}.gz`;
}

class DropboxClient {
  constructor(config) {
    this.config = config;
    this.accessToken = null;
  }

  async ensureAccessToken() {
    if (this.accessToken) {
      return this.accessToken;
    }

    const tokenBody = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.config.refreshToken,
      client_id: this.config.appKey,
      client_secret: this.config.appSecret,
    });
    const response = await fetch(DROPBOX_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody.toString(),
    });
    if (!response.ok) {
      const text = await readResponseText(response);
      throw new Error(`Dropbox token request failed (${response.status}): ${text}`);
    }

    const payload = await response.json();
    const accessToken = String(payload?.access_token || "").trim();
    if (!accessToken) {
      throw new Error("Dropbox token response missing access_token.");
    }

    this.accessToken = accessToken;
    return accessToken;
  }

  async callJson(endpoint, body) {
    const accessToken = await this.ensureAccessToken();
    const response = await fetch(`${DROPBOX_API_BASE_URL}/${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (response.ok) {
      return response.json();
    }

    const text = await readResponseText(response);
    const error = new Error(`Dropbox API ${endpoint} failed (${response.status}): ${text}`);
    error.dropbox_status = response.status;
    error.dropbox_body = text;
    throw error;
  }

  async uploadFile(localPath, dropboxPath) {
    const accessToken = await this.ensureAccessToken();
    const response = await fetch(DROPBOX_UPLOAD_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Dropbox-API-Arg": JSON.stringify({
          path: dropboxPath,
          mode: "overwrite",
          autorename: false,
          mute: true,
          strict_conflict: false,
        }),
        "Content-Type": "application/octet-stream",
      },
      body: createReadStream(localPath),
      duplex: "half",
    });

    if (!response.ok) {
      const text = await readResponseText(response);
      throw new Error(`Dropbox upload failed (${response.status}): ${text}`);
    }

    return response.json();
  }

  async listFolderEntries(dropboxPath) {
    let response;
    try {
      response = await this.callJson("files/list_folder", {
        path: dropboxPath,
        recursive: false,
        include_deleted: false,
        include_mounted_folders: true,
      });
    } catch (error) {
      if (
        error?.dropbox_status === 409 &&
        String(error?.dropbox_body || "").includes("not_found")
      ) {
        return [];
      }
      throw error;
    }

    const entries = [...(Array.isArray(response?.entries) ? response.entries : [])];
    let cursor = response?.cursor || null;
    let hasMore = Boolean(response?.has_more);

    while (hasMore && cursor) {
      const page = await this.callJson("files/list_folder/continue", { cursor });
      entries.push(...(Array.isArray(page?.entries) ? page.entries : []));
      cursor = page?.cursor || null;
      hasMore = Boolean(page?.has_more);
    }

    return entries;
  }

  async deletePath(dropboxPath) {
    try {
      return await this.callJson("files/delete_v2", { path: dropboxPath });
    } catch (error) {
      if (
        error?.dropbox_status === 409 &&
        String(error?.dropbox_body || "").includes("not_found")
      ) {
        return null;
      }
      throw error;
    }
  }
}

function resolveConfig() {
  const retentionDays = parsePositiveInt(
    process.env.UK_AQ_SUPABASE_DB_DUMP_RETENTION_DAYS,
    DEFAULT_RETENTION_DAYS,
  );
  const dropboxRoot = requiredEnv("UK_AQ_DROPBOX_ROOT");
  const backupDir = String(process.env.UK_AQ_SUPABASE_DB_DUMP_BACKUP_DIR || DEFAULT_BACKUP_DIR).trim()
    || DEFAULT_BACKUP_DIR;

  return {
    bashBin: String(process.env.BASH_BIN || "bash").trim() || "bash",
    gzipBin: String(process.env.GZIP_BIN || "gzip").trim() || "gzip",
    supabaseBin: String(process.env.SUPABASE_BIN || "supabase").trim() || "supabase",
    retentionDays,
    dropboxRoot,
    backupDir,
    dropboxBackupRoot: buildBackupRoot(dropboxRoot, backupDir),
    databases: {
      ingestdb: {
        name: "ingestdb",
        dbUrl: requiredEnv("UK_AQ_INGESTDB_DB_URL"),
      },
      obs_aqidb: {
        name: "obs_aqidb",
        dbUrl: requiredEnv("UK_AQ_OBS_AQIDB_DB_URL"),
      },
    },
    dropbox: {
      appKey: requiredEnv("DROPBOX_APP_KEY"),
      appSecret: requiredEnv("DROPBOX_APP_SECRET"),
      refreshToken: requiredEnv("DROPBOX_REFRESH_TOKEN"),
    },
  };
}

async function runSingleDump({
  config,
  runId,
  databaseName,
  dumpKind,
  workingDir,
  dbUrl,
  dropboxClient,
  runDate,
}) {
  const rawFilePath = path.join(workingDir, `${dumpKind}.sql`);
  const scriptPath = path.join(workingDir, `${dumpKind}.sh`);
  const dropboxFolder = buildDatabaseBackupFolder(
    config.dropboxRoot,
    config.backupDir,
    databaseName,
    runDate,
  );
  const dropboxPath = `${dropboxFolder}/${dumpKind}.sql.gz`;

  logStructured("INFO", "supabase_db_dump_step_started", {
    run_id: runId,
    database: databaseName,
    dump_kind: dumpKind,
  });

  const dryRunResult = await spawnAndCapture(
    config.supabaseBin,
    buildDumpArgs({ dbUrl, outputFile: rawFilePath, dumpKind }),
  );
  if (dryRunResult.code !== 0) {
    throw new Error(
      `supabase db dump dry-run failed for ${databaseName}/${dumpKind} (${dryRunResult.code}): ${sanitizeErrorMessage(dryRunResult.stderr || dryRunResult.stdout)}`,
    );
  }

  const scriptText = extractDryRunScript(dryRunResult.stdout);
  await executeDumpScriptToFile({
    bashBin: config.bashBin,
    scriptText,
    scriptPath,
    outputFile: rawFilePath,
  });

  const rawStats = await fs.stat(rawFilePath);
  const gzFilePath = await gzipFile(config.gzipBin, rawFilePath);
  const gzStats = await fs.stat(gzFilePath);

  logStructured("INFO", "supabase_db_dump_step_finished", {
    run_id: runId,
    database: databaseName,
    dump_kind: dumpKind,
    raw_bytes: rawStats.size,
    gzip_bytes: gzStats.size,
  });

  await dropboxClient.uploadFile(gzFilePath, dropboxPath);

  logStructured("INFO", "supabase_db_dump_dropbox_upload_finished", {
    run_id: runId,
    database: databaseName,
    dump_kind: dumpKind,
    gzip_bytes: gzStats.size,
    dropbox_path: dropboxPath,
  });

  return {
    dump_kind: dumpKind,
    file_name: `${dumpKind}.sql.gz`,
    raw_bytes: rawStats.size,
    gzip_bytes: gzStats.size,
    dropbox_path: dropboxPath,
  };
}

async function applyDropboxRetention({ config, dropboxClient, databaseName, runDate, runId }) {
  const databaseRoot = joinDropboxPath(config.dropboxBackupRoot, databaseName);
  const oldestKeptDate = resolveOldestKeptDate(runDate, config.retentionDays);
  const entries = await dropboxClient.listFolderEntries(databaseRoot);
  const { deletes, keeps } = planRetentionDeletes(entries, oldestKeptDate);
  const deletedPaths = [];

  for (const entry of deletes) {
    const targetPath = entry.path_display || entry.path_lower;
    if (!targetPath) {
      continue;
    }
    await dropboxClient.deletePath(targetPath);
    deletedPaths.push(targetPath);
    logStructured("INFO", "supabase_db_dump_retention_deleted", {
      run_id: runId,
      database: databaseName,
      dropbox_path: targetPath,
    });
  }

  return {
    root: databaseRoot,
    retention_days: config.retentionDays,
    oldest_kept_date: oldestKeptDate,
    deleted_paths: deletedPaths,
    kept_dates: keeps.map((entry) => entry.name),
    scanned_entries: entries.length,
  };
}

async function runDatabaseBackup({
  config,
  dropboxClient,
  databaseName,
  runId,
  runDate,
  tempRoot,
}) {
  const databaseConfig = config.databases[databaseName];
  if (!databaseConfig) {
    throw new Error(`Missing database config for ${databaseName}`);
  }

  const startedAt = nowIso();
  const workingDir = await fs.mkdtemp(path.join(tempRoot, `${databaseName}-`));
  const result = {
    database: databaseName,
    ok: false,
    started_at: startedAt,
    finished_at: null,
    dumps: [],
    retention: null,
    error: null,
  };

  logStructured("INFO", "supabase_db_backup_database_started", {
    run_id: runId,
    database: databaseName,
    started_at: startedAt,
  });

  try {
    for (const dumpKind of DEFAULT_DUMP_KINDS) {
      const dumpResult = await runSingleDump({
        config,
        runId,
        databaseName,
        dumpKind,
        workingDir,
        dbUrl: databaseConfig.dbUrl,
        dropboxClient,
        runDate,
      });
      result.dumps.push(dumpResult);
    }

    result.retention = await applyDropboxRetention({
      config,
      dropboxClient,
      databaseName,
      runDate,
      runId,
    });
    result.ok = true;
    return result;
  } catch (error) {
    result.error = sanitizeErrorMessage(error);
    logStructured("ERROR", "supabase_db_backup_database_failed", {
      run_id: runId,
      database: databaseName,
      error: result.error,
    });
    return result;
  } finally {
    result.finished_at = nowIso();
    await fs.rm(workingDir, { recursive: true, force: true });
    logStructured(
      result.ok ? "INFO" : "ERROR",
      "supabase_db_backup_database_finished",
      {
        run_id: runId,
        database: databaseName,
        ok: result.ok,
        dump_count: result.dumps.length,
        finished_at: result.finished_at,
      },
    );
  }
}

export async function runBackupWorkflow({
  triggerMode = "manual",
  requestedDatabases = null,
}) {
  const startedAt = nowIso();
  const runId = randomUUID();
  const config = resolveConfig();
  const runDate = formatUtcDate(startedAt);
  const databases = resolveRequestedDatabases(triggerMode, requestedDatabases);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "uk-aq-supabase-db-dump-"));
  const dropboxClient = new DropboxClient(config.dropbox);

  const report = {
    ok: false,
    service: SERVICE_NAME,
    run_id: runId,
    trigger_mode: triggerMode,
    requested_databases: databases,
    started_at: startedAt,
    finished_at: null,
    retention_days: config.retentionDays,
    dropbox_backup_root: config.dropboxBackupRoot,
    databases: [],
    error: null,
  };

  logStructured("INFO", "supabase_db_backup_run_started", {
    run_id: runId,
    trigger_mode: triggerMode,
    databases,
    started_at: startedAt,
  });

  try {
    for (const databaseName of databases) {
      const databaseResult = await runDatabaseBackup({
        config,
        dropboxClient,
        databaseName,
        runId,
        runDate,
        tempRoot,
      });
      report.databases.push(databaseResult);
    }

    report.ok = report.databases.every((entry) => entry.ok);
    if (!report.ok) {
      report.error = "One or more database backups failed.";
    }
    return report;
  } catch (error) {
    report.ok = false;
    report.error = sanitizeErrorMessage(error);
    logStructured("ERROR", "supabase_db_backup_run_failed", {
      run_id: runId,
      error: report.error,
    });
    return report;
  } finally {
    report.finished_at = nowIso();
    await fs.rm(tempRoot, { recursive: true, force: true });
    logStructured(
      report.ok ? "INFO" : "ERROR",
      "supabase_db_backup_run_finished",
      {
        run_id: runId,
        ok: report.ok,
        finished_at: report.finished_at,
        database_results: report.databases.map((entry) => ({
          database: entry.database,
          ok: entry.ok,
          dump_count: entry.dumps.length,
        })),
      },
    );
  }
}
