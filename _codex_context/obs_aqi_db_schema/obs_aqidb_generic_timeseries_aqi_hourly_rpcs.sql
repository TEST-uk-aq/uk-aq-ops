-- ObsAQIDB generic AQI hourly RPCs
-- Removes old pollutant-specific/wide-column compatibility from the RPC layer.
-- Run this on ObsAQIDB, not IngestDB.

begin;

-- Return generic AQI hourly rows only.
-- This function's return signature has changed, so it must be dropped before being recreated.
drop function if exists uk_aq_public.uk_aq_rpc_aqilevels_history_day_rows(
  date,
  integer,
  integer,
  timestamp with time zone,
  integer
);

create or replace function uk_aq_public.uk_aq_rpc_aqilevels_history_day_rows(
  p_day_utc date,
  p_connector_id integer,
  p_after_timeseries_id integer default null::integer,
  p_after_timestamp_hour_utc timestamp with time zone default null::timestamp with time zone,
  p_limit integer default 20000
)
returns table(
  connector_id integer,
  station_id bigint,
  timeseries_id integer,
  pollutant_code text,
  timestamp_hour_utc timestamp with time zone,
  hourly_mean_ugm3 double precision,
  rolling24h_mean_ugm3 double precision,
  hourly_sample_count smallint,
  daqi_index_level smallint,
  eaqi_index_level smallint,
  updated_at timestamp with time zone,
  daqi_input_value_ugm3 double precision,
  daqi_input_averaging_code text,
  daqi_source_observation_count smallint,
  daqi_required_observation_count smallint,
  daqi_calculation_status text,
  daqi_missing_reason text,
  eaqi_input_value_ugm3 double precision,
  eaqi_input_averaging_code text,
  eaqi_source_observation_count smallint,
  eaqi_required_observation_count smallint,
  eaqi_calculation_status text,
  eaqi_missing_reason text,
  algorithm_version text,
  computed_at_utc timestamp with time zone
)
language plpgsql
security definer
set search_path to 'uk_aq_aqilevels', 'public', 'pg_catalog'
as $function$
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
    h.hourly_mean_ugm3,
    h.rolling24h_mean_ugm3,
    h.hourly_sample_count,
    h.daqi_index_level,
    h.eaqi_index_level,
    h.updated_at,
    h.daqi_input_value_ugm3,
    h.daqi_input_averaging_code,
    h.daqi_source_observation_count,
    h.daqi_required_observation_count,
    h.daqi_calculation_status,
    h.daqi_missing_reason,
    h.eaqi_input_value_ugm3,
    h.eaqi_input_averaging_code,
    h.eaqi_source_observation_count,
    h.eaqi_required_observation_count,
    h.eaqi_calculation_status,
    h.eaqi_missing_reason,
    h.algorithm_version,
    h.computed_at_utc
  from uk_aq_aqilevels.timeseries_aqi_hourly h
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
$function$;

-- Upsert generic AQI hourly rows only.
-- Accepts the helper rows produced by IngestDB and writes the generic ObsAQIDB table.
create or replace function uk_aq_public.uk_aq_rpc_timeseries_aqi_hourly_upsert(
  p_rows jsonb,
  p_late_cutoff_hour timestamp with time zone default null::timestamp with time zone,
  p_reference_hour timestamp with time zone default null::timestamp with time zone
)
returns table(
  rows_attempted integer,
  rows_changed integer,
  rows_inserted integer,
  rows_updated integer,
  timeseries_hours_changed integer,
  timeseries_hours_changed_gt_cutoff integer,
  max_changed_lag_hours numeric
)
language plpgsql
security definer
set search_path to 'uk_aq_aqilevels', 'public', 'pg_catalog'
as $function$
declare
  v_rows_attempted integer := 0;
  v_rows_changed integer := 0;
  v_rows_inserted integer := 0;
  v_rows_updated integer := 0;
  v_timeseries_hours_changed integer := 0;
  v_timeseries_hours_changed_gt_cutoff integer := 0;
  v_max_changed_lag_hours numeric := null;
  v_reference_effective_date date := null;
