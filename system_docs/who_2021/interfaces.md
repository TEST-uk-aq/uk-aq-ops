# WHO 2021 interfaces

This document defines the worker-facing configuration and database interface meanings owned by the WHO 2021 system contract.

## Readiness RPC

The worker calls:

```text
uk_aq_public.uk_aq_rpc_who_2021_readiness_check
```

The RPC signature remains:

```sql
uk_aq_rpc_who_2021_readiness_check(
  p_as_of_day_utc date,
  p_connector_id integer,
  p_source_network_code text,
  p_pollutant_codes text[],
  p_min_final_hour_coverage_ratio double precision
)
```

The existing signature is retained to avoid breaking the deployed worker contract.

## Legacy field-name compatibility

The following input and output names are retained for compatibility even though the readiness rule now covers a six-hour window:

- `p_min_final_hour_coverage_ratio`;
- `final_hour_timeseries_count`;
- `final_hour_coverage_ratio`;
- `final_hour_observed_at`.

Their authoritative meanings are now:

| Legacy name | Current meaning |
|---|---|
| `p_min_final_hour_coverage_ratio` | Minimum proportion of eligible timeseries that must have at least one valid reading in the final six-hour window |
| `final_hour_timeseries_count` | Distinct eligible timeseries with at least one valid reading in the final six-hour window |
| `final_hour_coverage_ratio` | `final_hour_timeseries_count / eligible_timeseries_count` using the current six-hour meaning |
| `final_hour_observed_at` | Inclusive end of the final six-hour window, normally the next-day `00:00` hour-ending timestamp |

New implementation and documentation MUST NOT interpret these fields as exact-midnight-only coverage.

A future deliberate RPC version MAY introduce clearer recent-window field names. Until then, the legacy names are a compatibility surface and MUST remain stable.

## Readiness output

The RPC returns one row for every configured pollutant with:

- target day, connector and source network;
- pollutant code;
- eligible timeseries count;
- recent-window timeseries count through the legacy field name;
- recent-window coverage ratio through the legacy field name;
- window end timestamp through the legacy field name;
- per-pollutant readiness;
- all-pollutants readiness;
- whether a prior successful processing run covered the day.

The worker MUST derive overall readiness from all returned pollutant rows. An empty result MUST not be treated as ready.

## Backfill observation interfaces

Backfill source selection is defined by [`contract.md`](contract.md). Interface design MUST preserve that source authority.

When the target R2 top-level day manifest is absent and Obs AQI DB still contains the complete WHO observation window, the worker MAY use the existing daily database calculation path if that path preserves the same scientific day and completeness rules.

When the target day is authoritative in validated R2 but the following-day top-level R2 manifest is absent, the worker requires only the following `00:00` hour-ending boundary observations from Obs AQI DB. The implementation MUST first inspect existing database interfaces and reuse a suitable service-role interface if one already exists.

If a new database interface is genuinely required for the mixed-source boundary case:

- its canonical SQL and permissions MUST be owned by `TEST-uk-aq/uk-aq-schema`;
- it MUST be restricted to the minimum observation data needed for the WHO boundary calculation rather than exposing a broad raw-observation read surface without a separate contract decision;
- it MUST preserve connector, source-network and pollutant scoping;
- it MUST preserve service-role-only access unless a separate contract explicitly changes that security model;
- it MUST return enough identity information to combine each boundary observation with the correct WHO timeseries without ambiguity;
- it MUST NOT change the hour-ending timestamp convention or scientific completeness rules.

This document intentionally does not invent a new RPC name or signature before implementation inspection establishes whether a new interface is needed. A coding agent MUST stop for a decision rather than invent an architectural or schema contract that is not determined by the existing repositories.

## R2 missing-object interface meaning

R2 read errors MUST preserve enough structured information for the worker to distinguish an absent initial top-level day manifest from an integrity failure inside a declared partition.

The only missing object that may be interpreted as source unavailability is the initial top-level manifest being probed at:

```text
history/v2/observations/day_utc=<DAY>/manifest.json
```

This rule applies independently to the target day and the following boundary day.

Once the top-level day manifest has been read successfully, any missing referenced connector manifest, pollutant manifest or Parquet object is an integrity failure. It MUST NOT be converted into an Obs AQI DB fallback condition.

Fallback logic MUST use a typed or otherwise structured not-found condition. It MUST NOT depend on matching human-readable error strings.

## Workflow configuration

The GitHub Actions workflow MAY read this optional repository variable:

```text
UK_AQ_WHO_2021_MIN_RECENT_WINDOW_COVERAGE_RATIO
```

Its default is:

```text
0.5
```

The workflow maps that value into the legacy runtime environment variable expected by the current worker:

```text
UK_AQ_WHO_2021_MIN_FINAL_HOUR_COVERAGE_RATIO
```

The clearer repository variable exists because the configured meaning has materially changed from exact-final-hour coverage to recent-window coverage. The legacy runtime name remains only for compatibility with the current TypeScript configuration model and RPC payload.

The readiness gate enable switch remains:

```text
UK_AQ_WHO_2021_READINESS_GATE_ENABLED
```

It normally defaults to `true` for daily operation.

No new repository variable is required merely to distinguish R2 from Obs AQI DB during backfill. Source selection MUST derive from source availability and integrity unless a separately approved contract change introduces configuration.

## Scientific-completeness configuration

The readiness ratio MUST remain separate from:

```text
UK_AQ_WHO_2021_MIN_VALID_HOURS_PER_DAY
UK_AQ_WHO_2021_MIN_VALID_DAYS
```

Normal defaults are:

```text
UK_AQ_WHO_2021_MIN_VALID_HOURS_PER_DAY=18
UK_AQ_WHO_2021_MIN_VALID_DAYS=274
```

Changing the readiness ratio MUST NOT silently change either scientific-completeness threshold.

## Report contract

The run report MUST preserve per-day readiness evidence and daily source decisions.

Because the readiness RPC field names remain compatible, report consumers may continue to receive `final_hour_*` properties. Their values MUST be interpreted according to the final-six-hour meanings in this document.

The report MUST also identify:

- attempted and completed days;
- publication day;
- correction day;
- target-day observation source;
- following `00:00` boundary source when it differs from the target-day source;
- pure Obs AQI DB, pure R2, mixed R2/Obs AQI DB and unavailable/failed backfill cases in an unambiguous structured form;
- fallback or integrity-failure reasons;
- daily, rolling-year and calendar-year row counts;
- summary and R2 publication outcome.

Existing report fields SHOULD be preserved where they remain meaningful. If the existing `source` field is retained for target-day authority, a mixed-source backfill day MUST add an explicit boundary-source field or an equally clear structured representation. `source_mode` or equivalent summary fields MUST NOT claim that a backfill was R2-only when one or more days used Obs AQI DB or a mixed boundary.
