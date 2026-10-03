# Hex Map live-network eligibility contract

Status: **authoritative current TEST behaviour, implemented and accepted on 25 September 2026**

## Authority and scope

This is the authoritative cross-area contract for deciding which canonical UK AQ networks may participate in the live/latest Hex Map.

It owns:

- the canonical network-level `live_map_enabled` flag;
- the distinction between ingest, public display and live-map eligibility;
- propagation of the flag through the IngestDB-to-ObsAQIDB network mirror;
- additive exposure of the flag in the public network catalogue;
- Hex Map catalogue, selection and latest-row filtering;
- the explicit boundary that the shared footer does not use this flag;
- the boundary between network presentation eligibility and connector acquisition metadata.

It does not make a network public, enable ingest, define connector polling, define provider attribution wording, or make a non-live network unavailable to dedicated public pages and APIs.

## Canonical field

`uk_aq_core.networks` MUST add:

```text
live_map_enabled boolean not null default false
```

IngestDB remains the authoritative source of the network row.

The default MUST be `false` so a newly added network cannot appear on the live Hex Map merely because it is ingest-enabled or public.

## Independent network switches

The following fields have separate meanings and MUST NOT be derived from one another:

```text
ingest_enabled
public_display_enabled
live_map_enabled
```

Their meanings are:

- `ingest_enabled`: UK AQ is authorised to acquire/process the network under the relevant ingest contracts.
- `public_display_enabled`: the network is eligible for the public network catalogue and public data surfaces that use the general public-network boundary.
- `live_map_enabled`: the network is eligible to participate in the live/latest Hex Map.

`network_type` remains the ownership/category classification `official | community | aggregator`. It MUST NOT be overloaded to represent acquisition cadence or live-map suitability.

A valid and expected combination is:

```text
ingest_enabled = true
public_display_enabled = true
live_map_enabled = false
```

This allows a network such as Black Carbon to be publicly available on a dedicated page while remaining absent from the live Hex Map.

## Initial contracted values

The implementation MUST initialise the current canonical network rows as follows:

| network_code | live_map_enabled |
| --- | --- |
| `gov_uk_aurn` | `true` |
| `breathelondon` | `true` |
| `sensorcommunity` | `true` |
| `black_carbon` | `false` |
| `openaq` | `true` |
| `laqn` | `false` |

OpenAQ is intentionally `live_map_enabled = true` while `public_display_enabled = false` on TEST. This keeps it absent from the public catalogue and Hex Map now, while ensuring that making OpenAQ public later is sufficient for it to join the Hex Map without a second eligibility change. LAQN remains `live_map_enabled = false` until an explicit product decision changes it.

## IngestDB-to-ObsAQIDB mirror

The Daily Stations network-catalogue mirror MUST copy `live_map_enabled` as part of the complete authoritative network row.

The complete mirrored row becomes:

```text
id
network_code
display_name
network_type
ingest_enabled
public_display_enabled
live_map_enabled
default_priority
metadata
created_at
updated_at
```

ObsAQIDB MUST preserve the IngestDB value exactly. It MUST NOT infer the flag from connector polling state, recent observation freshness, `network_type`, or `public_display_enabled`.

Any schema/RPC allow-list or complete-row validation used by the network mirror MUST be updated so omission of `live_map_enabled` fails structurally rather than silently retaining a default or stale value.

## Public network catalogue

The public network catalogue remains a catalogue of all public networks.

Eligibility for:

```text
GET /api/aq/networks
```

MUST remain:

```text
public_display_enabled = true
```

The catalogue MUST NOT add `live_map_enabled = true` as a row filter.

The public network row/contract-v2 payload MUST expose `live_map_enabled` as an additive boolean field so Hex Map consumers can derive their narrower network set without creating a second network-identity catalogue.

This additive field does not change `contract_version: 2`.

## Shared footer boundary

The shared footer MUST continue to use the full public network catalogue and `public_display_enabled` semantics.

The footer MUST NOT:

- filter attribution definitions using `live_map_enabled`;
- hide a public network because it is not a live-map network;
- require any footer code or layout change solely for this feature.

Therefore a network with:

```text
public_display_enabled = true
live_map_enabled = false
```

remains eligible for its normal footer attribution.

Black Carbon is the primary expected example.

## Hex Map catalogue eligibility

The Hex Map MUST treat a network as selectable/available only when the public catalogue row has:

```text
public_display_enabled = true
and live_map_enabled = true
```

Because the public catalogue already enforces `public_display_enabled = true`, the Hex-specific consumer may implement this as a strict `live_map_enabled === true` filter over validated public catalogue rows.

