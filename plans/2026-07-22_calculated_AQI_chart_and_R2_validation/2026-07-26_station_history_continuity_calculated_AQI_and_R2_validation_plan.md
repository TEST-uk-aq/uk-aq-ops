# 2026-07-26 Station-history continuity, calculated AQI chart and R2 validation plan

## Status

Planned for the UK AQ TEST system.

This plan supersedes the implementation sequence in:

```text
plans/2026-07-22_calculated_AQI_chart_and_R2_validation/2026-07-22_calculated_AQI_chart_and_R2_validation_plan.md
```

The earlier plan remains useful as the original calculated-AQI and R2-validation design record. This plan incorporates that work and adds date-valid SOS station/timeseries continuity, website compatibility and integrity repair safety.

## Recommended Codex model

Use **GPT-5.6 Codex with High reasoning** for all Codex phases.

## Repositories

Primary planning, Worker and integrity repository:

- `TEST-uk-aq/uk-aq-ops`

Canonical schema repository:

- `TEST-uk-aq/uk-aq-schema`

Website repository:

- `TEST-uk-aq/TEST-uk-aq-root.github.io`

Start in `TEST-uk-aq/uk-aq-ops`. Read that repository's instructions and active system contracts first, then inspect the related instructions and contracts in the schema and website repositories before editing them.

## Codex operating boundary

Phases 0 to 8 are one code-only Codex implementation sequence. Codex should complete all structurally viable implementation phases together rather than stopping after each phase for deployment or operational testing.

Codex must:

1. Read each repository's `AGENTS.md`, any linked `AGENTS_BASE.md`, and all relevant active `system_docs/` files before editing.
2. Treat active `system_docs/` as authoritative and report any conflict before changing code.
3. Follow the repository archive rules for active non-test implementation code.
4. Use `grep`, not `rg`, for searches.
5. Make the smallest coherent cross-repository implementation that satisfies this plan.
6. Run only the minimal fast local structural checks listed in Phase 8.
7. Provide exact manual schema, deployment, configuration, integrity-run and rollback commands for the user.
8. Provide a concise system-documentation handover for ChatGPT.

Codex must not:

- create, amend, stage or modify Git commits;
- push branches or open pull requests;
- run SQL against TEST or LIVE Supabase;
- apply migrations;
- deploy Workers, websites or workflows;
- change Cloudflare, R2, Supabase or GitHub settings;
- run integrity, backfills, reconciliations or bulk jobs;
- write, move, rename or delete anything under `system_docs/`;
- edit any LIVE repository;
- add a broad or speculative test suite.

Use Level 1, code only. Where deployment or database work is needed, prepare the files and exact commands but do not execute them.

## Purpose

Implement a stable logical station-history identity so the website can continue requesting one current `timeseries_id` while the station-history Worker automatically retrieves the correct historical station and timeseries identities for each date.

At the same time:

1. Calculate historical DAQI and EAQI from the same observation rows used to draw the concentration line.
2. Return observations and calculated AQI in one station-history response so visible AQI bands do not wait for a separate foreground R2 AQI request.
3. Retain stored R2 `aqilevels` as an independent, non-blocking validation source.
4. Keep R2 observations and AQI historically accurate under the physical `station_id` and `timeseries_id` valid for each date.
5. Allow integrity to recognise and eventually repair historical identity rollover mismatches without breaking website history.

## Problem being solved

A physical SOS station/timeseries identity can change while the UK-AIR monitoring site and pollutant remain logically continuous.

Example for BPLE PM2.5:

```text
Logical site:
site_ref=BPLE
uk_air_ref=UKA00574
pollutant_code=pm25

Historical physical identity:
station_id=248
station_ref=3916
timeseries_id=285
timeseries_ref=97
valid_from_day_utc=2013-11-14
valid_to_day_utc=2026-05-17

Current physical identity:
station_id=7479
station_ref=10539
timeseries_id=212
timeseries_ref=1965
valid_from_day_utc=2026-05-18
valid_to_day_utc=NULL
```

For `2026-01-01`, source evidence correctly maps BPLE PM2.5 to timeseries `285`. Existing R2 observations appear to contain timeseries `212` for that date.

Changing the historical R2 rows to `285` is historically correct, but the current website requests only the current ID `212`. The current APIs filter R2 by that exact ID and do not discover predecessor identities. A repair performed before continuity support is deployed would therefore make older history disappear from the chart.

## Existing bridge and authority

The existing table:

```text
uk_aq_raw.sos_station_timeseries_site_refs
```

contains:

```text
site_ref
uk_air_ref
pollutant_code
station_id
station_ref
timeseries_id
timeseries_ref
valid_from_day_utc
valid_to_day_utc
match_method
source_snapshot_at
raw_payload
```

The mapping is derived in two stages:

1. The latest UK-AIR AURN register supplies `uk_air_ref`, `site_ref`, site identity, dates and location evidence.
2. UK AQ matches that site to SOS stations, then joins the station to canonical pollutant/timeseries rows and sequences historical and current identities using validity dates and `timeseries.ended_at`.

