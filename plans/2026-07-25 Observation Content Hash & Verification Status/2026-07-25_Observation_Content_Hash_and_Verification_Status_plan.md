# Observation Content Hash and Verification Status

**Date:** 25 July 2026  
**Target environment:** TEST only  
**Primary repositories:** `TEST-uk-aq/uk-aq-schema`, then `TEST-uk-aq/uk-aq-ops`  
**Plan path:** `plans/2026-07-25 Observation Content Hash & Verification Status/2026-07-25_Observation_Content_Hash_and_Verification_Status_plan.md`  
**Status:** Revised after the Phase 0 prerequisite blocker was confirmed

## 1. Purpose

Implement one deterministic observation-content identity for R2 v2 observation history and preserve UK-AIR provisional or ratified status as canonical observation data.

The change addresses two existing weaknesses:

1. Integrity currently relies primarily on source and R2 row counts for source-to-R2 comparison. Matching counts do not detect a changed value, moved timestamp, changed status or parser correction.
2. UK-AIR verification status exists in source data and parts of the historical backfill pipeline, but the active normal Prune Daily RPC and R2 v2 observation contract do not expose it consistently.

The intended end state is:

```text
IngestDB / historical source observations
  -> canonical observation rows including verification_status
  -> one shared observation-content-hash helper
  -> one observation_content_hash per day + connector + pollutant
  -> canonical R2 pollutant Parquet + pollutant manifest
  -> existing parent manifests, indexes and Dropbox backup

Integrity
  -> fast source/R2 row-count comparison
  -> when counts match, source hash versus Dropbox manifest hash
  -> complete pollutant-partition repair on count or hash mismatch
  -> post-write live R2 hash equality
```

This is a TEST system. Pre-deployment checking is deliberately narrow. Functional acceptance happens through real Prune Daily and scoped Integrity operations on TEST.

## 2. Confirmed prerequisite blocker

The first Codex inspection correctly stopped before implementation because the approved Prune Daily source interface does not currently return observation status.

The active five-argument RPC is:

```text
uk_aq_phase_b_history_rows_v2
```

Its canonical definition is in:

```text
TEST-uk-aq/uk-aq-schema/
  schemas/ingest_db/main_db_dualwrite_bootstrap.sql
```

The active RPC currently returns only:

```text
connector_id
station_id
timeseries_id
pollutant_code
observed_at_utc
value
```

The underlying observations table already contains nullable `status`, but the RPC does not select or return it. Prune Daily therefore cannot obtain status through its approved interface.

No null fallback is permitted. Silently setting `verification_status` to null for normal SOS writes would discard available verification evidence and violate the authoritative contract.

The schema prerequisite must be implemented, applied and validated on CIC-Test before the ops implementation resumes.

## 3. Authoritative contracts

Codex must read the relevant repository `AGENTS.md` and these ops authority documents before implementation:

```text
system_docs/README.md
system_docs/documentation_contract.md
system_docs/r2_history/README.md
system_docs/r2_history/integrity.md
system_docs/r2_history/aqi_history_write_pipeline.md
```

The system documents are read-only to Codex. ChatGPT in Chat mode owns later documentation reconciliation.

## 4. Fixed design decisions

### 4.1 Hash scope and location

There is one authoritative `observation_content_hash` for each non-empty:

```text
day_utc + connector_id + pollutant_code
```

The hash covers every timeseries row in that pollutant partition.

It is stored in the existing v2 observation pollutant manifest:

```text
history/v2/observations/
  day_utc=<YYYY-MM-DD>/
  connector_id=<connector>/
  pollutant_code=<pollutant>/
  manifest.json
```

There is no separate authoritative hash:

- per timeseries;
- per connector-day;
- per day;
- in a separate R2 object;
- in Integrity SQLite.

The normal pollutant `manifest_hash` includes the new fields. Connector and day manifests continue to refer to child manifest hashes.

### 4.2 Shared helper

Prune Daily and the Integrity source-to-R2 path must call one shared implementation, expected at:

```text
workers/shared/uk_aq_observation_content_hash.mjs
```

The helper owns:

- contract version;
- canonical column list;
- canonical row validation;
- deterministic numeric encoding;
- deterministic row encoding and ordering;
- duplicate multiplicity;
- SHA-256 calculation;
- `verification_status_counts`.

Source-specific interpretation must not be guessed by the generic helper. UK-AIR/SOS source handling normalises its source values to canonical `P`, `R` or null before hashing. The generic helper accepts only those canonical values.

Python orchestration must not implement a second Python hash algorithm. It must obtain hash results through the shared JavaScript implementation or through worker evidence produced by that implementation.

### 4.3 Hash contract version 1

Contract version 1 covers:

```text
connector_id
station_id
timeseries_id
pollutant_code
observed_at_utc
value
verification_status
```

The canonical row is:

```text
[
  connector_id,
  station_id,
  timeseries_id,
  pollutant_code,
  observed_at_utc,
  value_float64_hex,
  verification_status
]
```

