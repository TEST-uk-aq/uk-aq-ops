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
    data: [{
      id: 101,
      network_id: 2,
      network_code: "breathelondon",
      network_label: "Breathe London",
      connector_id: 7,
      connector_code: "blondon_nodes",
      connector_label: "Breathe London Nodes",
    }],
  };
}

test("public latest snapshot reads only the canonical v2 object contract", async () => {
  const requestedKeys = [];
  const payload = snapshotPayload();
  const env = {
    UK_AQ_EDGE_UPSTREAM_SECRET: AUTH_SECRET,
    UK_AQ_HISTORY_BUCKET: {
      async get(key) {
        requestedKeys.push(key);
        return {
          body: JSON.stringify(payload),
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
    "latest_snapshots/v2/network_group=all/pollutant=no2/window=6h.json",
  ]);

  const body = await response.json();
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
