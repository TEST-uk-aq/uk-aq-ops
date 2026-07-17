# Latest Snapshot Builder to `all` Only

- **Date:** 17 July 2026
- **Repository:** `TEST-uk-aq/uk-aq-ops`
- **Environment:** TEST only
- **Status:** Proposed direct cutover
- **Recommended coding model:** GPT-5.6 Codex with **High reasoning**

## Purpose

Reduce the repeated work and Cloud Run cost of the every-minute Latest Snapshot builder by storing only one physical snapshot per pollutant:

```text
latest_snapshots/v2/network_group=all/pollutant=pm25/window=all.json
latest_snapshots/v2/network_group=all/pollutant=pm10/window=all.json
latest_snapshots/v2/network_group=all/pollutant=no2/window=all.json
```

The public API continues serving `3h`, `6h`, `1d`, `7d` and `all`.

The Latest Snapshot R2 API Worker derives finite windows from the relevant physical `window=all` payload by filtering rows using the existing public `last_value_at` timestamp.

This is a direct TEST cutover. There will be no shadow family, compatibility prefix, dual-read mode, soak period or extended comparison.

## TEST validation policy for this plan

This plan follows `AGENTS.md`.

- Perform as little pre-deployment testing as reasonably possible.
- Before deployment, establish only that changed code and configuration are structurally viable.
- Do not create new automated tests by default.
- Reuse at most one directly relevant existing fast check if it is already available and genuinely useful.
- Do not run broad test suites, exhaustive edge cases, large fixture programmes, shadow comparisons or soak testing.
- Functional validation happens through normal operation on TEST.
- For this reversible change, one representative public output check and one successful normal builder run are sufficient unless either exposes a problem.

The only required pre-implementation check is an active-code search for consumers of the physical manifest or finite object keys. This prevents breaking a real internal dependency when the manifest changes from 15 entries to three.

## Current and target behaviour

### Current

The builder maintains latest-valid-per-timeseries state, creates rows containing `last_value_at`, then builds three pollutants across five windows. The finite objects are only timestamp-filtered copies of the same latest rows.

The R2 API Worker currently maps the requested window directly to a matching physical R2 object.

### Target

The builder will:

1. preserve the same latest-valid state and v2 rows;
2. build only `window=all` for `pm25`, `pm10` and `no2`;
3. write a three-entry physical manifest;
4. preserve Pub/Sub acknowledgement, metadata resolution, sorting, cursor derivation, stable JSON, hash gating, scheduling, overlap protection and timeout behaviour.

The R2 API Worker will:

1. continue accepting all five public windows;
2. always read the pollutant's physical `window=all` object;
3. return `all` directly or filter it for a finite window;
4. preserve the route, query parameters, top-level fields, row fields, authentication and v2 marker;
5. recalculate `window`, `count`, `next_since` and `next_since_id` for finite responses;
6. preserve stored row order;
7. use time-aware finite-response ETags so rows age out even when no new observation arrives.

## Why this is correct

The physical `all` object is not raw history. It contains one latest valid row per eligible timeseries.

`last_value_at` is already derived from retained state `observed_at`. The current finite files contain no separate aggregation or observation. They are only filtered copies of the same rows.

## Cost and storage impact

- Cloud Run work falls from 15 physical matrix variants to three.
- Cloudflare Worker CPU rises slightly for uncached finite responses because it parses and filters one pollutant payload.
- The normal 60-second cache prevents repeating that work for every request.
- Old finite R2 objects remain temporarily but are no longer read or updated.
- Supabase billable egress is unchanged.
- Database size and schema are unchanged.

## Scope

### In scope

- `workers/uk_aq_latest_snapshot_r2_api_worker/worker.mjs`
- `workers/uk_aq_latest_snapshot_cloud_run/run_job.ts`
- `.github/workflows/uk_aq_latest_snapshot_cloud_run_deploy.yml`
- active non-archive ops files that directly encode the physical window matrix
- existing directly relevant tests only if a very small amendment is genuinely required
- direct TEST deployment in the order below
- minimal real-operation validation
- final authoritative documentation update by ChatGPT

### Out of scope