There is no single official external cross-reference directly mapping UK-AIR ID to UK AQ `station_id` or `timeseries_id`. The existing bridge is the system's derived authoritative mapping and retains its provenance through match methods, source snapshots and internal references.

The implementation must preserve that provenance and fail closed on ambiguous or internally inconsistent continuity data.

## Three identity levels

The implementation must explicitly distinguish three identities.

### Request identity

The current active timeseries selected by the website, for example:

```text
timeseries_id=212
connector_id=1
pollutant=pm25
```

This remains the only identity the website needs to send.

### Logical continuity identity

The stable site/pollutant family used to render one continuous chart.

Preferred key inputs:

```text
connector_id + uk_air_ref + pollutant_code
```

Example:

```text
1:UKA00574:pm25
```

`site_ref` must be retained and validated as corroborating identity. If one logical family unexpectedly contains conflicting non-null `site_ref` values, the resolver must fail closed rather than silently combining them.

### Physical identity

The date-valid R2 identity:

```text
station_id
station_ref
timeseries_id
timeseries_ref
valid_from_day_utc
valid_to_day_utc
```

R2 observations, stored R2 AQI and indexes must continue to use this physical identity. Historical provenance must not be rewritten to the current ID merely to simplify API reads.

## Core design decisions

### 1. Create a separate service-only continuity view

Do not join continuity rows into the existing public `timeseries` view. That view represents one physical timeseries row and existing consumers may rely on one row per `timeseries.id`.

Create a dedicated read-only view, with a final name aligned to repository conventions. Preferred conceptual name:

```text
uk_aq_public.uk_aq_timeseries_continuity
```

The view should expose one row per physical continuity member and include at least:

```text
connector_id
continuity_key
site_ref
uk_air_ref
pollutant_code
station_id
station_ref
timeseries_id
timeseries_ref
valid_from_day_utc
valid_to_day_utc
is_current
station_match_method
station_match_distance_m
timeseries_match_method
source_snapshot_at
```

The view must:

- use `security_invoker = true` where supported by the current Postgres version and repository conventions;
- be readable by the station-history service role only;
- not be granted to `anon` or `authenticated`;
- expose no unnecessary raw payload;
- use the canonical raw bridge and core connector/station/timeseries data;
- remain a plain view unless inspection proves a materialised form is required;
- preserve one deterministic continuity key per connector, UK-AIR identity and pollutant;
- expose enough match provenance for bounded diagnostics.

Codex must inspect current Data API schema exposure and grants before finalising the DDL. Do not solve access by creating an unnecessarily broad `SECURITY DEFINER` public view or by granting public access to `uk_aq_raw`.

### 2. Keep the website continuity-unaware

The website continues to request one current `timeseries_id`.

It must not:

- query the continuity view directly;
- discover predecessor IDs;
- issue one request per historical identity;
- contain SOS-specific identity logic.

Continuity resolution belongs in the station-history Worker.

### 3. Keep low-level R2 APIs physically exact

The low-level observations and AQI R2 APIs should continue accepting an exact physical:

```text
connector_id + timeseries_id + pollutant + time range
```

They should not silently reinterpret one timeseries ID as a logical family and should not independently call Supabase for continuity.

The station-history Worker should orchestrate multiple exact physical requests when a logical request crosses a continuity boundary.

This preserves deterministic R2 APIs, avoids duplicated resolver logic and keeps the low-level readers useful for diagnostics and integrity verification.

### 4. Calculate visible AQI from the logical observation stream

The shared AQI helper in:

```text
lib/aqi/aqi_levels.mjs
```

remains authoritative.

The station-history Worker must:

1. Retrieve all physical observation segments required by the logical range.
2. Include the preceding 23 hours required for PM rolling calculations, even when that context crosses a physical timeseries transition.
3. Validate and merge the observations into one deterministic logical stream.
4. Calculate DAQI and EAQI from that stream.
5. Return only visible observations and AQI endpoints inside the requested output range.
6. Preserve the physical identity valid for each returned observation and calculated AQI hour.

Do not copy the AQI algorithm into the browser.

### 5. Use stored R2 AQI only as non-blocking validation

Stored R2 `aqilevels` remain an independent materialised result.

When calculated historical AQI is enabled:

- the visible chart uses AQI calculated from the observations returned for the line;
- the foreground response does not wait for a separate stored R2 AQI read;
- validation runs later through Cloudflare execution context, normally `ctx.waitUntil(...)`;
- validation failures or mismatches never fail or redraw the chart;
- validation never repairs, overwrites or deletes data.

### 6. Preserve feature-flag rollback

The old separate foreground R2 AQI path must remain available during TEST rollout.

Final configuration names may follow current conventions, but the implementation must provide controls equivalent to:

```text
UK_AQ_STATION_HISTORY_CONTINUITY_ENABLED
UK_AQ_STATION_HISTORY_CALCULATED_HISTORY_AQI_ENABLED
UK_AQ_STATION_HISTORY_AQI_VALIDATION_MODE
UK_AQ_STATION_HISTORY_AQI_VALIDATION_SAMPLE_PERCENT
```

Recommended validation modes:

```text
off
all
sample
```

