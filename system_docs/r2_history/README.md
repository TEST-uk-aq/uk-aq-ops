# R2 history

## Current authority

This area governs:

- stable v2 physical timeseries binding identity and routing;
- embedded multi-member continuity families in schema-version-2 bindings;
- v2 history Integrity detection, planning and repair;
- latest-complete selection and immutable run-scoped core snapshot identity for every Integrity invocation;
- the dedicated SOS historical complete-partition replacement path;
- post-verification reconciliation of `timeseries` freshness and Latest Snapshot current state;
- scheduled Integrity daily date selection;
- the connector-specific IngestDB-to-R2 boundary used by Integrity;
- concurrent Prune Daily and Integrity writer coordination;
- connector-day, day-finalisation and global-index advisory locks;
- Supabase project isolation and database-local advisory-lock identity;
- the shared canonical R2 v2 connector-day writer and parent finalisers;
- exact sparse affected-day index finalisation without intervening-range expansion;
- the active Prune Daily Phase B observation and observation-derived AQI history write pipeline;
- the 30-minute Prune Daily worker envelope and internal Phase B budget;
- connector-day observation deletion gates and aggregate whole-day completion gates;
- versioned canonical connector-day source identity for deletion authority;
- Prune Daily-only deletion authority and deletion-time completion-source/count/source-identity validation;
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
- [`integrity_core_snapshot_identity.md`](integrity_core_snapshot_identity.md) for latest-complete snapshot selection and one immutable coordinator-selected identity across every detector, proposal, apply and verification process boundary;
- [`sos_historical_repair_contract.md`](sos_historical_repair_contract.md) for write-enabled SOS historical complete-partition replacement;
- [`integrity_apply_safety_contract.md`](integrity_apply_safety_contract.md) for proposal ownership and generic apply safety, subject to the SOS mode-specific amendment above;
- [`current_state_reconciliation.md`](current_state_reconciliation.md) where a verified history repair can affect `timeseries` freshness or Latest Snapshot;
- [`../latest_snapshot/integrity_reconciliation.md`](../latest_snapshot/integrity_reconciliation.md) for the Latest Snapshot owner-service boundary;
- [`history_writer_coordination.md`](history_writer_coordination.md) for the request-level IngestDB boundary, shared writer and lock hierarchy;
- [`lock_environment_boundary.md`](lock_environment_boundary.md) for the authoritative Supabase-project boundary and lock-key inputs;
- [`implementation_safety_contract.md`](implementation_safety_contract.md) for exact affected-day finalisation, shared-writer compliance, deletion-gate validation and active v2-only AQI enforcement;
- [`prune_connector_day_gate.md`](prune_connector_day_gate.md) for the Prune Daily-only observation deletion gate;
- [`prune_connector_source_identity.md`](prune_connector_source_identity.md) where candidate or gate evidence can affect deletion;
- [`connector_gate_file_identity.md`](connector_gate_file_identity.md) for physical Parquet identity validation used by Prune Daily gate completion and explicit recovery verification;
- [`daily_profile_selection.md`](daily_profile_selection.md) where scheduled selection is involved.

For Prune Daily Phase B observation/AQI writes and IngestDB deletion safety, read in this order:

1. [`history_writer_coordination.md`](history_writer_coordination.md)
2. [`lock_environment_boundary.md`](lock_environment_boundary.md)
3. [`implementation_safety_contract.md`](implementation_safety_contract.md)
4. [`prune_daily_runtime_budget.md`](prune_daily_runtime_budget.md)
5. [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md)
6. [`prune_daily_observation_only_phase_b_contract.md`](prune_daily_observation_only_phase_b_contract.md)
7. [`prune_connector_day_gate.md`](prune_connector_day_gate.md)
8. [`prune_connector_source_identity.md`](prune_connector_source_identity.md)
9. [`connector_gate_file_identity.md`](connector_gate_file_identity.md)

For calculated station-chart AQI and website display, also read:

- [`../aqi-levels/README.md`](../aqi-levels/README.md);
- [`../aqi-levels/station-history-contract.md`](../aqi-levels/station-history-contract.md);
- [`../aqi-levels/station-history-validation.md`](../aqi-levels/station-history-validation.md).

## Integrity core snapshot identity

The authoritative contract is [`integrity_core_snapshot_identity.md`](integrity_core_snapshot_identity.md).

Required behaviour includes:

- at run initialisation, Integrity discovers the committed core snapshots that actually exist in the chosen Dropbox baseline;
- candidates are checked newest first and the latest complete structurally valid snapshot is selected;
- a snapshot for the current UTC day is not required;
- a newer incomplete candidate may be skipped in favour of the next older complete candidate, with the rejection recorded;
- the run-scoped identity includes the canonical core manifest key and its immutable manifest identity where available;
- every detector, proposal, apply and final-verification child receives and validates that same identity explicitly;
- no child may derive a new core snapshot from the current clock or independently select the newest locally visible snapshot;
- crossing midnight UTC does not change the snapshot used by an existing invocation;
- missing, contradictory or unavailable pinned identity fails before proposal construction or live R2 mutation;
- check-only, dry-run, generic repair and SOS-light share the same selection and propagation rules;
- a later separate invocation repeats latest-complete selection and may independently choose a newer committed snapshot;
- JSON, Markdown and log audit evidence records candidate selection, the pinned identity and process-boundary agreement.

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
- [`sos_historical_repair_contract.md`](sos_historical_repair_contract.md) for the dedicated write-enabled SOS complete-replacement and single ordered live-verification path;
- [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md) for the normal Phase B writer, canonical Parquet schema and manifest publication;
- [`history_writer_coordination.md`](history_writer_coordination.md) for shared writer ownership and concurrent live mutation;
- [`implementation_safety_contract.md`](implementation_safety_contract.md) for the requirement that both live mutation paths use the same canonical builders and validators rather than only a common lock wrapper;
- [`prune_connector_source_identity.md`](prune_connector_source_identity.md) for the separate connector-day operational source identity used by Prune Daily deletion authority.

Required behaviour includes:

- canonical observation rows contain nullable `verification_status`;
- UK-AIR SOS stores `P`, `R` or null after deterministic normalisation;
- unknown non-empty UK-AIR SOS status values fail closed;
- legacy readers prefer `verification_status`, then legacy `status`, then null;
- new writers emit only `verification_status`;
- one deterministic `observation_content_hash` exists per non-empty v2 observation pollutant partition;
- the hash covers every canonical row including `verification_status`;
- the pollutant manifest contains deterministic status counts;
- the existing Dropbox manifest/day backup carries the data and hash without a separate hash object;
- Prune Daily additionally persists a distinct versioned connector-day source hash built from the same canonical row encoder.

## Current-state reconciliation

The authoritative reconciliation contract is [`current_state_reconciliation.md`](current_state_reconciliation.md).

Required behaviour includes:

- reconciliation runs only after final verified R2 observation evidence exists;
- `timeseries.last_value_at` and `timeseries.last_value` are updated only through a private schema-owned monotonic RPC;
- Latest Snapshot state and products are updated only through the existing authenticated Latest Snapshot owner service;
- Integrity never writes Latest Snapshot R2 objects directly;
- O3 may update timeseries freshness but remains outside Latest Snapshot;
- older candidates cannot move current state backwards;
- identical same-timestamp content is a no-op;
- a different final verified same-timestamp value or status may be applied once as a correction;
- check-only and dry-run modes remain non-mutating;
- R2 history, timeseries reconciliation and Latest Snapshot reconciliation retain separate component statuses;
- the dedicated SOS historical path retains both Timeseries and Latest Snapshot reconciliation after its ordered live R2 verification succeeds;
- the line chart continues using its normal recent-head and R2 history routes without a browser-side SOS fallback.

## Shared history writer and lock hierarchy

The authoritative coordination contracts are:

- [`history_writer_coordination.md`](history_writer_coordination.md);
- [`lock_environment_boundary.md`](lock_environment_boundary.md), which supersedes any older requirement to include an environment label in the lock key;
- [`implementation_safety_contract.md`](implementation_safety_contract.md), which supersedes conflicting implementation assumptions and defines exact affected-day finalisation.

Required behaviour includes:

- each connector has one continuous boundary, with earlier days in R2 History and the earliest IngestDB day and later owned by Prune Daily;
- if any requested connector's Integrity range reaches its earliest IngestDB day, the complete Integrity request fails immediately;
- Integrity does not clip the range or skip only the blocking connector;
- Prune Daily and Integrity may run concurrently on non-conflicting work;
- no global "Prune Daily is running" exclusion is required;
- live writers share a connector-day lock for exact `day_utc + connector_id` mutation;
- parent day-manifest merging is serialised by a day-finalisation lock;
- aggregate/latest index updates are serialised by one database-local global index lock;
- TEST and LIVE isolation is provided by their separate Supabase projects;
- environment labels are diagnostic only and are not advisory-lock key input;
- locks are acquired sequentially and are not nested across those three scopes;
- day finalisation preserves connectors already present in R2 and does not rebuild a day solely from the current run's connector set;
- sparse affected-day sets remain exact and are not expanded into all intervening calendar days;
- a shared lock wrapper around caller-owned write implementations is not a substitute for one canonical writer implementation.

## Prune Daily runtime budget

