# WHO 2021 R2 observation backfill and recent-day fallback plan

**Date:** 24 July 2026  
**Primary repository:** `TEST-uk-aq/uk-aq-ops`  
**Schema repository:** `TEST-uk-aq/uk-aq-schema`  
**Plan type:** Additional implementation plan for the existing WHO 2021 workflow  
**Status:** Ready for Codex implementation after the Phase 1 structural contract check

## 1. Purpose

The existing WHO 2021 workflow can calculate daily status only from recent rows in `uk_aq_observs.observations`.

That is not sufficient for:

- a historical WHO daily-status backfill;
- a rolling 365-day calculation when older raw observations have been pruned from Obs AQI DB;
- a complete previous-calendar-year calculation;
- recent AURN recovery when the SOS gateway is unavailable but Integrity has restored the day from UK-AIR flat files into R2.

The required change is to make R2 v2 observations an authoritative input for historical backfill and a fallback input for recent daily processing.

The target data path is:

```text
R2 v2 observations
        ↓
per-timeseries/per-day WHO daily aggregates
        ↓
uk_aq_ops.who_2021_daily_status
        ↓
existing rolling-year and calendar-year summary RPC
        ↓
uk_aq_ops.who_2021_rolling_year_status
uk_aq_ops.who_2021_calendar_year_status
        ↓
existing WHO R2 parquet and public JSON publication
```

Raw R2 observations must not be copied into Supabase. Only the compact derived WHO daily rows are retained.

---

## 2. Relationship to the existing WHO plan

This is an additional plan. It does not replace the consolidated WHO implementation plan.

The following existing behaviour remains authoritative unless this plan explicitly changes it:

- AURN-only initial scope using connector `1`;
- pollutants `pm25`, `pm10` and `no2`;
- WHO 2021 guideline values;
- UTC storage and hour-ending daily windows;
- a valid daily mean requires at least 18 distinct valid hourly values;
- a rolling/calendar annual result requires at least 274 valid daily means;
- rolling and calendar calculations remain in the existing private database RPC;
- the public website remains R2-backed;
- WHO-derived R2 paths remain under `history/v2/who_2021/`;
- GitHub Actions is dispatched manually or by the Cloudflare Scheduler;
- no GCP service, Cloud Run service or GCP scheduler is introduced.

---

## 3. Decisions adopted by this plan

### 3.1 Backfill source

`run_mode=backfill` will mean:

```text
read raw observations from validated R2 v2 observation history
```

It will no longer call the Obs AQI DB raw-observation daily-refresh RPC for the requested historical range.

Normal `run_mode=daily` remains Obs AQI DB-first, with R2 as a recent-day fallback.

### 3.2 Source priority in daily mode

For each target day independently:

1. use Obs AQI DB when the existing readiness/source checks show that the day is usable;
2. otherwise use the matching validated R2 v2 observation day;
3. otherwise mark the day unavailable.

The worker must never select an unrestricted “latest R2 day”. It must read only the requested target day.

### 3.3 Initial historical range

The initial operational backfill should start at:

```text
2025-01-01
```

and finish at the latest complete validated AURN observation day available in R2.

This covers:

- the complete 2025 calendar year;
- the current rolling 365-day window;
- the historical daily-status display period already intended for UK AQ.

The date is an operational input, not a hard-coded application minimum.

### 3.4 Backfill size

A single workflow invocation may process at most 31 inclusive days.

The worker will process and commit one day at a time. Monthly manual ranges are therefore the normal initial-backfill unit.

This keeps each run bounded and idempotent while allowing a failed month to be resumed without repeating the whole historical period.

### 3.5 Summary refresh during historical loading

Historical backfill will populate `who_2021_daily_status` first.

By default, backfill runs will not:

- refresh rolling/calendar summary tables;
- publish summary JSON;
- write WHO-derived parquet.

A new explicit workflow input will control summary refresh:

```text
refresh_summaries
```

Recommended default:

```text
false for backfill
true for daily
```

After all monthly daily-status ranges have loaded, one final run will refresh rolling/calendar summaries as of the chosen latest complete day.

The implementation must not generate a separate historical rolling-year snapshot for every day in the initial backfill.

### 3.6 Failure behaviour

A requested R2 backfill day must fail closed when any required authority is absent or invalid, including:

