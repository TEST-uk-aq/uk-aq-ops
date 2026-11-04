import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  buildObservationHistoryExactLeafIndexV3ScopedHierarchy,
  encodeObservationHistoryIndexV3Json,
} from "../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs";
import { buildObservationHistoryV3SteadyStatePartition } from "../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs";
import {
  prepareObservationHistoryExactLeafRequestV3,
  readObservationHistoryExactLeafDailyMetadataV3,
  readObservationHistoryExactLeafPageV3,
} from "../workers/shared/uk_aq_observation_history_exact_leaf_reader_v3.mjs";
import { createR2ObservationHistoryV3Source } from "../workers/shared/uk_aq_observation_history_random_access_v3.mjs";
import { exactLeafRevisionBytesV3 } from "../workers/shared/uk_aq_observation_history_exact_leaf_format_v3.mjs";
import { createStationHistoryV3ReadBudget, readR2Observations } from "../workers/uk_aq_station_history/src/r2_observations.mjs";
import worker, { observationHistoryV3ReaderIndex } from "../workers/uk_aq_observs_history_r2_api_worker/worker_v3.mjs";

const ROOT = "history/_index_v3/observations_timeseries";
const INDEX = observationHistoryV3ReaderIndex(ROOT);
const ID = 7421;
const sha256 = (body) => createHash("sha256").update(body).digest("hex");
const encode = (payload) => Buffer.from(encodeObservationHistoryIndexV3Json(payload));
const decodeCursor = (cursor) => JSON.parse(Buffer.from(cursor, "base64url"));
const encodeCursor = (payload) => Buffer.from(JSON.stringify(payload)).toString("base64url");

// Real writer bytes, served only by an injected local R2 binding. Both exact
// formats refer to the same canonical files; selection never runs a publisher.
function partition(day = "2026-01-02", count = 1025, hour = 0) {
  const built = buildObservationHistoryV3SteadyStatePartition({
    source: "integrity", targetWriterGitSha: "1".repeat(40), backedUpAtUtc: null,
    rows: Array.from({ length: count }, (_, i) => ({
      connector_id: 1, station_id: 7001, timeseries_id: ID, pollutant_code: "pm25",
      observed_at_utc: new Date(Date.parse(`${day}T00:00:00.000Z`) + hour * 3600000 + i * 1000).toISOString(),
      value: 10 + i / 100, verification_status: "R",
    })),
  });
  const manifest = built.canonical_pollutant_manifest;
  const two = buildObservationHistoryExactLeafIndexV3ScopedHierarchy({
    metadata: built.target_metadata, exactSchemaVersion: 2,
    canonicalManifest: { key: manifest.key, byte_size: manifest.byte_size, sha256: manifest.sha256,
      manifest_hash: manifest.payload.manifest_hash, row_count: manifest.payload.row_count,
      observation_content_hash: manifest.payload.observation_content_hash, observation_content_hash_version: 1 },
  });
  return { built, one: built.v3_hierarchy, two };
}

function fixture(...partitions) {
  const objects = new Map();
  const calls = [];
  const select = (hierarchy) => {
    for (const artifact of hierarchy.publication_objects) objects.set(artifact.key, Buffer.from(artifact.body));
  };
  for (const p of partitions) {
    select(p.one);
    for (const file of p.built.file_intents) objects.set(file.key, Buffer.from(file.body));
  }
  const metadata = (body) => ({ size: body.length, etag: `fixture-${sha256(body)}`,
    checksums: { sha256: Uint8Array.from(Buffer.from(sha256(body), "hex")).buffer } });
  const bucket = {
    async head(key) { calls.push({ head: key }); const body = objects.get(key); return body ? metadata(body) : null; },
    async get(key, options) {
      calls.push({ get: key, options });
      const body = objects.get(key);
      if (!body) return null;
      const meta = metadata(body);
      if (options?.range) {
        assert.equal(options.onlyIf.etagMatches, meta.etag);
        const { offset, length } = options.range;
        assert.ok(length < body.length, "no whole-file Parquet GET");
        return { ...meta, range: { offset, length }, body: true,
          async arrayBuffer() { return Uint8Array.from(body.subarray(offset, offset + length)).buffer; } };
      }
      assert.ok(!key.endsWith(".parquet"), "no footer or whole-file discovery");
      return { ...meta, body: true, async arrayBuffer() { return Uint8Array.from(body).buffer; } };
    },
  };
  const source = createR2ObservationHistoryV3Source({ bucket });
  return { objects, calls, select, bucket, source, request: {
    source, timeseriesId: ID, connectorId: 1, pollutantCode: "pm25",
    startUtc: "2026-01-02T00:00:00.000Z", endUtc: "2026-01-03T00:00:00.000Z", index: INDEX,
  } };
}

