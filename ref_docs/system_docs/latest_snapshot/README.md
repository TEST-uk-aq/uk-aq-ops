# Latest Snapshot

## Purpose

This directory contains the authoritative contracts for the UK AQ Latest Snapshot current-state product, its public v2 API, website consumers and R2 History Integrity reconciliation through the Latest Snapshot owner service.

This README is an area router. Detailed required behaviour belongs in the linked contracts.

For the cross-system map, start with [`../SYSTEM_OVERVIEW.md`](../SYSTEM_OVERVIEW.md).

## Current authority

Latest Snapshot is a derived current-state product, not the authoritative raw observation record.

The broad behavioural authority is [`contract.md`](contract.md). It owns latest-valid state, supported pollutants/windows, physical snapshot generation, finite-window derivation, durable R2 authority, warm local caching, run-report policy and the public R2 API behaviour.

The legacy Supabase current-reading path is retired and must not be used as a fallback.

R2 History Integrity may supply final verified candidates only through the authenticated owner-service boundary in [`integrity_reconciliation.md`](integrity_reconciliation.md). Integrity does not write Latest Snapshot R2 state or products directly.

Public v2 rows include authoritative `connector_id` under [`public-row-connector-identity-contract.md`](public-row-connector-identity-contract.md). That narrow amendment governs where older broad row-shape wording differs on this field.

## Choose the smallest task route

Read only the route matching the task.

### Core builder, state or API behaviour

Start with [`contract.md`](contract.md).

Add only when needed:

- [`data_flow.md`](data_flow.md) for component/data boundaries;
- [`state_model.md`](state_model.md) for durable state identity and transitions;
- [`interfaces.md`](interfaces.md) for public/private request and row interfaces;
- [`operations.md`](operations.md) for deployment, scheduling and routine operation;
- [`recovery.md`](recovery.md) for rebuild/repair/recovery;
- [`validation.md`](validation.md) for structural and TEST operational validation.

Do not read all supporting files for every task.

### Public row connector identity

For `connector_id`, connector/network identity or translating a latest row into an authoritative history request, start with:

1. [`public-row-connector-identity-contract.md`](public-row-connector-identity-contract.md)
2. [`interfaces.md`](interfaces.md)

Add [`contract.md`](contract.md) only when broader Latest Snapshot semantics also change.

### Future canonical physical-site projection

**Status: future implementation authority; TEST-first, not current runtime.**

For additive `match_id`, UK-AIR identity and canonical site-network projection in public latest rows, read:

1. [`canonical-site-projection-contract.md`](canonical-site-projection-contract.md)
2. [`../station_identity/README.md`](../station_identity/README.md)

Add [`interfaces.md`](interfaces.md) only when checking the current row/interface baseline that the future contract amends. The future projection MUST preserve source-row connector and scalar network provenance and MUST NOT deduplicate the durable latest-state object itself.

### Integrity reconciliation

For current-state reconciliation after verified historical repair, start with:

1. [`integrity_reconciliation.md`](integrity_reconciliation.md)
2. [`../r2_history/current_state_reconciliation.md`](../r2_history/current_state_reconciliation.md)

Add [`contract.md`](contract.md) when normal state/product rules are in scope, and [`decisions/0004-integrity-reconciliation-through-owner-service.md`](decisions/0004-integrity-reconciliation-through-owner-service.md) only when the architectural rationale is useful.

Read [`../r2_history/README.md`](../r2_history/README.md) only when the task also changes upstream Integrity repair or verification behaviour.

### Homepage consumer

For the homepage `Highest sensor readings` consumer, start with [`homepage-consumer-contract.md`](homepage-consumer-contract.md).

Add [`contract.md`](contract.md) only for backend data/API changes. For surrounding page layout/navigation, add [`../website_ui/README.md`](../website_ui/README.md).

### Sensor Map consumer

For Sensor Map current readings, observation windows or geometry behaviour, start with [`sensor-map-consumer-contract.md`](sensor-map-consumer-contract.md).

Add [`contract.md`](contract.md) only for backend data/API changes. For surrounding page presentation, add [`../website_ui/README.md`](../website_ui/README.md).

### Core metadata-cache freshness

Start with:

1. [`contract.md`](contract.md)
2. [`decisions/0006-core-metadata-cache-follows-latest-core-snapshot.md`](decisions/0006-core-metadata-cache-follows-latest-core-snapshot.md)

Add [`operations.md`](operations.md) only for deployment/configuration work.

### Warm local cache or run-report policy

Start with:

1. [`contract.md`](contract.md)
2. [`decisions/0003-warm-local-cache-and-run-report-policy.md`](decisions/0003-warm-local-cache-and-run-report-policy.md)

Add [`operations.md`](operations.md) for runtime configuration or deployment work.

### Recovery or rebuild

Start with:

1. [`recovery.md`](recovery.md)
2. [`contract.md`](contract.md)

Add [`state_model.md`](state_model.md) only when durable state identity or transitions are being reconstructed or changed.

## Decision records

Architecture decisions are indexed in [`decisions/README.md`](decisions/README.md). They explain rationale and are not part of the default reading path or a substitute for the active contract.

## Area boundaries

Latest Snapshot owns current-state derivation and publication, not upstream raw observation history.

Cross-area owners include:

- historical observation repair: [`../r2_history/README.md`](../r2_history/README.md);
- public website shell/responsive presentation: [`../website_ui/README.md`](../website_ui/README.md);
- station-history/calculated AQI: [`../aqi-levels/README.md`](../aqi-levels/README.md).

Use [`../READING_GUIDE.md`](../READING_GUIDE.md) only when the task genuinely crosses an area boundary.

## Implementation ownership

Implementation is primarily in `uk-aq-ops` Latest Snapshot Cloud Run, the private R2 API Worker, cache-proxy routing, state/recovery scripts and the authenticated owner-service reconciliation operation. Public homepage and Sensor Map consumers are implemented in the website repository.

The raw observation publisher and R2 observation-history writer are upstream systems and are not owned by this area.

## Documentation status

This README intentionally does not maintain dated implementation-status claims or duplicate object matrices, row fields, state replacement rules, window filtering, cache validation, run-report modes or reconciliation transitions. Those details belong in the active contracts and ADRs.

Worker-local READMEs and historical plans remain implementation/context material and do not override this area.
