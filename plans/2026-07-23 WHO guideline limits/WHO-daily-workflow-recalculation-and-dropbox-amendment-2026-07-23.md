# WHO daily workflow recalculation and Dropbox report amendment

Date: 2026-07-23  
Status: authoritative amendment to the daily workflow parts of `WHO-derived-data-tables-and-processes-codex-plan-2026-07-23.md`

This amendment supersedes any wording in the main plan that says a successful earlier run prevents later hourly recalculation, or that a completed day should automatically no-op during the remaining 04:00-09:00 UTC scheduler window.

Use GPT-5.6 Codex with High reasoning for implementation.

## 1. Normal scheduled-day selection

Every normal scheduler-dispatched workflow run must calculate:

```text
latest_complete_day_utc = yesterday
correction_day_utc = latest_complete_day_utc - 1 day
```

Every run at 04:00, 05:00, 06:00, 07:00, 08:00 and 09:00 UTC must recalculate both of those complete sample days.

Do not recalculate a wider normal correction window. Corrections older than the day before yesterday remain a manual backfill concern.

A successful earlier run must not prevent a later hourly run from recalculating the same two days. Idempotency must prevent duplicate logical rows and objects, not prevent recalculation.

## 2. Readiness and publication date

The latest-day readiness check is a network-level ingest-readiness signal. It is not a requirement that every individual timeseries contains the final `00:00` hour-ending observation.

An individual timeseries daily mean remains valid when it has at least 18 valid distinct hourly observations in the sample-day window, even when its final midnight observation is absent.

The readiness result controls which day becomes the current published summary date:

```text
if latest_complete_day_utc is ready:
    publication_as_of_day_utc = latest_complete_day_utc
else:
    publication_as_of_day_utc = correction_day_utc
```

Both target days must still be recalculated in either case.

When the latest day is deferred:

- record the latest day as deferred;
- keep the current public summary as of `correction_day_utc`;
- regenerate the correction-day rolling and current summary outputs;
- update their R2 objects only if their content changed.

When readiness passes, advance the current rolling and summary outputs to `latest_complete_day_utc`.

## 3. Hourly recalculation behaviour

The Cloudflare schedule remains:

```toml
cron_expr = "0 4-9 * * *"
```

Each hourly slot is an intentional recalculation opportunity for late or amended observations. It is not merely a failure retry.

Expected normal outcomes are:

- `deferred`: the latest complete day is not ready, but both daily target days and the correction-day current summary are still recalculated;
- `updated`: one or more derived rows or published objects changed;
- `unchanged`: recalculation completed and the logical result matches the existing state;
- `failed`: calculation, database, R2 publication or Dropbox report upload failed.

Remove or amend any existing `already_completed` or equivalent successful-run skip that would suppress later hourly recalculation.

## 4. Daily workflow sequence

The normal daily workflow must:

1. Determine `latest_complete_day_utc` and `correction_day_utc`.
2. Run the latest-day readiness check.
3. Recalculate daily status for both target days using the hour-ending window `(day_utc 00:00, next_day_utc 00:00]`.
4. Apply the existing 18-valid-hour rule independently to each timeseries and day.
5. Idempotently upsert changed, valid, invalid or newly missing daily states according to the existing RPC contract.
6. Select `publication_as_of_day_utc` from the readiness result.
7. Recalculate the current rolling 365-day and other enabled current summaries as of `publication_as_of_day_utc`.
8. Generate affected R2 parquet and JSON payloads using stable serialisation or a stable logical-content hash.
9. Compare every generated R2 payload with the existing R2 object.
10. Upload only changed R2 objects.
11. Preserve parquet-before-JSON ordering and dated JSON before `latest_who_2021.json`.
12. Write the bounded JSON run report.
13. Upload the report to Dropbox and retain the same report as a GitHub Actions artefact.

## 5. R2 comparison state

Do not use GitHub workflow artefacts or caches as cross-run application state.

Use:

- Obs AQI DB as the source for derived database state;
- the existing R2 object as the comparison source for each published object.

Before an R2 write, compare the new canonical payload or stable logical-content hash with the existing object. Skip the write when unchanged. Replace the same stable object key when changed.

The report must list changed and unchanged R2 objects so the hourly behaviour is auditable.

## 6. Dropbox report upload

Write the runner-local report to:

```text
tmp/uk_aq_who_2021_daily_report.json
```

Then upload it to Dropbox through the repository's existing Dropbox helper if one exists. If none exists, add the smallest repo-consistent Dropbox API uploader.

`${UK_AQ_DROPBOX_ROOT}` is the remote Dropbox root path, not a local GitHub runner or Mac filesystem path.

