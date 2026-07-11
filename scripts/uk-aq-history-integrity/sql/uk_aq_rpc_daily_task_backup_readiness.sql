-- Narrow read RPC for the history integrity Dropbox-backup readiness gate.
-- Apply manually in the ops database after confirming table/column names match
-- the deployed daily task health schema.

CREATE OR REPLACE FUNCTION uk_aq_ops.uk_aq_rpc_daily_task_backup_readiness(
  p_scheduled_for_date date,
  p_task_keys text[]
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = uk_aq_ops, public
AS $$
  WITH requested AS (
    SELECT DISTINCT unnest(COALESCE(p_task_keys, ARRAY[]::text[])) AS task_key
  ),
  latest AS (
    SELECT DISTINCT ON (r.task_key)
      r.task_key,
      r.status,
      r.scheduled_for_date,
      r.finished_at_utc AS completed_at
    FROM uk_aq_ops.daily_task_runs r
    JOIN requested q ON q.task_key = r.task_key
    WHERE r.scheduled_for_date = p_scheduled_for_date
    ORDER BY r.task_key, r.finished_at_utc DESC NULLS LAST, r.started_at_utc DESC NULLS LAST
  ),
  joined AS (
    SELECT
      q.task_key,
      COALESCE(l.status, 'missing') AS status,
      p_scheduled_for_date AS scheduled_for_date,
      l.completed_at,
      (l.status IN ('ok', 'success', 'succeeded', 'complete', 'completed') AND l.completed_at IS NOT NULL) AS ready
    FROM requested q
    LEFT JOIN latest l ON l.task_key = q.task_key
  )
  SELECT jsonb_build_object(
    'backup_ready', COALESCE(bool_and(ready), false),
    'blocked_reason', CASE
      WHEN COUNT(*) = 0 THEN 'no_required_backup_task_keys_configured'
      WHEN COALESCE(bool_and(ready), false) THEN NULL
      ELSE 'backup_task_not_successful'
    END,
    'backup_completed_at', MAX(completed_at),
    'tasks', COALESCE(jsonb_agg(jsonb_build_object(
      'task_key', task_key,
      'status', status,
      'scheduled_for_date', scheduled_for_date,
      'completed_at', completed_at
    ) ORDER BY task_key), '[]'::jsonb)
  )
  FROM joined;
$$;

REVOKE ALL ON FUNCTION uk_aq_ops.uk_aq_rpc_daily_task_backup_readiness(date, text[]) FROM PUBLIC;
-- Grant execute to the role used by the integrity runner if needed, for example:
-- GRANT EXECUTE ON FUNCTION uk_aq_ops.uk_aq_rpc_daily_task_backup_readiness(date, text[]) TO service_role;
