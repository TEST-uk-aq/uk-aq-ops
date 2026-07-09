# UK AQ website/API v0.2.0 network hard cut

## Status

Design confirmed. Phases 0 through 3 are complete on TEST. Phase 4 has not
started.

This is a hard cut from connector-derived public network identity to the
v0.2.0 network model. It does not preserve old connector-based URL parameters,
API filters, payload fallbacks, browser state, or frontend naming.

No archive snapshot is required for this change. The v0.1.0 archive already
exists.

## Confirmed decisions

- Public network identity comes from `uk_aq_core.networks`.
- Only networks with `public_display_enabled = true` are returned or displayed
  by public API and website paths.
- `networks.display_name` is exposed as `network_label` and is the only
  user-facing network name.
- Each station has one `connector_id` and one canonical `network_id`.
- `stations.network_id -> networks.id` is authoritative for public reads.
- Connector-to-network mapping through `connectors.default_network_id` is a
  write-time default, not a public read-time fallback.
- Breathe London Nodes and Breathe London Communities remain separate
  connectors but resolve to the single public `breathelondon` network with
  label `Breathe London`.
- Station matching, station merging, and `station_matches` work are out of
  scope.
- Connector identifiers and source details remain available for internal
  provenance, debug views, details panels, metrics, and cache keys.
- The legacy `uk_aq_networks` and `station_network_memberships` tables are
  removed from the active schema.
- All non-archive runtime, API, worker, script, test, configuration, and
  current system-documentation dependencies on those tables are removed.
- UK-AIR SOS station network assignment moves to the canonical
  `stations.network_id -> networks.id` relationship.
- OpenAQ is not currently ingested on TEST and remains
  `public_display_enabled = false`.
- OpenAQ retains `network_type = 'aggregator'` so it is ready for later public
  enablement.
- LAQN uses `network_type = 'official'`.
- Breathe London and Sensor.Community use `network_type = 'community'`.
- `network_type` is a text column with a check constraint, not a PostgreSQL
  enum.
- `network_type` is exposed by the public network catalog only. It is not
  repeated on station/latest rows because stations may gain a separate station
  type later.
- The hard-cut snapshot contract uses `latest_snapshots/v2` while retaining
  the existing latest-observation state.
- Website polling remains fixed at one minute.
- Normal traffic uses stable URLs. Cache-buster parameters are reserved for
  diagnostics and explicit forced refreshes.

## New `networks.network_type` field

Add `network_type text not null` with an allowed-value check:

```sql
check (network_type in ('official', 'community', 'aggregator'))
```

A text column plus a check constraint is preferred to a PostgreSQL enum. It
keeps the allowed values enforced while making a future type addition less
operationally restrictive.

Proposed seed values:

| `network_code` | `network_type` | Public on TEST |
| --- | --- | --- |
| `gov_uk_aurn` | `official` | yes |
| `breathelondon` | `community` | yes |
| `openaq` | `aggregator` | no |
| `sensorcommunity` | `community` | no |
| `laqn` | `official` | no |

The public networks API includes `network_type`. Station/latest rows do not.
The frontend must not infer a network type from connector codes or labels.

## Current architecture

The normal hex-map request path is:

```text
hex_map.html
  -> Cloudflare cache proxy /api/aq/*
    -> /latest-snapshot -> R2 latest-snapshot API worker
    -> /latest          -> Supabase uk_aq_latest edge function
    -> /pcon-hex        -> Supabase uk_aq_pcon_hex edge function
    -> /la-hex          -> Supabase uk_aq_la_hex edge function
```

`hex_map.html` normally uses the R2 latest snapshot for supported windows and
uses the live Supabase latest endpoint as a fallback. The map downloads all
rows for the selected pollutant/window and applies network selection in the
browser.

The latest-snapshot production path is:

```text
Pub/Sub latest observation state
  + daily R2 core metadata snapshot
  -> latest-snapshot Cloud Run builder
  -> deterministic latest snapshot JSON in R2
  -> R2 API worker
  -> cache proxy
  -> website
```

The current R2 core metadata export includes connectors, stations,
`uk_aq_networks`, and `station_network_memberships`, but not the v0.2.0
`networks` table. The snapshot builder therefore reconstructs public network
identity from legacy membership rows.

The live public RPCs use the same legacy model:

- `uk_aq_latest_rpc` adds a `station_network_memberships` JSON array.
- `uk_aq_stations_rpc` returns `network_memberships`.
- `uk_aq_latest`, `uk_aq_stations`, and `uk_aq_stations_chart` accept
  connector filters.
- PCON and LA aggregate RPCs do not consistently enforce
  `public_display_enabled`.

The frontend labels the controls as networks but still:

- falls back to connector codes and labels;
- canonicalises connector-derived strings in JavaScript;
- changes `gov_uk_aurn` to `aurn`;
- changes `breathelondon` to `breathe_london`;
- uses hardcoded base network definitions;
- uses membership arrays for filtering;
- uses connector-derived names when network metadata is missing.

## Target public data contract

### Public networks endpoint

Add:

```http
GET /api/aq/networks
```

Suggested response:

```json
{
  "contract_version": 2,
  "data": [
    {
      "network_id": 1,
      "network_code": "gov_uk_aurn",
      "network_label": "GOV.UK AURN",
      "network_type": "official",
      "public_display_enabled": true
    },
    {
      "network_id": 2,
      "network_code": "breathelondon",
      "network_label": "Breathe London",
      "network_type": "community",
      "public_display_enabled": true
    }
  ]
}
```

