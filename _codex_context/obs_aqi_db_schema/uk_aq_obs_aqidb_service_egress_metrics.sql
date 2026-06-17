create schema if not exists uk_aq_ops;
create schema if not exists uk_aq_public;

create table if not exists uk_aq_ops.service_egress_metrics_minute (
  bucket_minute timestamptz not null,
  env_name text not null,
  project_ref text not null default '',
  service_name text not null,
  source_type text not null check (
    source_type in ('supabase', 'r2', 'cloudflare_cache', 'gcp', 'other')
  ),
  source_name text not null default '',
  route_name text not null,
  query_name text not null default '',
  window_label text not null default '',
  status text not null check (status in ('ok', 'error', 'partial', 'skipped')),
  request_count integer not null default 0 check (request_count >= 0),
  response_rows bigint not null default 0 check (response_rows >= 0),
  response_bytes_est bigint not null default 0 check (response_bytes_est >= 0),
  upstream_bytes_est bigint not null default 0 check (upstream_bytes_est >= 0),
  cache_hit_count integer not null default 0 check (cache_hit_count >= 0),
  cache_miss_count integer not null default 0 check (cache_miss_count >= 0),
  objects_written_count integer not null default 0 check (objects_written_count >= 0),
  objects_written_bytes bigint not null default 0 check (objects_written_bytes >= 0),
  duration_ms bigint not null default 0 check (duration_ms >= 0),
  error_count integer not null default 0 check (error_count >= 0),
  notes jsonb,
  recorded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (
    bucket_minute,
    env_name,
    project_ref,
    service_name,
    source_type,
    source_name,
    route_name,
    query_name,
    window_label,
    status
  )
);

create index if not exists service_egress_metrics_minute_service_bucket_idx
  on uk_aq_ops.service_egress_metrics_minute (
    service_name,
    bucket_minute desc
  );

create index if not exists service_egress_metrics_minute_source_bucket_idx
  on uk_aq_ops.service_egress_metrics_minute (
    source_type,
    bucket_minute desc
  );

create index if not exists service_egress_metrics_minute_window_bucket_idx
  on uk_aq_ops.service_egress_metrics_minute (
    window_label,
    bucket_minute desc
  );

create table if not exists uk_aq_ops.endpoint_egress_metrics_minute (
  bucket_minute timestamptz not null,
  endpoint text not null,
  method text not null,
  status_class text not null check (status_class in ('2xx', '3xx', '4xx', '5xx', 'other')),
  observed_requests bigint not null default 0,
  estimated_requests numeric(18,4) not null default 0,
  response_bytes_sum bigint not null default 0,
  response_bytes_max integer not null default 0,
  duration_ms_sum bigint not null default 0,
  duration_ms_max integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (bucket_minute, endpoint, method, status_class)
);

create index if not exists endpoint_egress_metrics_minute_endpoint_idx
  on uk_aq_ops.endpoint_egress_metrics_minute (
    endpoint,
    bucket_minute desc
  );

create or replace view uk_aq_public.uk_aq_service_egress_metrics_minute as
select
  bucket_minute,
  env_name,
  project_ref,
  service_name,
  source_type,
  source_name,
  route_name,
  query_name,
  window_label,
  status,
  request_count,
  response_rows,
  response_bytes_est,
  upstream_bytes_est,
  cache_hit_count,
  cache_miss_count,
  objects_written_count,
  objects_written_bytes,
  duration_ms,
  error_count,
  notes,
  recorded_at,
  created_at,
  updated_at
from uk_aq_ops.service_egress_metrics_minute;
alter view if exists uk_aq_public.uk_aq_service_egress_metrics_minute set (security_invoker = true);

create or replace view uk_aq_public.uk_aq_endpoint_egress_metrics_minute as
select
  bucket_minute,
  endpoint,
  method,
  status_class,
  observed_requests,
  estimated_requests,
  response_bytes_sum,
  response_bytes_max,
  duration_ms_sum,
  duration_ms_max,
  case when observed_requests > 0 then round((response_bytes_sum::numeric / observed_requests), 2) else 0 end as response_bytes_avg,
  case when observed_requests > 0 then round((duration_ms_sum::numeric / observed_requests), 2) else 0 end as duration_ms_avg,
  updated_at
from uk_aq_ops.endpoint_egress_metrics_minute;
alter view if exists uk_aq_public.uk_aq_endpoint_egress_metrics_minute set (security_invoker = true);

create or replace view uk_aq_public.uk_aq_endpoint_egress_metrics_24h_dashboard as
select
  bucket_minute,
  endpoint,
  method,
  status_class,
  observed_requests,
  estimated_requests,
  response_bytes_sum,
  response_bytes_max,
  duration_ms_sum,
  duration_ms_max,
  response_bytes_avg,
  duration_ms_avg,
  updated_at
