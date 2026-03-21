import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  parseBooleanish,
  parseConnectorIds,
  parseIsoDayUtc,
  parseRunMode,
  parseTriggerMode,
} from "./backfill_core.mjs";

const PORT = Number(Deno.env.get("PORT") || "8000");
const RUN_JOB_SCRIPT = "/app/workers/uk_aq_backfill_cloud_run/run_job.ts";

let inFlight = false;

type RequestBody = {
  trigger_mode?: unknown;
  run_mode?: unknown;
  dry_run?: unknown;
  force_replace?: unknown;
  from_day_utc?: unknown;
  to_day_utc?: unknown;
  connector_ids?: unknown;
  connector_id?: unknown;
  station_ids?: unknown;
  station_id?: unknown;
  enable_r2_fallback?: unknown;
};

function parseBody(payload: unknown): RequestBody | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  return payload as RequestBody;
}

function readStringQuery(req: Request, key: string): string {
  const url = new URL(req.url);
  return (url.searchParams.get(key) || "").trim();
}

function resolveTriggerMode(req: Request, body: RequestBody | null): string {
  const queryValue = readStringQuery(req, "trigger_mode");
  if (queryValue) {
    return parseTriggerMode(queryValue, "manual");
  }

  const headerValue = (req.headers.get("x-uk-aq-backfill-trigger-mode") || "")
    .trim();
  if (headerValue) {
    return parseTriggerMode(headerValue, "manual");
  }

  return parseTriggerMode(body?.trigger_mode, "manual");
}

function resolveRunMode(req: Request, body: RequestBody | null): string {
  const queryValue = readStringQuery(req, "run_mode");
  if (queryValue) {
    return parseRunMode(queryValue, "local_to_aqilevels");
  }

  const headerValue = (req.headers.get("x-uk-aq-backfill-run-mode") || "")
    .trim();
  if (headerValue) {
    return parseRunMode(headerValue, "local_to_aqilevels");
  }

  return parseRunMode(body?.run_mode, "local_to_aqilevels");
}

function resolveDryRun(req: Request, body: RequestBody | null): boolean {
  const queryValue = readStringQuery(req, "dry_run");
  if (queryValue) {
    return parseBooleanish(queryValue, false);
  }

  const headerValue = (req.headers.get("x-uk-aq-backfill-dry-run") || "")
    .trim();
  if (headerValue) {
    return parseBooleanish(headerValue, false);
  }

  return parseBooleanish(body?.dry_run, false);
}

function resolveForceReplace(req: Request, body: RequestBody | null): boolean {
  const queryValue = readStringQuery(req, "force_replace");
  if (queryValue) {
    return parseBooleanish(queryValue, false);
  }

  const headerValue = (req.headers.get("x-uk-aq-backfill-force-replace") || "")
    .trim();
  if (headerValue) {
    return parseBooleanish(headerValue, false);
  }

  return parseBooleanish(body?.force_replace, false);
}

function resolveEnableR2Fallback(
  req: Request,
  body: RequestBody | null,
): boolean {
  const queryValue = readStringQuery(req, "enable_r2_fallback");
  if (queryValue) {
    return parseBooleanish(queryValue, false);
  }

  const headerValue =
    (req.headers.get("x-uk-aq-backfill-enable-r2-fallback") || "").trim();
  if (headerValue) {
    return parseBooleanish(headerValue, false);
  }

  return parseBooleanish(body?.enable_r2_fallback, false);
}

function resolveDay(raw: unknown): string | null {
  return parseIsoDayUtc(typeof raw === "string" ? raw : "");
}

function resolveFromDayUtc(
  req: Request,
  body: RequestBody | null,
): string | null {
  const queryValue = resolveDay(readStringQuery(req, "from_day_utc"));
  if (queryValue) {
    return queryValue;
  }

  const headerValue = resolveDay(
    req.headers.get("x-uk-aq-backfill-from-day-utc") || "",
  );
  if (headerValue) {
    return headerValue;
  }

  return resolveDay(body?.from_day_utc);
}

function resolveToDayUtc(
  req: Request,
  body: RequestBody | null,
): string | null {
  const queryValue = resolveDay(readStringQuery(req, "to_day_utc"));
  if (queryValue) {
    return queryValue;
  }

  const headerValue = resolveDay(
    req.headers.get("x-uk-aq-backfill-to-day-utc") || "",
  );
  if (headerValue) {
    return headerValue;
  }

  return resolveDay(body?.to_day_utc);
}

