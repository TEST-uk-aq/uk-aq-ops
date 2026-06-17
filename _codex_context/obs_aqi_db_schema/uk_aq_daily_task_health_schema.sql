-- Daily scheduled task health tracking for Obs AQI DB.
-- Apply in obs_aqidb (service_role context).
--
-- Design notes:
-- - Supabase stores daily task status metadata only.
-- - R2 is intentionally not part of v1 storage.
-- - uk_aq_ops.daily_task_runs rows are factual task reports.
-- - uk_aq_ops.daily_task_status is calendar/report-facing and may be manually overridden.
-- - GitHub Actions can be delayed, so due_time_utc is the missing-run threshold,
--   not scheduled_time_utc.
-- - Seeded times below should be checked against actual GitHub/GCP schedules.

create schema if not exists uk_aq_ops;
create schema if not exists uk_aq_public;
create extension if not exists pgcrypto;

create table if not exists uk_aq_ops.daily_task_definitions (
  task_key text primary key,
  task_name text not null,
  task_group text not null default 'ops',
  platform text not null,
  is_active boolean not null default true,
  include_in_daily_check boolean not null default true,
  include_in_email boolean not null default true,
  include_in_dashboard boolean not null default true,
  scheduled_time_utc time,
  due_time_utc time not null,
  schedule_notes text,
  source_repo text,
  source_workflow text,
  source_service text,
  sort_order integer not null default 100,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint daily_task_definitions_platform_check
    check (platform in ('gcp', 'github', 'supabase', 'cloudflare', 'other', 'MBPro'))
);

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'daily_task_definitions_platform_check'
      and conrelid = 'uk_aq_ops.daily_task_definitions'::regclass
  ) then
    alter table uk_aq_ops.daily_task_definitions
      drop constraint daily_task_definitions_platform_check;
  end if;
  alter table uk_aq_ops.daily_task_definitions
    add constraint daily_task_definitions_platform_check
    check (platform in ('gcp', 'github', 'supabase', 'cloudflare', 'other', 'MBPro'));
end $$;

comment on table uk_aq_ops.daily_task_definitions is
  'Defines daily scheduled tasks expected by the ops health calendar and future email report. Add rows here to extend the system.';
comment on column uk_aq_ops.daily_task_definitions.scheduled_time_utc is
  'Configured scheduler/cron time in UTC. Informational only.';
comment on column uk_aq_ops.daily_task_definitions.due_time_utc is
  'UTC threshold after which a missing run counts as Missing. This is deliberately more reliable than scheduled_time_utc for delayed GitHub Actions.';

create table if not exists uk_aq_ops.daily_task_runs (
  id uuid primary key default gen_random_uuid(),
  task_key text not null references uk_aq_ops.daily_task_definitions(task_key),
  scheduled_for_date date not null,
  attempt integer not null default 1,
  status text not null,
  started_at timestamptz,
  finished_at timestamptz,
  failed_at timestamptz,
  duration_seconds integer,
  summary jsonb not null default '{}'::jsonb,
  error_message text,
  error jsonb,
  source_repo text,
  source_worker text,
  platform_run_id text,
  log_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint daily_task_runs_status_check
    check (status in ('Started', 'Finished', 'Failed')),
  constraint daily_task_runs_attempt_check
    check (attempt >= 1),
  constraint daily_task_runs_started_at_check
    check (status <> 'Started' or started_at is not null),
  constraint daily_task_runs_finished_at_check
    check (status <> 'Finished' or finished_at is not null),
  constraint daily_task_runs_failed_at_check
    check (status <> 'Failed' or failed_at is not null),
  constraint daily_task_runs_duration_seconds_check
    check (duration_seconds is null or duration_seconds >= 0),
  constraint daily_task_runs_task_date_attempt_uq
    unique (task_key, scheduled_for_date, attempt)
);

comment on table uk_aq_ops.daily_task_runs is
  'Factual reports from daily scheduled tasks. Retries use higher attempt numbers; dashboard/report queries use the latest attempt for each task/date.';
comment on column uk_aq_ops.daily_task_runs.summary is
  'Task-owned JSON summary. Finish/fail RPCs replace this value when a summary is supplied.';

create index if not exists daily_task_runs_date_idx
  on uk_aq_ops.daily_task_runs (scheduled_for_date desc);
create index if not exists daily_task_runs_task_date_idx
  on uk_aq_ops.daily_task_runs (task_key, scheduled_for_date desc);
create index if not exists daily_task_runs_status_date_idx
  on uk_aq_ops.daily_task_runs (status, scheduled_for_date desc);
