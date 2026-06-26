# UK AQ v0.2.0 draft plan

## Status

Draft for discussion.

This document captures the current working plan for UK AQ v0.2.0. It replaces the earlier canonical/public-station design with a simpler station-first model.

## Version aim

v0.2.0 is a hard cut from v0.1.0 to a new database schema and updated application code.

The important distinction for v0.2.0 is:

- ingest scope remains broad
- initial public website display scope is narrow
- station/time-series/observation data remains connector-specific
- duplicate real-world sites are handled for display using station grouping and priority

v0.2.0 still needs to ingest all networks handled before, plus Breathe London Nodes. However, the first beta website display should initially show only:

- GOV.UK AURN
- Breathe London

The first public/beta milestone is to get those two networks working properly in the new schema, including deduplication where needed, then update the beta site. After that, the remaining networks can be checked for data accuracy and added back to the public display later.

## Agreed points

### 1. Hard cut from v0.1.0

v0.2.0 will not try to support both old and new database shapes at the same time.

There should be no fallback logic for v0.1.0 schemas, old snapshot formats, old connector labels, or old front-end assumptions.

This means:

- database schemas can be redesigned cleanly
- ingest and snapshot code can target the new schema directly
- front-end code can assume the new public data shape
- migration complexity should be kept out of the application code
- old compatibility branches should be avoided unless they are needed for temporary local diagnostics

v0.1.0 has already been backed up in Dropbox, so the project does not need a rollback compatibility layer inside v0.2.0.

### 2. Ingest scope remains all networks

v0.2.0 still needs to ingest all networks previously supported by the project, plus Breathe London Nodes.

This is important because the new schema should not be designed only around GOV.UK AURN and Breathe London. The schema should be capable of supporting the full network set, even though only two networks will be displayed at first.

Initial v0.2.0 ingest scope should include:

- GOV.UK AURN
- Breathe London
- Breathe London Nodes
- OpenAQ
- Sensor.Community
- LAQN, when the LAQN connector is brought into the v0.2.0 flow
- any other networks already part of the v0.1.0 ingest system

The ingest layer should continue collecting and storing these networks in the new v0.2.0 schema, subject to each network’s data quality and readiness.

### 3. Initial website display scope is only AURN and Breathe London

The first public/beta display for v0.2.0 should only show:

- GOV.UK AURN
- Breathe London

Other networks should be hidden from the initial public website display until their data accuracy has been reviewed and improved.

Out of initial display scope:

- OpenAQ
- Sensor.Community
- PurpleAir, if present or planned
- LAQN, until the LAQN connector and duplicate handling have been checked
- other future networks or local council feeds

These networks are not removed from the ingest plan. They are simply not part of the first website display milestone.

### 4. Breathe London as one public network

Breathe London should be displayed as one network in the public app.

The public user should not need to understand whether a Breathe London station came from a particular underlying Breathe London connector.

Internally, the connector detail should still be retained for audit, troubleshooting, ingest provenance and data comparison.

Public label:

- Breathe London

Internal provenance may still record things such as:

- connector id
- station ref
- device id
- installation/site id
- ingest run id
- source payload metadata

### 5. Station data stays independent

Each station row should be treated as an independent station record.

A station row should have:

- one `station_id`
- one `connector_id`
- one `network_id`
- one `station_ref`
- its own timeseries
- its own observations

If the same real-world monitoring site appears through two connectors, or through two networks, it should still be stored as two separate station rows.

The important rule is:

> Duplicate station rows may be grouped for website display, but their timeseries and observations must not be merged.

This protects against cases where two connectors appear to contain the same station but their observations differ.

### 6. Dedupe is by station group and priority

Duplicate station rows should be linked by a nullable `group_id` on `stations`.

Stations with the same `group_id` are alternate records for the same real-world monitoring site.

A `priority` field on `stations` decides which station row should be displayed when more than one member of the group is available for the currently selected networks.

Priority rule:

- lower number wins
- `1` is highest priority
- larger numbers are fallback choices

Example, LAQN direct plus LAQN via OpenAQ:

| station_id | connector | network | group_id | priority |
| --- | --- | --- | --- | --- |
| 1 | OpenAQ | OpenAQ | 1 | 2 |
| 2 | LAQN | LAQN | 1 | 1 |

