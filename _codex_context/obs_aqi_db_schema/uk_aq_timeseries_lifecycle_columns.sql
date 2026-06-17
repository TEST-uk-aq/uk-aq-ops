-- Focused apply file for timeseries lifecycle columns.
-- Apply in both ingest DB and Obs AQI DB when needed.

alter table if exists uk_aq_core.timeseries
  add column if not exists last_catalog_seen_at timestamptz;

alter table if exists uk_aq_core.timeseries
  add column if not exists catalog_missing_runs integer not null default 0;

alter table if exists uk_aq_core.timeseries
  add column if not exists ended_at timestamptz;

update uk_aq_core.timeseries
set catalog_missing_runs = 0
where catalog_missing_runs is null;

create index if not exists timeseries_connector_ended_idx
  on uk_aq_core.timeseries(connector_id, ended_at);
