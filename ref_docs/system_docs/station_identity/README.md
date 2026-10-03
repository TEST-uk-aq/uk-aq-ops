# Canonical station identity

Status: **future implementation authority; TEST-first, not current runtime**

## Purpose

This area defines the future canonical physical monitoring-site identity layer that sits above connector-scoped UK AQ source stations.

It exists so one physical monitoring site represented by more than one connector or network can remain fully traceable to every source while being counted and presented once where a consumer explicitly needs physical-site semantics.

The initial bounded use case is overlap between GOV.UK AURN and:

- Welsh AQN;
- Scottish AQN;
- Northern Ireland Air.

The authoritative behavioural contract is [`contract.md`](contract.md).

## Current-runtime boundary

Current `uk_aq_core.stations` rows remain connector-scoped source identities. Current public products and the Hex Map do not yet use the canonical physical-site relationship described here.

The future implementation MUST be deployed and accepted on TEST before this area is promoted to current-runtime authority.

## Task routing

For database identity, UK-AIR matching rules, `station_matches`, `stations.match_id`, source preservation and canonical network membership, read [`contract.md`](contract.md).

When the task changes WAQN, SAQN or NI source/reference discovery, also read [`../ingest/waqn_saqn_ni_connector_contract.md`](../ingest/waqn_saqn_ni_connector_contract.md).

When the task projects canonical identity into Latest Snapshot rows, also read [`../latest_snapshot/canonical-site-projection-contract.md`](../latest_snapshot/canonical-site-projection-contract.md).

When the task changes Hex Map grouping, counting, aggregation, filtering or visible multi-network identity, also read [`../website_ui/hex-map-canonical-site-contract.md`](../website_ui/hex-map-canonical-site-contract.md).

For canonical schema and existing-database migrations, follow [`../READING_GUIDE.md#shared-schema-and-database-promotion`](../READING_GUIDE.md#shared-schema-and-database-promotion).

## Implementation ownership

Expected implementation ownership crosses:

- `TEST-uk-aq/uk-aq-schema` for canonical DDL and existing-database migration;
- `TEST-uk-aq/uk-aq-ingest` for resolving and persisting source-station to canonical-site relationships;
- `TEST-uk-aq/uk-aq-ops` for Latest Snapshot projection;
- `TEST-uk-aq/TEST-uk-aq.github.io` for Hex Map physical-site consumption.

The relationship MUST NOT be implemented only in website JavaScript.
