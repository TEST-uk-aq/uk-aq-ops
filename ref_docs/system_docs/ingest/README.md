# Ingest and Daily Stations

## Purpose

This directory contains authoritative UK AQ contracts for connector reference discovery, Daily Stations, connector scheduling ownership, connector/network ingest enablement, observation transport and selected connector-specific ingest behaviour.

This README is an area router. Start with [`../SYSTEM_OVERVIEW.md`](../SYSTEM_OVERVIEW.md), then choose the smallest route below.

## Ownership boundary

- runtime implementation: primarily `TEST-uk-aq/uk-aq-ingest`;
- canonical database definitions/migrations: `TEST-uk-aq/uk-aq-schema`;
- active prose authority: `TEST-uk-aq/uk-aq-system-docs/system_docs/`.

Repository-local implementation docs and historical plans are contextual only and do not override active contracts here.

## Daily Stations and scheduler routes

### Cross-connector Daily Stations orchestration or scheduler ownership

Start with [`contract.md`](contract.md).

Use it for general Daily Stations ordering/idempotency/failure rules, connector Cloudflare scheduler ownership, cross-database mirror gating and cross-connector reference-discovery boundaries.

Add only the specialist contract whose component is changing.

### Isolated SOS Daily Stations failure handling

Read:

1. [`contract.md`](contract.md)
2. [`daily_stations_sos_isolation_contract.md`](daily_stations_sos_isolation_contract.md)

Use this only for the two isolated SOS reference stages, continuation of independent work, mirror eligibility after SOS failure, polling cleanup and the Finished-with-warning health semantics defined by the specialist contract.

Normal SOS observation ingest/fallback remains under [`sos/README.md`](sos/README.md).

### Network catalogue and core mirror

Read:

1. [`contract.md`](contract.md)
2. [`network_catalogue_mirror_contract.md`](network_catalogue_mirror_contract.md)

Use this for authoritative IngestDB `uk_aq_core.networks`, stable numeric network IDs, complete row mirroring, network-before-connector/station ordering and required ObsAQIDB schema/RPC surfaces.

When the network-row change adds or changes `live_map_enabled`, also read [`../website_ui/hex-map-live-network-eligibility-contract.md`](../website_ui/hex-map-live-network-eligibility-contract.md). That contract owns the meaning and initial values of the flag; this area remains authoritative for complete-row mirroring.

### Breathe London Nodes deterministic reference discovery

Read:

1. [`contract.md`](contract.md)
2. [`blondon_nodes_reference_discovery_contract.md`](blondon_nodes_reference_discovery_contract.md)

Use this for deterministic Nodes phenomena/timeseries identity, the `4 × active stations` reference set, discovery versus quarter-hour ingest ownership and shared reference-building helpers.

For source observations add only the relevant Nodes raw/normalisation/transport contract below.

### Future Breathe London Communities reference discovery and shared partial recovery

**Status: future implementation authority, not current deployed behaviour.**

For the planned matched Communities/Nodes reference resilience implementation, read:

1. [`contract.md`](contract.md) for Daily Stations and mirror gating;
2. [`blondon_nodes_reference_discovery_contract.md`](blondon_nodes_reference_discovery_contract.md) for the existing four-species Nodes identity;
3. [`blondon_communities_reference_discovery_contract.md`](blondon_communities_reference_discovery_contract.md) for the proposed two-species Communities Daily Stations stage;
4. [`blondon_reference_failure_isolation_contract.md`](blondon_reference_failure_isolation_contract.md) for common quarter-hour targeted self-repair, failed-station checkpoint protection, partial status and systemic-failure boundaries;
5. [`station_metadata_ownership_contract.md`](station_metadata_ownership_contract.md) when changing current reference-metadata ownership.

Only add the compact transport specialist when the changed code actually crosses observation writer or cross-database delivery boundaries. These future documents do not assert that the Communities discovery stage or partial-run isolation is already deployed.

## Observation ingest routes

### Shared compact-ingest invariants

Read [`compact_observation_transport_and_metadata_ownership_contract.md`](compact_observation_transport_and_metadata_ownership_contract.md) when a task crosses both reference/metadata ownership and observation transport, or when changing a shared compact-ingest invariant.

