# 2026-07-26 Station-history continuity, calculated AQI chart and R2 validation plan

## Status

Planned for the UK AQ TEST system.

This plan supersedes the implementation sequence in:

```text
plans/2026-07-22_calculated_AQI_chart_and_R2_validation/2026-07-22_calculated_AQI_chart_and_R2_validation_plan.md
```

It incorporates the original calculated-AQI chart and non-blocking R2-validation work, and adds date-valid SOS station/timeseries continuity using the approved Option 1 embedded `timeseries_binding` design.

## Recommended Codex model

Use **GPT-5.6 Codex with High reasoning** for all Codex phases.

## Repositories

Primary Worker, R2-index, integrity and planning repository:

- `TEST-uk-aq/uk-aq-ops`

Canonical schema repository:

- `TEST-uk-aq/uk-aq-schema`

Website repository:

- `TEST-uk-aq/TEST-uk-aq-root.github.io`

Start in `TEST-uk-aq/uk-aq-ops`.

## Authoritative contracts

Before editing, Codex must read:

- each repository's `AGENTS.md` and any linked `AGENTS_BASE.md`;
- `uk-aq-ops/system_docs/README.md`;
- `uk-aq-ops/system_docs/r2_history/README.md`;
- `uk-aq-ops/system_docs/r2_history/contract.md`;
- `uk-aq-ops/system_docs/r2_history/continuity.md`;
- `uk-aq-ops/system_docs/r2_history/interfaces.md`;
- `uk-aq-ops/system_docs/r2_history/operations.md`;
- `uk-aq-ops/system_docs/r2_history/integrity.md` where relevant;
- `uk-aq-ops/system_docs/aqi-levels/README.md`;
- `uk-aq-ops/system_docs/aqi-levels/contract.md`;
- `uk-aq-ops/system_docs/aqi-levels/station-history-contract.md`;
- `uk-aq-ops/system_docs/aqi-levels/station-history-validation.md`;
- the active schema documentation for the SOS bridge and any public service-only view created by this plan.

The specific station-history contracts deliberately amend the previous chart-rendering source-precedence rule. Codex must not treat older R2-authoritative chart wording as permission to ignore the new calculated-response contract.

## Codex operating boundary

Phases 0 to 9 are one code-only Codex implementation sequence. Codex should complete all structurally viable implementation phases together rather than stopping after each phase for deployment or operational testing.

Codex must:

1. Read the authoritative contracts before editing.
2. Report any code/contract conflict before changing code.
3. Follow archive rules for active non-test implementation files.
4. Use `grep`, not `rg`.
5. Make the smallest coherent cross-repository implementation.
6. Run only the minimal fast local structural checks in Phase 9.
7. Prepare exact manual schema, deployment, configuration, integrity and rollback commands.
8. Provide a concise implementation handover for ChatGPT.

Codex must not:

- create, amend, stage or modify Git commits;
- push branches or open pull requests;
- run SQL against TEST or LIVE Supabase;
- apply migrations;
- deploy Workers, websites or workflows;
- change Cloudflare, R2, Supabase or GitHub settings;
- run integrity, backfills, reconciliations or bulk jobs;
- create, edit, move, rename or delete anything under `system_docs/`;
- edit any LIVE repository;
- add a broad or speculative test suite.

Use Level 1, code only. Database and deployment work must be prepared but not executed.

## Purpose

Implement a stable logical station-history identity so the website can continue requesting one current `timeseries_id` while the station-history Worker retrieves the physical station and timeseries identities valid for each historical date.

At the same time:

1. Calculate historical DAQI and European AQI from the same observation rows used to draw the concentration line.
2. Return observations and calculated AQI together so visible bands do not wait for a separate foreground R2 AQI request.
3. Retain stored R2 `aqilevels` as an independent, non-blocking validation source.
4. Keep R2 observations and AQI historically accurate under their date-valid physical identities.
5. Allow integrity to identify and later repair historical identity rollover mismatches without breaking website history.

