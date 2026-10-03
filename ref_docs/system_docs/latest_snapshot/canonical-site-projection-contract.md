# Latest Snapshot canonical physical-site projection contract

Status: **future implementation authority; TEST-first, not current runtime**

## Authority and scope

This is the future narrow Latest Snapshot contract for projecting canonical physical-site identity into public v2 rows.

It supplements the current Latest Snapshot contracts and, once implemented and accepted on TEST, supersedes only the current row-shape wording that omits canonical physical-site fields.

The underlying canonical relationship is owned by [`../station_identity/contract.md`](../station_identity/contract.md).

## Preserve source-row state and provenance

The durable latest-state identity MUST remain:

```text
(connector_id, timeseries_id)
```

Canonical physical-site identity MUST NOT replace that state key.

The builder MUST continue to retain source-specific latest rows before public projection. AURN, WAQN, SAQN and NI source rows are not collapsed inside the durable latest-state object.

Existing scalar source provenance fields MUST retain their current meaning:

```text
connector_id
connector_code
connector_label
station_id
network_id
network_code
network_label
```

In particular, `network_code` on a source latest row remains the source station's scalar UK AQ network. It is not replaced by a synthetic combined network.

## Additive public row fields

Every future public v2 row MUST add:

| Field | Type | Meaning |
|---|---|---|
| `match_id` | positive integer or null | Canonical physical-site identity from `stations.match_id` |
| `uk_air_ref` | string or null | Canonical DEFRA UK-AIR ID for the physical site when available |
| `canonical_station_label` | string or null | Canonical physical-site display label, normally `station_matches.match_name` for matched rows |
| `site_networks` | array | Canonical public UK AQ network memberships for the physical site |

Each `site_networks` member MUST contain:

```text
network_id
network_code
network_label
```

The array MUST:

- contain unique network IDs;
- be sorted by ascending `network_id`;
- contain only networks eligible for general public display;
- be the same for every source latest row that shares the same non-null `match_id`.

For an unmatched source row:

- `match_id = null`;
- `uk_air_ref = null`;
- `canonical_station_label = null`;
- `site_networks` contains the row's own public scalar network as its single member.

This keeps the new array uniform without pretending an unmatched station has a canonical UK-AIR identity.

## No legacy membership resurrection

`site_networks` is a physical-site projection derived from canonical matched source stations.

It is not the retired:

```text
station_network_memberships
network_memberships
```

interface.

Those legacy membership tables/fields MUST NOT be recreated.

The existing current-interface statement that `network_memberships` is omitted remains true. This future amendment adds only the explicitly named `site_networks` field.

## Metadata authority

The builder MUST derive canonical fields from authoritative core metadata associated with the current core snapshot.

It MAY extend the durable core metadata cache to include `station_matches`, or MAY prejoin equivalent canonical fields into its internal station metadata, provided that:

- the source is the canonical core snapshot family;
- cache freshness follows the existing newest-core-manifest rules;
- no browser or Latest Snapshot heuristic re-matches stations by name or coordinates.

A canonical metadata-cache change MUST remain derived and disposable under the current Latest Snapshot cache contract.

## Public row count

This future projection is additive.

The physical `window=all` snapshot continues to contain source latest rows. The builder MUST NOT reduce its row count merely because two source rows share a `match_id`.

Physical-site deduplication for the Hex Map is owned by the Hex consumer contract.

Other consumers may continue to use source rows and scalar source network provenance.

## Finite responses

The R2 API Worker MUST preserve the four additive canonical fields when deriving `3h`, `6h`, `1d` and `7d` responses from the physical `all` object.

Finite-window filtering remains row-by-row on source `last_value_at`.

The Worker MUST NOT recalculate canonical membership arrays independently.

## Compatibility

The public contract remains v2 because the fields are additive and existing consumers may ignore them.

This amendment MUST NOT change:

- query parameters;
- supported pollutants/windows;
- source latest-state identity;
- source scalar connector/network fields;
- latest-value eligibility;
- row ordering;
- physical object count;
- finite-window cutoff semantics;
- cache-proxy route;
- R2 API authentication.

## Structural validation before implementation

Before deployment, confirm only that:

1. the current core metadata path can expose `stations.match_id` and canonical match rows;
2. public row construction can add the four fields without changing source-state identity;
3. the R2 API finite-response path preserves unknown/additive row fields;
4. existing consumers tolerate the additive v2 fields.

Do not create a speculative pre-deployment test suite.

## Post-deployment TEST acceptance

After deployment and a real TEST Latest Snapshot build, confirm through the real public route that:

- matched AURN and devolved source rows carry the same `match_id` and `uk_air_ref`;
- `site_networks` for Cardiff Centre includes both GOV.UK AURN and Welsh AQN;
- equivalent Scottish and NI overlaps expose both network memberships;
- source scalar `network_code` remains different on the AURN and devolved rows;
- unmatched stations have `match_id = null` and a one-network `site_networks` array;
- finite-window responses preserve the canonical fields unchanged for retained rows.