The endpoint only returns enabled networks. Including
`public_display_enabled: true` is intentional contract clarity even though
every returned row is enabled.

The endpoint uses a stable URL and the cache proxy metadata profile. The
website uses this catalog to build its network filters, including zero-reading
networks if an enabled network has no current rows.

### Latest and station rows

Public latest, station search, station geometry, and snapshot rows expose:

```json
{
  "network_id": 2,
  "network_code": "breathelondon",
  "network_label": "Breathe London",
  "connector_id": 7,
  "connector_code": "blondon_nodes",
  "connector_label": "Breathe London Nodes"
}
```

Contract rules:

- Network fields are scalar, not membership arrays.
- `network_label` always comes from `networks.display_name`.
- `network_type` is intentionally omitted from station/latest rows.
- Public endpoints filter disabled networks before serialising rows.
- There is no connector-to-network or membership fallback.
- A missing `network_id` or missing network join is a data-validation failure,
  not a reason to display a connector label as a network.
- Connector fields remain in the response for debug/details where useful.
- Remove public `station_network_memberships`, `network_memberships`, and
  `network_name` fields.

### Public filter parameters

Replace public connector filters with:

```text
network_code=breathelondon
```

Use `network_code` in URLs because numeric IDs may differ between environments.
Old `connector`, `connector_id`, or equivalent public parameters must return a
clear `400` response rather than being translated or silently ignored.

The hex map should continue fetching all public rows and filtering locally.
This avoids generating a separate cache key for every possible combination of
selected networks.

## Confirmed implementation approach

Use resolved public views backed by `stations.network_id`.

Create canonical public network/station views based on:

```text
stations.network_id -> networks.id
```

Use `connectors.default_network_id` only when assigning a network to a new
station. Do not use it as a public read-time fallback.

Remove the legacy `uk_aq_networks` and `station_network_memberships` tables
after every active consumer has moved to `networks` and `stations.network_id`.
Do not retain runtime fallbacks, compatibility views, compatibility RPCs, or
dual writes for the legacy tables.

Historical archive files remain read-only. The destructive migration and this
plan may name the legacy tables because they document and execute the removal;
active code must not query, write, export, copy, or expose them after cutover.

This provides one canonical SQL projection, enforces public visibility at the
source, keeps connector provenance separate, and avoids contract drift between
live and snapshot paths.

Database-size impact is negligible because standard views store no result
rows. Endpoint response egress is expected to decrease because repeated
membership arrays are replaced by scalar network fields.

## Implementation phases

### Phase 0 — Data preflight

Before changing the contract, run read-only checks for:

- every active station having a non-null valid `network_id`;
- every connector having the intended `default_network_id`;
- Breathe London Communities and Nodes connectors both mapping to
  `breathelondon`;
- all Breathe London stations resolving to `breathelondon`;
- OpenAQ stations resolving to `openaq`, while OpenAQ remains non-public;
- no public station resolving to a network with
  `public_display_enabled = false`;
- differences between `stations.network_id` and legacy membership rows;
- stations whose network differs from their connector default.
- every active dependency on `uk_aq_networks` and
  `station_network_memberships`, including schema objects, scripts, workers,
  copy/backup tooling, tests, and current system documentation.

Legacy membership differences should be reported. Any source information still
needed to establish the canonical `stations.network_id` must be migrated before
the legacy tables are dropped; it must not become a public fallback.

#### Phase 0 result — 2026-06-29

Phase 0 was run read-only against the TEST ingest database.

Database findings:

- PostgreSQL version: 17.6.
- `uk_aq_core.networks`, `connectors`, and `stations` exist.
- Legacy `uk_aq_core.uk_aq_networks` is already absent from TEST.
- Legacy `uk_aq_core.station_network_memberships` still exists but contains
  zero rows.
- `networks.network_type` does not exist yet.
- The five network rows and all connector defaults match the planned mapping.
- OpenAQ remains `public_display_enabled = false`.
- Stations: 5,140 total; 4,628 active.
- Active stations with null `network_id`: 0.
- Stations with orphaned `network_id`: 0.
- Station/connector-default network mismatches: 0.
- Active stations on public networks: 3,352.
- Active stations on hidden networks: 1,276.
- Breathe London Communities: 662 total / 196 active, all assigned to
  `breathelondon`.
- Breathe London Nodes: 189 total / 144 active, all assigned to
  `breathelondon`.
- OpenAQ: 793 total / 793 active, all assigned to `openaq` and hidden by the
  public flag.
- `stations.network_id` remains nullable.
- `stations_network_id_fkey` exists as `NOT VALID`; the equivalent orphan
  check returned zero, so Phase 1 can validate it before enforcing `NOT NULL`.

Database object dependencies still to replace:

- views: `uk_aq_public.station_network_memberships` and
  `uk_aq_public.uk_aq_station_lat_lon`;
- RPCs: `uk_aq_public.uk_aq_latest_rpc` and
  `uk_aq_public.uk_aq_stations_rpc`;
- RLS policies: two policies on the empty legacy membership table;
- triggers referencing legacy tables: none;
- `pg_cron` commands referencing legacy tables: none.

Repository dependency inventory:

- 121 active non-archive, non-plan references across 38 files;
- Ops repo: 7 files;
- ingest repo: 11 files;
- schema repo: 16 files;
- webpage repo: 4 files.

