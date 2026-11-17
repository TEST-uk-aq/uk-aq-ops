#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { getObservationHistoryGeneration } from "../../workers/shared/uk_aq_observation_history_generation.mjs";
import { resolveR2HistoryIndexConfig } from "../../workers/shared/uk_aq_r2_history_index.mjs";
import { r2GetObject, r2PutObject } from "../../workers/shared/r2_sigv4.mjs";
import {
  buildR2HistoryV2ObservationsRootManifestKey,
  validateR2HistoryV2ObservationsAggregateManifest,
} from "../../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs";
import { buildHistoryV2DayManifestKey, validateCanonicalHistoryV2Manifest } from "../../workers/shared/uk_aq_r2_history_canonical.mjs";
import { readCurrentPollutantState } from "./uk_aq_ukair_bc_observation_reconciler_locked.mjs";
import { FROM_DAY, derivationIdentity, fingerprint, validatePrevious, deriveMonthlyProduct } from "./bc_uv_diurnal_incremental.mjs";
import { sourceSlot, validateProduct as validateBcUvProduct } from "./bc_uv_diurnal_product.mjs";

export const LATEST_KEY = "derived/bc_uv_diurnal/v1/latest.json";

export function requireEnvironment(env, requested) {
  if (!["TEST", "LIVE"].includes(requested) || env.UK_AQ_ENV_NAME !== requested) {
    throw new Error("Requested environment must explicitly match UK_AQ_ENV_NAME");
  }
  if (String(env.UK_AQ_GITHUB_REPO || "").trim() === "" ||
      String(env.GITHUB_REPOSITORY || "").trim() !== String(env.UK_AQ_GITHUB_REPO).trim()) {
    throw new Error("Executing repository must match UK_AQ_GITHUB_REPO");
  }
  if (env.UK_AQ_R2_HISTORY_VERSION !== "v3") {
    throw new Error("BC/UV derivation requires canonical v3 history");
  }
  const account = String(env.CLOUDFLARE_ACCOUNT_ID || "").trim();
  const endpoint = String(env.CFLARE_R2_ENDPOINT || "").trim();
  const bucket = String(env.CFLARE_R2_BUCKET || "").trim();
  const accessKeyId = String(env.CFLARE_R2_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = String(env.CFLARE_R2_SECRET_ACCESS_KEY || "").trim();
  if (!/^[0-9a-f]{32}$/.test(account) || endpoint !== `https://${account}.r2.cloudflarestorage.com` ||
      !bucket.endsWith(`-${requested.toLowerCase()}`) || !accessKeyId || !secretAccessKey) {
    throw new Error("Complete environment-matched R2 configuration is required");
  }
  const supabase = new URL(String(env.SUPABASE_URL || ""));
  const database = new URL(String(env.SUPABASE_DB_URL || ""));
  const ref = /^([a-z0-9]+)\.supabase\.co$/.exec(supabase.hostname)?.[1];
  if (supabase.protocol !== "https:" || !ref || !["postgres:", "postgresql:"].includes(database.protocol) ||
      !(database.username === `postgres.${ref}` || database.hostname === `db.${ref}.supabase.co`)) {
    throw new Error("Metadata database does not match configured Supabase project");
  }
  const r2 = resolveR2HistoryIndexConfig(env).r2;
  if (r2.endpoint !== endpoint || r2.bucket !== bucket || r2.access_key_id !== accessKeyId ||
      r2.secret_access_key !== secretAccessKey ||
      (env.R2_ENDPOINT && String(env.R2_ENDPOINT).trim() !== endpoint) ||
      (env.R2_BUCKET && String(env.R2_BUCKET).trim() !== bucket) ||
      (env.R2_ACCESS_KEY_ID && String(env.R2_ACCESS_KEY_ID).trim() !== accessKeyId) ||
      (env.R2_SECRET_ACCESS_KEY && String(env.R2_SECRET_ACCESS_KEY).trim() !== secretAccessKey)) {
    throw new Error("R2 configuration contradicts selected environment");
  }
  return r2;
}

async function json(r2, key) {
  const object = await r2GetObject({ r2, key });
  const body = Buffer.from(object.body);
  return { payload: JSON.parse(body.toString("utf8")), body };
}

export function selectPublicStations(stationRows, seriesRows) {
  if (!stationRows.length) throw new Error("No current public Black Carbon stations");
  if (new Set(stationRows.map((row) => Number(row.station_id))).size !== stationRows.length) {
    throw new Error("Duplicate Black Carbon station metadata");
  }
  const byStation = new Map(stationRows.map((row) => [Number(row.station_id), {
    station_id: Number(row.station_id), station_ref: row.station_ref, name: row.name,
    latitude: row.latitude == null ? NaN : Number(row.latitude),
    longitude: row.longitude == null ? NaN : Number(row.longitude),
    timeseries_ids: { bc: null, uv370: null },
  }]));
  for (const row of seriesRows) {
    const station = byStation.get(Number(row.station_id));
    if (!station) continue;
    const timeseriesId = Number(row.timeseries_id);
    if (!Object.hasOwn(station.timeseries_ids, row.property) || station.timeseries_ids[row.property] !== null ||
        row.timeseries_ref !== `${station.station_ref}:${row.property}` || row.service_ref !== "ukair_bc" ||
        row.uom !== "ug/m3" || !Number.isSafeInteger(timeseriesId) || timeseriesId <= 0) {
      throw new Error("Contradictory Black Carbon timeseries identity");
    }
    station.timeseries_ids[row.property] = timeseriesId;
  }
  const stations = [...byStation.values()].filter((station) =>
    Object.values(station.timeseries_ids).some((id) => id !== null));
  if (!stations.length) throw new Error("No eligible public Black Carbon stations with BC/UV370 timeseries");
  for (const station of stations) {
    if (!Number.isSafeInteger(station.station_id) || station.station_id <= 0 ||
        !Number.isFinite(station.latitude) || !Number.isFinite(station.longitude) || !station.name ||
        !/^[A-Z0-9]+$/.test(station.station_ref)) {
      throw new Error(`Incomplete public station metadata: ${station.station_ref}`);
    }
  }
  // Validate unique canonical IDs even on runs that will reuse all profiles.
  const ids = new Set();
  const refs = new Set();
  const seriesIds = new Set();
  for (const station of stations) {
    if (ids.has(station.station_id) || refs.has(station.station_ref) ||
        Math.abs(station.latitude) > 90 || Math.abs(station.longitude) > 180) throw new Error("Duplicate or invalid Black Carbon station identity");
    ids.add(station.station_id);
    refs.add(station.station_ref);
    for (const id of Object.values(station.timeseries_ids)) if (id !== null) {
      if (seriesIds.has(id)) throw new Error("Duplicate Black Carbon timeseries identity");
      seriesIds.add(id);
    }
  }
  return stations;
}

async function metadata(databaseUrl) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const connector = await client.query("select id from uk_aq_core.connectors where connector_code = 'ukair_bc'");
    if (connector.rows.length !== 1) throw new Error("Canonical ukair_bc connector identity is unavailable");
    const connectorId = Number(connector.rows[0].id);
    if (!Number.isSafeInteger(connectorId) || connectorId <= 0) throw new Error("Invalid canonical connector identity");
    const stations = await client.query(`
      select s.id::bigint::text as station_id, upper(btrim(s.station_ref)) as station_ref,
        coalesce(nullif(btrim(s.station_name), ''), nullif(btrim(s.label), '')) as name,
        ST_Y(s.geometry::geometry) as latitude, ST_X(s.geometry::geometry) as longitude
      from uk_aq_core.stations s
      join uk_aq_core.networks n on n.id = s.network_id
      where s.connector_id = $1 and s.service_ref = 'ukair_bc'
        and s.removed_at is null and n.network_code = 'black_carbon'
      order by s.station_ref, s.id`, [connectorId]);
    const series = await client.query(`
      select t.id as timeseries_id, t.station_id::bigint::text as station_id,
        t.timeseries_ref, t.service_ref, t.uom, lower(btrim(op.code)) as property
      from uk_aq_core.timeseries t
      join uk_aq_core.phenomena p on p.id = t.phenomenon_id
      join uk_aq_core.observed_properties op on op.id = p.observed_property_id
      where t.connector_id = $1 and lower(btrim(op.code)) in ('bc', 'uv370')`, [connectorId]);
    return { connectorId, stations: selectPublicStations(stations.rows, series.rows) };
  } finally { await client.end(); }
}

