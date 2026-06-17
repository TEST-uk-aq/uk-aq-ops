create schema if not exists uk_aq_ops;
create schema if not exists uk_aq_public;

create table if not exists uk_aq_ops.chart_load_metrics (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  page_name text not null,
  page_view_id uuid not null,
  request_group_id uuid not null,
  session_id uuid,
  load_reason text not null check (
    load_reason in ('initial', 'station_change', 'timescale_change', 'pollutant_change', 'refresh')
  ),
  station_id bigint,
  timeseries_id bigint,
  station_label text,
  pollutant text,
  window_label text,
  success boolean not null,
  error_stage text,
  error_message text,
  total_load_ms integer check (total_load_ms is null or total_load_ms >= 0),
  time_to_first_obs_response_ms integer check (
    time_to_first_obs_response_ms is null or time_to_first_obs_response_ms >= 0
  ),
  time_to_first_obs_render_ms integer check (
    time_to_first_obs_render_ms is null or time_to_first_obs_render_ms >= 0
  ),
  time_to_obs_complete_ms integer check (
    time_to_obs_complete_ms is null or time_to_obs_complete_ms >= 0
  ),
  time_to_aqi_complete_ms integer check (
    time_to_aqi_complete_ms is null or time_to_aqi_complete_ms >= 0
  ),
  time_to_chart_ready_ms integer check (
    time_to_chart_ready_ms is null or time_to_chart_ready_ms >= 0
  ),
  cache_session_init_ms integer check (
    cache_session_init_ms is null or cache_session_init_ms >= 0
  ),
  turnstile_ms integer check (turnstile_ms is null or turnstile_ms >= 0),
  obs_chunk_count integer check (obs_chunk_count is null or obs_chunk_count >= 0),
  obs_network_request_count integer check (
    obs_network_request_count is null or obs_network_request_count >= 0
  ),
  obs_total_points integer check (obs_total_points is null or obs_total_points >= 0),
  obs_used_local_cache boolean,
  obs_used_etag boolean,
  obs_received_304 boolean,
  obs_cache_mode text,
  aqi_supported boolean,
  aqi_network_request_count integer check (
    aqi_network_request_count is null or aqi_network_request_count >= 0
  ),
  aqi_total_points integer check (aqi_total_points is null or aqi_total_points >= 0),
  aqi_used_local_cache boolean,
  aqi_received_304 boolean,
  cache_session_was_warm boolean,
  overall_cache_class text,
  network_effective_type text,
  device_memory_gb numeric(8, 2) check (device_memory_gb is null or device_memory_gb >= 0),
  hardware_concurrency integer check (
    hardware_concurrency is null or hardware_concurrency >= 0
  ),
  app_version text,
  constraint chart_load_metrics_obs_cache_mode_check check (
    obs_cache_mode is null
    or obs_cache_mode in ('local_only', 'local_plus_refresh', 'network_full', 'network_chunked', 'unknown')
  ),
  constraint chart_load_metrics_overall_cache_class_check check (
    overall_cache_class is null
    or overall_cache_class in ('cold', 'warm_local', 'warm_http_304', 'mixed', 'bypass', 'unknown')
  )
);

create index if not exists chart_load_metrics_created_at_idx
  on uk_aq_ops.chart_load_metrics (created_at desc);

create index if not exists chart_load_metrics_reason_created_at_idx
  on uk_aq_ops.chart_load_metrics (load_reason, created_at desc);

create index if not exists chart_load_metrics_window_created_at_idx
  on uk_aq_ops.chart_load_metrics (window_label, created_at desc);

create index if not exists chart_load_metrics_pollutant_created_at_idx
  on uk_aq_ops.chart_load_metrics (pollutant, created_at desc);

create index if not exists chart_load_metrics_success_created_at_idx
  on uk_aq_ops.chart_load_metrics (success, created_at desc);

create index if not exists chart_load_metrics_cache_class_created_at_idx
  on uk_aq_ops.chart_load_metrics (overall_cache_class, created_at desc);

