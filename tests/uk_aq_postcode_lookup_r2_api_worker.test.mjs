import test from "node:test";
import assert from "node:assert/strict";

import {
  getPostcodeShard,
  normalisePostcode,
} from "../workers/shared/postcode_lookup.mjs";
import postcodeLookupWorker, {
  handlePostcodeLookupRequest,
} from "../workers/uk_aq_postcode_lookup_r2_api_worker/worker.mjs";

function createEnvWithShards(shardsByKey) {
  return {
    UK_AQ_EDGE_UPSTREAM_SECRET: "test-upstream-secret",
    UK_AQ_POSTCODE_R2_PREFIX: "v1",
    UK_AQ_POSTCODE_LOOKUP_BUCKET: {
      async get(key) {
        if (!(key in shardsByKey)) {
          return null;
        }
        const value = shardsByKey[key];
        return {
          async json() {
            return value;
          },
        };
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
  const response = await handlePostcodeLookupRequest(
    new Request("https://example.test/v1/postcode_lookup?postcode=not-a-real-postcode"),
    createEnvWithShards({}),
  );
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.error, "invalid_postcode");
});

test("route returns 404 when postcode is not in an existing shard", async () => {
  const env = createEnvWithShards({
    "v1/SW.json": {
      schema_version: 1,
      source: "ONSPD",
      shard: "SW",
      postcodes: {
        SW1A1AA: [51.501009, -0.141588],
      },
    },
  });
  const response = await handlePostcodeLookupRequest(
    new Request("https://example.test/v1/postcode_lookup?postcode=SW1A%202AA"),
    env,
  );
  assert.equal(response.status, 404);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.error, "postcode_not_found");
});

test("fetch returns 401 when upstream auth header is missing", async () => {
  const env = createEnvWithShards({
    "v1/SW.json": {
      schema_version: 1,
      source: "ONSPD",
      shard: "SW",
      postcodes: {
        SW1A1AA: [51.501009, -0.141588],
      },
    },
  });

  const response = await postcodeLookupWorker.fetch(
    new Request("https://example.test/v1/postcode_lookup?postcode=SW1A%201AA"),
    env,
  );
  assert.equal(response.status, 401);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.error, "unauthorized");
});

test("fetch returns 200 with valid upstream auth header", async () => {
  const env = createEnvWithShards({
    "v1/SW.json": {
      schema_version: 1,
      source: "ONSPD",
      shard: "SW",
      postcodes: {
        SW1A1AA: [51.501009, -0.141588],
      },
    },
  });

  const response = await postcodeLookupWorker.fetch(
    new Request("https://example.test/v1/postcode_lookup?postcode=SW1A%201AA", {
      headers: {
        "x-uk-aq-upstream-auth": "test-upstream-secret",
      },
    }),
    env,
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.postcode_normalised, "SW1A1AA");
});