The authoritative runtime envelope is defined in [`prune_daily_runtime_budget.md`](prune_daily_runtime_budget.md).

Required active values are:

```text
UK_AQ_PRUNE_DAILY_PHASE_B_MAX_SECONDS_PER_RUN=1740
UK_AQ_PRUNE_DAILY_PHASE_B_STOP_BEFORE_TIMEOUT_SECONDS=60
Phase B effective deadline=1680 seconds
worker hard timeout=30 minutes
GitHub Actions job timeout=40 minutes
```

The retired broad variable names are not supported as aliases.

## Prune deletion gate and source identity

The authoritative gate split is defined in [`prune_connector_day_gate.md`](prune_connector_day_gate.md). Physical Parquet identity validation is defined in [`connector_gate_file_identity.md`](connector_gate_file_identity.md). Deletion-time source identity is defined in [`prune_connector_source_identity.md`](prune_connector_source_identity.md). General deletion-time evidence requirements are tightened by [`implementation_safety_contract.md`](implementation_safety_contract.md).

Required behaviour includes:

- IngestDB observation deletion is authorised by the exact `day_utc + connector_id` gate;
- one incomplete connector does not block another complete connector on the same day;
- the existing day gate remains the aggregate whole-day completion gate;
- a day gate cannot substitute for missing connector-level evidence;
- only Prune Daily may establish, invalidate or complete connector-day prune gates;
- deletion authority requires `completion_source=prune_daily_phase_b`, complete valid manifest/count evidence and matching versioned current source identity;
- current canonical IngestDB identity, candidate identity and gate identity must match immediately before deletion;
- source revalidation and deletion occur in one PostgreSQL transaction and database session;
- existing null-identity evidence is ineligible and is reprocessed rather than backfilled;
- Integrity-created, legacy or adoption gate rows are ineligible for deletion even when `history_done=true`;
- Integrity, migration and generic shared-writer code never update prune gates;
- historical R2 connector-days with no corresponding IngestDB rows require no prune gate;
- every referenced Parquet must match its required physical identity before Prune Daily completes the connector gate;
- AQI success is not required for connector observation pruning;
- check-only and dry-run Integrity modes cannot change prune eligibility;
- if the aggregate day gate is retained, its totals must describe the complete merged day manifest rather than only the current run's candidates.

Prune Daily MUST NOT use Dropbox as a source, planning baseline, verification source or deletion authority.

## AQI writer source boundary

The only supported Phase B AQI implementation is the observation-derived writer defined in [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md).

Required behaviour includes:

- target-day IngestDB observations are the source for target-day R2 observations and target-day AQI input;
- only the preceding 23 hourly PM2.5 and PM10 observation aggregates are read from ObsAQIDB as calculation context;
- ObsAQIDB materialised AQI is not a Phase B source or fallback;
- context rows are not written into the target-day observation partition or previous-day AQI output;
- the legacy AQI RPC/export selector, aliases, v1 AQI output path and fallback implementation are retired;
- the active Phase B AQI path requires `UK_AQ_R2_HISTORY_VERSION=v2` and fails closed rather than executing a v1 branch;
- incomplete or truncated context fails AQI for the affected connector-day;
- an AQI-only failure does not block or revoke a verified connector observation deletion gate;
- AQI data, debug, manifest and index completion remain separate aggregate outcomes;
- the dedicated SOS historical replacement path does not invoke or validate AQI data, AQI debug, AQI manifests or AQI indexes.

## Integrity historical rollover rule

Integrity must distinguish a date-invalid R2 member of a known continuity family from a genuinely unknown timeseries.

For the generic Integrity path, a bridge-known rollover retains its existing continuity-aware handling. For the dedicated SOS complete-replacement path, legacy R2-only identities inside the selected partition are diagnostic and do not require continuity mapping when complete current SOS evidence and valid replacement identities are available.

Unknown, ambiguous or contradictory identity in fresh selected SOS source evidence remains fail-closed. The established warning-only `no_authoritative_timeseries_binding` case is excluded consistently and does not block other valid rows.

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
- `workers/uk_aq_latest_snapshot_cloud_run/` for the owner-service reconciliation operation
- `workers/uk_aq_prune_daily/server.mjs`
- `workers/uk_aq_prune_daily/phase_b_history_r2.mjs`
- `workers/uk_aq_backfill_local/`
- the dedicated SOS historical replacement route selected inside the existing repository-owned Integrity execution path
- the private schema migration and RPC used for monotonic timeseries reconciliation
- `lib/aqi/aqi_levels.mjs`
- `scripts/backup_r2/`
- `scripts/uk-aq-history-integrity/`

The binding and continuity contracts do not own daily observation or AQI coverage. Daily coverage remains in the domain manifests and timeseries file-range indexes.
