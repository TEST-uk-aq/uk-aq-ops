"""Read-only Cloudflare account analytics; same DTO/templates as the hosted API."""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlparse

import requests

from uk_aq_dashboard_accounts_auth import AccountsAccessError, authorize_accounts_request

DAY = 86400
TTL = 900
STALE = 3600
MAX_BYTES = 768 * 1024
TEMPLATES = json.loads((Path(__file__).resolve().parents[3] / 'workers/uk_aq_dashboard_online_api_worker/src/lib/media_d1_queries.json').read_text())
_lock = threading.Lock()
_cache: dict[str, tuple[float, dict]] = {}
_attempts: dict[str, list[float]] = {}
_manual_attempts: dict[str, float] = {}
_busy: set[str] = set()


class SourceError(Exception):
    def __init__(self, code: str, stale_safe: bool = False):
        self.code = code
        self.stale_safe = stale_safe


def _day(value: float) -> str:
    return datetime.fromtimestamp(value, timezone.utc).date().isoformat()


def _stamp(value: str) -> float:
    return datetime.strptime(value, '%Y-%m-%d').replace(tzinfo=timezone.utc).timestamp()


def _object(value) -> dict:
    if not isinstance(value, dict):
        raise SourceError('INVALID_ANALYTICS')
    return value


def _numeric(value):
    return value if type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 9007199254740991 else None


def _positive(value):
    raw = str(value or '')
    return int(raw) if re.fullmatch(r'[1-9][0-9]{0,15}', raw) and int(raw) <= 9007199254740991 else None


# Common Cloudflare D1 Free-plan limits and dashboard policy, independent of identity.
DEFAULTS = {'DAILY_READ_LIMIT': 5000000, 'DAILY_WRITE_LIMIT': 100000,
            'WARNING_PERCENT': 75, 'CRITICAL_PERCENT': 90}


def _config() -> dict:
    account = os.getenv('UK_AQ_MEDIA_CLOUDFLARE_ACCOUNT_ID', '').strip()
    database = os.getenv('UK_AQ_MEDIA_CFLARE_D1DB_ID', '').strip()
    token = os.getenv('UK_AQ_MEDIA_D1_ANALYTICS_TOKEN', '').strip()
    if not re.fullmatch(r'[a-fA-F0-9]{32}', account) or not token or len(token) > 4096 or re.search(r'\s', token):
        raise SourceError('NOT_CONFIGURED')
    if not re.fullmatch(r'[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}', database):
        raise SourceError('DATABASE_NOT_CONFIGURED')

    def override(name):
        value = os.getenv('UK_AQ_MEDIA_D1_' + name)
        if value is None:
            return DEFAULTS[name]
        parsed = _positive(value)
        if parsed is None:
            raise SourceError('INVALID_ALLOWANCES')
        return parsed

    limits = {'rows_read': override('DAILY_READ_LIMIT'), 'rows_written': override('DAILY_WRITE_LIMIT')}
    thresholds = {'warning': override('WARNING_PERCENT'), 'critical': override('CRITICAL_PERCENT')}
    if not thresholds['warning'] < thresholds['critical'] <= 100:
        raise SourceError('INVALID_ALLOWANCES')
    return {'account': account, 'database': database, 'token': token, 'limits': limits, 'thresholds': thresholds}


def _graphql(config: dict, query: str, variables: dict) -> dict:
    try:
        with requests.post('https://api.cloudflare.com/client/v4/graphql',
                           headers={'Authorization': 'Bearer ' + config['token'], 'Content-Type': 'application/json'},
                           json={'query': query, 'variables': {'account': config['account'], **variables}},
                           timeout=(3.05, 12), allow_redirects=False, stream=True) as response:
            if response.status_code != 200:
                raise SourceError('ANALYTICS_ACCESS_DENIED' if response.status_code in {401, 403}
                                  else 'ANALYTICS_UNAVAILABLE', response.status_code >= 500)
            raw = bytearray()
            started = time.monotonic()
            for chunk in response.iter_content(8192):
                raw.extend(chunk)
                if len(raw) > MAX_BYTES or time.monotonic() - started > 15:
                    raise SourceError('INVALID_ANALYTICS')
        payload = _object(json.loads(raw))
    except requests.RequestException:
        raise SourceError('ANALYTICS_UNAVAILABLE', True) from None
    except (ValueError, TypeError):
        raise SourceError('INVALID_ANALYTICS') from None
    # Provider error text and SQL are never logged or copied to the response.
    if payload.get('errors'):
        raise SourceError('ANALYTICS_REJECTED')
    accounts = _object(_object(payload.get('data')).get('viewer')).get('accounts')
    if not isinstance(accounts, list) or len(accounts) != 1:
        raise SourceError('ANALYTICS_ACCESS_DENIED')
    return _object(accounts[0])


