# Prune Daily Phase B history write pipeline

## Purpose

This document defines the required R2 v2 history-writing behaviour used by Prune Daily Phase B.

It covers:

- target-day observation source ownership;
- canonical v2 observation writes;
- canonical observation `verification_status`;
- the shared `observation_content_hash` contract;
- the limited ObsAQIDB PM rolling-context read;
- the single supported observation-derived AQI calculation path;
- v2 AQI data and debug objects;
- manifests, targeted indexes and completion separation;
- failure, retry and recovery behaviour.

AQI formulae and public read behaviour remain owned by their respective AQI and API components.

This document supplements:

- [`history_writer_coordination.md`](history_writer_coordination.md);
- [`prune_connector_day_gate.md`](prune_connector_day_gate.md);
- [`integrity.md`](integrity.md).

Where older wording conflicts with this document, this document is authoritative for Phase B AQI source selection, AQI writer ownership and the separation between observation pruning and AQI completion.

## Implementation ownership

The main implementation areas are:

- `workers/uk_aq_prune_daily/phase_b_history_r2.mjs`;
- the shared R2 v2 connector-day writer and finalisers;
- `workers/shared/uk_aq_observation_content_hash.mjs`;
- `workers/shared/uk_aq_r2_history_index.mjs`;
- `lib/aqi/aqi_levels.mjs`;
- the Prune Daily GitHub Actions workflow and environment configuration.

The Integrity source-to-R2 writer consumes the same canonical observation, status, hash, manifest, AQI and index helpers where applicable. Integrity's own source and repair rules remain defined in [`integrity.md`](integrity.md).

## One supported Phase B AQI path

Prune Daily has exactly one supported AQI implementation:

```text
calculate AQI directly from the canonical observations being written to R2
```

The observation-derived writer is the normal and permanent Phase B path.

The existing guard may remain temporarily as a required-true assertion:

```text
UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED=true
```

It is not a writer-selection mechanism. A normal Phase B deployment MUST NOT select an alternative AQI implementation.

The following legacy path is retired and MUST be removed from active code and configuration:

```text
UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED
```

The active implementation MUST NOT retain:

- an "exactly one AQI writer must be enabled" mode-selection check;
- `runAqilevelsBackup()` or an equivalent legacy materialised-AQI exporter;
- legacy AQI rows or connector-count RPCs used as the Phase B AQI source;
- an `aqilevels_source` alias that points at ObsAQIDB materialised AQI;
- old v1 AQI write prefixes in the active Phase B path;
- a legacy fallback branch in `runPhaseBBackup()`;
- tests whose only purpose is to preserve the retired writer-selection or RPC-export path.

The active R2 history version is:

```text
UK_AQ_R2_HISTORY_VERSION=v2
```

No active Phase B AQI output is written to v1 history paths.

## Observation retention and AQI separation

Observation retention is the deletion-safety path:

```text
IngestDB observations
        ↓
canonical R2 v2 observation history
        ↓
read-back and connector-targeted observation-index verification
        ↓
Prune Daily connector-day gate
        ↓
delete matching IngestDB observations
```

AQI is derived afterwards from the canonical observation data.

The connector-day observation deletion gate deliberately does not require AQI to succeed.

Therefore:

- observation history may be safely pruned from IngestDB after its connector-day gate succeeds;
- an AQI calculation or write failure MUST NOT block or revoke that successful observation gate;
- an AQI failure remains relevant to AQI history and whole-day aggregate completion;
- AQI data/debug connector-set mismatch is an AQI-history fault, not an observation-retention fault;
- ObsAQIDB materialised AQI is not a fallback source for Phase B.

The aggregate day gate or AQI-specific completion result remains incomplete when required AQI work fails, even though one or more connector observation gates may already be complete.

## Source ownership

Phase B uses observation sources for two distinct purposes.

### Target-day observations

IngestDB is authoritative for the connector and UTC day being archived by Prune Daily.

The frozen target-day source covers:

```text
D 00:00 inclusive to D+1 00:00 exclusive
```

The same frozen rows feed:

- the permanent R2 v2 observation write for D;
- target-day hourly inputs for AQI calculation.

The fetch MUST preserve the source observation status needed to produce canonical `verification_status`.

ObsAQIDB MUST NOT replace the target-day observation source.

### PM rolling context

ObsAQIDB supplies only the older PM2.5 and PM10 hourly observation aggregates needed to start target day D with a complete 24-hour rolling window.

For D, the context window is:

```text
D-1 01:00 inclusive to D 00:00 exclusive
```

This provides 23 older UTC hours. Combined with the target hour, it permits PM DAQI calculation at D 00:00.

NO2 does not use rolling context. NO2 DAQI and EAQI use the target hour's hourly mean.

### ObsAQIDB is not the AQI source

ObsAQIDB context rows are calculation inputs only. They MUST NOT:

- be written to the target day's observation partition;
- contribute to target-day observation row counts or hashes;
- contribute to canonical `verification_status` for D;
- alter observation checkpoints or manifests;
- produce AQI output before D 00:00;
- create a supported AQI source when D has no supported target-day observations;
- be treated as previously calculated AQI output for export.

The only Phase B AQI source is the canonical observation set plus the limited PM rolling context required by the shared AQI algorithm.

## Canonical observation contract

Canonical R2 v2 observation rows contain:

```text
connector_id
station_id
timeseries_id
pollutant_code
observed_at_utc
value
verification_status
```

For UK-AIR SOS observations, canonical status values are:

```text
P
R
null
```

Source values are normalised as:

```text
null or blank -> null
P or Provisional -> P
R or Ratified -> R
```

Any other non-empty UK-AIR SOS status fails the connector-day observation write closed.

New writers emit only `verification_status`. Readers may retain legacy read compatibility by resolving:

1. `verification_status` when present;
2. legacy `status` when present;
3. otherwise null.

## Observation content hash

There is one authoritative `observation_content_hash` for each non-empty:

```text
day_utc + connector_id + pollutant_code
```

It lives in the canonical v2 observation pollutant manifest.

Prune Daily and Integrity MUST use the same shared helper:

```text
workers/shared/uk_aq_observation_content_hash.mjs
```

The helper owns:

- canonical row normalisation;
- verification-status normalisation;
- deterministic ordering;
- duplicate multiplicity;
- Float64 value encoding;
- `verification_status_counts`;
- SHA-256 calculation;
- contract version and canonical column list.

The hash is calculated from the exact logical canonical rows passed to the Parquet writer. It is not a Parquet byte hash, compression hash or R2 ETag.

A change to row identity, timestamp, value or verification status MUST change the logical content hash. A physical-only change such as compression or row order MUST NOT change it.

Every non-empty pollutant manifest MUST contain valid:

```text
observation_content_hash
observation_content_hash_algorithm
observation_content_hash_contract_version
observation_content_hash_row_count
observation_content_hash_columns
verification_status_counts
```

The row counts and status counts MUST match the exact canonical rows written.

## Phase B connector-day flow

For each target connector-day, Phase B MUST perform this sequence.

### Observation retention stage

1. Acquire the shared connector-day lock defined in [`history_writer_coordination.md`](history_writer_coordination.md).
2. Stream and freeze target-day observations from IngestDB, including source status.
3. Validate and normalise canonical v2 observation rows.
4. Group rows by canonical pollutant code.
5. Calculate the shared observation content hash and verification-status counts for each non-empty pollutant group.
6. Build Parquet from the exact same canonical rows.
7. Write and verify observation pollutant Parquet and manifests.
8. Write and verify the observation connector manifest.
9. Build and verify connector-targeted observation indexes.
10. Release the connector-day lock after connector-scoped observation verification.
11. Return the verified connector evidence to Prune Daily.
12. Prune Daily sets the connector-day observation deletion gate.

At this point, observation retention is complete for pruning purposes.

### Observation-derived AQI stage

