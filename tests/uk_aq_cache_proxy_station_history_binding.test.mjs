import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("gateway declares the private STATION_HISTORY Service Binding and disabled route flags", async () => {
  const [source, wrangler, cacheWorkflow, stationWorkflow] = await Promise.all([
    readFile("workers/uk_aq_cache_proxy/src/index.ts", "utf8"),
    readFile("workers/uk_aq_cache_proxy/wrangler.toml", "utf8"),
    readFile(".github/workflows/uk_aq_cache_proxy_deploy.yml", "utf8"),
    readFile(".github/workflows/uk_aq_station_history_deploy.yml", "utf8"),
  ]);
  assert.match(wrangler, /binding = "STATION_HISTORY"/);
  assert.match(wrangler, /service = "__UK_AQ_STATION_HISTORY_WORKER_NAME__"/);
  assert.doesNotMatch(wrangler, /service = "uk-aq-station-history"/);
  assert.match(cacheWorkflow, /UK_AQ_STATION_HISTORY_WORKER_NAME: \$\{\{ vars\.UK_AQ_STATION_HISTORY_WORKER_NAME \|\| '' \}\}/);
  assert.match(cacheWorkflow, /Resolve STATION_HISTORY Service Binding target/);
  assert.match(cacheWorkflow, /Missing required GitHub repository variable UK_AQ_STATION_HISTORY_WORKER_NAME/);
  assert.equal((cacheWorkflow.match(/deploy --config wrangler\.deploy\.toml --name/g) || []).length, 2, "base and final cache deployments use the same resolved binding config");
  assert.match(stationWorkflow, /UK_AQ_STATION_HISTORY_WORKER_NAME: \$\{\{ vars\.UK_AQ_STATION_HISTORY_WORKER_NAME \|\| '' \}\}/);
  assert.match(stationWorkflow, /Missing required GitHub repository variable UK_AQ_STATION_HISTORY_WORKER_NAME/);
  assert.match(stationWorkflow, /SB_SECRET_KEY/);
  assert.doesNotMatch(stationWorkflow, /OBS_AQIDB_SUPABASE_URL|OBS_AQIDB_SECRET_KEY/);
  assert.match(stationWorkflow, /UK_AQ_PUBLIC_SCHEMA/);
  assert.match(stationWorkflow, /INGESTDB_RETENTION_DAYS/);
  assert.doesNotMatch(stationWorkflow, /SB_PUBLISHABLE_DEFAULT_KEY/);
  assert.match(source, /UK_AQ_STATION_HISTORY_AQI_HISTORY_ENABLED/);
  assert.match(source, /UK_AQ_STATION_HISTORY_TIMESERIES_ENABLED/);
  assert.match(source, /station_history_internal_fetch_failed/);
  assert.match(source, /X-UK-AQ-Station-History-Route/);
  assert.match(source, /usingExternalAqiHistoryUpstream[\s\S]*?"\/v1\/aqi-history"/);
  assert.match(source, /TIMESERIES_UPSTREAM_FUNCTION[\s\S]*?"\/v1\/observations-history"/);
  assert.match(source, /isProgressiveStationHistoryChunkRequest\(url\)/);
  assert.match(source, /useTimeseriesV2Skeleton && stationHistoryInternalRoute !== "\/v1\/observations-history"/);
  assert.match(source, /X-UK-AQ-Station-History-Identity-Error/);
  assert.match(source, /const responseHeaders = new Headers\(internalResponse\.headers\);/);
  assert.match(source, /new Response\(internalResponse\.body, \{\s*status: internalResponse\.status,/);
  assert.equal((source.match(/cachedStationSeriesIdentityMatchesRequest/g) || []).length, 2, "fresh and stale station-series hits validate any supplied connector hint");
});

test("station-history deployment validates every mandatory private data-path setting before secret bulk", async () => {
  const workflow = await readFile(".github/workflows/uk_aq_station_history_deploy.yml", "utf8");
  for (const name of [
    "SUPABASE_URL",
    "SB_SECRET_KEY",
    "UK_AQ_EDGE_UPSTREAM_SECRET",
    "UK_AQ_AQI_HISTORY_R2_API_URL",
    "UK_AQ_OBSERVS_HISTORY_R2_API_URL",
    "UK_AQ_STATION_HISTORY_WORKER_NAME",
    "UK_AQ_DOMAIN_CLOUDFLARE_ACCOUNT_ID",
    "UK_AQ_DOMAIN_CLOUDFLARE_API_TOKEN",
  ]) {
    assert.match(workflow, new RegExp(`test -n "\\$\\{${name}\\}"`));
  }
  assert.ok(workflow.indexOf("Validate station-history deployment configuration") < workflow.indexOf("Set data-path Worker secrets"));
});

test("station-series cache canonicalisation separates observations-only requests", async () => {
  const source = await readFile("workers/uk_aq_cache_proxy/src/station_history/cache_keys.mjs", "utf8");
  assert.match(source, /canonicalizeStationSeriesRequestUrl/);
  assert.match(source, /include_aqi/);
});
