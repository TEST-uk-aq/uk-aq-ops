# Integrity current-state reconciliation plan

**Proposed path**

`plans/2026-07-28_integrity_current_state_reconciliation/2026-07-28_integrity_current_state_reconciliation_plan.md`

**Status:** Draft
**Environment:** CIC-Test only
**Implementation model:** GPT-5.6 Codex with High reasoning

## 1. Purpose

Extend History Integrity so that a successfully verified observation repair can also reconcile the current-state records that would normally have been advanced by ingestion.

The first use case is a UK-AIR SOS outage where authoritative annual flat files allow Integrity to repair R2 observation history through yesterday, while the following remain stale:

* `timeseries.last_value_at`;
* `timeseries.last_value`;
* Latest Snapshot durable state;
* Latest Snapshot public pollutant products.

This work must not turn Integrity into a second general-purpose ingest pipeline.

## 2. Required architecture

### 2.1 R2 observation history

R2 v2 observation history remains owned by the existing Integrity repair pipeline.

Current detection, repair planning, overlay construction, scoped mutation, post-write GET verification, manifest rebuilding and index rebuilding remain unchanged.

### 2.2 Timeseries freshness

The schema/database layer owns mutation of:

```text
timeseries.last_value_at
timeseries.last_value
```

Integrity must call a narrowly scoped RPC rather than issuing unrestricted table updates.

The RPC must apply monotonic conditional updates and return detailed result counts.

### 2.3 Latest Snapshot

Latest Snapshot remains the sole owner of:

```text
latest_snapshots_state/v1/latest_state.json
latest_snapshots/v2/network_group=all/pollutant=<pollutant>/window=all.json
latest_snapshots/v2/manifest.json
```

Integrity must not write those objects directly.

The existing Latest Snapshot Cloud Run service must gain an authenticated Integrity reconciliation mode. That mode must use the same state policy, metadata resolution, R2 state writer, product builder and manifest writer used by normal scheduled operation.

### 2.4 Line chart

No line-chart architecture change is planned.

The station-history worker continues reading the recent stable head and the required R2 observation-history segments. A TEST operational check will confirm that an SOS observation repaired into R2 appears in a normal line-chart request even when the equivalent IngestDB row is absent.

## 3. Phase 0: structural viability

Perform only the checks needed to confirm that the design can be implemented safely.

### 3.1 Integrity integration point

Identify the exact point after:

1. selected observation data has been written;
2. written Parquet has been GET-read and hash-verified;
3. pollutant manifests have been GET-verified;
4. connector and day manifests have been rebuilt;
5. affected indexes have been rebuilt;
6. final canonical verification has succeeded.

Current-state reconciliation must not run before this boundary.

### 3.2 Database write path

Confirm:

* the authoritative schema containing `timeseries`;
* the current privileges available to Integrity;
* the existing migration and RPC conventions;
* whether the RPC belongs in `uk_aq_private`, `uk_aq_ops` or another established private schema;
* the exact numeric type of `last_value`;
* the existing timestamp precision and update behaviour.

### 3.3 Latest Snapshot service path

Confirm:

* the service route through which an authenticated reconciliation request can be accepted;
* that scheduled and reconciliation operations pass through the same single-writer service;
* that TEST remains configured with one maximum instance and safe concurrency;
* that the request can reach the normal state-to-product build path without exposing a public mutation endpoint;
* whether the existing internal manifest source fields can remain compatible.

### 3.4 Targeted deterministic check

One targeted pre-deployment check is genuinely required for Latest Snapshot state ordering.

It must prove that:

* a strictly newer eligible observation replaces older state;
* an older observation cannot replace newer state;
* identical content at the same observation timestamp is a no-op;
* corrected content at the same observation timestamp may replace stale content once;
* retrying that same correction is a no-op.

Do not add a broad speculative test suite.

## 4. Phase 1: establish contracts

Before implementation, add the current-state reconciliation contract under:

```text
system_docs/r2_history/current_state_reconciliation.md
```

Update the reading order and related-document links in:

```text
system_docs/r2_history/README.md
system_docs/r2_history/integrity.md
```

Amend the Latest Snapshot authoritative area only where necessary to permit an authenticated reconciliation input while preserving Latest Snapshot ownership:

```text
system_docs/latest_snapshot/contract.md
system_docs/latest_snapshot/interfaces.md
system_docs/latest_snapshot/operations.md
system_docs/latest_snapshot/validation.md
```

The documentation must clearly separate:

* canonical raw observation history;
* timeseries freshness metadata;
* latest valid public current state.

## 5. Phase 2: add the timeseries reconciliation RPC

Add a schema-owned RPC that accepts a bounded set of candidate rows containing:

```text
integrity_run_id
connector_id
timeseries_id
observed_at
value
```

The RPC must lock or conditionally update each target row safely.

### 5.1 Candidate rule

For each affected timeseries, Integrity derives the latest canonical raw observation from the final verified observation collection.

This candidate is not filtered through Latest Snapshot public-value eligibility. A finite negative source value remains valid raw observation history and may remain the raw `timeseries.last_value`.

### 5.2 Update rule

Update when:

```text
stored last_value_at is null
OR candidate observed_at > stored last_value_at
OR candidate observed_at = stored last_value_at
   AND candidate value differs from stored last_value
```

Do not update when the candidate timestamp is older.

An identical timestamp and value must be a no-op.

### 5.3 RPC response

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

A missing timeseries identity must not be created by this RPC.

## 6. Phase 3: add Latest Snapshot reconciliation mode

Add an authenticated internal reconciliation mode to the existing Latest Snapshot service.

### 6.1 Input

The request contains a bounded candidate collection with:

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

For the existing state schema, canonical Integrity `verification_status` is mapped to the state field currently named `status`.

