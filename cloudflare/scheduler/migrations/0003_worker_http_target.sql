pragma defer_foreign_keys = on;

create table scheduler_jobs_worker_http (
  job_key text primary key,

  enabled integer not null default 1
    check (enabled in (0, 1)),

  target_type text not null
    check (target_type in ('github_workflow', 'cloud_run', 'worker_http')),

  cron_expr text not null,
  timezone text not null default 'UTC',

  github_repo text,
  github_workflow_file text,
  github_ref text not null default 'main',
  github_inputs_json text,

  cloud_run_url text,
  cloud_run_method text not null default 'POST',
  cloud_run_headers_json text,
  cloud_run_body_json text,

  worker_http_url text,
  worker_http_secret_binding text,
  worker_http_body_json text,

  dry_run integer not null default 1
    check (dry_run in (0, 1)),

  notes text,

  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,

  check (timezone in ('UTC', 'Etc/UTC')),
  check (
    target_type != 'github_workflow'
    or (
      github_repo is not null
      and github_workflow_file is not null
      and github_ref is not null
    )
  ),
  check (
    target_type != 'cloud_run'
    or cloud_run_url is not null
  ),
  check (
    target_type != 'worker_http'
    or (
      worker_http_url is not null
      and length(trim(worker_http_url)) > 0
      and worker_http_secret_binding is not null
      and length(trim(worker_http_secret_binding)) > 0
    )
  ),
  check (
    github_inputs_json is null or json_valid(github_inputs_json)
  ),
  check (
    cloud_run_headers_json is null or json_valid(cloud_run_headers_json)
  ),
  check (
    cloud_run_body_json is null or json_valid(cloud_run_body_json)
  ),
  check (
    worker_http_body_json is null or json_valid(worker_http_body_json)
  )
);

insert into scheduler_jobs_worker_http (
  job_key,
  enabled,
  target_type,
  cron_expr,
  timezone,
  github_repo,
  github_workflow_file,
  github_ref,
  github_inputs_json,
  cloud_run_url,
  cloud_run_method,
  cloud_run_headers_json,
  cloud_run_body_json,
  worker_http_url,
  worker_http_secret_binding,
  worker_http_body_json,
  dry_run,
  notes,
  created_at,
  updated_at
)
select
  job_key,
  enabled,
  target_type,
  cron_expr,
  timezone,
  github_repo,
  github_workflow_file,
  github_ref,
  github_inputs_json,
  cloud_run_url,
  cloud_run_method,
  cloud_run_headers_json,
  cloud_run_body_json,
  null,
  null,
  null,
  dry_run,
  notes,
  created_at,
  updated_at
from scheduler_jobs;

create table scheduler_dispatches_worker_http (
  id integer primary key autoincrement,

  job_key text not null,
  due_at text not null,

  claimed_at text not null default current_timestamp,
  dispatched_at text,

  target_type text not null,
  dry_run integer not null default 0
    check (dry_run in (0, 1)),

  dispatch_status text not null
    check (dispatch_status in (
      'claimed',
      'dry_run',
      'dispatched',
      'failed',
      'skipped'
    )),

  reason text,
  response_status integer,
  response_preview text,

  unique (job_key, due_at),

  foreign key (job_key)
    references scheduler_jobs_worker_http(job_key)
);

insert into scheduler_dispatches_worker_http (
  id,
  job_key,
  due_at,
  claimed_at,
  dispatched_at,
  target_type,
  dry_run,
  dispatch_status,
  reason,
  response_status,
  response_preview
)
select
  id,
  job_key,
  due_at,
  claimed_at,
  dispatched_at,
  target_type,
  dry_run,
  dispatch_status,
  reason,
  response_status,
  response_preview
from scheduler_dispatches;

drop table scheduler_dispatches;
drop table scheduler_jobs;
alter table scheduler_jobs_worker_http rename to scheduler_jobs;
alter table scheduler_dispatches_worker_http rename to scheduler_dispatches;

create index scheduler_dispatches_job_time_idx
on scheduler_dispatches(job_key, due_at desc);

pragma foreign_key_check;