## Example problem

BPLE PM2.5 is one logical site/pollutant history with two physical identities:

```text
Logical identity:
connector_id=1
site_ref=BPLE
uk_air_ref=UKA00574
pollutant_code=pm25
continuity_key=1:UKA00574:pm25

Historical member:
station_id=248
station_ref=3916
timeseries_id=285
timeseries_ref=97
valid_from_day_utc=2013-11-14
valid_to_day_utc=2026-05-17

Current member:
station_id=7479
station_ref=10539
timeseries_id=212
timeseries_ref=1965
valid_from_day_utc=2026-05-18
valid_to_day_utc=NULL
```

For 2026-01-01, authoritative source evidence maps PM2.5 to timeseries `285`. R2 currently appears to contain that historical data under `212`.

Changing the historical rows to `285` is correct, but the existing website requests only current ID `212`. The current exact-ID APIs do not discover predecessor identities. Repair must therefore remain blocked until the continuity-aware station-history implementation is deployed.

## Existing bridge and authority

The canonical bridge is:

```text
uk_aq_raw.sos_station_timeseries_site_refs
```

It contains:

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

There is no single official external cross-reference directly mapping UK-AIR IDs to UK AQ `station_id` or `timeseries_id`. The bridge is the system's derived authoritative mapping, based on UK-AIR site evidence, SOS station matching, canonical pollutant identity and date sequencing.

## Approved architecture

### 1. Three identity levels

#### Request identity

The website sends one current active identity:

```text
connector_id + timeseries_id + pollutant
```

#### Logical continuity identity

The stable chart family is:

```text
connector_id + uk_air_ref + pollutant_code
```

Example:

```text
1:UKA00574:pm25
```

`site_ref` is retained and validated as corroborating identity, but is not part of the continuity key. A corrected `site_ref` must not unnecessarily change the logical key or object path.

#### Physical identity

R2 rows retain the date-valid:

```text
station_id
station_ref
timeseries_id
timeseries_ref
valid_from_day_utc
valid_to_day_utc
```

Historical provenance must not be rewritten to the current ID merely to simplify API reads.

### 2. Service-only continuity view

Create a dedicated read-only IngestDB view, using a final name aligned with schema conventions. Preferred conceptual name:

```text
uk_aq_public.uk_aq_timeseries_continuity
```

The view must expose one row per physical member and include at least:

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

Requirements:

- use `security_invoker = true` where supported;
- grant only the required service role, not `anon` or `authenticated`;
- do not expose raw payloads;
- remain a plain view unless inspection proves otherwise;
- fail closed on ambiguous, overlapping or contradictory continuity data;
- preserve provenance for diagnostics.

### 3. Option 1: embed continuity in `timeseries_binding`

The runtime materialised copy belongs in the existing object:

```text
history/_index_v2/timeseries_binding/timeseries_id=<id>.json
```

The top level remains the exact physical binding.

A genuine multi-member family adds an optional nested `continuity` section containing the complete date-valid family. Every member binding contains the same deterministic family payload.

Conceptual example:

```json
{
  "schema_version": 2,
  "history_version": "v2",
  "index_kind": "timeseries_binding",
  "timeseries_id": 212,
  "connector_id": 1,
  "station_id": 7479,
  "pollutant_code": "pm25",
  "continuity": {
    "schema_version": 1,
    "source": "sos_station_timeseries_site_refs",
    "continuity_key": "1:UKA00574:pm25",
    "site_ref": "BPLE",
    "uk_air_ref": "UKA00574",
    "pollutant_code": "pm25",
    "members": [
      {
        "station_id": 248,
        "station_ref": "3916",
        "timeseries_id": 285,
        "timeseries_ref": "97",
        "valid_from_day_utc": "2013-11-14",
        "valid_to_day_utc": "2026-05-17"
      },
      {
        "station_id": 7479,
        "station_ref": "10539",
        "timeseries_id": 212,
        "timeseries_ref": "1965",
        "valid_from_day_utc": "2026-05-18",
        "valid_to_day_utc": null
      }
    ]
  }
}
```

