#!/usr/bin/env node
// Operator-only diagnostic. No writer, lock, workflow or publication entry point is called.
import { createHash } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolveObservationHistoryGeneration } from "../../workers/shared/uk_aq_observation_history_generation.mjs";
import { resolveR2HistoryIndexConfig } from "../../workers/shared/uk_aq_r2_history_index.mjs";
import { hasRequiredR2Config, r2GetObjectBounded } from "../../workers/shared/r2_sigv4.mjs";
import { validateR2HistoryV2ObservationsAggregateManifest } from "../../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs";
import { validateCanonicalHistoryV2Manifest } from "../../workers/shared/uk_aq_r2_history_manifest_validation.mjs";
import { fingerprint, validatePrevious, monthDependencies, stationIdentity } from "./bc_uv_diurnal_incremental.mjs";

const FORMAT = "uk_aq_bc_uv_read_only_inventory";
const FROM = "2024-01-01";
const LATEST = "derived/bc_uv_diurnal/v1/latest.json";
const DAY = 86_400_000;
const LIMITS = Object.freeze({ requests: 120_000, bytes: 1024 ** 3, object_bytes: 8 * 1024 ** 2,
  product_bytes: 32 * 1024 ** 2, days: 5000, metadata_rows: 2000, duration_ms: 30 * 60_000 });
const digest = (body) => createHash("sha256").update(body).digest("hex");
const same = (a, b) => fingerprint(a) === fingerprint(b);
const check = (condition, code) => { if (!condition) throw new AuditError(code); };
class AuditError extends Error { constructor(code) { super(code); this.auditCode = code; } }
function date(value) {
  check(/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value, "INVALID_UTC_DAY");
  return value;
}
function daysBetween(first, last) {
  const count = (Date.parse(last) - Date.parse(first)) / DAY + 1;
  check(count > 0 && count <= LIMITS.days, "UTC_DAY_BUDGET_EXCEEDED");
  return Array.from({ length: count }, (_, i) => new Date(Date.parse(first) + i * DAY).toISOString().slice(0, 10));
}
const nextDay = (day) => new Date(Date.parse(day) + DAY).toISOString().slice(0, 10);
function ranges(days) {
  const result = [];
  for (const day of [...new Set(days)].sort()) {
    if (result.length && nextDay(result.at(-1).through) === day) result.at(-1).through = day;
    else result.push({ from: day, through: day });
  }
  return result;
}
// Never serialize exceptions, connection targets, arbitrary JSON metadata or client configuration.
function safeError(error) { return { code: error.auditCode || "READ_OR_VALIDATION_FAILED",
  hint: "Check scoped access, required metadata and selected manifests locally; raw driver errors are suppressed." }; }
function redact(text, env = process.env) {
  for (const [key, value] of Object.entries(env)) {
    if (/TOKEN|SECRET|PASSWORD|ACCESS_KEY|DATABASE_URL|DB_URL/i.test(key) && value.length >= 8) text = text.split(value).join("[REDACTED]");
  }
  return text.replace(/(?:postgres(?:ql)?|https?):\/\/[^\s"<>]*@[^\s"<>]*/gi, "[REDACTED_CONNECTION]")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]");
}
async function save(path, value) { await writeFile(path, redact(JSON.stringify(value, null, 2)) + "\n", { flag: "wx", mode: 0o600 }); }

// All data statements are fixed SELECTs. Transaction control only opens/rolls back a read-only snapshot.
const QUERIES = {
  connectors: `select c.id::text, c.connector_code, c.default_network_id::text,
    n.network_code as default_network_code from uk_aq_core.connectors c
    left join uk_aq_core.networks n on n.id=c.default_network_id where c.connector_code='ukair_bc' order by c.id`,
  networks: `select id::text, network_code, display_name, network_type, ingest_enabled, public_display_enabled
    from uk_aq_core.networks where network_code='black_carbon' order by id`,
  properties: `select id::text, code, display_name, domain, canonical_uom
    from uk_aq_core.observed_properties where code in ('bc','uv370') order by code, id`,
  stations: `select s.id::text as station_id, s.station_ref, s.service_ref,
    coalesce(nullif(btrim(s.station_name),''),nullif(btrim(s.label),'')) as name,
    s.station_type, s.region, s.removed_at, n.network_code, n.public_display_enabled,
    ST_Y(s.geometry::geometry) as latitude, ST_X(s.geometry::geometry) as longitude
    from uk_aq_core.stations s join uk_aq_core.connectors c on c.id=s.connector_id
    left join uk_aq_core.networks n on n.id=s.network_id
    where c.connector_code='ukair_bc' order by s.service_ref, s.station_ref, s.id`,
  timeseries: `select t.id::text as timeseries_id, t.station_id::text, t.timeseries_ref, t.service_ref,
    s.station_ref, s.service_ref as station_service_ref, sc.connector_code as station_connector_code,
    t.uom, t.ended_at, t.phenomenon_id::text, p.label as phenomenon_label,
    pc.connector_code as phenomenon_connector_code, op.code as property
    from uk_aq_core.timeseries t join uk_aq_core.connectors c on c.id=t.connector_id
    left join uk_aq_core.stations s on s.id=t.station_id
    left join uk_aq_core.connectors sc on sc.id=s.connector_id
    left join uk_aq_core.phenomena p on p.id=t.phenomenon_id
    left join uk_aq_core.connectors pc on pc.id=p.connector_id
    left join uk_aq_core.observed_properties op on op.id=p.observed_property_id
    where c.connector_code='ukair_bc' order by t.service_ref, t.timeseries_ref, t.id`,
  phenomena: `select p.id::text, p.label, p.source_label, op.code as property
    from uk_aq_core.phenomena p join uk_aq_core.connectors c on c.id=p.connector_id
    left join uk_aq_core.observed_properties op on op.id=p.observed_property_id
    where c.connector_code='ukair_bc' order by p.label, p.id`,
};
const ROUTES = `select r.station_id::text, r.uk_air_ref, r.site_ref, r.source_snapshot_at,
  s.station_ref, s.service_ref from uk_aq_raw.ukair_bc_station_refs r
  join uk_aq_core.stations s on s.id=r.station_id join uk_aq_core.connectors c on c.id=s.connector_id
  where c.connector_code='ukair_bc' order by s.service_ref, s.station_ref`;