create index if not exists daily_task_runs_summary_gin_idx
  on uk_aq_ops.daily_task_runs using gin (summary);

create table if not exists uk_aq_ops.daily_task_status (
  date_utc date primary key,
  computed_status text not null default 'Unknown',
  final_status text not null default 'Unknown',
  checked_task_count integer not null default 0,
  finished_task_count integer not null default 0,
  failed_task_count integer not null default 0,
  started_task_count integer not null default 0,
  not_due_task_count integer not null default 0,
  missing_task_count integer not null default 0,
  computed_summary jsonb not null default '{}'::jsonb,
  computed_at timestamptz,
  override_status text,
  override_reason text,
  override_by text,
  override_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint daily_task_status_computed_status_check
    check (computed_status in ('Unknown', 'Pending', 'Finished', 'Failed')),
  constraint daily_task_status_final_status_check
    check (final_status in ('Unknown', 'Pending', 'Finished', 'Failed')),
  constraint daily_task_status_override_status_check
    check (override_status is null or override_status in ('Finished', 'Failed')),
  constraint daily_task_status_counts_check
    check (
      checked_task_count >= 0
      and finished_task_count >= 0
      and failed_task_count >= 0
      and started_task_count >= 0
      and not_due_task_count >= 0
      and missing_task_count >= 0
    ),
  constraint daily_task_status_final_matches_override_check
    check (
      (override_status is not null and final_status = override_status)
      or (override_status is null and final_status = computed_status)
    )
);

comment on table uk_aq_ops.daily_task_status is
  'Calendar/report-facing daily health status derived from factual daily_task_runs. Day-level final_status can be manually overridden without changing individual runs.';
comment on column uk_aq_ops.daily_task_status.override_status is
  'Manual day-level override only. Individual daily_task_runs remain factual.';

create index if not exists daily_task_status_date_idx
  on uk_aq_ops.daily_task_status (date_utc desc);
create index if not exists daily_task_status_final_idx
  on uk_aq_ops.daily_task_status (final_status, date_utc desc);

insert into uk_aq_ops.daily_task_definitions (
  task_key,
  task_name,
  task_group,
  platform,
  scheduled_time_utc,
  due_time_utc,
  schedule_notes,
  source_repo,
  source_workflow,
  source_service,
  sort_order,
  notes
) values
  (
    'ops.supabase_db_dump_backup',
    'Supabase DB dump backup',
    'ops',
    'gcp',
    time '00:55',
    time '01:25',
    'Default GCP Cloud Scheduler cron observed in ops docs: 55 0 * * * UTC. Check deployed scheduler before relying on this value.',
    'uk-aq-ops',
    null,
    'uk_aq_supabase_db_dump_backup_service',
    10,
    'GCP due time uses scheduled_time_utc + 30 minutes.'
  ),
  (
    'ops.prune_daily',
    'Prune daily',
    'ops',
    'gcp',
    time '02:00',
    time '02:30',
    'Default GCP Cloud Scheduler cron observed in workflow: 0 2 * * * UTC. Check deployed scheduler before relying on this value.',
    'uk-aq-ops',
    '.github/workflows/uk_aq_prune_daily_cloud_run_deploy.yml',
    'uk_aq_prune_daily',
    20,
    'GCP due time uses scheduled_time_utc + 30 minutes.'
  ),
  (
    'ops.observs_partition_maintenance',
    'Observations partition maintenance',
    'ops',
    'gcp',
    time '03:00',
    time '03:30',
    'Default GCP Cloud Scheduler cron observed in workflow/docs: 0 3 * * * UTC. Check deployed scheduler before relying on this value.',
    'uk-aq-ops',
    '.github/workflows/uk_aq_observs_partition_maintenance_cloud_run_deploy.yml',
    'uk_aq_observs_partition_maintenance_service',
    30,
    'GCP due time uses scheduled_time_utc + 30 minutes.'
  ),
  (
    'ingest.stations_daily',
    'Stations daily',
    'ingest',
    'github',
    time '03:00',
    time '03:10',
    'GitHub Actions cron observed in ingest workflow: 0 3 * * * UTC. GitHub may delay scheduled starts; check workflow before relying on this value.',
    'uk-aq-ingest',
    '.github/workflows/uk_aq_stations_daily.yml',
    null,
    40,
    'GitHub due time allows for very late scheduled workflow starts.'
  ),
  (
    'ops.r2_core_snapshot',
    'R2 core snapshot',
    'ops',
    'github',
    time '04:15',
    time '04:25',
    'Intended external Cloudflare Worker schedule for workflow_dispatch: 04:15 UTC daily. Previous GitHub cron observed in workflow comments: 15 4 * * * UTC.',
    'uk-aq-ops',
    '.github/workflows/uk_aq_r2_core_snapshot.yml',
    null,
    45,
    'GitHub due time allows for workflow dispatch delay and brief snapshot runtime.'
  ),
  (
    'ops.r2_history_dropbox_backup',
    'R2 history Dropbox backup',
    'ops',
    'github',
    time '04:35',
    time '06:05',
    'GitHub Actions cron observed in ops workflow: 35 4 * * * UTC. GitHub may delay scheduled starts; check workflow before relying on this value.',
    'uk-aq-ops',
    '.github/workflows/uk_aq_r2_history_dropbox_backup.yml',
    null,
    50,
    'GitHub due time allows for very late scheduled workflow starts and roughly an hour of backup runtime. R2 is not integrated into v1 status storage.'
  ),
  (
    'ops.history_integrity',
    'R2 History integrity',
    'ops',
    'MBPro',
    time '12:00',
    time '23:59',
    'Local MBPro integrity task for R2 history/source parity checks and targeted backfill orchestration. Daily profile start target is 12:00 UTC.',
    'uk-aq-ops',
    null,
    'uk-aq-history-integrity',
    70,
    'Manual and scheduled integrity runs on MBPro.'
  ),
  (
    'ops.dropbox_prune_raw',
    'Dropbox prune raw',
    'ops',
    'github',
    time '05:49',
    time '05:54',
    'Cloudflare Worker cron for workflow_dispatch currently 22 9 * * * UTC. Check deployed scheduler before relying on this value.',
    'uk-aq-ops',
    '.github/workflows/uk_aq_dropbox_prune_raw.yml',
    null,
    60,
    'GitHub due time allows for workflow dispatch delay plus prune runtime.'
  )
