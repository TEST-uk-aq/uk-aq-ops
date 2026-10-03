# Canonical physical monitoring-site identity contract

Status: **future implementation authority; TEST-first, not current runtime**

## Authority and scope

This contract is the authoritative future definition of physical monitoring-site identity across connector-scoped UK AQ station records.

It owns:

- the distinction between a source station and a physical monitoring site;
- the canonical `uk_aq_core.station_matches` physical-site entity;
- `uk_aq_core.stations.match_id` membership in that entity;
- the explicit `UK-AIR ID` field used for UK-AIR-backed physical sites;
- evidence rules for AURN overlap with WAQN, SAQN and Northern Ireland Air;
- preservation of connector, network, station, timeseries and observation provenance;
- derivation of a physical site's canonical UK AQ network membership set.

It does not own Latest Snapshot public-row shape or Hex Map presentation. Those are defined by the linked cross-area contracts.

## Source station and physical site are different identities

A row in `uk_aq_core.stations` is a connector-scoped source representation.

Its existing identity remains:

```text
connector_id + service_ref + station_ref
```

and its required `network_id` remains the source station's canonical UK AQ network.

A physical monitoring site is a separate higher-level entity.

Multiple source station rows MAY point to the same physical-site entity when authoritative evidence shows that they represent the same monitoring location.

This relationship MUST NOT:

- delete or merge source station rows;
- rewrite source `station_ref`;
- rewrite source `network_id`;
- merge connector identities;
- merge timeseries identities;
- merge raw observation identities;
- remove source provenance.

## Canonical database entity

The future canonical physical-site entity is:

```text
uk_aq_core.station_matches
```

Member source stations point to it through:

```text
uk_aq_core.stations.match_id
```

The current TEST database already contains a dormant `station_matches` table and a nullable `stations.match_id` foreign key, but implementation MUST verify canonical schema ownership rather than rely on environment drift.

If either object is missing from the canonical schema source, the implementation MUST add it to the correct `uk-aq-schema` owner file and provide an existing-database migration.

## UK-AIR ID

`station_matches` MUST add an explicit nullable field:

```text
uk_air_ref text
```

For a UK-AIR-backed physical site:

- `uk_air_ref` MUST contain the canonical DEFRA UK-AIR ID such as `UKA00217`;
- it MUST be stored in its canonical uppercase form;
- non-null `uk_air_ref` values MUST be unique;
- the generic existing `match_key` MUST NOT be the sole storage location for UK-AIR identity.

A physical site that has no authoritative UK-AIR identity MAY have `uk_air_ref = null`. This contract does not require every UK AQ station to obtain a UK-AIR ID.

For the AURN/devolved-network overlap covered here, the canonical physical-site identity is the DEFRA UK-AIR ID.

## UK-AIR register authority

The current UK AQ source of DEFRA site identity is the latest valid `uk_aq_raw.sos_site_register` snapshot.

For this relationship the load-bearing fields are:

```text
uk_air_ref
site_ref
site_name
latitude
longitude
networks
```

The target DEFRA record MUST explicitly contain:

```text
Automatic Urban and Rural Monitoring Network (AURN)
```

in its `networks` membership before a WAQN, SAQN or NI station may be treated as an AURN overlap under this contract.

The monthly UK-AIR site-register process already derives and validates `site_ref` from official UK-AIR pages. The future canonical-site resolver SHOULD reuse that authority rather than create an independent UK-AIR catalogue.

## Regional exact-code resolution

For WAQN, SAQN and NI, the regional `station_ref` is the source network's own stable site code.

A regional source station MAY resolve directly to a DEFRA AURN physical site when:

1. the latest valid DEFRA record is an AURN member;
2. `upper(regional station_ref) = upper(DEFRA site_ref)`;
3. the DEFRA row has a non-null `uk_air_ref`.

This is an authoritative identifier bridge, not a station-name match.

The resulting `station_matches.uk_air_ref` is the DEFRA `uk_air_ref`.

## Different-code alias resolution

Some physical sites use different regional and DEFRA/AURN site codes.

A different-code regional station MUST NOT be matched merely to the nearest AURN site.

A different-code relationship MAY be accepted only when all of the following hold:

1. there is exactly one plausible current DEFRA AURN site within 50 metres of the regional coordinates;
2. official regional and DEFRA evidence supports the same physical monitoring location;
3. the evidence is stronger than station-name similarity alone;
4. no conflicting site, relocation or second AURN candidate makes the relationship ambiguous.

Strong corroborating evidence includes:

- identical official coordinates to the precision published by both sources;
- an official regional site page explicitly identifying the station as AURN or naming its AURN counterpart;
- official site descriptions or addresses that clearly identify the same monitoring enclosure/location.

Station name MAY corroborate a relationship but MUST NOT establish it by itself.

If the relationship remains ambiguous, leave the regional station unmatched and report it for review.

## Current design evidence

The design investigation on 03/10/2026 found 41 active regional stations corresponding to DEFRA AURN sites in TEST:

- 11 WAQN;
- 23 SAQN;
- 7 Northern Ireland Air.

Thirty-three use the same regional and DEFRA site code.

Eight use a different code:

