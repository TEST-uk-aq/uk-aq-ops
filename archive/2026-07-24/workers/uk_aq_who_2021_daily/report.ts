export const DEFAULT_REPORT_PATH = "tmp/uk_aq_who_2021_daily_report.json";

export type OperationalOutcome =
  | "deferred"
  | "updated"
  | "unchanged"
  | "failed";

function boundedStrings(values: unknown, limit = 50): string[] {
  if (!Array.isArray(values)) return [];
  return values.slice(0, limit).map((value) => String(value).slice(0, 500));
}

export function boundedReport(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return {
    schema_version: 1,
    task_key: "uk_aq_who_2021_daily",
    workflow_run_id: String(value.workflow_run_id || "").slice(0, 100) || null,
    workflow_run_attempt:
      String(value.workflow_run_attempt || "").slice(0, 20) || null,
    run_id: String(value.run_id || "").slice(0, 100) || null,
    run_mode: String(value.run_mode || "daily").slice(0, 30),
    trigger_mode: String(value.trigger_mode || "manual").slice(0, 30),
    started_at: value.started_at || null,
    finished_at: value.finished_at || null,
    latest_complete_day_utc: value.latest_complete_day_utc || null,
    correction_day_utc: value.correction_day_utc || null,
    publication_as_of_day_utc: value.publication_as_of_day_utc || null,
    readiness: value.readiness || null,
    row_counts: value.row_counts || {},
    r2_objects_checked: boundedStrings(value.r2_objects_checked),
    r2_objects_updated: boundedStrings(value.r2_objects_updated),
    r2_objects_unchanged: boundedStrings(value.r2_objects_unchanged),
    dropbox: value.dropbox || {
      destination_path: null,
      upload_result: "pending",
    },
    warnings: boundedStrings(value.warnings),
    operational_outcome: value.operational_outcome || "failed",
    error: value.error || null,
  };
}

export async function writeBoundedReport(
  reportPath: string,
  value: Record<string, unknown>,
): Promise<void> {
  const report = boundedReport(value);
  const slash = reportPath.lastIndexOf("/");
  if (slash > 0) {
    await Deno.mkdir(reportPath.slice(0, slash), { recursive: true });
  }
  const temporaryPath = `${reportPath}.tmp`;
  await Deno.writeTextFile(
    temporaryPath,
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await Deno.rename(temporaryPath, reportPath);
}