Required normalisation:

- `connector_id` is a positive integer;
- `station_id` is a positive integer or null;
- `timeseries_id` is a positive integer;
- `pollutant_code` is the validated canonical lower-case code;
- `observed_at_utc` is an exact UTC ISO timestamp with millisecond precision and trailing `Z`;
- `value` is a finite IEEE-754 binary64 value;
- finite negative values are preserved;
- negative zero normalises to positive zero;
- null, NaN and infinite values are invalid canonical observation values;
- `verification_status` is `P`, `R` or null.

The value is encoded as 16 lower-case hexadecimal characters representing its big-endian IEEE-754 binary64 bytes.

Each row is compact UTF-8 JSON in the fixed array order. Canonical row strings are sorted lexicographically. Exact duplicate rows retain their multiplicity.

The SHA-256 input is:

```text
uk-aq-observation-content-hash:v1\n
<canonical row 1>\n
<canonical row 2>\n
...
```

The final row also ends with `\n`.

The hash must not depend on Parquet compression, row groups, file splitting, physical row order, run IDs, wall-clock time, object ETags or manifest formatting outside the canonical input.

### 4.4 Verification status

The canonical nullable R2 observation field is:

```text
verification_status
```

For UK-AIR SOS observations:

```text
P = provisional
R = ratified
null = no source verification status supplied
```

Source values are trimmed and compared case-insensitively:

```text
null or blank -> null
P or Provisional -> P
R or Ratified -> R
```

Any other non-empty UK-AIR SOS value fails closed for the affected selected scope. It must not be guessed or silently changed to null.

For other connectors, `verification_status` remains null unless that connector has a separately documented source field with equivalent provisional or ratified meaning. Operational sensor state, ingestion state and unrelated QA flags must not be put into this field.

Ratified observations are not locked. A later source correction to a ratified value or status is valid changed content and must change `observation_content_hash`.

### 4.5 Legacy compatibility

Readers and Integrity canonicalisation resolve existing Parquet status in this order:

1. `verification_status` when present;
2. legacy nullable `status` when present;
3. otherwise null.

New writers emit only `verification_status`. They must not write both fields.

For SOS legacy `status`, the same canonical P/R/null normalisation applies. For a non-SOS legacy status without documented equivalent meaning, canonical `verification_status` remains null.

A missing legacy status column and an explicit null are semantically equivalent.

### 4.6 Manifest fields

Every newly written non-empty v2 observation pollutant manifest contains:

```json
{
  "observation_content_hash": "<64 lower-case hexadecimal characters>",
  "observation_content_hash_algorithm": "sha256",
  "observation_content_hash_contract_version": 1,
  "observation_content_hash_row_count": 1234,
  "observation_content_hash_columns": [
    "connector_id",
    "station_id",
    "timeseries_id",
    "pollutant_code",
    "observed_at_utc",
    "value",
    "verification_status"
  ],
  "verification_status_counts": {
    "P": 600,
    "R": 620,
    "null": 14
  }
}
```

`verification_status_counts`:

- is derived from the same canonical rows used for hashing and Parquet;
- always has `P`, `R`, `null` in that order;
- contains non-negative integers;
- sums exactly to `observation_content_hash_row_count`;
- is deterministic and contains no run-scoped values.

### 4.7 Integrity comparison

For each selected day, connector and pollutant:

```text
Counts differ
  -> observation data mismatch
  -> rebuild complete selected pollutant partition

Counts match
  -> calculate authoritative source observation_content_hash
  -> compare with Dropbox pollutant-manifest hash

Hashes differ
  -> observation data mismatch
  -> rebuild complete selected pollutant partition

Counts and hashes match
  -> observation content verified
```

Row counts remain the fast first check. They are not sufficient evidence of content equality.

A complete row-by-row pre-repair diff is not required. Diagnostics remain bounded. The repair unit is the complete day/connector/pollutant partition.

### 4.8 Legacy hashless partitions

A missing hash is not automatic proof that Parquet is wrong.

For a readable legacy hashless partition, Integrity reads Dropbox Parquet and calculates its hash through the shared helper:

- R2 hash equals source hash: metadata-only pollutant-manifest repair, preserving Parquet;
- R2 hash differs from source hash: complete pollutant data repair;
- unreadable or non-canonicalisable Parquet: fail closed.

SOS history without preserved source status may legitimately differ from authoritative source P/R values and require rebuilding. Non-SOS history whose authoritative status is null must not be rewritten merely to add an all-null physical column when logical content otherwise agrees.

### 4.9 Post-repair verification

After a real observation repair, Integrity must:

1. GET or read the newly written pollutant Parquet from live R2;
2. recalculate its content hash through the shared helper;
3. require exact equality with the authoritative source hash and status counts;
4. require the written pollutant manifest to contain that verified result;
5. only then continue to parent manifests, indexes and AQI work.

### 4.10 SQLite ownership

Integrity SQLite continues to store source state, comparison evidence, findings, repair planning and audit history.

It must not become a duplicate authoritative R2 content-hash store.

