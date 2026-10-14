"""Private, explicit TEST/LIVE billing configuration. No ambient credentials or dotenv execution."""
import hashlib
import json
import re
from datetime import date
from pathlib import Path

ENV_PREFIX = 'UK_AQ_BILLING_'
ENV_FIELDS = {
    'ENVIRONMENT', 'QUERY_PROJECT', 'DATASET', 'LOCATION', 'BILLING_ACCOUNT_ID',
    'EARLIEST_USAGE_DATE', 'ARCHIVE_ROOT', 'MYSQL_DATABASE', 'MYSQL_USER',
    'MYSQL_SOCKET', 'OVERLAP_SECONDS', 'SETTLING_SECONDS',
    'MAXIMUM_BYTES_BILLED', 'MAXIMUM_RUN_BYTES', 'MAXIMUM_DAYS_PER_BATCH',
    'RUN_HISTORY_LIMIT',
}
NUMBER_DEFAULTS = {
    'overlap_seconds': 7200,
    'settling_seconds': 120,
    'maximum_bytes_billed': 1073741824,
    'maximum_run_bytes': 8589934592,
    'maximum_days_per_batch': 7,
    'run_history_limit': 200,
}


class SafeError(Exception):
    """Bounded operator-safe failure code, without provider exception payloads."""


def require(ok, code):
    if not ok:
        raise SafeError(code)


def _env_config(path):
    """Parse a private dotenv file as literal KEY=VALUE pairs; never evaluate shell."""
    require(path.is_file() and path.stat().st_mode & 0o077 == 0, 'ENV_FILE_PERMISSIONS')
    values = {}
    for line in path.read_text(encoding='utf-8').splitlines():
        entry = line.strip()
        if not entry or entry.startswith('#'):
            continue
        key, separator, raw = entry.partition('=')
        key = key.strip()
        require(separator and key.startswith(ENV_PREFIX) and
                key[len(ENV_PREFIX):] in ENV_FIELDS and key not in values, 'ENV_FILE_FORMAT')
        value = raw.strip()
        if value.startswith(("'", '"')):
            require(len(value) >= 2 and value.endswith(value[0]), 'ENV_FILE_FORMAT')
            value = value[1:-1]
        values[key] = value

    def field(key):
        return values.get(ENV_PREFIX + key, '')

    def required(key):
        value = field(key)
        require(bool(value), 'ENV_REQUIRED_' + key)
        return value

    account = required('BILLING_ACCOUNT_ID')
    raw_suffix = account.replace('-', '_')
    c = {
        'environment': required('ENVIRONMENT'),
        'query_project': required('QUERY_PROJECT'),
        'dataset': required('DATASET'),
        'location': required('LOCATION'),
        'billing_account_id': account,
        'earliest_usage_date': required('EARLIEST_USAGE_DATE'),
        'archive_root': required('ARCHIVE_ROOT'),
        'mysql_database': required('MYSQL_DATABASE'),
        'mysql_user': required('MYSQL_USER'),
        'mysql_socket': required('MYSQL_SOCKET'),
        'sources': {
            'standard': {
                'raw_table': 'gcp_billing_export_v1_' + raw_suffix,
                'view': 'uk_aq_billing_standard_v1',
            },
            'detailed': {
                'raw_table': 'gcp_billing_export_resource_v1_' + raw_suffix,
                'view': 'uk_aq_billing_detailed_v1',
            },
        },
    }
    for name, default in NUMBER_DEFAULTS.items():
        value = field(name.upper())
        try:
            c[name] = int(value) if value else default
        except ValueError:
            raise SafeError('INVALID_LIMIT') from None
    return c


def load(path, runtime, expected_environment):
    require(expected_environment in ('TEST', 'LIVE'), 'ENVIRONMENT_REQUIRED')
    require(runtime.is_absolute() and runtime.resolve() == runtime and
            runtime.name == expected_environment, 'RUNTIME_BOUNDARY')
    path = Path(path)
    if path.name == '.env.gcp_billing':
        # Operator-managed configuration lives in each Ops repository root.
        # Require this exact location, not a cross-repo or unrelated dotenv.
        root_file = Path(__file__).resolve().parents[2] / '.env.gcp_billing'
        require(path.is_absolute() and path.resolve() == root_file and
                not path.is_symlink(), 'ENV_FILE_BOUNDARY')
        c = _env_config(path)
    elif path.name == '.env':
        # Preserve the previously supported private runtime dotenv format.
        require(path.is_absolute() and path.resolve().is_relative_to(runtime),
                'ENV_FILE_BOUNDARY')
        c = _env_config(path)
    else:
        # Existing deployed TEST config.json remains supported unchanged.
        require(path.suffix == '.json', 'CONFIG_FILE_FORMAT')
        c = json.loads(path.read_text(encoding='utf-8'))

    environment = c['environment']
    require(environment == expected_environment, 'ENVIRONMENT_MISMATCH')
    project = c['query_project']
    dataset = c['dataset']
    require(re.fullmatch(r'[a-z][a-z0-9-]{4,61}[a-z0-9]', project) is not None,
            'SOURCE_PROJECT_INVALID')
    require(dataset.startswith(project + '.') and
            re.fullmatch(r'[A-Za-z0-9_]+', dataset[len(project) + 1:]) is not None,
            'SOURCE_BOUNDARY')
    require(re.fullmatch(r'[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}',
                         c['billing_account_id']) is not None, 'ACCOUNT_REQUIRED')
    env_lower = environment.lower()
    require(c['mysql_database'] == 'uk_aq_gcp_billing_' + env_lower and
            c['mysql_user'] == 'uk_aq_gcp_billing_' + env_lower + '_writer',
            'MYSQL_BOUNDARY')
    require(Path(c['mysql_socket']).is_absolute(), 'SOCKET_REQUIRED')
    try:
        date.fromisoformat(c['earliest_usage_date'])
    except (ValueError, TypeError):
        raise SafeError('HISTORY_BOUNDARY') from None
    require(re.fullmatch(r'[A-Za-z0-9-]+', c['location']) is not None, 'LOCATION_REQUIRED')
    root = Path(c['archive_root'])
    require(root.is_absolute() and root.resolve() == root, 'ARCHIVE_ABSOLUTE_NO_SYMLINK')
    require(root.parts[-4:] == ('Apps', 'github-uk-air-quality-networks',
                                environment, 'gcp_billing'), 'ARCHIVE_BOUNDARY')
    other_env = 'LIVE' if environment == 'TEST' else 'TEST'
    for location in (root, runtime):
        require(other_env not in location.parts, 'CROSS_ENVIRONMENT_PATH')
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
    # Account/source/environment/destination bindings fail closed on later changes.
    value = {k: c[k] for k in ('environment', 'dataset', 'billing_account_id',
                             'earliest_usage_date', 'archive_root', 'mysql_database')}
    value.update(source_kind=source, source=c['sources'][source], generation='micros-v1-csv-gzip')
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