For a bounded task, add only the relevant specialist contract below.

### Station/timeseries metadata ownership

Read:

1. [`compact_observation_transport_and_metadata_ownership_contract.md`](compact_observation_transport_and_metadata_ownership_contract.md)
2. [`station_metadata_ownership_contract.md`](station_metadata_ownership_contract.md)

Use this for:

- normal metadata authority by connector;
- Sensor.Community immediate discovery, presence and descriptive fingerprints;
- OpenAQ full-catalogue-fetch boundary;
- static timeseries metadata versus changing latest-value state;
- metadata-before-observation reference ordering.

Do not load compact RPC/Pub/Sub detail unless the wire/database transport is also changing.

### Compact observation database transport

Read:

1. [`compact_observation_transport_and_metadata_ownership_contract.md`](compact_observation_transport_and_metadata_ownership_contract.md)
2. [`compact_observation_transport_contract.md`](compact_observation_transport_contract.md)

Use this for:

- `timeseries_id` compact wire identity;
- IngestDB observation and latest-value compact RPCs;
- ObsAQIDB compact observation RPC;
- Pub/Sub writer/delivery boundary;
- retry, batching and request-body egress measurement;
- the required pooled transaction transport baseline for new/materially revised GCP Cloud Run compact observation v1/v2 writers;
- additive TEST rollout and transport rollback.

Add metadata ownership only when reference creation/lifecycle is also changing.

### Observation acquisition-method provenance

Read [`observation_acquisition_method_contract.md`](observation_acquisition_method_contract.md).

Add the compact transport umbrella/specialist only when the writer/transport boundary is involved. Current UK-AIR SOS acquisition methods include `sos` and `ukair_html`. WAQN, SAQN and NI current public-site acquisition uses `site_graph_html` under [`waqn_saqn_ni_connector_contract.md`](waqn_saqn_ni_connector_contract.md). Acquisition method does not create a second logical observation identity.

For actual SOS HTML fallback also read [`sos/README.md`](sos/README.md).

### WAQN, SAQN and Northern Ireland official-network connectors

Read:

1. [`waqn_saqn_ni_connector_contract.md`](waqn_saqn_ni_connector_contract.md)
2. [`observation_acquisition_method_contract.md`](observation_acquisition_method_contract.md) when changing current observation provenance
3. [`contract.md`](contract.md) when changing Daily Stations or scheduler ownership

Use this route for connector/network identities 9/7, 10/8 and 11/9, OpenAir reference discovery, WAQN/SAQN embedded graph acquisition, the NI graph plus hourly-only Latest Data adapter, Ricardo `Europe/London` graph/site timestamp normalisation, source-health separation and the shared implementation boundary.

WAQN, SAQN and NI are separate connectors even where parsing/client code is shared. Their scheduler jobs and polling gates remain independent. Their primary recurring IngestDB observation writer uses compact v2 because `acquisition_method` provenance is required; the authorised next transport change moves only that v2 call to the shared pooled database path.

For the agreed future AURN/devolved-network physical-site relationship, also read [`../station_identity/README.md`](../station_identity/README.md). That area owns canonical UK-AIR physical-site identity and `stations.match_id`; this connector area continues to own each source station, source code, connector and observation provenance.

### Breathe London Nodes source normalisation

Read [`blondon_nodes_source_observation_normalisation_contract.md`](blondon_nodes_source_observation_normalisation_contract.md).

Add only when relevant:

- [`blondon_nodes_raw_capture_contract.md`](blondon_nodes_raw_capture_contract.md) for source capture;
- [`compact_observation_transport_contract.md`](compact_observation_transport_contract.md) for post-normalisation observation writer/transport;
- [`blondon_nodes_database_transport_contract.md`](blondon_nodes_database_transport_contract.md) when changing the Nodes primary IngestDB observation call from PostgREST to the authorised pooled database transport;
- [`station_metadata_ownership_contract.md`](station_metadata_ownership_contract.md) when observation ingest reference ownership is involved;
- [`blondon_nodes_reference_discovery_contract.md`](blondon_nodes_reference_discovery_contract.md) for deterministic Daily Stations reference identity.

