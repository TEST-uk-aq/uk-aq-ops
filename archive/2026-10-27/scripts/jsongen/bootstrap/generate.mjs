#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { gzipSync, gunzipSync } from 'node:zlib';
import { canonicalJson, requireValid as check, assertIdentity, newPubID, publicationPrefix } from '../schema.mjs';
import { sha256Hex } from '../../backup_r2/lib/rclone.mjs';
import { decodeCanonicalObservations, daysBetween } from '../../compressed_chart_history/extract.mjs';
import { calculateMonthAqi } from '../../compressed_chart_history/export.mjs';
import { observationHistoryPhysicalSchemasFromManifest } from '../../../workers/shared/uk_aq_observation_history_schema.mjs';
import { AQI_ALGORITHM_VERSION, DAQI_PM_ROLLING24H_WINDOW_HOURS,
  DAQI_PM_ROLLING24H_REQUIRED_HOURS } from '../../../lib/aqi/aqi_levels.mjs';
import { createDropboxReader, DROPBOX_SOURCE, CHECKPOINT_KEY } from './dropbox-reader.mjs';
import { openBackupSource } from './source.mjs';

const DAY = 86_400_000, HOUR = 3_600_000, MIB = 1024 ** 2;
export const HELP = `Manual, local-only TEST Dropbox historical JSONgen bootstrap.
No execution occurs on import. No R2/database/Dropbox writes or publication.
Required:
  --source dropbox-backup
  --checkpoint-path ${CHECKPOINT_KEY}
  --checkpoint-sha256 <SHA-256 of exact selected completed root.json bytes>
  --observations-root-sha256 <checkpoint processed observations root>
  --start-utc <UTC midnight> --end-utc <exclusive UTC midnight>
  --connector-ids <comma-separated explicit physical connector IDs>
  --pollutants <pm25,pm10,no2 subset>
  --verification-modes <id=overlay_accepted|pre_overlay_accepted,...>
  --output-dir <absolute new directory>
Optional: --timeseries-ids <comma-separated physical IDs>
Bounds (default; hard maximum):
  --max-days 124 (366), --max-series 256 (4096, across invocation)
  --max-selected-rows 250000 (1000000, per connector/pollutant/month incl context)
  --max-file-rows 131072 (1000000), --max-decoded-rows 10000000 (100000000)
  --max-source-mib 1024 (16384, includes metadata rechecks)
  --max-object-mib 16 (64), --max-metadata-mib 16 (32)
  --max-output-mib 1024 (8192), --max-objects 8192 (65536)
  --max-read-commands 16384 (131072), --max-wall-seconds 3600 (14400)
Uses existing uk_aq_dropbox remote/RCLONE_CONFIG and UK_AQ_ENV_NAME=TEST.
Source is fixed to ${DROPBOX_SOURCE}. See README.md for the proposed seven-day command.
`;

function csv(value, validate, label) {
  const entries = (value || '').split(',');
  check(entries.length > 0 && entries.every(validate) && new Set(entries).size === entries.length, `invalid ${label}`);
  return entries;
}
export function parseOptions(argv) {
  const names = ['source', 'checkpoint-path', 'checkpoint-sha256', 'observations-root-sha256',
    'start-utc', 'end-utc', 'connector-ids', 'timeseries-ids', 'pollutants', 'verification-modes', 'output-dir',
    'max-days', 'max-series', 'max-selected-rows', 'max-file-rows', 'max-decoded-rows', 'max-source-mib',
    'max-object-mib', 'max-metadata-mib', 'max-output-mib', 'max-objects', 'max-read-commands', 'max-wall-seconds'];
  const supplied = {};
  check(argv.length % 2 === 0, 'every option requires a value; use --help');
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].slice(2);
    check(argv[i] === `--${key}` && names.includes(key) && supplied[key] === undefined, 'unknown/repeated option');
    supplied[key] = argv[i + 1];
  }
  check(supplied.source === 'dropbox-backup' && supplied['checkpoint-path'] === CHECKPOINT_KEY, 'explicit Dropbox v3 checkpoint required');
  const sha = value => /^[a-f0-9]{64}$/.test(value || '');
  check(sha(supplied['checkpoint-sha256']) && sha(supplied['observations-root-sha256']), 'both explicit checkpoint and observation-root SHA-256 pins required');
  const positive = value => /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
  const connectors = csv(supplied['connector-ids'], positive, 'connector selection').map(Number).sort((a,b) => a-b);
  const timeseries = supplied['timeseries-ids'] === undefined ? null
    : csv(supplied['timeseries-ids'], positive, 'timeseries selection').map(Number).sort((a,b) => a-b);
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
    wallSeconds: bound('max-wall-seconds', 3600, 14400) };
  function utc(raw) {
    check(/^\d{4}-\d\d-\d\dT00:00:00(?:\.000)?Z$/.test(raw || ''), 'this version requires whole UTC days');
    const date = new Date(raw);
    check(Number.isFinite(date.getTime()) && date.toISOString() === raw.replace(/(?:\.000)?Z$/, '.000Z'), 'invalid UTC date');
    return date.toISOString();
  }
  const start = utc(supplied['start-utc']), end = utc(supplied['end-utc']);
  check(start < end && (Date.parse(end) - Date.parse(start)) / DAY <= limits.days, 'invalid or over-budget requested interval');
  check(path.isAbsolute(supplied['output-dir'] || ''), 'absolute new output directory required');
  check(!timeseries || timeseries.length <= limits.series, 'selected series exceed invocation limit');
  return { source: 'dropbox-backup', checkpointPath: CHECKPOINT_KEY, checkpointSha256: supplied['checkpoint-sha256'],
    observationsRoot: supplied['observations-root-sha256'], start, end, connectors, timeseries, pollutants,
    verificationModes, limits, output: path.resolve(supplied['output-dir']) };
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
const sortedRows = rows => rows.sort((a,b) => a.observed_at_utc.localeCompare(b.observed_at_utc)
  || a.value - b.value || canonicalJson(a).compare(canonicalJson(b)));
