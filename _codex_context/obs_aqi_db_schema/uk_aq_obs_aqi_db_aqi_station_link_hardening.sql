-- Focused apply: AQI station-link hardening and rollup join fix
-- Generated from uk_aq_obs_aqi_db_schema.sql

alter table if exists uk_aq_aqilevels.timeseries_aqi_hourly
  add column if not exists no2_hourly_mean_ugm3 double precision;

alter table if exists uk_aq_aqilevels.timeseries_aqi_hourly
  add column if not exists pm25_hourly_mean_ugm3 double precision;

alter table if exists uk_aq_aqilevels.timeseries_aqi_hourly
  add column if not exists pm10_hourly_mean_ugm3 double precision;

alter table if exists uk_aq_aqilevels.timeseries_aqi_hourly
  add column if not exists pm25_rolling24h_mean_ugm3 double precision;

alter table if exists uk_aq_aqilevels.timeseries_aqi_hourly
  add column if not exists pm10_rolling24h_mean_ugm3 double precision;

alter table if exists uk_aq_aqilevels.timeseries_aqi_hourly
  add column if not exists daqi_no2_index_level smallint;

alter table if exists uk_aq_aqilevels.timeseries_aqi_hourly
  add column if not exists daqi_pm25_rolling24h_index_level smallint;

alter table if exists uk_aq_aqilevels.timeseries_aqi_hourly
  add column if not exists daqi_pm10_rolling24h_index_level smallint;

alter table if exists uk_aq_aqilevels.timeseries_aqi_hourly
  add column if not exists eaqi_no2_index_level smallint;

alter table if exists uk_aq_aqilevels.timeseries_aqi_hourly
  add column if not exists eaqi_pm25_index_level smallint;

alter table if exists uk_aq_aqilevels.timeseries_aqi_hourly
  add column if not exists eaqi_pm10_index_level smallint;

drop function if exists uk_aq_public.uk_aq_rpc_timeseries_aqi_hourly_upsert(
  jsonb,
  timestamptz,
  timestamptz
);

