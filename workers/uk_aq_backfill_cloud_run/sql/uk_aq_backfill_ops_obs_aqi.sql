-- Backfill ops metadata tables for Obs AQI DB.
-- Canonical location is the schema repo:
--   ../CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema/schemas/obs_aqi_db/uk_aq_backfill_ops_obs_aqi.sql
-- Keep this file in sync only as a convenience mirror.

create schema if not exists uk_aq_ops;

create table if not exists uk_aq_ops.backfill_runs (
  run_id uuid primary key,
  run_mode text not null check (run_mode in ('local_to_aqilevels', 'obs_aqi_to_r2', 'source_to_all')),
  trigger_mode text not null check (trigger_mode in ('manual', 'scheduler')),
  window_from_utc date not null,
  window_to_utc date not null,
  connector_filter integer[],
  dry_run boolean not null default false,
  force_replace boolean not null default false,
  status text not null check (status in ('in_progress', 'ok', 'error', 'dry_run', 'stubbed')),
  rows_read bigint not null default 0,
  rows_written_aqilevels bigint not null default 0,
  objects_written_r2 bigint not null default 0,
  checkpoint_json jsonb,
  error_json jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists backfill_runs_started_at_idx
  on uk_aq_ops.backfill_runs (started_at desc);

create table if not exists uk_aq_ops.backfill_run_days (
  id bigserial primary key,
  run_id uuid not null references uk_aq_ops.backfill_runs(run_id) on delete cascade,
  run_mode text not null check (run_mode in ('local_to_aqilevels', 'obs_aqi_to_r2', 'source_to_all')),
  day_utc date not null,
  connector_id integer not null,
  source_kind text not null check (source_kind in ('ingestdb', 'obs_aqidb', 'r2', 'api', 'download', 'manual_file', 'none')),
  status text not null check (status in ('planned', 'in_progress', 'complete', 'skipped', 'error', 'dry_run', 'stubbed')),
  rows_read bigint not null default 0,
  rows_written_aqilevels bigint not null default 0,
  objects_written_r2 bigint not null default 0,
  checkpoint_json jsonb,
  error_json jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists backfill_run_days_run_day_connector_source_uq
  on uk_aq_ops.backfill_run_days (run_id, day_utc, connector_id, source_kind);

create index if not exists backfill_run_days_lookup_idx
  on uk_aq_ops.backfill_run_days (run_mode, day_utc desc, connector_id);

create table if not exists uk_aq_ops.backfill_checkpoints (
  run_mode text not null check (run_mode in ('local_to_aqilevels', 'obs_aqi_to_r2', 'source_to_all')),
  day_utc date not null,
  connector_id integer not null,
  source_kind text not null check (source_kind in ('ingestdb', 'obs_aqidb', 'r2', 'api', 'download', 'manual_file', 'none')),
  status text not null check (status in ('complete', 'error', 'dry_run', 'skipped')),
  rows_read bigint not null default 0,
  rows_written_aqilevels bigint not null default 0,
  objects_written_r2 bigint not null default 0,
  checkpoint_json jsonb,
  error_json jsonb,
  updated_at timestamptz not null default now(),
  primary key (run_mode, day_utc, connector_id)
);

create index if not exists backfill_checkpoints_day_connector_idx
  on uk_aq_ops.backfill_checkpoints (day_utc desc, connector_id);

create table if not exists uk_aq_ops.backfill_errors (
  id bigserial primary key,
  run_id uuid,
  run_mode text not null check (run_mode in ('local_to_aqilevels', 'obs_aqi_to_r2', 'source_to_all')),
  day_utc date,
  connector_id integer,
  source_kind text,
  error_json jsonb not null,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists backfill_errors_run_idx
  on uk_aq_ops.backfill_errors (run_id, created_at desc);

alter table uk_aq_ops.backfill_runs enable row level security;
alter table uk_aq_ops.backfill_run_days enable row level security;
alter table uk_aq_ops.backfill_checkpoints enable row level security;
alter table uk_aq_ops.backfill_errors enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'uk_aq_ops'
      and tablename = 'backfill_runs'
      and policyname = 'backfill_runs_service_role'
  ) then
    create policy backfill_runs_service_role
      on uk_aq_ops.backfill_runs
      for all
      using (auth.role() = 'service_role')
      with check (auth.role() = 'service_role');
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'uk_aq_ops'
      and tablename = 'backfill_run_days'
      and policyname = 'backfill_run_days_service_role'
  ) then
    create policy backfill_run_days_service_role
      on uk_aq_ops.backfill_run_days
      for all
      using (auth.role() = 'service_role')
      with check (auth.role() = 'service_role');
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'uk_aq_ops'
      and tablename = 'backfill_checkpoints'
      and policyname = 'backfill_checkpoints_service_role'
  ) then
    create policy backfill_checkpoints_service_role
      on uk_aq_ops.backfill_checkpoints
      for all
      using (auth.role() = 'service_role')
      with check (auth.role() = 'service_role');
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'uk_aq_ops'
      and tablename = 'backfill_errors'
      and policyname = 'backfill_errors_service_role'
  ) then
    create policy backfill_errors_service_role
      on uk_aq_ops.backfill_errors
      for all
      using (auth.role() = 'service_role')
      with check (auth.role() = 'service_role');
  end if;
end $$;

grant usage on schema uk_aq_ops to service_role;
grant all on table uk_aq_ops.backfill_runs to service_role;
grant all on table uk_aq_ops.backfill_run_days to service_role;
grant all on table uk_aq_ops.backfill_checkpoints to service_role;
grant all on table uk_aq_ops.backfill_errors to service_role;
grant usage, select on all sequences in schema uk_aq_ops to service_role;
