# WAQN, SAQN and Northern Ireland connector contract

Status: authoritative  
Area: ingest  
Scope: canonical network/connector identity, current-observation acquisition, source selection, UK-local timestamp interpretation, shared implementation boundaries and historical-source ownership for WAQN, SAQN and Northern Ireland Air

## Purpose

This contract defines the UK AQ ingest model for:

- the Welsh Air Quality Network, WAQN;
- the Scottish Air Quality Network, SAQN;
- Northern Ireland Air, NI.

These are separate official UK AQ networks and MUST have separate UK AQ connector identities even where their upstream systems use similar Ricardo, 52°North SOS, OpenAir or website technologies.

Shared implementation code does not imply shared connector identity.

This contract supplements:

- `contract.md`;
- `network_ingest_enablement_contract.md`;
- `network_catalogue_mirror_contract.md`;
- `observation_acquisition_method_contract.md`;
- `compact_observation_transport_contract.md`;
- `gcp_cloud_run_database_runtime_contract.md`.

Where this contract defines source-specific behaviour for WAQN, SAQN or NI, it is authoritative for those connectors.

The NI site adapter and the Europe/London graph/site timestamp interpretation described below are required behaviour. WAQN graph alignment has been confirmed through deployed TEST operation against overlapping AURN observations; the remaining NI/SAQN checks stay part of normal post-deployment validation.

## Stable canonical identities

The following numeric identities are reserved and MUST be treated as stable canonical identities.

| Network | Network ID | Connector code | Connector ID |
| --- | ---: | --- | ---: |
| WAQN | 7 | `waqn` | 9 |
| SAQN | 8 | `saqn` | 10 |
| Northern Ireland Air | 9 | `ni` | 11 |

These IDs are intentional canonical identities, not merely values assigned because they happen to be the next available numbers.

Canonical schema/reference-data changes MUST preserve these exact IDs.

Existing-database migrations and clean-schema bootstrap/reference data MUST converge on the same identities.

Where explicit numeric IDs are inserted, the relevant identity sequence MUST remain valid afterwards so subsequent inserts cannot collide with these reserved IDs.

The ObsAQIDB network catalogue mirror MUST preserve network IDs 7, 8 and 9 exactly, in accordance with `network_catalogue_mirror_contract.md`.

## One network per connector

WAQN, SAQN and NI MUST use separate connectors.

The relationship is:

```text
connector 9  waqn -> network 7  WAQN
connector 10 saqn -> network 8  SAQN
connector 11 ni   -> network 9  Northern Ireland Air
```

The three networks MUST NOT be represented as one multi-network connector merely because their upstream services share software or data formats.

The separate connector identities preserve independent:

- source health;
- SOS availability;
- fallback state;
- scheduling state;
- polling state;
- checkpoints;
- run status;
- diagnostics;
- source configuration;
- future source changes.

For example, recovery of the WAQN SOS service MUST NOT imply that SAQN or NI have also recovered.

## Shared implementation is encouraged

Separate connector identity MUST NOT require duplicate implementation.

WAQN and SAQN SHOULD share common implementation modules where source behaviour is identical, including as appropriate:

- 52°North SOS request and response handling;
- website retrieval;
- embedded `graphData` extraction;
- Highcharts-series parsing;
- Unix epoch timestamp handling;
- pollutant mapping;
- observation normalisation;
- fallback-state handling;
- common HTTP/retry behaviour.

NI MAY reuse the same shared modules where its source behaviour is proven compatible, but MUST retain connector 11 and its own source adapter/configuration.

Source-specific adapters SHOULD contain only the differences required by the respective upstream service.

## Current-source architecture

Current observation acquisition is source-specific.

The required current routing is:

```text
WAQN connector
    current route -> WAQN site embedded graph data
    retained capability -> WAQN SOS, only if separately healthy/enabled

SAQN connector
    current route -> SAQN site embedded graph data
    retained capability -> SAQN SOS, only if separately healthy/enabled

NI connector
    current route -> NI site graph JSON plus hourly-only latest-data HTML supplement
    current route MUST bypass the broken Series REST/SOS acquisition branch
```

WAQN and SAQN retain SOS as an authorised capability because their dedicated services may become usable again. The current known SOS outage MUST NOT be encoded as a permanent architectural prohibition.