- missing or invalid day manifest;
- missing connector `1` manifest;
- required `pm25`, `pm10` or `no2` pollutant manifest absent or invalid;
- referenced parquet object missing;
- parquet schema incompatible with the expected observation contract;
- manifest coverage marked partial or inconsistent;
- an observation timeseries ID cannot be resolved to the authoritative core/binding identity;
- duplicate or contradictory prepared daily rows.

Days already committed before a later failure remain valid and idempotent. The report must state the last completed day and the failed day.

### 3.7 Persistent database data

`uk_aq_ops.who_2021_daily_status` is the permanent compact derived history used by rolling and calendar calculations.

No new retention or pruning rule is introduced in this implementation.

Based on the current TEST shape of approximately 436 AURN pollutant timeseries per day, a backfill from 1 January 2025 to late July 2026 is expected to add approximately 248,000 daily rows and roughly 130–170 MB including indexes and PostgreSQL overhead.

---

## 4. Required targeted structural check before implementation

This is a genuinely necessary pre-implementation check, not a speculative test suite.

Codex must inspect one known-valid R2 v2 AURN day and confirm:

1. the exact day-manifest fields;
2. how the connector manifest is referenced;
3. how `pm25`, `pm10` and `no2` parquet keys are referenced;
4. whether object hashes or row counts are available and must be checked;
5. the exact observation parquet columns and types;
6. that `timeseries_id`, an observation timestamp and `value` are present;
7. whether the timestamp column is `observed_at_utc` or `observed_at`;
8. how partial or incomplete coverage is represented;
9. that sampled historical timeseries IDs still resolve through current `uk_aq_core` data or the stable v2 timeseries-binding objects.

Relevant existing implementation includes:

- `system_docs/r2_history/README.md`;
- `system_docs/r2_history/contract.md`;
- `system_docs/r2_history/integrity.md`;
- `system_docs/r2_history/validation.md`;
- `workers/uk_aq_observs_history_r2_api_worker/worker.mjs`;
- `workers/uk_aq_who_2021_daily/r2_objects.ts`;
- `workers/shared/uk_aq_r2_history_index.mjs`;
- existing Integrity and R2 writer code.

Codex must record the confirmed contract in its implementation summary.

If the real R2 layout materially contradicts this plan, Codex must stop after Phase 1 and report the conflict rather than inventing a new R2 format.

---

# Codex implementation phases

## Phase 1 — Confirm the R2 input and identity contracts

**Owner:** Codex  
**Recommended model:** GPT-5.6 Codex with High reasoning

### Tasks

1. Read `AGENTS.md` and the authoritative `system_docs`.
2. Perform the targeted structural check in section 4.
3. Identify the smallest existing R2 read/signing/parquet code that can be reused.
4. Confirm whether historical R2 `timeseries_id` values all resolve through current core tables.
5. Confirm the precise day and pollutant completeness gates required before a day may be used.
6. Confirm that the proposed one-day prepared-row RPC payload remains comfortably bounded for approximately 436 rows.
7. Record any necessary deviation before editing code.

### Structural completion criteria

- the R2 object and parquet input contract is explicitly recorded;
- the required columns and manifest fields are known;
- the identity-resolution path is known;
- direct signed R2 GETs from the GitHub Actions Deno runtime are structurally viable;
- no database, workflow, scheduler, R2 object or external service has been changed.

---

## Phase 2 — Add the private prepared daily-status upsert RPC

**Owner:** Codex  
**Repositories:** `TEST-uk-aq/uk-aq-schema`, then corresponding caller changes in `TEST-uk-aq/uk-aq-ops`

### Required database interface

Add a service-role-only RPC with a clear canonical name, recommended:

```text
uk_aq_public.uk_aq_rpc_who_2021_daily_status_upsert_prepared
```

The final name may follow the established schema naming conventions, but it must be used consistently in canonical SQL, migration SQL and ops defaults.

### Recommended inputs

```text
p_day_utc
p_connector_id
p_source_network_code
p_pollutant_codes
p_min_valid_hours_per_day
p_prepared_rows
p_dry_run
```

`p_prepared_rows` should be a bounded JSON array containing one row per R2 timeseries with usable daily input, for example:

```json
{
  "timeseries_id": 123,
  "valid_hour_count": 24,
  "daily_mean_ugm3": 8.42
}
```

The worker must not need to send repeated station labels, guideline values or other mutable core metadata.

