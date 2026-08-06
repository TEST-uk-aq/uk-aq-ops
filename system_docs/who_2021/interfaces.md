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

Because the RPC field names remain compatible, report consumers may continue to receive `final_hour_*` properties. Their values MUST be interpreted according to the final-six-hour meanings in this document.

The report MUST also identify:

- attempted and completed days;
- publication day;
- correction day;
- Obs AQI DB or R2 source selection;
- fallback failure reasons;
- daily, rolling-year and calendar-year row counts;
- summary and R2 publication outcome.
