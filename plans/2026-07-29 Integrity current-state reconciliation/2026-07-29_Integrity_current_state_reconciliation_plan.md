# Integrity current-state reconciliation implementation plan

**Date:** 29 July 2026  
**Environment:** CIC-Test only  
**Status:** Approved for implementation  
**Primary repository:** `TEST-uk-aq/uk-aq-ops`  
**Schema repository:** `TEST-uk-aq/uk-aq-schema`  
**Recommended Codex model:** GPT-5.6 Codex with High reasoning

# Codex execution prompts

## Master prompt: complete every phase in one continuous implementation

```text
Use GPT-5.6 Codex with High reasoning.

Implement the complete Integrity current-state reconciliation plan in CIC-Test.
/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/plans/2026-07-29 Integrity current-state reconciliation/2026-07-29_Integrity_current_state_reconciliation_plan.md

Work in these TEST repositories only:

- TEST-uk-aq/uk-aq-ops
- TEST-uk-aq/uk-aq-schema where the private database RPC and migration belong

Do not inspect, modify, deploy or configure LIVE repositories or LIVE services.

Read AGENTS.md in each repository before changing anything. Then read the complete authoritative contracts:

- uk-aq-ops/system_docs/r2_history/integrity.md
- uk-aq-ops/system_docs/r2_history/current_state_reconciliation.md
- uk-aq-ops/system_docs/latest_snapshot/README.md
- uk-aq-ops/system_docs/latest_snapshot/contract.md
- uk-aq-ops/system_docs/latest_snapshot/integrity_reconciliation.md
- uk-aq-ops/system_docs/latest_snapshot/state_model.md
- uk-aq-ops/system_docs/latest_snapshot/interfaces.md
- uk-aq-ops/system_docs/latest_snapshot/operations.md
- uk-aq-ops/system_docs/latest_snapshot/validation.md
- uk-aq-ops/system_docs/latest_snapshot/decisions/0004-integrity-reconciliation-through-owner-service.md

Then read this plan in full.

Complete every implementation phase in this plan in order during one continuous task. Do not stop after Phase 0 or any later phase to ask for approval. Do not return a findings-only response. Continue from structural inspection into schema, service, Integrity, configuration and documentation implementation.

Complete all code, migrations, configuration, deployment-workflow changes and documentation status updates before performing any real TEST operational validation. This is a test system, so keep testing minimal.

Before deployment, run only:

1. structural checks needed to prove the migration, route, service invocation and configuration are viable;
2. normal syntax/type checks for files changed;
3. one small deterministic state-transition check covering newer, older, equal and same-timestamp correction behaviour.

Do not add a broad speculative test suite. Do not create browser tests. Do not add mock operational environments.

After all implementation phases are complete, deploy through the existing TEST mechanisms where repository permissions and existing workflows permit. Functional validation must use real CIC-Test operation after deployment, not a pre-deployment simulation.

Preserve all functionality not explicitly changed by the authoritative contracts. Keep the change focused. Do not refactor unrelated R2, ingestion, chart, AQI, WHO or Prune Daily code.

Where an exact file, schema or helper location must be discovered, follow existing repository conventions and continue without asking the operator to choose between equivalent implementation details.

At the end, report:

- files changed in each repository;
- migration and RPC created;
- Latest Snapshot private route and authentication method;
- Integrity integration point and new configuration;
- deployment status;
- minimal checks run;
- any real TEST operation still requiring the operator's source data or command.
```

## Phase 0 prompt: structural inspection and final implementation map

```text
Use GPT-5.6 Codex with High reasoning.

Perform Phase 0 of the Integrity current-state reconciliation plan and then continue automatically into every later phase. Do not stop after reporting findings.

Confirm the exact implementation map for:

- the Integrity point reached only after final source-to-R2 observation verification;
- the canonical final verified rows already available at that point;
- the correct TEST schema and migration location for a private monotonic timeseries RPC;
- existing private RPC naming, grants and service-role conventions;
- the existing Latest Snapshot Cloud Run POST handler and child-job model;
- Cloud Run IAM authentication and the existing authenticated invocation conventions available to the local Integrity runtime;
- the state loader, metadata loader, eligibility policy, state serializer, physical product builder and manifest writer that must be reused;
- the existing one-instance and overlap safety boundary;
- Integrity configuration, reporting and SQLite audit extension points;
- deployment workflow paths and repository variables required for the new route.

The current Cloud Run deployment uses --no-allow-unauthenticated. Prefer Cloud Run IAM identity-token authentication and existing Google credentials over introducing a new shared application secret, unless repository evidence proves that the Integrity runtime cannot use the existing IAM path.

Validate structural viability only. Do not perform a broad test programme. Once the implementation map is clear, continue directly to Phase 1.
```