NI is different. Its current live adapter is explicitly the public site-data route defined below. Existing connector configuration such as `sos_probe_enabled=true` MUST NOT force NI through the generic Series REST/SOS branch. Re-enabling an NI SOS current-observation route requires separate source validation and an intentional contract change.

A site-data route is an acquisition mechanism within the same connector. It MUST NOT create a second logical observation identity.

## WAQN source profile

WAQN uses:

```text
host: www.airquality.gov.wales

SOS path:
  /sos-waq/

site path:
  /air-pollution/site/{site_code}
```

At the time this contract was written, the documented WAQN SOS service is unavailable and its published SOS route returns HTTP 404.

That current outage MUST NOT be encoded as a permanent assumption.

The connector design MUST retain SOS as a supported primary acquisition route so the service can be used again if it becomes operational.

### WAQN website fallback

The WAQN site page embeds a structured JavaScript `graphData` object containing measured observation series used by the site's Highcharts graph.

The fallback MUST consume this structured graph data rather than scrape the human-readable Latest Data table.

The graph data includes raw hourly observations such as:

- PM2.5;
- PM10;
- NO2;
- NO;
- NOx as NO2;
- O3;
- SO2;

where supported by the individual station.

The visible Latest Data table MUST NOT be used as the raw observation source for pollutants where it displays derived values such as:

- running 24-hour PM means;
- 8-hour ozone means;
- 15-minute values.

### WAQN graph period

The normal site page currently embeds approximately seven days of graph observations.

This is sufficient for normal current ingestion and short polling gaps.

Absence of a current graph for a station MUST NOT automatically be classified as a connector failure.

A station may legitimately have:

- closed;
- stopped reporting;
- no observations within the current graph window;
- temporarily unavailable measurements.

The connector SHOULD distinguish at least:

```text
no_recent_graph_data
http_error
graphdata_missing
invalid_graphdata
invalid_json
```

`no_recent_graph_data` is not equivalent to a source/parser failure.

## SAQN source profile

SAQN uses:

```text
host: www.scottishairquality.scot

SOS path:
  /sos-scotland/

site path:
  /latest/site-info/{site_code}
```

At the time this contract was written, the documented Scottish SOS route is also unavailable and returns HTTP 404.

As with WAQN, SOS remains the preferred machine-service capability if it becomes operational again.

### SAQN website fallback

SAQN has been verified to expose the same core embedded graph structure as WAQN:

```text
var graphData = {
  graph: {
    json: ...
  }
}
```

Its graph contains Highcharts observation series with:

- Unix epoch millisecond timestamps;
- one-hour point intervals for hourly data;
- explicit pollutant series;
- null entries for missing observations;
- recent provisional measured observations.

The WAQN and SAQN connectors SHOULD therefore use the same shared embedded-graph parser.

Network-specific configuration MUST supply the host, site path and other source-specific values rather than duplicating the parser.

## Northern Ireland source profile

Northern Ireland Air MUST use:

```text
connector_id = 11
connector_code = ni
network_id = 9
```

The current NI observation adapter uses two public site sources for each selected UK AQ station:

```text
site page:
  https://www.airqualityni.co.uk/site/{site_code}

graph endpoint:
  https://www.airqualityni.co.uk/api/site/graph/{site_code}/{days}
```

The graph endpoint is the preferred observation source where it exposes a pollutant because it supplies recent timestamp/value history at source precision.

The graph response is JSON whose outer value is a list. Each relevant list member contains a `json` field holding a JSON-encoded Highcharts configuration. Recognised `series` entries contain pollutant names and `data` arrays of `[epoch_ms, value]`.

Supported public graph periods are:

```text
7, 14, 21, 30, 60, 90 days
```

The adapter MUST choose the smallest supported period that covers the requested window. If the requested window is longer than 90 days, it MUST use the available 90-day graph window and emit a clear warning. It MUST NOT claim that the graph supplied the unavailable earlier part of the request.

The server-rendered site page contains a Latest Data table. This table is a supplementary current source for mapped pollutants that are absent from the graph, for example NO or NOx at sites where the public graph exposes only index-relevant species.