async function selectedDays(r2, prefix, firstMonth) {
  const rootKey = buildR2HistoryV2ObservationsRootManifestKey(prefix);
  const root = await json(r2, rootKey);
  const rootManifest = validateR2HistoryV2ObservationsAggregateManifest(root.payload, { basePrefix: prefix });
  if (rootManifest.kind !== "uk_aq_observations_root_manifest") throw new Error("Invalid canonical root kind");
  const days = [];
  for (const year of rootManifest.children) {
    if (year.year < Number(firstMonth.slice(0, 4))) continue;
    const yearManifest = validateR2HistoryV2ObservationsAggregateManifest((await json(r2, year.manifest_key)).payload, { basePrefix: prefix });
    if (yearManifest.kind !== "uk_aq_observations_year_manifest" || yearManifest.content_hash !== year.content_hash || yearManifest.year !== year.year) throw new Error("Canonical year manifest changed");
    for (const month of yearManifest.children) {
      const identity = `${year.year}-${month.month}`;
      if (identity < firstMonth) continue;
      const monthManifest = validateR2HistoryV2ObservationsAggregateManifest((await json(r2, month.manifest_key)).payload, { basePrefix: prefix });
      if (monthManifest.kind !== "uk_aq_observations_month_manifest" || monthManifest.content_hash !== month.content_hash || monthManifest.year !== year.year || monthManifest.month !== month.month) {
        throw new Error("Canonical month manifest changed");
      }
      for (const day of monthManifest.children) days.push(day);
    }
  }
  if (!days.length) throw new Error("No canonical days in selected period");
  days.sort((a, b) => a.day_utc.localeCompare(b.day_utc));
  return { days, rootKey, rootHash: createHash("sha256").update(root.body).digest("hex") };
}

