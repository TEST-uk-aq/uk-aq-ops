import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const directSource = readFileSync('workers/uk_aq_dashboard_online_api_worker/src/lib/direct.ts', 'utf8');

function normalizeIsoDay(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function parseDropboxBackupDays(state) {
  const sets = { observations: new Set(), aqilevels: new Set() };
  const domains = state && typeof state === 'object' && !Array.isArray(state) ? state.domains : null;
  if (!domains || typeof domains !== 'object' || Array.isArray(domains)) return sets;
  for (const domainName of ['observations', 'aqilevels']) {
    const domain = domains[domainName];
    const dayMap = domain && typeof domain === 'object' && !Array.isArray(domain) ? domain.days : null;
    if (!dayMap || typeof dayMap !== 'object' || Array.isArray(dayMap)) continue;
    for (const key of Object.keys(dayMap)) {
      const normalized = normalizeIsoDay(key);
      if (normalized) sets[domainName].add(normalized);
    }
  }
  return sets;
}

function parseIsoDay(day) {
  const normalized = normalizeIsoDay(day);
  if (!normalized) return null;
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toIsoDay(date) {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function buildStorageCoverageRows(r2Days, dropboxDays) {
  const dateCandidates = [];
  for (const day of r2Days?.observations || []) {
    const parsed = parseIsoDay(day);
    if (parsed) dateCandidates.push(parsed);
  }
  for (const day of r2Days?.aqilevels || []) {
    const parsed = parseIsoDay(day);
    if (parsed) dateCandidates.push(parsed);
  }
  for (const day of dropboxDays.observations) {
    const parsed = parseIsoDay(day);
    if (parsed) dateCandidates.push(parsed);
  }
  for (const day of dropboxDays.aqilevels) {
    const parsed = parseIsoDay(day);
    if (parsed) dateCandidates.push(parsed);
  }
  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const defaultStart = addUtcDays(todayUtc, -90);
  const minStart = dateCandidates.length
    ? new Date(Math.min(...dateCandidates.map((item) => item.getTime())))
    : defaultStart;
  const start = minStart.getTime() < defaultStart.getTime() ? minStart : defaultStart;
  const rows = [];
  for (let cursor = new Date(start.getTime()); cursor.getTime() <= todayUtc.getTime(); cursor = addUtcDays(cursor, 1)) {
    const day = toIsoDay(cursor);
    rows.push({
      date: day,
      r2_observs: Boolean(r2Days?.observations.has(day)),
      r2_aqilevels: Boolean(r2Days?.aqilevels.has(day)),
      dropbox_observs: dropboxDays.observations.has(day),
      dropbox_aqilevels: dropboxDays.aqilevels.has(day),
    });
  }
  return rows;
}

function filterDropboxBackupDaysForReadVersion(dropboxDays, r2Days, readVersion) {
  if (readVersion !== 'v2') return dropboxDays;
  if (!r2Days) {
    return { observations: new Set(), aqilevels: new Set() };
  }
  return {
    observations: new Set([...dropboxDays.observations].filter((day) => r2Days.observations.has(day))),
    aqilevels: new Set([...dropboxDays.aqilevels].filter((day) => r2Days.aqilevels.has(day))),
  };
}

test('storage coverage source clears both storage coverage and R2 history-day caches on force refresh', () => {
  assert.match(directSource, /function clearStorageCoverageCaches\(\): void \{[\s\S]*storageCoverageCache = null;[\s\S]*r2HistoryDaysCache = null;/);
  assert.match(directSource, /if \(forceRefresh\) \{[\s\S]*clearStorageCoverageCaches\(\);[\s\S]*\}/);
});

test('v2 source disables version-blind Supabase R2 window fallback', () => {
  assert.match(directSource, /r2_history_read_version\.version !== "v2"/);
  assert.match(directSource, /Version-blind Supabase window fallback disabled for v2/);
});

test('storage coverage response exposes actual R2 history diagnostics', () => {
  for (const field of [
    'r2_backup_window',
    'r2_backup_window_error',
    'r2_history_days_bucket',
    'r2_history_days_error',
    'r2_history_read_version_effective',
    'dropbox_backup_observations_earliest_day',
    'dropbox_backup_observations_latest_day',
    'dropbox_backup_aqilevels_earliest_day',
    'dropbox_backup_aqilevels_latest_day',
  ]) {
    assert.match(directSource, new RegExp(`${field}: payload\\.${field}`));
  }
});

test('v2 source filters Dropbox checkpoint days to explicit v2 R2 history days', () => {
  assert.match(directSource, /function filterDropboxBackupDaysForReadVersion/);
  assert.match(directSource, /Active R2 history version is v2 but explicit v2 history-days data is unavailable/);
  assert.match(directSource, /before explicit v2 R2 history starts/);
});

test('v2 Dropbox backup days populate backup overlay fields without changing R2 presence', () => {
  const dropboxDays = parseDropboxBackupDays({
    domains: {
      observations: {
        days: {
          '2026-06-12': {},
          '2026-06-13': {},
          '2026-06-14': {},
        },
      },
      aqilevels: {
        days: {
          '2026-06-12': {},
          '2026-06-13': {},
          '2026-06-14': {},
        },
      },
    },
  });
  const r2Days = {
    observations: new Set(['2026-06-12', '2026-06-13', '2026-06-14']),
    aqilevels: new Set(['2026-06-12', '2026-06-13', '2026-06-14']),
  };
  const rows = buildStorageCoverageRows(r2Days, dropboxDays);
  for (const day of ['2026-06-12', '2026-06-13', '2026-06-14']) {
    const row = rows.find((item) => item.date === day);
    assert.ok(row, `expected storage coverage row for ${day}`);
    assert.equal(row.r2_observs, true);
    assert.equal(row.r2_aqilevels, true);
    assert.equal(row.dropbox_observs, true);
    assert.equal(row.dropbox_aqilevels, true);
  }
});

test('v2 storage coverage does not mark 2025 R2 presence without explicit v2 history-days API days', () => {
  const dropboxDays = parseDropboxBackupDays({
    domains: {
      observations: { days: { '2025-07-02': {} } },
      aqilevels: { days: { '2025-07-02': {} } },
    },
  });
  const filteredDropboxDays = filterDropboxBackupDaysForReadVersion(dropboxDays, null, 'v2');
  const rows = buildStorageCoverageRows(null, filteredDropboxDays);
  const row = rows.find((item) => item.date === '2025-07-02');
  assert.equal(row, undefined);
});

test('v2 Dropbox state does not include 2025 when explicit v2 R2 starts at 2026-03-18', () => {
  const rawDropboxDays = parseDropboxBackupDays({
    domains: {
      observations: {
        days: {
          '2025-07-02': {},
          '2026-03-18': {},
        },
      },
      aqilevels: {
        days: {
          '2025-07-02': {},
          '2026-03-18': {},
        },
      },
    },
  });
  const r2Days = {
    observations: new Set(['2026-03-18']),
    aqilevels: new Set(['2026-03-18']),
  };
  const dropboxDays = filterDropboxBackupDaysForReadVersion(rawDropboxDays, r2Days, 'v2');
  const rows = buildStorageCoverageRows(r2Days, dropboxDays);
  const badRow = rows.find((item) => item.date === '2025-07-02');
  assert.equal(badRow, undefined);
  const firstV2Row = rows.find((item) => item.date === '2026-03-18');
  assert.equal(firstV2Row.dropbox_observs, true);
  assert.equal(firstV2Row.dropbox_aqilevels, true);
});
