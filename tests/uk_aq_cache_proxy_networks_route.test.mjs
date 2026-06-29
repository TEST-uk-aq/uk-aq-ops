import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourcePath = new URL("../workers/uk_aq_cache_proxy/src/index.ts", import.meta.url);

async function cacheProxySource() {
  return await readFile(sourcePath, "utf8");
}

test("/api/aq/networks routes to the public networks edge function with metadata caching", async () => {
  const source = await cacheProxySource();

  assert.match(source, /uk_aq_public_networks:\s*"metadata"/);
  assert.match(source, /networks:\s*"uk_aq_public_networks"/);
  assert.doesNotMatch(source, /networks:\s*"uk_aq_networks"/);
});

test("cache proxy keeps snapshot URLs stable and does not add routine cache busters", async () => {
  const source = await cacheProxySource();

  assert.match(source, /"latest-snapshot":\s*EXTERNAL_LATEST_SNAPSHOT_UPSTREAM/);
  assert.match(source, /const CACHE_BYPASS_QUERY = "cache"/);
  assert.doesNotMatch(source, /networks.*(?:cache_bust|cache-bust|cachebuster|timestamp|_t)/i);
});

test("legacy connector filter route mapping is unchanged", async () => {
  const source = await cacheProxySource();

  assert.match(source, /latest:\s*"uk_aq_latest"/);
  assert.match(source, /timeseries:\s*"uk_aq_timeseries"/);
  assert.match(source, /stations:\s*"uk_aq_stations"/);
  assert.match(source, /"stations-chart":\s*"uk_aq_stations_chart"/);
  assert.match(source, /"la-hex":\s*"uk_aq_la_hex"/);
  assert.match(source, /"pcon-hex":\s*"uk_aq_pcon_hex"/);
});