create index if not exists chart_load_metrics_station_series_created_at_idx
  on uk_aq_ops.chart_load_metrics (station_id, timeseries_id, created_at desc);

create table if not exists uk_aq_ops.chart_load_metrics_daily (
  day_utc date not null,
  load_reason text not null,
  window_label text,
  pollutant text,
  success boolean not null,
  overall_cache_class text,
  sample_count bigint not null check (sample_count >= 0),
  avg_total_load_ms numeric,
  avg_time_to_first_obs_response_ms numeric,
  avg_time_to_first_obs_render_ms numeric,
  avg_time_to_obs_complete_ms numeric,
  avg_time_to_aqi_complete_ms numeric,
  avg_time_to_chart_ready_ms numeric,
  avg_obs_chunk_count numeric,
  avg_obs_network_request_count numeric,
  avg_obs_total_points numeric,
  avg_aqi_network_request_count numeric,
  avg_aqi_total_points numeric,
  pct_obs_used_local_cache numeric,
  pct_aqi_used_local_cache numeric,
  pct_obs_received_304 numeric,
  pct_cache_session_was_warm numeric,
  updated_at timestamptz not null default now(),
  constraint chart_load_metrics_daily_load_reason_check check (
    load_reason in ('initial', 'station_change', 'timescale_change', 'pollutant_change', 'refresh')
  ),
  constraint chart_load_metrics_daily_overall_cache_class_check check (
    overall_cache_class is null
    or overall_cache_class in ('cold', 'warm_local', 'warm_http_304', 'mixed', 'bypass', 'unknown')
  ),
  constraint chart_load_metrics_daily_pct_obs_local_cache_check check (
    pct_obs_used_local_cache is null or (pct_obs_used_local_cache >= 0 and pct_obs_used_local_cache <= 100)
  ),
  constraint chart_load_metrics_daily_pct_aqi_local_cache_check check (
    pct_aqi_used_local_cache is null or (pct_aqi_used_local_cache >= 0 and pct_aqi_used_local_cache <= 100)
  ),
  constraint chart_load_metrics_daily_pct_obs_304_check check (
    pct_obs_received_304 is null or (pct_obs_received_304 >= 0 and pct_obs_received_304 <= 100)
  ),
  constraint chart_load_metrics_daily_pct_session_warm_check check (
    pct_cache_session_was_warm is null or (pct_cache_session_was_warm >= 0 and pct_cache_session_was_warm <= 100)
  )
);

create unique index if not exists chart_load_metrics_daily_dim_uidx
  on uk_aq_ops.chart_load_metrics_daily (
    day_utc,
    load_reason,
    window_label,
    pollutant,
    success,
    overall_cache_class
  ) nulls not distinct;

create index if not exists chart_load_metrics_daily_day_idx
  on uk_aq_ops.chart_load_metrics_daily (day_utc desc, load_reason, success);

drop function if exists uk_aq_public.uk_aq_rpc_chart_load_metrics_insert(jsonb);
create or replace function uk_aq_public.uk_aq_rpc_chart_load_metrics_insert(
  p_metric jsonb
)
returns table (rows_inserted int)
language plpgsql
security definer
set search_path = uk_aq_ops, public, pg_catalog
as $$
declare
  v_rows int := 0;
  v_page_name text;
  v_page_view_id uuid;
  v_request_group_id uuid;
  v_session_id uuid;
  v_load_reason text;
  v_station_id bigint;
  v_timeseries_id bigint;
  v_station_label text;
  v_pollutant text;
  v_window_label text;
  v_success boolean;
  v_error_stage text;
  v_error_message text;
  v_total_load_ms integer;
  v_time_to_first_obs_response_ms integer;
  v_time_to_first_obs_render_ms integer;
  v_time_to_obs_complete_ms integer;
  v_time_to_aqi_complete_ms integer;
  v_time_to_chart_ready_ms integer;
  v_cache_session_init_ms integer;
  v_turnstile_ms integer;
  v_obs_chunk_count integer;
  v_obs_network_request_count integer;
  v_obs_total_points integer;
  v_obs_used_local_cache boolean;
  v_obs_used_etag boolean;
  v_obs_received_304 boolean;
  v_obs_cache_mode text;
  v_aqi_supported boolean;
  v_aqi_network_request_count integer;
  v_aqi_total_points integer;
  v_aqi_used_local_cache boolean;
  v_aqi_received_304 boolean;
  v_cache_session_was_warm boolean;
  v_overall_cache_class text;
  v_network_effective_type text;
  v_device_memory_gb numeric(8, 2);
  v_hardware_concurrency integer;
  v_app_version text;