### Breathe London Nodes raw source capture

Read [`blondon_nodes_raw_capture_contract.md`](blondon_nodes_raw_capture_contract.md).

Add source normalisation only if crossing from raw evidence into logical observation selection.

### OpenAQ self-scheduling

Read [`openaq_self_scheduling_due_state_contract.md`](openaq_self_scheduling_due_state_contract.md).

Add [`contract.md`](contract.md) only for cross-connector scheduler ownership/dispatch invariants. Add metadata or compact transport only when those boundaries actually change.

### OpenAQ rate-budget scheduling

**Status: authoritative future implementation; TEST-first, not current runtime until accepted.**

Read:

1. [`openaq_rate_budget_scheduling_contract.md`](openaq_rate_budget_scheduling_contract.md)
2. [`openaq_self_scheduling_due_state_contract.md`](openaq_self_scheduling_due_state_contract.md)
3. [`openaq_token_budget_database_transport_contract.md`](openaq_token_budget_database_transport_contract.md)

Use this route for OpenAQ provider-limit safety caps, rolling-hour request accounting, low-headroom dispatch suppression, separation of station batch selection from per-run request allowance, self-scheduling after rolling capacity returns, and shared-budget telemetry null semantics.

The contract authorises TEST implementation only until real TEST operational acceptance is reviewed. It does not change the canonical due-state RPC or the pooled token-reservation transport.

### Shared GCP Cloud Run database runtime identity

**Status: authoritative current runtime.**

Read [`gcp_cloud_run_database_runtime_contract.md`](gcp_cloud_run_database_runtime_contract.md).

Use this for the shared `uk_aq_gcp_cloud_run_runtime` PostgreSQL login/secret/privilege boundary used by authorised GCP Cloud Run pooled-database transports. Together with `compact_observation_transport_contract.md`, it provides generic authority for the exact compact observation v1/v2 functions. Other RPCs/database operations still require narrower authority.

### OpenAQ token-budget internal database transport

**Status: authoritative current runtime.**

Read:

1. [`gcp_cloud_run_database_runtime_contract.md`](gcp_cloud_run_database_runtime_contract.md)
2. [`openaq_token_budget_database_transport_contract.md`](openaq_token_budget_database_transport_contract.md).

Use this only for the bounded OpenAQ Cloud Run transport change that moves `uk_aq_rpc_openaq_token_budget_reserve` from the hosted PostgREST/API Gateway path to the Supabase transaction pooler while preserving the existing canonical PostgreSQL function and all shared-budget semantics.

This route does not authorise moving other OpenAQ RPCs, observation writes, checkpoint operations or the self-scheduling due-state lookup away from their current interfaces. The due-state lookup remains governed by [`openaq_self_scheduling_due_state_contract.md`](openaq_self_scheduling_due_state_contract.md).

### SOS high-frequency IngestDB database transport

**Status: authoritative current runtime; TEST and LIVE.**

Read:

1. [`gcp_cloud_run_database_runtime_contract.md`](gcp_cloud_run_database_runtime_contract.md)
2. [`compact_observation_transport_contract.md`](compact_observation_transport_contract.md)
3. [`sos/contract.md`](sos/contract.md)
4. [`sos/database_transport_contract.md`](sos/database_transport_contract.md)

Use this only for the bounded SOS Cloud Run transport change that moves station-attempt persistence, compact IngestDB observation upsert v2 and compact latest-value update v1 away from the hosted PostgREST/API Gateway path while preserving the existing canonical behaviour. Other SOS reads, checkpoints, metadata operations, timestamp-only latest-value PATCHes and ObsAQIDB delivery remain on their existing interfaces.

### Breathe London Nodes compact observation database transport

**Status: authoritative current runtime in TEST and LIVE.**

Read:

1. [`gcp_cloud_run_database_runtime_contract.md`](gcp_cloud_run_database_runtime_contract.md)
2. [`compact_observation_transport_contract.md`](compact_observation_transport_contract.md)
3. [`blondon_nodes_source_observation_normalisation_contract.md`](blondon_nodes_source_observation_normalisation_contract.md)
4. [`blondon_nodes_database_transport_contract.md`](blondon_nodes_database_transport_contract.md)

