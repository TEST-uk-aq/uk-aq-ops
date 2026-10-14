"""Journalled filesystem replacement coordinated with a MySQL transaction.

Required sync evidence is published as prepared before SQL commit. A success
annotation is finalised after commit (or recovered using committed sync_runs).
No filesystem operation can make an uncommitted database transaction succeed.
"""
import hashlib
import json
import os
from pathlib import Path

from configuration import require


def atomic(path, data):
    temp = path.with_name(path.name + '.new')
    with temp.open('wb') as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp, path)
    fsync_dir(path.parent)


def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


class Publication:
    def __init__(self, runtime, root, run_id):
        self.journal = runtime / 'publication.json'
        self.root = root
        self.record = {'run_id': run_id, 'files': [], 'evidence': None}

    def stage(self, relative, data):
        dst = self.root / relative
        require(dst.resolve().is_relative_to(self.root), 'ARCHIVE_ESCAPE')
        dst.parent.mkdir(parents=True, exist_ok=True)
        incoming = dst.with_name('.' + dst.name + '.' + self.record['run_id'] + '.tmp')
        backup = incoming.with_suffix('.bak')
        item = {'dst': str(dst), 'incoming': str(incoming), 'backup': str(backup),
                'existed': dst.exists(), 'sha256': hashlib.sha256(data).hexdigest()}
        # Record intent before any new file, so interrupted staging is recoverable.
        self.record['files'].append(item)
        self.save()
        atomic(incoming, data)
        return {'path': str(relative), 'sha256': item['sha256'], 'bytes': len(data)}

    def evidence(self, relative, record):
        path = self.root / relative
        self.record['evidence'] = str(path)
        record['status'] = 'published_pending_database_commit'
        self.stage(relative, (json.dumps(record, indent=2, sort_keys=True) + '\n').encode())

    def save(self):
        atomic(self.journal, json.dumps(self.record).encode())

    def publish(self):
        for item in self.record['files']:
            dst, incoming, backup = [Path(item[k]) for k in ('dst', 'incoming', 'backup')]
            require(dst.exists() == item['existed'], 'ARCHIVE_CHANGED_DURING_RUN')
            if item['existed']:
                os.replace(dst, backup)
            os.replace(incoming, dst)
            fsync_dir(dst.parent)

    @classmethod
    def recover(cls, runtime, root, connection):
        journal = runtime / 'publication.json'
        if not journal.exists():
            return
        record = json.loads(journal.read_text())
        with connection.cursor() as cur:
            cur.execute('SELECT status FROM sync_runs WHERE run_id=%s', (record['run_id'],))
            row = cur.fetchone()
        committed = row and row['status'] == 'success'
        for item in reversed(record['files']):
            paths = [Path(item[k]) for k in ('dst', 'incoming', 'backup')]
            require(all(p.resolve().is_relative_to(root) for p in paths), 'JOURNAL_BOUNDARY')
            dst, incoming, backup = paths
            if not committed:
                if backup.exists():
                    os.replace(backup, dst)
                elif not item['existed'] and not incoming.exists():
                    dst.unlink(missing_ok=True)
            incoming.unlink(missing_ok=True)
            incoming.with_name(incoming.name + '.new').unlink(missing_ok=True)
            backup.unlink(missing_ok=True)
            fsync_dir(dst.parent)
        if committed and record['evidence']:
            path = Path(record['evidence'])
            require(path.resolve().is_relative_to(root), 'JOURNAL_BOUNDARY')
            evidence = json.loads(path.read_text())
            evidence['status'] = 'success'
            atomic(path, (json.dumps(evidence, indent=2, sort_keys=True) + '\n').encode())
        journal.unlink()
        fsync_dir(runtime)