begin
  set local timezone = 'UTC';

  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  if p_metric is null or jsonb_typeof(p_metric) <> 'object' then
    raise exception 'p_metric must be a json object';
  end if;

  v_page_name := coalesce(nullif(btrim(p_metric->>'page_name'), ''), 'uk_aq_stations_chart');
  v_page_view_id := nullif(btrim(p_metric->>'page_view_id'), '')::uuid;
  v_request_group_id := nullif(btrim(p_metric->>'request_group_id'), '')::uuid;
  v_session_id := nullif(btrim(p_metric->>'session_id'), '')::uuid;
  v_load_reason := coalesce(nullif(btrim(p_metric->>'load_reason'), ''), 'refresh');
  v_station_id := nullif(btrim(p_metric->>'station_id'), '')::bigint;
  v_timeseries_id := nullif(btrim(p_metric->>'timeseries_id'), '')::bigint;
  v_station_label := nullif(btrim(p_metric->>'station_label'), '');
  v_pollutant := nullif(btrim(p_metric->>'pollutant'), '');
  v_window_label := nullif(btrim(p_metric->>'window_label'), '');
  v_success := (p_metric->>'success')::boolean;
  v_error_stage := nullif(btrim(p_metric->>'error_stage'), '');
  v_error_message := nullif(btrim(p_metric->>'error_message'), '');
  v_total_load_ms := nullif(btrim(p_metric->>'total_load_ms'), '')::integer;
  v_time_to_first_obs_response_ms := nullif(btrim(p_metric->>'time_to_first_obs_response_ms'), '')::integer;
  v_time_to_first_obs_render_ms := nullif(btrim(p_metric->>'time_to_first_obs_render_ms'), '')::integer;
  v_time_to_obs_complete_ms := nullif(btrim(p_metric->>'time_to_obs_complete_ms'), '')::integer;
  v_time_to_aqi_complete_ms := nullif(btrim(p_metric->>'time_to_aqi_complete_ms'), '')::integer;
  v_time_to_chart_ready_ms := nullif(btrim(p_metric->>'time_to_chart_ready_ms'), '')::integer;
  v_cache_session_init_ms := nullif(btrim(p_metric->>'cache_session_init_ms'), '')::integer;
  v_turnstile_ms := nullif(btrim(p_metric->>'turnstile_ms'), '')::integer;
  v_obs_chunk_count := nullif(btrim(p_metric->>'obs_chunk_count'), '')::integer;
  v_obs_network_request_count := nullif(btrim(p_metric->>'obs_network_request_count'), '')::integer;
  v_obs_total_points := nullif(btrim(p_metric->>'obs_total_points'), '')::integer;
  v_obs_used_local_cache := nullif(btrim(p_metric->>'obs_used_local_cache'), '')::boolean;
  v_obs_used_etag := nullif(btrim(p_metric->>'obs_used_etag'), '')::boolean;
  v_obs_received_304 := nullif(btrim(p_metric->>'obs_received_304'), '')::boolean;
  v_obs_cache_mode := nullif(btrim(p_metric->>'obs_cache_mode'), '');
  v_aqi_supported := nullif(btrim(p_metric->>'aqi_supported'), '')::boolean;
  v_aqi_network_request_count := nullif(btrim(p_metric->>'aqi_network_request_count'), '')::integer;
  v_aqi_total_points := nullif(btrim(p_metric->>'aqi_total_points'), '')::integer;
  v_aqi_used_local_cache := nullif(btrim(p_metric->>'aqi_used_local_cache'), '')::boolean;
  v_aqi_received_304 := nullif(btrim(p_metric->>'aqi_received_304'), '')::boolean;
  v_cache_session_was_warm := nullif(btrim(p_metric->>'cache_session_was_warm'), '')::boolean;
  v_overall_cache_class := nullif(btrim(p_metric->>'overall_cache_class'), '');
  v_network_effective_type := nullif(btrim(p_metric->>'network_effective_type'), '');
  v_device_memory_gb := nullif(btrim(p_metric->>'device_memory_gb'), '')::numeric(8, 2);
  v_hardware_concurrency := nullif(btrim(p_metric->>'hardware_concurrency'), '')::integer;
  v_app_version := nullif(btrim(p_metric->>'app_version'), '');

  if v_page_view_id is null then
    raise exception 'page_view_id is required';
  end if;

  if v_request_group_id is null then
    raise exception 'request_group_id is required';
  end if;

  if v_success is null then
    raise exception 'success is required';
  end if;

  if v_load_reason not in ('initial', 'station_change', 'timescale_change', 'pollutant_change', 'refresh') then
    raise exception 'invalid load_reason: %', v_load_reason;
  end if;

  if v_obs_cache_mode is not null and v_obs_cache_mode not in (
    'local_only',
    'local_plus_refresh',
    'network_full',
    'network_chunked',
    'unknown'
  ) then
    raise exception 'invalid obs_cache_mode: %', v_obs_cache_mode;
  end if;

  if v_overall_cache_class is not null and v_overall_cache_class not in (
    'cold',
    'warm_local',
    'warm_http_304',
    'mixed',
    'bypass',
    'unknown'
  ) then
    raise exception 'invalid overall_cache_class: %', v_overall_cache_class;
  end if;

  if v_error_message is not null then
    v_error_message := left(v_error_message, 240);
  end if;

  insert into uk_aq_ops.chart_load_metrics (
    created_at,
    page_name,
    page_view_id,
    request_group_id,
    session_id,
    load_reason,
    station_id,
    timeseries_id,
    station_label,
    pollutant,
    window_label,
    success,
    error_stage,
    error_message,
    total_load_ms,
    time_to_first_obs_response_ms,
    time_to_first_obs_render_ms,
    time_to_obs_complete_ms,
    time_to_aqi_complete_ms,
    time_to_chart_ready_ms,
    cache_session_init_ms,
    turnstile_ms,
    obs_chunk_count,
    obs_network_request_count,
    obs_total_points,
    obs_used_local_cache,
    obs_used_etag,
    obs_received_304,
    obs_cache_mode,
    aqi_supported,
    aqi_network_request_count,
    aqi_total_points,
    aqi_used_local_cache,
    aqi_received_304,
    cache_session_was_warm,
    overall_cache_class,
    network_effective_type,
    device_memory_gb,
    hardware_concurrency,
    app_version
  )
  values (
    now(),
    v_page_name,
    v_page_view_id,
    v_request_group_id,
    v_session_id,
    v_load_reason,
    v_station_id,
    v_timeseries_id,
    v_station_label,
    v_pollutant,
    v_window_label,
    v_success,
    v_error_stage,
    v_error_message,
    v_total_load_ms,
    v_time_to_first_obs_response_ms,
    v_time_to_first_obs_render_ms,
    v_time_to_obs_complete_ms,
    v_time_to_aqi_complete_ms,
    v_time_to_chart_ready_ms,
    v_cache_session_init_ms,
    v_turnstile_ms,
    v_obs_chunk_count,
    v_obs_network_request_count,
    v_obs_total_points,
    v_obs_used_local_cache,
    v_obs_used_etag,
    v_obs_received_304,
    v_obs_cache_mode,
    v_aqi_supported,
    v_aqi_network_request_count,
    v_aqi_total_points,
    v_aqi_used_local_cache,
    v_aqi_received_304,
    v_cache_session_was_warm,
    v_overall_cache_class,
    v_network_effective_type,
    v_device_memory_gb,
    v_hardware_concurrency,
    v_app_version
  );

  get diagnostics v_rows = row_count;
  return query select v_rows;