The HTML table MUST be filtered by its Period field:

- only a period that normalises exactly to `hourly mean` is eligible as a raw hourly observation;
- `24 Hour mean`, 8-hour means, 15-minute values and any other non-hourly statistic MUST NOT be inserted as hourly raw observations;
- the pollutant label, numeric concentration and last-updated timestamp MUST all be parseable and map to an existing UK AQ timeseries.

Where graph data and an eligible HTML row resolve to the same timeseries and observation timestamp, the graph value MUST win. This preserves graph precision and prevents rounded display values from replacing the underlying graph value.

The two NI site sources are failure-isolated. A graph failure MUST NOT discard usable hourly HTML observations. An HTML failure MUST NOT discard usable graph observations.

A successfully fetched and parsed source that yields no eligible mapped observations in the requested window is a normal no-data condition, not a source failure. This includes an empty graph response, graph series with no eligible in-window points, Latest Data rows whose concentration is `No data`, and rows that are valid but use excluded non-hourly periods such as 24-hour, 8-hour or 15-minute means.

A station for which both NI site sources are reachable/parseable but neither yields a usable mapped in-window observation MUST NOT increment `stations_failed` and MUST NOT make the connector run `partial`. It SHOULD be counted separately as a no-current-data/no-usable-observation condition for diagnostics.

`source_failures` and `stations_failed` are reserved for genuine acquisition or parsing failures where the connector could not reliably determine source state. A run with a genuine one-source failure but retained observations from the other source SHOULD report partial status and preserve diagnostic warnings.

NI MUST use its own parser/adapter where its response structure differs from WAQN/SAQN. It MAY reuse shared pollutant mapping, observation normalisation, timestamp helpers, HTTP/retry behaviour and connector infrastructure.

The newer NI Series REST route under `/sos-ni/api/v1` is not an authorised current-observation source while its timeseries catalogue fails server-side. The OGC SOS 2.0 service is also not an authorised current route until a current-observation request path is separately proven and contracted.

## Current route selection and source health

WAQN and SAQN may retain generic SOS/site-graph source selection logic, but their current normal route is the verified site graph while the dedicated SOS services are unavailable.

NI MUST be dispatched to its dedicated site adapter before the generic SOS/configuration decision path. In particular, stale database configuration containing `sos_probe_enabled=true` MUST NOT cause connector 11 to call the unusable NI Series REST/SOS route.

Source-health state is connector-specific. WAQN, SAQN and NI MUST remain independent.

Within the NI site adapter, graph and HTML are complementary parts of one current acquisition route rather than competing logical observation identities. Their failures MUST be tracked independently so that useful data from one route can be retained when the other route fails.

A future decision to restore any SOS service to normal polling MUST be based on targeted source validation and MUST preserve the same canonical connector/timeseries/observation identities.

## Acquisition-method provenance

WAQN, SAQN and NI MUST opt into the IngestDB acquisition-method provenance interface.

The acquisition method describes the mechanism, not the network.

The authorised methods for the official-network connectors are:

```text
sos
site_graph_html
```

Current site-derived observations for WAQN, SAQN and NI MUST use:

```text
site_graph_html
```

For NI, the combined graph plus hourly-only HTML supplement is one site acquisition route and therefore uses `site_graph_html` for both components.

WAQN or SAQN MAY use `sos` if their SOS route is intentionally re-enabled and healthy. NI MUST NOT emit `sos` for its current adapter unless an NI SOS current-observation route is separately validated, contracted and enabled.

Connector identity already determines the network, so values such as `waqn_html`, `saqn_html` or `ni_html` SHOULD NOT be introduced.

The existing `ukair_html` method remains specific to the UK-AIR SOS connector and is not renamed by this contract.

The existing material-update provenance rule remains authoritative:

```text
site graph/HTML inserts value 10.5
    acquisition_method = site_graph_html

another route later repeats the same material value/status
    row remains unchanged

an authorised route later materially revises the observation
    value/status are updated
    acquisition_method becomes the route that supplied that accepted version
```

Acquisition method MUST NOT participate in observation identity.

## Primary IngestDB observation transport

WAQN, SAQN and NI require the compact observation v2 function because acquisition-method provenance is part of their accepted observation-write semantics.