| Regional network | Regional code | DEFRA AURN code | UK-AIR ID |
|---|---|---|---|
| Welsh AQN | `CHEP` | `CHP` | `UKA00515` |
| Welsh AQN | `NPT1` | `NPT3` | `UKA00380` |
| Scottish AQN | `DUN1` | `DCC1` | `UKA00643` |
| Scottish AQN | `INC2` | `GKA8` | `UKA00621` |
| Scottish AQN | `PET07` | `PEGR` | `UKA01088` |
| Scottish AQN | `WDB4` | `DUMB` | `UKA00555` |
| Northern Ireland Air | `BALY` | `BALM` | `UKA00503` |
| Northern Ireland Air | `ARM5` | `ARM6` | `UKA00541` |

Seven of those eight pairs had identical coordinates in the current TEST/DEFRA data. `ARM5` and `ARM6` were approximately 2.456 metres apart and the NI source explicitly identifies the regional site as the AURN Armagh Roadside site.

These rows are acceptance evidence, not a permanent hard-coded alias table. The implementation MUST derive the relationship from current official evidence and MUST NOT assume the counts or list can never change.

## AURN/SOS source members

The UK-AIR SOS connector may represent one physical AURN site through more than one pollutant-specific source station/timeseries row.

When an SOS source station has an established `uk_air_ref` through the existing UK-AIR reference bridge, every source station resolving to the same UK-AIR ID MUST point to the same `station_matches.id`.

This contract does not authorise a new browser-side name/distance inference for SOS.

If the upstream SOS-to-UK-AIR relationship is unresolved or ambiguous, the source station MUST remain unmatched rather than being forced into a physical-site group.

## Relationship persistence

For each resolved UK-AIR physical site:

1. upsert one `station_matches` row keyed by unique `uk_air_ref`;
2. keep canonical physical-site descriptive fields such as `match_name`, coordinates and geometry aligned with the selected official UK-AIR record where practical;
3. set each resolved source station's `match_id` to that canonical row;
4. preserve the source station's own connector, station reference, network and lifecycle fields.

Relationship refresh MUST be idempotent.

A resolver MUST NOT silently move an existing source station from one non-null `uk_air_ref` to another merely because a new nearest candidate appears. A conflicting reassignment requires authoritative evidence and MUST be surfaced diagnostically.

The resolution method and material evidence for non-trivial aliases MUST remain auditable, using `station_matches.metadata` or another canonical derived evidence surface chosen during implementation. That evidence surface is not a public API contract.

## Canonical network membership

The physical site does not replace the source network model.

The canonical UK AQ network membership set for a physical site is derived from the distinct `stations.network_id` values of its applicable member source stations.

For example:

```text
station_matches UKA00217
  member source station: GOV.UK AURN
  member source station: Welsh AQN

canonical UK AQ site networks:
  GOV.UK AURN
  Welsh AQN
```

Do not recreate the retired legacy station/network membership tables merely to express this relationship.

A source station continues to have exactly one required scalar `network_id`. Multi-network physical-site presentation is derived from the canonical site's member source stations.

## Downstream canonical grouping key

A downstream consumer that explicitly needs physical-site semantics MUST use:

```text
match_id when non-null
otherwise source station_id
```

It MUST NOT derive physical identity from:

- station name;
- display name;
- coordinates;
- source `station_ref`;
- network label.

This fallback preserves existing behaviour for every station that has not been assigned a canonical physical-site match.

## Source observation preservation

Canonical physical-site identity is not observation deduplication at ingest.

WAQN, SAQN, NI and AURN observations MUST continue to be acquired and retained under their existing connector/timeseries identities.

This preserves:

- source provenance;
- source-specific diagnostics;
- independent connector health;
- comparison of overlapping feeds;
- fallback/resilience options.

Any downstream decision to choose one representative current reading for a physical site is owned by the consuming product contract and MUST NOT delete the other source readings.

## Structural validation before implementation

Before writing implementation code, confirm only that:

1. canonical `uk-aq-schema` can own `station_matches`, `stations.match_id` and the additive `uk_air_ref`;
2. a partial unique constraint/index can enforce one non-null `uk_air_ref` per physical site;
3. the existing UK-AIR site-register and SOS UK-AIR reference data can supply the required identifiers without a new external dataset;
4. WAQN, SAQN and NI station rows retain their regional source codes and scalar networks;
5. the resolver can fail closed for ambiguous aliases.

Do not create a speculative pre-deployment test suite.

## Post-deployment TEST acceptance

After schema/runtime deployment, validate through real TEST data.

At minimum confirm:

- exact-code examples such as `CARD -> UKA00217`, `ED3 -> UKA00454` and `BEL2 -> UKA00212`;
- different-code examples `NPT1 -> UKA00380`, `DUN1 -> UKA00643` and `BALY -> UKA00503`;
- `ARM5 -> UKA00541` resolves using its authoritative alias evidence rather than name alone;
- all source station rows remain present with their original connector/network identity;
- multiple source stations sharing one UK-AIR site point to one `station_matches.id`;
- an unmatched regional-only station remains ungrouped and continues normal source behaviour;
- no ambiguous candidate is auto-assigned.