from uk_aq_public.uk_aq_endpoint_egress_metrics_minute
where bucket_minute >= (now() - interval '24 hours');
alter view if exists uk_aq_public.uk_aq_endpoint_egress_metrics_24h_dashboard set (security_invoker = true);

drop view if exists uk_aq_public.uk_aq_service_egress_metrics_24h_dashboard;

create or replace view uk_aq_public.uk_aq_service_egress_metrics_daily as
select
  (bucket_minute at time zone 'UTC')::date as day_utc,
  env_name,
  project_ref,
  service_name,
  source_type,
  source_name,
  route_name,
  query_name,
  window_label,
  status,
  sum(request_count)::bigint as request_count,
  sum(response_rows)::bigint as response_rows,
  sum(response_bytes_est)::bigint as response_bytes_est,
  sum(upstream_bytes_est)::bigint as upstream_bytes_est,
  sum(cache_hit_count)::bigint as cache_hit_count,
  sum(cache_miss_count)::bigint as cache_miss_count,
  sum(objects_written_count)::bigint as objects_written_count,
  sum(objects_written_bytes)::bigint as objects_written_bytes,
  sum(duration_ms)::bigint as duration_ms,
  sum(error_count)::bigint as error_count,
  max(recorded_at) as recorded_at
from uk_aq_ops.service_egress_metrics_minute
group by
  (bucket_minute at time zone 'UTC')::date,
  env_name,
  project_ref,
  service_name,
  source_type,
  source_name,
  route_name,
  query_name,
  window_label,
  status;
alter view if exists uk_aq_public.uk_aq_service_egress_metrics_daily set (security_invoker = true);

drop function if exists uk_aq_public.uk_aq_rpc_service_egress_metrics_batch_upsert(jsonb);
create or replace function uk_aq_public.uk_aq_rpc_service_egress_metrics_batch_upsert(
  p_rows jsonb
)
returns table (rows_upserted integer)
language plpgsql
security definer
set search_path = uk_aq_ops, public, pg_catalog
as $$
declare
  v_row jsonb;
  v_rows integer := 0;
  v_bucket_minute timestamptz;
  v_env_name text;
  v_project_ref text;
  v_service_name text;
  v_source_type text;
  v_source_name text;
  v_route_name text;
  v_query_name text;
  v_window_label text;
  v_status text;
  v_request_count integer;
  v_response_rows bigint;
  v_response_bytes_est bigint;
  v_upstream_bytes_est bigint;
  v_cache_hit_count integer;
  v_cache_miss_count integer;
  v_objects_written_count integer;
  v_objects_written_bytes bigint;
  v_duration_ms bigint;
  v_error_count integer;
  v_notes jsonb;
