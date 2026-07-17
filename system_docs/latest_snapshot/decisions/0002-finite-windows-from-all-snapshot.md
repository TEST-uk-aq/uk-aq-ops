# ADR 0002: finite windows are derived from the physical all snapshot

- Status: Accepted and implemented
- Date: 17 July 2026
- Area: latest snapshot

## Context

The previous builder produced 15 physical R2 objects every minute:

```text
3 pollutants x 5 windows
```

The `3h`, `6h`, `1d` and `7d` objects did not contain different observations or aggregations. They were filtered copies of the same latest-valid rows held in `window=all`.

Each public row already carries `last_value_at`, derived from the retained state's `observed_at`. That timestamp is sufficient to decide whether the row belongs in any finite public window.

Generating and hashing 15 variants every minute repeated CPU, serialisation, sorting and R2 work in Cloud Run.

## Decision

The Cloud Run builder stores only one physical `window=all` object for each supported pollutant:

```text
pm25/all
pm10/all
no2/all
```

The physical manifest describes those three stored products only.

The R2 API Worker remains responsible for the public request matrix:

```text
3h, 6h, 1d, 7d, all
```

For every accepted request, the Worker reads the pollutant's physical `all` object.

- `window=all` is returned directly.
- A finite window is derived by filtering `last_value_at` against a cutoff calculated from the start of the current UTC minute.
- The Worker preserves row order and recalculates `window`, `count`, `next_since` and `next_since_id`.

## Cache decision

A finite response can change as time passes even when the physical source object is unchanged.

The finite response ETag therefore includes:

- the physical source ETag;
- the requested window;
- the effective UTC minute.

This allows conditional requests and caches to distinguish each minute's finite representation without forcing a new physical R2 write.

The existing cache-control period remains in force.

## Manifest meaning

The manifest is an inventory of physical stored products, not a catalogue of every public query representation.

It therefore contains:

```text
matrix.windows = [all]
snapshots.length = 3
```

Virtual finite responses are not manifest entries and do not have physical object keys.

## Public compatibility

The public contract remains v2 because the external interface did not change:

- route unchanged;
- query parameter names unchanged;
- accepted public window labels unchanged;
- top-level response fields unchanged;
- row fields and meanings unchanged;
- cache-proxy route unchanged;
- v2 contract marker unchanged.

The change is an internal ownership and storage optimisation behind the existing API.

## Consequences

### Positive

- Builder matrix work falls from 15 physical variants to three.
- Each pollutant is grouped, sorted and serialised once per build.
- R2 physical object writes and manifest entries are reduced.
- Rows age out of finite windows without requiring a physical object rewrite.
- Website and cache-proxy request contracts remain unchanged.

### Trade-offs

- The R2 API Worker parses and filters the pollutant `all` payload on a finite-response cache miss.
- Finite response cache identity must include time, not only source content.
- HEAD requests for finite windows may need to parse the source to calculate correct representation headers.
- The physical manifest no longer lists all public request variants.

The Worker-side cost is bounded by the normal cache and occurs only when a finite representation is not already cached.

## Alternatives considered

### Continue storing all 15 objects

Rejected because the finite objects duplicated the same latest rows and repeated work every minute.

### Filter in the website

Rejected because it would send the full pollutant payload to every browser, duplicate filtering across clients, and expose storage design to the presentation layer.

### Filter in the cache proxy

Rejected because the dedicated R2 API Worker already owns the Latest Snapshot object contract and can derive the representation closest to the source.

### Store a separate object per public window but build less often

Rejected because rows would age out based on time even without new observations, creating freshness and scheduling complexity while preserving duplicate storage.

### Put virtual finite entries in the manifest

Rejected because entries without stored objects would make manifest meaning ambiguous and could mislead backup, recovery and operational tooling.

## Old finite objects

Old physical finite-window objects may remain temporarily in R2.

They are inert historical artefacts and are not:

- read by the current Worker;
- updated by the current builder;
- listed in the current manifest;
- used as automatic fallbacks.

They may support a deliberate rollback only after the previous builder revision is restored and resumes updating them.

## Deployment and rollback

Deployment order:

1. R2 API Worker;
2. one representative finite response;
3. all-only builder;
4. one normal scheduled run;
5. one website output check.

Rollback after both components are deployed:

1. restore the previous builder so finite objects resume updating;
2. restore the previous Worker;
3. confirm one representative public request.

## Validation outcome

The direct cutover was deployed to TEST on 17 July 2026. The builder, API and website path were reported running successfully.

Ongoing validation follows the minimal TEST policy in [`../validation.md`](../validation.md).