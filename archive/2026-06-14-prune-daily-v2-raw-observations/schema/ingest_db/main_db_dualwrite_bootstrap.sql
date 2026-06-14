-- Dual-write bootstrap for MAIN DB (uk_aq_core + uk_aq_raw).
-- Safe to run multiple times.

create extension if not exists pgcrypto;

create schema if not exists uk_aq_raw;
create schema if not exists uk_aq_public;

create table if not exists uk_aq_raw.observs_observation_outbox (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  next_attempt_at timestamptz not null default now(),
  attempts integer not null default 0,
  last_error text,
  payload jsonb not null
);

create index if not exists observs_observation_outbox_next_attempt_at_idx
  on uk_aq_raw.observs_observation_outbox (next_attempt_at);

create index if not exists observs_observation_outbox_created_at_idx
  on uk_aq_raw.observs_observation_outbox (created_at);

create table if not exists uk_aq_raw.observs_sync_receipt_daily (
  connector_id integer not null,
  timeseries_id integer not null,
  observed_day date not null,
  synced_at timestamptz not null default now(),
  primary key (connector_id, timeseries_id, observed_day)
);

create index if not exists observs_sync_receipt_daily_observed_day_idx
  on uk_aq_raw.observs_sync_receipt_daily (observed_day);

alter table uk_aq_raw.observs_observation_outbox enable row level security;
alter table uk_aq_raw.observs_sync_receipt_daily enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'uk_aq_raw'
      and tablename = 'observs_observation_outbox'
      and policyname = 'observs_observation_outbox_select_service_role'
  ) then
    execute 'create policy observs_observation_outbox_select_service_role '
      'on uk_aq_raw.observs_observation_outbox '
      'for select using ((select auth.role()) = ''service_role'')';
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'uk_aq_raw'
      and tablename = 'observs_observation_outbox'
      and policyname = 'observs_observation_outbox_write_service_role'
  ) then
    execute 'create policy observs_observation_outbox_write_service_role '
      'on uk_aq_raw.observs_observation_outbox '
      'for all using ((select auth.role()) = ''service_role'') '
      'with check ((select auth.role()) = ''service_role'')';
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'uk_aq_raw'
      and tablename = 'observs_sync_receipt_daily'
      and policyname = 'observs_sync_receipt_daily_select_service_role'
  ) then
    execute 'create policy observs_sync_receipt_daily_select_service_role '
      'on uk_aq_raw.observs_sync_receipt_daily '
      'for select using ((select auth.role()) = ''service_role'')';
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'uk_aq_raw'
      and tablename = 'observs_sync_receipt_daily'
      and policyname = 'observs_sync_receipt_daily_write_service_role'
  ) then
    execute 'create policy observs_sync_receipt_daily_write_service_role '
      'on uk_aq_raw.observs_sync_receipt_daily '
      'for all using ((select auth.role()) = ''service_role'') '
      'with check ((select auth.role()) = ''service_role'')';
  end if;
end $$;

create or replace function uk_aq_public.uk_aq_rpc_observs_outbox_enqueue(entries jsonb)
returns table(rows_enqueued int)
language plpgsql
security definer
set search_path = uk_aq_raw, uk_aq_core, public, pg_catalog
as $$
declare
  v_count int := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  if entries is null
    or jsonb_typeof(entries) <> 'array'
    or jsonb_array_length(entries) = 0
  then
    return query select 0;
    return;
  end if;

  insert into uk_aq_raw.observs_observation_outbox (
    payload,
    next_attempt_at
  )
  select
    row_payload.payload,
    coalesce(row_payload.next_attempt_at, now())
  from jsonb_to_recordset(entries) as row_payload(
    payload jsonb,
    next_attempt_at timestamptz
  )
  where row_payload.payload is not null;

  get diagnostics v_count = row_count;
  return query select coalesce(v_count, 0);
end;
$$;

create or replace function uk_aq_public.uk_aq_rpc_observs_outbox_claim(batch_limit int default 10)
returns table(
  id uuid,
  payload jsonb,
  attempts int
)
language plpgsql
security definer
set search_path = uk_aq_raw, uk_aq_core, public, pg_catalog
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  return query
  with due as (
    select
      o.id,
      o.next_attempt_at,
      o.created_at
    from uk_aq_raw.observs_observation_outbox o
    where o.next_attempt_at <= now()
    order by o.next_attempt_at asc, o.created_at asc
    for update skip locked
    limit greatest(coalesce(batch_limit, 10), 1)
  ),
  claimed as (
    update uk_aq_raw.observs_observation_outbox o
    set next_attempt_at = now() + interval '5 minutes'
    from due
    where o.id = due.id
    returning o.id, o.payload, o.attempts
  )
  select c.id, c.payload, c.attempts
  from claimed c
  join due d on d.id = c.id
  order by d.next_attempt_at asc, d.created_at asc;
