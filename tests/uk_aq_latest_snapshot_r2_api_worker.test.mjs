import assert from "node:assert/strict";
import test from "node:test";

import worker from "../workers/uk_aq_latest_snapshot_r2_api_worker/worker.mjs";

const AUTH_SECRET = "test-upstream-secret";

function request(path) {
  return new Request(`https://snapshot.test${path}`, {
    headers: {
      "x-uk-aq-upstream-auth": AUTH_SECRET,
    },
  });
}

function snapshotPayload() {
  return {
    region: null,
    pcon_code: null,
    pollutant: "no2",
    window: "all",
    since: null,
    since_id: null,
    next_since: null,
    next_since_id: null,
    count: 1,
    data: [{
      id: 101,
      last_value: 12,
      last_value_at: new Date(Date.now()).toISOString(),
      network_id: 2,
      network_code: "breathelondon",
      network_label: "Breathe London",
      connector_id: 7,
      connector_code: "blondon_nodes",
      connector_label: "Breathe London Nodes",
    }],
  };
}

test("public finite latest snapshot derives from the canonical v2 all object", async () => {
  const requestedKeys = [];
  const payload = snapshotPayload();
  const env = {
    UK_AQ_EDGE_UPSTREAM_SECRET: AUTH_SECRET,
    UK_AQ_HISTORY_BUCKET: {
      async get(key) {
        requestedKeys.push(key);
        return {
          body: JSON.stringify(payload),
          json: async () => payload,
          etag: "v2-etag",
          httpMetadata: { contentType: "application/json" },
        };
      },
    },
  };

  const response = await worker.fetch(
    request("/v1/latest-snapshot?pollutant=no2&window=6h&scope=all"),
    env,
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-UK-AQ-Snapshot-Contract"), "v2");
  assert.deepEqual(requestedKeys, [
    "latest_snapshots/v2/network_group=all/pollutant=no2/window=all.json",
  ]);

  const body = await response.json();
  assert.equal(body.window, "6h");
  assert.equal(body.count, 1);
  assert.equal(body.next_since, payload.data[0].last_value_at);
  assert.equal(body.next_since_id, 101);
  assert.match(response.headers.get("ETag") || "", /^"sha256-[a-f0-9]{64}"$/);
  const row = body.data[0];
  assert.equal(row.network_id, 2);
  assert.equal(row.network_code, "breathelondon");
  assert.equal(row.network_label, "Breathe London");
  assert.equal(row.connector_code, "blondon_nodes");
  assert.equal(Object.hasOwn(row, "station_network_memberships"), false);
  assert.equal(Object.hasOwn(row, "network_memberships"), false);
  assert.equal(Object.hasOwn(row, "network_name"), false);
  assert.equal(Object.hasOwn(row, "network_type"), false);
});

test("v1 prefix configuration fails closed without reading R2", async () => {
  let readCount = 0;
  const env = {
    UK_AQ_EDGE_UPSTREAM_SECRET: AUTH_SECRET,
    UK_AQ_LATEST_SNAPSHOT_R2_PREFIX: "latest_snapshots/v1",
    UK_AQ_LATEST_SNAPSHOT_MANIFEST_KEY: "latest_snapshots/v1/manifest.json",
    UK_AQ_HISTORY_BUCKET: {
      async get() {
        readCount += 1;
        return null;
      },
    },
  };

  const response = await worker.fetch(
    request("/v1/latest-snapshot?pollutant=no2&window=6h&scope=all"),
    env,
  );

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "invalid_v2_snapshot_config" });
  assert.equal(readCount, 0);
});
