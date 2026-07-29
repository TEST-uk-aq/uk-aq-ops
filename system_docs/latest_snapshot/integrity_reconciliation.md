# Latest Snapshot Integrity reconciliation

## Authority

This document is the authoritative Latest Snapshot contract for accepting final verified observation candidates from R2 History Integrity.

It supplements:

- [`contract.md`](contract.md);
- [`state_model.md`](state_model.md);
- [`interfaces.md`](interfaces.md);
- [`operations.md`](operations.md);
- [`validation.md`](validation.md);
- [`../r2_history/current_state_reconciliation.md`](../r2_history/current_state_reconciliation.md).

The existing Latest Snapshot contract remains authoritative for public-current-value eligibility, state identity, metadata eligibility, physical products, finite-window derivation and public v2 compatibility.

## Purpose

Normal Latest Snapshot state is advanced from a dedicated Pub/Sub observation subscription.

R2 History Integrity may establish final verified canonical observations that did not pass through that subscription, for example when the UK-AIR SOS gateway is unavailable but authoritative annual flat files are available.

This interface allows the existing Latest Snapshot owner service to reconcile those observations without creating a second R2 state writer.

## Ownership invariant

Latest Snapshot remains the sole owner of:

```text
latest_snapshots_state/v1/latest_state.json
latest_snapshots/v2/network_group=all/pollutant=pm25/window=all.json
latest_snapshots/v2/network_group=all/pollutant=pm10/window=all.json
latest_snapshots/v2/network_group=all/pollutant=no2/window=all.json
latest_snapshots/v2/manifest.json
```

Integrity must not write those objects directly.

The reconciliation operation must run inside the existing Latest Snapshot Cloud Run service and use the same durable-state and product-building implementation as scheduled processing.

## Private reconciliation interface

The service must expose one authenticated internal POST operation for Integrity reconciliation.

The exact route name is implementation-owned, but it must:

- be accepted only by the Latest Snapshot service;
- not be exposed through the public R2 API Worker;
- not be exposed through the website cache API;
- require the established private service authentication model or a narrower equivalent;
- reject unauthenticated or malformed requests;
- identify the trigger mode as Integrity reconciliation in structured logs and build metadata where compatible.

## Request contract

The request contains:

```text
schema_version
integrity_run_id
candidates
```

`schema_version` starts at `1`.

Each candidate contains:

```text
connector_id
timeseries_id
observed_at
value
value_float8_hex
status
pollutant_code
```

Required structural rules:

- `connector_id` is a positive integer;
- `timeseries_id` is a positive integer;
- `observed_at` is a valid UTC timestamp;
- `value` is finite or null before policy evaluation;
- `value_float8_hex` is a string or null;
- `status` is a string or null;
- `pollutant_code` is a string;
- request size and candidate count are bounded;
- duplicate candidate identities within one request are resolved deterministically or rejected clearly.

## Supported pollutant scope

Only the current Latest Snapshot matrix is accepted:

```text
pm25
pm10
no2
```

O3 and all other observed properties are outside this interface.

Unsupported candidates are counted and skipped or rejected according to the existing policy boundary. They must not create state.

## Metadata and eligibility

The owner service must resolve candidates through the existing core metadata cache and normal metadata eligibility rules.

The service must not trust caller-supplied pollutant identity as a replacement for metadata resolution. `pollutant_code` is request evidence that must agree with the resolved timeseries identity.

The service must apply the existing authoritative latest-current-value policy, including:

- numeric finite value requirement;
- non-negative value requirement;
- PM2.5 maximum `500`;
- PM10 maximum `600`;
- current NO2 behaviour;
- existing supported pollutant aliases and normalisation.

A newer invalid candidate must not remove, replace or refresh a previously retained valid row.

## Durable-state read behaviour

Reconciliation must load the durable R2 state through the established validated local-cache and R2 path.

An unexpected durable-state read, parse or validation failure must fail the reconciliation operation.

Reconciliation must not treat an unreadable existing state object as an authoritative empty state.

The existing normal scheduled behaviour may be tightened separately if required, but this operation must fail closed before applying candidates when durable state cannot be loaded reliably.

## State identity and ordering

State identity remains:

```text
connector_id + timeseries_id
```

For different observation timestamps:

- a newer eligible candidate replaces older state;
- an older candidate does not replace newer state.

For equal observation timestamps, canonical content must be compared before the wall-clock `ingested_at` tie-break.

Canonical same-timestamp content contains:

```text
value
value_float8_hex
status
```

Required behaviour is:

```text
same canonical content
  -> no-op

different final verified canonical content
  -> correction may replace retained content
```

When a correction is applied, the state entry may record the current reconciliation time in `ingested_at` under the existing schema.

Retrying the same already applied correction must be a no-op and must not rewrite durable state solely because the retry occurs later.

Normal Pub/Sub same-timestamp ordering must remain unchanged unless a separate contract change explicitly unifies it with this correction rule.

## State persistence

When at least one candidate changes state:

1. serialise the complete state through the shared stable state serializer;
2. apply the existing maximum-entry protection;
3. hash-gate unchanged state;
4. PUT the durable R2 state object;
5. update the local cache only after the R2 PUT succeeds.

A local-cache write is never durable success.

When no candidate changes state, the operation must not rewrite durable state merely to update `updated_at`.

## Product and manifest rebuild

After candidate application, the service must run the normal state-to-product build path.

It must:

- build only the three physical `window=all` products;
- use existing metadata eligibility and network visibility rules;
- preserve deterministic row ordering;
- preserve existing cursor meaning;
- preserve stable JSON and SHA-256 hash gating;
- skip unchanged object writes;
- preserve previous manifest entries on existing partial-failure rules;
- write the physical manifest through the normal path;
- leave finite public responses owned by the R2 API Worker.

Integrity reconciliation must not create separate physical finite-window objects or a separate manifest family.

## Single-writer and overlap safety

Scheduled Pub/Sub processing and Integrity reconciliation must use the same service-level overlap protection and single-writer runtime assumptions.

The implementation must preserve the current maximum-instance and concurrency safety boundary unless an approved architecture change replaces it with a stronger durable lock.

A reconciliation request must not run a separate child process or code path that can write state concurrently with a scheduled build.

The service may serialise, queue or reject an overlapping reconciliation request, but it must report the result clearly and must not permit concurrent state mutation.

## Acknowledgement separation

Integrity reconciliation has no Pub/Sub acknowledgement responsibility.

It must not acknowledge, consume or publish messages on the Latest Snapshot or raw observation subscriptions.

Normal scheduled message acknowledgement rules remain unchanged.

## Response contract

The successful response must include at least:

```text
ok
trigger_mode
integrity_run_id
candidate_count
eligible_count
applied_new_count
applied_newer_count
applied_same_timestamp_correction_count
skipped_equal_count
skipped_older_count
skipped_invalid_current_value_count
skipped_unsupported_pollutant_count
skipped_metadata_unresolved_count
state_changed
product_success_count
product_failure_count
changed_product_count
skipped_unchanged_product_count
manifest_key
warnings
```

A partial product or manifest failure must return a non-successful operation result even when durable state was already advanced.

The response and structured logs must make that partial durable outcome clear so Integrity can report and retry safely.

## Run reports and logs

Every reconciliation operation must emit a structured completion summary.

The existing R2 run-report policy remains in force. A reconciliation operation may be treated like a manual run for report selection, provided the existing schema can represent it without misleading fields.

Reconciliation success must not depend on writing a `_runs` object.

The summary must include the Integrity run ID and bounded candidate outcome counts.

## Retry behaviour

The operation must be idempotent.

A retry after:

- a complete success;
- a client timeout after durable success;
- a state success followed by product failure;
- a later normal scheduled build

must safely reload current durable state, compare candidates and avoid moving backwards.

When state is already correct but products or the manifest are stale, a retry may rebuild products without rewriting state.

## Failure behaviour

The operation fails clearly when:

- authentication fails;
- the request is malformed or exceeds bounds;
- durable state cannot be read reliably;
- required metadata cannot be loaded;
- candidate identity contradicts resolved metadata;
- durable state persistence fails;
- physical product generation fails;
- manifest persistence fails;
- overlap safety cannot be preserved.

A failure must not be hidden by a stale local cache or old physical object.

## Public compatibility

This work must not change:

- the public pollutant matrix;
- accepted public windows;
- physical `all` object keys;
- the public manifest key;
- public row fields or meanings;
- finite-window cutoff semantics;
- public ETag identity;
- cache-proxy routes;
- `X-UK-AQ-Snapshot-Contract: v2`;
- fail-closed public v2 behaviour.

## Explicit non-goals

This interface must not:

- make Integrity an R2 state writer;
- add O3 or another pollutant;
- insert observations into IngestDB;
- change raw observation history;
- change AQI or WHO calculations;
- change connector checkpoints;
- create missing metadata identities;
- expose a public mutation endpoint;
- depend on container-local cache as durable authority;
- require a new physical snapshot family.

## Validation model

Before implementation, only one targeted deterministic state-transition check is required.

It must prove:

- newer eligible candidate replaces older state;
- older candidate cannot replace newer state;
- identical same-timestamp content is a no-op;
- different final verified same-timestamp content replaces stale content once;
- retrying that correction is a no-op.

After deployment, functional validation occurs through real CIC-Test operation:

1. one authenticated reconciliation with a recent SOS candidate;
2. one public finite response showing the advanced row;
3. one identical retry with no state or product rewrite;
4. one older candidate with no rollback;
5. one normal scheduled Latest Snapshot run after reconciliation.

Do not add a broad speculative pre-implementation test suite.

## Implementation status

Approved for CIC-Test implementation as of 29 July 2026. The private service interface and runtime changes are pending.

## Related decision

See [`decisions/0004-integrity-reconciliation-through-owner-service.md`](decisions/0004-integrity-reconciliation-through-owner-service.md).
