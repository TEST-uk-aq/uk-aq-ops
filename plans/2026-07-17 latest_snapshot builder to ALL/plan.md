# Latest Snapshot Builder to `all` Only

- **Date:** 17 July 2026
- **Repository:** `TEST-uk-aq/uk-aq-ops`
- **Environment:** TEST only
- **Status:** Proposed direct cutover
- **Recommended coding model:** GPT-5.6 Codex with **High reasoning**

## 1. Purpose

Reduce the cost and repeated work of the every-minute Latest Snapshot Cloud Run builder by storing only one physical snapshot per pollutant:

```text
latest_snapshots/v2/network_group=all/pollutant=pm25/window=all.json
latest_snapshots/v2/network_group=all/pollutant=pm10/window=all.json
latest_snapshots/v2/network_group=all/pollutant=no2/window=all.json
```

Finite API windows remain available to the website:

```text
3h
6h
1d
7d
all
```

The Latest Snapshot R2 API Worker will derive the finite windows from each pollutant's stored `window=all` payload by filtering rows using the existing public `last_value_at` timestamp.

This is a direct TEST cutover. There will be no shadow family, compatibility prefix, feature flag, dual-read mode or extended comparison period.

## 2. Decision summary

### Current behaviour

The Cloud Run builder currently:

1. maintains latest-valid-per-timeseries state;
2. builds public rows containing `last_value_at` from the retained state's `observed_at`;
3. loops through three pollutants and five windows;
4. filters the same latest rows separately for each finite window;
5. writes up to 15 physical snapshot objects;
6. writes a manifest describing all 15 matrix entries.

The R2 API Worker currently maps each requested window directly to a matching physical R2 object.

### Target behaviour

The Cloud Run builder will:

1. continue maintaining exactly the same latest-valid state;
2. continue constructing exactly the same v2 rows;
3. build and write only `window=all` for `pm25`, `pm10` and `no2`;
4. write a manifest describing the three physical `all` objects;
5. retain the existing every-minute schedule, state handling, Pub/Sub acknowledgement, metadata resolution, sorting, cursor derivation, stable JSON, hash gating, overlap protection and timeout behaviour.

The R2 API Worker will:

1. continue accepting `window=3h|6h|1d|7d|all`;
2. always use the pollutant's physical `window=all` object as its source;
3. return `all` directly or derive a finite response using `last_value_at`;
4. preserve the existing public top-level fields, row fields, route, query parameters, authentication and v2 contract marker;
5. recalculate `window`, `count`, `next_since` and `next_since_id` for a finite response;
6. preserve the stored row ordering when filtering;
7. provide time-aware cache validation so rows can age out even when the source `all` object has not changed.

## 3. Why this is correct

The stored `all` payload is not raw observation history. It contains one latest valid public row per eligible timeseries.

Each row already contains:

```text
last_value_at
```

That value is derived from the retained latest state's:

```text
observed_at
```

The current finite snapshot objects are produced only by filtering those latest rows against a time cutoff. They do not contain a different observation, aggregation or calculation.

It is therefore safe for the read Worker to apply the same cutoff to the stored `all` rows.

## 4. Scope

### In scope

- `workers/uk_aq_latest_snapshot_r2_api_worker/worker.mjs`
- focused tests for the Latest Snapshot R2 API Worker
- `workers/uk_aq_latest_snapshot_cloud_run/run_job.ts`
- focused tests for Latest Snapshot builder matrix behaviour
- `.github/workflows/uk_aq_latest_snapshot_cloud_run_deploy.yml`
- other active, non-archive ops files that directly encode the physical Latest Snapshot window matrix
- direct deployment to TEST in the safe order defined below
- minimal operational validation through the real TEST system
- final authoritative `system_docs/latest_snapshot/` updates by ChatGPT

### Out of scope