def _settings(value, fields: list[str]) -> dict:
    info = _object(value)
    if info.get('enabled') is not True or not isinstance(info.get('availableFields'), list) or any(
            field not in info['availableFields'] for field in fields) or not all(
            _positive(info.get(field)) for field in ['maxDuration', 'notOlderThan', 'maxPageSize']):
        raise SourceError('DATASET_UNAVAILABLE')
    return info


def _retrieve(config: dict, mode: str, dates: list[str], selected: str, now: float) -> dict:
    info = _object(_graphql(config, TEMPLATES['settings'], {}).get('settings'))
    limits = _settings(info.get(mode), ['dimensions_date', 'sum_rowsRead', 'sum_rowsWritten'] if mode == 'daily'
                       else ['dimensions_query', 'count', 'sum_rowsRead'])
    oldest = math.ceil((now - limits['notOlderThan']) / DAY) * DAY
    if mode == 'queries':
        start = _stamp(selected)
        if start < oldest:
            raise SourceError('OUTSIDE_RETENTION')
        if limits['maxDuration'] < DAY or limits['maxPageSize'] < 5:
            raise SourceError('UNSUPPORTED_WINDOW')
        fields = ['rowsRead'] + (['rowsWritten'] if 'sum_rowsWritten' in limits['availableFields'] else [])
        result = _graphql(config, TEMPLATES['queries'].replace('METRICS', ' '.join(fields)), {
            'database': config['database'], 'start': datetime.fromtimestamp(start, timezone.utc).isoformat(),
            'end': datetime.fromtimestamp(min(start + DAY, now), timezone.utc).isoformat(),
        }).get('queries')
        if not isinstance(result, list) or len(result) > 5:
            raise SourceError('INVALID_ANALYTICS')
        rows = []
        for raw in result:
            row = _object(raw)
            totals = _object(row.get('sum'))
            query = _object(row.get('dimensions')).get('query')
            count, reads = _numeric(row.get('count')), _numeric(totals.get('rowsRead'))
            if not isinstance(query, str) or len(query) > 100000 or count is None or reads is None:
                raise SourceError('INVALID_ANALYTICS')
            # Preserve Cloudflare's group identity without returning SQL text.
            fingerprint = hashlib.sha256(query.encode()).hexdigest()[:20]
            operation = re.match(r'\s*(SELECT|INSERT|UPDATE|DELETE|WITH|REPLACE|PRAGMA)\b', query, re.I)
            rows.append({'description': f'{operation[1].upper() if operation else "SQL"} · query {fingerprint}',
                         'fingerprint': fingerprint, 'executions': count, 'rows_read': reads,
                         'average_rows_read': reads / count if count > 0 else None,
                         'rows_written': _numeric(totals.get('rowsWritten'))})
        return {'scope': 'media_database', 'rows': sorted(rows, key=lambda row: -row['rows_read'])}
    fields = ['rowsRead', 'rowsWritten'] + [field for field in ['readQueries', 'writeQueries']
                                          if 'sum_' + field in limits['availableFields']]
    eligible = [date for date in dates if _stamp(date) >= oldest]
    chunk_size = min(31, limits['maxDuration'] // DAY, limits['maxPageSize'])
    if chunk_size < 1 or math.ceil(len(eligible) / chunk_size) > 12:
        raise SourceError('UNSUPPORTED_WINDOW')
    by_day = {}
    for index in range(0, len(eligible), chunk_size):
        chunk = eligible[index:index + chunk_size]
        query = TEMPLATES['daily'].replace('LIMIT', str(len(chunk))).replace('METRICS', ' '.join(fields))
        result = _graphql(config, query, {'start': chunk[0], 'end': chunk[-1]}).get('daily')
        if not isinstance(result, list) or len(result) > len(chunk):
            raise SourceError('INVALID_ANALYTICS')
        for raw in result:
            row = _object(raw)
            date = _object(row.get('dimensions')).get('date')
            totals = _object(row.get('sum'))
            if date not in chunk or date in by_day or any(_numeric(totals.get(field)) is None for field in ['rowsRead', 'rowsWritten']):
                raise SourceError('INVALID_ANALYTICS')
            by_day[date] = {'rows_read': _numeric(totals.get('rowsRead')), 'rows_written': _numeric(totals.get('rowsWritten')),
                            'read_queries': _numeric(totals.get('readQueries')), 'write_queries': _numeric(totals.get('writeQueries'))}
    return {'scope': 'account', 'retention_start': _day(oldest), 'rows': [
        {'date': date, 'partial': date == dates[-1], 'status': 'available' if date in by_day else
         'outside_retention' if _stamp(date) < oldest else 'missing', 'rows_read': None, 'rows_written': None,
         'read_queries': None, 'write_queries': None, **by_day.get(date, {})} for date in dates]}


def _usage_data(mode: str, dates: list[str], selected: str, refresh: bool) -> dict:
    try:
        config = _config()
    except SourceError as error:
        return {'status': 'unavailable', 'error': error.code, 'daily_limits': None, 'thresholds': None, 'retrieved_at': None, 'rows': []}
    now = time.time()
    identity = hashlib.sha256(json.dumps([config['account'], config['database'], config['token']], separators=(',', ':')).encode()).hexdigest()
    key = f'{identity}:{mode}:{dates[0]}:{dates[-1]}:{selected if mode == "queries" else ""}'
    gate = mode
    base = {'daily_limits': config['limits'], 'thresholds': config['thresholds']}
    with _lock:
        entry = _cache.get(key)
        if not refresh and entry and now - entry[0] < TTL:
            return {**base, **entry[1], 'status': 'cached', 'error': None}
        recent_attempts = [at for at in _attempts.get(gate, []) if now - at < 60]
        if len(recent_attempts) >= 4 or (refresh and now - _manual_attempts.get(gate, 0) < 60) or gate in _busy:
            recent = entry and now - entry[0] <= STALE
            return {**base, **(entry[1] if recent else {'rows': [], 'retrieved_at': None}),
                    'status': ('cached' if now - entry[0] < TTL else 'stale') if recent else 'unavailable',
                    'error': 'REFRESH_RATE_LIMITED'}
        _attempts[gate] = recent_attempts + [now]
        if refresh:
            _manual_attempts[gate] = now
        _busy.add(gate)
    try:
        data = {**_retrieve(config, mode, dates, selected, now),
                'retrieved_at': datetime.now(timezone.utc).isoformat()}
        with _lock:
            if len(_cache) >= 32:
                del _cache[next(iter(_cache))]
            _cache[key] = (time.time(), data)
        return {**base, **data, 'status': 'fresh', 'error': None}
    except Exception as error:
        failure = error if isinstance(error, SourceError) else SourceError('ANALYTICS_UNAVAILABLE')
        if entry and failure.stale_safe and now - entry[0] <= STALE:
            return {**base, **entry[1], 'status': 'stale', 'error': failure.code}
        with _lock:
            for cached_key in list(_cache):
                if cached_key.startswith(identity + ':'):
                    _cache.pop(cached_key, None)
        return {**base, 'status': 'unavailable', 'error': failure.code, 'retrieved_at': None, 'rows': []}
    finally:
        with _lock:
            _busy.discard(gate)


def _query(raw: str) -> dict:
    if len(raw) > 256 or re.search(r'%(?![a-fA-F0-9]{2})', raw):
        raise ValueError()
    rows = parse_qsl(raw, keep_blank_values=True, strict_parsing=True, max_num_fields=4, errors='strict')
    query = dict(rows)
    if len(query) != len(rows) or set(query) - {'days', 'day', 'view', 'refresh'}:
        raise ValueError()
    if query.get('days', '7') not in {'7', '30', '90'} or query.get('view', 'daily') not in {'daily', 'queries'} or query.get('refresh', '0') not in {'0', '1'}:
        raise ValueError()
    if query.get('view', 'daily') == 'daily' and 'day' in query:
        raise ValueError()
    return query


def _send(handler, body: dict, status: int = 200):
    payload = json.dumps(body, allow_nan=False, separators=(',', ':')).encode()
    handler.send_response(status)
    for name, value in {'Content-Type': 'application/json; charset=utf-8', 'Content-Length': str(len(payload)),
                        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'}.items():
        handler.send_header(name, value)
    if status == 405:
        handler.send_header('Allow', 'GET')
    handler.end_headers()
    if handler.command != 'HEAD':
        handler.wfile.write(payload)


def serve_d1_usage(handler):
    try:
        authorize_accounts_request(handler)
    except AccountsAccessError as error:
        _send(handler, {'error': {'code': 'UNAUTHORIZED', 'message': 'A verified personal Access session is required'}}, error.status)
        return
    if handler.command != 'GET':
        _send(handler, {'error': {'message': 'Only GET is supported'}}, 405)
        return
    try:
        query = _query(urlparse(handler.path).query)
        days, mode = int(query.get('days', '7')), query.get('view', 'daily')
        today = math.floor(time.time() / DAY) * DAY
        dates = [_day(today - (days - index - 1) * DAY) for index in range(days)]
        selected = query.get('day', dates[-1])
        if selected not in dates:
            raise ValueError()
    except (ValueError, UnicodeError):
        _send(handler, {'error': {'code': 'INVALID_QUERY', 'message': 'Invalid D1 Usage parameters'}}, 400)
        return
    usage = _usage_data(mode, dates, selected, query.get('refresh') == '1')
    _send(handler, {'view': mode, 'days': days, 'dates': dates, 'selected_day': selected,
                    'today': _day(today), 'usage': usage})