const tuples = rows => rows.map(r => [r.observed_at_utc, r.value, r.station_id, r.source_status, r.verification_status]);
function evaluated(status, reason) {
  return status === 'ok' || (status === 'insufficient_samples' && reason === 'insufficient_rolling_24h_hours')
    || (status === 'missing_input' && reason === 'no_input_value');
}
function indexCompleteness(aqi, index, expectedEndpoints) {
  const rows = aqi.rows;
  return { evaluated_complete: rows.length === expectedEndpoints
      && rows.every(r => evaluated(r[`${index}_calculation_status`], r[`${index}_missing_reason`])),
    available_endpoint_count: rows.filter(r => r[`${index}_calculation_status`] === 'ok').length,
    unavailable_endpoint_count: rows.filter(r => r[`${index}_calculation_status`] !== 'ok').length,
    unevaluated_endpoint_count: expectedEndpoints - rows.length };
}

export async function runBootstrap(options) {
  check(process.env.UK_AQ_ENV_NAME === 'TEST', 'UK_AQ_ENV_NAME must be TEST');
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
  const reader = createDropboxReader({ cacheDir, limits: options.limits });
  const stats = { rows_decoded: 0, row_groups_decoded: 0, selected_timestamp_value_column_bytes: 0,
    decode_wall_ms: 0, decode_cpu_ms: 0, physical_schemas: new Map() };
  const report = { schema_version: 1, kind: 'uk_aq_jsongen_dropbox_bootstrap_report', environment: 'TEST',
    state: 'running', invocation_id: newPubID(), source: DROPBOX_SOURCE,
    requested_period: { start_utc: options.start, end_exclusive_utc: options.end }, completed_periods: [],
    selection: { connector_ids: options.connectors, timeseries_ids: options.timeseries, pollutants: options.pollutants },
    source_checkpoint: { key: options.checkpointPath, sha256: options.checkpointSha256,
      processed_observations_root_hash: options.observationsRoot },
    verification_modes: options.verificationModes, limits: options.limits,
    successful_scopes: [], incomplete_scopes: [], errors: [], candidates: [],
    eligible_for_further_manual_review: false, managed_publication_eligible: false,
    current_canonical_authority: 'not_established_offline_backup_reconstruction',
    remote_write_operations: 0, canonical_r2_reads: 0, derived_r2_reads: 0,
    observation_count: 0, aqi_calculation_wall_ms: 0, aqi_calculation_cpu_ms: 0,
    json_gzip_write_wall_ms: 0, json_gzip_write_cpu_ms: 0, output_bytes: 0,
    json_bytes: 0, gzip_bytes: 0, runtime: { node: process.version, zlib: process.versions.zlib, gzip_level: 9 } };
  let active = null;
  const progress = setInterval(() => process.stderr.write(JSON.stringify({ state: report.state,
    scope: active, source_files: reader.inventory.size, source_bytes: reader.metrics.source_bytes_read,
    decoded_rows: stats.rows_decoded, candidates: report.candidates.length }) + '\n'), 15000);
  async function write(relative, body) {
    reader.deadline();
    check(report.output_bytes + body.length <= options.limits.outputBytes, 'output-byte limit exceeded');
    const target = path.join(output, relative);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, body, { flag: 'wx', mode: 0o600 });
    check(sha256Hex(await fs.readFile(target)) === sha256Hex(body), 'local output readback mismatch');
    report.output_bytes += body.length;
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
  try {
    const source = await openBackupSource(reader, options);
    report.source_checkpoint = source.checkpoint;
    // Preserve exact metadata bytes once, independent of volatile measurements.
    const retainedMetadata = new Set();
    async function retainMetadata() {
      for (const ref of reader.metadata.values()) {
        if (retainedMetadata.has(ref.sha256)) continue;
        await write(`evidence/source/${ref.sha256}.json`, await fs.readFile(path.join(cacheDir, ref.sha256)));
        retainedMetadata.add(ref.sha256);
      }
    }
    if (options.timeseries) for (const id of options.timeseries) {
      const binding = await source.binding(id);
      check(options.connectors.includes(binding.connector_id) && options.pollutants.includes(binding.pollutant_code),
        'explicit timeseries is outside connector/pollutant selection');
    }
    for (const month of monthsBetween(options.start, options.end)) {
      for (const connectorId of options.connectors) for (const pollutant of options.pollutants) {
        active = { connector_id: connectorId, pollutant_code: pollutant, month_utc: month.month_utc };
        const contextStart = new Date(Date.parse(month.requested_start_utc) - DAY).toISOString();
        const groups = new Map(), days = [], files = [], selectedIds = options.timeseries ? new Set(options.timeseries) : null;
        let selectedRows = 0;
        const group = async id => {
          if (!groups.has(id)) {
            const binding = await source.binding(id, connectorId, pollutant);
            groups.set(id, { binding, rows: [], schemas: new Map() });
          }
          return groups.get(id);
        };
        if (options.timeseries) for (const id of options.timeseries) {
          const b = source.bindings.get(id);
          if (b.connector_id === connectorId && b.pollutant_code === pollutant) await group(id);
        }
        const authority = await source.authority(connectorId);
        for (const day of daysBetween(contextStart, month.requested_end_exclusive_utc)) {
          reader.deadline();
          const manifest = await source.pollutant(day, connectorId, pollutant);
          if (!manifest) { days.push({ day_utc: day, state: 'authoritative_absence', row_count: 0 }); continue; }
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
                const target = await group(row.timeseries_id);
                target.rows.push(row); target.schemas.set(JSON.stringify(physical), physical);
              },
            }, authority, stats);
            const used = process.cpuUsage(beforeCpu);
            stats.decode_cpu_ms += (used.user + used.system) / 1000;
            files.push(reader.inventory.get(file.key));
          }
          if (manifest.timeseries_row_counts) for (const [id, count] of Object.entries(manifest.timeseries_row_counts)) {
            if (!selectedIds || selectedIds.has(Number(id))) check((perSeries.get(Number(id)) || 0) === count,
              'selected physical-series canonical row count mismatch');
          }
          if (manifest.timeseries_row_counts) check([...perSeries.keys()].every(id => Object.hasOwn(manifest.timeseries_row_counts, String(id))),
            'canonical timeseries counts omit decoded physical identity');
          days.push({ day_utc: day, state: 'exported', row_count: selectedRows - before });
        }
        await retainMetadata();
        const sourceEvidence = await contentJson('evidence/source-evidence', {
          schema_version: 1, kind: 'uk_aq_jsongen_dropbox_bootstrap_source_evidence', environment: 'TEST',
          source: DROPBOX_SOURCE, source_checkpoint: source.checkpoint, scope: active, month,
          current_authority: source.current_authority, index_v3_trees: 'excluded_from_backup_not_read_or_rebuilt',
          verification_mode: options.verificationModes[connectorId], verification_mode_provenance: source.verification_mode_provenance,
          verification: { overlay_authoritative: authority.overlay_authoritative,
            latest_identity: authority.latest_identity || null, manifest_identity: authority.manifest_identity || null },
          physical_bindings: [...groups.keys()].sort((a,b) => a-b).map(id => source.memberEvidence.get(id)),
          physical_binding_authority: 'authenticated_backup_pack_membership_corroborated_by_physical_rows; matching_Core_publication_not_independently_authenticated',
          metadata_objects: [...reader.metadata.values()].sort((a,b) => a.key.localeCompare(b.key)),
          consumed_parquet: files, days, context_start_utc: contextStart,
          raw_source_status_rule: 'embedded verification_status is never represented as original provider status',
          source_timestamp_precision: 'canonical millisecond UTC; no rounding or truncation',
        });
        for (const [timeseriesId, groupValue] of [...groups].sort(([a],[b]) => a-b)) {
          reader.deadline();
          const identity = assertIdentity({ connector_id: connectorId, timeseries_id: timeseriesId,
            station_id: groupValue.binding.station_id, pollutant_code: pollutant });
          const rows = sortedRows(groupValue.rows);
          const visible = rows.filter(r => r.observed_at_utc >= month.requested_start_utc && r.observed_at_utc < month.requested_end_exclusive_utc);
          const context = rows.filter(r => r.observed_at_utc < month.requested_start_utc);
          const pubID = newPubID();
          const algorithm = { version: AQI_ALGORITHM_VERSION, daqi_pm_window_hours: DAQI_PM_ROLLING24H_WINDOW_HOURS,
            daqi_pm_required_valid_hours: DAQI_PM_ROLLING24H_REQUIRED_HOURS,
            endpoint_convention: 'hour-ending (n-1h,n]; visible endpoints in [requested_start,requested_end)',
            dependency_start_utc: contextStart, dependency_end_exclusive_utc: month.requested_end_exclusive_utc,
            dependency_evidence: sourceEvidence, preceding_managed_publication: null };
          const common = { schema_version: 1, environment: 'TEST', pub_id: pubID, identity, month_utc: month.month_utc,
            source_checkpoint: source.checkpoint, source_evidence: sourceEvidence, calculation_dependencies: algorithm,
            publication_state: 'local_private_candidate_not_managed_publication', coverage: month };
          const provenance = [...new Set(rows.map(r => r.source_status_provenance))].sort();
          const unique = new Set(visible.map(r => r.observed_at_utc)).size;
          const observations = { ...common, kind: 'uk_aq_jsongen_bootstrap_observations_candidate',
            physical_schemas: [...groupValue.schemas.values()], source_status_provenance: provenance.length ? provenance : ['no_source_rows'],
            canonical_row_multiplicity_preserved: true,
            completeness: { requested_source_complete: true, full_calendar_month: !month.partial_month,
              row_count: visible.length, unique_timestamp_count: unique, duplicate_timestamp_row_count: visible.length - unique,
              days: days.filter(d => d.day_utc >= month.requested_start_utc.slice(0,10)).map(d => ({
                day_utc: d.day_utc, state: visible.some(r => r.observed_at_utc.startsWith(d.day_utc)) ? 'exported' : 'authoritative_absence',
                row_count: visible.filter(r => r.observed_at_utc.startsWith(d.day_utc)).length })) },
            row_columns: ['observed_at_utc', 'value', 'station_id', 'source_status', 'verification_status',
              'embedded_verification_status', 'source_status_provenance'],
            observations: visible.map(r => [r.observed_at_utc, r.value, r.station_id, r.source_status,
              r.verification_status, r.embedded_verification_status, r.source_status_provenance]) };
          const aqBegin = performance.now(), aqCpu = process.cpuUsage();
          let calculated;
          try {
            const result = { binding: groupValue.binding, rows: tuples(visible), contextRows: tuples(context),
              days: days.filter(d => d.day_utc >= month.requested_start_utc.slice(0,10)),
              contextDays: days.filter(d => d.day_utc < month.requested_start_utc.slice(0,10)),
              state: 'complete', generation: 'v3', bucket: 'dropbox_backup_not_r2', evidence: sourceEvidence };
            calculated = await calculateMonthAqi(result, month, { pollutant, timeseriesId, contextStart });
          } catch (error) {
            // Preserve authenticated raw rows, including conflicting duplicates
            // or nullable stations; the shared AQI path must reject unsafe input.
            calculated = { rejection_reason: error.message, aqi: { rows: [], response_complete: false, has_gap: true, gap_ranges: [],
              partial_reasons: ['shared_station_history_aqi_rejected_input'] }, coverage: { daily_batches: [] } };
          } finally {
            const used = process.cpuUsage(aqCpu);
            report.aqi_calculation_wall_ms += performance.now() - aqBegin;
            report.aqi_calculation_cpu_ms += (used.user + used.system) / 1000;
          }
          const aqi = { ...common, kind: 'uk_aq_jsongen_bootstrap_aqi_candidate',
            algorithm_version: AQI_ALGORITHM_VERSION, daily_batches: calculated.coverage.daily_batches,
            completeness: { response_complete: calculated.aqi.response_complete,
              daqi: indexCompleteness(calculated.aqi, 'daqi', (Date.parse(month.requested_end_exclusive_utc) - Date.parse(month.requested_start_utc)) / HOUR),
              eaqi: indexCompleteness(calculated.aqi, 'eaqi', (Date.parse(month.requested_end_exclusive_utc) - Date.parse(month.requested_start_utc)) / HOUR),
              context_source_complete: true, partial_reasons: calculated.aqi.partial_reasons,
              calculation_error: calculated.rejection_reason || null }, aqi: calculated.aqi };
          const prefix = `candidates/${publicationPrefix(identity, month.month_utc, pubID)}`;
          const observationRef = await gzipProduct(prefix, 'observations', observations);
          const aqiRef = await gzipProduct(prefix, 'aqi', aqi);
          const candidate = { ...common, kind: 'uk_aq_jsongen_bootstrap_monthly_pair_candidate',
            observations: observationRef, aqi: aqiRef, observation_count: visible.length,
            observation_completeness: observations.completeness, aqi_completeness: aqi.completeness,
            proposed_publication_keys: { observations: `${publicationPrefix(identity, month.month_utc, pubID)}/observations.${observationRef.sha256}.json.gz`,
              aqi: `${publicationPrefix(identity, month.month_utc, pubID)}/aqi.${aqiRef.sha256}.json.gz` },
            managed_publication_eligible: false, manual_review_eligible: calculated.aqi.response_complete,
            completion_rule: 'requires final invocation COMPLETE.json, matching report and candidate manifest',
            unresolved_authority: ['current_canonical_authority_not_established', 'no_verified_writer_receipts',
              'matching_core_publication_not_independently_authenticated',
              'no_authenticated_managed_monthly_baseline', 'no_managed_preceding_month_publication'] };
          const descriptor = await contentJson(`${prefix}/candidate`, candidate);
          const summary = { identity, month_utc: month.month_utc, included_start_utc: month.requested_start_utc,
            included_end_exclusive_utc: month.requested_end_exclusive_utc, partial_month: month.partial_month,
            observation_count: visible.length, aqi_row_count: calculated.aqi.rows.length,
            aqi_response_complete: calculated.aqi.response_complete, candidate: descriptor,
            aqi_completeness: aqi.completeness,
            observations: observationRef, aqi: aqiRef, pub_id: pubID };
          report.candidates.push(summary); report.observation_count += visible.length;
          (calculated.aqi.response_complete ? report.successful_scopes : report.incomplete_scopes).push(summary);
        }
        report.completed_periods.push({ ...active, start_utc: month.requested_start_utc,
          end_exclusive_utc: month.requested_end_exclusive_utc, source_complete: true,
          physical_series_count: groups.size, candidate_count: groups.size });
      }
    }
    check(report.candidates.length > 0, 'no physical candidates resolved; explicitly select timeseries for authenticated empty output');
    await reader.checkStability();
    await retainMetadata();
    const manifest = await contentJson('candidate-manifest', { schema_version: 1,
      kind: 'uk_aq_jsongen_dropbox_bootstrap_candidate_manifest', environment: 'TEST',
      source_checkpoint: source.checkpoint, requested_period: report.requested_period,
      source_complete: true, aqi_complete: report.incomplete_scopes.length === 0,
      publication_state: 'local_private_candidate_not_managed_publication',
      managed_publication_eligible: false, candidates: report.candidates });
    report.manifest = manifest;
    report.state = report.incomplete_scopes.length ? 'incomplete' : 'local_candidates_complete';
    report.eligible_for_further_manual_review = report.incomplete_scopes.length === 0;
  } catch (error) {
    report.state = 'failed';
    report.errors.push({ scope: active, message: error.message });
    report.incomplete_scopes.push({ scope: active, requested_period: report.requested_period, reason: error.message });
  } finally {
    clearInterval(progress);
    const used = process.cpuUsage(cpu);
    report.wall_ms = performance.now() - begun; report.cpu_ms = (used.user + used.system) / 1000;
    report.metrics = { ...reader.metrics, ...stats, physical_schemas: [...stats.physical_schemas.values()],
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
