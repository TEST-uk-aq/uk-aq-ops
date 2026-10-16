const ALLOWED_TRIGGER_MODES = new Set(["scheduler", "manual"]);
const INTEGRITY_RECONCILE_PATH = "/internal/integrity-reconcile";
const MAX_RECONCILE_BODY_BYTES = 256_000;
const MAX_RECONCILE_CANDIDATES = 1000;

export type JobStatus = {
  success: boolean;
  code: number;
  result?: Record<string, unknown>;
};

export type JobRunner = (
  triggerMode: string,
  reconciliationRequest?: Record<string, unknown>,
  invocationId?: string,
) => Promise<JobStatus>;

type Logger = {
  log: (message: string) => void;
  error: (message: string) => void;
};

type InFlightState = {
  invocation_id: string;
  started_at: string;
  started_ms: number;
  trigger_mode: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function validateIntegrityReconciliationRequest(
  value: unknown,
): Record<string, unknown> {
  const root = asRecord(value);
  const integrityRunId = typeof root?.integrity_run_id === "string"
    ? root.integrity_run_id.trim()
    : "";
  if (
    root?.schema_version !== 1 ||
    !integrityRunId || integrityRunId.length > 200 ||
    !Array.isArray(root.candidates) ||
    root.candidates.length > MAX_RECONCILE_CANDIDATES
  ) {
    throw new Error("Invalid reconciliation request envelope.");
  }
  if (Object.keys(root).some((key) => !["schema_version", "integrity_run_id", "candidates"].includes(key))) {
    throw new Error("Unexpected reconciliation request field.");
  }

  const candidates = root.candidates.map((value, index) => {
    const candidate = asRecord(value);
    const allowed = [
      "connector_id", "timeseries_id", "observed_at", "value",
      "value_float8_hex", "status", "pollutant_code",
    ];
    if (!candidate || Object.keys(candidate).some((key) => !allowed.includes(key))) {
      throw new Error(`Invalid reconciliation candidate at index ${index}.`);
    }
    const connectorId = candidate.connector_id;
    const timeseriesId = candidate.timeseries_id;
    const observedAt = candidate.observed_at;
    const pollutantCode = candidate.pollutant_code;
    const valueFloat8Hex = candidate.value_float8_hex;
    const status = candidate.status;
    const timestamp = typeof observedAt === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(observedAt)
      ? Date.parse(observedAt)
      : Number.NaN;
    if (
      !Number.isInteger(connectorId) || Number(connectorId) <= 0 ||
      !Number.isInteger(timeseriesId) || Number(timeseriesId) <= 0 ||
      !Number.isFinite(timestamp) ||
      !((typeof candidate.value === "number" && Number.isFinite(candidate.value)) || candidate.value === null) ||
      !(valueFloat8Hex === null || (typeof valueFloat8Hex === "string" && valueFloat8Hex.length <= 100)) ||
      !(status === null || (typeof status === "string" && status.length <= 500)) ||
      typeof pollutantCode !== "string" || !pollutantCode.trim() || pollutantCode.length > 100
    ) {
      throw new Error(`Invalid reconciliation candidate at index ${index}.`);
    }
    return {
      connector_id: connectorId,
      timeseries_id: timeseriesId,
      observed_at: new Date(timestamp).toISOString(),
      value: candidate.value,
      value_float8_hex: valueFloat8Hex,
      status,
      pollutant_code: pollutantCode.trim().toLowerCase(),
    };
  });
  return { schema_version: 1, integrity_run_id: integrityRunId, candidates };
}

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
    const url = new URL(req.url);
    const isReconciliation = url.pathname === INTEGRITY_RECONCILE_PATH;
    if (req.method === "GET" && !isReconciliation) {
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
    if (isReconciliation) {
      const contentLength = Number(req.headers.get("content-length") || "0");
      if (Number.isFinite(contentLength) && contentLength > MAX_RECONCILE_BODY_BYTES) {
        return jsonResponse({ ok: false, error: "request_too_large" }, 413);
      }
      try {
        const text = await req.text();
        if (new TextEncoder().encode(text).byteLength > MAX_RECONCILE_BODY_BYTES) {
          return jsonResponse({ ok: false, error: "request_too_large" }, 413);
        }
        body = validateIntegrityReconciliationRequest(JSON.parse(text));
      } catch (error) {
        return jsonResponse({
          ok: false,
          error: "invalid_request",
          message: error instanceof Error ? error.message : String(error),
        }, 400);
      }
    } else {
      try {
        body = await req.json();
      } catch {
        body = null;
      }
    }
    const triggerMode = isReconciliation ? "integrity_reconciliation" : resolveTriggerMode(req, body);
    const requestNow = now();
    const invocationId = crypto.randomUUID();

    if (inFlight) {
      const ageSeconds = Math.max(0, Math.floor((requestNow - inFlight.started_ms) / 1000));
      writeLog(logger, "log", "latest_snapshot_run_skipped", {
        reason: "run_in_flight",
        invocation_id: invocationId,
        active_invocation_id: inFlight.invocation_id,
        requested_trigger_mode: triggerMode,
        active_trigger_mode: inFlight.trigger_mode,
        in_flight_started_at: inFlight.started_at,
        age_seconds: ageSeconds,
      }, requestNow);
      return jsonResponse({
        ok: !isReconciliation,
        skipped: true,
        reason: "run_in_flight",
        trigger_mode: triggerMode,
        active_trigger_mode: inFlight.trigger_mode,
        in_flight_started_at: inFlight.started_at,
        age_seconds: ageSeconds,
      }, isReconciliation ? 409 : 200);
    }

    const startedMs = requestNow;
    inFlight = {
      invocation_id: invocationId,
      started_at: new Date(startedMs).toISOString(),
      started_ms: startedMs,
      trigger_mode: triggerMode,
    };
    writeLog(logger, "log", "latest_snapshot_run_accepted", {
      invocation_id: invocationId,
      trigger_mode: triggerMode,
      started_at: inFlight.started_at,
    }, startedMs);

    try {
      const status = await runJob(
        triggerMode,
        isReconciliation ? body as Record<string, unknown> : undefined,
        invocationId,
      );
      const finishedMs = now();
      const durationMs = Math.max(0, finishedMs - startedMs);
      const responseStatus = status.success ? 200 : 500;
      writeLog(
        logger,
        status.success ? "log" : "error",
        status.success ? "latest_snapshot_run_succeeded" : "latest_snapshot_run_failed",
        {
          invocation_id: invocationId,
          trigger_mode: triggerMode,
          code: status.code,
          duration_ms: durationMs,
        },
        finishedMs,
      );
      return jsonResponse(status.result || {
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
        invocation_id: invocationId,
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