begin
  set local statement_timeout = '15min';

  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  if p_rows is null
     or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) = 0 then
    return query
    select 0, 0, 0, 0, 0, 0, null::numeric;
    return;
  end if;

  if p_reference_hour is not null then
    v_reference_effective_date := (p_reference_hour at time zone 'UTC')::date;
  end if;

  with incoming_raw as (
    select
      r.timeseries_id,
      r.station_id,
      r.connector_id,
      lower(nullif(trim(r.pollutant_code), '')) as pollutant_code,
      date_trunc('hour', r.timestamp_hour_utc) as timestamp_hour_utc,
      r.daqi_input_value_ugm3,
      nullif(trim(r.daqi_input_averaging_code), '') as daqi_input_averaging_code,
      r.daqi_index_level,
      r.daqi_source_observation_count,
      r.daqi_required_observation_count,
      nullif(trim(r.daqi_calculation_status), '') as daqi_calculation_status,
      nullif(trim(r.daqi_missing_reason), '') as daqi_missing_reason,
      r.eaqi_input_value_ugm3,
      nullif(trim(r.eaqi_input_averaging_code), '') as eaqi_input_averaging_code,
      r.eaqi_index_level,
      r.eaqi_source_observation_count,
      r.eaqi_required_observation_count,
      nullif(trim(r.eaqi_calculation_status), '') as eaqi_calculation_status,
      nullif(trim(r.eaqi_missing_reason), '') as eaqi_missing_reason,
      r.hourly_sample_count,
      nullif(trim(r.algorithm_version), '') as algorithm_version,
      r.computed_at_utc,
      r.hourly_mean_ugm3,
      r.rolling24h_mean_ugm3
    from jsonb_to_recordset(p_rows) as r(
      timeseries_id integer,
      station_id bigint,
      connector_id integer,
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
      rolling24h_mean_ugm3 double precision
    )
    where r.timeseries_id is not null
      and r.connector_id is not null
      and r.timestamp_hour_utc is not null
      and lower(nullif(trim(r.pollutant_code), '')) in ('pm25', 'pm10', 'no2')
  ),
  incoming_base as (
    select
      r.timeseries_id,
      coalesce(r.station_id, ts.station_id) as station_id,
      r.connector_id,
      r.pollutant_code,
      r.timestamp_hour_utc,
      coalesce(
        r.daqi_input_value_ugm3,
        r.rolling24h_mean_ugm3,
        case when r.pollutant_code = 'no2' then r.hourly_mean_ugm3 else null end
      ) as daqi_input_value_ugm3,
      coalesce(
        r.daqi_input_averaging_code,
        case when r.pollutant_code = 'no2' then 'hourly_mean' else 'rolling_24h_mean' end
      ) as daqi_input_averaging_code,
      coalesce(
        r.eaqi_input_value_ugm3,
        r.hourly_mean_ugm3
      ) as eaqi_input_value_ugm3,
      coalesce(r.eaqi_input_averaging_code, 'hourly_mean') as eaqi_input_averaging_code,
      r.daqi_source_observation_count,
      r.daqi_required_observation_count,
      r.daqi_calculation_status,
      r.daqi_missing_reason,
      r.eaqi_source_observation_count,
      r.eaqi_required_observation_count,
      r.eaqi_calculation_status,
      r.eaqi_missing_reason,
      r.daqi_index_level,
      r.eaqi_index_level,
      coalesce(r.hourly_sample_count, r.eaqi_source_observation_count, r.daqi_source_observation_count) as hourly_sample_count,
      r.algorithm_version,
      r.computed_at_utc
    from incoming_raw r
    left join uk_aq_core.timeseries ts
      on ts.id = r.timeseries_id
     and ts.connector_id = r.connector_id
  ),
  incoming as (
    select
      b.timeseries_id,
      b.station_id,
      b.connector_id,
      b.pollutant_code,
      b.timestamp_hour_utc,
      coalesce(b.daqi_input_value_ugm3, e.daqi_input_value_ugm3) as daqi_input_value_ugm3,
      coalesce(b.daqi_input_averaging_code, e.daqi_input_averaging_code) as daqi_input_averaging_code,
      coalesce(b.daqi_index_level, daqi_lookup.index_level, e.daqi_index_level) as daqi_index_level,
      coalesce(b.daqi_source_observation_count, e.daqi_source_observation_count, b.hourly_sample_count, e.hourly_sample_count) as daqi_source_observation_count,
      coalesce(
        b.daqi_required_observation_count,
        e.daqi_required_observation_count,
        case when coalesce(b.daqi_input_averaging_code, e.daqi_input_averaging_code) = 'rolling_24h_mean' then 24 else 1 end
      ) as daqi_required_observation_count,
      coalesce(
        b.daqi_calculation_status,
        e.daqi_calculation_status,
        case when coalesce(b.daqi_input_value_ugm3, e.daqi_input_value_ugm3) is null then 'missing_input' else 'ok' end
      ) as daqi_calculation_status,
      coalesce(b.daqi_missing_reason, e.daqi_missing_reason) as daqi_missing_reason,
      coalesce(b.eaqi_input_value_ugm3, e.eaqi_input_value_ugm3) as eaqi_input_value_ugm3,
      coalesce(b.eaqi_input_averaging_code, e.eaqi_input_averaging_code) as eaqi_input_averaging_code,
      coalesce(b.eaqi_index_level, eaqi_lookup.index_level, e.eaqi_index_level) as eaqi_index_level,
      coalesce(b.eaqi_source_observation_count, e.eaqi_source_observation_count, b.hourly_sample_count, e.hourly_sample_count) as eaqi_source_observation_count,
      coalesce(b.eaqi_required_observation_count, e.eaqi_required_observation_count, 1) as eaqi_required_observation_count,
      coalesce(
        b.eaqi_calculation_status,
        e.eaqi_calculation_status,
        case when coalesce(b.eaqi_input_value_ugm3, e.eaqi_input_value_ugm3) is null then 'missing_input' else 'ok' end
      ) as eaqi_calculation_status,
      coalesce(b.eaqi_missing_reason, e.eaqi_missing_reason) as eaqi_missing_reason,
      coalesce(b.hourly_sample_count, e.hourly_sample_count) as hourly_sample_count,
      coalesce(b.algorithm_version, e.algorithm_version, 'aqilevels_hourly_v1') as algorithm_version,
      coalesce(b.computed_at_utc, e.computed_at_utc, now()) as computed_at_utc,
      coalesce(b.eaqi_input_value_ugm3, e.eaqi_input_value_ugm3, e.hourly_mean_ugm3) as hourly_mean_ugm3,
      case
        when b.pollutant_code in ('pm25', 'pm10') then coalesce(b.daqi_input_value_ugm3, e.daqi_input_value_ugm3, e.rolling24h_mean_ugm3)
        else null
      end as rolling24h_mean_ugm3
    from incoming_base b
    left join uk_aq_aqilevels.timeseries_aqi_hourly e
      on e.timeseries_id = b.timeseries_id
     and e.timestamp_hour_utc = b.timestamp_hour_utc
    left join lateral uk_aq_aqilevels.uk_aq_aqi_index_lookup(
      'daqi',
      b.pollutant_code,
      coalesce(b.daqi_input_averaging_code, e.daqi_input_averaging_code),
      coalesce(b.daqi_input_value_ugm3, e.daqi_input_value_ugm3),
      coalesce(v_reference_effective_date, (b.timestamp_hour_utc at time zone 'UTC')::date)
    ) daqi_lookup on true
    left join lateral uk_aq_aqilevels.uk_aq_aqi_index_lookup(
      'eaqi',
      b.pollutant_code,
      coalesce(b.eaqi_input_averaging_code, e.eaqi_input_averaging_code),
      coalesce(b.eaqi_input_value_ugm3, e.eaqi_input_value_ugm3),
      coalesce(v_reference_effective_date, (b.timestamp_hour_utc at time zone 'UTC')::date)
    ) eaqi_lookup on true
  ),
  dedup as (
    select distinct on (timeseries_id, timestamp_hour_utc)
      i.*
    from incoming i
    order by i.timeseries_id, i.timestamp_hour_utc
  ),
  compared as (
    select
      d.*,
      (e.timeseries_id is null) as is_insert,
      (
        e.timeseries_id is null
        or (
          (
            e.station_id,
            e.connector_id,
            e.pollutant_code,
            e.hourly_mean_ugm3,
            e.rolling24h_mean_ugm3,
            e.hourly_sample_count,
            e.daqi_index_level,
            e.eaqi_index_level,
            e.daqi_input_value_ugm3,
            e.daqi_input_averaging_code,
            e.daqi_source_observation_count,
            e.daqi_required_observation_count,
            e.daqi_calculation_status,
            e.daqi_missing_reason,
            e.eaqi_input_value_ugm3,
            e.eaqi_input_averaging_code,
            e.eaqi_source_observation_count,
            e.eaqi_required_observation_count,
            e.eaqi_calculation_status,
            e.eaqi_missing_reason,
            e.algorithm_version,
            e.computed_at_utc
          )
          is distinct from
          (
            d.station_id,
            d.connector_id,
            d.pollutant_code,
            d.hourly_mean_ugm3,
            d.rolling24h_mean_ugm3,
            d.hourly_sample_count,
            d.daqi_index_level,
            d.eaqi_index_level,
            d.daqi_input_value_ugm3,
            d.daqi_input_averaging_code,
            d.daqi_source_observation_count,
            d.daqi_required_observation_count,
            d.daqi_calculation_status,
            d.daqi_missing_reason,
            d.eaqi_input_value_ugm3,
            d.eaqi_input_averaging_code,
            d.eaqi_source_observation_count,
            d.eaqi_required_observation_count,
            d.eaqi_calculation_status,
            d.eaqi_missing_reason,
            d.algorithm_version,
            d.computed_at_utc
          )
        )
      ) as is_changed
    from dedup d
    left join uk_aq_aqilevels.timeseries_aqi_hourly e
      on e.timeseries_id = d.timeseries_id
     and e.timestamp_hour_utc = d.timestamp_hour_utc
  ),
  summary as (
    select
      count(*)::integer as rows_attempted,
      count(*) filter (where is_changed)::integer as rows_changed,
      count(*) filter (where is_changed and is_insert)::integer as rows_inserted,
      count(*) filter (where is_changed and not is_insert)::integer as rows_updated,
      count(*) filter (where is_changed)::integer as timeseries_hours_changed,
      count(*) filter (
        where is_changed
          and p_late_cutoff_hour is not null
          and timestamp_hour_utc < p_late_cutoff_hour
      )::integer as timeseries_hours_changed_gt_cutoff,
      max(
        case
          when is_changed and p_reference_hour is not null then
            greatest(0, extract(epoch from (p_reference_hour - timestamp_hour_utc)) / 3600.0)
          else null
        end
      )::numeric as max_changed_lag_hours
    from compared
  ),
  upserted as (
    insert into uk_aq_aqilevels.timeseries_aqi_hourly (
      timeseries_id,
      station_id,
      connector_id,
      pollutant_code,
      timestamp_hour_utc,
      hourly_mean_ugm3,
      rolling24h_mean_ugm3,
      hourly_sample_count,
      daqi_index_level,
      eaqi_index_level,
      updated_at,
      daqi_input_value_ugm3,
      daqi_input_averaging_code,
      daqi_source_observation_count,
      daqi_required_observation_count,
      daqi_calculation_status,
      daqi_missing_reason,
      eaqi_input_value_ugm3,
      eaqi_input_averaging_code,
      eaqi_source_observation_count,
      eaqi_required_observation_count,
      eaqi_calculation_status,
      eaqi_missing_reason,
      algorithm_version,
      computed_at_utc
    )
    select
      c.timeseries_id,
      c.station_id,
      c.connector_id,
      c.pollutant_code,
      c.timestamp_hour_utc,
      c.hourly_mean_ugm3,
      c.rolling24h_mean_ugm3,
      c.hourly_sample_count,
      c.daqi_index_level,
      c.eaqi_index_level,
      now(),
      c.daqi_input_value_ugm3,
      c.daqi_input_averaging_code,
      c.daqi_source_observation_count,
      c.daqi_required_observation_count,
      c.daqi_calculation_status,
      c.daqi_missing_reason,
      c.eaqi_input_value_ugm3,
      c.eaqi_input_averaging_code,
      c.eaqi_source_observation_count,
      c.eaqi_required_observation_count,
      c.eaqi_calculation_status,
      c.eaqi_missing_reason,
      c.algorithm_version,
      c.computed_at_utc
    from compared c
    where c.is_changed
    on conflict (timeseries_id, timestamp_hour_utc) do update
    set
      station_id = excluded.station_id,
      connector_id = excluded.connector_id,
      pollutant_code = excluded.pollutant_code,
      hourly_mean_ugm3 = excluded.hourly_mean_ugm3,
      rolling24h_mean_ugm3 = excluded.rolling24h_mean_ugm3,
      hourly_sample_count = excluded.hourly_sample_count,
      daqi_index_level = excluded.daqi_index_level,
      eaqi_index_level = excluded.eaqi_index_level,
      updated_at = now(),
      daqi_input_value_ugm3 = excluded.daqi_input_value_ugm3,
      daqi_input_averaging_code = excluded.daqi_input_averaging_code,
      daqi_source_observation_count = excluded.daqi_source_observation_count,
      daqi_required_observation_count = excluded.daqi_required_observation_count,
      daqi_calculation_status = excluded.daqi_calculation_status,
      daqi_missing_reason = excluded.daqi_missing_reason,
      eaqi_input_value_ugm3 = excluded.eaqi_input_value_ugm3,
      eaqi_input_averaging_code = excluded.eaqi_input_averaging_code,
      eaqi_source_observation_count = excluded.eaqi_source_observation_count,
      eaqi_required_observation_count = excluded.eaqi_required_observation_count,
      eaqi_calculation_status = excluded.eaqi_calculation_status,
      eaqi_missing_reason = excluded.eaqi_missing_reason,
      algorithm_version = excluded.algorithm_version,
      computed_at_utc = excluded.computed_at_utc
    where
      (
        uk_aq_aqilevels.timeseries_aqi_hourly.station_id,
        uk_aq_aqilevels.timeseries_aqi_hourly.connector_id,
        uk_aq_aqilevels.timeseries_aqi_hourly.pollutant_code,
        uk_aq_aqilevels.timeseries_aqi_hourly.hourly_mean_ugm3,
        uk_aq_aqilevels.timeseries_aqi_hourly.rolling24h_mean_ugm3,
        uk_aq_aqilevels.timeseries_aqi_hourly.hourly_sample_count,
        uk_aq_aqilevels.timeseries_aqi_hourly.daqi_index_level,
        uk_aq_aqilevels.timeseries_aqi_hourly.eaqi_index_level,
        uk_aq_aqilevels.timeseries_aqi_hourly.daqi_input_value_ugm3,
        uk_aq_aqilevels.timeseries_aqi_hourly.daqi_input_averaging_code,
        uk_aq_aqilevels.timeseries_aqi_hourly.daqi_source_observation_count,
        uk_aq_aqilevels.timeseries_aqi_hourly.daqi_required_observation_count,
        uk_aq_aqilevels.timeseries_aqi_hourly.daqi_calculation_status,
        uk_aq_aqilevels.timeseries_aqi_hourly.daqi_missing_reason,
        uk_aq_aqilevels.timeseries_aqi_hourly.eaqi_input_value_ugm3,
        uk_aq_aqilevels.timeseries_aqi_hourly.eaqi_input_averaging_code,
        uk_aq_aqilevels.timeseries_aqi_hourly.eaqi_source_observation_count,
        uk_aq_aqilevels.timeseries_aqi_hourly.eaqi_required_observation_count,
        uk_aq_aqilevels.timeseries_aqi_hourly.eaqi_calculation_status,
        uk_aq_aqilevels.timeseries_aqi_hourly.eaqi_missing_reason,
        uk_aq_aqilevels.timeseries_aqi_hourly.algorithm_version,
        uk_aq_aqilevels.timeseries_aqi_hourly.computed_at_utc
      )
      is distinct from
      (
        excluded.station_id,
        excluded.connector_id,
        excluded.pollutant_code,
        excluded.hourly_mean_ugm3,
        excluded.rolling24h_mean_ugm3,
        excluded.hourly_sample_count,
        excluded.daqi_index_level,
        excluded.eaqi_index_level,
        excluded.daqi_input_value_ugm3,
        excluded.daqi_input_averaging_code,
        excluded.daqi_source_observation_count,
        excluded.daqi_required_observation_count,
        excluded.daqi_calculation_status,
        excluded.daqi_missing_reason,
        excluded.eaqi_input_value_ugm3,
        excluded.eaqi_input_averaging_code,
        excluded.eaqi_source_observation_count,
        excluded.eaqi_required_observation_count,
        excluded.eaqi_calculation_status,
        excluded.eaqi_missing_reason,
        excluded.algorithm_version,
        excluded.computed_at_utc
      )
    returning 1
  )
  select
    s.rows_attempted,
    s.rows_changed,
    s.rows_inserted,
    s.rows_updated,
    s.timeseries_hours_changed,
    s.timeseries_hours_changed_gt_cutoff,
    s.max_changed_lag_hours
  into
    v_rows_attempted,
    v_rows_changed,
    v_rows_inserted,
    v_rows_updated,
    v_timeseries_hours_changed,
    v_timeseries_hours_changed_gt_cutoff,
    v_max_changed_lag_hours
  from summary s;

  return query
  select
    coalesce(v_rows_attempted, 0),
    coalesce(v_rows_changed, 0),
    coalesce(v_rows_inserted, 0),
    coalesce(v_rows_updated, 0),
    coalesce(v_timeseries_hours_changed, 0),
    coalesce(v_timeseries_hours_changed_gt_cutoff, 0),
    v_max_changed_lag_hours;
end;
$function$;

commit;
