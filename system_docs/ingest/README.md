# Ingest and Daily Stations

This area defines the authoritative cross-repository behaviour for connector reference discovery and the Daily Stations workflow.

The system documentation lives in `uk-aq-ops` even where the implementation is owned by `uk-aq-ingest` or the canonical database structure is owned by `uk-aq-schema`.

## Reading order

1. [`../README.md`](../README.md)
2. [`../documentation_contract.md`](../documentation_contract.md)
3. [`contract.md`](contract.md)
4. The implementation files listed below

## Current authoritative scope

The current contract covers:

- the purpose and ordering of the Daily Stations workflow;
- Breathe London Nodes station and timeseries reference discovery;
- the boundary between daily reference discovery and quarter-hour observation ingestion;
- the reference-data prerequisites for mirroring IngestDB core rows into ObsAQIDB.

Other connector-specific Daily Stations behaviour remains unchanged unless explicitly stated in [`contract.md`](contract.md).

## Implementation ownership

The active implementation is primarily in `TEST-uk-aq/uk-aq-ingest`, including:

- `.github/workflows/uk_aq_stations_daily.yml`;
- `scripts/blondon_nodes/blondon_nodes_list_stations.py`;
- `scripts/blondon_nodes/blondon_nodes_ingest.py`;
- shared phenomena and Supabase helpers used by those scripts;
- the final IngestDB-to-ObsAQIDB core reference synchronisation step.

Canonical table, function and seed definitions remain owned by `TEST-uk-aq/uk-aq-schema`.

## Change ownership

Codex and other coding agents must treat this area as read-only authority. They may change implementation in the owning repositories, but must not edit `system_docs/`. Behavioural changes require a handover to ChatGPT for any necessary contract update.