No active workflow directly invokes the obsolete membership backfill or
membership-report scripts. The scheduled core snapshot does invoke
`uk_aq_core_snapshot_to_r2.mjs`, so that script must be updated before the
legacy membership table is dropped.

Phase 0 result: passed. There is no data migration blocker because the
membership table is empty and every station already has a consistent canonical
network. Phase 1 must still add `network_type`, validate the existing network
foreign key, enforce `network_id NOT NULL`, and replace the identified database
objects before destructive cleanup.

### Phase 1 — Schema foundations

#### Add and seed `network_type`

For the existing TEST database:

1. Add `network_type` temporarily nullable.
2. Populate all known network rows using the agreed mapping.
3. Fail the migration if any row is still null or has an unsupported value.
4. Add the allowed-value check constraint.
5. Set the column `NOT NULL`.
6. Update canonical clean-install DDL and seed files.

Keep OpenAQ `public_display_enabled = false`.

#### Harden station network assignment

Add central write-time handling so a new station with no explicit network uses
the connector's `default_network_id`.

Recommended implementation:

- a `BEFORE INSERT OR UPDATE OF connector_id, network_id` trigger on
  `uk_aq_core.stations`;
- fill `network_id` only when it is null;
- fail if the connector has no default network;
- preserve an explicitly supplied valid `network_id`.

Backfill current null values from connector defaults, validate, and enforce
`stations.network_id NOT NULL` only after all active station writers pass.

#### Create canonical public views

Create a public networks view exposing:

- `network_id`
- `network_code`
- `network_label`
- `network_type`
- `public_display_enabled`
- optional display ordering from `default_priority`

The view filters to `public_display_enabled = true`.

Create or replace the public station projection so it:

- joins `stations.network_id` to `networks.id`;
- joins connector metadata separately;
- exposes scalar network and connector fields;
- excludes disabled networks;
- does not join `station_network_memberships`.

Update `uk_aq_station_lat_lon` or replace it with the resolved projection so it
does not fall back to connector labels.

#### Phase 1 result — 2026-06-29

Phase 1 canonical DDL, focused migration SQL, seed data, public views, and
schema documentation were updated in the schema repo. The focused Phase 1 SQL
was validated in a rollback-only transaction and then applied successfully to
the TEST ingest database.

Applied TEST state:

- `networks.network_type` is required text with a validated allowed-value
  constraint.
- Network types are `official` for AURN/LAQN, `community` for Breathe
  London/Sensor.Community, and `aggregator` for OpenAQ.
- OpenAQ remains `public_display_enabled = false`.
- `connectors.default_network_id` and `stations.network_id` foreign keys are
  validated.
- `stations.network_id` is `NOT NULL`.
- `stations_assign_network_default` is active.
- A rollback-only insert test confirmed omitted station `network_id` uses the
  connector default.
- A rollback-only insert test confirmed an explicit valid station
  `network_id` is preserved.
- `uk_aq_public.networks` returns AURN and Breathe London only and includes
  `network_type`.
- `uk_aq_public.stations` exposes scalar network and connector identity,
  contains 3,864 rows / 3,352 active rows, and contains zero hidden-network
  rows.
- `uk_aq_public.uk_aq_station_lat_lon` now resolves labels from canonical
  networks without membership or connector-label fallback.
- Post-apply integrity checks found zero null station networks, zero orphan
  station networks, and zero station/connector-default mismatches.

The empty legacy membership relation remains in place until Phase 8. Phase 1
did not change RPC signatures, edge functions, snapshots, cache routing, or
website code.

### Phase 2 — Hard-cut public RPCs

Update:

- `uk_aq_latest_rpc`
- `uk_aq_stations_rpc`
- `uk_aq_pcon_hex_rpc`
- `uk_aq_la_hex_rpc`

Required behaviour:

- replace connector filter arguments with `network_code`;
- join the canonical network row;
- apply `public_display_enabled = true` even when no network filter is passed;
- return scalar `network_id`, `network_code`, and `network_label` fields;
- retain scalar connector provenance fields where useful;
- remove membership arrays;
- update grants for the new function signatures;
- reload the PostgREST schema cache after apply.

#### Phase 2 result (2026-06-29)

- Replaced the public connector filter argument with `network_code` on
  `uk_aq_latest_rpc` and `uk_aq_stations_rpc`.
- Added `network_code` filtering to `uk_aq_pcon_hex_rpc` and
  `uk_aq_la_hex_rpc`; their aggregates are now grouped by geography and
  canonical network so each row has one truthful scalar network identity.
- All four RPCs join `stations.network_id -> networks.id` and exclude disabled
  networks before filtering or aggregation.
- Latest and station RPC rows now expose scalar `network_id`, `network_code`,
  and `network_label`; connector ID/code/label remain separate provenance.
- Removed membership arrays and all `station_network_memberships` reads from
  these four RPCs.
- Replaced the deployed signatures and grants atomically on TEST and notified
  PostgREST to reload its schema cache.
- TEST verification returned only `gov_uk_aurn` and `breathelondon`. Explicit
  `openaq` latest/station requests returned zero rows while OpenAQ remains
  disabled.
- Breathe London latest and station results span both source connectors but
  expose one `breathelondon` public network.
- Supabase response egress may fall slightly because membership JSON arrays
  were removed, although three scalar connector provenance fields and scalar
  network fields remain. The geography endpoints may return more rows when a
  geography contains multiple public networks because aggregates are now
  network-specific. Measure the net endpoint response effect after Phase 3
  deploys the edge contract.