const MAPPINGS = `select m.source_label, m.source_uom, m.observed_property_id::text,
  m.observed_property_code, op.code as property, m.mapping_kind, m.is_aqi_eligible, m.is_active
  from uk_aq_core.observed_property_mappings m join uk_aq_core.connectors c on c.id=m.connector_id
  left join uk_aq_core.observed_properties op on op.id=m.observed_property_id
  where c.connector_code='ukair_bc' order by m.source_label`;

async function metadata(url, mirror = false) {
  check(url, mirror ? "MISSING_OBSAQIDB_CONNECTION" : "MISSING_INGESTDB_CONNECTION");
  const { Client } = await import("pg");
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10_000, query_timeout: 20_000,
    options: "-c default_transaction_read_only=on -c statement_timeout=15000 -c idle_in_transaction_session_timeout=30000" });
  client.on("error", () => {}); // connection errors are handled by the bounded query/section failure
  try {
    await client.connect();
    await client.query("begin transaction isolation level repeatable read read only");
    const result = {};
    for (const [name, sql] of Object.entries(QUERIES)) {
      result[name] = JSON.parse(JSON.stringify((await client.query(`${sql} limit ${LIMITS.metadata_rows + 1}`)).rows));
      check(result[name].length <= LIMITS.metadata_rows, "METADATA_ROW_BUDGET_EXCEEDED");
    }
    // Raw routing is IngestDB-owned; the normal mirror need not contain it.
    if (!mirror) {
      for (const [name, sql] of Object.entries({ routes: ROUTES, mappings: MAPPINGS })) {
        result[name] = JSON.parse(JSON.stringify((await client.query(`${sql} limit ${LIMITS.metadata_rows + 1}`)).rows));
        check(result[name].length <= LIMITS.metadata_rows, "METADATA_ROW_BUDGET_EXCEEDED");
      }
    }
    return result;
  } finally { await client.query("rollback").catch(() => {}); await client.end().catch(() => {}); }
}

function assessMetadata(m) {
  const conflicts = [], missing = [], extra = [];
  const add = (code, identity) => conflicts.push({ code, identity });
  for (const [family, expected] of [["connectors", "ukair_bc"], ["networks", "black_carbon"]]) {
    if (!m[family].length) missing.push({ code: "CANONICAL_ROW", identity: expected });
    if (m[family].length > 1) add("DUPLICATE_CANONICAL_ROW", expected);
  }
  for (const property of ["bc", "uv370"]) if (!m.properties.some((p) => p.code === property)) missing.push({ code: "CANONICAL_ROW", identity: property });
  if (m.connectors[0] && m.connectors[0].default_network_code !== "black_carbon") add("CONNECTOR_DEFAULT_NETWORK", "ukair_bc");
  if (m.networks[0] && m.networks[0].network_type !== "official") add("NETWORK_TYPE", "black_carbon");
  for (const p of m.properties) if (p.domain !== "aq" || p.canonical_uom !== "ug/m3") add("PROPERTY_POLICY", p.code);
  const refs = new Set(), ids = new Set();
  for (const s of m.stations) {
    const key = `${s.service_ref}/${s.station_ref}`;
    if (refs.has(key) || ids.has(s.station_id)) add("DUPLICATE_STATION", key);
    refs.add(key); ids.add(s.station_id);
    if (!/^UKA[A-Z0-9]+$/.test(s.station_ref) || s.service_ref !== "ukair_bc" || s.network_code !== "black_carbon") add("STATION_IDENTITY", key);
    if (s.latitude == null || s.longitude == null || !Number.isFinite(Number(s.latitude)) || !Number.isFinite(Number(s.longitude)) ||
      Math.abs(s.latitude) > 90 || Math.abs(s.longitude) > 180) add("STATION_COORDINATES", key);
    const route = m.routes.filter((r) => r.station_id === s.station_id);
    if (!route.length || !route[0].site_ref) missing.push({ code: "SOURCE_ROUTE", identity: key });
    else if (route.length !== 1 || route[0].uk_air_ref !== s.station_ref || !/^[A-Z0-9]+$/.test(route[0].site_ref)) add("SOURCE_ROUTE", key);
  }
  const series = new Set();
  for (const t of m.timeseries) {
    const key = `${t.service_ref}/${t.timeseries_ref}`;
    if (series.has(key)) add("DUPLICATE_TIMESERIES", key);
    series.add(key);
    if (!["bc", "uv370"].includes(t.property)) extra.push({ code: "NON_BC_UV_TIMESERIES", identity: key });
    if (t.service_ref !== "ukair_bc" || t.station_connector_code !== "ukair_bc" || t.station_service_ref !== "ukair_bc" ||
      t.phenomenon_connector_code !== "ukair_bc" || t.timeseries_ref !== `${t.station_ref}:${t.property}` || t.uom !== "ug/m3") add("TIMESERIES_IDENTITY", key);
  }
  for (const property of ["bc", "uv370"]) {
    if (!m.timeseries.some((t) => t.property === property)) missing.push({ code: "PROPERTY_TIMESERIES", identity: property });
    if (!m.phenomena.some((p) => p.property === property)) missing.push({ code: "PROPERTY_PHENOMENON", identity: property });
    const mappings = m.mappings.filter((r) => r.property === property);
    if (!mappings.length) missing.push({ code: "PROPERTY_SOURCE_MAPPING", identity: property });
    for (const r of mappings) if (r.observed_property_code !== property || r.source_uom !== "ug/m3" ||
      r.mapping_kind !== "raw_observed_property" || r.is_aqi_eligible !== false || r.is_active !== true) add("PROPERTY_SOURCE_MAPPING", r.source_label);
  }
  return { missing, extra, conflicts, public_display_eligible: m.networks[0]?.public_display_enabled === true };
}