## Phase 1 prompt: private monotonic timeseries RPC

```text
Use GPT-5.6 Codex with High reasoning.

Implement Phase 1 and then continue automatically.

In TEST-uk-aq/uk-aq-schema, add the private migration and RPC required by system_docs/r2_history/current_state_reconciliation.md.

The RPC must accept a bounded JSON or typed candidate collection containing:

- integrity_run_id
- connector_id
- timeseries_id
- observed_at
- value

For each existing timeseries, atomically:

- update when stored last_value_at is null;
- update when candidate observed_at is newer;
- update last_value when observed_at is equal and the canonical value differs;
- skip when timestamp and value are equal;
- skip when the candidate is older;
- never create a missing timeseries;
- never change first_value_at, identity, lifecycle, checkpoint or ingest-run fields.

Return deterministic aggregate outcome counts required by the contract.

Follow the existing private-schema, SECURITY DEFINER/INVOKER, search_path, grants and service-role conventions. Do not expose the RPC to anon or authenticated website roles.

Add only the smallest SQL-level deterministic check genuinely needed to establish monotonic and same-timestamp behaviour if the repository has an established migration validation pattern. Do not add a broad database test suite.

Continue to Phase 2 after the migration and RPC are complete.
```

## Phase 2 prompt: Latest Snapshot owner-service reconciliation

```text
Use GPT-5.6 Codex with High reasoning.

Implement Phase 2 and then continue automatically.

In TEST-uk-aq/uk-aq-ops, extend the existing Latest Snapshot Cloud Run service with one authenticated internal reconciliation POST route owned by the same service.

Use Cloud Run IAM authentication. Preserve --no-allow-unauthenticated. Do not add a public cache-proxy route and do not introduce a new shared bearer secret unless Phase 0 repository evidence makes IAM invocation structurally impossible.

The route must accept schema_version=1, integrity_run_id and bounded candidates containing:

- connector_id
- timeseries_id
- observed_at
- value
- value_float8_hex
- status
- pollutant_code

Requirements:

- only pm25, pm10 and no2 are eligible;
- caller pollutant evidence must agree with resolved metadata;
- reuse the existing metadata cache and latest-current-value policy;
- reuse state identity connector_id + timeseries_id;
- newer eligible rows replace older state;
- older rows do not replace newer state;
- identical same-timestamp value, value_float8_hex and status are a no-op;
- different final verified same-timestamp canonical content may replace stale content once;
- retrying that correction is a no-op;
- reconciliation must strictly fail if durable state cannot be loaded reliably;
- do not use the existing empty-state fallback for reconciliation read failures;
- normal scheduled Pub/Sub behaviour must remain unchanged unless a minimal shared helper can preserve it exactly;
- state writes remain hash-gated and durable R2 succeeds before local cache write-through;
- when state changes, and also when state is already correct but products need recovery, run the normal physical all-product and manifest build path;
- preserve the public v2 contract and finite-window derivation;
- preserve single-instance and overlap safety;
- do not consume, publish or acknowledge Pub/Sub messages on this route.

The route response and structured summary must include the contracted candidate, state and product outcome counts, plus integrity_run_id.

Refactor only enough to share the existing state-to-product build implementation. Do not duplicate the complete builder or create a second writer script.

Add one small deterministic test or extend the existing latest_state_core_test.ts to cover:

- newer replacement;
- older skip;
- equal identical no-op;
- equal corrected content applied once;
- repeated correction no-op.

Keep existing service tests and normal type checks. Do not add integration mocks or a broad new suite.

Continue to Phase 3.
```

## Phase 3 prompt: Integrity integration, configuration and reporting

