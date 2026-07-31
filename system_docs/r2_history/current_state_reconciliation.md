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
- making a failed downstream target look like an R2 repair failure.

## Operational recovery rule

Integrity runs are immutable operational records and are not resumed.

After correcting a failure, the operator starts a new appropriately scoped Integrity operation. The new run uses current source evidence, mappings, configuration, authentication and R2 state.

Normal repair and current-state reconciliation must remain idempotent or monotonic so that a new run:

- skips already-correct canonical R2 objects;
- does not move timeseries current state backwards;
- does not move Latest Snapshot state backwards;
- treats identical same-timestamp content as a no-op;
- may apply one final verified same-timestamp correction when canonical content differs.

There is no supported CLI or hidden entrypoint for replaying candidates from an earlier Integrity run. Failed runs remain unchanged as historical audit evidence.

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

The canonical observation collection that passed source comparison or direct selected-partition source validation, proposal validation, real R2 apply verification and final source-to-R2 verification for the selected scope.

For partition-scoped direct replacement, this collection is the union of every successfully verified selected partition. It is not the contents of a mutable connector-day staging directory and is not limited to the last processed pollutant.

### Raw latest candidate

The final verified canonical observation with the greatest `observed_at` for one affected timeseries.

### Latest valid candidate

The final verified canonical observation with the greatest `observed_at` for one affected timeseries after Latest Snapshot public-value eligibility has been applied.

The latest valid candidate may be earlier than the raw latest candidate when the raw latest observation is not publicly eligible.

### Same-timestamp correction

A candidate whose `observed_at` equals stored current state but whose canonical value, binary value identity or preserved status differs.

### Monotonic update

An update that never replaces current state with an earlier observation.

## Authoritative candidate-evidence contract

Current-state candidates must be derived from final verified canonical evidence, not from incidental staging state.

For the dedicated SOS direct-replacement path, Integrity must:

1. enumerate every selected `day_utc + connector_id + pollutant_code` partition;
2. include canonical rows only from partitions whose complete replacement passed proposal validation, ordered R2 apply and final changed-object verification;
3. union the successful verified partitions across the complete selected run scope;
4. compact that union independently for Timeseries and Latest Snapshot.

Integrity must not derive candidates from:

- only the last processed pollutant;
- a shared connector-day source-evidence directory that is overwritten between partitions;
- an unverified proposal;
- a failed or blocked partition;
- an all-unmapped partition that was deliberately left unchanged;
- generic gap results when the dedicated direct-replacement route is active.

An authoritative no-data replacement is a successful verified partition with zero canonical rows. It contributes no current-state candidate and does not make candidate derivation fail.

A selected partition that is skipped because all source rows lack authoritative bindings contributes no candidate because its existing R2 contents were not replaced or verified by that operation.

The verified evidence identity for the dedicated path remains:

```text
day_utc + connector_id + pollutant_code
```

Candidate derivation must not introduce a broad live R2 rescan.

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
- canonical R2 mutation is genuinely planned;
- proposal validation succeeded;
- the Latest Snapshot target is enabled.

The preflight must:

1. validate the configured URL and audience;
2. invoke the same audience-specific identity-token helper used by the final call;
3. use the configured account and impersonated service account explicitly where configured;
4. discard the token without logging it;
5. fail the run before canonical R2 writes when token acquisition fails.

The preflight is a capability check, not reusable authentication state. The final Latest Snapshot invocation must obtain a fresh audience-specific token again.

An O3-only run does not require Latest Snapshot authentication preflight.

Check-only and dry-run may validate configuration shape but must not require an interactive credential refresh or invoke a mutating target.

A successful preflight cannot guarantee that credentials, IAM, network access or the owner service remain available later. A later target failure is recorded independently, and recovery is a new scoped Integrity run.

## Timeseries candidate and mutation contract

Across the complete successful verified repair scope, Integrity must derive exactly one raw latest candidate per affected timeseries.

Candidate compaction considers all supported verified rows for that timeseries across every successful selected day and pollutant partition, then selects the greatest `observed_at` using deterministic canonical tie handling.

Each candidate contains:

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

Integrity must submit the compacted candidate to the owner RPC even when a preliminary read suggests that stored `last_value_at` is later or equal. Integrity must not duplicate the RPC's durable-state comparison or use current Timeseries state as a submission gate.

For an existing timeseries, the RPC atomically:

1. updates when `last_value_at` is null;
2. updates when the candidate is newer;
3. corrects `last_value` when the timestamp is equal but canonical value differs;
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

Across the complete successful verified repair scope, Integrity must derive exactly one latest valid candidate per supported affected timeseries.

Integrity must not send every historical observation to the owner service. For each supported timeseries it must:

1. consider all verified canonical rows across all successful selected partitions;
2. apply the shared Latest Snapshot public-current-value eligibility semantics used for candidate compaction;
3. select the greatest eligible `observed_at`;
4. retain deterministic same-timestamp correction evidence;
5. send only that compacted candidate.

When the raw latest observation is ineligible but an earlier observation is eligible, Timeseries receives the raw latest observation and Latest Snapshot receives the earlier latest eligible observation.

Integrity supplies each compacted candidate to the Latest Snapshot owner service as:

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

The owner service remains the final authority for metadata resolution, pollutant aliases, upper bounds, public eligibility, state identity, ordering, physical product construction and manifest writing. It must revalidate every submitted candidate.

Integrity must submit the compacted Latest Snapshot candidate independently of Timeseries state and independently of the Timeseries reconciliation outcome. A later or equal `timeseries.last_value_at` must not suppress Latest Snapshot submission.

Integrity must call the authenticated private owner-service route and must not mutate Latest Snapshot R2 objects directly.