function reader(r2) {
  const started = performance.now(), identities = new Map();
  const stats = { requests: 0, bytes: 0, parquet_objects_read: 0 };
  async function get(key, { optional = false, product = false, fence = true } = {}) {
    check(typeof key === "string" && key.endsWith(".json") && !key.split("/").some((p) => !p || p === "." || p === "..") &&
      !/[\\\x00-\x1f\x7f]/.test(key) && /^(history\/(v3|_index_v3)\/|derived\/bc_uv_diurnal\/v1\/)/.test(key), "OUT_OF_SCOPE_JSON_KEY");
    check(++stats.requests <= LIMITS.requests && performance.now() - started < LIMITS.duration_ms, "R2_REQUEST_OR_TIME_BUDGET_EXCEEDED");
    const remainingTime = Math.max(1, Math.min(30_000, Math.floor(LIMITS.duration_ms - (performance.now() - started))));
    const maxBytes = Math.min(product ? LIMITS.product_bytes : LIMITS.object_bytes, LIMITS.bytes - stats.bytes);
    check(maxBytes > 0, "R2_BYTE_BUDGET_EXCEEDED");
    let object;
    try { object = await r2GetObjectBounded({ r2, key, max_bytes: maxBytes, timeout_ms: remainingTime }); }
    catch (error) {
      if (optional && error.status === 404) { if (fence) identities.set(key, null); return null; }
      throw error;
    }
    stats.bytes += object.bytes;
    const identity = { key, byte_size: object.bytes, sha256: digest(object.body) };
    if (fence) {
      if (identities.has(key)) check(same(identities.get(key), identity), "SOURCE_CHANGED_DURING_INVENTORY");
      identities.set(key, identity);
    }
    return { ...object, byte_size: object.bytes, identity, payload: JSON.parse(object.body.toString("utf8")) };
  }
  return { get, stats, identities, async verify() {
    // Recheck selected mutable ancestors/selectors, including authenticated absences.
    // Leaves are body-pinned by their rechecked selectors; no observation bodies are read.
    for (const [key, expected] of identities) {
      if (key.includes("/timeseries_id=") || key.includes("/generations/")) continue;
      const actual = await get(key, { optional: expected === null, product: key === LATEST, fence: false });
      check(same(actual?.identity ?? null, expected), "SOURCE_CHANGED_DURING_INVENTORY");
    }
  } };
}

async function hierarchy(io, generation, through) {
  const prefix = generation.observations_prefix;
  const root = await io.get(generation.observations_root_key);
  const validate = (o, kind) => {
    const value = validateR2HistoryV2ObservationsAggregateManifest(o.payload, { basePrefix: prefix });
    check(value.kind === kind, "AGGREGATE_KIND_MISMATCH"); return value;
  };
  const selected = new Map();
  for (const year of validate(root, "uk_aq_observations_root_manifest").children) {
    if (year.year < 2024 || year.year > Number(through.slice(0, 4))) continue;
    const y = validate(await io.get(year.manifest_key), "uk_aq_observations_year_manifest");
    check(y.year === year.year && y.content_hash === year.content_hash, "YEAR_PARENT_IDENTITY_MISMATCH");
    for (const month of y.children) {
      if (`${year.year}-${month.month}` > through.slice(0, 7)) continue;
      const m = validate(await io.get(month.manifest_key), "uk_aq_observations_month_manifest");
      check(m.year === year.year && m.month === month.month && m.content_hash === month.content_hash, "MONTH_PARENT_IDENTITY_MISMATCH");
      for (const day of m.children) if (day.day_utc >= FROM && day.day_utc <= through) {
        check(!selected.has(day.day_utc) && selected.size < LIMITS.days, "DUPLICATE_OR_EXCESSIVE_DAYS");
        selected.set(day.day_utc, day);
      }
    }
  }
  return { root: { ...root.identity, content_hash: root.payload.content_hash }, selected };
}

async function canonical(io, key, expected, hash) {
  const object = await io.get(key);
  validateCanonicalHistoryV2Manifest(object.payload, { history_version: "v2", domain: "observations", manifest_key: key, ...expected });
  check(object.payload.manifest_hash === hash, "CANONICAL_PARENT_HASH_MISMATCH");
  return object;
}
function children(manifest, alias, field) {
  const a = manifest.child_manifests, b = manifest[alias];
  check(Array.isArray(a) && Array.isArray(b) && new Set(a.map((e) => e[field])).size === a.length &&
    same([...a].sort((x, y) => String(x[field]).localeCompare(String(y[field]))),
      [...b].sort((x, y) => String(x[field]).localeCompare(String(y[field])))), "CONTRADICTORY_CHILD_ALIASES");
  return a;
}
function pin(object, descriptor) {
  check(object && descriptor && object.identity.key === descriptor.key && object.identity.byte_size === descriptor.byte_size &&
    object.identity.sha256 === descriptor.sha256, "PINNED_OBJECT_IDENTITY_MISMATCH");
}

