# Latest snapshot validation

## Validation principle

Latest Snapshot runs on the UK AQ TEST system. Pre-deployment validation must remain deliberately small so functional validation happens through the real deployed pipeline.

Follow `AGENTS.md`:

- perform as little pre-deployment testing as reasonably possible;
- run only the smallest structural or syntax/type check needed;
- do not create new automated tests by default;
- add a targeted deterministic check only for a specific high-risk regression that is difficult to detect through normal TEST operation;
- do not run broad suites, exhaustive edge cases, shadow comparisons or soak tests unless explicitly requested.

For a reversible Latest Snapshot change, one successful normal operation and one representative output check are generally sufficient.

## Structural review before implementation

Confirm only the dependencies that could make the proposed structure invalid.

For the current all-only architecture, the load-bearing structural checks are:

- no active consumer requires finite physical objects;
- the physical manifest is treated as a stored-product manifest rather than a public request catalogue;
- the cache proxy and website continue forwarding the same public window parameter;
- the Worker can read and parse the pollutant's physical `all` payload within its runtime limits;
- state, Pub/Sub acknowledgement and metadata ordering are not accidentally changed.

Do not inspect archive code as an active dependency.

## Minimal pre-deployment checks

Use only:

- syntax or type validation for changed files;
- workflow parsing where deployment configuration changed;
- at most one directly relevant existing fast check when genuinely useful.

A targeted state-transition check is justified only when the latest-current-value policy or state application ordering changes. The compact regression is:

```text
08:00  21.793  valid
09:00  -99     invalid
```

Required state:

```text
observed_at=08:00
value=21.793
```

Do not expand this into a broad API, cache, network or website test suite before deploying to TEST.

## Current architecture acceptance

### Physical builder product

A successful normal run must show:

- `success_count=3`;
- `failure_count=0`;
- `matrix.windows=["all"]`;
- three manifest entries;
- each object key ends with `window=all.json`;
- unchanged physical payloads continue skipping writes;
- no new metadata, timeout, overlap or R2 errors;
- dedicated Pub/Sub acknowledgement remains healthy.

### Representative finite response

One representative finite request, normally PM2.5 `3h`, is sufficient unless it exposes a problem.

Confirm:

- HTTP `200`;
- `X-UK-AQ-Snapshot-Contract: v2` is accepted through the normal path;
- top-level and row field names remain unchanged;
- every returned row has a parseable `last_value_at` within the inclusive cutoff from the start of the current UTC minute;
- `count` matches returned data;
- `next_since` and `next_since_id` match the newest returned timestamp and tie-break ID;
- the response uses a derived finite ETag.

Do not compare every pollutant and every public window unless the representative check identifies a defect.

### `window=all`

When specifically relevant, confirm that `window=all` is served from the physical object and retains its physical ETag. A separate all-response check is not required for every reversible change.

### Website output

Load the normal TEST map or station search once and confirm Latest Snapshot data displays. Do not run broad browser automation or a manual regression programme by default.

## Latest-valid state acceptance

When state policy or recovery is in scope, confirm only the affected behaviour:

- raw invalid observations remain retained by the raw-data path;
- invalid pollutant values do not create or replace latest state;
- zero remains valid;
- the previous valid row remains in the physical `all` object;
- finite public windows use that valid row's timestamp;
- decoded invalid messages are acknowledged after handling;
- the public response does not emit an invalid current value.

The historical Manchester Piccadilly identity may be used as a concrete diagnostic example, but it is not a mandatory repeated test for unrelated changes.

## Cache validation

Finite response identity changes with:

- source physical ETag;
- requested window;
- effective UTC minute.

A matching `If-None-Match` may return `304`. Test this only when ETag or conditional-request code changes.

## Failure and rollback validation

When both components change, deploy the Worker first and the builder second.

If rollback is required after both are deployed:

1. roll back the builder so finite objects resume updating;
2. roll back the Worker;
3. make one representative public request.

Do not modify latest state or raw observations for an architecture rollback.

## Current TEST status

The all-only builder and deriving R2 API Worker were deployed and confirmed running successfully on TEST on 17 July 2026.

## Acceptance criteria

The system conforms to this documentation when:

1. latest-valid state rules remain intact;
2. the builder stores only three physical `window=all` objects;
3. the physical manifest contains only those three entries;
4. the API continues accepting `3h`, `6h`, `1d`, `7d` and `all`;
5. finite responses derive from `last_value_at` at the UTC-minute cutoff;
6. finite order, counts and cursors are correct;
7. finite ETags are time-aware;
8. public v2 fields, route and query parameters remain unchanged;
9. Pub/Sub acknowledgement and normal scheduled operation remain healthy;
10. one representative website output works;
11. no broad or speculative testing is required unless a real problem is found.