# 2026-07-22 Calculated AQI chart and R2 validation plan

## Status

Planned for the UK AQ TEST system.

## Recommended Codex model

Use **GPT-5.6 Codex with High reasoning** for implementation.

## Repositories

Primary planning and Worker repository:

- `TEST-uk-aq/uk-aq-ops`

Website implementation repository:

- `TEST-uk-aq/TEST-uk-aq-root.github.io`

Start in `TEST-uk-aq/uk-aq-ops` to establish the current station-history, R2 and AQI contracts before changing the website consumer.

## Purpose

Make station line charts render AQI bands faster by calculating historical DAQI and EAQI from the same observation rows used to draw the concentration line, instead of making the browser wait for a separate R2 `aqilevels` request.

Continue to use the stored R2 `aqilevels` rows as an independent validation source. The R2 comparison must happen after the calculated chart response has been returned, so it cannot delay chart rendering.

The validation must identify any mismatch between:

- AQI calculated from the observation rows used by the chart; and
- the corresponding immutable AQI rows already stored in R2.

## Current position

The current station-history Worker already imports the shared AQI calculation code from `lib/aqi/aqi_levels.mjs` and calculates AQI from recent observation rows when needed.

The historical chart path still treats observations and R2 AQI as separate progressive data streams. The browser can therefore wait for both observation chunks and AQI chunks before the complete chart is available.

Supabase no longer stores `aqilevels`. This plan must not recreate AQI-level storage in Supabase.

## Core design decisions

1. **The shared AQI helper remains authoritative**
   - Reuse `lib/aqi/aqi_levels.mjs`.
   - Do not copy the AQI algorithm into browser code.
   - The same calculation module must remain responsible for recent Supabase observations and archived R2 observations.

2. **Observation responses carry calculated AQI**
   - Each station-history observation response or history chunk should include both:
     - the observation rows needed for the line; and
     - AQI rows calculated from those observations.
   - The browser should not need a separate blocking R2 AQI request during normal chart rendering.

3. **R2 AQI becomes a validation source, not the normal render source**
   - Stored R2 `aqilevels` remain useful because they provide an independently materialised result.
   - The normal visible chart should use the calculated AQI returned with the observation response.
   - A later R2 validation result must not replace or redraw an already rendered chart.

4. **Validation runs outside the response path**
   - Use the Cloudflare Worker execution context, normally `ctx.waitUntil(...)`, to perform the R2 AQI comparison after returning the response.
   - A validation timeout, R2 error or mismatch must not make the chart request fail.

5. **Only stable immutable hours are compared**
   - Do not compare mutable recent hours where R2 can legitimately lag, be incomplete or be awaiting a later integrity correction.
   - Derive the comparable range from actual R2 coverage and completeness information, not from a guessed retention date alone.

6. **No new AQI row store**
   - Do not send every calculated AQI row to Supabase or another replacement AQI database.
   - Initially record validation summaries and mismatch details in Worker logs only.
   - Durable mismatch storage is outside this plan and should only be considered later if TEST operation shows that logs are insufficient.

7. **Feature flags must allow immediate rollback**
   - The existing separate R2 AQI path must remain available while the new path is tested.
   - Switching the new calculated-history path off must restore the previous behaviour without a code rollback.

## Required invariants

The implementation must preserve all existing station-history and AQI behaviour unless this plan explicitly changes it.

- AQI identity remains based on the authoritative `connector_id`, `timeseries_id`, `pollutant_code` and canonical AQI hour endpoint.
- Existing AQI hour interval semantics must remain unchanged. Do not reintroduce a period-start/period-end shift.
- PM2.5 and PM10 DAQI calculations must receive the required preceding 23 hours of context for the first requested output hour.
- Context observations may be used for calculation but must not be returned as visible points outside the requested chart interval.
- NO2 DAQI remains hourly rather than rolling 24-hour.
- EAQI and DAQI remain independently calculable. Missing rolling context for PM DAQI must not suppress a valid EAQI value.
- Negative sentinel values and otherwise invalid observations must continue to be excluded using the shared AQI rules.
- Existing station and timeseries identity checks must remain fail-closed.
- Existing R2 AQI files and indexes must not be modified by chart requests or validation.
- Validation must never repair, overwrite or delete data automatically.
- The browser must not silently mix old cached AQI rows with the new calculated-response contract.

## Target response shape

Extend the existing station-history observation response or chunk response so that one request can return both data types. Preserve existing fields where possible and add a clearly versioned AQI section rather than inventing an unrelated second browser API.

Conceptual response shape:

