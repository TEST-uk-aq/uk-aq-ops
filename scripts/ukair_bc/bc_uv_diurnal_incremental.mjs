import { createHash } from "node:crypto";
import { createAccumulator, PROPERTIES, sourceSlot, validateProduct } from "./bc_uv_diurnal_product.mjs";

export const FROM_DAY = "2024-01-01";
export const ALGORITHM = "bc-uv-monthly-v1";
const SHA256 = /^[0-9a-f]{64}$/;
const STORED_PROPERTIES = ["bc", "uv370"];
const validHash = (value) => typeof value === "string" && SHA256.test(value);

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

function stationKey(station) {
  return JSON.stringify([station.station_id, station.station_ref]);
}

function sharedDerivation({ stations, ...identity }) {
  return fingerprint(identity);
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
function latestDay(records) {
  return records.map((record) => record.source_through_day).filter(Boolean).sort().at(-1) ?? null;
}

function observationDigest(dependencies, bc = [], uv370 = []) {
  // UTC day presence is explicit even when the selected series has no rows.
  return fingerprint([dependencies.map((entry) => entry.manifest_hash !== null), bc, uv370]);
}

function validateSourceCoverage(month, through, profiles) {
  const properties = profiles.flatMap((station) => PROPERTIES.map((property) => station.profiles[property]));
  const hasObservations = properties.some((profile) => profile.observed_source_days > 0);
  if (through === null ? hasObservations :
      typeof through !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(through) ||
      through < `${month}-01` || through > monthEnd(month) || !hasObservations ||
      properties.some((profile) => profile.observed_source_days > Number(through.slice(8)))) {
    throw new Error("Invalid BC/UV monthly source coverage");
  }
}

function validateStationMonth(record, profiles, stations) {
  const { observed_timeseries_ids: ids, stations: proofs } = record;
  if (!Array.isArray(ids) || ids.some((id, index) =>
    !Number.isSafeInteger(id) || id <= 0 || (index > 0 && ids[index - 1] >= id)) ||
    !Array.isArray(proofs) || proofs.length !== stations.length) {
    throw new Error("Invalid BC/UV station-month evidence");
  }
  const observed = new Set(ids);
  const emptyDigest = observationDigest(record.dependencies);
  for (const [index, station] of stations.entries()) {
    const proof = proofs[index];
    const profile = profiles[index];
    if (proof?.station_id !== station.station_id || !validHash(proof.observations_sha256) ||
        proof.profiles_sha256 !== fingerprint(profile)) {
      throw new Error("BC/UV station-month profile provenance mismatch");
    }
    validateSourceCoverage(record.month, proof.source_through_day, [profile]);
    const lastSourceDay = Number(proof.source_through_day?.slice(8));
    if ((proof.source_through_day === null) !== (proof.observations_sha256 === emptyDigest) ||
        (lastSourceDay && record.dependencies[lastSourceDay - 1].manifest_hash === null &&
          record.dependencies[lastSourceDay].manifest_hash === null) ||
        STORED_PROPERTIES.some((property) => observed.has(station.timeseries_ids[property]) !==
          (profile.profiles[property].observed_source_days > 0))) {
      throw new Error("Contradictory BC/UV station-month observation evidence");
    }
  }
  if (record.source_through_day !== latestDay(proofs) ||
      (observed.size > 0 && record.dependencies.every((entry) => entry.manifest_hash === null))) {
    throw new Error("Contradictory BC/UV station-month coverage");
  }
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
  if (![1, 2].includes(provenance?.schema_version) || identity?.algorithm !== ALGORITHM || identity.from_day !== FROM_DAY ||
      identity.observations_prefix !== "history/v3/observations" || !validHash(identity.implementation_sha256) ||
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
        record.dependencies.some((entry) => entry.manifest_hash !== null && !validHash(entry.manifest_hash)) ||
        record.dependency_sha256 !== fingerprint(record.dependencies)) throw new Error("Invalid BC/UV monthly dependencies");
    for (const entry of record.dependencies) {
      if (dependencyHashes.has(entry.day_utc) && dependencyHashes.get(entry.day_utc) !== entry.manifest_hash) {
        throw new Error("Contradictory BC/UV boundary dependencies");
      }
      dependencyHashes.set(entry.day_utc, entry.manifest_hash);
    }
    const profiles = profilesForMonth(product, identity.stations, record.month);
    if (provenance.schema_version === 2) {
      validateStationMonth(record, profiles, identity.stations);
    } else {
      if (record.profiles_sha256 !== fingerprint(profiles)) throw new Error("BC/UV monthly profile provenance mismatch");
      validateSourceCoverage(record.month, record.source_through_day, profiles);
    }
    if (record.source_through_day && (!through || record.source_through_day > through)) through = record.source_through_day;
  }
  if (through !== product.source_through_day) throw new Error("Contradictory BC/UV source-through day");
  return provenance;
}