If both OpenAQ and LAQN are selected, the website displays station 2 and uses station 2’s timeseries/observations.

If only OpenAQ is selected, the website displays station 1 and uses station 1’s timeseries/observations.

Example, Breathe London from two connectors:

| station_id | connector | network | group_id | priority |
| --- | --- | --- | --- | --- |
| 3 | Breathe London main | Breathe London | 2 | 1 |
| 4 | Breathe London Nodes | Breathe London | 2 | 2 |

If Breathe London is selected, the website displays the available station with the lowest priority for that group.

This same model can handle:

- duplicate stations within Breathe London
- duplicate stations between AURN and OpenAQ
- duplicate stations between LAQN and OpenAQ
- duplicate stations between AURN, LAQN and OpenAQ
- future duplicate stations between any other networks

### 7. Cross-network duplicate indicator

When a `group_id` contains stations from more than one distinct network, the public site may show an indicator that the monitoring site is present in multiple networks.

This should be derived from grouped station rows rather than manually maintained at first.

For example:

- group contains AURN, LAQN and OpenAQ: show multiple-network indicator
- group contains two Breathe London connector rows but only the Breathe London network: no cross-network indicator needed

This indicator is display-only. It must not change which timeseries or observations are used.

### 8. Network visibility

Network visibility should be controlled by the `networks` table.

Recommended field:

- `is_public_visible`

For v0.2.0 initial beta:

| Network | Ingested in v0.2.0 | `is_public_visible` initially | Notes |
| --- | --- | --- | --- |
| GOV.UK AURN | Yes | true | Initial public display network |
| Breathe London | Yes | true | Displayed as one deduplicated network |
| Breathe London Nodes | Yes | false or not a separate public network | Ingested through its connector, displayed as Breathe London when selected |
| OpenAQ | Yes | false | Data accuracy review before display |
| Sensor.Community | Yes | false | Data accuracy review before display |
| LAQN | Yes, when connector is added | false | Data and duplicate handling review before display |
| Other existing v0.1.0 networks | Yes, where still supported | false | Review before re-adding to display |

There may also be a `display_order` field for the website network controls.

### 9. GOV.UK AURN naming

The public network label should be:

- GOV.UK AURN

Avoid older or internal labels such as:

- UK-AIR AURN
- UK AIR SOS
- UK-AIR-SOS

The new schema and snapshot format should make the display name explicit so the front end does not need label correction logic.

### 10. No fallback logic

Because this is a hard cut, v0.2.0 code should not contain fallback paths for v0.1.0.

Avoid logic such as:

- if new field missing, try old field
- if new network label missing, remap old label
- if v0.2.0 snapshot missing, load v0.1.0 snapshot
- if new station grouping missing, fall back to old canonical station logic

Temporary scripts for inspection or one-off migration checks are fine, but they should not become part of the long-term app code.

### 11. v0.1.0 backup

v0.1.0 has already been backed up in Dropbox.

This means v0.2.0 planning can focus on clean replacement rather than preserving old code paths inside the live app.

The backup should be treated as the historical reference point for v0.1.0 behaviour.

## Glossary

### Connector

A connector is the technical ingest source/API/feed.

Examples:

- UK-AIR SOS
- Breathe London main connector
- Breathe London Nodes connector
- OpenAQ
- Sensor.Community
- LAQN connector

A connector is not the same thing as a network.

### Network

A network is the monitoring network or public grouping that a station belongs to.

Examples:

- GOV.UK AURN
- Breathe London
- OpenAQ
- Sensor.Community
- LAQN

In the simplified v0.2.0 model, each station row belongs to one network.

### Station

A station is one connector-specific monitoring station record.

A station has one connector and one network.

If the same real-world site is present in two connectors or two networks, those are separate station rows.

### Station group

A station group links station rows that represent the same real-world monitoring site.

A station group is only for dedupe/display selection. It does not own timeseries or observations.

### Priority

Priority decides which station row wins within a group when multiple grouped stations are available for the selected networks.

Lower number wins.

### Timeseries

A timeseries is one measurement stream for one station and one observed property.

Examples:

- station 10 PM2.5
- station 10 NO2
- station 11 PM2.5

Timeseries belongs to a station.

### Observation

An observation is one measured value at one timestamp for one timeseries.

Observations should reference `timeseries_id`, not `group_id`.

### Observed property

