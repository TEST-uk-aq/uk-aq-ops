#!/usr/bin/env python3
"""MacBook Pro TEST/LIVE billing collector. No schema apply or cloud mutation path."""
import argparse
import fcntl
import hashlib
import json
import os
import sys
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from configuration import SafeError, identity, load, require
from publication import Publication, atomic
from queries import (MONEY, TABLES, aggregate_sql, dimensions,
                     expected_view_schema, view_ddl, view_sql_tokens)
from reports import daily_archive, scalar, summaries


def utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def encode(value):
    return json.dumps(value, default=scalar, sort_keys=True, separators=(',', ':'))


class Queries:
    def __init__(self, config, runtime):
        from google.cloud import bigquery
        import google.auth
        self.bq = bigquery
        self.config = config
        credentials, _ = google.auth.load_credentials_from_file(
            str(runtime / 'credentials/google-application-credentials.json'),
            scopes=['https://www.googleapis.com/auth/bigquery'])
        self.client = bigquery.Client(project=config['query_project'], credentials=credentials,
                                      location=config['location'])
        self.reserved = 0

    def query(self, sql, **values):
        params = []
        for key, value in values.items():
            kind = ('TIMESTAMP' if isinstance(value, datetime) else
                    'DATE' if isinstance(value, date) else 'STRING')
            # Naive datetimes in this subsystem always mean UTC, including SQL state.
            if kind == 'TIMESTAMP':
                value = value.replace(tzinfo=timezone.utc)
            params.append(self.bq.ScalarQueryParameter(key, kind, value))
        dry = self.client.query(sql, job_config=self.bq.QueryJobConfig(
            dry_run=True, use_query_cache=False, query_parameters=params), job_retry=None)
        estimate = dry.total_bytes_processed
        require(estimate is not None, 'QUERY_ESTIMATE_UNAVAILABLE')
        # BigQuery rounds billing to MB, with a minimum 10 MB per referenced table.
        reserve = max(10 * 1024**2, ((estimate + 1024**2 - 1) // 1024**2) * 1024**2)
        remaining = self.config['maximum_run_bytes'] - self.reserved
        limit = min(self.config['maximum_bytes_billed'], remaining)
        require(reserve <= limit, 'QUERY_BUDGET_EXCEEDED')
        self.reserved += reserve
        job = self.client.query(sql, job_config=self.bq.QueryJobConfig(
            maximum_bytes_billed=reserve, query_parameters=params,
            labels={'uk_aq_environment': self.config['environment'].lower(), 'uk_aq_collector': 'gcp_billing'}),
            job_retry=None)
        try:
            rows = [dict(row.items()) for row in job.result(timeout=300)]
        except Exception:
            # Cancellation is best effort; the full job reservation is retained
            # even if its final billing result is unavailable.
            try:
                job.cancel()
            except Exception:
                pass
            raise
        self.reserved += max(0, (job.total_bytes_billed or 0) - reserve)
        return rows

    def verify_view(self, source):
        cfg = self.config['sources'][source]
        table = self.client.get_table(self.config['dataset'] + '.' + cfg['view'])
        require(table.table_type == 'VIEW', 'VIEW_TYPE_MISMATCH')
        require(table.location.casefold() == self.config['location'].casefold(), 'VIEW_LOCATION')
        actual_fields = [(f.name.casefold(), 'INTEGER' if f.field_type.upper() == 'INT64'
                          else f.field_type.upper()) for f in table.schema]
        require(actual_fields == expected_view_schema(source), 'VIEW_COLUMNS_MISMATCH')
        expected = view_ddl(self.config, source).split(' AS\n', 1)[1]
        try:
            # Token identity retains the original raw table, ordered columns,
            # aliases, casts, calculations and predicates without a SQL job.
            same_definition = (view_sql_tokens(table.view_query or '') ==
                               view_sql_tokens(expected))
        except ValueError:
            same_definition = False
        require(same_definition, 'VIEW_DEFINITION_MISMATCH')


def connect(c, runtime):
    import pymysql
    password_path = runtime / 'credentials/mysql-password'
    # Only the terminal newline belongs to the credential-file format.
    password = password_path.read_text().removesuffix('\n')
    require(bool(password), 'MYSQL_PASSWORD_REQUIRED')
    return pymysql.connect(sql_mode='STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION',
                           unix_socket=c['mysql_socket'], user=c['mysql_user'], password=password,
                           database=c['mysql_database'], charset='utf8mb4', autocommit=True,
                           cursorclass=pymysql.cursors.DictCursor,
                           init_command="SET time_zone = '+00:00'", connect_timeout=10,
                           read_timeout=60, write_timeout=60)


def sql(db, statement, args=()):
    with db.cursor() as cur:
        cur.execute(statement, args)
        return cur.fetchall()


def safe_credentials(runtime):
    for relative in ('credentials/google-application-credentials.json', 'credentials/mysql-password'):
        p = runtime / relative
        require(p.is_file() and p.resolve().is_relative_to(runtime), 'CREDENTIAL_BOUNDARY')
        require(p.stat().st_mode & 0o077 == 0, 'CREDENTIAL_PERMISSIONS')


def acquire_state(db, c, source):
    binding = identity(c, source)
    sql(db, '''INSERT IGNORE INTO sync_state
        (source_kind,identity_hash,earliest_usage_date) VALUES (%s,%s,%s)''',
        (source, binding, c['earliest_usage_date']))
    state = sql(db, 'SELECT * FROM sync_state WHERE source_kind=%s', (source,))[0]
    require(state['identity_hash'] == binding, 'STATE_IDENTITY_MISMATCH')
    return state


def day_rows(queries, c, source, day, cutoff):
    view = c['dataset'] + '.' + c['sources'][source]['view']
    rows = queries.query(aggregate_sql(view, source), day=day, cutoff=cutoff,
                         account=c['billing_account_id'])
    now = utcnow()
    for row in rows:
        for key in MONEY:
            value = row[key]
            require(type(value) is int and -(2**63) <= value < 2**63, 'MONEY_OVERFLOW')
        require(row['net_cost_micros'] == row['gross_cost_micros'] + row['credit_micros'],
                'MONEY_INVARIANT')
        require(row['billing_account_id'] == c['billing_account_id'] and
                row['usage_date'] == day, 'FACT_BOUNDARY')
        # PyMySQL stores UTC DATETIME without tzinfo.
        row['source_export_time_max'] = row['source_export_time_max'].replace(tzinfo=None)
        row['refreshed_at'] = now
        logical_key = [row[k] for k in dimensions(source)]
        row['dimension_hash'] = hashlib.sha256(
            json.dumps(logical_key, default=scalar, ensure_ascii=False,
                       separators=(',', ':')).encode('utf-8')).digest()
    rows.sort(key=lambda r: r['dimension_hash'])
    require(len({r['dimension_hash'] for r in rows}) == len(rows), 'DIMENSION_HASH_COLLISION')
    return rows


def replace_day(db, source, day, rows):
    table = TABLES[source]
    sql(db, f'DELETE FROM {table} WHERE usage_date=%s', (day,))
    if rows:
        keys = dimensions(source) + MONEY + ['source_export_time_max', 'refreshed_at', 'dimension_hash']
        statement = f"INSERT INTO {table} ({','.join(keys)}) VALUES ({','.join(['%s'] * len(keys))})"
        with db.cursor() as cur:
            cur.executemany(statement, [[r[k] for k in keys] for r in rows])


def select_window(db, queries, c, source, mode, state, args):
    view = c['dataset'] + '.' + c['sources'][source]['view']
    cutoff = utcnow() - timedelta(seconds=c['settling_seconds'])
    prior = state['watermark_at']
    cap = c['maximum_days_per_batch']
    if mode == 'backfill':
        require(prior is None, 'BACKFILL_ALREADY_COMPLETE_USE_REFRESH')
        if state['backfill_cutoff'] is None:
            meta = queries.query(f'''SELECT MIN(usage_date) AS first_day,
                MAX(usage_date) AS last_day, MAX(export_time) AS newest,
                COUNTIF(billing_account_id IS NULL OR billing_account_id != @account) AS wrong_account
                FROM `{view}` WHERE export_time <= @cutoff''',
                account=c['billing_account_id'], cutoff=cutoff)[0]
            require(meta['wrong_account'] == 0, 'SOURCE_ACCOUNT_MISMATCH')
            require(meta['first_day'] is not None, 'EMPTY_SOURCE')
            require(meta['first_day'] >= date.fromisoformat(c['earliest_usage_date']) and
                    meta['last_day'] <= cutoff.date(), 'SOURCE_HISTORY_MISMATCH')
            if source == 'standard':
                require(meta['first_day'] == date.fromisoformat(c['earliest_usage_date']),
                        'STANDARD_HISTORY_MISMATCH')
            sql(db, '''UPDATE sync_state SET earliest_usage_date=%s, backfill_cutoff=%s,
                backfill_next_date=%s, backfill_last_date=%s, newest_export_time=%s
                WHERE source_kind=%s''', (meta['first_day'], cutoff, meta['first_day'],
                                         meta['last_day'], meta['newest'], source))
            state = sql(db, 'SELECT * FROM sync_state WHERE source_kind=%s', (source,))[0]
        cutoff = state['backfill_cutoff']
        start = state['backfill_next_date']
        last = min(state['backfill_last_date'], start + timedelta(days=cap - 1))
        days = [start + timedelta(days=i) for i in range((last - start).days + 1)]
        final = last == state['backfill_last_date']
        return days, cutoff, None, cutoff if final else None, state['newest_export_time'], last + timedelta(days=1)
    require(prior is not None, 'BACKFILL_REQUIRED')
    if mode == 'refresh':
        require(args.start and args.end, 'REFRESH_DATES_REQUIRED')
        require(date.fromisoformat(c['earliest_usage_date']) <= args.start <= args.end <= cutoff.date(),
                'REFRESH_DATE_BOUNDARY')
        require((args.end - args.start).days < cap, 'REFRESH_TOO_LARGE')
        days = [args.start + timedelta(days=i) for i in range((args.end - args.start).days + 1)]
        return days, cutoff, None, prior, state['newest_export_time'], None
    start = prior - timedelta(seconds=c['overlap_seconds'])
    changed = queries.query(f'''SELECT usage_date, MAX(export_time) AS newest
        FROM `{view}` WHERE export_time >= @start AND export_time <= @cutoff
          AND billing_account_id = @account GROUP BY usage_date ORDER BY usage_date''',
        start=start, cutoff=cutoff, account=c['billing_account_id'])
    require(all(date.fromisoformat(c['earliest_usage_date']) <= r['usage_date'] <= cutoff.date()
                for r in changed), 'SOURCE_HISTORY_MISMATCH')
    # Do not truncate this list: doing so could advance past an unprocessed correction.
    # Bound with query budgets instead; if exceeded, the complete unit is retried.
    observed = [r['newest'].replace(tzinfo=None) for r in changed]
    if state['newest_export_time'] is not None:
        observed.append(state['newest_export_time'])
    newest = max(observed) if observed else None
    watermark = max(prior, newest) if newest is not None else prior
    return [r['usage_date'] for r in changed], cutoff, start, watermark, newest, None


def collect(db, queries, c, runtime, source, args):
    state = acquire_state(db, c, source)
    run_id = uuid.uuid4().hex
    started = utcnow()
    sql(db, 'UPDATE sync_state SET last_attempt_at=%s WHERE source_kind=%s', (started, source))
    # Prune before every attempt, including repeated failures, after journal
    # recovery has resolved the previous decision. Never prune billing facts.
    sql(db, '''DELETE FROM sync_runs WHERE source_kind=%s AND run_id NOT IN
        (SELECT run_id FROM (SELECT run_id FROM sync_runs WHERE source_kind=%s
         ORDER BY started_at DESC LIMIT %s) AS keep_runs)''',
        (source, source, c['run_history_limit'] - 1))
    # Start evidence survives a killed process and never claims a successful run.
    sql(db, '''INSERT INTO sync_runs (run_id,source_kind,mode,started_at,status,
        prior_watermark,source_window_end) VALUES (%s,%s,%s,%s,'running',%s,%s)''',
        (run_id, source, args.command, started, state['watermark_at'], started))
    pub = Publication(runtime, Path(c['archive_root']), run_id)
    initial_bytes = queries.reserved
    try:
        queries.verify_view(source)
        days, cutoff, start, watermark, newest, next_day = select_window(
            db, queries, c, source, args.command, state, args)
        sql(db, '''UPDATE sync_runs SET source_window_start=%s,source_window_end=%s,
            affected_dates=%s WHERE run_id=%s''', (start, cutoff, encode(days), run_id))
        sql(db, 'UPDATE sync_state SET newest_export_time=%s WHERE source_kind=%s', (newest, source))
        records = [(day, day_rows(queries, c, source, day, cutoff)) for day in days]
        total = sum(len(rows) for _, rows in records)
        db.begin()
        files = []
        for day, rows in records:
            replace_day(db, source, day, rows)
            base = Path('daily') if source == 'standard' else Path('detailed/daily')
            relative = base / day.strftime('%Y/%m') / (day.isoformat() + '.csv.gz')
            files.append(pub.stage(relative, daily_archive(source, rows)))
        for name, data in summaries(db, source, cutoff, history_complete=watermark is not None,
                                    environment=c['environment']):
            files.append(pub.stage(Path('reports') / source / name, data))
        evidence = dict(run_id=run_id, environment=c['environment'], source_kind=source,
                        source_view=c['dataset'] + '.' + c['sources'][source]['view'],
                        billing_account_id=c['billing_account_id'], identity_hash=identity(c, source),
                        started_at=scalar(started), cutoff=scalar(cutoff),
                        prior_watermark=scalar(state['watermark_at']), resulting_watermark=scalar(watermark),
                        affected_dates=[d.isoformat() for d in days], rows_written=total, files=files,
                        query_bytes_reserved=queries.reserved - initial_bytes,
                        earliest_available_usage_date=scalar(sql(db,
                            'SELECT earliest_usage_date FROM sync_state WHERE source_kind=%s',
                            (source,))[0]['earliest_usage_date']))
        pub.evidence(Path('_sync') / started.strftime('%Y/%m') / (run_id + '.json'), evidence)
        pub.publish()
        finished = utcnow()
        sql(db, '''UPDATE sync_state SET last_success_at=%s, watermark_at=%s,
            newest_export_time=%s, last_error_code=NULL,
            backfill_next_date=COALESCE(%s,backfill_next_date) WHERE source_kind=%s''',
            (finished, watermark, newest, next_day, source))
        sql(db, '''UPDATE sync_runs SET status='success', finished_at=%s,
            resulting_watermark=%s,source_window_start=%s,source_window_end=%s,
            affected_dates=%s,rows_written=%s,files_written=%s,query_bytes_reserved=%s WHERE run_id=%s''',
            (finished, watermark, start, cutoff, encode(days), total, len(files) + 1,
             queries.reserved - initial_bytes, run_id))
        db.commit()
    except Exception as exc:
        # commit() can fail after the server committed: reconnect and consult its
        # durable decision before touching archive files or reporting failure.
        try:
            db.rollback()
            db.ping(reconnect=True)
            require(sql(db, "SELECT GET_LOCK(%s,0) AS acquired",
                             ('uk_aq_gcp_billing_' + c['environment'].lower() + '_collector',))[0]
                    ['acquired'] == 1, 'DATABASE_RECOVERY_LOCK_REQUIRED')
        except Exception:
            raise SafeError('DATABASE_RECOVERY_REQUIRED') from None
        committed = sql(db, 'SELECT status FROM sync_runs WHERE run_id=%s', (run_id,))[0]['status'] == 'success'
        Publication.recover(runtime, Path(c['archive_root']), db)
        if not committed:
            code = str(exc) if isinstance(exc, SafeError) else 'COLLECTION_FAILED'
            sql(db, '''UPDATE sync_runs SET status='failed', finished_at=%s,
                error_code=%s,query_bytes_reserved=%s WHERE run_id=%s''',
                (utcnow(), code, queries.reserved - initial_bytes, run_id))
            sql(db, 'UPDATE sync_state SET last_error_code=%s WHERE source_kind=%s', (code, source))
            raise SafeError(code) from None
    # All required files and prepared evidence exist at SQL commit. This final
    # success annotation/cleanup is recoverable; keep the journal if it fails.
    try:
        Publication.recover(runtime, Path(c['archive_root']), db)
    except Exception:
        raise SafeError('COMMITTED_PUBLICATION_FINALIZATION_PENDING') from None
    print(encode({'source': source, 'status': 'success', 'run_id': run_id,
                  'days': len(days), 'rows': total, 'watermark': watermark}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--environment', required=True, choices=['TEST', 'LIVE'])
    config_input = parser.add_mutually_exclusive_group(required=True)
    config_input.add_argument('--config', type=Path, help='Existing private config.json (TEST compatibility)')
    config_input.add_argument('--env-file', type=Path, help='Private per-environment .env settings')
    parser.add_argument('--runtime-root', required=True, type=Path)
    parser.add_argument('--source', choices=['standard', 'detailed', 'all'], default='standard')
    parser.add_argument('command', choices=['validate', 'render-views', 'backfill', 'incremental', 'refresh'])
    parser.add_argument('--start', type=date.fromisoformat)
    parser.add_argument('--end', type=date.fromisoformat)
    args = parser.parse_args()
    c = load(args.env_file or args.config, args.runtime_root, args.environment)
    sources = list(c['sources']) if args.source == 'all' else [args.source]
    if args.command == 'validate':
        print(args.environment + ' configuration structurally valid; no credentials or services accessed')
        return 0
    if args.command == 'render-views':
        for source in sources:
            print(view_ddl(c, source))
        return 0
    runtime = args.runtime_root
    require(runtime.is_dir() and runtime.stat().st_mode & 0o077 == 0, 'PRIVATE_RUNTIME_REQUIRED')
    safe_credentials(runtime)
    os.umask(0o077)
    with (runtime / 'collector.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SafeError('COLLECTOR_ALREADY_RUNNING') from None
        db = connect(c, runtime)
        try:
            got = sql(db, "SELECT GET_LOCK(%s,0) AS acquired",
                             ('uk_aq_gcp_billing_' + c['environment'].lower() + '_collector',))[0]
            require(got['acquired'] == 1, 'DATABASE_COLLECTOR_ALREADY_RUNNING')
            root = Path(c['archive_root'])
            root.mkdir(parents=True, exist_ok=True)
            binding = {'environment': c['environment'], 'sources': {s: identity(c, s) for s in c['sources']}}
            binding_file = root / 'archive-identity.json'
            if binding_file.exists():
                require(json.loads(binding_file.read_text()) == binding, 'ARCHIVE_IDENTITY_MISMATCH')
            else:
                require(not any(root.iterdir()), 'NONEMPTY_UNBOUND_ARCHIVE')
                atomic(binding_file, (encode(binding) + '\n').encode())
            Publication.recover(runtime, root, db)
            # An interrupted attempt with no committed decision is safe to retry.
            sql(db, "UPDATE sync_runs SET status='failed',finished_at=%s,error_code='INTERRUPTED' WHERE status='running'",
                (utcnow(),))
            sql(db, '''UPDATE sync_state s SET last_error_code='INTERRUPTED'
                WHERE EXISTS (SELECT 1 FROM sync_runs r WHERE r.source_kind=s.source_kind
                AND r.started_at=s.last_attempt_at AND r.error_code='INTERRUPTED')''')
            queries = Queries(c, runtime)
            failures = []
            for source in sources:
                try:
                    collect(db, queries, c, runtime, source, args)
                except SafeError as exc:
                    print(encode({'source': source, 'status': 'failed', 'code': str(exc)}), file=sys.stderr)
                    failures.append(str(exc))
                    # A pending journal must be resolved before another source can publish.
                    if (runtime / 'publication.json').exists():
                        break
            return int(bool(failures))
        finally:
            db.close()  # advisory lock released by MySQL, including process death


if __name__ == '__main__':
    try:
        sys.exit(main())
    except SafeError as error:
        print(encode({'status': 'stopped', 'code': str(error)}), file=sys.stderr)
        sys.exit(1)
    except Exception:
        # No raw SDK/SQL/auth exception strings in launchd or Dropbox evidence.
        print('{"status":"stopped","code":"CONFIGURATION_OR_RUNTIME_FAILURE"}', file=sys.stderr)
        sys.exit(1)
