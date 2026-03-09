#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const DOMAIN_NAMES = Object.freeze(["observations", "aqilevels"]);

function parseNonNegativeInt(rawValue, fallback) {
  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  const intValue = Math.trunc(value);
  if (intValue < 0) {
    return fallback;
  }
  return intValue;
}

function normalizePrefix(rawPrefix) {
  return String(rawPrefix || "").trim().replace(/^\/+|\/+$/g, "");
}

const DEFAULT_DOMAIN_PREFIXES = Object.freeze({
  observations: normalizePrefix(process.env.UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX || "history/v1/observations"),
  aqilevels: normalizePrefix(process.env.UK_AQ_R2_HISTORY_AQILEVELS_PREFIX || "history/v1/aqilevels"),
});

const DEFAULT_STATE_REL_PATH =
  String(process.env.UK_AQ_R2_HISTORY_BACKUP_STATE_REL_PATH || "").trim()
  || "_ops/checkpoints/r2_history_backup_state_v1.json";
const DEFAULT_MAX_DAYS_PER_RUN = parseNonNegativeInt(
  process.env.UK_AQ_R2_HISTORY_BACKUP_MAX_DAYS_PER_RUN,
  0,
);
const DEFAULT_RCLONE_BIN =
  String(process.env.UK_AQ_R2_HISTORY_BACKUP_RCLONE_BIN || "").trim()
  || "rclone";
const DEFAULT_REPORT_OUT = String(process.env.UK_AQ_R2_HISTORY_BACKUP_REPORT_OUT || "").trim();

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/backup_r2/sync_history_to_dropbox.mjs \\",
      "    --source-root <rclone-source-root> \\",
      "    --dest-root <rclone-destination-root> [options]",
      "",
      "Required:",
      "  --source-root   Example: uk_aq_r2:uk-aq-backup-cic-test",
      "  --dest-root     Example: uk_aq_dropbox:/CIC-Test/R2_history_backup",
      "",
      "Optional:",
      "  --state-rel-path <path>      Default: _ops/checkpoints/r2_history_backup_state_v1.json",
      "  --domain <name>              observations | aqilevels (repeatable)",
      "  --max-days-per-run <N>       0 = unlimited (default 0)",
      "  --rclone-bin <name>          Default: rclone",
      "  --report-out <file>          Write JSON report to file",
      "  --dry-run                    Compute/validate only, no copy and no checkpoint writes",
      "  -h, --help",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = {
    source_root: "",
    dest_root: "",
    state_rel_path: DEFAULT_STATE_REL_PATH,
    domains: [],
    max_days_per_run: DEFAULT_MAX_DAYS_PER_RUN,
    rclone_bin: DEFAULT_RCLONE_BIN,
    dry_run: false,
    report_out: DEFAULT_REPORT_OUT,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source-root") {
      args.source_root = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--dest-root") {
      args.dest_root = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--state-rel-path") {
      args.state_rel_path = String(argv[i + 1] || "").trim() || DEFAULT_STATE_REL_PATH;
      i += 1;
      continue;
    }
    if (arg === "--domain") {
      const domain = String(argv[i + 1] || "").trim();
      if (!DOMAIN_NAMES.includes(domain)) {
        throw new Error(`Invalid --domain value: ${domain}`);
      }
      args.domains.push(domain);
      i += 1;
      continue;
    }
    if (arg === "--max-days-per-run") {
      const raw = String(argv[i + 1] || "").trim();
      const parsed = parseNonNegativeInt(raw, Number.NaN);
      if (!Number.isFinite(parsed)) {
        throw new Error("--max-days-per-run must be a non-negative integer");
      }
      args.max_days_per_run = parsed;
      i += 1;
      continue;
    }
    if (arg === "--rclone-bin") {
      args.rclone_bin = String(argv[i + 1] || "").trim() || DEFAULT_RCLONE_BIN;
      i += 1;
      continue;
    }
    if (arg === "--report-out") {
      args.report_out = String(argv[i + 1] || "").trim();
      i += 1;
      continue;
    }
    if (arg === "--dry-run") {
      args.dry_run = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  if (!args.source_root) {
    throw new Error("--source-root is required");
  }
  if (!args.dest_root) {
    throw new Error("--dest-root is required");
  }
  if (!args.state_rel_path) {
    throw new Error("--state-rel-path cannot be empty");
  }

  if (args.domains.length === 0) {
    args.domains = [...DOMAIN_NAMES];
  } else {
    args.domains = Array.from(new Set(args.domains));
  }

  return args;
}

