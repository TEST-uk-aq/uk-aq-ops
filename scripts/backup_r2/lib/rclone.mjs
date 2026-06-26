// Shared rclone + path + hash helpers used by build_backup_inventory.mjs and
// sync_history_to_dropbox.mjs. Single source of truth for rclone invocation
// shape, "not found" detection, lsjson parsing, and the temp-file-then-copyto
// upload pattern.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

export function normalizePrefix(rawPrefix) {
  return String(rawPrefix || "").trim().replace(/^\/+|\/+$/g, "");
}

export function isRemotePath(targetPath) {
  return /^[A-Za-z0-9_.-]+:/.test(targetPath);
}

export function joinTargetPath(basePath, relativePath) {
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

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function runRclone(rcloneBin, rcloneArgs, options = {}) {
  const result = spawnSync(rcloneBin, rcloneArgs, {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 256 * 1024 * 1024,
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
        `rclone ${rcloneArgs.join(" ")} failed (exit ${status})`,
        stderr.trim(),
        stdout.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return { status, stdout, stderr };
}

function sleepMs(delayMs) {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  const bounded = Math.trunc(delayMs);
  const int32Max = 2_147_483_647;
  const duration = Math.min(bounded, int32Max);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, duration);
}

function defaultRetryMatcher(error) {
  return false;
}

export function runRcloneWithRetry(rcloneBin, rcloneArgs, options = {}) {
  const maxAttempts = Number.isFinite(Number(options.max_attempts))
    ? Math.max(1, Math.trunc(Number(options.max_attempts)))
    : 1;
  const initialDelayMs = Number.isFinite(Number(options.initial_delay_ms))
    ? Math.max(0, Math.trunc(Number(options.initial_delay_ms)))
    : 0;
  const maxDelayMs = Number.isFinite(Number(options.max_delay_ms))
    ? Math.max(0, Math.trunc(Number(options.max_delay_ms)))
    : initialDelayMs;
  const backoffMultiplier = Number.isFinite(Number(options.backoff_multiplier))
    ? Math.max(1, Number(options.backoff_multiplier))
    : 2;
  const shouldRetry = typeof options.should_retry === "function"
    ? options.should_retry
    : defaultRetryMatcher;
  const onRetry = typeof options.on_retry === "function"
    ? options.on_retry
    : null;
  const onRetryExhausted = typeof options.on_retry_exhausted === "function"
    ? options.on_retry_exhausted
    : null;

  let attempt = 1;
  let delayMs = initialDelayMs;
  while (attempt <= maxAttempts) {
    try {
      return runRclone(rcloneBin, rcloneArgs, options);
    } catch (error) {
      const matchedRetryableError = shouldRetry(error);
      if (!matchedRetryableError || attempt >= maxAttempts) {
        if (matchedRetryableError && onRetryExhausted) {
          try {
            onRetryExhausted({
              attempt,
              max_attempts: maxAttempts,
              args: [...rcloneArgs],
              error,
            });
          } catch {
            // Never mask the original rclone error because a callback throws.
          }
        }
        throw error;
      }

      if (onRetry) {
        try {
          onRetry({
            attempt,
            max_attempts: maxAttempts,
            delay_ms: delayMs,
            args: [...rcloneArgs],
            error,
          });
        } catch {
          // Never fail the retry path because a logger callback throws.
        }
      }

      sleepMs(delayMs);
      delayMs = Math.min(maxDelayMs, Math.max(delayMs + 1, Math.trunc(delayMs * backoffMultiplier)));
      attempt += 1;
    }
  }
  throw new Error("unreachable");
}

export function isRcloneNotFoundMessage(text) {
  const normalized = String(text || "").toLowerCase();
  return (
    normalized.includes("not found")
    || normalized.includes("directory not found")
    || normalized.includes("object not found")
    || normalized.includes("failed to lstat")
    || normalized.includes("doesn't exist")
    || normalized.includes("no such file or directory")
  );
}

export function rcloneCatMaybe(rcloneBin, targetPath, retryOptions = null) {
  const args = ["cat", targetPath];
  let result;
  try {
    result = retryOptions
      ? runRcloneWithRetry(rcloneBin, args, retryOptions)
      : runRclone(rcloneBin, args, { allow_failure: true });
  } catch (error) {
    const combined = error instanceof Error ? error.message : String(error);
    if (isRcloneNotFoundMessage(combined)) {
      return { found: false, text: "" };
    }
    throw new Error(
      [`Failed to read path with rclone cat: ${targetPath}`, combined.trim()]
        .filter(Boolean)
        .join("\n"),
      { cause: error },
    );
  }
  if (result.status === 0) {
    return { found: true, text: result.stdout };
  }
  const combined = `${result.stderr}\n${result.stdout}`;
  if (isRcloneNotFoundMessage(combined)) {
    return { found: false, text: "" };
  }
  throw new Error(
    [`Failed to read path with rclone cat: ${targetPath}`, combined.trim()]
      .filter(Boolean)
      .join("\n"),
  );
}

export function rcloneCat(rcloneBin, targetPath, retryOptions = null) {
  const result = rcloneCatMaybe(rcloneBin, targetPath, retryOptions);
  if (!result.found) {
    throw new Error(`rclone cat: object not found: ${targetPath}`);
  }
  return result.text;
}

export function rcloneDeleteFile(rcloneBin, targetPath, retryOptions = null) {
  const args = ["deletefile", targetPath];
  if (retryOptions) {
    return runRcloneWithRetry(rcloneBin, args, retryOptions);
  }
  return runRclone(rcloneBin, args);
}

// Recursive lsjson for files under a remote path. Returns [] if the path does
// not exist; throws on any other rclone error.
//
// `--hash --hash-type MD5` is included by default. For Cloudflare R2 (and other
// S3-compatible backends), rclone only populates `Hashes.md5` in the lsjson
// output when these flags are set — without them the etag is hidden, and any
// caller relying on it for change detection silently falls back to ModTime.
// Pass `{ hash: false }` to opt out (rare; useful only when the caller doesn't
// need the hash and wants a marginally cheaper LIST).
//
// `maxDepth` (optional positive integer) caps the recursion depth so we don't
// enumerate sibling objects we'll filter out anyway. Day manifests live at
// depth 2 (`day_utc=*/manifest.json`); timeseries-tree per-unit manifests
// live at depth 3 (`day_utc=*/connector_id=*/manifest.json`). Without this,
// recursing into `history/v1/observations/` walks every parquet part inside
// each connector folder — thousands of extra LIST entries that cost minutes
// of GH-runner time per scan.
export function rcloneLsjsonRecursive(
  rcloneBin,
  targetPath,
  { hash = true, maxDepth = 0, retryOptions = null } = {},
) {
  const args = ["lsjson", targetPath, "--recursive", "--files-only"];
  if (hash) args.push("--hash", "--hash-type", "MD5");
  if (Number.isFinite(maxDepth) && maxDepth > 0) {
    args.push("--max-depth", String(Math.trunc(maxDepth)));
  }
  let result;
  try {
    result = retryOptions
      ? runRcloneWithRetry(rcloneBin, args, retryOptions)
      : runRclone(rcloneBin, args, { allow_failure: true });
  } catch (error) {
    const combined = error instanceof Error ? error.message : String(error);
    if (isRcloneNotFoundMessage(combined)) {
      return [];
    }
    throw new Error(
      [`rclone lsjson recursive failed: ${targetPath}`, combined.trim()]
        .filter(Boolean)
        .join("\n"),
      { cause: error },
    );
  }
  if (result.status !== 0) {
    const combined = `${result.stderr}\n${result.stdout}`;
    if (isRcloneNotFoundMessage(combined)) {
      return [];
    }
    throw new Error(
      [`rclone lsjson recursive failed: ${targetPath}`, combined.trim()]
        .filter(Boolean)
        .join("\n"),
    );
  }
  try {
    const parsed = JSON.parse(result.stdout || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    throw new Error(
      `Failed to parse rclone lsjson output for ${targetPath}: ${err?.message || err}`,
    );
  }
}

// Non-recursive lsjson for a single file (or its parent directory). Returns
// the matching entry by file name, or null if the file is not present.
//
// `--hash --hash-type MD5` is included by default for the same reason as
// `rcloneLsjsonRecursive` — see that function's comment.
export function rcloneLsjsonFile(
  rcloneBin,
  parentPath,
  fileName,
  { hash = true, retryOptions = null } = {},
) {
  const args = ["lsjson", parentPath, "--files-only", "--max-depth", "1"];
  if (hash) args.push("--hash", "--hash-type", "MD5");
  let result;
  try {
    result = retryOptions
      ? runRcloneWithRetry(rcloneBin, args, retryOptions)
      : runRclone(rcloneBin, args, { allow_failure: true });
  } catch (error) {
    const combined = error instanceof Error ? error.message : String(error);
    if (isRcloneNotFoundMessage(combined)) {
      return null;
    }
    throw new Error(
      [`rclone lsjson failed: ${parentPath}`, combined.trim()]
        .filter(Boolean)
        .join("\n"),
      { cause: error },
    );
  }
  if (result.status !== 0) {
    const combined = `${result.stderr}\n${result.stdout}`;
    if (isRcloneNotFoundMessage(combined)) {
      return null;
    }
    throw new Error(
      [`rclone lsjson failed: ${parentPath}`, combined.trim()]
        .filter(Boolean)
        .join("\n"),
    );
  }
  let entries;
  try {
    entries = JSON.parse(result.stdout || "[]");
  } catch (err) {
    throw new Error(
      `Failed to parse rclone lsjson output for ${parentPath}: ${err?.message || err}`,
    );
  }
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    if (entry && String(entry.Name || "") === fileName) {
      return entry;
    }
  }
  return null;
}

// Write `content` to a temp file, then `rclone copyto` it to `remoteTargetPath`.
// Used for both inventory and checkpoint uploads.
export function uploadFromTempFile(
  rcloneBin,
  remoteTargetPath,
  content,
  tempPrefix = "uk_aq_r2_upload_",
  retryOptions = null,
) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), tempPrefix));
  const tempFile = path.join(tempDir, "upload.tmp");
  try {
    fs.writeFileSync(tempFile, content, "utf8");
    if (retryOptions) {
      runRcloneWithRetry(rcloneBin, ["copyto", tempFile, remoteTargetPath], retryOptions);
    } else {
      runRclone(rcloneBin, ["copyto", tempFile, remoteTargetPath]);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
