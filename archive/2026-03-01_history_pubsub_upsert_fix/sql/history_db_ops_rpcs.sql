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
set search_path = uk_aq_history, public, pg_catalog
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

drop function if exists uk_aq_public.uk_aq_rpc_history_ensure_daily_partitions(date, date);
create or replace function uk_aq_public.uk_aq_rpc_history_ensure_daily_partitions(
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
set search_path = uk_aq_history, public, pg_catalog
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

  create table if not exists uk_aq_history.observations_default
    partition of uk_aq_history.observations default;

  create index if not exists uk_aq_history_observations_default_observed_at_brin
    on uk_aq_history.observations_default using brin (observed_at);

  for v_day in
    select generate_series(start_day_utc, end_day_utc, interval '1 day')::date
  loop
    v_partition_name := format('observations_%s', to_char(v_day, 'YYYYMMDD'));

    select to_regclass(format('uk_aq_history.%I', v_partition_name)) is not null
    into v_partition_exists;

    if not v_partition_exists then
      execute format(
        'create table uk_aq_history.%I '
        'partition of uk_aq_history.observations '
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
      where n.nspname = 'uk_aq_history'
        and idx.relname = v_partition_name || '_observed_at_brin_idx'
    )
    into v_brin_exists;

    execute format(
      'create index if not exists %I on uk_aq_history.%I using brin (observed_at)',
      v_partition_name || '_observed_at_brin_idx',
      v_partition_name
    );

    if v_day between v_today_utc and v_hot_future_end_day_utc then
      execute format(
        'create unique index if not exists %I on uk_aq_history.%I (connector_id, timeseries_id, observed_at)',
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

drop function if exists uk_aq_public.uk_aq_rpc_history_enforce_hot_cold_indexes(date, date);
create or replace function uk_aq_public.uk_aq_rpc_history_enforce_hot_cold_indexes(
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
set search_path = uk_aq_history, public, pg_catalog
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
    where n.nspname = 'uk_aq_history'
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
      where n.nspname = 'uk_aq_history'
        and idx.relname = v_part.partition_name || '_observed_at_brin_idx'
    )
    into v_brin_exists;

    execute format(
      'create index if not exists %I on uk_aq_history.%I using brin (observed_at)',
      v_part.partition_name || '_observed_at_brin_idx',
      v_part.partition_name
    );

    select exists (
      select 1
      from pg_class idx
      join pg_namespace n on n.oid = idx.relnamespace
      where n.nspname = 'uk_aq_history'
        and idx.relname = v_part.partition_name || '_hot_key_uidx'
    )
    into v_hot_key_exists;

    if v_is_hot then
      execute format(
        'create unique index if not exists %I on uk_aq_history.%I (connector_id, timeseries_id, observed_at)',
        v_part.partition_name || '_hot_key_uidx',
        v_part.partition_name
      );
      v_drop_count := 0;
    else
      for v_con in
        select con.conname
        from pg_constraint con
        where con.conrelid = format('uk_aq_history.%I', v_part.partition_name)::regclass
          and con.contype in ('p', 'u')
      loop
        execute format(
          'alter table uk_aq_history.%I drop constraint if exists %I',
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
        where n.nspname = 'uk_aq_history'
          and tbl.relname = v_part.partition_name
          and am.amname = 'btree'
      loop
        execute format('drop index if exists uk_aq_history.%I', v_idx.index_name);
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

drop function if exists uk_aq_public.uk_aq_rpc_history_observations_default_diagnostics(integer);
create or replace function uk_aq_public.uk_aq_rpc_history_observations_default_diagnostics(
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
set search_path = uk_aq_history, public, pg_catalog
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
    from uk_aq_history.observations_default
  ),
  offenders as (
    select
      o.connector_id,
      o.timeseries_id,
      count(*)::bigint as row_count
    from uk_aq_history.observations_default o
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

drop function if exists uk_aq_public.uk_aq_rpc_history_drop_candidates(timestamptz);
create or replace function uk_aq_public.uk_aq_rpc_history_drop_candidates(
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
set search_path = uk_aq_history, public, pg_catalog
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
    where n.nspname = 'uk_aq_history'
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

drop function if exists uk_aq_public.uk_aq_rpc_history_drop_partition(text);
create or replace function uk_aq_public.uk_aq_rpc_history_drop_partition(
  p_partition_name text
)
returns table (
  dropped boolean
)
language plpgsql
security definer
set search_path = uk_aq_history, public, pg_catalog
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

  select to_regclass(format('uk_aq_history.%I', p_partition_name)) is not null
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
    where n.nspname = 'uk_aq_history'
      and parent.relname = 'observations'
      and child.relname = p_partition_name
  )
  into v_is_child;

  if not v_is_child then
    raise exception 'partition % is not a child of uk_aq_history.observations', p_partition_name;
  end if;

  execute format('drop table uk_aq_history.%I', p_partition_name);

  return query select true;
end;
$$;

revoke execute on function uk_aq_public.uk_aq_rpc_observations_hourly_fingerprint(timestamptz, timestamptz) from public;
revoke execute on function uk_aq_public.uk_aq_rpc_observations_hourly_fingerprint(timestamptz, timestamptz) from anon, authenticated;
grant execute on function uk_aq_public.uk_aq_rpc_observations_hourly_fingerprint(timestamptz, timestamptz) to service_role;

revoke execute on function uk_aq_public.uk_aq_rpc_history_ensure_daily_partitions(date, date) from public;
revoke execute on function uk_aq_public.uk_aq_rpc_history_ensure_daily_partitions(date, date) from anon, authenticated;
grant execute on function uk_aq_public.uk_aq_rpc_history_ensure_daily_partitions(date, date) to service_role;

revoke execute on function uk_aq_public.uk_aq_rpc_history_enforce_hot_cold_indexes(date, date) from public;
revoke execute on function uk_aq_public.uk_aq_rpc_history_enforce_hot_cold_indexes(date, date) from anon, authenticated;
grant execute on function uk_aq_public.uk_aq_rpc_history_enforce_hot_cold_indexes(date, date) to service_role;

revoke execute on function uk_aq_public.uk_aq_rpc_history_observations_default_diagnostics(integer) from public;
revoke execute on function uk_aq_public.uk_aq_rpc_history_observations_default_diagnostics(integer) from anon, authenticated;
grant execute on function uk_aq_public.uk_aq_rpc_history_observations_default_diagnostics(integer) to service_role;

revoke execute on function uk_aq_public.uk_aq_rpc_history_drop_candidates(timestamptz) from public;
revoke execute on function uk_aq_public.uk_aq_rpc_history_drop_candidates(timestamptz) from anon, authenticated;
grant execute on function uk_aq_public.uk_aq_rpc_history_drop_candidates(timestamptz) to service_role;

revoke execute on function uk_aq_public.uk_aq_rpc_history_drop_partition(text) from public;
revoke execute on function uk_aq_public.uk_aq_rpc_history_drop_partition(text) from anon, authenticated;
grant execute on function uk_aq_public.uk_aq_rpc_history_drop_partition(text) to service_role;

grant usage on schema uk_aq_public to service_role;
