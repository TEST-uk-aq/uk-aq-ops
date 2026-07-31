# Ingest and Daily Stations

This area defines authoritative cross-repository behaviour for connector reference discovery, the Daily Stations workflow and connector-specific observation-ingest contracts.

The system documentation lives in `uk-aq-ops` even where implementation is owned by `uk-aq-ingest` or canonical database structure is owned by `uk-aq-schema`.

## Reading order

1. [`../README.md`](../README.md)
2. [`../documentation_contract.md`](../documentation_contract.md)
3. [`contract.md`](contract.md)
4. The relevant connector-specific area, where present
5. The implementation files listed by the relevant area README

For UK-AIR SOS polling and Cloud Run behaviour, continue with [`sos/README.md`](sos/README.md).

## Current authoritative scope

The current broad contract covers:

- the purpose and ordering of the Daily Stations workflow;
- Breathe London Nodes station and timeseries reference discovery;
- the boundary between daily reference discovery and quarter-hour observation ingestion;
- the reference-data prerequisites for mirroring IngestDB core rows into ObsAQIDB.

The connector-specific [`sos/`](sos/) area additionally covers:

- the shared UK-AIR SOS observation-polling path;
- SOS Cloud Run work selection and child-result handling;
- SOS polling checkpoints, failures, partial runs and intentional skips;
- SOS deployment, operation and focused TEST validation.

Other connector-specific Daily Stations and observation-ingest behaviour remains unchanged unless explicitly stated in an authoritative contract within this area.

## Implementation ownership

The active implementation is primarily in `TEST-uk-aq/uk-aq-ingest`, including:

- `.github/workflows/uk_aq_stations_daily.yml`;
- `scripts/blondon_nodes/blondon_nodes_list_stations.py`;
- `scripts/blondon_nodes/blondon_nodes_ingest.py`;
- shared phenomena and Supabase helpers used by those scripts;
- the final IngestDB-to-ObsAQIDB core reference synchronisation step;
- `supabase/functions/ingest_sos/`;
- `workers/uk_aq_sos_cloud_run/`;
- `.github/workflows/uk_aq_sos_cloud_run_deploy.yml`.

Canonical table, function and seed definitions remain owned by `TEST-uk-aq/uk-aq-schema`.

## Change ownership

Codex and other coding agents must treat this area as read-only authority. They may change implementation in the owning repositories, but must not edit `system_docs/`. Behavioural changes require a handover to ChatGPT for any necessary contract update.