Upload reports under:

```text
${UK_AQ_DROPBOX_ROOT}/who_2021/
```

Use a unique timestamped filename that includes the GitHub run ID, for example:

```text
uk_aq_who_2021_daily_report_2026-07-23T090000Z_123456789.json
```

Map `UK_AQ_DROPBOX_ROOT` from non-secret GitHub repository configuration. Identify the repository-consistent Dropbox credential during focused inspection and map it from GitHub secrets.

Run the Dropbox upload and GitHub artefact-retention steps with `if: always()` after the local report has been written. A Dropbox upload failure must be visible and must not be silently reported as success.

Do not attempt to write directly to `${UK_AQ_DROPBOX_ROOT}` as a filesystem directory.

## 7. Phase 7 amendments

### Phase 7.1 focused inspection

In addition to the main plan, confirm:

- where the successful-run skip currently occurs;
- the smallest focused change that permits later hourly recalculation;
- any existing Dropbox API/helper pattern;
- if no Dropbox helper exists, the smallest repo-consistent uploader;
- the Dropbox secret name and remote-path conventions;
- how `UK_AQ_DROPBOX_ROOT` is supplied to GitHub Actions;
- the existing R2 read or metadata mechanism suitable for change comparison.

Do not call external services during inspection.

### Phase 7.2 direct worker

The direct worker must:

- recalculate yesterday and the day before yesterday on every scheduled run;
- apply readiness only to the current publication date;
- remove the successful-run skip that suppresses later recalculation;
- compare R2 outputs and skip unchanged writes;
- write the report on updated, unchanged, deferred and failure paths;
- upload the report remotely to `${UK_AQ_DROPBOX_ROOT}/who_2021/` through Dropbox.

### Phase 7.3 GitHub Actions workflow

The workflow must map:

- the existing Obs AQI DB and R2 secrets;
- the Dropbox credential identified during inspection;
- `UK_AQ_DROPBOX_ROOT` from non-secret repository configuration.

The report must be uploaded to Dropbox and retained as a GitHub Actions artefact with `if: always()`.

Deferred and unchanged outcomes remain successful. Genuine calculation, database, R2 publication or Dropbox report-upload failures remain non-zero.

### Phase 7.4 Cloudflare Scheduler

Retain the 04:00-09:00 UTC hourly schedule. Document it as an hourly recalculation and readiness window, not merely a retry window.

### Phase 7.5 minimal structural checks

Use only the main plan's minimal structural checks, plus one narrow Dropbox upload/path-construction check if the repository has no existing structural coverage for it.

Do not create a broad new test suite or mock R2/Dropbox system. Functional validation happens through real operation on TEST.

### Phase 7.6 real TEST validation

Confirm through real TEST operation that:

- both target days are recalculated;
- a prior successful hourly run does not suppress a later run;
- readiness deferral keeps the public summary on the correction day;
- correction-day output can still change while the latest day is deferred;
- unchanged R2 objects are not rewritten;
- changed R2 objects are replaced in the existing publication order;
- the Dropbox report appears under `${UK_AQ_DROPBOX_ROOT}/who_2021/`;
- the same report is retained as a GitHub Actions artefact;
- no secrets appear in logs or reports.

## 8. System documentation amendments

After implementation and real TEST validation, the authoritative `system_docs/` must document:

- the 04:00-09:00 UTC hourly recalculation and readiness window;
- recalculation of yesterday and the day before yesterday on every scheduled run;
- readiness, deferred, updated and unchanged semantics;
- change-aware R2 publication;
- Dropbox report upload to `${UK_AQ_DROPBOX_ROOT}/who_2021/`;
- GitHub Actions artefact retention as a secondary report copy.

## 9. Revised done criteria

The daily workflow part is complete when:

1. Every normal hourly run recalculates yesterday and the day before yesterday.
2. A prior successful run does not suppress later recalculation.
3. Readiness controls the current published `as_of_day_utc`, not whether private daily rows can be recalculated.
4. Individual daily validity remains based on at least 18 valid distinct hours and does not require that individual timeseries to contain the final midnight observation.
5. Unchanged R2 JSON and parquet objects are not rewritten.
6. Changed R2 objects replace the same stable keys in the existing publication order.
7. Every workflow attempt writes a bounded report.
8. Every report is uploaded through Dropbox to `${UK_AQ_DROPBOX_ROOT}/who_2021/` and retained as a GitHub Actions artefact.
9. The implementation uses minimal structural checks before real TEST operation.
10. The authoritative system documentation reflects the final behaviour.