on conflict (task_key) do update
set
  task_name = excluded.task_name,
  task_group = excluded.task_group,
  platform = excluded.platform,
  scheduled_time_utc = excluded.scheduled_time_utc,
  due_time_utc = excluded.due_time_utc,
  schedule_notes = excluded.schedule_notes,
  source_repo = excluded.source_repo,
  source_workflow = excluded.source_workflow,
  source_service = excluded.source_service,
  sort_order = excluded.sort_order,
  notes = excluded.notes,
  updated_at = now();

create or replace view uk_aq_ops.daily_task_status_calendar as
select
  date_utc,
  computed_status,
  final_status,
  checked_task_count,
  finished_task_count,
  failed_task_count,
  started_task_count,
  not_due_task_count,
  missing_task_count,
  override_status,
  override_reason,
  override_at,
  computed_at
from uk_aq_ops.daily_task_status;

comment on view uk_aq_ops.daily_task_status_calendar is
  'Dashboard/API calendar projection of computed and final daily scheduled task health.';

create or replace view uk_aq_ops.daily_task_latest_runs as
select distinct on (r.task_key, r.scheduled_for_date)
  r.scheduled_for_date,
  r.task_key,
  d.task_name,
  d.platform,
  r.attempt,
  r.status,
  r.started_at,
  r.finished_at,
  r.failed_at,
  r.duration_seconds,
  r.error_message,
  r.summary,
  r.log_url,
  r.updated_at
from uk_aq_ops.daily_task_runs r
join uk_aq_ops.daily_task_definitions d on d.task_key = r.task_key
order by r.task_key, r.scheduled_for_date, r.attempt desc, r.updated_at desc;

comment on view uk_aq_ops.daily_task_latest_runs is
  'Latest attempt per task/date for daily scheduled task details.';

