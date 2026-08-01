# Ingest and Daily Stations contract

## Purpose

Daily Stations establishes and refreshes the connector reference data required by normal observation ingestion and downstream database synchronisation.

It is not only a station-name refresh. For connectors whose timeseries identities are deterministic from station identity and a fixed source-species contract, Daily Stations must establish those timeseries before observation polling depends on them.

## Cross-repository authority

This contract is authoritative even though:

- runtime implementation is primarily in `uk-aq-ingest`;
- canonical SQL is owned by `uk-aq-schema`;
- this contract is stored in `uk-aq-ops`.

Implementation and schema changes must preserve this contract unless the contract is intentionally amended first or in the assigned ChatGPT documentation phase.

## Connector ingest scheduler ownership

For TEST Cloud Run connector-ingest services, recurring external dispatch is owned by the Cloudflare ingest scheduler and its D1 job configuration.

This applies to:

- Breathe London Nodes;
- Breathe London Communities;
- UK-AIR SOS;
- Sensor.Community;
- the OpenAQ external safety trigger.

Cloud Run deployment workflows MUST:

- deploy and configure the connector service;
- preserve authenticated application-level dispatch through the shared upstream secret;
- reconcile the deployed Cloud Run service URL into the corresponding Cloudflare scheduler D1 job.

Cloud Run deployment workflows MUST NOT:

- create, update, resume or otherwise manage Google Cloud Scheduler jobs for connector ingestion.

The database value `scheduler_backend = 'google_cloud_run'` identifies the execution backend. It does not mean that Google Cloud Scheduler owns dispatch.

OpenAQ retains its worker-created one-off Cloud Tasks as its primary self-scheduling path. The Cloudflare OpenAQ safety job remains the external recovery trigger. Removing Google Cloud Scheduler MUST NOT remove or disable the OpenAQ Cloud Tasks queue, task creation, task invoker identity or associated IAM permissions.

This scheduler-ownership change MUST NOT alter connector poll intervals, due-state checks, dispatch claims, overlap protection, retry behaviour or connector-specific work selection.

## Daily Stations general contract

Daily Stations MUST:

- use connector identity by `connector_code`, not by an assumed numeric connector ID;
- make connector-specific stages idempotent and safe to rerun;
- refresh station reference rows without deleting historical observations or timeseries;
- establish all deterministic reference rows required by a connector before downstream reference mirroring runs;
- fail the workflow when a required connector stage leaves an internally inconsistent reference state;
- run the IngestDB-to-ObsAQIDB core reference synchronisation only after the IngestDB reference stages have completed successfully;
- preserve existing SOS and OpenAQ polling pause/resume safety behaviour unless a separate contract change explicitly replaces it.

Daily Stations MUST NOT:

- fetch or write routine observation measurements merely to discover deterministic reference rows;
- reset observation checkpoints or normal poll scheduling state;
- treat a zero-work connector stage as successful when active source stations exist but required reference rows are missing;
- delete historical timeseries because a station is now removed from the active source list.

## Breathe London Nodes identity

The connector identity is:

```text
connector_code = blondon_nodes
service_ref = breathelondon
network_code = breathelondon
```

Station identity is:

```text
connector_id + station_ref
```

where `station_ref` is the Breathe London Nodes `SiteCode`.

Timeseries identity is:

```text
connector_id + timeseries_ref
```

The deterministic `timeseries_ref` values for each active Nodes station are:

```text
<station_ref>:PM25
<station_ref>:NO2
<station_ref>:PM25Index
<station_ref>:NO2Index
```

These identities MUST remain stable across repeated Daily Stations runs and quarter-hour observation ingests.

## Breathe London Nodes Daily Stations stage

After the Nodes station-list import, Daily Stations MUST perform a Nodes reference-discovery stage that:

1. resolves the `blondon_nodes` connector by `connector_code`;
2. selects active Nodes stations where `service_ref = 'breathelondon'` and `removed_at is null`;
3. upserts the four canonical Nodes phenomena through the current central phenomena RPC contract;
4. upserts four deterministic timeseries rows for every selected active station;
5. preserves existing timeseries IDs through the unique identity `(connector_id, timeseries_ref)`;
6. reports the active-station count, expected-timeseries count, pre-existing count, inserted or repaired count, and final count;
7. fails when active Nodes stations exist but the final required timeseries set is incomplete.