The authorised primary IngestDB observation function remains:

```text
uk_aq_public.uk_aq_rpc_observations_compact_upsert_v2(
    integer[],
    timestamptz[],
    double precision[],
    text,
    text[]
)
```

The connectors MUST NOT be redesigned to use v1 merely to simplify the database transport or reduce Supabase logging.

Under the shared authority in `compact_observation_transport_contract.md` and `gcp_cloud_run_database_runtime_contract.md`, the next transport change for these three GCP Cloud Run services is to invoke this same canonical v2 function through the Supabase Shared Pooler transaction endpoint using the shared `uk_aq_gcp_cloud_run_runtime` identity.

The transport change is limited to the primary recurring compact observation v2 write. It MUST preserve:

- the same `timeseries_ids`, `observed_ats`, `values`, `acquisition_method` and optional `statuses` arguments;
- the same material-update and acquisition-method provenance rules;
- the same observation identity and timestamp/value/status precision;
- the same committed/upserted-row accounting and failure semantics;
- the existing connector/source routing, graph/HTML parsing and scheduler behaviour.

Reference/metadata reads and writes, connector/run bookkeeping, station/timeseries discovery, latest-value mutation, secondary ObsAQIDB/Pub/Sub delivery and other comparatively low-frequency Supabase operations remain on their existing interfaces unless later log-ingestion evidence shows that a specific route has become material and a separate contract authorises moving it.

Direct table DML and arbitrary SQL are not authorised.

Until the pooled v2 implementation is deployed and accepted through real TEST operation, the existing PostgREST v2 path remains the current runtime. After TEST acceptance and LIVE promotion, pooled v2 becomes the required runtime baseline for these recurring primary observation writes.

## Provisional-data semantics

Current website/SOS observations from these networks are provisional measurements.

The connectors MUST NOT infer a verification status such as `P` or `R` merely because the website describes the data as provisional.

Unless an upstream field explicitly provides a verification status under a separately contracted mapping:

```text
status = null
```

Acquisition method and verification status remain separate concepts.

## Timestamp contract

UK AQ databases store observation timestamps in UTC.

The current WAQN, SAQN and NI Ricardo-style graph/site feeds encode the displayed UK wall-clock time rather than supplying a UTC instant that should be persisted unchanged.

For current site ingestion, the authoritative rule is:

1. decode the source timestamp into its calendar/time components without applying the runtime host's local timezone;
2. interpret those components as `Europe/London` local wall-clock time;
3. apply the GMT or BST offset that is valid for that source date;
4. convert the resulting aware datetime to UTC for persisted `observed_at`.

This is a timezone interpretation of the graph/site presentation timestamp. It MUST NOT be implemented as a fixed one-hour subtraction.

The public sites may separately describe some tabular/latest measurements as "GMT hour ending". That wording MUST NOT be assumed to define the timestamp encoding of the Highcharts graph data. The graph/site adapter behaviour is governed by the observed graph semantics and the `Europe/London` rule above.

Deployed TEST comparison of overlapping WAQN and AURN series confirms that applying this rule aligns the plotted observation sequences during BST.

For example, during BST:

```text
source graph wall clock:
  02/10/2026 21:00 Europe/London

stored observed_at:
  2026-10-02T20:00:00Z

UK local display:
  02/10/2026 21:00
```

During GMT, no one-hour offset is applied:

```text
source graph wall clock:
  02/01/2026 21:00 Europe/London

stored observed_at:
  2026-01-02T21:00:00Z
```

The implementation MUST use the IANA `Europe/London` timezone rules. It MUST NOT hard-code BST dates or subtract one hour unconditionally.

### Graph timestamps

WAQN, SAQN and NI Highcharts graph timestamps are numeric epoch-millisecond values whose calendar/time components represent the source graph's UK local wall clock.

The parser MUST therefore treat those components as `Europe/London` before converting to UTC. It MUST NOT treat the numeric value directly as the final UTC observation instant.

This rule applies to graph acquisition only. It does not redefine timestamp semantics of unrelated SOS/AURN feeds.

### NI HTML timestamps

NI Latest Data table timestamps in `DD/MM/YYYY HH:MM` are also interpreted as `Europe/London` local wall-clock times for the NI current site adapter.

