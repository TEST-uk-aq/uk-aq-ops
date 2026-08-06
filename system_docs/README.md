# UK AQ Ops authoritative system documentation

This directory contains the authoritative behavioural and operational documentation for active `uk-aq-ops` systems.

Human-readable Markdown is the source of truth for people and coding agents. There is no separate Codex-only behavioural specification.

`system_docs/` is the sole active system-documentation root. Historical and superseded broad documents belong under `system_docs_legacy/` and do not override active contracts.

Files under [`drafts/`](drafts/) are non-authoritative design drafts. They are not part of the required reading order and must not constrain current implementation unless the user explicitly asks to promote and implement a named draft.

## Authority and document types

Documents in an area directory normally have these roles:

- `README.md`: area orientation, ownership and reading order;
- `contract.md`: authoritative required behaviour and non-goals;
- specific `*-contract.md` files: authoritative narrower contracts that may deliberately amend a broad area contract for one path;
- `data_flow.md` or `data-flow.md`: inputs, processing and component boundaries;
- `state_model.md` or `state-model.md`: state, identities and transition rules;
- `interfaces.md`: API, message, object and database-facing contracts;
- `operations.md`: deployment, scheduling, monitoring and routine operation;
- `recovery.md`: repair, rebuild and rollback;
- `validation.md` and specific `*-validation.md` files: structural and TEST operational validation;
- `decisions/`: Architecture Decision Records.

Worker-local README files remain implementation guides. They do not override system contracts.

Plans, files under `system_docs/drafts/`, archives and `system_docs_legacy/` are not current runtime authority unless an active contract explicitly incorporates a decision from them.

## Required reading order

Before changing an active system area:

1. Read this index.
2. Read the area's `README.md`.
3. Read the broad `contract.md`.
4. Read any narrower contract named by the area README.
5. Read linked interfaces, operations, validation and decisions.
6. Confirm the requested change against explicit non-goals.

If code and documentation disagree, do not silently choose one. Report whether the task is:

- correcting implementation to match the contract;
- intentionally changing contract and implementation together; or
- correcting inaccurate documentation without changing behaviour.

## Change rule

An intentional behavioural change must update the authoritative documents in the same branch or through the explicitly assigned ChatGPT documentation phase.

Codex and other coding agents must not edit `system_docs/`. They read active contracts as authority and provide a handover for ChatGPT after implementation. They must ignore `system_docs/drafts/` unless the user explicitly names a draft for promotion or implementation.

See [`documentation_contract.md`](documentation_contract.md) for full maintenance rules.

## Active system-area map

| Area | Authoritative directory | Current status |
|---|---|---|
| Connector ingest and Daily Stations reference discovery | [`ingest/`](ingest/) | Authoritative for Daily Stations, Breathe London Nodes deterministic reference discovery and UK-AIR SOS polling/Cloud Run behaviour |
| Latest snapshot builder, R2 API and cache-proxy boundary | [`latest_snapshot/`](latest_snapshot/) | Authoritative and current |
| Raw observations and AQI R2 history | [`r2_history/`](r2_history/) | Authoritative for stable bindings, embedded continuity, current Integrity, targeted indexes, Phase B history writes and observations aggregate manifests |
| Calculated hourly AQI and station-chart bands | [`aqi-levels/`](aqi-levels/) | Authoritative and current, including continuity-aware calculated chart AQI and asynchronous R2 validation |
| WHO 2021 daily, rolling-year and calendar-year derived data | [`who_2021/`](who_2021/) | Authoritative for calculation completeness, readiness, source fallback, correction-day recalculation and publication ordering |
| Shared website station-chart frontend | [`station_charts/`](station_charts/) | Authoritative for modular chart architecture, browser cache ownership, AQI-source switching, rendering and page adapters |
| Prune daily and backup gating | `prune_and_retention/` | Migration analysis pending outside completed R2-history contracts |
| Observs outbox and partition maintenance | `observs_operations/` | Migration analysis pending |
| Public and private R2-backed APIs outside completed history/AQI boundaries | `api_services/` | Migration analysis pending |
| Cache proxy and website routing outside completed history/AQI boundaries | [`cache_proxy/`](cache_proxy/) | Authoritative for the WHO homepage summary route and UTC-day browser/edge cache; broader cache-proxy migration remains pending |
| R2 and database backups, restore and repair outside completed contracts | [`backup_and_recovery/`](backup_and_recovery/) | Authoritative for the Supabase logical database dump backup and R2 v2 history Dropbox backup inventory/checkpoint contract; broader migration remains pending |
| Cloudflare and GCP scheduling | `scheduling/` | Migration analysis pending |
| Task health, metrics and operational dashboards | `monitoring/` | Migration analysis pending |
| Hosted and local administrative dashboards | [`dashboards/`](dashboards/) | Authoritative and current |
| Postcode and geography lookup products | [`geography/`](geography/) | Authoritative and current |
| Shared runtime components and cross-area invariants | `shared/` | Migration analysis pending |