Repository defaults should remain safe and disabled unless current TEST configuration conventions require otherwise.

### 7. Gate historical identity repair until API support is deployed

Integrity must distinguish:

```text
bridge-known historical identity rollover
ordinary source/R2 row mismatch
genuinely unknown R2 timeseries identity
```

A bridge-known rollover must not be misclassified as unavailable source mapping.

However, execution of a rollover repair must remain disabled by default until continuity-aware station history and website compatibility are deployed and operationally confirmed.

Use a clear integrity feature flag or explicit CLI option, following current conventions, equivalent to:

```text
UK_AQ_INTEGRITY_HISTORICAL_IDENTITY_REPAIR_ENABLED=false
```

Do not weaken fail-closed handling for genuinely unknown or ambiguous mappings.

## Required invariants

The implementation must preserve these behaviours unless this plan explicitly changes them.

### Identity and continuity

- The website request identity remains the current active timeseries selected from the latest-data API.
- Non-SOS timeseries, or SOS timeseries without a valid continuity row, retain current exact single-timeseries behaviour.
- Continuity is resolved only for the connector and pollutant matching the authoritative requested identity.
- Every physical segment must overlap the requested/context interval according to its inclusive date validity.
- Overlapping physical identities for the same logical pollutant and date are an error.
- Conflicting `site_ref`, connector or pollutant identity is an error.
- A missing continuity member needed for a claimed interval must produce an incomplete/fail-closed response, not silent substitution.
- Physical R2 identity remains visible in diagnostics and response provenance.

### Observations

- Negative sentinel values and otherwise invalid observations remain excluded under existing rules.
- Observation sorting and deduplication remain deterministic.
- If two physical members produce different valid values for the same timestamp, the Worker must report an identity overlap/conflict and must not choose one silently.
- Context observations may be used for calculation but must not appear outside the requested visible interval.
- Existing recent Supabase/R2 seam behaviour and completeness checks must remain intact.

### AQI

- Existing canonical AQI hour semantics remain unchanged.
- Do not reintroduce a period-start/period-end shift.
- PM2.5 and PM10 DAQI receive the preceding 23 hours required for the first output hour.
- PM context may cross a physical timeseries boundary within the same logical family.
- NO2 DAQI remains hourly.
- DAQI and EAQI remain independently calculable.
- Missing rolling PM context must not suppress valid hourly EAQI.
- The existing algorithm version remains attached to calculated rows.
- Do not create a new Supabase AQI row store.

### R2 and validation

- Chart requests and validation do not modify R2.
- Low-level R2 APIs remain exact physical readers.
- Existing R2 files and indexes are not changed by the chart path.
- Only immutable, complete comparable hours are validated.
- Algorithm-version differences are reported as not comparable, not ordinary mismatches.
- Validation logging is bounded.
- A validation result never replaces an already rendered AQI band.

### Browser

- The browser does not silently combine old cached AQI rows with the new response contract.
- Progressive newest-to-oldest rendering, abort handling and stale fallback remain supported.
- Existing visible points are not removed merely because a later chunk uses a different physical timeseries ID in the same logical family.

## Continuity resolution contract

The station-history Worker should resolve a request in this order.

1. Resolve the requested active timeseries identity using the existing authoritative identity lookup.
2. When continuity is enabled, query the service-only continuity view for the requested `timeseries_id`, connector and pollutant.
3. If no valid continuity row exists, use existing exact single-timeseries behaviour.
4. If a row exists, load all members with the same `continuity_key` whose validity intersects the required context/output interval.
5. Validate:
   - one logical connector;
   - one logical pollutant;
   - one consistent non-null `uk_air_ref`;
   - one consistent `site_ref`, unless the active system contract explicitly permits a documented correction;
   - no date overlap between physical members;
   - no duplicate physical member rows;
   - the requested timeseries belongs to the family;
   - the requested current member covers the current part of the range where applicable.
6. Convert inclusive date validity to exact UTC segment boundaries without off-by-one errors.
7. Split the history read into the smallest required physical segments.
8. Use the existing low-level R2 APIs for each exact segment.
9. Merge rows deterministically by timestamp.
10. Return continuity provenance and completeness diagnostics.

The resolver must not assume that `station_id` remains stable across a transition.

## Conceptual response contract

The exact shape must be aligned to current station-history contracts, but should express request, logical and physical identity separately.

```json
{
  "schema_version": 2,
  "request": {
    "requested_timeseries_id": 212,
    "connector_id": 1,
    "pollutant": "pm25",
    "start_utc": "2026-01-01T00:00:00.000Z",
    "end_utc": "2026-07-26T00:00:00.000Z"
  },
  "continuity": {
    "enabled": true,
    "resolved": true,
    "continuity_key": "1:UKA00574:pm25",
    "site_ref": "BPLE",
    "uk_air_ref": "UKA00574",
    "members": [
      {
        "station_id": 248,
        "timeseries_id": 285,
        "valid_from_day_utc": "2013-11-14",
        "valid_to_day_utc": "2026-05-17"
      },
      {
        "station_id": 7479,
        "timeseries_id": 212,
        "valid_from_day_utc": "2026-05-18",
        "valid_to_day_utc": null
      }
    ]
  },
  "observations": {
    "rows": [],
    "response_complete": true,
    "source_counts": {
      "r2": 0,
      "ingest": 0
    }
  },
  "aqi": {
    "enabled": true,
    "calculation_source": "calculated_from_observations",
    "algorithm_version": "aqilevels_hourly_v1",
    "rows": [],
    "response_complete": true,
    "required_context_start_utc": "2025-12-31T01:00:00.000Z",
    "output_start_utc": "2026-01-01T00:00:00.000Z",
    "output_end_utc": "2026-07-26T00:00:00.000Z"
  }
}
```

