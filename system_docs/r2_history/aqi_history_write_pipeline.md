# Prune Daily Phase B history write pipeline

## Purpose

This document defines the required R2 v2 history-writing behaviour used by Prune Daily Phase B.

It covers:

- target-day observation source ownership;
- canonical v2 observation writes;
- the shared `observation_content_hash` contract;
- the separate ObsAQIDB PM rolling-context read;
- AQI calculation and output boundaries;
- v2 data and debug objects;
- manifests, targeted indexes and completion gates;
- failure, retry and recovery behaviour.

AQI formulae and public read behaviour remain owned by their respective AQI and API components.

## Implementation ownership

The main implementation files are:

- `workers/uk_aq_prune_daily/phase_b_history_r2.mjs`;
- `workers/shared/uk_aq_observation_content_hash.mjs`;
- `workers/shared/uk_aq_r2_history_index.mjs`;
- `lib/aqi/aqi_levels.mjs`;
- `.github/workflows/uk_aq_prune_daily_cloud_run_deploy.yml`;
- `config/uk_aq_github_env_targets.csv`.

The Integrity source-to-R2 writer MUST consume the same shared observation-content-hash helper. The Integrity contract is defined in [`integrity.md`](integrity.md).

The ObsAQIDB PM context RPC is owned by `TEST-uk-aq/uk-aq-schema` and is version-controlled in:

- `schemas/migrations/20260717_001_obs_aqidb_pm_hourly_context_rpc.sql`;
- `schemas/obs_aqi_db/uk_aq_obs_aqi_db_ops_rpcs.sql`;
- `schemas/obs_aqi_db/uk_aq_obs_aqi_db_schema.sql`.

## Source ownership

Phase B deliberately uses two observation sources for different purposes.

### Target-day source

IngestDB is authoritative for the connector and UTC day being archived.

The frozen target-day source covers:

```text
D 00:00 inclusive to D+1 00:00 exclusive
```

The same frozen rows feed:

- the permanent R2 observation write for D;
- the target-day hourly inputs used by the AQI calculation.

ObsAQIDB MUST NOT replace this target-day source. This preserves the existing fingerprint-repair, candidate row-count, checkpoint, manifest and prune-gate contract.

### PM rolling-context source

ObsAQIDB supplies only the older PM2.5 and PM10 hourly aggregates required to start D with a complete rolling window.

For target day D, the context window is:

```text
D-1 01:00 inclusive to D 00:00 exclusive
```

This is exactly 23 older UTC hours. Combined with the target hour, it permits the shared AQI library to calculate PM DAQI for D 00:00.

NO2 does not use this context. NO2 DAQI and EAQI continue to use the target hour's hourly mean.

### Context is calculation-only

ObsAQIDB context rows MUST NOT:

- be written to the target day's R2 observation partition;
- contribute to the observation-content hash for D;
- increase the target-day observation candidate count;
- alter observation checkpoints or manifests;
- produce AQI output rows before D 00:00;
- make a connector/day a supported AQI source when D contains no supported target-day observations.

## Writer selection

Exactly one Phase B AQI writer mode MUST be enabled:

- observation-derived AQI; or
- the legacy materialised-AQI RPC export.

Both enabled and both disabled are invalid and fail closed.

The current R2-first TEST configuration is expected to use:

```text
UK_AQ_R2_HISTORY_VERSION=v2
UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED=true
UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED=false
```

## Phase B connector-day flow

For each target connector/day, Phase B MUST:

1. stream and freeze target-day observations from IngestDB;
2. validate and normalise canonical v2 observation rows;
3. group those rows by canonical `pollutant_code`;
4. calculate one `observation_content_hash` per non-empty day/connector/pollutant group through the shared helper;
5. build the Parquet object from the exact same canonical rows supplied to that hash calculation;
6. write the pollutant Parquet and pollutant manifest containing the hash result;
7. write connector and day observation manifests from the final pollutant manifests;
8. select supported target-day PM2.5, PM10 and NO2 rows;
9. aggregate target-day observations to hourly rows through `lib/aqi/aqi_levels.mjs`;
10. identify target-day PM timeseries requiring older context;
11. fetch the preceding 23 hourly PM aggregates from ObsAQIDB;
12. discard context rows that do not match a target-day PM timeseries and pollutant;
13. merge context and target-day rows by `timeseries_id + pollutant_code + timestamp_hour_utc`;
14. prefer the target-day IngestDB-derived row if an overlap occurs;
15. calculate DAQI and EAQI through the shared AQI library;
16. restrict final AQI output to target day D;
17. write canonical v2 AQI data and debug objects;
18. write AQI connector and day manifests;
19. build and verify the required targeted observation and AQI indexes;
20. set `history_done=true` only after every required gate succeeds.

