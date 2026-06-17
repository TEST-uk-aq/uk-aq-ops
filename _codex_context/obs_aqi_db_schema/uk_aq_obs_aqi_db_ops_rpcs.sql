create schema if not exists uk_aq_public;
create extension if not exists pgcrypto;

drop function if exists uk_aq_public.uk_aq_rpc_observations_hourly_fingerprint(timestamptz, timestamptz);
create or replace function uk_aq_public.uk_aq_rpc_observations_hourly_fingerprint(
  window_start timestamptz,
  window_end timestamptz
)
returns table (
  connector_id integer,
  hour_start timestamptz,
  observation_count bigint,
  fingerprint text,
  min_observed_at timestamptz,
  max_observed_at timestamptz
)
language plpgsql
security definer
set search_path = uk_aq_observs, extensions, public, pg_catalog
as $$
begin
  set local timezone = 'UTC';

  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  if window_start is null or window_end is null then
    raise exception 'window_start and window_end are required';
  end if;

  if window_end <= window_start then
    raise exception 'window_end must be greater than window_start';
  end if;

  return query
  with row_hashes as (
    select
      o.connector_id,
      date_trunc('hour', o.observed_at) as hour_start,
      o.timeseries_id,
      o.observed_at,
      encode(
        digest(
          concat_ws(
            '|',
            o.connector_id::text,
            o.timeseries_id::text,
            to_char(o.observed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            coalesce(to_char(o.value, 'FM9999999990.999999999'), 'NULL')
          ),
          'sha256'
        ),
        'hex'
      ) as row_hash_hex
    from uk_aq_observs.observations o
    where o.observed_at >= window_start
      and o.observed_at < window_end
  )
  select
    r.connector_id,
    r.hour_start,
    count(*)::bigint as observation_count,
    encode(
      digest(
        string_agg(r.row_hash_hex, '' order by r.timeseries_id, r.observed_at),
        'sha256'
      ),
      'hex'
    ) as fingerprint,
    min(r.observed_at) as min_observed_at,
    max(r.observed_at) as max_observed_at
  from row_hashes r
  group by r.connector_id, r.hour_start
  order by r.hour_start, r.connector_id;
end;
$$;

drop function if exists uk_aq_public.uk_aq_rpc_observs_observations_upsert(jsonb);
drop function if exists uk_aq_public.uk_aq_rpc_station_aqi_hourly_source(
  timestamptz,
  timestamptz,
  bigint[]
);

drop function if exists uk_aq_public.uk_aq_rpc_observs_history_day_rows(
  date,
  integer,
  integer,
  timestamptz,
  integer
);
drop function if exists uk_aq_public.uk_aq_rpc_observs_timeseries_window(
  integer,
  integer,
  timestamptz,
  timestamptz,
  timestamptz,
  integer
);
create or replace function uk_aq_public.uk_aq_rpc_observs_history_day_rows(
  p_day_utc date,
  p_connector_id integer,
  p_after_timeseries_id integer default null,
  p_after_observed_at timestamptz default null,
  p_limit integer default 20000
)
returns table (
  timeseries_id integer,
  observed_at timestamptz,
  value double precision
)
language plpgsql
security definer
set search_path = uk_aq_observs, public, pg_catalog
as $$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_limit integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  if p_day_utc is null then
    raise exception 'p_day_utc is required';
  end if;

  if p_connector_id is null or p_connector_id <= 0 then
    raise exception 'p_connector_id must be > 0';
  end if;

  if (p_after_timeseries_id is null) <> (p_after_observed_at is null) then
    raise exception 'p_after_timeseries_id and p_after_observed_at must both be null or both provided';
  end if;

  v_limit := greatest(1, least(coalesce(p_limit, 20000), 100000));
  v_start := (p_day_utc::text || ' 00:00:00+00')::timestamptz;
  v_end := ((p_day_utc + 1)::text || ' 00:00:00+00')::timestamptz;

  return query
  select
    o.timeseries_id::integer,
    o.observed_at,
    o.value
  from uk_aq_observs.observations o
  where o.connector_id = p_connector_id
    and o.observed_at >= v_start
    and o.observed_at < v_end
    and (
      p_after_timeseries_id is null
      or o.timeseries_id > p_after_timeseries_id
      or (o.timeseries_id = p_after_timeseries_id and o.observed_at > p_after_observed_at)
    )
  order by o.timeseries_id asc, o.observed_at asc
  limit v_limit;
end;
$$;

create or replace function uk_aq_public.uk_aq_rpc_observs_timeseries_window(
  p_connector_id integer,
  p_timeseries_id integer,
  p_start_utc timestamptz,
  p_end_utc timestamptz,
  p_since_ts timestamptz default null,
  p_limit integer default null
)
returns table (
  observed_at timestamptz,
  value double precision
)
language plpgsql
security definer
set search_path = uk_aq_observs, public, pg_catalog
as $$
declare
  v_limit integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  if p_connector_id is null or p_connector_id <= 0 then
    raise exception 'p_connector_id must be > 0';
  end if;

  if p_timeseries_id is null or p_timeseries_id <= 0 then
    raise exception 'p_timeseries_id must be > 0';
  end if;

  if p_start_utc is null or p_end_utc is null then
    raise exception 'p_start_utc and p_end_utc are required';
  end if;

  if p_end_utc <= p_start_utc then
    raise exception 'p_end_utc must be greater than p_start_utc';
  end if;

  if p_limit is null then
    v_limit := 2147483647;
  else
    v_limit := greatest(1, least(p_limit, 100000));
  end if;

  return query
  select
    o.observed_at,
    o.value
  from uk_aq_observs.observations o
  where o.connector_id = p_connector_id
    and o.timeseries_id = p_timeseries_id
    and o.observed_at >= p_start_utc
    and o.observed_at < p_end_utc
    and (
      p_since_ts is null
      or o.observed_at > p_since_ts
    )
  order by o.observed_at asc
  limit v_limit;
end;
$$;

drop function if exists uk_aq_public.uk_aq_rpc_aqilevels_history_day_connector_counts(
  date,
  integer[]
);
create or replace function uk_aq_public.uk_aq_rpc_aqilevels_history_day_connector_counts(
  p_day_utc date,
  p_connector_ids integer[] default null
)
returns table (
  connector_id integer,
  row_count bigint
)
language plpgsql
security definer
set search_path = uk_aq_aqilevels, public, pg_catalog
as $$
declare
  v_start timestamptz;
  v_end timestamptz;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  if p_day_utc is null then
    raise exception 'p_day_utc is required';
  end if;

  v_start := (p_day_utc::text || ' 00:00:00+00')::timestamptz;
  v_end := ((p_day_utc + 1)::text || ' 00:00:00+00')::timestamptz;

  return query
  select
    h.connector_id::integer,
    count(*)::bigint as row_count
  from uk_aq_aqilevels.timeseries_aqi_hourly h
  where h.timestamp_hour_utc >= v_start
    and h.timestamp_hour_utc < v_end
    and h.connector_id is not null
    and h.connector_id > 0
    and (
      p_connector_ids is null
      or h.connector_id = any(p_connector_ids)
    )
  group by h.connector_id
  order by h.connector_id;
end;
$$;

drop function if exists uk_aq_public.uk_aq_rpc_aqilevels_history_day_rows(
  date,
  integer,
  bigint,
  timestamptz,
  integer
);
drop function if exists uk_aq_public.uk_aq_rpc_aqilevels_history_day_rows(
  date,
  integer,
  integer,
  timestamptz,
  integer
);
create or replace function uk_aq_public.uk_aq_rpc_aqilevels_history_day_rows(
  p_day_utc date,
  p_connector_id integer,
  p_after_timeseries_id integer default null,
  p_after_timestamp_hour_utc timestamptz default null,
  p_limit integer default 20000
)
returns table (
  connector_id integer,
  station_id bigint,
  timeseries_id integer,
  pollutant_code text,
  timestamp_hour_utc timestamptz,
  daqi_input_value_ugm3 double precision,
  daqi_input_averaging_code text,
  daqi_index_level smallint,
  daqi_source_observation_count smallint,
  daqi_required_observation_count smallint,
  daqi_calculation_status text,
  daqi_missing_reason text,
  eaqi_input_value_ugm3 double precision,
  eaqi_input_averaging_code text,
  eaqi_index_level smallint,
  eaqi_source_observation_count smallint,
  eaqi_required_observation_count smallint,
  eaqi_calculation_status text,
  eaqi_missing_reason text,
  hourly_sample_count smallint,
  algorithm_version text,
  computed_at_utc timestamptz,
  hourly_mean_ugm3 double precision,
  rolling24h_mean_ugm3 double precision,
  no2_hourly_mean_ugm3 double precision,
  pm25_hourly_mean_ugm3 double precision,
  pm10_hourly_mean_ugm3 double precision,
  pm25_rolling24h_mean_ugm3 double precision,
  pm10_rolling24h_mean_ugm3 double precision,
  daqi_no2_index_level smallint,
  daqi_pm25_rolling24h_index_level smallint,
  daqi_pm10_rolling24h_index_level smallint,
  eaqi_no2_index_level smallint,
  eaqi_pm25_index_level smallint,
  eaqi_pm10_index_level smallint,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = uk_aq_aqilevels, public, pg_catalog
as $$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_limit integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  if p_day_utc is null then
    raise exception 'p_day_utc is required';
  end if;

  if p_connector_id is null or p_connector_id <= 0 then
    raise exception 'p_connector_id must be > 0';
  end if;

  if (p_after_timeseries_id is null) <> (p_after_timestamp_hour_utc is null) then
    raise exception 'p_after_timeseries_id and p_after_timestamp_hour_utc must both be null or both provided';
  end if;

  v_limit := greatest(1, least(coalesce(p_limit, 20000), 100000));
  v_start := (p_day_utc::text || ' 00:00:00+00')::timestamptz;
  v_end := ((p_day_utc + 1)::text || ' 00:00:00+00')::timestamptz;

  return query
  select
    h.connector_id,
    h.station_id,
    h.timeseries_id,
    h.pollutant_code,
    h.timestamp_hour_utc,
    h.daqi_input_value_ugm3,
    h.daqi_input_averaging_code,
    h.daqi_index_level,
    h.daqi_source_observation_count,
    h.daqi_required_observation_count,
    h.daqi_calculation_status,
    h.daqi_missing_reason,
    h.eaqi_input_value_ugm3,
    h.eaqi_input_averaging_code,
    h.eaqi_index_level,
    h.eaqi_source_observation_count,
    h.eaqi_required_observation_count,
    h.eaqi_calculation_status,
    h.eaqi_missing_reason,
    h.hourly_sample_count,
    h.algorithm_version,
    h.computed_at_utc,
    h.hourly_mean_ugm3,
    h.rolling24h_mean_ugm3,
    h.no2_hourly_mean_ugm3,
    h.pm25_hourly_mean_ugm3,
    h.pm10_hourly_mean_ugm3,
    h.pm25_rolling24h_mean_ugm3,
    h.pm10_rolling24h_mean_ugm3,
    h.daqi_no2_index_level,
    h.daqi_pm25_rolling24h_index_level,
    h.daqi_pm10_rolling24h_index_level,
    h.eaqi_no2_index_level,
    h.eaqi_pm25_index_level,
    h.eaqi_pm10_index_level,
    h.updated_at
  from uk_aq_public.uk_aq_timeseries_aqi_hourly h
  where h.connector_id = p_connector_id
    and h.timestamp_hour_utc >= v_start
    and h.timestamp_hour_utc < v_end
    and (
      p_after_timeseries_id is null
      or h.timeseries_id > p_after_timeseries_id
      or (
        h.timeseries_id = p_after_timeseries_id
        and h.timestamp_hour_utc > p_after_timestamp_hour_utc
      )
    )
  order by h.timeseries_id asc, h.timestamp_hour_utc asc
  limit v_limit;
end;
$$;

drop function if exists uk_aq_public.uk_aq_rpc_database_size_bytes();
create or replace function uk_aq_public.uk_aq_rpc_database_size_bytes()
returns table (
  database_name text,
  size_bytes bigint,
  oldest_observed_at timestamptz,
  sampled_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_oldest_observs timestamptz := null;
  v_oldest_aqilevels timestamptz := null;
  v_oldest_observed_at timestamptz := null;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  if to_regclass('uk_aq_observs.observations') is not null then
    execute 'select min(o.observed_at) from uk_aq_observs.observations o'
      into v_oldest_observs;
  end if;

  if to_regclass('uk_aq_aqilevels.timeseries_aqi_hourly') is not null then
    execute 'select min(a.timestamp_hour_utc) from uk_aq_aqilevels.timeseries_aqi_hourly a'
      into v_oldest_aqilevels;
  end if;

  select min(v)
    into v_oldest_observed_at
  from (values (v_oldest_observs), (v_oldest_aqilevels)) as oldest(v);

  return query
  select
    current_database()::text as database_name,
    pg_database_size(current_database())::bigint as size_bytes,
    v_oldest_observed_at as oldest_observed_at,
    now() as sampled_at;
end;
$$;

drop function if exists uk_aq_public.uk_aq_rpc_schema_size_bytes(text);
create or replace function uk_aq_public.uk_aq_rpc_schema_size_bytes(
  p_schema_name text default null
)
returns table (
  schema_name text,
  size_bytes bigint,
  oldest_observed_at timestamptz,
  sampled_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_schema_names text[];
  v_schema text;
  v_size_bytes bigint;
  v_oldest_observed_at timestamptz;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  if p_schema_name is null or btrim(p_schema_name) = '' then
    v_schema_names := array['uk_aq_observs', 'uk_aq_aqilevels'];
  elsif p_schema_name in ('uk_aq_observs', 'uk_aq_aqilevels') then
    v_schema_names := array[p_schema_name];
  else
    raise exception 'invalid schema_name: %', p_schema_name;
  end if;

  foreach v_schema in array v_schema_names loop
    v_size_bytes := 0;
    v_oldest_observed_at := null;

    if to_regnamespace(v_schema) is not null then
      execute format(
        $sql$
          select coalesce(sum(pg_total_relation_size(c.oid)), 0)::bigint
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = %L
            and c.relkind in ('r', 'p', 'm', 't')
        $sql$,
        v_schema
      ) into v_size_bytes;

      if v_schema = 'uk_aq_observs'
         and to_regclass('uk_aq_observs.observations') is not null then
        execute 'select min(o.observed_at) from uk_aq_observs.observations o'
          into v_oldest_observed_at;
      elsif v_schema = 'uk_aq_aqilevels'
            and to_regclass('uk_aq_aqilevels.timeseries_aqi_hourly') is not null then
        execute 'select min(a.timestamp_hour_utc) from uk_aq_aqilevels.timeseries_aqi_hourly a'
          into v_oldest_observed_at;
      end if;
    end if;

    schema_name := v_schema;
    size_bytes := coalesce(v_size_bytes, 0);
    oldest_observed_at := v_oldest_observed_at;
    sampled_at := now();
    return next;
  end loop;
end;
$$;

drop function if exists uk_aq_public.uk_aq_rpc_db_size_metric_upsert(
  text,
  text,
  bigint,
  timestamptz,
  timestamptz,
  text
);
create or replace function uk_aq_public.uk_aq_rpc_db_size_metric_upsert(
  p_database_label text,
  p_database_name text,
  p_size_bytes bigint,
  p_oldest_observed_at timestamptz default null,
  p_recorded_at timestamptz default now(),
  p_source text default null
)
returns table (rows_upserted int)
language plpgsql
security definer
set search_path = uk_aq_ops, public, pg_catalog
as $$
declare
  v_bucket_hour timestamptz;
  v_rows int := 0;
  v_source text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  if p_database_label not in ('ingestdb', 'obs_aqidb') then
    raise exception 'invalid database_label: %', p_database_label;
  end if;

  if p_database_name is null or btrim(p_database_name) = '' then
    raise exception 'database_name is required';
  end if;

  if p_size_bytes is null or p_size_bytes < 0 then
    raise exception 'size_bytes must be >= 0';
  end if;

  v_bucket_hour := date_trunc('hour', coalesce(p_recorded_at, now()));
  v_source := coalesce(nullif(btrim(p_source), ''), 'uk_aq_db_size_logger_cloud_run');

  insert into uk_aq_ops.db_size_metrics_hourly (
    bucket_hour,
    database_label,
    database_name,
    size_bytes,
    oldest_observed_at,
    source,
    recorded_at,
    updated_at
  )
  values (
    v_bucket_hour,
    p_database_label,
    p_database_name,
    p_size_bytes,
    p_oldest_observed_at,
    v_source,
    coalesce(p_recorded_at, now()),
    now()
  )
  on conflict (bucket_hour, database_label) do update set
    database_name = excluded.database_name,
    size_bytes = excluded.size_bytes,
    oldest_observed_at = excluded.oldest_observed_at,
    source = excluded.source,
    recorded_at = excluded.recorded_at,
    updated_at = now();

  get diagnostics v_rows = row_count;
  return query select v_rows;
end;
$$;

drop function if exists uk_aq_public.uk_aq_rpc_db_size_metric_cleanup(integer);
create or replace function uk_aq_public.uk_aq_rpc_db_size_metric_cleanup(
  p_retention_days integer default 120
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
  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  v_days := greatest(1, least(coalesce(p_retention_days, 120), 3650));

  delete from uk_aq_ops.db_size_metrics_hourly
  where bucket_hour < now() - make_interval(days => v_days);

  get diagnostics v_rows = row_count;
  return query select v_rows;
end;
$$;

create or replace function uk_aq_public.uk_aq_rpc_observs_observations_upsert(rows jsonb)
returns table(observations_upserted int)
language plpgsql
security definer
set search_path = uk_aq_observs, uk_aq_raw, public, pg_catalog
as $$
declare
  v_count int := 0;
  v_started_at timestamptz := clock_timestamp();
  v_input_rows int := 0;
  v_payload_bytes int := 0;
  v_duration_ms int := 0;
  v_hot_start_utc timestamptz := (date_trunc('day', now() at time zone 'UTC') - interval '3 day');
  v_hot_end_utc timestamptz := (date_trunc('day', now() at time zone 'UTC') + interval '1 day');
begin
  set local timezone = 'UTC';
  set local statement_timeout = '120s';
  set local plan_cache_mode = 'force_custom_plan';

  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  if rows is null
    or jsonb_typeof(rows) <> 'array'
    or jsonb_array_length(rows) = 0
  then
    return query select 0;
    return;
  end if;

  v_input_rows := jsonb_array_length(rows);
  v_payload_bytes := pg_column_size(rows);

  with parsed_rows as (
    select
      input.connector_id,
      input.timeseries_id,
      input.observed_at,
      input.value
    from jsonb_to_recordset(rows) as input(
      connector_id integer,
      timeseries_id integer,
      observed_at timestamptz,
      value double precision,
      value_float8_hex text
    )
    where input.connector_id is not null
      and input.timeseries_id is not null
      and input.observed_at is not null
      and input.observed_at >= v_hot_start_utc
      and input.observed_at < v_hot_end_utc
  ),
  input_rows as (
    select distinct on (
      p.connector_id,
      p.timeseries_id,
      p.observed_at
    )
      p.connector_id,
      p.timeseries_id,
      p.observed_at,
      p.value
    from parsed_rows p
    order by
      p.connector_id,
      p.timeseries_id,
      p.observed_at
  ),
  updated as (
    update uk_aq_observs.observations o
    set value = i.value
    from input_rows i
    where o.connector_id = i.connector_id
      and o.timeseries_id = i.timeseries_id
      and o.observed_at = i.observed_at
      and o.observed_at >= v_hot_start_utc
      and o.observed_at < v_hot_end_utc
      and o.value is distinct from i.value
    returning 1
  ),
  inserted as (
    insert into uk_aq_observs.observations (
      connector_id,
      timeseries_id,
      observed_at,
      value
    )
    select
      i.connector_id,
      i.timeseries_id,
      i.observed_at,
      i.value
    from input_rows i
    left join uk_aq_observs.observations o
      on o.connector_id = i.connector_id
     and o.timeseries_id = i.timeseries_id
     and o.observed_at = i.observed_at
     and o.observed_at >= v_hot_start_utc
     and o.observed_at < v_hot_end_utc
    where o.connector_id is null
    returning 1
  )
  select
    coalesce((select count(*) from updated), 0)
    + coalesce((select count(*) from inserted), 0)
  into v_count;

  v_duration_ms := greatest(
    0,
    floor(extract(epoch from (clock_timestamp() - v_started_at)) * 1000)::int
  );

  insert into uk_aq_raw.observs_rpc_metrics_minute (
    bucket_minute,
    endpoint,
    calls,
    rows_input,
    payload_bytes,
    rows_upserted,
    duration_ms_sum,
    duration_ms_max
  )
  values (
    date_trunc('minute', now()),
    'rpc/uk_aq_rpc_observs_observations_upsert',
    1,
    v_input_rows,
    v_payload_bytes,
    coalesce(v_count, 0),
    v_duration_ms,
    v_duration_ms
  )
  on conflict (bucket_minute, endpoint)
  do update set
    calls = uk_aq_raw.observs_rpc_metrics_minute.calls + 1,
    rows_input = uk_aq_raw.observs_rpc_metrics_minute.rows_input + excluded.rows_input,
    payload_bytes = uk_aq_raw.observs_rpc_metrics_minute.payload_bytes + excluded.payload_bytes,
    rows_upserted = uk_aq_raw.observs_rpc_metrics_minute.rows_upserted + excluded.rows_upserted,
    duration_ms_sum = uk_aq_raw.observs_rpc_metrics_minute.duration_ms_sum + excluded.duration_ms_sum,
    duration_ms_max = greatest(uk_aq_raw.observs_rpc_metrics_minute.duration_ms_max, excluded.duration_ms_max);

  return query select coalesce(v_count, 0);
end;
$$;

drop function if exists uk_aq_public.uk_aq_rpc_observs_ensure_daily_partitions(date, date);
create or replace function uk_aq_public.uk_aq_rpc_observs_ensure_daily_partitions(
  start_day_utc date,
  end_day_utc date
)
returns table (
  day_utc date,
  partition_name text,
  partition_created boolean,
  brin_created boolean
)
language plpgsql
security definer
set search_path = uk_aq_observs, public, pg_catalog
as $$
declare
  v_today_utc date := (now() at time zone 'UTC')::date;
  v_hot_future_end_day_utc date := ((now() at time zone 'UTC')::date + 3);
  v_day date;
  v_partition_name text;
  v_partition_exists boolean;
  v_brin_exists boolean;
begin
  set local timezone = 'UTC';
  -- Guard against short inherited role/session timeouts during partition/index DDL.
  set local statement_timeout = '15min';
  set local lock_timeout = '5s';

  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  if start_day_utc is null or end_day_utc is null then
    raise exception 'start_day_utc and end_day_utc are required';
  end if;

  if end_day_utc < start_day_utc then
    raise exception 'end_day_utc must be >= start_day_utc';
  end if;

  if end_day_utc - start_day_utc > 400 then
    raise exception 'partition ensure range too large (max 400 days)';
  end if;

  create table if not exists uk_aq_observs.observations_default
    partition of uk_aq_observs.observations default;

  create index if not exists uk_aq_observs_observations_default_observed_at_brin
    on uk_aq_observs.observations_default using brin (observed_at);

  for v_day in
    select generate_series(start_day_utc, end_day_utc, interval '1 day')::date
  loop
    v_partition_name := format('observations_%s', to_char(v_day, 'YYYYMMDD'));

    select to_regclass(format('uk_aq_observs.%I', v_partition_name)) is not null
    into v_partition_exists;

    if not v_partition_exists then
      execute format(
        'create table uk_aq_observs.%I '
        'partition of uk_aq_observs.observations '
        'for values from (%L) to (%L)',
        v_partition_name,
        format('%s 00:00:00+00', v_day),
        format('%s 00:00:00+00', v_day + 1)
      );
    end if;

    select exists (
      select 1
      from pg_class idx
      join pg_namespace n on n.oid = idx.relnamespace
      where n.nspname = 'uk_aq_observs'
        and idx.relname = v_partition_name || '_observed_at_brin_idx'
    )
    into v_brin_exists;

    execute format(
      'create index if not exists %I on uk_aq_observs.%I using brin (observed_at)',
      v_partition_name || '_observed_at_brin_idx',
      v_partition_name
    );

    if v_day between v_today_utc and v_hot_future_end_day_utc then
      execute format(
        'create unique index if not exists %I on uk_aq_observs.%I (connector_id, timeseries_id, observed_at)',
        v_partition_name || '_hot_key_uidx',
        v_partition_name
      );
    end if;

    day_utc := v_day;
    partition_name := v_partition_name;
    partition_created := not v_partition_exists;
    brin_created := not v_brin_exists;
    return next;
  end loop;
end;
$$;

drop function if exists uk_aq_public.uk_aq_rpc_observs_enforce_hot_cold_indexes(date, date);
create or replace function uk_aq_public.uk_aq_rpc_observs_enforce_hot_cold_indexes(
  hot_start_day_utc date,
  hot_end_day_utc date
)
returns table (
  partition_name text,
  day_utc date,
  is_hot boolean,
  brin_created boolean,
  hot_key_created boolean,
  btree_indexes_dropped integer
)
language plpgsql
security definer
set search_path = uk_aq_observs, public, pg_catalog
as $$
declare
  v_part record;
  v_day date;
  v_is_hot boolean;
  v_brin_exists boolean;
  v_hot_key_exists boolean;
  v_drop_count integer;
  v_idx record;
  v_con record;
begin
  set local timezone = 'UTC';
  -- Guard against short inherited role/session timeouts during partition/index DDL.
  set local statement_timeout = '15min';
  set local lock_timeout = '5s';

  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  if hot_start_day_utc is null or hot_end_day_utc is null then
    raise exception 'hot_start_day_utc and hot_end_day_utc are required';
  end if;

  if hot_end_day_utc < hot_start_day_utc then
    raise exception 'hot_end_day_utc must be >= hot_start_day_utc';
  end if;

  for v_part in
    select c.relname as partition_name
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    join pg_class p on p.oid = i.inhparent
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'uk_aq_observs'
      and p.relname = 'observations'
      and c.relname ~ '^observations_[0-9]{8}$'
    order by c.relname
  loop
    v_day := to_date(substring(v_part.partition_name from '([0-9]{8})$'), 'YYYYMMDD');
    v_is_hot := v_day between hot_start_day_utc and hot_end_day_utc;

    select exists (
      select 1
      from pg_class idx
      join pg_namespace n on n.oid = idx.relnamespace
      where n.nspname = 'uk_aq_observs'
        and idx.relname = v_part.partition_name || '_observed_at_brin_idx'
    )
    into v_brin_exists;

    execute format(
      'create index if not exists %I on uk_aq_observs.%I using brin (observed_at)',
      v_part.partition_name || '_observed_at_brin_idx',
      v_part.partition_name
    );

    select exists (
      select 1
      from pg_class idx
      join pg_namespace n on n.oid = idx.relnamespace
      where n.nspname = 'uk_aq_observs'
        and idx.relname = v_part.partition_name || '_hot_key_uidx'
    )
    into v_hot_key_exists;

    if v_is_hot then
      execute format(
        'create unique index if not exists %I on uk_aq_observs.%I (connector_id, timeseries_id, observed_at)',
        v_part.partition_name || '_hot_key_uidx',
        v_part.partition_name
      );
      v_drop_count := 0;
    else
      for v_con in
        select con.conname
        from pg_constraint con
        where con.conrelid = format('uk_aq_observs.%I', v_part.partition_name)::regclass
          and con.contype in ('p', 'u')
      loop
        execute format(
          'alter table uk_aq_observs.%I drop constraint if exists %I',
          v_part.partition_name,
          v_con.conname
        );
      end loop;

      v_drop_count := 0;
      for v_idx in
        select idx.relname as index_name
        from pg_index i
        join pg_class idx on idx.oid = i.indexrelid
        join pg_class tbl on tbl.oid = i.indrelid
        join pg_namespace n on n.oid = tbl.relnamespace
        join pg_am am on am.oid = idx.relam
        where n.nspname = 'uk_aq_observs'
          and tbl.relname = v_part.partition_name
          and am.amname = 'btree'
      loop
        execute format('drop index if exists uk_aq_observs.%I', v_idx.index_name);
        v_drop_count := v_drop_count + 1;
      end loop;
    end if;

    partition_name := v_part.partition_name;
    day_utc := v_day;
    is_hot := v_is_hot;
    brin_created := not v_brin_exists;
    hot_key_created := v_is_hot and not v_hot_key_exists;
    btree_indexes_dropped := coalesce(v_drop_count, 0);
    return next;
  end loop;
end;
$$;

drop function if exists uk_aq_public.uk_aq_rpc_observs_observations_default_diagnostics(integer);
create or replace function uk_aq_public.uk_aq_rpc_observs_observations_default_diagnostics(
  top_n integer default 20
)
returns table (
  default_row_count bigint,
  min_observed_at timestamptz,
  max_observed_at timestamptz,
  top_offenders jsonb
)
language plpgsql
security definer
set search_path = uk_aq_observs, public, pg_catalog
as $$
declare
  v_top_n integer := greatest(1, least(coalesce(top_n, 20), 200));
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  return query
  with stats as (
    select
      count(*)::bigint as default_row_count,
      min(observed_at) as min_observed_at,
      max(observed_at) as max_observed_at
    from uk_aq_observs.observations_default
  ),
  offenders as (
    select
      o.connector_id,
      o.timeseries_id,
      count(*)::bigint as row_count
    from uk_aq_observs.observations_default o
    group by o.connector_id, o.timeseries_id
    order by count(*) desc, o.connector_id, o.timeseries_id
    limit v_top_n
  )
  select
    s.default_row_count,
    s.min_observed_at,
    s.max_observed_at,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'connector_id', x.connector_id,
            'timeseries_id', x.timeseries_id,
            'row_count', x.row_count
          )
          order by x.row_count desc, x.connector_id, x.timeseries_id
        )
        from offenders x
      ),
      '[]'::jsonb
    ) as top_offenders
  from stats s;
end;
$$;

drop function if exists uk_aq_public.uk_aq_rpc_observs_drop_candidates(timestamptz);
create or replace function uk_aq_public.uk_aq_rpc_observs_drop_candidates(
  cutoff_utc timestamptz
)
returns table (
  partition_name text,
  partition_day_utc date,
  partition_start_utc timestamptz,
  partition_end_utc timestamptz
)
language plpgsql
security definer
set search_path = uk_aq_observs, public, pg_catalog
as $$
begin
  set local timezone = 'UTC';

  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  if cutoff_utc is null then
    raise exception 'cutoff_utc is required';
  end if;

  return query
  with parts as (
    select
      c.relname::text as partition_name,
      to_date(substring(c.relname from '([0-9]{8})$'), 'YYYYMMDD') as partition_day_utc
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    join pg_class p on p.oid = i.inhparent
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'uk_aq_observs'
      and p.relname = 'observations'
      and c.relname ~ '^observations_[0-9]{8}$'
  ),
  bounds as (
    select
      p.partition_name,
      p.partition_day_utc,
      (to_char(p.partition_day_utc, 'YYYY-MM-DD') || ' 00:00:00+00')::timestamptz as partition_start_utc,
      (to_char(p.partition_day_utc + 1, 'YYYY-MM-DD') || ' 00:00:00+00')::timestamptz as partition_end_utc
    from parts p
  )
  select
    b.partition_name::text,
    b.partition_day_utc,
    b.partition_start_utc::timestamptz,
    b.partition_end_utc::timestamptz
  from bounds b
  where b.partition_end_utc <= cutoff_utc
  order by b.partition_day_utc;
end;
$$;

drop function if exists uk_aq_public.uk_aq_rpc_observs_drop_partition(text);
create or replace function uk_aq_public.uk_aq_rpc_observs_drop_partition(
  p_partition_name text
)
returns table (
  dropped boolean
)
language plpgsql
security definer
set search_path = uk_aq_observs, public, pg_catalog
as $$
declare
  v_exists boolean;
  v_is_child boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  if coalesce(trim(p_partition_name), '') = '' then
    raise exception 'p_partition_name is required';
  end if;

  if p_partition_name = 'observations_default' then
    raise exception 'refusing to drop default partition';
  end if;

  select to_regclass(format('uk_aq_observs.%I', p_partition_name)) is not null
  into v_exists;

  if not v_exists then
    return query select false;
    return;
  end if;

  select exists (
    select 1
    from pg_inherits i
    join pg_class child on child.oid = i.inhrelid
    join pg_class parent on parent.oid = i.inhparent
    join pg_namespace n on n.oid = child.relnamespace
    where n.nspname = 'uk_aq_observs'
      and parent.relname = 'observations'
      and child.relname = p_partition_name
  )
  into v_is_child;

  if not v_is_child then
    raise exception 'partition % is not a child of uk_aq_observs.observations', p_partition_name;
  end if;

  execute format('drop table uk_aq_observs.%I', p_partition_name);

  return query select true;
end;
$$;

drop function if exists uk_aq_public.uk_aq_rpc_observs_day_has_rows(date);
create or replace function uk_aq_public.uk_aq_rpc_observs_day_has_rows(
  p_day_utc date
)
returns table (
  has_rows boolean
)
language plpgsql
security definer
set search_path = uk_aq_observs, public, pg_catalog
as $$
declare
  v_start timestamptz;
  v_end timestamptz;
begin
  set local timezone = 'UTC';

  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  if p_day_utc is null then
    raise exception 'p_day_utc is required';
  end if;

  v_start := (p_day_utc::text || ' 00:00:00+00')::timestamptz;
  v_end := ((p_day_utc + 1)::text || ' 00:00:00+00')::timestamptz;

  return query
  select exists (
    select 1
    from uk_aq_observs.observations o
    where o.observed_at >= v_start
      and o.observed_at < v_end
    limit 1
  );
end;
$$;

drop function if exists uk_aq_public.uk_aq_rpc_info_schema_columns(text, text[]);
create or replace function uk_aq_public.uk_aq_rpc_info_schema_columns(
  p_schema text default 'uk_aq_core',
  p_table_names text[] default null
)
returns table (
  table_name text,
  column_name text,
  udt_name text,
  is_nullable text,
  column_default text,
  ordinal_position integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  return query
  select
    c.table_name::text,
    c.column_name::text,
    c.udt_name::text,
    c.is_nullable::text,
    c.column_default::text,
    c.ordinal_position::integer
  from information_schema.columns c
  where c.table_schema = coalesce(nullif(trim(p_schema), ''), 'uk_aq_core')
    and (p_table_names is null or c.table_name = any(p_table_names))
  order by c.table_name, c.ordinal_position;
end;
$$;

drop function if exists uk_aq_public.uk_aq_rpc_info_schema_primary_keys(text, text[]);
create or replace function uk_aq_public.uk_aq_rpc_info_schema_primary_keys(
  p_schema text default 'uk_aq_core',
  p_table_names text[] default null
)
returns table (
  table_name text,
  constraint_name text,
  column_name text,
  ordinal_position integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  return query
  select
    kcu.table_name::text,
    kcu.constraint_name::text,
    kcu.column_name::text,
    kcu.ordinal_position::integer
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on tc.constraint_name = kcu.constraint_name
   and tc.table_schema = kcu.table_schema
   and tc.table_name = kcu.table_name
  where tc.table_schema = coalesce(nullif(trim(p_schema), ''), 'uk_aq_core')
    and tc.constraint_type = 'PRIMARY KEY'
    and (p_table_names is null or tc.table_name = any(p_table_names))
  order by kcu.table_name, kcu.constraint_name, kcu.ordinal_position;
end;
$$;

revoke execute on function uk_aq_public.uk_aq_rpc_observations_hourly_fingerprint(timestamptz, timestamptz) from public;
revoke execute on function uk_aq_public.uk_aq_rpc_observations_hourly_fingerprint(timestamptz, timestamptz) from anon, authenticated;
grant execute on function uk_aq_public.uk_aq_rpc_observations_hourly_fingerprint(timestamptz, timestamptz) to service_role;

revoke execute on function uk_aq_public.uk_aq_rpc_database_size_bytes() from public;
revoke execute on function uk_aq_public.uk_aq_rpc_database_size_bytes() from anon, authenticated;
grant execute on function uk_aq_public.uk_aq_rpc_database_size_bytes() to service_role;

revoke execute on function uk_aq_public.uk_aq_rpc_schema_size_bytes(text) from public;
revoke execute on function uk_aq_public.uk_aq_rpc_schema_size_bytes(text) from anon, authenticated;
grant execute on function uk_aq_public.uk_aq_rpc_schema_size_bytes(text) to service_role;

revoke execute on function uk_aq_public.uk_aq_rpc_db_size_metric_upsert(
  text,
  text,
  bigint,
  timestamptz,
  timestamptz,
  text
) from public;
revoke execute on function uk_aq_public.uk_aq_rpc_db_size_metric_upsert(
  text,
  text,
  bigint,
  timestamptz,
  timestamptz,
  text
) from anon, authenticated;
grant execute on function uk_aq_public.uk_aq_rpc_db_size_metric_upsert(
  text,
  text,
  bigint,
  timestamptz,
  timestamptz,
  text
) to service_role;

revoke execute on function uk_aq_public.uk_aq_rpc_db_size_metric_cleanup(integer) from public;
revoke execute on function uk_aq_public.uk_aq_rpc_db_size_metric_cleanup(integer) from anon, authenticated;
grant execute on function uk_aq_public.uk_aq_rpc_db_size_metric_cleanup(integer) to service_role;

revoke execute on function uk_aq_public.uk_aq_rpc_observs_history_day_rows(
  date,
  integer,
  integer,
  timestamptz,
  integer
) from public;
revoke execute on function uk_aq_public.uk_aq_rpc_observs_history_day_rows(
  date,
  integer,
  integer,
  timestamptz,
  integer
) from anon, authenticated;
grant execute on function uk_aq_public.uk_aq_rpc_observs_history_day_rows(
  date,
  integer,
  integer,
  timestamptz,
  integer
) to service_role;

revoke execute on function uk_aq_public.uk_aq_rpc_observs_timeseries_window(
  integer,
  integer,
  timestamptz,
  timestamptz,
  timestamptz,
  integer
) from public;
revoke execute on function uk_aq_public.uk_aq_rpc_observs_timeseries_window(
  integer,
  integer,
  timestamptz,
  timestamptz,
  timestamptz,
  integer
) from anon, authenticated;
grant execute on function uk_aq_public.uk_aq_rpc_observs_timeseries_window(
  integer,
  integer,
  timestamptz,
  timestamptz,
  timestamptz,
  integer
) to service_role;

revoke execute on function uk_aq_public.uk_aq_rpc_aqilevels_history_day_connector_counts(
  date,
  integer[]
) from public;
revoke execute on function uk_aq_public.uk_aq_rpc_aqilevels_history_day_connector_counts(
  date,
  integer[]
) from anon, authenticated;
grant execute on function uk_aq_public.uk_aq_rpc_aqilevels_history_day_connector_counts(
  date,
  integer[]
) to service_role;

revoke execute on function uk_aq_public.uk_aq_rpc_aqilevels_history_day_rows(
  date,
  integer,
  integer,
  timestamptz,
  integer
) from public;
revoke execute on function uk_aq_public.uk_aq_rpc_aqilevels_history_day_rows(
  date,
  integer,
  integer,
  timestamptz,
  integer
) from anon, authenticated;
grant execute on function uk_aq_public.uk_aq_rpc_aqilevels_history_day_rows(
  date,
  integer,
  integer,
  timestamptz,
  integer
) to service_role;

revoke execute on function uk_aq_public.uk_aq_rpc_observs_observations_upsert(jsonb) from public;
revoke execute on function uk_aq_public.uk_aq_rpc_observs_observations_upsert(jsonb) from anon, authenticated;
grant execute on function uk_aq_public.uk_aq_rpc_observs_observations_upsert(jsonb) to service_role;

revoke execute on function uk_aq_public.uk_aq_rpc_observs_ensure_daily_partitions(date, date) from public;
revoke execute on function uk_aq_public.uk_aq_rpc_observs_ensure_daily_partitions(date, date) from anon, authenticated;
grant execute on function uk_aq_public.uk_aq_rpc_observs_ensure_daily_partitions(date, date) to service_role;

revoke execute on function uk_aq_public.uk_aq_rpc_observs_enforce_hot_cold_indexes(date, date) from public;
revoke execute on function uk_aq_public.uk_aq_rpc_observs_enforce_hot_cold_indexes(date, date) from anon, authenticated;
grant execute on function uk_aq_public.uk_aq_rpc_observs_enforce_hot_cold_indexes(date, date) to service_role;

revoke execute on function uk_aq_public.uk_aq_rpc_observs_observations_default_diagnostics(integer) from public;
revoke execute on function uk_aq_public.uk_aq_rpc_observs_observations_default_diagnostics(integer) from anon, authenticated;
grant execute on function uk_aq_public.uk_aq_rpc_observs_observations_default_diagnostics(integer) to service_role;

revoke execute on function uk_aq_public.uk_aq_rpc_observs_drop_candidates(timestamptz) from public;
revoke execute on function uk_aq_public.uk_aq_rpc_observs_drop_candidates(timestamptz) from anon, authenticated;
grant execute on function uk_aq_public.uk_aq_rpc_observs_drop_candidates(timestamptz) to service_role;

revoke execute on function uk_aq_public.uk_aq_rpc_observs_drop_partition(text) from public;
revoke execute on function uk_aq_public.uk_aq_rpc_observs_drop_partition(text) from anon, authenticated;
grant execute on function uk_aq_public.uk_aq_rpc_observs_drop_partition(text) to service_role;

revoke execute on function uk_aq_public.uk_aq_rpc_observs_day_has_rows(date) from public;
revoke execute on function uk_aq_public.uk_aq_rpc_observs_day_has_rows(date) from anon, authenticated;
grant execute on function uk_aq_public.uk_aq_rpc_observs_day_has_rows(date) to service_role;

revoke execute on function uk_aq_public.uk_aq_rpc_info_schema_columns(text, text[]) from public;
revoke execute on function uk_aq_public.uk_aq_rpc_info_schema_columns(text, text[]) from anon, authenticated;
grant execute on function uk_aq_public.uk_aq_rpc_info_schema_columns(text, text[]) to service_role;

revoke execute on function uk_aq_public.uk_aq_rpc_info_schema_primary_keys(text, text[]) from public;
revoke execute on function uk_aq_public.uk_aq_rpc_info_schema_primary_keys(text, text[]) from anon, authenticated;
grant execute on function uk_aq_public.uk_aq_rpc_info_schema_primary_keys(text, text[]) to service_role;

grant usage on schema uk_aq_public to service_role;

-- Phase 1 additive: timeseries-first AQI source RPC.
drop function if exists uk_aq_public.uk_aq_rpc_timeseries_aqi_hourly_source(
  timestamptz,
  timestamptz,
  integer[]
);

create or replace function uk_aq_public.uk_aq_rpc_timeseries_aqi_hourly_source(
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_timeseries_ids integer[] default null
)
returns table (
  timeseries_id integer,
  station_id bigint,
  connector_id integer,
  pollutant_code text,
  timestamp_hour_utc timestamptz,
  hourly_mean_ugm3 double precision,
  sample_count integer
)
language plpgsql
security definer
set search_path = uk_aq_observs, uk_aq_core, public, pg_catalog
as $$
declare
  v_window_start timestamptz;
  v_window_end timestamptz;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  if p_window_start is null or p_window_end is null then
    raise exception 'p_window_start and p_window_end are required';
  end if;

  v_window_start := date_trunc('hour', p_window_start);
  v_window_end := date_trunc('hour', p_window_end);

  if v_window_end <= v_window_start then
    raise exception 'p_window_end must be greater than p_window_start';
  end if;

  return query
  with raw as (
    select
      ts.id::integer as timeseries_id,
      ts.station_id,
      ts.connector_id,
      op.code as pollutant_code,
      o.observed_at,
      o.value
    from uk_aq_observs.observations o
    join uk_aq_core.timeseries ts
      on ts.id = o.timeseries_id
     and ts.connector_id = o.connector_id
    join uk_aq_core.phenomena p
      on p.id = ts.phenomenon_id
    join uk_aq_core.observed_properties op
      on op.id = p.observed_property_id
    where o.observed_at >= v_window_start
      and o.observed_at < v_window_end
      and op.code in ('pm25', 'pm10', 'no2')
      and o.value is not null
      and o.value >= 0
      and (
        p_timeseries_ids is null
        or ts.id = any(p_timeseries_ids)
      )
  )
  select
    r.timeseries_id,
    r.station_id,
    r.connector_id,
    r.pollutant_code,
    date_trunc('hour', r.observed_at at time zone 'UTC') at time zone 'UTC' as timestamp_hour_utc,
    avg(r.value)::double precision as hourly_mean_ugm3,
    count(*)::int as sample_count
  from raw r
  group by
    r.timeseries_id,
    r.station_id,
    r.connector_id,
    r.pollutant_code,
    date_trunc('hour', r.observed_at at time zone 'UTC') at time zone 'UTC'
  order by
    timestamp_hour_utc,
    r.timeseries_id;
end;
$$;

revoke execute on function uk_aq_public.uk_aq_rpc_timeseries_aqi_hourly_source(
  timestamptz,
  timestamptz,
  integer[]
) from public;
revoke execute on function uk_aq_public.uk_aq_rpc_timeseries_aqi_hourly_source(
  timestamptz,
  timestamptz,
  integer[]
) from anon, authenticated;
grant execute on function uk_aq_public.uk_aq_rpc_timeseries_aqi_hourly_source(
  timestamptz,
  timestamptz,
  integer[]
) to service_role;