end;
$$;

drop function if exists uk_aq_public.uk_aq_rpc_chart_load_metrics_cleanup(integer);
create or replace function uk_aq_public.uk_aq_rpc_chart_load_metrics_cleanup(
  p_retention_days integer default 90
)
returns table (rows_deleted bigint)
language plpgsql
security definer
set search_path = uk_aq_ops, public, pg_catalog
as $$
declare
  v_days integer;
  v_rows bigint := 0;
begin
  set local timezone = 'UTC';

  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  v_days := greatest(1, least(coalesce(p_retention_days, 90), 3650));

  delete from uk_aq_ops.chart_load_metrics
  where created_at < now() - make_interval(days => v_days);

  get diagnostics v_rows = row_count;
  return query select v_rows;
end;
$$;

drop function if exists uk_aq_public.uk_aq_rpc_chart_load_metrics_daily_refresh(integer);
create or replace function uk_aq_public.uk_aq_rpc_chart_load_metrics_daily_refresh(
  p_recent_days integer default 7
)
returns table (
  days_refreshed integer,
  refreshed_from_day_utc date,
  refreshed_to_day_utc date,
  rows_upserted bigint
)
language plpgsql
security definer
set search_path = uk_aq_ops, public, pg_catalog
as $$
declare
  v_days integer;
  v_today_utc date;
  v_from_day_utc date;
  v_to_day_utc date;
  v_rows bigint := 0;