The writer MUST compose shared helpers. It MUST NOT copy the observation-content-hash algorithm, AQI breakpoints or rolling-average algorithm.

## Observation content hash contract

### Scope and location

There is one `observation_content_hash` for each non-empty v2 observation partition at:

```text
history/v2/observations/
  day_utc=<D>/
  connector_id=<connector>/
  pollutant_code=<pollutant>/
  manifest.json
```

The hash covers every timeseries row in that pollutant partition. There is no separate authoritative hash per timeseries, connector-day or day.

The pollutant manifest's normal `manifest_hash` includes the observation-content-hash fields. Connector and day manifests include the changed child-manifest hashes, so the content identity propagates through the existing hierarchy without a separate object.

### Required manifest fields

Every non-empty v2 observation pollutant manifest MUST contain:

```json
{
  "observation_content_hash": "<64 lowercase hexadecimal characters>",
  "observation_content_hash_algorithm": "sha256",
  "observation_content_hash_contract_version": 1,
  "observation_content_hash_row_count": 1234,
  "observation_content_hash_columns": [
    "connector_id",
    "station_id",
    "timeseries_id",
    "pollutant_code",
    "observed_at_utc",
    "value"
  ]
}
```

`observation_content_hash_row_count` MUST equal the pollutant manifest `row_count`, `source_row_count` and the number of canonical rows passed to the Parquet serializer for that pollutant.

The content hash is not the Parquet checksum or R2 ETag. Physical Parquet compression, row groups, file splitting and row order MUST NOT change it when the logical observation rows are unchanged.

### Shared helper

The authoritative implementation is one shared module, expected at:

```text
workers/shared/uk_aq_observation_content_hash.mjs
```

It exports the contract version, canonical column list and a function such as:

```text
computeObservationContentHash(rows)
```

Prune Daily and the Integrity source-to-R2 writer MUST call that function directly. They MUST NOT maintain separate equivalent implementations.

### Contract version 1 encoding

Contract version 1 normalises each row as:

- positive integer `connector_id`;
- positive integer or null `station_id`;
- positive integer `timeseries_id`;
- validated canonical lower-case `pollutant_code`;
- exact UTC `observed_at_utc` with millisecond precision and trailing `Z`;
- finite IEEE-754 binary64 `value`.

Finite negative values are preserved. Negative zero is normalised to positive zero. Null, NaN and infinite values are invalid canonical observation rows.

The numeric value is encoded as 16 lower-case hexadecimal characters containing its big-endian IEEE-754 binary64 bytes. The canonical row is compact UTF-8 JSON with fixed array order:

```text
[connector_id, station_id, timeseries_id, pollutant_code, observed_at_utc, value_float64_hex]
```

Canonical row strings are sorted lexicographically. Exact duplicate rows retain their multiplicity. The SHA-256 input is:

```text
uk-aq-observation-content-hash:v1\n
<canonical row 1>\n
<canonical row 2>\n
...
```

The final row ends with `\n`.

The current contract does not include `verification_status_code` because that field is not yet in the canonical v2 observation schema. Adding it requires a new observation-content-hash contract version and coordinated schema, writer, reader, manifest and Integrity changes.

### Writer fail-closed rules

Phase B MUST fail the connector-day and keep pruning blocked when:

- any selected observation row cannot be canonicalised;
- the hash helper returns invalid algorithm, version, columns, row count or hash text;
- hash row count differs from the pollutant's canonical source rows;
- the Parquet serializer receives a different row collection from the hash helper;
- the pollutant manifest does not exactly contain the returned hash metadata;
- parent manifests or targeted indexes do not reference the final pollutant manifest and hash.

The normal writer calculates the hash from rows already in memory. It does not need a separate pass over the newly written Parquet solely to create the hash.

### Idempotency and changed-only behaviour

Equivalent canonical rows MUST produce the same observation-content hash on every run.

A change to only compression, row-group size, Parquet writer version or physical row order MUST NOT change the content hash. A change to row identity, timestamp or value MUST change it.

The new hash fields are deterministic and contain no run timestamp. Existing manifest and index byte-stability and put-if-changed rules remain load-bearing.

### Dropbox backup

The hash remains inside the existing pollutant manifest and is therefore included in the normal v2 observation day-folder backup to Dropbox.

No separate R2 hash object, backup inventory category, Dropbox directory or checkpoint section is introduced. When logical observation content changes, the pollutant manifest, parent manifest identities and normal backup inventory entry change, and the existing backup process copies the affected units.