create or replace function uk_aq_public.uk_aq_rpc_timeseries_aqi_hourly_upsert(
  p_rows jsonb,
  p_late_cutoff_hour timestamptz default null,
  p_reference_hour timestamptz default null
)
returns table (
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
set search_path = uk_aq_aqilevels, public, pg_catalog
as $$
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
      r.pollutant_code,
      date_trunc('hour', r.timestamp_hour_utc) as timestamp_hour_utc,
      r.daqi_input_value_ugm3,
      r.daqi_input_averaging_code,
      r.daqi_index_level,
      r.daqi_source_observation_count,
      r.daqi_required_observation_count,
      r.daqi_calculation_status,
      r.daqi_missing_reason,
      r.eaqi_input_value_ugm3,
      r.eaqi_input_averaging_code,
      r.eaqi_index_level,
      r.eaqi_source_observation_count,
      r.eaqi_required_observation_count,
      r.eaqi_calculation_status,
      r.eaqi_missing_reason,
      r.hourly_sample_count,
      r.algorithm_version,
      r.computed_at_utc,
      r.hourly_mean_ugm3,
      r.rolling24h_mean_ugm3,
      r.no2_hourly_mean_ugm3,
      r.pm25_hourly_mean_ugm3,
      r.pm10_hourly_mean_ugm3,
      r.pm25_rolling24h_mean_ugm3,
      r.pm10_rolling24h_mean_ugm3,
      r.daqi_no2_index_level,
      r.daqi_pm25_rolling24h_index_level,
      r.daqi_pm10_rolling24h_index_level,
      r.eaqi_no2_index_level,
      r.eaqi_pm25_index_level,
      r.eaqi_pm10_index_level
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
      eaqi_pm10_index_level smallint
    )
    where r.timeseries_id is not null
      and r.connector_id is not null
      and r.timestamp_hour_utc is not null
      and r.pollutant_code in ('pm25', 'pm10', 'no2')
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
        case r.pollutant_code
          when 'no2' then r.hourly_mean_ugm3
          when 'pm25' then coalesce(r.rolling24h_mean_ugm3, r.pm25_rolling24h_mean_ugm3)
          when 'pm10' then coalesce(r.rolling24h_mean_ugm3, r.pm10_rolling24h_mean_ugm3)
          else null
        end
      ) as daqi_input_value_ugm3,
      coalesce(
        nullif(trim(r.daqi_input_averaging_code), ''),
        case
          when r.pollutant_code = 'no2' then 'hourly_mean'
          else 'rolling_24h_mean'
        end
      ) as daqi_input_averaging_code,
      coalesce(
        r.eaqi_input_value_ugm3,
        case r.pollutant_code
          when 'no2' then r.hourly_mean_ugm3
          when 'pm25' then r.pm25_hourly_mean_ugm3
          when 'pm10' then r.pm10_hourly_mean_ugm3
          else null
        end
      ) as eaqi_input_value_ugm3,
      coalesce(
        nullif(trim(r.eaqi_input_averaging_code), ''),
        'hourly_mean'
      ) as eaqi_input_averaging_code,
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
      coalesce(r.hourly_sample_count, r.daqi_source_observation_count, r.eaqi_source_observation_count) as hourly_sample_count,
      nullif(trim(r.algorithm_version), '') as algorithm_version,
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
      coalesce(b.daqi_source_observation_count, b.hourly_sample_count, e.daqi_source_observation_count, e.hourly_sample_count) as daqi_source_observation_count,
      coalesce(
        b.daqi_required_observation_count,
        case
          when coalesce(b.daqi_input_averaging_code, e.daqi_input_averaging_code) = 'rolling_24h_mean' then 24
          else 1
        end
      ) as daqi_required_observation_count,
      coalesce(
        b.daqi_calculation_status,
        case
          when coalesce(b.daqi_input_value_ugm3, e.daqi_input_value_ugm3) is null then 'missing_input'
          else 'ok'
        end
      ) as daqi_calculation_status,
      coalesce(b.daqi_missing_reason, e.daqi_missing_reason) as daqi_missing_reason,
      coalesce(b.eaqi_input_value_ugm3, e.eaqi_input_value_ugm3) as eaqi_input_value_ugm3,
      coalesce(b.eaqi_input_averaging_code, e.eaqi_input_averaging_code) as eaqi_input_averaging_code,
      coalesce(b.eaqi_index_level, eaqi_lookup.index_level, e.eaqi_index_level) as eaqi_index_level,
      coalesce(b.eaqi_source_observation_count, b.hourly_sample_count, e.eaqi_source_observation_count, e.hourly_sample_count) as eaqi_source_observation_count,
      coalesce(
        b.eaqi_required_observation_count,
        case
          when coalesce(b.eaqi_input_averaging_code, e.eaqi_input_averaging_code) = 'rolling_24h_mean' then 24
          else 1
        end
      ) as eaqi_required_observation_count,
      coalesce(
        b.eaqi_calculation_status,
        case
          when coalesce(b.eaqi_input_value_ugm3, e.eaqi_input_value_ugm3) is null then 'missing_input'
          else 'ok'
        end
      ) as eaqi_calculation_status,
      coalesce(b.eaqi_missing_reason, e.eaqi_missing_reason) as eaqi_missing_reason,
      coalesce(b.hourly_sample_count, e.hourly_sample_count) as hourly_sample_count,
      coalesce(b.algorithm_version, e.algorithm_version, 'aqilevels_hourly_v1') as algorithm_version,
      coalesce(b.computed_at_utc, e.computed_at_utc, now()) as computed_at_utc,
      coalesce(b.eaqi_input_value_ugm3, e.eaqi_input_value_ugm3) as hourly_mean_ugm3,
      case
        when b.pollutant_code in ('pm25', 'pm10') then coalesce(b.daqi_input_value_ugm3, e.daqi_input_value_ugm3)
        else null
      end as rolling24h_mean_ugm3,
      case
        when b.pollutant_code = 'no2' then coalesce(b.eaqi_input_value_ugm3, e.eaqi_input_value_ugm3)
        else null
      end as no2_hourly_mean_ugm3,
      case
        when b.pollutant_code = 'pm25' then coalesce(b.eaqi_input_value_ugm3, e.eaqi_input_value_ugm3)
        else null
      end as pm25_hourly_mean_ugm3,
      case
        when b.pollutant_code = 'pm10' then coalesce(b.eaqi_input_value_ugm3, e.eaqi_input_value_ugm3)
        else null
      end as pm10_hourly_mean_ugm3,
      case
        when b.pollutant_code = 'pm25' then coalesce(b.daqi_input_value_ugm3, e.daqi_input_value_ugm3)
        else null
      end as pm25_rolling24h_mean_ugm3,
      case
        when b.pollutant_code = 'pm10' then coalesce(b.daqi_input_value_ugm3, e.daqi_input_value_ugm3)
        else null
      end as pm10_rolling24h_mean_ugm3,
      case
        when b.pollutant_code = 'no2' then coalesce(b.daqi_index_level, daqi_lookup.index_level, e.daqi_index_level)
        else null
      end as daqi_no2_index_level,
      case
        when b.pollutant_code = 'pm25' then coalesce(b.daqi_index_level, daqi_lookup.index_level, e.daqi_index_level)
        else null
      end as daqi_pm25_rolling24h_index_level,
      case
        when b.pollutant_code = 'pm10' then coalesce(b.daqi_index_level, daqi_lookup.index_level, e.daqi_index_level)
        else null
      end as daqi_pm10_rolling24h_index_level,
      case
        when b.pollutant_code = 'no2' then coalesce(b.eaqi_index_level, eaqi_lookup.index_level, e.eaqi_index_level)
        else null
      end as eaqi_no2_index_level,
      case
        when b.pollutant_code = 'pm25' then coalesce(b.eaqi_index_level, eaqi_lookup.index_level, e.eaqi_index_level)
        else null
      end as eaqi_pm25_index_level,
      case
        when b.pollutant_code = 'pm10' then coalesce(b.eaqi_index_level, eaqi_lookup.index_level, e.eaqi_index_level)
        else null
      end as eaqi_pm10_index_level
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
            e.daqi_input_value_ugm3,
            e.daqi_input_averaging_code,
            e.daqi_index_level,
            e.daqi_source_observation_count,
            e.daqi_required_observation_count,
            e.daqi_calculation_status,
            e.daqi_missing_reason,
            e.eaqi_input_value_ugm3,
            e.eaqi_input_averaging_code,
            e.eaqi_index_level,
            e.eaqi_source_observation_count,
            e.eaqi_required_observation_count,
            e.eaqi_calculation_status,
            e.eaqi_missing_reason,
            e.hourly_sample_count,
            e.algorithm_version,
            e.computed_at_utc
          )
          is distinct from
          (
            d.station_id,
            d.connector_id,
            d.pollutant_code,
            d.daqi_input_value_ugm3,
            d.daqi_input_averaging_code,
            d.daqi_index_level,
            d.daqi_source_observation_count,
            d.daqi_required_observation_count,
            d.daqi_calculation_status,
            d.daqi_missing_reason,
            d.eaqi_input_value_ugm3,
            d.eaqi_input_averaging_code,
            d.eaqi_index_level,
            d.eaqi_source_observation_count,
            d.eaqi_required_observation_count,
            d.eaqi_calculation_status,
            d.eaqi_missing_reason,
            d.hourly_sample_count,
            d.algorithm_version,
            d.computed_at_utc
          )
        )
      ) as is_changed
    from dedup d
    left join uk_aq_aqilevels.timeseries_aqi_hourly e
      on e.timeseries_id = d.timeseries_id
     and e.timestamp_hour_utc = d.timestamp_hour_utc
  )
  select
    count(*)::integer,
    count(*) filter (where is_changed)::integer,
    count(*) filter (where is_changed and is_insert)::integer,
    count(*) filter (where is_changed and not is_insert)::integer,
    count(*) filter (where is_changed)::integer,
    count(*) filter (
      where is_changed
        and p_late_cutoff_hour is not null
        and timestamp_hour_utc < p_late_cutoff_hour
    )::integer,
    max(
      case
        when is_changed and p_reference_hour is not null then
          greatest(
            0,
            extract(epoch from (p_reference_hour - timestamp_hour_utc)) / 3600.0
          )
        else null
      end
    )::numeric
  into
    v_rows_attempted,
    v_rows_changed,
    v_rows_inserted,
    v_rows_updated,
    v_timeseries_hours_changed,
    v_timeseries_hours_changed_gt_cutoff,
    v_max_changed_lag_hours
  from compared;

  with incoming_raw as (
    select
      r.timeseries_id,
      r.station_id,
      r.connector_id,
      r.pollutant_code,
      date_trunc('hour', r.timestamp_hour_utc) as timestamp_hour_utc,
      r.daqi_input_value_ugm3,
      r.daqi_input_averaging_code,
      r.daqi_index_level,
      r.daqi_source_observation_count,
      r.daqi_required_observation_count,
      r.daqi_calculation_status,
      r.daqi_missing_reason,
      r.eaqi_input_value_ugm3,
      r.eaqi_input_averaging_code,
      r.eaqi_index_level,
      r.eaqi_source_observation_count,
      r.eaqi_required_observation_count,
      r.eaqi_calculation_status,
      r.eaqi_missing_reason,
      r.hourly_sample_count,
      r.algorithm_version,
      r.computed_at_utc,
      r.hourly_mean_ugm3,
      r.rolling24h_mean_ugm3,
      r.no2_hourly_mean_ugm3,
      r.pm25_hourly_mean_ugm3,
      r.pm10_hourly_mean_ugm3,
      r.pm25_rolling24h_mean_ugm3,
      r.pm10_rolling24h_mean_ugm3,
      r.daqi_no2_index_level,
      r.daqi_pm25_rolling24h_index_level,
      r.daqi_pm10_rolling24h_index_level,
      r.eaqi_no2_index_level,
      r.eaqi_pm25_index_level,
      r.eaqi_pm10_index_level
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
      eaqi_pm10_index_level smallint
    )
    where r.timeseries_id is not null
      and r.connector_id is not null
      and r.timestamp_hour_utc is not null
      and r.pollutant_code in ('pm25', 'pm10', 'no2')
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
        case r.pollutant_code
          when 'no2' then r.hourly_mean_ugm3
          when 'pm25' then coalesce(r.rolling24h_mean_ugm3, r.pm25_rolling24h_mean_ugm3)
          when 'pm10' then coalesce(r.rolling24h_mean_ugm3, r.pm10_rolling24h_mean_ugm3)
          else null
        end
      ) as daqi_input_value_ugm3,
      coalesce(
        nullif(trim(r.daqi_input_averaging_code), ''),
        case
          when r.pollutant_code = 'no2' then 'hourly_mean'
          else 'rolling_24h_mean'
        end
      ) as daqi_input_averaging_code,
      coalesce(
        r.eaqi_input_value_ugm3,
        case r.pollutant_code
          when 'no2' then r.hourly_mean_ugm3
          when 'pm25' then r.pm25_hourly_mean_ugm3
          when 'pm10' then r.pm10_hourly_mean_ugm3
          else null
        end
      ) as eaqi_input_value_ugm3,
      coalesce(
        nullif(trim(r.eaqi_input_averaging_code), ''),
        'hourly_mean'
      ) as eaqi_input_averaging_code,
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
      coalesce(r.hourly_sample_count, r.daqi_source_observation_count, r.eaqi_source_observation_count) as hourly_sample_count,
      nullif(trim(r.algorithm_version), '') as algorithm_version,
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
      coalesce(b.daqi_source_observation_count, e.daqi_source_observation_count) as daqi_source_observation_count,
      coalesce(
        b.daqi_required_observation_count,
        e.daqi_required_observation_count,
        case
          when coalesce(b.daqi_input_averaging_code, e.daqi_input_averaging_code) = 'rolling_24h_mean' then 24
          else 1
        end
      ) as daqi_required_observation_count,
      coalesce(
        b.daqi_calculation_status,
        e.daqi_calculation_status,
        case
          when coalesce(b.daqi_input_value_ugm3, e.daqi_input_value_ugm3) is null then 'missing_input'
          else 'ok'
        end
      ) as daqi_calculation_status,
      coalesce(b.daqi_missing_reason, e.daqi_missing_reason) as daqi_missing_reason,
      coalesce(b.eaqi_input_value_ugm3, e.eaqi_input_value_ugm3) as eaqi_input_value_ugm3,
      coalesce(b.eaqi_input_averaging_code, e.eaqi_input_averaging_code) as eaqi_input_averaging_code,
      coalesce(b.eaqi_index_level, eaqi_lookup.index_level, e.eaqi_index_level) as eaqi_index_level,
      coalesce(b.eaqi_source_observation_count, e.eaqi_source_observation_count) as eaqi_source_observation_count,
      coalesce(
        b.eaqi_required_observation_count,
        e.eaqi_required_observation_count,
        1
      ) as eaqi_required_observation_count,
      coalesce(
        b.eaqi_calculation_status,
        e.eaqi_calculation_status,
        case
          when coalesce(b.eaqi_input_value_ugm3, e.eaqi_input_value_ugm3) is null then 'missing_input'
          else 'ok'
        end
      ) as eaqi_calculation_status,
      coalesce(b.eaqi_missing_reason, e.eaqi_missing_reason) as eaqi_missing_reason,
      coalesce(b.hourly_sample_count, e.hourly_sample_count) as hourly_sample_count,
      coalesce(b.algorithm_version, e.algorithm_version, 'aqilevels_hourly_v1') as algorithm_version,
      coalesce(b.computed_at_utc, e.computed_at_utc, now()) as computed_at_utc,
      coalesce(b.eaqi_input_value_ugm3, e.eaqi_input_value_ugm3) as hourly_mean_ugm3,
      case
        when b.pollutant_code in ('pm25', 'pm10') then coalesce(b.daqi_input_value_ugm3, e.daqi_input_value_ugm3)
        else null
      end as rolling24h_mean_ugm3,
      case
        when b.pollutant_code = 'no2' then coalesce(b.eaqi_input_value_ugm3, e.eaqi_input_value_ugm3)
        else null
      end as no2_hourly_mean_ugm3,
      case
        when b.pollutant_code = 'pm25' then coalesce(b.eaqi_input_value_ugm3, e.eaqi_input_value_ugm3)
        else null
      end as pm25_hourly_mean_ugm3,
      case
        when b.pollutant_code = 'pm10' then coalesce(b.eaqi_input_value_ugm3, e.eaqi_input_value_ugm3)
        else null
      end as pm10_hourly_mean_ugm3,
      case
        when b.pollutant_code = 'pm25' then coalesce(b.daqi_input_value_ugm3, e.daqi_input_value_ugm3)
        else null
      end as pm25_rolling24h_mean_ugm3,
      case
        when b.pollutant_code = 'pm10' then coalesce(b.daqi_input_value_ugm3, e.daqi_input_value_ugm3)
        else null
      end as pm10_rolling24h_mean_ugm3,
      case
        when b.pollutant_code = 'no2' then coalesce(b.daqi_index_level, daqi_lookup.index_level, e.daqi_index_level)
        else null
      end as daqi_no2_index_level,
      case
        when b.pollutant_code = 'pm25' then coalesce(b.daqi_index_level, daqi_lookup.index_level, e.daqi_index_level)
        else null
      end as daqi_pm25_rolling24h_index_level,
      case
        when b.pollutant_code = 'pm10' then coalesce(b.daqi_index_level, daqi_lookup.index_level, e.daqi_index_level)
        else null
      end as daqi_pm10_rolling24h_index_level,
      case
        when b.pollutant_code = 'no2' then coalesce(b.eaqi_index_level, eaqi_lookup.index_level, e.eaqi_index_level)
        else null
      end as eaqi_no2_index_level,
      case
        when b.pollutant_code = 'pm25' then coalesce(b.eaqi_index_level, eaqi_lookup.index_level, e.eaqi_index_level)
        else null
      end as eaqi_pm25_index_level,
      case
        when b.pollutant_code = 'pm10' then coalesce(b.eaqi_index_level, eaqi_lookup.index_level, e.eaqi_index_level)
        else null
      end as eaqi_pm10_index_level
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
  changed as (
    select
      d.*
    from dedup d
    left join uk_aq_aqilevels.timeseries_aqi_hourly e
      on e.timeseries_id = d.timeseries_id
     and e.timestamp_hour_utc = d.timestamp_hour_utc
    where
      e.timeseries_id is null
      or (
        (
          e.station_id,
          e.connector_id,
          e.pollutant_code,
          e.daqi_input_value_ugm3,
          e.daqi_input_averaging_code,
          e.daqi_index_level,
          e.daqi_source_observation_count,
          e.daqi_required_observation_count,
          e.daqi_calculation_status,
          e.daqi_missing_reason,
          e.eaqi_input_value_ugm3,
          e.eaqi_input_averaging_code,
          e.eaqi_index_level,
          e.eaqi_source_observation_count,
          e.eaqi_required_observation_count,
          e.eaqi_calculation_status,
          e.eaqi_missing_reason,
          e.hourly_sample_count,
          e.algorithm_version,
          e.computed_at_utc,
          e.hourly_mean_ugm3,
          e.rolling24h_mean_ugm3,
          e.no2_hourly_mean_ugm3,
          e.pm25_hourly_mean_ugm3,
          e.pm10_hourly_mean_ugm3,
          e.pm25_rolling24h_mean_ugm3,
          e.pm10_rolling24h_mean_ugm3,
          e.daqi_no2_index_level,
          e.daqi_pm25_rolling24h_index_level,
          e.daqi_pm10_rolling24h_index_level,
          e.eaqi_no2_index_level,
          e.eaqi_pm25_index_level,
          e.eaqi_pm10_index_level
        )
        is distinct from
        (
          d.station_id,
          d.connector_id,
          d.pollutant_code,
          d.daqi_input_value_ugm3,
          d.daqi_input_averaging_code,
          d.daqi_index_level,
          d.daqi_source_observation_count,
          d.daqi_required_observation_count,
          d.daqi_calculation_status,
          d.daqi_missing_reason,
          d.eaqi_input_value_ugm3,
          d.eaqi_input_averaging_code,
          d.eaqi_index_level,
          d.eaqi_source_observation_count,
          d.eaqi_required_observation_count,
          d.eaqi_calculation_status,
          d.eaqi_missing_reason,
          d.hourly_sample_count,
          d.algorithm_version,
          d.computed_at_utc,
          d.hourly_mean_ugm3,
          d.rolling24h_mean_ugm3,
          d.no2_hourly_mean_ugm3,
          d.pm25_hourly_mean_ugm3,
          d.pm10_hourly_mean_ugm3,
          d.pm25_rolling24h_mean_ugm3,
          d.pm10_rolling24h_mean_ugm3,
          d.daqi_no2_index_level,
          d.daqi_pm25_rolling24h_index_level,
          d.daqi_pm10_rolling24h_index_level,
          d.eaqi_no2_index_level,
          d.eaqi_pm25_index_level,
          d.eaqi_pm10_index_level
        )
      )
  )
  insert into uk_aq_aqilevels.timeseries_aqi_hourly (
    timeseries_id,
    station_id,
    connector_id,
    pollutant_code,
    timestamp_hour_utc,
    daqi_input_value_ugm3,
    daqi_input_averaging_code,
    daqi_index_level,
    daqi_source_observation_count,
    daqi_required_observation_count,
    daqi_calculation_status,
    daqi_missing_reason,
    eaqi_input_value_ugm3,
    eaqi_input_averaging_code,
    eaqi_index_level,
    eaqi_source_observation_count,
    eaqi_required_observation_count,
    eaqi_calculation_status,
    eaqi_missing_reason,
    hourly_sample_count,
    algorithm_version,
    computed_at_utc,
    hourly_mean_ugm3,
    rolling24h_mean_ugm3,
    no2_hourly_mean_ugm3,
    pm25_hourly_mean_ugm3,
    pm10_hourly_mean_ugm3,
    pm25_rolling24h_mean_ugm3,
    pm10_rolling24h_mean_ugm3,
    daqi_no2_index_level,
    daqi_pm25_rolling24h_index_level,
    daqi_pm10_rolling24h_index_level,
    eaqi_no2_index_level,
    eaqi_pm25_index_level,
    eaqi_pm10_index_level,
    updated_at
  )
  select
    c.timeseries_id,
    c.station_id,
    c.connector_id,
    c.pollutant_code,
    c.timestamp_hour_utc,
    c.daqi_input_value_ugm3,
    c.daqi_input_averaging_code,
    c.daqi_index_level,
    c.daqi_source_observation_count,
    c.daqi_required_observation_count,
    c.daqi_calculation_status,
    c.daqi_missing_reason,
    c.eaqi_input_value_ugm3,
    c.eaqi_input_averaging_code,
    c.eaqi_index_level,
    c.eaqi_source_observation_count,
    c.eaqi_required_observation_count,
    c.eaqi_calculation_status,
    c.eaqi_missing_reason,
    c.hourly_sample_count,
    c.algorithm_version,
    c.computed_at_utc,
    c.hourly_mean_ugm3,
    c.rolling24h_mean_ugm3,
    c.no2_hourly_mean_ugm3,
    c.pm25_hourly_mean_ugm3,
    c.pm10_hourly_mean_ugm3,
    c.pm25_rolling24h_mean_ugm3,
    c.pm10_rolling24h_mean_ugm3,
    c.daqi_no2_index_level,
    c.daqi_pm25_rolling24h_index_level,
    c.daqi_pm10_rolling24h_index_level,
    c.eaqi_no2_index_level,
    c.eaqi_pm25_index_level,
    c.eaqi_pm10_index_level,
    now()
  from changed c
  on conflict (timeseries_id, timestamp_hour_utc) do update
  set
    station_id = excluded.station_id,
    connector_id = excluded.connector_id,
    pollutant_code = excluded.pollutant_code,
    daqi_input_value_ugm3 = excluded.daqi_input_value_ugm3,
    daqi_input_averaging_code = excluded.daqi_input_averaging_code,
    daqi_index_level = excluded.daqi_index_level,
    daqi_source_observation_count = excluded.daqi_source_observation_count,
    daqi_required_observation_count = excluded.daqi_required_observation_count,
    daqi_calculation_status = excluded.daqi_calculation_status,
    daqi_missing_reason = excluded.daqi_missing_reason,
    eaqi_input_value_ugm3 = excluded.eaqi_input_value_ugm3,
    eaqi_input_averaging_code = excluded.eaqi_input_averaging_code,
    eaqi_index_level = excluded.eaqi_index_level,
    eaqi_source_observation_count = excluded.eaqi_source_observation_count,
    eaqi_required_observation_count = excluded.eaqi_required_observation_count,
    eaqi_calculation_status = excluded.eaqi_calculation_status,
    eaqi_missing_reason = excluded.eaqi_missing_reason,
    hourly_sample_count = excluded.hourly_sample_count,
    algorithm_version = excluded.algorithm_version,
    computed_at_utc = excluded.computed_at_utc,
    hourly_mean_ugm3 = excluded.hourly_mean_ugm3,
    rolling24h_mean_ugm3 = excluded.rolling24h_mean_ugm3,
    no2_hourly_mean_ugm3 = excluded.no2_hourly_mean_ugm3,
    pm25_hourly_mean_ugm3 = excluded.pm25_hourly_mean_ugm3,
    pm10_hourly_mean_ugm3 = excluded.pm10_hourly_mean_ugm3,
    pm25_rolling24h_mean_ugm3 = excluded.pm25_rolling24h_mean_ugm3,
    pm10_rolling24h_mean_ugm3 = excluded.pm10_rolling24h_mean_ugm3,
    daqi_no2_index_level = excluded.daqi_no2_index_level,
    daqi_pm25_rolling24h_index_level = excluded.daqi_pm25_rolling24h_index_level,
    daqi_pm10_rolling24h_index_level = excluded.daqi_pm10_rolling24h_index_level,
    eaqi_no2_index_level = excluded.eaqi_no2_index_level,
    eaqi_pm25_index_level = excluded.eaqi_pm25_index_level,
    eaqi_pm10_index_level = excluded.eaqi_pm10_index_level,
    updated_at = now()
  where
    (
      uk_aq_aqilevels.timeseries_aqi_hourly.station_id,
      uk_aq_aqilevels.timeseries_aqi_hourly.connector_id,
      uk_aq_aqilevels.timeseries_aqi_hourly.pollutant_code,
      uk_aq_aqilevels.timeseries_aqi_hourly.daqi_input_value_ugm3,
      uk_aq_aqilevels.timeseries_aqi_hourly.daqi_input_averaging_code,
      uk_aq_aqilevels.timeseries_aqi_hourly.daqi_index_level,
      uk_aq_aqilevels.timeseries_aqi_hourly.daqi_source_observation_count,
      uk_aq_aqilevels.timeseries_aqi_hourly.daqi_required_observation_count,
      uk_aq_aqilevels.timeseries_aqi_hourly.daqi_calculation_status,
      uk_aq_aqilevels.timeseries_aqi_hourly.daqi_missing_reason,
      uk_aq_aqilevels.timeseries_aqi_hourly.eaqi_input_value_ugm3,
      uk_aq_aqilevels.timeseries_aqi_hourly.eaqi_input_averaging_code,
      uk_aq_aqilevels.timeseries_aqi_hourly.eaqi_index_level,
      uk_aq_aqilevels.timeseries_aqi_hourly.eaqi_source_observation_count,
      uk_aq_aqilevels.timeseries_aqi_hourly.eaqi_required_observation_count,
      uk_aq_aqilevels.timeseries_aqi_hourly.eaqi_calculation_status,
      uk_aq_aqilevels.timeseries_aqi_hourly.eaqi_missing_reason,
      uk_aq_aqilevels.timeseries_aqi_hourly.hourly_sample_count,
      uk_aq_aqilevels.timeseries_aqi_hourly.algorithm_version,
      uk_aq_aqilevels.timeseries_aqi_hourly.computed_at_utc,
      uk_aq_aqilevels.timeseries_aqi_hourly.hourly_mean_ugm3,
      uk_aq_aqilevels.timeseries_aqi_hourly.rolling24h_mean_ugm3,
      uk_aq_aqilevels.timeseries_aqi_hourly.no2_hourly_mean_ugm3,
      uk_aq_aqilevels.timeseries_aqi_hourly.pm25_hourly_mean_ugm3,
      uk_aq_aqilevels.timeseries_aqi_hourly.pm10_hourly_mean_ugm3,
      uk_aq_aqilevels.timeseries_aqi_hourly.pm25_rolling24h_mean_ugm3,
      uk_aq_aqilevels.timeseries_aqi_hourly.pm10_rolling24h_mean_ugm3,
      uk_aq_aqilevels.timeseries_aqi_hourly.daqi_no2_index_level,
      uk_aq_aqilevels.timeseries_aqi_hourly.daqi_pm25_rolling24h_index_level,
      uk_aq_aqilevels.timeseries_aqi_hourly.daqi_pm10_rolling24h_index_level,
      uk_aq_aqilevels.timeseries_aqi_hourly.eaqi_no2_index_level,
      uk_aq_aqilevels.timeseries_aqi_hourly.eaqi_pm25_index_level,
      uk_aq_aqilevels.timeseries_aqi_hourly.eaqi_pm10_index_level
    )
    is distinct from
    (
      excluded.station_id,
      excluded.connector_id,
      excluded.pollutant_code,
      excluded.daqi_input_value_ugm3,
      excluded.daqi_input_averaging_code,
      excluded.daqi_index_level,
      excluded.daqi_source_observation_count,
      excluded.daqi_required_observation_count,
      excluded.daqi_calculation_status,
      excluded.daqi_missing_reason,
      excluded.eaqi_input_value_ugm3,
      excluded.eaqi_input_averaging_code,
      excluded.eaqi_index_level,
      excluded.eaqi_source_observation_count,
      excluded.eaqi_required_observation_count,
      excluded.eaqi_calculation_status,
      excluded.eaqi_missing_reason,
      excluded.hourly_sample_count,
      excluded.algorithm_version,
      excluded.computed_at_utc,
      excluded.hourly_mean_ugm3,
      excluded.rolling24h_mean_ugm3,
      excluded.no2_hourly_mean_ugm3,
      excluded.pm25_hourly_mean_ugm3,
      excluded.pm10_hourly_mean_ugm3,
      excluded.pm25_rolling24h_mean_ugm3,
      excluded.pm10_rolling24h_mean_ugm3,
      excluded.daqi_no2_index_level,
      excluded.daqi_pm25_rolling24h_index_level,
      excluded.daqi_pm10_rolling24h_index_level,
      excluded.eaqi_no2_index_level,
      excluded.eaqi_pm25_index_level,
      excluded.eaqi_pm10_index_level
    );

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
$$;
drop function if exists uk_aq_public.uk_aq_rpc_timeseries_aqi_rollups_refresh(
  timestamptz,
  timestamptz,
  integer[]
);