```json
{
  "schema_version": 2,
  "request": {
    "connector_id": 1,
    "timeseries_id": 360,
    "pollutant": "pm25",
    "start_utc": "2026-07-01T00:00:00.000Z",
    "end_utc": "2026-07-08T00:00:00.000Z"
  },
  "observations": {
    "rows": [],
    "response_complete": true,
    "source_counts": {
      "r2": 168,
      "ingest": 0
    }
  },
  "aqi": {
    "enabled": true,
    "calculation_source": "calculated_from_observations",
    "algorithm_version": "aqilevels_hourly_v1",
    "rows": [],
    "response_complete": true,
    "required_context_start_utc": "2026-06-30T01:00:00.000Z",
    "output_start_utc": "2026-07-01T00:00:00.000Z",
    "output_end_utc": "2026-07-08T00:00:00.000Z"
  }
}
```

The exact response contract must be aligned with the existing station-history contract and current browser normalisation before implementation.

## Validation comparison contract

Use the existing canonical AQI row key and deterministic ordering.

### Identity fields

A row is comparable only when all of these agree:

- `connector_id`
- `timeseries_id`
- `pollutant_code`
- canonical AQI hour endpoint

### Exact comparison fields

Compare these discrete fields exactly:

- `daqi_index_level`
- `eaqi_index_level`
- `daqi_calculation_status`
- `eaqi_calculation_status`
- `daqi_missing_reason`
- `eaqi_missing_reason`
- `daqi_input_averaging_code`
- `eaqi_input_averaging_code`
- `daqi_source_observation_count`
- `daqi_required_observation_count`
- `eaqi_source_observation_count`
- `eaqi_required_observation_count`
- `hourly_sample_count`

### Numeric comparison fields

Compare these using a small explicit tolerance that only permits storage serialisation noise:

- `daqi_input_value_ugm3`
- `eaqi_input_value_ugm3`

Use `0.000001 µg/m³` as the provisional maximum tolerance unless inspection of the current Parquet writer proves that a smaller exact tolerance is appropriate. Record the actual numeric difference in mismatch diagnostics.

### Algorithm version

- Compare `algorithm_version` before comparing values.
- If the versions differ, report the row or range as `not_comparable_algorithm_version`.
- Do not report an ordinary AQI mismatch when the stored row was produced by a different algorithm version.

### Coverage differences

Record separately:

- rows present in calculated output but missing from R2 AQI;
- rows present in R2 AQI but missing from calculated output;
- rows present in both but with different values;
- rows excluded because the range was mutable or incomplete;
- rows excluded because the algorithm versions differed.

## Validation logging

Emit one bounded summary event per validated chunk, for example:

```json
{
  "event": "station_history_aqi_validation",
  "connector_id": 1,
  "timeseries_id": 360,
  "pollutant_code": "pm25",
  "start_utc": "2026-07-01T00:00:00.000Z",
  "end_utc": "2026-07-08T00:00:00.000Z",
  "algorithm_version": "aqilevels_hourly_v1",
  "calculated_row_count": 168,
  "r2_row_count": 168,
  "overlap_count": 168,
  "mismatch_count": 0,
  "missing_in_r2_count": 0,
  "missing_in_calculated_count": 0,
  "not_comparable_count": 0,
  "status": "match"
}
```

When mismatches exist, emit a second bounded diagnostic event containing:

- mismatch count;
- a limited list of mismatch hours;
- calculated and stored index levels;
- calculated and stored input values;
- calculated and stored statuses;
- algorithm versions;
- the relevant source and coverage metadata.

Do not log the complete observation history or unbounded row payloads.

## Configuration

Add explicit TEST-safe configuration. Final names may be adjusted to match current conventions, but they should cover these behaviours:

```text
UK_AQ_STATION_HISTORY_CALCULATED_HISTORY_AQI_ENABLED
UK_AQ_STATION_HISTORY_AQI_VALIDATION_MODE
UK_AQ_STATION_HISTORY_AQI_VALIDATION_SAMPLE_PERCENT
```

Recommended modes:

```text
off
all
sample
```

Initial TEST values after deployment:

```text
UK_AQ_STATION_HISTORY_CALCULATED_HISTORY_AQI_ENABLED=true
UK_AQ_STATION_HISTORY_AQI_VALIDATION_MODE=all
UK_AQ_STATION_HISTORY_AQI_VALIDATION_SAMPLE_PERCENT=100
```

Do not enable this automatically in LIVE as part of this plan.

## Phase 0: targeted structural inspection

Before editing code, inspect only what is needed to confirm the design is structurally viable.

1. Read the current station-history Worker request handler and confirm that its fetch entry point receives a Cloudflare execution context supporting `waitUntil`.
2. Trace the current recent-head and historical observation chunk routes.
3. Confirm where the browser currently makes separate observation and AQI chunk requests.
4. Confirm the exact observation context available for PM rolling calculations.
5. Confirm the R2 AQI endpoint can query the same exact immutable chunk by connector, timeseries, pollutant and time range.
6. Confirm current R2 AQI rows expose `algorithm_version` and the comparison fields listed above.
7. Confirm the current cache-proxy and Service Binding path permits the station-history Worker background task to finish after the foreground response is returned.
8. Identify every active website consumer of `station-history-loader.js` before changing its response contract.