### Integrity source-hash performance

Prune Daily calculates the R2 hash while the canonical rows are already available, so it does not require an Integrity SQLite cache.

The initial Integrity implementation SHOULD calculate the authoritative source hash during its existing source parsing and canonical-row pass. It MUST NOT create a duplicate authoritative R2 hash cache in SQLite.

If real TEST Integrity operations show that creating source hashes is materially slow, a later additive SQLite source-hash cache MAY be introduced. Such a cache is non-authoritative and must be invalidated by exact source-file identities, timestamp/parser contract, mapping identities, source-label registry identity, selected scope and observation-content-hash contract version. That performance change is deferred until measured evidence justifies it.

## Shared AQI behaviour

The shared AQI library remains authoritative for:

- pollutant normalisation;
- raw observation hourly aggregation;
- PM rolling 24-hour calculations;
- DAQI and EAQI breakpoints;
- required source-hour counts;
- calculation statuses and missing reasons;
- algorithm version.

PM DAQI requires 24 available hourly values in:

```text
H-23 hours through H
```

A complete source read with genuine missing hours is not an infrastructure failure. The affected row uses:

```text
daqi_calculation_status=insufficient_samples
daqi_missing_reason=insufficient_rolling_24h_hours
daqi_index_level=null
```

EAQI continues to use the current hourly mean and may therefore be available when PM DAQI is not.

## ObsAQIDB PM context RPC

The default RPC is:

```text
uk_aq_public.uk_aq_rpc_observs_aqi_pm_hourly_context
```

It is called through PostgREST with the ObsAQIDB service-role key.

### Inputs

```text
p_connector_id
p_start_utc
p_end_utc
p_after_timeseries_id
p_after_timestamp_hour_utc
p_limit
```

### Output

Rows are ordered by `timeseries_id, timestamp_hour_utc` and contain:

```text
connector_id
station_id
timeseries_id
pollutant_code
timestamp_hour_utc
hourly_mean_ugm3
sample_count
```

### Required interface behaviour

The RPC MUST:

- require `service_role`;
- read ObsAQIDB observations and authoritative timeseries metadata;
- accept only a positive connector ID;
- require hour-aligned start and end timestamps;
- reject an empty, reversed or longer-than-24-hour window;
- require both cursor fields together or neither;
- return only `pm25` and `pm10`;
- ignore null and negative observation values for AQI calculation;
- use UTC hourly buckets matching the JavaScript AQI library;
- aggregate an hourly mean and sample count;
- order output for stable keyset pagination;
- clamp `p_limit` to the range 1 to 5000;
- return an empty array when no qualifying rows exist;
- remain unavailable to `public`, `anon` and `authenticated` roles.

The AQI calculation exclusion of negative values does not alter the observation history or observation-content hash. Finite negative source observations remain in canonical observation history.

The caller validates returned identifiers, pollutant, UTC hour alignment, requested window, hourly mean, sample count, order and uniqueness. Invalid output fails the candidate.

## Pagination and bounded reads

The caller uses keyset pagination with:

```text
after timeseries_id
after timestamp_hour_utc
```

Default runtime limits are:

```text
UK_AQ_PHASE_B_PM_CONTEXT_PAGE_SIZE=1000
UK_AQ_PHASE_B_PM_CONTEXT_MAX_PAGES=100
UK_AQ_PHASE_B_PM_CONTEXT_MAX_ROWS=50000
```

Reaching a page or row cap before a complete response is a failure, not a partial success.

The service accepts only context rows matching target-day PM timeseries. Operators monitor:

```text
pm_context_rows_fetched
pm_context_rows_accepted
pm_context_rows_discarded
```

A cap failure requires a safe configuration adjustment or a more selective RPC contract. It MUST NOT be bypassed by accepting a truncated response.

## ObsAQIDB retention guard

Before requesting context, Phase B calculates the ObsAQIDB retention boundary from:

```text
OBS_AQIDB_OBSERVS_RETENTION_DAYS
```

The default is 14 days. If required context starts outside the retention boundary, the candidate fails and pruning remains blocked.

An older pending candidate requires rebuild from another authoritative retained source, normally R2 observations or an approved backfill source.

## Fail-closed context contract

The candidate MUST fail and pruning MUST remain blocked when:

- ObsAQIDB configuration is missing;
- the context RPC request fails;
- the response is not an array;
- pagination does not advance monotonically;
- duplicate hourly keys are returned;
- a page or row cap is reached before completion;
- a row cannot be normalised safely;
- a row is outside the requested window;
- context starts outside ObsAQIDB retention;
- a complete empty result cannot be distinguished from an incomplete read.

