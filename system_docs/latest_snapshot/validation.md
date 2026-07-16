# Latest snapshot validation

## Validation principle

The latest-snapshot service runs on the TEST system. Pre-deployment validation must therefore remain deliberately small and must not delay functional testing through the real deployed pipeline.

Before deployment, perform only:

1. structural confirmation that the proposed code preserves the authoritative contract;
2. basic syntax/type validation for changed files;
3. one compact deterministic regression check for the invalid-state transition.

Functional validation happens after deployment through normal TEST operation using the real Cloud Scheduler, Cloud Run service, Pub/Sub subscription, R2 state, public API and website.

Do not create or run a broad speculative pre-deployment test suite.

## Pre-implementation structural review

Before changing code, confirm that the proposed implementation can:

- resolve the incoming row to its observed property before state replacement;
- share one value-eligibility rule between state application and source-row defence-in-depth filtering;
- skip invalid state changes while retaining the message for acknowledgement;
- preserve the existing state schema;
- preserve the public v2 row and HTTP contracts;
- repair existing poisoned state separately from normal message handling.

If metadata cannot be available before state application without a larger ordering change, document the alternative and prove structurally that an invalid row cannot replace state.

## Minimal deterministic regression check

Use one compact table-driven or similarly narrow check covering only the load-bearing defect and boundaries:

- a valid row creates state;
- a newer `-99` does not replace an existing valid row;
- an invalid row between two valid rows does not prevent the later valid row becoming state;
- zero is valid;
- PM2.5 above `500` is rejected;
- PM10 above `600` is rejected;
- negative NO2 is rejected;
- an invalid-only batch does not alter state bytes or the retained row's `ingested_at`;
- an invalid decoded row is still handled for acknowledgement after successful classification.

The Manchester-style sequence is the primary regression:

```text
08:00  21.793  valid
09:00  -99     invalid
```

Required result:

```text
retained observed_at=08:00
retained value=21.793
```

Do not expand this into a broad suite of unrelated latest-snapshot, API, cache, network or deployment tests before deploying to TEST.

## Minimal local checks

Run only:

- syntax/type validation for changed latest-snapshot files;
- the single focused state-policy regression check;
- an existing fast service-core check only where it is already required by the deployment workflow and runs locally without external calls.

Do not run broad repository suites, backfills, Pub/Sub calls, R2 writes, Supabase queries or website automation before deployment.

## Diff review before deployment

Compare the diff with [`contract.md`](contract.md).

Confirm there are no unintended changes to:

- v2 types and field lists;
- R2 prefixes and keys;
- matrix pollutants or windows;
- metadata and network rules;
- display-name formatting;
- sort order and cursor logic;
- Pub/Sub pull and acknowledgement bounds;
- Cloud Run overlap and timeout logic;
- API Worker or cache-proxy behaviour;
- raw observation publishing or storage.

Once these minimal checks pass, deploy to TEST rather than adding more pre-deployment testing.

## TEST deployment validation

Functional validation occurs through normal TEST operation.

### Builder health

After deployment, confirm:

- scheduled runs complete;
- metadata loads successfully before state application where the new ordering is used;
- Pub/Sub backlog does not grow because invalid rows are unacknowledged;
- invalid-value skips are reported;
- state entry count remains plausible;
- invalid-only handling does not generate unnecessary state writes;
- no new metadata or matrix failures appear.

### Known Manchester Piccadilly case

For connector `1`, timeseries `360`:

- raw history retains the `2026-07-16 09:00:00+00` value `-99`;
- latest state retains or is repaired to the newest valid observation;
- if no newer valid row exists, the expected state is `2026-07-16 08:00:00+00`, value `21.793`;
- `window=all` contains the timeseries;
- finite windows use the retained valid timestamp;
- the public response never emits `-99` as `last_value`;
- website search can find the station when otherwise eligible;
- the hex map can display it when otherwise eligible.

### Public interface compatibility

Compare a representative response before and after deployment.

Confirm:

- top-level fields are unchanged;
- latest row field names are unchanged;
- scalar v2 network fields remain unchanged;
- omitted v1 and membership fields remain absent;
- `X-UK-AQ-Snapshot-Contract: v2` remains present;
- cache-proxy route and query parameters remain unchanged.

### Matrix and manifest

Confirm:

- all 15 configured pollutant/window combinations remain represented;
- unchanged objects still skip writes;
- changed objects have matching manifest hashes and row counts;
- no matrix entry fails solely because an invalid observation was skipped.

## Acceptance criteria

The latest-snapshot issue is fixed only when:

1. raw invalid observations remain retained by the raw-data path;
2. invalid pollutant values do not create or replace latest state;
3. zero remains valid;
4. previous valid state remains available to `window=all`;
5. finite windows use the valid observation timestamp;
6. decoded invalid messages are acknowledged after handling;
7. existing poisoned state is repaired or replaced by a newer valid row;
8. the website search and hex map work again for the affected station;
9. no unrelated public, metadata, scheduling or cache behaviour changed.