- Database-size impact is negligible: this phase replaces function
  definitions and does not add tables, indexes, or persisted row data.
- The currently deployed Phase 2 edge functions still send the old latest and
  station RPC arguments. Those endpoints are intentionally incompatible until
  Phase 3 is deployed; no connector compatibility signature was retained.

### Phase 3 — Supabase edge functions

Update:

- `uk_aq_latest`
- `uk_aq_stations`
- `uk_aq_stations_chart`
- `uk_aq_la_hex`
- `uk_aq_pcon_hex`

Add:

- `uk_aq_public_networks`

The new network function reads the canonical public networks view. Its name
deliberately avoids reusing the legacy `uk_aq_networks` table name. All
modified functions reject connector-based public filters and emit the v2
scalar contract.

Add `uk_aq_public_networks` to the Supabase edge deployment workflow.

#### Phase 3 result (2026-06-29)

- Updated `uk_aq_latest`, `uk_aq_stations`, `uk_aq_stations_chart`,
  `uk_aq_la_hex`, and `uk_aq_pcon_hex` to accept `network_code` and emit
  `contract_version: 2`.
- Added shared hard-cut validation that returns `400` for `connector`,
  `connector_id`, or `connector_code` rather than translating or ignoring
  those parameters.
- Latest and station-chart rows now expose scalar network identity and separate
  connector provenance without membership arrays or `network_name`.
- Station geometry responses now use a versioned `{count, data}` envelope and
  scalar network/connector fields.
- LA and PCON responses now preserve the RPC's per-network aggregates and
  accept the same `network_code` filter.
- Added `uk_aq_public_networks`, backed only by
  `uk_aq_public.networks`. It returns the two enabled TEST networks and includes
  `network_type`.
- Added the new function to `supabase/config.toml` and the Supabase edge deploy
  workflow.
- Deployed all six functions to TEST and verified live `200` responses for the
  v2 contracts and live `400` responses for legacy connector filters.
- Live TEST verification returned only `gov_uk_aurn` and `breathelondon` in the
  catalog. Filtered latest, stations, chart, LA, and PCON responses returned
  only `breathelondon`.
- Supabase endpoint response egress should be modestly lower for latest and
  chart rows because membership arrays and `network_name` were removed.
  Versioned envelopes and scalar provenance add a small fixed cost. Geography
  response size may increase where one geography contains multiple enabled
  networks. Confirm the net effect from endpoint egress metrics after normal
  traffic reaches the deployed functions.
- Database-size impact is negligible. Edge code and response-shape changes add
  no database tables, indexes, or persisted rows; existing endpoint telemetry
  continues unchanged.

### Phase 4 — R2 core metadata snapshot

Add `networks` to the deterministic daily core snapshot table set.

Remove `uk_aq_networks` and `station_network_memberships` from the core snapshot
table set, manifest expectations, copy tooling, and integrity checks. The
latest-snapshot builder must stop reading them.

This does not alter the mandatory Phase B observations backup. The canonical
`networks` and `stations.network_id` fields replace the legacy core metadata in
new snapshots. Existing immutable R2/archive objects are not rewritten.

#### Phase 4 result (2026-06-29)

- Updated the R2 core snapshot exporter default table set to export
  `uk_aq_core.networks` and to omit the legacy `uk_aq_networks` and
  `station_network_memberships` tables from new manifests.
- Updated TEST-to-LIVE core copy tooling table order and identity sequence
  handling to copy `uk_aq_core.networks` instead of `uk_aq_core.uk_aq_networks`
  and to stop copying `station_network_memberships`.
- Updated the latest-snapshot Cloud Run metadata refresh to require/read the
  `networks` core snapshot table into its metadata cache and to stop reading
  `station_network_memberships` from active core snapshots. For Phase 4
  compatibility, the existing latest row `station_network_memberships` array is
  still emitted, but it is derived from `stations.network_id -> networks.id`
  rather than the retired membership table.
- Updated R2 core snapshot and history-integrity docs/tests to reflect the
  canonical `networks` table set.
- No deployment was performed. Existing immutable R2 objects were not rewritten.

### Phase 5 — Latest-snapshot v2

Update the metadata cache to index:

- networks by ID;
- stations including `network_id`;
- connectors separately.

Build each latest row by joining the station's network ID to the networks
index. Skip disabled networks before writing snapshot payloads. Treat missing
network metadata as a build warning/error rather than a connector fallback.

Remove membership parsing and membership arrays from the latest snapshot
contract.

Use snapshot contract version 2 and a new deterministic R2 prefix such as:

```text
latest_snapshots/v2
```

The existing latest-observation state can remain in its current state prefix.
The core metadata cache must use a new schema version/key so it cannot reuse
the old membership-based cache.

The v2 R2 API must never fall back to v1 snapshot objects when a requested v2
object is missing. A missing v2 object must return a clear error that the cache
proxy/frontend can handle, or trigger a controlled fallback to the live
Supabase endpoint. It must never produce a response assembled from mixed v1
and v2 contract objects.

#### Phase 5 implementation result — 2026-06-29

- Latest-snapshot builder now supports `UK_AQ_LATEST_SNAPSHOT_CONTRACT_VERSION`.
- The default builder contract and deploy workflow defaults are v2, writing to
  `latest_snapshots/v2`; the latest-observation state remains in
  `latest_snapshots_state/v1`.
- v2 rows derive network identity from `station.network_id -> networks.id` and
  emit scalar `network_id`, `network_code`, and `network_label` fields.