### 6.2 Candidate derivation

Integrity must:

1. use only final verified canonical observations;
2. filter to the Latest Snapshot pollutant matrix of `pm25`, `pm10` and `no2`;
3. apply or request application of the authoritative Latest Snapshot value-eligibility policy;
4. choose the latest eligible valid candidate for each `(connector_id, timeseries_id)`;
5. exclude `o3` because it is outside the current public Latest Snapshot matrix.

A later invalid observation must not displace an earlier valid current value.

### 6.3 State application

The Latest Snapshot service must:

* load the durable R2 state;
* fail rather than treating an unexpected state-read failure as an empty authoritative state;
* resolve metadata through the existing metadata cache;
* use the existing state identity `(connector_id, timeseries_id)`;
* reject unsupported pollutants and invalid current values;
* prevent older candidates from replacing newer state;
* treat identical same-timestamp content as a no-op;
* allow a verified same-timestamp correction to replace stale content;
* write durable R2 state before reporting success;
* rebuild the normal physical `all` products;
* rebuild and write the normal manifest;
* preserve all existing public v2 payload and route contracts.

### 6.4 Concurrency

Scheduled Pub/Sub processing and Integrity reconciliation must not become independent R2 writers.

Both modes must pass through the same Latest Snapshot runtime and its established single-writer restriction.

Do not add a separate script that edits Latest Snapshot R2 state from the Integrity machine.

### 6.5 Authentication

Use the existing private service authentication model where structurally possible.

Do not expose the reconciliation operation through the public cache API or website routes.

## 7. Phase 4: integrate reconciliation into Integrity

### 7.1 Mutation boundary

Current-state mutation is permitted only during a real repair-capable run.

`--check-only` and `--dry-run` may calculate and report proposed reconciliation candidates, but must not call either mutation interface.

### 7.2 Execution order

After final observation-history verification:

1. derive one raw latest candidate per affected timeseries;
2. call the timeseries reconciliation RPC;
3. derive one eligible Latest Snapshot candidate per affected supported timeseries;
4. call the authenticated Latest Snapshot reconciliation mode;
5. verify the reconciliation responses;
6. record all results in Integrity SQLite and the JSON/Markdown reports.

The two reconciliation targets are independently durable. Failure of one must not undo a successful R2 history repair or the other successful reconciliation.

### 7.3 Retry behaviour

A later real Integrity rerun may reconcile current state even when the R2 partition no longer needs rewriting, provided:

* authoritative source evidence is available;
* final source-to-R2 verification succeeds;
* the selected scope is unchanged or explicitly requested.

This allows recovery after a run that repaired R2 successfully but failed during current-state reconciliation.

All reconciliation operations must be idempotent.

### 7.4 Run result

A run must not report full `status=ok` when a required current-state reconciliation failed.

The report must distinguish:

```text
r2_history_status
timeseries_reconciliation_status
latest_snapshot_reconciliation_status
overall_status
```

Correct R2 history remains committed and must be reported as such even when the overall run is failed or partial.

## 8. Phase 5: deploy and validate through CIC-Test operations

Deploy the schema migration, Latest Snapshot service change and Integrity integration to CIC-Test.

Functional validation must use real TEST operations.

### 8.1 SOS outage case

Run a recent SOS repair using the authoritative local annual-file cache while the SOS gateway path is unavailable.

Confirm:

* R2 contains the verified repaired observations;
* newer `timeseries.last_value_at` and `last_value` fields advance;
* older database values are not retained;
* Latest Snapshot state advances for eligible PM2.5, PM10 and NO2 rows;
* public finite Latest Snapshot responses include newly current sensors;
* O3 does not enter Latest Snapshot.

### 8.2 Idempotent repeat

Repeat the same selected scope.

Confirm:

* no R2 history rewrite is required;
* timeseries reconciliation reports equal/no-op;
* Latest Snapshot state is unchanged;
* public snapshot hashes remain unchanged when payload content is unchanged.

### 8.3 No rollback case

Run an older historical range.

Confirm that neither `timeseries.last_value_at` nor Latest Snapshot state moves backwards.

### 8.4 Line-chart operation

For one repaired SOS timeseries whose latest repaired observation is absent from IngestDB:

* open a normal chart through the website;
* confirm that the station-history response obtains the repaired observation from R2;
* confirm that the observation line includes it;
* confirm that no browser or website special-case fallback is added.

Do not create a broad pre-deployment functional test programme.

## 9. Reporting

Add these report sections:

```text
current_state_reconciliation
  enabled
  planned
  attempted
  timeseries
  latest_snapshot
  candidate_observed_at_min
  candidate_observed_at_max
  warnings
  failures
```

Per-timeseries detail may remain in Integrity SQLite or a bounded diagnostic attachment rather than making the normal Markdown report excessively large.

## 10. Rollback

Rollback must be possible independently.

* Disable Integrity current-state reconciliation while retaining R2 history repair.
* Roll back the Latest Snapshot service route without changing existing state or public objects.
* Leave the database RPC installed but unused if migration rollback would be riskier than disabling the caller.
* Do not reverse valid monotonic `timeseries` updates.
* Do not restore an older Latest Snapshot state over newer valid state.

## 11. Completion criteria

The work is complete when:

1. Integrity can repair recent SOS history from authoritative cached files.
2. Verified newer raw observations advance `timeseries` freshness.
3. Verified newer valid public observations advance Latest Snapshot through its owning service.
4. Older repairs cannot roll current state backwards.
5. Same-timestamp corrections and retries are deterministic.
6. Check-only and dry-run remain non-mutating.
7. The line chart reads repaired R2 history without a new browser fallback.
8. All authoritative system documentation reflects the implemented behaviour.
