// @ts-nocheck -- repository-owned fixed-v3 operator bootstrap.

import fs from "node:fs";
import path from "node:path";

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_LOCAL_ROOT = "/Users/mikehinford/uk-aq-history-integrity";
const DEFAULT_DROPBOX_APP_ROOT = "/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks";

function stripInlineComment(rawValue) {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let output = "";
  let previous = "";
  for (let index = 0; index < rawValue.length; index += 1) {
    const character = rawValue[index];
    if (inSingle) {
      if (character === "'") inSingle = false;
      output += character;
      previous = character;
      continue;
    }
    if (inDouble) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inDouble = false;
      output += character;
      previous = character;
      continue;
    }
    if (character === "'") inSingle = true;
    else if (character === '"') inDouble = true;
    else if (character === "#" && (index === 0 || /\s/.test(previous))) break;
    output += character;
    previous = character;
  }
  return output.trim();
}

export function parseIntegrityEnvAssignments(contents) {
  const parsed = {};
  for (const rawLine of String(contents).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const separator = line.indexOf("=");
    let key = line.slice(0, separator).trim();
    if (key.startsWith("export ")) key = key.slice("export ".length).trim();
    if (!ENV_NAME_PATTERN.test(key)) continue;
    let value = stripInlineComment(line.slice(separator + 1));
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function containsArchiveSegment(candidate) {
  return String(candidate).split(/[\\/]+/).includes("archive") ||
    path.resolve(String(candidate)).split(path.sep).includes("archive");
}

function rejectArchivePath(label, candidate) {
  if (containsArchiveSegment(candidate)) throw new Error(`${label} points to an archive path`);
}

function resolveExistingDirectory(label, candidate) {
  const resolved = path.resolve(String(candidate));
  rejectArchivePath(label, resolved);
  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    throw new Error(`${label} is unavailable: ${resolved}`);
  }
  if (!fs.statSync(real).isDirectory()) throw new Error(`${label} is not a directory: ${real}`);
  rejectArchivePath(`resolved ${label}`, real);
  return real;
}

function requireReadableFile(label, candidate) {
  const resolved = path.resolve(String(candidate));
  try {
    fs.accessSync(resolved, fs.constants.R_OK);
    if (!fs.statSync(resolved).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`${label} is unavailable: ${resolved}`);
  }
  return resolved;
}

function requireExecutableFile(label, candidate) {
  const resolved = path.resolve(String(candidate));
  try {
    fs.accessSync(resolved, fs.constants.X_OK);
    if (!fs.statSync(resolved).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`${label} is unavailable: ${resolved}`);
  }
  return resolved;
}

export function bootstrapObservationVerificationIntegrityV3({
  environment,
  repositoryRoot,
  stateDirOverride = "",
  env = process.env,
}) {
  const selectedEnvironment = String(environment || "").trim().toUpperCase();
  if (selectedEnvironment !== "TEST" && selectedEnvironment !== "LIVE") {
    throw new Error("environment must be TEST or LIVE");
  }
  const repoRoot = resolveExistingDirectory("repository root", repositoryRoot);
  const exportedRepoRoot = String(env.UK_AQ_OPS_REPO_ROOT || "").trim();
  if (exportedRepoRoot) {
    if (!path.isAbsolute(exportedRepoRoot)) {
      throw new Error("UK_AQ_OPS_REPO_ROOT is not an existing absolute directory");
    }
    const resolvedExportedRoot = resolveExistingDirectory("UK_AQ_OPS_REPO_ROOT", exportedRepoRoot);
    if (resolvedExportedRoot !== repoRoot) {
      throw new Error("UK_AQ_OPS_REPO_ROOT points to a different repository");
    }
  }

  const localRootRaw = String(env.UK_AQ_HISTORY_INTEGRITY_LOCAL_ROOT || DEFAULT_LOCAL_ROOT).trim();
  if (!path.isAbsolute(localRootRaw)) {
    throw new Error("UK_AQ_HISTORY_INTEGRITY_LOCAL_ROOT must be absolute");
  }
  rejectArchivePath("UK_AQ_HISTORY_INTEGRITY_LOCAL_ROOT", localRootRaw);
  const localRoot = path.resolve(localRootRaw);

  const rootEnvFile = requireReadableFile("repository root .env", path.join(repoRoot, ".env"));
  Object.assign(env, parseIntegrityEnvAssignments(fs.readFileSync(rootEnvFile, "utf8")));
  const configuredEnvironment = String(env.UKAQ_ENV_NAME || "").trimEnd();
  if (configuredEnvironment !== selectedEnvironment) {
    throw new Error(
      `UKAQ_ENV_NAME in the selected repository root .env does not match --env=${selectedEnvironment}`,
    );
  }

  const pythonPath = requireExecutableFile(
    "repository Python interpreter",
    path.join(repoRoot, ".venv/bin/python"),
  );
  const dropboxAppRoot = String(env.UK_AQ_DROPBOX_APP_ROOT || DEFAULT_DROPBOX_APP_ROOT).trim();
  rejectArchivePath("UK_AQ_DROPBOX_APP_ROOT", dropboxAppRoot);
  const dropboxRootRaw = String(env.UK_AQ_DROPBOX_ROOT || "").trim();
  if (!dropboxRootRaw) throw new Error(`UK_AQ_DROPBOX_ROOT is missing from ${rootEnvFile}`);
  rejectArchivePath("UK_AQ_DROPBOX_ROOT", dropboxRootRaw);
  const dropboxRoot = resolveExistingDirectory(
    "Dropbox environment root",
    path.isAbsolute(dropboxRootRaw)
      ? dropboxRootRaw
      : path.join(dropboxAppRoot, dropboxRootRaw.replace(/^[/\\]+/, "")),
  );

  const explicitR2Root = String(env.UK_AQ_R2_HISTORY_DROPBOX_ROOT || "").trim();
  let r2RootRaw;
  if (explicitR2Root) {
    if (!path.isAbsolute(explicitR2Root)) {
      throw new Error("UK_AQ_R2_HISTORY_DROPBOX_ROOT must be absolute when configured");
    }
    r2RootRaw = explicitR2Root;
  } else {
    const r2Directory = String(env.UK_AQ_R2_HISTORY_DROPBOX_DIR || "R2_history_backup").trim();
    rejectArchivePath("UK_AQ_R2_HISTORY_DROPBOX_DIR", r2Directory);
    r2RootRaw = path.isAbsolute(r2Directory) ? r2Directory : path.join(dropboxRoot, r2Directory);
  }
  const r2Root = resolveExistingDirectory("R2 history Dropbox root", r2RootRaw);
  const stateDir = stateDirOverride
    ? path.resolve(stateDirOverride)
    : path.join(localRoot, "state", selectedEnvironment);
  rejectArchivePath("UK_AQ_HISTORY_INTEGRITY_STATE_DIR", stateDir);

  Object.assign(env, {
    UK_AQ_ENV_NAME: selectedEnvironment,
    UK_AQ_OPS_REPO_ROOT: repoRoot,
    UK_AQ_HISTORY_INTEGRITY_LOCAL_ROOT: localRoot,
    UK_AQ_HISTORY_INTEGRITY_ROOT: path.join(repoRoot, "scripts/uk-aq-history-integrity"),
    UK_AQ_BACKFILL_ENV_FILE: rootEnvFile,
    UK_AQ_HISTORY_INTEGRITY_PYTHON: pythonPath,
    UK_AQ_R2_HISTORY_VERSION: "v3",
    UK_AQ_R2_HISTORY_INDEX_VERSION: "v3",
    UK_AQ_R2_HISTORY_INTEGRITY_VERSION: "v3",
    UK_AQ_HISTORY_INTEGRITY_STATE_DIR: stateDir,
    UK_AQ_HISTORY_INTEGRITY_DB_PATH: path.join(stateDir, "uk_aq_history_integrity.sqlite"),
    UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR: path.join(stateDir, "source-cache"),
    UK_AQ_HISTORY_INTEGRITY_TMP_DIR: path.join(stateDir, "tmp"),
    UK_AQ_HISTORY_INTEGRITY_LOCK_DIR: path.join(stateDir, "locks"),
    UK_AQ_HISTORY_INTEGRITY_LOG_DIR: path.join(dropboxRoot, "uk-aq-history-integrity/logs"),
    UK_AQ_HISTORY_INTEGRITY_REPORT_DIR: path.join(dropboxRoot, "uk-aq-history-integrity/reports"),
    UK_AQ_HISTORY_INTEGRITY_DROPBOX_DB_COPY_PATH: path.join(
      dropboxRoot,
      "uk-aq-history-integrity/uk_aq_history_integrity.sqlite",
    ),
    UK_AQ_R2_HISTORY_DROPBOX_ROOT: r2Root,
    UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT: path.join(r2Root, "history/v3/core"),
    UK_AQ_HISTORY_INTEGRITY_BACKFILL_WRAPPER: path.join(
      repoRoot,
      "scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill_v3.sh",
    ),
  });

  return Object.freeze({
    repositoryRoot: repoRoot,
    rootEnvFile,
    localRoot,
    stateDir,
    pythonPath,
    dropboxRoot,
    r2Root,
    runtimeDirectories: Object.freeze([
      stateDir,
      env.UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR,
      env.UK_AQ_HISTORY_INTEGRITY_TMP_DIR,
      env.UK_AQ_HISTORY_INTEGRITY_LOCK_DIR,
      env.UK_AQ_HISTORY_INTEGRITY_LOG_DIR,
      env.UK_AQ_HISTORY_INTEGRITY_REPORT_DIR,
    ]),
  });
}

export function ensureObservationVerificationRuntimeDirectories(bootstrap) {
  for (const directory of bootstrap.runtimeDirectories) {
    fs.mkdirSync(directory, { recursive: true });
    try {
      fs.accessSync(directory, fs.constants.W_OK);
    } catch {
      throw new Error(`required runtime directory is unavailable or not writable: ${directory}`);
    }
  }
}
