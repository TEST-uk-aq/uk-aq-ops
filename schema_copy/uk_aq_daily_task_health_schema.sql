-- Authoritative local copy for daily task health objects used by ops integrity.
-- Confirmed repository usage: clients call uk_aq_public RPCs through PostgREST
-- with the service role and store runs in uk_aq_ops.daily_task_runs.

CREATE SCHEMA IF NOT EXISTS uk_aq_ops;

CREATE TABLE IF NOT EXISTS uk_aq_ops.daily_task_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_key text NOT NULL,
  env_name text,
  scheduled_for_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('started', 'running', 'succeeded', 'failed')),
  started_at_utc timestamptz NOT NULL DEFAULT now(),
  completed_at_utc timestamptz,
  failed_at_utc timestamptz,
  platform_run_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at_utc timestamptz NOT NULL DEFAULT now(),
  updated_at_utc timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS daily_task_runs_task_schedule_started_idx
  ON uk_aq_ops.daily_task_runs (task_key, scheduled_for_date, started_at_utc DESC, id DESC);