### RPC responsibilities

The RPC must:

1. require `service_role`;
2. require one UTC day;
3. permit only the configured connector and supported pollutant set;
4. validate JSON shape, row count, uniqueness and numeric bounds;
5. reject unknown or mismatched timeseries IDs;
6. resolve eligible timeseries from authoritative core tables using the same historical-active rules as the existing daily refresh RPC;
7. create a row for every eligible timeseries, including `not_enough_data` rows where no valid prepared aggregate exists;
8. obtain WHO thresholds from `uk_aq_ops.who_guideline_values` for `WHO 2021`;
9. derive `has_enough_data`, completeness percentage, above/below state and status code in SQL;
10. upsert into `uk_aq_ops.who_2021_daily_status`;
11. preserve the existing logical primary key and idempotency;
12. return candidate, valid, insufficient-data and upsert counts;
13. support a no-write dry-run response.

### Schema files

Update the authoritative focused and combined Obs AQI DB SQL files and add an idempotent TEST migration.

Do not add a public table or expose raw R2 observations.

### Structural validation

Only perform:

- SQL structural review;
- function signature consistency checks;
- canonical/migration reference checks;
- repository formatting checks.

Do not apply the migration in this phase.

---

## Phase 3 — Add the direct R2 v2 observation reader

**Owner:** Codex  
**Repository:** `TEST-uk-aq/uk-aq-ops`

### Tasks

Create focused modules under:

```text
workers/uk_aq_who_2021_daily/
```

Responsibilities should be separated into:

- signed R2 GET/HEAD transport;
- manifest resolution and validation;
- parquet reading;
- WHO daily aggregation;
- prepared-RPC payload construction.

Reuse or safely extract existing logic where practical. Do not create a second incompatible interpretation of the R2 history layout.

### R2 read behaviour

For each requested day:

1. read and validate the v2 observation day manifest;
2. resolve and validate connector `1`;
3. resolve the required pollutant objects for `pm25`, `pm10` and `no2`;
4. read the referenced parquet objects sequentially;
5. verify available manifest row counts/hashes where the authority contract requires them;
6. reject partial or contradictory coverage.

### Daily aggregation rules

For day `D`, use the established hour-ending interval:

```text
(D 00:00 UTC, D+1 00:00 UTC]
```

The worker must:

- ignore null, non-finite and negative values;
- normalise timestamps to UTC;
- group duplicate source rows within the same timeseries/hour;
- use the mean of duplicates as the hourly value;
- count distinct valid hours;
- calculate the daily mean from valid hourly means;
- send a null daily mean where fewer than 18 valid hours exist;
- retain the existing `18`-hour threshold as a configurable value.

### Resource limits

Process one day and one pollutant object at a time.

Do not load a complete multi-month history into memory.

Add bounded retries for transient R2 reads, using existing retry conventions.

---

## Phase 4 — Make `backfill` an R2-backed daily-history mode

**Owner:** Codex  
**Repository:** `TEST-uk-aq/uk-aq-ops`

### Tasks

1. Route `run_mode=backfill` to the new R2 reader.
2. Require explicit start and end days.
3. Reject ranges longer than 31 inclusive days.
4. Process days in ascending order.
5. Upsert each completed day through the new prepared-row RPC.
6. Make repeated runs idempotent.
7. Do not use the Obs AQI DB raw-observation daily-refresh RPC in backfill mode.
8. Do not run the normal final-hour readiness gate in historical backfill mode.
9. Add an explicit `refresh_summaries` setting.
10. Default summary refresh and all WHO R2 output publication to off for backfill.
11. When `refresh_summaries=true`, run the existing rolling/calendar summary RPC once, using the backfill end day as `as_of_day_utc`.
12. Never run summary refresh once per backfilled day.

### Reporting

The bounded report must include:

```text
source_mode = r2_v2
requested_start_day_utc
requested_end_day_utc
completed_days
failed_day
daily_sources
manifest keys used
manifest/hash validation result
R2 object count
R2 bytes read
parquet row count
prepared daily row count
valid and insufficient-data counts
daily rows upserted
summary refresh requested/completed
```

Do not include secrets or full observation payloads.

---

## Phase 5 — Add R2 fallback to normal daily mode

**Owner:** Codex  
**Repository:** `TEST-uk-aq/uk-aq-ops`

### Required behaviour