An observed property is the canonical measurement/pollutant dictionary.

Examples:

- `pm25`
- `pm10`
- `no2`
- `o3`
- `so2`
- `co`
- `temperature`
- `humidity`

It is used so that different connector labels for the same pollutant can be mapped to one internal property code.

## Draft technical direction

### Recommended core tables

The simplified v0.2.0 core model is:

- `connectors`
- `networks`
- `stations`
- `station_groups`
- `observed_properties`
- `timeseries`
- `observations`
- `ingest_runs`
- `source_checkpoints` or connector-specific checkpoint tables where needed

Removed from the current preferred plan:

- `station_networks`
- `station_network_memberships`
- `public_stations`
- `public_station_sources`
- `public_timeseries_selection`
- canonical/public station tables that own or imply merged observations

Those tables may be useful in a different design, but they are not part of the current simplified v0.2.0 direction.

### `connectors`

Purpose: one row per technical ingest connector.

Suggested fields:

- `connector_id`
- `connector_code`
- `display_name`
- `provider_name`
- `service_url`
- `connector_kind`
- `is_active`
- `ingest_enabled`
- `config`
- `metadata`
- `created_at`
- `updated_at`

Notes:

- Keep the word `connector`.
- Do not also use `source` as a parallel term for the same thing.
- Connector identity should be retained for diagnostics and for comparing duplicate station data.

### `networks`

Purpose: one row per network/display grouping.

Suggested fields:

- `network_id`
- `network_code`
- `display_name`
- `is_active`
- `ingest_enabled`
- `is_public_visible`
- `display_order`
- `data_status`
- `notes`
- `metadata`
- `created_at`
- `updated_at`

Initial public visibility:

- GOV.UK AURN: public visible
- Breathe London: public visible
- OpenAQ: hidden
- Sensor.Community: hidden
- LAQN: hidden until checked
- other networks: hidden until checked

### `station_groups`

Purpose: group stations that are the same real-world monitoring site.

Suggested fields:

- `group_id`
- `display_name`
- `latitude`
- `longitude`
- `status`
- `match_basis`
- `confidence`
- `notes`
- `metadata`
- `created_at`
- `updated_at`

Notes:

- Non-duplicate stations do not need a group row.
- `stations.group_id` can be nullable.
- A station group does not own observations.
- A station group does not replace the selected station.
- The selected station’s own timeseries and observations are always used.

### `stations`

Purpose: one independent connector-specific station.

Suggested fields:

- `station_id`
- `connector_id`
- `network_id`
- `station_ref`
- `station_name`
- `display_name`
- `latitude`
- `longitude`
- `geometry`
- `country_code`
- `region_code`
- `local_authority_code`
- `parliamentary_constituency_code`
- `station_type`
- `site_type`
- `exposure`
- `status`
- `is_active`
- `is_public_candidate`
- `group_id`
- `priority`
- `first_seen_at`
- `last_seen_at`
- `ended_at`
- `metadata`
- `created_at`
- `updated_at`

Recommended constraints and indexes:

- primary key: `station_id`
- unique: `(connector_id, station_ref)`
- index: `(connector_id)`
- index: `(network_id)`
- index: `(group_id)`
- index: `(group_id, priority)`
- index: `(network_id, is_public_candidate)`
- spatial index on `geometry`, if PostGIS geography/geometry is used

Notes:

- Use `station_ref`, not `source_station_ref`.
- Current assumption: there should not be duplicate `station_ref` values within a connector.
- If a connector unexpectedly exposes duplicate station refs, this should be treated as a data-quality issue to investigate rather than designed around prematurely.
- `group_id` is nullable.
- `priority` defaults to a normal fallback value such as `100`.
- Lower priority value wins when selecting a station from a group.

### `observed_properties`

Purpose: canonical pollutant/measurement dictionary.

Suggested fields:

- `observed_property_id`
- `property_code`
- `display_name`
- `canonical_unit`
- `domain`
- `default_display_precision`
- `is_public_visible`
- `metadata`
- `created_at`
- `updated_at`

Examples:

- `pm25`
- `pm10`
- `no2`
- `o3`
- `so2`
- `co`
- `temperature`
- `humidity`

Notes:

- Keep this table.
- It maps connector-specific pollutant labels onto stable UK AQ property codes.
- It is not for station dedupe.