Each returned observation should retain its actual physical `station_id` and `timeseries_id`, either directly on the row or through an unambiguous segment/provenance structure.

Each calculated AQI hour must be assigned the physical identity valid for its represented hour under the existing canonical hour-endpoint semantics. Codex must trace the current endpoint contract before implementing this assignment and must not infer identity from a naïve date truncation that could introduce an hour-boundary shift.

Useful additional response fields may include:

```text
requested_timeseries_id
continuity_key
calculation_source_timeseries_ids
physical_segment_count
```

Keep the browser-facing payload bounded and avoid repeating the full member structure on every row when top-level provenance is sufficient.

## AQI calculation contract

Reuse the current shared calculation implementation.

The station-history calculation wrapper must:

1. Accept authoritative normalised observation rows from all required physical segments.
2. Validate that every row belongs to the resolved logical connector and pollutant.
3. Sort and deduplicate deterministically.
4. Build one logical calculation stream across physical transitions.
5. Include the preceding 23 hours for PM2.5 and PM10.
6. Calculate DAQI and EAQI using the existing helper and algorithm version.
7. Return only output endpoints inside the visible requested interval.
8. Reattach the physical station/timeseries identity valid for each output hour.
9. Preserve DAQI and EAQI status, missing-reason and source-count fields.
10. Report which physical timeseries contributed calculation context when a PM window crosses a transition.

Do not change the shared AQI algorithm unless inspection finds a separate correctness defect. Report such a defect rather than silently bundling an algorithm change into this work.

## R2 AQI validation contract

Validation compares the calculated logical stream with stored R2 AQI using the physical identity valid for each hour.

### Comparable row identity

A stored row is comparable only when these agree:

```text
connector_id
physical timeseries_id
pollutant_code
canonical AQI hour endpoint
algorithm_version
```

The current requested timeseries ID is not the stored historical identity for older hours and must not be used as the comparison key across the entire range.

### Exact comparison fields

Compare exactly:

```text
daqi_index_level
eaqi_index_level
daqi_calculation_status
eaqi_calculation_status
daqi_missing_reason
eaqi_missing_reason
daqi_input_averaging_code
eaqi_input_averaging_code
daqi_source_observation_count
daqi_required_observation_count
eaqi_source_observation_count
eaqi_required_observation_count
hourly_sample_count
```

### Numeric comparison fields

Compare with a small explicit tolerance permitting only serialisation noise:

```text
daqi_input_value_ugm3
eaqi_input_value_ugm3
```

Use `0.000001 µg/m³` provisionally unless inspection of the current writer proves exact or tighter comparison is appropriate. Log the actual difference for sampled mismatches.

### Algorithm version

- Compare `algorithm_version` before values.
- Report version differences as `not_comparable_algorithm_version`.
- Do not count them as ordinary AQI mismatches.

### Coverage categories

Record separately:

```text
calculated row missing from stored R2 AQI
stored R2 AQI row missing from calculated output
same identity/hour with different values or statuses
excluded mutable/incomplete hours
excluded algorithm-version differences
continuity resolution or physical identity errors
```

### Background execution

- Schedule validation after the foreground response is prepared, normally with `ctx.waitUntil(...)`.
- Validation timeout, fetch failure or mismatch must not affect the response already returned.
- Do not retry repeatedly within one chart request.
- Do not write repairs.

### Bounded logging

Emit one summary event per validated logical chunk, including:

```text
event=station_history_aqi_validation
requested_timeseries_id
continuity_key
connector_id
pollutant_code
start_utc
end_utc
physical_timeseries_ids
algorithm_version
calculated_row_count
r2_row_count
overlap_count
mismatch_count
missing_in_r2_count
missing_in_calculated_count
not_comparable_count
status
```

When mismatches exist, emit one additional bounded diagnostic event with a limited sample of hours and fields. Do not log complete observation or AQI histories.

## Integrity contract

The integrity implementation must first verify the suspected failure path against the supplied 26 July run artefacts and current code.

The suspected issue is that source mapping correctly selects the historical date-valid timeseries, but a later check sees an R2 timeseries ID outside the date-valid expected set and changes a successful source state to:

```text
mapping_unavailable
r2_timeseries_not_covered_by_date_valid_sos_bridge
```

For a bridge-known rollover, that reverses the evidence. It should instead retain successful source mapping and represent the R2-only/current-ID rows versus source-only/historical-ID rows as a historical identity mismatch.

Codex must distinguish:

### Bridge-known but not date-valid on the target day

Example:

```text
source expects 285 for 2026-01-01
R2 contains 212
212 exists in the same continuity family but begins 2026-05-18
```

This is a historical identity rollover mismatch.

### Genuinely unknown to the bridge

An R2 timeseries ID absent from all authoritative bridge rows for the connector/pollutant remains a fail-closed source-mapping or identity problem unless active contracts explicitly say otherwise.

### Required repair gating

Codex should implement the classification and prepare the executable repair path, but leave historical identity repair disabled by default.

When the gate is disabled:

- integrity reports the exact physical identity correction required;
- the gap is recognised and bounded;
- no R2 write is attempted for a rollover mismatch;
- output clearly states that station-history continuity compatibility must be deployed first.

When the gate is explicitly enabled after deployment:

- the normal authoritative source-versus-R2 repair path may replace the incorrect physical identity;
- affected observation manifests and timeseries indexes must be rebuilt through existing supported paths;
- affected AQI must use the corrected physical identity;
- final verification must check both observations and AQI/index coverage.

Codex must inspect the current repair pipeline and identify whether observation repair already regenerates AQI and all required indexes. If it does not, add the smallest safe supported orchestration or provide exact follow-up commands. Do not invent an implicit partial repair.

## Phase 0: Codex structural inspection

Repositories: all three.

Before editing, Codex must perform the one targeted pre-implementation inspection needed to establish structural viability.

1. Read repository instructions and relevant active system contracts.
2. Trace the current station-history routes:
   - `/v1/station-series`;
   - observation history chunks;
   - AQI history chunks;
   - recent Supabase/R2 seam.
3. Trace current authoritative timeseries identity lookup and inactive-timeseries handling.
4. Trace the low-level R2 observations and AQI request/filter contracts.
5. Confirm where the Cloudflare Worker fetch entry point receives execution context and can use `waitUntil`.
6. Confirm current cache-proxy/Service Binding behaviour permits background validation to finish after response return.
7. Inspect the canonical schema definitions and refresh functions for:
   - `sos_station_uk_air_refs`;
   - `sos_station_timeseries_site_refs`;
   - relevant public views and grants.
8. Confirm current bridge uniqueness, interval and provenance contracts in code/schema, without querying the live database.
9. Identify every active website consumer of `station-history-loader.js` and station-history response data.
10. Trace the failed integrity path and current repair/index/AQI regeneration behaviour.
11. Confirm the exact deployment workflows and configuration files that need new variables.
12. Confirm the exact canonical AQI hour endpoint used to assign physical identity at a transition.

If active system contracts conflict with this plan, stop and report the conflict. Otherwise continue through all Codex phases without waiting for operational deployment.

## Phase 1: Codex schema implementation

Repository: `TEST-uk-aq/uk-aq-schema`.

1. Add the canonical service-only continuity view DDL in the appropriate ingest schema file.
2. Add a focused migration/apply file following current repository naming and placement conventions.
3. Use a deterministic continuity key based on connector, UK-AIR identity and canonical pollutant code.
4. Retain and validate `site_ref` separately.
5. Join only the minimum required raw bridge/core tables.
6. Include physical identity, inclusive validity, current-member and match provenance fields.
7. Use `security_invoker = true` where appropriate.
8. Revoke public access and grant only the service role required by the Worker.
9. Do not modify the existing one-row-per-physical-timeseries public view.
10. Do not create a materialised view, refresh job or new table unless structural inspection proves a plain view cannot satisfy the Worker.
11. Do not add a generic cross-network logical-series table in this phase.
12. Keep schema SQL idempotent and aligned between canonical schema and migration/apply files.

Likely areas include:

```text
schemas/ingest_db/
schemas/migrations/
```

Codex must discover the exact canonical files rather than placing DDL only in ops.

## Phase 2: Codex continuity resolver and segmented observation reads

Repository: `TEST-uk-aq/uk-aq-ops`.

1. Add a focused continuity-resolution module under the station-history Worker.
2. Resolve the request identity through the existing authoritative lookup first.
3. Query the new service-only continuity view using the existing service credentials and schema conventions.
4. Fall back to exact current behaviour when continuity is disabled or no eligible row exists.
5. Load all date-overlapping physical members needed for output plus AQI context.
6. Validate continuity family identity and non-overlap fail-closed.
7. Convert inclusive validity dates into exact UTC request segments.
8. Issue exact physical observation R2 requests per segment.
9. Preserve recent Supabase observations for the current physical identity under the existing seam policy.
10. Merge observations deterministically across physical segments and the recent seam.
11. Preserve each row's date-valid physical station/timeseries provenance.
12. Add bounded continuity diagnostics to Worker logs and response metadata.
13. Do not change low-level R2 API semantics.
14. Do not allow a historical member to bypass existing connector or pollutant checks.

Likely files include:

```text
workers/uk_aq_station_history/src/index.mjs
workers/uk_aq_station_history/src/identity.mjs
workers/uk_aq_station_history/src/r2_observations.mjs
workers/uk_aq_station_history/src/history_chunks.mjs
workers/uk_aq_station_history/src/policy.mjs
```

