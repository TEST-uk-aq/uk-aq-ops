"""Read-only collector queries and operator-rendered view DDL (never applied here)."""
import re
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

# Lexical view comparison: ignore only formatting/comments/case of bare words.
# Quoted identifiers and literals remain exact; no semantic SQL rewriting.
_SQL_WORD = re.compile(r'[A-Za-z_][A-Za-z_0-9]*')
_SQL_NUMBER = re.compile(r'(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[Ee][+-]?[0-9]+)?')
_SQL_OPERATORS = ('<=', '>=', '<>', '!=', '||', '<<', '>>', '=>', ':=')
_SQL_PUNCTUATION = frozenset('(),.*=+-/<>;%[]')


def view_sql_tokens(statement):
    """Return SQL tokens, failing closed on unfamiliar or unterminated input."""
    tokens = []
    pos = 0
    while pos < len(statement):
        char = statement[pos]
        if char.isspace():
            pos += 1
            continue
        if statement.startswith('--', pos) or char == '#':
            end = statement.find('\n', pos)
            pos = len(statement) if end < 0 else end + 1
            continue
        if statement.startswith('/*', pos):
            end = statement.find('*/', pos + 2)
            if end < 0:
                raise ValueError('unterminated SQL comment')
            pos = end + 2
            continue
        if char in ("'", '"', chr(96)):
            start = pos
            quote = char
            pos += 1
            while pos < len(statement):
                if statement[pos] == '\\':
                    if pos + 1 >= len(statement):
                        raise ValueError('incomplete SQL string escape')
                    pos += 2
                elif statement[pos] == quote:
                    if pos + 1 < len(statement) and statement[pos + 1] == quote:
                        pos += 2
                    else:
                        pos += 1
                        break
                else:
                    pos += 1
            else:
                raise ValueError('unterminated SQL quoted value')
            tokens.append(('quoted', statement[start:pos]))
            continue
        word = _SQL_WORD.match(statement, pos)
        if word:
            tokens.append(('word', word.group().casefold()))
            pos = word.end()
            continue
        number = _SQL_NUMBER.match(statement, pos)
        if number:
            tokens.append(('number', number.group()))
            pos = number.end()
            continue
        operator = next((x for x in _SQL_OPERATORS if statement.startswith(x, pos)), None)
        if operator:
            tokens.append(('operator', operator))
            pos += len(operator)
            continue
        if char in _SQL_PUNCTUATION:
            tokens.append(('punctuation', char))
            pos += 1
            continue
        raise ValueError('unsupported SQL token')
    if tokens and tokens[-1] == ('punctuation', ';'):
        tokens.pop()
    if any(kind == 'punctuation' and value == ';' for kind, value in tokens):
        raise ValueError('multiple SQL statements')
    return tuple(tokens)


def expected_view_schema(source):
    """Expected column names/types, ordered as in the pinned generated SQL."""
    names = dimensions(source) + ['gross_cost_micros', 'credit_micros', 'export_time']
    return list(zip(names, ['DATE'] + ['STRING'] * (len(dimensions(source)) - 1)
                    + ['INTEGER', 'INTEGER', 'TIMESTAMP']))