### `timeseries`

Purpose: one measurement stream for one station and one observed property.

Suggested fields:

- `timeseries_id`
- `connector_id`
- `station_id`
- `observed_property_id`
- `timeseries_ref`
- `parameter_ref`
- `parameter_label`
- `source_unit`
- `normalised_unit`
- `aggregation_period`
- `measurement_method`
- `sampling_height_m`
- `status`
- `first_observed_at`
- `last_observed_at`
- `last_value`
- `last_normalised_value`
- `last_qa_status`
- `metadata`
- `created_at`
- `updated_at`
- `ended_at`

Recommended constraints and indexes:

- primary key: `timeseries_id`
- unique: `(connector_id, timeseries_ref)`
- index: `(station_id, observed_property_id)`
- index: `(observed_property_id, station_id)`
- index: `(connector_id, status)`

Notes:

- Use `timeseries_ref`, not `source_timeseries_ref`.
- Timeseries belongs to one station.
- Observations belong to one timeseries.
- `connector_id` is technically derivable through station, but may be useful for ingest and diagnostics.

### `observations`

Purpose: raw observation grain, preserving connector/station/timeseries independence.

Suggested fields:

- `timeseries_id`
- `observed_at`
- `value_raw`
- `unit_raw`
- `value_normalised`
- `unit_normalised`
- `qa_status`
- `source_status`
- `ingest_run_id`
- `payload_hash`
- `metadata`
- `created_at`
- `updated_at`

Recommended primary key:

- `(timeseries_id, observed_at)`

Notes:

- Observations should reference `timeseries_id`, not `station_id` and not `group_id`.
- Station, connector and network are derivable through `timeseries_id`.
- The grouped display layer must not merge observations.

## Website selection rules

### Public station selection

For the public map/list/latest values:

1. Start from `stations`.
2. Join to `networks`.
3. Only include stations where:
   - `networks.is_public_visible = true`
   - the network is selected in the UI
   - `stations.is_public_candidate = true`
   - the station is active or otherwise valid for public display
4. For stations with `group_id is null`, show them normally.
5. For stations with `group_id is not null`, group by `group_id`.
6. Within each group, choose the station with the lowest `priority` among the currently selected/visible networks.
7. Use the chosen station’s own `station_id` to find timeseries and observations.
8. Do not merge observations from other stations in the group.

### Chart selection

When a user opens a chart from the map/list:

1. The selected public row must carry the chosen `station_id`.
2. The chart loads timeseries for that `station_id`.
3. The chart reads observations from those timeseries.
4. Other stations in the same `group_id` are not used unless a diagnostics/comparison mode explicitly asks for them.

### Network filter behaviour

Example group:

| station_id | connector | network | group_id | priority |
| --- | --- | --- | --- | --- |
| 1 | OpenAQ | OpenAQ | 1 | 2 |
| 2 | LAQN | LAQN | 1 | 1 |

If both OpenAQ and LAQN are selected:

- show station 2
- use station 2 observations

If only OpenAQ is selected:

- show station 1
- use station 1 observations

### Multiple-network indicator

If a selected station has a `group_id`, the public view can derive whether the group contains stations from multiple distinct networks.

This can support a display indicator such as:

- also present in OpenAQ
- also present in LAQN
- multiple network records available

This indicator should not affect the selected station or its observations.

## Breathe London dedupe

Breathe London can use the same station grouping model as other networks.

Example:

| station_id | connector | network | group_id | priority |
| --- | --- | --- | --- | --- |
| 3 | Breathe London main | Breathe London | 2 | 1 |
| 4 | Breathe London Nodes | Breathe London | 2 | 2 |

Both stations remain independent. The website displays one station for group 2 and uses the chosen station’s own timeseries and observations.

The priority for Breathe London duplicates should be set after analysing which connector gives better data for each duplicate station.

Known possible matching signals:

- Breathe London `InstallationCode`
- Communities `SiteCode`
- `DeviceCode`
- rounded coordinates
- status fields
- station names
- manual review

## LAQN and UK-AIR SOS question

There is an open question about how LAQN appears through UK-AIR SOS and whether some LAQN stations are also part of AURN.

This should be checked before finalising LAQN import/display behaviour.

The current simplified model can still handle the expected cases:

### Case A: LAQN direct station and OpenAQ station

