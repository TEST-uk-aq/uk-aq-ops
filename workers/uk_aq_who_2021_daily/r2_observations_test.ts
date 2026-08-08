import { assertEquals, assertRejects } from "jsr:@std/assert";
import { R2ObjectNotFoundError } from "./r2_objects.ts";
import {
  isAbsentR2ObservationDayManifest,
  prepareWhoDailyRowsFromR2,
  r2ObservationDayManifestKey,
} from "./r2_observations.ts";

Deno.test("only the probed top-level day manifest is source-unavailable", () => {
  const dayUtc = "2026-08-04";
  assertEquals(
    isAbsentR2ObservationDayManifest(
      new R2ObjectNotFoundError(r2ObservationDayManifestKey(dayUtc)),
      dayUtc,
    ),
    true,
  );
  assertEquals(
    isAbsentR2ObservationDayManifest(
      new R2ObjectNotFoundError(
        `history/v2/observations/day_utc=${dayUtc}/connector_id=1/manifest.json`,
      ),
      dayUtc,
    ),
    false,
  );
});

Deno.test("mixed-source boundary rows must be exact next-day midnight", async () => {
  await assertRejects(
    () =>
      prepareWhoDailyRowsFromR2({
        readObject: () => {
          throw new Error("R2 should not be read for an invalid boundary row");
        },
        dayUtc: "2026-08-03",
        connectorId: 1,
        pollutantCodes: ["pm25", "pm10", "no2"],
        minValidHoursPerDay: 18,
        boundaryRows: [{
          connectorId: 1,
          stationId: 1,
          timeseriesId: 1,
          pollutantCode: "pm25",
          observedAtUtc: "2026-08-04T01:00:00.000Z",
          value: 5,
        }],
      }),
    Error,
    "Invalid Obs AQI DB boundary row",
  );
});