The initial implementation calculates source hashes during the existing parsing and canonical-row pass.

A non-authoritative source-hash cache may be considered later only if real TEST timings show material source-hashing cost. It is not part of this implementation.

### 4.11 Dropbox backup

No new backup object or directory is added.

The existing v2 observation day-folder backup carries:

- Parquet containing `verification_status`;
- pollutant manifests containing hash and status counts;
- parent manifests whose child identities change normally.

Backup code changes only if focused inspection proves that a strict allow-list would otherwise drop or reject the new deterministic fields.

## 5. Scope

### 5.1 In scope

- Extend the existing Prune Daily RPC to return source `status`.
- Add a targeted TEST migration that drops and recreates the exact five-argument RPC.
- Update the canonical schema definition in `TEST-uk-aq-schema`.
- Add the shared observation-content-hash implementation.
- Add canonical `verification_status` to new v2 observation Parquet.
- Preserve and normalise UK-AIR status in Prune Daily and Integrity source-to-R2 writes.
- Add `verification_status_counts` to pollutant manifests.
- Add count-then-hash comparison to Integrity.
- Handle legacy hashless Parquet and legacy `status` reads safely.
- Require post-repair live R2 hash equality.
- Update active observation readers and validators where required.
- Preserve manifest and index byte-stability.
- Preserve the existing Dropbox backup path.
- Store bounded audit evidence only.
- Run one focused deterministic helper check and only directly relevant local structural checks.

### 5.2 Out of scope

- LIVE repositories or resources.
- Website presentation of provisional or ratified status.
- WHO calculation, backfill, publication or fallback changes.
- AQI formula or rolling-window changes.
- New per-timeseries hashes.
- A complete pre-repair semantic diff.
- A standalone R2 hash object.
- An authoritative R2-hash cache in SQLite.
- The optional future source-hash cache.
- Broad SQLite retention or compaction changes.
- A full historical repair during Codex implementation.
- Changes to the underlying observations table, because nullable `status` already exists.
- Broad test suites, fixture programmes, shadow comparisons or soak tests.
- Editing `system_docs/` by Codex.

## 6. Protected behaviour

The implementation must preserve:

- R2 `history/v2` object paths;
- one pollutant partition as the physical repair unit;
- the selected `pm25`, `pm10`, `no2`, `o3` Integrity scope;
- AQI rebuild eligibility only for `pm25`, `pm10`, `no2`;
- warning-only `no_authoritative_timeseries_binding` handling;
- fail-closed ambiguous, contradictory or unavailable-source handling;
- UK-AIR `24:00` next-day UTC normalisation and D-1 annual-file discovery;
- exact selected-pollutant tombstone and write scope;
- preservation of unselected and out-of-scope pollutant children;
- child-data, child-manifest, parent-manifest, scoped-index, latest-index write order;
- changed-only and byte-stable manifest/index writes;
- backup readiness gate and Dropbox pre-repair baseline;
- no live R2 reads during check-only or dry-run;
- live R2 reads only for post-mutation verification during real repair;
- Prune Daily Phase B target-day source ownership;
- the exact RPC inputs, filtering, pagination and ordering behaviour;
- PM context as AQI-calculation-only data;
- existing pruning, completion and history gates;
- current task-health, logging and failure semantics.

# Part A: Schema prerequisite

## 7. Phase 0: completed blocker inspection

**Owner:** VS Code Codex  
**Recommended model:** GPT-5.6 Codex with High reasoning  
**Status:** Completed

The first inspection established that:

- the observations table already has nullable `status`;
- the active five-argument `uk_aq_phase_b_history_rows_v2` RPC omits it;
- the normal Prune Daily frozen-row normaliser consequently cannot preserve it;
- PostgreSQL cannot change the existing `RETURNS TABLE` shape with `CREATE OR REPLACE`;
- a targeted drop-and-recreate migration is required.

No ops files, archives or system documentation were changed. This completed finding is the basis for Phases 1 and 2.

## 8. Phase 1: implement the schema RPC prerequisite

**Owner:** VS Code Codex  
**Recommended model:** GPT-5.6 Codex with High reasoning  
**Repository:** `TEST-uk-aq/uk-aq-schema`  
**Permission:** Level 1, with only local structural SQL checks

Codex must inspect the schema repository `AGENTS.md` and the exact current function definition before editing.

### 8.1 Migration

Create one targeted TEST migration using the repository's normal naming and placement convention.

The migration must:

1. Identify and drop the exact existing five-argument signature only.
2. Recreate the function with the exact same:
   - function name;
   - five input arguments;
   - input argument order and types;
   - defaults;
   - filtering;
   - day bounds;
   - cursor or pagination behaviour;
   - ordering;
   - limits;
   - joins and identity rules;
   - language;
   - volatility;
   - parallel classification;
   - security mode;
   - `search_path`;
   - owner;
   - comments;
   - grants and revokes.
3. Preserve the existing six output columns in their existing order.
4. Append:

```text
status text
```