| station_id | connector | network | group_id | priority |
| --- | --- | --- | --- | --- |
| 1 | OpenAQ | OpenAQ | 1 | 2 |
| 2 | LAQN | LAQN | 1 | 1 |

### Case B: LAQN appears through UK-AIR SOS and through LAQN connector

| station_id | connector | network | group_id | priority |
| --- | --- | --- | --- | --- |
| 10 | UK-AIR SOS | LAQN | 5 | 2 |
| 11 | LAQN | LAQN | 5 | 1 |

### Case C: AURN, LAQN and OpenAQ all refer to the same real-world site

| station_id | connector | network | group_id | priority |
| --- | --- | --- | --- | --- |
| 20 | UK-AIR SOS | GOV.UK AURN | 6 | 1 |
| 21 | LAQN | LAQN | 6 | 2 |
| 22 | OpenAQ | OpenAQ | 6 | 3 |

The selected station depends on currently selected networks and priority.

If a station is genuinely both LAQN and AURN in the source data, the v0.2.0 simplification is to represent the imported records as separate station rows if needed, because each station row belongs to one network.

## Latest snapshot/API model

The latest snapshot should be rebuilt for v0.2.0 rather than adapted through fallback logic.

The public snapshot should expose selected station rows after grouping and priority selection.

The first public snapshot/API should include only:

- GOV.UK AURN
- Breathe London

Suggested public row fields:

- schema version
- station id
- group id, where present
- connector id/code
- network id/code
- network display name
- station ref
- station name/display name
- latitude/longitude
- active/latest status
- latest pollutant values
- latest timestamps
- public visibility fields
- optional multiple-network indicator
- optional grouped station count
- optional list of other networks in group

The snapshot should not require the front end to deduplicate Breathe London or cross-network duplicate stations.

## Front end

The front end should be updated to assume the v0.2.0 snapshot format.

Expected changes:

- load only the new v0.2.0 data shape
- show only GOV.UK AURN and Breathe London initially
- show Breathe London as one deduplicated public network
- show GOV.UK AURN with that exact label
- hide networks that are ingested but not yet approved for public display
- remove old network label correction logic
- remove old schema fallback logic
- map/list/search use selected station ids
- chart uses selected station ids and their timeseries
- optional indicator for stations present in multiple networks

## Draft implementation phases

### Phase 1: Confirm data model

Decide the final v0.2.0 database structure for:

- connectors
- networks
- stations
- station groups
- observed properties
- timeseries
- observations
- latest state
- snapshot output
- ingest run/audit tables

Make sure the model supports all networks, not only the first two displayed networks.

### Phase 2: Confirm network visibility rules

Agree how the system distinguishes between:

- networks being ingested
- networks being available internally
- networks being included in the public snapshot/API
- networks being shown in the website UI

Questions to resolve:

- Should public display be controlled only by `networks.is_public_visible`?
- Should public snapshots be filtered during snapshot generation?
- Should hidden networks ever appear in public payloads?
- Should hidden networks be visible on a diagnostics/admin page?
- How should Breathe London Nodes be represented in relation to Breathe London?

### Phase 3: Confirm station grouping and priority rules

Agree the deterministic grouping and selection rules.

Questions to resolve:

- Should `group_id` be nullable on `stations`?
- What default `priority` should non-grouped stations receive?
- Should lower priority always win?
- Should grouped stations be selected only from currently visible/selected networks?
- Should a station with no recent observations lose to a lower-priority station that has recent data?
- Should there be a manual override/edit table later?
- How should inactive stations affect selection?
- How should multiple-network indicators be displayed?

### Phase 4: Confirm Breathe London dedupe rules

Agree the deterministic Breathe London matching signals and priority rules.

Questions to resolve:

- Should `InstallationCode` to `SiteCode` be the primary rule?
- Should matching `DeviceCode` be used as a strong match?
- How should coordinate-only matches be treated?
- What rounding precision should be used for coordinate matching?
- What happens when a station is inactive in one connector but active in another?
- Which Breathe London connector wins by default?
- Do we need manual override records before launch?
- How do Breathe London Nodes relate to the public Breathe London network?

### Phase 5: Create new database schemas

Create the v0.2.0 database schemas and tables.

This should be a clean schema deployment rather than a compatibility migration from v0.1.0.

Deliverables:

