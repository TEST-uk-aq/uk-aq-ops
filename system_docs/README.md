# UK AQ Ops authoritative system documentation

This directory contains the authoritative behavioural and operational documentation for the active `uk-aq-ops` systems.

The documents are written for both people and coding agents. Human-readable Markdown is the source of truth. There is no separate Codex-only behavioural specification.

`system_docs/` is the sole active system-documentation root. Do not create a second top-level `docs/` tree. Historical reports and superseded broad documents belong under `system_docs_legacy/` and are not current operating instructions.

## Authority and document types

Documents in an area directory have the following roles:

- `README.md`: area orientation, ownership and reading order.
- `contract.md`: authoritative required behaviour and explicit non-goals.
- `data_flow.md`: inputs, processing stages, outputs and component boundaries.
- `state_model.md`: persistent and transient state, identities and transition rules.
- `interfaces.md`: message, object, API and database-facing contracts.
- `operations.md`: deployment, scheduling, monitoring and routine operation.
- `recovery.md`: repair, rebuild and rollback procedures where a separate file is warranted.
- `validation.md`: targeted deterministic checks and TEST operational validation.
- `decisions/`: Architecture Decision Records explaining why load-bearing choices were made.

Worker-local `README.md` files remain useful implementation guides, but they do not override an area `contract.md`.

Plans describe proposed work. Archives and `system_docs_legacy/` describe historical implementations or superseded broad documents. None is authoritative for current runtime behaviour unless an authoritative area document explicitly incorporates the relevant decision.

## Required reading order

Before changing an active system area:

1. Read this index.
2. Read the area's `README.md`.
3. Read the area's `contract.md` when present.
4. Read the files linked under that area's implementation ownership section.
5. Read any relevant decision records.
6. Confirm the requested change against the area's explicit non-goals.

If code and the documented contract disagree, do not silently choose one. Record the conflict and identify whether the task is:

- correcting the implementation to match the contract;
- intentionally changing the contract and implementation together; or
- correcting inaccurate documentation without changing behaviour.

## Change rule

An intentional behavioural change must update the authoritative documents in the same branch or pull request, or through the explicitly assigned post-implementation ChatGPT documentation phase.

An implementation-only change that preserves behaviour does not require artificial wording changes, but its change report must state:

- which authoritative documents were reviewed;
- which behaviours were deliberately preserved;
- why no contract update was necessary.

See [`documentation_contract.md`](documentation_contract.md) for the full maintenance rules.

## Active system-area map

| Area | Authoritative directory | Current status |
|---|---|---|
| Latest snapshot builder, R2 API and cache-proxy boundary | [`latest_snapshot/`](latest_snapshot/) | Authoritative and current, including all-only physical snapshots, validated warm local cache and failures-by-default run reports |
| Raw observations and AQI R2 history | [`r2_history/`](r2_history/) | Binding index, integrity and active AQI write-pipeline contracts are current; remaining history migration is pending |
| Prune daily and backup gating | `prune_and_retention/` | Migration analysis pending |
| Observs outbox and partition maintenance | `observs_operations/` | Migration analysis pending |
| AQI generation and WHO summaries outside the R2 write pipeline | `aqi/` | Migration analysis pending |
| Public and private R2-backed APIs | `api_services/` | Migration analysis pending |
| Cache proxy and website routing | `cache_proxy/` | Migration analysis pending |
| R2 and database backups, restore and repair | `backup_and_recovery/` | Migration analysis pending |
| Cloudflare and GCP scheduling | `scheduling/` | Migration analysis pending |
| Task health, metrics and operational dashboards | `monitoring/` | Migration analysis pending |
| Hosted and local administrative dashboards | [`dashboards/`](dashboards/) | Authoritative and current |
| Postcode and geography lookup products | [`geography/`](geography/) | Authoritative and current |
| Shared runtime components and cross-area invariants | `shared/` | Migration analysis pending |

Directories marked as pending are proposed area boundaries, not yet authoritative replacements for existing documents. Existing legacy documents remain relevant evidence until their migration is explicitly recorded, but they must not override a completed area contract.

## Current authoritative areas

The completed [`latest_snapshot/`](latest_snapshot/) area governs:

- `workers/uk_aq_latest_snapshot_cloud_run/`;
- `workers/uk_aq_latest_snapshot_r2_api_worker/`;
- the latest-snapshot route boundary in `workers/uk_aq_cache_proxy/src/index.ts`;
- latest-snapshot state seed, repair and rebuild tooling;
- `.github/workflows/uk_aq_latest_snapshot_cloud_run_deploy.yml`;
- `.github/workflows/uk_aq_latest_snapshot_r2_api_worker_deploy.yml`.

It defines:

- latest-valid state;
- R2 as durable authority;
- the disposable ETag-validated local cache for state, metadata cache and manifest;
- the three physical pollutant `window=all` objects;
- request-time finite-window derivation;
- the physical manifest;
- failures-by-default R2 run-report policy;
- public v2 compatibility;
- minimal TEST validation and rollback policy.

The R2-history documents in [`r2_history/`](r2_history/) currently govern:

- stable v2 timeseries binding identity and routing;
- binding publication and reconciliation;
- v2 integrity detection, repair planning and repair execution;
- the active Prune Daily Phase B AQI history write and targeted-index gates.

They do not yet replace every legacy R2 layout, backup, read-API or general operations document.

The completed [`dashboards/`](dashboards/) area governs the hosted Pages and API Worker architecture, the local Python dashboard, station snapshot behaviour, displayed data-source ownership, deployment and TEST validation.

The completed [`geography/`](geography/) area governs ONSPD postcode builds and lookup routes, PCON and local-authority boundary shards, source-version selection, upload behaviour and TEST validation.

## Repository-wide rules already defined elsewhere

`AGENTS.md` contains repository operating constraints, including:

- TEST-only scope unless LIVE is explicitly requested;
- minimal pre-deployment validation and real TEST operational validation;
- archive execution policy;
- pre-change archive requirements;
- schema placement rules;
- R2 index byte-stability requirements;
- limits on deployments and external operations.

Those constraints apply in addition to the behavioural contracts in this directory.