Normal daily mode continues to target:

```text
yesterday
day before yesterday
```

For each target day independently:

1. evaluate whether Obs AQI DB is usable;
2. use the existing Obs AQI DB daily refresh when usable;
3. otherwise attempt the exact matching R2 v2 day;
4. if R2 is valid, calculate and upsert through the prepared-row RPC;
5. if neither source is usable, mark the day unavailable.

### Publication selection

Publish the newest target day that was successfully calculated and contains at least one valid timeseries-day.

If neither target day has valid data:

- leave the existing `latest_who_2021.json` unchanged;
- do not publish a new dated summary;
- report `operational_outcome=deferred`.

Do not fall back to an arbitrary older R2 date.

### Provenance

The report and processing-run summary must identify the source used for each day:

```text
obs_aqidb
r2_v2
unavailable
```

A prior successful run must not suppress recalculation.

---

## Phase 6 — Update workflow inputs, defaults and operational controls

**Owner:** Codex  
**Repository:** `TEST-uk-aq/uk-aq-ops`

### Workflow changes

Update `.github/workflows/uk_aq_who_2021_daily.yml` to support:

```text
refresh_summaries
```

Recommended UI/default behaviour:

| Mode | Refresh summaries | Publish JSON | Write WHO parquet |
|---|---:|---:|---:|
| `daily` | true | configured/explicit | configured/explicit |
| `backfill` | false by default | false by default | false by default |
| `dry_run` | false | false | false |

Keep the existing explicit start/end inputs.

### Timeout and concurrency

- retain one stable WHO concurrency group;
- do not allow daily and backfill writes to run concurrently;
- raise the maximum workflow timeout enough for a bounded 31-day backfill, recommended 45 minutes;
- a long manual backfill should be run outside the normal 04:00–09:00 UTC daily schedule window.

### Configuration

Prefer existing R2 variables and secrets:

```text
CFLARE_R2_ENDPOINT
CFLARE_R2_BUCKET
CFLARE_R2_REGION
CFLARE_R2_ACCESS_KEY_ID
CFLARE_R2_SECRET_ACCESS_KEY
```

Only add variables where a real implementation setting is required, recommended:

```text
UK_AQ_WHO_2021_R2_BACKFILL_MAX_DAYS=31
```

Do not add GCP configuration.

### Report retention

Preserve:

- Dropbox upload under `${UK_AQ_DROPBOX_ROOT}/who_2021/`;
- GitHub Actions artefact retention;
- fallback report creation for setup failures;
- non-zero failure when Dropbox upload fails.

---

## Phase 7 — Minimal structural validation and Codex handover

**Owner:** Codex

### Allowed pre-deployment validation

Perform only:

- Deno type-check of the affected entrypoints;
- workflow YAML parse;
- package/lock consistency;
- SQL signature and migration structure checks;
- manifest/parquet fixture shape check based on the real inspected R2 objects;
- report JSON serialisation and path construction;
- confirmation that no GCP implementation has been introduced.

Do not:

- create a broad speculative test suite;
- apply the database migration;
- dispatch a real workflow;
- write or modify R2;
- sync the Cloudflare Scheduler;
- edit `system_docs`;
- perform a large local historical calculation.

### Codex handover must state

- files changed;
- schema migration created;
- exact R2 contract used;
- exact source-selection logic;
- workflow inputs/defaults;
- maximum backfill range;
- known operational limits;
- commands for the first one-day TEST run;
- rollback steps.

---

# Mike and ChatGPT operational phases

## Phase 8 — Mike: apply and operate on TEST

**Owner:** Mike

### 8.1 Review and apply

1. Review and commit the schema and ops changes.
2. Apply the new schema migration to TEST Obs AQI DB.
3. Confirm repository variables and secrets already used by the WHO workflow remain available.
4. Do not enable or change the Cloudflare schedule yet.

### 8.2 First real one-day R2 backfill

Choose one known-valid R2 AURN day already repaired by Integrity.

Run:

```text
mode = backfill
trigger = manual
start day = selected day
end day = selected day
refresh summaries = false
publish summary JSON = false
write derived parquet = false
```

Operational acceptance evidence:

- manifest validation succeeds;
- R2 objects are read;
- prepared rows are non-zero;
- valid daily rows are non-zero where source data exists;
- the expected number of `who_2021_daily_status` rows is upserted;
- rerunning the same day is idempotent;
- Dropbox report exists;
- Actions artefact exists;
- no secrets appear in logs.