begin
  set local timezone = 'UTC';

  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  v_days := greatest(1, least(coalesce(p_recent_days, 7), 31));
  v_today_utc := (now() at time zone 'UTC')::date;
  v_from_day_utc := v_today_utc - (v_days - 1);
  v_to_day_utc := v_today_utc;

  insert into uk_aq_ops.chart_load_metrics_daily (
    day_utc,
    load_reason,
    window_label,
    pollutant,
    success,
    overall_cache_class,
    sample_count,
    avg_total_load_ms,
    avg_time_to_first_obs_response_ms,
    avg_time_to_first_obs_render_ms,
    avg_time_to_obs_complete_ms,
    avg_time_to_aqi_complete_ms,
    avg_time_to_chart_ready_ms,
    avg_obs_chunk_count,
    avg_obs_network_request_count,
    avg_obs_total_points,
    avg_aqi_network_request_count,
    avg_aqi_total_points,
    pct_obs_used_local_cache,
    pct_aqi_used_local_cache,
    pct_obs_received_304,
    pct_cache_session_was_warm,
    updated_at
  )
  select
    (m.created_at at time zone 'UTC')::date as day_utc,
    m.load_reason,
    m.window_label,
    m.pollutant,
    m.success,
    m.overall_cache_class,
    count(*)::bigint as sample_count,
    avg(m.total_load_ms)::numeric as avg_total_load_ms,
    avg(m.time_to_first_obs_response_ms)::numeric as avg_time_to_first_obs_response_ms,
    avg(m.time_to_first_obs_render_ms)::numeric as avg_time_to_first_obs_render_ms,
    avg(m.time_to_obs_complete_ms)::numeric as avg_time_to_obs_complete_ms,
    avg(m.time_to_aqi_complete_ms)::numeric as avg_time_to_aqi_complete_ms,
    avg(m.time_to_chart_ready_ms)::numeric as avg_time_to_chart_ready_ms,
    avg(m.obs_chunk_count)::numeric as avg_obs_chunk_count,
    avg(m.obs_network_request_count)::numeric as avg_obs_network_request_count,
    avg(m.obs_total_points)::numeric as avg_obs_total_points,
    avg(m.aqi_network_request_count)::numeric as avg_aqi_network_request_count,
    avg(m.aqi_total_points)::numeric as avg_aqi_total_points,
    avg(case when m.obs_used_local_cache is true then 100::numeric else 0::numeric end) as pct_obs_used_local_cache,
    avg(case when m.aqi_used_local_cache is true then 100::numeric else 0::numeric end) as pct_aqi_used_local_cache,
    avg(case when m.obs_received_304 is true then 100::numeric else 0::numeric end) as pct_obs_received_304,
    avg(case when m.cache_session_was_warm is true then 100::numeric else 0::numeric end) as pct_cache_session_was_warm,
    now() as updated_at
  from uk_aq_ops.chart_load_metrics m
  where (m.created_at at time zone 'UTC')::date >= v_from_day_utc
    and (m.created_at at time zone 'UTC')::date <= v_to_day_utc
  group by
    (m.created_at at time zone 'UTC')::date,
    m.load_reason,
    m.window_label,
    m.pollutant,
    m.success,
    m.overall_cache_class
  on conflict (day_utc, load_reason, window_label, pollutant, success, overall_cache_class)
  do update set
    sample_count = excluded.sample_count,
    avg_total_load_ms = excluded.avg_total_load_ms,
    avg_time_to_first_obs_response_ms = excluded.avg_time_to_first_obs_response_ms,
    avg_time_to_first_obs_render_ms = excluded.avg_time_to_first_obs_render_ms,
    avg_time_to_obs_complete_ms = excluded.avg_time_to_obs_complete_ms,
    avg_time_to_aqi_complete_ms = excluded.avg_time_to_aqi_complete_ms,
    avg_time_to_chart_ready_ms = excluded.avg_time_to_chart_ready_ms,
    avg_obs_chunk_count = excluded.avg_obs_chunk_count,
    avg_obs_network_request_count = excluded.avg_obs_network_request_count,
    avg_obs_total_points = excluded.avg_obs_total_points,
    avg_aqi_network_request_count = excluded.avg_aqi_network_request_count,
    avg_aqi_total_points = excluded.avg_aqi_total_points,
    pct_obs_used_local_cache = excluded.pct_obs_used_local_cache,
    pct_aqi_used_local_cache = excluded.pct_aqi_used_local_cache,
    pct_obs_received_304 = excluded.pct_obs_received_304,
    pct_cache_session_was_warm = excluded.pct_cache_session_was_warm,
    updated_at = now();

  get diagnostics v_rows = row_count;

  delete from uk_aq_ops.chart_load_metrics_daily d
  where d.day_utc >= v_from_day_utc
    and d.day_utc <= v_to_day_utc
    and not exists (
      select 1
      from uk_aq_ops.chart_load_metrics m
      where (m.created_at at time zone 'UTC')::date = d.day_utc
        and m.load_reason = d.load_reason
        and m.window_label is not distinct from d.window_label
        and m.pollutant is not distinct from d.pollutant
        and m.success = d.success
        and m.overall_cache_class is not distinct from d.overall_cache_class
    );

  return query
  select
    v_days,
    v_from_day_utc,
    v_to_day_utc,
    v_rows;
end;
$$;

grant all on table uk_aq_ops.chart_load_metrics to service_role;
grant all on table uk_aq_ops.chart_load_metrics_daily to service_role;

revoke all on function uk_aq_public.uk_aq_rpc_chart_load_metrics_insert(jsonb) from public;
grant execute on function uk_aq_public.uk_aq_rpc_chart_load_metrics_insert(jsonb) to service_role;

revoke all on function uk_aq_public.uk_aq_rpc_chart_load_metrics_cleanup(integer) from public;
grant execute on function uk_aq_public.uk_aq_rpc_chart_load_metrics_cleanup(integer) to service_role;

revoke all on function uk_aq_public.uk_aq_rpc_chart_load_metrics_daily_refresh(integer) from public;
grant execute on function uk_aq_public.uk_aq_rpc_chart_load_metrics_daily_refresh(integer) to service_role;