If NI supplies `24:00`, the parser MUST first roll that value to 00:00 on the following LOCAL calendar day, then attach `Europe/London`, then convert to UTC.

For example, during BST:

```text
01/10/2026 24:00
    -> local 02/10/2026 00:00 Europe/London
    -> 2026-10-01T23:00:00Z
```

The graph-wins-on-duplicate rule remains authoritative after timestamp normalisation.

The repeated autumn `01:xx` hour is inherently ambiguous if an upstream source supplies only a wall-clock time with no fold indicator. The adapter MUST use the standard deterministic `Europe/London` interpretation unless future source evidence provides an explicit fold/offset signal.

## Pollutant mapping

Source graph-series names MUST map explicitly to canonical UK AQ observed properties.

Examples include:

```text
PM2.5      -> pm25
PM10       -> pm10
NO2        -> no2
NO         -> no
O3         -> o3
SO2        -> so2
NOXasNO2   -> nox_as_no2
```

The connector MUST NOT infer a new canonical pollutant merely because an unfamiliar graph series appears.

Unknown or unsupported series SHOULD be recorded diagnostically and skipped until their mapping and units are explicitly authorised.

Units MUST be established per pollutant/source mapping.

The connector MUST NOT assume that every series in a graph uses an identical canonical unit merely because the graph has one generic y-axis label.

Derived DAQI/index values from the website are not substitutes for measured pollutant observations.

## Invalid and unusual values

These feeds may contain provisional values that appear unusual, including negative particulate concentrations or unexpectedly high gaseous-pollutant readings.

The connector MUST apply the existing UK AQ invalid-value policy.

It MUST NOT introduce source-specific plausibility filtering solely because a provisional value looks surprising.

Any new source-specific invalid-value rule requires a separate evidence-based contract change.

## Station and timeseries identity

Source site code is the stable upstream station reference within each connector.

Source station identity MUST remain connector-scoped.

Therefore:

```text
WAQN/CARD
```

and an AURN/SOS station representation are still separate UK AQ source-station identities with separate connector, network, timeseries and observation provenance.

The agreed future physical-site relationship is defined separately by [`../station_identity/contract.md`](../station_identity/contract.md). That contract authorises multiple connector-scoped source stations to point through `stations.match_id` to one canonical physical monitoring site without merging or deleting the source station rows.

For UK-AIR-backed overlaps, `UK-AIR ID` is the canonical external physical-site identifier. Matching source site codes are useful authoritative evidence when a regional `station_ref` exactly equals the DEFRA `site_ref`, but site-code equality is not itself the physical-site identity and is not sufficient to justify a general cross-connector merge rule.

Different-code aliases such as regional and AURN codes for the same physical location MUST be resolved only through the stricter evidence rules in the station-identity contract. Station name alone MUST NOT establish the relationship.

Until that future contract is implemented and accepted on TEST, current source station identity and current public behaviour remain unchanged.

## OpenAir RData role

OpenAir network-specific RData is the intended supporting source for:

- network station inventory;
- site/network membership;
- coordinates and metadata;
- available pollutant metadata;
- historical measurements;
- later historical reconciliation/backfill.

It is not the preferred near-real-time source because its publication is daily rather than continuously updated.

The source profiles are conceptually:

```text
WAQN -> OpenAir source waqn
SAQN -> OpenAir source saqn
NI   -> OpenAir source ni
```

OpenAir and the live website/SOS routes are different acquisition/distribution paths and MUST NOT be described as the same feed.

## Historical timestamp reconciliation

A targeted source-semantics check is required before OpenAir RData is used to overwrite or reconcile live-ingested observations.

This check is required because the OpenAir representation and website presentation may differ in hour-beginning/hour-ending convention.

The check MUST compare known identical observations across:

- live site graph data;
- OpenAir RData;

and establish the canonical timestamp transformation, if any.

This is a narrow source-semantics prerequisite, not a speculative pre-implementation functional test suite.

Until that mapping is established, OpenAir MAY be used for metadata/discovery and historical analysis but MUST NOT silently revise live observations by assuming timestamp equivalence.

## Reference discovery and Daily Stations

