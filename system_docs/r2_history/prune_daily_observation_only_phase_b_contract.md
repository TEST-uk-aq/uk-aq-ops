# Prune Daily observation-only Phase B contract

## Authority and scope

This document is an authoritative narrow amendment to:

- [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md);
- [`implementation_safety_contract.md`](implementation_safety_contract.md);
- [`prune_connector_day_gate.md`](prune_connector_day_gate.md).

Where those documents require AQI work as part of normal Prune Daily Phase B completion, this contract defines the permitted observation-only operating mode.

The first implementation and operational acceptance belong in the UK AQ TEST system. LIVE remains unchanged until the user explicitly requests a separate LIVE change.

## Purpose

The current target R2 deployment may intentionally contain only canonical observation history while calculated AQI history is deferred.

Prune Daily must therefore be able to:

- write and verify canonical R2 v2 observations;
- build and verify observation manifests and targeted indexes;
- complete connector-day observation deletion gates;
- complete observation day finalisation;
- allow safe IngestDB observation pruning;
- skip every calculated AQI write and finalisation step without treating the skip as a failure.

This is a temporary operating mode, not a second AQI implementation.

## Configuration decision

No new secret, repository variable or environment variable is introduced.

The mode is selected by the existing internal runtime property in:

```text
workers/uk_aq_prune_daily/phase_b_history_r2.mjs
```

For observation-only operation it is set to:

```javascript
phase_b_calculate_aqi_from_observations_enabled: false,
```

For normal observation-derived AQI operation it is set to `true`.

The property remains an internal implementation switch. It must not select a legacy AQI RPC exporter, v1 writer or other fallback.

The active observation history version remains canonical R2 v2.

## Required observation-only behaviour

When `phase_b_calculate_aqi_from_observations_enabled` is `false`, Phase B must continue the complete observation-retention path unchanged:

1. discover and process eligible connector-day candidates;
2. freeze and validate canonical IngestDB observations;
3. write and verify observation Parquet and pollutant manifests;
4. write and verify the observation connector manifest;
5. build and verify connector-targeted observation indexes;
6. complete the exact connector-day prune gate with `completion_source=prune_daily_phase_b`;
7. merge and verify the canonical observation day manifest;
8. complete observation-based aggregate day evidence where retained;
9. permit deletion only through the existing valid connector-day gate and source-identity checks.

The observation-only mode must not weaken any observation hash, verification-status, physical file-identity, source-identity, locking, deletion-atomicity or byte-stability requirement.

## Required AQI skip behaviour

When the switch is `false`, Phase B must not invoke or create any calculated AQI work for the affected candidate or day.

It must skip:

- observation-derived AQI row calculation;
- the PM rolling-context RPC;
- AQI data Parquet writes;
- AQI debug Parquet writes;
- AQI pollutant manifests;
- AQI connector manifests, including empty connector manifests;
- AQI day manifests;
- connector-targeted AQI indexes;
- AQI global or latest index updates.

Existing AQI objects already present in R2 are outside this change. Observation-only Prune Daily must not delete, rewrite, invalidate or adopt them.

The skip must be represented explicitly in structured output, using a stable reason equivalent to:

```text
aqilevels_disabled
```

A deliberate disabled result is not an AQI failure and must not be added to aggregate failure collections.

## Candidate processing

The candidate path must guard the call that derives and writes AQI from the frozen observation source.

When disabled:

- observation processing and connector-gate completion continue;
- the candidate AQI result records `status=skipped` and `reason=aqilevels_disabled`, or an equivalent stable structure;
- no AQI lock, context, calculation, object-write or index adapter is called.

When enabled:

- the existing observation-derived AQI path remains reachable;
- its current failure separation remains unchanged;
- an AQI-only failure does not revoke a verified observation connector gate.

## Day finalisation

Observation day finalisation must not call an AQI day finaliser when AQI is disabled.

When disabled:

- the canonical observation day manifest is still merged and verified;
- the aggregate observation day gate may complete from the verified merged observation manifest;
- returned day evidence records AQI as deliberately skipped;
- no AQI day manifest or AQI index is required for observation completion or deletion.

When enabled:

- existing AQI data/debug day-manifest and index finalisation remains required by the broader AQI history contract.

The implementation must not call a function whose precondition requires AQI to be enabled and then rely on catching its error. The disabled branch must be explicit before the call.

## Re-enablement

Re-enabling AQI must require only changing the internal property back to `true` and deploying the resulting code.

The disabled implementation must not remove, fork or degrade the existing observation-derived AQI code path.

No legacy materialised-AQI export, v1 AQI output or alternative writer may be introduced as part of this change.

## Structured diagnostics

Run and candidate summaries must distinguish:

```text
observation_history_outcome
aqi_history_outcome
day_finalisation_outcome
connector_gate_outcome
```

For observation-only mode, `aqi_history_outcome` must clearly report a deliberate skip rather than success, failure or missing execution.

Logs must make it possible to confirm that:

- observation connector and day outputs completed;
- AQI was disabled by the internal switch;
- no PM context or AQI output stage started;
- pruning remained authorised only by valid observation connector-day evidence.

## Regression-sensitive validation requirement

This change modifies central control flow around candidate processing, day finalisation and deletion-gate completion. It therefore requires more than syntax validation, while remaining local, deterministic and efficient.

Before deployment, Codex must:

1. run `node --check` on each changed JavaScript module;
2. add or amend narrowly targeted deterministic tests for both values of `phase_b_calculate_aqi_from_observations_enabled`;
3. run the directly relevant Prune Daily and Phase B test files first;
4. after focused tests pass, run the repository's complete local Node test suite once as the regression gate;
5. run `git diff --check`;
6. report every command, pass/fail count and any skipped test with its reason.

The targeted tests must prove at least:

- `false` prevents the candidate AQI calculation/write function from being called;
- `false` prevents AQI day finalisation from being called;
- `false` performs no PM-context, AQI object or AQI-index side effects;
- `false` still permits verified observation connector-gate and observation day completion;
- disabled summaries use an explicit stable skip reason and do not record an AQI failure;
- `true` still reaches the existing observation-derived AQI candidate path;
- `true` still reaches existing AQI day finalisation;
- the enabled-path AQI-only failure separation remains intact;
- no new configuration variable or fallback writer is introduced.

The complete local Node suite is required once because the changed module is shared, large and central to Prune Daily orchestration. Do not run it repeatedly after every edit. Run focused tests during iteration, then one complete Node regression run after the implementation stabilises.

Do not run unrelated Python suites, external APIs, Supabase, Cloudflare, R2, Dropbox, deployments, backfills or real Prune Daily operations during Codex implementation.

Do not create a broad speculative test framework or duplicate existing fixtures. Prefer extending the nearest existing Phase B tests and using dependency injection, exported test helpers or narrow stubs already established by the repository.

## TEST functional acceptance

After review and deployment to TEST, perform one real non-dry-run Prune Daily operation for a representative eligible connector-day.

Acceptance must confirm:

1. canonical observation Parquet, pollutant manifests and connector manifest are written and verified;
2. connector-targeted observation indexes are current;
3. the connector-day prune gate completes with valid source identity and `completion_source=prune_daily_phase_b`;
4. the observation day manifest and retained aggregate observation evidence complete;
5. matching eligible IngestDB observations can be pruned through the connector-day gate;
6. logs report AQI as deliberately skipped with the configured reason;
7. no new objects are written under `history/v2/aqilevels/hourly/data` or `history/v2/aqilevels/hourly/debug` for the processed day;
8. no PM-context RPC or AQI index update runs;
9. unrelated existing R2 AQI objects remain untouched.

Structural tests do not replace this real TEST acceptance.

## Rollback

The code rollback is to restore:

```javascript
phase_b_calculate_aqi_from_observations_enabled: true,
```

and redeploy the prior or corrected worker.

Rollback must not delete valid observation history, connector gates or existing AQI history.