```text
Use GPT-5.6 Codex with High reasoning.

Implement Phase 3 and then continue automatically.

Extend scripts/uk-aq-history-integrity in TEST-uk-aq/uk-aq-ops.

Run current-state reconciliation only after the selected scope has passed the final authoritative source-to-R2 verification boundary.

Implement:

1. one raw latest candidate per affected timeseries for the private timeseries RPC;
2. one latest eligible valid candidate per affected pm25, pm10 and no2 timeseries for Latest Snapshot;
3. verification_status, then legacy status, then null mapping into the Latest Snapshot status field;
4. no Latest Snapshot candidate for o3;
5. check-only and dry-run planning without mutation;
6. real-run invocation of the private database RPC;
7. real-run invocation of the Latest Snapshot Cloud Run IAM-protected reconciliation route;
8. idempotent retry when R2 history is already correct but a prior reconciliation failed;
9. separate component status and audit outcomes;
10. bounded report detail and SQLite evidence.

Add configuration following existing environment-file conventions. Prefer names such as:

- UK_AQ_INTEGRITY_CURRENT_STATE_RECONCILIATION_ENABLED
- UK_AQ_INTEGRITY_TIMESERIES_RECONCILIATION_RPC
- UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_URL
- UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_AUDIENCE
- UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_TIMEOUT_SECONDS

Use repository conventions if established names are more appropriate.

For Cloud Run IAM invocation, reuse an existing Google identity-token helper or add one focused helper. It must use the service URL as the default audience and work with the existing authenticated TEST operator/service-account environment. Do not log tokens or credentials.

The result must distinguish:

- r2_history_status
- timeseries_reconciliation_status
- latest_snapshot_reconciliation_status
- overall_status

A failed reconciliation must not undo verified R2 history, but it must prevent full status=ok.

Do not update connector checkpoints, ingest-run success records or Prune Daily deletion gates.

Continue to Phase 4.
```

## Phase 4 prompt: workflows, environment templates and operational wiring

```text
Use GPT-5.6 Codex with High reasoning.

Implement Phase 4 and then continue automatically.

Update TEST deployment and environment wiring required for the completed code.

Latest Snapshot:

- preserve --no-allow-unauthenticated;
- include all new service files in Dockerfile and deno check/test commands;
- keep max instances at 1;
- keep the current concurrency safety rules;
- add only required non-secret environment settings;
- do not add a new application secret when IAM authentication is used;
- ensure the service account or intended Integrity caller has roles/run.invoker through the repository's existing infrastructure or documented operator command, without granting public invocation.

Integrity:

- add environment template and example entries without credentials;
- document the expected Google identity available on the Integrity machine;
- add a clear startup/configuration failure when reconciliation is enabled but required URL/RPC/auth configuration is absent;
- keep reconciliation configurable so it can be disabled independently of R2 history repair.

Schema:

- ensure the TEST migration can be applied through the repository's normal deployment process;
- preserve existing schema ownership and grants.

Do not alter Cloud Scheduler cadence, service CPU, memory, timeout, network routes or public APIs unless the new route structurally requires a small timeout/configuration addition.

Continue to Phase 5.
```

## Phase 5 prompt: documentation completion and implementation status

```text
Use GPT-5.6 Codex with High reasoning.

Implement Phase 5 and then continue automatically.

Update the authoritative system docs to match the actual implemented names and behaviour.

At minimum review and update where required:

- system_docs/r2_history/current_state_reconciliation.md
- system_docs/r2_history/README.md
- system_docs/r2_history/integrity.md
- system_docs/latest_snapshot/README.md
- system_docs/latest_snapshot/contract.md
- system_docs/latest_snapshot/integrity_reconciliation.md
- system_docs/latest_snapshot/interfaces.md
- system_docs/latest_snapshot/operations.md
- system_docs/latest_snapshot/recovery.md
- system_docs/latest_snapshot/validation.md
- system_docs/latest_snapshot/decisions/0004-integrity-reconciliation-through-owner-service.md
- relevant environment and deployment inventories

Replace pending implementation wording only when code and configuration are actually complete. Record exact route, RPC, environment names, authentication, response fields, failure behaviour and rollback switch.

Do not create duplicate authoritative documents. Keep worker READMEs subordinate to system_docs.

Continue to Phase 6.
```

## Phase 6 prompt: complete implementation checks, deploy TEST, then minimal real validation