function resolveConnectorIds(
  req: Request,
  body: RequestBody | null,
): number[] | null {
  const queryCsv = readStringQuery(req, "connector_ids");
  if (queryCsv) {
    return parseConnectorIds(queryCsv);
  }

  const querySingle = readStringQuery(req, "connector_id");
  if (querySingle) {
    return parseConnectorIds(querySingle);
  }

  const headerCsv = (req.headers.get("x-uk-aq-backfill-connector-ids") || "")
    .trim();
  if (headerCsv) {
    return parseConnectorIds(headerCsv);
  }

  const bodyList = parseConnectorIds(body?.connector_ids);
  if (bodyList && bodyList.length) {
    return bodyList;
  }

  return parseConnectorIds(body?.connector_id);
}

function resolveStationIds(
  req: Request,
  body: RequestBody | null,
): number[] | null {
  const queryCsv = readStringQuery(req, "station_ids");
  if (queryCsv) {
    return parseConnectorIds(queryCsv);
  }

  const querySingle = readStringQuery(req, "station_id");
  if (querySingle) {
    return parseConnectorIds(querySingle);
  }

  const headerCsv = (req.headers.get("x-uk-aq-backfill-station-ids") || "")
    .trim();
  if (headerCsv) {
    return parseConnectorIds(headerCsv);
  }

  const bodyList = parseConnectorIds(body?.station_ids);
  if (bodyList && bodyList.length) {
    return bodyList;
  }

  return parseConnectorIds(body?.station_id);
}

async function runJob(args: {
  triggerMode: string;
  runMode: string;
  dryRun: boolean;
  forceReplace: boolean;
  fromDayUtc: string | null;
  toDayUtc: string | null;
  connectorIds: number[] | null;
  stationIds: number[] | null;
  enableR2Fallback: boolean;
}): Promise<Deno.CommandStatus> {
  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    UK_AQ_BACKFILL_TRIGGER_MODE: args.triggerMode,
    UK_AQ_BACKFILL_RUN_MODE: args.runMode,
    UK_AQ_BACKFILL_DRY_RUN: args.dryRun ? "true" : "false",
    UK_AQ_BACKFILL_FORCE_REPLACE: args.forceReplace ? "true" : "false",
    UK_AQ_BACKFILL_ENABLE_R2_FALLBACK: args.enableR2Fallback ? "true" : "false",
  };

  if (args.fromDayUtc) {
    env.UK_AQ_BACKFILL_FROM_DAY_UTC = args.fromDayUtc;
  }
  if (args.toDayUtc) {
    env.UK_AQ_BACKFILL_TO_DAY_UTC = args.toDayUtc;
  }
  if (args.connectorIds && args.connectorIds.length > 0) {
    env.UK_AQ_BACKFILL_CONNECTOR_IDS = args.connectorIds.join(",");
  }
  if (args.stationIds && args.stationIds.length > 0) {
    env.UK_AQ_BACKFILL_STATION_IDS = args.stationIds.join(",");
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

function json(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

serve(async (req: Request) => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    return json({
      ok: true,
      service: "uk_aq_backfill_cloud_run",
      run_modes: [
        "local_to_aqilevels",
        "obs_aqi_to_r2",
        "source_to_r2",
        "r2_history_obs_to_aqilevels",
      ],
    });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (url.pathname !== "/" && url.pathname !== "/run") {
    return json({ ok: false, error: "not_found" }, 404);
  }

  if (inFlight) {
    return json({ ok: false, error: "run_in_flight" }, 409);
  }

  let body: RequestBody | null = null;
  try {
    body = parseBody(await req.json());
  } catch {
    body = null;
  }

  const triggerMode = resolveTriggerMode(req, body);
  const runMode = resolveRunMode(req, body);
  const dryRun = resolveDryRun(req, body);
  const forceReplace = resolveForceReplace(req, body);
  const fromDayUtc = resolveFromDayUtc(req, body);
  const toDayUtc = resolveToDayUtc(req, body);
  const connectorIds = resolveConnectorIds(req, body);
  const stationIds = resolveStationIds(req, body);
  const enableR2Fallback = resolveEnableR2Fallback(req, body);

  inFlight = true;
  try {
    const status = await runJob({
      triggerMode,
      runMode,
      dryRun,
      forceReplace,
      fromDayUtc,
      toDayUtc,
      connectorIds,
      stationIds,
      enableR2Fallback,
    });

    return json({
      ok: status.success,
      trigger_mode: triggerMode,
      run_mode: runMode,
      dry_run: dryRun,
      force_replace: forceReplace,
      from_day_utc: fromDayUtc,
      to_day_utc: toDayUtc,
      connector_ids: connectorIds,
      station_ids: stationIds,
      enable_r2_fallback: enableR2Fallback,
      code: status.code,
    }, status.success ? 200 : 500);
  } finally {
    inFlight = false;
  }
}, { port: PORT });