A likely new focused module is:

```text
workers/uk_aq_station_history/src/continuity.mjs
```

Use a different name if current module ownership indicates a better location.

## Phase 3: Codex calculated AQI from combined observations

Repository: `TEST-uk-aq/uk-aq-ops`.

1. Reuse the shared AQI helpers from `lib/aqi/aqi_levels.mjs`.
2. Add or extract a focused station-history calculation wrapper.
3. Feed it the combined logical observation stream, including cross-transition PM context.
4. Preserve deterministic sorting and deduplication.
5. Return only requested output hours.
6. Reattach the physical identity valid for each AQI hour.
7. Preserve DAQI/EAQI values, statuses, missing reasons, source counts and algorithm version.
8. Preserve independent DAQI and EAQI calculation.
9. Do not foreground-read stored R2 AQI when the new path is enabled and observations are complete enough.
10. Preserve the old separate R2 AQI path behind compatibility flags.
11. Ensure incomplete observations cannot claim complete calculated AQI.
12. Keep current recent-head behaviour compatible.

Likely files include:

```text
workers/uk_aq_station_history/src/index.mjs
workers/uk_aq_station_history/src/history_chunks.mjs
workers/uk_aq_station_history/src/stable_head.mjs
lib/aqi/aqi_levels.mjs
```

Do not alter the shared algorithm merely to accommodate continuity. Adapt identity orchestration around it.

## Phase 4: Codex combined response and non-blocking validator

Repository: `TEST-uk-aq/uk-aq-ops`.

1. Extend the existing station-history observation/head and history-chunk contracts to carry calculated AQI.
2. Preserve existing observation fields and backward compatibility.
3. Add a clearly versioned `continuity` section and `aqi` section.
4. Return the foreground response before validation starts.
5. Add a focused validation module.
6. Schedule validation through Worker execution context.
7. Split validation reads by date-valid physical timeseries identity.
8. Query stored R2 AQI through the existing private exact-identity API.
9. Apply the comparison contract in this plan.
10. Restrict comparison to immutable complete coverage.
11. Emit bounded summary and mismatch events.
12. Catch all validation failures without changing the returned response.
13. Keep calculation and validation independently configurable.
14. Do not add durable mismatch storage.

Likely new file:

```text
workers/uk_aq_station_history/src/aqi_validation.mjs
```

## Phase 5: Codex website progressive-loader implementation

Repository: `TEST-uk-aq/TEST-uk-aq-root.github.io`.

1. Discover every active station-history chart consumer.
2. Keep sending only the current selected `timeseries_id`, connector and pollutant.
3. Parse the versioned combined observation-plus-calculated-AQI response.
4. Render concentration observations as chunks arrive.
5. Render calculated AQI bands from the same response without waiting for a separate stored R2 AQI request.
6. Merge observations across physical identity transitions as one visible logical series.
7. Do not remove already rendered observations or bands merely because a later/older chunk contains another physical ID in the same continuity family.
8. Keep compatibility fallback to the old separate AQI route when:
   - the calculated-history flag is disabled;
   - an older Worker response is received;
   - calculated AQI is unavailable.
9. Do not wait for or consume validation results.
10. Bump the station-history browser cache contract and local-storage key.
11. Prevent old separately sourced AQI cache rows from being mistaken for calculated-response rows.
12. Preserve progressive newest-to-oldest loading, request cancellation, coverage tracking, refresh behaviour and stale-cache fallback.
13. Preserve canonical AQI band endpoint rendering and alignment.
14. Keep continuity logic out of browser code.

Likely active files include:

```text
station-history-loader.js
hex_map/index.html
```

Codex must discover all other active consumers rather than assuming these are the only files.

## Phase 6: Codex integrity classification and repair gate

Repository: `TEST-uk-aq/uk-aq-ops`.

Inspect the supplied failed-run artefacts locally:

```text
/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/logs/2026-07-26T104611Z-summary.json
/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/logs/run-state.json
/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/logs/rows.ndjson
/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/logs/run-2026-07-26T104611Z.log
```

1. Confirm the date-relative source resolver selects the correct historical physical ID.
2. Confirm the later uncovered-R2-ID check causes the incorrect `mapping_unavailable` state.
3. Distinguish bridge-known date-invalid IDs from genuinely unknown IDs.
4. Preserve successful authoritative source evidence for a bridge-known rollover.
5. Produce a specific historical identity rollover gap/diagnostic.
6. Reuse the normal source-versus-R2 mismatch comparison where safe.
7. Add the default-disabled execution gate.
8. When disabled, report exact proposed physical identity corrections without writing R2.
9. When enabled later, use the supported authoritative repair path.
10. Confirm or implement the required observation manifest, timeseries index and AQI follow-through.
11. Preserve fail-closed behaviour for unknown, ambiguous or incomplete source mappings.
12. Preserve successful recent-date integrity behaviour.

Likely files include:

```text
scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py
scripts/uk-aq-history-integrity/tests/test_sos_site_ref_bridge.py
```