- website, ingest or schema code
- raw observation publication or storage
- latest-state identity, eligibility or replacement rules
- Pub/Sub topics or subscriptions
- new pollutants or public windows
- Cloud Run resource, timeout, concurrency or schedule changes
- run-report retention changes
- broader performance refactors
- archive files
- deletion of old finite R2 objects
- LIVE deployment
- new automated test coverage unless a specific high-risk regression cannot reasonably be detected through TEST operation

## Behaviour that must remain unchanged

Preserve:

- contract version `v2`;
- `/api/aq/latest-snapshot` and `/v1/latest-snapshot`;
- query parameters and accepted values;
- all existing top-level and row fields;
- `last_value_at` as the window timestamp;
- row ordering and cursor meaning;
- `X-UK-AQ-Snapshot-Contract: v2`;
- authentication and fail-closed behaviour;
- dedicated Latest Snapshot Pub/Sub subscription;
- latest-valid state and invalid-value handling;
- acknowledgement ordering and chunking;
- R2 state, metadata and manifest keys;
- one-minute scheduling;
- overlap and child-timeout protection;
- cache-proxy route and errors.

## Required structural search

Search active, non-archive code for:

```text
latest_snapshots/v2/manifest.json
/v1/manifest
matrix.windows
manifest.snapshots
window=3h.json
window=6h.json
window=1d.json
window=7d.json
UK_AQ_LATEST_SNAPSHOT_WINDOWS
```

If a real active ops consumer depends on the old structure, adapt only that consumer. Do not create virtual finite manifest entries. Do not inspect or edit archive code.

---

# Phase 1: Derive finite windows in the R2 API Worker

## Implementation

For every accepted request, read:

```text
latest_snapshots/v2/network_group={network_group}/pollutant={pollutant}/window=all.json
```

For `window=all`, return the stored payload directly where practical, preserving source ETag, conditional `304`, HEAD behaviour, cache headers and v2 marker.

For `3h`, `6h`, `1d` and `7d`:

1. parse the physical `all` payload;
2. confirm the expected v2 structure and `data` array;
3. use the start of the current UTC minute as effective current time;
4. retain rows where `last_value_at` is parseable and at or after the requested cutoff;
5. preserve row order;
6. set the requested `window`;
7. recalculate `count`, `next_since` and `next_since_id`;
8. preserve every other top-level and row field.

Rows with missing or invalid `last_value_at` do not appear in finite responses.

The finite ETag must be deterministic from at least:

```text
source all-object ETag
requested window
effective UTC minute
```

Use it for `If-None-Match` and `304`. Never fall back to old finite objects or v1.

## Minimal pre-deployment validation

- Complete the required active-code search.
- Run only the smallest syntax or module-parse check for the changed Worker.
- Use at most one existing directly relevant fast check if already available.
- Do not create new tests by default or contact external services.

## Acceptance

- all accepted windows use the physical `all` source;
- finite filtering uses `last_value_at` and the UTC-minute cutoff;
- finite count and cursors are recalculated;
- time-aware conditional caching works structurally;
- the v2 public shape is preserved.

## Codex prompt

```text
Use GPT-5.6 Codex with High reasoning.

Work only in TEST-uk-aq/uk-aq-ops. Read AGENTS.md and the authoritative latest_snapshot system docs for context. Do not edit system_docs. ChatGPT owns Phase 5.

Implement Phase 1 of plans/2026-07-17 latest_snapshot builder to ALL/plan.md.

First perform the single active, non-archive consumer search in the plan. Report any real dependency on the old 15-entry manifest or finite physical keys.

Change the Latest Snapshot R2 API Worker so every accepted request reads the pollutant's physical window=all object. Return all directly where practical. Derive finite windows by filtering last_value_at at the start of the current UTC minute, preserving order and recalculating window, count, next_since and next_since_id.

Finite ETags must include source ETag, requested window and effective UTC minute. Preserve If-None-Match, 304, HEAD, authentication, errors, Cache-Control and the v2 marker. Never fall back to old finite objects or v1.

Follow the TEST validation policy. Do not create new automated tests by default. Run only the smallest syntax/module check and, at most, one existing directly relevant fast check. Do not deploy or contact external systems.

Finish with files changed, structural-search result, behaviour preserved, minimal checks run and any deployment note.
```

---

# Phase 2: Make the builder publish only `all`

## Implementation

Build exactly:

```text
network_group=all, pollutant=pm25, window=all
network_group=all, pollutant=pm10, window=all
network_group=all, pollutant=no2, window=all
```

Do not calculate or write finite objects.

- Make the builder's physical window a code-owned `all` value.
- Remove `UK_AQ_LATEST_SNAPSHOT_WINDOWS` parsing from the builder.
- Remove or stop passing it in the Cloud Run deployment workflow.
- Keep all public window validation in the R2 API Worker.
- Group source rows by pollutant once.
- Sort each pollutant once using the existing sort.
- Preserve current cursor, stable JSON, SHA-256 and write-if-changed behaviour.

The manifest must describe physical products only:

```text
matrix.pollutants = [pm25, pm10, no2]
matrix.windows = [all]
snapshots.length = 3
build.success_count = 3 when fully successful
```

Do not retain old finite manifest entries or create virtual entries. Do not delete the old finite objects.

## Minimal pre-deployment validation

- Run only the smallest syntax, type, module or workflow-parse check.
- Use at most one existing directly relevant fast check if already available.
- Do not create new tests by default or contact Pub/Sub, R2, Supabase or GCP.

## Acceptance

- no finite-window builder loop remains;
- at most three physical snapshot objects are written;
- the manifest contains three physical entries;
- state, Pub/Sub, metadata and runtime safety behaviour are unchanged.

## Codex prompt

```text
Use GPT-5.6 Codex with High reasoning.

Implement Phase 2 of plans/2026-07-17 latest_snapshot builder to ALL/plan.md in TEST-uk-aq/uk-aq-ops. Do not edit system_docs.

Change the builder so the physical matrix contains only window=all for pm25, pm10 and no2. Remove finite-window calculation and prevent UK_AQ_LATEST_SNAPSHOT_WINDOWS or an old repository variable from restoring the old matrix. Amend the Cloud Run deployment workflow accordingly.

Group source rows by pollutant once, preserve existing sort and cursor rules, and build three stable v2 payloads. The manifest must contain the three physical all objects and matrix.windows=["all"]. Do not create virtual finite entries or delete old finite objects.

Preserve latest-valid state, invalid-value policy, metadata eligibility, Pub/Sub acknowledgement, R2 write gating, run reports, schedule, resources, overlap and timeout behaviour.

Follow the TEST validation policy. Do not create new tests by default. Run only the smallest structural checks and, at most, one existing directly relevant fast check. Do not deploy or contact external systems.

Finish with files changed, exact physical matrix, behaviour preserved, minimal checks and deployment notes.
```

---

# Phase 3: Align active configuration

Review active, non-archive references to the old window variable, finite object keys and manifest assumptions.

Expected ownership:

- builder owns three physical `all` objects;
- R2 API Worker owns all five public windows and finite filtering;
- cache proxy forwards queries unchanged;
- website requests remain unchanged;
- manifest describes physical objects only.

Remove only stale active configuration or a real internal assumption that breaks this design.

## Minimal combined validation

Run only syntax, type, module and workflow parsing needed for changed files, plus at most one existing directly relevant fast contract check. Do not add tests or run unrelated suites.

## Acceptance

- no active builder configuration can restore finite physical outputs;
- all five public windows remain accepted;
- no active consumer depends on the old manifest without adaptation;
- the diff remains limited to Latest Snapshot runtime and configuration.

---

# Phase 4: Direct TEST cutover

This phase explicitly authorises the required TEST deployments. It does not authorise LIVE changes.

## Deployment order

### 1. Deploy the R2 API Worker first

The existing physical `all` objects allow immediate finite responses.

### 2. Make one representative public check

Request through the normal TEST cache-proxy route:

```text
pollutant=pm25&window=3h&network_group=all
```

Confirm only:

- HTTP 200;
- v2 top-level structure;
- returned rows have parseable `last_value_at` within the three-hour UTC-minute cutoff.

If it fails, roll back the Worker and stop. Do not perform a full matrix comparison.

### 3. Deploy the Cloud Run builder

Keep the existing schedule and service resources.

### 4. Observe one normal scheduled run

Confirm only:

- the request succeeds;
- `success_count=3`;
- `failure_count=0`;
- `matrix.windows=["all"]`;
- the manifest contains three entries;
- all keys end in `window=all.json`;
- Pub/Sub backlog is not growing because acknowledgement failed;
- no new timeout, metadata or R2 error appears.