test("cursor 3 rejects a schema-2 switch even while its original aligned and exact leaves remain", async () => {
  const p = partition();
  const f = fixture(p);
  const first = await readObservationHistoryExactLeafPageV3(f.request);
  const cursor = decodeCursor(first.physical_page.next_cursor);
  assert.equal(cursor.schema_version, 3);
  assert.equal(cursor.discovery.scopes[0].exact_format, undefined);
  f.select(p.two);
  f.calls.length = 0;
  await assert.rejects(readObservationHistoryExactLeafPageV3({ ...f.request,
    physicalCursor: first.physical_page.next_cursor }), (error) => error.code === "physical_cursor_invalid");
  assert.equal(f.calls.filter((call) => call.head || call.options?.range).length, 0);
});

test("cursor 3 authenticates both day selectors before continuing into unchanged schema-1 data", async () => {
  const older = partition("2026-01-02", 1, 23);
  const newer = partition("2026-01-03", 1, 1);
  const f = fixture(older, newer);
  const request = { ...f.request, startUtc: "2026-01-02T23:00:00.000Z", endUtc: "2026-01-03T23:00:00.000Z" };
  const first = await readObservationHistoryExactLeafPageV3(request);
  f.select(older.two);
  await assert.rejects(readObservationHistoryExactLeafPageV3({ ...request,
    physicalCursor: first.physical_page.next_cursor }), (error) => error.code === "physical_cursor_invalid");
});

test("unchanged schema-1 and direct schema-2 pages preserve rows, cursor meanings and read bounds", async () => {
  const p = partition();
  for (const version of [1, 2]) {
    const f = fixture(p);
    if (version === 2) {
      f.objects.clear();
      for (const file of p.built.file_intents) f.objects.set(file.key, Buffer.from(file.body));
      f.select(p.two);
    }
    const first = await readObservationHistoryExactLeafPageV3(f.request);
    const cursor = decodeCursor(first.physical_page.next_cursor);
    assert.equal(cursor.schema_version, version === 1 ? 3 : 4);
    assert.ok(first.physical_page.next_cursor.length <= 12288);
    if (version === 2) assert.equal(Date.parse(cursor.expires_at_utc) - Date.parse(cursor.issued_at_utc), 300000);
    f.calls.length = 0;
    const second = await readObservationHistoryExactLeafPageV3({ ...f.request, physicalCursor: first.physical_page.next_cursor });
    assert.equal(second.response_complete, true);
    assert.deepEqual([...first.rows, ...second.rows].map((r) => r.value), Array.from({ length: 1025 }, (_, i) => 10 + i / 100));
    assert.equal(second.diagnostics.scoped_manifests_read, 1);
    assert.equal(second.diagnostics.timeseries_leaf_objects_read, 1);
    assert.equal(second.diagnostics.whole_logical_range_segment_discovery, false);
    assert.equal(second.diagnostics.global_segment_sorting, false);
    for (const result of [first, second]) {
      assert.ok(result.diagnostics.index_objects_read <= 4);
      assert.ok(result.diagnostics.index_bytes_read <= 8 * 1024 * 1024);
      assert.ok(result.diagnostics.r2_range_reads <= 2);
      assert.ok(result.diagnostics.r2_bytes_requested <= 8 * 1024 * 1024);
      assert.equal(result.diagnostics.physical_segments_decoded, 1);
      assert.ok(result.diagnostics.physical_rows_decoded <= 1024);
      assert.equal(result.diagnostics.parquet_footer_fetched, false);
      assert.equal(result.diagnostics.timeseries_id_decoded, false);
    }
    assert.equal(f.calls.filter((c) => c.get?.includes("/_aligned/")).length, 0);
  }
});