5. Select:

```text
o.status
```

6. Keep the function exposed only to the same roles as before.
7. Avoid changing the underlying table or unrelated RPCs.

Because drop and recreate can remove privileges and metadata, preserving grants, ownership, comments and security properties is a genuinely required targeted structural check.

### 8.2 Canonical schema

Update the canonical definition in:

```text
schemas/ingest_db/main_db_dualwrite_bootstrap.sql
```

Update another active canonical schema file only when repository evidence proves it also owns this function. Do not create duplicate authority.

Follow the schema repository archive policy. Archive only an active non-test canonical SQL file when required by that repository's `AGENTS.md`. Do not archive migrations, plans, documentation, tests or generated files.

### 8.3 Minimal checks

Run only:

- the repository's smallest SQL parse or structural check;
- a focused comparison confirming the input signature and function body behaviour are unchanged apart from the appended return column and `o.status` selection;
- `git diff --check`.

Do not apply SQL, call Supabase, inspect cloud state, edit ops or edit `system_docs/`.

### 8.4 Schema handover

Codex must report:

- files changed;
- archive file created, if required;
- exact old and new signatures;
- exact output column order;
- confirmation that only the return shape and selected `status` changed;
- preserved function properties, owner, grants and comments;
- checks run;
- exact CIC-Test apply command using the project's normal process;
- a bounded validation query or RPC call;
- any required PostgREST schema refresh step based on project convention;
- rollback SQL;
- concise handover for resuming the ops phases.

## 9. Phase 2: apply and validate the RPC on CIC-Test

**Owner:** User/operator, with ChatGPT reviewing the evidence

After reviewing the schema Codex handover:

1. Commit and push the focused schema change through the normal TEST workflow.
2. Apply the targeted migration to CIC-Test using the established schema process.
3. Perform one bounded RPC validation.

Confirm:

- the function still has exactly the intended five input arguments;
- the original six return columns remain present and ordered as before;
- nullable `status` is appended;
- a bounded call returns successfully;
- at least one SOS result has a non-null source status when suitable current test data exists;
- null status remains accepted;
- filtering, ordering and pagination remain unchanged;
- Prune Daily's existing service role can still execute the function;
- no broader table or RPC change occurred.

Do not run Prune Daily as part of the schema validation itself unless the established apply process requires a normal service operation. A bounded direct RPC call is sufficient for this prerequisite.

If privileges, schema cache or return decoding fail, fix the schema prerequisite before resuming ops work.

# Part B: Ops implementation

## 10. Phase 3: resume focused ops inspection

**Owner:** VS Code Codex  
**Recommended model:** GPT-5.6 Codex with High reasoning  
**Repository:** `TEST-uk-aq/uk-aq-ops`  
**Permission:** Level 1

This phase starts only after the user confirms Phase 2 succeeded on CIC-Test.

Before editing:

1. Read `AGENTS.md` and the authoritative documents in Section 3.
2. Use `grep`, not `rg`.
3. Confirm the canonical schema commit and validated RPC return shape supplied by the user.
4. Inspect only the active paths responsible for:
   - Prune Daily target-day RPC selection and frozen-row normalisation;
   - v2 observation Parquet creation;
   - pollutant, connector and day manifest construction;
   - Integrity source acquisition and canonical source evidence;
   - current source-to-Dropbox count comparison;
   - repair proposal and source-to-R2 writing;
   - live R2 post-write verification;
   - observation-history API and cache-proxy reads;
   - manifest/index validation;
   - Dropbox backup inventory and changed-unit copying.
5. Confirm how other connectors use the source `status` field. Do not interpret unrelated connector status values as verification status.
6. Confirm the smallest backwards-compatible observation schema-version policy while retaining `history/v2` paths.
7. Confirm how Python receives shared JavaScript hash evidence without reimplementing the algorithm.

Likely files include, but are not limited to:

```text
workers/shared/uk_aq_observation_content_hash.mjs
workers/uk_aq_prune_daily/phase_b_history_r2.mjs
workers/uk_aq_backfill_local/run_job.ts
scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py
workers/uk_aq_observs_history_r2_api_worker/worker.mjs
workers/uk_aq_cache_proxy/src/station_history/
workers/shared/uk_aq_r2_history_index.mjs
```

Only change files proven necessary.

No external source scans, R2 operations, Dropbox operations, database operations, deployments or long-running jobs are allowed.

Stop only for a new genuine blocker that makes the approved contract structurally unsafe.

## 11. Phase 4: implement the shared hash and verification-status contract

**Owner:** VS Code Codex  
**Recommended model:** GPT-5.6 Codex with High reasoning  
**Permission:** Level 1, with Level 2 only for the focused deterministic helper check

### 11.1 Archive active code

Follow `AGENTS.md`.

Before changing substantial active non-test implementation code, archive the current version under:

```text
archive/2026-07-25/
```

Archive only active non-test implementation code that will be changed. Do not archive plans, `system_docs/`, tests, fixtures, workflows, generated files or reports.

