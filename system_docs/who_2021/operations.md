# WHO 2021 operations

This runbook operates the behaviour defined by [`contract.md`](contract.md). It MUST NOT redefine the calculation, readiness or source-authority rules.

## Normal daily operation

A normal daily workflow run:

1. resolves yesterday in UTC as the latest complete day;
2. includes the preceding correction day;
3. evaluates readiness separately for each configured pollutant and day;
4. uses Obs AQI DB when readiness passes;
5. attempts exact-day R2 v2 fallback when the database path is not usable;
6. selects the newest day with usable daily results as the publication day;
7. refreshes rolling-year and last-complete-calendar-year summaries when enabled;
8. writes enabled derived Parquet outputs before dated and latest summary JSON;
9. writes the bounded report and processing-run ledger.

## Backfill operation across the storage boundary

Backfill runs MUST be able to cross the point where older observations have reached R2 while newer observations remain in Obs AQI DB.

For each requested WHO day `D`, the worker should process the range chronologically and apply the source contract independently for that day:

1. probe the top-level R2 v2 observation manifest for `D`;
2. when it exists, validate and use R2 as the target-day authority;
3. when it is genuinely absent, use Obs AQI DB for the complete WHO day if the required observations are still available there;
4. when `D` comes from R2, resolve the required following `00:00` boundary independently;
5. use validated R2 for the boundary when the top-level `D+1` R2 day manifest exists;
6. when that initial `D+1` top-level manifest is genuinely absent, obtain the required `D+1 00:00` boundary observations from Obs AQI DB if available;
7. stop or report the day unavailable when neither authorised source path can provide the complete WHO window;
8. record the target and boundary source decisions clearly in the run report.

Changing the processing order to newest-first does not move raw observations into R2 and MUST NOT be used as a workaround for the D+1 storage-boundary case.

A top-level R2 day manifest that exists establishes R2 authority for that declared partition. Any missing referenced child manifest, missing referenced Parquet file, hash mismatch, coverage failure or other integrity failure is a hard R2 failure and MUST NOT be hidden by using Obs AQI DB.

## Deployment order for a readiness-contract change

The database RPC and worker configuration MUST be deployed in this order:

1. Apply the schema migration that changes the readiness RPC implementation.
2. Confirm the RPC exists with the unchanged worker-facing signature and service-role permission.
3. Merge or deploy the ops workflow configuration that supplies the 50% default.
4. Run the WHO daily workflow through normal TEST operation.
5. Inspect the real report before transferring the change to LIVE.

Deploying the workflow threshold before the RPC migration would lower the exact-midnight threshold without introducing the intended six-hour rule. That intermediate state MUST be avoided.

## Deployment order for a backfill source-selection change

Before implementation, inspect the existing worker and schema interfaces and determine whether the mixed R2/Obs AQI DB boundary can be implemented with an existing service-role database interface.

If no schema change is required:

1. deploy the worker/source-selection implementation to TEST;
2. run the real TEST backfill described below;
3. inspect the report and derived daily rows before any LIVE transfer.

If a new or changed database interface is required:

1. add the canonical migration in `TEST-uk-aq/uk-aq-schema`;
2. apply that migration to TEST and confirm the intended service-role permission and worker-facing shape;
3. deploy the dependent `uk-aq-ops` worker change;
4. run the real TEST backfill described below;
5. inspect the report and derived daily rows before any LIVE transfer.

Do not deploy a worker that depends on an unapplied schema interface.

## Repository variable

The workflow works without creating a repository variable because the readiness default is 0.5.

Create or change this variable only when an intentional environment-specific override is required:

```text
UK_AQ_WHO_2021_MIN_RECENT_WINDOW_COVERAGE_RATIO
```

Values are ratios from 0 to 1. The normal contract value is 0.5.

Do not restore or rely on the old repository variable `UK_AQ_WHO_2021_MIN_FINAL_HOUR_COVERAGE_RATIO` for this workflow. The old name remains only as the runtime environment and RPC compatibility surface described in [`interfaces.md`](interfaces.md).

Backfill source selection does not require an environment or repository variable merely to choose between R2 and Obs AQI DB. The choice is based on source availability and R2 integrity under the authoritative contract.

## Pre-deployment structural validation

For a readiness-contract migration, before applying the migration:

- confirm the replacement function compiles against the TEST Obs AQI DB inside a transaction that is rolled back;
- confirm its identity arguments and return fields remain compatible with the worker;
- confirm execution remains restricted to `service_role`;
- confirm the workflow YAML parses and maps the recent-window repository variable to the legacy runtime environment name;
- confirm no rolling-year `is_final` column or payload field has been introduced.

