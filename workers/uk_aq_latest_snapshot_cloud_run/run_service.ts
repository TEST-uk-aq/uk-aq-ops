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

function reconciliationResultFromOutput(output: string): Record<string, unknown> | undefined {
  const prefix = "UK_AQ_LATEST_SNAPSHOT_RECONCILE_RESULT ";
  for (const line of output.split(/\r?\n/).reverse()) {
    if (!line.startsWith(prefix)) continue;
    const parsed = JSON.parse(line.slice(prefix.length));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  return undefined;
}

export async function runJob(
  triggerMode: string,
  reconciliationRequest?: Record<string, unknown>,
  invocationId?: string,
): Promise<{ success: boolean; code: number; result?: Record<string, unknown> }> {
  const traceId = invocationId || crypto.randomUUID();
  const startedMs = Date.now();
  let requestFile: string | null = null;
  if (reconciliationRequest) {
    requestFile = await Deno.makeTempFile({
      prefix: "uk-aq-latest-snapshot-reconcile-",
      suffix: ".json",
    });
    await Deno.writeTextFile(requestFile, JSON.stringify(reconciliationRequest));
  }
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
      UK_AQ_LATEST_SNAPSHOT_INVOCATION_ID: traceId,
      ...(requestFile
        ? { UK_AQ_LATEST_SNAPSHOT_RECONCILE_REQUEST_FILE: requestFile }
        : {}),
    },
    stdout: requestFile ? "piped" : "inherit",
    stderr: "inherit",
  }).spawn();
  const statusPromise = child.status;
  const stdoutPromise = requestFile && child.stdout
    ? new Response(child.stdout).text()
    : Promise.resolve("");

  logEvent("log", "latest_snapshot_child_started", {
    invocation_id: traceId,
    trigger_mode: triggerMode,
    pid: child.pid,
    timeout_ms: JOB_TIMEOUT_MS,
  });

  const initialResult = await waitForStatus(statusPromise, JOB_TIMEOUT_MS);
  if (!initialResult.timed_out) {
    const output = await stdoutPromise;
    if (output.trim()) console.log(output.trimEnd());
    if (requestFile) {
      try {
        await Deno.remove(requestFile);
      } catch {
        // Best-effort cleanup of a non-secret request body.
      }
    }
    logEvent(
      initialResult.status.success ? "log" : "error",
      "latest_snapshot_child_completed",
      {
        invocation_id: traceId,
        trigger_mode: triggerMode,
        pid: child.pid,
        code: initialResult.status.code,
        success: initialResult.status.success,
        duration_ms: Date.now() - startedMs,
      },
    );
    return {
      success: initialResult.status.success,
      code: initialResult.status.code,
      result: reconciliationResultFromOutput(output),
    };
  }

  logEvent("error", "latest_snapshot_child_timeout", {
    invocation_id: traceId,
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
      invocation_id: traceId,
      trigger_mode: triggerMode,
      pid: child.pid,
      signal: "SIGTERM",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const graceResult = await waitForStatus(statusPromise, JOB_KILL_GRACE_MS);
  if (graceResult.timed_out) {
    logEvent("error", "latest_snapshot_child_kill_escalated", {
      invocation_id: traceId,
      trigger_mode: triggerMode,
      pid: child.pid,
      grace_ms: JOB_KILL_GRACE_MS,
      signal: "SIGKILL",
    });
    try {
      child.kill("SIGKILL");
    } catch (error) {
      logEvent("error", "latest_snapshot_child_signal_failed", {
        invocation_id: traceId,
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
          invocation_id: traceId,
          trigger_mode: triggerMode,
          pid: child.pid,
          wait_ms: JOB_KILL_WAIT_MS,
        });
      }
    } catch (error) {
      logEvent("error", "latest_snapshot_child_reap_failed", {
        invocation_id: traceId,
        trigger_mode: triggerMode,
        pid: child.pid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await stdoutPromise.catch(() => "");
  if (requestFile) {
    try {
      await Deno.remove(requestFile);
    } catch {
      // Best-effort cleanup after timeout.
    }
  }
  throw new JobTimeoutError(JOB_TIMEOUT_MS);
}

export const handler = createLatestSnapshotHandler({ runJob });

if (import.meta.main) {
  serve(handler, { port: PORT });
}
