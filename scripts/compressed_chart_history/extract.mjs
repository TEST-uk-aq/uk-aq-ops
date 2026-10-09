import { performance } from "node:perf_hooks";
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
function validateScope(payload, day, pollutant) {
  check(payload && payload.day_utc === day && payload.connector_id === 1 && payload.pollutant_code === pollutant && payload.domain === "observations", `Source scope mismatch: ${day}`);
}
function overlaps(file, id) {
  return !(integer(file.min_timeseries_id) && integer(file.max_timeseries_id)) || (id >= Number(file.min_timeseries_id) && id <= Number(file.max_timeseries_id));
}

async function decode(reader, fileDescriptor, manifest, segments, selection, authority, stats) {
  const { timeseriesId, pollutant, binding, day } = selection;
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
  check(integer(count) && count <= 1_000_000 && count === Number(canonical.row_count), `Invalid Parquet row count: ${fileKey}`);
  if (segments) check(fileDescriptor.row_count === count && fileDescriptor.row_group_count === metadata.row_groups.length, "Exact file/Parquet metadata disagreement");
  const columns = parquetSchema(metadata).children.map((column) => String(column.element.name));
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
      check(Number(row.connector_id) === 1 && row.pollutant_code === pollutant && timestamp.slice(0, 10) === day, `Canonical row outside file scope: ${fileKey}`);
      if (segments) check(Number(row.timeseries_id) === timeseriesId, `Exact row group contains another timeseries: ${fileKey}`);
      if (Number(row.timeseries_id) !== timeseriesId) continue;
      check(row.station_id === null || Number(row.station_id) === binding.station_id, "Physical station identity disagrees with binding");
      const embedded = statusColumn ? row[statusColumn] : null;
      check(statusColumn === "status" ? embedded === null || typeof embedded === "string" : embedded === null || embedded === "P" || embedded === "R", "Invalid persisted verification status");
      const legacy = resolveLegacyVerificationStatus(row, { isSos: true });
      const effective = resolveEffectiveObservationVerificationStatus({ authority, timeseriesId, observedAtUtc: timestamp, legacyStatus: legacy });
      result.push([timestamp, row.value, row.station_id === null ? null : Number(row.station_id), embedded, effective]);
    }
  }
  stats.decode_wall_ms += performance.now() - started;
  return result;
}

async function proveMissingScope(reader, generation, day, pollutant, canonical) {
  if (canonical) return "unexported_missing_index";
  // Missing objects alone do not prove canonical absence. Only an authoritative
  // parent manifest omitting this child can establish that narrower absence.
  const connectorKey = `${generation.observations_prefix}/day_utc=${day}/connector_id=1/manifest.json`;
  const connector = await reader.json(connectorKey);
  if (!connector) return "unknown_missing_source_scope";
  check(connector.day_utc === day && connector.connector_id === 1 && connector.domain === "observations" && connector.manifest_kind === "connector" && Array.isArray(connector.child_manifests) && connector.child_manifests.every((child) => typeof (child.key || child.manifest_key) === "string"), "Invalid canonical connector manifest");
  const key = `${generation.observations_prefix}/day_utc=${day}/connector_id=1/pollutant_code=${pollutant}/manifest.json`;
  return connector.child_manifests.some((child) => child.key === key || child.manifest_key === key) ? "unknown_missing_source_scope" : "authoritative_absence";
}

