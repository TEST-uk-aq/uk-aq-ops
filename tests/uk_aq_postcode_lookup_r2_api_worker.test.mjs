import test from "node:test";
import assert from "node:assert/strict";

import {
  getPostcodeShard,
  normalisePostcode,
} from "../workers/shared/postcode_lookup.mjs";
import postcodeLookupWorker, {
  handlePostcodeLookupRequest,
  handlePostcodePrefixHintsRequest,
  handlePostcodeSuggestRequest,
} from "../workers/uk_aq_postcode_lookup_r2_api_worker/worker.mjs";

function createEnvWithObjects(objectsByKey) {
  const uniquePrefix = `v1-${Math.random().toString(36).slice(2, 10)}`;
  const remapped = {};
  for (const [key, value] of Object.entries(objectsByKey)) {
    remapped[key.replace(/^v1\//, `${uniquePrefix}/`)] = value;
  }

  const getCalls = [];

  return {
    getCalls,
    prefix: uniquePrefix,
    env: {
      UK_AQ_EDGE_UPSTREAM_SECRET: "test-upstream-secret",
      UK_AQ_POSTCODE_R2_PREFIX: uniquePrefix,
      UK_AQ_POSTCODE_LOOKUP_BUCKET: {
        async get(key) {
          getCalls.push(key);
          if (!(key in remapped)) {
            return null;
          }
          return {
            async json() {
              return remapped[key];
            },
          };
        },
      },
    },
  };
}

function buildBaseObjects() {
  return {
    "v1/shards/BS.json": {
      schema_version: 2,
      source: "ONSPD",
      shard: "BS",
      columns: ["lat", "lon", "pcon_code", "la_code", "area_town_id"],
      postcodes: {
        BS21AA: [51.45, -2.58, "E14000001", "E06000001", 41],
        BS375BA: [51.544645, -2.410163, "E14001545", "E06000025", 42],
      },
    },
    "v1/suggest/BS.json": {
      schema_version: 1,
      postcode_area: "BS",
      columns: ["n", "p", "at", "pc", "la"],
      rows: [
        ["BS200AA", "BS20 0AA", 41, "E14000001", "E06000001"],
        ["BS21AA", "BS2 1AA", 41, "E14000001", "E06000001"],
        ["BS21AB", "BS2 1AB", 41, "E14000001", "E06000001"],
        ["BS375BA", "BS37 5BA", 42, "E14001545", "E06000025"],
      ],
    },
    "v1/area_town_index.json": {
      schema_version: 1,
      columns: ["area_name", "post_town"],
      values: {
        0: [null, null],
        41: ["Emersons Green", "Bristol"],
        42: ["Bristol", "Bristol"],
      },
    },
    "v1/postcode_prefix_hints.json": {
      schema_version: 1,
      postcode_samples_1: {
        B: [
          ["BS11AA", "BS1 1AA", 41, "E14000001", "E06000001"],
          ["BS11AB", "BS1 1AB", 41, "E14000001", "E06000001"],
          ["BT11AA", "BT1 1AA", 0, "N06000001", "N09000003"],
        ],
      },
      postcode_samples_2: {
        BS: [
          ["BS11AA", "BS1 1AA", 41, "E14000001", "E06000001"],
          ["BS11AB", "BS1 1AB", 41, "E14000001", "E06000001"],
          ["BS200AA", "BS20 0AA", 41, "E14000001", "E06000001"],
        ],
      },
    },
  };
}

test("normalisePostcode handles lowercase and surrounding whitespace", () => {
  assert.equal(normalisePostcode("sw1a 1aa"), "SW1A1AA");
  assert.equal(normalisePostcode(" SW1A1AA "), "SW1A1AA");
});

test("getPostcodeShard resolves outward alphabetic area", () => {
  assert.equal(getPostcodeShard("SW1A1AA"), "SW");
  assert.equal(getPostcodeShard("EC1A1BB"), "EC");
  assert.equal(getPostcodeShard("BT11AA"), "BT");
});

test("normalisePostcode rejects blank and invalid input", () => {
  assert.equal(normalisePostcode(""), null);
  assert.equal(normalisePostcode("   "), null);
  assert.equal(normalisePostcode("NOT_A_POSTCODE"), null);
});

test("route returns 400 for invalid postcode", async () => {
  const { env } = createEnvWithObjects(buildBaseObjects());
  const response = await handlePostcodeLookupRequest(
    new Request("https://example.test/v1/postcode_lookup?postcode=not-a-real-postcode"),
    env,
  );
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.error, "invalid_postcode");
});

test("route returns 404 when postcode is not in an existing shard", async () => {
  const { env } = createEnvWithObjects(buildBaseObjects());
  const response = await handlePostcodeLookupRequest(
    new Request("https://example.test/v1/postcode_lookup?postcode=BS2%209ZZ"),
    env,
  );
  assert.equal(response.status, 404);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.error, "postcode_not_found");
});