async function history(io, generation, m, through) {
  const { readObservationHistoryExactLeafDailyMetadataV3 } = await import("../../workers/shared/uk_aq_observation_history_exact_leaf_reader_v3.mjs");
  const { OBSERVATION_HISTORY_EXACT_LEAF_INDEX_VERSION } = await import("../../workers/shared/uk_aq_observation_history_target_writer.mjs");
  const selected = await hierarchy(io, generation, through);
  const connectorId = Number(m.connectors[0].id), prefix = generation.observations_prefix;
  check(Number.isSafeInteger(connectorId) && connectorId > 0, "INVALID_CONNECTOR_ID");
  const records = [], seriesCoverage = new Map(), issues = [];
  const index = { root: generation.observations_timeseries_index_prefix,
    alignedIndexRoot: `${generation.observations_timeseries_index_prefix}/_aligned`, alignedDataRoot: prefix,
    indexGeneration: "v3", historyVersion: "v2", physicalLayoutVersion: "timeseries-aligned-v2", alignedRowCap: 1024,
    decodeProfileId: "hyparquet-direct-column-v1", manifestKind: "observation_timeseries_physical_leaf_scoped_manifest",
    leafKind: "observation_timeseries_physical_leaf", additionalCommonFields: { exact_leaf_index_version: OBSERVATION_HISTORY_EXACT_LEAF_INDEX_VERSION },
    supportedExactSchemas: [1, 2] };
  for (const [day, ref] of [...selected.selected].sort()) {
    const dayKey = `${prefix}/day_utc=${day}/manifest.json`;
    check(ref.manifest_key === dayKey, "CANONICAL_DAY_KEY_MISMATCH");
    const d = await canonical(io, dayKey, { manifest_kind: "day", day_utc: day }, ref.manifest_hash);
    const cRef = children(d.payload, "connector_manifests", "connector_id").find((c) => c.connector_id === connectorId);
    if (!cRef) continue;
    const cKey = `${prefix}/day_utc=${day}/connector_id=${connectorId}/manifest.json`;
    check(cRef.manifest_key === cKey, "CANONICAL_CONNECTOR_KEY_MISMATCH");
    const c = await canonical(io, cKey, { manifest_kind: "connector", day_utc: day, connector_id: connectorId }, cRef.manifest_hash);
    for (const pRef of children(c.payload, "pollutant_manifests", "pollutant_code")) {
      if (!["bc", "uv370"].includes(pRef.pollutant_code)) continue;
      const property = pRef.pollutant_code, scope = `day_utc=${day}/connector_id=${connectorId}/pollutant_code=${property}`;
      const key = `${prefix}/${scope}/manifest.json`;
      check(pRef.manifest_key === key, "CANONICAL_PROPERTY_KEY_MISMATCH");
      const p = await canonical(io, key, { manifest_kind: "pollutant", day_utc: day, connector_id: connectorId, pollutant_code: property }, pRef.manifest_hash);
      check(/^[0-9a-f]{64}$/.test(p.payload.observation_content_hash) &&
        p.payload.observation_content_hash_row_count === p.payload.row_count, "CANONICAL_CONTENT_IDENTITY_UNAVAILABLE");
      const counts = p.payload.timeseries_row_counts;
      check(counts && Object.keys(counts).length <= LIMITS.metadata_rows, "CANONICAL_TIMESERIES_COUNTS_UNAVAILABLE");
      const record = { day_utc: day, property, ...p.identity, manifest_hash: p.payload.manifest_hash,
        observation_content_hash: p.payload.observation_content_hash, row_count: p.payload.row_count,
        min_observed_at_utc: p.payload.min_observed_at_utc, max_observed_at_utc: p.payload.max_observed_at_utc,
        files: p.payload.files.map((f) => ({ key: f.key, bytes: f.bytes, etag_or_hash: f.etag_or_hash })),
        index_status: "unverified" };
      records.push(record);
      // Cache one scope only. The existing reader validates selector/leaf identities and segments, without Parquet reads.
      const cache = new Map();
      const source = { getIndexObject: async ({ key: k, maxBytes = LIMITS.object_bytes }) => {
        if (!cache.has(k)) cache.set(k, io.get(k, { optional: true }));
        const object = await cache.get(k);
        check(!object || object.byte_size <= maxBytes, "EXACT_INDEX_BYTE_BUDGET_EXCEEDED");
        return object;
      } };
      const selectorKey = `${index.root}/${scope}/manifest.json`;
      const selector = await source.getIndexObject({ key: selectorKey });
      if (!selector) { issues.push({ code: "SCOPED_INDEX_MISSING", day_utc: day, property }); continue; }
      const ids = Object.keys(counts).sort((a, b) => Number(a) - Number(b));
      check(same(ids, Object.keys(selector.payload.leaves_by_timeseries_id || {}).sort((a, b) => Number(a) - Number(b))), "INDEX_CANONICAL_MEMBERSHIP_MISMATCH");
      let canonicalSource;
      if (selector.payload.schema_version === 1) {
        const descriptor = selector.payload.source_aligned_scoped_manifest;
        check(descriptor?.key === `${index.alignedIndexRoot}/${scope}/manifest.json`, "ALIGNED_SOURCE_KEY_MISMATCH");
        const aligned = await io.get(descriptor.key); pin(aligned, descriptor);
        canonicalSource = aligned.payload.canonical_source_manifest;
      } else canonicalSource = selector.payload.canonical_source_manifest;
      pin(p, canonicalSource);
      check(canonicalSource.manifest_hash === p.payload.manifest_hash && canonicalSource.row_count === p.payload.row_count &&
        canonicalSource.observation_content_hash === p.payload.observation_content_hash, "INDEX_CANONICAL_SOURCE_MISMATCH");
      let total = 0;
      for (const id of ids) {
        const timeseriesId = Number(id), count = counts[id];
        check(Number.isSafeInteger(timeseriesId) && timeseriesId > 0 && Number.isSafeInteger(count) && count > 0, "INVALID_CANONICAL_SERIES_COUNT");
        total += count;
        const ts = m.timeseries.find((t) => t.timeseries_id === id && t.property === property);
        if (!ts) issues.push({ code: "HISTORY_SERIES_METADATA_MISSING", timeseries_id: id, property });
        const result = await readObservationHistoryExactLeafDailyMetadataV3({ source, timeseriesId, connectorId,
          pollutantCode: property, startUtc: `${day}T00:00:00.000Z`, endUtc: `${nextDay(day)}T00:00:00.000Z`, index });
        check(result.coverage_complete && result.rows.length === 1 && result.rows[0].row_count === count, "EXACT_LEAF_COVERAGE_MISMATCH");
        const row = result.rows[0], stable = ts ? `ukair_bc/${ts.station_service_ref}/${ts.station_ref}/${property}` : `unresolved/${id}/${property}`;
        if (!seriesCoverage.has(stable)) seriesCoverage.set(stable, { identity: stable, station_ref: ts?.station_ref ?? null,
          timeseries_ref: ts?.timeseries_ref ?? null, timeseries_id: id, property, days: [], row_count: 0,
          earliest: row.min_observed_at_utc, latest: row.max_observed_at_utc, days_with_fewer_than_24_rows: [] });
        const coverage = seriesCoverage.get(stable);
        coverage.days.push(day); coverage.row_count += count;
        coverage.earliest = [coverage.earliest, row.min_observed_at_utc].sort()[0];
        coverage.latest = [coverage.latest, row.max_observed_at_utc].sort().at(-1);
        if (count < 24) coverage.days_with_fewer_than_24_rows.push(day);
      }
      check(total === p.payload.row_count, "CANONICAL_SCOPE_COUNT_MISMATCH");
      record.index_status = "validated_metadata";
    }
  }
  const allDays = daysBetween(FROM, through);
  const coverage = [...seriesCoverage.values()].sort((a, b) => a.identity.localeCompare(b.identity)).map(({ days, ...s }) => {
    const set = new Set(days);
    return { ...s, represented_utc_days: ranges(days), unrepresented_utc_days: ranges(allDays.filter((d) => !set.has(d))),
      days_with_fewer_than_24_rows: ranges(s.days_with_fewer_than_24_rows) };
  });
  return { status: "ok", root: selected.root, selected_day_dependencies: [...selected.selected.values()], scopes: records,
    canonical_bc_present: records.some((r) => r.row_count > 0), coverage, issues,
    absent_property_days: Object.fromEntries(["bc", "uv370"].map((p) => {
      const represented = new Set(records.filter((r) => r.property === p && r.row_count > 0).map((r) => r.day_utc));
      return [p, ranges(allDays.filter((d) => !represented.has(d)))];
    })), evidence_level: "authenticated_manifest_and_exact_leaf_metadata_only",
    observations_verified: false,
    uncertainty: "No Parquet bodies, values, P/R statuses or exact hourly slots were verified. Unrepresented UTC days need source/lifecycle interpretation; they are not proof of lost observations. Metadata cannot certify bootstrap completeness." };
}

