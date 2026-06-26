# UK AQ v0.2.0 schema design analysis

Status: design proposal only. No schema, ingest, worker, or website code is implemented by this document.

## Scope

v0.2.0 is a hard cut. The design below assumes:

- no backwards compatibility layer for v0.1.0 table names, fields, RPCs, snapshot shapes, or website assumptions
- all v0.1.0 data has already been backed up
- all existing v0.1.0 networks still ingest in v0.2.0
- Breathe London Nodes are added to ingest scope
- the first public beta display shows only GOV.UK AURN and Breathe London
- other networks ingest but remain hidden from public display until checked
- source observations are never merged into a canonical station

The core modelling decision is to keep connector-specific source stations and timeseries as the observation owners, then add a separate public display layer for dedupe and website selection.

## Current Schema Analysis

### Current relevant tables

Current main ingest schema files:

- `schemas/ingest_db/uk_aq_core_schema.sql`
- `schemas/ingest_db/uk_aq_raw_schema.sql`
- `schemas/ingest_db/uk_aq_public_views.sql`
- `schemas/ingest_db/uk_aq_rpc.sql`
- `schemas/ingest_db/uk_aq_aqilevels_schema.sql`
- `schemas/ingest_db/main_db_dualwrite_bootstrap.sql`

Current Obs AQI schema files:

- `schemas/obs_aqi_db/uk_aq_obs_aqi_db_schema.sql`
- `schemas/obs_aqi_db/uk_aq_core_mirror_rpcs.sql`
- `schemas/obs_aqi_db/uk_aq_obs_aqi_db_ops_rpcs.sql`
- `schemas/obs_aqi_db/obs_aqidb_generic_timeseries_aqi_hourly_rpcs.sql`
- `schemas/obs_aqi_db/uk_aq_obs_aqi_db_aqi_station_link_hardening.sql`

Current core metadata tables:

- `uk_aq_core.connectors`
- `uk_aq_core.categories`
- `uk_aq_core.observed_properties`
- `uk_aq_core.phenomena`
- `uk_aq_core.offerings`
- `uk_aq_core.features`
- `uk_aq_core.procedures`
- `uk_aq_core.stations`
- `uk_aq_core.station_metadata`
- `uk_aq_core.station_network_memberships`
- `uk_aq_core.uk_aq_networks`
- `uk_aq_core.uk_air_sos_networks`
- `uk_aq_core.uk_air_sos_network_pollutants`
- `uk_aq_core.timeseries`
- `uk_aq_core.reference_values`
- `uk_aq_core.observations` in ingest DB
- `uk_aq_observs.observations` in Obs AQI DB
- `uk_aq_core.uk_aq_ingest_runs`

Current raw/checkpoint tables include:

- `uk_aq_raw.uk_air_sos_site_register`
- `uk_aq_raw.laqn_site_register`
- `uk_aq_raw.uk_air_sos_station_refs`
- `uk_aq_raw.breathelondon_station_checkpoints`
- `uk_aq_raw.erg_laqn_station_checkpoints`
- `uk_aq_raw.uk_air_sos_timeseries_checkpoints`
- `uk_aq_raw.uk_air_sos_station_checkpoints`
- `uk_aq_raw.openaq_station_checkpoints`
- `uk_aq_raw.openaq_timeseries_checkpoints`
- `uk_aq_raw.error_logs`

Current AQI/history tables and outputs are built around `station_id`, `timeseries_id`, `connector_id`, and day/hour windows. R2 history writers and readers serialize these IDs into Parquet and JSON manifests.

### Current station identity model

The current `stations` table is already source-station oriented:

- one row is scoped by `(connector_id, service_ref, station_ref)`
- source identifiers are text
- geometry and location metadata live directly on the station row
- `station_metadata` holds free-form JSON attributes
- `station_network_memberships` maps one source station to one or more network labels

This is a good starting point. The problem is not that station observations are merged today. The problem is that public display identity is not a first-class separate model. The website and public views have to infer which stations to expose, which stations duplicate each other, and which source should be preferred.

### Current time series and observation grain

The current `timeseries` table is source-timeseries oriented:

- `timeseries.id` is the primary internal series key
- uniqueness is `(connector_id, service_ref, timeseries_ref)`
- `station_id` links a series to one source station
- source-specific SOS concepts are represented through `offering_id`, `feature_id`, `procedure_id`, `phenomenon_id`, and `category_id`
- `phenomena.observed_property_id` maps source pollutant labels to canonical observed properties

Current observations reference the series:

- ingest DB observations primary key: `(connector_id, timeseries_id, observed_at)`
- Obs AQI DB observations store `(connector_id, timeseries_id, observed_at, value)`
- AQI and R2 history paths use `timeseries_id` heavily

This grain is fundamentally correct. Observations should continue to belong to one source timeseries, not to a public/canonical station.

### Current connector and source identity handling

Connectors are currently data-source objects, not networks. That is correct.

Important existing distinctions:

- UK-AIR SOS is one connector, with networks in `uk_air_sos_networks` and `station_network_memberships`
- LAQN uses connector code `erg_laqn`
- Sensor.Community uses connector code `sensorcommunity`
- Breathe London currently has a connector and station/timeseries upsert scripts
- OpenAQ has station and timeseries checkpoint tables

