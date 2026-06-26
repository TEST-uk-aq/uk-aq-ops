# UK AQ v0.2.0 draft plan

## Status

Draft for discussion.

This document captures the updated initial plan for UK AQ v0.2.0, following the Breathe London network overlap work.

## Version aim

v0.2.0 is a hard cut from v0.1.0 to a new database schema and updated application code.

The important distinction for v0.2.0 is:

- ingest scope remains broad
- initial public website display scope is narrow

v0.2.0 still needs to ingest all the networks handled before, plus Breathe London Nodes. However, the first beta website display should initially show only:

- GOV.UK AURN
- Breathe London

The first public/beta milestone is to get those two networks working properly in the new schema, including deduplication where needed, then update the beta site. After that, the remaining networks can be worked through for data accuracy and added back to the public display later.

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
- other future networks or local council feeds

These networks are not removed from the ingest plan. They are simply not part of the first website display milestone.

### 4. Breathe London as one public network

Breathe London should be displayed as one network in the public app.

The public user should not need to understand whether a Breathe London station came from a particular underlying Breathe London source feed.

Internally, the source feed detail can still be retained for audit, troubleshooting, and ingest provenance, but the public network identity should be unified.

Public label:

- Breathe London

Internal source/provenance may still record things such as:

- source feed name
- source station identifier
- source device identifier
- source installation/site identifier
- ingest run id
- source payload metadata

### 5. Breathe London deduplication first

The first deduplication work should focus on the two initial displayed networks:

- GOV.UK AURN
- Breathe London

The known practical deduplication issue is Breathe London overlap. Breathe London v0.2.0 should deduplicate overlapping Breathe London stations into one canonical station record before data reaches the public app layer.

From the overlap work, the important known matching signal is:

- Breathe London `InstallationCode` can match Communities `SiteCode`

Other possible matching signals discussed include:

- `DeviceCode`
- rounded coordinates
- source/site status fields

The v0.2.0 plan should define a canonical station identity model so that duplicate source rows are represented as one public station where they describe the same physical monitoring site.

The dedupe should be deterministic and explainable, not a fuzzy process hidden inside the front end.

### 6. Remaining networks added to display later

After GOV.UK AURN and Breathe London are working in the new schema, deduped where needed, and visible on beta, the other networks can be worked through separately.

The later work should focus on:

- data accuracy
- station identity quality
- pollutant/property normalisation
- latest reading reliability
- whether each network should be displayed directly or as an aggregator/source-derived network
- any deduplication or overlap rules needed for those networks

Only after that should each additional network be added back to the public website display.

### 7. GOV.UK AURN naming

The public network label should be:

- GOV.UK AURN

Avoid older or internal labels such as:

- UK-AIR AURN
- UK AIR SOS
- UK-AIR-SOS

The new schema and snapshot format should make the display name explicit so the front end does not need label correction logic.

### 8. No fallback logic

Because this is a hard cut, v0.2.0 code should not contain fallback paths for v0.1.0.

Avoid logic such as:

- if new field missing, try old field
- if new network label missing, remap old label
- if v0.2.0 snapshot missing, load v0.1.0 snapshot
- if canonical station id missing, fall back to source id for public identity

Temporary scripts for inspection or one-off migration checks are fine, but they should not become part of the long-term app code.

### 9. v0.1.0 backup

v0.1.0 has already been backed up in Dropbox.

This means v0.2.0 planning can focus on clean replacement rather than preserving old code paths inside the live app.

The backup should be treated as the historical reference point for v0.1.0 behaviour.

## Draft technical direction

### Database

v0.2.0 should introduce new database schemas/tables for the new station identity model, source mapping, readings, latest readings, network metadata, and snapshot build process.

The database should clearly separate:

- public canonical station identity
- source feed identity
- source-to-station mappings
- network display metadata
- network ingest metadata
- network display flags
- observed pollutant/property metadata
- readings/time series data
- latest public station state
- ingest provenance and run information

The aim is to avoid front-end dedupe and avoid using raw source identifiers as the only public station identity.

The schema must support all ingested networks, even though the initial public display only shows GOV.UK AURN and Breathe London.

### Network visibility model

v0.2.0 should separate network ingest status from public display status.

A network may be:

- ingested and displayed
- ingested but hidden from the public website
- not yet ingested
- planned for future work

This suggests a network metadata model with fields such as:

- network id
- public display name
- source/system name
- ingest enabled flag
- public display enabled flag
- display phase or release phase
- data accuracy status
- notes for known caveats

For the first v0.2.0 beta display:

| Network | Ingested in v0.2.0 | Displayed initially | Notes |
| --- | --- | --- | --- |
| GOV.UK AURN | Yes | Yes | Initial public display network |
| Breathe London | Yes | Yes | Displayed as one deduplicated network |
| Breathe London Nodes | Yes | To decide | Ingest required, public display relationship needs defining |
| OpenAQ | Yes | No | Data accuracy review before display |
| Sensor.Community | Yes | No | Data accuracy review before display |
| Other existing v0.1.0 networks | Yes, where already supported | No | Review before re-adding to display |

