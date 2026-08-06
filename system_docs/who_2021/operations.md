# WHO 2021 operations

This runbook operates the behaviour defined by [`contract.md`](contract.md). It MUST NOT redefine the calculation or readiness rules.

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

## Deployment order for a readiness-contract change

The database RPC and worker configuration MUST be deployed in this order:

1. Apply the schema migration that changes the readiness RPC implementation.
2. Confirm the RPC exists with the unchanged worker-facing signature and service-role permission.
3. Merge or deploy the ops workflow configuration that supplies the 50% default.
4. Run the WHO daily workflow through normal TEST operation.
5. Inspect the real report before transferring the change to LIVE.

Deploying the workflow threshold before the RPC migration would lower the exact-midnight threshold without introducing the intended six-hour rule. That intermediate state MUST be avoided.

## Repository variable

The workflow works without creating a repository variable because the default is 0.5.

Create or change this variable only when an intentional environment-specific override is required:

```text
UK_AQ_WHO_2021_MIN_RECENT_WINDOW_COVERAGE_RATIO
```

Values are ratios from 0 to 1. The normal contract value is 0.5.

Do not restore or rely on the old repository variable `UK_AQ_WHO_2021_MIN_FINAL_HOUR_COVERAGE_RATIO` for this workflow. The old name remains only as the runtime environment and RPC compatibility surface described in [`interfaces.md`](interfaces.md).

## Pre-deployment structural validation

Before applying the migration:

- confirm the replacement function compiles against the TEST Obs AQI DB inside a transaction that is rolled back;
- confirm its identity arguments and return fields remain compatible with the worker;
- confirm execution remains restricted to `service_role`;
- confirm the workflow YAML parses and maps the recent-window repository variable to the legacy runtime environment name;
- confirm no rolling-year `is_final` column or payload field has been introduced.

No broad speculative test suite is required before deployment.

## TEST operational validation

After the schema migration and workflow change are deployed to TEST, run the normal WHO daily workflow.

The report SHOULD show:

- one readiness row for PM2.5, PM10 and NO2 for each checked day;
- the legacy `final_hour_timeseries_count` and `final_hour_coverage_ratio` fields populated from final-six-hour coverage;
- `pollutant_ready=true` when at least 50% of eligible timeseries has a valid recent-window reading;
- the latest complete day using `obs_aqidb` when all pollutants pass;
- the correction day still recalculated;
- the newest usable day selected as `publication_as_of_day_utc`;
- rolling-year and calendar-year summary refresh completing when enabled;
- no rolling-year finality field.

For the previously blocked 5 August 2026 case, the known final-six-hour coverage was well above 50% for all three pollutants, so a comparable data state should pass the new operational gate even when an exact midnight NO2 reading is absent for some stations.

## Failure interpretation

A failed readiness row now means fewer than the configured proportion of eligible timeseries had any valid reading in the final six hours. It no longer means the exact midnight reading was absent.

When readiness fails:

- inspect all pollutant counts and ratios;
- inspect whether the exact-day R2 fallback was available and usable;
- do not infer scientific incompleteness solely from the readiness result;
- use daily `valid_hour_count`, `has_enough_data` and `not_enough_data` results for scientific completeness.

## Rollback

To roll back safely:

1. restore the previous readiness RPC implementation and its 0.9 default;
2. restore the workflow's previous exact-final-hour variable mapping and default;
3. run the next normal TEST workflow and inspect the report.

The database RPC and workflow configuration must be rolled back together. Rolling back only one side would leave the field meaning and configured threshold inconsistent.

No data-table rollback is required because this change does not add or remove WHO state columns. Recalculation through the normal correction-day process restores derived rows under the active rules.