13. Select supported target-day PM2.5, PM10 and NO2 observations from the frozen canonical source.
14. Aggregate target-day observations to hourly rows through `lib/aqi/aqi_levels.mjs`.
15. Identify target-day PM timeseries requiring older context.
16. Fetch the preceding 23 hourly PM aggregates from ObsAQIDB.
17. Validate and retain only context rows matching a target-day PM timeseries and pollutant.
18. Merge context and target-day hourly rows by `timeseries_id + pollutant_code + timestamp_hour_utc`.
19. Prefer the target-day IngestDB-derived row when an overlap occurs.
20. Calculate DAQI and EAQI through the shared AQI library.
21. Restrict final output to target day D.
22. Write and verify canonical v2 AQI data and debug connector outputs and manifests.
23. Build and verify connector-targeted AQI indexes.

### Parent and aggregate finalisation

24. Finalise affected observation and AQI day manifests once under the day-finalisation lock.
25. Preserve every valid connector already present for the day.
26. Update global/latest indexes once under the global index-finalisation lock.
27. Record observation-gate, AQI and aggregate-day outcomes separately.

AQI failure after step 12 MUST NOT roll back or clear the verified observation connector-day gate.

## Shared AQI behaviour

The shared AQI library remains authoritative for:

- pollutant normalisation;
- raw-observation hourly aggregation;
- PM rolling 24-hour calculations;
- DAQI and EAQI breakpoints;
- required source-hour counts;
- calculation statuses and missing reasons;
- algorithm version.

PM DAQI requires 24 available hourly values from:

```text
H-23 through H
```

A complete source read with genuine missing hours is a valid insufficient-samples result rather than an infrastructure failure. The affected row uses a null DAQI level with the appropriate calculation status and missing reason.

EAQI uses the current hourly mean and may be available when PM DAQI is unavailable.

The Phase B writer MUST compose shared AQI helpers. It MUST NOT copy or independently reimplement AQI breakpoints, rolling calculations or status semantics.

## PM context RPC

The supported ObsAQIDB RPC is the PM hourly observation-context RPC:

```text
uk_aq_public.uk_aq_rpc_observs_aqi_pm_hourly_context
```

It is not a materialised-AQI export RPC.

The RPC:

- requires service-role access;
- reads ObsAQIDB observations and authoritative timeseries metadata;
- accepts a positive connector ID and bounded hour-aligned window;
- returns only PM2.5 and PM10 hourly aggregates;
- ignores null and negative values for AQI calculation only;
- uses stable keyset pagination;
- remains unavailable to public roles.

Finite negative source observations remain in canonical observation history even though they are excluded from AQI calculation.

The caller validates identifiers, pollutant, timestamps, requested window, hourly mean, sample count, ordering, uniqueness and pagination progress.

## Bounded context reads

Context pagination uses:

```text
after_timeseries_id
after_timestamp_hour_utc
```

Page and row limits remain bounded. Reaching a cap before a complete response is a failure, not a partial success.

Before requesting context, Phase B checks that the required period remains within ObsAQIDB retention.

A context request failure or incomplete response fails AQI history for that connector-day but does not invalidate already verified observation retention.

## No-supported-source state

A connector-day with no target-day PM2.5, PM10 or NO2 observations has a successful:

```text
no_supported_aqi_source
```

state.

In this state:

- the PM context RPC is not called;
- previous-day context cannot create target-day AQI output;
- canonical empty AQI connector manifests are written where required by the v2 contract;
- fake AQI Parquet objects are not created;
- stale AQI connector indexes do not remain authoritative;
- non-AQI observation pollutants remain unaffected.

## Canonical R2 outputs

Observations are written under:

```text
history/v2/observations
```

Observation-derived AQI is written under:

```text
history/v2/aqilevels/hourly/data
history/v2/aqilevels/hourly/debug
```

The data profile contains DAQI and EAQI levels, statuses and missing reasons needed by public history readers.

The debug profile contains calculation inputs, source counts, required counts, algorithm version and computation evidence.

Context rows are not published as a separate R2 product.

Legacy v1 AQI prefixes are not active Phase B outputs.

## Manifest and index safety

Connector and pollutant leaf indexes remain scoped by day, connector and pollutant.

