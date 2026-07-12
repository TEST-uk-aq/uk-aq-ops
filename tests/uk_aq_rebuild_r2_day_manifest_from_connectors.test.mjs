import test from "node:test";
import assert from "node:assert/strict";
import { sha256Hex } from "../workers/shared/r2_sigv4.mjs";
import {
  buildDayManifestFromConnectorManifests,
  runDayManifestRebuild,
} from "../scripts/backup_r2/uk_aq_rebuild_r2_day_manifest_from_connectors.mjs";

function hashWithoutManifestHash(payload) {
  const { manifest_hash: _ignored, ...withoutHash } = payload;
  return sha256Hex(JSON.stringify(withoutHash));
}

function installFakeR2Fetch(objectsByKey, options = {}) {
  const originalFetch = globalThis.fetch;
  const puts = new Map();
  const liveBodyTransforms = options.liveBodyTransforms || new Map();

  function keyFromUrl(url) {
    const parsed = new URL(url);
    const path = decodeURIComponent(parsed.pathname).replace(/^\/+/, "");
    const slashIndex = path.indexOf("/");
    return slashIndex === -1 ? "" : path.slice(slashIndex + 1);
  }

  function encodeListObjectsXml(keys) {
    const contents = keys.map((key) => [
      "  <Contents>",
      `    <Key>${key}</Key>`,
      `    <Size>${key.length}</Size>`,
      "  </Contents>",
    ].join("\n"));
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<ListBucketResult>",
      ...contents,
      "</ListBucketResult>",
    ].join("\n");
  }

  globalThis.fetch = async (url, init = {}) => {
    const method = String(init.method || "GET").toUpperCase();
    const parsed = new URL(String(url));
    const isList = method === "GET" && parsed.searchParams.get("list-type") === "2";
    if (isList) {
      const prefix = parsed.searchParams.get("prefix") || "";
      const keys = Array.from(new Set([
        ...Object.keys(objectsByKey),
        ...Array.from(puts.keys()),
      ]))
        .filter((key) => key.startsWith(prefix))
        .sort((left, right) => left.localeCompare(right));
      return new Response(encodeListObjectsXml(keys), {
        status: 200,
        headers: { etag: `"list-${keys.length}"` },
      });
    }
    const key = keyFromUrl(String(url));
    if (method === "GET") {
      let body;
      if (puts.has(key)) {
        body = puts.get(key);
      } else if (Object.prototype.hasOwnProperty.call(objectsByKey, key)) {
        const value = objectsByKey[key];
        body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      } else {
        return new Response("not found", { status: 404 });
      }
      if (liveBodyTransforms.has(key)) {
        body = liveBodyTransforms.get(key)(body);
      }
      return new Response(body, {
        status: 200,
        headers: { etag: `"${key.length.toString(16)}"` },
      });
    }
    if (method === "HEAD") {
      return new Response(null, { status: 404 });
    }
    if (method === "PUT") {
      const bodyText = typeof init.body === "string"
        ? init.body
        : Buffer.from(init.body || "").toString("utf8");
      puts.set(key, bodyText);
      return new Response("", { status: 200, headers: { etag: `"put-${puts.size}"` } });
    }
    return new Response("unsupported", { status: 405 });
  };

  return {
    puts,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

test("buildDayManifestFromConnectorManifests rebuilds observations day manifest from connector manifests", () => {
  const existingDayManifest = {
    day_utc: "2026-04-30",
    connector_ids: [1],
    run_id: "existing-day-run",
    writer_git_sha: "abc123",
    backed_up_at_utc: "2026-05-20T20:00:20.000Z",
    manifest_hash: "old",
  };
  const connectorManifests = [
    {
      day_utc: "2026-04-30",
      connector_id: 7,
      run_id: "connector-run-7",
      manifest_key: "history/v1/observations/day_utc=2026-04-30/connector_id=7/manifest.json",
      source_row_count: 200,
      min_observed_at: "2026-04-30T00:05:00.000Z",
      max_observed_at: "2026-04-30T23:55:00.000Z",
      parquet_object_keys: ["history/v1/observations/day_utc=2026-04-30/connector_id=7/part-00000.parquet"],
      file_count: 1,
      total_bytes: 2000,
      files: [
        {
          key: "history/v1/observations/day_utc=2026-04-30/connector_id=7/part-00000.parquet",
          bytes: 2000,
          row_count: 200,
          etag_or_hash: "etag-7",
          min_timeseries_id: 701,
          max_timeseries_id: 799,
          min_observed_at: "2026-04-30T00:05:00.000Z",
          max_observed_at: "2026-04-30T23:55:00.000Z",
        },
      ],
      backed_up_at_utc: "2026-05-20T21:00:00.000Z",
    },
    {
      day_utc: "2026-04-30",
      connector_id: 3,
      run_id: "connector-run-3",
      manifest_key: "history/v1/observations/day_utc=2026-04-30/connector_id=3/manifest.json",
      source_row_count: 50,
      min_observed_at: "2026-04-30T01:00:00.000Z",
      max_observed_at: "2026-04-30T22:00:00.000Z",
      parquet_object_keys: ["history/v1/observations/day_utc=2026-04-30/connector_id=3/part-00000.parquet"],
      file_count: 1,
      total_bytes: 500,
      files: [
        {
          key: "history/v1/observations/day_utc=2026-04-30/connector_id=3/part-00000.parquet",
          bytes: 500,
          row_count: 50,
          etag_or_hash: "etag-3",
          min_timeseries_id: 301,
          max_timeseries_id: 399,
          min_observed_at: "2026-04-30T01:00:00.000Z",
          max_observed_at: "2026-04-30T22:00:00.000Z",
        },
      ],
      backed_up_at_utc: "2026-05-20T22:00:00.000Z",
    },
  ];

  const rebuilt = buildDayManifestFromConnectorManifests({
    domain: "observations",
    dayUtc: "2026-04-30",
    connectorManifests,
    existingDayManifest,
  });

  assert.deepEqual(rebuilt.connector_ids, [3, 7]);
  assert.equal(rebuilt.run_id, "existing-day-run");
  assert.equal(rebuilt.source_row_count, 250);
  assert.equal(rebuilt.file_count, 2);
  assert.equal(rebuilt.total_bytes, 2500);
  assert.equal(rebuilt.min_observed_at, "2026-04-30T00:05:00.000Z");
  assert.equal(rebuilt.max_observed_at, "2026-04-30T23:55:00.000Z");
  assert.equal(rebuilt.backed_up_at_utc, "2026-05-20T22:00:00.000Z");
  assert.deepEqual(rebuilt.parquet_object_keys, [
    "history/v1/observations/day_utc=2026-04-30/connector_id=3/part-00000.parquet",
    "history/v1/observations/day_utc=2026-04-30/connector_id=7/part-00000.parquet",
  ]);
  assert.deepEqual(rebuilt.connector_manifests, [
    {
      connector_id: 3,
      manifest_key: "history/v1/observations/day_utc=2026-04-30/connector_id=3/manifest.json",
      source_row_count: 50,
      file_count: 1,
      total_bytes: 500,
    },
    {
      connector_id: 7,
      manifest_key: "history/v1/observations/day_utc=2026-04-30/connector_id=7/manifest.json",
      source_row_count: 200,
      file_count: 1,
      total_bytes: 2000,
    },
  ]);
  assert.equal(rebuilt.history_schema_name, "observations");
  assert.equal(rebuilt.history_schema_version, 2);
  assert.equal(rebuilt.writer_version, "parquet-wasm-zstd-v2");
  assert.equal(rebuilt.writer_git_sha, "abc123");
  assert.equal(rebuilt.manifest_hash, hashWithoutManifestHash(rebuilt));
});

test("buildDayManifestFromConnectorManifests keeps aqilevels connector summary fields", () => {
  const rebuilt = buildDayManifestFromConnectorManifests({
    domain: "aqilevels",
    dayUtc: "2026-04-30",
    connectorManifests: [
      {
        day_utc: "2026-04-30",
        connector_id: 3,
        run_id: "shared-run",
        manifest_key: "history/v1/aqilevels/hourly/day_utc=2026-04-30/connector_id=3/manifest.json",
        source_row_count: 24,
        min_timeseries_id: 301,
        max_timeseries_id: 350,
        min_timestamp_hour_utc: "2026-04-30T00:00:00.000Z",
        max_timestamp_hour_utc: "2026-04-30T23:00:00.000Z",
        file_count: 1,
        total_bytes: 1200,
        available_pollutants: ["no2", "pm10"],
        files: [
          {
            key: "history/v1/aqilevels/hourly/day_utc=2026-04-30/connector_id=3/part-00000.parquet",
            bytes: 1200,
            row_count: 24,
            etag_or_hash: "etag-aqi-3",
            pollutant_codes: ["no2", "pm10"],
            min_timeseries_id: 301,
            max_timeseries_id: 350,
            min_timestamp_hour_utc: "2026-04-30T00:00:00.000Z",
            max_timestamp_hour_utc: "2026-04-30T23:00:00.000Z",
          },
        ],
        backed_up_at_utc: "2026-05-01T01:00:00.000Z",
      },
    ],
  });

  assert.deepEqual(rebuilt.connector_ids, [3]);
  assert.equal(rebuilt.run_id, "shared-run");
  assert.equal(rebuilt.min_timeseries_id, 301);
  assert.equal(rebuilt.max_timeseries_id, 350);
  assert.equal(rebuilt.min_timestamp_hour_utc, "2026-04-30T00:00:00.000Z");
  assert.equal(rebuilt.max_timestamp_hour_utc, "2026-04-30T23:00:00.000Z");
  assert.deepEqual(rebuilt.files[0].pollutant_codes, ["no2", "pm10"]);
  assert.deepEqual(rebuilt.connector_manifests, [
    {
      connector_id: 3,
      manifest_key: "history/v1/aqilevels/hourly/day_utc=2026-04-30/connector_id=3/manifest.json",
      source_row_count: 24,
      min_timeseries_id: 301,
      max_timeseries_id: 350,
      file_count: 1,
      total_bytes: 1200,
      available_pollutants: ["no2", "pm10"],
    },
  ]);
  assert.equal(rebuilt.grain, "hourly");
  assert.equal(rebuilt.history_schema_name, "aqilevels_hourly");
  assert.equal(rebuilt.history_schema_version, 1);
  assert.equal(rebuilt.writer_version, "parquet-wasm-zstd-v1");
  assert.deepEqual(rebuilt.available_pollutants, ["no2", "pm10"]);
  assert.equal(rebuilt.manifest_hash, hashWithoutManifestHash(rebuilt));
});

test("runDayManifestRebuild writes only the day manifest key and verifies the live object", async () => {
  const dayManifestKey = "history/v1/observations/day_utc=2026-04-30/manifest.json";
  const connectorManifest = {
    day_utc: "2026-04-30",
    connector_id: 7,
    run_id: "connector-run-7",
    manifest_key: "history/v1/observations/day_utc=2026-04-30/connector_id=7/manifest.json",
    source_row_count: 200,
    min_observed_at: "2026-04-30T00:05:00.000Z",
    max_observed_at: "2026-04-30T23:55:00.000Z",
    parquet_object_keys: [
      "history/v1/observations/day_utc=2026-04-30/connector_id=7/part-00000.parquet",
    ],
    file_count: 1,
    total_bytes: 2000,
    files: [
      {
        key: "history/v1/observations/day_utc=2026-04-30/connector_id=7/part-00000.parquet",
        bytes: 2000,
        row_count: 200,
        etag_or_hash: "etag-7",
        min_timeseries_id: 701,
        max_timeseries_id: 799,
        min_observed_at: "2026-04-30T00:05:00.000Z",
        max_observed_at: "2026-04-30T23:55:00.000Z",
      },
    ],
    backed_up_at_utc: "2026-05-20T21:00:00.000Z",
  };
  const fake = installFakeR2Fetch({
    "history/v1/observations/day_utc=2026-04-30/connector_id=7/manifest.json": connectorManifest,
    [dayManifestKey]: {
      day_utc: "2026-04-30",
      connector_ids: [7],
      run_id: "old-run",
      writer_git_sha: "old-sha",
      backed_up_at_utc: "2026-05-19T00:00:00.000Z",
      manifest_hash: "old-hash",
    },
  });
  try {
    const output = await runDayManifestRebuild({
      argv: [
        "--day-utc",
        "2026-04-30",
        "--connector-id",
        "7",
        "--write-r2",
      ],
      env: {
        CFLARE_R2_ENDPOINT: "https://r2.example.invalid",
        CFLARE_R2_BUCKET: "uk-aq-history-cic-test",
        CFLARE_R2_ACCESS_KEY_ID: "key",
        CFLARE_R2_SECRET_ACCESS_KEY: "secret",
      },
    });

    assert.equal(output.status, "succeeded");
    assert.equal(output.execution.status, "succeeded");
    assert.equal(output.verification.status, "succeeded");
    assert.equal(output.verification.fresh_remote_reads, true);
    assert.equal(fake.puts.size, 1);
    assert.deepEqual(Array.from(fake.puts.keys()), [dayManifestKey]);
  } finally {
    fake.restore();
  }
});

test("runDayManifestRebuild reports skipped_unchanged for identical day manifests", async () => {
  const dayManifestKey = "history/v1/observations/day_utc=2026-04-30/manifest.json";
  const connectorManifest = {
    day_utc: "2026-04-30",
    connector_id: 7,
    run_id: "connector-run-7",
    manifest_key: "history/v1/observations/day_utc=2026-04-30/connector_id=7/manifest.json",
    source_row_count: 200,
    min_observed_at: "2026-04-30T00:05:00.000Z",
    max_observed_at: "2026-04-30T23:55:00.000Z",
    parquet_object_keys: [
      "history/v1/observations/day_utc=2026-04-30/connector_id=7/part-00000.parquet",
    ],
    file_count: 1,
    total_bytes: 2000,
    files: [
      {
        key: "history/v1/observations/day_utc=2026-04-30/connector_id=7/part-00000.parquet",
        bytes: 2000,
        row_count: 200,
        etag_or_hash: "etag-7",
        min_timeseries_id: 701,
        max_timeseries_id: 799,
        min_observed_at: "2026-04-30T00:05:00.000Z",
        max_observed_at: "2026-04-30T23:55:00.000Z",
      },
    ],
    backed_up_at_utc: "2026-05-20T21:00:00.000Z",
  };
  const rebuilt = buildDayManifestFromConnectorManifests({
    domain: "observations",
    dayUtc: "2026-04-30",
    connectorManifests: [connectorManifest],
    existingDayManifest: {
      day_utc: "2026-04-30",
      connector_ids: [7],
      run_id: "old-run",
      writer_git_sha: "old-sha",
      backed_up_at_utc: "2026-05-19T00:00:00.000Z",
      manifest_hash: "old-hash",
    },
  });
  const fake = installFakeR2Fetch({
    "history/v1/observations/day_utc=2026-04-30/connector_id=7/manifest.json": connectorManifest,
    [dayManifestKey]: JSON.stringify(rebuilt, null, 2),
  });
  try {
    const output = await runDayManifestRebuild({
      argv: [
        "--day-utc",
        "2026-04-30",
        "--connector-id",
        "7",
        "--write-r2",
      ],
      env: {
        CFLARE_R2_ENDPOINT: "https://r2.example.invalid",
        CFLARE_R2_BUCKET: "uk-aq-history-cic-test",
        CFLARE_R2_ACCESS_KEY_ID: "key",
        CFLARE_R2_SECRET_ACCESS_KEY: "secret",
      },
    });

    assert.equal(output.status, "skipped_unchanged");
    assert.equal(output.execution.status, "skipped_unchanged");
    assert.equal(output.verification.status, "skipped_unchanged");
    assert.equal(fake.puts.size, 0);
  } finally {
    fake.restore();
  }
});

test("runDayManifestRebuild fails when live verification does not match the written body", async () => {
  const dayManifestKey = "history/v1/observations/day_utc=2026-04-30/manifest.json";
  const connectorManifest = {
    day_utc: "2026-04-30",
    connector_id: 7,
    run_id: "connector-run-7",
    manifest_key: "history/v1/observations/day_utc=2026-04-30/connector_id=7/manifest.json",
    source_row_count: 200,
    min_observed_at: "2026-04-30T00:05:00.000Z",
    max_observed_at: "2026-04-30T23:55:00.000Z",
    parquet_object_keys: [
      "history/v1/observations/day_utc=2026-04-30/connector_id=7/part-00000.parquet",
    ],
    file_count: 1,
    total_bytes: 2000,
    files: [
      {
        key: "history/v1/observations/day_utc=2026-04-30/connector_id=7/part-00000.parquet",
        bytes: 2000,
        row_count: 200,
        etag_or_hash: "etag-7",
        min_timeseries_id: 701,
        max_timeseries_id: 799,
        min_observed_at: "2026-04-30T00:05:00.000Z",
        max_observed_at: "2026-04-30T23:55:00.000Z",
      },
    ],
    backed_up_at_utc: "2026-05-20T21:00:00.000Z",
  };
  const fake = installFakeR2Fetch(
    {
      "history/v1/observations/day_utc=2026-04-30/connector_id=7/manifest.json": connectorManifest,
    },
    {
      liveBodyTransforms: new Map([
        [dayManifestKey, (body) => `${body}\n`],
      ]),
    },
  );
  try {
    await assert.rejects(
      runDayManifestRebuild({
        argv: [
          "--day-utc",
          "2026-04-30",
          "--connector-id",
          "7",
          "--write-r2",
        ],
        env: {
          CFLARE_R2_ENDPOINT: "https://r2.example.invalid",
          CFLARE_R2_BUCKET: "uk-aq-history-cic-test",
          CFLARE_R2_ACCESS_KEY_ID: "key",
          CFLARE_R2_SECRET_ACCESS_KEY: "secret",
        },
      }),
      /R2 verification failed for history\/v1\/observations\/day_utc=2026-04-30\/manifest\.json/,
    );
    assert.equal(fake.puts.size, 1);
  } finally {
    fake.restore();
  }
});
