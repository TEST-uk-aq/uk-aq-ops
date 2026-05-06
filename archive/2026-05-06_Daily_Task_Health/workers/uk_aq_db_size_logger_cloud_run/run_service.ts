import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const PORT = Number(Deno.env.get("PORT") || "8000");
const RUN_JOB_SCRIPT = "/app/workers/uk_aq_db_size_logger_cloud_run/run_job.ts";
const ALLOWED_TRIGGER_MODES = new Set(["scheduler", "manual"]);

let inFlight = false;

function resolveTriggerMode(req: Request, body: unknown): string {
  const url = new URL(req.url);
  const queryMode = (url.searchParams.get("trigger_mode") || "").trim()
    .toLowerCase();
  if (queryMode && ALLOWED_TRIGGER_MODES.has(queryMode)) {
    return queryMode;
  }

  const headerMode = (req.headers.get("x-uk-aq-db-size-trigger-mode") || "")
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

async function runJob(triggerMode: string): Promise<Deno.CommandStatus> {
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
      UK_AQ_DB_SIZE_TRIGGER_MODE: triggerMode,
    },
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
        service: "uk_aq_db_size_logger_cloud_run",
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
      JSON.stringify({
        ok: false,
        error: "run_in_flight",
      }),
      {
        status: 409,
        headers: { "content-type": "application/json" },
      },
    );
  }

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const triggerMode = resolveTriggerMode(req, body);

  inFlight = true;
  try {
    const status = await runJob(triggerMode);
    return new Response(
      JSON.stringify({
        ok: status.success,
        trigger_mode: triggerMode,
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
