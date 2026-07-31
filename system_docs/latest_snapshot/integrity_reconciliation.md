# Latest Snapshot Integrity reconciliation

## Authority

This document is the authoritative Latest Snapshot contract for accepting final verified observation candidates from R2 History Integrity.

It supplements:

- [`contract.md`](contract.md);
- [`state_model.md`](state_model.md);
- [`interfaces.md`](interfaces.md);
- [`operations.md`](operations.md);
- [`validation.md`](validation.md);
- [`../r2_history/current_state_reconciliation.md`](../r2_history/current_state_reconciliation.md);
- [`../r2_history/integrity_modularisation.md`](../r2_history/integrity_modularisation.md).

The existing Latest Snapshot contract remains authoritative for public-current-value eligibility, state identity, metadata eligibility, physical products, finite-window derivation and public v2 compatibility.

## Purpose

Normal Latest Snapshot state advances from a dedicated Pub/Sub observation subscription.

R2 History Integrity may establish final verified canonical observations that did not pass through that subscription, for example when the UK-AIR SOS gateway is unavailable but authoritative annual flat files remain available.

This interface allows the existing Latest Snapshot owner service to reconcile those observations without creating a second state writer.

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

The reconciliation operation runs inside the existing Latest Snapshot Cloud Run service and uses the same durable-state and product-building implementation as scheduled processing.

## Private reconciliation interface

The service exposes:

```text
POST /internal/integrity-reconcile
```

The route must:

- be accepted only by the Latest Snapshot service;
- not be exposed through public Workers or website APIs;
- require Cloud Run IAM authentication or a narrower approved equivalent;
- reject unauthenticated or malformed requests;
- identify the trigger mode as Integrity reconciliation in structured logs and build metadata where compatible.

## Caller authentication contract

The request carries a Google-signed identity token accepted by the private Cloud Run service.

The token audience is exactly the configured Cloud Run service origin URL. It must not include `/internal/integrity-reconcile`.

For local or operator-run Integrity using service-account impersonation:

- the base principal holds `roles/iam.serviceAccountTokenCreator` on the caller service account;
- the caller service account holds `roles/run.invoker` on the Latest Snapshot service;
- token generation explicitly selects the configured impersonated service account;
- the configured service audience is always supplied;
- failure to obtain that token blocks the target.

For `gcloud auth print-identity-token`, the command is equivalent to:

```text
gcloud auth print-identity-token
  --account=<configured base account>
  --impersonate-service-account=<configured caller service account>
  --audiences=<configured service origin>
```

The client must not fall back to:

- a different active user identity;
- a token without the configured audience;
- a token whose audience is the route URL;
- an empty token after a failed command;
- unauthenticated invocation.

Native service-account runtimes may use their established credential path when the resulting token has the same audience and authorised caller identity.

## Integrity-side authentication preflight

Before a real Integrity operation performs canonical R2 mutation for a scope that can affect PM2.5, PM10 or NO2 Latest Snapshot state, the Integrity client performs an authentication capability preflight.

The preflight:

1. validates URL and audience configuration;
2. invokes the same audience-specific identity-token helper used for the final call;
3. uses the configured account and impersonated service account explicitly where configured;
4. discards the token without logging it;
5. blocks canonical mutation when token acquisition fails.

The preflight does not call the mutating reconciliation route and does not retain a token for later use.

The final request obtains a fresh identity token after final R2 verification.

A successful preflight does not convert a later IAM, network or service failure into success. The failed target remains visible in that immutable run, and recovery is a new scoped Integrity operation.

O3-only repairs do not require this preflight because O3 is outside Latest Snapshot scope.

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

- `connector_id` and `timeseries_id` are positive integers;
- `observed_at` is a valid UTC timestamp;
- `value` is finite or null before policy evaluation;
- `value_float8_hex` is a string or null;
- `status` is a string or null;
- `pollutant_code` is a string;
- request size and candidate count are bounded;
- the Integrity caller supplies at most one compacted candidate for each `connector_id + timeseries_id` identity;
- duplicate candidate identities are rejected clearly or resolved only through the existing deterministic owner rule.

## Supported pollutant scope

Only:

```text
pm25
pm10
no2
```

are supported.

O3 and all other observed properties are outside this interface and must not create state.

## Integrity-side candidate derivation and compaction

Integrity must derive Latest Snapshot candidates only after the selected R2 history scope has completed final verification.