For a backfill source-selection change, before deployment:

- confirm the code can structurally distinguish absence of the initial top-level day manifest from failures after that manifest has established an R2 partition;
- confirm fallback does not rely on human-readable error-string matching;
- confirm existing R2 manifest, coverage, hash, Parquet and identity validation remains on the authoritative R2 path;
- confirm the target-day and following-boundary source decisions can be represented unambiguously in the report;
- if a database interface change is required, confirm its migration and permissions are structurally viable in TEST without exposing a broader raw-observation surface than required;
- confirm the WHO day still contains exactly the hour-ending window `01:00` through the following `00:00` and cannot duplicate the boundary into a 25th hour.

No broad speculative test suite is required before deployment. Functional validation belongs on the deployed TEST system through real operations.

## TEST operational validation for normal daily readiness

After the readiness schema migration and workflow change are deployed to TEST, run the normal WHO daily workflow.

The report SHOULD show:

- one readiness row for PM2.5, PM10 and NO2 for each checked day;
- the legacy `final_hour_timeseries_count` and `final_hour_coverage_ratio` fields populated from final-six-hour coverage;
- `pollutant_ready=true` when at least 50% of eligible timeseries has a valid recent-window reading;
- the latest complete day using `obs_aqidb` when all pollutants pass;
- the correction day still recalculated;
- the newest usable day selected as `publication_as_of_day_utc`;
- rolling-year and calendar-year summary refresh completing when enabled;
- no rolling-year finality field.

For the previously blocked 5 August 2026 case, the known final-six-hour coverage was well above 50% for all three pollutants, so a comparable data state should pass the operational gate even when an exact midnight NO2 reading is absent for some stations.

## TEST operational validation for the backfill crossover

After the backfill source-selection implementation is deployed to TEST, validate through a real backfill for:

```text
2026-08-01 through 2026-08-07
```

When the storage state is:

- 1 to 3 August present in validated R2;
- 4 to 7 August still present in Obs AQI DB and not yet represented by top-level R2 day manifests;
- the required 8 August `00:00` hour-ending observations available in Obs AQI DB;

the source decisions SHOULD resolve as:

- 1 August: validated R2 target day and validated R2 boundary;
- 2 August: validated R2 target day and validated R2 boundary;
- 3 August: validated R2 target day with the 4 August `00:00` boundary from Obs AQI DB;
- 4 to 7 August: full WHO day from Obs AQI DB while the target R2 top-level day manifest is absent.

These dates are a validation scenario, not hard-coded source rules. If pruning moves more of the range into R2 before validation, the expected source labels should move naturally with the actual storage state while preserving the same WHO results and integrity rules.

The report MUST distinguish the mixed 3 August case from pure R2 and pure Obs AQI DB days.

## Failure interpretation

A failed readiness row means fewer than the configured proportion of eligible timeseries had any valid reading in the final six hours. It does not mean the exact midnight reading was absent.

When normal daily readiness fails:

- inspect all pollutant counts and ratios;
- inspect whether the exact-day R2 fallback was available and usable;
- do not infer scientific incompleteness solely from the readiness result;
- use daily `valid_hour_count`, `has_enough_data` and `not_enough_data` results for scientific completeness.

When backfill source selection fails:

- first identify whether the failure occurred while probing the initial top-level R2 day manifest or after that manifest was read;
- an absent initial top-level manifest may legitimately lead to Obs AQI DB source selection;
- a failure after the top-level manifest exists is an R2 integrity problem and must not be interpreted as normal source fallback;
- inspect target-day and boundary-source fields separately for mixed transition days;
- if Obs AQI DB is also unavailable, report the day unavailable rather than weakening R2 validation.

## Rollback

### Readiness-contract rollback

To roll back a readiness-contract change safely:

1. restore the previous readiness RPC implementation and its 0.9 default;
2. restore the workflow's previous exact-final-hour variable mapping and default;
3. run the next normal TEST workflow and inspect the report.

The database RPC and workflow configuration must be rolled back together. Rolling back only one side would leave the field meaning and configured threshold inconsistent.

No data-table rollback is required because the readiness change does not add or remove WHO state columns. Recalculation through the normal correction-day process restores derived rows under the active rules.

### Backfill source-selection rollback

If the backfill change introduces only worker code, restore the previous worker implementation.

If it introduces a new database interface, roll back the dependent worker first and then remove or revert the database interface only when no deployed code depends on it.

A rollback MUST NOT modify or delete source observations or validated R2 history merely to restore the previous backfill behaviour.
