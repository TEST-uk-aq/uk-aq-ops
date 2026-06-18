#!/usr/bin/env python3
"""
CIC multi-repo dev server — run with: python3 serve.py
Serves multiple repos from a single port without moving any folders.
API calls to /api/aq/... are proxied to the production Cloudflare Workers.
"""

import datetime
import http.server
import json
import os
import socketserver
import urllib.request
import urllib.error
from urllib.parse import urlparse, unquote, parse_qs, urlencode

PORT = 8080

# Proxy /api/aq/... to production Cloudflare Workers
API_PROXY_PREFIX  = '/api/aq'
API_PROXY_TARGET  = 'https://cic-test.chronicillnesschannel.co.uk'
POSTCODE_PROXY_ROUTES = {
    '/api/postcode_suggest': '/v1/postcode_suggest',
    '/api/postcode_lookup': '/v1/postcode_lookup',
}

# URL prefix → absolute filesystem root (longest prefix matched first)
ROOTS = {
    '/uk-aq':         '/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-UK-AQ Webpage/CIC-test-uk-aq-webpage',
    '/data-explorer': '/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Data Explorer/CIC Data Explorer Mark 2/CIC-test-data-explorer-mk2',
    '/report':        '/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Report Form/CIC-TEST-report-form',
    '/station-snapshot': '/Users/mikehinford/Dropbox/Projects/CIC Website/CIC Air Quality Networks/CIC-test-uk-aq-Operations/CIC-test-uk-aq-ops/station_snapshot',
    '/station-snapshot-v2': None,  # populated from OPS_REPO_ROOT below
    '/':                 '/Users/mikehinford/Dropbox/Projects/CIC Website/ChronicChannel-Test Root Repo/ChronicChannel-test.github.io',
}


