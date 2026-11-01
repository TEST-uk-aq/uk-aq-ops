#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { gzipSync, gunzipSync } from 'node:zlib';
import { canonicalJson, requireValid as check, assertIdentity, newPubID, publicationPrefix } from '../schema.mjs';
import { sha256Hex } from '../../backup_r2/lib/rclone.mjs';
import { decodeCanonicalObservations, daysBetween } from '../../compressed_chart_history/extract.mjs';
import { calculateMonthAqi, aqiEndpointCompleteness, indexCompleteness } from '../../compressed_chart_history/export.mjs';
import { observationHistoryPhysicalSchemasFromManifest } from '../../../workers/shared/uk_aq_observation_history_schema.mjs';
import { AQI_ALGORITHM_VERSION, DAQI_PM_ROLLING24H_WINDOW_HOURS,
  DAQI_PM_ROLLING24H_REQUIRED_HOURS } from '../../../lib/aqi/aqi_levels.mjs';
import { createDropboxReader, resolveDropboxSource, CHECKPOINT_KEY } from './dropbox-reader.mjs';
import { openBackupSource } from './source.mjs';
import { authenticatedTerminalSourceDay, readCurrentObservationScopes, withBootstrapObservationLock } from './currentness.mjs';
import { selectMonths, resolveMonths } from './months.mjs';
import { failureReason, rethrowInvocationFault } from './failures.mjs';
import { createBulkProcessor, createTemporaryBudget } from './bulk.mjs';

const DAY = 86_400_000, MIB = 1024 ** 2;
const scopeKey = scope => `${scope.connector_id}/${scope.pollutant_code}/${scope.month_utc}/${scope.timeseries_id ?? '*'}`;
export const HELP = `Manual, local-only TEST Dropbox historical JSONgen bootstrap.
No execution occurs on import. No R2/database/Dropbox writes or publication.
Required:
  --source dropbox-backup
  --checkpoint-path ${CHECKPOINT_KEY}
  --checkpoint-sha256 <SHA-256 of exact selected completed root.json bytes>
  --observations-root-sha256 <checkpoint processed observations root>
  --months <YYYY-MM:YYYY-MM or YYYY-MM> (inclusive UTC calendar months)
     Requires --timeseries-ids OR --all-eligible-timeseries (AURN connector 1).
     Shared Dropbox decoding; one physical series/month in candidate memory.
     Historical months are full; the current month
     resolves its completed prefix and terminal source from the pinned backup.
     No admitted current-month days means an incomplete scope; earlier months continue.
  or one of the separate manual compatibility period modes:
  --month-utc <closed calendar month YYYY-MM> (complete-month mode)
  or --start-utc <UTC month start> --partial-month-utc <YYYY-MM>
     --completed-before-utc <UTC midnight exclusive cutoff>
  or --start-utc <UTC midnight> --end-utc <exclusive UTC midnight> (legacy range)
  --connector-ids <comma-separated explicit physical connector IDs>
  --pollutants <pm25,pm10,no2 subset>
  --verification-modes <id=overlay_accepted|pre_overlay_accepted,...>
  --output-dir <absolute new directory>
Optional: --timeseries-ids <comma-separated physical IDs>
  --all-eligible-timeseries (boolean opt-in, --months only; mutually exclusive
     with --timeseries-ids; discovers selected PM2.5/PM10/NO2 from Dropbox only)
Bounds (default; hard maximum):
  --max-days 124 (366), --max-series 256 (4096, across invocation)
  --max-selected-rows 250000 (1000000, per month unit incl dependencies;
     --months candidate memory selects one physical series)
  --max-file-rows 131072 (1000000), --max-decoded-rows 10000000 (100000000)
  --max-source-mib 1024 (16384, includes metadata rechecks)
  --max-object-mib 16 (64), --max-metadata-mib 16 (32)
  --max-output-mib 1024 (8192), --max-objects 8192 (65536)
  --max-temp-mib 2048 (32768, --months cache plus decoded row spools;
     legacy modes retain their source-byte cache cap unless explicitly set)
  --max-read-commands 16384 (131072), --max-wall-seconds 3600 (14400)
Uses existing Dropbox root/directory configuration, uk_aq_dropbox and RCLONE_CONFIG.
Uses existing R2 credentials and observations global lock configuration.
See README.md for reviewed offline command shapes.
`;

function csv(value, validate, label) {
  const entries = (value || '').split(',');
  check(entries.length > 0 && entries.every(validate) && new Set(entries).size === entries.length, `invalid ${label}`);
  return entries;
}
export function parseOptions(argv, nowUtc = new Date().toISOString()) {
  const names = ['source', 'checkpoint-path', 'checkpoint-sha256', 'observations-root-sha256',
    'months', 'month-utc', 'start-utc', 'end-utc', 'partial-month-utc', 'completed-before-utc',
    'connector-ids', 'timeseries-ids', 'pollutants', 'verification-modes', 'output-dir',
    'max-days', 'max-series', 'max-selected-rows', 'max-file-rows', 'max-decoded-rows', 'max-source-mib',
    'max-object-mib', 'max-metadata-mib', 'max-output-mib', 'max-objects', 'max-read-commands', 'max-wall-seconds',
    'max-temp-mib', 'all-eligible-timeseries'];
  const supplied = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].slice(2);
    check(argv[i] === `--${key}` && names.includes(key) && supplied[key] === undefined, 'unknown/repeated option');
    if (key === 'all-eligible-timeseries') supplied[key] = true;
    else {
      check(argv[i + 1] !== undefined && !argv[i + 1].startsWith('--'), 'every valued option requires a value; use --help');
      supplied[key] = argv[++i];
    }
  }
  check(supplied.source === 'dropbox-backup' && supplied['checkpoint-path'] === CHECKPOINT_KEY, 'explicit Dropbox v3 checkpoint required');
  const sha = value => /^[a-f0-9]{64}$/.test(value || '');
  check(sha(supplied['checkpoint-sha256']) && sha(supplied['observations-root-sha256']), 'both explicit checkpoint and observation-root SHA-256 pins required');
  const positive = value => /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
  const connectors = csv(supplied['connector-ids'], positive, 'connector selection').map(Number).sort((a,b) => a-b);
  const timeseries = supplied['timeseries-ids'] === undefined ? null
    : csv(supplied['timeseries-ids'], positive, 'timeseries selection').map(Number).sort((a,b) => a-b);
  const allEligible = supplied['all-eligible-timeseries'] === true;
  check(!allEligible || (!timeseries && supplied.months !== undefined
    && connectors.length === 1 && connectors[0] === 1),
  '--all-eligible-timeseries requires --months, connector 1 and no --timeseries-ids');
  const pollutants = csv(supplied.pollutants, p => ['pm25', 'pm10', 'no2'].includes(p), 'pollutant selection').sort();
  const verificationModes = {};
  for (const item of csv(supplied['verification-modes'], s => /^[1-9]\d*=(?:pre_overlay_accepted|overlay_accepted)$/.test(s), 'verification modes')) {
    const [id, mode] = item.split('=');
    check(verificationModes[id] === undefined && connectors.includes(Number(id)), 'duplicate/unselected verification connector');
    verificationModes[id] = mode;
  }
  check(connectors.every(id => verificationModes[id]), 'verification mode required for every selected connector');
  function bound(name, fallback, maximum) {
    const raw = supplied[name] ?? String(fallback);
    check(positive(raw) && Number(raw) <= maximum, `${name} must be 1..${maximum}`);
    return Number(raw);
  }
  const limits = { days: bound('max-days', 124, 366), series: bound('max-series', 256, 4096),
    selectedRows: bound('max-selected-rows', 250000, 1000000), fileRows: bound('max-file-rows', 131072, 1000000),
    decodedRows: bound('max-decoded-rows', 10000000, 100000000),
    sourceBytes: bound('max-source-mib', 1024, 16384) * MIB, objectBytes: bound('max-object-mib', 16, 64) * MIB,
    metadataBytes: bound('max-metadata-mib', 16, 32) * MIB, outputBytes: bound('max-output-mib', 1024, 8192) * MIB,
    objects: bound('max-objects', 8192, 65536), requests: bound('max-read-commands', 16384, 131072),
    wallSeconds: bound('max-wall-seconds', 3600, 14400), tempBytes: bound('max-temp-mib', 2048, 32768) * MIB };
  function utc(raw) {
    check(/^\d{4}-\d\d-\d\dT00:00:00(?:\.000)?Z$/.test(raw || ''), 'this version requires whole UTC days');
    const date = new Date(raw);
    check(Number.isFinite(date.getTime()) && date.toISOString() === raw.replace(/(?:\.000)?Z$/, '.000Z'), 'invalid UTC date');
    return date.toISOString();
  }
  let start, end, selectedMonth = null, partialMonth = null, periodMode = 'legacy_range', monthSelection = null;
  if (supplied.months !== undefined) {
    check(['month-utc', 'start-utc', 'end-utc', 'partial-month-utc', 'completed-before-utc']
      .every(name => supplied[name] === undefined), '--months cannot be combined with other period options');
    check(timeseries?.length > 0 || allEligible, '--months requires --timeseries-ids or --all-eligible-timeseries');
    monthSelection = selectMonths(supplied.months, nowUtc, limits.days);
    ({ start, end } = monthSelection);
    periodMode = 'month_range';
  } else if (supplied['month-utc'] !== undefined) {
    check(supplied['start-utc'] === undefined && supplied['end-utc'] === undefined
      && supplied['partial-month-utc'] === undefined && supplied['completed-before-utc'] === undefined,
    '--month-utc cannot be combined with other period options');
    check(/^\d{4}-(0[1-9]|1[0-2])$/.test(supplied['month-utc']), '--month-utc must be YYYY-MM');
    selectedMonth = supplied['month-utc'];
    start = `${selectedMonth}-01T00:00:00.000Z`;
    const nextMonth = new Date(start);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    end = nextMonth.toISOString();
    periodMode = 'complete_month';
    check(connectors.length === 1 && timeseries?.length === 1 && pollutants.length === 1
      && pollutants[0] === 'pm25',
    'complete-month mode requires one explicit physical timeseries and the pm25 pollutant');
  } else if (supplied['partial-month-utc'] !== undefined) {
    check(supplied['start-utc'] !== undefined && supplied['end-utc'] === undefined
      && supplied['completed-before-utc'] !== undefined,
    'partial-month mode requires --start-utc, --partial-month-utc and --completed-before-utc');
    check(/^\d{4}-(0[1-9]|1[0-2])$/.test(supplied['partial-month-utc']), '--partial-month-utc must be YYYY-MM');
    start = utc(supplied['start-utc']);
    check(start.slice(8, 10) === '01', '--start-utc must be the first day of a UTC month in partial-month mode');
    partialMonth = supplied['partial-month-utc'];
    const partialStart = `${partialMonth}-01T00:00:00.000Z`;
    const nextMonth = new Date(partialStart);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const cutoff = utc(supplied['completed-before-utc']);
    check(cutoff.slice(0, 7) === partialMonth && cutoff > partialStart && cutoff < nextMonth.toISOString(),
      'completed-before cutoff must be a UTC midnight inside the selected partial month');
    check(start <= partialStart, 'partial month must not precede the selected start month');
    end = cutoff;
    periodMode = 'partial_month_cutoff';
  } else {
    check(supplied['start-utc'] !== undefined && supplied['end-utc'] !== undefined,
      'provide --month-utc or both --start-utc and --end-utc');
    check(supplied['completed-before-utc'] === undefined,
      '--completed-before-utc requires --partial-month-utc');
    start = utc(supplied['start-utc']); end = utc(supplied['end-utc']);
  }
  check(start < end && (Date.parse(end) - Date.parse(start)) / DAY <= limits.days, 'invalid or over-budget requested interval');
  check(path.isAbsolute(supplied['output-dir'] || ''), 'absolute new output directory required');
  check(!timeseries || timeseries.length <= limits.series, 'selected series exceed invocation limit');
  if (!monthSelection && supplied['max-temp-mib'] === undefined) limits.tempBytes = limits.sourceBytes;
  return { source: 'dropbox-backup', checkpointPath: CHECKPOINT_KEY, checkpointSha256: supplied['checkpoint-sha256'],
    observationsRoot: supplied['observations-root-sha256'], start, end, connectors, timeseries, pollutants,
    verificationModes, limits, output: path.resolve(supplied['output-dir']), selectedMonth,
    partialMonth, periodMode, monthSelection, allEligible };
}