end;
$$;

create or replace function uk_aq_public.uk_aq_rpc_observs_outbox_resolve(resolutions jsonb)
returns table(rows_resolved int)
language plpgsql
security definer
set search_path = uk_aq_raw, uk_aq_core, public, pg_catalog
as $$
declare
  v_resolved int := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  if resolutions is null
    or jsonb_typeof(resolutions) <> 'array'
    or jsonb_array_length(resolutions) = 0
  then
    return query select 0;
    return;
  end if;

  with incoming as (
    select
      nullif(trim(item->>'id'), '')::uuid as id,
      coalesce((item->>'ok')::boolean, false) as ok,
      nullif(item->>'error', '') as error_message,
      case
        when item ? 'retry_in_seconds'
          and (item->>'retry_in_seconds') ~ '^[0-9]+$'
        then greatest(0, least((item->>'retry_in_seconds')::int, 3600))
        else null
      end as retry_in_seconds
    from jsonb_array_elements(resolutions) item
    where item ? 'id'
  ),
  deleted as (
    delete from uk_aq_raw.observs_observation_outbox o
    using incoming i
    where i.ok = true
      and o.id = i.id
    returning o.id
  ),
  failed as (
    update uk_aq_raw.observs_observation_outbox o
    set
      attempts = o.attempts + 1,
      last_error = case
        when (o.attempts + 1) >= 20 then
          concat(
            '[dead_letter_threshold_reached] ',
            coalesce(i.error_message, o.last_error, 'observs delivery failed')
          )
        else
          coalesce(i.error_message, o.last_error, 'observs delivery failed')
      end,
      next_attempt_at = now() + make_interval(
        secs => case
          when (o.attempts + 1) >= 20 then 3600
          else coalesce(
            i.retry_in_seconds,
            case o.attempts
              when 0 then 30
              when 1 then 120
              when 2 then 600
              else 3600
            end
          )
        end
      )
    from incoming i
    where i.ok = false
      and o.id = i.id
    returning o.id
  )
  select
    (select count(*) from deleted) + (select count(*) from failed)
  into v_resolved;

  return query select coalesce(v_resolved, 0);
end;
$$;

create or replace function uk_aq_public.uk_aq_rpc_observs_sync_receipt_daily_upsert(rows jsonb)
returns table(rows_upserted int)
language plpgsql
security definer
set search_path = uk_aq_raw, uk_aq_core, public, pg_catalog
as $$
declare
  v_count int := 0;
begin
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

  insert into uk_aq_raw.observs_sync_receipt_daily (
    connector_id,
    timeseries_id,
    observed_day,
    synced_at
  )
  select
    input.connector_id,
    input.timeseries_id,
    input.observed_day,
    now()
  from jsonb_to_recordset(rows) as input(
    connector_id integer,
    timeseries_id integer,
    observed_day date
  )
  where input.connector_id is not null
    and input.timeseries_id is not null
    and input.observed_day is not null
  on conflict (connector_id, timeseries_id, observed_day)
  do update set
    synced_at = now();

  get diagnostics v_count = row_count;
  return query select coalesce(v_count, 0);
end;
$$;

revoke all on table uk_aq_raw.observs_observation_outbox from public, anon, authenticated;
revoke all on table uk_aq_raw.observs_sync_receipt_daily from public, anon, authenticated;
grant all on table uk_aq_raw.observs_observation_outbox to service_role;
grant all on table uk_aq_raw.observs_sync_receipt_daily to service_role;

grant usage on schema uk_aq_raw to service_role;
grant usage on schema uk_aq_public to service_role;

revoke all on function uk_aq_public.uk_aq_rpc_observs_outbox_enqueue(jsonb) from public;
revoke all on function uk_aq_public.uk_aq_rpc_observs_outbox_claim(int) from public;
revoke all on function uk_aq_public.uk_aq_rpc_observs_outbox_resolve(jsonb) from public;
revoke all on function uk_aq_public.uk_aq_rpc_observs_sync_receipt_daily_upsert(jsonb) from public;

grant execute on function uk_aq_public.uk_aq_rpc_observs_outbox_enqueue(jsonb) to service_role;
grant execute on function uk_aq_public.uk_aq_rpc_observs_outbox_claim(int) to service_role;
grant execute on function uk_aq_public.uk_aq_rpc_observs_outbox_resolve(jsonb) to service_role;
grant execute on function uk_aq_public.uk_aq_rpc_observs_sync_receipt_daily_upsert(jsonb) to service_role;

-- Phase B history ops objects (ingest prune safety gate + resumable export checkpoints).

create schema if not exists uk_aq_ops;