- v2 rows omit `station_network_memberships`, `network_memberships`,
  `network_name`, and `network_type`; connector provenance fields remain
  available.
- v1 compatibility remains available by setting the contract version/prefix to
  v1, and existing v1 R2 objects are not rewritten or deleted.
- Missing station/network metadata is counted/reported and skipped; disabled
  networks are skipped before writing payload rows.
- No website code, ingest code, database drops, station matching/merging,
  deployment, or immutable R2 object rewrites were performed in this phase.

### Phase 6 — Cache proxy

Add:

```text
/api/aq/networks -> uk_aq_public_networks
```

Use the metadata cache profile. Keep normal network and snapshot URLs stable.

At cutover, purge affected Cloudflare cache entries or rotate the snapshot
prefix/contract version. Do not add routine cache-buster parameters to website
traffic.

#### Phase 6 implementation result — 2026-06-29

- Added the cache-proxy route mapping `/api/aq/networks` to the
  `uk_aq_public_networks` Supabase edge function.
- The route uses the existing metadata cache profile and leaves normal network
  and latest-snapshot URLs stable. No routine cache-buster parameters were
  added to website traffic.
- Disabled-network exclusion remains enforced by the `uk_aq_public_networks`
  upstream, which reads the canonical `uk_aq_public.networks` source and returns
  only `public_display_enabled=true` rows in the v2 public catalog contract.
- Added cache-proxy route tests covering the `/api/aq/networks` mapping,
  metadata cache profile, stable latest-snapshot route, absence of routine
  cache-buster parameters, and unchanged legacy route mappings.
- Manual post-deploy verification check. Test from the browser console::

  ```bash
  fetch("/api/aq/networks", { credentials: "include" })
    .then(r => r.json())
    .then(console.log)
  ```

  Expected result: 

  contract_version: 2
  count: 2
  data includes GOV.UK AURN and Breathe London
  OpenAQ absent while disabled
  
- No website code, ingest code, deployments, database drops, station
  matching/merging, immutable R2 object rewrites, or archive files were created
  or changed in this phase.

### Phase 7 — Website hard cut

#### Update `hex_map.html`

Apply the same hard cut to both duplicated map controllers.

Remove:

- `CONNECTOR_DEFS`;
- public `getConnectorLabelByCode` logic;
- `resolveNetworkMemberships`;
- membership-array collection;
- connector fallback in `collectNetworkEntries`;
- connector/string-based network canonicalisation;
- hardcoded `NETWORK_FILTER_BASE_DEFS` as the source of available networks;
- remapping from `gov_uk_aurn` to `aurn`;
- remapping from `breathelondon` to `breathe_london`.

Replace with:

- catalog data from `/api/aq/networks`;
- `resolveNetworkId(row)`;
- `resolveNetworkCode(row)`;
- `resolveNetworkLabel(row)`;
- exact matching on `network_code`.

Rename:

- `getActiveNetworkIds` -> `getActiveNetworkCodes`;
- `networkIds` -> `networkCodes`;
- `selectedCodes` -> `selectedNetworkCodes`;
- connector-named summary DOM IDs/variables when they display a public network;
- generated `network_name` fields -> `network_label`.

Keep:

- connector IDs in chart/debug metadata;
- connector-based observation/AQI cache keys where connector provenance is
  part of uniqueness;
- connector details in debug/details UI;
- the OpenAQ `AGGREGATOR` badge rule keyed by
  the catalog's `network_type = 'aggregator'` when OpenAQ is eventually
  public.

Because OpenAQ remains non-public, it should not currently appear as a pill.

#### Update related website pages

`sensors_map.html`:

- remove `connector_probe_max`;
- remove numeric connector-ID station sharding;
- obtain public network codes from `/api/aq/networks`;
- shard station geometry by `network_code` only if response limits still
  require sharding;
- remove membership and connector-label display fallbacks.

`sensors_chart.html`:

- consume `network_label` directly;
- remove `network_name`, membership, and connector-label fallbacks;
- retain connector fields only for debug/details.

`hex_map.html` currently has no persisted connector filter in localStorage or
its own URL state. Its shared `window.mapNetworkState` is in-memory only.
Rename its internal selected-code fields without adding a legacy migration.

Do not introduce a connector alias for any new network URL state.

#### Phase 7 implementation result — 2026-06-29

- Updated the active website pages `hex_map.html`, `sensors_map.html`, and
  `sensors_chart.html` to use the v2 public network catalog from
  `/api/aq/networks` as the public network source of truth.
- `hex_map.html` now builds network filters from catalog rows and resolves
  public identity using scalar `network_id`, `network_code`, and
  `network_label`. It filters by exact database `network_code` values and no
  longer remaps `gov_uk_aurn` to `aurn` or `breathelondon` to
  `breathe_london`.
- Removed connector-derived public network discovery from the website path,
  including membership-array collection, connector-label fallbacks for public
  network display, hardcoded base network definitions as the source of
  available networks, and old connector/string canonicalisation.
- Both duplicated hex-map controllers were updated. The shared in-memory
  network selection now uses selected network codes rather than connector or
  membership-derived identifiers. No legacy URL-state or localStorage migration
  was added because the map did not persist connector filters.
- Network panel counts are seeded from the catalog so enabled public networks
  can appear even when they currently have zero rows in the selected
  pollutant/window. Counts remain “active sensors in the current window”.
