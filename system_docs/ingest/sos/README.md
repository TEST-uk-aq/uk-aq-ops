# UK-AIR SOS system area

This directory is the authoritative UK-AIR SOS ingest documentation area within `TEST-uk-aq/uk-aq-ops`.

The prose contract lives in Ops even though runtime implementation is primarily owned by `TEST-uk-aq/uk-aq-ingest` and canonical database SQL is owned by `TEST-uk-aq/uk-aq-schema`.

## Reading order

1. [`../README.md`](../README.md)
2. [`../contract.md`](../contract.md)
3. [`contract.md`](contract.md)
4. [`interfaces.md`](interfaces.md)
5. [`operations.md`](operations.md)
6. [`validation.md`](validation.md)

## Authoritative scope

This SOS sub-area defines current observation-polling and Cloud Run behaviour for connector code `sos`, including:

- the shared `ingest_sos` polling path;
- Cloud Run work selection and child-process behaviour;
- polling checkpoints and run persistence;
- response, failure, partial-run and intentional-skip semantics;
- deployment, scheduling, runtime logging and focused TEST validation.

The parent [`../contract.md`](../contract.md) remains authoritative for cross-connector Daily Stations and reference-discovery behaviour.

The source documents moved into this directory do not contain a complete contract for SOS source discovery, station metadata, site-register loading, archive mapping or network assignment. Existing broad SOS documents in `uk-aq-ingest/system_docs/` remain temporarily authoritative only for those explicitly non-overlapping subjects until they are separately consolidated into this Ops area. They do not override the polling, Cloud Run, interface, operations or validation contracts here.

## Implementation ownership

The polling contract is implemented in `TEST-uk-aq/uk-aq-ingest`, principally by:

- `supabase/functions/ingest_sos/index.ts`;
- `supabase/functions/ingest_sos/failure.ts`;
- `workers/uk_aq_sos_cloud_run/run_job.ts`;
- `workers/uk_aq_sos_cloud_run/run_service.ts`;
- `workers/uk_aq_sos_cloud_run/result_contract.ts`;
- `workers/uk_aq_sos_cloud_run/Dockerfile`;
- `.github/workflows/uk_aq_sos_cloud_run_deploy.yml`.

Relevant persistent state includes:

- `uk_aq_core.connectors`;
- `uk_aq_core.timeseries`;
- `uk_aq_core.observations`;
- `uk_aq_core.uk_aq_ingest_runs`;
- `uk_aq_raw.sos_timeseries_checkpoints`;
- `uk_aq_raw.sos_station_checkpoints`;
- `uk_aq_raw.error_logs`.

## Change ownership

Codex and other coding agents must treat this directory as read-only authority. They may change implementation in the owning repositories, but must not edit `system_docs/`. Behavioural changes require a handover to ChatGPT for any necessary contract update.
