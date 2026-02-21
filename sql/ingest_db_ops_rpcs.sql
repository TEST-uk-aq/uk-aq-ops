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
set search_path = uk_aq_core, extensions, public, pg_catalog
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
    from uk_aq_core.observations o
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

drop function if exists uk_aq_public.uk_aq_rpc_observations_delete_hour_bucket(bigint, timestamptz, int);
create or replace function uk_aq_public.uk_aq_rpc_observations_delete_hour_bucket(
  p_connector_id bigint,
  p_hour_start timestamptz,
  p_delete_limit int default 50000
)
returns table (
  deleted_count int
)
language plpgsql
security definer
set search_path = uk_aq_core, public, pg_catalog
as $$
declare
  v_hour_start timestamptz;
  v_hour_end timestamptz;
  v_delete_limit int;
  v_deleted_count int;
begin
  set local timezone = 'UTC';

  if p_connector_id is null then
    raise exception 'p_connector_id is required';
  end if;

  if p_hour_start is null then
    raise exception 'p_hour_start is required';
  end if;

  v_hour_start := date_trunc('hour', p_hour_start);
  v_hour_end := v_hour_start + interval '1 hour';
  v_delete_limit := greatest(1, coalesce(p_delete_limit, 50000));

  with target_rows as (
    select o.ctid
    from uk_aq_core.observations o
    where o.connector_id = p_connector_id
      and o.observed_at >= v_hour_start
      and o.observed_at < v_hour_end
    limit v_delete_limit
  ),
  deleted as (
    delete from uk_aq_core.observations o
    using target_rows t
    where o.ctid = t.ctid
    returning 1
  )
  select count(*)::int
  into v_deleted_count
  from deleted;

  return query select coalesce(v_deleted_count, 0);
end;
$$;

revoke execute on function uk_aq_public.uk_aq_rpc_observations_delete_hour_bucket(bigint, timestamptz, int) from public;
revoke execute on function uk_aq_public.uk_aq_rpc_observations_delete_hour_bucket(bigint, timestamptz, int) from anon, authenticated;
grant execute on function uk_aq_public.uk_aq_rpc_observations_delete_hour_bucket(bigint, timestamptz, int) to service_role;

drop function if exists uk_aq_public.uk_aq_rpc_history_outbox_enqueue_hour_bucket(bigint, timestamptz, int);
create or replace function uk_aq_public.uk_aq_rpc_history_outbox_enqueue_hour_bucket(
  p_connector_id bigint,
  p_hour_start timestamptz,
  p_chunk_size int default 1000
)
returns table (
  rows_selected int,
  outbox_entries_enqueued int
)
language plpgsql
security definer
set search_path = uk_aq_core, uk_aq_raw, public, pg_catalog
as $$
declare
  v_hour_start timestamptz;
  v_hour_end timestamptz;
  v_chunk_size int;
  v_rows_selected int := 0;
  v_outbox_entries_enqueued int := 0;
begin
  set local timezone = 'UTC';

  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  if p_connector_id is null then
    raise exception 'p_connector_id is required';
  end if;

  if p_hour_start is null then
    raise exception 'p_hour_start is required';
  end if;

  v_hour_start := date_trunc('hour', p_hour_start);
  v_hour_end := v_hour_start + interval '1 hour';
  v_chunk_size := greatest(1, least(coalesce(p_chunk_size, 1000), 10000));

  with source_rows as (
    select
      o.connector_id,
      o.timeseries_id,
      o.observed_at,
      o.value,
      o.status,
      row_number() over (
        order by o.timeseries_id, o.observed_at
      ) as rn
    from uk_aq_core.observations o
    where o.connector_id = p_connector_id
      and o.observed_at >= v_hour_start
      and o.observed_at < v_hour_end
  ),
  chunked as (
    select
      ((sr.rn - 1) / v_chunk_size) as chunk_no,
      jsonb_agg(
        jsonb_build_object(
          'connector_id', sr.connector_id,
          'timeseries_id', sr.timeseries_id,
          'observed_at', sr.observed_at,
          'value', sr.value,
          'status', sr.status
        )
        order by sr.timeseries_id, sr.observed_at
      ) as payload,
      count(*)::int as chunk_rows
    from source_rows sr
    group by ((sr.rn - 1) / v_chunk_size)
  ),
  inserted as (
    insert into uk_aq_raw.history_observation_outbox (
      payload,
      next_attempt_at
    )
    select
      c.payload,
      now()
    from chunked c
    where c.payload is not null
      and jsonb_array_length(c.payload) > 0
    returning 1
  )
  select
    coalesce((select sum(c.chunk_rows) from chunked c), 0),
    coalesce((select count(*) from inserted), 0)
  into
    v_rows_selected,
    v_outbox_entries_enqueued;

  return query
  select
    coalesce(v_rows_selected, 0),
    coalesce(v_outbox_entries_enqueued, 0);
end;
$$;

revoke execute on function uk_aq_public.uk_aq_rpc_history_outbox_enqueue_hour_bucket(bigint, timestamptz, int) from public;
revoke execute on function uk_aq_public.uk_aq_rpc_history_outbox_enqueue_hour_bucket(bigint, timestamptz, int) from anon, authenticated;
grant execute on function uk_aq_public.uk_aq_rpc_history_outbox_enqueue_hour_bucket(bigint, timestamptz, int) to service_role;
grant usage on schema uk_aq_public to service_role;
