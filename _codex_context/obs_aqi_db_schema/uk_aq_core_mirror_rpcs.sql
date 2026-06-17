-- uk_aq_core mirror RPCs for Obs AQI DB.
-- Apply this focused file when only mirror RPC changes are needed.

create schema if not exists uk_aq_public;

drop function if exists uk_aq_public.uk_aq_rpc_core_table_select(text, text[], text[], integer, integer);
create or replace function uk_aq_public.uk_aq_rpc_core_table_select(
  p_table_name text,
  p_select_columns text[] default null,
  p_order_columns text[] default null,
  p_limit integer default 1000,
  p_offset integer default 0
)
returns table (
  row_data jsonb
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_table text;
  v_allowed_tables constant text[] := array[
    'connectors',
    'observed_properties',
    'categories',
    'phenomena',
    'offerings',
    'features',
    'procedures',
    'stations',
    'timeseries'
  ];
  v_column text;
  v_select_list text;
  v_order_list text;
  v_sql text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  v_table := lower(coalesce(nullif(trim(p_table_name), ''), ''));
  if v_table = '' or not (v_table = any(v_allowed_tables)) then
    raise exception 'unsupported uk_aq_core table: %', p_table_name;
  end if;

  p_limit := coalesce(p_limit, 1000);
  p_offset := coalesce(p_offset, 0);
  if p_limit < 1 then
    p_limit := 1;
  end if;
  if p_limit > 5000 then
    p_limit := 5000;
  end if;
  if p_offset < 0 then
    p_offset := 0;
  end if;

  if p_select_columns is null or cardinality(p_select_columns) = 0 then
    v_select_list := '*';
  else
    v_select_list := null;
    foreach v_column in array p_select_columns loop
      v_column := trim(coalesce(v_column, ''));
      if v_column = '' then
        continue;
      end if;
      perform 1
      from information_schema.columns c
      where c.table_schema = 'uk_aq_core'
        and c.table_name = v_table
        and c.column_name = v_column;
      if not found then
        raise exception 'unsupported select column % for table %', v_column, v_table;
      end if;
      v_select_list := concat_ws(', ', v_select_list, format('%I', v_column));
    end loop;
    if coalesce(v_select_list, '') = '' then
      raise exception 'p_select_columns did not include any usable column names';
    end if;
  end if;

  if p_order_columns is null or cardinality(p_order_columns) = 0 then
    select string_agg(format('%I', kcu.column_name), ', ' order by kcu.ordinal_position)
    into v_order_list
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on tc.constraint_name = kcu.constraint_name
     and tc.table_schema = kcu.table_schema
     and tc.table_name = kcu.table_name
    where tc.table_schema = 'uk_aq_core'
      and tc.table_name = v_table
      and tc.constraint_type = 'PRIMARY KEY';
  else
    v_order_list := null;
    foreach v_column in array p_order_columns loop
      v_column := trim(coalesce(v_column, ''));
      if v_column = '' then
        continue;
      end if;
      perform 1
      from information_schema.columns c
      where c.table_schema = 'uk_aq_core'
        and c.table_name = v_table
        and c.column_name = v_column;
      if not found then
        raise exception 'unsupported order column % for table %', v_column, v_table;
      end if;
      v_order_list := concat_ws(', ', v_order_list, format('%I', v_column));
    end loop;
  end if;

  if coalesce(v_order_list, '') = '' then
    v_order_list := '1';
  end if;

  v_sql := format(
    'select to_jsonb(t) as row_data '
    'from ('
    '  select %s '
    '  from uk_aq_core.%I '
    '  order by %s '
    '  limit %s offset %s'
    ') t',
    v_select_list,
    v_table,
    v_order_list,
    p_limit,
    p_offset
  );

  return query execute v_sql;
end;
$$;

revoke all on function uk_aq_public.uk_aq_rpc_core_table_select(text, text[], text[], integer, integer) from public;
grant execute on function uk_aq_public.uk_aq_rpc_core_table_select(text, text[], text[], integer, integer) to service_role;

drop function if exists uk_aq_public.uk_aq_rpc_core_table_upsert(text, jsonb, text[]);
create or replace function uk_aq_public.uk_aq_rpc_core_table_upsert(
  p_table_name text,
  p_rows jsonb,
  p_on_conflict_columns text[] default null
)
returns table (
  rows_upserted bigint
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_table text;
  v_allowed_tables constant text[] := array[
    'connectors',
    'observed_properties',
    'categories',
    'phenomena',
    'offerings',
    'features',
    'procedures',
    'stations',
    'timeseries'
  ];
  v_column text;
  v_pk_cols text[];
  v_conflict_cols text[];
  v_conflict_list text;
  v_update_set text;
  v_sql text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  v_table := lower(coalesce(nullif(trim(p_table_name), ''), ''));
  if v_table = '' or not (v_table = any(v_allowed_tables)) then
    raise exception 'unsupported uk_aq_core table: %', p_table_name;
  end if;

  if p_rows is null then
    return query select 0::bigint;
    return;
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array';
  end if;
  if jsonb_array_length(p_rows) = 0 then
    return query select 0::bigint;
    return;
  end if;

  select array_agg(kcu.column_name order by kcu.ordinal_position)
  into v_pk_cols
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on tc.constraint_name = kcu.constraint_name
   and tc.table_schema = kcu.table_schema
   and tc.table_name = kcu.table_name
  where tc.table_schema = 'uk_aq_core'
    and tc.table_name = v_table
    and tc.constraint_type = 'PRIMARY KEY';

  if v_pk_cols is null or cardinality(v_pk_cols) = 0 then
    raise exception 'primary key metadata missing for table %', v_table;
  end if;

  if p_on_conflict_columns is null or cardinality(p_on_conflict_columns) = 0 then
    v_conflict_cols := v_pk_cols;
  else
    v_conflict_cols := array[]::text[];
    foreach v_column in array p_on_conflict_columns loop
      v_column := trim(coalesce(v_column, ''));
      if v_column = '' then
        continue;
      end if;
      if not (v_column = any(v_pk_cols)) then
        raise exception 'unsupported conflict column % for table %', v_column, v_table;
      end if;
      v_conflict_cols := array_append(v_conflict_cols, v_column);
    end loop;
    if v_conflict_cols is distinct from v_pk_cols then
      raise exception 'p_on_conflict_columns must match table primary key columns for %', v_table;
    end if;
  end if;

  select string_agg(format('%I', c), ', ')
  into v_conflict_list
  from unnest(v_conflict_cols) as c;

  select string_agg(format('%1$I = excluded.%1$I', c.column_name), ', ' order by c.ordinal_position)
  into v_update_set
  from information_schema.columns c
  where c.table_schema = 'uk_aq_core'
    and c.table_name = v_table
    and not (c.column_name = any(v_conflict_cols));

  if coalesce(v_update_set, '') = '' then
    v_sql := format(
      'with input_rows as ('
      '  select * from jsonb_populate_recordset(null::uk_aq_core.%I, $1)'
      '), ins as ('
      '  insert into uk_aq_core.%I '
      '  select * from input_rows '
      '  on conflict (%s) do nothing '
      '  returning 1'
      ') '
      'select count(*)::bigint as rows_upserted from ins',
      v_table,
      v_table,
      v_conflict_list
    );
  else
    v_sql := format(
      'with input_rows as ('
      '  select * from jsonb_populate_recordset(null::uk_aq_core.%I, $1)'
      '), ins as ('
      '  insert into uk_aq_core.%I '
      '  select * from input_rows '
      '  on conflict (%s) do update set %s '
      '  returning 1'
      ') '
      'select count(*)::bigint as rows_upserted from ins',
      v_table,
      v_table,
      v_conflict_list,
      v_update_set
    );
  end if;

  return query execute v_sql using p_rows;
end;
$$;

revoke all on function uk_aq_public.uk_aq_rpc_core_table_upsert(text, jsonb, text[]) from public;
grant execute on function uk_aq_public.uk_aq_rpc_core_table_upsert(text, jsonb, text[]) to service_role;

drop function if exists uk_aq_public.uk_aq_rpc_core_table_delete_keys(text, text[], jsonb);
create or replace function uk_aq_public.uk_aq_rpc_core_table_delete_keys(
  p_table_name text,
  p_pk_columns text[] default null,
  p_keys jsonb default '[]'::jsonb
)
returns table (
  rows_deleted bigint
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_table text;
  v_allowed_tables constant text[] := array[
    'connectors',
    'observed_properties',
    'categories',
    'phenomena',
    'offerings',
    'features',
    'procedures',
    'stations',
    'timeseries'
  ];
  v_column text;
  v_actual_pk_cols text[];
  v_pk_cols text[];
  v_key_defs text;
  v_join_predicate text;
  v_sql text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  v_table := lower(coalesce(nullif(trim(p_table_name), ''), ''));
  if v_table = '' or not (v_table = any(v_allowed_tables)) then
    raise exception 'unsupported uk_aq_core table: %', p_table_name;
  end if;

  if p_keys is null then
    return query select 0::bigint;
    return;
  end if;
  if jsonb_typeof(p_keys) <> 'array' then
    raise exception 'p_keys must be a JSON array';
  end if;
  if jsonb_array_length(p_keys) = 0 then
    return query select 0::bigint;
    return;
  end if;

  select array_agg(kcu.column_name order by kcu.ordinal_position)
  into v_actual_pk_cols
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on tc.constraint_name = kcu.constraint_name
   and tc.table_schema = kcu.table_schema
   and tc.table_name = kcu.table_name
  where tc.table_schema = 'uk_aq_core'
    and tc.table_name = v_table
    and tc.constraint_type = 'PRIMARY KEY';

  if v_actual_pk_cols is null or cardinality(v_actual_pk_cols) = 0 then
    raise exception 'primary key metadata missing for table %', v_table;
  end if;

  if p_pk_columns is null or cardinality(p_pk_columns) = 0 then
    v_pk_cols := v_actual_pk_cols;
  else
    v_pk_cols := array[]::text[];
    foreach v_column in array p_pk_columns loop
      v_column := trim(coalesce(v_column, ''));
      if v_column = '' then
        continue;
      end if;
      if not (v_column = any(v_actual_pk_cols)) then
        raise exception 'unsupported pk column % for table %', v_column, v_table;
      end if;
      v_pk_cols := array_append(v_pk_cols, v_column);
    end loop;
    if v_pk_cols is distinct from v_actual_pk_cols then
      raise exception 'p_pk_columns must match table primary key columns for %', v_table;
    end if;
  end if;

  with pk_cols as (
    select
      kcu.column_name,
      kcu.ordinal_position,
      format_type(a.atttypid, a.atttypmod) as data_type_sql
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on tc.constraint_name = kcu.constraint_name
     and tc.table_schema = kcu.table_schema
     and tc.table_name = kcu.table_name
    join pg_namespace n
      on n.nspname = 'uk_aq_core'
    join pg_class cls
      on cls.relnamespace = n.oid
     and cls.relname = v_table
    join pg_attribute a
      on a.attrelid = cls.oid
     and a.attname = kcu.column_name
     and a.attnum > 0
     and not a.attisdropped
    where tc.table_schema = 'uk_aq_core'
      and tc.table_name = v_table
      and tc.constraint_type = 'PRIMARY KEY'
  )
  select
    string_agg(format('%I %s', p.column_name, p.data_type_sql), ', ' order by p.ordinal_position),
    string_agg(format('t.%1$I is not distinct from k.%1$I', p.column_name), ' and ' order by p.ordinal_position)
  into v_key_defs, v_join_predicate
  from pk_cols p;

  if coalesce(v_key_defs, '') = '' or coalesce(v_join_predicate, '') = '' then
    raise exception 'could not resolve key metadata for table %', v_table;
  end if;

  v_sql := format(
    'with keys as ('
    '  select * from jsonb_to_recordset($1) as k(%s)'
    '), del as ('
    '  delete from uk_aq_core.%I t '
    '  using keys k '
    '  where %s '
    '  returning 1'
    ') '
    'select count(*)::bigint as rows_deleted from del',
    v_key_defs,
    v_table,
    v_join_predicate
  );

  return query execute v_sql using p_keys;
end;
$$;

revoke all on function uk_aq_public.uk_aq_rpc_core_table_delete_keys(text, text[], jsonb) from public;
grant execute on function uk_aq_public.uk_aq_rpc_core_table_delete_keys(text, text[], jsonb) to service_role;
