# Hex Map canonical physical-site contract

Status: **future implementation authority; TEST-first, not current runtime**

## Authority and scope

This contract defines the future Hex Map behaviour for source stations that share a canonical physical monitoring-site identity.

It depends on:

- [`../station_identity/contract.md`](../station_identity/contract.md) for physical-site identity;
- [`../latest_snapshot/canonical-site-projection-contract.md`](../latest_snapshot/canonical-site-projection-contract.md) for public row fields;
- [`hex-map-live-network-eligibility-contract.md`](hex-map-live-network-eligibility-contract.md) for which networks may participate in the live Hex Map.

It owns:

- one displayed Hex sensor per canonical physical site;
- network filtering before canonical grouping;
- deterministic representative-reading selection;
- non-double-counted Hex aggregation and physical sensor counts;
- visible multi-network identity for matched sites;
- fallback behaviour for unmatched stations.

It does not merge historical chart data across connectors.

## Canonical grouping key

For each selected pollutant/window, Hex Map source latest rows MUST use:

```text
match_id when non-null
otherwise station_id
```

as the physical-site grouping key.

The browser MUST NOT attempt to discover physical duplicates from station name, `station_ref`, coordinates or display text.

If `match_id` is null, the existing station-level behaviour is preserved.

## Network eligibility and selection happen before grouping

The existing live-network catalogue remains authoritative.

Hex Map MUST first exclude source rows whose scalar `network_code` is not live-map eligible.

It MUST then apply the user's selected-network filter to the row's scalar source `network_code`.

Only the surviving source rows participate in canonical physical-site grouping.

This preserves the meaning of network selection. For example:

- selecting only Welsh AQN requires an eligible Welsh AQN source row;
- selecting only GOV.UK AURN requires an eligible AURN source row;
- selecting both allows both source rows to become candidates for the same physical site.

A row MUST NOT become eligible merely because its `site_networks` array contains a selected network when that row's own scalar source network was not selected.

## Representative current reading

After source-network filtering, a canonical group contributes exactly one representative current reading for the selected pollutant.

Candidate rows are ordered by:

1. greatest parseable `last_value_at`;
2. if timestamps tie, prefer `network_code = gov_uk_aurn`;
3. if still tied, ascending `connector_id`;
4. then ascending `station_id`;
5. then ascending row `id`.

The chosen row supplies:

- the displayed pollutant value;
- the displayed observed time;
- source connector/station/timeseries identity used by existing row/chart actions.

Values from overlapping source rows MUST NOT be averaged together.

The non-selected source rows remain available in the underlying Latest Snapshot response and are not deleted or rewritten.

## One physical site in counts and aggregation

After grouping:

- the selected-area sensor list MUST contain one real row per physical grouping key;
- physical sensor counts MUST count that group once;
- Hex cell/area pollutant averages MUST use the one representative reading once;
- selecting AURN plus a devolved network MUST NOT double-weight the same matched physical site.

A network-specific membership statistic MAY count the same physical site under each network to which it genuinely belongs, but any metric labelled or used as a physical sensor total MUST count the site once.

## Visible network identity

For a matched physical site, the Network presentation MUST use the row's canonical `site_networks` membership set after intersecting it with the current live-map-eligible public catalogue.

It MUST NOT be reduced to only the representative source row's scalar network.

It MUST also not be reduced to only the networks currently selected by the user.

Therefore a Cardiff Centre row may show:

```text
GOV.UK AURN + Welsh AQN
```

even when the current filter contains only one of those networks.

Network labels MUST:

- use the canonical public catalogue labels;
- be unique;
- follow ascending `network_id` order;
- use ` + ` between multiple network labels.

The visible field is network membership of the physical site. The representative row's scalar source network remains provenance data and is not silently rewritten.

## Sensor name

When `canonical_station_label` is non-empty, the Hex Map SHOULD use it as the stable Sensor label for the physical group.

If it is absent, fall back to the existing representative-row Sensor/display name.

Changing network selection MUST NOT deliberately create a second row for the same non-null `match_id`.

## Responsive sensor-list presentation

This contract changes identity content, not the established Narrow/Compact/Full layout model.

Full mode keeps separate Sensor and Network columns.

Narrow and Compact continue to use the existing combined Sensor / Network presentation rules. The joined multi-network string is treated as the Network text for those fit rules.

Individual canonical network labels MUST NOT be truncated merely to imitate a single-network row. Existing exceptional-fit behaviour remains the authority if an unusually long combined identity does not fit the accepted geometry.

## Chart boundary

A canonical Hex row still launches/selects one source station/timeseries at a time.

The representative current row chosen above supplies the existing chart identity.

This contract does not authorise:

- merging AURN and regional historical series into one synthetic history;
- averaging histories;
- rewriting station-history connector identity;
- creating a new cross-connector chart cache key.

A later combined-history design requires its own contract.

## Examples

Expected matched-site examples include:

```text
WAQN CARD + AURN CARD -> UKA00217
WAQN NPT1 + AURN NPT3 -> UKA00380
SAQN DUN1 + AURN DCC1 -> UKA00643
NI BALY + AURN BALM -> UKA00503
```

With both source networks selected, each pair MUST produce one physical sensor row and one contribution to a Hex average for the selected pollutant.

## Existing behaviour preserved for unmatched stations

A source row with `match_id = null` continues to behave as one station.

This future feature MUST NOT change:

- pollutant/window semantics;
- live-network eligibility;
- URL network codes;
- sensor sort state;
- chart-selection limits;
- station-history API identity;
- existing responsive regime boundaries;
- source latest-reading eligibility.

## Structural validation before implementation

Before deployment, confirm only that:

1. the Hex data path receives the future `match_id`, `canonical_station_label` and `site_networks` fields;
2. current network filtering can remain source-row based before grouping;
3. current station-list, area aggregation and summary-count paths can share one canonical grouping helper rather than each inventing duplicate logic;
4. row/chart actions can retain the chosen representative row's current source identity;
5. responsive renderers can display a multi-network Network string without creating a new layout regime.

Do not create a speculative pre-deployment browser or fixture suite.

## Post-deployment TEST acceptance

Functional acceptance MUST use real TEST operation after the database relationship and Latest Snapshot projection have been deployed.

Confirm at least:

1. Cardiff Centre appears once when GOV.UK AURN and Welsh AQN are both selected and displays both network labels.
2. Newport `NPT1/NPT3` appears once and resolves through `UKA00380`.
3. Dundee Mains Loan `DUN1/DCC1` appears once with GOV.UK AURN plus Scottish AQN.
4. Ballymena Ballykeel `BALY/BALM` appears once with GOV.UK AURN plus Northern Ireland Air.
5. selecting only one member network still uses only that source network's eligible row candidates while the visible physical-site Network field retains all live memberships.
6. selecting both networks does not double the sensor count or Hex average weight.
7. where both source rows have the same observation timestamp, the AURN row wins the representative-reading tie.
8. where one selected source has a newer observation timestamp, the newer selected source row supplies the displayed value/time.
9. an unmatched station retains current one-row behaviour.
10. chart launch from a grouped row uses the representative source row and does not create a synthetic cross-connector history.