### 8.3 Initial historical load

Run monthly inclusive ranges beginning:

```text
2025-01-01
```

Continue through the latest complete validated AURN day in R2.

Use one month per invocation. Do not request a multi-month range.

If a month fails on a particular day:

1. correct or complete that R2 day through Integrity;
2. rerun from the failed day;
3. do not skip the gap silently.

### 8.4 Refresh summaries

After all daily ranges are present:

1. run a final backfill invocation ending on the chosen latest complete day with `refresh_summaries=true`;
2. keep JSON and parquet publication off for the first summary refresh;
3. inspect rolling valid-day counts and the completed 2025 calendar-year rows;
4. then run the normal daily workflow with publication enabled.

### 8.5 Current SOS outage recovery

For each recent day recovered from UK-AIR flat files:

1. run Integrity and verify the R2 day;
2. run the WHO R2 backfill for the same day or range;
3. refresh summaries after the gap is filled;
4. confirm subsequent daily mode can use R2 fallback while SOS remains unavailable.

### 8.6 Scheduler acceptance

Only after successful real TEST evidence:

1. run a normal daily workflow;
2. allow one Cloudflare-scheduled run;
3. confirm later hourly runs still recalculate;
4. confirm an unchanged R2 result is skipped;
5. confirm a changed integrity-repaired day is picked up through explicit backfill or the recent-day fallback.

---

## Phase 9 — ChatGPT: operational review, documentation and close-out

**Owner:** ChatGPT

After Mike supplies the real TEST reports/logs:

1. verify the first one-day backfill;
2. verify at least one idempotent rerun;
3. verify a monthly range;
4. verify rolling-year valid-day counts;
5. verify completed 2025 calendar-year rows;
6. verify one R2 recent-day fallback while Obs AQI DB is unavailable;
7. compare actual database growth with the estimated 130–170 MB historical increase;
8. identify any operational limits revealed by real runs;
9. update authoritative `system_docs`;
10. update the consolidated WHO plan to reference this completed implementation;
11. record final operational commands and rollback guidance.

Do not update `system_docs` before real TEST acceptance.

---

## 5. Rollback

### Code rollback

Revert the ops and schema commits.

The existing Obs AQI DB-only daily path can then be restored.

### Database rollback

The new RPC may remain unused without affecting current behaviour.

If the R2-derived daily rows are later shown to be incorrect, delete only the affected `who_2021_daily_status` date range through a reviewed TEST SQL operation, then refresh rolling/calendar summaries.

Do not drop the existing WHO tables.

### R2 rollback

Backfill mode should not write raw observations to R2.

WHO-derived JSON/parquet publication is disabled during the initial backfill, so no R2 rollback should be needed until final publication is explicitly enabled.

---

## 6. Codex starter prompts

### Phase 1 only

```text
Use GPT-5.6 Codex with High reasoning.

Work in TEST-uk-aq/uk-aq-ops and inspect TEST-uk-aq/uk-aq-schema where required.

Implement Phase 1 of:
plans/2026-07-23 WHO guideline limits/2026-07-24_WHO_2021_R2_backfill_and_recent_day_fallback_plan.md

This is the required structural contract check. Read AGENTS.md and authoritative system_docs first. Inspect one known-valid R2 v2 AURN observation day and record the actual manifest, parquet and timeseries-identity contracts. Do not change code, SQL, databases, workflows, scheduler configuration, R2 objects or system_docs. Stop and report if the real R2 contract materially conflicts with the plan.
```

### Codex implementation after Phase 1 confirms viability

```text
Use GPT-5.6 Codex with High reasoning.

Implement Codex Phases 2 to 7 of:
plans/2026-07-23 WHO guideline limits/2026-07-24_WHO_2021_R2_backfill_and_recent_day_fallback_plan.md

Work only in TEST-uk-aq/uk-aq-schema and TEST-uk-aq/uk-aq-ops. Follow each repository's AGENTS.md and authoritative system_docs.

Use the real R2 manifest/parquet contract confirmed in Phase 1. Keep pre-deployment validation structural and minimal. Do not apply migrations, dispatch workflows, sync the Cloudflare Scheduler, modify external services, write R2, or edit system_docs. Functional validation will happen afterwards through real TEST operations.
```