test("fetch returns 401 when upstream auth header is missing", async () => {
  const { env } = createEnvWithObjects(buildBaseObjects());

  const response = await postcodeLookupWorker.fetch(
    new Request("https://example.test/v1/postcode_lookup?postcode=BS2%201AA"),
    env,
  );
  assert.equal(response.status, 401);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.error, "unauthorized");
});

test("fetch returns 200 with pcon_code, la_code, area_town details for valid postcode", async () => {
  const { env } = createEnvWithObjects(buildBaseObjects());

  const response = await postcodeLookupWorker.fetch(
    new Request("https://example.test/v1/postcode_lookup?postcode=BS2%201AA", {
      headers: {
        "x-uk-aq-upstream-auth": "test-upstream-secret",
      },
    }),
    env,
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.postcode_normalised, "BS21AA");
  assert.equal(payload.pcon_code, "E14000001");
  assert.equal(payload.la_code, "E06000001");
  assert.equal(payload.area_town_id, 41);
  assert.equal(payload.area_name, "Emersons Green");
  assert.equal(payload.post_town, "Bristol");
  assert.equal(payload.label, "BS2 1AA, Emersons Green, Bristol");
  assert.equal("pcon_name" in payload, false);
  assert.equal("la_name" in payload, false);
});

test("exact lookup label avoids duplicate town text", async () => {
  const { env } = createEnvWithObjects(buildBaseObjects());
  const response = await handlePostcodeLookupRequest(
    new Request("https://example.test/v1/postcode_lookup?postcode=BS37%205BA"),
    env,
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.area_name, "Bristol");
  assert.equal(payload.post_town, "Bristol");
  assert.equal(payload.label, "BS37 5BA, Bristol");
});

test("fetch keeps backward compatibility for older two-value shard rows", async () => {
  const { env } = createEnvWithObjects({
    "v1/BS.json": {
      schema_version: 1,
      source: "ONSPD",
      shard: "BS",
      postcodes: {
        BS21AA: [51.45, -2.58],
      },
    },
    "v1/area_town_index.json": {
      schema_version: 1,
      columns: ["area_name", "post_town"],
      values: { 0: [null, null] },
    },
  });

  const response = await postcodeLookupWorker.fetch(
    new Request("https://example.test/v1/postcode_lookup?postcode=BS2%201AA", {
      headers: {
        "x-uk-aq-upstream-auth": "test-upstream-secret",
      },
    }),
    env,
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.pcon_code, null);
  assert.equal(payload.la_code, null);
  assert.equal(payload.area_town_id, 0);
});

test("suggest endpoint returns decorated postcode results with default max limit", async () => {
  const { env } = createEnvWithObjects(buildBaseObjects());

  const response = await handlePostcodeSuggestRequest(
    new Request("https://example.test/v1/postcode_suggest?q=BS2"),
    env,
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.query_normalised, "BS2");
  assert.equal(payload.results.length, 3);
  assert.deepEqual(payload.results[0], {
    type: "postcode",
    postcode: "BS2 1AA",
    postcode_normalised: "BS21AA",
    area_town_id: 41,
    pcon_code: "E14000001",
    la_code: "E06000001",
    area_name: "Emersons Green",
    post_town: "Bristol",
    label: "BS2 1AA, Emersons Green, Bristol",
  });
  assert.equal(payload.results[1].postcode_normalised, "BS21AB");
  assert.equal(payload.results[2].postcode_normalised, "BS200AA");
});