The current design mixes some SensorThings-like terms (`phenomena`, `procedures`, `offerings`, `features`) with simpler station/timeseries concepts. For v0.2.0, these should be collapsed unless the field is directly needed by ingest or diagnostics.

### Current public website views and RPCs

Current public SQL surfaces include:

- `uk_aq_public.connectors`
- `uk_aq_public.stations`
- `uk_aq_public.timeseries`
- `uk_aq_public.observations`
- `uk_aq_public.bristol_latest_pollutants`
- `uk_aq_public.uk_aq_station_lat_lon`
- `uk_aq_public.uk_aq_station_connector_lookup`
- `uk_aq_public.uk_aq_latest_rpc`
- `uk_aq_public.uk_aq_stations_rpc`
- `uk_aq_public.uk_aq_timeseries_rpc`
- `uk_aq_public.rpc_observations_window`
- hex-map RPCs such as `uk_aq_la_hex_rpc` and `uk_aq_pcon_hex_rpc`
- Obs AQI RPCs such as `uk_aq_rpc_observs_timeseries_window`
- AQI views/RPCs around `uk_aq_aqilevels.timeseries_aqi_hourly`

The webpage repo currently depends most visibly on API/R2 payloads rather than direct table names:

- `timeseries-client.js` expects a timeseries URL with `timeseries_id`, optional pollutant/window/start/end/since, and payload points with `observed_at` plus `value`.
- sidebar files are navigation/UI only.
- ops workers serving history and AQI data continue to use `station_id`, `timeseries_id`, and connector IDs internally.

This means v0.2.0 can change database internals if the public API/R2 snapshot shape is intentionally rebuilt.

## Option Comparison

### 1. Pure source-station model

Tables:

- connectors
- stations
- timeseries
- observed_properties
- observations
- no explicit dedupe tables

Pros:

- simplest schema
- observations remain safely source-specific
- ingest code stays straightforward
- smallest DB metadata footprint
- lowest write/query complexity
- egress impact is low because public payloads can be generated directly from source stations with filtering
- DB-size impact is lowest because there are no display/link metadata tables

Cons:

- dedupe logic moves into SQL views, API workers, or front-end code
- AURN and Breathe London overlap becomes implicit and harder to audit
- every future public network requires custom display-selection logic
- public beta can accidentally show duplicate real-world sites

Complexity: low.

Risk of hiding source differences: low at storage level, medium at display level because dedupe rules are not explicit.

Suitability for AURN plus Breathe London beta: acceptable only if duplicate display is tolerable or hard-coded in one view.

Suitability for later OpenAQ, Sensor.Community, LAQN, WAQN: weak, because dedupe/visibility rules will sprawl.

### 2. Source stations plus pairwise station links

Tables:

- connectors
- stations
- timeseries
- observed_properties
- observations
- station_links

`station_links` records relationships such as `same_real_world_site`, `possible_match`, and `not_same`.

Pros:

- preserves source stations and source observations
- strong audit trail for why two source stations are believed to match or not match
- useful for diagnostics and curation
- can encode AURN to Breathe London overlap without merging records
- egress impact is low if links are resolved into compact public views server-side
- DB-size impact is small for curated links, but grows roughly with pair counts if automated matching is broad

Cons:

- pairwise links do not directly answer "which one public station should the website display?"
- transitive matches can be awkward: if A links B and B links C, group meaning must be inferred
- public views need additional logic to cluster links or pick preferred stations
- more operational curation than pure source-station model

Complexity: medium.

Risk of hiding source differences: low if links are only used for display and diagnostics.

Suitability for AURN plus Breathe London beta: good for audit, but not enough by itself for a clean public map/list.

Suitability for later OpenAQ, Sensor.Community, LAQN, WAQN: good as a curation/audit table, but not ideal as the only public-display model.

### 3. Source stations plus station match groups

Tables:

- connectors
- stations
- timeseries
- observed_properties
- observations
- station_match_groups
- station_match_group_members

Groups are dedupe/link clusters, not stations.

Pros:

- handles one-to-many and multi-source overlaps better than pairwise links
- can represent Breathe London overlap as one group with multiple source members
- avoids transitive-link ambiguity
- preserves source observations
- egress impact is low when public payloads use one selected member per group
- DB-size impact is small to moderate: one group plus membership rows per deduped site

Cons:

- still does not define all public display fields unless views derive them
- can become a weak "canonical station" if not carefully named and documented
- needs curation rules for group creation, confidence, and member precedence
- slightly heavier than needed for the first beta if only a few Breathe London duplicates exist

Complexity: medium.

Risk of hiding source differences: medium if users treat groups as stations; low if groups are explicitly non-observation-owning.

Suitability for AURN plus Breathe London beta: good, but more machinery than required if public display selection is the real problem.

Suitability for later OpenAQ, Sensor.Community, LAQN, WAQN: good for growing match review workflows.

### 4. Source stations plus public display stations

Tables:

- connectors
- stations
- timeseries
- observed_properties
- observations
- public_stations
- public_station_sources

Public stations are website display objects only. They never own observations.

Pros:

- directly models the website problem
- allows Breathe London to appear as one public network while preserving source feed details
- lets public beta show only AURN and Breathe London without hiding source data from diagnostics
- clear source precedence for map/list/chart defaults
- supports multiple source stations behind one public display marker without merging observations
- egress impact is best for public traffic because map/list payloads can be prefiltered to display stations only
- DB-size impact is low: one public display row plus a small membership table

Cons:

- adds a second station-like concept that must be named carefully
- public display rows need their own lifecycle and curation
- diagnostics must remain source-station aware so public rows do not mask differences
- without station_links or match_groups, evidence for why sources were grouped can be thin unless stored as JSON

Complexity: medium-low.

Risk of hiding source differences: low if public_station_sources exposes source membership and selected series.

Suitability for AURN plus Breathe London beta: strongest option. It matches the immediate need.

Suitability for later OpenAQ, Sensor.Community, LAQN, WAQN: strong. Additional networks can be ingested but only promoted into `public_station_sources` when checked.

### 5. OGC SensorThings-inspired model

Tables:

- connectors/providers
- things
- locations
- datastreams
- sensors
- observed_properties
- observations

Pros:

- standards-aligned vocabulary
- datastream maps cleanly to a pollutant/time series
- supports source provenance and sensor metadata
- observations belong to datastreams, which is correct
- useful if future APIs need SensorThings compatibility
- egress impact can be low if public views flatten the model
- DB-size impact is moderate because Thing, Location, Sensor, and Datastream add separate rows and joins

Cons:

- heavier than the project needs now
- "Thing" and "Sensor" semantics may confuse current network terminology
- source feeds such as UK-AIR SOS already arrive with similar but not identical concepts
- more joins in ingest and public views
- still needs a public display dedupe layer

Complexity: high.

Risk of hiding source differences: low in storage, medium in display unless public station selection is separate.

Suitability for AURN plus Breathe London beta: overbuilt.

Suitability for later OpenAQ, Sensor.Community, LAQN, WAQN: technically strong, but the implementation cost is not justified for v0.2.0 beta.

### 6. OpenAQ-inspired model

Tables:

- providers/connectors
- locations/stations
- sensors or timeseries
- parameters/observed_properties
- measurements/observations

Pros:

- close to the practical AQ domain
- "location + parameter-specific series + measurement" maps well to the current design
- easier for developers to understand than SensorThings
- supports OpenAQ import naturally
- egress impact is low if public display filtering is explicit
- DB-size impact is low to moderate, similar to the current source station/time series model

Cons:

- OpenAQ "location" can sound canonical even when the project needs source-specific stations
- does not solve public dedupe by itself
- still needs a display-source precedence model
- less complete for SOS-specific metadata than SensorThings unless metadata JSON is retained

Complexity: medium-low.

Risk of hiding source differences: medium if "location" becomes a golden record; low if named `stations` and scoped by connector.

Suitability for AURN plus Breathe London beta: good foundation, but needs option 4 on top.

Suitability for later OpenAQ, Sensor.Community, LAQN, WAQN: good.

## Recommended v0.2.0 Schema

### Recommendation summary

Use a source-station plus public display station model:

- ingest-facing source tables:
  - `connectors`
  - `networks`
  - `connector_networks`
  - `stations`
  - `station_networks`
  - `observed_properties`
  - `timeseries`
  - `observations`
  - `ingest_runs`
  - `source_checkpoints`
  - `source_payloads` or connector-specific raw JSON tables only where necessary
- public display tables:
  - `public_networks`
  - `public_stations`
  - `public_station_sources`
  - optionally `public_timeseries_selection`
- diagnostic/linking table:
  - optional now, recommended soon: `station_links`

Do not create a canonical station table that owns observations. If a display station represents multiple sources, it is only a website object.

### Schema placement

Canonical DDL should live in the schema repo:

- `schemas/obs_aqi_db/uk_aq_v0_2_core_schema.sql`
- `schemas/obs_aqi_db/uk_aq_v0_2_observations_schema.sql`
- `schemas/obs_aqi_db/uk_aq_v0_2_public_schema.sql`
- `schemas/obs_aqi_db/uk_aq_v0_2_ops_schema.sql`
- roll-up into `schemas/obs_aqi_db/uk_aq_obs_aqi_db_schema.sql`

If the ingest DB remains separate for v0.2.0, mirror equivalent core tables there. The cleaner hard-cut option is to make Obs AQI DB the authoritative v0.2.0 operational DB and remove dual-write complexity.

### Ingest-facing tables

#### `uk_aq_core.connectors`

Purpose: one row per data source/API/feed.

Key fields:

- `connector_id integer generated by default as identity primary key`
- `connector_code text not null`
- `display_name text not null`
- `provider_name text null`
- `service_url text null`
- `connector_kind text not null default 'api'`
- `is_active boolean not null default true`
- `ingest_enabled boolean not null default true`
- `public_default_visible boolean not null default false`
- `config jsonb not null default '{}'::jsonb`
- `source_metadata jsonb not null default '{}'::jsonb`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Constraints and indexes:

- primary key: `connector_id`
- unique: `(connector_code)`
- check `connector_kind in ('api', 'file', 'manual', 'derived')`
- index: `(ingest_enabled, is_active)`

Nullability:

- `connector_code`, `display_name`, `connector_kind`, booleans required
- `service_url`, `provider_name` nullable
- connector-specific behavior belongs in `config` JSONB

Notes:

- Keep connector as source identity, not public network identity.
- UK-AIR SOS remains one connector.
- Breathe London and Breathe London Nodes can either be separate connectors behind one public network, or one connector with source feed metadata. Prefer separate connectors if the feeds have separate IDs, schedules, or payload shapes.

#### `uk_aq_core.networks`

Purpose: source/network taxonomy used by ingest and QA.

Key fields:

- `network_id integer generated by default as identity primary key`
- `network_code text not null`
- `display_name text not null`
- `network_kind text not null default 'source_network'`
- `is_active boolean not null default true`
- `source_metadata jsonb not null default '{}'::jsonb`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Constraints and indexes:

- unique: `(network_code)`
- check `network_kind in ('source_network', 'public_network', 'administrative_group')`

Examples:

- `gov_uk_aurn`
- `gov_uk_waqn`
- `erg_laqn`
- `breathelondon`
- `breathelondon_nodes`
- `openaq`
- `sensorcommunity`

#### `uk_aq_core.connector_networks`

Purpose: many-to-many mapping between connectors and source networks.

Key fields:

- `connector_id integer not null references connectors(connector_id)`
- `network_id integer not null references networks(network_id)`
- `source_network_ref text null`
- `is_primary boolean not null default false`
- `source_metadata jsonb not null default '{}'::jsonb`
- `created_at timestamptz not null default now()`

Constraints and indexes:

- primary key: `(connector_id, network_id)`
- index: `(network_id, connector_id)`
- optional unique: `(connector_id, source_network_ref)` where `source_network_ref is not null`

#### `uk_aq_core.stations`

Purpose: connector-specific source station. Owns no dedupe identity beyond source identity.

Key fields:

- `station_id bigint generated by default as identity primary key`
- `connector_id integer not null references connectors(connector_id)`
- `source_station_ref text not null`
- `source_station_alt_ref text null`
- `source_feed_ref text null`
- `station_label text not null`
- `display_name text null`
- `latitude double precision null`
- `longitude double precision null`
- `geometry geography(Point, 4326) null`
- `country_code text null`
- `region_code text null`
- `local_authority_code text null`
- `parliamentary_constituency_code text null`
- `station_type text null`
- `site_type text null`
- `exposure text null`
- `status text not null default 'active'`
- `first_seen_at timestamptz not null default now()`
- `last_seen_at timestamptz null`
- `ended_at timestamptz null`
- `source_metadata jsonb not null default '{}'::jsonb`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Constraints and indexes:

- primary key: `station_id`
- unique: `(connector_id, source_station_ref)`
- optional unique: `(connector_id, source_feed_ref, source_station_ref)` if `source_station_ref` is only feed-unique
- check `status in ('active', 'inactive', 'ended', 'unknown')`
- GiST index: `geometry`
- B-tree indexes: `(connector_id)`, `(source_station_ref)`, `(status)`, `(local_authority_code)`, `(parliamentary_constituency_code)`
- partial index: `(connector_id, status)` where `ended_at is null`

Nullable fields:

- coordinates nullable because some feeds may produce metadata before location
- administrative geography nullable because it can be backfilled
- `display_name` nullable because source label can be used

JSONB:

- raw source fields such as Breathe London `InstallationCode`, `SiteCode`, `DeviceCode`, status, owner, deployment details, and OpenAQ provider payload fragments go in `source_metadata`

#### `uk_aq_core.station_networks`

Purpose: source station membership in one or more source networks.

Key fields:

- `station_id bigint not null references stations(station_id)`
- `network_id integer not null references networks(network_id)`
- `is_primary boolean not null default false`
- `source_network_ref text null`
- `source_metadata jsonb not null default '{}'::jsonb`
- `created_at timestamptz not null default now()`

Constraints and indexes:

- primary key: `(station_id, network_id)`
- index: `(network_id, station_id)`

#### `uk_aq_core.observed_properties`

Purpose: canonical pollutant/met parameter registry.

Key fields:

- `observed_property_id integer generated by default as identity primary key`
- `property_code text not null`
- `display_name text not null`
- `domain text not null`
- `canonical_unit text null`
- `default_display_precision integer null`
- `is_public_beta boolean not null default false`
- `source_metadata jsonb not null default '{}'::jsonb`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Constraints and indexes:

- unique: `(property_code)`
- check `domain in ('aq', 'met', 'other')`
- index: `(domain, is_public_beta)`

Examples:

- `pm25`
- `pm10`
- `no2`
- `o3`
- `so2`
- `co`
- `temperature`
- `humidity`

#### `uk_aq_core.timeseries`

Purpose: source datastream. One row per connector-specific station plus observed property plus source parameter stream.

Key fields:

- `timeseries_id integer generated by default as identity primary key`
- `connector_id integer not null references connectors(connector_id)`
- `station_id bigint not null references stations(station_id)`
- `observed_property_id integer not null references observed_properties(observed_property_id)`
- `source_timeseries_ref text not null`
- `source_parameter_ref text null`
- `source_parameter_label text null`
- `source_unit text null`
- `normalised_unit text null`
- `aggregation_period text null`
- `measurement_method text null`
- `sampling_height_m numeric null`
- `status text not null default 'active'`
- `first_observed_at timestamptz null`
- `last_observed_at timestamptz null`
- `last_value numeric null`
- `last_normalised_value numeric null`
- `last_qa_status text null`
- `source_metadata jsonb not null default '{}'::jsonb`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`
- `ended_at timestamptz null`

Constraints and indexes:

- primary key: `timeseries_id`
- unique: `(connector_id, source_timeseries_ref)`
- optional unique: `(station_id, observed_property_id, source_parameter_ref)` where `source_parameter_ref is not null`
- index: `(station_id, observed_property_id)`
- index: `(observed_property_id, station_id)`
- index: `(connector_id, status)`
- index: `(updated_at, timeseries_id)` for mirrors/R2 snapshots
- partial index: `(station_id, observed_property_id)` where `ended_at is null`

Nullable fields:

- `source_parameter_ref`, `measurement_method`, `sampling_height_m`, aggregation fields nullable because many feeds do not expose them consistently
- `normalised_unit` nullable only for non-normalisable or unknown units; for public AQ series it should be populated

JSONB:

- source SensorThings fields, OpenAQ sensor metadata, Breathe London species metadata, SOS offering/procedure details, and source-specific status intervals

#### `uk_aq_observs.observations`

Purpose: raw observation grain, preserving source granularity.

Key fields:

- `timeseries_id integer not null references uk_aq_core.timeseries(timeseries_id)`
- `observed_at timestamptz not null`
- `source_observed_at timestamptz null`
- `value_raw numeric null`
- `unit_raw text null`
- `value_normalised numeric null`
- `unit_normalised text null`
- `qa_status text null`
- `source_status text null`
- `ingest_run_id bigint null references uk_aq_ops.ingest_runs(ingest_run_id)`
- `source_payload_hash text null`
- `source_metadata jsonb not null default '{}'::jsonb`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Recommended primary key:

- primary key: `(timeseries_id, observed_at)`

Recommended partitioning:

- range partition by `observed_at` using daily or monthly partitions depending on write volume
- do not use TimescaleDB
- keep standard Postgres indexes only

Indexes:

- partition-local primary key `(timeseries_id, observed_at)`
- BRIN on `observed_at` for large partitions
- optional B-tree `(observed_at, timeseries_id)` for backup/day export
- optional partial index on `qa_status` if diagnostics need it

Why no `station_id` on observations:

- station is derivable through `timeseries_id`
- duplicating station creates mismatch risk
- AQI and history exports can join to timeseries when station metadata is needed

Why no `connector_id` on observations:

- connector is derivable through `timeseries_id`
- current `(connector_id, timeseries_id, observed_at)` key is redundant if `timeseries_id` is globally unique
- for high-volume backup partition routing, connector can be denormalised into export manifests rather than the base observation key

If write performance requires connector partitioning later, add a generated or denormalised `connector_id` with a trigger/check, but do not make it part of identity.

#### `uk_aq_ops.ingest_runs`

Purpose: one row per connector ingest execution.

Key fields:

- `ingest_run_id bigint generated by default as identity primary key`
- `connector_id integer null references connectors(connector_id)`
- `connector_code text not null`
- `run_kind text not null`
- `started_at timestamptz not null default now()`
- `finished_at timestamptz null`
- `status text not null default 'started'`
- `stations_seen integer null`
- `stations_upserted integer null`
- `timeseries_seen integer null`
- `timeseries_upserted integer null`
- `observations_seen integer null`
- `observations_upserted integer null`
- `max_observed_at timestamptz null`
- `message text null`
- `summary jsonb not null default '{}'::jsonb`
- `created_at timestamptz not null default now()`

Constraints and indexes:

- check `status in ('started', 'finished', 'failed', 'partial')`
- index: `(connector_code, started_at desc)`
- index: `(status, started_at desc)`

#### `uk_aq_ops.source_checkpoints`

Purpose: replace connector-specific checkpoint tables where possible.

Key fields:

- `checkpoint_key text primary key`
- `connector_id integer not null references connectors(connector_id)`
- `checkpoint_scope text not null`
- `station_id bigint null references stations(station_id)`
- `timeseries_id integer null references timeseries(timeseries_id)`
- `cursor_text text null`
- `cursor_timestamp timestamptz null`
- `cursor_json jsonb not null default '{}'::jsonb`
- `last_success_at timestamptz null`
- `last_error_at timestamptz null`
- `last_error text null`
- `updated_at timestamptz not null default now()`

Indexes:

- `(connector_id, checkpoint_scope)`
- `(timeseries_id)` where `timeseries_id is not null`
- `(station_id)` where `station_id is not null`

Keep connector-specific checkpoint tables only when a source genuinely needs a specialized uniqueness shape.

### Public website-facing tables

#### `uk_aq_public_model.public_networks`

Purpose: display network taxonomy.

Key fields:

- `public_network_id integer generated by default as identity primary key`
- `public_network_code text not null`
- `display_name text not null`
- `is_public_beta_visible boolean not null default false`
- `sort_order integer not null default 100`
- `description text null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Constraints:

- unique: `(public_network_code)`

Initial rows:

- `gov_uk_aurn`, visible
- `breathelondon`, visible
- other networks present but not visible, or omitted until promotion