### 11.2 Shared module

Add:

```text
workers/shared/uk_aq_observation_content_hash.mjs
```

It must export clear constants and functions for:

- algorithm;
- contract version;
- canonical columns;
- canonical row validation and encoding;
- `computeObservationContentHash(rows)` or an equivalently explicit API.

The result contains:

```text
observation_content_hash
observation_content_hash_algorithm
observation_content_hash_contract_version
observation_content_hash_row_count
observation_content_hash_columns
verification_status_counts
```

The generic helper accepts only canonical `P`, `R` or null. It fails clearly on invalid canonical content.

### 11.3 Source normalisation

- UK-AIR/SOS maps raw `P`, `Provisional`, `R`, `Ratified`, blank and null to canonical values.
- Unknown non-empty UK-AIR/SOS values fail closed.
- Other adapters provide null unless a separately documented equivalent status exists.
- Do not infer verification meaning from an operational source status.

### 11.4 Focused deterministic helper check

One small deterministic check is genuinely required because inconsistent hashing would make every Integrity comparison unreliable.

Prove only:

- input order does not change the hash;
- changing value, timestamp, identity, pollutant or verification status changes the hash;
- UK-AIR status normalisation follows the contract;
- unknown non-empty UK-AIR status fails;
- exact duplicate multiplicity affects the hash;
- finite negative values are retained;
- negative zero normalises consistently;
- status counts sum to row count;
- Float64 encoding is deterministic.

Do not add a broad test suite.

## 12. Phase 5: integrate Prune Daily normal observation writes

**Owner:** VS Code Codex  
**Recommended model:** GPT-5.6 Codex with High reasoning  
**Permission:** Level 1

Update Phase B so that:

1. The validated RPC response includes and preserves source `status`.
2. Frozen rows retain that value until source-specific normalisation.
3. Canonical rows use `verification_status`, not legacy `status`.
4. SOS values become `P`, `R` or null.
5. Other connectors receive null unless an equivalent source field is documented.
6. Rows are grouped by pollutant.
7. The exact rows passed to Parquet are passed to the shared helper.
8. One hash and status-count object are produced per non-empty pollutant partition.
9. Pollutant manifests contain every required field.
10. The canonical `columns` list includes `verification_status`.
11. Parent manifests and indexes continue to use the final child `manifest_hash`.
12. The writer fails closed and keeps pruning blocked on invalid rows, status, hash metadata or count disagreement.
13. PM context rows are not written and do not affect the hash or status counts.
14. Finite negative history observations remain in R2 even where AQI calculation ignores them.
15. Equivalent canonical input remains idempotent and changed-only.

### 12.1 Schema compatibility

Preserve `history_version=v2` and existing R2 paths.

New observation manifests must identify the changed canonical observation schema distinctly from legacy observation manifests. Active readers must accept both forms. AQI history schema versions are not changed.

If current code couples manifest schema and observation data schema versions incorrectly, separate constants only as far as necessary for clear compatibility. Report the final version decision.

No further database migration is expected after Phase 2. If the validated RPC still cannot be consumed correctly, stop and report the exact interface mismatch rather than dropping status.

## 13. Phase 6: integrate Integrity comparison and repair

**Owner:** VS Code Codex  
**Recommended model:** GPT-5.6 Codex with High reasoning  
**Permission:** Level 1

### 13.1 Source evidence

For each selected day, connector and pollutant, add:

- total source rows;
- per-timeseries row counts;
- source `observation_content_hash`;
- source `verification_status_counts`;
- hash contract metadata;
- existing source-file and mapping identities.

The shared JavaScript helper must produce the source hash. Python must not independently encode or hash rows.

Detector and proposal evidence must agree on selected source files, canonical rows, skipped missing-binding groups, counts, hash, status counts and contract version. Disagreement fails closed.

### 13.2 Count-first comparison

Keep total and per-timeseries counts as the first check.

A count match must proceed to source hash versus Dropbox pollutant-manifest hash comparison.

Reports distinguish at least:

```text
row_count_mismatch
observation_content_hash_mismatch
observation_content_hash_missing
observation_content_hash_invalid_contract
observation_content_hash_verified
```

Names may follow repository conventions, but meanings must be unambiguous.

### 13.3 Legacy hashless comparison

For a hashless partition:

1. Read Dropbox Parquet.
2. Resolve `verification_status`, legacy `status`, then null.
3. Apply SOS P/R normalisation only for SOS data.
4. Calculate the R2 hash through the shared helper.
5. Compare it with source truth.
6. Plan metadata-only repair when content agrees.
7. Plan complete pollutant data repair when content differs.
8. Fail closed when Parquet cannot be read or canonicalised.

Do not rewrite a non-SOS partition merely to add an all-null column when logical content agrees.

### 13.4 Repair and diagnostics

A count or hash mismatch repairs the complete selected day/connector/pollutant partition. Do not add per-timeseries patching.

A complete pre-repair row diff is not required. Keep diagnostics bounded to hashes, counts, status counts, partition identity and limited examples or categories where inexpensive.

