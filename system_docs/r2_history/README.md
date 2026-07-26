# R2 history

## Current authority

This area governs:

- stable v2 physical timeseries binding identity and routing;
- embedded multi-member continuity families in schema-version-2 bindings;
- v2 history Integrity detection, planning and repair;
- scheduled Integrity daily date selection;
- the active Prune Daily Phase B observation and AQI history write pipeline;
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
- [`daily_profile_selection.md`](daily_profile_selection.md) where scheduled selection is involved.

For Prune Daily Phase B observation/AQI writes, also read:

- [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md).

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
- [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md) for the normal Phase B writer, canonical Parquet schema and manifest publication.

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

## AQI writer source boundary

For the observation-derived Phase B AQI path:

- target-day IngestDB observations remain the source for target-day R2 observations and target-day AQI input;
- only the preceding 23 hourly PM2.5 and PM10 aggregates are read from ObsAQIDB as context;
- context rows are not written into the target-day observation partition or previous-day AQI output;
- incomplete or truncated context fails closed and keeps pruning blocked.

## Integrity historical rollover rule

Integrity must distinguish a date-invalid R2 member of a known continuity family from a genuinely unknown timeseries.

For a bridge-known rollover, source mapping remains available and physical source/R2 mismatch evidence must be emitted. Repair execution remains gated until continuity-aware station history has been deployed and confirmed in TEST.

Unknown, ambiguous or contradictory identity remains fail-closed.

## Implementation ownership

- `scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs`
- `scripts/backup_r2/uk_aq_reconcile_r2_timeseries_bindings.mjs`
- `workers/shared/uk_aq_r2_history_index.mjs`
- `workers/shared/uk_aq_observation_content_hash.mjs`
- `workers/uk_aq_observs_history_r2_api_worker/`
- `workers/uk_aq_aqi_history_r2_api_worker/`
- `workers/uk_aq_cache_proxy/src/station_history/`
- `workers/uk_aq_station_history/`
- `workers/uk_aq_prune_daily/phase_b_history_r2.mjs`
- `workers/uk_aq_backfill_local/`
- `lib/aqi/aqi_levels.mjs`
- `scripts/backup_r2/`
- `scripts/uk-aq-history-integrity/`

The binding and continuity contracts do not own daily observation or AQI coverage. Daily coverage remains in the domain manifests and timeseries file-range indexes.