For `N` active Nodes stations, the required active-station reference set contains exactly `4 × N` distinct `(connector_id, timeseries_ref)` identities.

Historical timeseries belonging to removed stations MAY remain in `uk_aq_core.timeseries` and MUST NOT be deleted by this discovery stage.

## Canonical Nodes phenomena mappings

The required source labels and classifications are:

| Source label | Source species | Mapping kind | Canonical observed property | AQI eligible |
|---|---|---|---|---|
| `breathelondon_nodes:pm2.5` | `PM25` | `raw_observed_property` | `pm25` | yes |
| `breathelondon_nodes:no2` | `NO2` | `raw_observed_property` | `no2` | yes |
| `breathelondon_nodes:pm2.5:daqi` | `PM25Index` | `derived_index` | `pm25index` | no |
| `breathelondon_nodes:no2:daqi` | `NO2Index` | `derived_index` | `no2index` | no |

Source-provided index observations are retained source observations. They MUST remain distinct from UK AQ calculated AQI or DAQI products.

The discovery stage MUST fail rather than silently create an unknown mapping or continue with a mapping warning.

## Discovery versus observation ingestion

The Daily Stations Nodes discovery stage owns creation and repair of the complete deterministic reference set.

It MUST NOT:

- call the Breathe London `/SensorData` endpoint;
- write observations;
- update station observation checkpoints;
- update timeseries value bounds.

The quarter-hour Nodes ingest owns due-station selection, `/SensorData` calls, observation writes, checkpoints and value-bound updates.

The quarter-hour ingest SHOULD retain an idempotent timeseries upsert as a self-repair guard, but it MUST NOT be the sole normal mechanism that creates the Nodes timeseries reference set.

A quarter-hour run that processes observations successfully while the authoritative IngestDB contains no Nodes timeseries is an invalid state and MUST be surfaced as a deployment or database-target mismatch, not accepted as normal operation.

## Shared implementation boundary

The deterministic Nodes species definitions and timeseries-row construction MUST have one shared implementation used by both:

- Daily Stations reference discovery;
- the quarter-hour Nodes observation ingest self-repair path.

The workflow SHOULD remain an orchestrator of independently runnable connector stages. Connector-specific station import and reference discovery SHOULD live in connector modules or commands rather than being embedded as large inline workflow scripts.

Modularisation MUST NOT change connector scheduling, polling, retry, checkpoint, observation-write or secondary-write behaviour unless separately authorised.

## ObsAQIDB reference mirroring

The final Daily Stations reference mirror to ObsAQIDB MUST run only after Nodes station and timeseries discovery has succeeded.

The mirrored core reference set must include the current connector, station and timeseries rows required by downstream ObsAQIDB foreign-key and lookup contracts.

A schema-compatible mirror that copies zero Nodes timeseries when active Nodes stations exist MUST be treated as an incomplete Daily Stations result.

## Structural viability before implementation

Before implementation, only the following targeted checks are required:

- confirm the existing unique identity for timeseries is `(connector_id, timeseries_ref)`;
- confirm the current central phenomena RPC exposes the fields consumed by the shared Nodes mapping helper;
- confirm the Daily Stations workflow can invoke the new connector-specific discovery command before the ObsAQIDB mirror step.

No broad speculative pre-implementation test suite is required.

## TEST operational validation after deployment

Functional validation must occur through real TEST operation:

1. run Daily Stations on TEST;
2. confirm the Nodes station stage completes;
3. confirm the final active Nodes timeseries reference count is `4 × active Nodes stations`;
4. confirm a subsequent normal quarter-hour Nodes ingest writes observations using those existing timeseries identities;
5. confirm the final ObsAQIDB core mirror includes the same Nodes timeseries identities;
6. rerun Daily Stations and confirm identities remain stable and no duplicate timeseries are created.

## Explicit non-goals

This contract does not authorise:

- changing the four Nodes source species;
- changing public network naming;
- changing quarter-hour due-station scheduling;
- changing observation retention or R2 history behaviour;
- merging Breathe London Nodes and Communities connector identities;
- deleting existing historical Nodes timeseries;
- changing SOS, OpenAQ, Sensor.Community or Breathe London Communities behaviour beyond preserving their existing Daily Stations stages.