export function monthsBetween(start, end) {
  const result = [], cursor = new Date(`${start.slice(0, 7)}-01T00:00:00.000Z`);
  while (cursor.toISOString() < end) {
    const monthStart = cursor.toISOString(); cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    const monthEnd = cursor.toISOString();
    result.push({ month_utc: monthStart.slice(0, 7), month_start_utc: monthStart, month_end_exclusive_utc: monthEnd,
      requested_start_utc: start > monthStart ? start : monthStart,
      requested_end_exclusive_utc: end < monthEnd ? end : monthEnd,
      partial_month: start > monthStart || end < monthEnd });
  }
  return result;
}

export async function buildCurrentnessScopes(source, periods, pollutants) {
  const wantsPmContext = pollutants.some(pollutant => pollutant === 'pm25' || pollutant === 'pm10');
  const daysByMonth = new Map();
  const requested = periods.map(period => {
    const selectedDays = daysBetween(period.requested_start_utc, period.requested_end_exclusive_utc);
    const contextDay = wantsPmContext
      ? new Date(Date.parse(period.requested_start_utc) - DAY).toISOString().slice(0, 10) : null;
    const terminalDay = period.requested_end_exclusive_utc.slice(0, 10);
    for (const day of [...selectedDays, ...(contextDay ? [contextDay] : []), terminalDay]) {
      if (!daysByMonth.has(day.slice(0, 7))) daysByMonth.set(day.slice(0, 7), new Set());
      daysByMonth.get(day.slice(0, 7)).add(day);
    }
    const monthStart = `${period.month_utc}-01T00:00:00.000Z`;
    const monthEnd = (() => { const date = new Date(monthStart); date.setUTCMonth(date.getUTCMonth() + 1); return date.toISOString(); })();
    return { ...period, mode: period.requested_start_utc === monthStart
      && period.requested_end_exclusive_utc === monthEnd ? 'complete_month' : 'partial_completed_days',
    selected_days: selectedDays, context_days: contextDay ? [contextDay] : [],
    terminal_days: [terminalDay], terminal_endpoint_utc: period.requested_end_exclusive_utc };
  });
  const sourceMonths = new Map();
  for (const [monthUtc, selectedDays] of daysByMonth) {
    try {
      sourceMonths.set(monthUtc, await source.observationMonthSnapshot(monthUtc, [...selectedDays]));
    } catch (error) {
      rethrowInvocationFault(error);
      sourceMonths.set(monthUtc, { month_utc: monthUtc, selected_days: [],
        source_failure: { reason: failureReason(error), message: error.message } });
    }
  }
  const scopes = requested.map(period => {
    const month = sourceMonths.get(period.month_utc);
    return { month_utc: period.month_utc, mode: period.mode,
      source_failure: month.source_failure || null,
      source_month_hash: month.processed_source_month_hash,
      selected_days: period.selected_days,
      source_days: period.mode === 'partial_completed_days'
        ? period.selected_days.map(dayUtc => month.selected_days.find(day => day.day_utc === dayUtc) || { day_utc: dayUtc,
          state: 'not_established', manifest_hash: null, manifest_key: null, copied_at: null }) : [],
      context_days: period.context_days,
      source_context_days: period.context_days.map(dayUtc => sourceMonths.get(dayUtc.slice(0, 7))
        .selected_days.find(day => day.day_utc === dayUtc)),
      source_month_evidence: month,
      context_month_evidence: period.context_days.map(dayUtc => sourceMonths.get(dayUtc.slice(0, 7))),
      terminal_endpoint_utc: period.terminal_endpoint_utc,
      terminal_days: period.terminal_days,
      source_terminal_days: period.terminal_days.map(dayUtc => sourceMonths.get(dayUtc.slice(0, 7))
        .selected_days.find(day => day.day_utc === dayUtc)),
      terminal_month_evidence: period.terminal_days.map(dayUtc => sourceMonths.get(dayUtc.slice(0, 7))),
    };
  });
  return { source_months: Object.fromEntries(sourceMonths), scopes };
}

export function classifyPeriodCurrentness(sourceScope, canonicalScope, requirePmContext = sourceScope.context_days?.length > 0) {
  const established = canonicalScope.proof_state === 'established';
  const monthMatches = established && canonicalScope.currentness.matches && (sourceScope.mode === 'complete_month'
    ? (sourceScope.source_month_hash || null) === (canonicalScope.currentness.canonical_content_hash || null)
    : canonicalScope.currentness.matches);
  const contextMatches = (canonicalScope.context_days || []).length === (sourceScope.context_days || []).length
    && (canonicalScope.context_days || []).every(day => day.matches);
  const terminalMatches = sourceScope.terminal_days?.length === 1
    && canonicalScope.terminal_days?.length === 1
    && canonicalScope.terminal_days[0].day_utc === sourceScope.terminal_days[0]
    && canonicalScope.terminal_days[0].matches === true;
  return { matches: monthMatches && (!requirePmContext || contextMatches) && terminalMatches,
    month_matches: monthMatches, context_matches: contextMatches,
    terminal_matches: terminalMatches, context_required: requirePmContext };
}

export function scopedSourceStabilityKeys(source, sourceProof, reader, scope, timeseriesIds = [], requirePmContext = true,
  requireTerminal = true) {
  const scopeProof = sourceProof.scopes.find(item => item.month_utc === scope.month_utc);
  check(scopeProof, `scoped metadata proof missing for ${scope.month_utc}`);
  const networkKeys = new Set();
  const cachedProofKeys = new Set([CHECKPOINT_KEY]);
  if (source.bindingPackRootEvidence?.key) cachedProofKeys.add(source.bindingPackRootEvidence.key);
  if (source.verificationLatestEvidence?.key) cachedProofKeys.add(source.verificationLatestEvidence.key);
  const monthEvidence = scopeProof.source_month_evidence;
  for (const evidence of [monthEvidence,
    ...(requirePmContext ? scopeProof.context_month_evidence || [] : []),
    ...(requireTerminal ? scopeProof.terminal_month_evidence || [] : [])]) {
    if (!evidence) continue;
    for (const reference of [evidence.observations_root_manifest, evidence.year_manifest,
      evidence.month_manifest, evidence.month_state_shard]) {
      if (reference?.key) cachedProofKeys.add(reference.key);
    }
  }
  // A whole-month identity includes its complete child set, so pin and reread
  // that selected month and its completion shard. Partial scopes deliberately
  // validate only selected day leaves; later days may advance the month parent.
  if (scopeProof.mode === 'complete_month') {
    for (const reference of [monthEvidence.month_manifest, monthEvidence.month_state_shard]) {
      if (reference?.key) networkKeys.add(reference.key);
    }
  }
  const selectedDays = [...scopeProof.selected_days,
    ...(requirePmContext ? (scopeProof.context_days || []) : []),
    ...(requireTerminal ? (scopeProof.terminal_days || []) : [])];
  for (const dayUtc of selectedDays) {
    const evidence = sourceProof.source_months[dayUtc.slice(0, 7)];
    const day = evidence?.selected_days?.find(item => item.day_utc === dayUtc);
    if (!day?.manifest_key) continue; // authenticated absence was pinned in the original parent chain
    const dayBase = day.manifest_key.slice(0, -14);
    const connectorManifest = `${dayBase}/connector_id=${scope.connector_id}/manifest.json`;
    const pollutantManifest = `${dayBase}/connector_id=${scope.connector_id}`
      + `/pollutant_code=${scope.pollutant_code}/manifest.json`;
    for (const key of [day.manifest_key, connectorManifest, pollutantManifest]) {
      if (reader.metadata.has(key)) cachedProofKeys.add(key);
    }
    if (reader.metadata.has(pollutantManifest)) networkKeys.add(pollutantManifest);
  }
  for (const timeseriesId of timeseriesIds) {
    const binding = source.memberEvidence.get(timeseriesId);
    if (binding?.pack_key) networkKeys.add(binding.pack_key);
    if (binding?.pack_state_shard_key) networkKeys.add(binding.pack_state_shard_key);
  }
  const authority = source.authorities.get(scope.connector_id);
  const verificationKey = authority?.manifest_identity?.key || authority?.manifest_identity?.relative_path;
  if (verificationKey && reader.metadata.has(verificationKey)) networkKeys.add(verificationKey);
  for (const key of networkKeys) cachedProofKeys.add(key);
  return { network_keys: [...networkKeys].sort(), cached_proof_keys: [...cachedProofKeys].sort() };
}
const sortedRows = rows => rows.sort((a,b) => a.observed_at_utc.localeCompare(b.observed_at_utc)
  || a.value - b.value || canonicalJson(a).localeCompare(canonicalJson(b)));