This is the one genuinely necessary pre-implementation targeted check. Do not add a speculative test programme.

## Phase 1: calculate AQI for historical observation chunks

Repository: `TEST-uk-aq/uk-aq-ops`

1. Reuse the existing shared AQI helper functions from `lib/aqi/aqi_levels.mjs`.
2. Add or extract a focused Worker helper that:
   - accepts authoritative normalised observation rows;
   - receives the requested output interval;
   - includes the preceding 23 hours for PM2.5 and PM10;
   - calculates deterministic normalised AQI rows;
   - returns only AQI endpoints inside the requested output interval;
   - preserves DAQI and EAQI status and missing-reason fields;
   - attaches the existing `AQI_ALGORITHM_VERSION`.
3. Use deterministic observation sorting and deduplication before calculation so R2 and recent observation paths behave identically.
4. Preserve the existing recent Supabase calculation behaviour.
5. Add a distinct source label for AQI calculated from archived R2 observations if the current source contract requires the distinction, while keeping existing consumers compatible.
6. Do not read stored R2 AQI in the foreground when the new calculated-history flag is enabled and the observation response is complete enough to calculate the requested rows.

Likely active files include:

```text
workers/uk_aq_station_history/src/index.mjs
workers/uk_aq_station_history/src/history_chunks.mjs
workers/uk_aq_station_history/src/stable_head.mjs
lib/aqi/aqi_levels.mjs
```

Do not change the shared AQI algorithm unless inspection finds an existing correctness defect unrelated to this optimisation. Any such defect must be reported separately rather than silently bundled into this work.

## Phase 2: return observations and calculated AQI together

Repository: `TEST-uk-aq/uk-aq-ops`

1. Extend the existing station-history observation/chunk response rather than creating an unnecessary parallel public route.
2. Include a versioned `aqi` section with:
   - calculated rows;
   - calculation source;
   - algorithm version;
   - required context start;
   - output interval;
   - completeness status;
   - gap ranges;
   - source counts.
3. Preserve existing observation response fields.
4. Keep the old separate R2 AQI history path available while the new feature flag is disabled.
5. Ensure an incomplete observation response cannot claim complete calculated AQI coverage.
6. Do not hide valid hourly EAQI merely because rolling PM DAQI lacks sufficient context.
7. Return the foreground response before starting the validation fetch.

## Phase 3: add the non-blocking R2 AQI validator

Repository: `TEST-uk-aq/uk-aq-ops`

1. Add a small focused validation module, preferably separate from the response-building code.
2. After the foreground response has been prepared, schedule validation through `ctx.waitUntil(...)`.
3. Limit validation to the exact immutable output range with complete observation and R2 AQI coverage.
4. Fetch the matching stored R2 AQI rows using the existing private R2 AQI API and upstream authentication.
5. Compare calculated and stored rows using the validation comparison contract above.
6. Emit the bounded summary and mismatch events.
7. Catch and log validation errors without altering the already returned chart response.
8. Do not retry repeatedly inside one request. A later real chart request can perform another comparison.
9. Do not write corrections or replacement rows.
10. Keep validation controlled independently from calculated chart rendering so either feature can be disabled separately.

A likely new file is:

```text
workers/uk_aq_station_history/src/aqi_validation.mjs
```

Use a different filename if current module ownership indicates a better home.

## Phase 4: update the browser progressive loader

Repository: `TEST-uk-aq/TEST-uk-aq-root.github.io`

1. Update the active station-history chart consumers to request the combined observation-plus-calculated-AQI response.
2. Render observation points as soon as the combined chunk arrives.
3. Merge the returned calculated AQI points into the existing AQI band cache using the canonical hour endpoint.
4. Stop issuing the separate normal R2 AQI chunk request when the combined response contract is present and enabled.
5. Keep a compatibility fallback to the existing separate AQI path when:
   - the feature is disabled;
   - an older Worker response is received; or
   - the combined AQI section is unavailable.
6. Do not wait for the background validation result.
7. Do not redraw or replace the visible AQI bands when validation finishes.
8. Bump the station-history browser cache contract and local-storage key so old separately sourced AQI entries cannot be mistaken for the new calculated response.
9. Preserve the existing progressive newest-to-oldest rendering order, abort behaviour, coverage tracking and stale fallback behaviour.
10. Confirm all active chart pages that use `station-history-loader.js` are updated consistently.

Likely active files include:

```text
station-history-loader.js
hex_map/index.html
```

Codex must discover the remaining active consumers rather than assuming these are the only files.

## Phase 5: configuration and deployment wiring