begin
  set local timezone = 'UTC';

  if auth.role() <> 'service_role' then
    raise exception 'service_role required';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a json array';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    if jsonb_typeof(v_row) <> 'object' then
      continue;
    end if;

    v_bucket_minute := date_trunc(
      'minute',
      coalesce(
        nullif(btrim(v_row->>'bucket_minute'), '')::timestamptz,
        now()
      )
    );
    v_env_name := coalesce(nullif(btrim(v_row->>'env_name'), ''), 'unknown');
    v_project_ref := coalesce(nullif(btrim(v_row->>'project_ref'), ''), '');
    v_service_name := nullif(btrim(v_row->>'service_name'), '');
    v_source_type := coalesce(nullif(btrim(v_row->>'source_type'), ''), 'other');
    v_source_name := coalesce(nullif(btrim(v_row->>'source_name'), ''), '');
    v_route_name := nullif(btrim(v_row->>'route_name'), '');
    v_query_name := coalesce(nullif(btrim(v_row->>'query_name'), ''), '');
    v_window_label := coalesce(nullif(btrim(v_row->>'window_label'), ''), '');
    v_status := coalesce(nullif(btrim(v_row->>'status'), ''), 'ok');

    if v_service_name is null or v_route_name is null then
      continue;
    end if;

    v_request_count := greatest(0, coalesce(nullif(btrim(v_row->>'request_count'), '')::integer, 0));
    v_response_rows := greatest(0, coalesce(nullif(btrim(v_row->>'response_rows'), '')::bigint, 0));
    v_response_bytes_est := greatest(0, coalesce(nullif(btrim(v_row->>'response_bytes_est'), '')::bigint, 0));
    v_upstream_bytes_est := greatest(0, coalesce(nullif(btrim(v_row->>'upstream_bytes_est'), '')::bigint, 0));
    v_cache_hit_count := greatest(0, coalesce(nullif(btrim(v_row->>'cache_hit_count'), '')::integer, 0));
    v_cache_miss_count := greatest(0, coalesce(nullif(btrim(v_row->>'cache_miss_count'), '')::integer, 0));
    v_objects_written_count := greatest(0, coalesce(nullif(btrim(v_row->>'objects_written_count'), '')::integer, 0));
    v_objects_written_bytes := greatest(0, coalesce(nullif(btrim(v_row->>'objects_written_bytes'), '')::bigint, 0));
    v_duration_ms := greatest(0, coalesce(nullif(btrim(v_row->>'duration_ms'), '')::bigint, 0));
    v_error_count := greatest(0, coalesce(nullif(btrim(v_row->>'error_count'), '')::integer, 0));
    v_notes := case
      when v_row ? 'notes' and jsonb_typeof(v_row->'notes') = 'object' then v_row->'notes'
      else null
    end;

    insert into uk_aq_ops.service_egress_metrics_minute (
      bucket_minute,
      env_name,
      project_ref,
      service_name,
      source_type,
      source_name,
      route_name,
      query_name,
      window_label,
      status,
      request_count,
      response_rows,
      response_bytes_est,
      upstream_bytes_est,
      cache_hit_count,
      cache_miss_count,
      objects_written_count,
      objects_written_bytes,
      duration_ms,
      error_count,
      notes,
      recorded_at,
      updated_at
    )
    values (
      v_bucket_minute,
      v_env_name,
      v_project_ref,
      v_service_name,
      v_source_type,
      v_source_name,
      v_route_name,
      v_query_name,
      v_window_label,
      v_status,
      v_request_count,
      v_response_rows,
      v_response_bytes_est,
      v_upstream_bytes_est,
      v_cache_hit_count,
      v_cache_miss_count,
      v_objects_written_count,
      v_objects_written_bytes,
      v_duration_ms,
      v_error_count,
      v_notes,
      now(),
      now()
    )
    on conflict (
      bucket_minute,
      env_name,
      project_ref,
      service_name,
      source_type,
      source_name,
      route_name,
      query_name,
      window_label,
      status
    ) do update set
      request_count = uk_aq_ops.service_egress_metrics_minute.request_count + excluded.request_count,
      response_rows = uk_aq_ops.service_egress_metrics_minute.response_rows + excluded.response_rows,
      response_bytes_est = uk_aq_ops.service_egress_metrics_minute.response_bytes_est + excluded.response_bytes_est,
      upstream_bytes_est = uk_aq_ops.service_egress_metrics_minute.upstream_bytes_est + excluded.upstream_bytes_est,
      cache_hit_count = uk_aq_ops.service_egress_metrics_minute.cache_hit_count + excluded.cache_hit_count,
      cache_miss_count = uk_aq_ops.service_egress_metrics_minute.cache_miss_count + excluded.cache_miss_count,
      objects_written_count = uk_aq_ops.service_egress_metrics_minute.objects_written_count + excluded.objects_written_count,
      objects_written_bytes = uk_aq_ops.service_egress_metrics_minute.objects_written_bytes + excluded.objects_written_bytes,
      duration_ms = uk_aq_ops.service_egress_metrics_minute.duration_ms + excluded.duration_ms,
      error_count = uk_aq_ops.service_egress_metrics_minute.error_count + excluded.error_count,
      notes = coalesce(uk_aq_ops.service_egress_metrics_minute.notes, '{}'::jsonb) || coalesce(excluded.notes, '{}'::jsonb),
      recorded_at = now(),
      updated_at = now();

    v_rows := v_rows + 1;
  end loop;

  return query select v_rows;
end;
$$;

grant all on table uk_aq_ops.service_egress_metrics_minute to service_role;

revoke all on function uk_aq_public.uk_aq_rpc_service_egress_metrics_batch_upsert(jsonb) from public;
grant execute on function uk_aq_public.uk_aq_rpc_service_egress_metrics_batch_upsert(jsonb) to service_role;

revoke all on uk_aq_public.uk_aq_service_egress_metrics_minute from public;
grant select on uk_aq_public.uk_aq_service_egress_metrics_minute to authenticated;
grant select on uk_aq_public.uk_aq_service_egress_metrics_minute to service_role;

grant all on table uk_aq_ops.endpoint_egress_metrics_minute to service_role;

revoke all on uk_aq_public.uk_aq_endpoint_egress_metrics_minute from public;
grant select on uk_aq_public.uk_aq_endpoint_egress_metrics_minute to authenticated;
grant select on uk_aq_public.uk_aq_endpoint_egress_metrics_minute to service_role;

revoke all on uk_aq_public.uk_aq_endpoint_egress_metrics_24h_dashboard from public;
grant select on uk_aq_public.uk_aq_endpoint_egress_metrics_24h_dashboard to authenticated;
grant select on uk_aq_public.uk_aq_endpoint_egress_metrics_24h_dashboard to service_role;

revoke all on uk_aq_public.uk_aq_service_egress_metrics_daily from public;
grant select on uk_aq_public.uk_aq_service_egress_metrics_daily to authenticated;
grant select on uk_aq_public.uk_aq_service_egress_metrics_daily to service_role;