// A null raw concentration is a retained source row, not a zero AQI sample.
const tuples = rows => rows.filter(r => r.value !== null)
  .map(r => [r.observed_at_utc, r.value, r.station_id, r.source_status, r.verification_status]);

export async function runBootstrap(options) {
  check(process.env.UK_AQ_ENV_NAME === 'TEST', 'UK_AQ_ENV_NAME must be TEST');
  const sourceRoot = resolveDropboxSource(process.env);
  // Resolve parent symlinks before creating the immutable invocation directory.
  await fs.mkdir(path.dirname(options.output), { recursive: true });
  const parent = await fs.realpath(path.dirname(options.output));
  const output = path.join(parent, path.basename(options.output));
  const repo = await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'));
  check(output !== repo && !output.startsWith(`${repo}${path.sep}`), 'candidate output must be outside ops repository');
  await fs.mkdir(output, { mode: 0o700 }); // EEXIST is intentional; never resume partial output.
  const work = path.join(output, 'work'), cacheDir = path.join(work, 'source-cache');
  await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const begun = performance.now(), cpu = process.cpuUsage();
  const disk = createTemporaryBudget(options.limits.tempBytes ?? options.limits.sourceBytes * 2);
  const reader = createDropboxReader({ cacheDir, limits: options.limits, sourceRoot, disk });
  const stats = { rows_decoded: 0, row_groups_decoded: 0, selected_timestamp_value_column_bytes: 0,
    decode_wall_ms: 0, decode_cpu_ms: 0, physical_schemas: new Map() };
  const report = { schema_version: 1, kind: 'uk_aq_jsongen_dropbox_bootstrap_report', environment: 'TEST',
    started_at_utc: new Date().toISOString(),
    state: 'running', invocation_id: newPubID(), source: sourceRoot,
    requested_period: { start_utc: options.start, end_exclusive_utc: options.end,
      ...(options.monthSelection ? { months: options.monthSelection.requested,
        end_semantics: 'selected_calendar_envelope; current-month cutoff resolved separately' } : {}) }, completed_periods: [],
    month_plan: null,
    selection: { connector_ids: options.connectors, timeseries_ids: options.timeseries, pollutants: options.pollutants,
      all_eligible_timeseries: options.allEligible === true },
    source_checkpoint: { key: options.checkpointPath, sha256: options.checkpointSha256,
      processed_observations_root_hash: options.observationsRoot },
    verification_modes: options.verificationModes, limits: options.limits,
    successful_scopes: [], incomplete_scopes: [], errors: [], candidates: [],
    eligible_for_further_manual_review: false, managed_publication_eligible: false,
    current_canonical_authority: 'not_established_offline_backup_reconstruction',
    currentness: { status: 'not_established', start: null, final: null,
      scope_results: [], unrelated_root_advance: null, source_as_of: 'not_established',
      managed_publication_eligible: false },
    verification_binding_authority: { selected_backup_domains: 'authenticated_by_existing_bootstrap_validators',
      packed_physical_bindings: 'authenticated_from_selected_backup', core_binding_currentness: 'unresolved',
      transition_mode: 'explicit_operator_input_not_independently_established' },
    admission_blockers: [{ gate: 'managed_publication_authority', state: 'unresolved',
      reason: 'matching Core publication, independent verification-transition authority, writer freshness and managed baseline are not established by this local bootstrap' }],
    operation_lock: { initial: [], final: [] },
    scoped_currentness_r2_reads: { count: 0, bytes: 0, wall_ms: 0 },
    source_stability: { original_checkpoint_sha256: options.checkpointSha256,
      original_checkpoint_cached_proof: 'not_established', current_checkpoint: 'not_read',
      selected_scopes: [],
      lock_boundary_rule: 'original source proof remains pinned; final shared-lock comparison observes canonical R2 after any earlier backup-lock holder completes; newer Dropbox checkpoints are diagnostic only and never adopted' },
    selected_month_utc: options.selectedMonth, partial_month_utc: options.partialMonth,
    period_mode: options.periodMode,
    remote_write_operations: 0, canonical_r2_reads: 0, derived_r2_reads: 0,
    observation_count: 0, aqi_calculation_wall_ms: 0, aqi_calculation_cpu_ms: 0,
    json_gzip_write_wall_ms: 0, json_gzip_write_cpu_ms: 0, output_bytes: 0,
    json_bytes: 0, gzip_bytes: 0, output_object_count: 0,
    runtime: { node: process.version, zlib: process.versions.zlib, gzip_level: 9 } };
  let active = null;
  let source = null;
  let sourceScopeProof = null;
  let bulk = null;
  const periodCurrentness = new Map();
  const stagedCandidates = [];
  const failedScopes = new Map();
  let periods = options.monthSelection ? [] : monthsBetween(options.start, options.end);
  const bindingFailures = new Map();
  function recordFailure(scope, stage, reason, details = {}) {
    report.incomplete_scopes.push({ ...scope, stage, reason,
      raw_observation_candidate_complete: false, derived_aqi_candidate_complete: false, ...details });
    report.errors.push({ scope, stage, reason, ...details });
  }
  function reconcileRequestedCandidates() {
    if (!report.requested_candidates) return;
    for (const requested of report.requested_candidates) {
      const candidate = report.candidates.find(result => result.month_utc === requested.month_utc
        && result.identity.timeseries_id === requested.timeseries_id);
      requested.state = candidate?.local_candidate_complete ? 'complete' : 'incomplete';
      if (!candidate && !report.incomplete_scopes.some(scope => scope.month_utc === requested.month_utc
        && (scope.timeseries_id === requested.timeseries_id || scope.identity?.timeseries_id === requested.timeseries_id)))
        recordFailure(requested, 'candidate_not_completed', 'requested_candidate_not_completed');
    }
  }
  function reconcileInventoryCompletion() {
    const complete = !options.allEligible || report.discovery?.state === 'complete';
    if (!complete && !report.incomplete_scopes.some(scope => scope.stage === 'physical_inventory_completion')) {
      // Inventory is a selection-wide gate, not a failure of independently
      // authenticated candidate bytes. Record it once across finalization paths.
      const failure = { selection_wide: true, stage: 'physical_inventory_completion',
        reason: 'all_eligible_inventory_not_established',
        discovery_state: report.discovery?.state ?? 'not_established',
        unresolved_discovery_scopes: (report.discovery?.scopes || []).filter(scope =>
          !['membership_established', 'authenticated_absence'].includes(scope.state)),
        unproved_physical_identities: [
          ...(report.discovery?.selected || []).filter(identity => identity.state !== 'selected'),
          ...(report.discovery?.excluded || []).filter(identity => identity.state !== 'dependency_only'),
        ] };
      report.incomplete_scopes.push(failure);
      report.errors.push({ scope: { selection_wide: true }, stage: failure.stage, reason: failure.reason });
    }
    return complete;
  }
  function recordCurrentnessFailures(scope, canonical, stage, needsPmContext, rawComplete = false) {
    const result = classifyPeriodCurrentness(sourceScopeProof.scopes.find(item => item.month_utc === scope.month_utc),
      canonical, needsPmContext);
    const evidence = [];
    if (!result.month_matches) {
      if (canonical.currentness.days) evidence.push(...canonical.currentness.days.filter(day => !day.matches));
      else evidence.push({ matches: false, source_content_hash: canonical.currentness.source_content_hash || null,
        canonical_content_hash: canonical.currentness.canonical_content_hash || null });
    }
    if (needsPmContext) evidence.push(...(canonical.context_days || []).filter(day => !day.matches));
    evidence.push(...(canonical.terminal_days || []).filter(day => !day.matches));
    if (!result.matches && !evidence.length) evidence.push({});
    for (const failed of evidence) {
      const authorityEstablished = failed.proof_state ? failed.proof_state === 'established'
        : canonical.currentness.source_authority_established && canonical.currentness.canonical_authority_established;
      const sourceHash = failed.source_manifest_hash ?? failed.source_content_hash ?? null;
      const canonicalHash = failed.canonical_manifest_hash ?? failed.canonical_content_hash ?? null;
      recordFailure(scope, stage, authorityEstablished && sourceHash !== canonicalHash ? 'hash_mismatch' : 'authority_not_established',
        { ...failed, raw_currentness_matches: result.month_matches,
          raw_observation_candidate_complete: rawComplete, currentness: canonical });
    }
  }
  const progress = setInterval(() => process.stderr.write(JSON.stringify({ state: report.state,
    scope: active, source_files: reader.inventory.size, source_bytes: reader.metrics.source_bytes_read,
    decoded_rows: stats.rows_decoded, assigned_rows: bulk?.metrics.rows_assigned_to_selected_series || 0,
    temporary_bytes: disk.metrics.temporary_bytes, candidates_staged: stagedCandidates.length,
    source_dependency: bulk?.metrics.active_source || null,
    discovery: bulk?.discovery.state || null, candidates: report.candidates.length }) + '\n'), 15000);
  async function write(relative, body) {
    reader.deadline();
    check(report.output_bytes + body.length <= options.limits.outputBytes, 'output-byte limit exceeded');
    const target = path.join(output, relative);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, body, { flag: 'wx', mode: 0o600 });
    check(sha256Hex(await fs.readFile(target)) === sha256Hex(body), 'local output readback mismatch');
    report.output_bytes += body.length;
    report.output_object_count++;
    return { path: relative, sha256: sha256Hex(body), byte_size: body.length };
  }
  async function contentJson(prefix, value) {
    const body = canonicalJson(value);
    return write(`${prefix}.${sha256Hex(body)}.json`, body);
  }
  async function gzipProduct(prefix, product, value) {
    const begin = performance.now(), before = process.cpuUsage();
    try {
      const raw = canonicalJson(value), gzip = gzipSync(raw, { level: 9 });
      check(gunzipSync(gzip).equals(raw), 'gzip round-trip mismatch');
      const ref = await write(`${prefix}/${product}.${sha256Hex(gzip)}.json.gz`, gzip);
      report.json_bytes += raw.length; report.gzip_bytes += gzip.length;
      return { ...ref, json_sha256: sha256Hex(raw), json_byte_size: raw.length,
        content_type: 'application/json', content_encoding: 'gzip' };
    } finally {
      const used = process.cpuUsage(before);
      report.json_gzip_write_wall_ms += performance.now() - begin;
      report.json_gzip_write_cpu_ms += (used.user + used.system) / 1000;
    }
  }
  // Retain original authenticated metadata even when no current-month day is
  // admissible. These are the pinned source bytes, never a newer checkpoint.
  const retainedMetadata = new Set();
  async function retainMetadata() {
    for (const ref of reader.metadata.values()) {
      if (retainedMetadata.has(ref.sha256)) continue;
      await write(`evidence/source/${ref.sha256}.json`, await fs.readFile(path.join(cacheDir, ref.sha256)));
      retainedMetadata.add(ref.sha256);
    }
  }
  try {
    const initialStarted = performance.now();
    // Authenticate the immutable selected Dropbox generation and prepare all
    // selected month/day/PM proofs before acquiring the canonical writer lock.
    const opened = await openBackupSource(reader, options);
    source = opened;
    report.source_checkpoint = source.checkpoint;
    if (options.monthSelection) {
      const resolved = await resolveMonths(opened, options.monthSelection);
      report.month_plan = resolved;
      periods = resolved.periods;
      for (const plan of resolved.plans.filter(plan => plan.state === 'incomplete')) {
        recordFailure({ month_utc: plan.month_utc, timeseries_ids: options.timeseries,
          connector_ids: options.connectors, pollutants: options.pollutants }, 'source_planning', plan.reason,
        { day_utc: plan.first_uncompleted_day_utc || null, source_evidence: plan.source_month_evidence || null });
      }
      if (!periods.length) {
        if (options.allEligible) report.discovery = { mode: 'all_eligible_timeseries', state: 'not_established',
          selected: [], excluded: [], reason: 'no_admitted_reporting_months' };
        await retainMetadata(); report.state = 'incomplete'; return report;
      }
    }
    const sourceProof = await buildCurrentnessScopes(opened, periods, options.pollutants);
    sourceScopeProof = sourceProof;
    if (options.monthSelection) {
      bulk = createBulkProcessor({ source, reader, options, periods, stats, disk,
        directory: path.join(work, 'decoded-rows') });
      report.discovery = bulk.discovery;
      const discoveryBegan = performance.now();
      const selected = await bulk.discover();
      bulk.metrics.discovery_wall_ms = performance.now() - discoveryBegan;
      options = { ...options, timeseries: selected };
      report.selection.timeseries_ids = selected;
      for (const scope of bulk.discovery.scopes.filter(scope => scope.state === 'not_established'))
        recordFailure(scope, 'physical_inventory', scope.reason, { message: scope.message });
      report.requested_candidates = options.monthSelection.periods.flatMap(period => selected.map(id => ({ month_utc: period.month_utc,
        timeseries_id: id, state: 'pending' })));
    }
    if (report.month_plan) for (const plan of report.month_plan.plans) {
      const proof = sourceProof.scopes.find(scope => scope.month_utc === plan.month_utc);
      if (proof) plan.source_scope = proof;
    }
    const initial = await withBootstrapObservationLock(async lock => {
      const canonical = await readCurrentObservationScopes(sourceProof.scopes, {
        env: process.env, signal: lock.signal, assertHeld: () => { lock.assertHeld(); reader.deadline(); },
      });
      return canonical;
    }, { env: process.env, runId: report.invocation_id, diagnostics: report.operation_lock.initial });
    const initialScopes = sourceProof.scopes.map((scope, index) => ({ ...scope,
      canonical: initial.scopes[index],
      result: classifyPeriodCurrentness(scope, initial.scopes[index]),
    }));
    report.currentness.start = { checked_at_utc: initial.checked_at_utc,
      checkpoint_sha256: source.checkpoint.sha256,
      checkpoint_observations_root_hash: source.checkpoint.processed_observations_root_hash,
      canonical_root: initial.root,
      canonical_root_content_hash: initial.root_content_hash,
      r2_manifest_reads: initial.reads,
      scopes: initialScopes.map(scope => ({ month_utc: scope.month_utc, mode: scope.mode,
        result: scope.result, currentness: scope.canonical.currentness,
        context_days: scope.canonical.context_days, terminal_days: scope.canonical.terminal_days,
        canonical_scope: scope.canonical.canonical_scope })),
    };
    report.currentness.source_as_of = initial.checked_at_utc;
    report.currentness.status = initialScopes.every(scope => scope.result.matches)
      ? 'initial_scopes_match' : 'initial_scoped_mismatch';
    report.currentness.scope_results = initialScopes.map(scope => ({ month_utc: scope.month_utc,
      mode: scope.mode, start_matches: scope.result.matches }));
    report.scoped_currentness_r2_reads.count += initial.reads.length;
    report.scoped_currentness_r2_reads.bytes += initial.reads.reduce((sum, read) => sum + read.byte_size, 0);
    report.scoped_currentness_r2_reads.wall_ms += performance.now() - initialStarted;
    report.canonical_r2_reads += initial.reads.length;
    for (const scope of initialScopes) periodCurrentness.set(scope.month_utc, scope);
    if (source.checkpoint.sha256 !== options.checkpointSha256) throw new Error('selected Dropbox checkpoint byte pin mismatch');
    if (options.timeseries) for (const id of options.timeseries) {
      try {
        const binding = await source.binding(id);
        check(options.connectors.includes(binding.connector_id) && options.pollutants.includes(binding.pollutant_code),
          'explicit timeseries is outside connector/pollutant selection');
      } catch (error) {
        rethrowInvocationFault(error);
        bindingFailures.set(id, error);
        const binding = source.bindings.get(id);
        for (const month of periods) recordFailure({ month_utc: month.month_utc, timeseries_id: id,
          connector_id: binding?.connector_id || null, pollutant_code: binding?.pollutant_code || null },
        'binding_or_verification_authority', failureReason(error), { message: error.message });
      }
    }
    function* workUnits() {
      for (const month of periods) for (const connectorId of options.connectors) for (const pollutant of options.pollutants) {
        yield { month, connectorId, pollutant };
      }
    }
    for (const { month, connectorId, pollutant } of workUnits()) {
      const groupBegan = performance.now(), candidatesBefore = stagedCandidates.length;
      active = { connector_id: connectorId, pollutant_code: pollutant, month_utc: month.month_utc };
      try {
        const monthCurrentness = periodCurrentness.get(month.month_utc);
        const needsPmContext = pollutant === 'pm25' || pollutant === 'pm10';
        const admission = classifyPeriodCurrentness(monthCurrentness, monthCurrentness.canonical, needsPmContext);
        if (!admission.month_matches) {
          recordCurrentnessFailures(active, monthCurrentness.canonical, 'initial_currentness', needsPmContext);
          continue;
        }
        const contextStart = needsPmContext
          ? new Date(Date.parse(month.requested_start_utc) - DAY).toISOString()
          : month.requested_start_utc;
        const sourceScope = sourceScopeProof.scopes.find(scope => scope.month_utc === month.month_utc);
        const terminalDay = month.requested_end_exclusive_utc.slice(0, 10);
        const terminalSourceDay = sourceScope.source_terminal_days[0];
        let terminalSourceEstablished = authenticatedTerminalSourceDay(terminalSourceDay, terminalDay);
        const terminalDependency = { dependency_role: 'aqi_terminal_endpoint',
          endpoint_utc: month.requested_end_exclusive_utc, day_utc: terminalDay,
          proof_method: 'completed_timestamp_day', source_day: terminalSourceDay,
          source_authority_established: terminalSourceEstablished,
          state: terminalSourceEstablished ? 'authenticated_source_day' : 'pending_terminal_source_authority',
          limitation: 'no partial_timestamp_day_or_exact_midnight_authority_implemented' };
        const groups = new Map(), days = [], files = [], selectedIds = options.timeseries
          ? new Set(options.timeseries.filter(id => !bindingFailures.has(id))) : null;
        let selectedRows = 0;
        const group = async id => {
          if (!groups.has(id)) {
            const binding = await source.binding(id, connectorId, pollutant);
            groups.set(id, { binding, rows: [], schemas: new Map() });
          }
          return groups.get(id);
        };
        if (selectedIds) for (const id of selectedIds) {
          const b = source.bindings.get(id);
          if (b.connector_id === connectorId && b.pollutant_code === pollutant) await group(id);
        }
        const authority = await source.authority(connectorId);
        const sourceDays = daysBetween(contextStart, month.requested_end_exclusive_utc);
        if (terminalSourceEstablished) sourceDays.push(terminalDay);
        let shared = null;
        if (bulk) {
          shared = await bulk.prepare(month, connectorId, pollutant, contextStart, terminalSourceEstablished);
          days.push(...shared.days); files.push(...shared.files);
          terminalSourceEstablished &&= days.some(day => day.dependency_role === 'aqi_terminal_endpoint'
            && ['authenticated_membership', 'authoritative_absence'].includes(day.source_state));
          terminalDependency.source_authority_established = terminalSourceEstablished;
          terminalDependency.state = terminalSourceEstablished ? 'authenticated_source_day' : 'pending_terminal_source_authority';
        } else {
          for (const day of sourceDays) {
            active.day_utc = day;
            reader.deadline();
            const dependencyRole = day === terminalDay ? 'aqi_terminal_endpoint'
              : day < month.requested_start_utc.slice(0, 10) ? 'pm_rolling_context' : 'raw_observations';
            const manifest = await source.pollutant(day, connectorId, pollutant);
            if (!manifest) { days.push({ day_utc: day, state: 'authoritative_absence',
              dependency_role: dependencyRole, source_state: 'authoritative_absence', row_count: 0 }); continue; }
            for (const physical of observationHistoryPhysicalSchemasFromManifest(manifest)) source.assertStatusMode(physical, connectorId, authority);
            const before = selectedRows, perSeries = new Map();
            for (const file of manifest.files) {
              check(stats.rows_decoded + file.row_count <= options.limits.decodedRows, 'decoded-row limit exceeded');
              const beforeCpu = process.cpuUsage();
              await decodeCanonicalObservations(reader, file, manifest, null, {
                connectorId, pollutant, day, timeseriesIds: selectedIds, maxFileRows: options.limits.fileRows,
                requireMillisecondTimestamps: true,
                resolveBinding: async id => source.binding(id, connectorId, pollutant),
                onRow: async (row, physical) => {
                  source.assertStatusMode(physical, connectorId, authority);
                  const entry = authority.manifest?.timeseries.find(t => t.timeseries_id === row.timeseries_id);
                  if (entry) check(entry.station_id === source.bindings.get(row.timeseries_id).station_id
                    && entry.pollutant_code === pollutant, 'verification/physical binding identity mismatch');
                  check(++selectedRows <= options.limits.selectedRows, 'selected-row memory limit exceeded; select a smaller batch');
                  perSeries.set(row.timeseries_id, (perSeries.get(row.timeseries_id) || 0) + 1);
                  // Authenticate/count the whole admitted source day, but retain
                  // only E from the terminal day as a calculation dependency.
                  if (day === terminalDay && row.observed_at_utc !== month.requested_end_exclusive_utc) return;
                  const target = await group(row.timeseries_id);
                  target.rows.push(row);
                  if (dependencyRole === 'raw_observations') target.schemas.set(JSON.stringify(physical), physical);
                },
              }, authority, stats);
              const used = process.cpuUsage(beforeCpu);
              stats.decode_cpu_ms += (used.user + used.system) / 1000;
              files.push({ ...reader.inventory.get(file.key), dependency_role: dependencyRole });
            }
            if (manifest.timeseries_row_counts) for (const [id, count] of Object.entries(manifest.timeseries_row_counts)) {
              if (!selectedIds || selectedIds.has(Number(id))) check((perSeries.get(Number(id)) || 0) === count,
                'selected physical-series canonical row count mismatch');
            }
            if (manifest.timeseries_row_counts) check([...perSeries.keys()].every(id => Object.hasOwn(manifest.timeseries_row_counts, String(id))),
              'canonical timeseries counts omit decoded physical identity');
            days.push({ day_utc: day, state: 'exported', source_state: 'authenticated_membership',
              dependency_role: dependencyRole, row_count: selectedRows - before });
          }
        }
        delete active.day_utc;
        if (!terminalSourceEstablished && !days.some(day => day.dependency_role === 'aqi_terminal_endpoint')) days.push({ day_utc: terminalDay,
          dependency_role: 'aqi_terminal_endpoint', state: 'pending_terminal_source_authority',
          source_state: 'not_established', row_count: 0 });
        terminalDependency.day_accounting = days.filter(day => day.dependency_role === 'aqi_terminal_endpoint');
        terminalDependency.source_bytes_authenticated = terminalSourceEstablished;
        await retainMetadata();
        const sourceEvidence = await contentJson('evidence/source-evidence', {
          schema_version: 1, kind: 'uk_aq_jsongen_dropbox_bootstrap_source_evidence', environment: 'TEST',
          source: reader.sourceRoot, source_checkpoint: source.checkpoint, scope: active, month,
          currentness_initial: monthCurrentness.canonical,
          verification_binding_authority: report.verification_binding_authority,
          current_authority: source.current_authority, index_v3_trees: 'excluded_from_backup_not_read_or_rebuilt',
          verification_mode: options.verificationModes[connectorId], verification_mode_provenance: source.verification_mode_provenance,
          verification: { overlay_authoritative: authority.overlay_authoritative,
            latest_identity: authority.latest_identity || null, manifest_identity: authority.manifest_identity || null },
          physical_bindings: [...groups.keys()].sort((a,b) => a-b).map(id => source.memberEvidence.get(id)),
          physical_binding_authority: 'authenticated_backup_pack_membership_corroborated_by_physical_rows; matching_Core_publication_not_independently_authenticated',
          metadata_objects: [...reader.metadata.values()].sort((a,b) => a.key.localeCompare(b.key)),
          consumed_parquet: files, days, context_start_utc: contextStart,
          terminal_dependency: terminalDependency,
          raw_source_status_rule: 'embedded verification_status is never represented as original provider status',
          source_timestamp_precision: 'canonical millisecond UTC; no rounding or truncation',
        });
        for (const [timeseriesId, groupValue] of [...groups].sort(([a],[b]) => a-b)) {
          reader.deadline();
          const candidateScope = { ...active, timeseries_id: timeseriesId };
          try {
            if (shared) {
              groupValue.rows = await shared.rowsFor(timeseriesId);
              groupValue.schemas = shared.schemas;
            }
            const candidateDays = shared ? shared.daysFor(timeseriesId) : days;
            const candidateTerminalSourceComplete = terminalSourceEstablished
              && candidateDays.filter(day => day.dependency_role === 'aqi_terminal_endpoint')
                .every(day => ['authenticated_membership', 'authoritative_absence'].includes(day.source_state));
            const candidateTerminalDependency = { ...terminalDependency,
              source_authority_established: candidateTerminalSourceComplete,
              source_bytes_authenticated: candidateTerminalSourceComplete,
              day_accounting: candidateDays.filter(day => day.dependency_role === 'aqi_terminal_endpoint') };
            const rawSourceComplete = candidateDays.filter(day => day.dependency_role === 'raw_observations')
              .every(day => ['authenticated_membership', 'authoritative_absence'].includes(day.source_state));
            if (!admission.matches) recordCurrentnessFailures(candidateScope,
              monthCurrentness.canonical, 'initial_currentness', needsPmContext, rawSourceComplete);
            const identity = assertIdentity({ connector_id: connectorId, timeseries_id: timeseriesId,
              station_id: groupValue.binding.station_id, pollutant_code: pollutant });
            const rows = sortedRows(groupValue.rows);
            const visible = rows.filter(r => r.observed_at_utc >= month.requested_start_utc && r.observed_at_utc < month.requested_end_exclusive_utc);
            const context = rows.filter(r => r.observed_at_utc < month.requested_start_utc);
            const terminal = rows.filter(r => r.observed_at_utc === month.requested_end_exclusive_utc);
            const pubID = newPubID();
            const algorithm = { version: AQI_ALGORITHM_VERSION, daqi_pm_window_hours: DAQI_PM_ROLLING24H_WINDOW_HOURS,
              daqi_pm_required_valid_hours: DAQI_PM_ROLLING24H_REQUIRED_HOURS,
              endpoint_convention: 'hour-ending (n-1h,n]; requested_start < n <= requested_end',
              dependency_start_utc: contextStart,
              dependency_end_exclusive_utc: new Date(Date.parse(month.requested_end_exclusive_utc) + 1).toISOString(),
              terminal_dependency: candidateTerminalDependency,
              dependency_evidence: sourceEvidence, preceding_managed_publication: null };
            const common = { schema_version: 1, environment: 'TEST', pub_id: pubID, identity, month_utc: month.month_utc,
              source_checkpoint: source.checkpoint, source_evidence: sourceEvidence, calculation_dependencies: algorithm,
              publication_state: 'local_private_candidate_not_managed_publication', coverage: month };
            const provenance = [...new Set(visible.map(r => r.source_status_provenance))].sort();
            const unique = new Set(visible.map(r => r.observed_at_utc)).size;
            const observations = { ...common, kind: 'uk_aq_jsongen_bootstrap_observations_candidate',
              physical_schemas: [...groupValue.schemas.values()], source_status_provenance: provenance.length ? provenance : ['no_source_rows'],
              canonical_row_multiplicity_preserved: true,
            completeness: { requested_source_complete: rawSourceComplete, full_calendar_month: !month.partial_month,
                currentness_evidence_in_candidate_descriptor: true,
                row_count: visible.length, unique_timestamp_count: unique, duplicate_timestamp_row_count: visible.length - unique,
                days: candidateDays.filter(d => d.day_utc >= month.requested_start_utc.slice(0,10)
                  && d.day_utc < month.requested_end_exclusive_utc.slice(0,10)).map(d => ({
                  day_utc: d.day_utc, source_state: d.source_state,
                  measurement_state: !['authenticated_membership', 'authoritative_absence'].includes(d.source_state)
                    ? 'source_coverage_not_established' : visible.some(row => row.observed_at_utc.startsWith(d.day_utc))
                    ? 'measurements_present' : 'natural_measurement_gap',
                  row_count: visible.filter(r => r.observed_at_utc.startsWith(d.day_utc)).length })) },
              row_columns: ['observed_at_utc', 'value', 'station_id', 'source_status', 'verification_status',
                'embedded_verification_status', 'source_status_provenance'],
              observations: visible.map(r => [r.observed_at_utc, r.value, r.station_id, r.source_status,
                r.verification_status, r.embedded_verification_status, r.source_status_provenance]) };
            const aqBegin = performance.now(), aqCpu = process.cpuUsage();
            let calculated;
            try {
              const result = { binding: groupValue.binding, rows: tuples(visible), contextRows: tuples(context),
                terminalRows: tuples(terminal),
                days: candidateDays.filter(d => d.dependency_role === 'raw_observations'),
                terminalDays: candidateDays.filter(d => d.dependency_role === 'aqi_terminal_endpoint'),
                contextDays: needsPmContext
                  ? candidateDays.filter(d => d.day_utc < month.requested_start_utc.slice(0,10)) : [],
                state: rawSourceComplete ? 'complete' : 'incomplete', generation: 'v3', bucket: 'dropbox_backup_not_r2', evidence: sourceEvidence };
              calculated = await calculateMonthAqi(result, month, { pollutant, timeseriesId, contextStart });
            } catch (error) {
              rethrowInvocationFault(error);
              // Preserve authenticated raw rows, including conflicting duplicates
              // or nullable stations; the shared AQI path must reject unsafe input.
              calculated = { rejection_reason: error.message, aqi: { rows: [], response_complete: false, has_gap: true, gap_ranges: [],
                partial_reasons: ['shared_station_history_aqi_rejected_input'] }, coverage: { daily_batches: [] } };
            } finally {
              const used = process.cpuUsage(aqCpu);
              report.aqi_calculation_wall_ms += performance.now() - aqBegin;
              report.aqi_calculation_cpu_ms += (used.user + used.system) / 1000;
            }
            const endpoints = aqiEndpointCompleteness(calculated.aqi, month.requested_start_utc,
              month.requested_end_exclusive_utc, calculated.coverage.daily_batches);
            const aqi = { ...common, kind: 'uk_aq_jsongen_bootstrap_aqi_candidate',
              algorithm_version: AQI_ALGORITHM_VERSION, daily_batches: calculated.coverage.daily_batches,
              // Original exact-E inputs retain identity, statuses and provenance
              // as derived dependencies, outside the raw [S,E) observation product.
              terminal_source_inputs: terminal,
              completeness: { response_complete: calculated.aqi.response_complete,
                endpoints,
                daqi: indexCompleteness(calculated.aqi, 'daqi', endpoints),
                eaqi: indexCompleteness(calculated.aqi, 'eaqi', endpoints),
                terminal_source_complete: candidateTerminalSourceComplete,
                terminal_dependency: { ...candidateTerminalDependency, input_row_count: terminal.length },
                context_source_complete: !needsPmContext || (candidateDays.filter(d => d.dependency_role === 'pm_rolling_context').length === 1
                  && candidateDays.filter(d => d.dependency_role === 'pm_rolling_context')
                    .every(d => ['authenticated_membership', 'authoritative_absence'].includes(d.source_state))),
                context_day_accounting: needsPmContext
                  ? candidateDays.filter(d => d.day_utc < month.requested_start_utc.slice(0,10)) : [],
                currentness_evidence_in_candidate_descriptor: true, partial_reasons: calculated.aqi.partial_reasons,
                calculation_error: calculated.rejection_reason || null }, aqi: calculated.aqi };
            const prefix = `candidates/${publicationPrefix(identity, month.month_utc, pubID)}`;
            const observationRef = await gzipProduct(prefix, 'observations', observations);
            const aqiRef = await gzipProduct(prefix, 'aqi', aqi);
            const candidate = { ...common, kind: 'uk_aq_jsongen_bootstrap_monthly_pair_candidate',
              observations: observationRef, aqi: aqiRef, observation_count: visible.length,
              observation_completeness: observations.completeness, aqi_completeness: aqi.completeness,
              currentness: { initial: { ...monthCurrentness.canonical,
                result: classifyPeriodCurrentness(sourceScope, monthCurrentness.canonical, needsPmContext) }, final: null },
              proposed_publication_keys: { observations: `${publicationPrefix(identity, month.month_utc, pubID)}/observations.${observationRef.sha256}.json.gz`,
                aqi: `${publicationPrefix(identity, month.month_utc, pubID)}/aqi.${aqiRef.sha256}.json.gz` },
              managed_publication_eligible: false, local_candidate_complete: false,
              manual_review_eligible: false,
              completion_rule: 'requires final invocation COMPLETE.json, matching report and candidate manifest',
              unresolved_authority: ['all_writer_publication_freshness_unknown',
                'independent_current_verification_transition_authority_unresolved',
                'matching_core_publication_not_independently_authenticated',
                'no_authenticated_managed_monthly_baseline', 'no_managed_preceding_month_publication'] };
            const summary = { identity, month_utc: month.month_utc, included_start_utc: month.requested_start_utc,
              included_end_exclusive_utc: month.requested_end_exclusive_utc, partial_month: month.partial_month,
              aqi_first_endpoint_utc: endpoints.first_endpoint_utc, aqi_last_endpoint_utc: endpoints.last_endpoint_utc,
              observation_count: visible.length, aqi_row_count: calculated.aqi.rows.length,
              aqi_response_complete: calculated.aqi.response_complete, source_complete: rawSourceComplete,
              context_complete: aqi.completeness.context_source_complete, local_candidate_complete: false,
              candidate: null,
              aqi_completeness: aqi.completeness,
              observations: observationRef, aqi: aqiRef, pub_id: pubID };
            stagedCandidates.push({ prefix, candidate, summary, month_utc: month.month_utc,
              connector_id: connectorId, pollutant_code: pollutant, timeseries_id: timeseriesId,
              source_object_keys: files.map(file => file.key),
              raw_source_object_keys: files.filter(file => file.dependency_role === 'raw_observations').map(file => file.key),
              raw_complete: rawSourceComplete,
              generation_failures: candidateDays.filter(day => day.failure).map(day => ({
                key: day.failure.source_key, reason: day.failure.message, dependency_role: day.dependency_role, stage: 'source_read',
                day_utc: day.day_utc })),
              aqi_complete: calculated.aqi.response_complete && endpoints.complete
                && aqi.completeness.daqi.evaluated_complete && aqi.completeness.eaqi.evaluated_complete,
              terminal_complete: candidateTerminalSourceComplete,
              context_complete: aqi.completeness.context_source_complete });
            report.observation_count += visible.length;
          } catch (error) {
            rethrowInvocationFault(error);
            recordFailure(candidateScope, 'candidate_generation', failureReason(error), { message: error.message });
          } finally {
            // The source-day spools remain reusable; release the candidate's
            // only in-memory month before opening the next physical series.
            groupValue.rows = [];
          }
        }
        report.completed_periods.push({ ...active, start_utc: month.requested_start_utc,
          end_exclusive_utc: month.requested_end_exclusive_utc, source_complete: days.filter(day => day.dependency_role === 'raw_observations')
            .every(day => ['authenticated_membership', 'authoritative_absence'].includes(day.source_state)),
          full_calendar_month: !month.partial_month,
          selected_day_accounting: days.filter(d => d.day_utc >= month.requested_start_utc.slice(0,10)
            && d.day_utc < month.requested_end_exclusive_utc.slice(0,10)),
          pm_context_day_accounting: days.filter(d => d.day_utc < month.requested_start_utc.slice(0,10)),
          terminal_dependency: terminalDependency,
          physical_series_failure_count: days.reduce((sum, day) => sum + (day.physical_series_failures?.length || 0), 0),
          physical_series_count: groups.size, candidate_count: stagedCandidates.length - candidatesBefore });
      } catch (error) {
        rethrowInvocationFault(error);
        const key = scopeKey(active);
        failedScopes.set(key, error.message);
        recordFailure(active, 'source_read', failureReason(error), { message: error.message,
          currentness: periodCurrentness.get(month.month_utc)?.canonical || null });
      } finally {
        if (bulk) {
          bulk.groupMetrics(month.month_utc, connectorId, pollutant).total_group_wall_ms = performance.now() - groupBegan;
          await bulk.releaseCompleted(month, connectorId, pollutant);
        }
      }
    }
    check(stagedCandidates.length > 0 || report.incomplete_scopes.length > 0,
      'no physical candidates resolved; explicitly select timeseries for authenticated empty output');
    // Revalidate the original pinned source proof outside the global lock.
    // Mutable global checkpoint/root/year objects are retained as original
    // evidence, but are not required to remain byte-identical for unrelated
    // months. Complete months recheck their month identity; partial scopes
    // recheck only selected day leaves. Parquet cache bytes are locally rehashed.
    const networkConsumers = new Map(), cachedConsumers = new Map();
    const addConsumer = (map, key, candidate) => {
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(candidate);
    };
    for (const staged of stagedCandidates) {
      const proofKeys = scopedSourceStabilityKeys(source, sourceScopeProof, reader, staged,
        [staged.timeseries_id], staged.pollutant_code === 'pm25' || staged.pollutant_code === 'pm10');
      const rawProofKeys = scopedSourceStabilityKeys(source, sourceScopeProof, reader, staged,
        [staged.timeseries_id], false, false);
      staged.raw_proof_keys = new Set([...rawProofKeys.network_keys,
        ...rawProofKeys.cached_proof_keys, ...staged.raw_source_object_keys]);
      const networkKeys = new Set(proofKeys.network_keys);
      const cachedKeys = new Set([...proofKeys.cached_proof_keys, ...proofKeys.network_keys,
        ...staged.source_object_keys]);
      for (const key of networkKeys) addConsumer(networkConsumers, key, staged);
      for (const key of cachedKeys) addConsumer(cachedConsumers, key, staged);
    }
    const sourceFailures = new Map(stagedCandidates.filter(staged => staged.generation_failures.length)
      .map(staged => [staged, [...staged.generation_failures]]));
    const rawSourceFailures = new Map(stagedCandidates.filter(staged => staged.generation_failures
      .some(failure => failure.dependency_role === 'raw_observations'))
      .map(staged => [staged, staged.generation_failures.filter(failure => failure.dependency_role === 'raw_observations')]));
    const failSourceConsumers = (key, error, consumers) => {
      for (const staged of consumers || stagedCandidates) {
        if (!sourceFailures.has(staged)) sourceFailures.set(staged, []);
        sourceFailures.get(staged).push({ key, reason: error.message });
        if (staged.raw_proof_keys.has(key)) {
          if (!rawSourceFailures.has(staged)) rawSourceFailures.set(staged, []);
          rawSourceFailures.get(staged).push({ key, reason: error.message });
        }
      }
    };
    try { await reader.verifyCachedObjects([CHECKPOINT_KEY]); }
    catch (error) { throw new Error(`original selected checkpoint proof failed: ${error.message}`, { cause: error }); }
    for (const [key, consumers] of cachedConsumers) {
      if (key === CHECKPOINT_KEY) continue;
      try { await reader.verifyCachedObjects([key]); }
      catch (error) { rethrowInvocationFault(error); failSourceConsumers(key, error, consumers); }
    }
    for (const [key, consumers] of networkConsumers) {
      try { await reader.checkSelectedStability([key]); }
      catch (error) { rethrowInvocationFault(error); failSourceConsumers(key, error, consumers); }
    }
    report.source_stability.original_checkpoint_cached_proof = 'verified';
    const checkpointKeyStillPinned = reader.inventory.get(CHECKPOINT_KEY)?.sha256 === options.checkpointSha256;
    if (!checkpointKeyStillPinned) throw new Error('original selected checkpoint bytes are not present at their pinned identity');
    try {
      const currentCheckpoint = await reader.readCurrentDigest(CHECKPOINT_KEY);
      report.source_stability.current_checkpoint = currentCheckpoint.sha256 === options.checkpointSha256
        ? { state: 'unchanged', ...currentCheckpoint }
        : { state: 'changed_not_adopted_scope_results_decide', ...currentCheckpoint };
    } catch (error) {
      rethrowInvocationFault(error);
      report.source_stability.current_checkpoint = { state: 'not_established', reason: error.message };
    }
    report.source_stability.final_checkpoint_reread_at_utc = new Date().toISOString();
    report.source_stability.selected_scopes = stagedCandidates.map(staged => ({
      scope: scopeKey(staged), timeseries_id: staged.timeseries_id,
      state: sourceFailures.has(staged) ? 'not_established' : 'original_selected_proof_revalidated',
      raw_observation_state: rawSourceFailures.has(staged) ? 'not_established' : 'original_selected_proof_revalidated',
      terminal_endpoint_utc: staged.candidate.calculation_dependencies.terminal_dependency.endpoint_utc,
      terminal_source_object_keys: staged.source_object_keys.filter(key => key.includes(
        `/day_utc=${staged.candidate.calculation_dependencies.terminal_dependency.day_utc}/`)),
      failures: sourceFailures.get(staged) || [],
    }));
    const finalStarted = performance.now();
    // The final lock callback contains only bounded canonical R2 reads and
    // selected month/day comparisons. No Dropbox network or source-byte work.
    const final = await withBootstrapObservationLock(async lock => {
      const canonical = await readCurrentObservationScopes(sourceScopeProof.scopes, {
        env: process.env, signal: lock.signal, assertHeld: () => { lock.assertHeld(); reader.deadline(); },
      });
      return { canonical };
    }, { env: process.env, runId: report.invocation_id, diagnostics: report.operation_lock.final });
    report.scoped_currentness_r2_reads.count += final.canonical.reads.length;
    report.scoped_currentness_r2_reads.bytes += final.canonical.reads.reduce((sum, read) => sum + read.byte_size, 0);
    report.scoped_currentness_r2_reads.wall_ms += performance.now() - finalStarted;
    report.canonical_r2_reads += final.canonical.reads.length;
    const finalByMonth = new Map(sourceScopeProof.scopes.map((scope, index) => [scope.month_utc,
      { ...final.canonical.scopes[index], result: classifyPeriodCurrentness(scope, final.canonical.scopes[index]) }]));
    report.currentness.final = { checked_at_utc: final.canonical.checked_at_utc,
      checkpoint_sha256: source.checkpoint.sha256,
      canonical_root: final.canonical.root,
      canonical_root_content_hash: final.canonical.root_content_hash,
      r2_manifest_reads: final.canonical.reads,
      scopes: [...finalByMonth.values()].map(scope => ({ month_utc: scope.month_utc,
        result: scope.result, currentness: scope.currentness, context_days: scope.context_days,
        terminal_days: scope.terminal_days,
        canonical_scope: scope.canonical_scope })) };
    const rootHashChanged = report.currentness.start.canonical_root_content_hash
      !== final.canonical.root_content_hash;
    report.currentness.canonical_root_hash_changed = rootHashChanged;
    report.currentness.unrelated_root_advance = rootHashChanged
      && [...finalByMonth.values()].every(scope => scope.result.matches
        && periodCurrentness.get(scope.month_utc)?.result.matches === true);
    report.currentness.status = [...finalByMonth.values()].every(scope => scope.result.matches
      && periodCurrentness.get(scope.month_utc)?.result.matches === true)
      ? 'initial_and_final_scoped_checks_match' : 'initial_or_final_scoped_mismatch';
    report.currentness.scope_results = [...finalByMonth.values()].map(scope => ({ month_utc: scope.month_utc,
      mode: scope.currentness.mode, start_matches: periodCurrentness.get(scope.month_utc)?.result.matches === true,
      final_matches: scope.result.matches,
      raw_start_matches: periodCurrentness.get(scope.month_utc)?.result.month_matches === true,
      raw_final_matches: scope.result.month_matches,
      terminal_start_matches: periodCurrentness.get(scope.month_utc)?.result.terminal_matches === true,
      terminal_final_matches: scope.result.terminal_matches }));
    await retainMetadata();
    for (const staged of stagedCandidates) {
      const canonicalScope = finalByMonth.get(staged.month_utc);
      const sourceScope = sourceScopeProof.scopes.find(scope => scope.month_utc === staged.month_utc);
      const needsPmContext = staged.pollutant_code === 'pm25' || staged.pollutant_code === 'pm10';
      const finalResult = canonicalScope && sourceScope
        ? classifyPeriodCurrentness(sourceScope, canonicalScope, needsPmContext) : { matches: false };
      const finalScope = canonicalScope ? { ...canonicalScope, result: finalResult } : null;
      const startResult = periodCurrentness.get(staged.month_utc)?.result;
      const initiallyCurrent = startResult?.month_matches === true
        && (!needsPmContext || startResult.context_matches === true) && startResult.terminal_matches === true;
      const sourceFailure = sourceFailures.get(staged) || [];
      const rawSourceFailure = rawSourceFailures.get(staged) || [];
      const generationFailure = failedScopes.get(scopeKey(staged))
        || failedScopes.get(scopeKey({ ...staged, timeseries_id: undefined })) || null;
      const rawComplete = startResult?.month_matches === true && finalResult.month_matches === true
        && staged.raw_complete && rawSourceFailure.length === 0 && !generationFailure;
      const localComplete = initiallyCurrent && finalScope?.result.matches === true
        && finalResult.matches === true && canonicalScope?.proof_state === 'established'
        && sourceFailure.length === 0 && !generationFailure
        && staged.raw_complete && staged.aqi_complete && staged.context_complete && staged.terminal_complete;
      if (!finalResult.matches) recordCurrentnessFailures({ month_utc: staged.month_utc,
        ...staged.summary.identity }, canonicalScope, 'final_currentness', needsPmContext, rawComplete);
      for (const failure of sourceFailure) recordFailure({ month_utc: staged.month_utc,
        ...staged.summary.identity }, failure.stage || 'source_revalidation', failureReason({ message: failure.reason }),
      { source_key: failure.key, message: failure.reason, dependency_role: failure.dependency_role || null,
        day_utc: failure.day_utc || failure.key?.match(/day_utc=(\d{4}-\d{2}-\d{2})\//)?.[1] || null,
        original_source_identity: reader.inventory.get(failure.key) || null,
        currentness: finalScope,
        raw_observation_candidate_complete: rawComplete });
      staged.candidate.currentness.final = finalScope || null;
      staged.candidate.source_stability = { state: sourceFailure.length ? 'not_established'
        : generationFailure ? 'scope_generation_failed' : 'original_selected_proof_revalidated',
        failures: sourceFailure, generation_failure: generationFailure,
        raw_observation_state: rawSourceFailure.length ? 'not_established' : 'original_selected_proof_revalidated',
        raw_observation_failures: rawSourceFailure };
      staged.candidate.raw_observation_candidate_complete = rawComplete;
      staged.candidate.derived_aqi_candidate_complete = localComplete;
      staged.candidate.local_candidate_complete = localComplete;
      staged.candidate.manual_review_eligible = localComplete;
      staged.candidate.completion_rule = 'requires final invocation COMPLETE.json, matching report and candidate manifest';
      staged.summary.local_candidate_complete = localComplete;
      staged.summary.raw_observation_candidate_complete = rawComplete;
      staged.summary.derived_aqi_candidate_complete = localComplete;
      try {
        staged.summary.candidate = await contentJson(`${staged.prefix}/candidate`, staged.candidate);
      } catch (error) {
        rethrowInvocationFault(error);
        staged.candidate.local_candidate_complete = false;
        staged.candidate.raw_observation_candidate_complete = false;
        staged.candidate.derived_aqi_candidate_complete = false;
        staged.candidate.manual_review_eligible = false;
        staged.summary.local_candidate_complete = false;
        staged.summary.raw_observation_candidate_complete = false;
        staged.summary.derived_aqi_candidate_complete = false;
        report.candidates.push({ ...staged.summary, candidate: null,
          staged_products: { observations: staged.candidate.observations, aqi: staged.candidate.aqi } });
        report.errors.push({ scope: staged.candidate.identity, message: error.message });
        report.incomplete_scopes.push({ month_utc: staged.month_utc,
          identity: staged.summary.identity, stage: 'candidate_output',
          reason: 'candidate_descriptor_write_failed', message: error.message });
        continue;
      }
      report.candidates.push({ ...staged.summary });
      if (localComplete) report.successful_scopes.push({ month_utc: staged.month_utc,
        identity: staged.summary.identity, currentness: finalScope });
      else report.incomplete_scopes.push({ month_utc: staged.month_utc,
        identity: staged.summary.identity,
        stage: sourceFailure.length ? (sourceFailure[0].stage || 'source_revalidation')
          : !initiallyCurrent ? 'initial_currentness' : !finalResult.matches ? 'final_currentness' : 'aqi_calculation',
        reason: generationFailure ? 'source_scope_generation_failed'
          : sourceFailure.length ? 'selected_source_revalidation_not_established'
            : !staged.terminal_complete ? 'pending_terminal_source_authority'
              : !startResult?.terminal_matches || !finalResult.terminal_matches ? 'terminal_dependency_currentness_mismatch'
            : finalScope?.proof_state !== 'established' ? 'final_currentness_not_established'
              : 'final_local_candidate_gate_failed',
        currentness: finalScope, aqi_complete: staged.aqi_complete,
        context_complete: staged.context_complete, terminal_complete: staged.terminal_complete,
        raw_observation_candidate_complete: rawComplete, source_failures: sourceFailure });
    }
    if (bulk) bulk.finishDiscovery();
    const inventoryComplete = reconcileInventoryCompletion();
    reconcileRequestedCandidates();
    if (report.month_plan) for (const plan of report.month_plan.plans) {
      plan.currentness_initial = report.currentness.start.scopes.find(scope => scope.month_utc === plan.month_utc) || null;
      plan.currentness_final = report.currentness.final.scopes.find(scope => scope.month_utc === plan.month_utc) || null;
      plan.successful_scope_count = report.successful_scopes.filter(scope => scope.month_utc === plan.month_utc).length;
      plan.incomplete_scope_count = report.incomplete_scopes.filter(scope => scope.month_utc === plan.month_utc).length;
      plan.result = plan.incomplete_scope_count ? 'incomplete' : 'local_candidates_complete';
    }
    const allRequestedProduced = !report.requested_candidates || report.requested_candidates.every(requested =>
      report.candidates.some(candidate => candidate.month_utc === requested.month_utc
        && candidate.identity.timeseries_id === requested.timeseries_id));
    const manifest = await contentJson('candidate-manifest', { schema_version: 1,
      kind: 'uk_aq_jsongen_dropbox_bootstrap_candidate_manifest', environment: 'TEST',
      source_checkpoint: source.checkpoint, requested_period: report.requested_period, month_plan: report.month_plan,
      discovery: report.discovery || null,
      source_complete: allRequestedProduced && inventoryComplete && report.completed_periods.length === periods.length * options.connectors.length * options.pollutants.length
        && !report.month_plan?.plans.some(plan => plan.state === 'incomplete')
        && report.candidates.length > 0
        && report.candidates.every(candidate => candidate.raw_observation_candidate_complete),
      terminal_source_complete: allRequestedProduced && inventoryComplete && report.completed_periods.length === periods.length * options.connectors.length * options.pollutants.length
        && !report.month_plan?.plans.some(plan => plan.state === 'incomplete')
        && report.candidates.every(candidate => candidate.aqi_completeness.terminal_source_complete)
        && report.completed_periods.every(period => period.terminal_dependency.source_authority_established),
      aqi_complete: inventoryComplete && report.candidates.length > 0 && report.incomplete_scopes.length === 0
        && report.candidates.every(candidate => candidate.derived_aqi_candidate_complete),
      currentness: report.currentness,
      publication_state: 'local_private_candidate_not_managed_publication',
      managed_publication_eligible: false, candidates: report.candidates });
    report.manifest = manifest;
    const complete = inventoryComplete && stagedCandidates.length > 0 && report.incomplete_scopes.length === 0
      && stagedCandidates.every(candidate => candidate.candidate.local_candidate_complete);
    report.state = complete ? 'local_candidates_complete' : 'incomplete';
    report.eligible_for_further_manual_review = complete;
  } catch (error) {
    report.state = 'failed';
    recordFailure({ invocation_wide: true }, 'invocation', failureReason(error), {
      active_scope: active, source_key: error.sourceKey || null,
      message: error.message, requested_period: report.requested_period });
    const reportedCandidateIds = new Set(report.candidates.map(candidate => candidate.pub_id));
    for (const staged of stagedCandidates) {
      if (reportedCandidateIds.has(staged.summary.pub_id)) continue;
      staged.candidate.local_candidate_complete = false;
      staged.candidate.raw_observation_candidate_complete = false;
      staged.candidate.derived_aqi_candidate_complete = false;
      staged.candidate.manual_review_eligible = false;
      staged.summary.local_candidate_complete = false;
      staged.summary.raw_observation_candidate_complete = false;
      staged.summary.derived_aqi_candidate_complete = false;
      report.candidates.push({ ...staged.summary, candidate: null,
        staged_products: { observations: staged.candidate.observations, aqi: staged.candidate.aqi } });
      report.incomplete_scopes.push({ month_utc: staged.month_utc,
        identity: staged.summary.identity, stage: 'invocation', reason: 'final_candidate_gate_not_completed' });
    }
  } finally {
    clearInterval(progress);
    if (options.allEligible && !report.requested_candidates && report.discovery) {
      report.requested_candidates = options.monthSelection.periods.flatMap(period => report.discovery.selected
        .map(identity => ({ month_utc: period.month_utc, timeseries_id: identity.timeseries_id, state: 'pending' })));
      report.inventory_unresolved_scopes = options.monthSelection.periods.flatMap(period => options.pollutants.map(pollutant => ({
        month_utc: period.month_utc, connector_id: 1, pollutant_code: pollutant,
        state: 'inventory_not_fully_established_no_complete_cross_batch_claim' })));
    }
    reconcileRequestedCandidates();
    if (bulk) bulk.finishDiscovery();
    if (!reconcileInventoryCompletion()) {
      if (report.state !== 'failed') report.state = 'incomplete';
      report.eligible_for_further_manual_review = false;
    }
    report.failure_summary = { incomplete_record_count: report.incomplete_scopes.length,
      affected_months: [...new Set(report.incomplete_scopes.map(scope => scope.month_utc).filter(Boolean))].sort(),
      reasons: [...new Set(report.incomplete_scopes.map(scope => scope.reason))].sort() };
    const used = process.cpuUsage(cpu);
    report.wall_ms = performance.now() - begun; report.cpu_ms = (used.user + used.system) / 1000;
    report.metrics = { ...reader.metrics, ...stats, ...disk.metrics, bulk: bulk?.metrics || null,
      completed_monthly_candidates: report.candidates.filter(candidate => candidate.local_candidate_complete).length,
      incomplete_monthly_candidates: report.requested_candidates
        ? report.requested_candidates.filter(candidate => !report.candidates.some(result => result.month_utc === candidate.month_utc
          && result.identity.timeseries_id === candidate.timeseries_id && result.local_candidate_complete)).length
        : report.candidates.filter(candidate => !candidate.local_candidate_complete).length,
      physical_series: source?.bindings.size || 0, physical_schemas: [...stats.physical_schemas.values()],
      process_max_rss_bytes: process.resourceUsage().maxRSS * 1024,
      source_object_count: reader.inventory.size,
      cpu_measurement: 'Node process CPU; rclone child CPU and HTTP overhead are not measured; decode includes row authentication',
      source_parquet_files: [...reader.inventory.values()].filter(o => o.key.endsWith('.parquet')).length };
    report.source_objects = [...reader.inventory.values()].sort((a,b) => a.key.localeCompare(b.key));
    // Report is always written, even after time/output limits. Never include
    // credentials, signed URLs, rclone stderr or arbitrary upstream bodies.
    await fs.writeFile(path.join(output, 'report.json'), canonicalJson(report), { flag: 'wx', mode: 0o600 });
    await fs.rm(work, { recursive: true, force: true });
  }
  if (report.eligible_for_further_manual_review) {
    await fs.writeFile(path.join(output, 'COMPLETE.json'), canonicalJson({ schema_version: 1,
      kind: 'uk_aq_jsongen_local_bootstrap_completion', manifest: report.manifest,
      report_sha256: sha256Hex(await fs.readFile(path.join(output, 'report.json'))),
      publication_state: 'local_only_no_operational_or_managed_acceptance' }), { flag: 'wx', mode: 0o600 });
  }
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--help') { console.log(HELP); return; }
  const report = await runBootstrap(parseOptions(argv));
  console.log(JSON.stringify({ state: report.state, candidate_count: report.candidates.length,
    observation_count: report.observation_count, eligible_for_further_manual_review: report.eligible_for_further_manual_review }));
  if (!report.eligible_for_further_manual_review) process.exitCode = 2;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Bootstrap stopped: ${error.message}`); process.exitCode = 1; });
}
