import {
  parsePollutantCodes,
  parseRunMode,
  parseTriggerMode,
} from "./who_2021_daily_core.ts";

const PORT = Number(Deno.env.get("PORT") || "8000");
const RUN_JOB_SCRIPT = "/app/workers/uk_aq_who_2021_daily_cloud_run/run_job.ts";

let inFlight = false;

type RequestBody = {
  trigger_mode?: unknown;
  run_mode?: unknown;
  start_day_utc?: unknown;
  end_day_utc?: unknown;
  connector_id?: unknown;
  source_network_code?: unknown;
  pollutant_codes?: unknown;
};

function bodyRecord(body: unknown): Record<string, unknown> | null {
  return body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveIntegerValue(value: unknown): string | null {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0) return null;
  return String(Math.trunc(numberValue));
}

function pollutantCodesValue(value: unknown): string | null {
  if (Array.isArray(value)) {
    const joined = value
      .map((item) => typeof item === "string" ? item.trim() : "")
      .filter(Boolean)
      .join(",");
    return joined || null;
  }
  if (typeof value === "string" && value.trim()) {
    return parsePollutantCodes(value).join(",");
  }
  return null;
}

function resolveBodyValue(
  req: Request,
  body: RequestBody | null,
  key: keyof RequestBody,
  headerName: string,
): string | null {
  const url = new URL(req.url);
  return stringValue(url.searchParams.get(key)) ||
    stringValue(req.headers.get(headerName)) ||
    stringValue(body?.[key]);
}

async function runJob(
  req: Request,
  body: RequestBody | null,
): Promise<Deno.CommandStatus> {
  const triggerMode = parseTriggerMode(
    resolveBodyValue(
      req,
      body,
      "trigger_mode",
      "x-uk-aq-who-2021-trigger-mode",
    ),
  );
  const runMode = parseRunMode(
    resolveBodyValue(req, body, "run_mode", "x-uk-aq-who-2021-run-mode"),
  );
  const startDayUtc = resolveBodyValue(
    req,
    body,
    "start_day_utc",
    "x-uk-aq-who-2021-start-day-utc",
  );
  const endDayUtc = resolveBodyValue(
    req,
    body,
    "end_day_utc",
    "x-uk-aq-who-2021-end-day-utc",
  );
  const sourceNetworkCode = resolveBodyValue(
    req,
    body,
    "source_network_code",
    "x-uk-aq-who-2021-source-network-code",
  );
  const connectorId = positiveIntegerValue(
    new URL(req.url).searchParams.get("connector_id") ||
      req.headers.get("x-uk-aq-who-2021-connector-id") ||
      body?.connector_id,
  );
  const pollutantCodes = pollutantCodesValue(
    new URL(req.url).searchParams.get("pollutant_codes") ||
      req.headers.get("x-uk-aq-who-2021-pollutant-codes") ||
      body?.pollutant_codes,
  );

  const env: Record<string, string> = {
    ...Deno.env.toObject(),
    UK_AQ_WHO_2021_TRIGGER_MODE: triggerMode,
    UK_AQ_WHO_2021_RUN_MODE: runMode,
  };
  if (startDayUtc) env.UK_AQ_WHO_2021_START_DAY_UTC = startDayUtc;
  if (endDayUtc) env.UK_AQ_WHO_2021_END_DAY_UTC = endDayUtc;
  if (sourceNetworkCode) {
    env.UK_AQ_WHO_2021_SOURCE_NETWORK_CODE = sourceNetworkCode;
  }
  if (connectorId) env.UK_AQ_WHO_2021_CONNECTOR_ID = connectorId;
  if (pollutantCodes) env.UK_AQ_WHO_2021_POLLUTANT_CODES = pollutantCodes;

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

Deno.serve({ port: PORT }, async (req: Request) => {
  const url = new URL(req.url);
  if (
    req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")
  ) {
    return new Response(
      JSON.stringify({
        ok: true,
        service: "uk_aq_who_2021_daily_cloud_run",
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }

  if (
    req.method !== "POST" || (url.pathname !== "/" && url.pathname !== "/run")
  ) {
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
    body = bodyRecord(await req.json()) as RequestBody | null;
  } catch {
    body = null;
  }

  inFlight = true;
  try {
    const status = await runJob(req, body);
    return new Response(
      JSON.stringify({
        ok: status.success,
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
});
