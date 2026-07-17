# Dashboard data sources

## Purpose

This file identifies the authoritative route and upstream source for each dashboard area. It prevents the front end, local backend and hosted Worker from drifting onto different data meanings.

## Main routes

| Route | Purpose | Primary source or owner |
|---|---|---|
| `GET /api/dashboard` | Main connector, dispatcher, pollutant freshness, DB trend and operational payload | Dashboard backend or direct Worker data adapters |
| `GET /api/storage_coverage` | Storage coverage calendar | Ingest DB day fingerprint, Obs AQI DB day coverage, version-selected R2 history API and Dropbox checkpoint |
| `GET /api/r2_metrics` | On-demand R2 account usage | Cloudflare account metrics API through the backend or Worker |
| `GET /api/r2_connector_counts` | R2 connector and day counts | DB/R2 metrics API history-counts endpoint |
| `GET /api/daily_task_runs` | Operations task rows where supported | Obs AQI DB daily task health views |
| `POST /api/connectors` | Connector polling settings | Ingest DB connector configuration |
| `POST /api/dispatcher_settings` | Dispatcher settings | Ingest DB dispatcher configuration |

## Panel ownership

| Dashboard panel | Authoritative data |
|---|---|
| Connector settings | `uk_aq_core.connectors`, exposed through the configured API schema |
| Dispatcher settings | `uk_aq_core.dispatcher_settings` |
| Dispatcher feed | ingest run records plus any explicitly derived in-flight state |
| PM2.5, PM10 and NO2 freshness | canonical timeseries, station, connector and observed-property relationships |
| DB size trend | DB/R2 metrics API, with explicitly documented database view fallbacks where still supported |
| Supabase endpoint egress | the configured endpoint-egress dashboard view |
| R2 usage bars | Cloudflare account metrics API |
| R2 history window and calendar | the selected `UK_AQ_R2_HISTORY_VERSION` history-days API and matching Dropbox checkpoint |
| Daily task runs | Obs AQI DB daily task health contract |
| Station snapshot | station snapshot v2 API routes and independent observation/AQI reads |

## R2 version rule

`UK_AQ_R2_HISTORY_VERSION` is the active selector and MUST be `v1` or `v2` where the runtime requires it. The deprecated `UK_AQ_R2_HISTORY_READ_VERSION` must not be restored as a second selector.

When v2 is selected, a missing v2 history source MUST NOT be hidden by silently substituting v1-derived coverage.

## Freshness semantics

Pollutant freshness is based on the canonical timeseries timestamp used by the active backend. Active-station rules may include connector-specific metadata, but must be applied consistently by local and hosted implementations.

A displayed placeholder or warning must remain distinguishable from a genuine zero or empty dataset.
