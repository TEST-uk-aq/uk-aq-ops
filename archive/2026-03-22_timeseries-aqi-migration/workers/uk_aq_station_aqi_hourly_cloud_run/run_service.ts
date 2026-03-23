import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const PORT = Number(Deno.env.get("PORT") || "8000");
const RUN_JOB_SCRIPT = "/app/workers/uk_aq_station_aqi_hourly_cloud_run/run_job.ts";
const ALLOWED_TRIGGER_MODES = new Set(["scheduler", "manual"]);
const ALLOWED_RUN_MODES = new Set(["sync_hourly", "backfill", "reconcile_short", "reconcile_deep"]);

let inFlight = false;

type RequestBody = {
  trigger_mode?: unknown;
  run_mode?: unknown;
  from_hour_utc?: unknown;
  to_hour_utc?: unknown;
  station_ids?: unknown;
};

function parseTriggerMode(req: Request, body: RequestBody | null): string {
  const url = new URL(req.url);
  const queryMode = (url.searchParams.get("trigger_mode") || "").trim().toLowerCase();
  if (queryMode && ALLOWED_TRIGGER_MODES.has(queryMode)) {
    return queryMode;
  }

  const headerMode = (req.headers.get("x-uk-aq-aqi-trigger-mode") || "").trim().toLowerCase();
  if (headerMode && ALLOWED_TRIGGER_MODES.has(headerMode)) {
    return headerMode;
  }

  const bodyMode = typeof body?.trigger_mode === "string"
    ? body.trigger_mode.trim().toLowerCase()
    : "";
  if (bodyMode && ALLOWED_TRIGGER_MODES.has(bodyMode)) {
    return bodyMode;
  }

  return "manual";
}

function parseRunMode(req: Request, body: RequestBody | null): string {
  const url = new URL(req.url);
  const queryMode = (url.searchParams.get("run_mode") || "").trim().toLowerCase();
  if (queryMode && ALLOWED_RUN_MODES.has(queryMode)) {
    return queryMode;
  }

  const headerMode = (req.headers.get("x-uk-aq-aqi-run-mode") || "").trim().toLowerCase();
  if (headerMode && ALLOWED_RUN_MODES.has(headerMode)) {
    return headerMode;
  }

  const bodyMode = typeof body?.run_mode === "string"
    ? body.run_mode.trim().toLowerCase()
    : "";
  if (bodyMode && ALLOWED_RUN_MODES.has(bodyMode)) {
    return bodyMode;
  }

  return "sync_hourly";
}

function parseIsoHour(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return null;
  }
  const date = new Date(parsed);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function parseStationIdsCsv(value: unknown): string | null {
  if (Array.isArray(value)) {
    const ids = value
      .map((entry) => Number(entry))
      .filter((entry) => Number.isInteger(entry) && entry > 0)
      .map((entry) => Math.trunc(entry));
    if (!ids.length) {
      return null;
    }
    return Array.from(new Set(ids)).join(",");
  }

  if (typeof value !== "string") {
    return null;
  }

  const ids = value
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isInteger(entry) && entry > 0)
    .map((entry) => Math.trunc(entry));
  if (!ids.length) {
    return null;
  }
  return Array.from(new Set(ids)).join(",");
}

async function runJob(
  triggerMode: string,
  runMode: string,
  fromHourUtc: string | null,
  toHourUtc: string | null,
  stationIdsCsv: string | null,
): Promise<Deno.CommandStatus> {
  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    UK_AQ_AQI_TRIGGER_MODE: triggerMode,
    UK_AQ_AQI_RUN_MODE: runMode,
  };

  if (fromHourUtc) {
    env.UK_AQ_AQI_FROM_HOUR_UTC = fromHourUtc;
  }
  if (toHourUtc) {
    env.UK_AQ_AQI_TO_HOUR_UTC = toHourUtc;
  }
  if (stationIdsCsv) {
    env.UK_AQ_AQI_STATION_IDS_CSV = stationIdsCsv;
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
    env,
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();

  return await child.status;
}

serve(async (req: Request) => {
  if (req.method === "GET") {
    return new Response(
      JSON.stringify({
        ok: true,
        service: "uk_aq_station_aqi_hourly_cloud_run",
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (inFlight) {
    return new Response(
      JSON.stringify({ ok: false, error: "run_in_flight" }),
      {
        status: 409,
        headers: { "content-type": "application/json" },
      },
    );
  }

  let body: RequestBody | null = null;
  try {
    const payload = await req.json();
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      body = payload as RequestBody;
    }
  } catch {
    body = null;
  }

  const triggerMode = parseTriggerMode(req, body);
  const runMode = parseRunMode(req, body);
  const fromHourUtc = parseIsoHour(body?.from_hour_utc);
  const toHourUtc = parseIsoHour(body?.to_hour_utc);
  const stationIdsCsv = parseStationIdsCsv(body?.station_ids);

  inFlight = true;
  try {
    const status = await runJob(
      triggerMode,
      runMode,
      fromHourUtc,
      toHourUtc,
      stationIdsCsv,
    );

    return new Response(
      JSON.stringify({
        ok: status.success,
        trigger_mode: triggerMode,
        run_mode: runMode,
        from_hour_utc: fromHourUtc,
        to_hour_utc: toHourUtc,
        station_ids_csv: stationIdsCsv,
        code: status.code,
      }),
      {
        status: status.success ? 200 : 500,
        headers: { "content-type": "application/json" },
      },
    );
  } finally {
    inFlight = false;
  }
}, { port: PORT });