#### `uk_aq_public_model.public_stations`

Purpose: website display station. Does not own observations.

Key fields:

- `public_station_id bigint generated by default as identity primary key`
- `public_station_code text not null`
- `public_network_id integer not null references public_networks(public_network_id)`
- `display_name text not null`
- `short_name text null`
- `latitude double precision null`
- `longitude double precision null`
- `geometry geography(Point, 4326) null`
- `local_authority_code text null`
- `parliamentary_constituency_code text null`
- `display_status text not null default 'visible'`
- `preferred_source_station_id bigint null references uk_aq_core.stations(station_id)`
- `dedupe_method text null`
- `dedupe_confidence numeric null`
- `display_metadata jsonb not null default '{}'::jsonb`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Constraints and indexes:

- unique: `(public_station_code)`
- index: `(public_network_id, display_status)`
- GiST index: `geometry`
- check `display_status in ('visible', 'hidden', 'diagnostic', 'retired')`

Nullable fields:

- `preferred_source_station_id` nullable for display rows staged before source mapping
- coordinates nullable only during build/staging; public visible rows should have coordinates

JSONB:

- display labels, attribution, dedupe notes, manually curated text

#### `uk_aq_public_model.public_station_sources`

Purpose: source membership and public precedence for a display station.

Key fields:

- `public_station_id bigint not null references public_stations(public_station_id) on delete cascade`
- `station_id bigint not null references uk_aq_core.stations(station_id)`
- `source_role text not null default 'member'`
- `is_primary_display_source boolean not null default false`
- `include_in_public_charts boolean not null default true`
- `include_in_public_map boolean not null default true`
- `source_priority integer not null default 100`
- `match_basis text null`
- `match_confidence numeric null`
- `notes text null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Constraints and indexes:

- primary key: `(public_station_id, station_id)`
- unique partial index: one primary display source per public station where `is_primary_display_source`
- index: `(station_id)`
- index: `(public_station_id, source_priority)`
- check `source_role in ('primary', 'duplicate', 'alternate', 'diagnostic', 'hidden')`

How this handles AURN and Breathe London overlap:

- AURN source station remains its own station and timeseries.
- Breathe London source station remains its own station and timeseries.
- one public station can include both sources.
- public chart default selects one source series by `source_priority` and `include_in_public_charts`.
- alternate source series remain queryable for diagnostics.

#### Optional `uk_aq_public_model.public_timeseries_selection`

Purpose: explicitly select which source timeseries feeds each public station/pollutant chart.

Key fields:

- `public_station_id bigint not null`
- `observed_property_id integer not null`
- `timeseries_id integer not null references uk_aq_core.timeseries(timeseries_id)`
- `selection_role text not null default 'primary'`
- `priority integer not null default 100`
- `is_public_visible boolean not null default true`
- `selection_reason text null`
- `created_at timestamptz not null default now()`

Constraints and indexes:

- primary key: `(public_station_id, observed_property_id, timeseries_id, selection_role)`
- unique partial: one primary visible timeseries per `(public_station_id, observed_property_id)` where `selection_role = 'primary' and is_public_visible`
- index: `(timeseries_id)`

This table is worth adding if source stations have multiple timeseries for the same pollutant or if Breathe London dedupe needs pollutant-level precedence. If not, `public_station_sources` plus a view can derive selections.

### Optional linking/diagnostic tables

#### `uk_aq_core.station_links`

Purpose: audit/candidate table for source-source relationships.

Key fields:

- `station_link_id bigint generated by default as identity primary key`
- `station_id_a bigint not null references stations(station_id)`
- `station_id_b bigint not null references stations(station_id)`
- `link_type text not null`
- `confidence numeric null`
- `reason text null`
- `evidence jsonb not null default '{}'::jsonb`
- `source text not null default 'manual'`
- `created_at timestamptz not null default now()`
- `created_by text null`

Constraints and indexes:

- check `station_id_a < station_id_b`
- unique `(station_id_a, station_id_b, link_type)`
- check `link_type in ('same_real_world_site', 'possible_match', 'not_same')`
- index `(station_id_a)`, `(station_id_b)`, `(link_type)`

This is recommended as a diagnostic table, not as the primary public display table.

## Recommended Observation and Timeseries Grain

Observations should reference `timeseries_id`, not `station_id`.

Timeseries should represent:

- one connector-specific source station
- one canonical observed property
- one source parameter stream or source datastream

Identity should be:

- `connectors.connector_code`
- `stations.source_station_ref`
- `timeseries.source_timeseries_ref`
- `observed_properties.property_code`
- `observations.timeseries_id + observed_at`

Source units and normalised units:

- keep `source_unit` on timeseries and `unit_raw` on observations when the source can vary
- keep `normalised_unit` on timeseries and `unit_normalised` on observations
- public AQ pollutants should normalise to `ug/m3` where appropriate
- do not discard raw units/values

Raw values and normalised values:

- `value_raw` stores exactly what the source reported after numeric parsing
- `value_normalised` stores the value in canonical unit
- public views should use `value_normalised`
- diagnostics can show both

QA flags and source timestamps:

- `observed_at` is the canonical UTC observation timestamp used for identity and query windows
- `source_observed_at` stores source-specific timestamp if it differs or was parsed from a local/source format
- `qa_status` stores project-normalised flags such as `valid`, `suspect`, `invalid`, `missing`
- `source_status` stores raw source status labels
- `source_metadata` stores source payload fragments and QA details that do not justify columns

## Recommended Dedupe and Public Display Model

Use public display stations plus source memberships for v0.2.0 beta.

Do not use a golden/canonical station that owns observations.

### AURN to Breathe London overlap

Represent overlap as:

- one AURN source station in `uk_aq_core.stations`
- one Breathe London source station in `uk_aq_core.stations`
- one public station in `uk_aq_public_model.public_stations`
- two source rows in `public_station_sources`

The public station stores display geometry/name only. It does not own observations.

The default public chart source should be chosen by:

1. explicit `public_timeseries_selection` if present
2. otherwise source station priority in `public_station_sources`
3. otherwise network priority, with AURN before Breathe London for regulatory-grade pollutants unless a Breathe London-specific beta page says otherwise

Breathe London display:

- public network label is `Breathe London`
- Breathe London Communities and Breathe London Nodes can map into that public network
- dedupe can use `InstallationCode`, `SiteCode`, `DeviceCode`, rounded coordinates, and source status
- source feed identity remains visible in diagnostics

Hidden duplicate/source series:

- hidden or alternate source stations remain in source tables
- hidden source timeseries remain in `timeseries`
- diagnostics can query `public_station_sources` and `public_timeseries_selection`
- public map/list/chart filters use `is_public_beta_visible`, `display_status`, and selection flags

## Public Website-Facing Views and RPCs

Create public v0.2.0 views that hide old internal table complexity:

- `uk_aq_public.v02_public_networks`
- `uk_aq_public.v02_public_stations`
- `uk_aq_public.v02_public_station_sources`
- `uk_aq_public.v02_public_timeseries`
- `uk_aq_public.v02_latest_observations`
- `uk_aq_public.v02_station_pollutant_summary`

Create public RPCs/API surfaces:

- `uk_aq_public.uk_aq_v02_latest_rpc(public_network_codes text[] default null)`
- `uk_aq_public.uk_aq_v02_stations_rpc(public_network_codes text[] default null)`
- `uk_aq_public.uk_aq_v02_timeseries_rpc(p_timeseries_id integer, p_start timestamptz, p_end timestamptz, p_format text default 'compact')`
- `uk_aq_public.uk_aq_v02_public_station_timeseries_rpc(p_public_station_id bigint, p_property_code text, p_start timestamptz, p_end timestamptz)`

Website beta should consume public station IDs and selected source timeseries IDs:

- map/list rows show `public_station_id`, `public_station_code`, `public_network_code`, `display_name`, `geometry`, latest selected pollutant values
- chart calls use source `timeseries_id`
- diagnostics can expose alternate source series but normal beta UI should not show them by default

## Migration and Build Plan

### Phase 0: freeze and inventory

Tasks:

- record current v0.1.0 schema and code state
- confirm Dropbox backup completeness
- export current connector, station, timeseries, observed-property, and network inventories
- document current public RPC payload shapes used by the beta website

Egress impact:

- low if done through metadata exports and existing backups
- avoid full observation export unless using existing R2/Dropbox backup artifacts

DB-size impact:

- none to low
- temporary metadata exports only

### Phase 1: new SQL files

Create schema files:

- `uk_aq_v0_2_core_schema.sql`
- `uk_aq_v0_2_observations_schema.sql`
- `uk_aq_v0_2_public_schema.sql`
- `uk_aq_v0_2_ops_schema.sql`
- optional targeted apply file for public display tables

Decisions:

- use standard Postgres range partitions for observations
- no TimescaleDB
- use source-specific IDs and public display tables
- drop old compatibility views/RPCs in v0.2.0 beta environment

Egress impact:

- none from DDL itself
- public egress can decrease if beta views only emit AURN and Breathe London

DB-size impact:

- small metadata increase from public display/source tables
- observation table size roughly unchanged for same raw granularity
- no rollups/downsampling proposed

### Phase 2: ingest code changes

Update ingest code paths:

- `scripts/uk_air_sos/*`
- `scripts/breathelondon/*`
- Breathe London Nodes ingest
- `scripts/erg_laqn/*`
- `scripts/openaq/*`
- `scripts/sensorcommunity/*`
- station daily sync/mirror scripts if a separate ingest DB remains
- Cloud Run workers for UK-AIR SOS, Breathe London, OpenAQ, and Sensor.Community

Implementation shape:

- one shared upsert helper for connectors, stations, observed_properties, timeseries, and observations
- source station upserts use `(connector_id, source_station_ref)`
- timeseries upserts use `(connector_id, source_timeseries_ref)`
- observations upsert by `(timeseries_id, observed_at)`
- network membership written separately
- Breathe London dedupe builder writes public display rows and sources after source ingest

Egress impact:

- write-path payloads to Supabase may shrink because fewer legacy/mirror fields are sent
- this is upload/ingress, not Supabase billable egress
- public response egress should decrease for beta because hidden networks are excluded

DB-size impact:

- source metadata JSONB can grow if too much raw payload is stored
- keep large raw API payloads out of station/timeseries rows unless needed
- observation size may increase slightly if both raw and normalised values are stored; this is worth it for auditability

### Phase 3: reload or backfill

Recommended approach: reload metadata and recent observations from source APIs, then use v0.1.0 backups only for validation or targeted backfill.

Steps:

- seed connectors, networks, public_networks
- run station metadata ingest for all networks
- run Breathe London and Breathe London Nodes station ingest
- build source timeseries for all networks
- load recent observations for all networks
- run public display builder for AURN and Breathe London
- leave non-beta networks ingested but hidden

Egress impact:

- source API egress/request cost depends on each provider
- Supabase public egress remains low until public beta views are queried
- avoid pulling full v0.1.0 observation history back from Dropbox unless needed

DB-size impact:

- full raw-history reload preserves raw granularity and grows with observation volume
- recent-only beta load keeps initial DB smaller but is not a substitute for long-term history preservation
- R2 history can continue to be the long-term history layer

### Phase 4: public views/RPCs and R2/API workers

Tasks:

- build v0.2.0 public views and RPCs
- update R2 latest snapshot builders to source from public display tables
- update AQI computation to use source timeseries, with public station selection only at output time
- update history API workers if payload fields change
- keep stable cacheable URLs for normal traffic

Egress impact:

- likely lower public egress for beta because only AURN and Breathe London are emitted
- stable URLs preserve Cloudflare cache hit behavior
- avoid diagnostic cache-busters in normal traffic

DB-size impact:

- views/RPCs add no data size
- optional materialized/latest snapshot tables add small size if used

### Phase 5: beta website changes

Tasks:

- update map/list data loader to use public station rows
- rename UI concepts from "Sensors" to "timeseries" where code/docs are touched, while preserving user-friendly copy where needed
- chart by selected source `timeseries_id`
- expose source alternatives only in diagnostics
- default visible public networks: AURN and Breathe London

Egress impact:

- lower initial payload if map/list excludes unchecked networks
- chart egress depends on selected timeseries and R2 cache behavior
- keep website polling at 1 minute where applicable

DB-size impact:

- none from website code

### Phase 6: checks and release gates

Checks:

- station source uniqueness checks
- timeseries source uniqueness checks
- no public station owns observations
- every visible public station has at least one visible source
- every visible public station has geometry
- AURN and Breathe London source overlap review report
- Breathe London duplicates collapse to one public display station where intended
- hidden networks are absent from public beta views but present in source tables
- observations preserve raw granularity
- AQI output joins back to source timeseries and public display rows correctly
- R2 snapshot/history manifests remain byte-stable where relevant
- website map/list/chart loads with AURN and Breathe London only

Egress impact:

- validation queries should run from service-role scripts and avoid broad public payload downloads
- test website traffic should check Cloudflare `CF-Cache-Status`

DB-size impact:

- validation outputs should be summaries, not large row dumps

## Final Recommendation

### Simplest viable schema

Use:

- `connectors`
- `networks`
- `stations`
- `station_networks`
- `observed_properties`
- `timeseries`
- `observations`
- `ingest_runs`
- `source_checkpoints`
- `public_networks`
- `public_stations`
- `public_station_sources`

Pros:

- directly solves beta display requirements
- keeps observations source-specific
- avoids a misleading golden station table
- small metadata footprint
- simple enough to implement in one hard-cut release

Cons:

- match evidence is thin unless stored in `public_station_sources.match_basis` and JSON metadata
- future large-scale dedupe review may need more tooling

Egress impact:

- public egress should decrease for initial beta because public views only emit AURN and Breathe London
- write/upload bytes may decrease after removing legacy fields, but do not count that as Supabase egress

DB-size impact:

- small metadata increase
- observation size approximately unchanged, with possible slight increase if both raw and normalised values are stored

### Slightly more robust schema

Use the simplest viable schema plus:

- `station_links`
- optional `public_timeseries_selection`

Pros:

- preserves evidence for source matches and non-matches
- supports pollutant-level source selection
- makes future OpenAQ, Sensor.Community, LAQN, and WAQN promotion safer
- keeps public display rules explicit

Cons:

- slightly more schema and curation work
- more tests and admin views needed

Egress impact:

- no meaningful public egress increase if links stay diagnostic
- diagnostic endpoints should be separate and not loaded by default website views

DB-size impact:

- small for curated links
- can grow if automated candidate matching writes many low-confidence rows

### Recommended pick

Pick the slightly more robust schema, but implement it in two steps:

1. Build the source tables, public display tables, and public beta views first.
2. Add `station_links` and `public_timeseries_selection` immediately after the first AURN/Breathe London display path is working, or include them in the first DDL if implementation time permits.

Reason:

- The core risk is not storing observations incorrectly. The current source timeseries grain is already broadly right.
- The real v0.2.0 risk is public dedupe and network display selection.
- `public_stations` and `public_station_sources` solve that without hiding source differences.
- `station_links` gives an audit trail for Breathe London overlap and future network promotion.
- `public_timeseries_selection` prevents source precedence from becoming ad hoc code when a public station has multiple pollutant series from multiple connectors.

This keeps the beta schema clean while avoiding a later redesign when OpenAQ, Sensor.Community, LAQN, and other networks are promoted back into public display.
