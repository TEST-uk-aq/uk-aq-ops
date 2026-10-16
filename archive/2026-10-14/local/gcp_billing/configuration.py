"""Explicit TEST-only configuration; no global login, dotenv or LIVE fallback."""
import hashlib
import json
import re
from datetime import date
from pathlib import Path

PROJECT = 'project-53835517-a266-48e3-8d9'


class SafeError(Exception):
    """Bounded operator-safe failure code, without provider exception payloads."""


def require(ok, code):
    if not ok:
        raise SafeError(code)


def load(path, runtime):
    c = json.loads(Path(path).read_text())
    require(c['environment'] == 'TEST', 'TEST_ONLY')
    require(c['query_project'] == PROJECT and
            c['dataset'] == PROJECT + '.gcp_billing_export', 'SOURCE_BOUNDARY')
    require(re.fullmatch(r'[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}', c['billing_account_id']),
            'ACCOUNT_REQUIRED')
    require(c['mysql_database'] == 'uk_aq_gcp_billing_test' and
            c['mysql_user'] == 'uk_aq_gcp_billing_test_writer', 'MYSQL_BOUNDARY')
    require(Path(c['mysql_socket']).is_absolute(), 'SOCKET_REQUIRED')
    require(date.fromisoformat(c['earliest_usage_date']) == date(2026, 5, 1), 'HISTORY_BOUNDARY')
    require(re.fullmatch(r'[a-zA-Z0-9-]+', c['location']) is not None, 'LOCATION_REQUIRED')
    root = Path(c['archive_root'])
    require(root.is_absolute() and root.resolve() == root, 'ARCHIVE_ABSOLUTE_NO_SYMLINK')
    require(root.parts[-4:] == ('Apps', 'github-uk-air-quality-networks', 'TEST', 'gcp_billing'),
            'ARCHIVE_BOUNDARY')
    require(runtime.is_absolute() and runtime.resolve() == runtime and runtime.name == 'TEST',
            'RUNTIME_BOUNDARY')
    for p in (root, runtime):
        require(not any(x.casefold() == 'live' for x in p.parts), 'LIVE_PATH_REJECTED')
    require(not root.is_relative_to(runtime) and not runtime.is_relative_to(root),
            'RUNTIME_OUTSIDE_ARCHIVE')
    require(set(c['sources']) == {'standard', 'detailed'}, 'SOURCE_KINDS')
    for source, cfg in c['sources'].items():
        prefix = 'gcp_billing_export_' + ('resource_' if source == 'detailed' else '') + 'v1_'
        require(cfg['raw_table'] == prefix + c['billing_account_id'].replace('-', '_'),
                'EXPORT_TABLE_ACCOUNT')
        require(cfg['view'] == f'uk_aq_billing_{source}_v1', 'VIEW_IDENTITY')
    for key, low, high in [
        ('overlap_seconds', 3600, 604800), ('settling_seconds', 60, 86400),
        ('maximum_bytes_billed', 1, 10**12), ('maximum_run_bytes', 1, 10**13),
        ('maximum_days_per_batch', 1, 31), ('run_history_limit', 10, 1000),
    ]:
        require(type(c[key]) is int and low <= c[key] <= high, 'INVALID_LIMIT')
    require(c['maximum_run_bytes'] >= c['maximum_bytes_billed'], 'INVALID_BUDGET')
    require('REPLACE' not in json.dumps(c), 'UNCONFIGURED')
    return c


def identity(c, source):
    # Stable source/destination binding. Tuning budgets or scheduling is harmless;
    # changing a source, boundary or canonical semantics requires explicit rebuild.
    value = {k: c[k] for k in ('environment', 'dataset', 'billing_account_id',
                             'earliest_usage_date', 'archive_root', 'mysql_database')}
    value.update(source_kind=source, source=c['sources'][source], generation='micros-v1-csv-gzip')
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
