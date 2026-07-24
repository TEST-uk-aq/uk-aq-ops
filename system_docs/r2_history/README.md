# R2 history

## Current authority

Read [`contract.md`](contract.md) first for the stable v2 per-timeseries binding contract.

This area currently has four completed authority groups:

- stable timeseries binding identity and routing;
- v2 history Integrity detection and repair in [`integrity.md`](integrity.md), including count-first observation comparison followed by `observation_content_hash` comparison;
- scheduled Integrity daily date selection in [`daily_profile_selection.md`](daily_profile_selection.md);
- the active Prune Daily Phase B observation and AQI history write pipeline in [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md), including creation of the R2 observation-content hash and the PM rolling-context and targeted-index gates.

The remaining broader daily layout, backup and read-API documentation is still being migrated from `system_docs_legacy/`. Do not infer that a legacy broad document overrides the completed files above.

## Observation content hash authority

The current observation-content-hash contract is jointly defined by:

- [`integrity.md`](integrity.md) for source comparison, fault classification, repair planning and post-repair verification;
- [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md) for the normal Prune Daily Phase B observation writer and manifest publication.

Required behaviour:

- one `observation_content_hash` exists per non-empty `day_utc + connector_id + pollutant_code` observation partition;
- the hash covers every canonical timeseries row in that pollutant partition;
- the authoritative R2 hash is stored in the existing v2 observation pollutant manifest;
- Prune Daily and the Integrity source-to-R2 writer use one shared helper, expected at `workers/shared/uk_aq_observation_content_hash.mjs`;
- Integrity compares authoritative source content with the hash in the Dropbox copy of the pollutant manifest;
- Integrity SQLite stores comparison and audit evidence, not a duplicate authoritative R2 hash cache;
- if real TEST runs show source-hash creation is materially slow, a later non-authoritative SQLite source-hash cache may be added with complete source, parser, mapping and hash-contract invalidation;
- the existing manifest/day Dropbox backup path carries the hash, with no separate hash object or backup category.

The current hash contract does not include `verification_status_code`. Adding source provisional or ratified status to canonical R2 observations is a separate schema and contract-version change.

## AQI writer source boundary

For the current observation-derived Phase B AQI path:

- target-day observations are frozen from IngestDB and remain the source for target-day R2 observations and target-day AQI input;
- only the preceding 23 hourly PM2.5 and PM10 aggregates are read from ObsAQIDB as calculation context;
- context rows are never written into the target-day observation partition, included in its observation-content hash or emitted as previous-day AQI output;
- incomplete, truncated or out-of-retention context reads fail closed and keep pruning blocked.

The exact RPC, pagination, retention, diagnostics and recovery contract is defined in [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md).

## Binding documentation reading order

1. [`contract.md`](contract.md)
2. [`interfaces.md`](interfaces.md)
3. [`operations.md`](operations.md)
4. [`recovery.md`](recovery.md)
5. [`validation.md`](validation.md)
6. relevant files under [`decisions/`](decisions/)

For scheduled Integrity date selection, also read [`daily_profile_selection.md`](daily_profile_selection.md).

For observation-content hashing, Integrity comparison and Prune Daily Phase B writes, also read both [`integrity.md`](integrity.md) and [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md).

## Integrity repair execution scope

A complete connector-day Integrity repair remains pollutant-scoped. The selected pollutant set passes unchanged to the shared source-to-R2 worker, which filters adapter bindings before mapping guards while retaining complete connector-day source evidence. Complete connector-day mode must not use a timeseries-ID filter.

UK-AIR CSV heading decisions are maintained in the Integrity SQLite source-label registry. The registry is authoritative for approved SOS heading-to-pollutant decisions, while core mappings are consistency checks when present. An automatic mapped decision requires exactly one active supported mapping with an explicit expected unit; multiple active mappings require review, and stale unreviewed automatic decisions return to review without changing operator-reviewed decisions. Python's broad cached-heading inventory is warning-only. The worker derives the exact required files from validated active connector-day mappings and keeps their availability, readability and identity checks fail-closed. Each SOS repair receives one UTF-8 content-hashed and exact-file-hashed JSON snapshot for detector and proposal stages; non-SOS connectors do not load it. Unknown headings are treated as review, skipped and reported rather than broadening repair scope. For an approved heading, a source site/pollutant with no authoritative active timeseries binding is warning-only: it is recorded as `no_authoritative_timeseries_binding`, its rows are excluded from canonical output and every expected count and observation-content hash, and other valid sites continue. Integrity never invents a binding. Ambiguous or contradictory bindings, incompatible units and invalid selected canonical rows remain fail-closed. Section-level unit evidence is independent of target-day rows, so zero target-day values do not require a target-day unit cell. Only approved mappings for `pm25`, `pm10`, `no2` and observation-only `o3` enter canonical processing. Operational validation runs only through `uk-aq-history-integrity.sh` on the dedicated Integrity machine, not on a development laptop with online-only Dropbox files; a JSON end-of-input error from an empty, unavailable or truncated online-only placeholder does not prove that the operational copy is corrupt.

## Implementation ownership

- `scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs`
- `workers/shared/uk_aq_observation_content_hash.mjs`
- `workers/shared/uk_aq_r2_history_index.mjs`
- `workers/uk_aq_observs_history_r2_api_worker/`
- `workers/uk_aq_aqi_history_r2_api_worker/`
- `workers/uk_aq_cache_proxy/src/station_history/`
- `workers/uk_aq_prune_daily/phase_b_history_r2.mjs`
- `workers/uk_aq_backfill_local/`
- `lib/aqi/aqi_levels.mjs`
- `scripts/backup_r2/`
- `scripts/uk-aq-history-integrity/`

The binding contract does not own daily observation or AQI coverage. The daily-profile selection contract owns scheduled Integrity date selection. The write-pipeline document owns Phase B source selection, observation-content-hash publication, calculation boundaries, writes and completion gates, but not public display semantics.