create or replace function uk_aq_ops.uk_aq_touch_updated_at()
returns trigger
language plpgsql
set search_path = uk_aq_ops, public, pg_catalog
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists uk_aq_ops.history_candidates (
  day_utc date not null,
  connector_id integer not null,
  expected_row_count bigint not null,
  min_observed_at timestamptz,
  max_observed_at timestamptz,
  status text not null default 'pending',
  run_id text,
  last_error text,
  manifest_key text,
  history_row_count bigint,
  history_file_count integer,
  history_total_bytes bigint,
  history_completed_at timestamptz,
  resume_last_timeseries_id integer,
  resume_last_observed_at timestamptz,
  resume_part_index integer not null default 0,
  resume_exported_row_count bigint not null default 0,
  resume_parts_json jsonb not null default '[]'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  primary key (day_utc, connector_id)
);

alter table if exists uk_aq_ops.history_candidates
  add column if not exists expected_row_count bigint;
alter table if exists uk_aq_ops.history_candidates
  add column if not exists min_observed_at timestamptz;
alter table if exists uk_aq_ops.history_candidates
  add column if not exists max_observed_at timestamptz;
alter table if exists uk_aq_ops.history_candidates
  add column if not exists status text;
alter table if exists uk_aq_ops.history_candidates
  add column if not exists run_id text;
alter table if exists uk_aq_ops.history_candidates
  add column if not exists last_error text;
alter table if exists uk_aq_ops.history_candidates
  add column if not exists manifest_key text;
alter table if exists uk_aq_ops.history_candidates
  add column if not exists history_row_count bigint;
alter table if exists uk_aq_ops.history_candidates
  add column if not exists history_file_count integer;
alter table if exists uk_aq_ops.history_candidates
  add column if not exists history_total_bytes bigint;
alter table if exists uk_aq_ops.history_candidates
  add column if not exists history_completed_at timestamptz;
alter table if exists uk_aq_ops.history_candidates
  add column if not exists resume_last_timeseries_id integer;
alter table if exists uk_aq_ops.history_candidates
  add column if not exists resume_last_observed_at timestamptz;
alter table if exists uk_aq_ops.history_candidates
  add column if not exists resume_part_index integer default 0;
alter table if exists uk_aq_ops.history_candidates
  add column if not exists resume_exported_row_count bigint default 0;
alter table if exists uk_aq_ops.history_candidates
  add column if not exists resume_parts_json jsonb default '[]'::jsonb;
alter table if exists uk_aq_ops.history_candidates
  add column if not exists created_at timestamptz default now();
alter table if exists uk_aq_ops.history_candidates
  add column if not exists updated_at timestamptz default now();

update uk_aq_ops.history_candidates
set
  status = coalesce(nullif(btrim(status), ''), 'pending'),
  expected_row_count = coalesce(expected_row_count, 0),
  resume_part_index = coalesce(resume_part_index, 0),
  resume_exported_row_count = coalesce(resume_exported_row_count, 0),
  resume_parts_json = coalesce(resume_parts_json, '[]'::jsonb),
  updated_at = coalesce(updated_at, now()),
  created_at = coalesce(created_at, now())
where
  status is null
  or btrim(status) = ''
  or expected_row_count is null
  or resume_part_index is null
  or resume_exported_row_count is null
  or resume_parts_json is null
  or updated_at is null
  or created_at is null;

alter table uk_aq_ops.history_candidates
  alter column expected_row_count set not null;
alter table uk_aq_ops.history_candidates
  alter column status set not null;
alter table uk_aq_ops.history_candidates
  alter column status set default 'pending';
alter table uk_aq_ops.history_candidates
  alter column resume_part_index set not null;
alter table uk_aq_ops.history_candidates
  alter column resume_part_index set default 0;
alter table uk_aq_ops.history_candidates
  alter column resume_exported_row_count set not null;
alter table uk_aq_ops.history_candidates
  alter column resume_exported_row_count set default 0;
alter table uk_aq_ops.history_candidates
  alter column resume_parts_json set not null;
alter table uk_aq_ops.history_candidates
  alter column resume_parts_json set default '[]'::jsonb;

create index if not exists history_candidates_status_day_idx
  on uk_aq_ops.history_candidates(status, day_utc);

create index if not exists history_candidates_day_status_idx
  on uk_aq_ops.history_candidates(day_utc, status, connector_id);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'history_candidates_status_check'
      and conrelid = 'uk_aq_ops.history_candidates'::regclass
  ) then
    alter table uk_aq_ops.history_candidates
      add constraint history_candidates_status_check
      check (status in ('pending', 'in_progress', 'complete', 'failed'));
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'history_candidates_resume_nonnegative_check'
      and conrelid = 'uk_aq_ops.history_candidates'::regclass
  ) then
    alter table uk_aq_ops.history_candidates
      add constraint history_candidates_resume_nonnegative_check
      check (
        resume_part_index >= 0
        and resume_exported_row_count >= 0
      );
  end if;
end
$$;