create or replace function uk_aq_public.uk_aq_rpc_timeseries_aqi_rollups_refresh(
  p_start_hour_utc timestamptz,
  p_end_hour_utc timestamptz,
  p_timeseries_ids integer[] default null
)
returns table (
  daily_rows_upserted bigint,
  monthly_rows_upserted bigint
)
language plpgsql
security definer
set search_path = uk_aq_aqilevels, public, pg_catalog
as $$
declare
  v_start_hour timestamptz;
  v_end_hour timestamptz;
  v_start_day date;
  v_end_day date;
  v_start_month date;
  v_end_month date;
  v_daily_rows bigint := 0;
  v_monthly_rows bigint := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  if p_start_hour_utc is null or p_end_hour_utc is null then
    raise exception 'p_start_hour_utc and p_end_hour_utc are required';
  end if;

  v_start_hour := date_trunc('hour', p_start_hour_utc);
  v_end_hour := date_trunc('hour', p_end_hour_utc);
  if v_end_hour <= v_start_hour then
    raise exception 'p_end_hour_utc must be greater than p_start_hour_utc';
  end if;

  set local timezone = 'UTC';

  v_start_day := v_start_hour::date;
  v_end_day := (v_end_hour - interval '1 hour')::date;
  v_start_month := date_trunc('month', v_start_day::timestamp)::date;
  v_end_month := date_trunc('month', v_end_day::timestamp)::date;

  delete from uk_aq_aqilevels.timeseries_aqi_daily d
  where d.observed_day between v_start_day and v_end_day
    and (p_timeseries_ids is null or d.timeseries_id = any(p_timeseries_ids));

  with flat as (
    select
      h.timeseries_id,
      h.station_id,
      h.connector_id,
      h.pollutant_code,
      (h.timestamp_hour_utc at time zone 'UTC')::date as observed_day,
      'daqi'::text as standard_code,
      h.daqi_index_level as index_level
    from uk_aq_aqilevels.timeseries_aqi_hourly h
    where h.timestamp_hour_utc >= v_start_day::timestamptz
      and h.timestamp_hour_utc < (v_end_day + 1)::timestamptz
      and (p_timeseries_ids is null or h.timeseries_id = any(p_timeseries_ids))
    union all
    select
      h.timeseries_id,
      h.station_id,
      h.connector_id,
      h.pollutant_code,
      (h.timestamp_hour_utc at time zone 'UTC')::date,
      'eaqi'::text,
      h.eaqi_index_level
    from uk_aq_aqilevels.timeseries_aqi_hourly h
    where h.timestamp_hour_utc >= v_start_day::timestamptz
      and h.timestamp_hour_utc < (v_end_day + 1)::timestamptz
      and (p_timeseries_ids is null or h.timeseries_id = any(p_timeseries_ids))
  ),
  counts as (
    select
      f.timeseries_id,
      f.station_id,
      f.connector_id,
      f.pollutant_code,
      f.observed_day,
      f.standard_code,
      f.index_level,
      count(*)::integer as cnt
    from flat f
    where f.index_level is not null
    group by
      f.timeseries_id,
      f.station_id,
      f.connector_id,
      f.pollutant_code,
      f.observed_day,
      f.standard_code,
      f.index_level
  ),
  keys as (
    select distinct
      c.timeseries_id,
      c.station_id,
      c.connector_id,
      c.pollutant_code,
      c.observed_day,
      c.standard_code
    from counts c
  ),
  assembled as (
    select
      k.timeseries_id,
      k.station_id,
      k.connector_id,
      k.pollutant_code,
      k.observed_day,
      k.standard_code,
      array_agg(coalesce(c.cnt, 0)::integer order by lvl.level) as index_level_hour_counts,
      coalesce(sum(c.cnt), 0)::smallint as valid_hour_count,
      max(c.index_level)::smallint as max_index_level
    from keys k
    cross join lateral generate_series(
      1,
      case when k.standard_code = 'daqi' then 10 else 6 end
    ) as lvl(level)
    left join counts c
      on c.timeseries_id = k.timeseries_id
     and c.observed_day = k.observed_day
     and c.standard_code = k.standard_code
     and c.pollutant_code = k.pollutant_code
     and c.station_id is not distinct from k.station_id
     and c.connector_id is not distinct from k.connector_id
     and c.index_level = lvl.level
    group by
      k.timeseries_id,
      k.station_id,
      k.connector_id,
      k.pollutant_code,
      k.observed_day,
      k.standard_code
  )
  insert into uk_aq_aqilevels.timeseries_aqi_daily (
    timeseries_id,
    station_id,
    connector_id,
    pollutant_code,
    observed_day,
    standard_code,
    index_level_hour_counts,
    valid_hour_count,
    max_index_level,
    updated_at
  )
  select
    a.timeseries_id,
    a.station_id,
    a.connector_id,
    a.pollutant_code,
    a.observed_day,
    a.standard_code,
    a.index_level_hour_counts,
    a.valid_hour_count,
    a.max_index_level,
    now()
  from assembled a
  on conflict (timeseries_id, observed_day, standard_code, pollutant_code) do update
  set
    station_id = excluded.station_id,
    connector_id = excluded.connector_id,
    index_level_hour_counts = excluded.index_level_hour_counts,
    valid_hour_count = excluded.valid_hour_count,
    max_index_level = excluded.max_index_level,
    updated_at = now();

  get diagnostics v_daily_rows = row_count;

  delete from uk_aq_aqilevels.timeseries_aqi_monthly m
  where m.observed_month between v_start_month and v_end_month
    and (p_timeseries_ids is null or m.timeseries_id = any(p_timeseries_ids));

  with flat as (
    select
      h.timeseries_id,
      h.station_id,
      h.connector_id,
      h.pollutant_code,
      date_trunc('month', h.timestamp_hour_utc at time zone 'UTC')::date as observed_month,
      'daqi'::text as standard_code,
      h.daqi_index_level as index_level
    from uk_aq_aqilevels.timeseries_aqi_hourly h
    where h.timestamp_hour_utc >= v_start_month::timestamptz
      and h.timestamp_hour_utc < (v_end_month + interval '1 month')::timestamptz
      and (p_timeseries_ids is null or h.timeseries_id = any(p_timeseries_ids))
    union all
    select
      h.timeseries_id,
      h.station_id,
      h.connector_id,
      h.pollutant_code,
      date_trunc('month', h.timestamp_hour_utc at time zone 'UTC')::date,
      'eaqi'::text,
      h.eaqi_index_level
    from uk_aq_aqilevels.timeseries_aqi_hourly h
    where h.timestamp_hour_utc >= v_start_month::timestamptz
      and h.timestamp_hour_utc < (v_end_month + interval '1 month')::timestamptz
      and (p_timeseries_ids is null or h.timeseries_id = any(p_timeseries_ids))
  ),
  counts as (
    select
      f.timeseries_id,
      f.station_id,
      f.connector_id,
      f.pollutant_code,
      f.observed_month,
      f.standard_code,
      f.index_level,
      count(*)::integer as cnt
    from flat f
    where f.index_level is not null
    group by
      f.timeseries_id,
      f.station_id,
      f.connector_id,
      f.pollutant_code,
      f.observed_month,
      f.standard_code,
      f.index_level
  ),
  keys as (
    select distinct
      c.timeseries_id,
      c.station_id,
      c.connector_id,
      c.pollutant_code,
      c.observed_month,
      c.standard_code
    from counts c
  ),
  assembled as (
    select
      k.timeseries_id,
      k.station_id,
      k.connector_id,
      k.pollutant_code,
      k.observed_month,
      k.standard_code,
      array_agg(coalesce(c.cnt, 0)::integer order by lvl.level) as index_level_hour_counts,
      coalesce(sum(c.cnt), 0)::integer as valid_hour_count,
      max(c.index_level)::smallint as max_index_level
    from keys k
    cross join lateral generate_series(
      1,
      case when k.standard_code = 'daqi' then 10 else 6 end
    ) as lvl(level)
    left join counts c
      on c.timeseries_id = k.timeseries_id
     and c.observed_month = k.observed_month
     and c.standard_code = k.standard_code
     and c.pollutant_code = k.pollutant_code
     and c.station_id is not distinct from k.station_id
     and c.connector_id is not distinct from k.connector_id
     and c.index_level = lvl.level
    group by
      k.timeseries_id,
      k.station_id,
      k.connector_id,
      k.pollutant_code,
      k.observed_month,
      k.standard_code
  )
  insert into uk_aq_aqilevels.timeseries_aqi_monthly (
    timeseries_id,
    station_id,
    connector_id,
    pollutant_code,
    observed_month,
    standard_code,
    index_level_hour_counts,
    valid_hour_count,
    max_index_level,
    updated_at
  )
  select
    a.timeseries_id,
    a.station_id,
    a.connector_id,
    a.pollutant_code,
    a.observed_month,
    a.standard_code,
    a.index_level_hour_counts,
    a.valid_hour_count,
    a.max_index_level,
    now()
  from assembled a
  on conflict (timeseries_id, observed_month, standard_code, pollutant_code) do update
  set
    station_id = excluded.station_id,
    connector_id = excluded.connector_id,
    index_level_hour_counts = excluded.index_level_hour_counts,
    valid_hour_count = excluded.valid_hour_count,
    max_index_level = excluded.max_index_level,
    updated_at = now();

  get diagnostics v_monthly_rows = row_count;

  return query
  select
    coalesce(v_daily_rows, 0),
    coalesce(v_monthly_rows, 0);