test("suggest endpoint q length 1 and 2 uses postcode prefix samples and does not read suggest shard", async () => {
  const { env, getCalls, prefix } = createEnvWithObjects(buildBaseObjects());

  const response1 = await handlePostcodeSuggestRequest(
    new Request("https://example.test/v1/postcode_suggest?q=B&limit=10"),
    env,
  );
  const response2 = await handlePostcodeSuggestRequest(
    new Request("https://example.test/v1/postcode_suggest?q=BS&limit=10"),
    env,
  );

  assert.equal(response1.status, 200);
  assert.equal(response2.status, 200);

  const payload1 = await response1.json();
  const payload2 = await response2.json();

  assert.equal(payload1.source, "postcode_prefix_samples");
  assert.equal(payload2.source, "postcode_prefix_samples");
  assert.equal(payload1.results[0].type, "postcode");
  assert.equal(payload2.results[0].type, "postcode");
  assert.equal(payload1.results[0].postcode, "BS1 1AA");
  assert.equal(payload2.results[0].postcode, "BS1 1AA");
  assert.equal(payload1.results[0].pcon_code, "E14000001");
  assert.equal(payload1.results[0].la_code, "E06000001");
  assert.equal(payload2.results[0].pcon_code, "E14000001");
  assert.equal(payload2.results[0].la_code, "E06000001");

  const suggestReads = getCalls.filter((key) => key === `${prefix}/suggest/BS.json`);
  assert.equal(suggestReads.length, 0);
});

test("prefix hints endpoint returns decorated rows with geography codes", async () => {
  const { env } = createEnvWithObjects(buildBaseObjects());

  const response = await handlePostcodePrefixHintsRequest(
    new Request("https://example.test/v1/postcode_prefix_hints"),
    env,
  );
  assert.equal(response.status, 200);

  const payload = await response.json();
  const firstRow = payload.postcode_samples_1.B[0];
  assert.equal(firstRow.postcode, "BS1 1AA");
  assert.equal(firstRow.postcode_normalised, "BS11AA");
  assert.equal(firstRow.pcon_code, "E14000001");
  assert.equal(firstRow.la_code, "E06000001");
  assert.equal(firstRow.area_name, "Emersons Green");
  assert.equal(firstRow.post_town, "Bristol");
});

test("suggest endpoint q length 1 and 2 returns empty when sample table is missing", async () => {
  const { env } = createEnvWithObjects({
    "v1/postcode_prefix_hints.json": {
      schema_version: 1,
      postcode_samples_1: {},
      postcode_samples_2: {},
    },
    "v1/area_town_index.json": {
      schema_version: 1,
      columns: ["area_name", "post_town"],
      values: { 0: [null, null] },
    },
  });

  const response = await handlePostcodeSuggestRequest(
    new Request("https://example.test/v1/postcode_suggest?q=B&limit=10"),
    env,
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.source, "postcode_prefix_samples");
  assert.equal(payload.results.length, 0);
});

test("suggest endpoint returns 400 for invalid query", async () => {
  const { env } = createEnvWithObjects(buildBaseObjects());
  const response = await handlePostcodeSuggestRequest(
    new Request("https://example.test/v1/postcode_suggest?q=@@"),
    env,
  );
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.error, "invalid_query");
});

test("suggest endpoint returns empty results for unknown prefix area shard", async () => {
  const { env } = createEnvWithObjects({
    "v1/postcode_prefix_hints.json": {
      schema_version: 1,
      prefixes_1: {},
      prefixes_2: {},
    },
    "v1/area_town_index.json": {
      schema_version: 1,
      columns: ["area_name", "post_town"],
      values: { 0: [null, null] },
    },
  });

  const response = await handlePostcodeSuggestRequest(
    new Request("https://example.test/v1/postcode_suggest?q=ZZ1"),
    env,
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(Array.isArray(payload.results), true);
  assert.equal(payload.results.length, 0);
});