- SQL migration files
- table comments where useful
- indexes and constraints
- views/RPCs needed by snapshot builders or front-end APIs
- seed rows for connectors
- seed rows for network metadata
- initial display flags for GOV.UK AURN and Breathe London
- hidden/display-pending flags for other ingested networks

### Phase 6: Update ingests

Update ingests to write to the new v0.2.0 tables.

This phase includes all networks, not just the two initially displayed networks.

Deliverables:

- GOV.UK AURN ingest writes stations, timeseries and observations
- Breathe London ingest writes independent station rows and station groups where duplicates exist
- Breathe London Nodes ingest writes to the new schema
- OpenAQ ingest writes to the new schema
- Sensor.Community ingest writes to the new schema
- LAQN ingest writes to the new schema when brought in
- any other existing v0.1.0 ingest writes to the new schema, where still required
- ingest run records retained for audit
- no writes required to old v0.1.0 tables

### Phase 7: Build v0.2.0 latest snapshot

Create a v0.2.0 snapshot builder that reads only the new schema and emits only the new snapshot format.

The first public snapshot should be filtered to include only:

- GOV.UK AURN
- Breathe London

Deliverables:

- new snapshot format documented
- latest snapshot generation for GOV.UK AURN and Breathe London public display
- validation checks for duplicate visible station groups
- validation checks for duplicate public Breathe London stations
- validation checks that hidden networks do not appear in the public beta snapshot
- internal checks confirming other networks are still ingesting
- R2/Supabase output path agreed, if applicable

### Phase 8: Update front end

Update map, chart, sensor list, search, and network panel code to use the v0.2.0 snapshot.

Deliverables:

- only GOV.UK AURN and Breathe London visible initially
- Breathe London shown as one network
- selected station ids used for charting
- old fallback logic removed
- old label correction logic removed
- hidden networks do not appear in public controls/search/list/map
- optional multiple-network indicator supported if included in snapshot

### Phase 9: Test and compare

Run local and test environment checks before promoting.

Suggested checks:

- ingest runs are completing for all expected networks
- public snapshot includes only GOV.UK AURN and Breathe London
- station counts by displayed network
- hidden-network counts available internally for later accuracy work
- Breathe London station count vs grouped display station count
- sample duplicate groups confirm as one public station
- latest readings present for both displayed networks
- latest readings are being stored for hidden networks where ingested
- grouped stations use the selected station’s own timeseries and observations
- map hex colours work from the new data
- sensor list order works from the new data
- chart opens from map/list and loads readings
- search finds selected station names
- no hidden networks appear publicly
- no old labels appear

### Phase 10: Update beta with AURN and Breathe London

Once GOV.UK AURN and Breathe London are working in the new schema and Breathe London dedupe has been checked, update the beta site.

Cutover checklist:

- v0.1.0 backup confirmed in Dropbox
- v0.2.0 database schema deployed
- all required ingests writing to v0.2.0 schema
- GOV.UK AURN public display working
- Breathe London public display working
- Breathe London dedupe checked
- latest public snapshot generated from v0.2.0 schema
- public snapshot includes only GOV.UK AURN and Breathe London
- front end points to v0.2.0 snapshot/API
- old fallback logic removed
- test site checked
- beta site promoted when ready

### Phase 11: Work through remaining networks

After the first beta update, work through the remaining ingested networks one by one.

For each network, check:

- station identity accuracy
- duplicate/overlap risk
- pollutant/property naming
- units
- latest reading reliability
- timestamp handling
- public display name
- aggregator/source labelling
- whether the network should be enabled on the public website
- duplicate-group priority compared with other connectors/networks

Add each network to the public display only after its data accuracy is acceptable.

## Items to discuss before coding

### Product scope

- Is v0.2.0 only the data model/network reset, or should any front-end design changes be included?
- Should the public beta notice mention that only GOV.UK AURN and Breathe London are currently displayed?
- Should there be a separate note that other networks are still being ingested and checked before being added?

### Ingest scope

- Which exact v0.1.0 networks must continue ingesting in v0.2.0?
- What is the exact list of Breathe London connectors, including Breathe London Nodes?
- Are any old ingests being retired, or should all previous ingests continue?
- Are there any networks that should ingest but never display publicly?

### Database/schema naming

