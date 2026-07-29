const ALLOWED_TRIGGER_MODES = new Set(["scheduler", "manual"]);

export type JobStatus = {
  success: boolean;
  code: number;
};

export type JobRunner = (triggerMode: string) => Promise<JobStatus>;

type Logger = {
  log: (message: string) => void;
  error: (message: string) => void;
};

type InFlightState = {
  started_at: string;
  started_ms: number;
  trigger_mode: string;
};

export class JobTimeoutError extends Error {
  readonly timeout_ms: number;

  constructor(timeoutMs: number) {
    super(`Latest snapshot job exceeded ${timeoutMs}ms and was terminated`);
    this.name = "JobTimeoutError";
    this.timeout_ms = timeoutMs;
  }
}

function jsonResponse(payload: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function writeLog(
  logger: Logger,
  level: "log" | "error",
  event: string,
  fields: Record<string, unknown>,
  nowMs: number,
): void {
  logger[level](JSON.stringify({
    event,
    timestamp: new Date(nowMs).toISOString(),
    ...fields,
  }));
}

export function resolveTriggerMode(req: Request, body: unknown): string {
  const url = new URL(req.url);
  const queryMode = (url.searchParams.get("trigger_mode") || "").trim().toLowerCase();
  if (queryMode && ALLOWED_TRIGGER_MODES.has(queryMode)) {
    return queryMode;
  }

  const headerMode = (req.headers.get("x-uk-aq-latest-snapshot-trigger-mode") || "")
    .trim()
    .toLowerCase();
  if (headerMode && ALLOWED_TRIGGER_MODES.has(headerMode)) {
    return headerMode;
  }

  const root = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
  const bodyMode = typeof root?.trigger_mode === "string"
    ? root.trigger_mode.trim().toLowerCase()
    : "";
  if (bodyMode && ALLOWED_TRIGGER_MODES.has(bodyMode)) {
    return bodyMode;
  }

  return "manual";
}

export function createLatestSnapshotHandler({
  runJob,
  now = () => Date.now(),
  logger = console,
}: {
  runJob: JobRunner;
  now?: () => number;
  logger?: Logger;
}): (req: Request) => Promise<Response> {
  let inFlight: InFlightState | null = null;

  return async (req: Request): Promise<Response> => {
    if (req.method === "GET") {
      return jsonResponse({
        ok: true,
        service: "uk_aq_latest_snapshot_cloud_run",
        in_flight: inFlight !== null,
        in_flight_started_at: inFlight?.started_at ?? null,
        in_flight_trigger_mode: inFlight?.trigger_mode ?? null,
        in_flight_age_seconds: inFlight
          ? Math.max(0, Math.floor((now() - inFlight.started_ms) / 1000))
          : null,
      }, 200);
    }

    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    let body: unknown = null;
    try {
      body = await req.json();
    } catch {
      body = null;
    }
    const triggerMode = resolveTriggerMode(req, body);
    const requestNow = now();

    if (inFlight) {
      const ageSeconds = Math.max(0, Math.floor((requestNow - inFlight.started_ms) / 1000));
      writeLog(logger, "log", "latest_snapshot_run_skipped", {
        reason: "run_in_flight",
        requested_trigger_mode: triggerMode,
        active_trigger_mode: inFlight.trigger_mode,
        in_flight_started_at: inFlight.started_at,
        age_seconds: ageSeconds,
      }, requestNow);
      return jsonResponse({
        ok: true,
        skipped: true,
        reason: "run_in_flight",
        trigger_mode: triggerMode,
        active_trigger_mode: inFlight.trigger_mode,
        in_flight_started_at: inFlight.started_at,
        age_seconds: ageSeconds,
      }, 200);
    }

    const startedMs = requestNow;
    inFlight = {
      started_at: new Date(startedMs).toISOString(),
      started_ms: startedMs,
      trigger_mode: triggerMode,
    };
    writeLog(logger, "log", "latest_snapshot_run_accepted", {
      trigger_mode: triggerMode,
      started_at: inFlight.started_at,
    }, startedMs);

    try {
      const status = await runJob(triggerMode);
      const finishedMs = now();
      const durationMs = Math.max(0, finishedMs - startedMs);
      const responseStatus = status.success ? 200 : 500;
      writeLog(
        logger,
        status.success ? "log" : "error",
        status.success ? "latest_snapshot_run_succeeded" : "latest_snapshot_run_failed",
        {
          trigger_mode: triggerMode,
          code: status.code,
          duration_ms: durationMs,
        },
        finishedMs,
      );
      return jsonResponse({
        ok: status.success,
        trigger_mode: triggerMode,
        code: status.code,
        duration_ms: durationMs,
      }, responseStatus);
    } catch (error) {
      const finishedMs = now();
      const durationMs = Math.max(0, finishedMs - startedMs);
      const timedOut = error instanceof JobTimeoutError;
      const message = error instanceof Error ? error.message : String(error);
      writeLog(logger, "error", timedOut
        ? "latest_snapshot_run_timed_out"
        : "latest_snapshot_run_failed", {
        trigger_mode: triggerMode,
        duration_ms: durationMs,
        error: message,
        ...(timedOut ? { timeout_ms: error.timeout_ms } : {}),
      }, finishedMs);
      return jsonResponse({
        ok: false,
        error: timedOut ? "job_timeout" : "job_failed",
        message,
        trigger_mode: triggerMode,
        duration_ms: durationMs,
      }, timedOut ? 504 : 500);
    } finally {
      inFlight = null;
    }
  };
}
