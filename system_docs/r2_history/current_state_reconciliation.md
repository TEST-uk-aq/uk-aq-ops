# Integrity current-state reconciliation

## Authority and scope

This document is the authoritative cross-system contract for reconciling current-state records after R2 History Integrity has established final verified canonical observations.

It supplements:

- [`integrity.md`](integrity.md) for source evidence, canonical observation repair and final R2 verification;
- [`integrity_modularisation.md`](integrity_modularisation.md) for module ownership and stage boundaries;
- [`../latest_snapshot/contract.md`](../latest_snapshot/contract.md) for latest-valid public-state policy;
- [`../latest_snapshot/integrity_reconciliation.md`](../latest_snapshot/integrity_reconciliation.md) for the Latest Snapshot owner-service mutation boundary.

Where this document conflicts with an implementation plan, worker README, script comment or archive, this document is authoritative for current-state reconciliation.

## Purpose

A source outage may prevent normal ingestion while authoritative historical source files remain available. Integrity may therefore repair R2 v2 observation history through a timestamp newer than:

```text
timeseries.last_value_at
latest_snapshots_state/v1/latest_state.json
```

The repaired observation history may already be readable by station-history routes, but stale current-state records can leave discovery, map rows and finite Latest Snapshot responses out of date.

Integrity must reconcile those derived records without:

- replaying the normal raw-ingest pipeline;
- inserting duplicate IngestDB observations;
- moving current state backwards;
- bypassing Latest Snapshot eligibility or metadata rules;
- writing Latest Snapshot objects directly;
- repeating successful R2 repair stages solely because a later current-state target failed.

## State ownership

### Canonical observation history

R2 v2 observation history remains the authoritative historical observation record. Integrity owns detection, repair planning, scoped R2 mutation, manifest and index repair, and final source-to-R2 verification.

### Timeseries freshness

The database `timeseries` row owns:

```text
last_value_at
last_value
```

These fields are discovery and operational metadata. They are not authoritative observation history.

### Latest valid public state

The Latest Snapshot owner service owns:

```text
latest_snapshots_state/v1/latest_state.json
latest_snapshots/v2/network_group=all/pollutant=pm25/window=all.json
latest_snapshots/v2/network_group=all/pollutant=pm10/window=all.json
latest_snapshots/v2/network_group=all/pollutant=no2/window=all.json
latest_snapshots/v2/manifest.json
```

Integrity must not write, patch or delete those objects directly.

## Definitions

### Final verified canonical observations

The canonical observation collection that passed source comparison, proposal validation, real R2 apply verification and final source-to-R2 verification for the selected scope.

### Raw latest candidate

The final verified canonical observation with the greatest `observed_at` for one affected timeseries.

### Latest valid candidate

The final verified canonical observation with the greatest `observed_at` for one affected timeseries after the Latest Snapshot owner policy has applied pollutant and value eligibility.

### Same-timestamp correction

A candidate whose `observed_at` equals stored current state but whose canonical value, binary value identity or preserved status differs.

### Monotonic update

An update that never replaces current state with an earlier observation.

## Reconciliation trigger boundary

Integrity may mutate downstream current-state records only when:

1. the run is not `--check-only`;
2. the run is not `--dry-run`;
3. authoritative source evidence is available;
4. mapping and identity evidence are not ambiguous;
5. the selected observation scope passed final source-to-R2 verification;
6. required parent manifests and indexes are valid;
7. the target is enabled for the environment;
8. any required target-specific authentication preflight passed before canonical mutation began.

A source failure, uncertain empty result, blocked mapping, failed R2 mutation or failed final verification blocks reconciliation for the affected scope.

Current-state reconciliation must not make an unverified history repair appear successful.

## Pollutant scope

Timeseries freshness reconciliation supports:

```text
pm25
pm10
no2
o3
```

Latest Snapshot reconciliation supports:

```text
pm25
pm10
no2
```

An O3 repair may advance `timeseries.last_value_at` and `timeseries.last_value`, but must not create or update Latest Snapshot state or products.

Integrity must not broaden connector, pollutant, day or timeseries scope merely because reconciliation is enabled.

## Authentication configuration

For a local operator run using `gcloud` and service-account impersonation, configuration consists of:

```text
CLOUDSDK_CORE_ACCOUNT
CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT
UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_URL
UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_AUDIENCE
UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_TIMEOUT_SECONDS
```

The configured audience must be exactly the Cloud Run service origin. It must not contain `/internal/integrity-reconcile`.

The configured URL must contain the private reconciliation route.

The identity-token command must be equivalent to:

```text
gcloud auth print-identity-token
  --account=<configured base account>
  --impersonate-service-account=<configured caller service account>
  --audiences=<configured Cloud Run service origin>
```

The account and impersonation flags are optional only when the runtime has an equivalent native credential path. The audience is always required.

The client must not fall back to:

- an active user token with a different identity;
- an audience-less token;
- a token for the route URL rather than the service origin;
- an empty token;
- unauthenticated invocation.

Errors must be bounded and must not expose token contents or secrets.

## Authentication preflight

For a real repair run, Integrity must perform an authentication capability preflight before canonical R2 mutation when all of these are true:

- current-state reconciliation is enabled;
- the selected repair scope can produce PM2.5, PM10 or NO2 Latest Snapshot candidates;
- the Latest Snapshot target is enabled.

The preflight must:

1. validate the configured URL and audience;
2. invoke the same audience-specific identity-token helper used by the final call;
3. use the configured account and impersonated service account explicitly where configured;
4. discard the token without logging it;
5. fail the run before canonical R2 writes when token acquisition fails.

The preflight is a capability check, not reusable authentication state. The final Latest Snapshot invocation must obtain a fresh audience-specific token again.

An O3-only run does not require Latest Snapshot authentication preflight.

Check-only and dry-run validate configuration shape but must not require an interactive credential refresh or invoke a mutating target.

A successful preflight cannot guarantee that credentials or IAM remain valid later. A final target failure must therefore remain safely resumable.

## Timeseries candidate and mutation contract

For each affected timeseries, Integrity derives one raw latest candidate containing:

```text
integrity_run_id
connector_id
timeseries_id
observed_at
value
```

The value is the exact finite canonical source value. Finite negative values are retained because `timeseries.last_value` is raw latest observation metadata.

Integrity must not create a missing timeseries, station, phenomenon, connector or observed-property identity.

Timeseries reconciliation must use one private schema-owned RPC. Integrity must not issue unrestricted direct updates to `timeseries`.

For an existing timeseries, the RPC atomically:

1. updates when `last_value_at` is null;
2. updates when the candidate is newer;
3. corrects `last_value` when timestamp is equal but canonical value differs;
4. skips equal timestamp and value;
5. skips an older candidate;
6. returns deterministic outcome counts.

The RPC must not alter `first_value_at`, identity fields, lifecycle fields, connector checkpoints or ingest evidence.

The response includes at least:

```text
candidate_count
updated_newer_count
updated_same_timestamp_correction_count
skipped_equal_count
skipped_older_count
missing_timeseries_count
failed_count
```

A missing target is reported and prevents full target success. It is not created.

## Latest Snapshot candidate and mutation contract

For each supported affected timeseries, Integrity supplies final verified candidate data to the Latest Snapshot owner service:

```text
integrity_run_id
connector_id
timeseries_id
observed_at
value
value_float8_hex
status
pollutant_code
```

Source status is resolved in this order:

1. `verification_status`;
2. legacy `status`;
3. null.

The owner service applies authoritative metadata resolution, pollutant aliases, upper bounds, public eligibility, state identity, ordering, physical product construction and manifest writing.

Integrity must call the authenticated private owner-service route and must not mutate Latest Snapshot R2 objects directly.

## Execution order

For a real repair that can affect Latest Snapshot, the required stage order is:

1. acquire and validate source evidence;
2. detect gaps and build explicit repair decisions;
3. create and validate local proposals;
4. perform Latest Snapshot authentication capability preflight;
5. perform canonical R2 apply;
6. perform final R2 verification;
7. derive current-state candidates;
8. reconcile timeseries freshness;
9. reconcile Latest Snapshot through the owner service;
10. persist independent target results and calculate overall status.

The preflight occurs before canonical apply, but the actual Latest Snapshot call occurs only after final R2 verification.

## Independent target results

Timeseries freshness and Latest Snapshot are separate durable targets.

Failure of either target:

- does not roll back verified R2 observation history;
- does not roll back a successful update to the other target;
- prevents full run success;
- must be represented as a partial result rather than implying that earlier stages failed;
- remains safely retryable.

Reports must distinguish:

```text
r2_history_status
timeseries_reconciliation_status
latest_snapshot_reconciliation_status
overall_status
```

Correct verified R2 history remains successful even when `overall_status` is failed or partial because a current-state target failed.

## Durable stage audit

Integrity SQLite owns durable stage and target audit evidence.

For each reconciliation-capable run, persist at least:

```text
integrity_run_id
source run identifier
selected connector and pollutant scope
final-verification status and identity
candidate derivation identity or deterministic candidate evidence
timeseries target status and outcome counts
Latest Snapshot target status and outcome counts
attempt count per target
retryable or terminal classification
last bounded error
started and finished timestamps
```