function sha256(body) { return createHash("sha256").update(body).digest("hex"); }
function generationKey(digest) { return `derived/bc_uv_diurnal/v1/generations/${digest}.json`; }

function validateChildAliases(manifest, alias, identity) {
  const children = manifest.child_manifests;
  const named = manifest[alias];
  if (!Array.isArray(children) || !Array.isArray(named) ||
      new Set(children.map((child) => child[identity])).size !== children.length ||
      new Set(named.map((child) => child[identity])).size !== named.length ||
      fingerprint([...children].sort((a, b) => String(a[identity]).localeCompare(String(b[identity])))) !==
        fingerprint([...named].sort((a, b) => String(a[identity]).localeCompare(String(b[identity]))))) {
    throw new Error(`Contradictory canonical child aliases: ${manifest.manifest_key}`);
  }
}

async function previousProduct(r2) {
  let latest;
  try { latest = await json(r2, LATEST_KEY); }
  catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
  const provenance = validatePrevious(latest.payload);
  if (provenance) {
    const immutable = await json(r2, generationKey(sha256(latest.body)));
    if (!immutable.body.equals(latest.body)) throw new Error("Prior derived generation verification failed");
  }
  return latest.payload;
}

// Read the most recent canonical days in reverse. The 00:00 UTC endpoint belongs
// to the preceding GMT source day, so include the UTC day matching the final BC
// source day before deciding which eligible stations reported on that day.
export async function latestBcReporting(days, stations, readDay, sourceThroughDay) {
  const eligibleSeries = new Map(stations.filter((station) => station.timeseries_ids.bc !== null)
    .map((station) => [station.station_id, station.timeseries_ids.bc]));
  let latestDay = null;
  const stationIds = new Set();
  if (!eligibleSeries.size) return { source_day: null, station_ids: [] };
  for (let index = days.length - 1; index >= 0; index--) {
    const day = days[index];
    const { bcRows } = await readDay(day);
    for (const row of bcRows) {
      const stationId = Number(row.station_id);
      if (!eligibleSeries.has(stationId) ||
          eligibleSeries.get(stationId) !== Number(row.timeseries_id) ||
          row.pollutant_code !== "bc" || !Number.isFinite(row.value) ||
          !["P", "R"].includes(row.verification_status)) continue;
      const sourceDay = sourceSlot(row.observed_at_utc).source_day;
      if (sourceDay > sourceThroughDay) throw new Error("BC reporting day exceeds published source coverage");
      if (latestDay === null || sourceDay > latestDay) {
        latestDay = sourceDay;
        stationIds.clear();
      }
      if (sourceDay === latestDay) stationIds.add(stationId);
    }
    if (latestDay !== null && day.day_utc <= latestDay) break;
  }
  return { source_day: latestDay, station_ids: [...stationIds].sort((a, b) => a - b) };
}