### 13.5 Replacement writer

New Integrity Parquet:

- uses `verification_status` only;
- uses the exact rows supplied to the shared helper;
- writes hash and status-count manifest fields;
- retains finite negative values;
- preserves duplicate conflict rules;
- preserves UK-AIR timestamp and previous-year file behaviour;
- preserves selected-pollutant and exact-prefix scope.

### 13.6 Post-write verification

After writing a selected pollutant partition:

- GET/read live R2 Parquet;
- canonicalise through the shared helper;
- require equality with source hash and status counts;
- verify the pollutant manifest contains the same result;
- only then rebuild parents, indexes and AQI.

A failed post-write hash check is a failed repair.

### 13.7 SQLite

Store compact comparison and audit evidence only. Do not add an authoritative R2 hash cache, the optional source-hash cache, full canonical row sets or unbounded semantic diffs.

## 14. Phase 7: update readers, validators and backup compatibility

**Owner:** VS Code Codex  
**Recommended model:** GPT-5.6 Codex with High reasoning  
**Permission:** Level 1

### 14.1 Readers

Active R2 observation readers must:

- read `verification_status` when present;
- fall back to legacy `status`;
- otherwise return null;
- expose only the canonical name where the quality field is returned;
- remain able to read legacy Parquet without either column.

Public website presentation is out of scope.

### 14.2 Manifest validation

- New canonical manifests require valid hash fields and status counts.
- Legacy manifests remain readable and are classified as hashless, not corrupt solely because fields are absent.
- Hash row count equals manifest row count.
- Status counts sum to row count.
- Column list, algorithm and contract version are exact.
- Unknown algorithms or versions fail closed where semantic comparison is required.

### 14.3 Indexes

Preserve index byte-stability. Indexes continue to refer to pollutant `manifest_hash`. Do not copy full content hashes into every index unless existing validation genuinely requires it. Do not add volatile fields.

### 14.4 Dropbox

Confirm the existing backup copies complete changed manifests and Parquet. Do not change backup code when it already copies complete day units. If a strict allow-list must change, make the smallest deterministic edit and explain it.

## 15. Phase 8: minimal structural checks and Codex handover

**Owner:** VS Code Codex  
**Recommended model:** GPT-5.6 Codex with High reasoning

Run only:

1. Syntax or type checks for changed JavaScript, TypeScript and Python.
2. The focused helper check.
3. Directly relevant existing fast writer/reader checks.
4. One focused legacy-Parquet compatibility check only if needed.
5. `git diff --check`.

Do not call Supabase, R2, Dropbox, GCP, Cloudflare or external APIs. Do not run Prune Daily or Integrity. Do not deploy, repair history, edit `system_docs/`, commit or push.

The handover must include:

- files changed;
- archives created;
- final schema/version decision;
- canonical status normalisation;
- shared helper interface;
- Prune Daily source-status path;
- Integrity detector and proposal evidence path;
- legacy hashless and legacy status behaviour;
- reader and validator compatibility;
- manifest fields;
- SQLite changes and confirmation no hash cache was added;
- backup/index changes or confirmation none were needed;
- checks run;
- exact manual TEST deployment and execution steps;
- expected Prune Daily, R2, Dropbox and Integrity evidence;
- rollback notes;
- concise ChatGPT system-document handover.

Phases 3 to 8 should be completed in one Codex implementation request unless Phase 3 finds a new genuine blocker.

# Part C: Real TEST operations and acceptance

## 16. Phase 9: review and place ops implementation on TEST main

**Owner:** User/operator and ChatGPT in Chat mode

1. Provide the ops Codex handover and diff summary to ChatGPT.
2. ChatGPT checks the implementation against this plan and the authoritative documents.
3. Resolve any clear contract mismatch.
4. The user commits and pushes the focused ops implementation to TEST `main`.
5. Apply or deploy only through the existing TEST path identified by the handover.

Do not begin historical repair in this phase.

## 17. Phase 10: real TEST Prune Daily validation

**Owner:** User/operator, with ChatGPT analysing the run

Run one normal Prune Daily Phase B operation through the current TEST path.

Confirm:

- existing task success/failure semantics remain intact;
- pruning remains blocked if status or hash validation fails;
- each non-empty pollutant manifest contains valid hash fields;
- status counts sum to row count;
- the manifest column list includes `verification_status`;
- SOS rows contain only `P`, `R` or null;
- other connectors use null unless an equivalent status is documented;
- new Parquet does not contain both status column names;
- PM context is absent from observation Parquet, hash and status counts;
- parent manifests and indexes use final child manifest hashes;
- unrelated days do not churn;
- structured diagnostics are bounded;
- no secrets or canonical rows are dumped to logs.

One successful normal TEST operation and representative output inspection are sufficient unless a real failure identifies a specific additional check.

## 18. Phase 11: Dropbox backup validation

**Owner:** User/operator, with ChatGPT analysing evidence

Run or wait for the next normal R2-to-Dropbox backup.

