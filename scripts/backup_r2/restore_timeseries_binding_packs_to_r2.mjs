#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { assertSha256 } from "./lib/hierarchical_backup_v2.mjs";
import {
  isRcloneNotFoundMessage,
  joinTargetPath,
} from "./lib/rclone.mjs";
import {
  restoreTimeseriesBindingPacksToR2,
} from "./lib/timeseries_binding_pack_restore_v1.mjs";

export const NORMAL_TEST_R2_HISTORY_DESTINATION =
  "uk_aq_r2_test:uk-aq-history-cic-test";
export const PHASE4_ISOLATED_TEST_R2_DESTINATION =
  "uk_aq_r2_test:uk-aq-history-cic-test-timeseries-binding-restore-phase4";
export const NORMAL_TEST_DROPBOX_PACK_SOURCE =
  "uk_aq_dropbox:TEST/R2_history_backup";

const DEFAULT_RCLONE_BIN = "rclone";
const DEFAULT_WRITE_CONCURRENCY = 8;

function usage() {
  process.stdout.write([
    "Usage:",
    "  node scripts/backup_r2/restore_timeseries_binding_packs_to_r2.mjs \\",
    "    --source-root uk_aq_dropbox:TEST/R2_history_backup \\",
    "    --dest-root <isolated-test-r2-root> [options]",
    "",
    "Default mode is dry-run: the complete checkpoint, pack generation and",
    "reconstructed source hierarchy are verified without destination writes.",
    "",
    "Options:",
    "  --dry-run                         Explicit non-mutating mode (default)",
    "  --write-r2                        Enable writes after all source validation",
    "  --expected-source-root-sha256 <h> Required generation pin for --write-r2",
    "  --expected-pack-root-sha256 <h>   Required generation pin for --write-r2",
    "  --confirm-isolated-test-dest-root <root>",
    "                                    Must exactly repeat the allowed destination",
    `  --write-concurrency <n>            Default: ${DEFAULT_WRITE_CONCURRENCY}; maximum: 16`,
    `  --rclone-bin <name>                 Default: ${DEFAULT_RCLONE_BIN}`,
    "  --report-out <file>                Write the structured JSON report locally",
    "  -h, --help",
    "",
    "The only Phase 4 write destination allowed by this implementation is:",
    `  ${PHASE4_ISOLATED_TEST_R2_DESTINATION}`,
  ].join("\n") + "\n");
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function assertPhase4RestoreWriteSafety(args) {
  if (!args.writeR2) return;
  if (args.sourceRoot !== NORMAL_TEST_DROPBOX_PACK_SOURCE) {
    throw new Error(
      `Phase 4 writes require the exact normal TEST Dropbox source: ${NORMAL_TEST_DROPBOX_PACK_SOURCE}`,
    );
  }
  if (args.destRoot === NORMAL_TEST_R2_HISTORY_DESTINATION) {
    throw new Error("Refusing Phase 4 restore writes to the normal TEST history bucket");
  }
  if (args.destRoot !== PHASE4_ISOLATED_TEST_R2_DESTINATION) {
    throw new Error(
      `Phase 4 writes require the exact isolated TEST destination: ${PHASE4_ISOLATED_TEST_R2_DESTINATION}`,
    );
  }
  if (args.confirmIsolatedTestDestRoot !== args.destRoot) {
    throw new Error(
      "--confirm-isolated-test-dest-root must exactly repeat --dest-root",
    );
  }
  if (!args.expectedSourceRootSha256 || !args.expectedPackRootSha256) {
    throw new Error(
      "--write-r2 requires both expected source-root and pack-root SHA-256 pins",
    );
  }
}

export function parseTimeseriesBindingPackRestoreArgs(argv) {
  const args = {
    sourceRoot: null,
    destRoot: null,
    writeR2: false,
    dryRunExplicit: false,
    expectedSourceRootSha256: null,
    expectedPackRootSha256: null,
    confirmIsolatedTestDestRoot: null,
    writeConcurrency: DEFAULT_WRITE_CONCURRENCY,
    rcloneBin: DEFAULT_RCLONE_BIN,
    reportOut: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--dry-run") {
      args.dryRunExplicit = true;
    } else if (flag === "--write-r2") {
      args.writeR2 = true;
    } else if (flag === "-h" || flag === "--help") {
      usage();
      return null;
    } else {
      const value = requireValue(argv, index, flag);
      index += 1;
      if (flag === "--source-root") args.sourceRoot = value;
      else if (flag === "--dest-root") args.destRoot = value;
      else if (flag === "--expected-source-root-sha256") {
        args.expectedSourceRootSha256 = assertSha256(
          value,
          "expected source root SHA-256",
        );
      } else if (flag === "--expected-pack-root-sha256") {
        args.expectedPackRootSha256 = assertSha256(
          value,
          "expected pack root SHA-256",
        );
      } else if (flag === "--confirm-isolated-test-dest-root") {
        args.confirmIsolatedTestDestRoot = value;
      } else if (flag === "--write-concurrency") {
        const concurrency = Number(value);
        if (!Number.isSafeInteger(concurrency) || concurrency <= 0 || concurrency > 16) {
          throw new Error("--write-concurrency must be an integer from 1 through 16");
        }
        args.writeConcurrency = concurrency;
      } else if (flag === "--rclone-bin") args.rcloneBin = value;
      else if (flag === "--report-out") args.reportOut = value;
      else throw new Error(`Unknown argument: ${flag}`);
    }
  }
  if (!args.sourceRoot) throw new Error("--source-root is required");
  if (!args.destRoot) throw new Error("--dest-root is required");
  if (args.writeR2 && args.dryRunExplicit) {
    throw new Error("Use either --dry-run or --write-r2, not both");
  }
  assertPhase4RestoreWriteSafety(args);
  return Object.freeze(args);
}

