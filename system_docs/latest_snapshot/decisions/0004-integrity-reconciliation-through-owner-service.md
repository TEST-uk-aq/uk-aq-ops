# Decision 0004: Integrity reconciliation through the Latest Snapshot owner service

## Status

Approved for CIC-Test implementation on 29 July 2026.

## Context

The Latest Snapshot system normally advances durable state from a dedicated Pub/Sub observation subscription.

R2 History Integrity can repair canonical observation history from authoritative source files when normal ingestion is unavailable. Those repaired rows may be newer than the Latest Snapshot durable state even though R2 history and station-history reads are correct.

Possible approaches were:

1. let Integrity edit the public physical snapshot objects directly;
2. let Integrity edit `latest_state.json` directly and trigger a rebuild;
3. add a second reconciliation service or workflow that writes Latest Snapshot state;
4. add an authenticated reconciliation mode to the existing Latest Snapshot owner service.

The first approach would be overwritten by the next normal builder run and would leave durable state stale.

The second and third approaches would create multiple independent writers for one durable R2 state object, duplicate policy and metadata logic, and increase race and rollback risk.

## Decision

Integrity reconciliation must be performed through an authenticated internal operation in the existing Latest Snapshot Cloud Run service.

The owner service remains solely responsible for:

- loading and validating durable state;
- resolving metadata;
- applying latest-current-value eligibility;
- applying state identity and ordering;
- handling same-timestamp verified corrections idempotently;
- writing durable state;
- rebuilding physical `window=all` products;
- rebuilding the physical manifest;
- preserving overlap and single-writer safety.

Integrity supplies only final verified candidate observations after its normal R2 history verification boundary.

Integrity must not directly write Latest Snapshot R2 state, products or manifest objects.

## Same-timestamp correction decision

Normal state ordering remains based primarily on `observed_at`.

For Integrity reconciliation only, equal timestamps require canonical content comparison before a wall-clock `ingested_at` tie-break:

```text
identical value, value_float8_hex and status
  -> no-op

different final verified canonical content
  -> apply one correction
```

Retrying the same correction is a no-op.

This decision does not automatically change normal Pub/Sub same-timestamp ordering. Any such change requires a separate approved contract amendment.

## Consequences

### Positive

- Latest Snapshot retains one owner and one mutation path.
- Existing pollutant eligibility and metadata rules are reused.
- Public v2 object and API contracts remain unchanged.
- Integrity retries can be idempotent.
- A repaired SOS observation can advance map and finite-window state without inserting duplicate IngestDB observations.

### Costs

- The existing service needs a private authenticated request mode.
- The service must distinguish state success from later product or manifest failure.
- Same-timestamp correction handling needs one targeted deterministic check.
- Integrity must report component outcomes separately when R2 history succeeds but reconciliation fails.

## Rejected alternatives

### Direct public-object repair

Rejected because public objects are derived products and would be overwritten from stale durable state.

### Direct Integrity state PUT

Rejected because it creates a second state writer and duplicates Latest Snapshot policy, metadata and concurrency behaviour.

### Separate reconciliation worker

Rejected because it still creates an independent writer unless it merely calls the existing owner service, in which case the additional service adds no necessary ownership boundary.

### Raw Pub/Sub replay

Rejected because Integrity repair is not a normal source-ingest event, replay could affect unrelated raw consumers, and repaired historical evidence should not be represented as a fresh successful connector poll.

## Related contracts

- [`../integrity_reconciliation.md`](../integrity_reconciliation.md)
- [`../../r2_history/current_state_reconciliation.md`](../../r2_history/current_state_reconciliation.md)
- [`../contract.md`](../contract.md)
