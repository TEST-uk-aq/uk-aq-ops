import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main as reportHealth } from "../report_daily_task_health.mjs";

const stage = process.argv[2];
if (!["started", "final"].includes(stage)) {
  throw new Error("Usage: report_daily_pipeline_health.mjs started|final");
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

// The attempt endpoint supplies factual start time even when GitHub reruns only
// failed jobs and skips the original successful health-started job. Never reuse
// that job's UUID across GitHub attempts or manufacture a start at finalisation.
const repository = required("GITHUB_REPOSITORY");
const runId = required("GITHUB_RUN_ID");
const attempt = required("GITHUB_RUN_ATTEMPT");
const response = await fetch(
  `${required("GITHUB_API_URL")}/repos/${repository}/actions/runs/${runId}/attempts/${attempt}`,
  {
    headers: {
      Authorization: `Bearer ${required("GH_TOKEN")}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(15_000),
  },
);
if (!response.ok) throw new Error(`GitHub run attempt lookup failed (${response.status})`);
const run = await response.json();
if (String(run.id) !== runId || String(run.run_attempt) !== attempt) {
  throw new Error("GitHub run attempt identity mismatch");
}
const started = new Date(run.run_started_at);
const created = new Date(run.created_at);
if (!run.run_started_at || !run.created_at ||
    !Number.isFinite(started.getTime()) || !Number.isFinite(created.getTime())) {
  throw new Error("GitHub run attempt lacks execution timestamps");
}

const summary = {
  // Cloudflare and operator dispatches both use workflow_dispatch. Keep factual
  // event/actor provenance; neither timing nor the actor proves dispatch origin.
  dispatch_event: run.event,
  triggering_actor: run.triggering_actor?.login || null,
  workflow_created_at: created.toISOString(),
  workflow_attempt_started_at: started.toISOString(),
};
let jobStatus;
if (stage === "final") {
  const reconciliation = required("RECONCILIATION_RESULT");
  const publication = required("PUBLICATION_RESULT");
  summary.reconciliation = { outcome: reconciliation };
  summary.publication = { outcome: publication };
  const raw = process.env.PUBLICATION_SUMMARY?.trim();
  if (raw) {
    const details = JSON.parse(raw);
    // Bounded producer output only: no product, canonical rows or large logs.
    for (const key of ["mode", "rebuild_reason", "months_rebuilt", "months_reused",
      "canonical_days", "published", "result", "source_through_day"]) {
      if (Object.hasOwn(details, key)) summary.publication[key] = details[key];
    }
  }
  jobStatus = reconciliation === "success" && publication === "success" ? "success" : "failure";
}

const directory = mkdtempSync(join(tmpdir(), "bc-daily-health-"));
try {
  const filename = join(directory, "summary.json");
  writeFileSync(filename, JSON.stringify(summary));
  const env = {
    ...process.env,
    DAILY_TASK_KEY: "ops.ukair_bc_daily",
    DAILY_TASK_HEALTH_STRICT: "true",
    DAILY_TASK_HEALTH_DISABLED: "false",
    // Retain the original dispatch's UTC date for recovery on a later day.
    // Actual-time email selection still uses this attempt's factual start time.
    DAILY_TASK_SCHEDULED_FOR_DATE: created.toISOString().slice(0, 10),
    DAILY_TASK_STARTED_AT: started.toISOString(),
    DAILY_TASK_HEALTH_SUPPLEMENTAL_SUMMARY_FILE: filename,
    DAILY_TASK_HEALTH_REPORT_STAGE: "started",
  };
  // Existing Started RPC deduplicates task/repo/run/attempt, including replay
  // after an accepted response was lost. This never resets a terminal record.
  const healthRunId = await reportHealth({ env });
  if (!healthRunId) throw new Error("Started reporting returned no health UUID");
  if (stage === "final") {
    await reportHealth({ env: {
      ...env,
      DAILY_TASK_HEALTH_REPORT_STAGE: "final",
      DAILY_TASK_HEALTH_RUN_ID: healthRunId,
      JOB_STATUS: jobStatus,
    } });
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
