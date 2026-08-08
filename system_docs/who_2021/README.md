# WHO 2021 derived data

This area defines the authoritative cross-repository behaviour for calculating, publishing and operating the UK AQ WHO 2021 derived-data products.

The system documentation lives in `uk-aq-ops` even where canonical database functions and table structures are owned by `uk-aq-schema`.

## Reading order

1. [`../README.md`](../README.md)
2. [`../documentation_contract.md`](../documentation_contract.md)
3. [`contract.md`](contract.md)
4. [`interfaces.md`](interfaces.md)
5. [`operations.md`](operations.md)
6. [`../cache_proxy/who-summary-contract.md`](../cache_proxy/who-summary-contract.md) for public homepage delivery and cache behaviour

## Current authoritative scope

This area owns:

- WHO 2021 daily station-timeseries eligibility and completeness rules;
- the weak operational readiness gate used before the latest day is calculated from Obs AQI DB;
- correction-day recalculation;
- rolling 365-day and last-complete-calendar-year summaries;
- the meaning of rolling-year provisional status;
- normal daily source priority between Obs AQI DB and exact-day R2 fallback;
- backfill source selection across the validated R2 and Obs AQI DB storage boundary, including the following-day `00:00` hour-ending observation;
- the distinction between an R2 partition that is absent and an R2 partition that exists but fails integrity validation;
- summary and derived Parquet publication ordering;
- the worker-to-database RPC and configuration contract.

The public homepage route, Worker caching and browser fallback behaviour are owned by [`../cache_proxy/who-summary-contract.md`](../cache_proxy/who-summary-contract.md).

## Implementation ownership

The active worker and workflow are primarily in `TEST-uk-aq/uk-aq-ops`:

- `.github/workflows/uk_aq_who_2021_daily.yml`;
- `workers/uk_aq_who_2021_daily/main.ts`;
- `workers/uk_aq_who_2021_daily/who_2021_daily_core.ts`;
- supporting R2, Parquet, report and RPC-client modules in the same worker directory.

Canonical tables, functions, permissions and migrations are owned by `TEST-uk-aq/uk-aq-schema`, including `uk_aq_public.uk_aq_rpc_who_2021_readiness_check(...)`.

## Change ownership

Codex and other coding agents must treat this area as read-only authority. They may inspect and cite these files and may change implementation in the owning repositories, but must not edit any file under `system_docs/`. Behavioural changes require a handover to ChatGPT for any necessary contract update.
