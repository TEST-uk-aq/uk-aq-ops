// Dropbox-only shared day decoding. Spools are private, invocation-local and
// never substitute for the original source-byte/currentness revalidation.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { canonicalJson, requireValid as check } from '../schema.mjs';
import { sha256Hex } from '../../backup_r2/lib/rclone.mjs';
import { decodeCanonicalObservations, daysBetween } from '../../compressed_chart_history/extract.mjs';
import { observationHistoryPhysicalSchemasFromManifest } from '../../../workers/shared/uk_aq_observation_history_schema.mjs';
import { failureReason, rethrowInvocationFault } from './failures.mjs';

export function createTemporaryBudget(limit) {
  const metrics = { temporary_bytes: 0, peak_temporary_bytes: 0, spool_bytes_written: 0 };
  return { metrics,
    reserve(bytes) {
      check(metrics.temporary_bytes + bytes <= limit, 'invocation temporary-disk limit exceeded');
      metrics.temporary_bytes += bytes;
      metrics.peak_temporary_bytes = Math.max(metrics.peak_temporary_bytes, metrics.temporary_bytes);
    },
    release(bytes) { metrics.temporary_bytes -= bytes; },
  };
}

export function createBulkProcessor({ source, reader, options, periods, directory, stats, disk }) {
  const entries = new Map();
  const metrics = { rows_assigned_to_selected_series: 0, rows_retained_in_spools: 0,
    peak_file_buffer_rows: 0, peak_file_buffer_bytes: 0, peak_candidate_rows: 0,
    peak_observed_rss_bytes: 0, source_day_result_reuses: 0, decoded_day_spool_reuses: 0,
    decode_passes_by_source_file: {}, processing_groups: [] };
  const discovery = { mode: options.allEligible ? 'all_eligible_timeseries' : 'explicit_timeseries',
    state: 'pending', selected: [], excluded: [], scopes: [],
    membership_source: 'authenticated_Dropbox_canonical_manifests_or_shared_full_file_decode',
    logical_continuity_stitching: false };
  const selected = options.timeseries ? new Set(options.timeseries) : null;
  const encountered = new Map();
  const sampleMemory = () => { metrics.peak_observed_rss_bytes = Math.max(
    metrics.peak_observed_rss_bytes, process.memoryUsage().rss); };
  const keyFor = (day, connector, pollutant) => `${day}/${connector}/${pollutant}`;
  function needed(timestamp, pollutant) {
    return periods.some(period => timestamp >= (pollutant === 'no2' ? period.requested_start_utc
      : new Date(Date.parse(period.requested_start_utc) - 23 * 3_600_000).toISOString())
      && timestamp <= period.requested_end_exclusive_utc);
  }
  async function loadDay(day, connectorId, pollutant) {
    const key = keyFor(day, connectorId, pollutant);
    if (entries.has(key)) {
      metrics.source_day_result_reuses++;
      if (entries.get(key).rows.size) metrics.decoded_day_spool_reuses++;
      return entries.get(key);
    }
    const entry = { key, day_utc: day, state: 'failed', source_state: 'not_established',
      rows: new Map(), files: [], schemas: new Map(), seriesFailures: new Map(), row_count: 0 };
    entries.set(key, entry);
    const target = path.join(directory, day, String(connectorId), pollutant);
    let written = 0;
    try {
      metrics.active_source = { day_utc: day, connector_id: connectorId, pollutant_code: pollutant };
      reader.deadline();
      const manifest = await source.pollutant(day, connectorId, pollutant);
      if (!manifest) {
        Object.assign(entry, { state: 'authoritative_absence', source_state: 'authoritative_absence' });
        return entry;
      }
      const authority = await source.authority(connectorId);
      for (const physical of observationHistoryPhysicalSchemasFromManifest(manifest))
        source.assertStatusMode(physical, connectorId, authority);
      const counts = new Map();
      const failSeries = (error, id) => {
        rethrowInvocationFault(error);
        entry.seriesFailures.set(id, { reason: failureReason(error), message: error.message,
          source_key: source.memberEvidence.get(id)?.key || `physical_binding/timeseries_id=${id}` });
      };
      await fs.mkdir(target, { recursive: true, mode: 0o700 });
      for (const file of manifest.files) {
        metrics.active_source.file_key = file.key;
        reader.deadline();
        check(stats.rows_decoded + file.row_count <= options.limits.decodedRows, 'decoded-row limit exceeded');
        const buffered = new Map();
        let bufferRows = 0, bufferBytes = 0;
        const before = process.cpuUsage();
        metrics.decode_passes_by_source_file[file.key] ??= 0;
        try {
          await decodeCanonicalObservations(reader, file, manifest, null, {
            connectorId, pollutant, day, timeseriesIds: selected, maxFileRows: options.limits.fileRows,
            requireMillisecondTimestamps: true, allowNullValues: true,
            onDecode: key => { metrics.decode_passes_by_source_file[key]++; },
            resolveBinding: id => source.binding(id, connectorId, pollutant),
            onPhysicalIdentityError: async (error, id) => {
              counts.set(id, (counts.get(id) || 0) + 1);
              failSeries(error, id);
            },
            onRow: async (row, physical) => {
              source.assertStatusMode(physical, connectorId, authority);
              counts.set(row.timeseries_id, (counts.get(row.timeseries_id) || 0) + 1);
              try {
                source.assertPhysicalRow(row);
                const verification = authority.manifest?.timeseries.find(t => t.timeseries_id === row.timeseries_id);
                if (verification) check(verification.station_id === source.bindings.get(row.timeseries_id).station_id
                  && verification.pollutant_code === pollutant, 'verification/physical binding identity mismatch');
              } catch (error) { failSeries(error, row.timeseries_id); return; }
              if (entry.seriesFailures.has(row.timeseries_id)) return;
              encountered.set(row.timeseries_id, (encountered.get(row.timeseries_id) || false)
                || periods.some(period => row.observed_at_utc >= period.requested_start_utc
                  && row.observed_at_utc < period.requested_end_exclusive_utc));
              metrics.rows_assigned_to_selected_series++;
              // Count/authenticate the entire source day, retaining only raw,
              // preceding rolling and exact terminal inputs of requested months.
              if (!needed(row.observed_at_utc, pollutant)) return;
              const line = canonicalJson(row);
              if (!buffered.has(row.timeseries_id)) buffered.set(row.timeseries_id, []);
              buffered.get(row.timeseries_id).push(line);
              bufferRows++; bufferBytes += line.length;
              entry.schemas.set(JSON.stringify(physical), physical);
            },
          }, authority, stats);
        } catch (error) {
          error.sourceKey = file.key;
          throw error;
        } finally {
          const used = process.cpuUsage(before);
          stats.decode_cpu_ms += (used.user + used.system) / 1000;
          metrics.peak_file_buffer_rows = Math.max(metrics.peak_file_buffer_rows, bufferRows);
          metrics.peak_file_buffer_bytes = Math.max(metrics.peak_file_buffer_bytes, bufferBytes);
          sampleMemory();
        }
        // Nothing from a defective file is admitted to the day spool. A later
        // day failure discards this entire day, including earlier good files.
        for (const [id, lines] of buffered) {
          if (entry.seriesFailures.has(id)) continue;
          if (!entry.rows.has(id)) entry.rows.set(id, { path: path.join(target, `${id}.jsonl`),
            row_count: 0, byte_size: 0, digest: createHash('sha256') });
          const ref = entry.rows.get(id), body = Buffer.concat(lines);
          disk.reserve(body.length); written += body.length;
          await fs.appendFile(ref.path, body, { mode: 0o600 });
          ref.digest.update(body); ref.byte_size += body.length; ref.row_count += lines.length;
          metrics.rows_retained_in_spools += lines.length;
          disk.metrics.spool_bytes_written += body.length;
        }
        entry.files.push(reader.inventory.get(file.key));
      }
      if (manifest.timeseries_row_counts) {
        for (const [id, count] of Object.entries(manifest.timeseries_row_counts))
          if (!selected || selected.has(Number(id))) check(counts.get(Number(id)) === count,
            `selected physical-series canonical row count mismatch: ${day}/${id}`);
        check([...counts.keys()].every(id => Object.hasOwn(manifest.timeseries_row_counts, String(id))),
          'canonical timeseries counts omit decoded physical identity');
      }
      for (const [id, ref] of entry.rows) {
        if (entry.seriesFailures.has(id)) {
          await fs.rm(ref.path); disk.release(ref.byte_size); written -= ref.byte_size;
          entry.rows.delete(id); continue;
        }
        ref.sha256 = ref.digest.digest('hex'); delete ref.digest;
      }
      entry.membership = [...counts.keys()].sort((a,b) => a-b);
      entry.row_count = [...counts.values()].reduce((sum, count) => sum + count, 0);
      Object.assign(entry, { state: 'exported', source_state: 'authenticated_membership' });
    } catch (error) {
      error.sourceKey ||= metrics.active_source?.file_key || key;
      rethrowInvocationFault(error);
      entry.failure = { reason: failureReason(error), message: error.message,
        source_key: error.sourceKey || `${day}/connector_id=${connectorId}/pollutant_code=${pollutant}` };
      await fs.rm(target, { recursive: true, force: true });
      disk.release(written); entry.rows.clear();
    } finally {
      metrics.active_source = null;
    }
    return entry;
  }

  async function discover() {
    discovery.state = 'running';
    if (!options.allEligible) { discovery.state = 'explicit_selection'; return options.timeseries; }
    const ids = new Map();
    const seen = new Set();
    for (const period of periods) for (const connectorId of options.connectors) for (const pollutant of options.pollutants)
      for (const day of daysBetween(period.requested_start_utc, period.requested_end_exclusive_utc)) {
        const key = keyFor(day, connectorId, pollutant);
        if (seen.has(key)) continue;
        seen.add(key);
        const scope = { day_utc: day, month_utc: period.month_utc, connector_id: connectorId,
          pollutant_code: pollutant, state: 'pending' };
        discovery.scopes.push(scope);
        try {
          const manifest = await source.pollutant(day, connectorId, pollutant);
          let members;
          if (!manifest) { scope.state = 'authenticated_absence'; continue; }
          if (manifest.timeseries_row_counts) {
            members = Object.keys(manifest.timeseries_row_counts).map(Number);
            scope.method = 'authenticated_complete_canonical_timeseries_row_counts';
          } else {
            const decoded = await loadDay(day, connectorId, pollutant);
            check(!decoded.failure, decoded.failure?.message || 'bounded physical discovery failed');
            members = decoded.membership || [];
            scope.method = 'authenticated_bounded_shared_decode_reused_for_candidates';
          }
          scope.state = 'membership_established'; scope.timeseries_ids = members;
          for (const id of members) {
            if (!ids.has(id)) {
              const identity = { timeseries_id: id, connector_id: connectorId, pollutant_code: pollutant,
                state: 'selected', reason: 'represented_in_authenticated_requested_reporting_history' };
              ids.set(id, identity); discovery.selected.push(identity);
            }
            check(ids.get(id).connector_id === connectorId && ids.get(id).pollutant_code === pollutant,
              'physical series inventory scope conflict');
          }
          // Admit the whole current manifest's identities to the report, then
          // stop before another manifest can enlarge an over-budget inventory.
          check(ids.size <= options.limits.series,
            'invocation physical-series limit exceeded; select a smaller batch');
        } catch (error) {
          rethrowInvocationFault(error);
          Object.assign(scope, { state: 'not_established', reason: failureReason(error), message: error.message });
        }
      }
    // Inventory is never sliced to a processing cap. Report every discovered
    // identity before failing the invocation when the requested set is too big.
    check(ids.size <= options.limits.series, 'invocation physical-series limit exceeded; select a smaller batch');
    for (const identity of discovery.selected) {
      try {
        const b = await source.binding(identity.timeseries_id, identity.connector_id, identity.pollutant_code);
        identity.station_id = b.station_id;
      } catch (error) {
        rethrowInvocationFault(error);
        identity.state = 'not_established'; identity.reason = failureReason(error); identity.message = error.message;
      }
    }
    discovery.state = discovery.scopes.some(scope => scope.state === 'not_established')
      || discovery.selected.some(identity => identity.state === 'not_established') ? 'incomplete' : 'complete';
    return [...ids.keys()].sort((a,b) => a-b);
  }

  async function prepare(month, connectorId, pollutant, contextStart, terminalEstablished) {
    const begun = performance.now();
    const days = [], files = [], schemas = new Map();
    const sourceDays = daysBetween(contextStart, month.requested_end_exclusive_utc);
    const terminalDay = month.requested_end_exclusive_utc.slice(0, 10);
    if (terminalEstablished) sourceDays.push(terminalDay);
    const data = [];
    for (const day of sourceDays) {
      const role = day === terminalDay ? 'aqi_terminal_endpoint'
        : day < month.requested_start_utc.slice(0, 10) ? 'pm_rolling_context' : 'raw_observations';
      const entry = await loadDay(day, connectorId, pollutant);
      days.push({ day_utc: day, state: entry.state, source_state: entry.source_state,
        dependency_role: role, row_count: entry.row_count, ...(entry.failure ? { failure: entry.failure } : {}),
        physical_series_failures: [...entry.seriesFailures].map(([id, failure]) => ({ timeseries_id: id, ...failure })) });
      files.push(...entry.files.map(file => ({ ...file, dependency_role: role })));
      if (role === 'raw_observations') for (const [key, value] of entry.schemas) schemas.set(key, value);
      data.push(entry);
    }
    groupMetrics(month.month_utc, connectorId, pollutant).shared_source_wall_ms = performance.now() - begun;
    return { days, files, schemas,
      daysFor: id => days.map(day => {
        const failure = day.physical_series_failures.find(failure => failure.timeseries_id === id);
        return failure ? { ...day, state: 'failed', source_state: 'not_established', failure } : day;
      }),
      async rowsFor(id) {
        const rows = [];
        for (const entry of data) {
          const ref = entry.rows.get(id);
          if (!ref || entry.failure) continue;
          check(rows.length + ref.row_count <= options.limits.selectedRows,
            'selected-row memory limit exceeded; select a smaller series/month scope');
          const body = await fs.readFile(ref.path);
          check(body.length === ref.byte_size && sha256Hex(body) === ref.sha256,
            `private row spool identity mismatch: ${entry.day_utc}/${id}`);
          const decoded = body.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
          check(decoded.length === ref.row_count, 'private row spool count mismatch');
          const retainedStart = pollutant === 'no2' ? month.requested_start_utc
            : new Date(Date.parse(month.requested_start_utc) - 23 * 3_600_000).toISOString();
          for (const row of decoded) if (row.observed_at_utc >= retainedStart
            && row.observed_at_utc <= month.requested_end_exclusive_utc) rows.push(row);
        }
        metrics.peak_candidate_rows = Math.max(metrics.peak_candidate_rows, rows.length); sampleMemory();
        return rows;
      },
    };
  }
  function finishDiscovery() {
    for (const entry of entries.values()) if (entry.failure) {
      for (const scope of discovery.scopes.filter(scope => scope.day_utc === entry.day_utc
        && keyFor(scope.day_utc, scope.connector_id, scope.pollutant_code) === entry.key))
        Object.assign(scope, { state: 'not_established', reason: entry.failure.reason, message: entry.failure.message });
    }
    const declared = new Set(discovery.selected.map(identity => identity.timeseries_id));
    if (selected) for (const id of selected) if (!declared.has(id)) {
      const binding = source.bindings.get(id);
      discovery.selected.push({ timeseries_id: id, connector_id: binding?.connector_id || null,
        pollutant_code: binding?.pollutant_code || null, station_id: binding?.station_id || null,
        state: binding ? 'selected' : 'not_established', reason: 'explicit_operator_selection' });
      declared.add(id);
    }
    discovery.excluded = [...encountered].filter(([id]) => !declared.has(id)).map(([id, reporting]) => {
      const binding = source.bindings.get(id);
      return { timeseries_id: id, connector_id: binding?.connector_id || null,
        pollutant_code: binding?.pollutant_code || null, station_id: binding?.station_id || null,
        state: reporting ? 'not_established' : 'dependency_only',
        reason: reporting ? 'decoded_identity_not_in_proved_inventory' : 'represented_only_in_aqi_dependencies' };
    });
    if (['pending', 'running'].includes(discovery.state) || discovery.scopes.some(scope => scope.state === 'not_established')
      || discovery.excluded.some(identity => identity.state === 'not_established')) discovery.state = 'incomplete';
  }
  async function releaseCompleted(month, connectorId, pollutant) {
    for (const [key, entry] of entries) {
      if (!key.endsWith(`/${connectorId}/${pollutant}`) || entry.day_utc > month.requested_end_exclusive_utc.slice(0, 10)) continue;
      const futureNeedsDay = periods.some(period => period.month_utc > month.month_utc
        && entry.day_utc >= (pollutant === 'no2' ? period.requested_start_utc
          : new Date(Date.parse(period.requested_start_utc) - 86_400_000).toISOString()).slice(0, 10)
        && entry.day_utc <= period.requested_end_exclusive_utc.slice(0, 10));
      if (futureNeedsDay) continue;
      for (const ref of entry.rows.values()) {
        await fs.rm(ref.path); disk.release(ref.byte_size);
      }
      entry.rows.clear();
    }
  }
  function groupMetrics(monthUtc, connectorId, pollutant) {
    let group = metrics.processing_groups.find(group => group.month_utc === monthUtc
      && group.connector_id === connectorId && group.pollutant_code === pollutant);
    if (!group) {
      group = { month_utc: monthUtc, connector_id: connectorId, pollutant_code: pollutant };
      metrics.processing_groups.push(group);
    }
    return group;
  }
  return { discover, discovery, finishDiscovery, prepare, releaseCompleted, groupMetrics, metrics };
}
