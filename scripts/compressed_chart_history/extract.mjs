import { performance } from "node:perf_hooks";
import { validateTimeseriesBinding, selectContinuitySegments } from "../../workers/uk_aq_station_history/src/continuity.mjs";
import { createSourceReader, requireCondition as check } from "./source_reader.mjs";
import { getObservationHistoryGeneration } from "../../workers/shared/uk_aq_observation_history_generation.mjs";
import { compressors, parquetMetadataAsync, parquetRead, parquetSchema } from "../backup_r2/lib/uk_aq_parquet_dependencies.mjs";
import { observationHistoryPhysicalSchemaForColumns, observationHistoryPhysicalSchemasFromManifest, selectObservationVerificationStatusColumn } from "../../workers/shared/uk_aq_observation_history_schema.mjs";
import { resolveLegacyVerificationStatus } from "../../workers/shared/uk_aq_observation_content_hash.mjs";
import { loadObservationVerificationAuthority, resolveEffectiveObservationVerificationStatus } from "../../workers/shared/uk_aq_observation_verification_overlay.mjs";

const DAY = 86_400_000;
const integer = (v, minimum = 1) => Number.isSafeInteger(Number(v)) && v !== null && Number(v) >= minimum;
const canonicalFileHash = (file) => {
  const hash = file.sha256 || file.etag_or_hash;
  // Older manifests may supply an ETag rather than SHA. Still pin the downloaded
  // body in the evidence; do not reinterpret an opaque ETag as a content hash.
  return /^[0-9a-f]{64}$/.test(hash || "") ? hash : null;
};
export function daysBetween(start, end) {
  const days = [];
  for (let ms = Math.floor(Date.parse(start) / DAY) * DAY; ms < Date.parse(end); ms += DAY) days.push(new Date(ms).toISOString().slice(0, 10));
  return days;
}
function validateScope(payload, day, pollutant, connectorId) {
  check(payload && payload.day_utc === day && payload.connector_id === connectorId && payload.pollutant_code === pollutant && payload.domain === "observations", `Source scope mismatch: ${day}`);
}
// Whole-file offline consumers may select several physical series in one decode.
// The original pilot keeps its exact-leaf/single-series path and tuple format.
export async function decodeCanonicalObservations(reader, fileDescriptor, manifest, segments, selection, authority, stats) {
  const { timeseriesId, pollutant, binding, day } = selection;
  const connectorId = selection.connectorId ?? 1;
  const fileKey = fileDescriptor.key;
  const canonical = manifest.files.find((f) => f.key === fileKey);
  check(canonical, `Index references noncanonical file: ${fileKey}`);
  const expected = { byte_size: canonical.bytes ?? canonical.byte_size, sha256: canonicalFileHash(canonical) };
  if (!expected.sha256 && canonical.etag_or_hash) expected.etag = canonical.etag_or_hash;
  check(integer(expected.byte_size), `Canonical file size missing: ${fileKey}`);
  if (segments) {
    check(fileDescriptor.byte_size === Number(expected.byte_size) && /^[0-9a-f]{64}$/.test(fileDescriptor.sha256 || ""), `Invalid exact file descriptor: ${fileKey}`);
    if (expected.sha256) check(fileDescriptor.sha256 === expected.sha256, `Canonical/index digest mismatch: ${fileKey}`);
    expected.sha256 = fileDescriptor.sha256;
  }
  const object = await reader.read(fileKey, { expected });
  const started = performance.now();
  const file = new Uint8Array(object.body).slice().buffer;
  const metadata = await parquetMetadataAsync(file);
  const count = Number(metadata.num_rows);
  check(integer(count) && count <= (selection.maxFileRows ?? 1_000_000) && count === Number(canonical.row_count), `Invalid Parquet row count: ${fileKey}`);
  if (segments) check(fileDescriptor.row_count === count && fileDescriptor.row_group_count === metadata.row_groups.length, "Exact file/Parquet metadata disagreement");
  const schemaColumns = parquetSchema(metadata).children;
  const columns = schemaColumns.map((column) => String(column.element.name));
  if (selection.requireMillisecondTimestamps) {
    const timestamp = schemaColumns.find(column => column.element.name === "observed_at_utc")?.element;
    check(timestamp?.type === "INT64" && (timestamp.logical_type
      ? timestamp.logical_type.type === "TIMESTAMP" && timestamp.logical_type.unit === "MILLIS"
      : timestamp.converted_type === "TIMESTAMP_MILLIS")
      && (!timestamp.converted_type || timestamp.converted_type === "TIMESTAMP_MILLIS"), "Canonical millisecond timestamp schema required; finer precision must not be truncated");
    check(schemaColumns.find(column => column.element.name === "value")?.element.type === "DOUBLE", "Canonical binary64 values required");
  }
  const declared = observationHistoryPhysicalSchemasFromManifest(manifest);
  const matches = declared.filter((schema) => JSON.stringify(schema.columns) === JSON.stringify(columns));
  check(matches.length === 1, `Missing or ambiguous canonical physical schema identity: ${fileKey}`);
  const physical = matches[0];
  observationHistoryPhysicalSchemaForColumns(columns, { historySchemaVersion: physical.history_schema_version });
  if (physical.history_schema_version === 4) check(authority?.overlay_authoritative, "Schema v4 requires activated verification authority");
  stats.physical_schemas.set(JSON.stringify(physical), physical);
  const statusColumn = selectObservationVerificationStatusColumn(columns);
  const result = [];
  const ranges = segments || [{ row_start: 0, row_count: count }];
  const seenGroups = new Set();
  for (const segment of ranges) {
    check(integer(segment.row_start, 0) && integer(segment.row_count) && segment.row_start + segment.row_count <= count, `Invalid Parquet row interval: ${fileKey}`);
    if (segments) {
      const ordinal = segment.row_group_ordinal;
      const group = metadata.row_groups[ordinal];
      const start = metadata.row_groups.slice(0, ordinal).reduce((sum, g) => sum + Number(g.num_rows), 0);
      check(integer(ordinal, 0) && group && !seenGroups.has(ordinal) && segment.row_group_row_start === 0 && segment.row_count <= 1024 && Number(group.num_rows) === segment.row_count && segment.row_start === start && segment.timeseries_id === timeseriesId, `Exact segment is not a complete timeseries row group: ${fileKey}`);
      seenGroups.add(ordinal);
      for (const name of ["observed_at_utc", "value"]) {
        const range = segment.column_ranges?.[name];
        check(range && integer(range.start, 0) && integer(range.end) && range.start < range.end && range.end <= object.byte_size && range.num_values === segment.row_count, "Invalid indexed column byte interval");
        stats.selected_timestamp_value_column_bytes += range.end - range.start;
      }
    }
    let decoded;
    await parquetRead({ file, metadata, columns, rowStart: segment.row_start, rowEnd: segment.row_start + segment.row_count, compressors, onComplete: (rows) => { decoded = rows; } });
    check(Array.isArray(decoded) && decoded.length === segment.row_count, `Decode row count mismatch: ${fileKey}`);
    stats.rows_decoded += decoded.length;
    stats.row_groups_decoded += segments ? 1 : metadata.row_groups.length;
    for (const values of decoded) {
      const row = Object.fromEntries(columns.map((name, i) => [name, values[i]]));
      check(integer(row.connector_id) && integer(row.timeseries_id) && (row.station_id === null || integer(row.station_id)) && typeof row.value === "number" && Number.isFinite(row.value) && row.observed_at_utc !== null, `Invalid canonical row: ${fileKey}`);
      const observed = row.observed_at_utc instanceof Date ? row.observed_at_utc : new Date(row.observed_at_utc);
      check(!Number.isNaN(observed.getTime()), `Invalid observation timestamp: ${fileKey}`);
      const timestamp = observed.toISOString();
      check(Number(row.connector_id) === connectorId && row.pollutant_code === pollutant && timestamp.slice(0, 10) === day, `Canonical row outside file scope: ${fileKey}`);
      if (segments) check(Number(row.timeseries_id) === timeseriesId, `Exact row group contains another timeseries: ${fileKey}`);
      if (timeseriesId != null && Number(row.timeseries_id) !== timeseriesId) continue;
      if (selection.timeseriesIds && !selection.timeseriesIds.has(Number(row.timeseries_id))) continue;
      const physicalBinding = selection.resolveBinding
        ? await selection.resolveBinding(Number(row.timeseries_id)) : binding;
      check(physicalBinding && (row.station_id === null || Number(row.station_id) === physicalBinding.station_id), "Physical station identity disagrees with binding");
      const embedded = statusColumn ? row[statusColumn] : null;
      check(statusColumn === "status" ? embedded === null || typeof embedded === "string" : embedded === null || embedded === "P" || embedded === "R", "Invalid persisted verification status");
      check(selection.legacyStatusMode !== "persisted_verification_only" || statusColumn !== "status", "Legacy source text requires an explicitly selected compatibility interpretation");
      const legacy = resolveLegacyVerificationStatus(row, { isSos: selection.legacyStatusMode == null ? connectorId === 1 : selection.legacyStatusMode === "sos_compatibility" });
      const effective = resolveEffectiveObservationVerificationStatus({ authority, timeseriesId: Number(row.timeseries_id), observedAtUtc: timestamp, legacyStatus: legacy });
      const tuple = [timestamp, row.value, row.station_id === null ? null : Number(row.station_id), embedded, effective];
      if (selection.onRow) await selection.onRow({
        connector_id: connectorId, timeseries_id: Number(row.timeseries_id),
        station_id: tuple[2], pollutant_code: pollutant, observed_at_utc: timestamp,
        value: row.value, verification_status: effective,
        embedded_verification_status: statusColumn === "verification_status" ? embedded : null,
        source_status: statusColumn === "status" ? embedded : null,
        source_status_provenance: statusColumn === "status" ? "legacy_source_status_retained" : "original_source_status_unavailable",
      }, physical);
      else result.push(selection.includePhysicalIdentity ? [tuple[0], tuple[1], tuple[2],
        statusColumn === "status" ? embedded : null, effective, Number(row.timeseries_id),
        statusColumn === "verification_status" ? embedded : null,
        statusColumn === "status" ? "legacy_source_status_retained" : "original_source_status_unavailable"] : tuple);
    }
  }
  stats.decode_wall_ms += performance.now() - started;
  return result;
}
const decode = decodeCanonicalObservations;