Confirm:

- the affected day folder uses the existing path;
- Dropbox contains the same pollutant hash and status-count fields as R2;
- Parquet contains canonical `verification_status`;
- no separate hash object or backup category was created;
- only genuinely changed units were copied;
- unrelated broad manifest/index churn did not occur.

This backup becomes the baseline for normal Integrity comparison.

## 19. Phase 12: scoped Integrity functional validation

**Owner:** User/operator, with ChatGPT analysing logs and outputs

Use the dedicated Integrity machine and its normal dispatcher.

### 19.1 Recent hash-bearing day

Run one narrow check against a day produced by the new Prune Daily writer after backup.

Expected:

```text
counts agree
source and manifest observation_content_hash agree
verification_status_counts agree
no observation repair is planned
```

### 19.2 Historical hashless or incorrect day

Use `2025-01-01` as the preferred bounded SOS day because it also exercises previous-year UK-AIR source discovery.

Review check or dry-run evidence before a real repair.

Expected:

- both required annual years are downloaded or reused;
- count equality no longer ends comparison;
- a missing manifest hash causes Dropbox Parquet hashing;
- shifted timestamps, changed values or missing status cause a hash mismatch even when counts match;
- only affected day/connector/pollutant prefixes are rebuilt;
- live R2 hash and status counts equal source truth;
- AQI rebuilds only for changed PM2.5, PM10 or NO2;
- O3 repair does not queue AQI;
- final verification succeeds.

Do not broaden immediately to a month or year.

### 19.3 Post-repair backup confirmation

After the scoped repair:

1. Run the next Dropbox backup.
2. Rerun the normal check for the same day.

Expected:

```text
counts agree
source hash equals Dropbox manifest hash
status counts agree
no observation repair remains
```

## 20. Phase 13: ChatGPT implementation reconciliation

**Owner:** ChatGPT in Chat mode using Thinking

Using schema and ops handovers, committed code and real TEST evidence:

1. Compare implementation with:
   - `system_docs/r2_history/integrity.md`;
   - `system_docs/r2_history/aqi_history_write_pipeline.md`;
   - `system_docs/r2_history/README.md`.
2. Add the exact RPC status interface and final observation schema/version decision.
3. Correct documentation only where accepted implementation differs.
4. Preserve one authoritative home for each rule.
5. Do not copy this plan into system documentation.
6. Keep the dated pre-hash snapshot untouched.

## 21. Phase 14: controlled historical adoption

**Owner:** User/operator, with ChatGPT preparing and reviewing each bounded run

Proceed only after Phases 10 to 13 are accepted.

Repair historical SOS observations in explicit operator-approved month-sized ranges ending before the current UTC day.

For each range:

1. Confirm a current Dropbox baseline.
2. Run Integrity with explicit selected pollutants.
3. Review count and hash mismatch summaries.
4. Confirm complete selected-pollutant repairs only.
5. Confirm live R2 post-write hash equality.
6. Confirm AQI rebuild scope.
7. Run the next Dropbox backup.
8. Confirm a later check reports count and hash agreement.

Do not require a complete row diff. Do not run the whole historical period in one invocation.

WHO historical results must not be treated as authoritative until the relevant observation dates complete this adoption and verification process.

## 22. Phase 15: optional measured source-hash cache

**Owner:** ChatGPT for design, VS Code Codex for a later implementation, user/operator for TEST validation

This is not part of the initial implementation.

Consider it only when real Integrity timings show source hash creation is a material bottleneck.

Any later cache must:

- be non-authoritative;
- store source-side hashes only;
- never replace the R2 manifest hash as R2 truth;
- invalidate on source-file hashes, parser/timestamp version, registry identity, mappings, partition scope, status-normalisation contract and hash-contract version;
- be bounded and have explicit cleanup;
- report hit/miss evidence;
- produce exactly the same results as uncached calculation.

Do not add it merely because the existing SQLite database is large.

## 23. Rollback

### 23.1 Schema prerequisite before apply

Revert the schema changes. No database rollback is needed.

### 23.2 Schema prerequisite after apply but before ops deployment

Use the exact rollback SQL supplied by schema Codex to drop the extended signature and restore the previous six-column return shape, including all original grants and properties.

Do this only if a real compatibility problem requires rollback. Otherwise retain the additive status interface.

### 23.3 Ops implementation before a real R2 write

Revert the ops implementation. No R2 or Dropbox rollback is needed.

### 23.4 After a new Prune Daily write

- Revert defective code only after considering already-written schema compatibility.
- Do not manually delete the affected R2 partition.
- Keep pruning blocked while hash or manifest verification is unreliable.
- Use a corrected writer or approved scoped Integrity repair.

### 23.5 During historical adoption

Stop at the current bounded range. Do not continue until the failure is understood. Rerun the same selected scope after correction. Do not restore one-hour-shifted or status-losing Parquet merely to recreate the previous state.

## 24. Codex prompts

### Prompt A: schema RPC prerequisite