test("mixed-format cross-day cursors keep every scope identity and original lifetime across four pages", async () => {
  const older = partition("2026-01-02", 1025, 23), newer = partition("2026-01-03");
  for (const versions of [[1, 2], [2, 1]]) {
    const f = fixture(older, newer);
    if (versions[0] === 2) f.select(older.two); else f.select(newer.two);
    const request = { ...f.request, startUtc: "2026-01-02T23:00:00.000Z", endUtc: "2026-01-03T23:00:00.000Z" };
    let cursor = null, lifetime = null;
    const rows = [];
    for (let page = 1; page <= 4; page++) {
      f.calls.length = 0;
      const result = await readObservationHistoryExactLeafPageV3({ ...request, physicalCursor: cursor });
      rows.push(...result.rows);
      assert.equal(result.physical_page.page_number, page);
      assert.equal(result.response_complete, page === 4);
      assert.equal(result.has_gap, false);
      assert.equal(result.diagnostics.index_objects_read, page === 1 ? 4 : 3);
      assert.equal(f.calls.filter((c) => c.get && !c.options).length, page === 1 ? 4 : 3);
      cursor = result.physical_page.next_cursor;
      if (cursor) {
        const decoded = decodeCursor(cursor);
        assert.equal(decoded.schema_version, 4);
        assert.deepEqual(decoded.discovery.scopes.map((s) => s.exact_format.schema_version), versions);
        const pair = [decoded.issued_at_utc, decoded.expires_at_utc];
        if (lifetime) assert.deepEqual(pair, lifetime); else lifetime = pair;
      }
    }
    assert.equal(rows.length, 2050);
    assert.deepEqual(rows.map((r) => r.observed_at_utc), rows.map((r) => r.observed_at_utc).sort());
  }
});

test("cursor 4 rejects substituted format, selector, leaf, position, request, expiry and oversized state", async () => {
  const p = partition(), f = fixture(p);
  f.select(p.two);
  const first = await readObservationHistoryExactLeafPageV3(f.request);
  const original = decodeCursor(first.physical_page.next_cursor);
  const faults = [
    (c) => { c.discovery.scopes[0].exact_format.schema_version = 1; },
    (c) => { c.discovery.scopes[0].selector_descriptor.sha256 = "0".repeat(64); },
    (c) => { c.discovery.scopes[0].selector_descriptor.key = "outside/manifest.json"; },
    (c) => { c.next.leaf_sha256 = "0".repeat(64); },
    (c) => { c.next.row_start++; },
    (c) => { c.next.physical_identity.writer_version = "parquet-wasm-zstd-v4"; },
    (c) => { c.request.timeseries_id++; },
    (c) => { c.issued_at_utc = "2000-01-01T00:00:00.000Z"; c.expires_at_utc = "2000-01-01T00:05:00.000Z"; },
    (c) => { c.expires_at_utc = new Date(Date.parse(c.expires_at_utc) + 1).toISOString(); },
    (c) => { c.extra = "unsupported"; },
  ];
  for (const mutate of faults) {
    const cursor = structuredClone(original);
    mutate(cursor);
    f.calls.length = 0;
    await assert.rejects(readObservationHistoryExactLeafPageV3({ ...f.request, physicalCursor: encodeCursor(cursor) }),
      (error) => error.code === "physical_cursor_invalid");
    assert.equal(f.calls.filter((c) => c.head || c.options?.range).length, 0);
  }
  await assert.rejects(readObservationHistoryExactLeafPageV3({ ...f.request, physicalCursor: "a".repeat(12289) }),
    (error) => error.code === "physical_cursor_invalid");
  // An index-only selector revision leaves every canonical file and old leaf intact.
  const selector = structuredClone(p.two.scoped_manifest.payload);
  selector.canonical_source_manifest.sha256 = "0".repeat(64);
  f.objects.set(selector.key, encode(selector));
  await assert.rejects(readObservationHistoryExactLeafPageV3({ ...f.request, physicalCursor: first.physical_page.next_cursor }),
    (error) => error.code === "physical_cursor_invalid");
  // A different valid immutable revision against unchanged canonical data also
  // supersedes the cursor, even with the original immutable leaf retained.
  const leaf = structuredClone(p.two.exact_leaves[0].payload);
  leaf.files[0].etag = `fixture-${sha256(f.objects.get(leaf.files[0].key))}`;
  leaf.key = leaf.key.replace(/revision=[a-f0-9]{64}/, `revision=${sha256(exactLeafRevisionBytesV3(leaf))}`);
  const leafBody = encode(leaf);
  const revised = structuredClone(p.two.scoped_manifest.payload);
  revised.leaves_by_timeseries_id[ID] = [leaf.key, leafBody.length, sha256(leafBody)];
  f.objects.set(leaf.key, leafBody);
  f.objects.set(revised.key, encode(revised));
  await assert.rejects(readObservationHistoryExactLeafPageV3({ ...f.request, physicalCursor: first.physical_page.next_cursor }),
    (error) => error.code === "physical_cursor_invalid");
});