Daily Stations SHOULD establish the required station and timeseries reference state from the appropriate authoritative metadata/discovery sources before normal observation ingestion depends on them.

For these networks, OpenAir metadata is an appropriate initial source for:

- station code;
- station name;
- network membership;
- latitude/longitude;
- site type;
- start/end dates;
- pollutant availability;
- ratification metadata where supplied.

A station disappearing from the current live graph MUST NOT cause its historical station or timeseries rows to be deleted.

Closed and inactive stations remain historical reference entities.

## Scheduling

WAQN, SAQN and NI are separate connectors and therefore retain independent:

- `poll_enabled`;
- due state;
- overlap protection;
- run state;
- scheduler job;
- retry state;
- source health.

No poll interval is fixed by this contract.

Poll frequency MUST be chosen separately based on:

- upstream publication frequency;
- source load;
- UK AQ freshness requirements;
- existing scheduler architecture.

## TEST deployment trigger

The shared TEST Cloud Run deployment workflow for WAQN, SAQN and NI MUST retain manual `workflow_dispatch` support and MUST also deploy automatically on pushes to `main` when active devolved-official runtime dependencies change.

The automatic path scope MUST cover at least:

- `scripts/official_networks/**`;
- `workers/uk_aq_official_network_cloud_run/**`;
- shared runtime modules imported by that worker, including `scripts/uk_aq_supabase.py` and `scripts/uk_aq_service_egress_metrics.py`;
- the Cloudflare scheduler service-URL reconciliation script used by the deployment workflow;
- the deployment workflow itself.

Archive-only, documentation-only and unrelated connector changes MUST NOT trigger the devolved-official deployment.

Because WAQN, SAQN and NI share the official-network Cloud Run implementation, a qualifying shared-runtime push MAY deploy all three services together. The existing independent connector identities, scheduler jobs and polling state MUST remain unchanged.

The shared ingest deployment concurrency group MUST queue deployments rather than cancelling an in-progress deployment from another connector workflow.

## Public network catalogue

WAQN, SAQN and NI are separate official networks.

Their network catalogue rows SHOULD use:

```text
network_type = official
```

The exact initial values for:

```text
ingest_enabled
public_display_enabled
live_map_enabled
default_priority
```

MUST be set deliberately in the implementation plan rather than inferred solely from creation of the network row.

Connector creation MUST NOT implicitly change the semantics of those catalogue fields.

## Schema ownership

`uk-aq-schema` owns:

- canonical network rows and IDs;
- canonical connector rows and IDs;
- existing-database migrations;
- connector/network foreign-key relationships;
- acquisition-method RPC changes;
- required sequence reconciliation.

`uk-aq-ingest` owns:

- connector runtime implementations;
- SOS acquisition;
- website fallback acquisition;
- source-health/fallback selection;
- reference-discovery integration;
- pollutant mapping;
- observation normalisation.

`uk-aq-system-docs` owns the behavioural contract.

## Structural viability for source changes

Before further implementation changes to these connectors, perform only the targeted checks needed to establish structural viability.

As applicable, confirm:

1. stable connector/network identities remain 9/7, 10/8 and 11/9;
2. the compact observation v2 interface still accepts `site_graph_html`;
3. the shared `uk_aq_gcp_cloud_run_runtime` role retains exact EXECUTE authority for compact observation v2 without broad table/core/raw privileges;
4. the official-network Cloud Run image can package a transaction-pooler-compatible PostgreSQL client and bind the environment-specific shared database secret without exposing it;
5. WAQN and SAQN can continue sharing their embedded-graph parser without sharing connector state;
6. NI source changes preserve the dedicated graph/HTML adapter boundary and do not silently route connector 11 through the generic Series REST/SOS path;
7. supported NI graph periods and HTML Period semantics remain compatible with the contracted selection/filtering rules;
8. current Ricardo graph/site timestamps still represent UK local wall-clock time and can be normalised with `Europe/London` without depending on the runtime host timezone;
9. required scheduler configuration continues to support three independent connector jobs;
10. OpenAir metadata fields required for station/timeseries discovery remain normalisable into existing reference tables.

Do not create a speculative pre-deployment functional test suite.

The OpenAir/live timestamp-alignment check defined above is separately required before historical reconciliation is enabled because it establishes source semantics rather than runtime correctness.