- The OpenAQ `AGGREGATOR` badge rule is retained, but it is now keyed from the
  catalog `network_type = 'aggregator'`. Because OpenAQ remains non-public, it
  does not appear unless the catalog returns it.
- `sensors_map.html` now obtains public network codes from `/api/aq/networks`
  and uses `network_code` station-geometry sharding only if the unfiltered
  response reaches the response limit. Numeric connector-ID sharding and
  `connector_probe_max` were removed from the public path.
- `sensors_chart.html` now renders public network names from scalar
  `network_label`, with exact `network_code` catalog lookup only as a label
  fallback. Membership arrays, `network_name`, and connector-label fallbacks
  were removed from public network display.
- Connector fields remain available only where they are still useful for
  provenance, debugging, chart/details metadata, and cache uniqueness. They are
  no longer used to construct public network identity.
- Added Phase 7 static regression tests covering catalog use, exact
  `network_code` filtering, absence of connector/membership public fallbacks,
  catalog-backed labels, aggregator badge behaviour, no routine network
  catalog cache busters, and user-facing network paths avoiding connector-label
  fallbacks.
- PR #15 was merged into the website repo. The change was limited to website
  source and tests: `hex_map.html`, `sensors_map.html`, `sensors_chart.html`,
  `tests/test_phase7_network_hard_cut.py`, and a small station-chart test
  update. No ops, ingest, schema, edge-function, database, archive, station
  matching/merging, or immutable R2 object changes were made in this phase.
- Local validation reported `pytest -q` passing, inline script syntax checks
  passing, and `git diff --check` passing.
- Post-deploy observation: the website hard cut depends on v2 latest-snapshot
  rows carrying scalar `network_code` and `network_label`. If a public network
  flag is changed after snapshot metadata is cached, the R2 core snapshot and
  latest-snapshot metadata cache must be refreshed before the new network's
  latest rows appear in `/api/aq/latest-snapshot`. This is a snapshot metadata
  refresh concern, not a Phase 7 website fallback issue.

### Phase 8 — Remove legacy tables and active dependencies

**Implementation status: source implementation complete (30 June 2026).**

Phase 8 was implemented across the schema, ingest, ops, and webpage
repositories:

- Canonical schema DDL, public views, security allowlists, DBML models, seeds,
  and current table documentation no longer define or expose the two retired
  relations.
- The focused ordered migration
  `schemas/migrations/v0.2.0/ingestdb/011_remove_legacy_network_relations.sql`
  removes the public dependent view and relation privileges/policies, drops
  `station_network_memberships` before `uk_aq_networks`, and validates both
  results with `to_regclass(...)`.
- UK-AIR SOS station listing no longer writes membership rows. The obsolete
  membership backfill and report scripts were removed and replaced with
  `scripts/sos/sos_network_assignment_report.py`, which validates
  `stations.network_id -> networks.id`.
- The Dropbox station export and network summary use the canonical relationship.
  Each exported station now carries scalar `network_id`, `network_code`, and
  `network_label` alongside unchanged connector provenance.
- Ops core snapshot, latest-snapshot, cache-proxy, and contract tests use the
  canonical `networks` metadata. The latest-snapshot builder emits only the v2
  scalar network contract and has no membership compatibility branch.
- The active webpage paths remained on the Phase 7 scalar network contract; no
  connector or membership fallback was reintroduced.
- Python compilation, targeted Pytest checks, Node tests, Deno tests, and
  `git diff --check` passed during implementation. The final active-reference
  scan found only the destructive migration, migration/removal documentation,
  implementation plans, immutable archives, and negative absence assertions.

The source implementation is complete, but the destructive migration has not
been applied to a database and no deployment was performed as part of Phase 8.
Database application and TEST cutover remain Phase 10 activities.

After the replacement schema, APIs, workers, and scripts pass their contract
tests:

1. Remove all writes to `station_network_memberships` from UK-AIR SOS station
   listing and backfill code.
2. Replace membership reports with canonical `stations.network_id`/`networks`
   validation where the report remains useful.
3. Delete scripts whose only purpose is populating or repairing
   `station_network_memberships`.
4. Remove both legacy tables from core snapshot, copy-to-live, integrity,
   restore, and dependency tooling.
5. Remove their public views, grants, RLS/security allowlists, seeds, fixtures,
   and table documentation.
6. Drop `station_network_memberships` first because it references the legacy
   network table.
7. Drop `uk_aq_networks` after dependent foreign keys, views, functions, and
   scripts have been removed.
8. Run database dependency checks and a non-archive repository-wide search.

Do not create compatibility views with either legacy name. Do not retain a
dual-write period. The destructive SQL belongs in the canonical schema repo
and in a focused, ordered hard-cut apply file.

The final source scan may retain the names only in:

- the reviewed destructive migration that drops them;
- this implementation plan and current removal documentation;
- immutable archive files.

No active SQL, API, worker, script, configuration, test fixture, or system
documentation may depend on them after cutover.

### Phase 9 — Documentation and automated tests

**Implementation status: complete (30 June 2026).**

Phase 9 made documentation and test-only changes:

- Schema documentation now defines the v2 public network catalogue, allowed
  `network_type` values, enabled-network filtering, scalar station identity,
  OpenAQ visibility, and the shared `breathelondon` network.
- Ingest API/edge-function and UK-AIR SOS documentation now describes
  `/api/aq/networks`, `contract_version: 2`, connector-filter `400` responses,
  and canonical SOS assignment validation using the assignment report.