end;
$$;

revoke all on function uk_aq_public.uk_aq_rpc_timeseries_aqi_hourly_upsert(
  jsonb,
  timestamptz,
  timestamptz
) from public;
grant execute on function uk_aq_public.uk_aq_rpc_timeseries_aqi_hourly_upsert(
  jsonb,
  timestamptz,
  timestamptz
) to service_role;

revoke all on function uk_aq_public.uk_aq_rpc_timeseries_aqi_rollups_refresh(
  timestamptz,
  timestamptz,
  integer[]
) from public;
grant execute on function uk_aq_public.uk_aq_rpc_timeseries_aqi_rollups_refresh(
  timestamptz,
  timestamptz,
  integer[]
) to service_role;

drop function if exists uk_aq_public.uk_aq_rpc_timeseries_aqi_station_link_health(
  timestamptz,
  timestamptz,
  integer[]
);

create or replace function uk_aq_public.uk_aq_rpc_timeseries_aqi_station_link_health(
  p_start_hour_utc timestamptz default null,
  p_end_hour_utc timestamptz default null,
  p_timeseries_ids integer[] default null
)
returns table (
  null_station_rows bigint,
  mismatched_station_rows bigint,
  null_station_timeseries integer,
  mismatched_station_timeseries integer,
  sample_null_timeseries_ids integer[],
  sample_mismatched_timeseries_ids integer[]
)
language plpgsql
security definer
set search_path = uk_aq_aqilevels, uk_aq_core, public, pg_catalog
as $$
declare
  v_start_hour timestamptz := null;
  v_end_hour timestamptz := null;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  if (p_start_hour_utc is null) <> (p_end_hour_utc is null) then
    raise exception 'p_start_hour_utc and p_end_hour_utc must both be null or both provided';
  end if;

  if p_start_hour_utc is not null then
    v_start_hour := date_trunc('hour', p_start_hour_utc);
    v_end_hour := date_trunc('hour', p_end_hour_utc);
    if v_end_hour <= v_start_hour then
      raise exception 'p_end_hour_utc must be greater than p_start_hour_utc';
    end if;
  end if;

  return query
  with hourly as (
    select
      h.timeseries_id,
      h.station_id,
      h.timestamp_hour_utc
    from uk_aq_aqilevels.timeseries_aqi_hourly h
    where
      (p_timeseries_ids is null or h.timeseries_id = any(p_timeseries_ids))
      and (v_start_hour is null or h.timestamp_hour_utc >= v_start_hour)
      and (v_end_hour is null or h.timestamp_hour_utc < v_end_hour)
  ),
  joined as (
    select
      h.timeseries_id,
      h.station_id as hourly_station_id,
      ts.station_id as core_station_id
    from hourly h
    join uk_aq_core.timeseries ts
      on ts.id = h.timeseries_id
  ),
  null_rows as (
    select j.timeseries_id
    from joined j
    where j.hourly_station_id is null
  ),
  mismatched_rows as (
    select j.timeseries_id
    from joined j
    where j.hourly_station_id is distinct from j.core_station_id
  ),
  null_sample as (
    select coalesce(array_agg(x.timeseries_id order by x.timeseries_id), '{}'::integer[]) as ids
    from (
      select distinct n.timeseries_id
      from null_rows n
      order by n.timeseries_id
      limit 20
    ) x
  ),
  mismatch_sample as (
    select coalesce(array_agg(x.timeseries_id order by x.timeseries_id), '{}'::integer[]) as ids
    from (
      select distinct m.timeseries_id
      from mismatched_rows m
      order by m.timeseries_id
      limit 20
    ) x
  )
  select
    (select count(*) from null_rows)::bigint as null_station_rows,
    (select count(*) from mismatched_rows)::bigint as mismatched_station_rows,
    (select count(distinct timeseries_id) from null_rows)::integer as null_station_timeseries,
    (select count(distinct timeseries_id) from mismatched_rows)::integer as mismatched_station_timeseries,
    (select ids from null_sample) as sample_null_timeseries_ids,
    (select ids from mismatch_sample) as sample_mismatched_timeseries_ids;
end;
$$;

revoke all on function uk_aq_public.uk_aq_rpc_timeseries_aqi_station_link_health(
  timestamptz,
  timestamptz,
  integer[]
) from public;
grant execute on function uk_aq_public.uk_aq_rpc_timeseries_aqi_station_link_health(
  timestamptz,
  timestamptz,
  integer[]
) to service_role;
