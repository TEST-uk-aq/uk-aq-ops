#!/usr/bin/env node

import { createHash } from "node:crypto";
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
import { createAccumulator, validateProduct } from "./bc_uv_diurnal_product.mjs";

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
  return stations;
}

async function metadata(databaseUrl) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const connector = await client.query("select id from uk_aq_core.connectors where connector_code = 'ukair_bc'");
    if (connector.rows.length !== 1) throw new Error("Canonical ukair_bc connector identity is unavailable");
    const connectorId = Number(connector.rows[0].id);
    const stations = await client.query(`
      select s.id::bigint::text as station_id, upper(btrim(s.station_ref)) as station_ref,
        coalesce(nullif(btrim(s.station_name), ''), nullif(btrim(s.label), '')) as name,
        ST_Y(s.geometry::geometry) as latitude, ST_X(s.geometry::geometry) as longitude
      from uk_aq_core.stations s
      join uk_aq_core.networks n on n.id = s.network_id
      where s.connector_id = $1 and s.service_ref = 'ukair_bc'
        and s.removed_at is null and n.network_code = 'black_carbon' and n.public_display_enabled is true
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
  const days = [];
  for (const year of rootManifest.children) {
    if (year.year < Number(firstMonth.slice(0, 4))) continue;
    const yearManifest = validateR2HistoryV2ObservationsAggregateManifest((await json(r2, year.manifest_key)).payload, { basePrefix: prefix });
    if (yearManifest.content_hash !== year.content_hash || yearManifest.year !== year.year) throw new Error("Canonical year manifest changed");
    for (const month of yearManifest.children) {
      const identity = `${year.year}-${month.month}`;
      if (identity < firstMonth) continue;
      const monthManifest = validateR2HistoryV2ObservationsAggregateManifest((await json(r2, month.manifest_key)).payload, { basePrefix: prefix });
      if (monthManifest.content_hash !== month.content_hash || monthManifest.year !== year.year || monthManifest.month !== month.month) {
        throw new Error("Canonical month manifest changed");
      }
      for (const day of monthManifest.children) days.push(day);
    }
  }
  if (!days.length) throw new Error("No canonical days in selected period");
  return { days, rootKey, rootHash: createHash("sha256").update(root.body).digest("hex") };
}

export async function buildBcUvDiurnal({ env = process.env, fromDay = "2024-01-01", publish = false,
  requestedEnvironment, now = new Date() } = {}) {
  if (!/^\d{4}-\d{2}-01$/.test(fromDay) || !Number.isFinite(Date.parse(`${fromDay}T00:00:00Z`)) ||
      new Date(`${fromDay}T00:00:00Z`).toISOString().slice(0, 10) !== fromDay) {
    throw new Error("--from must be the first day of a valid UTC month");
  }
  const r2 = requireEnvironment(env, requestedEnvironment);
  const generation = getObservationHistoryGeneration("v3");
  const { connectorId, stations } = await metadata(env.SUPABASE_DB_URL);
  const { days, rootKey, rootHash } = await selectedDays(r2, generation.observations_prefix, fromDay.slice(0, 7));
  const accumulator = createAccumulator(stations, fromDay.slice(0, 7));
  let canonicalDays = 0;
  for (const day of days) {
    const expectedKey = buildHistoryV2DayManifestKey(generation.observations_prefix, day.day_utc);
    if (day.manifest_key !== expectedKey) throw new Error("Canonical day key mismatch");
    const selected = await json(r2, expectedKey);
    validateCanonicalHistoryV2Manifest(selected.payload, {
      history_version: "v2", domain: "observations", manifest_key: expectedKey,
      manifest_kind: "day", day_utc: day.day_utc,
    });
    if (selected.payload.manifest_hash !== day.manifest_hash) throw new Error(`Canonical day manifest changed: ${day.day_utc}`);
    const dayCache = new Map([[day.day_utc, selected.payload]]);
    const connectorCache = new Map();
    const bc = await readCurrentPollutantState({ r2, generation, scope: { day_utc: day.day_utc, connector_id: connectorId, pollutant_code: "bc" }, dayCache, connectorCache });
    const uv = await readCurrentPollutantState({ r2, generation, scope: { day_utc: day.day_utc, connector_id: connectorId, pollutant_code: "uv370" }, dayCache, connectorCache });
    if (!bc.connector && !uv.connector) continue;
    canonicalDays++;
    accumulator.addCanonicalDay(bc.rows, uv.rows);
  }
  if (!canonicalDays) throw new Error("No canonical Black Carbon day coverage");
  const product = accumulator.finish(now.toISOString());
  validateProduct(product);
  const body = Buffer.from(JSON.stringify(product));
  const rootAgain = await json(r2, rootKey);
  if (createHash("sha256").update(rootAgain.body).digest("hex") !== rootHash) {
    throw new Error("Canonical history changed during derivation");
  }
  if (!publish) return { product, published: false, bytes: body.length, canonical_days: canonicalDays };
  const digest = createHash("sha256").update(body).digest("hex");
  const generationKey = `derived/bc_uv_diurnal/v1/generations/${digest}.json`;
  await r2PutObject({ r2, key: generationKey, body, content_type: "application/json", sha256: digest });
  const confirmed = await json(r2, generationKey);
  if (createHash("sha256").update(confirmed.body).digest("hex") !== digest) throw new Error("Derived generation verification failed");
  // A single-object PUT makes the validated body visible atomically. A failure before
  // this point leaves the prior latest body untouched.
  await r2PutObject({ r2, key: LATEST_KEY, body, content_type: "application/json", sha256: digest });
  return { product, published: true, bytes: body.length, canonical_days: canonicalDays, generation_key: generationKey };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = (flag) => { const index = args.indexOf(flag); return index < 0 ? null : args[index + 1]; };
  const known = new Set(["--environment", "--from", "--publish"]);
  if (args.some((arg, i) => arg.startsWith("--") && !known.has(arg)) ||
      !value("--environment") || (args.includes("--from") && !value("--from"))) {
    process.stderr.write("Usage: node scripts/ukair_bc/build_bc_uv_diurnal.mjs --environment TEST|LIVE [--from YYYY-MM-01] [--publish]\n");
    process.exitCode = 2;
  } else {
    buildBcUvDiurnal({ requestedEnvironment: value("--environment"), fromDay: value("--from") || "2024-01-01", publish: args.includes("--publish") })
      .then(({ product, ...result }) => process.stdout.write(`${JSON.stringify({ ...result, source_through_day: product.source_through_day, sensor_count: product.sensors.length })}\n`))
      .catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
  }
}