Repository: `TEST-uk-aq/uk-aq-ops`

1. Add the new variables to the station-history deployment workflow and any cache-proxy configuration that passes station-history feature settings.
2. Keep safe defaults disabled in repository configuration unless current TEST conventions explicitly require enabled defaults.
3. Ensure the station-history Worker can access the existing private R2 AQI endpoint and upstream secret for background validation.
4. Do not add new public routes.
5. Do not add a database migration.
6. Do not run an AQI backfill.
7. Do not change existing R2 files or indexes.

Deploy in this order:

1. `uk-aq-station-history` Worker with the backward-compatible combined response available but disabled.
2. Cache proxy only if its binding or configuration must change.
3. TEST website consumer with fallback support.
4. Enable calculated historical AQI in TEST.
5. Enable validation mode `all` in TEST.

## Phase 6: system documentation handover

Codex must not edit `system_docs/`.

After implementation, Codex must provide ChatGPT with a concise handover containing:

- implemented behaviour;
- exact files changed in each repository;
- final response contract;
- feature-variable names and defaults;
- AQI source and authority rules;
- immutable validation boundary;
- algorithm-version handling;
- validation log event names and fields;
- deployment steps;
- structural checks run;
- TEST operational result.

ChatGPT in Chat mode will then update the relevant station-history, website chart, R2 history and AQI system documentation.

The documentation must make clear that:

- visible historical AQI is calculated from the same observations used for the chart;
- stored R2 AQI is retained as a validation artefact;
- validation is non-blocking and never changes the rendered chart;
- no AQI rows are stored in Supabase;
- the shared AQI helper and its algorithm version remain authoritative.

## Minimal pre-deployment validation

This is a TEST-system change. Perform only the smallest checks needed to establish structural viability.

1. Run syntax checking for each changed `.mjs` or browser JavaScript file.
2. Run a Cloudflare Worker dry-run/build check for the changed station-history Worker.
3. Confirm the deployment workflow parses after adding the new variables.
4. Confirm the website files still parse and reference the active non-archive paths.
5. Do not create a broad new test suite.
6. Do not perform a large local R2 comparison or synthetic shadow run before deployment.

A single existing focused check may be run only if it is already present and directly validates the changed response parser or canonical AQI comparator. Do not expand the work to add general test coverage.

## TEST operational validation after deployment

Functional validation should happen through real operation on the TEST system.

1. Open one PM2.5 station chart with a range that crosses:
   - immutable R2 history; and
   - the recent Supabase/R2 seam.
2. Confirm the observation line and AQI bands progressively render without waiting for a separate foreground R2 AQI request.
3. Confirm the browser network activity shows the combined response path and no normal blocking historical AQI request for that chunk.
4. Inspect the corresponding Worker log event.
5. Expected validation result:

```text
status=match
mismatch_count=0
missing_in_r2_count=0
missing_in_calculated_count=0
not_comparable_count=0
```

6. Confirm the first displayed PM AQI hour used the required preceding rolling context.
7. Confirm AQI band endpoints remain aligned with their represented hourly intervals.
8. One successful normal PM2.5 operation and one matching validation event are sufficient for initial TEST acceptance.
9. Allow normal TEST usage to exercise NO2 and PM10 rather than adding a broad manual test programme.

If a systematic mismatch appears:

1. Leave R2 and Supabase data unchanged.
2. Disable calculated historical AQI through the feature flag.
3. Return the website to the existing separate R2 AQI path.
4. Compare source observations, context range, hour endpoint, algorithm version and stored R2 row before making any correction.

## Acceptance criteria

The plan is complete when all of the following are true in TEST:

- historical chart responses calculate AQI from the same observations used for the concentration line;
- the browser can render those AQI bands without a separate blocking R2 AQI fetch;
- PM rolling context is complete and hour alignment is unchanged;
- stored R2 AQI is compared asynchronously for immutable overlapping hours;
- matching comparisons produce bounded `status=match` diagnostics;
- mismatches identify exact hours and fields without altering visible data;
- validation errors do not fail chart requests;
- no AQI-level rows are recreated in Supabase;
- no R2 data is rewritten;
- the old rendering path can be restored using feature flags;
- ChatGPT has updated the relevant `system_docs/` from the implementation handover.

## Rollback

Rollback should normally require configuration only:

```text
UK_AQ_STATION_HISTORY_CALCULATED_HISTORY_AQI_ENABLED=false
UK_AQ_STATION_HISTORY_AQI_VALIDATION_MODE=off
```

The browser must then use the retained compatibility path for separate R2 AQI history.

If the website cache contract was enabled and needs to be reverted, restore the previous website deployment or change the website feature selection while leaving the backward-compatible Worker response available.

No database, R2 or backfill rollback should be required because this plan does not modify stored AQI or observation data.