test("missing or contradictory schema-2 authority never falls back to retained schema-1 leaves", async () => {
  const p = partition();
  for (const fault of ["scope", "leaf", "format", "physical", "hash_version"]) {
    const f = fixture(p);
    f.select(p.two);
    const selector = structuredClone(p.two.scoped_manifest.payload);
    if (fault === "scope") f.objects.delete(selector.key);
    if (fault === "leaf") f.objects.delete(p.two.exact_leaves[0].key);
    if (fault === "format") selector.exact_leaf_index_version = "exact-timeseries-leaf-v1";
    if (fault === "physical") selector.writer_version = "unsupported";
    if (fault === "hash_version") selector.canonical_source_manifest.observation_content_hash_version = 3;
    if (!["scope", "leaf"].includes(fault)) f.objects.set(selector.key, encode(selector));
    if (["scope", "leaf"].includes(fault)) {
      const result = await readObservationHistoryExactLeafPageV3(f.request);
      assert.equal(result.response_complete, false);
      assert.equal(result.has_gap, true);
      assert.equal(result.rows.length, 0);
    } else await assert.rejects(readObservationHistoryExactLeafPageV3(f.request));
    assert.equal(f.calls.filter((c) => c.head || c.options?.range).length, 0);
    assert.ok(!f.calls.some((c) => c.get === p.one.exact_leaves[0].key));
  }
});

async function withCache(f, callback) {
  const previous = globalThis.caches;
  const entries = new Map(), pending = [];
  globalThis.caches = { default: {
    async match(key) { return entries.get(key.url)?.clone(); },
    async put(key, response) { entries.set(key.url, response); },
  } };
  const env = { UK_AQ_ENV_NAME: "TEST", UK_AQ_R2_HISTORY_VERSION: "v3", UK_AQ_HISTORY_BUCKET: f.bucket,
    UK_AQ_EDGE_UPSTREAM_SECRET: "fixture-secret", UK_AQ_OBSERVS_HISTORY_R2_VERIFICATION_OVERLAY_ENABLED: "false" };
  const fetchPage = async (params = {}) => {
    const url = new URL("https://history-test.sleepercar.co.uk/v1/observations");
    for (const [key, value] of Object.entries({ timeseries_id: ID, connector_id: 1, pollutant: "pm25",
      start_utc: f.request.startUtc, end_utc: f.request.endUtc, ...params })) url.searchParams.set(key, value);
    const response = await worker.fetch(new Request(url, { headers: { "x-uk-aq-upstream-auth": "fixture-secret" } }),
      env, { waitUntil(promise) { pending.push(promise); } });
    await Promise.all(pending.splice(0));
    return response;
  };
  try { await callback({ entries, fetchPage }); }
  finally { if (previous === undefined) delete globalThis.caches; else globalThis.caches = previous; }
}

test("Worker authenticates selectors before cache hits and invalidates complete responses on index-only switches", async () => {
  const p = partition("2026-01-02", 2), f = fixture(p);
  await withCache(f, async ({ entries, fetchPage }) => {
    assert.equal((await fetchPage()).headers.get("x-ukaq-cache"), "MISS");
    f.calls.length = 0;
    assert.equal((await fetchPage()).headers.get("x-ukaq-cache"), "HIT");
    assert.deepEqual(f.calls.map((c) => c.get), [p.one.scoped_manifest.key]);
    f.select(p.two);
    assert.equal((await fetchPage()).headers.get("x-ukaq-cache"), "MISS");
    assert.equal(entries.size, 2);
    assert.equal((await fetchPage()).headers.get("x-ukaq-cache"), "HIT");
    const selector = structuredClone(p.two.scoped_manifest.payload);
    selector.canonical_source_manifest.manifest_hash = "0".repeat(64);
    f.objects.set(selector.key, encode(selector));
    assert.equal((await fetchPage()).headers.get("x-ukaq-cache"), "MISS");
    assert.equal(entries.size, 3);
    f.objects.delete(selector.key);
    const missing = await fetchPage();
    assert.equal(missing.headers.get("Cache-Control"), "no-store");
    assert.equal((await missing.json()).response_complete, false);
    assert.equal(entries.size, 3);
  });
});

