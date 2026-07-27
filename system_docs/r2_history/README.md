# R2 history

## Current authority

This area governs:

- stable v2 physical timeseries binding identity and routing;
- embedded multi-member continuity families in schema-version-2 bindings;
- v2 history Integrity detection, planning and repair;
- scheduled Integrity daily date selection;
- the connector-specific IngestDB-to-R2 boundary used by Integrity;
- concurrent Prune Daily and Integrity writer coordination;
- connector-day, day-finalisation and global-index advisory locks;
- the shared canonical R2 v2 connector-day writer and parent finalisers;
- the active Prune Daily Phase B observation and observation-derived AQI history write pipeline;
- connector-day observation deletion gates and aggregate whole-day completion gates;
- physical Parquet identity validation before connector-day deletion gates are completed;
- observation content hashing and verification-status preservation;
- targeted v2 index generation and repair gates.

The broader backup and low-level read-API documentation is still being consolidated, but completed files in this area override older broad or legacy documents for the subjects above.

## Required reading order

For binding and continuity changes:

1. [`contract.md`](contract.md)
2. [`continuity.md`](continuity.md)
3. [`interfaces.md`](interfaces.md)
4. [`operations.md`](operations.md)
5. [`recovery.md`](recovery.md)
6. [`validation.md`](validation.md)
7. relevant files under [`decisions/`](decisions/)

For Integrity changes, also read:

- [`integrity.md`](integrity.md);
- [`history_writer_coordination.md`](history_writer_coordination.md) for the request-level IngestDB boundary, shared writer and lock hierarchy;
- [`prune_connector_day_gate.md`](prune_connector_day_gate.md) for the Prune Daily-only observation deletion gate;
- [`connector_gate_file_identity.md`](connector_gate_file_identity.md) for physical Parquet identity validation used by Prune Daily gate completion and explicit recovery verification;
- [`daily_profile_selection.md`](daily_profile_selection.md) where scheduled selection is involved.

For Prune Daily Phase B observation/AQI writes and IngestDB deletion safety, also read:

- [`history_writer_coordination.md`](history_writer_coordination.md);
- [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md);
- [`prune_connector_day_gate.md`](prune_connector_day_gate.md);
- [`connector_gate_file_identity.md`](connector_gate_file_identity.md).

For calculated station-chart AQI and website display, also read:

- [`../aqi-levels/README.md`](../aqi-levels/README.md);
- [`../aqi-levels/station-history-contract.md`](../aqi-levels/station-history-contract.md);
- [`../aqi-levels/station-history-validation.md`](../aqi-levels/station-history-validation.md).

## Stable binding and continuity summary

The active binding object is:

```text
history/_index_v2/timeseries_binding/timeseries_id=<id>.json
```

Schema version 1 contains one exact physical binding.

Schema version 2 contains the same exact physical top-level binding plus an embedded deterministic `continuity` family. Only genuine multi-member families require schema version 2. Existing single-member bindings may remain byte-identical schema version 1 objects.

The logical family key is:

```text
connector_id + uk_air_ref + pollutant_code
```

`site_ref` is corroborating identity and must agree within a family, but it is not part of the key.

The service-only Supabase continuity view is authoritative. The nested R2 family is its runtime materialised copy.

Low-level observations and AQI history APIs remain exact physical-timeseries readers. Logical family orchestration belongs to the private station-history Worker.

## Binding churn authority

R2 binding byte stability is load-bearing.

Binding and continuity objects must not contain run time, generation time, source snapshot time, row update time, match distance, raw payload or daily coverage.

A bridge refresh with unchanged stable identity, reference and validity fields must produce zero changed binding objects.

A genuine multi-member family change may rewrite each member binding in that small family. Broad unrelated rewrites are prohibited.

The existing backup category remains `timeseries_binding_v2`; there is no separate R2 continuity tree or backup category.

## Observation content and verification status

The current observation-content-hash and verification-status contracts are jointly defined by:

- [`integrity.md`](integrity.md) for source normalisation, comparison, fault classification, planning, repair and post-repair verification;
- [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md) for the normal Phase B writer, canonical Parquet schema and manifest publication;
- [`history_writer_coordination.md`](history_writer_coordination.md) for shared writer ownership and concurrent live mutation.

Required behaviour includes:

- canonical observation rows contain nullable `verification_status`;
- UK-AIR SOS stores `P`, `R` or null after deterministic normalisation;
- unknown non-empty UK-AIR SOS status values fail closed;
- legacy readers prefer `verification_status`, then legacy `status`, then null;
- new writers emit only `verification_status`;
- one deterministic `observation_content_hash` exists per non-empty v2 observation pollutant partition;
- the hash covers every canonical row including `verification_status`;
- the pollutant manifest contains deterministic status counts;
- the existing Dropbox manifest/day backup carries the data and hash without a separate hash object.

## Shared history writer and lock hierarchy

The authoritative coordination contract is [`history_writer_coordination.md`](history_writer_coordination.md).

Required behaviour includes:

- each connector has one continuous boundary, with earlier days in R2 History and the earliest IngestDB day and later owned by Prune Daily;
- if any requested connector's Integrity range reaches its earliest IngestDB day, the complete Integrity request fails immediately;
- Integrity does not clip the range or skip only the blocking connector;
- Prune Daily and Integrity may run concurrently on non-conflicting work;
- no global "Prune Daily is running" exclusion is required;
- live writers share a connector-day lock for exact `day_utc + connector_id` mutation;
- parent day-manifest merging is serialised by a day-finalisation lock;
- aggregate/latest index updates are serialised by a short environment-scoped global index lock;
- locks are acquired sequentially and are not nested across those three scopes;
- day finalisation preserves connectors already present in R2 and does not rebuild a day solely from the current run's connector set.

## Prune deletion gate model

The authoritative gate split is defined in [`prune_connector_day_gate.md`](prune_connector_day_gate.md). Physical Parquet identity validation is defined in [`connector_gate_file_identity.md`](connector_gate_file_identity.md).

Required behaviour includes:

- IngestDB observation deletion is authorised by the exact `day_utc + connector_id` gate;
- one incomplete connector does not block another complete connector on the same day;
- the existing day gate remains the aggregate whole-day completion gate;
- a day gate cannot substitute for missing connector-level evidence;
- only Prune Daily may establish, invalidate or complete connector-day prune gates;
- Integrity, migration and generic shared-writer code never update prune gates;
- historical R2 connector-days with no corresponding IngestDB rows require no prune gate;
- every referenced Parquet must match its required physical identity before Prune Daily completes the connector gate;
- AQI success is not required for connector observation pruning;
- check-only and dry-run Integrity modes cannot change prune eligibility.

## AQI writer source boundary

The only supported Phase B AQI implementation is the observation-derived writer defined in [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md).

Required behaviour includes:

- target-day IngestDB observations are the source for target-day R2 observations and target-day AQI input;
- only the preceding 23 hourly PM2.5 and PM10 observation aggregates are read from ObsAQIDB as calculation context;
- ObsAQIDB materialised AQI is not a Phase B source or fallback;
- context rows are not written into the target-day observation partition or previous-day AQI output;
- the legacy AQI RPC/export selector, aliases, v1 AQI output path and fallback implementation are retired;
- incomplete or truncated context fails AQI for the affected connector-day;
- an AQI-only failure does not block or revoke a verified connector observation deletion gate;
- AQI data, debug, manifest and index completion remain separate aggregate outcomes.

## Integrity historical rollover rule

Integrity must distinguish a date-invalid R2 member of a known continuity family from a genuinely unknown timeseries.

For a bridge-known rollover, source mapping remains available and physical source/R2 mismatch evidence must be emitted. Repair execution remains gated until continuity-aware station history has been deployed and confirmed in TEST.

Unknown, ambiguous or contradictory identity remains fail-closed.

## Implementation ownership

- `scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs`
- `scripts/backup_r2/uk_aq_reconcile_r2_timeseries_bindings.mjs`
- `workers/shared/uk_aq_r2_history_index.mjs`
- `workers/shared/uk_aq_observation_content_hash.mjs`
- `workers/shared/uk_aq_r2_file_identity.mjs`
- the shared history writer and lock helper introduced under the coordination contract
- `workers/uk_aq_observs_history_r2_api_worker/`
- `workers/uk_aq_aqi_history_r2_api_worker/`
- `workers/uk_aq_cache_proxy/src/station_history/`
- `workers/uk_aq_station_history/`
- `workers/uk_aq_prune_daily/server.mjs`
- `workers/uk_aq_prune_daily/phase_b_history_r2.mjs`
- `workers/uk_aq_backfill_local/`
- `lib/aqi/aqi_levels.mjs`
- `scripts/backup_r2/`
- `scripts/uk-aq-history-integrity/`

The binding and continuity contracts do not own daily observation or AQI coverage. Daily coverage remains in the domain manifests and timeseries file-range indexes.
