import { createHash } from "node:crypto";
import { createAccumulator, PROPERTIES, validateProduct } from "./bc_uv_diurnal_product.mjs";

export const FROM_DAY = "2024-01-01";
export const ALGORITHM = "bc-uv-monthly-v1";
const SHA256 = /^[0-9a-f]{64}$/;

// Logical identities must not depend on JSON object key insertion order.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
  );
  return value;
}
export function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function nextMonth(month) {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number, 1)).toISOString().slice(0, 7);
}
export function monthEnd(month) {
  return new Date(Date.parse(`${nextMonth(month)}-01T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}
export function monthSpine(first, last) {
  const valid = (month) => /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
  if (!valid(first) || !valid(last) || first > last) throw new Error("Invalid BC/UV month spine");
  const months = [];
  for (let month = first; month <= last; month = nextMonth(month)) months.push(month);
  return months;
}
export function stationIdentity(station) {
  return {
    station_id: station.station_id, station_ref: station.station_ref, name: station.name,
    latitude: station.latitude, longitude: station.longitude,
    timeseries_ids: { bc: station.timeseries_ids.bc, uv370: station.timeseries_ids.uv370 },
  };
}
export function derivationIdentity({ connectorId, stations, prefix, implementationHash }) {
  return { algorithm: ALGORITHM, from_day: FROM_DAY, observations_prefix: prefix,
    connector_id: connectorId, implementation_sha256: implementationHash,
    stations: stations.map(stationIdentity) };
}

export function dependencyDays(month) {
  const days = [];
  const last = `${nextMonth(month)}-01`;
  for (let day = `${month}-01`; day <= last;) {
    days.push(day);
    day = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  }
  return days;
}
export function monthDependencies(month, daysByDate) {
  // A null hash is authenticated absence in the selected root hierarchy. The
  // next month's day 01 is included even if that month is not yet represented.
  return dependencyDays(month).map((day) => ({ day_utc: day, manifest_hash: daysByDate.get(day)?.manifest_hash ?? null }));
}

function normalizeProfile(profile, expectedDays) {
  return { ...profile, expected_source_days: expectedDays,
    complete: profile.observed_source_days === expectedDays &&
      profile.points.every((point) => point.observation_count === expectedDays) };
}
export function emptyMonth(stations, month, generatedAt) {
  return createAccumulator(stations, month, month).finish(generatedAt, monthEnd(month));
}
export function profilesForMonth(product, stations, month) {
  const index = product.months.findIndex((entry) => entry.month === month);
  const source = index < 0 ? emptyMonth(stations, month, product.generated_at) : product;
  const selectedIndex = index < 0 ? 0 : index;
  const expected = Number(monthEnd(month).slice(8));
  return source.sensors.map((sensor) => ({ station_id: sensor.station_id,
    profiles: Object.fromEntries(PROPERTIES.map((property) =>
      [property, normalizeProfile(sensor.profiles[property][selectedIndex], expected)])) }));
}
export function monthRecord(month, dependencies, sourceThroughDay, profiles) {
  return { month, dependencies, dependency_sha256: fingerprint(dependencies),
    source_through_day: sourceThroughDay, profiles_sha256: fingerprint(profiles) };
}

// Validate provenance against the complete public body before considering *any*
// reuse, including on a forced rebuild. Malformed prior state is never a cache miss.
export function validatePrevious(product) {
  validateProduct(product);
  const months = monthSpine(FROM_DAY.slice(0, 7), product.source_through_day.slice(0, 7));
  if (fingerprint(months) !== fingerprint(product.months.map((entry) => entry.month))) {
    throw new Error("Prior BC/UV product does not contain the complete historical spine");
  }
  if (!Object.hasOwn(product, "incremental_provenance")) return null;
  const provenance = product.incremental_provenance;
  const identity = provenance?.derivation;
  if (provenance?.schema_version !== 1 || identity?.algorithm !== ALGORITHM || identity.from_day !== FROM_DAY ||
      identity.observations_prefix !== "history/v3/observations" || !SHA256.test(identity.implementation_sha256) ||
      !Number.isSafeInteger(identity.connector_id) || identity.connector_id <= 0 ||
      !Array.isArray(identity.stations) ||
      fingerprint(identity.stations) !== fingerprint(product.sensors.map(stationIdentity)) ||
      provenance.derivation_sha256 !== fingerprint(identity) || !Array.isArray(provenance.months) ||
      !provenance.months.length) throw new Error("Invalid BC/UV incremental derivation identity");
  const records = provenance.months;
  const recordMonths = monthSpine(FROM_DAY.slice(0, 7), records.at(-1)?.month);
  if (fingerprint(recordMonths) !== fingerprint(records.map((record) => record.month)) ||
      records.at(-1).month < months.at(-1)) throw new Error("Invalid BC/UV provenance month spine");
  let through = null;
  const dependencyHashes = new Map();
  for (const record of records) {
    if (!Array.isArray(record.dependencies) ||
        fingerprint(record.dependencies.map((entry) => entry.day_utc)) !== fingerprint(dependencyDays(record.month)) ||
        record.dependencies.some((entry) => entry.manifest_hash !== null && !SHA256.test(entry.manifest_hash)) ||
        record.dependency_sha256 !== fingerprint(record.dependencies)) throw new Error("Invalid BC/UV monthly dependencies");
    for (const entry of record.dependencies) {
      if (dependencyHashes.has(entry.day_utc) && dependencyHashes.get(entry.day_utc) !== entry.manifest_hash) {
        throw new Error("Contradictory BC/UV boundary dependencies");
      }
      dependencyHashes.set(entry.day_utc, entry.manifest_hash);
    }
    const profiles = profilesForMonth(product, identity.stations, record.month);
    if (record.profiles_sha256 !== fingerprint(profiles)) throw new Error("BC/UV monthly profile provenance mismatch");
    const count = profiles.reduce((total, sensor) => total + PROPERTIES.reduce((n, property) =>
      n + sensor.profiles[property].points.reduce((sum, point) => sum + point.observation_count, 0), 0), 0);
    if (record.source_through_day === null ? count !== 0 :
        !/^\d{4}-\d{2}-\d{2}$/.test(record.source_through_day) ||
        record.source_through_day < `${record.month}-01` || record.source_through_day > monthEnd(record.month) || count === 0 ||
        profiles.some((sensor) => PROPERTIES.some((property) =>
          sensor.profiles[property].observed_source_days > Number(record.source_through_day.slice(8))))) {
      throw new Error("Invalid BC/UV monthly source coverage");
    }
    if (record.source_through_day && (!through || record.source_through_day > through)) through = record.source_through_day;
  }
  if (through !== product.source_through_day) throw new Error("Contradictory BC/UV source-through day");
  return provenance;
}

export function assembleProduct({ stations, records, profilesByMonth, derivation, generatedAt }) {
  const through = records.map((record) => record.source_through_day).filter(Boolean).sort().at(-1);
  if (!through) throw new Error("No eligible canonical BC/UV observations");
  const months = monthSpine(FROM_DAY.slice(0, 7), through.slice(0, 7)).map((month) => {
    const identity = emptyMonth(stations, month, generatedAt).months[0];
    const expected = month === through.slice(0, 7) ? Number(through.slice(8)) : identity.expected_source_days;
    return { ...identity, expected_source_days: expected,
      complete_calendar_month: expected === identity.expected_source_days };
  });
  const product = { contract_version: 1, generated_at: generatedAt, source_through_day: through,
    network_code: "black_carbon", properties: PROPERTIES, months,
    sensors: stations.map((station, sensorIndex) => ({ ...station, network_code: "black_carbon",
      profiles: Object.fromEntries(PROPERTIES.map((property) => [property, months.map((month) =>
        normalizeProfile(profilesByMonth.get(month.month)[sensorIndex].profiles[property], month.expected_source_days))])) })),
    incremental_provenance: { schema_version: 1, derivation, derivation_sha256: fingerprint(derivation), months: records } };
  validatePrevious(product);
  return product;
}

export async function deriveMonthlyProduct({ days, previous, derivation, stations, readDay, generatedAt, fullRebuild = false }) {
  const prior = previous ? validatePrevious(previous) : null;
  const sameIdentity = prior && prior.derivation_sha256 === fingerprint(derivation);
  const reuse = sameIdentity && !fullRebuild;
  const mode = fullRebuild ? "forced_full_rebuild" : reuse ? "incremental" : "full_bootstrap";
  const daysByDate = new Map(days.map((day) => [day.day_utc, day]));
  if (!days.length || daysByDate.size !== days.length) throw new Error("Missing or duplicate canonical days");
  const months = monthSpine(FROM_DAY.slice(0, 7), days.at(-1).day_utc.slice(0, 7));
  const priorByMonth = new Map((prior?.months || []).map((record) => [record.month, record]));
  const recordsByMonth = new Map();
  const profilesByMonth = new Map();
  const rebuild = new Map();
  const rebuiltMonths = [];
  let reusedMonths = 0;
  for (const month of months) {
    const dependencies = monthDependencies(month, daysByDate);
    const old = priorByMonth.get(month);
    if (reuse && old?.dependency_sha256 === fingerprint(dependencies)) {
      recordsByMonth.set(month, old);
      profilesByMonth.set(month, profilesForMonth(previous, stations, month));
      reusedMonths++;
    } else {
      rebuiltMonths.push(month);
      rebuild.set(month, { dependencies, accumulator: createAccumulator(stations, month, month) });
    }
  }
  let canonicalDays = 0;
  // Fetch a boundary day once even when both adjacent source months need it.
  const required = new Set([...rebuild.values()].flatMap(({ dependencies }) =>
    dependencies.filter((entry) => entry.manifest_hash !== null).map((entry) => entry.day_utc)));
  for (const day of days) {
    if (!required.has(day.day_utc)) continue;
    const { bcRows, uvRows } = await readDay(day);
    canonicalDays++;
    const month = day.day_utc.slice(0, 7);
    rebuild.get(month)?.accumulator.addCanonicalDay(bcRows, uvRows);
    if (day.day_utc.endsWith("-01")) {
      const previousMonth = new Date(Date.parse(`${day.day_utc}T00:00:00Z`) - 1).toISOString().slice(0, 7);
      rebuild.get(previousMonth)?.accumulator.addCanonicalDay(bcRows, uvRows);
    }
  }
  for (const [month, { dependencies, accumulator }] of rebuild) {
    const monthly = accumulator.finish(generatedAt, monthEnd(month));
    const profiles = profilesForMonth(monthly, stations, month);
    profilesByMonth.set(month, profiles);
    recordsByMonth.set(month, monthRecord(month, dependencies, accumulator.getSourceThroughDay(), profiles));
  }
  const records = months.map((month) => recordsByMonth.get(month));
  const unchanged = reuse && rebuiltMonths.length === 0 && records.length === prior.months.length;
  const product = unchanged ? previous : assembleProduct({ stations, records, profilesByMonth, derivation, generatedAt });
  return { product, mode: unchanged ? "no_op" : mode, unchanged,
    rebuild_reason: fullRebuild ? "manual" : !previous ? "missing_product" : !prior ? "legacy_product" :
      !sameIdentity ? "derivation_or_metadata_changed" : "canonical_dependencies",
    months_rebuilt: rebuiltMonths.length, months_reused: reusedMonths, rebuilt_months: rebuiltMonths,
    canonical_days: canonicalDays };
}