#### Binding churn controls

- Existing exact-only, single-member bindings may remain schema version 1 and byte-identical.
- Schema version 2 is required only when `continuity` is present.
- Do not enrich every single-member binding merely for uniformity.
- The continuity payload must contain only stable operational identity and date fields.
- Do not include `generated_at`, `updated_at`, run IDs, source refresh timestamps, raw payloads, match distances or other refresh-sensitive values.
- Sort members by `valid_from_day_utc`, then `timeseries_id`.
- Preserve deterministic property ordering.
- Skip R2 PUTs when the proposed body is byte-identical.
- A new monthly source snapshot with unchanged substantive mapping must produce no binding changes.

`station_ref` and `timeseries_ref` are included because they are useful physical source references. If either genuinely changes, all bindings in that small family may change. That limited family-scoped churn is accepted in favour of the simpler one-object runtime lookup.

### 4. Keep the website continuity-unaware

The website continues sending one current `timeseries_id`.

It must not:

- query the continuity view;
- discover predecessor IDs;
- issue separate requests per physical member;
- contain SOS-specific continuity logic.

### 5. Keep low-level R2 readers physically exact

The observations and AQI R2 APIs continue accepting exact physical identity and range parameters. They must not reinterpret a physical ID as a logical family or independently query Supabase for continuity.

The station-history Worker performs continuity orchestration.

### 6. Continuity-aware observation stream

The station-history Worker must:

1. Resolve the requested physical binding.
2. Read `continuity` when present; otherwise retain current exact single-series behaviour.
3. Select family members whose inclusive validity dates overlap the requested interval and required AQI context interval.
4. Issue bounded exact physical observation requests.
5. merge rows deterministically by timestamp;
6. preserve each row's physical `station_id` and `timeseries_id`;
7. fail closed on conflicting overlapping rows;
8. report continuity members and physical source segments in response diagnostics.

### 7. Calculate visible AQI from the same observations

The shared helper in:

```text
lib/aqi/aqi_levels.mjs
```

remains authoritative.

For the calculated-history path, the Worker must:

1. build one logical observation stream from all required physical segments;
2. include the preceding 23 endpoint hours for PM2.5 and PM10;
3. allow that context to cross a physical identity boundary;
4. calculate DAQI and European AQI independently;
5. return only output endpoints within the requested visible interval;
6. preserve the physical identity valid for each calculated hour;
7. return observations and calculated AQI in one versioned response.

The browser must not implement the AQI algorithm.

### 8. Stored R2 AQI becomes non-blocking validation

When calculated historical AQI is enabled:

- visible AQI bands use AQI calculated from the observations used for the line;
- no separate foreground R2 AQI request may delay normal chart rendering;
- stored R2 AQI remains an independently materialised validation artefact;
- validation runs after the response through `ctx.waitUntil(...)` or the equivalent supported execution context;
- validation errors or mismatches never fail or redraw the chart;
- validation never repairs, overwrites or deletes data.

The previous separate R2 AQI rendering path remains available behind feature flags during TEST rollout.

### 9. Historical identity repair gate

Integrity must distinguish:

```text
bridge-known historical identity rollover
ordinary source/R2 row mismatch
genuinely unknown R2 identity
```

A bridge-known rollover must not be converted into `mapping_unavailable` merely because R2 contains a different family member.

Rollover repairs remain non-executable by default until continuity-aware station history and the website consumer are deployed and operationally confirmed.

Use an explicit feature flag or CLI option following existing conventions, equivalent to:

```text
UK_AQ_INTEGRITY_HISTORICAL_IDENTITY_REPAIR_ENABLED=false
```