async function proveMissingScope(reader, generation, day, pollutant, canonical, connectorId) {
  if (canonical) return "unexported_missing_index";
  // Missing objects alone do not prove canonical absence. Only an authoritative
  // parent manifest omitting this child can establish that narrower absence.
  const connectorKey = `${generation.observations_prefix}/day_utc=${day}/connector_id=${connectorId}/manifest.json`;
  const connector = await reader.json(connectorKey);
  if (!connector) return "unknown_missing_source_scope";
  check(connector.day_utc === day && connector.connector_id === connectorId && connector.domain === "observations" && connector.manifest_kind === "connector" && Array.isArray(connector.child_manifests) && connector.child_manifests.every((child) => typeof (child.key || child.manifest_key) === "string"), "Invalid canonical connector manifest");
  const key = `${generation.observations_prefix}/day_utc=${day}/connector_id=${connectorId}/pollutant_code=${pollutant}/manifest.json`;
  return connector.child_manifests.some((child) => child.key === key || child.manifest_key === key) ? "unknown_missing_source_scope" : "authoritative_absence";
}

export async function extractGeneration(version, options) {
  const started = performance.now(), cpuStarted = process.cpuUsage();
  const { config, sample, connectorId, pollutant, timeseriesId } = options;
  const generation = getObservationHistoryGeneration(version);
  const reader = createSourceReader(version, options);
  const stats = { rows_decoded: 0, row_groups_decoded: 0, selected_timestamp_value_column_bytes: 0, decode_wall_ms: 0, physical_schemas: new Map() };
  const days = [], rows = [], contextRows = [], contextDays = [], physicalBindings = [];
  let rootBinding, continuity;
  try {
    rootBinding = await reader.json(`${generation.timeseries_binding_index_prefix}/timeseries_id=${timeseriesId}.json`);
    const resolved = validateTimeseriesBinding(rootBinding, { connectorId, timeseriesId, pollutant });
    check(resolved.identity.stationId === sample.station_id, "Configured root station disagrees with canonical binding");
    continuity = resolved.continuity;
    const selected = selectContinuitySegments(continuity, Date.parse(options.contextStart), Date.parse(options.end));
    check(selected.gaps.length === 0 && selected.segments.length > 0, "Unresolved continuity validity/context gap");
    const bindings = new Map();
    for (const member of selected.segments) {
      check(sample.permitted_timeseries_ids.includes(member.timeseriesId), "Canonical continuity member not in configured finite allowlist");
      const binding = member.timeseriesId === timeseriesId ? rootBinding
        : await reader.json(`${generation.timeseries_binding_index_prefix}/timeseries_id=${member.timeseriesId}.json`);
      const physical = validateTimeseriesBinding(binding, { connectorId, timeseriesId: member.timeseriesId, pollutant });
      check(physical.identity.stationId === member.stationId && physical.continuity.continuityKey === continuity.continuityKey
        && JSON.stringify(physical.continuity.members) === JSON.stringify(continuity.members), "Conflicting physical continuity bindings");
      bindings.set(member.timeseriesId, binding);
      physicalBindings.push(binding);
    }
    const bucket = { get: async key => {
      const object = await reader.read(key);
      return object ? { arrayBuffer: async () => new Uint8Array(object.body).slice().buffer } : null;
    } };
    const authority = await loadObservationVerificationAuthority({ bucket, connectorId });
    check(config.verification_mode === "overlay_accepted" ? authority?.overlay_authoritative === true : !authority?.overlay_authoritative,
      "Configured verification transition disagrees with observed canonical authority");
    for (const day of daysBetween(options.contextStart, options.end)) {
      reader.checkBudget();
      const dayStart = Date.parse(`${day}T00:00:00.000Z`), dayEnd = dayStart + DAY;
      const daySelection = selectContinuitySegments(continuity, Math.max(dayStart, Date.parse(options.contextStart)), Math.min(dayEnd, Date.parse(options.end)));
      check(daySelection.gaps.length === 0 && daySelection.segments.length === 1, "Missing or conflicting date-valid physical member");
      const member = daySelection.segments[0], binding = bindings.get(member.timeseriesId);
      const physicalId = member.timeseriesId;
      const isContextDay = dayEnd <= Date.parse(options.start);
      const dayList = isContextDay ? contextDays : days;
      const suffix = `day_utc=${day}/connector_id=${connectorId}/pollutant_code=${pollutant}`;
      const indexKey = `${generation.observations_timeseries_index_prefix}/${suffix}/manifest.json`;
      const canonicalKey = `${generation.observations_prefix}/${suffix}/manifest.json`;
      const index = await reader.json(indexKey), canonical = await reader.json(canonicalKey);
      if (!index || !canonical) {
        const state = index ? "unknown_missing_source_scope" : await proveMissingScope(reader, generation, day, pollutant, canonical, connectorId);
        dayList.push({ day_utc: day, state, row_count: 0, timeseries_id: physicalId });
        continue;
      }
      validateScope(index, day, pollutant, connectorId);
      validateScope(canonical, day, pollutant, connectorId);
      check(canonical.manifest_kind === "pollutant" && Array.isArray(canonical.files) && canonical.file_count === canonical.files.length
        && new Set(canonical.files.map(file => file.key)).size === canonical.files.length, "Invalid canonical pollutant manifest");
      observationHistoryPhysicalSchemasFromManifest(canonical);
      check(index.schema_version === 1 && index.index_generation === "v3" && index.kind === "observation_timeseries_physical_leaf_scoped_manifest"
        && index.physical_layout_version === "timeseries-aligned-v2" && index.aligned_row_cap === 1024 && index.key === indexKey
        && index.leaf_descriptor_fields?.join() === "key,byte_size,sha256" && index.leaves_by_timeseries_id
        && typeof index.leaves_by_timeseries_id === "object" && !Array.isArray(index.leaves_by_timeseries_id)
        && index.coverage?.row_count === canonical.row_count && index.coverage?.timeseries_count === Object.keys(index.leaves_by_timeseries_id).length,
      "Unsupported or incomplete exact-leaf scoped index");
      const descriptor = index.leaves_by_timeseries_id[String(physicalId)], expectedCount = canonical.timeseries_row_counts?.[String(physicalId)];
      if (!descriptor) {
        check(expectedCount === undefined || Number(expectedCount) === 0, "Index omits canonical timeseries");
        dayList.push({ day_utc: day, state: "authoritative_absence", row_count: 0, timeseries_id: physicalId });
        continue;
      }
      const leafKey = `${generation.observations_timeseries_index_prefix}/${suffix}/timeseries_id=${String(physicalId).padStart(9, "0")}.json`;
      check(Array.isArray(descriptor) && descriptor.length === 3 && descriptor[0] === leafKey && integer(descriptor[1])
        && /^[0-9a-f]{64}$/.test(descriptor[2]), "Invalid requested exact-leaf identity");
      const leaf = await reader.json(leafKey, { expected: { byte_size: descriptor[1], sha256: descriptor[2] } });
      validateScope(leaf, day, pollutant, connectorId);
      check(leaf.kind === "observation_timeseries_physical_leaf" && leaf.index_generation === "v3" && leaf.key === leafKey
        && leaf.timeseries_id === physicalId && leaf.physical_layout_version === "timeseries-aligned-v2" && leaf.aligned_row_cap === 1024
        && Array.isArray(leaf.files) && Array.isArray(leaf.segments), "Invalid exact leaf");
      check(new Set(leaf.files.map(file => file.key)).size === leaf.files.length
        && leaf.segments.every(segment => leaf.files.some(file => file.key === segment.file_key))
        && leaf.segments.reduce((sum, segment) => sum + segment.row_count, 0) === leaf.row_count, "Invalid exact leaf membership");
      const dayRows = [];
      for (const file of leaf.files) {
        reader.checkBudget();
        const segments = leaf.segments.filter(segment => segment.file_key === file.key);
        check(segments.length > 0, "Unused file in exact leaf");
        dayRows.push(...await decode(reader, file, canonical, segments, { ...options, timeseriesId: physicalId, binding, day,
          includePhysicalIdentity: true, requireMillisecondTimestamps: true, legacyStatusMode: config.legacy_status_mode }, authority, stats));
      }
      check(dayRows.length === leaf.row_count && (expectedCount === undefined || dayRows.length === Number(expectedCount)), "Canonical/exact leaf row count mismatch");
      const selectedRows = dayRows.filter(([timestamp]) => timestamp >= options.contextStart && timestamp < options.end);
      contextRows.push(...selectedRows.filter(([timestamp]) => timestamp < options.start));
      rows.push(...selectedRows.filter(([timestamp]) => timestamp >= options.start));
      check(rows.length + contextRows.length <= 100_000, "Selected observation row budget exceeded");
      dayList.push({ day_utc: day, state: dayRows.length ? "exported" : "authoritative_absence",
        row_count: isContextDay ? selectedRows.length : selectedRows.filter(([timestamp]) => timestamp >= options.start).length, timeseries_id: physicalId });
    }
    await reader.checkStability();
    const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
    for (const list of [rows, contextRows]) list.sort((a, b) => compare(a[0], b[0]) || compare(JSON.stringify(a), JSON.stringify(b)));
    return finish({ state: days.every(day => ["exported", "authoritative_absence"].includes(day.state)) ? "complete" : "incomplete",
      binding: rootBinding, continuity, physical_bindings: physicalBindings, rows, days, contextRows, contextDays,
      verification: { mode: config.verification_mode, operator_authority_reference: config.status_authority_reference,
        overlay_authoritative: authority?.overlay_authoritative || false, latest_identity: authority?.latest_identity || null,
        manifest_identity: authority?.manifest_identity || null, legacy_status_mode: config.legacy_status_mode } });
  } catch (error) {
    return finish({ state: "failed", error: error.message, binding: rootBinding || null, continuity: continuity || null,
      physical_bindings: physicalBindings, rows: [], days, contextRows: [], contextDays });
  }
  function finish(result) {
    const cpu = process.cpuUsage(cpuStarted);
    const sourceObjects = [...reader.inventory.values()].sort((a, b) => a.key.localeCompare(b.key));
    return { generation: version, bucket: reader.bucket, ...result, source_objects: sourceObjects,
      metrics: { ...reader.metrics, ...stats, physical_schemas: [...stats.physical_schemas.values()], source_object_count: sourceObjects.length,
        source_parquet_object_count: sourceObjects.filter(object => object.key.endsWith(".parquet")).length,
        source_parquet_object_bytes: sourceObjects.filter(object => object.key.endsWith(".parquet")).reduce((sum, object) => sum + object.byte_size, 0),
        extraction_wall_ms: performance.now() - started, extraction_cpu_ms: (cpu.user + cpu.system) / 1000, row_count: result.rows.length } };
  }
}