export async function extractGeneration(version, options) {
  const started = performance.now();
  const cpuStarted = process.cpuUsage();
  const generation = getObservationHistoryGeneration(version);
  const reader = createSourceReader(version, { maxBytes: options.maxBytes });
  const stats = { rows_decoded: 0, row_groups_decoded: 0, selected_timestamp_value_column_bytes: 0, decode_wall_ms: 0, physical_schemas: new Map() };
  const days = [];
  const rows = [];
  const contextRows = [];
  const contextDays = [];
  try {
    const bindingKey = `${generation.timeseries_binding_index_prefix}/timeseries_id=${options.timeseriesId}.json`;
    const binding = await reader.json(bindingKey);
    check(binding, `${version} authoritative binding unavailable`);
    check([1, 2].includes(binding.schema_version) && binding.index_kind === "timeseries_binding" && binding.connector_id === 1 && binding.timeseries_id === options.timeseriesId && binding.pollutant_code === options.pollutant && integer(binding.station_id), "Binding does not identify selected physical AURN timeseries");
    check(!binding.continuity, "Pilot physical sample has a continuity binding; logical member export is required before publication");
    // The current overlay applies only to v3. Retained v2 keeps its own legacy
    // semantics; this difference is evidence, not something to harmonise away.
    const bucket = { get: async (key) => {
      const object = await reader.read(key);
      return object ? { arrayBuffer: async () => new Uint8Array(object.body).slice().buffer } : null;
    } };
    const authority = version === "v3" ? await loadObservationVerificationAuthority({ bucket, connectorId: 1 }) : null;
    for (const day of daysBetween(options.contextStart || options.start, options.end)) {
      const isContextDay = `${day}T00:00:00.000Z` < options.start;
      const dayList = isContextDay ? contextDays : days;
      const suffix = `day_utc=${day}/connector_id=1/pollutant_code=${options.pollutant}`;
      const indexKey = `${generation.observations_timeseries_index_prefix}/${suffix}/manifest.json`;
      const canonicalKey = `${generation.observations_prefix}/${suffix}/manifest.json`;
      const index = await reader.json(indexKey);
      const canonical = await reader.json(canonicalKey);
      if (!index || !canonical) {
        const state = index ? "unknown_missing_source_scope" : await proveMissingScope(reader, generation, day, options.pollutant, canonical);
        dayList.push({ day_utc: day, state, row_count: 0 });
        continue;
      }
      validateScope(index, day, options.pollutant);
      validateScope(canonical, day, options.pollutant);
      check(canonical.manifest_kind === "pollutant" && Array.isArray(canonical.files) && canonical.file_count === canonical.files.length && new Set(canonical.files.map((f) => f.key)).size === canonical.files.length, "Invalid canonical pollutant manifest");
      observationHistoryPhysicalSchemasFromManifest(canonical);
      const dayRows = [];
      if (version === "v3") {
        check(index.schema_version === 1 && index.index_generation === "v3" && index.kind === "observation_timeseries_physical_leaf_scoped_manifest" && index.physical_layout_version === "timeseries-aligned-v2" && index.aligned_row_cap === 1024 && index.key === indexKey && index.leaf_descriptor_fields?.join() === "key,byte_size,sha256" && index.leaves_by_timeseries_id && typeof index.leaves_by_timeseries_id === "object" && !Array.isArray(index.leaves_by_timeseries_id) && index.coverage?.row_count === canonical.row_count && index.coverage?.timeseries_count === Object.keys(index.leaves_by_timeseries_id).length, "Unsupported or incomplete exact-leaf scoped index");
        const descriptor = index.leaves_by_timeseries_id?.[String(options.timeseriesId)];
        const expectedCount = canonical.timeseries_row_counts?.[String(options.timeseriesId)];
        if (!descriptor) {
          check(expectedCount === undefined || Number(expectedCount) === 0, "Index omits canonical timeseries");
          dayList.push({ day_utc: day, state: "authoritative_absence", row_count: 0 });
          continue;
        }
        const leafKey = `${generation.observations_timeseries_index_prefix}/${suffix}/timeseries_id=${String(options.timeseriesId).padStart(9, "0")}.json`;
        check(Array.isArray(descriptor) && descriptor.length === 3 && descriptor[0] === leafKey && integer(descriptor[1]) && /^[0-9a-f]{64}$/.test(descriptor[2]), "Invalid requested exact-leaf identity");
        const leaf = await reader.json(leafKey, { expected: { byte_size: descriptor[1], sha256: descriptor[2] } });
        validateScope(leaf, day, options.pollutant);
        check(leaf.kind === "observation_timeseries_physical_leaf" && leaf.index_generation === "v3" && leaf.key === leafKey && leaf.timeseries_id === options.timeseriesId && leaf.physical_layout_version === "timeseries-aligned-v2" && leaf.aligned_row_cap === 1024 && Array.isArray(leaf.files) && Array.isArray(leaf.segments), "Invalid exact leaf");
        check(new Set(leaf.files.map((f) => f.key)).size === leaf.files.length && leaf.segments.every((s) => leaf.files.some((f) => f.key === s.file_key)) && leaf.segments.reduce((sum, s) => sum + s.row_count, 0) === leaf.row_count, "Invalid exact leaf membership");
        for (const file of leaf.files) {
          const segments = leaf.segments.filter((s) => s.file_key === file.key);
          check(segments.length > 0, "Unused file in exact leaf");
          dayRows.push(...await decode(reader, file, canonical, segments, { ...options, binding, day }, authority, stats));
        }
        check(dayRows.length === leaf.row_count, "Exact leaf row count mismatch");
      } else {
        check(index.index_kind === "timeseries_file_ranges" && index.index_coverage === "complete" && index.bucket === reader.bucket && index.data_prefix === generation.observations_prefix && index.pollutant_manifest_key === canonicalKey && /^[0-9a-f]{64}$/.test(canonical.manifest_hash || "") && index.pollutant_manifest_hash === canonical.manifest_hash && Array.isArray(index.files), "V2 index is incomplete or disagrees with canonical authority");
        check(index.files.length === canonical.files.length && new Set(index.files.map((f) => f.key)).size === index.files.length && canonical.files.every((f) => index.files.some((entry) => entry.key === f.key && entry.bytes === f.bytes && entry.row_count === f.row_count && entry.etag_or_hash === f.etag_or_hash && entry.min_timeseries_id === f.min_timeseries_id && entry.max_timeseries_id === f.max_timeseries_id)), "V2 index file identities/ranges disagree with canonical manifest");
        for (const file of index.files.filter((f) => overlaps(f, options.timeseriesId))) dayRows.push(...await decode(reader, file, canonical, null, { ...options, binding, day }, authority, stats));
      }
      const canonicalCount = canonical.timeseries_row_counts?.[String(options.timeseriesId)];
      if (canonicalCount !== undefined) check(dayRows.length === Number(canonicalCount), "Canonical timeseries row count mismatch");
      const selected = dayRows.filter(([timestamp]) => timestamp >= (isContextDay ? options.contextStart : options.start) && timestamp < options.end);
      (isContextDay ? contextRows : rows).push(...selected);
      check(rows.length + contextRows.length <= 100_000, "Selected observation row budget exceeded");
      dayList.push({ day_utc: day, state: dayRows.length ? "exported" : "authoritative_absence", row_count: selected.length });
    }
    await reader.checkStability();
    const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
    rows.sort((a, b) => compareText(a[0], b[0]) || a[1] - b[1] || compareText(JSON.stringify(a), JSON.stringify(b)));
    contextRows.sort((a, b) => compareText(a[0], b[0]) || a[1] - b[1] || compareText(JSON.stringify(a), JSON.stringify(b)));
    const verificationEntry = authority?.manifest?.timeseries.find((entry) => entry.timeseries_id === options.timeseriesId) || null;
    return finish({ state: days.every((day) => ["exported", "authoritative_absence"].includes(day.state)) ? "complete" : "incomplete", binding, rows, days, contextRows, contextDays, verification: { overlay_authoritative: authority?.overlay_authoritative || false, latest_identity: authority?.latest_identity || null, manifest_identity: authority?.manifest_identity || null, timeseries_entry: verificationEntry, legacy_status_rule: "existing AURN resolveLegacyVerificationStatus (persisted null remains null)" } });
  } catch (error) {
    // Source errors contain only admitted keys/local validation messages. Never
    // serialize signed requests, upstream response bodies, env or error causes.
    return finish({ state: "failed", error: error.message, rows: [], days, contextRows: [], contextDays });
  }
  function finish(result) {
    const cpu = process.cpuUsage(cpuStarted);
    const sourceObjects = [...reader.inventory.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    return { generation: version, bucket: reader.bucket, ...result, source_objects: sourceObjects, metrics: { ...reader.metrics, ...stats, selected_timestamp_value_column_bytes: version === "v3" ? stats.selected_timestamp_value_column_bytes : null, physical_schemas: [...stats.physical_schemas.values()], source_object_count: sourceObjects.length, source_parquet_object_count: sourceObjects.filter((o) => o.key.endsWith(".parquet")).length, source_parquet_object_bytes: sourceObjects.filter((o) => o.key.endsWith(".parquet")).reduce((sum, o) => sum + o.byte_size, 0), extraction_wall_ms: performance.now() - started, extraction_cpu_ms: (cpu.user + cpu.system) / 1000, row_count: result.rows.length } };
  }
}
