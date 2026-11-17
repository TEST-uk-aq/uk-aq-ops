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
const runUrl = `${required("GITHUB_API_URL")}/repos/${repository}/actions/runs/${runId}`;
async function getRunMetadata(suffix, label) {
  const response = await fetch(`${runUrl}${suffix}`, {
    headers: {
      Authorization: `Bearer ${required("GH_TOKEN")}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub ${label} lookup failed (${response.status})`);
  const metadata = await response.json();
  if (String(metadata.id) !== runId || metadata.repository?.full_name !== repository) {
    throw new Error(`GitHub ${label} identity mismatch`);
  }
  return metadata;
}

// Attempt created_at changes on rerun. Only the original workflow-run endpoint
// supplies the dispatch creation date; do not require its latest run_attempt to
// equal ours, since it can advance independently of this attempt-specific read.
const [workflow, run] = await Promise.all([
  getRunMetadata("", "workflow run"),
  getRunMetadata(`/attempts/${attempt}`, "run attempt"),
]);
if (String(run.run_attempt) !== attempt) {
  throw new Error("GitHub run attempt identity mismatch");
}

function timestamp(value, label) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    throw new Error(`Missing or invalid GitHub ${label}`);
  }
  const parsed = new Date(value);
  const normalized = value.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction = "") => `.${fraction.padEnd(3, "0")}Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== normalized) {
    throw new Error(`Invalid GitHub ${label}`);
  }
  return parsed;
}

const created = timestamp(workflow.created_at, "workflow creation timestamp");
const attemptCreated = timestamp(run.created_at, "attempt creation timestamp");
const started = timestamp(run.run_started_at, "attempt start timestamp");

const summary = {
  // Cloudflare and operator dispatches both use workflow_dispatch. Keep factual
  // event/actor provenance; neither timing nor the actor proves dispatch origin.
  dispatch_event: run.event,
  triggering_actor: run.triggering_actor?.login || null,
  workflow_created_at: created.toISOString(),
  workflow_attempt_created_at: attemptCreated.toISOString(),
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
