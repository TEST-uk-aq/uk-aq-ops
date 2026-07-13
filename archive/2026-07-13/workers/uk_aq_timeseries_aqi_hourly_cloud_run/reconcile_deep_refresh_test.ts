import {
  aggregateRefreshMetrics,
  buildDeepRefreshChunks,
  buildDeepRollingWindow,
  buildRecentWindow,
  deepHourlyUpsertBatchSize,
  DeepHourlyUpsertChunkError,
  DeepRefreshChunkError,
  deepRollingHourlyUpsertBatchSize,
} from "./reconcile_deep_refresh.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("24-hour deep window splits into four six-hour exclusive/inclusive chunks", () => {
  const chunks = buildDeepRefreshChunks({
    hourEndStartExclusive: new Date("2026-06-29T09:00:00Z"),
    hourEndEndInclusive: new Date("2026-06-30T09:00:00Z"),
  }, 6);
  assertEquals(
    chunks.map((chunk) => [
      chunk.hourEndStartExclusive.toISOString(),
      chunk.hourEndEndInclusive.toISOString(),
    ]),
    [
      ["2026-06-29T09:00:00.000Z", "2026-06-29T15:00:00.000Z"],
      ["2026-06-29T15:00:00.000Z", "2026-06-29T21:00:00.000Z"],
      ["2026-06-29T21:00:00.000Z", "2026-06-30T03:00:00.000Z"],
      ["2026-06-30T03:00:00.000Z", "2026-06-30T09:00:00.000Z"],
    ],
  );
});

Deno.test("uneven deep window produces a shorter final chunk", () => {
  const chunks = buildDeepRefreshChunks({
    hourEndStartExclusive: new Date("2026-06-29T19:00:00Z"),
    hourEndEndInclusive: new Date("2026-06-30T09:00:00Z"),
  }, 6);
  assertEquals(chunks.map((chunk) => chunk.hourEndEndInclusive.toISOString()), [
    "2026-06-30T01:00:00.000Z",
    "2026-06-30T07:00:00.000Z",
    "2026-06-30T09:00:00.000Z",
  ]);
});

Deno.test("refresh metrics sum counts and retain maximum lag", () => {
  assertEquals(
    aggregateRefreshMetrics([
      {
        source_rows: 10,
        rows_upserted: 8,
        timeseries_hours_changed: 6,
        max_changed_lag_hours: 4,
      },
      {
        source_rows: 20,
        rows_upserted: 12,
        timeseries_hours_changed: 9,
        max_changed_lag_hours: 7,
      },
    ]),
    {
      source_rows: 30,
      rows_upserted: 20,
      timeseries_hours_changed: 15,
      max_changed_lag_hours: 7,
    },
  );
});

Deno.test("failed chunk error exposes chunk metadata", () => {
  const full = {
    hourEndStartExclusive: new Date("2026-06-29T09:00:00Z"),
    hourEndEndInclusive: new Date("2026-06-30T09:00:00Z"),
  };
  const chunk = buildDeepRefreshChunks(full, 6)[1];
  const error = new DeepRefreshChunkError(
    full,
    chunk,
    2,
    4,
    "statement timeout",
  );
  assertEquals(error.chunkIndex, 2);
  assertEquals(error.chunkCount, 4);
  assertEquals(error.chunkStartUtc, "2026-06-29T15:00:00.000Z");
  assertEquals(error.chunkEndUtc, "2026-06-29T21:00:00.000Z");
  if (
    !error.message.includes(
      "helper upsert RPC failed for reconcile_deep chunk 2/4",
    )
  ) {
    throw new Error(`Unexpected error message: ${error.message}`);
  }
});

Deno.test("failed hourly upsert chunk error exposes chunk metadata", () => {
  const full = {
    hourEndStartExclusive: new Date("2026-06-29T09:00:00Z"),
    hourEndEndInclusive: new Date("2026-06-30T09:00:00Z"),
  };
  const chunk = buildDeepRefreshChunks(full, 6)[2];
  const error = new DeepHourlyUpsertChunkError(
    full,
    chunk,
    3,
    4,
    "statement timeout",
  );
  assertEquals(error.chunkIndex, 3);
  assertEquals(error.chunkCount, 4);
  assertEquals(error.chunkStartUtc, "2026-06-29T21:00:00.000Z");
  assertEquals(error.chunkEndUtc, "2026-06-30T03:00:00.000Z");
  if (
    !error.message.includes(
      "hourly upsert RPC failed for reconcile_deep chunk 3/4",
    )
  ) {
    throw new Error(`Unexpected error message: ${error.message}`);
  }
});

Deno.test("deep hourly upsert caps each RPC batch at 50 rows", () => {
  assertEquals(deepHourlyUpsertBatchSize(2000), 50);
  assertEquals(deepHourlyUpsertBatchSize(100), 50);
  assertEquals(deepHourlyUpsertBatchSize(25), 25);
});

Deno.test("rolling deep window covers 24 hours ago through 18 hours ago", () => {
  const window = buildDeepRollingWindow(
    new Date("2026-07-01T12:00:00Z"),
    24,
    6,
  );
  assertEquals(
    window.hourEndStartExclusive.toISOString(),
    "2026-06-30T12:00:00.000Z",
  );
  assertEquals(
    window.hourEndEndInclusive.toISOString(),
    "2026-06-30T18:00:00.000Z",
  );
  assertEquals(
    window.hourEndEndInclusive.getTime() -
      window.hourEndStartExclusive.getTime(),
    6 * 60 * 60 * 1000,
  );
});

Deno.test("rolling deep hourly upsert caps each RPC batch at 100 rows", () => {
  assertEquals(deepRollingHourlyUpsertBatchSize(2000), 100);
  assertEquals(deepRollingHourlyUpsertBatchSize(100), 100);
  assertEquals(deepRollingHourlyUpsertBatchSize(40), 40);
});

Deno.test("rolling deep chunk errors identify the rolling run mode", () => {
  const full = buildDeepRollingWindow(
    new Date("2026-07-01T12:00:00Z"),
    24,
    6,
  );
  const error = new DeepHourlyUpsertChunkError(
    full,
    full,
    1,
    1,
    "statement timeout",
    "reconcile_deep_rolling",
  );
  if (
    !error.message.includes(
      "hourly upsert RPC failed for reconcile_deep_rolling chunk 1/1",
    )
  ) {
    throw new Error(`Unexpected error message: ${error.message}`);
  }
});

Deno.test("existing recent-window modes retain their window behavior", () => {
  const reference = new Date("2026-07-01T12:00:00Z");
  assertEquals(
    [
      buildRecentWindow(reference, 1).hourEndStartExclusive.toISOString(),
      buildRecentWindow(reference, 1).hourEndEndInclusive.toISOString(),
    ],
    ["2026-07-01T11:00:00.000Z", "2026-07-01T12:00:00.000Z"],
  );
  assertEquals(
    buildRecentWindow(reference, 8).hourEndStartExclusive.toISOString(),
    "2026-07-01T04:00:00.000Z",
  );
  assertEquals(
    buildRecentWindow(reference, 24).hourEndStartExclusive.toISOString(),
    "2026-06-30T12:00:00.000Z",
  );
});