One successful normal run is sufficient.

### 5. Make one representative website check

Load the normal TEST map or search path once and confirm Latest Snapshot data displays.

Do not run a soak period or broad manual regression exercise.

### 6. Handover to ChatGPT

Return the final diff, files changed, workflow results, one builder summary, manifest summary, representative response result, website result and any deviation.

## Rollback

If only the Worker has been deployed, roll back the Worker.

If both have been deployed:

1. roll back the builder so finite files resume updating;
2. roll back the Worker;
3. confirm the previous route works.

Do not modify latest state or raw observations.

## Acceptance

- Worker deployed before builder;
- one representative finite response succeeds;
- one normal builder run succeeds with three objects;
- one website output check succeeds;
- acknowledgement remains healthy;
- no broad testing, shadow mode or soak period is performed.

## Codex prompt

```text
Use GPT-5.6 Codex with High reasoning.

Perform Phase 4 of plans/2026-07-17 latest_snapshot builder to ALL/plan.md. This explicitly authorises the required TEST deployments. Do not touch LIVE.

Deploy the Latest Snapshot R2 API Worker first. Make only one representative pm25 3h request through the normal TEST cache-proxy route and confirm HTTP 200, v2 structure and last_value_at values inside the three-hour UTC-minute cutoff.

If that succeeds, deploy the Cloud Run builder without changing schedule or resources. Observe one normal scheduled run and confirm success_count=3, failure_count=0, matrix.windows=["all"], three manifest entries, all keys ending window=all.json, healthy Pub/Sub acknowledgement and no new timeout, metadata or R2 error.

Then load the normal TEST map or search path once and confirm Latest Snapshot data displays.

Do not delete old finite objects. Do not run broad tests, all-window comparisons, full pollutant comparisons, shadow mode, backfills or a soak period. Do not update system_docs.

Return exact revisions, workflow results, one builder summary, manifest summary, representative finite response result, website result, files changed and any deviation. Phase 5 belongs to ChatGPT.
```

---

# Phase 5: ChatGPT updates the authoritative system documentation

## Owner

**ChatGPT must perform this phase.** Codex must not edit `system_docs`.

After Phase 4, ChatGPT must inspect and update at least:

```text
system_docs/latest_snapshot/README.md
system_docs/latest_snapshot/contract.md
system_docs/latest_snapshot/data_flow.md
system_docs/latest_snapshot/interfaces.md
system_docs/latest_snapshot/operations.md
system_docs/latest_snapshot/validation.md
```

Also inspect `state_model.md`, `recovery.md`, decisions, migration inventory, the old flat document and both worker READMEs where relevant.

The documentation must state that:

1. latest state remains latest-valid-per-timeseries;
2. state `observed_at` is exposed as `last_value_at`;
3. the builder stores three physical `window=all` objects;
4. the manifest describes those three objects;
5. the API still accepts all five public windows;
6. the Worker reads `all` and derives finite responses;
7. finite filtering uses the current UTC-minute cutoff;
8. filtering preserves order and recalculates count and cursors;
9. finite ETags include source identity, window and effective minute;
10. rows can age out without a new physical object;
11. cache-proxy and website contracts remain unchanged;
12. old finite objects are inert and are not fallbacks;
13. TEST validation is intentionally minimal under `AGENTS.md`.

Add:

```text
ADR 0002: finite Latest Snapshot windows are derived from the physical all snapshot
```

The updated validation document should require only:

- three physical objects and a three-entry manifest;
- one representative finite response;
- one successful normal builder run;
- unchanged v2 fields;
- healthy Pub/Sub operation;
- one successful website map or search check.

Do not introduce a broad speculative test programme.

# Final acceptance

The cutover is complete when:

1. the builder writes only three current `window=all` objects;
2. the manifest contains those three entries;
3. the API still serves all five windows;
4. finite responses derive from `last_value_at` at the UTC-minute cutoff;
5. finite count, order and cursors are correct;
6. public v2 routes and fields remain unchanged;
7. latest-valid state and acknowledgement remain unchanged;
8. one representative finite request succeeds;
9. one normal TEST builder run succeeds;
10. one TEST website output check succeeds;
11. ChatGPT updates the authoritative documentation and ADR.