```text
Use GPT-5.6 Codex with High reasoning.

Complete Phase 6 after every earlier implementation phase is finished.

Before deployment, run only:

- normal syntax/type checks for changed Python, TypeScript, JavaScript, workflow and SQL files;
- existing focused Latest Snapshot service tests;
- the targeted deterministic state-transition test;
- structural migration and environment validation.

Do not add or run a broad speculative test suite.

Deploy to CIC-Test through the existing TEST workflows and migration process where permissions permit. Do not deploy LIVE.

After deployment, perform the smallest real operational checks available without inventing source data:

1. invoke the private Latest Snapshot reconciliation route with one safe TEST candidate or a no-op candidate and verify authentication, response shape and no rollback;
2. verify a later normal scheduled Latest Snapshot run still succeeds;
3. when an authoritative SOS Integrity repair scope is available, run one real recent repair and verify timeseries and Latest Snapshot outcomes;
4. repeat the same scope once to verify idempotent no-op outcomes;
5. use one older selected range to verify no rollback only if that can be done without broad extra source acquisition;
6. verify one normal station-history or website line-chart response reads the repaired R2 observation when the sensor identity is known.

Do not delay completing code because the operator's real SOS source scope is not available. Clearly report which post-deployment real operation remains for the operator.
```

# Implementation plan

## 1. Objective

Extend R2 History Integrity so that final verified canonical observation repairs can reconcile:

```text
timeseries.last_value_at
timeseries.last_value
Latest Snapshot durable latest-valid state
Latest Snapshot physical all products and manifest
```

The immediate use case is a UK-AIR SOS outage where authoritative annual flat files allow R2 history repair through yesterday, while normal ingest-driven current state remains stale.

## 2. Approved architecture

### 2.1 Observation history

R2 v2 observation history remains owned by the existing Integrity repair pipeline.

No changes are made to source authority, canonical observation rules, overlay construction, scoped R2 mutation, manifest/index verification or Prune Daily ownership.

### 2.2 Timeseries freshness

A private schema-owned RPC performs monotonic conditional updates to `timeseries.last_value_at` and `timeseries.last_value`.

Integrity does not perform unrestricted table updates.

### 2.3 Latest Snapshot

The existing Latest Snapshot Cloud Run service remains the only owner and writer of durable Latest Snapshot state, physical pollutant products and the manifest.

Integrity calls one private Cloud Run IAM-protected reconciliation route after final R2 verification.

No new public route, application secret, worker or direct R2 writer is introduced.

### 2.4 Line chart

No line-chart code change is planned.

The station-history system continues using its normal recent stable head and R2 history paths. Repaired R2 history should be available when the timeseries identity is known.

Latest Snapshot reconciliation remains necessary so stale map and sensor-list rows do not prevent the normal user journey into the chart.

## 3. Scope

### Included

- `pm25`, `pm10`, `no2` and `o3` raw timeseries freshness reconciliation;
- `pm25`, `pm10` and `no2` Latest Snapshot reconciliation;
- same-timestamp final verified correction handling;
- check-only and dry-run planning;
- real-run mutation after final verification;
- idempotent retry;
- separate component status and audit evidence;
- TEST schema, service, workflow and environment wiring;
- authoritative documentation updates.

### Excluded

- LIVE deployment;
- O3 Latest Snapshot support;
- republishing raw observation messages;
- duplicate IngestDB observation inserts;
- connector checkpoint changes;
- Prune Daily gate changes;
- AQI or WHO calculation changes;
- website or line-chart rendering changes;
- broad refactoring or speculative testing.

## 4. Required pre-implementation structural inspection

Codex must locate and confirm:

1. the final source-to-R2 verification boundary in the active Integrity orchestrator;
2. the final canonical rows or deterministic means of deriving candidates without rereading unverified content;
3. the private schema and RPC migration conventions in `uk-aq-schema`;
4. the normal service-role caller and grants;
5. the Latest Snapshot route handler and child-job execution model;
6. the existing Cloud Run IAM deployment and invocation model;
7. the state loader, eligibility policy, metadata index, serializer, product builder and manifest writer;
8. the exact reporting and SQLite extension points;
9. the normal TEST deployment process for schema and Cloud Run.

This phase must continue directly into implementation. It is not a findings-only phase.

## 5. Database RPC design

## 5.1 Candidate input

The RPC accepts a bounded candidate set with:

```text
integrity_run_id
connector_id
timeseries_id
observed_at
value
```

The exact SQL type may use JSONB or a repository-standard typed structure. It must support one transactional call per bounded batch rather than one HTTP request per timeseries.

## 5.2 Update rules

For each candidate:

```text
stored last_value_at IS NULL
  -> update timestamp and value

candidate observed_at > stored last_value_at
  -> update timestamp and value

candidate observed_at = stored last_value_at
AND candidate value IS DISTINCT FROM stored last_value
  -> update value as a same-timestamp correction

candidate observed_at = stored last_value_at
AND candidate value IS NOT DISTINCT FROM stored last_value
  -> no-op

candidate observed_at < stored last_value_at
  -> no-op
```

Comparisons and update must be atomic.

## 5.3 Missing identity

A missing timeseries is reported. The RPC must not create it or infer identity.

## 5.4 Outcome counts

Return at least:

```text
candidate_count
updated_newer_count
updated_same_timestamp_correction_count
skipped_equal_count
skipped_older_count
missing_timeseries_count
failed_count
```

## 5.5 Privileges

Follow the repository's existing private RPC and service-role conventions.

Do not grant execution to public website roles.

## 6. Latest Snapshot service design

## 6.1 Route and authentication

Add one internal POST route to the existing service.

The Cloud Run service already deploys with:

```text
--no-allow-unauthenticated
```

Retain this. Use Cloud Run IAM identity-token invocation.

The local Integrity environment must use its intended Google account or service account with `roles/run.invoker` on the TEST Latest Snapshot service.

Do not add a second application-level shared token unless Phase 0 proves IAM is unavailable to the supported Integrity runtime.

## 6.2 Request

```json
{
  "schema_version": 1,
  "integrity_run_id": "...",
  "candidates": [
    {
      "connector_id": 1,
      "timeseries_id": 123,
      "observed_at": "2026-07-28T23:00:00.000Z",
      "value": 12.5,
      "value_float8_hex": "...",
      "status": "P",
      "pollutant_code": "pm25"
    }
  ]
}
```

The implementation must bound candidate count and body size.

## 6.3 Strict state load

The current scheduled job may fall back to an empty map when state loading throws.

The reconciliation route must not do this.

It must fail before candidate application when durable state cannot be read and validated reliably.

Prefer an explicit strict state-load option or helper so the normal scheduled path remains unchanged unless there is a separately justified tightening.

## 6.4 Eligibility and metadata

Use the existing metadata cache and latest-value policy.

Caller `pollutant_code` must agree with resolved timeseries metadata.

Do not trust caller metadata as a substitute for the authoritative core snapshot.

## 6.5 Ordering and corrections

Different timestamps retain the existing monotonic ordering.

For equal timestamps compare:

```text
value
value_float8_hex
status
```

Identical content is a no-op.

Different final verified content is applied once.

A later identical retry is a no-op even though the retry wall-clock time is newer.

## 6.6 Shared product build

The reconciliation route must reuse the normal state-to-product and manifest build path.

It must not duplicate the full run job.

A focused refactor may separate:

- message acquisition and acknowledgement;
- state candidate application;
- durable state persistence;
- physical product and manifest build.

Normal scheduled behaviour must remain functionally unchanged.

## 6.7 Response

Return at least:

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

State success followed by a product or manifest failure is a partial durable outcome and must be reported clearly.

## 7. Integrity integration

## 7.1 Integration boundary

Run reconciliation only after:

1. source acquisition and identity pinning;
2. canonical comparison and repair planning;
3. local replacement validation;
4. real scoped R2 apply;
5. post-write Parquet and manifest GET verification;
6. parent manifest and index repair;
7. final source-to-R2 verification.

## 7.2 Raw candidates

For each affected timeseries, choose the greatest final verified canonical `observed_at`.

Raw candidates may include finite negative values because timeseries freshness describes raw source state.

## 7.3 Latest-valid candidates

For each affected `pm25`, `pm10` or `no2` timeseries, provide final verified candidate evidence to the owner service.

Integrity may reduce to the latest likely candidate per timeseries, but the owner service remains authoritative for eligibility.

A newer invalid observation must not displace an earlier valid retained public row.

If candidate derivation needs multiple rows to determine the latest valid source row, use the verified final canonical collection, not unverified R2 or current database metadata.

## 7.4 Status mapping

Resolve candidate status in this order:

```text
verification_status
legacy status
null
```

Supply the result through Latest Snapshot's existing `status` field.

## 7.5 IAM invocation

Use an identity token whose audience defaults to the reconciliation service URL.

Reuse an existing Google authentication helper where available.

Never log identity tokens, service-account JSON or credential paths.

## 7.6 Retry