A narrowly targeted regression check is justified here because the defect can cause a historically correct repair to break public history. Keep it focused on one rollover and one genuinely unknown identity case. Do not create a broad fixture or test programme.

## Phase 7: Codex configuration and deployment wiring

Repository: `TEST-uk-aq/uk-aq-ops` and any required website configuration files.

1. Add the continuity, calculated-AQI, validation and integrity-repair variables to the correct Worker/deployment configuration.
2. Keep repository defaults safe and disabled.
3. Ensure the station-history Worker has service-only access to the continuity view.
4. Ensure background validation retains access to the existing private R2 AQI API and upstream secret.
5. Preserve stable request URLs and cache behaviour.
6. Do not add new public low-level routes unless current architecture proves unavoidable.
7. Do not deploy or change secrets.
8. Prepare exact manual commands for:
   - schema application;
   - station-history Worker deployment;
   - cache proxy deployment only if required;
   - website deployment;
   - TEST feature enablement;
   - integrity repair enablement after compatibility validation.
9. Prepare exact rollback commands/variable values.

Recommended initial TEST feature sequence after deployment:

```text
UK_AQ_STATION_HISTORY_CONTINUITY_ENABLED=true
UK_AQ_STATION_HISTORY_CALCULATED_HISTORY_AQI_ENABLED=true
UK_AQ_STATION_HISTORY_AQI_VALIDATION_MODE=all
UK_AQ_STATION_HISTORY_AQI_VALIDATION_SAMPLE_PERCENT=100
UK_AQ_INTEGRITY_HISTORICAL_IDENTITY_REPAIR_ENABLED=false
```

Do not enable any of these in LIVE as part of this plan.

## Phase 8: Codex minimal local validation and handover

This is a TEST-system change. Run only the smallest checks required to show structural viability.

Required checks:

1. SQL parse/structural review using existing repository tooling without applying SQL.
2. Syntax or compile checks for changed Python, `.mjs` and browser JavaScript files.
3. Cloudflare Worker dry-run/build check for changed Workers.
4. Workflow/configuration parse check for changed deployment files.
5. One focused continuity resolver check covering:
   - current request `212`;
   - historical member `285`;
   - the `2026-05-18` transition;
   - cross-transition PM context.
6. One focused integrity regression check covering:
   - bridge-known date-invalid R2 identity;
   - retained successful source mapping;
   - repair blocked while the feature gate is off;
   - genuinely unknown identity remains fail-closed.
7. One existing focused website loader/parser check if already present and directly relevant.

Do not:

- run the full test suite;
- add broad new tests;
- query TEST Supabase or R2;
- run a real chart request;
- run integrity;
- perform a large R2 comparison;
- deploy anything.

Codex deliverables:

1. Confirmation that the design was structurally viable.
2. Exact root cause of the historical integrity failure.
3. Exact files changed in each repository.
4. Final continuity view name, columns and grants.
5. Final response contract.
6. Final feature-variable names and defaults.
7. Explanation of physical versus logical identity handling.
8. Explanation of PM context across a transition.
9. Explanation of non-blocking validation and log events.
10. Explanation of integrity classification and repair gating.
11. Minimal checks run and results.
12. Exact manual schema/deploy/configuration commands.
13. Exact TEST operational validation steps.
14. Exact command to rerun integrity for `2026-01-01` first with repair disabled, then enabled.
15. Expected evidence for both runs.
16. Rollback instructions.
17. A concise handover for ChatGPT to update active `system_docs/` later.

Codex must not commit, push, deploy, apply SQL, run integrity or write system docs.

## Phase 9: manual schema and deployment sequence

This phase is performed by the user after reviewing the Codex changes.

Apply and deploy in this order.

1. Apply the IngestDB continuity-view schema migration.
2. Verify the view is service-only and not readable by `anon` or `authenticated`.
3. Deploy the station-history Worker with backward-compatible features present but disabled.
4. Deploy the cache proxy only if bindings/configuration changed.
5. Deploy the TEST website consumer with fallback support.
6. Enable station-history continuity in TEST.
7. Enable calculated historical AQI in TEST.
8. Enable validation mode `all` in TEST.
9. Leave historical identity repair disabled.

Do not repair R2 before the continuity-aware chart path is confirmed operational.

## Phase 10: TEST operational validation

Functional validation happens through real TEST operation after deployment.

### Representative continuity chart

Use BPLE PM2.5 or another confirmed rollover family with a date range spanning the transition.

Confirm:

1. The website still sends only current `timeseries_id=212`.
2. The station-history response resolves the logical family.
3. Older observation rows come from physical timeseries `285`.
4. Newer observation rows come from physical timeseries `212`.
5. The concentration line remains continuous where source data exists.
6. No points are lost solely because the physical ID changes.
7. The response fails closed rather than mixing data if identity overlap/conflict is introduced by bad metadata.

### Calculated AQI rendering

Confirm:

1. Observation line and AQI bands progressively render from the combined response.
2. The browser does not issue the normal blocking historical stored-R2-AQI request for combined chunks.
3. The first displayed PM AQI hour receives the required preceding context.
4. PM context can include `285` and `212` across the transition.
5. AQI band endpoints remain aligned with their represented hourly intervals.
6. The browser does not redraw visible bands when validation finishes.