async function product(io, m, h) {
  const latest = await io.get(LATEST, { optional: true, product: true });
  if (!latest) return { status: "absent", present: false };
  const value = latest.payload;
  // Existing validator binds monthly profiles, station identity, boundary-day dependencies and source-through day.
  const provenance = validatePrevious(value);
  const key = `derived/bc_uv_diurnal/v1/generations/${latest.identity.sha256}.json`;
  const immutable = await io.get(key, { optional: true, product: true });
  const issues = [];
  if (!immutable) issues.push({ code: "IMMUTABLE_GENERATION_MISSING" });
  else check(immutable.body.equals(latest.body), "IMMUTABLE_GENERATION_BYTES_DIFFER");
  let eligible = null;
  if (m?.status === "ok") {
    const { selectPublicStations } = await import("./build_bc_uv_diurnal.mjs");
    try { eligible = selectPublicStations(m.stations.filter((s) => s.service_ref === "ukair_bc" && s.network_code === "black_carbon" &&
      s.removed_at === null && s.public_display_enabled === true), m.timeseries); }
    catch { issues.push({ code: "ELIGIBLE_METADATA_UNAVAILABLE" }); }
    if (eligible && !same(eligible.map(stationIdentity), value.sensors.map(stationIdentity))) issues.push({ code: "PRODUCT_CURRENT_METADATA_DIFFERS" });
    if (provenance && provenance.derivation.connector_id !== Number(m.connectors[0]?.id)) issues.push({ code: "PRODUCT_CONNECTOR_ID_DIFFERS" });
  }
  const dependencies = provenance?.months.map((r) => ({ month: r.month, dependency_sha256: r.dependency_sha256,
    profiles_sha256: r.profiles_sha256, source_through_day: r.source_through_day, dependencies: r.dependencies })) ?? [];
  let currentDependencies = null;
  if (provenance && h?.status === "ok") {
    const byDate = new Map(h.selected_day_dependencies.map((d) => [d.day_utc, d]));
    currentDependencies = true;
    for (const record of provenance.months) {
      if (record.dependencies.some((d) => d.day_utc > h.through)) { currentDependencies = null; break; }
      if (!same(record.dependencies, monthDependencies(record.month, byDate))) {
        currentDependencies = false; issues.push({ code: "CURRENT_SOURCE_DEPENDENCIES_DIFFER", month: record.month });
      }
    }
  }
  return { status: "ok", present: true, validation: "existing_product_and_incremental_validators_passed",
    contract_version: value.contract_version, latest: latest.identity,
    immutable_generation: immutable?.identity ?? null, generated_at: value.generated_at,
    source_through_day: value.source_through_day, months: value.months, station_count: value.sensors.length,
    stations: value.sensors.map(stationIdentity), latest_bc_reporting: value.latest_bc_reporting ?? null,
    latest_bc_reporting_station_refs: value.latest_bc_reporting?.station_ids.map((id) => value.sensors.find((s) => s.station_id === id)?.station_ref) ?? null,
    monitoring_location_count: value.monitoring_location_count ?? null,
    incremental_provenance_available: provenance !== null,
    own_provenance_consistent: provenance ? true : null,
    derivation: provenance?.derivation ?? null, dependencies,
    current_source_dependencies_match: currentDependencies, current_eligible_metadata_match: eligible ? same(eligible.map(stationIdentity), value.sensors.map(stationIdentity)) : null,
    issues, uncertainty: "Schema/provenance consistency does not recompute science or verify the latest reporting summary from observations. Current source differences may indicate legitimate newer canonical data." };
}

