# Retired index-v3 experiments and legacy AQI tools

Archived: 16/09/2026

This archive contains implementation experiments and superseded operator tooling
that are no longer part of the current UK AQ runtime or the planned LIVE
index-v3 migration path.

Archived groups:

- `scripts/index_v3_aligned_candidate/`
- `scripts/index_v3_leaf_fanout_candidate/`
- `scripts/index_v3_physical_candidate/`
- `scripts/index_v3_physical_candidate_1024/`
- `scripts/index_v3_physical_leaf_candidate/`
- `scripts/index_v3_prototype/`

These directories were candidate/prototype layouts used while developing the
final observation-history v3 architecture.

Also archived:

- `scripts/index_v3_migration/index_v3_migration.sh`
  - Historical in-place/Dropbox recovery wrapper.
  - Superseded by the active side-by-side Node migration CLI:
    `scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs`.

- `scripts/index_v3_migration/measure_observation_history_v3_candidate.mjs`
  - Measurement utility for the superseded candidate implementation.

- `scripts/R2_v2_implementation/aqi_v2_dropbox_builder_TEST.mjs`
- `scripts/R2_v2_implementation/rebuild_aqilevels_v2_from_r2_dropbox_local_TEST.sh`
  - TEST-only persisted AQI-v2 rebuild tooling from the retired stored-AQI path.
  - Current visible AQI is calculated from authoritative observations.

The current generation-aware runtime, side-by-side v2-to-v3 migration tooling,
LIVE-capable operator tooling, current TEST repair tooling, and current migration
documentation remain in their active locations.