- website code changes
- ingest repository changes
- schema repository changes
- raw observation publication or storage
- latest-state identity, eligibility or replacement rules
- Pub/Sub topic or subscription changes
- new pollutants
- new public window labels
- cache-proxy route changes unless an active contract dependency makes a small compatibility amendment unavoidable
- Cloud Run CPU, memory, concurrency, timeout, instance count or schedule changes
- run-report retention changes
- broader Latest Snapshot performance refactors
- AQI, WHO, history, prune or backup systems
- archive files
- LIVE deployment

## 5. Behaviour that must remain unchanged

The implementation MUST preserve:

- Latest Snapshot contract version `v2`;
- external route `/api/aq/latest-snapshot`;
- private route `/v1/latest-snapshot`;
- accepted query parameters `pollutant`, `window`, `network_group` and `scope`;
- accepted pollutants `pm25`, `pm10` and `no2`;
- accepted windows `3h`, `6h`, `1d`, `7d` and `all`;
- network group `all`;
- all existing top-level response fields;
- all existing v2 row fields and field meanings;
- `last_value_at` as the observation-time source for window eligibility;
- row sorting and ordering;
- cursor meaning;
- `X-UK-AQ-Snapshot-Contract: v2` on successful snapshot responses;
- upstream authentication and fail-closed configuration validation;
- the dedicated Latest Snapshot Pub/Sub subscription;
- latest-valid state behaviour and invalid-value handling;
- acknowledgement ordering;
- R2 state and metadata-cache keys;
- the family prefix `latest_snapshots/v2`;
- the manifest key `latest_snapshots/v2/manifest.json`;
- one-minute builder scheduling;
- Cloud Run overlap and child-timeout protections;
- cache-proxy public error and cache behaviour unless a targeted compatibility change is proven necessary.

## 6. Intentional contract changes

This plan intentionally changes the currently documented architecture in these ways:

1. The builder's physical matrix changes from 15 objects to three objects.
2. The builder manifest describes only physical `window=all` objects.
3. The R2 API Worker becomes responsible for finite-window filtering.
4. Finite-window response cache identity becomes time-dependent as well as source-object-dependent.
5. `UK_AQ_LATEST_SNAPSHOT_WINDOWS` no longer controls the builder's physical output matrix.

These changes require the authoritative system documentation to be updated after implementation. That documentation update is Phase 5 and must be completed by ChatGPT using the actual implementation diff.

## 7. Required structural check before implementation

A single targeted structural check is genuinely required before changing the manifest:

- Search active, non-archive code for consumers of `latest_snapshots/v2/manifest.json`, `/v1/manifest`, `matrix.windows`, snapshot manifest entries and finite physical object keys.

This is not a broad test exercise. It is needed to confirm whether any active runtime component assumes that the manifest contains 15 physical objects.

Expected result:

- the manifest describes the physical stored product;
- the public request contract remains owned by the R2 API Worker;
- no website change is required.

If an active ops consumer depends on the old 15-entry physical manifest, update that consumer narrowly in this plan. Do not preserve misleading virtual manifest entries merely to avoid updating an internal consumer.

---

# Phase 1: Derive finite windows in the R2 API Worker

## Objective

Change the Latest Snapshot R2 API Worker so every snapshot request reads the pollutant's physical `window=all` object. Finite windows are generated at request time from `last_value_at`.

The existing physical `all` objects already exist, so this Worker can be deployed before the builder changes.

## Required implementation

### Source object selection

For all accepted requests, build the R2 source key as:

```text
latest_snapshots/v2/network_group={network_group}/pollutant={pollutant}/window=all.json
```

Do not attempt to read the old finite physical object keys.

### `window=all`

For `window=all`, preserve the stored payload and normal source-object caching behaviour.

The implementation may stream the stored object directly for the lowest Worker CPU use, provided existing headers, HEAD requests, conditional requests and the v2 contract marker remain correct.

### Finite windows

For `3h`, `6h`, `1d` and `7d`:

1. read and parse the physical `all` payload;
2. validate that it has the expected v2 top-level structure and a `data` array;
3. calculate the effective current time at the start of the current UTC minute;
4. calculate the requested cutoff from that effective time;
5. keep only rows with a parseable `last_value_at` where:

```text
Date.parse(last_value_at) >= cutoff
```

6. preserve the source row order by filtering without re-sorting;
7. set the returned `window` to the requested finite window;
8. set `count` to the filtered row count;
9. recalculate `next_since` and `next_since_id` using the existing cursor meaning;
10. preserve `region`, `pcon_code`, `pollutant`, `since`, `since_id` and every row field;
11. return the normal v2 contract marker.

Rows with missing or unparseable `last_value_at` must not enter a finite response. They remain present in `all` only if the existing stored contract already allows them.

### Cursor derivation

Reproduce the builder's current cursor rule:

- `next_since` is the greatest valid `last_value_at` in the returned rows;
- `next_since_id` is the greatest eligible row `id` among rows sharing that timestamp;
- both are `null` for an empty result.

Do not derive the cursor from array position.

### Time-aware ETag

A finite response can change because time passes even when its source `all` object is unchanged.

For a finite response, derive a deterministic ETag from at least:

```text
source all-object ETag
requested window
effective UTC minute
```

A SHA-256 digest is appropriate.

This ETag must be used for `If-None-Match` and `304` handling.

For `window=all`, retain the physical source object's normal ETag.

### Caching

Retain the existing cache-control configuration and default 60-second behaviour.

The finite response identity must advance each UTC minute so a cached row cannot remain indefinitely after it crosses a window cutoff.

### Error handling

Preserve current validation errors for invalid pollutant, window and network group.

Return a clear bounded upstream/product error if the physical `all` object exists but cannot be parsed as the expected v2 snapshot payload. Do not fall back to an old finite object or to v1.

### HEAD requests

HEAD must return the same status and representation headers as GET but no response body.

For finite windows, it is acceptable to parse and construct the derived response in order to calculate the correct ETag and headers.

## Focused pre-deployment checks

A small deterministic check is genuinely required because time-window boundaries and cache validators are load-bearing.

Use the existing test structure where possible. Cover only:

1. `all` uses the physical `all` key;
2. a finite request also uses the physical `all` key;
3. rows before the cutoff are removed;
4. a row exactly on the cutoff remains included;
5. order is preserved;
6. `window`, `count`, `next_since` and `next_since_id` are recalculated correctly;
7. empty finite data returns null cursors;
8. malformed `last_value_at` is excluded from finite data;
9. the finite ETag changes when the effective minute changes;
10. the finite ETag changes when the source ETag changes;
11. matching `If-None-Match` returns `304`;
12. successful GET and HEAD responses retain the v2 marker.

Run only the focused Worker checks and syntax checks relevant to changed files. Do not run cloud operations or a broad repository test programme in this phase.

## Phase 1 acceptance

- Every accepted window request uses the physical `all` object as source.
- The public payload shape remains v2-compatible.
- Finite windows use `last_value_at` and a UTC-minute cutoff.
- Conditional caching remains correct as rows age out.
- No cache-proxy or website change is needed unless the structural check proves otherwise.

## Ready-to-use Codex prompt