## Post-deployment TEST validation

Functional validation MUST occur through real TEST operation after deployment.

For WAQN, a real TEST run MUST demonstrate that:

1. connector 9 resolves to network 7;
2. active WAQN stations/timeseries retain stable source identities;
3. the site graph produces current hourly observations;
4. during BST, the WAQN graph sequence aligns with the corresponding AURN series after `Europe/London` conversion to UTC;
5. during GMT, equivalent graph timestamps are not shifted by an hour;
6. raw hourly graph observations are ingested rather than derived Latest Data statistics;
7. `acquisition_method=site_graph_html` is recorded;
8. stations without recent graph data do not falsely fail the whole connector;
9. the primary compact observation v2 write succeeds through the shared pooled database transport after that transport is enabled, while low-frequency metadata/bookkeeping paths remain on their existing interfaces.

SAQN MUST receive equivalent operational validation for connector 10/network 8.

For NI, real TEST validation MUST demonstrate at least:

1. connector 11 resolves to network 9 and uses the dedicated site adapter even if stored configuration still contains `sos_probe_enabled=true`;
2. no normal NI current run calls the unusable `/sos-ni/api/v1` Series REST path;
3. BEL1 and CAS3, or equivalent active NI sites, produce fresh graph observations through `/api/site/graph/{site_code}/7`;
4. graph precision wins over rounded HTML display values for the same timeseries/timestamp;
5. eligible HTML `hourly mean` rows supplement mapped pollutants absent from the graph, including NO/NOx where available;
6. non-hourly rows such as BEL1's PM10 `24 Hour mean` are excluded as raw observations while hourly graph PM10 remains eligible;
7. NI graph and HTML source times are interpreted as `Europe/London` local wall-clock times and converted to UTC, with `24:00` rolled to the following local day before conversion;
8. a genuine one-source acquisition/parsing failure retains observations from the other source and reports partial status; a station whose successfully read sources simply contain no eligible current observations is recorded as no-data/no-usable-observations and does not make the run partial;
9. `acquisition_method=site_graph_html` is stored for accepted NI site observations;
10. the primary compact observation v2 write succeeds through the shared pooled database transport after that transport is enabled, while latest-value and secondary downstream observation delivery continue using their existing wire/database shapes.

When the NI long-window path is deliberately exercised, validation SHOULD also confirm that the smallest supported 7/14/21/30/60/90-day graph period is selected and that requests beyond 90 days are explicitly capped with a warning rather than presented as complete history.

## Explicit non-goals

This contract does not authorise:

- merging WAQN, SAQN and NI into one connector;
- changing the existing AURN/SOS connector;
- adding AQE;
- deduplicating AURN and devolved-network stations based only on matching site code;
- assuming AQE licensing permits UK AQ republication;
- changing R2 observation-history format;
- changing ObsAQIDB observation schema;
- changing public website display behaviour;
- inventing verification status from provisional website wording;
- treating OpenAir as a real-time source;
- enabling OpenAir historical overwrite before timestamp semantics are established;
- routing NI through the WAQN/SAQN inline graph parser when the NI response shape requires its dedicated adapter;
- treating the NI Series REST or OGC SOS service as the current normal observation route without separate validation and contract change;
- changing existing connector/network IDs.

## Follow-up investigations

The next source investigations SHOULD cover:

1. **AURN and AQE together**
   - compare OpenAir AURN and AQE station membership and pollutant coverage;
   - identify physical/site-code overlaps;
   - compare the OpenAir AURN catalogue with the current main UK-AIR SOS station feed;
   - determine whether current AURN sites exist in Air Quality England even when they are absent from the main SOS station feed;
   - determine whether AQE offers a technically useful current-data route for AURN resilience without creating duplicate AURN/AQE identities;
   - keep AQE licensing/republication authority separate from technical feasibility.

2. **AURN resilience implications**
   - determine whether OpenAir AURN adds station coverage not present in the main SOS feed;
   - determine whether those differences are systematic, for example newer AURN PM expansion stations;
   - do not change AURN connector acquisition rules until the comparison is complete.

The results of those investigations MAY amend this contract or produce separate AQE/AURN contracts where appropriate.