Unknown, ambiguous or contradictory mappings remain fail-closed.

## Required invariants

### Continuity

- The requested binding must appear exactly once in its `continuity.members`.
- Every member has the same connector, UK-AIR ID and pollutant.
- Non-null `site_ref` values must agree.
- No member intervals overlap.
- There is at most one open-ended current member.
- A gap is not silently filled.
- One physical timeseries must not belong to two logical families.
- Non-SOS or unenriched bindings retain current exact behaviour.

### Observations

- R2 observations remain authoritative raw history.
- Negative sentinel and invalid values remain excluded from chart/AQI calculation under current rules.
- Sorting and deduplication remain deterministic.
- Different valid values for the same timestamp from overlapping members are a hard continuity conflict.
- Context rows are not displayed outside the requested interval.

### AQI

- `timestamp_hour_utc` remains the canonical hour endpoint.
- A row ending at `n` represents `(n - 1 hour, n]`.
- Requested represented interval `S` to `E` selects `S < n <= E`.
- PM DAQI requires 24 hourly values ending at `n`.
- NO2 DAQI remains hourly.
- European AQI remains independently calculable when PM DAQI lacks context.
- Missing hours remain blank.
- The final coloured band ends at the final valid endpoint.
- Breakpoints and algorithm version remain unchanged unless a separate defect is reported.

### R2 and validation

- Low-level R2 APIs remain exact physical readers.
- R2 AQI files and indexes are not changed by chart requests.
- Validation compares only immutable, complete overlapping hours.
- Algorithm-version disagreement is `not_comparable_algorithm_version`, not an ordinary mismatch.
- Validation logs are bounded.
- Binding/index payloads remain byte-stable.

## Target station-series response

Align the exact shape with current normalisation, but provide equivalent information:

```json
{
  "schema_version": 2,
  "request": {
    "connector_id": 1,
    "requested_timeseries_id": 212,
    "pollutant": "pm25",
    "start_utc": "2026-01-01T00:00:00.000Z",
    "end_utc": "2026-07-01T00:00:00.000Z"
  },
  "continuity": {
    "enabled": true,
    "continuity_key": "1:UKA00574:pm25",
    "site_ref": "BPLE",
    "uk_air_ref": "UKA00574",
    "members": []
  },
  "observations": {
    "rows": [],
    "response_complete": true,
    "source_segments": []
  },
  "aqi": {
    "enabled": true,
    "calculation_source": "calculated_from_observations",
    "algorithm_version": "aqilevels_hourly_v1",
    "rows": [],
    "response_complete": true,
    "required_context_start_utc": "2025-12-31T01:00:00.000Z",
    "output_start_utc": "2026-01-01T00:00:00.000Z",
    "output_end_utc": "2026-07-01T00:00:00.000Z"
  }
}
```

Every returned observation and AQI row retains its actual physical identity. The request identity remains separately visible.

## R2 AQI validation contract

Compare using physical identity valid for each hour:

```text
connector_id
timeseries_id
pollutant_code
canonical AQI endpoint
```

Compare these fields exactly:

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

Compare numeric inputs with an explicit storage-noise tolerance. Use `0.000001 µg/m³` provisionally unless current writer inspection proves a smaller exact tolerance.

Record separately:

- missing in R2;
- missing in calculated output;
- value/status mismatch;
- mutable/incomplete exclusions;
- algorithm-version exclusions.

Emit one bounded summary event per validated chunk and, when required, one bounded mismatch diagnostic event.

## Configuration

Provide controls equivalent to:

```text
UK_AQ_STATION_HISTORY_CONTINUITY_ENABLED
UK_AQ_STATION_HISTORY_CALCULATED_HISTORY_AQI_ENABLED
UK_AQ_STATION_HISTORY_AQI_VALIDATION_MODE
UK_AQ_STATION_HISTORY_AQI_VALIDATION_SAMPLE_PERCENT
UK_AQ_INTEGRITY_HISTORICAL_IDENTITY_REPAIR_ENABLED
```