test("mixed-day cache identities include missing/new scopes and reuse selector GETs on cold reads", async () => {
  const older = partition("2026-01-02", 1, 23), newer = partition("2026-01-03", 1);
  const f = fixture(older);
  const request = { ...f.request, startUtc: "2026-01-02T23:00:00.000Z", endUtc: "2026-01-03T23:00:00.000Z" };
  const missing = await prepareObservationHistoryExactLeafRequestV3(request);
  f.select(newer.two);
  const mixed = await prepareObservationHistoryExactLeafRequestV3(request);
  assert.notEqual(mixed.cache_identity, missing.cache_identity);
  f.calls.length = 0;
  const first = await readObservationHistoryExactLeafPageV3({ ...request, source: mixed.source });
  assert.equal(f.calls.filter((c) => c.get && !c.options).length, 2, "only two leaves; selectors already fetched");
  assert.equal(first.has_gap, false);
  f.select(older.two);
  assert.notEqual((await prepareObservationHistoryExactLeafRequestV3(request)).cache_identity, mixed.cache_identity);
});

test("Worker physical pagination and continuation remain no-store", async () => {
  const p = partition(), f = fixture(p);
  f.select(p.two);
  await withCache(f, async ({ entries, fetchPage }) => {
    const first = await fetchPage();
    assert.equal(first.headers.get("Cache-Control"), "no-store");
    const second = await fetchPage({ physical_cursor: (await first.json()).physical_page.next_cursor });
    assert.equal((await second.json()).response_complete, true);
    assert.equal(second.headers.get("Cache-Control"), "no-store");
    assert.equal(second.headers.get("x-ukaq-cache"), "BYPASS");
    assert.equal(entries.size, 0);
  });
});

test("daily provenance metadata accepts mixed selection without manufacturing physical or writer proof", async () => {
  const older = partition("2026-01-02", 1), newer = partition("2026-01-03", 1), f = fixture(older, newer);
  f.select(newer.two);
  const result = await readObservationHistoryExactLeafDailyMetadataV3({ ...f.request, endUtc: "2026-01-04T00:00:00.000Z" });
  assert.equal(result.response_complete, true);
  assert.deepEqual(result.rows.map((r) => r.day_utc), ["2026-01-02", "2026-01-03"]);
  assert.equal(f.calls.filter((c) => c.head || c.options?.range).length, 0);
  assert.equal(result.publication_eligible, undefined);
});

test("Station History consumes real mixed-format pages with chronological physical identity and shared budgets", async () => {
  const older = partition("2026-01-02", 1025, 23), newer = partition("2026-01-03"), f = fixture(older, newer);
  f.select(newer.two);
  await withCache(f, async ({ fetchPage }) => {
    const options = {
      env: { UK_AQ_R2_HISTORY_VERSION: "v3", UK_AQ_OBSERVS_HISTORY_R2_API_URL: "https://fixture.test",
        UK_AQ_EDGE_UPSTREAM_SECRET: "fixture-secret" },
      identity: { timeseriesId: ID, stationId: 7001, connectorId: 1, pollutant: "pm25" },
      startMs: Date.parse("2026-01-02T23:00:00.000Z"), endMs: Date.parse("2026-01-03T23:00:00.000Z"),
      fetchApi: async (url) => fetchPage(Object.fromEntries(new URL(url).searchParams)),
    };
    const budget = createStationHistoryV3ReadBudget();
    const result = await readR2Observations({ ...options, readBudget: budget });
    assert.equal(result.response_complete, true);
    assert.equal(result.fetch_count, 4);
    assert.equal(budget.pagesUsed, 4);
    assert.equal(budget.rowsUsed, 2050);
    assert.ok(result.rows.every((r) => r.station_id === 7001 && r.timeseries_id === ID));
    assert.deepEqual(result.rows.map((r) => r.observed_at), result.rows.map((r) => r.observed_at).sort());
    const bounded = await readR2Observations({ ...options, readBudget: createStationHistoryV3ReadBudget({ pageLimit: 1 }) });
    assert.equal(bounded.response_complete, false);
    assert.deepEqual(bounded.partial_reasons, ["observation_history_physical_page_budget_exceeded"]);
    const rowBounded = await readR2Observations({ ...options, readBudget: createStationHistoryV3ReadBudget({ rowLimit: 1024 }) });
    assert.equal(rowBounded.response_complete, false);
    assert.equal(rowBounded.rows.length, 1024);
    assert.deepEqual(rowBounded.partial_reasons, ["observation_history_row_budget_exceeded"]);
  });
});