Use this for the deployed Breathe London Nodes Cloud Run path that moves `uk_aq_rpc_observations_compact_upsert_v1` from hosted PostgREST/API Gateway to the shared Supabase transaction-pooler identity. Source normalisation, station/species chunking, latest-value updates, checkpoints, reference work, connector/run bookkeeping and secondary ObsAQIDB delivery remain on their existing interfaces.

### Connector and network ingest enablement


Read [`network_ingest_enablement_contract.md`](network_ingest_enablement_contract.md).

Add `contract.md` only when the change also enters scheduler ownership or Daily Stations orchestration/reference mirroring.

`connectors.poll_enabled` and `networks.ingest_enabled` remain distinct concepts.

### Future high-frequency canonical observation product

Status: **future implementation authority; not current runtime behaviour**.

For auditing or designing sources that may emit observations more frequently than the canonical public/history product requires, read:

1. [`high_frequency_observation_canonicalisation_contract.md`](high_frequency_observation_canonicalisation_contract.md)
2. the connector-specific future contract if one exists.

For Sensor.Community add:

- [`sensorcommunity_canonical_observation_contract.md`](sensorcommunity_canonical_observation_contract.md)
- [`../integrity_factory/ifw_sensorcommunity_source_contract.md`](../integrity_factory/ifw_sensorcommunity_source_contract.md) when long-term raw source evidence or IFW reconstruction is involved.

These contracts intentionally do **not** change current compact-ingest semantics. TEST may continue the current raw Sensor.Community ingest while cadence and cleansing work is performed; the contracts do not authorise LIVE re-enable or public display.

The current audit/implementation sequencing is documented non-authoritatively under `plans/2026-09-01 High-frequency observation canonicalisation/`.

### UK-AIR SOS observation ingestion

Start with [`sos/README.md`](sos/README.md).

The SOS sub-area routes normal polling, current-day HTML fallback, parsing, acquisition provenance, interfaces, operations and validation separately.

### Future UK-AIR Black Carbon connector

Status: **future implementation authority; not current runtime behaviour**.

Start with [`ukair_black_carbon/README.md`](ukair_black_carbon/README.md).

The Black Carbon connector is a dedicated source identity, separate from SOS. Its hourly BC/UV observations are R2-only; IngestDB owns connector/network/station/timeseries metadata rather than observation persistence.

For direct canonical R2 publication also read [`../r2_history/ukair_black_carbon_history_contract.md`](../r2_history/ukair_black_carbon_history_contract.md).

## Ingest plus historical R2 repair

Start with the relevant ingest route above.

Add [`../r2_history/README.md`](../r2_history/README.md) only when the task changes historical source evidence/repair, Integrity, R2 publication, timeseries reconciliation or another historical-storage boundary.

A normal current-ingest task should not preload R2-history contracts merely because the same connector also supports historical repair.

## Contract catalogue

