-- Exact current day counts for ObsAQIDB storage coverage and dashboard reads.
-- Apply in obs_aqidb.

create schema if not exists uk_aq_ops;
create schema if not exists uk_aq_public;
create extension if not exists pg_cron with schema extensions;

create table if not exists uk_aq_ops.obs_aqidb_day_counts_current (
  dataset text not null check (dataset in ('observs', 'aqilevels')),
  day_utc date not null,
  row_count bigint not null check (row_count >= 0),
  bucket_hour timestamptz not null,
  source text not null default 'uk_aq_obs_aqidb_day_counts_pg_cron',
  recorded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (dataset, day_utc)
);

create index if not exists obs_aqidb_day_counts_current_dataset_day_idx
  on uk_aq_ops.obs_aqidb_day_counts_current (dataset, day_utc desc);

create or replace view uk_aq_public.uk_aq_obs_aqidb_day_counts_current as
select
  dataset,
  day_utc,
  row_count,
  bucket_hour,
  source,
  recorded_at,
  created_at,
  updated_at
from uk_aq_ops.obs_aqidb_day_counts_current;

alter view if exists uk_aq_public.uk_aq_obs_aqidb_day_counts_current
  set (security_invoker = true);

create or replace function uk_aq_ops.uk_aq_obs_aqidb_day_counts_refresh_current(
  p_recorded_at timestamptz default now(),
  p_source text default 'uk_aq_obs_aqidb_day_counts_pg_cron'
)
returns table (
  rows_upserted int,
  rows_deleted bigint
)
language plpgsql
security definer
set search_path = uk_aq_ops, public, pg_catalog
as $$
declare
  v_bucket_hour timestamptz;
  v_rows_upserted int := 0;
  v_rows_deleted bigint := 0;
  v_source text;
begin
  set local timezone = 'UTC';
  set local statement_timeout = '15min';

  v_bucket_hour := date_trunc('hour', coalesce(p_recorded_at, now()));
  v_source := coalesce(nullif(btrim(p_source), ''), 'uk_aq_obs_aqidb_day_counts_pg_cron');

  with observs_counts as (
    select
      (o.observed_at at time zone 'UTC')::date as day_utc,
      count(*)::bigint as row_count
    from uk_aq_observs.observations o
    group by 1
  ),
  observs_days as (
    select generate_series(min(c.day_utc), max(c.day_utc), interval '1 day')::date as day_utc
    from observs_counts c
  ),
  observs_rows as (
    select
      'observs'::text as dataset,
      d.day_utc,
      coalesce(c.row_count, 0)::bigint as row_count
    from observs_days d
    left join observs_counts c using (day_utc)
  ),
  aqilevels_counts as (
    select
      (h.timestamp_hour_utc at time zone 'UTC')::date as day_utc,
      count(*)::bigint as row_count
    from uk_aq_aqilevels.timeseries_aqi_hourly h
    group by 1
  ),
  aqilevels_days as (
    select generate_series(min(c.day_utc), max(c.day_utc), interval '1 day')::date as day_utc
    from aqilevels_counts c
  ),
  aqilevels_rows as (
    select
      'aqilevels'::text as dataset,
      d.day_utc,
      coalesce(c.row_count, 0)::bigint as row_count
    from aqilevels_days d
    left join aqilevels_counts c using (day_utc)
  ),
  source_rows as (
    select * from observs_rows
    union all
    select * from aqilevels_rows
  )
  insert into uk_aq_ops.obs_aqidb_day_counts_current (
    dataset,
    day_utc,
    row_count,
    bucket_hour,
    source,
    recorded_at,
    updated_at
  )
  select
    s.dataset,
    s.day_utc,
    s.row_count,
    v_bucket_hour,
    v_source,
    coalesce(p_recorded_at, now()),
    now()
  from source_rows s
  on conflict (dataset, day_utc) do update set
    row_count = excluded.row_count,
    bucket_hour = excluded.bucket_hour,
    source = excluded.source,
    recorded_at = excluded.recorded_at,
    updated_at = now();

  get diagnostics v_rows_upserted = row_count;

  with observs_counts as (
    select
      (o.observed_at at time zone 'UTC')::date as day_utc,
      count(*)::bigint as row_count
    from uk_aq_observs.observations o
    group by 1
  ),
  observs_days as (
    select generate_series(min(c.day_utc), max(c.day_utc), interval '1 day')::date as day_utc
    from observs_counts c
  ),
  observs_rows as (
    select 'observs'::text as dataset, d.day_utc
    from observs_days d
  ),
  aqilevels_counts as (
    select
      (h.timestamp_hour_utc at time zone 'UTC')::date as day_utc,
      count(*)::bigint as row_count
    from uk_aq_aqilevels.timeseries_aqi_hourly h
    group by 1
  ),
  aqilevels_days as (
    select generate_series(min(c.day_utc), max(c.day_utc), interval '1 day')::date as day_utc
    from aqilevels_counts c
  ),
  aqilevels_rows as (
    select 'aqilevels'::text as dataset, d.day_utc
    from aqilevels_days d
  ),
  source_rows as (
    select * from observs_rows
    union all
    select * from aqilevels_rows
  )
  delete from uk_aq_ops.obs_aqidb_day_counts_current t
  where not exists (
    select 1
    from source_rows s
    where s.dataset = t.dataset
      and s.day_utc = t.day_utc
  );

  get diagnostics v_rows_deleted = row_count;

  return query select v_rows_upserted, v_rows_deleted;