### Validation event

Inspect one corresponding Worker validation event.

Expected normal result:

```text
status=match
mismatch_count=0
missing_in_r2_count=0
missing_in_calculated_count=0
not_comparable_count=0
```

Before historical R2 repair, the rollover range may legitimately report identity-related stored AQI differences. Confirm those diagnostics use the correct physical IDs and remain non-blocking.

One successful rollover chart operation, one normal non-rollover chart operation and bounded validation evidence are sufficient for initial TEST acceptance.

## Phase 11: integrity repair enablement and January correction

Only after Phase 10 succeeds:

1. Run integrity for `2026-01-01` with historical identity repair still disabled.
2. Confirm:
   - source mapping remains successful;
   - BPLE PM2.5 source selects `285`;
   - R2-only `212` is classified as a bridge-known historical rollover;
   - no source-mapping-unavailable state is created solely because R2 contains `212`;
   - proposed repair is blocked by the compatibility gate.
3. Enable the explicit TEST historical identity repair flag.
4. Rerun integrity for `2026-01-01`.
5. Confirm the supported path:
   - writes date-valid physical observations;
   - rebuilds affected manifests and timeseries indexes;
   - regenerates or corrects stored AQI under the date-valid physical identity;
   - verifies the corrected partition;
   - leaves genuinely unknown identity problems fail-closed.
6. Open the same website chart again.
7. Confirm the website still requests current `212` but automatically receives repaired older history from `285`.
8. Confirm the background stored-R2-AQI validation now reports a match for the corrected immutable range.

Do not perform a broad historical backfill until one repaired day has passed these checks.

## Phase 12: wider TEST operation

After the single-day correction succeeds:

1. Allow normal TEST chart use to exercise PM10 and NO2 continuity.
2. Review bounded continuity and validation logs for unexpected ambiguity or distance-only mapping issues.
3. Run selected historical integrity dates individually rather than one broad job.
4. Expand repair coverage only after normal operation confirms the same behaviour.
5. Keep LIVE unchanged.

## Phase 13: system documentation update by ChatGPT

Codex must not edit `system_docs/`.

After implementation and TEST operational validation, ChatGPT in Chat mode should update the relevant active documents using:

- the final implemented repository changes;
- the Codex handover;
- the schema/deployment commands actually used;
- the TEST operational results.

Documentation must clearly describe:

1. Request, logical continuity and physical identities.
2. The service-only continuity view and authority/provenance.
3. Exact low-level R2 API semantics.
4. Station-history segmented reads and fail-closed rules.
5. Cross-transition PM calculation context.
6. Calculated visible AQI versus stored R2 validation AQI.
7. Validation boundaries and event fields.
8. Browser cache contract and fallback path.
9. Integrity rollover classification and repair gate.
10. Deployment, rollback and LIVE enablement prerequisites.

## Acceptance criteria

The plan is complete in TEST when all of the following are true.

- The website sends one current timeseries ID and does not contain predecessor logic.
- The station-history Worker resolves the date-valid continuity family.
- R2 observations remain stored under historically correct physical identities.
- A range crossing a physical transition renders as one logical chart series.
- PM AQI context can cross the physical transition without losing the first rolling hours.
- Visible historical AQI is calculated from the same observations used for the concentration line.
- The browser does not wait for a separate foreground stored R2 AQI fetch when the combined contract is enabled.
- Stored R2 AQI is validated asynchronously using the physical identity valid for each hour.
- Validation mismatch or failure does not alter visible data.
- No AQI rows are recreated in Supabase.
- Existing low-level R2 APIs remain exact physical readers.
- Existing fallback behaviour can be restored through feature flags.
- Integrity distinguishes a bridge-known rollover from genuinely unknown identity.
- Historical rollover repair is blocked until compatibility is deployed.
- After explicit enablement, a repaired day remains visible through the current website timeseries request.
- No LIVE repository or service is changed.
- ChatGPT has updated the relevant active system documentation after TEST validation.

## Rollback

Normal rollback should be configuration-first.

Disable:

```text
UK_AQ_INTEGRITY_HISTORICAL_IDENTITY_REPAIR_ENABLED=false
UK_AQ_STATION_HISTORY_AQI_VALIDATION_MODE=off
UK_AQ_STATION_HISTORY_CALCULATED_HISTORY_AQI_ENABLED=false
UK_AQ_STATION_HISTORY_CONTINUITY_ENABLED=false
```

The website must then use the retained exact-timeseries and separate stored-R2-AQI compatibility paths.

If the website cache contract needs to be reverted, restore the prior TEST website deployment or disable the new consumer path while leaving the backward-compatible Worker available.

The continuity view can remain deployed while unused because it is read-only and service-only. If its schema must be removed, use the rollback SQL prepared by Codex after all dependent features are disabled.

No ordinary chart-request rollback should require changing R2 or Supabase data. Any R2 day already repaired to historically correct physical identity should not be rewritten to the current timeseries merely to support rollback. Instead, re-enable continuity-aware history before serving that repaired range publicly.