| Contract | Primary scope |
|---|---|
| [`contract.md`](contract.md) | Daily Stations cross-connector orchestration and connector scheduler ownership |
| [`daily_stations_sos_isolation_contract.md`](daily_stations_sos_isolation_contract.md) | Narrow isolated SOS reference-stage failure behaviour |
| [`network_catalogue_mirror_contract.md`](network_catalogue_mirror_contract.md) | IngestDB-to-ObsAQIDB network catalogue/core mirror authority |
| [`blondon_nodes_reference_discovery_contract.md`](blondon_nodes_reference_discovery_contract.md) | Deterministic Nodes Daily Stations phenomena/timeseries discovery |
| [`blondon_communities_reference_discovery_contract.md`](blondon_communities_reference_discovery_contract.md) | Future Communities deterministic Daily Stations timeseries discovery; not yet deployed |
| [`blondon_reference_failure_isolation_contract.md`](blondon_reference_failure_isolation_contract.md) | Future shared Nodes/Communities ingest-side repair and isolated station failure; not yet deployed |
| [`compact_observation_transport_and_metadata_ownership_contract.md`](compact_observation_transport_and_metadata_ownership_contract.md) | Shared compact-ingest invariants/boundary |
| [`station_metadata_ownership_contract.md`](station_metadata_ownership_contract.md) | Station/timeseries reference metadata ownership and Sensor.Community lifecycle split |
| [`compact_observation_transport_contract.md`](compact_observation_transport_contract.md) | Compact observation/latest-value RPCs, Pub/Sub delivery, egress transport and pooled v1/v2 baseline for GCP Cloud Run writers |
| [`observation_acquisition_method_contract.md`](observation_acquisition_method_contract.md) | Additive observation acquisition provenance |
| [`waqn_saqn_ni_connector_contract.md`](waqn_saqn_ni_connector_contract.md) | WAQN/SAQN/NI identities, live acquisition, OpenAir reference authority and compact v2 pooled-observation transport boundary |
| [`blondon_nodes_source_observation_normalisation_contract.md`](blondon_nodes_source_observation_normalisation_contract.md) | Nodes duplicate logical-timestamp normalisation |
| [`blondon_nodes_raw_capture_contract.md`](blondon_nodes_raw_capture_contract.md) | Nodes raw `/SensorData` evidence capture |
| [`openaq_self_scheduling_due_state_contract.md`](openaq_self_scheduling_due_state_contract.md) | OpenAQ checkpoint-derived next-due scheduling |
| [`openaq_rate_budget_scheduling_contract.md`](openaq_rate_budget_scheduling_contract.md) | TEST-first OpenAQ provider safety caps, rolling-hour low-headroom dispatch gate and budget telemetry semantics |
| [`gcp_cloud_run_database_runtime_contract.md`](gcp_cloud_run_database_runtime_contract.md) | Current shared GCP Cloud Run PostgreSQL login/secret/privilege boundary plus generic compact observation v1/v2 pooled authority |
| [`openaq_token_budget_database_transport_contract.md`](openaq_token_budget_database_transport_contract.md) | Current bounded OpenAQ shared-token-budget transport through the Supabase transaction pooler |
| [`sos/database_transport_contract.md`](sos/database_transport_contract.md) | Current SOS high-frequency IngestDB write transport through the shared transaction-pooler identity |
| [`blondon_nodes_database_transport_contract.md`](blondon_nodes_database_transport_contract.md) | Current TEST/LIVE Breathe London Nodes compact observation v1 transport through the shared transaction-pooler identity |
| [`network_ingest_enablement_contract.md`](network_ingest_enablement_contract.md) | Connector-wide/network-level ingest-enable semantics |
| [`high_frequency_observation_canonicalisation_contract.md`](high_frequency_observation_canonicalisation_contract.md) | Future explicitly designated high-frequency source to five-minute canonical product boundary |
| [`sensorcommunity_canonical_observation_contract.md`](sensorcommunity_canonical_observation_contract.md) | Future Sensor.Community raw/cleansing/five-minute canonical serving boundary |
| [`sos/`](sos/) | UK-AIR SOS observation polling and authorised HTML fallback |
| [`ukair_black_carbon/`](ukair_black_carbon/) | Future dedicated UK-AIR Black Carbon metadata/source contracts with R2-only observations |

## Implementation guidance

After selecting a route, inspect only the relevant implementation files. Typical locations are:

- `uk-aq-ingest/scripts/` for Daily Stations/connector scripts;
- `uk-aq-ingest/workers/` for connector Cloud Run services;
- `uk-aq-ingest/supabase/functions/` for ingest handlers/shared clients;
- `uk-aq-ingest/.github/workflows/` for connector deployment workflows;
- `uk-aq-schema/schemas/` and its active migration root for canonical database surfaces.

## Validation boundary

Before implementation, confirm only structural viability required by the selected contract. Do not create a broad speculative test programme.

Functional acceptance normally occurs through real TEST operation after deployment using the selected contract's acceptance evidence. A narrower contract MAY explicitly define a bounded environment exception when TEST cannot exercise a required external dependency; follow that narrower acceptance boundary rather than inventing credentials or synthetic end-to-end traffic.

Codex and other coding agents are read-only consumers of `system_docs/`; behavioural documentation changes are handed back to ChatGPT in Chat mode.