- Ops documentation now records `latest_snapshots/v2`, the retained
  latest-observation state prefix, deterministic core metadata containing
  `networks`, metadata-cache resolution through
  `stations.network_id -> networks.id`, stable cache URLs, and fail-closed v1
  handling.
- Website data-format documentation now records exact `network_code` filtering,
  `network_label` display, catalogue-only aggregator badges, hidden OpenAQ
  behaviour, no connector-label fallback or code remapping, and fixed
  one-minute polling.
- Static and contract tests were added or updated across all four repositories,
  including a cross-repository active-reference regression test.

Validation results:

- schema Pytest: 3 passed;
- ingest Pytest: 5 passed;
- ingest Deno public-filter tests: 5 passed;
- ops Node contract tests: 14 passed;
- ops Deno latest-snapshot tests: 4 passed;
- webpage Pytest: 15 passed;
- `git diff --check`: passed in every changed repository.

No runtime behaviour, database schema, deployment, or database contents were
changed in Phase 9. Remaining retired-name references are limited to the
reviewed destructive migration, current migration/removal and explicit
contract documentation, plans/archives, and negative test assertions.

Update the API, snapshot, cache, core snapshot, SOS membership, and website data
format documentation listed below.

Add contract tests covering:

- allowed `network_type` values;
- public network catalog filtering;
- scalar station/latest network fields without `network_type`;
- `network_type` on the network catalog only;
- OpenAQ remaining excluded;
- both Breathe connectors resolving to one network;
- hidden networks never appearing in public endpoints;
- connector filters returning `400`;
- absence of membership arrays;
- preservation of connector provenance fields;
- deterministic latest snapshot output.
- a missing v2 snapshot object never reading or returning a v1 object;
- a missing v2 object producing either the defined clear error or a controlled
  live Supabase response with the v2 contract;
- absence of both legacy relations from the database;
- absence of active non-archive code references to both legacy table names.

## Likely files to change

### Schema repo

- `schemas/v0.2.0/001_core_schema.sql`
- `schemas/v0.2.0/004_public_views.sql`
- `schemas/v0.2.0/005_rpc.sql`
- `schemas/v0.2.0/006_seed_core.sql`
- `schemas/ingest_db/uk_aq_core_schema.sql`
- `schemas/ingest_db/uk_aq_public_views.sql`
- `schemas/ingest_db/uk_aq_rpc.sql`
- `schemas/ingest_db/uk_aq_security.sql`
- new focused apply SQL under `schemas/ingest_db/`
- new migration/validation SQL under
  `schemas/migrations/v0.2.0/ingestdb/`
- remove the legacy `uk_aq_networks` seed file
- remove legacy table-info documents after replacing relevant network docs

Obs AQI schema files only need changes if the mirrored `networks` table is
intended to carry the same `network_type` contract. The public website read
path itself uses ingest DB/R2 metadata, so Obs AQI changes are not required
merely to serve the website.

### Ingest repo

- `supabase/functions/uk_aq_latest/index.ts`
- `supabase/functions/uk_aq_stations/index.ts`
- `supabase/functions/uk_aq_stations_chart/index.ts`
- `supabase/functions/uk_aq_la_hex/index.ts`
- `supabase/functions/uk_aq_pcon_hex/index.ts`
- new `supabase/functions/uk_aq_public_networks/index.ts`
- `.github/workflows/supabase_edge_deploy.yml`
- `scripts/sos/sos_list_stations.py`
- remove or replace `scripts/sos/sos_membership_report.py`
- remove `scripts/uk_aq_backfill_station_memberships.py`
- `scripts/uk_aq_export_stations_dropbox.py`
- `system_docs/uk_aq_edge_functions.md`
- `system_docs/sos_network_memberships.md`
- other current system docs that describe either legacy table

The Breathe London Nodes and UK-AIR SOS Cloud Run deployment workflows do not
need public-filter changes unless station-network preflight finds a writer that
does not produce a valid `network_id`.

### Ops repo

- `scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs`
- `scripts/uk_aq_copy_core_to_live.py`
- `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py`
- `workers/uk_aq_latest_snapshot_cloud_run/run_job.ts`
- latest-snapshot builder tests
- `workers/uk_aq_latest_snapshot_r2_api_worker/worker.mjs`
- `workers/uk_aq_latest_snapshot_r2_api_worker/wrangler.toml`
- `workers/uk_aq_cache_proxy/src/index.ts`
- `.github/workflows/uk_aq_latest_snapshot_cloud_run_deploy.yml`
- `env-vars-master.csv` if snapshot prefix defaults change
- `system_docs/uk-aq-latest-snapshot.md`
- `system_docs/uk-aq-r2-core-snapshot.md`
- `system_docs/uk-aq-cache-proxy.md`

### Webpage repo

- `hex_map.html`
- `sensors_map.html`
- `sensors_chart.html`
- `system_docs/hex-map-data-formats.md`
- `system_docs/uk-aq-hex-map-ui.md`

`orig_sensors_chart.html` should only change if it is still deployed as a
public page. Otherwise it remains reference material.

## Phase 10 — TEST deployment and cutover

1. Run database preflight checks.
2. Apply the additive `network_type`, seed values, station-network hardening,
   public views, and replacement RPCs to TEST. Do not drop legacy tables yet.
3. Reload the PostgREST schema cache.
4. Run a fresh R2 core snapshot containing `networks`.
5. Deploy the v2 latest-snapshot builder and generate all pollutant/window
   objects.