Directories marked pending are proposed area boundaries. They do not override completed contracts in `ingest/`, `r2_history/`, `aqi-levels/`, `who_2021/`, `station_charts/`, `latest_snapshot/`, `dashboards/`, `geography/` or the completed Supabase logical and R2 history Dropbox backup scopes in `backup_and_recovery/`.

## WHO 2021 reading set

Any change involving WHO daily means, readiness, correction-day processing, rolling-year or calendar-year status, source fallback or WHO summary publication must read:

1. [`who_2021/README.md`](who_2021/README.md)
2. [`who_2021/contract.md`](who_2021/contract.md)
3. [`who_2021/interfaces.md`](who_2021/interfaces.md)
4. [`who_2021/operations.md`](who_2021/operations.md)
5. [`cache_proxy/who-summary-contract.md`](cache_proxy/who-summary-contract.md) when the public homepage route or cache behaviour is also in scope

The WHO calculation contract deliberately separates the weak operational readiness gate from the 18-valid-hour daily and configured valid-day scientific-completeness rules.

## R2 history and station-history reading set

Any change involving timeseries identity, historical charts, R2 observations, R2 AQI, station-chart frontend behaviour or Integrity rollover repair must read:

1. [`r2_history/README.md`](r2_history/README.md)
2. [`r2_history/contract.md`](r2_history/contract.md)
3. [`r2_history/continuity.md`](r2_history/continuity.md)
4. [`r2_history/interfaces.md`](r2_history/interfaces.md)
5. [`r2_history/operations.md`](r2_history/operations.md)
6. [`r2_history/observations_manifest_hierarchy_contract.md`](r2_history/observations_manifest_hierarchy_contract.md)
7. [`r2_history/observations_run_exclusion_contract.md`](r2_history/observations_run_exclusion_contract.md)
8. [`aqi-levels/README.md`](aqi-levels/README.md)
9. [`aqi-levels/contract.md`](aqi-levels/contract.md)
10. [`aqi-levels/station-history-contract.md`](aqi-levels/station-history-contract.md)
11. [`aqi-levels/station-history-validation.md`](aqi-levels/station-history-validation.md)
12. [`station_charts/README.md`](station_charts/README.md)
13. [`station_charts/contract.md`](station_charts/contract.md)

The specific station-history contract deliberately changes visible chart AQI source precedence while preserving persisted R2 AQI as validation evidence.

The shared station-chart contract governs browser architecture, cache ownership, AQI-source switching, D3 rendering and page-adapter reuse without changing the Worker or R2 data contracts.

Before changing the R2 history Dropbox inventory or checkpoint layout, also read:

1. [`backup_and_recovery/README.md`](backup_and_recovery/README.md)
2. [`backup_and_recovery/r2_history_dropbox_backup_contract.md`](backup_and_recovery/r2_history_dropbox_backup_contract.md)

The proposed Integrity Factory is retained only as a non-authoritative draft at [`drafts/r2_history/integrity_factory_contract.md`](drafts/r2_history/integrity_factory_contract.md).

## Current continuity decision

The approved runtime design is Option 1:

- exact physical identity remains at the top level of `history/_index_v2/timeseries_binding/timeseries_id=<id>.json`;
- genuine multi-member families use schema version 2 with an embedded deterministic `continuity` section;
- exact-only single-member bindings may remain byte-identical schema version 1 objects;
- the logical key is `connector_id + uk_air_ref + pollutant_code`;
- `site_ref` is corroborating identity but not part of the key;
- low-level R2 APIs remain exact physical readers;
- the station-history Worker performs logical orchestration;
- no separate R2 continuity prefix or station-binding index is introduced.

## Current calculated station-chart AQI decision

When enabled:

- the station-history Worker merges date-valid physical observation segments into one logical observation stream;
- visible DAQI and European AQI are calculated from those same observations;
- PM rolling context may cross a physical timeseries transition;
- observations and calculated AQI are returned together;
- stored R2 AQI is compared asynchronously through Worker background execution;
- validation does not delay, fail or redraw the chart;
- the previous separate foreground R2 AQI path remains a feature-flag fallback;
- historical identity repair remains gated until TEST deployment succeeds.

The website consumes this through one shared modular station-chart controller and renderer. The compatibility source remains a data-client adapter rather than a second chart implementation.

## Repository-wide operating rules

`AGENTS.md` additionally defines:

- TEST-only scope unless LIVE is explicitly requested;
- minimal pre-deployment structural validation;
- real TEST operational validation after deployment;
- archive execution and pre-change archive rules;
- schema placement policy;
- R2 index byte-stability requirements;
- restrictions on deployments, SQL, backfills and cloud operations;
- `grep` as the preferred search tool.

Those rules apply in addition to these behavioural contracts.
