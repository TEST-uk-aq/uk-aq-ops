# Latest snapshot validation

## Validation principle

The invalid-value defect is a deterministic state-transition error. A small targeted regression check is genuinely required before deployment because the failure can be proved without external services.

Broader functional validation is performed after deployment through real operation on the TEST system.

## Pre-implementation structural review

Before changing code, confirm that the proposed implementation can:

- resolve the incoming row to its observed property before state replacement;
- share one value-eligibility rule between state application and source-row defence-in-depth filtering;
- skip invalid state changes while still retaining the message for acknowledgement;
- preserve the existing state schema;
- preserve the v2 row and HTTP contracts;
- repair existing poisoned state separately from normal message handling.

If metadata cannot be available before state application without a larger ordering change, the implementation must document the exact alternative and prove that invalid rows cannot replace state.

## Required deterministic regression checks

The focused checks should cover only the load-bearing transition contract.

### State replacement

1. No state plus a valid value creates state.
2. No state plus a negative value creates no state.
3. A newer valid value replaces older valid state.
4. A newer negative value does not replace valid state.
5. An older valid value does not replace newer valid state.
6. Zero is accepted as valid.
7. PM2.5 above the existing maximum is rejected.
8. PM10 above the existing maximum is rejected.
9. Negative NO2 is rejected even though NO2 has no configured upper maximum.
10. An invalid row between two valid rows does not prevent the later valid row becoming state.

### State persistence

1. An invalid-only handled batch does not alter state bytes or hash.
2. Skipping an invalid row does not refresh the retained row's `ingested_at`.
3. State serialisation order and schema remain unchanged.

### Snapshot behaviour

1. The retained valid row remains in `window=all` after a newer invalid row.
2. Finite-window filtering uses the retained valid row's timestamp.
3. The invalid value is never emitted as `last_value`.
4. Snapshot row fields and top-level payload fields are unchanged.
5. Existing sorting and cursor derivation remain unchanged.

### Message handling

The implementation must make it structurally clear that a decoded invalid value:

- is classified as handled;
- does not modify state;
- remains eligible for normal acknowledgement after successful state handling.

A narrow integration check may be added if this cannot be established through the extracted state-application result and call ordering.

## Local checks after implementation

Run only the focused checks and existing fast structural checks relevant to changed files.

Expected categories:

- TypeScript or JavaScript syntax/type validation for the builder;
- the targeted latest-state regression check;
- existing latest-snapshot contract checks, if present;
- no deployment or external R2, Pub/Sub or Supabase calls.

Do not run broad backfills, cloud operations or unrelated test suites as pre-deployment validation.

## Diff review

Before deployment, review the diff against [`contract.md`](contract.md).

Confirm no unintended changes to:

- v2 types and field lists;
- R2 prefixes and keys;
- matrix pollutants or windows;
- metadata and network rules;
- display-name formatting;
- sort order and cursor logic;
- Pub/Sub pull and acknowledgement bounds;
- Cloud Run overlap and timeout logic;
- API Worker or cache-proxy behaviour.

## TEST deployment validation

Functional validation occurs through normal TEST operation.

### Builder health

After deployment, confirm:

- scheduled runs complete;
- Pub/Sub backlog does not grow because invalid rows are unacknowledged;
- invalid-value skips are reported;
- state entry count remains plausible;
- no new metadata or matrix failures appear.

### Known Manchester Piccadilly case

For connector `1`, timeseries `360`:

- raw history retains the `2026-07-16 09:00:00+00` value `-99`;
- latest state retains or is repaired to `2026-07-16 08:00:00+00`, value `21.793`, until a newer valid row exists;
- `window=all` contains the timeseries;
- finite windows depend on the retained valid timestamp;
- the public latest-snapshot response never emits `-99`;
- website search can find the station when otherwise eligible;
- the hex map can display it when otherwise eligible.

If a newer valid observation has arrived by validation time, use the newest valid observation as the expected state and still confirm the intervening `-99` remained in raw history.

### Public interface compatibility

Compare a representative response before and after deployment.

Confirm:

- top-level fields are unchanged;
- latest row field names are unchanged;
- network scalar fields remain canonical v2 fields;
- omitted v1/membership fields remain absent;
- `X-UK-AQ-Snapshot-Contract: v2` remains present;
- cache-proxy route and query parameters remain unchanged.

### Matrix and manifest

Confirm:

- all 15 configured pollutant/window combinations remain represented;
- unchanged objects still skip writes;
- changed objects have matching manifest hashes and row counts;
- no matrix entry fails solely because an invalid observation was skipped.

## Acceptance criteria

The latest-snapshot issue is fixed only when all of the following are true:

1. raw invalid observations are still retained by the raw-data path;
2. invalid pollutant values do not create or replace latest state;
3. previous valid state remains available to `window=all`;
4. finite windows use the valid observation timestamp;
5. decoded invalid messages are acknowledged after handling;
6. existing poisoned state is repaired or demonstrably self-healed for affected identities;
7. the website search and hex map work again for the affected station;
8. no unrelated public, metadata, scheduling or cache behaviour changed.
