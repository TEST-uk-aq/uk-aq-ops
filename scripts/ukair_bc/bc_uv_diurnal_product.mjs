export const CONTRACT_VERSION = 1;
export const PROPERTIES = Object.freeze(["bc", "uv370", "uvpm"]);

export function sourceSlot(observedAtUtc) {
  const time = Date.parse(observedAtUtc);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== observedAtUtc ||
      new Date(time).getUTCMinutes() !== 0 || new Date(time).getUTCSeconds() !== 0 || new Date(time).getUTCMilliseconds() !== 0) {
    throw new Error(`Invalid canonical hourly endpoint: ${observedAtUtc}`);
  }
  const ending = new Date(time);
  const sourceDay = new Date(time - 1).toISOString().slice(0, 10);
  return { source_day: sourceDay, month: sourceDay.slice(0, 7), hour_ending: ending.getUTCHours() || 24 };
}

function season(month) {
  const year = Number(month.slice(0, 4));
  const number = Number(month.slice(5, 7));
  return number >= 4 && number <= 9
    ? { season: "Summer", season_year: year }
    : { season: "Winter", season_year: number >= 10 ? year : year - 1 };
}

export function createAccumulator(stations, firstMonth, lastMonth = null) {
  const bySeries = new Map();
  for (const station of stations) {
    for (const property of ["bc", "uv370"]) {
      const id = station.timeseries_ids[property];
      if (id != null) {
        if (bySeries.has(id)) throw new Error(`Duplicate timeseries identity ${id}`);
        bySeries.set(id, { station_id: station.station_id, property });
      }
    }
  }
  const points = new Map();
  const sourceDays = new Map();
  let sourceThroughDay = null;
  let observationCount = 0;
  function add(property, stationId, row) {
    if (!Number.isFinite(row.value) || !["P", "R"].includes(row.verification_status)) {
      throw new Error("Canonical value or verification status is invalid");
    }
    const slot = sourceSlot(row.observed_at_utc);
    if (slot.month < firstMonth || (lastMonth && slot.month > lastMonth)) return;
    const key = `${stationId}:${property}:${slot.month}:${slot.hour_ending}`;
    const point = points.get(key) || { sum: 0, observation_count: 0, ratified_count: 0, provisional_count: 0 };
    point.sum += row.value;
    if (!Number.isFinite(point.sum)) throw new Error("Non-finite aggregate sum");
    point.observation_count++;
    point[row.verification_status === "R" ? "ratified_count" : "provisional_count"]++;
    points.set(key, point);
    sourceThroughDay = !sourceThroughDay || slot.source_day > sourceThroughDay ? slot.source_day : sourceThroughDay;
    observationCount++;
    const coverageKey = `${stationId}:${property}:${slot.month}`;
    if (!sourceDays.has(coverageKey)) sourceDays.set(coverageKey, new Set());
    sourceDays.get(coverageKey).add(slot.source_day);
  }
  function addCanonicalDay(bcRows, uvRows) {
    const seen = [new Map(), new Map()];
    for (const [index, [property, rows]] of [["bc", bcRows], ["uv370", uvRows]].entries()) {
      for (const row of rows) {
        const series = bySeries.get(row.timeseries_id);
        if (!series || series.property !== property || series.station_id !== row.station_id || row.pollutant_code !== property) {
          // Historical or non-public stations are valid canonical rows, but a selected
          // timeseries with a contradictory identity is not.
          if (series) throw new Error(`Contradictory canonical identity ${row.timeseries_id}`);
          continue;
        }
        const key = `${row.station_id}:${row.observed_at_utc}`;
        if (seen[index].has(key)) throw new Error(`Ambiguous exact observation pair ${key}`);
        seen[index].set(key, row);
        add(property, row.station_id, row);
      }
    }
    for (const [key, bc] of seen[0]) {
      const uv = seen[1].get(key);
      if (uv) add("uvpm", bc.station_id, {
        observed_at_utc: bc.observed_at_utc,
        value: uv.value - bc.value,
        verification_status: bc.verification_status === "R" && uv.verification_status === "R" ? "R" : "P",
      });
    }
  }
  function finish(generatedAt, throughDay = sourceThroughDay) {
    if (!throughDay || (!lastMonth && observationCount === 0)) throw new Error("No eligible canonical BC/UV observations");
    const months = [];
    for (let month = firstMonth; month <= throughDay.slice(0, 7);) {
      const [year, number] = month.split("-").map(Number);
      const firstDay = `${month}-01`;
      const lastDay = new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
      const selectedEnd = lastDay < throughDay ? lastDay : throughDay;
      const expectedDays = Math.floor((Date.parse(`${selectedEnd}T00:00:00Z`) - Date.parse(`${firstDay}T00:00:00Z`)) / 86_400_000) + 1;
      months.push({ month, ...season(month), expected_source_days: expectedDays, complete_calendar_month: selectedEnd === lastDay });
      month = new Date(Date.UTC(year, number, 1)).toISOString().slice(0, 7);
    }
    const sensors = stations.map((station) => ({
      ...station,
      network_code: "black_carbon",
      profiles: Object.fromEntries(PROPERTIES.map((property) => [property, months.map(({ month, expected_source_days: expectedDays }) => ({
        month,
        observed_source_days: sourceDays.get(`${station.station_id}:${property}:${month}`)?.size || 0,
        expected_source_days: expectedDays,
        complete: (sourceDays.get(`${station.station_id}:${property}:${month}`)?.size || 0) === expectedDays &&
          Array.from({ length: 24 }, (_, i) => points.get(`${station.station_id}:${property}:${month}:${i + 1}`)?.observation_count || 0)
            .every((count) => count === expectedDays),
        points: Array.from({ length: 24 }, (_, i) => {
          const hour_ending = i + 1;
          const point = points.get(`${station.station_id}:${property}:${month}:${hour_ending}`);
          return point ? {
            month,
            hour_ending,
            mean_ugm3: point.sum / point.observation_count,
            observation_count: point.observation_count,
            ratified_count: point.ratified_count,
            provisional_count: point.provisional_count,
            source_validation_status: point.provisional_count ? "P" : "R",
          } : { month, hour_ending, mean_ugm3: null, observation_count: 0, ratified_count: 0, provisional_count: 0, source_validation_status: null };
        }),
      }))])),
    }));
    const product = { contract_version: CONTRACT_VERSION, generated_at: generatedAt, source_through_day: throughDay,
      network_code: "black_carbon", properties: PROPERTIES, months, sensors };
    validateProduct(product);
    return product;
  }
  return { addCanonicalDay, finish, getSourceThroughDay: () => sourceThroughDay };
}

