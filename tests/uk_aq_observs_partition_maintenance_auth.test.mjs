import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import test from "node:test";

import {
  DISPATCH_AUTH_HEADER,
  UPSTREAM_AUTH_HEADER,
  validateRunAuth,
} from "../workers/uk_aq_observs_partition_maintenance_service/run_auth.mjs";

function request(headers = {}) {
  return { headers };
}

const configuredEnv = {
  UK_AQ_EDGE_UPSTREAM_SECRET: "upstream-secret-value",
  UK_AQ_CLOUD_RUN_DISPATCH_SECRET: "dispatch-secret-value",
};

test("existing upstream authentication remains valid", () => {
  assert.deepEqual(
    validateRunAuth(request({ [UPSTREAM_AUTH_HEADER]: "upstream-secret-value" }), configuredEnv),
    { ok: true },
  );
  assert.equal(
    validateRunAuth(request({ [UPSTREAM_AUTH_HEADER]: "wrong-upstream-value" }), configuredEnv).status,
    403,
  );
  assert.equal(
    validateRunAuth(
      request({ [UPSTREAM_AUTH_HEADER]: "upstream-secret-value" }),
      { UK_AQ_CLOUD_RUN_DISPATCH_SECRET: "dispatch-secret-value" },
    ).status,
    403,
  );
});

test("Cloudflare dispatch authentication is independently valid", () => {
  assert.deepEqual(
    validateRunAuth(request({ [DISPATCH_AUTH_HEADER]: "dispatch-secret-value" }), configuredEnv),
    { ok: true },
  );
  assert.equal(
    validateRunAuth(request({ [DISPATCH_AUTH_HEADER]: "wrong-dispatch-value" }), configuredEnv).status,
    403,
  );
  assert.equal(
    validateRunAuth(
      request({ [DISPATCH_AUTH_HEADER]: "dispatch-secret-value" }),
      { UK_AQ_EDGE_UPSTREAM_SECRET: "upstream-secret-value" },
    ).status,
    403,
  );
});

test("either valid route is sufficient even when the other route is invalid", () => {
  assert.deepEqual(
    validateRunAuth(
      request({
        [UPSTREAM_AUTH_HEADER]: "wrong-upstream-value",
        [DISPATCH_AUTH_HEADER]: "dispatch-secret-value",
      }),
      configuredEnv,
    ),
    { ok: true },
  );
});

test("missing authentication is forbidden without exposing supplied values", () => {
  assert.deepEqual(validateRunAuth(request(), configuredEnv), {
    ok: false,
    status: 403,
    error: "Forbidden.",
  });

  const invalidValue = "must-not-appear";
  const result = validateRunAuth(
    request({ [DISPATCH_AUTH_HEADER]: invalidValue }),
    configuredEnv,
  );
  assert.equal(JSON.stringify(result).includes(invalidValue), false);
});

async function reservePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(url, child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`service exited before becoming healthy (${child.exitCode})`);
    }
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {
      // The child may still be binding its local port.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("service did not become healthy");
}

test("HTTP routing keeps health public and blocks invalid maintenance requests", async (t) => {
  const port = await reservePort();
  const output = [];
  const child = spawn(
    process.execPath,
    ["workers/uk_aq_observs_partition_maintenance_service/server.mjs"],
    {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        PORT: String(port),
        UK_AQ_EDGE_UPSTREAM_SECRET: "integration-upstream-secret",
        UK_AQ_CLOUD_RUN_DISPATCH_SECRET: "integration-dispatch-secret",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  t.after(() => child.kill("SIGTERM"));

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, child);

  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const getRun = await fetch(`${baseUrl}/run`);
  assert.equal(getRun.status, 405);

  const invalidValue = "integration-value-must-not-appear";
  const unauthorized = await fetch(`${baseUrl}/run`, {
    method: "POST",
    headers: { [DISPATCH_AUTH_HEADER]: invalidValue },
  });
  assert.equal(unauthorized.status, 403);
  const body = await unauthorized.text();
  assert.equal(body.includes(invalidValue), false);
  assert.equal(output.join("").includes(invalidValue), false);
});