export function assembleProduct({ stations, records, profilesByMonth, derivation, generatedAt }) {
  const through = latestDay(records);
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
    incremental_provenance: { schema_version: 2, derivation, derivation_sha256: fingerprint(derivation), months: records } };
  validatePrevious(product);
  return product;
}

async function readMonth(month, dependencies, stations, readDay) {
  const firstEndpoint = `${month}-01T00:00:00.000Z`;
  const lastEndpoint = `${nextMonth(month)}-01T00:00:00.000Z`;
  const selected = new Map();
  const observed = new Set();
  const throughByStation = new Map();
  const rowsByDay = [];
  for (const station of stations) for (const property of STORED_PROPERTIES) {
    const seriesId = station.timeseries_ids[property];
    if (seriesId !== null) selected.set(seriesId, { stationId: station.station_id, property, observations: [] });
  }

  for (const dependency of dependencies) {
    if (dependency.manifest_hash === null) continue;
    const { bcRows, uvRows } = await readDay(dependency.day_utc);
    rowsByDay.push([bcRows, uvRows]);
    for (const [index, rows] of [bcRows, uvRows].entries()) {
      const property = STORED_PROPERTIES[index];
      for (const row of rows) {
        const id = row.timeseries_id;
        const series = selected.get(id);
        if (series && (series.property !== property || row.pollutant_code !== property || series.stationId !== row.station_id)) {
          throw new Error(`Contradictory canonical identity ${id}`);
        }
        const timestamp = row.observed_at_utc;
        if (timestamp <= firstEndpoint || timestamp > lastEndpoint) continue;
        observed.add(id); // Also record series that are currently ineligible.
        if (!series) continue;
        if (!Number.isFinite(row.value) || !["P", "R"].includes(row.verification_status)) {
          throw new Error("Canonical value or verification status is invalid");
        }
        // The verified canonical reader sorts by endpoint then timeseries ID,
        // so the per-series sequence is independent of Parquet layout.
        if (series.observations.at(-1)?.[1] >= timestamp) {
          throw new Error(`Ambiguous or unordered canonical endpoints for timeseries ${id}`);
        }
        const { source_day: sourceDay } = sourceSlot(timestamp);
        if (sourceDay > (throughByStation.get(series.stationId) ?? "")) throughByStation.set(series.stationId, sourceDay);
        series.observations.push([id, timestamp, row.value, row.verification_status]);
      }
    }
  }
  return {
    rowsByDay,
    observedIds: [...observed].sort((a, b) => a - b),
    evidence: stations.map(({ station_id, timeseries_ids }) => ({
      station_id,
      observations_sha256: observationDigest(dependencies, selected.get(timeseries_ids.bc)?.observations,
        selected.get(timeseries_ids.uv370)?.observations),
      source_through_day: throughByStation.get(station_id) ?? null,
    })),
  };
}