drop trigger if exists history_candidates_touch_updated_at on uk_aq_ops.history_candidates;
create trigger history_candidates_touch_updated_at
before update on uk_aq_ops.history_candidates
for each row execute function uk_aq_ops.uk_aq_touch_updated_at();

create table if not exists uk_aq_ops.prune_day_gates (
  day_utc date primary key,
  history_done boolean not null default false,
  history_run_id text,
  history_manifest_key text,
  history_row_count bigint,
  history_file_count integer,
  history_total_bytes bigint,
  history_completed_at timestamptz,
  aggregate_done boolean not null default false,
  observs_repair_status text not null default 'not_required',
  updated_at timestamptz default now()
);

alter table if exists uk_aq_ops.prune_day_gates
  add column if not exists history_done boolean default false;
alter table if exists uk_aq_ops.prune_day_gates
  add column if not exists history_run_id text;
alter table if exists uk_aq_ops.prune_day_gates
  add column if not exists history_manifest_key text;
alter table if exists uk_aq_ops.prune_day_gates
  add column if not exists history_row_count bigint;
alter table if exists uk_aq_ops.prune_day_gates
  add column if not exists history_file_count integer;
alter table if exists uk_aq_ops.prune_day_gates
  add column if not exists history_total_bytes bigint;
alter table if exists uk_aq_ops.prune_day_gates
  add column if not exists history_completed_at timestamptz;
alter table if exists uk_aq_ops.prune_day_gates
  add column if not exists aggregate_done boolean default false;
alter table if exists uk_aq_ops.prune_day_gates
  add column if not exists observs_repair_status text default 'not_required';
alter table if exists uk_aq_ops.prune_day_gates
  add column if not exists updated_at timestamptz default now();

update uk_aq_ops.prune_day_gates
set
  history_done = coalesce(history_done, false),
  aggregate_done = coalesce(aggregate_done, false),
  observs_repair_status = coalesce(nullif(btrim(observs_repair_status), ''), 'not_required'),
  updated_at = coalesce(updated_at, now())
where
  history_done is null
  or aggregate_done is null
  or observs_repair_status is null
  or btrim(observs_repair_status) = ''
  or updated_at is null;

alter table uk_aq_ops.prune_day_gates
  alter column history_done set not null;
alter table uk_aq_ops.prune_day_gates
  alter column history_done set default false;
alter table uk_aq_ops.prune_day_gates
  alter column aggregate_done set not null;
alter table uk_aq_ops.prune_day_gates
  alter column aggregate_done set default false;
alter table uk_aq_ops.prune_day_gates
  alter column observs_repair_status set not null;
alter table uk_aq_ops.prune_day_gates
  alter column observs_repair_status set default 'not_required';

create index if not exists prune_day_gates_history_done_idx
  on uk_aq_ops.prune_day_gates(history_done, day_utc);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'prune_day_gates_observs_repair_status_check'
      and conrelid = 'uk_aq_ops.prune_day_gates'::regclass
  ) then
    alter table uk_aq_ops.prune_day_gates
      add constraint prune_day_gates_observs_repair_status_check
      check (observs_repair_status in ('not_required', 'queued', 'in_progress', 'resolved', 'failed'));
  end if;
end
$$;

drop trigger if exists prune_day_gates_touch_updated_at on uk_aq_ops.prune_day_gates;
create trigger prune_day_gates_touch_updated_at
before update on uk_aq_ops.prune_day_gates
for each row execute function uk_aq_ops.uk_aq_touch_updated_at();

create or replace function uk_aq_ops.uk_aq_phase_b_history_rows(
  p_connector_id integer,
  p_day_start timestamptz,
  p_day_end timestamptz,
  p_after_timeseries_id integer default null,
  p_after_observed_at timestamptz default null
)
returns table (
  connector_id integer,
  timeseries_id integer,
  observed_at timestamptz,
  value double precision
)
language sql
stable
set search_path = uk_aq_core, uk_aq_ops, public, pg_catalog
as $$
  select
    o.connector_id,
    o.timeseries_id,
    o.observed_at,
    o.value
  from uk_aq_core.observations o
  where o.connector_id = p_connector_id
    and o.observed_at >= p_day_start
    and o.observed_at < p_day_end
    and (
      p_after_timeseries_id is null
      or p_after_observed_at is null
      or (o.timeseries_id, o.observed_at) > (p_after_timeseries_id, p_after_observed_at)
    )
  order by o.timeseries_id asc, o.observed_at asc
$$;

grant usage on schema uk_aq_ops to service_role;
grant all on all tables in schema uk_aq_ops to service_role;
grant execute on all functions in schema uk_aq_ops to service_role;

alter default privileges in schema uk_aq_ops
  grant all on tables to service_role;
alter default privileges in schema uk_aq_ops
  grant execute on functions to service_role;