export async function inventory({ environment, through, env = process.env }) {
  check(["TEST", "LIVE"].includes(environment), "INVALID_ENVIRONMENT_LABEL");
  date(through); daysBetween(FROM, through);
  const report = { kind: FORMAT, schema_version: 1, environment, observed_at: new Date().toISOString(),
    scope: { from_utc_day: FROM, through_utc_day: through }, limits: LIMITS, status: "incomplete", errors: [],
    target: { identity_basis: "operator-selected existing profile; environment is an audit label, not an independent target attestation" } };
  const run = async (name, fn) => {
    try { report[name] = await fn(); }
    catch (error) { report[name] = { status: "failed", error: safeError(error) }; report.errors.push({ section: name, ...safeError(error) }); }
  };
  await run("metadata", async () => {
    const m = await metadata(env.UK_AQ_INGEST_DATABASE_URL || env.SUPABASE_DB_URL);
    const { selectPublicStations } = await import("./build_bc_uv_diurnal.mjs");
    let publisherEligible = null;
    try { publisherEligible = selectPublicStations(m.stations.filter((s) => s.service_ref === "ukair_bc" &&
      s.network_code === "black_carbon" && s.removed_at === null && s.public_display_enabled === true), m.timeseries); }
    catch { /* Missing eligibility is an audit finding, never manufactured metadata. */ }
    return { status: "ok", ...m, assessment: assessMetadata(m), publisher_eligible_stations: publisherEligible,
      snapshot_sha256: fingerprint(m) };
  });
  if (report.metadata.status === "ok" && (report.metadata.connectors.length !== 1 || report.metadata.networks.length !== 1 ||
    report.metadata.properties.length !== 2 || !report.metadata.stations.length || !report.metadata.timeseries.length)) {
    report.errors.push({ section: "metadata", code: "REQUIRED_CANONICAL_METADATA_UNAVAILABLE" });
  }
  if (report.metadata.status === "ok" && report.metadata.assessment.conflicts.length) {
    report.errors.push({ section: "metadata", code: "CONFLICTING_CANONICAL_METADATA" });
  }
  if (report.metadata.status === "ok" && report.metadata.assessment.missing.some((r) => r.code.startsWith("PROPERTY_"))) {
    report.errors.push({ section: "metadata", code: "REQUIRED_PROPERTY_METADATA_UNAVAILABLE" });
  }
  if (env.OBS_AQIDB_SUPABASE_DB_URL) await run("metadata_mirror", async () => {
    const m = await metadata(env.OBS_AQIDB_SUPABASE_DB_URL, true);
    const source = report.metadata;
    return { status: "ok", ...m, comparison: source.status === "ok" ? diffMetadata(source, m) : null,
      note: "Compare stable keys and numeric IDs within this environment; raw routing and property policy mappings are not mirror requirements." };
  });
  else report.metadata_mirror = { status: "not_inspected", reason: "OBS_AQIDB_SUPABASE_DB_URL unavailable; optional mirror access" };
  let io, generation;
  await run("r2_connection", async () => {
    check(env.UK_AQ_R2_HISTORY_VERSION, "MISSING_HISTORY_GENERATION_CONFIGURATION");
    generation = resolveObservationHistoryGeneration(env);
    check(generation.version === "v3", "SELECTED_HISTORY_GENERATION_IS_NOT_V3");
    const r2 = resolveR2HistoryIndexConfig(env).r2;
    check(hasRequiredR2Config(r2), "MISSING_R2_READ_CONNECTION");
    io = reader(r2);
    report.target.r2_target_sha256 = fingerprint({ endpoint: r2.endpoint, bucket: r2.bucket });
    return { status: "ok", generation };
  });
  if (io && report.metadata.status === "ok" && report.metadata.connectors.length === 1) await run("history", async () => ({ ...await history(io, generation, report.metadata, through), through }));
  else report.history = { status: "not_inspected", reason: "Both canonical metadata and selected R2 access are required" };
  if (report.history.status === "ok" && report.history.issues.length) {
    report.errors.push({ section: "history", code: "REQUIRED_HISTORY_METADATA_UNAVAILABLE" });
  }
  if (io) await run("product", () => product(io, report.metadata, report.history));
  else report.product = { status: "not_inspected", reason: "R2 read connection unavailable" };
  if (io) {
    await run("source_fence", async () => { await io.verify(); return { status: "ok" }; });
    report.r2_usage = io.stats;
    report.object_identities = [...io.identities].sort(([a], [b]) => a.localeCompare(b)).map(([key, identity]) => identity ?? { key, absent: true });
  }
  if (report.metadata.status === "ok") await run("metadata_fence", async () => {
    check(fingerprint(await metadata(env.UK_AQ_INGEST_DATABASE_URL || env.SUPABASE_DB_URL)) === report.metadata.snapshot_sha256,
      "METADATA_CHANGED_DURING_INVENTORY"); return { status: "ok" };
  });
  report.status = report.errors.length ? "incomplete" : "complete";
  report.completed_at = new Date().toISOString();
  return report;
}

const KEY = {
  connectors: (r) => r.connector_code, networks: (r) => r.network_code, properties: (r) => r.code,
  stations: (r) => `${r.service_ref}/${r.station_ref}`, timeseries: (r) => `${r.service_ref}/${r.timeseries_ref}`,
  phenomena: (r) => r.label, routes: (r) => `${r.service_ref}/${r.station_ref}`, mappings: (r) => r.source_label,
};
const ID_FIELDS = new Set(["id", "station_id", "timeseries_id", "phenomenon_id", "default_network_id", "observed_property_id"]);
function nonNumeric(row) {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !ID_FIELDS.has(key) && key !== "source_snapshot_at"));
}
function diffMetadata(test, live) {
  const result = { missing_in_live: [], extra_in_live: [], conflicts: [], numeric_id_differences: [], matched: [] };
  for (const [family, key] of Object.entries(KEY)) {
    if (!Array.isArray(test[family]) || !Array.isArray(live[family])) continue;
    const map = (rows) => {
      const value = new Map();
      for (const row of rows) { const identity = key(row);
        if (value.has(identity)) result.conflicts.push({ family, identity, reason: "duplicate stable identity" });
        value.set(identity, row);
      }
      return value;
    };
    const a = map(test[family]), b = map(live[family]);
    for (const identity of [...new Set([...a.keys(), ...b.keys()])].sort()) {
      if (!b.has(identity)) result.missing_in_live.push({ family, identity });
      else if (!a.has(identity)) result.extra_in_live.push({ family, identity });
      else {
        const left = a.get(identity), right = b.get(identity);
        if (same(nonNumeric(left), nonNumeric(right))) result.matched.push({ family, identity });
        else result.conflicts.push({ family, identity, test: nonNumeric(left), live: nonNumeric(right) });
        for (const field of ID_FIELDS) if (Object.hasOwn(left, field) && left[field] !== right[field]) {
          result.numeric_id_differences.push({ family, identity, field, test: left[field], live: right[field] });
        }
      }
    }
  }
  return result;
}