For partition-scoped direct replacement, the input is the union of all successfully verified canonical evidence partitions across the complete selected run scope. Integrity must not derive candidates from only the last processed pollutant, from a mutable connector-day staging directory, or from failed, unverified or all-unmapped partitions.

For each supported `connector_id + timeseries_id`, Integrity must submit exactly one latest eligible candidate.

The compaction procedure is:

1. consider every final verified canonical PM2.5, PM10 and NO2 observation for the timeseries across all successful selected partitions;
2. apply the shared Latest Snapshot public-current-value eligibility semantics used by the system;
3. exclude ineligible observations from candidate ordering;
4. select the eligible observation with the greatest `observed_at`;
5. preserve deterministic same-timestamp correction identity using `value`, `value_float8_hex` and `status`;
6. submit only that candidate to the owner service.

Integrity must not send every historical row merely so that the owner service can find the latest one.

If the raw latest observation is ineligible but an earlier observation is eligible, the earlier eligible observation is the Latest Snapshot candidate. A newer invalid observation must not hide the earlier valid candidate.

An authoritative no-data partition contributes no candidate. An all-unmapped partition left unchanged contributes no candidate because that operation did not verify replacement history for it.

The Integrity-side eligibility calculation exists only to compact the request. The Latest Snapshot owner service remains the final authority and must reapply metadata resolution, pollutant support and value eligibility to every submitted candidate.

## Independence from Timeseries reconciliation

Latest Snapshot is a separate durable target from the database Timeseries current-state fields.

Integrity must submit each compacted Latest Snapshot candidate regardless of:

- the stored `timeseries.last_value_at` value;
- whether the Timeseries candidate is older, equal or newer than stored Timeseries state;
- whether Timeseries reconciliation updated or skipped the row;
- whether the Timeseries target succeeded or failed.

A later Timeseries timestamp does not prove that Latest Snapshot received or retained the equivalent publicly eligible observation.

Timeseries reconciliation must not be used as a gate for Latest Snapshot candidate derivation or submission.

## Metadata and eligibility

The owner service resolves candidates through the existing core metadata cache and normal eligibility rules.

Caller-supplied `pollutant_code` is request evidence, not a replacement for metadata identity.

The service applies existing public-current-value policy, including:

- numeric finite value requirement;
- non-negative value requirement;
- PM2.5 maximum `500`;
- PM10 maximum `600`;
- current NO2 behaviour;
- existing aliases and normalisation.

A newer invalid candidate must not remove, replace or refresh a previously retained valid row.

## Durable-state read behaviour

Reconciliation loads durable R2 state through the established validated local-cache and R2 path.

Unexpected read, parse or validation failure blocks the operation. An unreadable existing state object must not be treated as authoritative empty state.

## State identity and ordering

State identity remains:

```text
connector_id + timeseries_id
```

For different timestamps:

- newer eligible candidate replaces older state;
- older candidate does not replace newer state.

For equal timestamps, compare:

```text
value
value_float8_hex
status
```

Required behaviour:

```text
same canonical content
  -> no-op

different final verified canonical content
  -> one correction may replace stale content
```

Repeating the same correction in a later new run is a no-op. A later execution time alone must not rewrite state.

Normal Pub/Sub same-timestamp ordering remains unchanged unless a separate contract change explicitly unifies it.

## State persistence

When candidates change state:

1. serialise the complete state through the shared stable serializer;
2. apply maximum-entry protection;
3. hash-gate unchanged state;
4. PUT durable R2 state;
5. update local cache only after the R2 PUT succeeds.

A local-cache write is never durable success.

When no candidate changes state, do not rewrite state merely to update timestamps.

## Product and manifest rebuild

After candidate application, the service runs the normal state-to-product path.

It must:

- build only the three physical `window=all` products;
- use existing metadata and network visibility rules;
- preserve deterministic row ordering and cursor meaning;
- preserve stable JSON and SHA-256 gating;
- skip unchanged writes;
- preserve existing partial-failure behaviour;
- write the physical manifest through the normal path.

Integrity reconciliation must not create a separate snapshot family.

## Single-writer and overlap safety

Scheduled processing and Integrity reconciliation use the same service-level overlap protection and single-writer assumptions.

The implementation preserves maximum-instance and concurrency safety unless an approved architecture change introduces a stronger durable lock.

A reconciliation request must not create a separate writer that can overlap scheduled state mutation.

## Response contract

A successful response includes at least:

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