```text
Use GPT-5.6 Codex with High reasoning.

Implement Phase 1 of:
plans/2026-07-25 Observation Content Hash & Verification Status/2026-07-25_Observation_Content_Hash_and_Verification_Status_plan.md

Work only in TEST-uk-aq/uk-aq-schema. Follow that repository's AGENTS.md. Use grep, not rg. Do not inspect or modify LIVE. Do not apply SQL or call Supabase.

The underlying observations table already contains nullable status. The active five-argument uk_aq_phase_b_history_rows_v2 RPC omits it.

Inspect the exact active signature and function properties. Create one targeted TEST migration that drops and recreates only that exact signature because PostgreSQL cannot change its RETURNS TABLE shape with CREATE OR REPLACE.

Preserve the exact five inputs, defaults, filters, pagination, ordering, limits, security mode, volatility, parallel classification, search_path, owner, comments, grants and revokes.

Preserve the existing six output columns in their existing order, append status text, and select o.status.

Update schemas/ingest_db/main_db_dualwrite_bootstrap.sql and only other proven active canonical definitions. Do not change the table or unrelated RPCs. Do not edit ops or system_docs.

Follow the schema repo archive policy. Run only the smallest local SQL structural checks and git diff --check.

Return:
1. files changed;
2. archives created, if required;
3. exact old and new signatures;
4. output column order;
5. preserved properties and permissions;
6. checks run;
7. exact CIC-Test apply command;
8. bounded validation call;
9. schema refresh requirement, if any;
10. rollback SQL;
11. concise handover for the ops implementation.
```

### Prompt B: ops implementation after RPC validation

```text
Use GPT-5.6 Codex with High reasoning.

The user has confirmed that the targeted CIC-Test migration extending the five-argument uk_aq_phase_b_history_rows_v2 RPC has been applied and validated. It now returns the original six fields plus nullable status.

Implement Phases 3 to 8 of:
plans/2026-07-25 Observation Content Hash & Verification Status/2026-07-25_Observation_Content_Hash_and_Verification_Status_plan.md

Work only in TEST-uk-aq/uk-aq-ops. Follow AGENTS.md. Use grep, not rg. Do not inspect or modify LIVE.

Read the authoritative system documents listed in the plan. They are read-only. Do not edit system_docs.

This is a TEST system. Perform minimal pre-deployment checking. Do not deploy, run Prune Daily, run Integrity, call Supabase, R2, Dropbox, Cloudflare, GCP or external APIs, or perform historical repairs.

Implement the coordinated observation_content_hash and verification_status contract exactly as defined in the plan:

- one shared JavaScript helper;
- one hash per non-empty day + connector + pollutant partition;
- canonical verification_status P, R or null;
- UK-AIR P/Provisional and R/Ratified normalisation;
- unknown non-empty UK-AIR status fails closed;
- verification_status included in hash contract version 1;
- verification_status_counts in pollutant manifests;
- normal Prune Daily preserves RPC status and writes only verification_status;
- Integrity uses counts first, then mandatory source hash versus Dropbox manifest hash when counts match;
- legacy hashless Parquet is hashed before deciding metadata-only versus data repair;
- complete pollutant partition repair on count or hash mismatch;
- mandatory live R2 post-write hash and status-count equality;
- active readers support verification_status, legacy status and missing columns;
- no per-timeseries hashes;
- no complete pre-repair diff;
- no authoritative R2 hash cache or optional source-hash cache in SQLite;
- existing paths, backup process, protected behaviour and index byte-stability remain unchanged.

Before changing substantial active non-test code, create required archive copies under archive/2026-07-25/. Do not archive docs, plans, workflows, tests or fixtures.

Run only syntax/type checks, the one focused deterministic helper check, directly relevant existing fast checks, one focused legacy compatibility check only if genuinely needed, and git diff --check.

Return the complete handover required by Phase 8, including exact manual TEST deployment and execution steps.
```

## 25. Acceptance criteria

The work is accepted when:

- the CIC-Test RPC returns the original six fields plus nullable `status`;
- its exact inputs, filters, ordering, security and permissions remain intact;
- both R2 writers call one shared hash helper;
- new Parquet uses `verification_status` only;
- UK-AIR status normalises to P/R/null and unknown values fail closed;
- ratified data remains correctable;
- each non-empty pollutant manifest contains valid hash fields and status counts;
- count equality alone no longer proves Integrity success;
- changed values, timestamps or statuses are detected by hash mismatch;
- legacy hashless partitions are classified through Parquet content comparison;
- non-SOS all-null status compatibility avoids unnecessary rewrites;
- a complete pollutant partition is the repair unit;
- live post-repair hash equality is mandatory;
- no duplicate authoritative R2 hash cache exists in SQLite;
- Dropbox uses its existing backup path;
- one normal TEST Prune Daily operation succeeds;
- one recent hash-bearing Integrity check succeeds;
- one bounded historical Integrity repair and Dropbox-backed recheck succeed;
- ChatGPT reconciles system documentation after real TEST evidence.