create or replace view uk_aq_ops.daily_task_runs_dashboard as
with base as (
  select
    r.id as run_id,
    r.task_key,
    d.task_name,
    d.platform,
    coalesce(nullif(r.source_repo, ''), nullif(d.source_repo, '')) as source,
    r.scheduled_for_date,
    d.scheduled_time_utc,
    (
      (
        r.scheduled_for_date::timestamp
        + coalesce(d.scheduled_time_utc, time '00:00')
      ) at time zone 'UTC'
    ) as scheduled_at_utc,
    r.attempt,
    r.status as raw_status,
    r.started_at,
    r.finished_at,
    r.failed_at,
    r.updated_at,
    r.duration_seconds,
    r.summary,
    r.error_message,
    r.log_url,
    case
      when r.failed_at is not null
        or lower(coalesce(r.status, '')) in ('failed', 'error') then 'Failed'
      when r.finished_at is not null
        or lower(coalesce(r.status, '')) in ('finished', 'success', 'ok', 'completed') then 'Success'
      when r.started_at is not null then 'Started'
      when lower(coalesce(r.status, '')) in ('warning', 'partial', 'stopped_limit') then 'Warning'
      when (
        (
          r.scheduled_for_date::timestamp
          + coalesce(d.scheduled_time_utc, time '00:00')
        ) at time zone 'UTC'
      ) < now() - interval '2 minute' then 'Overdue'
      else 'Scheduled'
    end as effective_status,
    coalesce(
      r.started_at,
      (
        (
          r.scheduled_for_date::timestamp
          + coalesce(d.scheduled_time_utc, time '00:00')
        ) at time zone 'UTC'
      )
    ) as scheduled_or_started_at,
    coalesce(r.failed_at, r.finished_at) as finished_or_failed_at,
    (r.failed_at is not null or lower(coalesce(r.status, '')) in ('failed', 'error')) as is_failed,
    (
      r.started_at is null
      and (
        (
          r.scheduled_for_date::timestamp
          + coalesce(d.scheduled_time_utc, time '00:00')
        ) at time zone 'UTC'
      ) < now() - interval '2 minute'
    ) as is_overdue,
    (r.started_at is null) as is_not_started,
    row_number() over (
      partition by r.scheduled_for_date, r.task_key
      order by r.attempt desc, r.updated_at desc, r.created_at desc
    ) as task_day_rank
  from uk_aq_ops.daily_task_runs r
  join uk_aq_ops.daily_task_definitions d on d.task_key = r.task_key
)
select
  run_id,
  task_key,
  task_name,
  platform,
  source,
  scheduled_for_date,
  scheduled_time_utc,
  scheduled_at_utc,
  attempt,
  raw_status,
  started_at,
  finished_at,
  failed_at,
  updated_at,
  duration_seconds,
  summary,
  error_message,
  log_url,
  effective_status,
  scheduled_or_started_at,
  finished_or_failed_at,
  is_failed,
  is_overdue,
  is_not_started,
  task_day_rank
from base;

comment on view uk_aq_ops.daily_task_runs_dashboard is
  'Dashboard-friendly daily task run projection for latest-per-task and all-attempt views on a selected scheduled_for_date.';

alter table uk_aq_ops.daily_task_definitions enable row level security;
alter table uk_aq_ops.daily_task_runs enable row level security;
alter table uk_aq_ops.daily_task_status enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'uk_aq_ops'
      and tablename = 'daily_task_definitions'
      and policyname = 'daily_task_definitions_service_role'
  ) then
    create policy daily_task_definitions_service_role
      on uk_aq_ops.daily_task_definitions
      for all
      using ((select auth.role()) = 'service_role')
      with check ((select auth.role()) = 'service_role');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'uk_aq_ops'
      and tablename = 'daily_task_runs'
      and policyname = 'daily_task_runs_service_role'
  ) then
    create policy daily_task_runs_service_role
      on uk_aq_ops.daily_task_runs
      for all
      using ((select auth.role()) = 'service_role')
      with check ((select auth.role()) = 'service_role');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'uk_aq_ops'
      and tablename = 'daily_task_status'
      and policyname = 'daily_task_status_service_role'
  ) then
    create policy daily_task_status_service_role
      on uk_aq_ops.daily_task_status
      for all
      using ((select auth.role()) = 'service_role')
      with check ((select auth.role()) = 'service_role');
  end if;
end $$;