function isRemotePath(targetPath) {
  return /^[A-Za-z0-9_.-]+:/.test(targetPath);
}

function joinTargetPath(basePath, relativePath) {
  const rel = String(relativePath || "").trim().replace(/^\/+/, "");
  if (isRemotePath(basePath)) {
    const base = String(basePath).replace(/\/+$/, "");
    return rel ? `${base}/${rel}` : base;
  }
  if (!rel) {
    return path.resolve(basePath);
  }
  return path.resolve(basePath, rel);
}

function runRclone(rcloneBin, args, options = {}) {
  const result = spawnSync(rcloneBin, args, {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const status = Number(result.status || 0);

  if (status !== 0 && !options.allow_failure) {
    throw new Error(
      [
        `rclone ${args.join(" ")} failed (exit ${status})`,
        stderr.trim(),
        stdout.trim(),
      ].filter(Boolean).join("\n"),
    );
  }

  return { status, stdout, stderr };
}

function isRcloneNotFoundMessage(text) {
  const normalized = String(text || "").toLowerCase();
  return normalized.includes("not found")
    || normalized.includes("directory not found")
    || normalized.includes("object not found")
    || normalized.includes("failed to lstat")
    || normalized.includes("doesn't exist")
    || normalized.includes("no such file or directory");
}

function rcloneCatMaybe(rcloneBin, targetPath) {
  const result = runRclone(rcloneBin, ["cat", targetPath], { allow_failure: true });
  if (result.status === 0) {
    return {
      found: true,
      text: result.stdout,
    };
  }

  const combined = `${result.stderr}\n${result.stdout}`;
  if (isRcloneNotFoundMessage(combined)) {
    return {
      found: false,
      text: "",
    };
  }

  throw new Error(
    [
      `Failed to read path with rclone cat: ${targetPath}`,
      combined.trim(),
    ].filter(Boolean).join("\n"),
  );
}

function listDayFolders(rcloneBin, sourceDomainPath) {
  const result = runRclone(
    rcloneBin,
    ["lsf", sourceDomainPath, "--dirs-only", "--format", "p", "--max-depth", "1"],
    { allow_failure: true },
  );

  if (result.status !== 0) {
    const combined = `${result.stderr}\n${result.stdout}`;
    if (isRcloneNotFoundMessage(combined)) {
      return [];
    }
    throw new Error(
      [
        `Failed to list source domain path: ${sourceDomainPath}`,
        combined.trim(),
      ].filter(Boolean).join("\n"),
    );
  }

  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const days = [];
  for (const line of lines) {
    const match = line.match(/^day_utc=(\d{4}-\d{2}-\d{2})\/?$/);
    if (!match) {
      continue;
    }
    days.push(match[1]);
  }

  return Array.from(new Set(days)).sort((a, b) => a.localeCompare(b));
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseManifestOrThrow(manifestText, manifestPath) {
  let parsed;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    throw new Error(`Manifest is not valid JSON: ${manifestPath}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Manifest JSON is not an object: ${manifestPath}`);
  }

  return parsed;
}

function emptyDomainState() {
  return {
    days: {},
    last_successful_day_utc: null,
    last_successful_copy_at: null,
  };
}

function emptyCheckpointState(nowIso) {
  return {
    version: 1,
    created_at: nowIso,
    updated_at: nowIso,
    domains: {
      observations: emptyDomainState(),
      aqilevels: emptyDomainState(),
    },
  };
}

function sanitizeCheckpointState(rawState) {
  const nowIso = new Date().toISOString();
  const state = rawState && typeof rawState === "object" && !Array.isArray(rawState)
    ? rawState
    : {};

  const domains = {};
  for (const domain of DOMAIN_NAMES) {
    const rawDomain = state.domains && typeof state.domains === "object"
      ? state.domains[domain]
      : null;
    const dayMap = rawDomain && typeof rawDomain === "object" && rawDomain.days && typeof rawDomain.days === "object"
      ? rawDomain.days
      : {};

    const cleanedDayMap = {};
    for (const [dayUtc, entry] of Object.entries(dayMap)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dayUtc)) {
        continue;
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const manifestKey = String(entry.manifest_key || "").trim();
      const copiedAt = String(entry.copied_at || "").trim();
      const manifestHash = String(entry.manifest_hash || "").trim();
      cleanedDayMap[dayUtc] = {
        manifest_key: manifestKey,
        copied_at: copiedAt,
        manifest_hash: manifestHash,
      };
    }

    domains[domain] = {
      days: cleanedDayMap,
      last_successful_day_utc: rawDomain && typeof rawDomain.last_successful_day_utc === "string"
        ? rawDomain.last_successful_day_utc
        : null,
      last_successful_copy_at: rawDomain && typeof rawDomain.last_successful_copy_at === "string"
        ? rawDomain.last_successful_copy_at
        : null,
    };
  }

  return {
    version: Number.isFinite(Number(state.version)) ? Number(state.version) : 1,
    created_at: typeof state.created_at === "string" && state.created_at ? state.created_at : nowIso,
    updated_at: typeof state.updated_at === "string" && state.updated_at ? state.updated_at : nowIso,
    domains,
  };
}

function loadCheckpointState(rcloneBin, checkpointPath) {
  const nowIso = new Date().toISOString();
  const result = rcloneCatMaybe(rcloneBin, checkpointPath);
  if (!result.found) {
    return {
      state: emptyCheckpointState(nowIso),
      existed: false,
    };
  }

  try {
    return {
      state: sanitizeCheckpointState(JSON.parse(result.text)),
      existed: true,
    };
  } catch {
    throw new Error(`Checkpoint state is not valid JSON: ${checkpointPath}`);
  }
}

function writeCheckpointState(rcloneBin, checkpointPath, state) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "uk_aq_r2_history_backup_state_"));
  const tempFile = path.join(tempDir, "state.json");
  try {
    fs.writeFileSync(tempFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    runRclone(rcloneBin, ["copyto", tempFile, checkpointPath]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeReport(reportOutPath, payload) {
  if (!reportOutPath) {
    return;
  }
  const outputPath = path.resolve(reportOutPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function markDayCopied(state, domain, dayUtc, details) {
  const domainState = state.domains[domain] || emptyDomainState();
  domainState.days[dayUtc] = {
    manifest_key: details.manifest_key,
    copied_at: details.copied_at,
    manifest_hash: details.manifest_hash,
  };
  domainState.last_successful_day_utc = dayUtc;
  domainState.last_successful_copy_at = details.copied_at;
  state.domains[domain] = domainState;
  state.updated_at = details.copied_at;
}

function selectCandidateDays(days, domainState, maxDaysPerRun) {
  const copiedDays = new Set(Object.keys(domainState.days || {}));
  const candidates = days.filter((dayUtc) => !copiedDays.has(dayUtc));
  if (maxDaysPerRun > 0) {
    return candidates.slice(0, maxDaysPerRun);
  }
  return candidates;
}

function validateManifestDay(manifest, dayUtc, manifestPath) {
  const manifestDay = typeof manifest.day_utc === "string" ? manifest.day_utc.trim() : "";
  if (manifestDay && manifestDay !== dayUtc) {
    throw new Error(
      `Manifest day mismatch for ${manifestPath}: expected ${dayUtc}, found ${manifestDay}`,
    );
  }
}

function copyDayFolder(rcloneBin, sourceDayPath, destDayPath, dryRun) {
  const args = [
    "copy",
    sourceDayPath,
    destDayPath,
    "--check-first",
    "--transfers",
    "8",
    "--checkers",
    "16",
    "--fast-list",
  ];
  if (dryRun) {
    args.push("--dry-run");
  }
  runRclone(rcloneBin, args);
}

async function main(args) {
  const startedAt = new Date().toISOString();

  const checkpointPath = joinTargetPath(args.dest_root, args.state_rel_path);
  const checkpointLoaded = loadCheckpointState(args.rclone_bin, checkpointPath);
  const state = checkpointLoaded.state;

  const report = {
    ok: true,
    started_at: startedAt,
    completed_at: null,
    source_root: args.source_root,
    dest_root: args.dest_root,
    state_checkpoint_path: checkpointPath,
    state_existed: checkpointLoaded.existed,
    dry_run: args.dry_run,
    max_days_per_run: args.max_days_per_run,
    domains: {},
    totals: {
      listed_days: 0,
      candidate_days: 0,
      copied_days: 0,
      skipped_existing: 0,
      skipped_incomplete: 0,
    },
  };

  for (const domain of args.domains) {
    const domainPrefix = DEFAULT_DOMAIN_PREFIXES[domain];
    if (!domainPrefix) {
      throw new Error(`No configured R2 prefix for domain: ${domain}`);
    }

    const sourceDomainPath = joinTargetPath(args.source_root, domainPrefix);
    const destDomainPath = joinTargetPath(args.dest_root, domainPrefix);
    const domainState = state.domains[domain] || emptyDomainState();

    const listedDays = listDayFolders(args.rclone_bin, sourceDomainPath);
    const candidateDays = selectCandidateDays(listedDays, domainState, args.max_days_per_run);

    const domainSummary = {
      prefix: domainPrefix,
      listed_days: listedDays.length,
      candidate_days: candidateDays.length,
      copied_days: 0,
      skipped_existing: Math.max(0, listedDays.length - candidateDays.length),
      skipped_incomplete: 0,
      copied_day_list: [],
    };

    for (const dayUtc of candidateDays) {
      const relativeDayPath = `${domainPrefix}/day_utc=${dayUtc}`;
      const sourceDayPath = joinTargetPath(args.source_root, relativeDayPath);
      const destDayPath = joinTargetPath(args.dest_root, relativeDayPath);
      const sourceManifestPath = joinTargetPath(sourceDayPath, "manifest.json");

      const sourceManifest = rcloneCatMaybe(args.rclone_bin, sourceManifestPath);
      if (!sourceManifest.found) {
        domainSummary.skipped_incomplete += 1;
        continue;
      }

      const manifest = parseManifestOrThrow(sourceManifest.text, sourceManifestPath);
      validateManifestDay(manifest, dayUtc, sourceManifestPath);

      const manifestHash = sha256Hex(sourceManifest.text);
      copyDayFolder(args.rclone_bin, sourceDayPath, destDayPath, args.dry_run);

      if (!args.dry_run) {
        const destManifestPath = joinTargetPath(destDayPath, "manifest.json");
        const destManifest = rcloneCatMaybe(args.rclone_bin, destManifestPath);
        if (!destManifest.found) {
          throw new Error(`Destination manifest missing after copy: ${destManifestPath}`);
        }
        const destManifestHash = sha256Hex(destManifest.text);
        if (manifestHash !== destManifestHash) {
          throw new Error(`Destination manifest hash mismatch for ${destManifestPath}`);
        }

        const copiedAt = new Date().toISOString();
        markDayCopied(state, domain, dayUtc, {
          manifest_key: `${relativeDayPath}/manifest.json`,
          copied_at: copiedAt,
          manifest_hash: manifestHash,
        });
        writeCheckpointState(args.rclone_bin, checkpointPath, state);
      }

      domainSummary.copied_days += 1;
      domainSummary.copied_day_list.push(dayUtc);
    }

    report.domains[domain] = domainSummary;
    report.totals.listed_days += domainSummary.listed_days;
    report.totals.candidate_days += domainSummary.candidate_days;
    report.totals.copied_days += domainSummary.copied_days;
    report.totals.skipped_existing += domainSummary.skipped_existing;
    report.totals.skipped_incomplete += domainSummary.skipped_incomplete;

    if (args.dry_run) {
      // No checkpoint write in dry-run mode.
      void destDomainPath;
    }
  }

  report.completed_at = new Date().toISOString();
  writeReport(args.report_out, report);
  console.log(JSON.stringify(report, null, 2));
}

let reportOutPath = DEFAULT_REPORT_OUT;
let parsedArgs = null;

try {
  parsedArgs = parseArgs(process.argv.slice(2));
  reportOutPath = parsedArgs.report_out || reportOutPath;
  await main(parsedArgs);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const payload = {
    ok: false,
    error: message,
  };
  if (reportOutPath) {
    writeReport(reportOutPath, payload);
  }
  console.error(JSON.stringify(payload));
  process.exit(1);
}