Validation modes:

```text
off
all
sample
```

Repository defaults remain safe and disabled unless established TEST conventions require otherwise. Do not enable in LIVE as part of this plan.

# Codex implementation phases

## Phase 0: targeted structural inspection

Confirm only what is required to keep the design structurally viable:

1. Current binding producer, consumers, schema-version handling and cache behaviour.
2. Whether core snapshot publication or the standalone reconciliation script is the correct place to fetch continuity-view rows.
3. Current Supabase service credentials and exposed-schema path used by private Workers and scripts.
4. Station-history request handler execution context and `waitUntil` support.
5. Current recent-head and older observation/AQI chunk flows.
6. Exact PM context availability across the R2/ingest seam.
7. Current AQI R2 debug/data fields and algorithm version.
8. All active website consumers of `station-history-loader.js`.
9. Current integrity repair-planning and execution gates.
10. Current workflow/config variable wiring.

Do not create a speculative test programme.

## Phase 1: continuity schema view

Repository: `TEST-uk-aq/uk-aq-schema`

1. Add canonical DDL and a migration for the service-only continuity view.
2. Build it from the authoritative SOS bridge and canonical core identity.
3. Expose deterministic `continuity_key`.
4. Preserve date validity and provenance.
5. Use security-invoker behaviour and least-privilege grants.
6. Do not expose raw bridge tables to browser roles.
7. Add or update non-system schema documentation only where repository rules require it.
8. Do not apply the migration.

## Phase 2: enrich multi-member R2 bindings

Repository: `TEST-uk-aq/uk-aq-ops`

1. Extend the binding parser/builder to support schema versions 1 and 2.
2. Keep exact-only single-member objects byte-identical at schema version 1.
3. Fetch validated continuity rows through the approved service boundary.
4. Build one deterministic family per `connector_id + uk_air_ref + pollutant_code`.
5. Add `continuity` only for families with more than one member.
6. Embed the same sorted family in every member binding.
7. Reject overlapping, contradictory or duplicate memberships.
8. Omit refresh-sensitive provenance from the R2 payload.
9. Preserve unchanged-object ETag/MD5 skip behaviour.
10. Add dry-run diagnostics for enriched, unchanged, changed, invalid and skipped families.
11. Ensure backup inventory continues treating these as `timeseries_binding_v2` objects, without creating a new backup category.
12. Do not write to R2.

## Phase 3: continuity-aware station-history observations

Repository: `TEST-uk-aq/uk-aq-ops`

1. Resolve the requested binding through the existing private binding route/helper.
2. Validate optional schema-v2 continuity.
3. Select members overlapping the visible and PM-context ranges.
4. Split requests at inclusive validity boundaries.
5. Fetch exact physical observation segments through existing private R2 APIs and recent ingest paths.
6. Merge deterministically and preserve physical identity.
7. Report family and segment provenance.
8. Keep exact single-timeseries behaviour when no continuity section exists.
9. Fail closed on overlaps, conflicts or required missing members.

## Phase 4: calculate AQI and return one combined response

Repository: `TEST-uk-aq/uk-aq-ops`

1. Reuse `lib/aqi/aqi_levels.mjs`.
2. Calculate from the merged authoritative observation stream.
3. Include preceding 23 hours across continuity boundaries for PM.
4. Keep DAQI and European AQI independent.
5. Return only visible endpoints.
6. Attach the existing algorithm version.
7. Extend the station-series/chunk contract with versioned `continuity`, `observations` and calculated `aqi` sections.
8. Preserve existing observation fields and compatibility fallbacks.
9. Do not read stored R2 AQI in the foreground when the new path has sufficient observations.
10. Keep the old separate foreground AQI path when disabled or when an older response contract is used.

## Phase 5: asynchronous R2 AQI validator

