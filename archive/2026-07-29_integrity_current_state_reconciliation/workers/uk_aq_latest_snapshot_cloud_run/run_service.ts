import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  createLatestSnapshotHandler,
  JobTimeoutError,
} from "./service_core.ts";

const PORT = Number(Deno.env.get("PORT") || "8000");
const RUN_JOB_SCRIPT = "/app/workers/uk_aq_latest_snapshot_cloud_run/run_job.ts";
const JOB_TIMEOUT_MS = parsePositiveInt(
  Deno.env.get("UK_AQ_LATEST_SNAPSHOT_JOB_TIMEOUT_MS"),
  240_000,
);
const JOB_KILL_GRACE_MS = 10_000;
const JOB_KILL_WAIT_MS = 5_000;

function parsePositiveInt(raw: string | undefined | null, fallback: number): number {
  const value = Number(raw || "");
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.trunc(value);
}

function logEvent(
  level: "log" | "error",
  event: string,
  fields: Record<string, unknown>,
): void {
  console[level](JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    ...fields,
  }));
}

async function waitForStatus(
  statusPromise: Promise<Deno.CommandStatus>,
  timeoutMs: number,
): Promise<{ timed_out: false; status: Deno.CommandStatus } | { timed_out: true }> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timed_out: true });
    }, timeoutMs);

    statusPromise.then(
      (status) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timed_out: false, status });
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function runJob(triggerMode: string): Promise<Deno.CommandStatus> {
  const startedMs = Date.now();
  const child = new Deno.Command("deno", {
    args: [
      "run",
      "--allow-env",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      RUN_JOB_SCRIPT,
    ],
    env: {
      ...Deno.env.toObject(),
      UK_AQ_LATEST_SNAPSHOT_TRIGGER_MODE: triggerMode,
    },
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const statusPromise = child.status;

  logEvent("log", "latest_snapshot_child_started", {
    trigger_mode: triggerMode,
    pid: child.pid,
    timeout_ms: JOB_TIMEOUT_MS,
  });

  const initialResult = await waitForStatus(statusPromise, JOB_TIMEOUT_MS);
  if (!initialResult.timed_out) {
    logEvent(
      initialResult.status.success ? "log" : "error",
      "latest_snapshot_child_completed",
      {
        trigger_mode: triggerMode,
        pid: child.pid,
        code: initialResult.status.code,
        success: initialResult.status.success,
        duration_ms: Date.now() - startedMs,
      },
    );
    return initialResult.status;
  }

  logEvent("error", "latest_snapshot_child_timeout", {
    trigger_mode: triggerMode,
    pid: child.pid,
    timeout_ms: JOB_TIMEOUT_MS,
    duration_ms: Date.now() - startedMs,
    signal: "SIGTERM",
  });
  try {
    child.kill("SIGTERM");
  } catch (error) {
    logEvent("error", "latest_snapshot_child_signal_failed", {
      trigger_mode: triggerMode,
      pid: child.pid,
      signal: "SIGTERM",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const graceResult = await waitForStatus(statusPromise, JOB_KILL_GRACE_MS);
  if (graceResult.timed_out) {
    logEvent("error", "latest_snapshot_child_kill_escalated", {
      trigger_mode: triggerMode,
      pid: child.pid,
      grace_ms: JOB_KILL_GRACE_MS,
      signal: "SIGKILL",
    });
    try {
      child.kill("SIGKILL");
    } catch (error) {
      logEvent("error", "latest_snapshot_child_signal_failed", {
        trigger_mode: triggerMode,
        pid: child.pid,
        signal: "SIGKILL",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      const killedResult = await waitForStatus(statusPromise, JOB_KILL_WAIT_MS);
      if (killedResult.timed_out) {
        logEvent("error", "latest_snapshot_child_reap_timeout", {
          trigger_mode: triggerMode,
          pid: child.pid,
          wait_ms: JOB_KILL_WAIT_MS,
        });
      }
    } catch (error) {
      logEvent("error", "latest_snapshot_child_reap_failed", {
        trigger_mode: triggerMode,
        pid: child.pid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  throw new JobTimeoutError(JOB_TIMEOUT_MS);
}

export const handler = createLatestSnapshotHandler({ runJob });

if (import.meta.main) {
  serve(handler, { port: PORT });
}