A real rerun may perform current-state reconciliation even when R2 history no longer needs mutation, provided final verified source-to-R2 evidence still agrees.

This supports recovery after:

- timeseries RPC failure;
- Cloud Run invocation failure;
- client timeout after durable state success;
- state success followed by product failure.

## 7.7 Check-only and dry-run

Derive and report proposed candidates, but do not call either mutation target.

## 8. Reporting and SQLite audit

Add component status:

```text
r2_history_status
timeseries_reconciliation_status
latest_snapshot_reconciliation_status
overall_status
```

Add bounded reconciliation evidence including:

```text
enabled
planned
attempted
candidate_count
candidate_observed_at_min
candidate_observed_at_max
timeseries outcomes
Latest Snapshot outcomes
warnings
failures
```

Per-timeseries detail may be stored in SQLite or a bounded attachment.

A required reconciliation failure prevents complete `status=ok`, but must not misreport verified R2 history as rolled back.

## 9. Configuration

Use existing environment-file conventions.

Expected settings are:

```text
UK_AQ_INTEGRITY_CURRENT_STATE_RECONCILIATION_ENABLED
UK_AQ_INTEGRITY_TIMESERIES_RECONCILIATION_RPC
UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_URL
UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_AUDIENCE
UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_TIMEOUT_SECONDS
```

Codex may use more established repository naming where discovered, but documentation and templates must match implementation exactly.

When reconciliation is disabled, existing Integrity behaviour remains unchanged.

## 10. Deployment order

Complete all implementation phases before starting deployment.

Then deploy in this order:

1. apply the TEST schema migration and private RPC;
2. deploy the TEST Latest Snapshot Cloud Run service and workflow changes;
3. grant the intended TEST Integrity caller Cloud Run invoker permission if not already present;
4. update the Integrity machine's TEST environment configuration;
5. run a non-mutating configuration or check-only operation;
6. perform the smallest real TEST reconciliation operation available.

Do not deploy LIVE.

## 11. Minimal validation

## 11.1 Before deployment

Only:

- syntax and type checks for changed files;
- structural SQL/migration validation;
- existing focused service tests;
- one deterministic state-transition check.

No browser tests. No broad integration mocks. No speculative suite.

## 11.2 After deployment

Use real CIC-Test operations:

1. one recent SOS repair from authoritative cached source files;
2. verify `timeseries.last_value_at` and `last_value` advance;
3. verify Latest Snapshot state and public finite response advance for eligible pollutants;
4. repeat the same scope and verify no-op outcomes;
5. verify an older candidate cannot roll back state;
6. verify a normal scheduled Latest Snapshot run still succeeds;
7. verify one normal chart request reads the repaired R2 observation when identity is known.

If the real SOS source scope is not available during Codex execution, complete all code and deployment work and state the exact operator command still required.

## 12. Failure and recovery

### R2 history succeeds, timeseries fails

Keep verified R2 history. Report timeseries failure and overall partial/failed status. Retry reconciliation later.

### Timeseries succeeds, Latest Snapshot fails

Keep the monotonic timeseries update. Report Latest Snapshot failure. Retry owner-service reconciliation later.

### Latest Snapshot state succeeds, products fail

Report the partial durable state outcome. Retry must reload state, no-op identical candidates and rebuild products and manifest.

### Client timeout

Retry safely using the same candidates and Integrity run evidence. State comparisons must prevent duplicate rewrites.

### Disable switch

Allow current-state reconciliation to be disabled independently while preserving normal Integrity R2 history repair.

Do not reverse valid newer timeseries or Latest Snapshot state during rollback.

## 13. Completion criteria

Implementation is complete when:

1. the TEST schema contains the private monotonic timeseries RPC;
2. the existing TEST Latest Snapshot service exposes the IAM-protected reconciliation route;
3. Integrity derives candidates only from final verified canonical observations;
4. check-only and dry-run remain non-mutating;
5. real runs call both reconciliation targets after final R2 verification;
6. older candidates cannot roll back either target;
7. same-timestamp corrections apply once and retries are no-ops;
8. Latest Snapshot remains the sole R2 state and product writer;
9. O3 remains outside Latest Snapshot;
10. component statuses and audit evidence are separate;
11. normal scheduled Latest Snapshot operation remains unchanged;
12. no line-chart code or browser fallback is added;
13. authoritative system docs describe the exact implemented interface;
14. only minimal TEST validation is used.
