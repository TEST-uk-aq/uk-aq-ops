create schema if not exists uk_aq_public;
create extension if not exists pgcrypto;

drop function if exists uk_aq_public.uk_aq_rpc_observations_hourly_fingerprint(timestamptz, timestamptz);
create or replace function uk_aq_public.uk_aq_rpc_observations_hourly_fingerprint(
  window_start timestamptz,
  window_end timestamptz
)
returns table (
  connector_id bigint,
  hour_start timestamptz,
  observation_count bigint,
  fingerprint text,
  min_observed_at timestamptz,
  max_observed_at timestamptz
)
language plpgsql
security definer
set search_path = uk_aq_history, extensions, public, pg_catalog
as $$
begin
  set local timezone = 'UTC';

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
            o.observed_at::text,
            coalesce(to_char(o.value, 'FM9999999990D999999999'), 'NULL'),
            coalesce(o.status, 'NULL')
          ),
          'sha256'
        ),
        'hex'
      ) as row_hash_hex
    from uk_aq_history.observations o
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

revoke execute on function uk_aq_public.uk_aq_rpc_observations_hourly_fingerprint(timestamptz, timestamptz) from public;
revoke execute on function uk_aq_public.uk_aq_rpc_observations_hourly_fingerprint(timestamptz, timestamptz) from anon, authenticated;
grant execute on function uk_aq_public.uk_aq_rpc_observations_hourly_fingerprint(timestamptz, timestamptz) to service_role;
grant usage on schema uk_aq_public to service_role;
