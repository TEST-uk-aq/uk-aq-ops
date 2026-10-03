# Latest snapshot public-row connector identity contract

## Authority

This is the authoritative narrow compatibility contract for connector identity in public latest-snapshot v2 rows.

It supplements `latest_snapshot/contract.md` and `latest_snapshot/interfaces.md` and supersedes only their current public-row field wording where the two differ.

All other latest-snapshot behaviour, eligibility, ordering, finite-window derivation, cache identity, authentication, network identity and failure rules remain unchanged.

This amendment exists to support consumers that must translate a current latest-snapshot row into an authoritative station-history request without performing a second identity lookup.

## Decision

Every emitted latest-snapshot v2 `data` row MUST include:

```text
connector_id
```

The value MUST be the authoritative positive integer connector identity already used by the latest-snapshot state identity:

```text
(connector_id, timeseries_id)
```

`network_id` MUST NOT be used as a substitute for `connector_id`.

Connector and network identity represent different domains and may legitimately have different numeric values.

## Row-shape amendment

The existing latest-row v2 contract is amended by adding:

| Field | Type | Meaning |
|---|---|---|
| `connector_id` | positive integer | Authoritative connector identity for the row/timeseries |

Existing fields, including `connector_code`, `connector_label`, `network_id`, `network_code` and `network_label`, retain their existing meanings.

This change adds one provenance/identity field. It does not rename or remove an existing field.

## Source of truth

The builder MUST derive `connector_id` from the authoritative latest-snapshot state/timeseries identity already associated with the row.

It MUST NOT infer connector identity from:

```text
network_id
network_code
network label
station display name
browser state
```

No new database or API lookup is required merely to derive this field when the authoritative connector identity is already present in latest-snapshot state and metadata processing.

If implementation analysis finds that the current builder has lost authoritative connector identity before row construction, stop and return that architecture issue for review rather than reconstructing identity heuristically.

## Physical and finite responses

The physical `window=all` v2 snapshot row MUST contain `connector_id`.

Finite `3h`, `6h`, `1d` and `7d` responses are derived from the physical `all` object and MUST preserve `connector_id` unchanged for every retained row.

The R2 API Worker MUST NOT strip, translate or recalculate the field.

The cache proxy MUST preserve the field as part of the v2 response body.

## Compatibility and rollout

This is an additive v2 field change.

Existing consumers that ignore unknown fields remain compatible.

Consumers that require authoritative chart/history identity may require `connector_id` after the updated latest-snapshot backend has been deployed and a current physical snapshot has been generated.

Rollout order on TEST MUST therefore be:

1. implement the latest-snapshot row addition in the owning backend/service;
2. structurally validate the change;
3. deploy the owning backend/service to TEST;
4. run or allow a normal latest-snapshot build that rewrites the physical v2 objects with `connector_id`;
5. verify through the real TEST `/api/aq/latest-snapshot` route that representative rows expose the authoritative `connector_id` and that it is distinct from `network_id` where the data says so;
6. then resume the Hex Map shared-chart consumer cutover that requires the field.

Do not make a frontend identity lookup or connector-less chart request the permanent compatibility mechanism for this change.

## Behavioural non-goals

This amendment MUST NOT change:

```text
latest-value eligibility
row count
latest-state replacement ordering
pollutant mappings
network assignment
station identity
timeseries identity
window filtering
row ordering
snapshot cadence
cache-proxy authentication
AQI behaviour
station-history request semantics
```

Adding `connector_id` must not cause an otherwise valid latest row to disappear merely because an unrelated optional metadata field is absent.

## Validation

Before deployment, validation is limited to structural viability, including the smallest targeted deterministic check needed to confirm that row construction carries the existing authoritative connector identity into the emitted v2 payload.

Do not create a speculative test suite for this amendment.

Functional acceptance occurs after deployment through the real TEST latest-snapshot route and then through normal Hex Map sensor/chart operation.

## Documentation consolidation

During the later system-doc consolidation phase, fold this amendment into the main `latest_snapshot/contract.md` public-v2 compatibility wording and `latest_snapshot/interfaces.md` latest-row table, then retire this narrow amendment if it has become fully redundant.
