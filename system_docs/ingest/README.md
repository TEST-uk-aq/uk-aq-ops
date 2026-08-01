# Ingest and Daily Stations

This area defines authoritative cross-repository behaviour for connector reference discovery, the Daily Stations workflow, connector scheduling ownership and connector-specific observation-ingest contracts.

The system documentation lives in `uk-aq-ops` even where implementation is owned by `uk-aq-ingest` or canonical database structure is owned by `uk-aq-schema`.

## Reading order

1. [`../README.md`](../README.md)
2. [`../documentation_contract.md`](../documentation_contract.md)
3. [`contract.md`](contract.md)
4. The relevant connector-specific area, where present
5. The implementation files listed below or by the relevant area README

For UK-AIR SOS polling and Cloud Run behaviour, continue with [`sos/README.md`](sos/README.md).

## Current authoritative scope

The broad [`contract.md`](contract.md) covers:

- the purpose and ordering of the Daily Stations workflow;
- Breathe London Nodes station and timeseries reference discovery;
- the boundary between daily reference discovery and quarter-hour observation ingestion;
- the reference-data prerequisites for mirroring IngestDB core rows into ObsAQIDB;
- ownership of recurring external dispatch for TEST Cloud Run connector-ingest services.

The connector-specific [`sos/`](sos/) area additionally covers:

- the shared UK-AIR SOS observation-polling path;
- SOS Cloud Run work selection and child-result handling;
- SOS polling checkpoints, failures, partial runs and intentional skips;
- SOS deployment, operation and focused TEST validation.

Other connector-specific Daily Stations and observation-ingest behaviour remains unchanged unless explicitly stated in an authoritative contract within this area.

## Implementation ownership

The active implementation is primarily in `TEST-uk-aq/uk-aq-ingest`.

### Daily Stations and Breathe London Nodes reference discovery

- `.github/workflows/uk_aq_stations_daily.yml`;
- `scripts/blondon_nodes/blondon_nodes_list_stations.py`;
- `scripts/blondon_nodes/blondon_nodes_discover_timeseries.py`;
- `scripts/blondon_nodes/blondon_nodes_reference_data.py`;
- `scripts/blondon_nodes/blondon_nodes_ingest.py`;
- shared phenomena and Supabase helpers used by those scripts;
- the final IngestDB-to-ObsAQIDB core reference synchronisation step.

`blondon_nodes_reference_data.py` owns the shared species definitions and deterministic timeseries-row construction. `blondon_nodes_discover_timeseries.py` establishes and verifies the complete active reference set without fetching observations. `blondon_nodes_ingest.py` reuses the shared definitions for its defensive timeseries upsert.

Daily Stations runs discovery immediately after the Nodes station import and before the ObsAQIDB reference mirror. Successful discovery emits `DISCOVERY_SUMMARY_JSON`. The Nodes Cloud Run deployment path filter includes the shared reference-data module.

### Connector Cloud Run deployment workflows

The five TEST connector deployment workflows are:

- `.github/workflows/uk_aq_blondon_nodes_cloud_run_deploy.yml`;
- `.github/workflows/uk_aq_blondon_communities_cloud_run_deploy.yml`;
- `.github/workflows/uk_aq_sos_cloud_run_deploy.yml`;
- `.github/workflows/uk_aq_openaq_cloud_run_deploy.yml`;
- `.github/workflows/uk_aq_scomm_cloud_run_deploy.yml`.

The shared Cloudflare scheduler URL reconciliation helper is:

```text
scripts/cloudflare/uk_aq_reconcile_ingest_scheduler_url.sh
```

Each deployment workflow owns its Cloud Run service deployment and reconciles the resulting service URL into the corresponding Cloudflare D1 scheduler job. Cloudflare owns recurring external dispatch. The deployment workflows do not own Google Cloud Scheduler jobs.

OpenAQ retains its Cloud Tasks queue and worker-created one-off tasks as its primary self-scheduling path. Its Cloudflare D1 job is the external safety trigger.

The authoritative ownership rules and protected unchanged behaviour are defined in [`contract.md`](contract.md#connector-ingest-scheduler-ownership).

### Connector runtime implementation

Relevant runtime areas include:

- `supabase/functions/ingest_sos/`;
- `workers/uk_aq_sos_cloud_run/`;
- `workers/uk_aq_blondon_nodes_cloud_run/`;
- `workers/uk_aq_blondon_communities_cloud_run/`;
- `workers/uk_aq_openaq_cloud_run/`;
- `workers/uk_aq_sensorcommunity_cloud_run/`.

Canonical table, function and seed definitions remain owned by `TEST-uk-aq/uk-aq-schema`.

## Change ownership

Codex and other coding agents must treat this area as read-only authority. They may change implementation in the owning repositories, but must not edit `system_docs/`. Behavioural changes require a handover to ChatGPT for any necessary contract update.