export async function deriveMonthlyProduct({ days, previous, derivation, stations, readDay, generatedAt, fullRebuild = false }) {
  const prior = previous ? validatePrevious(previous) : null;
  if (fingerprint(derivation.stations) !== fingerprint(stations.map(stationIdentity))) {
    throw new Error("Current BC/UV stations contradict derivation identity");
  }
  const sameIdentity = prior?.derivation_sha256 === fingerprint(derivation);
  const compatible = prior?.schema_version === 2 && sharedDerivation(prior.derivation) === sharedDerivation(derivation);
  const reuse = compatible && !fullRebuild;
  const mode = fullRebuild ? "forced_full_rebuild" : reuse ? "incremental" : "full_bootstrap";
  const daysByDate = new Map(days.map((day) => [day.day_utc, day]));
  if (!days.length || days.some((day, index) =>
    !validHash(day.manifest_hash) || (index > 0 && days[index - 1].day_utc >= day.day_utc))) {
    throw new Error("Invalid, missing or unordered canonical days");
  }
  const months = monthSpine(FROM_DAY.slice(0, 7), days.at(-1).day_utc.slice(0, 7));
  const priorByMonth = new Map(reuse ? prior.months.map((record) => [record.month, record]) : []);
  const priorStations = previous?.sensors ?? [];
  const priorIndex = new Map(priorStations.map((station, index) => [stationKey(station), index]));
  const currentKeys = new Set(stations.map(stationKey));
  const matchingIndices = stations.map((station) => {
    const index = priorIndex.get(stationKey(station));
    return index !== undefined && STORED_PROPERTIES.every((property) =>
      station.timeseries_ids[property] === priorStations[index].timeseries_ids[property]) ? index : -1;
  });
  const hasNewMappings = matchingIndices.includes(-1);

  const records = [];
  const profilesByMonth = new Map();
  const rebuiltMonths = [];
  const fallbackReasons = new Set();
  const rebuildReason = fullRebuild ? "manual" : !previous ? "missing_product" :
    !prior || prior.schema_version === 1 ? "legacy_product" :
    !sameIdentity ? "derivation_or_metadata_changed" : "canonical_dependencies";
  if (!reuse) fallbackReasons.add(!prior || fullRebuild ? rebuildReason :
    prior.schema_version === 1 ? "monthly_provenance_only" : "shared_derivation_changed");
  let stationMonthsRebuilt = 0;
  let stationMonthsReused = 0;
  let stationMonthsBuiltFromAbsence = 0;
  let canonicalDays = 0;
  let lastRead;
  let dependenciesUnchanged = true;
  const read = async (day) => {
    // Adjacent source months share day 01. Only keep the last read across
    // months; rows held for digest comparison are otherwise month-local.
    if (lastRead?.day !== day) {
      lastRead = { day, rows: await readDay(daysByDate.get(day)) };
      canonicalDays++;
    }
    return lastRead.rows;
  };

  for (const month of months) {
    const dependencies = monthDependencies(month, daysByDate);
    const dependencyHash = fingerprint(dependencies);
    const old = priorByMonth.get(month);
    const sameDependencies = old?.dependency_sha256 === dependencyHash;
    dependenciesUnchanged &&= sameDependencies;
    if (sameDependencies && sameIdentity) {
      records.push(old);
      profilesByMonth.set(month, profilesForMonth(previous, stations, month));
      stationMonthsReused += stations.length;
      continue;
    }
    const observed = new Set(old?.observed_timeseries_ids);
    // The prior verified inventory covers every series in the interval,
    // including ineligible series. An identical dependency window can
    // therefore prove a newly selected series has no data in this month.
    const unbaselinedPresent = sameDependencies && stations.some((station, index) =>
      matchingIndices[index] < 0 && STORED_PROPERTIES.some((property) => observed.has(station.timeseries_ids[property])));
    const needsRead = !sameDependencies || unbaselinedPresent;
    if (reuse && !old) fallbackReasons.add("no_station_month_baseline");
    if (old && !sameDependencies) fallbackReasons.add("canonical_dependencies_changed");
    if (unbaselinedPresent) fallbackReasons.add("unbaselined_series_present");
    const scanned = needsRead ? await readMonth(month, dependencies, stations, read) : null;
    const evidence = scanned?.evidence ?? stations.map((station, index) =>
      old.stations[matchingIndices[index]] ?? { station_id: station.station_id, source_through_day: null,
        observations_sha256: observationDigest(dependencies) });

    const reusable = evidence.map((proof, index) => {
      const priorProof = old?.stations[matchingIndices[index]];
      if (priorProof?.observations_sha256 !== proof.observations_sha256) return false;
      if (priorProof.source_through_day !== proof.source_through_day) {
        throw new Error("Equal BC/UV observation evidence has contradictory source coverage");
      }
      return true;
    });
    const rebuild = stations.filter((_, index) => !reusable[index]);
    stationMonthsReused += stations.length - rebuild.length;
    stationMonthsRebuilt += rebuild.length;
    if (!scanned) stationMonthsBuiltFromAbsence += rebuild.length;
    if (rebuild.length) rebuiltMonths.push(month);
    if (old && reusable.some((retained, index) => !retained && matchingIndices[index] >= 0)) {
      fallbackReasons.add("station_month_inputs_changed");
    }
    if (old && hasNewMappings) fallbackReasons.add("new_or_remapped_station");

    let rebuiltProfiles = [];
    if (rebuild.length) {
      const accumulator = createAccumulator(rebuild, month, month);
      for (const [bcRows, uvRows] of scanned?.rowsByDay ?? []) accumulator.addCanonicalDay(bcRows, uvRows);
      if (accumulator.getSourceThroughDay() !== latestDay(evidence.filter((_, index) => !reusable[index]))) {
        throw new Error("BC/UV accumulation contradicts canonical station-month coverage");
      }
      rebuiltProfiles = profilesForMonth(accumulator.finish(generatedAt, monthEnd(month)), rebuild, month);
    }
    const retained = reusable.some(Boolean) ? profilesForMonth(previous, prior.derivation.stations, month) : [];
    let rebuiltIndex = 0;
    const profiles = stations.map((_, index) =>
      reusable[index] ? retained[matchingIndices[index]] : rebuiltProfiles[rebuiltIndex++]);
    profilesByMonth.set(month, profiles);
    records.push({
      month, dependencies, dependency_sha256: dependencyHash, source_through_day: latestDay(evidence),
      observed_timeseries_ids: scanned?.observedIds ?? old.observed_timeseries_ids,
      stations: evidence.map(({ station_id, observations_sha256, source_through_day }, index) => ({
        station_id, observations_sha256, source_through_day,
        profiles_sha256: reusable[index] ? old.stations[matchingIndices[index]].profiles_sha256 : fingerprint(profiles[index]),
      })),
    });
  }
  const unchanged = reuse && sameIdentity && dependenciesUnchanged && rebuiltMonths.length === 0 &&
    records.length === prior.months.length;
  const product = unchanged ? previous : assembleProduct({ stations, records, profilesByMonth, derivation, generatedAt });
  return { product, mode: unchanged ? "no_op" : mode, unchanged, rebuild_reason: rebuildReason,
    months_rebuilt: rebuiltMonths.length, months_reused: months.length - rebuiltMonths.length, rebuilt_months: rebuiltMonths,
    canonical_days: canonicalDays, station_months_rebuilt: stationMonthsRebuilt, station_months_reused: stationMonthsReused,
    station_months_built_from_absence: stationMonthsBuiltFromAbsence,
    newly_eligible_stations: stations.filter((station) => !priorIndex.has(stationKey(station))).length,
    retired_stations: priorStations.filter((station) => !currentKeys.has(stationKey(station))).length,
    fallback_reasons: [...fallbackReasons] };
}