### Canonical station model

Each public monitoring location should have one canonical station record.

A canonical station can have one or more source mappings.

For Breathe London, this allows overlapping source feed rows to point to the same public station.

For GOV.UK AURN, the mapping may usually be one source row to one canonical station, but the same model should still be used for consistency.

For the remaining networks, the canonical station model should still be used from the start, even if the network is hidden from the first public display.

Possible fields to discuss:

- canonical station id
- public station name
- public network id
- latitude
- longitude
- local authority or area fields where available
- station type or classification where available
- active/inactive state
- public display enabled flag
- first seen and last seen timestamps
- public display flags

### Source mapping model

Each raw source station/site/device should have a mapping to a canonical station.

Possible fields to discuss:

- source mapping id
- canonical station id
- source feed id
- source station/site id
- source installation code
- source site code
- source device code
- source station name
- source latitude and longitude
- status fields from the source
- match method
- match confidence or priority
- first seen and last seen timestamps
- active flag

For Breathe London, match methods might include:

- installation_code_to_site_code
- same_device_code
- same_coordinates_rounded
- manual_override
- new_station

### Readings model

Readings should attach to the canonical station where possible, while retaining source mapping/provenance so problems can be traced back to the raw feed.

Possible fields to discuss:

- reading id
- canonical station id
- source mapping id
- pollutant/property id
- measured value
- unit
- measurement timestamp
- received/ingested timestamp
- source quality/status fields
- ingest run id

### Latest snapshot model

The latest snapshot should be rebuilt for v0.2.0 rather than adapted through fallback logic.

The snapshot should expose the new public station shape directly:

- canonical station id
- public network id
- public network display name
- public station name
- latitude and longitude
- active/latest status
- latest pollutant values
- latest timestamps
- display enabled flag or display-filtered output
- any display fields needed by the map, chart, list, and network panel

The snapshot should not require the front end to deduplicate Breathe London.

For the first beta update, the public snapshot/API should include only GOV.UK AURN and Breathe London, even though the database is ingesting other networks.

### Front end

The front end should be updated to assume the v0.2.0 snapshot format.

Expected changes:

- load only the new v0.2.0 data shape
- show only GOV.UK AURN and Breathe London initially
- show Breathe London as one deduplicated public network
- show GOV.UK AURN with that exact label
- hide networks that are ingested but not yet approved for public display
- remove old network label correction logic
- remove old schema fallback logic
- ensure chart, map, sensor list, network panel, and search all use canonical station ids

## Draft implementation phases

### Phase 1: Confirm data model

Decide the final v0.2.0 database structure for:

- canonical stations
- source feeds
- source station mappings
- network ingest metadata
- network display metadata
- pollutants/properties
- readings
- latest state
- snapshot output
- ingest run/audit tables

Decide whether these live in entirely new schemas, new table names, or both.

Make sure the model supports all networks, not only the first two displayed networks.

### Phase 2: Confirm network visibility rules

Agree how the system distinguishes between:

- networks being ingested
- networks being available internally
- networks being included in the public snapshot/API
- networks being shown in the website UI

Questions to resolve:

- Should public display be controlled by a database flag?
- Should public snapshots be filtered during snapshot generation?
- Should the front end receive hidden networks and filter them, or should hidden networks never appear in the public payload?
- Should hidden networks be visible on a diagnostics/admin page?
- How should Breathe London Nodes be represented in relation to Breathe London?

### Phase 3: Confirm Breathe London dedupe rules

Agree the deterministic dedupe priority order.

Questions to resolve:

- Should `InstallationCode` to `SiteCode` be the primary rule?
- Should matching `DeviceCode` be used as a strong match?
- How should coordinate-only matches be treated?
- What rounding precision should be used for coordinate matching?
- What happens when a source row is inactive in one feed but active in another?
- Which source wins for station name, coordinates, and status when duplicates merge?
- Do we need a manual override table from the start?

### Phase 4: Create new database schemas

Create the v0.2.0 database schemas and tables.

This should be a clean schema deployment rather than a compatibility migration from v0.1.0.

Deliverables:

- SQL migration files
- table comments where useful
- indexes and constraints
- views/RPCs needed by snapshot builders or front-end APIs
- seed rows for network metadata
- initial display flags for GOV.UK AURN and Breathe London
- hidden/display-pending flags for other ingested networks

### Phase 5: Update ingests

Update ingests to write to the new v0.2.0 tables.

This phase includes all networks, not just the two initially displayed networks.

Deliverables:

- GOV.UK AURN ingest writes canonical/source/readings structure
- Breathe London ingest writes source mappings and deduped canonical stations
- Breathe London Nodes ingest writes to the new schema
- OpenAQ ingest writes to the new schema
- Sensor.Community ingest writes to the new schema
- any other existing v0.1.0 ingest writes to the new schema, where still required
- ingest run records retained for audit
- no writes required to old v0.1.0 tables

### Phase 6: Build v0.2.0 latest snapshot

