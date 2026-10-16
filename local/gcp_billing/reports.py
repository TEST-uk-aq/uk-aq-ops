"""Deterministic gzip CSV archives and exact-money human-readable summaries."""
import csv
import gzip
import io
from datetime import date, datetime
from decimal import Decimal

from queries import MONEY, TABLES, dimensions


def scalar(value):
    if isinstance(value, datetime):
        return value.isoformat(timespec='microseconds') + 'Z'  # SQL sessions are UTC
    if isinstance(value, date):
        return value.isoformat()
    return value


def daily_archive(source, rows):
    fields = dimensions(source) + MONEY + ['source_export_time_max', 'refreshed_at']
    out = io.StringIO(newline='')
    writer = csv.writer(out, lineterminator='\n')
    # Separate null flags preserve SQL NULL versus genuine empty strings in CSV.
    writer.writerow(fields + [x + '__is_null' for x in dimensions(source)])
    for row in rows:
        writer.writerow([scalar(row[k]) for k in fields] +
                        [int(row[k] is None) for k in dimensions(source)])
    return gzip.compress(out.getvalue().encode('utf-8'), mtime=0)


def money(value):
    return format(Decimal(value) / Decimal(1000000), '.6f')


def summaries(connection, source, cutoff, history_complete, environment):
    table = TABLES[source]
    coverage = ('Initial history backfill complete.' if history_complete else
                'PARTIAL HISTORY: initial backfill is still in progress.')
    groups = {
        'daily': ['usage_date', 'currency'],
        'monthly-usage': ["DATE_FORMAT(usage_date, '%%Y-%%m')", 'currency'],
        'monthly-invoice': ['invoice_month', 'currency'],
        'services': ['service_id', 'service_description', 'currency'],
        'skus': ['service_id', 'service_description', 'sku_id', 'sku_description', 'currency'],
    }
    if source == 'detailed':
        groups['cloud-run-resources'] = [
            'usage_date', 'invoice_month', 'project_id', 'resource_name',
            'resource_global_name', 'sku_id', 'sku_description', 'currency',
        ]
    for name, dims in groups.items():
        # Stream canonical rows inside the caller's publication transaction.
        # Grouping/ordering the full TEXT descriptions in MySQL can exhaust its
        # sort buffer (error 1038); Python integers also preserve exact micros.
        from pymysql.cursors import SSDictCursor
        usage_month = "DATE_FORMAT(usage_date, '%%Y-%%m')"
        cols = list(dict.fromkeys(
            'usage_date' if dim == usage_month else dim for dim in dims
        )) + MONEY
        where = "WHERE service_description = %s" if name == 'cloud-run-resources' else ''
        statement = f"SELECT {', '.join(cols)} FROM {table} {where}"
        totals = {}
        with connection.cursor(SSDictCursor) as cur:
            cur.execute(statement, ('Cloud Run',) if where else ())
            for record in cur:
                key = tuple(record['usage_date'].strftime('%Y-%m')
                            if dim == usage_month else record[dim] for dim in dims)
                amounts = totals.setdefault(key, [0, 0, 0])
                for i, field in enumerate(MONEY):
                    amounts[i] += int(record[field])
        # NULL first, then deterministic dimension ordering without SQL filesort.
        ordered = sorted(totals.items(), key=lambda pair:
                         tuple((value is not None, value if value is not None else '')
                               for value in pair[0]))
        rows = [
            {**{f'd{i}': value for i, value in enumerate(key)},
             'gross': amounts[0], 'credits': amounts[1], 'net': amounts[2]}
            for key, amounts in ordered
        ]
        title = ('Standard reporting totals' if source == 'standard' else
                 'Detailed resource investigation — do not add to Standard totals')
        lines = [f'# {environment} GCP billing: {name}', '', title, '',
                 f'BigQuery is authoritative. Publication cutoff: {scalar(cutoff)}.',
                 coverage,
                 'Recent usage is provisional; absent usage does not prove zero cost.',
                 'Amounts retain six decimal places; currencies are never combined.',
                 'NULL means no upstream attribution; an empty string is shown as "".', '',
                 '| ' + ' | '.join(dim.replace('%%', '%') for dim in dims) +
                 ' | gross | signed credits | net |',
                 '| ' + ' | '.join(['---'] * (len(dims) + 3)) + ' |']
        def cell(value):
            if value is None:
                return 'NULL (unattributed)'
            if value == '':
                return '""'
            return str(scalar(value)).replace('|', '\\|').replace('\n', ' ').replace('\r', ' ')
        for row in rows:
            lines.append('| ' + ' | '.join([cell(row[f'd{i}']) for i in range(len(dims))] +
                                          [money(row[k]) for k in ('gross', 'credits', 'net')]) + ' |')
        if not rows:
            lines += ['', 'No exported costs in this snapshot (not proof of zero usage).']
        yield f'{name}.md', ('\n'.join(lines) + '\n').encode('utf-8')
