import { partitionRowsByExistingStations } from "./station_fk_guard.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test("missing station rows are skipped while valid rows continue", () => {
  const valid = { station_id: 101, timeseries_id: 1 };
  const missing = { station_id: 999, timeseries_id: 2 };
  const result = partitionRowsByExistingStations(
    [valid, missing],
    new Set([101]),
  );

  assertEquals(result.validRows, [valid]);
  assertEquals(result.skippedRows, [missing]);
  assertEquals(result.missingStationIds, [999]);
});

Deno.test("nullable station links remain eligible for RPC-side resolution", () => {
  const row = { station_id: null, timeseries_id: 1 };
  const result = partitionRowsByExistingStations([row], new Set());
  assertEquals(result.validRows, [row]);
  assertEquals(result.skippedRows, []);
});