```text
Use GPT-5.6 Codex with High reasoning.

Work only in TEST-uk-aq/uk-aq-ops. Read AGENTS.md, system_docs/README.md and the authoritative system_docs/latest_snapshot/ files first. The plan intentionally changes the current physical matrix and R2 API responsibilities, but do not update system_docs in this phase. ChatGPT will update the authoritative documentation in Phase 5 after seeing the actual implementation.

Implement Phase 1 of:
plans/2026-07-17 latest_snapshot builder to ALL/plan.md

Change workers/uk_aq_latest_snapshot_r2_api_worker/worker.mjs so all accepted requests use the pollutant's physical window=all R2 object. Return all directly where practical. For 3h, 6h, 1d and 7d, parse the all payload, filter by last_value_at using the start of the current UTC minute, preserve row order, and recalculate window, count, next_since and next_since_id.

Finite-response cache identity must include the source all-object ETag, requested window and effective UTC minute. Preserve If-None-Match, 304, HEAD, authentication, errors, Cache-Control and X-UK-AQ-Snapshot-Contract: v2. Never fall back to old finite objects or v1.

Before coding, perform only the targeted active-code search described in the plan to identify manifest or physical-key consumers. Report any real compatibility dependency. Do not inspect or modify archive code.

Add or amend only focused tests for finite filtering, cutoff inclusion, cursor recalculation, ETag time/source changes, 304 and HEAD/v2 headers. Run only relevant fast checks. Do not deploy, contact R2, change the website, change the cache proxy unless structurally required, update system_docs, commit, push or open a PR.

Finish with:
- files changed;
- structural consumer search result;
- behaviour preserved;
- focused checks run and results;
- any deployment consideration for Phase 4.
```

---

# Phase 2: Change the Cloud Run builder to publish only `all`

## Objective

Reduce the builder's physical output matrix from 15 objects to three while preserving state maintenance and the public row contract.

## Required implementation

### Physical builder matrix

The builder must build exactly:

```text
network_group=all, pollutant=pm25, window=all
network_group=all, pollutant=pm10, window=all
network_group=all, pollutant=no2, window=all
```

The builder must not calculate or write `3h`, `6h`, `1d` or `7d` objects.

### Builder configuration

Remove the finite window list as a configurable builder concern.

Preferred implementation:

- define the builder's physical windows as a code-owned constant containing only `all`;
- remove `UK_AQ_LATEST_SNAPSHOT_WINDOWS` parsing from the builder;
- remove or stop passing `UK_AQ_LATEST_SNAPSHOT_WINDOWS` in the Cloud Run deployment workflow;
- leave accepted public windows in the R2 API Worker.

Do not allow an old GitHub repository variable to restore the 15-object builder matrix accidentally.

### Efficient pollutant grouping

Since only one physical window exists, avoid repeatedly scanning all source rows where a simple grouping pass is clearer.

The builder should:

1. construct source rows exactly as now;
2. group rows by matrix pollutant once;
3. sort each pollutant's rows once using the existing sort;
4. derive the existing cursor;
5. build one `window=all` payload per pollutant;
6. retain stable JSON, SHA-256 and write-if-changed behaviour.

Do not alter row eligibility, metadata rules, display names, network fields or value policy.

### Manifest

The manifest must describe physical stored objects, not virtual API responses.

After cutover:

```text
matrix.pollutants = [pm25, pm10, no2]
matrix.windows = [all]
snapshots.length = 3
build.success_count = 3 when fully successful
```

Existing finite-window manifest entries from the previous manifest must not be copied into the new manifest.

A failed `all` matrix key should continue preserving its previous `all` manifest entry where the existing failure behaviour supports this.

Do not invent virtual object keys or pretend that finite responses are separately stored.

### Unchanged builder responsibilities

Do not change:

- state loading or schema;
- metadata loading or refresh;
- incoming value classification;
- state transition rules;
- state write gating;
- Pub/Sub pull limits;
- acknowledgement ordering or chunking;
- source row construction;
- stable row sort;
- cursor derivation;
- R2 signing and timeout behaviour;
- run reports;
- scheduler frequency;
- service resources;
- overlap lock or child watchdog.

### Previous finite objects

The builder does not need to delete the existing 12 finite-window objects.

They become inert stale objects because the new API Worker never reads them. Retaining them temporarily also leaves a simple TEST rollback path. Their storage cost is negligible compared with the removed every-minute build work.

Do not add R2 deletion logic to the builder.

## Focused pre-deployment checks

Use the existing builder tests where possible. Cover only:

1. the physical window list is exactly `all`;
2. three pollutants produce three payloads and three manifest entries;
3. the object keys end in `window=all.json`;
4. manifest `matrix.windows` equals `["all"]`;
5. the v2 payload shape, row order and cursor derivation remain unchanged;
6. an unchanged `all` payload still skips the R2 write;
7. a previous manifest containing finite entries does not retain them in the next manifest.

Run only focused relevant checks and syntax/type validation. Do not contact Pub/Sub, R2, Supabase or GCP.

## Phase 2 acceptance

- The builder has no finite-window loop.
- Each run produces at most three changed snapshot object writes.
- The manifest reports three physical objects.
- State, Pub/Sub and metadata behaviour are unchanged.
- Old finite physical files are ignored and not deleted.

## Ready-to-use Codex prompt

```text
Use GPT-5.6 Codex with High reasoning.

Work only in TEST-uk-aq/uk-aq-ops. Read AGENTS.md, system_docs/README.md and the authoritative system_docs/latest_snapshot/ files first. Do not update system_docs. ChatGPT owns the Phase 5 documentation update after the implementation and TEST outcome are known.

Implement Phase 2 of:
plans/2026-07-17 latest_snapshot builder to ALL/plan.md

Change workers/uk_aq_latest_snapshot_cloud_run/run_job.ts so the physical builder matrix contains only window=all for pm25, pm10 and no2. Remove finite-window calculation and prevent UK_AQ_LATEST_SNAPSHOT_WINDOWS or an old GitHub variable from restoring the old matrix. Amend .github/workflows/uk_aq_latest_snapshot_cloud_run_deploy.yml accordingly.

Group source rows by pollutant once, preserve the existing row sort and cursor rules, and build only three stable v2 payloads. The manifest must represent the three physical all objects, with matrix.windows=["all"]. Do not create virtual finite manifest entries.

Preserve all latest-valid state, invalid-value policy, metadata eligibility, Pub/Sub acknowledgement, R2 write-if-changed, run-report, schedule, resource, overlap and timeout behaviour. Do not delete the old finite R2 objects.

Add or amend only focused tests for the three-object matrix, keys, manifest, stable payload behaviour and removal of old finite manifest entries. Run only relevant fast checks. Do not deploy, contact external systems, change the R2 API Worker beyond any small issue found while integrating Phase 1, update system_docs, commit, push or open a PR.

Finish with:
- files changed;
- exact physical matrix after the change;
- behaviour preserved;
- focused checks run and results;
- any deployment consideration for Phase 4.
```

---

# Phase 3: Align active configuration and integration boundaries

## Objective

Review the combined Phase 1 and Phase 2 diff and remove stale active configuration assumptions without broadening the change.

## Required work

### Active-code integration review

Inspect active, non-archive references to:

```text
UK_AQ_LATEST_SNAPSHOT_WINDOWS
window=3h.json
window=6h.json
window=1d.json
window=7d.json
manifest.matrix.windows
manifest.snapshots
/v1/manifest
```

Classify each reference as:

- builder physical configuration;
- R2 API accepted public window configuration;
- internal manifest consumer;
- test fixture;
- documentation to leave for ChatGPT Phase 5;
- historical/archive reference to ignore.

### Expected ownership after cutover

- Cloud Run builder owns only physical `all` output.
- R2 API Worker owns accepted finite window labels and time filtering.
- Cache proxy continues forwarding the query unchanged.
- Website continues requesting the same public windows.
- Manifest describes stored objects only.

### Configuration cleanup

Remove stale active builder-only window configuration where it can mislead or re-enable finite builds.

Do not remove public window validation from the R2 API Worker.

Do not edit `system_docs` in this phase.

Do not make a website or cache-proxy change merely to tidy naming.

### Minimal combined checks

Run only:

- syntax/type checks for changed runtime files;
- focused Latest Snapshot Worker tests;
- focused Latest Snapshot builder tests;
- any existing fast contract check directly covering the v2 top-level and row fields.