Repository: `TEST-uk-aq/uk-aq-ops`

1. Add a focused validation module.
2. Schedule it after preparing the foreground response through `ctx.waitUntil(...)`.
3. Limit it to immutable, complete ranges.
4. Query stored AQI by the physical timeseries valid for each hour.
5. Compare fields using the approved contract.
6. Compare algorithm version first.
7. Emit bounded summary and mismatch events.
8. Catch validation failures without affecting the returned chart response.
9. Do not retry repeatedly inside one request.
10. Never write corrections.

## Phase 6: website combined-response consumer

Repository: `TEST-uk-aq/TEST-uk-aq-root.github.io`

1. Keep sending one current timeseries ID.
2. Consume observations and calculated AQI from the combined response.
3. Render observations as soon as each combined chunk arrives.
4. Merge AQI by canonical endpoint.
5. Stop the normal separate historical AQI request when the combined contract is available and enabled.
6. Keep compatibility fallback for disabled/older responses.
7. Do not wait for validation.
8. Do not redraw visible bands because validation completes.
9. Bump the browser cache contract/storage key so old separate-source rows are not mixed with the new contract.
10. Preserve progressive newest-to-oldest loading, abort behaviour, stale fallback, existing line-retention behaviour and all active chart consumers.
11. Render each AQI row from `n - 1 hour` to `n`.

## Phase 7: integrity classification and repair gate

Repository: `TEST-uk-aq/uk-aq-ops`

1. Keep successful source mapping when an R2 ID is a known but date-invalid member of the same family.
2. Emit the normal source/R2 physical mismatch evidence for old/current IDs.
3. Preserve fail-closed handling for IDs unknown to the authoritative bridge.
4. Add a distinct historical rollover classification where helpful.
5. Keep rollover repair execution disabled by default.
6. Require the explicit feature flag/CLI option to make it executable.
7. Preserve existing planning for ordinary mismatches.
8. Include exact manual rerun and expected evidence in the handover.
9. Do not run integrity.

## Phase 8: configuration and workflow wiring

Repository: `TEST-uk-aq/uk-aq-ops`

1. Add the new station-history and integrity variables to the appropriate workflows/configuration.
2. Keep safe repository defaults disabled.
3. Preserve private Service Binding and upstream-auth boundaries.
4. Do not add a public continuity route.
5. Do not add an R2 continuity prefix.
6. Do not change R2 observation or AQI data objects through chart requests.
7. Prepare deployment order and rollback commands.

## Phase 9: minimal structural checks and handover

Run only:

1. syntax/type checks for changed JS/TS/MJS files;
2. a Worker build/dry-run check;
3. migration/workflow parsing checks;
4. one directly relevant existing binding test;
5. one targeted continuity regression only if genuinely needed to protect multi-member boundary selection;
6. one directly relevant existing response-parser/comparator check if already present.

Do not run broad suites, cloud calls, R2 comparisons, Supabase SQL, deployments or integrity.

Codex handover must include:

- exact files changed by repository;
- final view and binding contracts;
- schema-version and churn behaviour;
- final station-series response contract;
- feature flags/defaults;
- validation events;
- integrity gate behaviour;
- checks run;
- exact manual migration/deployment/reconciliation/validation/rollback commands;
- affected system documents, without editing them.

# Manual and ChatGPT phases

## Phase 10: apply and deploy to TEST

Performed manually by the user, not Codex.

Recommended order:

1. Apply the IngestDB continuity-view migration.
2. Verify service-role access and absence of browser-role access.
3. Deploy binding producer/reconciliation support.
4. Run binding reconciliation in dry-run mode.
5. Inspect proposed schema-v2 family count and churn.
6. Apply binding reconciliation to TEST R2.
7. Deploy station-history Worker with new paths disabled.
8. Deploy cache proxy only if required.
9. Deploy the website compatibility consumer.
10. Enable continuity in TEST.
11. Enable calculated historical AQI in TEST.
12. Enable validation mode `all` in TEST.
13. Leave historical identity repair disabled.