For Integrity reconciliation, `candidate_count` is the compacted request count, normally no more than one candidate per supported timeseries. It is not the number of historical rows examined by Integrity.

Integrity audit must separately record rows examined, ineligible rows excluded, latest-raw-ineligible fallbacks and candidate count after compaction.

A partial product or manifest failure returns a non-successful operation result even when durable state already advanced.

The response and structured logs make partial durable outcomes explicit.

## Recovery and idempotency

The owner operation is idempotent and monotonic.

After any failed Integrity run, the operator corrects the cause and launches a new appropriately scoped Integrity operation. Integrity does not replay or resume the earlier run.

A later new run:

- obtains a fresh audience-specific token;
- derives candidates again from current final verified evidence;
- may safely send candidates already applied by an earlier partial attempt;
- cannot move state backwards;
- skips identical equal or older candidates;
- may rebuild stale products without rewriting unchanged state;
- records outcomes under the new Integrity run identifier.

The owner service does not require a special replay protocol, candidate receipt or previous-run state.

## Failure behaviour

The operation fails clearly when:

- authentication fails;
- request shape or bounds are invalid;
- durable state cannot be read;
- required metadata cannot be loaded;
- candidate identity contradicts metadata;
- durable state persistence fails;
- product generation fails;
- manifest persistence fails;
- overlap safety cannot be preserved.

A failure must not be hidden by stale local cache or old physical objects.

Authentication failure must be distinguishable from owner-service candidate, state, product and manifest failures.

## Public compatibility

This work must not change:

- the public pollutant matrix;
- public windows;
- physical `all` object keys;
- the public manifest key;
- public row fields;
- finite-window cutoff semantics;
- public ETag identity;
- cache-proxy routes;
- `X-UK-AQ-Snapshot-Contract: v2`;
- fail-closed public v2 behaviour.

## Explicit non-goals

This interface must not:

- make Integrity a direct Latest Snapshot R2 writer;
- add O3;
- insert observations into IngestDB;
- change raw observation history;
- change AQI or WHO calculations;
- change connector checkpoints;
- create missing metadata identities;
- expose a public mutation endpoint;
- depend on local cache as durable authority;
- provide an old-run replay or resume interface.

## Validation model

Before implementation, only targeted deterministic checks genuinely required for these behaviours are permitted:

- all successful verified pollutant-scoped evidence contributes to candidate derivation;
- failed, unverified and all-unmapped partitions do not contribute candidates;
- one latest eligible candidate is produced per supported timeseries;
- O3 is excluded;
- a newer ineligible raw observation does not hide an earlier eligible observation;
- Timeseries current state and Timeseries reconciliation outcomes do not gate submission;
- authentication command construction;
- preflight ordering;
- monotonic state transition;
- same-timestamp correction and idempotency.

Do not add a broad speculative pre-deployment test suite.

After deployment, functional validation occurs through real CIC-Test operations:

1. authenticated preflight before a real supported-pollutant repair;
2. one multi-pollutant reconciliation whose candidate count equals supported timeseries count rather than historical row count;
3. one reconciliation that advances state and products where applicable;
4. one later new scoped run that safely skips equal or older state where applicable;
5. one normal scheduled Latest Snapshot run after reconciliation.

A failed earlier Integrity run is not resumed as part of validation.

## Implementation status

Implemented and exercised in CIC-Test on 29 July 2026:

- private `POST /internal/integrity-reconcile` route;
- Cloud Run IAM authentication using the TEST operations service account;
- bounded request validation;
- owner-service state, product and manifest reconciliation;
- deterministic same-timestamp correction and idempotent behaviour;
- explicit audience-specific impersonated token acquisition;
- authentication capability preflight before canonical R2 mutation;
- fresh token acquisition for the final invocation;
- a successful full SOS repair through Latest Snapshot state and product reconciliation.

Contract clarified on 31 July 2026:

- Integrity must union all successful verified partition evidence;
- Integrity must send one latest eligible candidate per supported timeseries;
- a newer ineligible raw row must not hide an earlier eligible row;
- Timeseries state and outcome must not gate Latest Snapshot submission;
- the owner service remains the final eligibility and durable-state authority.

Operational recovery uses a new appropriately scoped Integrity run rather than replaying an earlier failed run.

## Related decision

See [`decisions/0004-integrity-reconciliation-through-owner-service.md`](decisions/0004-integrity-reconciliation-through-owner-service.md).