Do not add a broad pre-deployment suite. Do not run unrelated repository tests.

## Phase 3 acceptance

- No active builder configuration can recreate finite physical snapshots accidentally.
- Finite public windows remain accepted by the R2 API Worker.
- No active consumer relies on the old 15-entry physical manifest without being adapted.
- The combined diff is limited to Latest Snapshot runtime, focused tests and deployment configuration.
- `system_docs` remains untouched for ChatGPT Phase 5.

## Ready-to-use Codex prompt

```text
Use GPT-5.6 Codex with High reasoning.

Work only in TEST-uk-aq/uk-aq-ops. Review the completed Phase 1 and Phase 2 changes against Phase 3 of:
plans/2026-07-17 latest_snapshot builder to ALL/plan.md

Search only active, non-archive code and configuration for UK_AQ_LATEST_SNAPSHOT_WINDOWS, finite physical object keys, manifest.matrix.windows, manifest.snapshots and /v1/manifest consumers. Confirm the target ownership: builder stores only all; R2 API Worker derives finite windows; cache proxy and website request contract remain unchanged; manifest describes physical objects.

Remove only stale active builder configuration or internal assumptions that would break that design. Adapt an active ops manifest consumer only if one actually exists. Do not create virtual manifest entries. Do not edit archive files, website code, ingest, schema or system_docs.

Run only syntax/type checks, focused Latest Snapshot API Worker tests, focused builder tests and an existing fast v2 contract check if directly applicable. Do not deploy or contact external systems.

Finish with:
- active references found and classification;
- files changed;
- confirmation that no active builder path can publish finite objects;
- confirmation that the public API still accepts all five windows;
- checks run and results;
- exact deployment order for Phase 4.
```

---

# Phase 4: Direct TEST cutover and minimal operational validation

## Objective

Deploy the new architecture directly to TEST with no shadow mode and perform only the minimum real-system checks needed to catch a broken cutover.

## Deployment order

### Step 1: Deploy the R2 API Worker first

Deploy:

```text
workers/uk_aq_latest_snapshot_r2_api_worker/
```

The existing physical `window=all` objects allow the new Worker to serve every public window immediately.

Do not deploy the builder first. The old API Worker would continue expecting finite physical objects that the new builder would stop updating.

### Step 2: Minimal API Worker check

Before deploying the builder, make two representative TEST requests through the normal public cache-proxy route:

```text
pollutant=pm25&window=all&network_group=all
pollutant=pm25&window=3h&network_group=all
```

Confirm only:

- both return HTTP 200;
- both return the v2 top-level fields;
- the finite count is not greater than the all count;
- every finite row has a parseable `last_value_at` within the three-hour cutoff, allowing for the current UTC-minute boundary;
- the website can load the representative latest-snapshot view.

Do not perform an extended before/after dataset comparison.

### Step 3: Deploy the Cloud Run builder

Deploy:

```text
workers/uk_aq_latest_snapshot_cloud_run/
```

Keep the current one-minute scheduler and existing service settings.

### Step 4: Observe one normal scheduled run

Confirm only:

- the scheduled request completes successfully;
- the run reports `success_count=3` and `failure_count=0`;
- the manifest has `matrix.windows=["all"]`;
- the manifest has three snapshot entries;
- all three object keys end with `window=all.json`;
- the dedicated Pub/Sub backlog is not increasing due to failed acknowledgement;
- no new timeout, overlap, metadata or R2 errors appear.

One successful normal scheduled run is sufficient for this TEST cutover unless it reveals a problem.

### Step 5: One post-builder public check

Repeat one finite request and one `all` request for a representative pollutant.

Confirm:

- the finite API still works after the manifest changes to three physical entries;
- top-level and row fields remain unchanged;
- `X-UK-AQ-Snapshot-Contract: v2` remains present on the private upstream response or is accepted by the cache proxy;
- the website map/search path loads normally.

### Step 6: Stop and hand back to ChatGPT

