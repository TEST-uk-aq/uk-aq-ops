# UK AQ Ops authoritative system documentation

This directory contains the authoritative behavioural and operational documentation for the active `uk-aq-ops` systems.

The documents are written for both people and coding agents. Human-readable Markdown is the source of truth. There is no separate Codex-only behavioural specification.

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

Plans describe proposed work. Archives describe historical implementations. Neither is authoritative for current runtime behaviour unless an authoritative area document explicitly incorporates the relevant decision.

## Required reading order

Before changing an active system area:

1. Read this index.
2. Read the area's `README.md`.
3. Read the area's `contract.md`.
4. Read the files linked under that area's implementation ownership section.
5. Read any relevant decision records.
6. Confirm the requested change against the area's explicit non-goals.

If code and the documented contract disagree, do not silently choose one. Record the conflict and identify whether the task is:

- correcting the implementation to match the contract;
- intentionally changing the contract and implementation together; or
- correcting inaccurate documentation without changing behaviour.

## Change rule

An intentional behavioural change must update the authoritative documents in the same branch or pull request.

An implementation-only change that preserves behaviour does not require artificial wording changes, but its change report must state:

- which authoritative documents were reviewed;
- which behaviours were deliberately preserved;
- why no contract update was necessary.

See [`documentation_contract.md`](documentation_contract.md) for the full maintenance rules.

## Active system-area map

| Area | Authoritative directory | Current status |
|---|---|---|
| Latest snapshot builder, R2 API and cache-proxy boundary | [`latest_snapshot/`](latest_snapshot/) | Initial authoritative contract created |
| Raw observations R2 history and indexes | `r2_history/` | Migration analysis pending |
| Prune daily and backup gating | `prune_and_retention/` | Migration analysis pending |
| Observs outbox and partition maintenance | `observs_operations/` | Migration analysis pending |
| AQI generation, AQI history and WHO summaries | `aqi/` | Migration analysis pending |
| Public and private R2-backed APIs | `api_services/` | Migration analysis pending |
| Cache proxy and website routing | `cache_proxy/` | Migration analysis pending |
| R2 and database backups, restore and repair | `backup_and_recovery/` | Migration analysis pending |
| Cloudflare and GCP scheduling | `scheduling/` | Migration analysis pending |
| Task health, metrics and operational dashboards | `monitoring/` | Migration analysis pending |
| Postcode and geography lookup products | `geography/` | Migration analysis pending |
| Shared runtime components and cross-area invariants | `shared/` | Migration analysis pending |

Directories marked as pending are proposed area boundaries, not yet authoritative replacements for existing documents. Existing documents remain in force until their migration is explicitly recorded here.

## Current authoritative area

The first completed area is [`latest_snapshot/`](latest_snapshot/). It governs:

- `workers/uk_aq_latest_snapshot_cloud_run/`;
- `workers/uk_aq_latest_snapshot_r2_api_worker/`;
- the latest-snapshot route boundary in `workers/uk_aq_cache_proxy/src/index.ts`;
- latest-snapshot state seed, repair and rebuild tooling;
- `.github/workflows/uk_aq_latest_snapshot_cloud_run_deploy.yml`;
- `.github/workflows/uk_aq_latest_snapshot_r2_api_worker_deploy.yml`.

## Repository-wide rules already defined elsewhere

`AGENTS.md` contains repository operating constraints, including:

- TEST-only scope unless LIVE is explicitly requested;
- archive execution policy;
- pre-change archive requirements;
- schema placement rules;
- R2 index byte-stability requirements;
- limits on deployments and external operations.

Those constraints apply in addition to the behavioural contracts in this directory.