end;
$$;

create or replace function uk_aq_public.uk_aq_rpc_obs_aqidb_day_count_delete(
  p_dataset text,
  p_day_utc date
)
returns table (
  deleted_rows bigint
)
language plpgsql
security definer
set search_path = uk_aq_ops, public, pg_catalog
as $$
declare
  v_dataset text;
  v_deleted_rows bigint := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  v_dataset := lower(btrim(coalesce(p_dataset, '')));
  if v_dataset not in ('observs', 'aqilevels') then
    raise exception 'p_dataset must be observs or aqilevels';
  end if;

  if p_day_utc is null then
    raise exception 'p_day_utc is required';
  end if;

  delete from uk_aq_ops.obs_aqidb_day_counts_current
  where dataset = v_dataset
    and day_utc = p_day_utc;

  get diagnostics v_deleted_rows = row_count;

  return query select v_deleted_rows;
end;
$$;

grant all on table uk_aq_ops.obs_aqidb_day_counts_current to service_role;

revoke all on function uk_aq_ops.uk_aq_obs_aqidb_day_counts_refresh_current(timestamptz, text) from public;
grant execute on function uk_aq_ops.uk_aq_obs_aqidb_day_counts_refresh_current(timestamptz, text) to service_role;

revoke all on function uk_aq_public.uk_aq_rpc_obs_aqidb_day_count_delete(text, date) from public;
grant execute on function uk_aq_public.uk_aq_rpc_obs_aqidb_day_count_delete(text, date) to service_role;

revoke all on uk_aq_public.uk_aq_obs_aqidb_day_counts_current from public;
grant select on uk_aq_public.uk_aq_obs_aqidb_day_counts_current to authenticated;
grant select on uk_aq_public.uk_aq_obs_aqidb_day_counts_current to service_role;

select cron.unschedule(jobid)
from cron.job
where jobname in (
  'uk_aq_obs_aqidb_day_counts_current_hourly'
);

select cron.schedule(
  'uk_aq_obs_aqidb_day_counts_current_hourly',
  '55 * * * *',
  $$select * from uk_aq_ops.uk_aq_obs_aqidb_day_counts_refresh_current();$$
);

select cron.unschedule(jobid)
from cron.job
where jobname in (
  'uk_aq_obs_aqidb_day_counts_current_reconcile_daily'
);

select cron.schedule(
  'uk_aq_obs_aqidb_day_counts_current_reconcile_daily',
  '10 6 * * *',
  $$select * from uk_aq_ops.uk_aq_obs_aqidb_day_counts_refresh_current(
    p_source => 'uk_aq_obs_aqidb_day_counts_daily_reconcile_pg_cron'
  );$$
);