Do not update `system_docs` in Codex.

Return to ChatGPT with:

- final branch or commit diff;
- exact files changed;
- deployment workflow run results;
- one builder summary log;
- the new manifest shape;
- the representative `all` and finite response summaries;
- any deviation from the plan.

ChatGPT will then perform Phase 5.

## Old finite R2 objects

Do not delete the 12 old finite-window objects during this cutover.

They are no longer read and no longer updated. Keeping them temporarily:

- has negligible storage cost;
- does not reduce the compute saving;
- provides a simple rollback source for the previous Worker revision;
- avoids adding a deletion operation to a minimal TEST cutover.

Their later deletion can be considered separately after the new design is documented and accepted.

## Rollback

If the API Worker fails before the builder deployment:

1. roll back the R2 API Worker to the previous revision;
2. leave the existing builder unchanged.

If a problem appears after both deployments:

1. roll back the builder to the previous revision so finite physical objects resume updating;
2. roll back the R2 API Worker to the previous revision;
3. confirm the previous finite objects are readable;
4. investigate on TEST.

Do not modify latest state or raw observations as part of rollback.

## Phase 4 acceptance

- New Worker deployed before new builder.
- One scheduled builder run succeeds with three physical matrix entries.
- One representative finite response and one `all` response work through the normal TEST path.
- Website map/search remains functional.
- Pub/Sub acknowledgement remains healthy.
- No extended soak or broad manual test programme is required.

## Ready-to-use Codex prompt

```text
Use GPT-5.6 Codex with High reasoning.

Perform Phase 4 of:
plans/2026-07-17 latest_snapshot builder to ALL/plan.md

This is a direct TEST cutover with minimal operational validation. Follow AGENTS.md and do not touch LIVE.

Deploy the Latest Snapshot R2 API Worker first. Make only the representative all and 3h checks defined in the plan through the normal TEST cache-proxy route. Then deploy the Latest Snapshot Cloud Run builder without changing its schedule or service resources.

Observe one normal scheduled builder run. Confirm success_count=3, failure_count=0, matrix.windows=["all"], three manifest entries, all keys ending window=all.json, and no Pub/Sub acknowledgement, timeout, metadata or R2 error. Repeat one representative all and finite public request and confirm the website path loads.

Do not delete old finite R2 objects. Do not run an extended comparison, broad test suite, backfill or soak period. Do not change website, ingest, schema, cache-proxy behaviour or system_docs. Do not deploy LIVE.

Stop after the minimal checks and return:
- exact revisions deployed;
- workflow results;
- one builder summary log;
- manifest summary;
- representative all and finite response counts and cutoff result;
- website check result;
- any deviation or error;
- final files changed.

The next phase belongs to ChatGPT, not Codex.
```

---

# Phase 5: ChatGPT updates the authoritative Latest Snapshot system documentation

## Owner

**ChatGPT must perform this phase.**

Codex must not pre-emptively rewrite the authoritative documentation because the documents must describe the actual final code and TEST behaviour, not the proposed implementation.

The user should return to ChatGPT after Phase 4 with the implementation diff and minimal deployment evidence.

## Objective

Update the authoritative `system_docs/latest_snapshot/` area so it accurately describes the all-only physical builder and dynamically filtered finite API windows.

This documentation work should be completed on the same implementation branch or before the implementation is merged, in accordance with `system_docs/documentation_contract.md`.

## Documents ChatGPT must inspect and amend

At minimum:

```text
system_docs/latest_snapshot/README.md
system_docs/latest_snapshot/contract.md
system_docs/latest_snapshot/data_flow.md
system_docs/latest_snapshot/interfaces.md
system_docs/latest_snapshot/operations.md
system_docs/latest_snapshot/validation.md
```

Inspect and amend where needed:

```text
system_docs/latest_snapshot/state_model.md
system_docs/latest_snapshot/recovery.md
system_docs/latest_snapshot/decisions/
system_docs/migration_inventory.md
system_docs/uk-aq-latest-snapshot.md
workers/uk_aq_latest_snapshot_cloud_run/README.md
workers/uk_aq_latest_snapshot_r2_api_worker/README.md
```

Worker-local READMEs are implementation guides rather than authoritative contracts, but they should not contradict the updated authoritative area.

## Required documentation changes

The final documentation must state clearly that:

1. The Latest Snapshot state remains latest-valid-per-timeseries state.
2. `observed_at` remains persisted in state and is exposed publicly as `last_value_at`.
3. The Cloud Run builder stores only one physical `window=all` snapshot per supported pollutant.
4. The physical snapshot family contains three objects, not 15.
5. The manifest describes the three physical stored objects.
6. The public R2 API still accepts `3h`, `6h`, `1d`, `7d` and `all`.
7. The R2 API Worker reads the pollutant's physical `all` object for every request.
8. Finite responses are filtered using `last_value_at` and the start of the current UTC minute.
9. Filtering preserves row order and recalculates `count`, `next_since` and `next_since_id`.
10. Finite response ETags include the source object identity, requested window and effective UTC minute.
11. Rows can age out of finite responses even when the physical `all` object has not changed.
12. The cache proxy and website request contract are unchanged.
13. The v2 top-level and row field contracts are unchanged.
14. The one-minute builder schedule is unchanged.
15. Old finite objects may remain temporarily but are inert and must not be treated as current products.
16. Rollback order is builder first, then API Worker, when both new revisions have been deployed.

## Architecture decision record

ChatGPT should add a new ADR, expected title:

```text
ADR 0002: finite Latest Snapshot windows are derived from the physical all snapshot
```

The ADR should record:

- why storing five filtered copies was rejected;
- why `last_value_at` is sufficient;
- why filtering belongs in the R2 API Worker;
- the Cloud Run cost and repeated-work benefit;
- the Cloudflare request-time CPU trade-off;
- the time-aware cache consequence;
- why the public contract remains v2;
- why the manifest describes physical products rather than virtual API variants;
- why old finite objects are not runtime fallbacks.

## Validation document

Replace the previous requirement that all 15 physical objects remain represented.

The updated TEST acceptance should require only:

- three physical `all` objects;
- a three-entry physical manifest;
- successful public responses for all accepted windows;
- finite-window cutoff correctness;
- unchanged v2 response fields;
- healthy normal builder and Pub/Sub operation;
- normal website map/search loading.

Keep validation focused. Do not introduce a large speculative test programme.

## Phase 5 acceptance

- All active authoritative Latest Snapshot documents agree with the actual deployed architecture.
- No active document claims that the builder writes 15 current objects.
- No active document claims that the R2 API Worker merely streams a separately stored finite object.
- The difference between physical stored windows and public served windows is explicit.
- The public v2 contract and latest-valid state rules remain clearly protected.
- The new ADR records the reason for the architecture change.

---

# Final acceptance criteria for the whole plan

The direct cutover is complete when:

1. The builder writes only three current snapshot objects, all with `window=all`.
2. The builder manifest contains only those three physical objects.
3. The API continues serving `3h`, `6h`, `1d`, `7d` and `all`.
4. Finite windows are derived from `last_value_at` using the current UTC-minute cutoff.
5. Finite responses preserve row order and return correct counts and cursors.
6. Finite cache identity changes with source object, requested window and effective minute.
7. The external route, query contract, v2 fields and website behaviour remain unchanged.
8. Latest-valid state, Pub/Sub acknowledgement and metadata behaviour remain unchanged.
9. One normal TEST scheduled run and representative public requests succeed.
10. ChatGPT has updated the authoritative Latest Snapshot system documentation and added the architecture decision record.

# Expected result

The every-minute Cloud Run builder reduces its repeated snapshot matrix work from 15 physical variants to three, while the website continues receiving the same five public freshness windows from the Cloudflare read path.