## Phase 11: TEST operational validation

Use normal TEST operation.

Choose one PM2.5 chart that crosses a known physical transition, including BPLE if appropriate.

Confirm:

- the website still requests only current ID `212`;
- the binding resolves both `285` and `212`;
- older rows retain physical ID `285`;
- newer rows retain physical ID `212`;
- the line is continuous without duplicate/conflicting timestamps;
- PM AQI across the transition has the required 23-hour context;
- observations and AQI render from the combined response;
- no blocking historical R2 AQI request occurs for that chunk;
- bands align from `n - 1 hour` to `n`;
- the final band ends at the final concentration endpoint;
- one validation event reports `status=match` or gives bounded actionable mismatch evidence;
- a normal single-member station still uses exact schema-v1 behaviour;
- Dropbox inventory does not show broad binding churn.

One successful transition operation, one successful ordinary operation and one representative validation event are sufficient for initial TEST acceptance.

## Phase 12: enable historical identity repair

Only after Phase 11 succeeds:

1. Enable the explicit TEST repair flag/option.
2. Run one targeted dry-run for the known rollover day.
3. Confirm proposed physical changes are old ID `212` to date-valid ID `285`, with matching station identity.
4. Run the targeted repair.
5. Rebuild affected observation and AQI indexes through existing targeted paths.
6. Re-run integrity for that day.
7. Confirm the website still retrieves the complete logical history through the current request identity.
8. Keep the repair gate disabled in LIVE.

## Phase 13: system-documentation confirmation

ChatGPT in Chat mode reviews the implementation handover and actual repository changes.

Update active `system_docs/` only where implementation details differ from these already approved contracts. Codex must not edit them.

## Acceptance criteria

The plan is complete in TEST when:

- the service-only view provides deterministic date-valid continuity members;
- multi-member families are embedded in schema-v2 `timeseries_binding` objects;
- single-member exact-only bindings remain schema version 1 and avoid unnecessary churn;
- a request using any current or historical family `timeseries_id` resolves the complete family;
- the website sends only one timeseries ID and contains no SOS-specific mapping logic;
- low-level R2 APIs remain exact physical readers;
- the station-history Worker merges date-valid physical observation segments;
- visible AQI is calculated from those same observations;
- PM context crosses physical transitions correctly;
- the browser does not wait for stored R2 AQI;
- stored R2 AQI is validated asynchronously without affecting rendering;
- validation is bounded and algorithm-version aware;
- historical rollover repairs remain gated until deployment validation;
- repaired R2 rows retain historically correct physical identity;
- binding payloads remain byte-stable and Dropbox backup churn is family-scoped;
- no AQI rows are recreated in Supabase;
- no chart request modifies R2;
- all new behaviour can be disabled through configuration.

## Rollback

Normal rollback is configuration-first:

```text
UK_AQ_INTEGRITY_HISTORICAL_IDENTITY_REPAIR_ENABLED=false
UK_AQ_STATION_HISTORY_AQI_VALIDATION_MODE=off
UK_AQ_STATION_HISTORY_CALCULATED_HISTORY_AQI_ENABLED=false
UK_AQ_STATION_HISTORY_CONTINUITY_ENABLED=false
```

Then:

1. The website uses the retained separate R2 AQI compatibility path.
2. Station history returns to exact requested-timeseries behaviour.
3. Existing schema-v2 binding objects may remain unread by old consumers only if readers were made forwards-compatible before enablement; otherwise restore the previous Worker deployment before disabling continuity.
4. The continuity view can remain unused.
5. Do not delete or rewrite corrected historical R2 data merely to roll back chart behaviour.
6. No AQI database or bulk-data rollback is expected because this plan does not recreate AQI storage or let chart requests modify R2.