A context failure follows the normal retry-safe path. The candidate is marked failed, the day gate remains incomplete and partial output is cleaned up where the existing v2 cleanup contract requires it.

## Target-day precedence

Context and target-day hourly values are merged by:

```text
timeseries_id + pollutant_code + timestamp_hour_utc
```

The target-day value derived from frozen IngestDB observations MUST win over an ObsAQIDB context value for the same key.

## No-supported-source state

A target connector/day with no supported PM2.5, PM10 or NO2 target-day rows is a successful `no_supported_aqi_source` state.

In this state:

- the PM context RPC is not called;
- previous-day context cannot create target-day AQI output;
- canonical empty AQI connector manifests are written;
- fake AQI Parquet files are not created;
- stale pollutant indexes or metadata do not remain authoritative.

This AQI state does not remove or suppress non-AQI observation pollutants written for the same connector-day.

## R2 outputs

Canonical observations are written under:

```text
history/v2/observations
```

Observation-derived AQI writes:

```text
history/v2/aqilevels/hourly/data
history/v2/aqilevels/hourly/debug
```

The AQI data profile contains DAQI and EAQI levels, statuses and missing reasons required by the public history path. The debug profile contains calculation inputs, source counts, required counts, algorithm version and computation timestamp.

Context rows are never published as a separate R2 product.

## Structured diagnostics

Successful candidate logs and summaries expose the existing PM context and AQI status diagnostics plus:

```text
observation_content_hash_contract_version
observation_content_hash_pollutant_count
observation_content_hash_row_count
observation_content_hash_failures
```

Per-pollutant details MAY be included in bounded structured output, but logs MUST NOT dump canonical rows or create an unbounded hash report.

## Index and manifest safety

The writer uses the established targeted v2 updater. It MUST NOT run a target-day-filtered full rebuild that drops unrelated days.

The targeted update MUST:

- start from the existing global latest payload;
- replace or insert only the affected day summary;
- preserve unrelated older days;
- update only affected pollutant indexes and timeseries metadata;
- use byte-stable put-if-changed behaviour;
- verify that every required index refers to the current pollutant manifest and `manifest_hash`;
- preserve the observation-content-hash fields through pollutant, connector and day hierarchy generation.

Object existence alone is insufficient. Warnings, missing generated indexes, unreadable payloads or source-manifest mismatches block completion.

Observation-manifest adoption remains disabled for the observation-derived AQI path because an observation manifest alone cannot satisfy the complete observation, hash and AQI gate.

## Idempotency and retries

Rewriting the same canonical state MUST be idempotent.

If supported target-day rows exist but normalisation or hourly calculation produces no AQI rows, the writer fails closed rather than publishing a successful empty result.

A PM context failure is retry-safe while required context remains inside ObsAQIDB retention.

## Existing hashless and defective days

Deploying the hash contract does not automatically add hashes to historical manifests or correct historical observation content.

Integrity owns historical adoption:

- a legacy hashless partition whose calculated R2 content hash matches source truth receives metadata-only manifest repair;
- a count or content-hash mismatch receives complete selected-pollutant data repair;
- affected AQI is rebuilt only after observation repair succeeds.

Previously defective AQI days still require targeted rebuild from authoritative observation history.

## Validation policy

Before implementation, run only structural checks plus one focused deterministic shared-helper check. The helper check is genuinely required because separate or inconsistent hashing would invalidate all Integrity comparisons.

The focused check MUST prove:

- identical logical rows in different input orders produce the same hash;
- changed value, timestamp, timeseries, station, connector or pollutant changes the hash;
- exact duplicates retain multiplicity;
- finite negative values are preserved;
- negative zero normalises consistently;
- manifest row count and hash metadata match the writer input.

Functional acceptance occurs through real TEST operation:

1. Run one normal Prune Daily Phase B candidate.
2. Confirm each non-empty observation pollutant manifest contains valid hash fields.
3. Confirm connector and day manifests reference the resulting child manifest hashes.
4. Confirm the next Dropbox backup carries the same hash fields without a new backup path.
5. Run one scoped Integrity comparison and confirm count-matching content is verified by source hash versus manifest hash.
6. Confirm `history_done` is set only after observation, hash, AQI, manifest and index gates succeed.

Do not add a broad speculative pre-implementation test suite.

The dated pre-hash snapshot under `system_docs_legacy/r2_history/2026-07-24_before_observation_content_hash/` is historical evidence and does not override this contract.