- What should the new schema be called?
- Should old v0.1.0 tables remain untouched but unused, or be removed from the test database?
- Should table names include `v020`, or should the schema name carry the version?
- Do we want a public schema/view layer separate from ingest tables?

### Connector/network/station identity

- Confirm that one station row has exactly one connector and one network.
- Confirm `station_ref` is unique within each connector.
- Confirm whether the unique station constraint should be `(connector_id, station_ref)`.
- Confirm whether any connector can return the same station ref for different networks.
- Confirm how UK-AIR SOS represents LAQN stations.
- Confirm whether some LAQN stations are part of AURN.

### Network visibility

- Should network visibility be controlled by `networks.is_public_visible`?
- Should hidden networks be excluded from public snapshots completely?
- Should there be an internal diagnostics snapshot that includes all ingested networks?
- How should the beta site explain the limited initial display scope?

### Station grouping and priority

- What is the final name for `group_id` and `station_groups`?
- Is `priority` the final field name?
- Should default priority be `100`?
- Should grouped station priority be set manually, automatically, or both?
- What checks are needed to monitor duplicate station data and decide which connector gives better observations?
- Should there be an audit trail for priority changes?

### Breathe London dedupe

- What exact priority order should be used?
- Which connector wins by default?
- Which source field wins when duplicate rows disagree?
- How should inactive/disabled rows affect public active state?
- Should dedupe decisions be materialised in `stations.group_id` and `stations.priority`?
- Do we need manual override records before launch?
- How do Breathe London Nodes relate to the public Breathe London network?

### Observations and pollutants

- How should pollutant names and units be normalised?
- Do we keep connector pollutant labels as well as canonical observed property ids?
- What quality/status fields need to survive into the database?
- Do we keep both raw values and normalised values?

### Snapshots and APIs

- What should the v0.2.0 snapshot path be?
- Should snapshot files include a version number in the file name or payload?
- Should the front end reject snapshots without `schema_version: 0.2.0`?
- What validation checks should block publishing a bad snapshot?
- Should the public snapshot be pre-filtered to display-enabled networks only?

### Front-end cutover

- Which files need changing first?
- Should old network definitions be deleted or commented during development?
- Should chart and map be cut over together?
- Should there be a temporary local diagnostics page for v0.2.0 snapshot inspection?

### Testing

- What counts as acceptable Breathe London dedupe output?
- What station count differences should be expected between connector station rows and grouped public display rows?
- Which known overlapping Breathe London sites should be used as test cases?
- What manual test route should be followed before promoting to beta?
- What checks prove hidden networks are still ingesting correctly?

## Suggested first decisions

Before writing code, agree these first:

1. Final v0.2.0 schema name and table naming style.
2. Exact list of networks that must ingest in v0.2.0.
3. Network visibility model: ingested vs displayed.
4. Confirm one station row has one connector and one network.
5. Confirm use of `station_ref`, not `source_station_ref`.
6. Confirm station uniqueness as `(connector_id, station_ref)`.
7. Confirm `stations.group_id` and `stations.priority` as the dedupe/display selection model.
8. Breathe London dedupe matching and priority rules.
9. How Breathe London Nodes relate to the public Breathe London network.
10. Snapshot version and output path.
11. Whether public snapshots are filtered to display-enabled networks only.
12. Whether v0.2.0 beta should visibly say it initially displays only GOV.UK AURN and Breathe London.
13. Whether old v0.1.0 database objects are left untouched, archived, or removed from test.

## Current working assumption

The preferred v0.2.0 approach is:

- hard cut to new schemas and code
- no v0.1.0 fallback logic
- v0.1.0 backup already exists in Dropbox
- ingest continues for all existing networks, plus Breathe London Nodes
- initial public beta display includes only GOV.UK AURN and Breathe London
- Breathe London is one public network
- connector remains the project word for technical ingest source
- each station row has one connector and one network
- use `station_ref`, not `source_station_ref`
- `station_ref` is expected to be unique within each connector
- stations own their own timeseries
- observations belong to timeseries
- duplicate real-world sites are grouped with `stations.group_id`
- station selection inside a group is controlled by `stations.priority`
- lower priority number wins
- station grouping affects website display only
- grouped stations do not merge timeseries or observations
- other networks remain hidden from the first public display until data accuracy work is done
- front end uses selected station ids and explicit public network display names