export function validateProduct(product) {
  if (product?.contract_version !== CONTRACT_VERSION || product.network_code !== "black_carbon" ||
      !Number.isFinite(Date.parse(product.generated_at)) || !/^\d{4}-\d{2}-\d{2}$/.test(product.source_through_day) ||
      !Array.isArray(product.months) || !product.months.length || !Array.isArray(product.sensors) || !product.sensors.length ||
      JSON.stringify(product.properties) !== JSON.stringify(PROPERTIES)) throw new Error("Invalid BC/UV product header");
  const through = new Date(`${product.source_through_day}T00:00:00Z`);
  if (!Number.isFinite(through.getTime()) || through.toISOString().slice(0, 10) !== product.source_through_day) {
    throw new Error("Invalid BC/UV source date");
  }
  for (const [index, entry] of product.months.entries()) {
    const month = entry.month;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Invalid BC/UV month identity");
    const [year, number] = month.split("-").map(Number);
    const lastDay = new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
    const end = lastDay < product.source_through_day ? lastDay : product.source_through_day;
    const expected = Number(end.slice(8));
    const seasonal = season(month);
    if (month > product.source_through_day.slice(0, 7) ||
        (index && month !== new Date(Date.UTC(Number(product.months[index - 1].month.slice(0, 4)),
          Number(product.months[index - 1].month.slice(5)), 1)).toISOString().slice(0, 7)) ||
        entry.season !== seasonal.season || entry.season_year !== seasonal.season_year ||
        entry.expected_source_days !== expected || entry.complete_calendar_month !== (end === lastDay)) {
      throw new Error("Invalid BC/UV month spine or completeness");
    }
  }
  if (product.months.at(-1).month !== product.source_through_day.slice(0, 7)) throw new Error("Incomplete BC/UV month spine");
  const stationIds = new Set();
  const stationRefs = new Set();
  const seriesIds = new Set();
  for (const station of product.sensors) {
    if (!Number.isSafeInteger(station.station_id) || !station.station_ref ||
        stationIds.has(station.station_id) || stationRefs.has(station.station_ref) || station.station_id <= 0 ||
        !/^[A-Z0-9]+$/.test(station.station_ref) || !station.name ||
        !Number.isFinite(station.latitude) || Math.abs(station.latitude) > 90 ||
        !Number.isFinite(station.longitude) || Math.abs(station.longitude) > 180 ||
        station.network_code !== "black_carbon" || !station.timeseries_ids || Object.hasOwn(station.timeseries_ids, "uvpm") ||
        !PROPERTIES.every((property) => Array.isArray(station.profiles?.[property]) && station.profiles[property].length === product.months.length)) {
      throw new Error("Invalid BC/UV station identity or profile");
    }
    stationIds.add(station.station_id);
    stationRefs.add(station.station_ref);
    if (!["bc", "uv370"].some((property) => station.timeseries_ids[property] !== null)) throw new Error("Missing BC/UV series");
    for (const property of ["bc", "uv370"]) {
      const id = station.timeseries_ids[property];
      if (id === null) continue;
      if (!Number.isSafeInteger(id) || id <= 0 || seriesIds.has(id)) throw new Error("Invalid BC/UV timeseries identity");
      seriesIds.add(id);
    }
    for (const property of PROPERTIES) for (const [monthIndex, profile] of station.profiles[property].entries()) {
      if (profile.month !== product.months[monthIndex].month || profile.points?.length !== 24) throw new Error("Invalid BC/UV month profile");
      const expected = product.months[monthIndex].expected_source_days;
      if (profile.expected_source_days !== expected || !Number.isSafeInteger(profile.observed_source_days) ||
          profile.observed_source_days < 0 || profile.observed_source_days > expected ||
          profile.complete !== (profile.observed_source_days === expected &&
            profile.points.every((point) => point.observation_count === expected)) ||
          profile.points.some((point) => point.observation_count > profile.observed_source_days) ||
          (profile.observed_source_days === 0) !== profile.points.every((point) => point.observation_count === 0)) {
        throw new Error("Invalid BC/UV profile completeness");
      }
      for (const [index, point] of profile.points.entries()) {
        if (point.month !== profile.month || point.hour_ending !== index + 1 || !Number.isSafeInteger(point.observation_count) ||
            !Number.isSafeInteger(point.ratified_count) || !Number.isSafeInteger(point.provisional_count) ||
            point.observation_count < 0 || point.ratified_count < 0 || point.provisional_count < 0 ||
            point.observation_count !== point.ratified_count + point.provisional_count ||
            (point.observation_count === 0 ? point.mean_ugm3 !== null || point.source_validation_status !== null :
              !Number.isFinite(point.mean_ugm3) || point.source_validation_status !== (point.provisional_count ? "P" : "R"))) {
          throw new Error("Invalid BC/UV aggregate point");
        }
      }
    }
  }
  const hasReporting = Object.hasOwn(product, "latest_bc_reporting");
  const hasLocations = Object.hasOwn(product, "monitoring_location_count");
  if (hasReporting !== hasLocations) throw new Error("Partial BC/UV network summary");
  if (hasReporting) {
    const locations = new Set(product.sensors.map((station) => JSON.stringify([station.latitude, station.longitude])));
    if (!Number.isSafeInteger(product.monitoring_location_count) ||
        product.monitoring_location_count !== locations.size) {
      throw new Error("Invalid BC/UV monitoring location count");
    }
    const reporting = product.latest_bc_reporting;
    if (!reporting || !Array.isArray(reporting.station_ids) ||
        !reporting.station_ids.every((id) => Number.isSafeInteger(id)) ||
        !reporting.station_ids.every((id, index) => !index || reporting.station_ids[index - 1] < id) ||
        reporting.station_ids.some((id) => !stationIds.has(id) ||
          product.sensors.find((station) => station.station_id === id)?.timeseries_ids.bc == null)) {
      throw new Error("Invalid BC/UV latest reporting station IDs");
    }
    if (reporting.source_day === null) {
      if (reporting.station_ids.length) throw new Error("Stations reported on an absent BC source day");
    } else {
      const day = reporting.source_day;
      if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
          !Number.isFinite(Date.parse(`${day}T00:00:00Z`)) ||
          new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day ||
          day > product.source_through_day || !reporting.station_ids.length) {
        throw new Error("Invalid latest BC source day");
      }
    }
  }
  if (JSON.stringify(product).length > 64_000_000) throw new Error("BC/UV product exceeds browser response budget");
  return product;
}