Large candidate detail may remain in bounded SQLite tables or attachments rather than the normal Markdown report.

A successful target must remain recorded as successful when another target fails.

## Resume and retry contract

Integrity must provide an operator-supported current-state resume path for an existing Integrity run.

The default resume behaviour is to retry only failed or pending current-state targets. It must not repeat a successful target unless the operator explicitly requests it.

Before resuming, Integrity must prove that:

1. the referenced run exists;
2. its selected scope and environment match the requested resume;
3. final verified R2 evidence still exists and remains valid;
4. candidate derivation can be reproduced deterministically or persisted candidate evidence is intact;
5. the target has not been superseded by a newer successful reconciliation.

When those checks pass, resume must not repeat:

- source downloads;
- source comparison;
- observation or AQI proposal generation;
- canonical R2 writes;
- manifest or index repair;
- successful current-state targets.

A resume attempt must obtain fresh credentials and reapply normal monotonic and idempotency checks.

If final verified R2 evidence cannot be established, resume fails closed and instructs the operator to run a new scoped Integrity operation.

No permanent reconciliation receipt is required in R2. Integrity SQLite and normal reports own retry evidence.

## Check-only and dry-run

Check-only and dry-run may derive candidates, validate configuration shape and report proposed counts.

They must not:

- invoke mutating RPCs;
- invoke the mutating Latest Snapshot route;
- publish messages;
- write current-state objects;
- mark planned work as completed.

## Same-timestamp ordering and idempotency

For equal timestamps:

```text
same value + same value_float8_hex + same status
  -> no-op

different final verified canonical content
  -> one correction may apply
```

Retrying an already applied correction is a no-op. A later execution time alone must not cause rewrites.

An older candidate never replaces newer current state.

## Audit and reporting

Every reconciliation-capable run records:

```text
enabled
mode
integrity_run_id
selected scope
candidate count and timestamp bounds
timeseries outcomes
Latest Snapshot outcomes
same-timestamp corrections
older and equal candidates skipped
missing identities
preflight status
attempt counts
retryability
warnings
failures
component statuses
```

Authentication failures must be identifiable separately from source, R2, RPC, owner-service application and product-build failures.

## Line-chart relationship

Current-state reconciliation is not required for station-history workers to read canonical R2 history when the sensor identity is known.

Latest Snapshot reconciliation is required for discovery and map/list visibility where stale finite-window state could hide a sensor.

This contract introduces no browser-side direct R2 fallback, SOS-specific chart path or duplicate IngestDB insert.

## Explicit non-goals

This work must not:

- republish repaired observations through the raw observation topic;
- insert repaired observations into IngestDB solely for chart availability;
- change R2 history retention;
- change Prune Daily deletion ownership;
- add O3 to Latest Snapshot;
- change AQI or WHO contracts;
- create missing core identities;
- rewrite connector checkpoints;
- claim a successful source poll;
- turn Integrity into a general current-data ingestion service.

## Validation model

Before implementation, validate structural viability only, plus targeted deterministic checks that are genuinely required for:

- explicit repair-decision scope;
- authentication preflight ordering before canonical mutation;
- independent target status persistence;
- failed-target-only resume;
- idempotent and monotonic retry.

Do not create a broad speculative pre-deployment test suite.

Functional validation occurs after deployment through real CIC-Test operations:

1. refresh local Google credentials;
2. run one recent scoped SOS repair;
3. confirm authentication preflight succeeds before R2 mutation;
4. confirm R2, timeseries and Latest Snapshot all advance as required;
5. repeat the same scope and confirm no rewrites;
6. force or safely simulate a target-only retry condition and confirm only the failed target resumes;
7. run one older-range no-rollback operation;
8. verify a repaired sensor through the normal website route.

## Implementation status

As of 29 July 2026:

- the timeseries reconciliation RPC is deployed in CIC-Test;
- the private Latest Snapshot owner-service reconciliation route is deployed in CIC-Test;
- explicit audience-specific impersonated token acquisition is implemented;
- a real 24 July SOS repair successfully repaired and finally verified R2 observations and AQI history;
- that operation successfully updated 522 timeseries freshness records;
- its Latest Snapshot target failed because the local base-account `gcloud` credentials had expired;
- authentication capability preflight, independent target resume and the modular ownership defined in `integrity_modularisation.md` remain to be implemented.

## Contract-change rule

Changes to current-state ownership, candidate derivation, authentication, preflight ordering, target retry semantics, monotonic ordering, Latest Snapshot identity or same-timestamp correction require coordinated updates to this document and the owning area contract.