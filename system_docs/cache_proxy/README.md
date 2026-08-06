# Cache proxy authoritative documentation

This area contains authoritative behavioural contracts for cache-proxy routes that have completed migration into the structured `system_docs/` model.

## Current authoritative scope

The current migrated scope is limited to the public WHO homepage summary route and its authenticated history R2-reader boundary:

1. [`who-summary-contract.md`](who-summary-contract.md)

That contract owns the public route, upstream route, fixed R2 source key, UTC-day cache identity, freshness comparison, 30-minute behind-data retry interval and website fallback behaviour.

WHO calculation, readiness, source fallback and summary-publication behaviour are owned by [`../who_2021/contract.md`](../who_2021/contract.md). The cache-proxy contract MUST NOT redefine those rules.

## Broader cache-proxy scope

Other cache-proxy routes have not yet been migrated into this area. Their existing implementation and historical broad documentation must not override the WHO summary contract. The historical broad file under `system_docs_legacy/` is reference material only.

Changes outside the WHO summary route must read the authoritative area contract for the affected subsystem, including `latest_snapshot/`, `r2_history/`, `aqi-levels/`, `station_charts/`, `who_2021/` or `geography/` where applicable.
