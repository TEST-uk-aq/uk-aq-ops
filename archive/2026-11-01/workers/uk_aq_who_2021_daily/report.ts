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

function boundedRecords(
  values: unknown,
  limit = 31,
): Record<string, unknown>[] {
  if (!Array.isArray(values)) return [];
  return values.slice(0, limit).map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { value: String(value).slice(0, 500) };
    }
    return value as Record<string, unknown>;
  });
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
    publication_decision_reason:
      String(value.publication_decision_reason || "").slice(0, 100) || null,
    publication_eligible_days: boundedStrings(
      value.publication_eligible_days,
      31,
    ),
    source_mode: String(value.source_mode || "").slice(0, 30) || null,
    requested_start_day_utc: value.requested_start_day_utc || null,
    requested_end_day_utc: value.requested_end_day_utc || null,
    completed_days: boundedStrings(value.completed_days, 31),
    last_completed_day: value.last_completed_day || null,
    failed_day: value.failed_day || null,
    daily_sources: boundedRecords(value.daily_sources, 31),
    readiness: value.readiness || null,
    manifest_keys_used: boundedStrings(value.manifest_keys_used, 200),
    manifest_hash_validation: value.manifest_hash_validation || {
      manifests_validated: 0,
      parquet_objects_validated: 0,
      result: "not_run",
    },
    r2_object_count: Number(value.r2_object_count) || 0,
    r2_bytes_read: Number(value.r2_bytes_read) || 0,
    parquet_row_count: Number(value.parquet_row_count) || 0,
    prepared_daily_row_count: Number(value.prepared_daily_row_count) || 0,
    summary_refresh_requested: Boolean(value.summary_refresh_requested),
    summary_refresh_completed: Boolean(value.summary_refresh_completed),
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
