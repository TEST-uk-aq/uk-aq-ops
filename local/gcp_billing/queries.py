"""Read-only collector queries and operator-rendered view DDL (never applied here)."""
DIMENSIONS = [
    'usage_date', 'invoice_month', 'billing_account_id', 'project_id', 'project_name',
    'service_id', 'service_description', 'sku_id', 'sku_description', 'cost_type', 'currency',
]
RESOURCE_DIMENSIONS = ['resource_name', 'resource_global_name']
MONEY = ['gross_cost_micros', 'credit_micros', 'net_cost_micros']
TABLES = {'standard': 'daily_costs', 'detailed': 'resource_daily_costs'}


def dimensions(source):
    return DIMENSIONS + (RESOURCE_DIMENSIONS if source == 'detailed' else [])


def view_ddl(config, source):
    """Pinned v1: per-row BIGNUMERIC ROUND half away from zero, then sum micros.

    Casting Google's FLOAT64 export to decimal cannot recover upstream precision,
    but all downstream persisted money is signed integer micros. Credits are
    rounded individually before addition; net = gross micros + signed credits.
    """
    cfg = config['sources'][source]
    resource = (', resource.name AS resource_name, resource.global_name AS resource_global_name'
                if source == 'detailed' else '')
    return f'''CREATE OR REPLACE VIEW `{config['dataset']}.{cfg['view']}` AS
SELECT DATE(usage_start_time, 'UTC') AS usage_date,
       invoice.month AS invoice_month, billing_account_id,
       project.id AS project_id, project.name AS project_name,
       service.id AS service_id, service.description AS service_description,
       sku.id AS sku_id, sku.description AS sku_description,
       cost_type, currency{resource},
       CAST(ROUND(CAST(cost AS BIGNUMERIC) * 1000000) AS INT64) AS gross_cost_micros,
       COALESCE((SELECT SUM(CAST(ROUND(CAST(c.amount AS BIGNUMERIC) * 1000000)
                    AS INT64)) FROM UNNEST(credits) AS c), 0) AS credit_micros,
       export_time
FROM `{config['dataset']}.{cfg['raw_table']}`;
'''


def aggregate_sql(view, source):
    dims = ', '.join(dimensions(source))
    return f'''SELECT {dims},
        SUM(gross_cost_micros) AS gross_cost_micros,
        SUM(credit_micros) AS credit_micros,
        SUM(gross_cost_micros) + SUM(credit_micros) AS net_cost_micros,
        MAX(export_time) AS source_export_time_max
    FROM `{view}`
    WHERE usage_date = @day AND export_time <= @cutoff
      AND billing_account_id = @account
    GROUP BY {dims}'''