function runRcloneBytes(rcloneBin, rcloneArgs, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(rcloneBin, rcloneArgs, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      if (signal) {
        reject(new Error(`rclone ${rcloneArgs.join(" ")} terminated by ${signal}`));
        return;
      }
      const status = Number(code);
      if (status !== 0 && !allowFailure) {
        reject(new Error(
          [
            `rclone ${rcloneArgs.join(" ")} failed (exit ${status})`,
            stderr.toString("utf8").trim(),
            stdout.toString("utf8").trim(),
          ].filter(Boolean).join("\n"),
        ));
        return;
      }
      resolve({ status, stdout, stderr });
    });
  });
}

async function readRcloneObjectMaybe(rcloneBin, root, relativePath) {
  const target = joinTargetPath(root, relativePath);
  const result = await runRcloneBytes(
    rcloneBin,
    ["cat", target],
    { allowFailure: true },
  );
  if (result.status === 0) return result.stdout;
  const combined = `${result.stderr.toString("utf8")}\n${result.stdout.toString("utf8")}`;
  if (isRcloneNotFoundMessage(combined)) return null;
  throw new Error(`Failed to read ${target}: ${combined.trim()}`);
}

async function writeRcloneObject(rcloneBin, root, relativePath, body) {
  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "uk_aq_timeseries_binding_restore_"),
  );
  const tempFile = path.join(tempDir, "upload.tmp");
  try {
    await fs.promises.writeFile(tempFile, Buffer.from(body));
    await runRcloneBytes(rcloneBin, [
      "copyto",
      tempFile,
      joinTargetPath(root, relativePath),
    ]);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

function writeLocalReport(reportOut, report) {
  if (!reportOut) return;
  const output = path.resolve(reportOut);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

export async function main({ argv = process.argv.slice(2) } = {}) {
  let args = null;
  try {
    args = parseTimeseriesBindingPackRestoreArgs(argv);
    if (!args) return 0;
    const report = await restoreTimeseriesBindingPacksToR2({
      sourceRoot: args.sourceRoot,
      destRoot: args.destRoot,
      dryRun: !args.writeR2,
      writeConcurrency: args.writeConcurrency,
      expectedSourceRootHash: args.expectedSourceRootSha256,
      expectedPackRootSha256: args.expectedPackRootSha256,
      readSourceObject: (relativePath) => readRcloneObjectMaybe(
        args.rcloneBin,
        args.sourceRoot,
        relativePath,
      ),
      writeDestinationObject: args.writeR2
        ? (relativePath, body) => writeRcloneObject(
          args.rcloneBin,
          args.destRoot,
          relativePath,
          body,
        )
        : null,
      readDestinationObject: args.writeR2
        ? (relativePath) => readRcloneObjectMaybe(
          args.rcloneBin,
          args.destRoot,
          relativePath,
        )
        : null,
    });
    writeLocalReport(args.reportOut, report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    const report = error?.restore_report || {
      ok: false,
      mode: args?.writeR2 ? "write-r2" : "dry-run",
      dry_run: args ? !args.writeR2 : true,
      source_root: args?.sourceRoot || null,
      dest_root: args?.destRoot || null,
      failure: error instanceof Error ? error.message : String(error),
    };
    writeLocalReport(args?.reportOut, report);
    process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
    return 1;
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = await main();
}