drop function if exists uk_aq_public.uk_aq_rpc_daily_task_started(jsonb);
create or replace function uk_aq_public.uk_aq_rpc_daily_task_started(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = uk_aq_ops, public, pg_catalog
as $$
declare
  v_task_key text := nullif(btrim(p->>'task_key'), '');
  v_date date;
  v_attempt integer;
  v_started_at timestamptz;
  v_id uuid;
begin
  set local timezone = 'UTC';

  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  if v_task_key is null then
    raise exception 'task_key is required';
  end if;

  if not exists (select 1 from uk_aq_ops.daily_task_definitions where task_key = v_task_key) then
    raise exception 'unknown task_key: %', v_task_key;
  end if;

  v_date := coalesce(nullif(p->>'scheduled_for_date', '')::date, (now() at time zone 'UTC')::date);
  v_attempt := nullif(p->>'attempt', '')::integer;
  if v_attempt is null then
    select coalesce(max(attempt), 0) + 1
    into v_attempt
    from uk_aq_ops.daily_task_runs
    where task_key = v_task_key
      and scheduled_for_date = v_date;
  end if;

  if v_attempt < 1 then
    raise exception 'attempt must be >= 1';
  end if;

  v_started_at := coalesce(nullif(p->>'started_at', '')::timestamptz, now());

  insert into uk_aq_ops.daily_task_runs (
    task_key,
    scheduled_for_date,
    attempt,
    status,
    started_at,
    summary,
    source_repo,
    source_worker,
    platform_run_id,
    log_url
  ) values (
    v_task_key,
    v_date,
    v_attempt,
    'Started',
    v_started_at,
    coalesce(p->'summary', '{}'::jsonb),
    nullif(p->>'source_repo', ''),
    nullif(p->>'source_worker', ''),
    nullif(p->>'platform_run_id', ''),
    nullif(p->>'log_url', '')
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function uk_aq_public.uk_aq_rpc_daily_task_started(jsonb) is
  'Records a factual Started event for a daily scheduled task. Manual runs and ingest run details are intentionally out of scope.';

drop function if exists uk_aq_public.uk_aq_rpc_daily_task_finished(uuid, jsonb);
create or replace function uk_aq_public.uk_aq_rpc_daily_task_finished(p_run_id uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = uk_aq_ops, public, pg_catalog
as $$
declare
  v_finished_at timestamptz;
begin
  set local timezone = 'UTC';

  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  if p_run_id is null then
    raise exception 'p_run_id is required';
  end if;

  v_finished_at := coalesce(nullif(p->>'finished_at', '')::timestamptz, now());

  update uk_aq_ops.daily_task_runs
  set
    status = 'Finished',
    finished_at = v_finished_at,
    failed_at = null,
    duration_seconds = case
      when started_at is null then null
      else greatest(0, floor(extract(epoch from (v_finished_at - started_at)))::integer)
    end,
    summary = case when p ? 'summary' then coalesce(p->'summary', '{}'::jsonb) else summary end,
    error_message = null,
    error = null,
    source_repo = coalesce(nullif(p->>'source_repo', ''), source_repo),
    source_worker = coalesce(nullif(p->>'source_worker', ''), source_worker),
    platform_run_id = coalesce(nullif(p->>'platform_run_id', ''), platform_run_id),
    log_url = coalesce(nullif(p->>'log_url', ''), log_url),
    updated_at = now()
  where id = p_run_id;

  if not found then
    raise exception 'daily task run not found: %', p_run_id;
  end if;
end;
$$;

comment on function uk_aq_public.uk_aq_rpc_daily_task_finished(uuid, jsonb) is
  'Marks a factual daily scheduled task run as Finished. Supplied summary replaces the previous summary for simplicity.';

drop function if exists uk_aq_public.uk_aq_rpc_daily_task_failed(uuid, jsonb);
create or replace function uk_aq_public.uk_aq_rpc_daily_task_failed(p_run_id uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = uk_aq_ops, public, pg_catalog
as $$
declare
  v_failed_at timestamptz;
begin
  set local timezone = 'UTC';

  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  if p_run_id is null then
    raise exception 'p_run_id is required';
  end if;

  v_failed_at := coalesce(nullif(p->>'failed_at', '')::timestamptz, now());

  update uk_aq_ops.daily_task_runs
  set
    status = 'Failed',
    failed_at = v_failed_at,
    finished_at = null,
    duration_seconds = case
      when started_at is null then null
      else greatest(0, floor(extract(epoch from (v_failed_at - started_at)))::integer)
    end,
    summary = case when p ? 'summary' then coalesce(p->'summary', '{}'::jsonb) else summary end,
    error_message = nullif(p->>'error_message', ''),
    error = p->'error',
    source_repo = coalesce(nullif(p->>'source_repo', ''), source_repo),
    source_worker = coalesce(nullif(p->>'source_worker', ''), source_worker),
    platform_run_id = coalesce(nullif(p->>'platform_run_id', ''), platform_run_id),
    log_url = coalesce(nullif(p->>'log_url', ''), log_url),
    updated_at = now()
  where id = p_run_id;

  if not found then
    raise exception 'daily task run not found: %', p_run_id;
  end if;
end;
$$;

comment on function uk_aq_public.uk_aq_rpc_daily_task_failed(uuid, jsonb) is
  'Marks a factual daily scheduled task run as Failed and stores task-owned error metadata.';

drop function if exists uk_aq_public.uk_aq_rpc_daily_task_report_final(jsonb);
create or replace function uk_aq_public.uk_aq_rpc_daily_task_report_final(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = uk_aq_ops, public, pg_catalog
as $$
declare
  v_task_key text := nullif(btrim(p->>'task_key'), '');
  v_status text := nullif(btrim(p->>'status'), '');
  v_date date;
  v_attempt integer;
  v_started_at timestamptz;
  v_finished_at timestamptz;
  v_failed_at timestamptz;
  v_id uuid;
begin
  set local timezone = 'UTC';

  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  if v_task_key is null then
    raise exception 'task_key is required';
  end if;
  if v_status not in ('Finished', 'Failed') then
    raise exception 'status must be Finished or Failed';
  end if;
  if not exists (select 1 from uk_aq_ops.daily_task_definitions where task_key = v_task_key) then
    raise exception 'unknown task_key: %', v_task_key;
  end if;

  v_date := coalesce(nullif(p->>'scheduled_for_date', '')::date, (now() at time zone 'UTC')::date);
  v_attempt := nullif(p->>'attempt', '')::integer;
  if v_attempt is null then
    select coalesce(max(attempt), 0) + 1
    into v_attempt
    from uk_aq_ops.daily_task_runs
    where task_key = v_task_key
      and scheduled_for_date = v_date;
  end if;
  if v_attempt < 1 then
    raise exception 'attempt must be >= 1';
  end if;

  v_started_at := nullif(p->>'started_at', '')::timestamptz;
  if v_status = 'Finished' then
    v_finished_at := coalesce(nullif(p->>'finished_at', '')::timestamptz, now());
  else
    v_failed_at := coalesce(nullif(p->>'failed_at', '')::timestamptz, now());
  end if;

  insert into uk_aq_ops.daily_task_runs (
    task_key,
    scheduled_for_date,
    attempt,
    status,
    started_at,
    finished_at,
    failed_at,
    duration_seconds,
    summary,
    error_message,
    error,
    source_repo,
    source_worker,
    platform_run_id,
    log_url
  ) values (
    v_task_key,
    v_date,
    v_attempt,
    v_status,
    v_started_at,
    v_finished_at,
    v_failed_at,
    case
      when v_started_at is null then null
      when v_status = 'Finished' then greatest(0, floor(extract(epoch from (v_finished_at - v_started_at)))::integer)
      else greatest(0, floor(extract(epoch from (v_failed_at - v_started_at)))::integer)
    end,
    coalesce(p->'summary', '{}'::jsonb),
    nullif(p->>'error_message', ''),
    p->'error',
    nullif(p->>'source_repo', ''),
    nullif(p->>'source_worker', ''),
    nullif(p->>'platform_run_id', ''),
    nullif(p->>'log_url', '')
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function uk_aq_public.uk_aq_rpc_daily_task_report_final(jsonb) is
  'Single-call final daily scheduled task reporter, especially useful for GitHub Actions workflows.';

drop function if exists uk_aq_public.uk_aq_rpc_recompute_daily_task_status(date);
create or replace function uk_aq_public.uk_aq_rpc_recompute_daily_task_status(p_date date)
returns void
language plpgsql
security definer
set search_path = uk_aq_ops, public, pg_catalog
as $$
declare
  v_now timestamptz := now();
  v_checked integer;
  v_finished integer;
  v_failed integer;
  v_started integer;
  v_not_due integer;
  v_missing integer;
  v_computed text;
  v_summary jsonb;
begin
  set local timezone = 'UTC';

  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;
  if p_date is null then
    raise exception 'p_date is required';
  end if;

  with task_rows as (
    select
      d.task_key,
      d.task_name,
      d.platform,
      d.due_time_utc,
      d.sort_order,
      r.id as run_id,
      r.attempt,
      r.status as latest_status,
      r.started_at,
      r.finished_at,
      r.failed_at,
      r.duration_seconds,
      r.error_message,
      case
        when r.id is null
          and v_now < ((p_date + d.due_time_utc) at time zone 'UTC')
          then 'Not due'
        when r.id is null then 'Missing'
        else r.status
      end as classification
    from uk_aq_ops.daily_task_definitions d
    left join lateral (
      select r.*
      from uk_aq_ops.daily_task_runs r
      where r.task_key = d.task_key
        and r.scheduled_for_date = p_date
      order by r.attempt desc, r.created_at desc
      limit 1
    ) r on true
    where d.is_active
      and d.include_in_daily_check
  ),
  counts as (
    select
      count(*)::integer as checked_task_count,
      count(*) filter (where classification = 'Finished')::integer as finished_task_count,
      count(*) filter (where classification = 'Failed')::integer as failed_task_count,
      count(*) filter (where classification = 'Started')::integer as started_task_count,
      count(*) filter (where classification = 'Not due')::integer as not_due_task_count,
      count(*) filter (where classification = 'Missing')::integer as missing_task_count
    from task_rows
  ),
  summary as (
    select jsonb_build_object(
      'date', p_date,
      'generated_at', v_now,
      'tasks', coalesce(
        jsonb_agg(
          jsonb_build_object(
            'task_key', task_key,
            'task_name', task_name,
            'platform', platform,
            'due_time_utc', due_time_utc,
            'latest_status', classification,
            'attempt', attempt,
            'run_id', run_id,
            'started_at', started_at,
            'finished_at', finished_at,
            'failed_at', failed_at,
            'duration_seconds', duration_seconds,
            'error_message', error_message
          )
          order by sort_order, task_key
        ),
        '[]'::jsonb
      )
    ) as computed_summary
    from task_rows
  )
  select
    c.checked_task_count,
    c.finished_task_count,
    c.failed_task_count,
    c.started_task_count,
    c.not_due_task_count,
    c.missing_task_count,
    s.computed_summary
  into
    v_checked,
    v_finished,
    v_failed,
    v_started,
    v_not_due,
    v_missing,
    v_summary
  from counts c
  cross join summary s;

  v_computed := case
    when v_checked = 0 then 'Unknown'
    when v_failed > 0 or v_missing > 0 then 'Failed'
    when v_started > 0 or v_not_due > 0 then 'Pending'
    when v_finished = v_checked then 'Finished'
    else 'Pending'
  end;

  insert into uk_aq_ops.daily_task_status (
    date_utc,
    computed_status,
    final_status,
    checked_task_count,
    finished_task_count,
    failed_task_count,
    started_task_count,
    not_due_task_count,
    missing_task_count,
    computed_summary,
    computed_at,
    updated_at
  ) values (
    p_date,
    v_computed,
    v_computed,
    v_checked,
    v_finished,
    v_failed,
    v_started,
    v_not_due,
    v_missing,
    coalesce(v_summary, jsonb_build_object('date', p_date, 'generated_at', v_now, 'tasks', '[]'::jsonb)),
    v_now,
    now()
  )
  on conflict (date_utc) do update
  set
    computed_status = excluded.computed_status,
    final_status = coalesce(uk_aq_ops.daily_task_status.override_status, excluded.computed_status),
    checked_task_count = excluded.checked_task_count,
    finished_task_count = excluded.finished_task_count,
    failed_task_count = excluded.failed_task_count,
    started_task_count = excluded.started_task_count,
    not_due_task_count = excluded.not_due_task_count,
    missing_task_count = excluded.missing_task_count,
    computed_summary = excluded.computed_summary,
    computed_at = excluded.computed_at,
    updated_at = now();
end;
$$;

comment on function uk_aq_public.uk_aq_rpc_recompute_daily_task_status(date) is
  'Computes calendar/report daily health from active daily task definitions and latest factual run attempts, preserving any day-level manual override.';

drop function if exists uk_aq_public.uk_aq_rpc_set_daily_task_status_override(date, text, text, text);
create or replace function uk_aq_public.uk_aq_rpc_set_daily_task_status_override(
  p_date date,
  p_status text,
  p_reason text,
  p_override_by text default null
)
returns void
language plpgsql
security definer
set search_path = uk_aq_ops, public, pg_catalog
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;
  if p_date is null then
    raise exception 'p_date is required';
  end if;
  if p_status not in ('Finished', 'Failed') then
    raise exception 'p_status must be Finished or Failed';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'p_reason is required';
  end if;

  perform uk_aq_public.uk_aq_rpc_recompute_daily_task_status(p_date);

  update uk_aq_ops.daily_task_status
  set
    override_status = p_status,
    override_reason = p_reason,
    override_by = nullif(btrim(p_override_by), ''),
    override_at = now(),
    final_status = p_status,
    updated_at = now()
  where date_utc = p_date;
end;
$$;

comment on function uk_aq_public.uk_aq_rpc_set_daily_task_status_override(date, text, text, text) is
  'Sets a manual day-level health override. The factual daily task run rows are not changed.';

drop function if exists uk_aq_public.uk_aq_rpc_clear_daily_task_status_override(date);
create or replace function uk_aq_public.uk_aq_rpc_clear_daily_task_status_override(p_date date)
returns void
language plpgsql
security definer
set search_path = uk_aq_ops, public, pg_catalog
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;
  if p_date is null then
    raise exception 'p_date is required';
  end if;

  perform uk_aq_public.uk_aq_rpc_recompute_daily_task_status(p_date);

  update uk_aq_ops.daily_task_status
  set
    override_status = null,
    override_reason = null,
    override_by = null,
    override_at = null,
    final_status = computed_status,
    updated_at = now()
  where date_utc = p_date;
end;
$$;

comment on function uk_aq_public.uk_aq_rpc_clear_daily_task_status_override(date) is
  'Clears a manual day-level health override and restores final_status to computed_status.';

drop function if exists uk_aq_public.uk_aq_rpc_recompute_daily_task_status_range(date, date);
create or replace function uk_aq_public.uk_aq_rpc_recompute_daily_task_status_range(
  p_from date,
  p_to date
)
returns integer
language plpgsql
security definer
set search_path = uk_aq_ops, public, pg_catalog
as $$
declare
  v_day date;
  v_count integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;
  if p_from is null or p_to is null then
    raise exception 'p_from and p_to are required';
  end if;
  if p_to < p_from then
    raise exception 'p_to must be on or after p_from';
  end if;

  for v_day in
    select generate_series(p_from, p_to, interval '1 day')::date
  loop
    perform uk_aq_public.uk_aq_rpc_recompute_daily_task_status(v_day);
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

comment on function uk_aq_public.uk_aq_rpc_recompute_daily_task_status_range(date, date) is
  'Recomputes daily scheduled task health for an inclusive UTC date range and returns the number of days recomputed.';

grant usage on schema uk_aq_ops to service_role;
grant usage on schema uk_aq_public to service_role;

grant all on table uk_aq_ops.daily_task_definitions to service_role;
grant all on table uk_aq_ops.daily_task_runs to service_role;
grant all on table uk_aq_ops.daily_task_status to service_role;
grant select on table uk_aq_ops.daily_task_status_calendar to service_role;
grant select on table uk_aq_ops.daily_task_latest_runs to service_role;
grant select on table uk_aq_ops.daily_task_runs_dashboard to service_role;

revoke all on table uk_aq_ops.daily_task_definitions from anon, authenticated;
revoke all on table uk_aq_ops.daily_task_runs from anon, authenticated;
revoke all on table uk_aq_ops.daily_task_status from anon, authenticated;
revoke all on table uk_aq_ops.daily_task_status_calendar from anon, authenticated;
revoke all on table uk_aq_ops.daily_task_latest_runs from anon, authenticated;
revoke all on table uk_aq_ops.daily_task_runs_dashboard from anon, authenticated;

revoke all on function uk_aq_public.uk_aq_rpc_daily_task_started(jsonb) from public;
revoke all on function uk_aq_public.uk_aq_rpc_daily_task_finished(uuid, jsonb) from public;
revoke all on function uk_aq_public.uk_aq_rpc_daily_task_failed(uuid, jsonb) from public;
revoke all on function uk_aq_public.uk_aq_rpc_daily_task_report_final(jsonb) from public;
revoke all on function uk_aq_public.uk_aq_rpc_recompute_daily_task_status(date) from public;
revoke all on function uk_aq_public.uk_aq_rpc_set_daily_task_status_override(date, text, text, text) from public;
revoke all on function uk_aq_public.uk_aq_rpc_clear_daily_task_status_override(date) from public;
revoke all on function uk_aq_public.uk_aq_rpc_recompute_daily_task_status_range(date, date) from public;

grant execute on function uk_aq_public.uk_aq_rpc_daily_task_started(jsonb) to service_role;
grant execute on function uk_aq_public.uk_aq_rpc_daily_task_finished(uuid, jsonb) to service_role;
grant execute on function uk_aq_public.uk_aq_rpc_daily_task_failed(uuid, jsonb) to service_role;
grant execute on function uk_aq_public.uk_aq_rpc_daily_task_report_final(jsonb) to service_role;
grant execute on function uk_aq_public.uk_aq_rpc_recompute_daily_task_status(date) to service_role;
grant execute on function uk_aq_public.uk_aq_rpc_set_daily_task_status_override(date, text, text, text) to service_role;
grant execute on function uk_aq_public.uk_aq_rpc_clear_daily_task_status_override(date) to service_role;
grant execute on function uk_aq_public.uk_aq_rpc_recompute_daily_task_status_range(date, date) to service_role;