Networks with `live_map_enabled = false` MUST NOT appear in the Hex Map Networks panel, selected-network count, Hex summary network cards, pollutant capability presentation, or Hex Map URL/selection state.

Persisted Hex Map network selections MUST be reconciled against the live-map-eligible catalogue. A stored code that is no longer live-map eligible MUST be dropped using the existing selection reconciliation semantics.

Public Hex Map URL network selection MUST use canonical `network_code`, never numeric `network_id`, connector identity or display label. URL-code precedence, `networks=all`, canonicalisation and localStorage interaction are governed by [`hex-map-url-state-contract.md`](hex-map-url-state-contract.md).

## Hex Map latest-row eligibility

Filtering the Networks panel alone is insufficient.

The Hex Map controllers MUST ensure rows belonging to networks outside the live-map-eligible catalogue do not participate in Hex Map output, including when the logical selection is "all networks".

In particular, the current `selectedCodes === null` / "all selected" state MUST mean:

```text
all live_map_enabled catalogue networks
```

and MUST NOT mean "all network rows returned by the latest-data endpoint".

Non-live rows MUST be excluded before they can affect:

- map cells/area aggregation;
- sensor lists;
- summary cards;
- network counts/coverage;
- pollutant capability calculations;
- search/map presentation derived from the active Hex dataset.

The implementation MAY enforce this by deriving an eligible-code set from the Hex catalogue and applying it before normal selection filtering, or by an equivalent single-authority design. It MUST NOT rely on the absence of non-live networks from upstream latest payloads unless that upstream endpoint is explicitly changed to guarantee the same contract.

## Dedicated pages and chart boundary

`live_map_enabled = false` MUST NOT by itself prevent:

- a dedicated network page from showing the network;
- public charts for that network;
- the Wood Burning / Clean Air Night page from using Black Carbon;
- footer attribution;
- public API access already authorised by another contract.

This flag controls the live/latest Hex Map only.

## Connector acquisition metadata

General connector acquisition characteristics, such as whether a connector normally reads an API or downloads source files, MUST NOT determine `live_map_enabled`.

When useful for diagnostics or documentation, connector-level acquisition/source characteristics MAY be stored in:

```text
uk_aq_core.connectors.metadata
```

as JSONB.

Do not add a new connector boolean such as `realtime` merely for the Hex Map change.

The JSONB metadata is descriptive connector metadata. It does not replace the existing per-observation `acquisition_method` contract where that provenance is recorded for an individual stored observation version.

## Schema and implementation ownership

The implementation is expected to cross:

```text
TEST-uk-aq/uk-aq-schema
TEST-uk-aq/uk-aq-ingest
TEST-uk-aq/TEST-uk-aq.github.io
```

Required schema work includes:

- canonical IngestDB `networks` definition and canonical seed/reference data;
- an additive existing-database migration;
- canonical ObsAQIDB `networks` definition/bootstrap/migration as applicable;
- Daily Stations complete-row mirror/RPC compatibility;
- public network view/catalogue exposure of `live_map_enabled`.

Required runtime work includes:

- public network catalogue response typing/selects;
- shared website network-catalogue normalisation;
- Hex Map eligible-catalogue filtering;
- Hex Map latest-row filtering that remains correct for the "all selected" state.

The footer is explicitly out of implementation scope.

## Structural validation before deployment

Before deployment, validate only that:

- both database schemas can represent the new non-null boolean;
- the network mirror can copy it as part of the complete row;
- canonical seed values are explicit for every current network;
- the public catalogue can expose it without changing its public row eligibility;
- Hex Map code can derive one live-map-eligible code set and apply it to both catalogue selection and latest rows;
- existing footer consumers can ignore the additive catalogue field.

Do not create a speculative browser or end-to-end test suite before implementation.

## TEST acceptance after deployment

Functional acceptance MUST use real TEST operation after deployment.

Confirm:

1. IngestDB has the six contracted `live_map_enabled` values.
2. A real Daily Stations mirror leaves ObsAQIDB values identical to IngestDB.
3. `/api/aq/networks` still returns every `public_display_enabled` network and includes `live_map_enabled`.
4. The footer still follows the full public catalogue and does not change because of `live_map_enabled`.
5. The Hex Map Networks panel contains only live-map-enabled networks.
6. With all Hex networks selected, a public but `live_map_enabled = false` network contributes no Hex Map rows, counts, summaries or sensor-list entries.
7. Existing AURN, Breathe London and Sensor.Community Hex Map behaviour remains intact.
8. A dedicated non-live public surface, especially the Wood Burning / Black Carbon path when public-enabled, remains able to use that network independently of Hex Map eligibility.