export async function buildBcUvDiurnal({ env = process.env, fromDay = FROM_DAY, publish = false,
  requestedEnvironment, now = new Date(), fullRebuild = false } = {}) {
  const started = performance.now();
  if (fromDay !== FROM_DAY) throw new Error(`--from must remain ${FROM_DAY} for complete historical publication`);
  const r2 = requireEnvironment(env, requestedEnvironment);
  const generation = getObservationHistoryGeneration("v3");
  const currentMetadata = await metadata(env.SUPABASE_DB_URL);
  const { connectorId, stations } = currentMetadata;
  // Bind reuse to the implementation as well as its explicit science version.
  // A code change conservatively bootstraps again; timestamps and Git SHAs do not.
  const implementationHash = fingerprint([
    "./build_bc_uv_diurnal.mjs", "./bc_uv_diurnal_product.mjs", "./bc_uv_diurnal_incremental.mjs",
    "./uk_aq_ukair_bc_observation_reconciler_locked.mjs", "./uk_air_black_carbon_source.mjs",
    "../../workers/shared/uk_aq_observation_content_hash.mjs",
    "../../workers/shared/uk_aq_r2_history_manifest_validation.mjs",
    "../../workers/shared/uk_aq_observation_history_schema.mjs", "../../package-lock.json",
  ].map((path) => sha256(readFileSync(new URL(path, import.meta.url)))));
  const derivation = derivationIdentity({ connectorId, stations,
    prefix: generation.observations_prefix, implementationHash });
  const previous = await previousProduct(r2);
  const selected = await selectedDays(r2, generation.observations_prefix, fromDay.slice(0, 7));
  const readDay = async (day) => {
    const expectedKey = buildHistoryV2DayManifestKey(generation.observations_prefix, day.day_utc);
    if (day.manifest_key !== expectedKey) throw new Error("Canonical day key mismatch");
    const selectedDay = await json(r2, expectedKey);
    validateCanonicalHistoryV2Manifest(selectedDay.payload, {
      history_version: "v2", domain: "observations", manifest_key: expectedKey,
      manifest_kind: "day", day_utc: day.day_utc,
    });
    if (selectedDay.payload.manifest_hash !== day.manifest_hash) throw new Error(`Canonical day manifest changed: ${day.day_utc}`);
    validateChildAliases(selectedDay.payload, "connector_manifests", "connector_id");
    const dayCache = new Map([[day.day_utc, selectedDay.payload]]);
    const connectorCache = new Map();
    const bc = await readCurrentPollutantState({ r2, generation, scope: { day_utc: day.day_utc, connector_id: connectorId, pollutant_code: "bc" }, dayCache, connectorCache });
    const uv = await readCurrentPollutantState({ r2, generation, scope: { day_utc: day.day_utc, connector_id: connectorId, pollutant_code: "uv370" }, dayCache, connectorCache });
    if (bc.connector) validateChildAliases(bc.connector, "pollutant_manifests", "pollutant_code");
    return { bcRows: bc.rows, uvRows: uv.rows };
  };
  const result = await deriveMonthlyProduct({ days: selected.days, previous, derivation, stations, readDay,
    generatedAt: now.toISOString(), fullRebuild });
  const latestReporting = await latestBcReporting(selected.days, stations, readDay, result.product.source_through_day);
  const locationCount = new Set(stations.map((station) => JSON.stringify([station.latitude, station.longitude]))).size;
  if (result.unchanged) {
    if (fingerprint(result.product.latest_bc_reporting) !== fingerprint(latestReporting) ||
        result.product.monitoring_location_count !== locationCount) {
      throw new Error("Unchanged canonical inputs contradict previously published BC/UV summary");
    }
  } else {
    result.product.latest_bc_reporting = latestReporting;
    result.product.monitoring_location_count = locationCount;
  }
  validateBcUvProduct(result.product);
  const body = Buffer.from(JSON.stringify(result.product));
  const verifySource = async () => {
    // Re-walk aggregates as well as rechecking the root: an in-progress writer
    // may have advanced a child while its root is still unchanged.
    const again = await selectedDays(r2, generation.observations_prefix, fromDay.slice(0, 7));
    if (again.rootHash !== selected.rootHash || fingerprint(again.days) !== fingerprint(selected.days)) {
      throw new Error("Canonical history changed during derivation");
    }
    if (fingerprint(await metadata(env.SUPABASE_DB_URL)) !== fingerprint(currentMetadata)) {
      throw new Error("Eligible Black Carbon metadata changed during derivation");
    }
    if (sha256((await json(r2, selected.rootKey)).body) !== selected.rootHash) {
      throw new Error("Canonical history changed during source revalidation");
    }
  };
  await verifySource();
  const summary = { ...result, published: false, result: result.unchanged ? "unchanged" : "validated",
    bytes: body.length, source_through_day: result.product.source_through_day, sensor_count: stations.length };
  if (publish && !result.unchanged) {
    const digest = sha256(body);
    const key = generationKey(digest);
    await r2PutObject({ r2, key, body, content_type: "application/json", sha256: digest });
    const confirmed = await json(r2, key);
    if (!confirmed.body.equals(body)) throw new Error("Derived generation verification failed");
    await verifySource();
    // A single-object PUT makes the validated body and provenance visible
    // atomically. Earlier failures leave the prior latest body untouched.
    await r2PutObject({ r2, key: LATEST_KEY, body, content_type: "application/json", sha256: digest });
    Object.assign(summary, { published: true, result: "published", generation_key: key });
  }
  summary.elapsed_ms = Math.round(performance.now() - started);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = (flag) => { const index = args.indexOf(flag); return index < 0 ? null : args[index + 1]; };
  const known = new Set(["--environment", "--from", "--publish", "--full-rebuild"]);
  if (args.some((arg, i) => arg.startsWith("--") && !known.has(arg)) ||
      !value("--environment") || (args.includes("--from") && !value("--from"))) {
    process.stderr.write("Usage: node scripts/ukair_bc/build_bc_uv_diurnal.mjs --environment TEST|LIVE [--from YYYY-MM-01] [--publish] [--full-rebuild]\n");
    process.exitCode = 2;
  } else {
    buildBcUvDiurnal({ requestedEnvironment: value("--environment"), fromDay: value("--from") || "2024-01-01", publish: args.includes("--publish"), fullRebuild: args.includes("--full-rebuild") })
      .then(({ product, ...result }) => process.stdout.write(`${JSON.stringify({ ...result, source_through_day: product.source_through_day, sensor_count: product.sensors.length })}\n`))
      .catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
  }
}