Create a v0.2.0 snapshot builder that reads only the new schema and emits only the new snapshot format.

The first public snapshot should be filtered to include only:

- GOV.UK AURN
- Breathe London

Deliverables:

- new snapshot format documented
- latest snapshot generation for GOV.UK AURN and Breathe London public display
- validation checks for duplicate canonical station ids
- validation checks for duplicate public Breathe London stations
- validation checks that hidden networks do not appear in the public beta snapshot
- internal checks confirming other networks are still ingesting
- R2/Supabase output path agreed, if applicable

### Phase 7: Update front end

Update map, chart, sensor list, search, and network panel code to use the v0.2.0 snapshot.

Deliverables:

- only GOV.UK AURN and Breathe London visible initially
- Breathe London shown as one network
- canonical station ids used for selection/charting
- old fallback logic removed
- old label correction logic removed
- hidden networks do not appear in public controls/search/list/map

### Phase 8: Test and compare

Run local and test environment checks before promoting.

Suggested checks:

- ingest runs are completing for all expected networks
- public snapshot includes only GOV.UK AURN and Breathe London
- station counts by displayed network
- hidden-network counts available internally for later accuracy work
- Breathe London source row count vs deduped public station count
- sample duplicate pairs confirm as one public station
- latest readings present for both displayed networks
- latest readings are being stored for hidden networks where ingested
- map hex colours work from the new data
- sensor list order works from the new data
- chart opens from map/list and loads readings
- search finds canonical public station names
- no hidden networks appear publicly
- no old labels appear

### Phase 9: Update beta with AURN and Breathe London

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

### Phase 10: Work through remaining networks

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

Add each network to the public display only after its data accuracy is acceptable.

## Items to discuss before coding

### Product scope

- Is v0.2.0 only the data model/network reset, or should any front-end design changes be included?
- Should the public beta notice mention that only GOV.UK AURN and Breathe London are currently displayed?
- Should there be a separate note that other networks are still being ingested and checked before being added?

### Ingest scope

- Which exact v0.1.0 networks must continue ingesting in v0.2.0?
- What is the exact list of Breathe London feeds, including Breathe London Nodes?
- Are any old ingests being retired, or should all previous ingests continue?
- Are there any networks that should ingest but never display publicly?

### Database/schema naming

- What should the new schema be called?
- Should old v0.1.0 tables remain untouched but unused, or be removed from the test database?
- Should table names include `v020`, or should the schema name carry the version?
- Do we want a public schema/view layer separate from ingest tables?

### Network visibility

- Should network visibility be controlled at network level, source-feed level, station level, or snapshot level?
- Should hidden networks be excluded from public snapshots completely?
- Should there be an internal diagnostics snapshot that includes all ingested networks?
- How should the beta site explain the limited initial display scope?

### Station identity

- What is the final canonical station id format?
- Should canonical ids be generated UUIDs, stable slugs, or deterministic network/source based ids?
- Should public station identity be allowed to change if dedupe rules improve later?
- Do we need a station merge/split audit table from the start?

### Breathe London dedupe

- What exact priority order should be used?
- Which source field wins when duplicate rows disagree?
- How should inactive/disabled rows affect public active state?
- Should dedupe decisions be materialised in a table rather than recalculated every ingest?
- Do we need manual override records before launch?
- How do Breathe London Nodes relate to the main Breathe London public network?

### Readings and pollutants

- Should readings store only canonical station id, or canonical station id plus source mapping id?
- How should pollutant names and units be normalised?
- Do we keep source pollutant labels as well as canonical pollutant ids?
- What quality/status fields need to survive into the database?

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
- What station count differences should be expected between source feeds and public stations?
- Which known overlapping Breathe London sites should be used as test cases?
- What manual test route should be followed before promoting to beta?
- What checks prove hidden networks are still ingesting correctly?

## Suggested first decisions

Before writing code, agree these first:

1. Final v0.2.0 schema name and table naming style.
2. Exact list of networks that must ingest in v0.2.0.
3. Network visibility model: ingested vs displayed.
4. Canonical station id strategy.
5. Breathe London dedupe priority order.
6. Whether dedupe mappings are stored permanently in a table.
7. How Breathe London Nodes relate to the public Breathe London network.
8. Snapshot version and output path.
9. Whether public snapshots are filtered to display-enabled networks only.
10. Whether v0.2.0 beta should visibly say it initially displays only GOV.UK AURN and Breathe London.
11. Whether old v0.1.0 database objects are left untouched, archived, or removed from test.

## Current working assumption

The preferred v0.2.0 approach is:

- hard cut to new schemas and code
- no v0.1.0 fallback logic
- v0.1.0 backup already exists in Dropbox
- ingest continues for all existing networks, plus Breathe London Nodes
- initial public beta display includes only GOV.UK AURN and Breathe London
- Breathe London is one public network
- Breathe London source overlap is deduplicated before the public app layer
- other networks remain hidden from the first public display until data accuracy work is done
- front end uses canonical station ids and explicit public network display names