## Execution order

For a real repair that can affect Latest Snapshot, the required stage order is:

1. acquire and validate source evidence;
2. establish the explicit selected-partition repair scope and decisions;
3. create and validate local proposals;
4. perform Latest Snapshot authentication capability preflight;
5. perform canonical R2 apply;
6. perform final R2 verification;
7. assemble all successful verified partition evidence;
8. derive and compact current-state candidates;
9. reconcile timeseries freshness;
10. reconcile Latest Snapshot through the owner service;
11. persist independent target results and calculate overall status.

The preflight occurs before canonical apply, but the actual Latest Snapshot call occurs only after final R2 verification.

## Independent target results

Timeseries freshness and Latest Snapshot are separate durable targets.

Failure of either target:

- does not roll back verified R2 observation history;
- does not roll back a successful update to the other target;
- prevents full run success;
- must be represented without implying that earlier stages failed;
- remains visible in the immutable run record.

Reports must distinguish:

```text
r2_history_status
timeseries_reconciliation_status
latest_snapshot_reconciliation_status
overall_status
```

Correct verified R2 history remains successful even when `overall_status` is failed or partial because a current-state target failed.

A later new scoped run may safely reconcile the same state again through normal monotonic and idempotent rules.

## Durable stage audit

Integrity SQLite owns durable stage and target audit evidence.

For each reconciliation-capable run, persist at least:

```text
integrity_run_id
selected connector and pollutant scope
final-verification status and identity
verified partition count and identities
verified canonical rows examined by pollutant
candidate identity or deterministic candidate evidence
candidate counts before and after compaction
candidate counts by pollutant
timeseries target status and outcome counts
Latest Snapshot target status and outcome counts
bounded target errors
started and finished timestamps
```

Timeseries audit must distinguish raw rows examined from compacted candidate count.

Latest Snapshot audit must distinguish supported rows examined, ineligible rows excluded, latest-raw-ineligible fallbacks and compacted candidate count.

Timeseries and Latest Snapshot target outcomes are recorded independently. A successful target remains recorded as successful when another target fails.

Existing candidate-set or target-attempt tables may remain for historical compatibility. They must not provide an active replay or resume interface.

Large candidate detail may remain in bounded SQLite tables or attachments rather than the normal Markdown report.

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

Candidate compaction must retain the authoritative corrected content. If final verified evidence contains irreconcilable competing canonical content for one timeseries and timestamp, candidate derivation fails closed for that target scope.

Repeating an already applied correction in a later new run is a no-op. A later execution time alone must not cause rewrites.

An older candidate never replaces newer current state.

## Audit and reporting

Every reconciliation-capable run records:

```text
enabled
mode
integrity_run_id
selected scope
verified partition evidence count and pollutant coverage
raw and supported rows examined
candidate count before and after compaction
candidate counts by pollutant and timestamp bounds
timeseries outcomes
Latest Snapshot outcomes
same-timestamp corrections
older and equal candidates skipped
latest-raw-ineligible fallback count
missing identities
preflight status
warnings
failures
component statuses
```

Authentication failures must be identifiable separately from source, R2, RPC, owner-service application and product-build failures.

A report-generation error must never mask the original Integrity failure. Early-failure summaries must use safe defaults for fields that may not yet be available.

## Line-chart relationship

Current-state reconciliation is not required for station-history workers to read canonical R2 history when the sensor identity is known.

Latest Snapshot reconciliation is required for discovery and map/list visibility where stale finite-window state could hide a sensor.

This contract introduces no browser-side direct R2 fallback.

## Validation model

Before deployment, use only the smallest structural and targeted deterministic checks required to establish:

- all successful verified pollutant partitions contribute candidates;
- failed, unverified and all-unmapped partitions do not contribute candidates;
- one latest raw Timeseries candidate is produced per timeseries;
- one latest eligible Latest Snapshot candidate is produced per supported timeseries;
- a later ineligible raw row does not hide an earlier eligible Latest Snapshot candidate;
- Timeseries state does not gate Latest Snapshot submission;
- authentication command construction;
- preflight ordering;
- independent target status handling;
- monotonic timeseries updates;
- Latest Snapshot same-timestamp correction and idempotency;
- failure reporting that preserves the original error.

Functional validation occurs through real CIC-Test operations.

A representative successful operation must cover:

- a real multi-pollutant supported repair;
- authentication preflight before canonical mutation;
- final R2 verification;
- Timeseries candidate coverage for PM2.5, PM10, NO2 and O3;
- Latest Snapshot candidate coverage for PM2.5, PM10 and NO2 only;
- one compacted candidate per timeseries for each target;
- timeseries reconciliation;
- Latest Snapshot reconciliation;
- a later new run that safely skips or no-ops already-correct state where applicable.

Do not require replaying or resuming an earlier failed run.

## Implementation status

Implemented and exercised in CIC-Test on 29 July 2026:

- explicit audience-specific impersonated identity-token acquisition;
- authentication capability preflight before canonical R2 mutation;
- fresh token acquisition for the actual Latest Snapshot invocation;
- independent Timeseries and Latest Snapshot outcome recording;
- successful end-to-end SOS repair through final current-state reconciliation.

Contract clarified on 31 July 2026 for dedicated partition-scoped repair:

- all successful verified pollutant-scoped evidence must be consumed;
- Timeseries must receive one latest raw candidate per timeseries;
- Latest Snapshot must receive one latest eligible candidate per supported timeseries;
- Timeseries state and outcome must not gate Latest Snapshot submission.

The attempted legacy run-resume path added disproportionate evidence-reconstruction complexity and was rejected as an operational requirement. Recovery is now a new appropriately scoped Integrity run.