def _load_env_file(env_path):
    env = {}
    try:
        with open(env_path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, _, v = line.partition('=')
                    env[k.strip()] = v.strip()
    except FileNotFoundError:
        pass
    return env

# Ops repo root (one level up from station_snapshot)
OPS_REPO_ROOT = os.path.dirname(ROOTS['/station-snapshot'].rstrip('/')) if '/station-snapshot' in ROOTS else None
if OPS_REPO_ROOT:
    ROOTS['/station-snapshot-v2'] = os.path.join(OPS_REPO_ROOT, 'station_snapshot_v2')

# Cloudflare Access Service Token — loaded from local .env with fallback to UK-AQ .env
_env = {}
_env.update(_load_env_file(os.path.join(ROOTS['/uk-aq'], '.env')))
_env.update(_load_env_file(os.path.join(os.path.dirname(__file__), '.env')))
if OPS_REPO_ROOT:
    _env.update(_load_env_file(os.path.join(OPS_REPO_ROOT, '.env')))
# Real environment variables override local .env files so deployed/CI config wins.
_env.update(os.environ)
CF_CLIENT_ID     = _env.get('CLOUDFLARE_ACCESS_CLIENT_ID', '')
CF_CLIENT_SECRET = _env.get('CLOUDFLARE_ACCESS_CLIENT_SECRET', '')
AQ_CACHE_BYPASS_SECRET = _env.get('UK_AQ_CACHE_BYPASS_SECRET', '')
POSTCODE_UPSTREAM_URL = _env.get(
    'UK_AQ_POSTCODE_LOOKUP_UPSTREAM_URL',
    'https://uk-aq-postcode-lookup-r2-api.michael-hinford.workers.dev',
)
EDGE_UPSTREAM_SECRET = _env.get('UK_AQ_EDGE_UPSTREAM_SECRET', '')
TURNSTILE_SITE_KEY = _env.get('UK_AQ_TURNSTILE_SITE_KEY', '')
TURNSTILE_PLACEHOLDER = "__UK_AQ_TURNSTILE_SITE_KEY__"

# Database connection URLs for the Station Snapshot endpoint
INGESTDB_DB_URL = _env.get('SUPABASE_DB_URL', '')
OBSAQIDB_DB_URL = _env.get('OBS_AQIDB_SUPABASE_DB_URL', '')
INGESTDB_SUPABASE_URL = _env.get('SUPABASE_URL', '')
INGESTDB_SERVICE_KEY = _env.get('SB_SECRET_KEY', '') or _env.get('SUPABASE_SERVICE_ROLE_KEY', '')
OBSAQIDB_SUPABASE_URL = _env.get('OBS_AQIDB_SUPABASE_URL', '')
OBSAQIDB_SERVICE_KEY = _env.get('OBS_AQIDB_SECRET_KEY', '') or _env.get('SBASE_HISTORY_SB_SECRET', '')
STATION_SNAPSHOT_MODE = (_env.get('STATION_SNAPSHOT_MODE', 'api') or 'api').strip().lower()
try:
    STATION_SNAPSHOT_MAX_ROWS = int(_env.get('STATION_SNAPSHOT_MAX_ROWS', '10000'))
except (TypeError, ValueError):
    STATION_SNAPSHOT_MAX_ROWS = 10000
STATION_SNAPSHOT_MAX_ROWS = max(100, STATION_SNAPSHOT_MAX_ROWS)
UK_AQ_OBSERVS_HISTORY_R2_API_URL = _env.get('UK_AQ_OBSERVS_HISTORY_R2_API_URL', '')
UK_AQ_OBSERVS_HISTORY_R2_API_TOKEN = _env.get('UK_AQ_OBSERVS_HISTORY_R2_API_TOKEN', '')
UK_AQ_AQI_HISTORY_R2_API_URL = _env.get('UK_AQ_AQI_HISTORY_R2_API_URL', '')
UK_AQ_AQI_HISTORY_R2_API_TOKEN = _env.get('UK_AQ_AQI_HISTORY_R2_API_TOKEN', '')
UK_AQ_CORE_SCHEMA = _env.get('UK_AQ_CORE_SCHEMA', 'uk_aq_core') or 'uk_aq_core'
UK_AQ_PUBLIC_SCHEMA = _env.get('UK_AQ_PUBLIC_SCHEMA', 'uk_aq_public') or 'uk_aq_public'
LOCAL_DEV_USER_AGENT = _env.get(
    'UK_AQ_LOCAL_DEV_USER_AGENT',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    '(KHTML, like Gecko) Chrome/126 Safari/537.36 CIC-LocalDev/1.0',
)

# Headers that must not be forwarded to the upstream or back to the client
_HOP_BY_HOP = frozenset([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailers', 'transfer-encoding', 'upgrade',
    'host',  # we set this ourselves
])


class MultiRootHandler(http.server.SimpleHTTPRequestHandler):

    # ── API proxy ──────────────────────────────────────────────────────────────

    def _maybe_serve_uk_aq_html_with_turnstile(self):
        # Keep local URLs clean by replacing the Turnstile placeholder in served HTML.
        if not TURNSTILE_SITE_KEY:
            return False

        decoded_path = unquote(urlparse(self.path).path)
        if not decoded_path.startswith('/uk-aq'):
            return False

        target = self.translate_path(self.path)
        if not target.lower().endswith('.html') or not os.path.isfile(target):
            return False

        try:
            with open(target, 'rb') as f:
                source = f.read()
            html = source.decode('utf-8')
        except (OSError, UnicodeDecodeError):
            return False

        if TURNSTILE_PLACEHOLDER not in html:
            return False

        rendered = html.replace(TURNSTILE_PLACEHOLDER, TURNSTILE_SITE_KEY).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(rendered)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(rendered)
        return True

    def _proxy_request(self, upstream_base, upstream_path, extra_headers=None):
        upstream_url = upstream_base.rstrip('/') + upstream_path
        req_headers = {
            k: v for k, v in self.headers.items()
            if k.lower() not in _HOP_BY_HOP
        }
        req_headers['Host'] = urlparse(upstream_base).netloc
        if extra_headers:
            req_headers.update(extra_headers)

        body = None
        content_length = int(self.headers.get('Content-Length', 0))
        if content_length:
            body = self.rfile.read(content_length)

        req = urllib.request.Request(upstream_url, data=body,
                                     headers=req_headers, method=self.command)
        try:
            with urllib.request.urlopen(req) as resp:
                print(f'  [proxy] {self.command} {self.path} → {resp.status}')
                self.send_response(resp.status)
                for key, val in resp.headers.items():
                    if key.lower() not in _HOP_BY_HOP:
                        self.send_header(key, val)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                if self.command != 'HEAD' and resp.status not in (204, 304):
                    payload = resp.read()
                    try:
                        self.wfile.write(payload)
                    except (BrokenPipeError, ConnectionResetError):
                        print(f'  [proxy] {self.command} {self.path} → client disconnected during response write')
        except urllib.error.HTTPError as e:
            body = b'' if self.command == 'HEAD' else e.read()
            is_not_modified = (e.code == 304)
            if is_not_modified:
                print(f'  [proxy] {self.command} {self.path} → {e.code}')
            else:
                print(f'  [proxy] {self.command} {self.path} → {e.code} upstream error')
                print(f'  [proxy] response: {body[:300]}')
            self.send_response(e.code)
            for key, val in e.headers.items():
                if key.lower() not in _HOP_BY_HOP:
                    self.send_header(key, val)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            if self.command != 'HEAD' and e.code not in (204, 304) and body:
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    print(f'  [proxy] {self.command} {self.path} → client disconnected during error response write')
        except urllib.error.URLError as e:
            print(f'  [proxy] {self.command} {self.path} → connection failed: {e.reason}')
            self.send_error(502, f'API proxy error: {e.reason}')

    def _proxy_api(self):
        """Forward /api/aq/... to the production Cloudflare Worker and relay the response."""
        extra_headers = {}
        if CF_CLIENT_ID and CF_CLIENT_SECRET:
            extra_headers['CF-Access-Client-Id'] = CF_CLIENT_ID
            extra_headers['CF-Access-Client-Secret'] = CF_CLIENT_SECRET
        # Trusted server-side header for local-dev bypass in the test worker.
        if AQ_CACHE_BYPASS_SECRET:
            extra_headers['X-CIC-Local-Dev-Token'] = AQ_CACHE_BYPASS_SECRET
        self._proxy_request(API_PROXY_TARGET, self.path, extra_headers)

    def _proxy_postcode_api(self):
        """Forward /api/postcode_* to the postcode lookup worker route."""
        parsed = urlparse(self.path)
        route = unquote(parsed.path)
        upstream_route = POSTCODE_PROXY_ROUTES.get(route)
        if not upstream_route:
            self.send_error(404)
            return
        upstream_path = upstream_route
        if parsed.query:
            upstream_path = f'{upstream_path}?{parsed.query}'
        extra_headers = {}
        if EDGE_UPSTREAM_SECRET:
            extra_headers['x-uk-aq-upstream-auth'] = EDGE_UPSTREAM_SECRET
        self._proxy_request(POSTCODE_UPSTREAM_URL, upstream_path, extra_headers)

    def _is_postcode_proxy_route(self):
        decoded_path = unquote(urlparse(self.path).path)
        return decoded_path in POSTCODE_PROXY_ROUTES

    # ── Config API ────────────────────────────────────────────────────────────

    def _serve_api_config(self):
        """Return JSON config for the Station Snapshot page, populated from .env."""
        import json
        config = {
            'edge_url': _env.get('EDGE_URL', ''),
            'default_station_id': _env.get('CLEANAIRSURB_ST_ID', ''),
            'default_station_ref': _env.get('CLEANAIRSURB_ST_REF', ''),
            'default_obs_limit': _env.get('STATION_SNAPSHOT_OBS_LIMIT', 'all'),
            'snapshot_mode': 'api' if STATION_SNAPSHOT_MODE != 'sql' else 'sql',
        }
        body = json.dumps(config).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def _is_snapshot_route(self):
        return unquote(urlparse(self.path).path) == '/api/snapshot'

    def _normalize_snapshot_window(self, value):
        normalized = (value or '').strip().lower()
        if normalized in ('6h', '24h', '7d', '21d', '31d', '90d'):
            return normalized
        return '24h'

    def _window_bounds_utc(self, window):
        now_utc = datetime.datetime.now(datetime.timezone.utc)
        if window == '6h':
            delta = datetime.timedelta(hours=6)
        elif window == '7d':
            delta = datetime.timedelta(days=7)
        elif window == '21d':
            delta = datetime.timedelta(days=21)
        elif window == '31d':
            delta = datetime.timedelta(days=31)
        elif window == '90d':
            delta = datetime.timedelta(days=90)
        else:
            delta = datetime.timedelta(hours=24)
        start = now_utc - delta
        return (
            start.isoformat().replace('+00:00', 'Z'),
            now_utc.isoformat().replace('+00:00', 'Z'),
        )

    def _parse_obs_limit(self, value):
        raw = (value or '').strip().lower()
        if not raw or raw == 'all':
            return None
        try:
            parsed = int(raw)
        except ValueError:
            return None
        if parsed <= 0:
            return None
        return parsed

    def _outbound_headers(self, url, headers):
        out = dict(headers or {})
        host = urlparse(url).netloc.lower()
        needs_cloudflare_user_agent = (
            host.endswith('workers.dev')
            or host.endswith('chronicillnesschannel.co.uk')
        )
        if needs_cloudflare_user_agent and not any(k.lower() == 'user-agent' for k in out):
            out['User-Agent'] = LOCAL_DEV_USER_AGENT
        return out

    def _fetch_json(self, url, headers, timeout=45):
        request = urllib.request.Request(url, method='GET', headers=self._outbound_headers(url, headers))
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode('utf-8')
            return json.loads(body) if body else None

    def _post_json(self, url, headers, payload, timeout=45):
        request = urllib.request.Request(
            url,
            method='POST',
            headers=self._outbound_headers(url, headers),
            data=json.dumps(payload).encode('utf-8'),
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode('utf-8')
            return json.loads(body) if body else None

    def _augment_obs_aqidb_via_api(self, result, window_start_iso, window_end_iso, effective_limit):
        if not OBSAQIDB_SUPABASE_URL or not OBSAQIDB_SERVICE_KEY:
            result.setdefault('meta', {})['obs_aqidb_source'] = 'unavailable'
            return

        headers = {
            'apikey': OBSAQIDB_SERVICE_KEY,
            'Authorization': f'Bearer {OBSAQIDB_SERVICE_KEY}',
            'Accept': 'application/json',
            'Accept-Profile': 'uk_aq_public',
            'Content-Profile': 'uk_aq_public',
            'Content-Type': 'application/json',
        }
        rest_base = OBSAQIDB_SUPABASE_URL.rstrip('/') + '/rest/v1'
        timeseries_rows = result.get('timeseries') if isinstance(result.get('timeseries'), list) else []
        selected_ts = result.get('selected_timeseries_id')
        try:
            selected_ts_int = int(selected_ts) if selected_ts is not None else None
        except (TypeError, ValueError):
            selected_ts_int = None

        all_rows = []
        for row in timeseries_rows:
            if not isinstance(row, dict):
                continue
            try:
                connector_id = int(row.get('connector_id'))
                ts_id = int(row.get('id'))
            except (TypeError, ValueError):
                continue

            payload = {
                'p_connector_id': connector_id,
                'p_timeseries_id': ts_id,
                'p_start_utc': window_start_iso,
                'p_end_utc': window_end_iso,
                'p_since_ts': None,
                'p_limit': effective_limit,
            }
            try:
                points = self._post_json(
                    rest_base + '/rpc/uk_aq_rpc_observs_timeseries_window',
                    headers,
                    payload,
                )
            except Exception:
                continue
            if not isinstance(points, list):
                continue
            for point in points:
                if not isinstance(point, dict):
                    continue
                all_rows.append({
                    'connector_id': connector_id,
                    'timeseries_id': ts_id,
                    'observed_at': point.get('observed_at'),
                    'value': point.get('value'),
                })

        all_rows.sort(key=lambda row: str(row.get('observed_at') or ''), reverse=True)
        if len(all_rows) > effective_limit:
            all_rows = all_rows[:effective_limit]
        result['obs_aqidb_observations_all'] = all_rows

        if selected_ts_int is not None:
            selected_rows = [row for row in all_rows if row.get('timeseries_id') == selected_ts_int]
            if len(selected_rows) > effective_limit:
                selected_rows = selected_rows[:effective_limit]
            result['obs_aqidb_observations'] = selected_rows

        if selected_ts_int is not None:
            try:
                q_hourly = urlencode([
                    ('timeseries_id', f'eq.{selected_ts_int}'),
                    ('order', 'timestamp_hour_utc.desc'),
                    ('limit', str(effective_limit)),
                    ('select', '*'),
                ])
                result['obs_aqidb_timeseries_aqi_hourly'] = self._fetch_json(
                    rest_base + '/uk_aq_timeseries_aqi_hourly?' + q_hourly,
                    headers,
                ) or []
            except Exception:
                result['obs_aqidb_timeseries_aqi_hourly'] = []

            try:
                q_daily = urlencode([
                    ('timeseries_id', f'eq.{selected_ts_int}'),
                    ('order', 'observed_day.desc'),
                    ('limit', str(effective_limit)),
                    ('select', '*'),
                ])
                result['obs_aqidb_timeseries_aqi_daily'] = self._fetch_json(
                    rest_base + '/uk_aq_timeseries_aqi_daily?' + q_daily,
                    headers,
                ) or []
            except Exception:
                result['obs_aqidb_timeseries_aqi_daily'] = []

        result.setdefault('meta', {})['obs_aqidb_source'] = 'service_role_postgrest'

    def _serve_api_snapshot_via_postgrest(self, station_id, station_ref, timeseries_id, window, obs_limit):
        if not INGESTDB_SUPABASE_URL or not INGESTDB_SERVICE_KEY:
            raise RuntimeError('API mode requires SUPABASE_URL and SB_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY')

        headers = {
            'apikey': INGESTDB_SERVICE_KEY,
            'Authorization': f'Bearer {INGESTDB_SERVICE_KEY}',
            'Accept': 'application/json',
            'Accept-Profile': 'uk_aq_public',
            'Content-Profile': 'uk_aq_public',
            'Content-Type': 'application/json',
        }
        rest_base = INGESTDB_SUPABASE_URL.rstrip('/') + '/rest/v1'
        obs_limit_int = self._parse_obs_limit(obs_limit)
        # API-backed snapshot RPC currently supports 100 or 1000 rows.
        rpc_obs_limit = 1000 if (obs_limit_int is None or obs_limit_int >= 1000) else 100
        rpc_payload = {
            'p_station_id': int(station_id) if station_id else None,
            'p_station_ref': station_ref or None,
            'p_timeseries_id': int(timeseries_id) if timeseries_id else None,
            'p_window': window,
            'p_obs_limit': rpc_obs_limit,
        }

        snapshot = self._post_json(rest_base + '/rpc/uk_aq_station_snapshot', headers, rpc_payload)
        if not isinstance(snapshot, dict):
            raise RuntimeError('Unexpected snapshot response shape from ingest API')

        result = {
            'meta': snapshot.get('meta') if isinstance(snapshot.get('meta'), dict) else {},
            'station': snapshot.get('station') or {},
            'timeseries': snapshot.get('timeseries') if isinstance(snapshot.get('timeseries'), list) else [],
            'stations_checkpoints': snapshot.get('stations_checkpoints') if isinstance(snapshot.get('stations_checkpoints'), list) else [],
            'timeseries_checkpoints': snapshot.get('timeseries_checkpoints') if isinstance(snapshot.get('timeseries_checkpoints'), list) else [],
            'observations': snapshot.get('observations') if isinstance(snapshot.get('observations'), list) else [],
            'observations_all': [],
            'obs_aqidb_observations': [],
            'obs_aqidb_observations_all': [],
            'obs_aqidb_timeseries_aqi_hourly': [],
            'obs_aqidb_timeseries_aqi_daily': [],
            'selected_timeseries_id': snapshot.get('selected_timeseries_id'),
        }

        if station_id:
            result['meta']['station_id'] = station_id
        if station_ref:
            result['meta']['station_ref'] = station_ref
        result['meta']['timeseries_id'] = timeseries_id or result.get('selected_timeseries_id')
        result['meta']['window'] = window
        result['meta']['obs_limit'] = obs_limit or 'all'
        result['meta']['generated_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')
        result['meta']['snapshot_mode'] = 'api'
        result['meta']['ingest_source'] = 'service_role_postgrest_rpc'

        window_start_iso = str(result['meta'].get('window_start') or '')
        window_end_iso = str(result['meta'].get('window_end') or '')
        if not window_start_iso or not window_end_iso:
            window_start_iso, window_end_iso = self._window_bounds_utc(window)
            result['meta']['window_start'] = window_start_iso
            result['meta']['window_end'] = window_end_iso

        effective_limit = obs_limit_int if obs_limit_int is not None else STATION_SNAPSHOT_MAX_ROWS
        self._augment_obs_aqidb_via_api(result, window_start_iso, window_end_iso, effective_limit)
        return result

    def _serve_api_snapshot(self):
        """Query both databases directly and return station snapshot JSON."""
        parsed = urlparse(self.path)
        params = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        station_id = params.get('station_id', '').strip()
        station_ref = params.get('station_ref', '').strip()
        timeseries_id = params.get('timeseries_id', '').strip()
        window = self._normalize_snapshot_window(params.get('window', '24h'))
        obs_limit = params.get('obs_limit', 'all').strip()

        if not station_id and not station_ref:
            self.send_error(400, 'station_id or station_ref is required')
            return

        if STATION_SNAPSHOT_MODE != 'sql':
            try:
                result = self._serve_api_snapshot_via_postgrest(
                    station_id=station_id,
                    station_ref=station_ref,
                    timeseries_id=timeseries_id,
                    window=window,
                    obs_limit=obs_limit,
                )
                body = json.dumps(result, default=str).encode('utf-8')
                self._json_response(body)
                return
            except Exception as exc:
                print(f'  [snapshot] API mode failed, falling back to SQL mode: {exc}')

        result = {
            'meta': {
                'station_id': station_id,
                'station_ref': station_ref,
                'timeseries_id': timeseries_id,
                'window': window,
                'obs_limit': obs_limit,
                'generated_at': datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z'),
            },
            'station': {},
            'timeseries': [],
            'stations_checkpoints': [],
            'timeseries_checkpoints': [],
            'observations': [],
            'observations_all': [],
            'obs_aqidb_observations': [],
            'obs_aqidb_observations_all': [],
            'obs_aqidb_timeseries_aqi_hourly': [],
            'obs_aqidb_timeseries_aqi_daily': [],
            'selected_timeseries_id': timeseries_id if timeseries_id else None,
        }

        if not INGESTDB_DB_URL or not OBSAQIDB_DB_URL:
            result['meta']['error'] = (
                'Database not configured. Set SUPABASE_DB_URL and '
                'OBS_AQIDB_SUPABASE_DB_URL in .env'
            )
            body = json.dumps(result).encode('utf-8')
            self._json_response(body)
            return

        try:
            import psycopg2
            import psycopg2.extras

            ingest_conn = psycopg2.connect(INGESTDB_DB_URL)
            obsaqi_conn = psycopg2.connect(OBSAQIDB_DB_URL)

            try:
                with ingest_conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                    # Build WHERE clause for station lookup
                    station_where = []
                    station_args = []
                    if station_id:
                        station_where.append('s.id = %s')
                        station_args.append(int(station_id))
                    if station_ref:
                        station_where.append('s.station_ref = %s')
                        station_args.append(station_ref)
                    station_clause = ' AND '.join(station_where) or 'TRUE'

                    # Station
                    cur.execute(f'SELECT * FROM uk_aq_core.stations s WHERE {station_clause} LIMIT 1', station_args)
                    row = cur.fetchone()
                    if row:
                        result['station'] = dict(row)
                        # If we found station by ref but no station_id was given, use the id
                        if not station_id and 'id' in row:
                            station_id = str(row['id'])

                    # Timeseries for this station
                    if station_id:
                        cur.execute(
                            'SELECT * FROM uk_aq_core.timeseries WHERE station_id = %s ORDER BY id',
                            (int(station_id),)
                        )
                        result['timeseries'] = [dict(r) for r in cur.fetchall()]

                    # Station checkpoints
                    if station_id:
                        cur.execute(
                            'SELECT * FROM uk_aq_raw.openaq_station_checkpoints WHERE station_id = %s ORDER BY last_observed_at DESC',
                            (int(station_id),)
                        )
                        result['stations_checkpoints'] = [dict(r) for r in cur.fetchall()]

                    # Timeseries checkpoints
                    if station_id:
                        cur.execute(
                            'SELECT * FROM uk_aq_raw.openaq_timeseries_checkpoints WHERE station_id = %s ORDER BY last_observed_at DESC',
                            (int(station_id),)
                        )
                        result['timeseries_checkpoints'] = [dict(r) for r in cur.fetchall()]

                    # Resolve timeseries_id if not given
                    ts_ids = [str(t['id']) for t in result['timeseries'] if 'id' in t]
                    selected_ts_id = timeseries_id if timeseries_id else (ts_ids[0] if ts_ids else None)
                    if selected_ts_id:
                        result['selected_timeseries_id'] = selected_ts_id

                    # Build ts_id list for observation queries
                    ts_id_list = [int(t['id']) for t in result['timeseries'] if 'id' in t]

                    # Observations (ingestdb) - selected timeseries
                    if selected_ts_id:
                        limit_clause = ''
                        if obs_limit not in ('', 'all'):
                            limit_clause = f'LIMIT {int(obs_limit)}'
                        cur.execute(
                            f'SELECT * FROM uk_aq_core.observations '
                            f'WHERE timeseries_id = %s '
                            f'ORDER BY observed_at DESC {limit_clause}',
                            (int(selected_ts_id),)
                        )
                        result['observations'] = [dict(r) for r in cur.fetchall()]

                    # Observations (ingestdb) - all station timeseries
                    if ts_id_list:
                        limit_clause = ''
                        if obs_limit not in ('', 'all'):
                            limit_clause = f'LIMIT {int(obs_limit)}'
                        placeholders = ','.join(['%s'] * len(ts_id_list))
                        cur.execute(
                            f'SELECT * FROM uk_aq_core.observations '
                            f'WHERE timeseries_id IN ({placeholders}) '
                            f'ORDER BY observed_at DESC {limit_clause}',
                            ts_id_list
                        )
                        result['observations_all'] = [dict(r) for r in cur.fetchall()]

                with obsaqi_conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                    # ObsAQIDB observations - selected timeseries
                    if selected_ts_id:
                        limit_clause = ''
                        if obs_limit not in ('', 'all'):
                            limit_clause = f'LIMIT {int(obs_limit)}'
                        try:
                            cur.execute(
                                f'SELECT * FROM uk_aq_observs.observations '
                                f'WHERE timeseries_id = %s '
                                f'ORDER BY observed_at DESC {limit_clause}',
                                (int(selected_ts_id),)
                            )
                            result['obs_aqidb_observations'] = [dict(r) for r in cur.fetchall()]
                        except Exception:
                            pass

                    # ObsAQIDB observations - all station timeseries
                    if ts_id_list:
                        limit_clause = ''
                        if obs_limit not in ('', 'all'):
                            limit_clause = f'LIMIT {int(obs_limit)}'
                        placeholders = ','.join(['%s'] * len(ts_id_list))
                        try:
                            cur.execute(
                                f'SELECT * FROM uk_aq_observs.observations '
                                f'WHERE timeseries_id IN ({placeholders}) '
                                f'ORDER BY observed_at DESC {limit_clause}',
                                ts_id_list
                            )
                            result['obs_aqidb_observations_all'] = [dict(r) for r in cur.fetchall()]
                        except Exception:
                            pass

                    # AQI hourly
                    if selected_ts_id:
                        limit_clause = ''
                        if obs_limit not in ('', 'all'):
                            limit_clause = f'LIMIT {int(obs_limit)}'
                        try:
                            cur.execute(
                                f'SELECT * FROM uk_aq_aqilevels.timeseries_aqi_hourly '
                                f'WHERE timeseries_id = %s '
                                f'ORDER BY timestamp_hour_utc DESC {limit_clause}',
                                (int(selected_ts_id),)
                            )
                            result['obs_aqidb_timeseries_aqi_hourly'] = [dict(r) for r in cur.fetchall()]
                        except Exception:
                            pass

                    # AQI daily
                    if selected_ts_id:
                        limit_clause = ''
                        if obs_limit not in ('', 'all'):
                            limit_clause = f'LIMIT {int(obs_limit)}'
                        try:
                            cur.execute(
                                f'SELECT * FROM uk_aq_aqilevels.timeseries_aqi_daily '
                                f'WHERE timeseries_id = %s '
                                f'ORDER BY observed_day DESC {limit_clause}',
                                (int(selected_ts_id),)
                            )
                            result['obs_aqidb_timeseries_aqi_daily'] = [dict(r) for r in cur.fetchall()]
                        except Exception:
                            pass

            finally:
                ingest_conn.close()
                obsaqi_conn.close()

        except ImportError:
            result['meta']['error'] = 'psycopg2 not installed. Run: pip install psycopg2-binary'
        except Exception as exc:
            result['meta']['error'] = str(exc)

        body = json.dumps(result, default=str).encode('utf-8')
        self._json_response(body)

    def _is_station_snapshot_v2_route(self):
        path = unquote(urlparse(self.path).path)
        return path.startswith('/api/station-snapshot-v2/')

    def _normalize_v2_pollutant(self, value):
        raw = (value or '').strip().lower().replace('.', '').replace('_', '')
        aliases = {'pm25': 'pm25', 'pm10': 'pm10', 'no2': 'no2', 'nitrogendioxide': 'no2'}
        return aliases.get(raw)

    def _normalize_v2_range(self, value):
        raw = (value or '24h').strip().lower()
        aliases = {'24h': '24h', '24hr': '24h', '24hrs': '24h', '24 hours': '24h', '7d': '7d', '7 days': '7d', '31d': '31d', '31 days': '31d', '90d': '90d', '90 days': '90d'}
        return aliases.get(raw, '24h')

    def _v2_bounds_from_params(self, window, params):
        start_raw = params.get('start_utc') or params.get('from_utc') or params.get('start') or params.get('from')
        end_raw = params.get('end_utc') or params.get('to_utc') or params.get('end') or params.get('to')
        if start_raw and end_raw:
            start_dt = self._parse_utc_datetime(start_raw)
            end_dt = self._parse_utc_datetime(end_raw)
            if start_dt and end_dt and end_dt > start_dt:
                return (
                    start_dt.isoformat().replace('+00:00', 'Z'),
                    end_dt.isoformat().replace('+00:00', 'Z'),
                )
        return self._window_bounds_utc(window)

    def _v2_headers(self, service_key):
        return {'apikey': service_key, 'Authorization': f'Bearer {service_key}', 'Accept': 'application/json', 'Accept-Profile': 'uk_aq_public', 'Content-Profile': 'uk_aq_public', 'Content-Type': 'application/json'}

    def _connector_label(self, connector_id):
        try:
            return 'GOV.UK AURN' if int(connector_id) == 1 else f'Connector {connector_id}'
        except (TypeError, ValueError):
            return ''

    def _hour_key(self, value):
        if not value:
            return None
        text = str(value).replace('+00:00', 'Z')
        return text[:13] + ':00:00Z' if len(text) >= 13 else text

    def _aqi_colour(self, scheme, level):
        if level is None:
            return None
        daqi = {1: '#1DB100', 2: '#61D836', 3: '#34FF00', 4: '#FFFB00', 5: '#FFCE04', 6: '#FF9300', 7: '#FF6464', 8: '#FF2600', 9: '#A50026', 10: '#672C7F'}
        eaqi = {'good': '#34FF00', 'fair': '#FFFB00', 'moderate': '#FF9300', 'poor': '#FF2600', 'very poor': '#A50026', 'extremely poor': '#672C7F', 1: '#34FF00', 2: '#FFFB00', 3: '#FF9300', 4: '#FF2600', 5: '#A50026', 6: '#672C7F'}
        if scheme == 'eaqi' and isinstance(level, str):
            labelled = eaqi.get(level.strip().lower())
            if labelled:
                return labelled
        try:
            n = int(level)
        except (TypeError, ValueError):
            return None
        return (eaqi if scheme == 'eaqi' else daqi).get(n)



    def _v2_pollutant_label(self, pollutant):
        return {'pm25': 'PM2.5', 'pm10': 'PM10', 'no2': 'NO2'}.get(pollutant, pollutant or '')

    def _parse_utc_datetime(self, value):
        if not value:
            return None
        text = str(value).strip()
        if not text:
            return None
        if text.endswith('Z'):
            text = text[:-1] + '+00:00'
        try:
            parsed = datetime.datetime.fromisoformat(text)
        except ValueError:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=datetime.timezone.utc)
        return parsed.astimezone(datetime.timezone.utc)

    def _v2_config_status(self):
        return {
            'cloudflare_access_client_id_present': bool(CF_CLIENT_ID),
            'cloudflare_access_client_secret_present': bool(CF_CLIENT_SECRET),
            'edge_upstream_secret_present': bool(EDGE_UPSTREAM_SECRET),
            'cache_bypass_secret_present': bool(AQ_CACHE_BYPASS_SECRET),
            'observs_history_r2_api_url_present': bool(UK_AQ_OBSERVS_HISTORY_R2_API_URL),
            'observs_history_r2_api_token_present': bool(UK_AQ_OBSERVS_HISTORY_R2_API_TOKEN),
            'aqi_history_r2_api_url_present': bool(UK_AQ_AQI_HISTORY_R2_API_URL),
            'aqi_history_r2_api_token_present': bool(UK_AQ_AQI_HISTORY_R2_API_TOKEN),
        }

    def _v2_auth_attempted(self):
        return {
            'cloudflare_access_service_token': bool(CF_CLIENT_ID and CF_CLIENT_SECRET),
            'edge_upstream_secret': bool(EDGE_UPSTREAM_SECRET),
            'cache_bypass_secret': bool(AQ_CACHE_BYPASS_SECRET),
        }

    def _v2_chart_history_headers(self):
        headers = {'Accept': 'application/json'}
        if CF_CLIENT_ID and CF_CLIENT_SECRET:
            headers['CF-Access-Client-Id'] = CF_CLIENT_ID
            headers['CF-Access-Client-Secret'] = CF_CLIENT_SECRET
        if AQ_CACHE_BYPASS_SECRET:
            headers['X-CIC-Local-Dev-Token'] = AQ_CACHE_BYPASS_SECRET
        if EDGE_UPSTREAM_SECRET:
            headers['x-uk-aq-upstream-auth'] = EDGE_UPSTREAM_SECRET
        return headers

    def _v2_compact_field(self, row, columns, *names):
        if isinstance(row, dict):
            for name in names:
                if row.get(name) is not None:
                    return row.get(name)
            return None
        if isinstance(row, list):
            for name in names:
                if name in columns:
                    idx = columns.index(name)
                    if idx < len(row):
                        return row[idx]
        return None

    def _v2_rows_from_chart_history_payload(self, payload):
        if isinstance(payload, list):
            rows = payload
            columns = []
        elif isinstance(payload, dict):
            columns = payload.get('columns') if isinstance(payload.get('columns'), list) else []
            rows = next((payload.get(k) for k in ('rows', 'observations', 'data', 'points') if isinstance(payload.get(k), list)), [])
        else:
            return []
        out = []
        for row in rows:
            observed_at = self._v2_compact_field(row, columns, 'observed_at', 'timestamp_hour_utc', 'period_start_utc', 'time')
            value = self._v2_compact_field(row, columns, 'value', 'observed_value', 'observs_value', 'mean_value', 'hourly_mean_ugm3')
            if observed_at is None or value is None:
                continue
            out.append({'observed_at': observed_at, 'value': value, 'source': 'r2_chart_history'})
        return out

    def _v2_fetch_chart_history_rows(self, params):
        # This mirrors hex_map.html buildObservationSeriesRequestUrl(): /api/aq/timeseries
        # with timeseries_id, pollutant, start, end, and compact format.  That route
        # already performs the R2 key discovery used by the chart line.
        query_items = [
            ('timeseries_id', params.get('timeseries_id')),
            ('connector_id', params.get('connector_id')),
            ('pollutant', params.get('pollutant')),
            ('start', params.get('from_utc')),
            ('end', params.get('to_utc')),
            ('format', 'compact'),
            ('debug', '1'),
        ]
        query = urlencode([(k, v) for k, v in query_items if v is not None and v != ''])
        url = API_PROXY_TARGET.rstrip('/') + API_PROXY_PREFIX + '/timeseries?' + query
        debug = {
            'chart_history_route_used': API_PROXY_PREFIX + '/timeseries',
            'chart_history_params_equivalent': {
                'timeseries_id': params.get('timeseries_id'),
                'connector_id': params.get('connector_id'),
                'pollutant': params.get('pollutant'),
                'start': params.get('from_utc'),
                'end': params.get('to_utc'),
                'format': 'compact',
                'debug': '1',
            },
            'r2_candidate_keys_checked': [],
            'r2_candidate_key_count': 0,
            'r2_candidate_manifest_matches': [],
            'r2_candidate_manifest_match_count': 0,
            'r2_first_matching_key': None,
            'r2_first_matching_key_reason': None,
            'r2_object_rows_read': 0,
            'r2_rows_after_time_filter': 0,
            'chart_history_auth_attempted': self._v2_auth_attempted(),
        }
        try:
            payload = self._fetch_json(url, self._v2_chart_history_headers())
        except Exception as exc:
            debug['chart_history_error'] = str(exc)
            if '403' in str(exc) or 'Forbidden' in str(exc):
                debug['chart_history_auth_hint'] = 'Protected chart history route returned 403. Check Cloudflare Access service token and upstream secret env vars.'
            print(f'  [snapshot-v2] chart-history R2 fetch failed: {exc}')
            return [], debug
        if isinstance(payload, dict):
            meta = payload.get('meta') if isinstance(payload.get('meta'), dict) else payload
            coverage = meta.get('coverage') if isinstance(meta.get('coverage'), dict) else {}
            candidates = [coverage.get('manifest_key'), meta.get('manifest_key'), coverage.get('source_path'), meta.get('source_path'), coverage.get('history_prefix'), meta.get('history_prefix')]
            debug['r2_candidate_keys_checked'] = [c for c in candidates if c][:10]
            debug['r2_candidate_key_count'] = len([c for c in candidates if c])
            debug['r2_first_matching_key'] = next((c for c in candidates if c), None)
            debug['r2_first_matching_key_reason'] = 'chart-history timeseries_id lookup via /api/aq/timeseries' if debug['r2_first_matching_key'] else ('chart-history returned rows without key metadata' if self._v2_rows_from_chart_history_payload(payload) else None)
            debug['r2_object_rows_read'] = meta.get('row_count') or coverage.get('matched_rows') or 0
        rows = self._v2_rows_from_chart_history_payload(payload)
        debug['r2_rows_after_time_filter'] = len(rows)
        if rows and not debug['r2_first_matching_key_reason']:
            debug['r2_first_matching_key_reason'] = 'exact selected_timeseries_id match through chart history route'
        return rows, debug

    def _v2_fetch_r2_rows(self, base_url, token, params):
        if not base_url or not token:
            return []

        headers = {
            'Accept': 'application/json',
        }

        # Optional dedicated token for this endpoint, if one exists.
        if token:
            headers['Authorization'] = f'Bearer {token}'

        # Reuse the same local-dev/auth headers already used elsewhere by serve.py.
        # These are needed when the target endpoint is behind Cloudflare Access
        # or protected by the UK AQ upstream auth header.
        if CF_CLIENT_ID and CF_CLIENT_SECRET:
            headers['CF-Access-Client-Id'] = CF_CLIENT_ID
            headers['CF-Access-Client-Secret'] = CF_CLIENT_SECRET

        if AQ_CACHE_BYPASS_SECRET:
            headers['X-CIC-Local-Dev-Token'] = AQ_CACHE_BYPASS_SECRET

        if EDGE_UPSTREAM_SECRET:
            headers['x-uk-aq-upstream-auth'] = EDGE_UPSTREAM_SECRET

        url = base_url.rstrip('/') + '?' + urlencode([
            (k, v) for k, v in params.items()
            if v is not None and v != ''
        ])

        try:
            payload = self._fetch_json(url, headers)
        except Exception as exc:
            print(f'  [snapshot-v2] optional R2 API failed: {exc}')
            return []

        if isinstance(payload, list):
            return payload

        if isinstance(payload, dict):
            for key in ('rows', 'observations', 'data'):
                if isinstance(payload.get(key), list):
                    return payload[key]

        return []

    def _serve_station_snapshot_v2(self):
        parsed = urlparse(self.path)
        route = unquote(parsed.path).rstrip('/')
        if route.endswith('/search-stations'):
            self._serve_station_snapshot_v2_search(parsed); return
        if route.endswith('/rows'):
            self._serve_station_snapshot_v2_rows(parsed); return
        self.send_error(404)

    def _v2_station_row(self, row):
        return {'station_id': row.get('id') or row.get('station_id'), 'station_ref': row.get('station_ref'), 'station_name': row.get('station_name') or row.get('label'), 'connector_id': row.get('connector_id'), 'connector_label': self._connector_label(row.get('connector_id'))}

    def _v2_station_search_rows_with_last_values(self, station_rows, timeseries_rows, pollutant):
        latest_by_station = {}
        for row in timeseries_rows or []:
            if not self._v2_ts_matches(row, pollutant):
                continue
            station_id = row.get('station_id')
            station_key = str(station_id) if station_id is not None else ''
            if not station_key:
                continue
            last_value_at = row.get('last_value_at')
            current = latest_by_station.get(station_key)
            if current is None or str(last_value_at or '') > str(current.get('last_value_at') or ''):
                latest_by_station[station_key] = row
        stations = []
        for row in station_rows:
            station = self._v2_station_row(row)
            station_key = str(station.get('station_id')) if station.get('station_id') is not None else ''
            ts = latest_by_station.get(station_key)
            if not ts:
                continue
            station['last_value'] = ts.get('last_value')
            station['last_value_at'] = ts.get('last_value_at')
            station['selected_timeseries_id'] = ts.get('id') or ts.get('timeseries_id')
            station['selected_timeseries_ref'] = ts.get('timeseries_ref')
            station['selected_timeseries_connector_id'] = ts.get('connector_id')
            station['selected_timeseries_phenomenon_id'] = ts.get('phenomenon_id')
            station['selected_timeseries_label'] = ts.get('label')
            station['last_value_timeseries_id'] = station['selected_timeseries_id']
            stations.append(station)
        return stations

    def _serve_station_snapshot_v2_search(self, parsed):
        params = parse_qs(parsed.query)
        query = (params.get('q', [''])[0] or '').strip()
        pollutant = self._normalize_v2_pollutant(params.get('pollutant', [''])[0])
        result = {'query': query, 'pollutant': pollutant, 'stations': []}
        if not query:
            self._json_response(json.dumps(result).encode('utf-8')); return
        if not pollutant:
            result['error'] = 'pollutant (pm25, pm10, no2) is required'
            self._json_response(json.dumps(result).encode('utf-8')); return
        if STATION_SNAPSHOT_MODE != 'sql' and INGESTDB_SUPABASE_URL and INGESTDB_SERVICE_KEY:
            try:
                rest = INGESTDB_SUPABASE_URL.rstrip('/') + '/rest/v1'
                ors = ','.join([f'station_name.ilike.*{query}*', f'label.ilike.*{query}*', f'station_ref.ilike.*{query}*'])
                if query.isdigit(): ors += f',id.eq.{query}'
                qs = urlencode([('or', f'({ors})'), ('select', 'id,station_ref,station_name,label,connector_id'), ('limit', '25'), ('order', 'station_name.asc')])
                rows = self._fetch_json(rest + '/stations?' + qs, self._v2_headers(INGESTDB_SERVICE_KEY)) or []
                station_ids = [r.get('id') or r.get('station_id') for r in rows if r.get('id') or r.get('station_id')]
                timeseries = []
                if station_ids:
                    id_list = ','.join(str(int(sid)) for sid in station_ids)
                    q_ts = urlencode([('station_id', f'in.({id_list})'), ('select', '*'), ('order', 'last_value_at.desc.nullslast')])
                    timeseries = self._fetch_json(rest + '/timeseries?' + q_ts, self._v2_headers(INGESTDB_SERVICE_KEY)) or []
                result['stations'] = self._v2_station_search_rows_with_last_values(rows, timeseries, pollutant)
                self._json_response(json.dumps(result, default=str).encode('utf-8')); return
            except Exception as exc:
                print(f'  [snapshot-v2] search API mode failed, falling back to SQL mode: {exc}')
        if not INGESTDB_DB_URL:
            result['error'] = 'Database not configured. Set SUPABASE_URL + service key or SUPABASE_DB_URL in .env'
            self._json_response(json.dumps(result).encode('utf-8')); return
        try:
            import psycopg2, psycopg2.extras
            with psycopg2.connect(INGESTDB_DB_URL) as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                like = f'%{query}%'
                cur.execute("SELECT id, station_ref, station_name, label, connector_id FROM uk_aq_core.stations WHERE station_name ILIKE %s OR COALESCE(label, '') ILIKE %s OR station_ref ILIKE %s OR (%s ~ '^[0-9]+$' AND id = %s::int) ORDER BY station_name LIMIT 25", (like, like, like, query, query if query.isdigit() else '0'))
                station_rows = [dict(r) for r in cur.fetchall()]
                station_ids = [r.get('id') or r.get('station_id') for r in station_rows if r.get('id') or r.get('station_id')]
                timeseries = []
                if station_ids:
                    cur.execute("SELECT * FROM uk_aq_core.timeseries WHERE station_id = ANY(%s) ORDER BY last_value_at DESC NULLS LAST", (station_ids,))
                    timeseries = [dict(r) for r in cur.fetchall()]
                result['stations'] = self._v2_station_search_rows_with_last_values(station_rows, timeseries, pollutant)
        except ImportError:
            result['error'] = 'psycopg2 not installed. Run: pip install psycopg2-binary'
        except Exception as exc:
            result['error'] = str(exc)
        self._json_response(json.dumps(result, default=str).encode('utf-8'))

    def _v2_ts_matches(self, row, pollutant):
        return self._v2_ts_pollutant_key(row) == pollutant

    def _v2_ts_pollutant_key(self, row):
        # Prefer structured pollutant metadata over label text. The AURN PM2.5
        # rows seen at Bristol Temple Way use phenomenon_id 2 and the Eionet
        # URI /pollutant/6001 with labels such as "Particulate matter less than
        # 2.5 micro m", so those exact rules are kept explicit here.
        structured_fields = (
            'pollutant', 'pollutant_code', 'pollutant_notation', 'notation',
            'phenomena_notation', 'phenomenon_notation', 'parameter',
            'parameter_code', 'pollutant_label', 'phenomena_label',
        )
        for key in structured_fields:
            match = self._v2_pollutant_from_text(row.get(key))
            if match:
                return match
        try:
            phenomenon_id = int(row.get('phenomenon_id'))
        except (TypeError, ValueError):
            phenomenon_id = None
        phenomenon_map = {2: 'pm25'}
        if phenomenon_id in phenomenon_map:
            return phenomenon_map[phenomenon_id]
        for key in ('extras', 'rendering_hints', 'phenomenon'):
            value = row.get(key)
            if isinstance(value, dict):
                match = self._v2_pollutant_from_text(json.dumps(value, sort_keys=True))
                if match:
                    return match
        for key in ('label', 'measurement_type', 'uom', 'unit', 'unit_symbol'):
            match = self._v2_pollutant_from_text(row.get(key))
            if match:
                return match
        return None

    def _v2_pollutant_from_text(self, value):
        if value is None:
            return None
        text = str(value).lower().replace('₂', '2').replace('₅', '5').replace('₁', '1').replace('₀', '0')
        compact = ''.join(ch for ch in text if ch.isalnum())
        if 'ddeioneteuropaeuvocabularyaqpollutant6001' in compact or 'pollutant6001' in compact:
            return 'pm25'
        if 'particulatematterlessthan25' in compact or any(alias in compact for alias in ('pm25', 'pm2p5')):
            return 'pm25'
        if 'particulatematterlessthan10' in compact or any(alias in compact for alias in ('pm10', 'particulatematter10')):
            return 'pm10'
        if any(alias in compact for alias in ('no2', 'nitrogendioxide')):
            return 'no2'
        return None

    def _serve_station_snapshot_v2_rows(self, parsed):
        params = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        station_id = (params.get('station_id') or '').strip(); pollutant = self._normalize_v2_pollutant(params.get('pollutant'))
        window = self._normalize_v2_range(params.get('range')); requested_ts = (params.get('timeseries_id') or '').strip()
        result = {'station_id': int(station_id) if station_id.isdigit() else station_id, 'pollutant': pollutant, 'range': window, 'timeseries': [], 'selected_timeseries_id': None, 'overlap_detected': False, 'rows': [], 'debug': {'config': self._v2_config_status()}}
        if not station_id or not pollutant:
            result['error'] = 'station_id and pollutant (pm25, pm10, no2) are required'; self._json_response(json.dumps(result).encode('utf-8')); return
        start, end = self._v2_bounds_from_params(window, params)
        try:
            if STATION_SNAPSHOT_MODE != 'sql' and INGESTDB_SUPABASE_URL and INGESTDB_SERVICE_KEY:
                self._v2_rows_via_postgrest(result, station_id, pollutant, window, requested_ts, start, end)
            elif INGESTDB_DB_URL:
                self._v2_rows_via_sql(result, station_id, pollutant, window, requested_ts, start, end)
            else:
                result['error'] = 'Database not configured. Set SUPABASE_URL + service key or SUPABASE_DB_URL in .env'
        except Exception as exc:
            print(f'  [snapshot-v2] rows API mode failed, falling back to SQL mode: {exc}')
            if INGESTDB_DB_URL:
                try: self._v2_rows_via_sql(result, station_id, pollutant, window, requested_ts, start, end)
                except Exception as sql_exc: result['error'] = str(sql_exc)
            else: result['error'] = str(exc)
        self._json_response(json.dumps(result, default=str).encode('utf-8'))

    def _v2_select_timeseries(self, result, timeseries, requested_ts):
        result['timeseries'] = [{'timeseries_id': r.get('id') or r.get('timeseries_id'), 'timeseries_ref': r.get('timeseries_ref'), 'connector_id': r.get('connector_id'), 'station_id': r.get('station_id'), 'phenomenon_id': r.get('phenomenon_id'), 'label': r.get('label') or r.get('pollutant_label') or r.get('notation'), 'uom': r.get('uom') or r.get('unit') or r.get('unit_symbol'), 'station_ref': r.get('station_ref'), 'service_ref': r.get('service_ref'), 'last_value': r.get('last_value'), 'last_value_at': r.get('last_value_at')} for r in timeseries]
        ids = [str(r['timeseries_id']) for r in result['timeseries'] if r.get('timeseries_id') is not None]
        if requested_ts and requested_ts not in ids:
            result['message'] = 'Requested timeseries is not valid for the selected pollutant; using the best selected-pollutant timeseries.' if ids else 'No selected pollutant timeseries is available for this station.'
        result['selected_timeseries_id'] = int(requested_ts) if requested_ts and requested_ts in ids else (int(ids[0]) if ids else None)
        result['selected_timeseries'] = next((r for r in result['timeseries'] if str(r.get('timeseries_id')) == str(result.get('selected_timeseries_id'))), None)
        debug = result.setdefault('debug', {})
        selected_meta = result.get('selected_timeseries') or {}
        debug.update({
            'station_id': result.get('station_id'),
            'pollutant': result.get('pollutant'),
            'requested_timeseries_id': requested_ts or None,
            'selected_timeseries_id': result.get('selected_timeseries_id'),
            'selected_timeseries_ref': selected_meta.get('timeseries_ref'),
            'selected_connector_id': selected_meta.get('connector_id'),
            'selected_station_ref': selected_meta.get('station_ref'),
            'selected_service_ref': selected_meta.get('service_ref'),
            'selected_phenomenon_id': selected_meta.get('phenomenon_id'),
        })
        if not ids:
            result['message'] = 'No selected pollutant timeseries is available for this station.'

    def _v2_rows_via_postgrest(self, result, station_id, pollutant, window, requested_ts, start, end):
        rest = INGESTDB_SUPABASE_URL.rstrip('/') + '/rest/v1'; headers = self._v2_headers(INGESTDB_SERVICE_KEY)
        qs = urlencode([('station_id', f'eq.{int(station_id)}'), ('select', '*'), ('order', 'id.asc')])
        station_meta = {}
        try:
            station_qs = urlencode([('id', f'eq.{int(station_id)}'), ('select', 'id,station_ref,connector_id'), ('limit', '1')])
            station_rows = self._fetch_json(rest + '/stations?' + station_qs, headers) or []
            station_meta = station_rows[0] if station_rows else {}
        except Exception:
            station_meta = {}
        all_ts = self._fetch_json(rest + '/timeseries?' + qs, headers) or []
        for row in all_ts:
            row.setdefault('station_ref', station_meta.get('station_ref'))
        self._v2_select_timeseries(result, [r for r in all_ts if self._v2_ts_matches(r, pollutant)], requested_ts)
        selected = result.get('selected_timeseries_id')
        if not selected: return
        limit = str(STATION_SNAPSHOT_MAX_ROWS)
        result.setdefault('debug', {}).update({'range_start_utc': start, 'range_end_utc': end})
        q_obs = urlencode([('timeseries_id', f'eq.{selected}'), ('observed_at', f'gte.{start}'), ('observed_at', f'lte.{end}'), ('order', 'observed_at.desc'), ('limit', limit), ('select', '*')])
        ingest_obs = self._fetch_json(rest + '/observations?' + q_obs, headers) or []
        obs_obs = []
        obs_aqi = []
        if OBSAQIDB_SUPABASE_URL and OBSAQIDB_SERVICE_KEY:
            obs_headers = self._v2_headers(OBSAQIDB_SERVICE_KEY)
            obs_rest = OBSAQIDB_SUPABASE_URL.rstrip('/') + '/rest/v1'
            selected_meta = result.get('selected_timeseries') or {}
            connector_id = selected_meta.get('connector_id')
            try:
                obs_obs = self._post_json(
                    obs_rest + '/rpc/uk_aq_rpc_observs_timeseries_window',
                    obs_headers,
                    {
                        'p_connector_id': int(connector_id),
                        'p_timeseries_id': int(selected),
                        'p_start_utc': start,
                        'p_end_utc': end,
                        'p_since_ts': None,
                        'p_limit': STATION_SNAPSHOT_MAX_ROWS,
                    },
                ) or []
            except Exception as exc:
                print(f'  [snapshot-v2] ObsAQIDB RPC fetch failed, falling back to direct observations fetch: {exc}')
                try: obs_obs = self._fetch_json(obs_rest + '/observations?' + q_obs, obs_headers) or []
                except Exception: obs_obs = []
            try:
                q_aqi = urlencode([('timeseries_id', f'eq.{selected}'), ('timestamp_hour_utc', f'gte.{start}'), ('timestamp_hour_utc', f'lte.{end}'), ('order', 'timestamp_hour_utc.desc'), ('limit', limit), ('select', '*')])
                obs_aqi = self._fetch_json(obs_rest + '/uk_aq_timeseries_aqi_hourly?' + q_aqi, obs_headers) or []
                for row in obs_aqi:
                    row.setdefault('source', 'obsaqidb')
            except Exception as exc:
                print(f'  [snapshot-v2] ObsAQIDB AQI/hourly fetch failed: {exc}')
                obs_aqi = []
        selected_meta = result.get('selected_timeseries') or {}
        r2_params = {'timeseries_id': selected, 'timeseries_ref': selected_meta.get('timeseries_ref'), 'station_id': station_id, 'station_ref': selected_meta.get('station_ref'), 'connector_id': selected_meta.get('connector_id'), 'service_ref': selected_meta.get('service_ref'), 'phenomenon_id': selected_meta.get('phenomenon_id'), 'pollutant': pollutant, 'from_utc': start, 'to_utc': end, 'start_utc': start, 'end_utc': end, 'row_limit': limit, 'debug': '1'}
        debug = result.setdefault('debug', {})
        debug.update({'r2_lookup_key_or_filter': r2_params, 'ingestdb_row_count': len(ingest_obs), 'obsaqidb_row_count': len(obs_obs)})
        if not UK_AQ_OBSERVS_HISTORY_R2_API_URL or not UK_AQ_OBSERVS_HISTORY_R2_API_TOKEN:
            debug['r2_observs_config_error'] = 'Observations R2 API URL/token not configured'
        if not UK_AQ_AQI_HISTORY_R2_API_URL or not UK_AQ_AQI_HISTORY_R2_API_TOKEN:
            debug['r2_aqi_config_error'] = 'AQI R2 API URL/token not configured'
        r2_obs, chart_debug = self._v2_fetch_chart_history_rows(r2_params)
        result.setdefault('debug', {}).update(chart_debug)
        if not r2_obs:
            r2_obs = self._v2_fetch_r2_rows(UK_AQ_OBSERVS_HISTORY_R2_API_URL, UK_AQ_OBSERVS_HISTORY_R2_API_TOKEN, r2_params)
        r2_aqi_params = dict(r2_params)
        r2_aqi_params['format'] = 'objects'
        r2_aqi = self._v2_fetch_r2_rows(UK_AQ_AQI_HISTORY_R2_API_URL, UK_AQ_AQI_HISTORY_R2_API_TOKEN, r2_aqi_params)
        for row in r2_aqi:
            row.setdefault('source', 'r2')
        result.setdefault('debug', {}).update({'r2_row_count': len(r2_obs), 'aqi_row_count': len(r2_aqi) + len(obs_aqi)})
        self._v2_merge_rows(result, ingest_obs, obs_obs, r2_obs, r2_aqi + obs_aqi)

    def _v2_rows_via_sql(self, result, station_id, pollutant, window, requested_ts, start, end):
        import psycopg2, psycopg2.extras
        result.setdefault('debug', {}).update({'range_start_utc': start, 'range_end_utc': end})
        with psycopg2.connect(INGESTDB_DB_URL) as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute('SELECT t.*, s.station_ref FROM uk_aq_core.timeseries t LEFT JOIN uk_aq_core.stations s ON s.id = t.station_id WHERE t.station_id = %s ORDER BY t.id', (int(station_id),)); all_ts = [dict(r) for r in cur.fetchall()]
            self._v2_select_timeseries(result, [r for r in all_ts if self._v2_ts_matches(r, pollutant)], requested_ts)
            selected = result.get('selected_timeseries_id')
            if not selected: return
            cur.execute('SELECT * FROM uk_aq_core.observations WHERE timeseries_id = %s AND observed_at >= %s AND observed_at <= %s ORDER BY observed_at DESC LIMIT %s', (selected, start, end, STATION_SNAPSHOT_MAX_ROWS)); ingest_obs = [dict(r) for r in cur.fetchall()]
        obs_obs, local_aqi = [], []
        if OBSAQIDB_DB_URL:
            with psycopg2.connect(OBSAQIDB_DB_URL) as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                for sql, target in [("SELECT * FROM uk_aq_observs.observations WHERE timeseries_id = %s AND observed_at >= %s AND observed_at <= %s ORDER BY observed_at DESC LIMIT %s", obs_obs), ("SELECT * FROM uk_aq_aqilevels.timeseries_aqi_hourly WHERE timeseries_id = %s AND timestamp_hour_utc >= %s AND timestamp_hour_utc <= %s ORDER BY timestamp_hour_utc DESC LIMIT %s", local_aqi)]:
                    try: cur.execute(sql, (selected, start, end, STATION_SNAPSHOT_MAX_ROWS)); target.extend(dict(r) for r in cur.fetchall())
                    except Exception: pass
        selected_meta = result.get('selected_timeseries') or {}
        r2_params = {'timeseries_id': selected, 'timeseries_ref': selected_meta.get('timeseries_ref'), 'station_id': station_id, 'station_ref': selected_meta.get('station_ref'), 'connector_id': selected_meta.get('connector_id'), 'service_ref': selected_meta.get('service_ref'), 'phenomenon_id': selected_meta.get('phenomenon_id'), 'pollutant': pollutant, 'from_utc': start, 'to_utc': end, 'start_utc': start, 'end_utc': end, 'row_limit': STATION_SNAPSHOT_MAX_ROWS, 'debug': '1'}
        debug = result.setdefault('debug', {})
        debug.update({'r2_lookup_key_or_filter': r2_params, 'ingestdb_row_count': len(ingest_obs), 'obsaqidb_row_count': len(obs_obs)})
        if not UK_AQ_OBSERVS_HISTORY_R2_API_URL or not UK_AQ_OBSERVS_HISTORY_R2_API_TOKEN:
            debug['r2_observs_config_error'] = 'Observations R2 API URL/token not configured'
        if not UK_AQ_AQI_HISTORY_R2_API_URL or not UK_AQ_AQI_HISTORY_R2_API_TOKEN:
            debug['r2_aqi_config_error'] = 'AQI R2 API URL/token not configured'
        r2_obs, chart_debug = self._v2_fetch_chart_history_rows(r2_params)
        result.setdefault('debug', {}).update(chart_debug)
        if not r2_obs:
            r2_obs = self._v2_fetch_r2_rows(UK_AQ_OBSERVS_HISTORY_R2_API_URL, UK_AQ_OBSERVS_HISTORY_R2_API_TOKEN, r2_params)
        r2_aqi_params = dict(r2_params)
        r2_aqi_params['format'] = 'objects'
        r2_aqi = self._v2_fetch_r2_rows(UK_AQ_AQI_HISTORY_R2_API_URL, UK_AQ_AQI_HISTORY_R2_API_TOKEN, r2_aqi_params)
        for row in r2_aqi:
            row.setdefault('source', 'r2')
        for row in local_aqi:
            row.setdefault('source', 'obsaqidb')
        result.setdefault('debug', {}).update({'r2_row_count': len(r2_obs), 'aqi_row_count': len(r2_aqi) + len(local_aqi)})
        self._v2_merge_rows(result, ingest_obs, obs_obs, r2_obs, r2_aqi + local_aqi)

    def _v2_merge_rows(self, result, ingest_obs, obs_obs, r2_obs, aqi_rows):
        merged = {}
        empty = lambda key: {'observed_at': key, 'ingestdb_observs_value': None, 'obsaqidb_observs_value': None, 'r2_observs_value': None, 'aqi_source': None, 'hourly_mean_ugm3': None, 'rolling24h_mean_ugm3': None, 'hourly_sample_count': None, 'daqi_index_level': None, 'daqi_colour': None, 'eaqi_index_level': None, 'eaqi_colour': None, 'has_ingestdb_observs_row': False, 'has_obsaqidb_observs_row': False, 'has_r2_observs_row': False, 'has_aqi_row': False}

        def pick(row, *keys):
            for key in keys:
                if key in row and row.get(key) is not None:
                    return row.get(key)
            for key in keys:
                if key in row:
                    return None
            return None

        for source, flag, rows in [('ingestdb_observs_value', 'has_ingestdb_observs_row', ingest_obs), ('obsaqidb_observs_value', 'has_obsaqidb_observs_row', obs_obs), ('r2_observs_value', 'has_r2_observs_row', r2_obs)]:
            for r in rows:
                key = self._hour_key(r.get('observed_at') or r.get('timestamp_hour_utc'))
                if not key:
                    continue
                row = merged.setdefault(key, empty(key))
                row[source] = pick(r, 'value', 'observed_value', 'observs_value', 'mean_value')
                row[flag] = True
        for r in aqi_rows:
            key = self._hour_key(r.get('timestamp_hour_utc') or r.get('observed_at'))
            if not key: continue
            row = merged.setdefault(key, empty(key))
            source = r.get('source') or 'obsaqidb'
            if row.get('has_aqi_row') and row.get('aqi_source') != source:
                result['overlap_detected'] = True
            if row.get('aqi_source') == 'r2' and source != 'r2':
                continue
            if row.get('has_aqi_row') and row.get('aqi_source') and row.get('aqi_source') != 'r2' and source != 'r2':
                continue
            row['has_aqi_row'] = True
            row['aqi_source'] = source
            row['hourly_mean_ugm3'] = pick(r, 'hourly_mean_ugm3', 'hourly_mean')
            row['rolling24h_mean_ugm3'] = pick(r, 'rolling24h_mean_ugm3', 'rolling_24h_mean_ugm3')
            row['hourly_sample_count'] = pick(r, 'hourly_sample_count', 'sample_count')
            row['daqi_index_level'] = pick(r, 'daqi_index_level')
            row['eaqi_index_level'] = pick(r, 'eaqi_index_level')
            daqi_colour = pick(r, 'daqi_colour', 'daqi_color', 'daqi_index_colour', 'daqi_index_color')
            eaqi_colour = pick(r, 'eaqi_colour', 'eaqi_color', 'eaqi_index_colour', 'eaqi_index_color')
            row['daqi_colour'] = daqi_colour if daqi_colour is not None else self._aqi_colour('daqi', row['daqi_index_level'])
            row['eaqi_colour'] = eaqi_colour if eaqi_colour is not None else self._aqi_colour('eaqi', row['eaqi_index_level'])
        result['rows'] = sorted(merged.values(), key=lambda r: r['observed_at'], reverse=True)[:STATION_SNAPSHOT_MAX_ROWS]
        result.setdefault('debug', {})['merged_row_count'] = len(result['rows'])
        self._v2_set_empty_rows_warning(result)

    def _v2_set_empty_rows_warning(self, result):
        selected_meta = result.get('selected_timeseries') or {}
        if result.get('rows'):
            return
        latest_at_raw = selected_meta.get('last_value_at')
        label = self._v2_pollutant_label(result.get('pollutant'))
        debug = result.setdefault('debug', {})
        debug['selected_timeseries_latest_at_utc'] = latest_at_raw
        if not latest_at_raw:
            result['warning'] = f'Selected {label} timeseries has no latest timestamp metadata.'
            return
        latest_at = self._parse_utc_datetime(latest_at_raw)
        start_at = self._parse_utc_datetime(debug.get('range_start_utc') or debug.get('range_start'))
        end_at = self._parse_utc_datetime(debug.get('range_end_utc') or debug.get('range_end'))
        in_range = bool(latest_at and start_at and end_at and start_at <= latest_at <= end_at)
        debug['selected_timeseries_latest_in_range'] = in_range
        config_warnings = []
        if debug.get('chart_history_auth_hint'):
            config_warnings.append(debug['chart_history_auth_hint'])
        if debug.get('r2_observs_config_error'):
            config_warnings.append(debug['r2_observs_config_error'])
        if debug.get('r2_aqi_config_error'):
            config_warnings.append(debug['r2_aqi_config_error'])
        if config_warnings:
            result['warning'] = ' '.join(config_warnings)
        elif not in_range:
            result['warning'] = f'Selected {label} timeseries latest metadata is outside this range. Try a longer range.'
        else:
            result['warning'] = f'Selected {label} timeseries has latest metadata inside this range, but no R2/ObsAQIDB/AQI rows were matched. Check identifier mapping.'

    def _json_response(self, body):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def do_GET(self):
        decoded_path = unquote(urlparse(self.path).path)
        if decoded_path == '/api/config':
            self._serve_api_config()
            return
        if self._is_postcode_proxy_route():
            self._proxy_postcode_api()
            return
        if self._is_station_snapshot_v2_route():
            self._serve_station_snapshot_v2()
            return
        if decoded_path.startswith(API_PROXY_PREFIX):
            self._proxy_api()
            return
        if self._is_snapshot_route():
            self._serve_api_snapshot()
            return
        if self._maybe_serve_uk_aq_html_with_turnstile():
            return
        super().do_GET()

    def do_HEAD(self):
        if self._is_postcode_proxy_route():
            self.send_error(405)
            return
        if unquote(urlparse(self.path).path).startswith(API_PROXY_PREFIX):
            self.send_error(405)
            return
        if self._maybe_serve_uk_aq_html_with_turnstile():
            return
        super().do_HEAD()

    def do_POST(self):
        if self._is_postcode_proxy_route():
            self._proxy_postcode_api()
            return
        if unquote(urlparse(self.path).path).startswith(API_PROXY_PREFIX):
            self._proxy_api()
        else:
            self.send_error(405)

    def do_OPTIONS(self):
        if self._is_station_snapshot_v2_route():
            self.send_response(204)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
            self.end_headers()
            return
        if self._is_postcode_proxy_route():
            self.send_response(204)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-uk-aq-upstream-auth')
            self.end_headers()
            return
        if unquote(urlparse(self.path).path).startswith(API_PROXY_PREFIX):
            self.send_response(204)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
            self.end_headers()
        else:
            self.send_error(405)

    # ── Static file serving ────────────────────────────────────────────────────

    def translate_path(self, path):
        # Decode percent-encoding (%20 → space etc.) and strip query/fragment
        clean = unquote(urlparse(path).path)

        # Match longest prefix first; handle '/' last so it doesn't swallow everything
        for prefix, root in sorted(ROOTS.items(), key=lambda x: -len(x[0])):
            if prefix == '/':
                # Root matches any remaining path
                relative = clean.lstrip('/')
            elif clean == prefix or clean.startswith(prefix + '/'):
                relative = clean[len(prefix):].lstrip('/')
            else:
                continue

            target = os.path.join(root, relative) if relative else root
            if os.path.isdir(target):
                target = os.path.join(target, 'index.html')
            return target

        # Fallback: serve from root repo
        return os.path.join(ROOTS['/'], clean.lstrip('/'))

    def log_message(self, fmt, *args):
        print(f'  {self.address_string()}  {fmt % args}')


if __name__ == '__main__':
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(('', PORT), MultiRootHandler) as httpd:
        print(f'\nCIC dev server → http://localhost:{PORT}/\n')
        print(f'  /                → CIC root site')
        print(f'  /uk-aq/          → UK-AQ repo')
        print(f'  /data-explorer/  → Data Explorer mk2')
        print(f'  /report/         → Report Form')
        print(f'  /station-snapshot/ → Station Snapshot')
        print(f'  /station-snapshot-v2/ → Station Snapshot v2')
        print(f'  /api/aq/...      → proxy → {API_PROXY_TARGET}')
        print(f'  /api/postcode_*  → proxy → {POSTCODE_UPSTREAM_URL}')
        print('  Station Snapshot v2 config:')
        print(f"    Cloudflare Access service token → {'loaded' if CF_CLIENT_ID and CF_CLIENT_SECRET else 'missing'}")
        print(f"    Edge upstream secret → {'loaded' if EDGE_UPSTREAM_SECRET else 'missing'}")
        print(f"    Cache bypass secret → {'loaded' if AQ_CACHE_BYPASS_SECRET else 'missing'}")
        print(f"    Observations R2 history API URL → {'loaded' if UK_AQ_OBSERVS_HISTORY_R2_API_URL else 'missing'}")
        print(f"    Observations R2 history API token → {'loaded' if UK_AQ_OBSERVS_HISTORY_R2_API_TOKEN else 'missing'}")
        print(f"    AQI R2 history API URL → {'loaded' if UK_AQ_AQI_HISTORY_R2_API_URL else 'missing'}")
        print(f"    AQI R2 history API token → {'loaded' if UK_AQ_AQI_HISTORY_R2_API_TOKEN else 'missing'}")
        print(f"  Turnstile key      → {'loaded' if TURNSTILE_SITE_KEY else 'NOT FOUND (add UK_AQ_TURNSTILE_SITE_KEY)'}")
        print(f'  Station snapshot   → mode={STATION_SNAPSHOT_MODE}')
        if INGESTDB_SUPABASE_URL and INGESTDB_SERVICE_KEY:
            print(f'  Snapshot ingest API → configured')
        else:
            print(f'  Snapshot ingest API → NOT set (add SUPABASE_URL + SB_SECRET_KEY)')
        if OBSAQIDB_SUPABASE_URL and OBSAQIDB_SERVICE_KEY:
            print(f'  Snapshot obs API    → configured')
        else:
            print(f'  Snapshot obs API    → NOT set (add OBS_AQIDB_SUPABASE_URL + OBS_AQIDB_SECRET_KEY)')
        if UK_AQ_OBSERVS_HISTORY_R2_API_URL:
            print(f'  Snapshot v2 R2 observations API → configured')
        else:
            print(f'  Snapshot v2 R2 observations API → NOT set (optional)')
        if UK_AQ_AQI_HISTORY_R2_API_URL:
            print(f'  Snapshot v2 R2 AQI API → configured')
        else:
            print(f'  Snapshot v2 R2 AQI API → NOT set (optional)')
        if INGESTDB_DB_URL:
            print(f'  IngestDB           → configured')
        else:
            print(f'  IngestDB           → NOT set (add SUPABASE_DB_URL)')
        if OBSAQIDB_DB_URL:
            print(f'  ObsAQIDB           → configured')
        else:
            print(f'  ObsAQIDB           → NOT set (add OBS_AQIDB_SUPABASE_DB_URL)')
        print(f'\nCtrl+C to stop.\n')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nServer stopped.')