function validateInventory(r, label) {
  check(r?.kind === FORMAT && r.schema_version === 1 && r.environment === label &&
    ["complete", "incomplete"].includes(r.status) && Array.isArray(r.errors) &&
    r.scope?.from_utc_day === FROM && typeof r.observed_at === "string", "INVALID_INVENTORY_REPORT");
  date(r.scope.through_utc_day); daysBetween(FROM, r.scope.through_utc_day);
}
export function compare(test, live) {
  validateInventory(test, "TEST"); validateInventory(live, "LIVE");
  const available = (r) => r.history?.status === "ok" && r.metadata?.status === "ok" && r.source_fence?.status === "ok" && r.metadata_fence?.status === "ok";
  const scopesMatch = same(test.scope, live.scope);
  const metadataDiff = test.metadata?.status === "ok" && live.metadata?.status === "ok" ? diffMetadata(test.metadata, live.metadata) : null;
  const reliable = test.status === "complete" && live.status === "complete" && available(test) && available(live) && scopesMatch;
  const sourceComparison = reliable ? {
    configured_r2_target_fingerprints_equal: test.target.r2_target_sha256 === live.target.r2_target_sha256,
    selected_generation_equal: test.r2_connection.generation.version === live.r2_connection.generation.version,
    global_root_content_hash_equal: test.history.root.content_hash === live.history.root.content_hash,
    bc_scope_manifest_identities_equal: same(test.history.scopes, live.history.scopes),
    warning: "Global root differences may concern unrelated connectors; matching schema/layout is not matching source content. Equal configured target fingerprints require operator review of the selected profiles; audit labels do not attest environment identity.",
    missing_series_in_live: test.history.coverage.filter((a) => !live.history.coverage.some((b) => a.identity === b.identity)).map((r) => r.identity),
    extra_series_in_live: live.history.coverage.filter((a) => !test.history.coverage.some((b) => a.identity === b.identity)).map((r) => r.identity),
    series: test.history.coverage.flatMap((a) => { const b = live.history.coverage.find((v) => v.identity === a.identity);
      return b ? [{ identity: a.identity, test: a, live: b }] : []; }),
  } : null;
  const tp = test.product, lp = live.product;
  const liveDays = new Map((live.history?.selected_day_dependencies || []).map((d) => [d.day_utc, d]));
  const testProvenance = tp?.status === "ok" && tp.incremental_provenance_available;
  const crossDependenciesInScope = testProvenance && tp.dependencies.every((r) => r.dependencies.every((d) => d.day_utc <= live.scope.through_utc_day));
  const cross = {
    immutable_test_generation_verified: tp?.status === "ok" ? Boolean(tp.immutable_generation) : null,
    live_connector_id_matches: testProvenance && live.metadata?.status === "ok" ? tp.derivation.connector_id === Number(live.metadata.connectors[0]?.id) : null,
    live_eligible_station_and_timeseries_ids_match: testProvenance && live.metadata?.publisher_eligible_stations ?
      same(tp.derivation.stations, live.metadata.publisher_eligible_stations.map(stationIdentity)) : null,
    live_day_dependencies_match: reliable && crossDependenciesInScope ? tp.dependencies.every((r) => same(r.dependencies, monthDependencies(r.month, liveDays))) : null,
    live_publisher_implementation_and_source_acceptance: "not_verified_by_inventory",
  };
  const reuseRejected = Object.entries(cross).some(([key, value]) => key !== "live_publisher_implementation_and_source_acceptance" && value === false);
  // A diagnostic never promotes matching metadata to data acceptance or import authorisation.
  return { kind: "uk_aq_bc_uv_compatibility_comparison", schema_version: 1,
    observations: { test: test.observed_at, live: live.observed_at }, scope_matches: scopesMatch,
    inventories_complete: test.status === "complete" && live.status === "complete",
    metadata: metadataDiff, source: sourceComparison,
    product_bytes_equal: tp?.status === "ok" && lp?.status === "ok" ? tp.latest.sha256 === lp.latest.sha256 : null,
    live_canonical_bc_present: available(live) ? live.history.canonical_bc_present : null,
    live_product_present: ["ok", "absent"].includes(lp?.status) && live.source_fence?.status === "ok" ? lp.present : null,
    live_bootstrap_sufficient: "unproven_without_observation_validation_and_source_scope_acceptance",
    test_product_live_compatibility: cross,
    test_product_reusable_without_live_canonical_publication: reuseRejected ? "incompatible_with_verified_prerequisites; do_not_copy" : "not_established_by_this_metadata_audit",
    historical_live_reconciliation: available(live) && !live.history.canonical_bc_present ? "required_for_2024_onwards_initial_history" : "conditional_on_authenticated_live_coverage_and_official_source_review",
    writer_mediated_import: "Consider only if official acquisition is unavailable or materially slower; requires separate contract, identity remapping and shared LIVE writer publication.",
    recommendation: "Establish LIVE stable metadata and canonical coverage first. Use existing official-source selected BC/UV reconciliation for missing/unaccepted history, then bootstrap a LIVE-owned product. If accepted LIVE history is already sufficient, skip historical reconciliation and publish from LIVE. Deploy/accept the LIVE API before releasing Beta; enable recurring refresh separately.",
    limitations: ["No observations downloaded or revalidated; matching identities or object formats do not prove portability.",
      "Numeric IDs and source dependency fingerprints in TEST provenance cannot be copied on assumption.",
      "Independent inventories are timestamped observations, not a simultaneous cross-environment snapshot.",
      ...(!scopesMatch ? ["UTC audit scopes differ; canonical coverage comparison withheld."] : [])],
  };
}

