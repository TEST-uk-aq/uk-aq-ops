#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const DOMAIN_NAMES = Object.freeze(["observations", "aqilevels", "core"]);

function normalizePrefix(rawPrefix) {
  return String(rawPrefix || "").trim().replace(/^\/+|\/+$/g, "");
}

const DEFAULT_DOMAIN_PREFIXES = Object.freeze({
  observations: normalizePrefix(process.env.UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX || "history/v1/observations"),
  aqilevels: normalizePrefix(process.env.UK_AQ_R2_HISTORY_AQILEVELS_PREFIX || "history/v1/aqilevels"),
  core: normalizePrefix(process.env.UK_AQ_R2_HISTORY_CORE_PREFIX || "history/v1/core"),
});

const DEFAULT_RCLONE_BIN =
  String(process.env.UK_AQ_R2_HISTORY_BACKUP_RCLONE_BIN || "").trim()
  || "rclone";

const DEFAULT_REPORT_OUT = String(process.env.UK_AQ_R2_HISTORY_BACKUP_REPORT_OUT || "").trim();

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/backup_r2/restore_history_from_dropbox.mjs \\",
      "    --source-root <rclone-dropbox-root> \\",
      "    --dest-root <rclone-r2-root> [options]",
      "",
      "Required:",
      "  --source-root   Example: uk_aq_dropbox:CIC-Test/R2_history_backup",
      "  --dest-root     Example: uk_aq_r2:uk-aq-history-cic-test",
      "",
      "Optional:",
      "  --domain <name>              observations | aqilevels | core (repeatable; default all)",
      "  --day-utc <YYYY-MM-DD>       Restore only one day folder under selected domains",
      "  --rclone-bin <name>          Default: rclone",
      "  --report-out <file>          Write JSON report to file",
      "  --dry-run                    Validate/calculate only; no writes",
      "  -h, --help",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = {
    source_root: "",
    dest_root: "",
    domains: [],
    day_utc: "",
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
    if (arg === "--domain") {
      const domain = String(argv[i + 1] || "").trim();
      if (!DOMAIN_NAMES.includes(domain)) {
        throw new Error(`Invalid --domain value: ${domain}`);
      }
      args.domains.push(domain);
      i += 1;
      continue;
    }
    if (arg === "--day-utc") {
      args.day_utc = String(argv[i + 1] || "").trim();
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

  if (!args.domains.length) {
    args.domains = [...DOMAIN_NAMES];
  } else {
    args.domains = Array.from(new Set(args.domains));
  }

  if (args.day_utc && !/^\d{4}-\d{2}-\d{2}$/.test(args.day_utc)) {
    throw new Error("--day-utc must be in YYYY-MM-DD format");
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

function writeReport(reportOutPath, payload) {
  if (!reportOutPath) {
    return;
  }
  const outputPath = path.resolve(reportOutPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
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

function rclonePathExists(rcloneBin, targetPath) {
  const result = runRclone(
    rcloneBin,
    ["lsf", targetPath, "--max-depth", "1"],
    { allow_failure: true },
  );
  if (result.status === 0) {
    return true;
  }
  const combined = `${result.stderr}\n${result.stdout}`;
  if (isRcloneNotFoundMessage(combined)) {
    return false;
  }
  throw new Error(
    [
      `Failed to test source path with rclone lsf: ${targetPath}`,
      combined.trim(),
    ].filter(Boolean).join("\n"),
  );
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

function validateManifestDay(manifest, dayUtc, manifestPath) {
  const manifestDay = typeof manifest.day_utc === "string" ? manifest.day_utc.trim() : "";
  if (manifestDay && manifestDay !== dayUtc) {
    throw new Error(
      `Manifest day mismatch for ${manifestPath}: expected ${dayUtc}, found ${manifestDay}`,
    );
  }
}

function copyPath(rcloneBin, sourcePath, destPath, dryRun) {
  const args = [
    "copy",
    sourcePath,
    destPath,
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
  const report = {
    ok: true,
    started_at: startedAt,
    completed_at: null,
    source_root: args.source_root,
    dest_root: args.dest_root,
    dry_run: args.dry_run,
    day_utc: args.day_utc || null,
    domains: {},
    totals: {
      selected_domains: args.domains.length,
      copied_domains: 0,
      skipped_missing_source: 0,
      failed_domains: 0,
    },
  };

  for (const domain of args.domains) {
    const domainPrefix = DEFAULT_DOMAIN_PREFIXES[domain];
    if (!domainPrefix) {
      throw new Error(`No configured prefix for domain: ${domain}`);
    }

    const summary = {
      prefix: domainPrefix,
      source_path: "",
      dest_path: "",
      copied: false,
      skipped_missing_source: false,
      failure: null,
    };

    try {
      if (args.day_utc) {
        const relativeDayPath = `${domainPrefix}/day_utc=${args.day_utc}`;
        const sourceDayPath = joinTargetPath(args.source_root, relativeDayPath);
        const destDayPath = joinTargetPath(args.dest_root, relativeDayPath);
        summary.source_path = sourceDayPath;
        summary.dest_path = destDayPath;

        const sourceManifestPath = joinTargetPath(sourceDayPath, "manifest.json");
        const sourceManifest = rcloneCatMaybe(args.rclone_bin, sourceManifestPath);
        if (!sourceManifest.found) {
          summary.skipped_missing_source = true;
          report.totals.skipped_missing_source += 1;
          report.domains[domain] = summary;
          continue;
        }

        const manifest = parseManifestOrThrow(sourceManifest.text, sourceManifestPath);
        validateManifestDay(manifest, args.day_utc, sourceManifestPath);
        const sourceManifestHash = sha256Hex(sourceManifest.text);

        copyPath(args.rclone_bin, sourceDayPath, destDayPath, args.dry_run);

        if (!args.dry_run) {
          const destManifestPath = joinTargetPath(destDayPath, "manifest.json");
          const destManifest = rcloneCatMaybe(args.rclone_bin, destManifestPath);
          if (!destManifest.found) {
            throw new Error(`Destination manifest missing after copy: ${destManifestPath}`);
          }
          const destManifestHash = sha256Hex(destManifest.text);
          if (destManifestHash !== sourceManifestHash) {
            throw new Error(`Destination manifest hash mismatch for ${destManifestPath}`);
          }
        }
      } else {
        const sourceDomainPath = joinTargetPath(args.source_root, domainPrefix);
        const destDomainPath = joinTargetPath(args.dest_root, domainPrefix);
        summary.source_path = sourceDomainPath;
        summary.dest_path = destDomainPath;

        if (!rclonePathExists(args.rclone_bin, sourceDomainPath)) {
          summary.skipped_missing_source = true;
          report.totals.skipped_missing_source += 1;
          report.domains[domain] = summary;
          continue;
        }

        copyPath(args.rclone_bin, sourceDomainPath, destDomainPath, args.dry_run);
      }

      summary.copied = true;
      report.totals.copied_domains += 1;
    } catch (error) {
      summary.failure = error instanceof Error ? error.message : String(error);
      report.totals.failed_domains += 1;
      report.ok = false;
    }

    report.domains[domain] = summary;
  }

  report.completed_at = new Date().toISOString();
  writeReport(args.report_out, report);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    process.exit(1);
  }
}

let reportOutPath = DEFAULT_REPORT_OUT;

try {
  const parsed = parseArgs(process.argv.slice(2));
  reportOutPath = parsed.report_out || reportOutPath;
  await main(parsed);
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