6. Validate the R2 payload and manifest before switching the public worker.
7. Deploy the latest-snapshot R2 API worker.
8. Deploy `uk_aq_public_networks` and the modified Supabase edge functions.
9. Deploy the cache proxy route.
10. Purge affected Cloudflare cache entries.
11. Validate all API contracts and updated operational scripts.
12. Apply the destructive legacy-table removal SQL.
13. Verify both legacy relations are absent and no active database dependency
    remains.
14. Run the non-archive repository-wide legacy-name scan.
15. Deploy the webpage last.
16. Monitor endpoint errors, cache status, response egress, and map behaviour.

## Risks and required verification

- Existing station writers may not all provide `network_id`; central
  write-time defaulting must be proven before enforcing `NOT NULL`.
- Existing TEST rows may have null or inconsistent network assignments.
- Current frontend canonical codes differ from database codes, so old in-memory
  selections must not be carried across the cut.
- The old latest-snapshot metadata cache can retain membership-derived labels
  until explicitly versioned or invalidated.
- Cloudflare can continue serving the old contract after deployment unless
  affected cache entries are purged.
- Both Breathe London station sets remain independent and may both contribute
  readings/counts. This is expected because matching and merging are out of
  scope.
- OpenAQ must remain absent from the public catalog while its flag is false,
  even though its type is `aggregator`.
- PCON and LA summary endpoints must filter public networks at source to avoid
  briefly or independently exposing hidden-network aggregates.
- Standard views add negligible database size, but enforcing a new station
  constraint can require a table scan and should be scheduled after preflight.
- Dropping the membership table is destructive. Any source membership
  information still needed to assign canonical station networks must be
  migrated and validated first.
- Old scripts or scheduled workflows will fail immediately after the drop if
  the dependency inventory misses them; the repo scan and scheduler audit are
  cutover gates.

## Egress impact

Expected Supabase endpoint response egress should decrease slightly:

- repeated membership arrays are removed from live latest/station responses;
- flat network fields are smaller and consistent;
- disabled networks are filtered before response serialisation;
- `/api/aq/networks` is a small response cached under a stable URL.

The normal map still polls once per minute. This plan does not reduce polling
frequency.

The R2 latest snapshot payload should also become smaller. R2 cost impact is
primarily operation count and Worker requests, not bandwidth egress. A v2
snapshot cut creates a small one-time set of new R2 writes. Stable request URLs
and warm `CF-Cache-Status` hits remain required.

Write/upload payload metrics such as
`uk_aq_observation_rpc_metrics_minute.payload_bytes` are ingress and must not be
used to claim a Supabase egress improvement. Validate the result using
`uk_aq_endpoint_egress_metrics_minute` or Supabase billing/usage counters.

## Database-size impact

- `network_type` adds only a few bytes per network row.
- Standard views and function replacements do not persist result sets.
- Existing network and station indexes support the join.
- No observation/history table shape changes are required.
- Dropping the two legacy tables produces a small database-size reduction.
- No raw history is aggregated, downsampled, or removed.

Overall database-size impact remains negligible.

## Minimal verification checklist

- [ ] Every `networks` row has one allowed `network_type`.
- [ ] Public network catalog returns only AURN and Breathe London on current
      TEST flags.
- [ ] OpenAQ remains absent and has stored type `aggregator`.
- [ ] Breathe London Communities and Nodes rows both return
      `network_code = breathelondon`.
- [ ] `network_label` is always taken from `networks.display_name`.
- [ ] Latest, stations, station chart, PCON, and LA responses exclude disabled
      networks.
- [ ] Public station/latest rows contain scalar `network_id`, `network_code`,
      and `network_label` fields and do not contain `network_type`.
- [ ] The public network catalog contains `network_type`.
- [ ] Public rows no longer contain membership arrays or `network_name`.
- [ ] `to_regclass('uk_aq_core.station_network_memberships')` returns null.
- [ ] `to_regclass('uk_aq_core.uk_aq_networks')` returns null.
- [ ] No active non-archive API, worker, script, configuration, test fixture,
      or system documentation depends on either legacy table.
- [ ] Connector provenance fields remain available where required.
- [ ] Connector-based public filter parameters return `400`.
- [ ] Both hex-map controllers filter using exact database network codes.
- [ ] No station matching or merging occurs.
- [ ] Website polling remains one minute.
- [ ] Stable network/snapshot URLs show warm Cloudflare cache hits.
- [ ] v2 latest snapshots are deterministic for unchanged source data.
- [ ] A missing v2 snapshot object never falls back to a v1 R2 object.
- [ ] Missing-v2 handling returns the documented error or a controlled live
      Supabase response without mixing contracts.
- [ ] Endpoint response egress is measured before and after.
- [ ] Database size remains unchanged within normal measurement noise.

## Plan approval

All design decisions needed for implementation are confirmed:

- resolved public views backed by `stations.network_id`;
- LAQN is `official`;
- Breathe London and Sensor.Community are `community`;
- OpenAQ is `aggregator` and remains non-public on TEST;
- `network_type` is text with a check constraint;
- `network_type` is returned by the network catalog only;
- station/latest rows expose scalar network identity without `network_type`;
- latest snapshot output moves to `latest_snapshots/v2`;
- existing latest-observation state is retained.
- the legacy `uk_aq_networks` and `station_network_memberships` relations and
  all active dependencies are removed without compatibility aliases.

The plan is ready for phased implementation. Implementation must still begin
with Phase 0 preflight and stop if station/network integrity checks fail.