For a changed connector-day, the writer updates only the affected connector-specific observation and AQI indexes.

Parent day manifests are merged under the shared day-finalisation lock. They MUST preserve connectors already written by Integrity, migration or an earlier Prune Daily operation.

Aggregate/latest indexes are updated once after affected day finalisation under the shared global index lock.

The normal path MUST NOT run an unconditional second full history-index rebuild after targeted finalisation succeeds.

New manifests MUST include the timeseries row-count metadata needed for targeted index creation without rereading newly written Parquet.

Byte-stable put-if-changed behaviour remains required.

## Failure separation

### Observation failure

An observation write, hash, manifest, read-back, required observation-index or connector-scoped comparison failure:

- leaves the connector-day observation gate false;
- prevents deletion of the matching IngestDB observations;
- prevents AQI from being treated as complete for that connector-day.

### AQI failure

An AQI source, context, calculation, data/debug write, AQI manifest or AQI-index failure:

- is reported as AQI history incomplete;
- keeps AQI or aggregate whole-day state incomplete;
- does not clear a valid connector observation gate;
- does not prevent deletion based on that valid observation gate.

### Parent or global finalisation failure

A day-manifest or global-index finalisation failure:

- is reported separately;
- leaves broader aggregate completion incomplete;
- does not revoke an observation connector gate whose connector-scoped requirements were already verified;
- remains retryable through the shared finaliser.

## Idempotency and retries

Equivalent canonical observations MUST produce equivalent logical content hashes, manifests and connector-targeted indexes.

Rewriting the same canonical state is idempotent.

A retry MUST use the same single observation-derived AQI path. It MUST NOT fall back to a retired RPC export.

If supported target-day rows exist but normalisation or hourly calculation produces no AQI rows, AQI fails closed rather than publishing a false successful empty result.

## Integrity and historical repair

Integrity may rebuild affected AQI only after a successful canonical observation repair for PM2.5, PM10 or NO2.

Integrity and migration use the shared writer and lock hierarchy, but they do not create prune connector-day gates.

Legacy or defective AQI history is rebuilt from canonical observation history through the observation-derived AQI implementation. It is not repaired by exporting old materialised AQI from ObsAQIDB.

## Structured diagnostics

Reports MUST distinguish at least:

```text
observation_history_outcome
observation_connector_gate_outcome
aqi_calculation_outcome
aqi_data_write_outcome
aqi_debug_write_outcome
aqi_connector_index_outcome
day_finalisation_outcome
global_index_finalisation_outcome
```

AQI diagnostics may include bounded PM-context counts and calculation-status totals.

An AQI-only failure MUST NOT be labelled as an observation-retention or prune-gate failure.

## Validation policy

Before deployment, run only structural checks plus narrow directly relevant deterministic checks.

The focused checks MUST prove:

- the observation-derived path is the only reachable Phase B AQI writer;
- the retired legacy flag and RPC-export branch cannot select an alternative writer;
- target-day observations, not materialised ObsAQIDB AQI, feed the AQI calculation;
- PM context is calculation-only and cannot enter observation history;
- an observation failure keeps the connector gate incomplete;
- an AQI-only failure leaves a verified observation gate intact;
- parent-manifest merging preserves connectors already present in R2;
- targeted index finalisation does not require an unconditional full rebuild.

Before finalising source normalisation, one narrow UK-AIR status-vocabulary inspection remains genuinely required. Unknown non-empty values must be reported rather than guessed.

Do not add a broad speculative pre-implementation test suite.

Functional acceptance occurs through real TEST operation:

1. run one normal Prune Daily connector-day;
2. confirm canonical observations, hashes, status counts, connector manifest and observation indexes verify;
3. confirm the connector-day observation gate can complete before AQI whole-day finalisation;
4. confirm observation-derived AQI data and debug outputs are written to v2 paths;
5. confirm no legacy AQI RPC/export branch runs;
6. exercise an AQI-only failure and confirm the observation gate remains valid and matching IngestDB observations remain eligible for pruning;
7. confirm a later AQI retry completes without rewriting or invalidating correct observation history.