export function markdown(result, test, live) {
  const render = (value) => redact(JSON.stringify(value ?? null));
  const known = (value) => value === null ? "unresolved" : value ? "yes" : "no";
  const lines = ["# TEST/LIVE Black Carbon compatibility audit", "",
    `Observed: TEST ${test.observed_at}; LIVE ${live.observed_at}.`, "",
    `Inventory status: TEST **${test.status}**; LIVE **${live.status}**. Matching UTC scope: **${known(result.scope_matches)}**.`, "",
    `LIVE canonical BC present: **${known(result.live_canonical_bc_present)}**. LIVE derived product present: **${known(result.live_product_present)}**.`, "",
    "## Available data and unresolved access", "",
    "| Evidence | TEST | LIVE |", "|---|---|---|",
    ...["metadata", "metadata_mirror", "history", "product", "source_fence", "metadata_fence"].map((s) => `| ${s} | ${test[s]?.status ?? "unavailable"} | ${live[s]?.status ?? "unavailable"} |`), "",
    ...[test, live].flatMap((r) => r.errors.map((e) => `- ${r.environment}: ${e.section}: ${e.code}.`)), "",
    "## Stable metadata identities", ""];
  if (result.metadata) {
    for (const key of ["missing_in_live", "extra_in_live", "conflicts", "numeric_id_differences"]) {
      lines.push(`### ${key}`, "", "```json", render(result.metadata[key]), "```", "");
    }
    lines.push(`Matching metadata records: ${result.metadata.matched.length}. Numeric ID differences require remapping, independently of stable-key compatibility.`, "");
  } else lines.push("Metadata comparison unavailable. Missing access is not evidence of missing metadata.", "");
  lines.push("## Canonical history and derived product", "");
  for (const r of [test, live]) {
    lines.push(`### ${r.environment}`, "");
    if (r.history?.status === "ok") lines.push(`Root: ${render(r.history.root)}.`, "",
      `Coverage: ${r.history.coverage.length} represented station/property series; ${r.history.scopes.length} BC/UV day/property scopes.`, "",
      "| Stable series | Earliest UTC endpoint | Latest UTC endpoint | Rows | Unrepresented day ranges |", "|---|---|---|---|---|",
      ...r.history.coverage.map((s) => `| ${s.identity} | ${s.earliest} | ${s.latest} | ${s.row_count} | ${s.unrepresented_utc_days.length} |`), "",
      `Metadata issues: ${render(r.history.issues)}. Exact gap ranges, low-row days, file/content/index identities and day dependencies are in the JSON inventory.`, "", r.history.uncertainty, "");
    else lines.push("Canonical history remains unverified.", "");
    if (r.product?.status === "ok") lines.push(`Product v${r.product.contract_version}: ${r.product.latest.sha256} (${r.product.latest.byte_size} bytes); immutable present: ${Boolean(r.product.immutable_generation)}.`, "",
      `Source through ${r.product.source_through_day}; ${r.product.months.length} months; ${r.product.station_count} stations. Latest BC reporting: ${render(r.product.latest_bc_reporting)}; UKA refs: ${render(r.product.latest_bc_reporting_station_refs)}.`, "",
      `Incremental provenance: ${r.product.incremental_provenance_available}; own provenance consistent: ${render(r.product.own_provenance_consistent)}; current canonical dependencies match: ${render(r.product.current_source_dependencies_match)}; eligible metadata match: ${render(r.product.current_eligible_metadata_match)}.`, "",
      `Product issues: ${render(r.product.issues)}.`, "", r.product.uncertainty, "");
    else lines.push(`Product: ${r.product?.status ?? "unavailable"}.`, "");
  }
  if (result.source) lines.push(`Global canonical root content hashes equal: ${result.source.global_root_content_hash_equal}; scoped BC manifests/index audit records equal: ${result.source.bc_scope_manifest_identities_equal}.`, "", result.source.warning, "");
  lines.push("## Compatibility decisions and quickest safe route", "",
    `- LIVE publisher bootstrap sufficiency: ${result.live_bootstrap_sufficient}.`,
    `- TEST derived-product reuse without new LIVE canonical publication: ${result.test_product_reusable_without_live_canonical_publication}.`,
    `- TEST-to-LIVE prerequisite checks: ${render(result.test_product_live_compatibility)}.`,
    `- Historical official-source reconciliation: ${result.historical_live_reconciliation}.`,
    `- Writer-mediated TEST import: ${result.writer_mediated_import}`, "", result.recommendation, "",
    ...result.limitations.map((l) => `- ${l}`), "", "This audit grants no write, workflow, deployment, import or release authority.", "");
  return lines.join("\n");
}

const USAGE = `Usage:
  node scripts/ukair_bc/audit_bc_uv_compatibility.mjs inventory --environment TEST|LIVE --out inventory.json [--through YYYY-MM-DD]
  node scripts/ukair_bc/audit_bc_uv_compatibility.mjs compare --test test.json --live live.json --out comparison.md [--json comparison.json]
Existing profiles/configuration only. Outputs must not already exist. No remote writes. Exit 1 = incomplete inventory; 2 = invalid invocation/report.
`;
async function main(args) {
  if (args.length === 0 || args[0] === "--help") { process.stdout.write(USAGE); return; }
  const [mode, ...rest] = args, flags = {};
  const allowed = mode === "inventory" ? ["--environment", "--out", "--through"] : mode === "compare" ? ["--test", "--live", "--out", "--json"] : [];
  check(allowed.length && rest.length % 2 === 0, "INVALID_ARGUMENTS");
  for (let i = 0; i < rest.length; i += 2) {
    check(allowed.includes(rest[i]) && !Object.hasOwn(flags, rest[i]) && rest[i + 1] && !rest[i + 1].startsWith("--"), "INVALID_ARGUMENTS");
    flags[rest[i]] = rest[i + 1];
  }
  check(flags["--out"], "OUTPUT_PATH_REQUIRED");
  if (mode === "inventory") {
    const report = await inventory({ environment: flags["--environment"], through: flags["--through"] || new Date().toISOString().slice(0, 10) });
    await save(flags["--out"], report);
    process.stdout.write(JSON.stringify({ status: report.status, errors: report.errors }) + "\n");
    if (report.status !== "complete") process.exitCode = 1;
  } else {
    check(flags["--test"] && flags["--live"], "BOTH_INVENTORY_FILES_REQUIRED");
    const read = async (path) => {
      const file = await open(path, "r");
      try {
        check((await file.stat()).size <= 128 * 1024 ** 2, "INVENTORY_FILE_TOO_LARGE");
        const bytes = await file.readFile(); check(bytes.length <= 128 * 1024 ** 2, "INVENTORY_FILE_TOO_LARGE");
        return JSON.parse(bytes.toString("utf8"));
      } finally { await file.close(); }
    };
    const test = await read(flags["--test"]), live = await read(flags["--live"]);
    const result = compare(test, live);
    await writeFile(flags["--out"], redact(markdown(result, test, live)), { flag: "wx", mode: 0o600 });
    if (flags["--json"]) await save(flags["--json"], result);
    process.stdout.write(JSON.stringify({ status: result.inventories_complete ? "compared" : "compared_incomplete_inventories" }) + "\n");
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(JSON.stringify(safeError(error)) + "\n" + USAGE); process.exitCode = 2; });
}
