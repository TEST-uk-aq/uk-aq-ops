# Observs operations

## Scope

This area owns active operational behaviour for the Obs AQI database.

The current authoritative scope of this area is **Observs partition maintenance** only. The outbox/flush-service documentation migration remains pending and is not made authoritative by this file.

For partition maintenance, read:

1. [`partition_maintenance.md`](partition_maintenance.md);
2. the implementation under `TEST-uk-aq/uk-aq-ops/workers/uk_aq_observs_partition_maintenance_service/`;
3. `.github/workflows/uk_aq_observs_partition_maintenance.yml` for the current GitHub Actions execution wrapper.

Historical material under `system_docs_legacy/` is non-authoritative and must not override this area.

## Ownership

The implementation is owned by:

`TEST-uk-aq/uk-aq-ops`

The partition-maintenance service maintains daily partitions in `uk_aq_observs.observations` in Obs AQI DB. It may delete eligible old database partitions only after the deletion-safety rules in the partition-maintenance contract are satisfied.

Canonical observation-history generation and R2 layout are owned by [`../r2_history/README.md`](../r2_history/README.md). Partition maintenance consumes the selected-generation day manifest only as deletion authority; it does not write or repair canonical R2 history.

## Current routing status

| Task | Contract |
|---|---|
| Observs daily partition creation, hot/cold index maintenance, default-partition diagnostics and retention drops | [`partition_maintenance.md`](partition_maintenance.md) |
| Canonical observation-history generation selection and manifest layout | [`../r2_history/README.md`](../r2_history/README.md) |
| Observs outbox/flush behaviour | Migration pending; do not infer current authority from this area |

## Validation policy

Before implementation, use only the smallest structural checks needed to prove the proposed workflow/configuration/code is viable.

Functional acceptance happens after deployment through a real TEST Observs Partition Maintenance run against the actual TEST Obs AQI DB and R2 history. Do not create an artificial outage or speculative pre-deployment test suite merely to exercise the normal retention path.
