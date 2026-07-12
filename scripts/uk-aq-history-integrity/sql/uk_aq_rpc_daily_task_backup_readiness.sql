-- PostgREST-facing daily task health RPCs for Obs AQI DB.
-- The integrity runner uses the exposed uk_aq_public schema for RPC calls.

CREATE SCHEMA IF NOT EXISTS uk_aq_public;
CREATE SCHEMA IF NOT EXISTS uk_aq_ops;

CREATE OR REPLACE FUNCTION uk_aq_public.uk_aq_rpc_daily_task_backup_readiness(
  p_scheduled_for_date date,
  p_integrity_started_at_utc timestamptz,
  p_task_keys text[]
)
RETURNS TABLE (
  backup_ready boolean,
  blocked_reason text,
  backup_completed_at timestamptz,
  tasks jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, uk_aq_public
AS $$
DECLARE
  v_task_key text;
  v_latest uk_aq_ops.daily_task_runs%ROWTYPE;
  v_tasks jsonb := '[]'::jsonb;
  v_ready boolean := true;
  v_reason text := null;
  v_completed_at timestamptz := null;
BEGIN
  IF p_scheduled_for_date IS NULL THEN
    RAISE EXCEPTION 'p_scheduled_for_date is required';
  END IF;
  IF p_integrity_started_at_utc IS NULL THEN
    RAISE EXCEPTION 'p_integrity_started_at_utc is required';
  END IF;
  IF p_task_keys IS NULL OR cardinality(p_task_keys) = 0 THEN
    RAISE EXCEPTION 'p_task_keys must contain at least one task key';
  END IF;
  FOREACH v_task_key IN ARRAY p_task_keys LOOP
    v_task_key := btrim(coalesce(v_task_key, ''));
    IF v_task_key = '' THEN
      RAISE EXCEPTION 'p_task_keys must not contain blank task keys';
    END IF;

    SELECT r.*
      INTO v_latest
      FROM uk_aq_ops.daily_task_runs AS r
     WHERE r.task_key = v_task_key
       AND r.scheduled_for_date = p_scheduled_for_date
     ORDER BY r.attempt DESC, r.updated_at DESC, r.id DESC
     LIMIT 1;

    IF NOT FOUND THEN
      v_ready := false;
      v_reason := coalesce(v_reason, 'missing_required_task');
      v_tasks := v_tasks || jsonb_build_object(
        'task_key', v_task_key,
        'backup_ready', false,
        'blocked_reason', 'missing_required_task'
      );
    ELSIF v_latest.status <> 'Finished' THEN
      v_ready := false;
      v_reason := coalesce(v_reason, 'latest_task_not_finished');
      v_tasks := v_tasks || jsonb_build_object(
        'task_key', v_task_key,
        'run_id', v_latest.id,
        'status', v_latest.status,
        'backup_ready', false,
        'blocked_reason', 'latest_task_not_finished',
        'finished_at', v_latest.finished_at
      );
    ELSIF v_latest.finished_at IS NULL OR v_latest.finished_at > p_integrity_started_at_utc THEN
      v_ready := false;
      v_reason := coalesce(v_reason, 'task_finished_after_integrity_start');
      v_tasks := v_tasks || jsonb_build_object(
        'task_key', v_task_key,
        'run_id', v_latest.id,
        'status', v_latest.status,
        'backup_ready', false,
        'blocked_reason', 'task_finished_after_integrity_start',
        'finished_at', v_latest.finished_at
      );
    ELSE
      v_completed_at := greatest(coalesce(v_completed_at, v_latest.finished_at), v_latest.finished_at);
      v_tasks := v_tasks || jsonb_build_object(
        'task_key', v_task_key,
        'run_id', v_latest.id,
        'status', v_latest.status,
        'backup_ready', true,
        'blocked_reason', null,
        'finished_at', v_latest.finished_at
      );
    END IF;
  END LOOP;

  RETURN QUERY SELECT v_ready, CASE WHEN v_ready THEN NULL ELSE v_reason END, v_completed_at, v_tasks;
END;
$$;

REVOKE ALL ON FUNCTION uk_aq_public.uk_aq_rpc_daily_task_backup_readiness(date, timestamptz, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION uk_aq_public.uk_aq_rpc_daily_task_backup_readiness(date, timestamptz, text[]) TO service_role;
