# Observation Content Hash and Verification Status

**Date:** 25 July 2026  
**Target environment:** TEST only  
**Primary repository:** `TEST-uk-aq/uk-aq-ops`  
**Plan path:** `plans/2026-07-25 Observation Content Hash & Verification Status/2026-07-25_Observation_Content_Hash_and_Verification_Status_plan.md`  
**Status:** Implementation plan

## 1. Purpose

Implement one deterministic observation-content identity for R2 v2 observation history and preserve UK-AIR provisional or ratified status as canonical observation data.

The change addresses two existing weaknesses:

1. Integrity currently uses source and R2 row counts as its main source-to-R2 content comparison. Matching counts do not detect a changed value, moved timestamp, changed status or parser correction.
2. UK-AIR verification status is available in source and parts of the historical backfill pipeline, but the active R2 v2 observation contract is inconsistent. Prune Daily omits it and historical writers may use the legacy name `status`.

The intended end state is:

```text
Authoritative source observations
  -> canonical observation rows
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

This is a TEST system. Pre-deployment checking is deliberately narrow. Functional acceptance happens through normal Prune Daily and scoped Integrity operations on TEST.

## 2. Authoritative contracts

Codex must read these files before implementation and treat them as read-only:

- `AGENTS.md`
- `system_docs/README.md`
- `system_docs/documentation_contract.md`
- `system_docs/r2_history/README.md`
- `system_docs/r2_history/integrity.md`
- `system_docs/r2_history/aqi_history_write_pipeline.md`
- relevant R2 history interfaces, operations, recovery and validation documents

The current system documents already define the intended `observation_content_hash` and `verification_status` behaviour. Where current code differs, implementation must be brought into line with those contracts.

Codex must not edit `system_docs/`. ChatGPT in Chat mode owns later documentation reconciliation.

## 3. Fixed design decisions

### 3.1 Hash scope and location

There is one authoritative `observation_content_hash` for each non-empty:

```text
day_utc + connector_id + pollutant_code
```

The hash covers every timeseries row in that pollutant partition.

The hash is stored in the existing v2 observation pollutant manifest:

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

The existing pollutant manifest `manifest_hash` includes the new fields. Existing connector and day manifests continue to refer to their child manifest hashes, so content changes propagate through the current hierarchy.

### 3.2 Shared helper

Prune Daily and the Integrity source-to-R2 path must call one shared implementation, expected at:

```text
workers/shared/uk_aq_observation_content_hash.mjs
```

The shared implementation owns:

- contract version;
- canonical column list;
- verification-status normalisation support;
- row validation;
- deterministic value encoding;
- canonical row encoding;
- deterministic row ordering;
- duplicate multiplicity;
- SHA-256 calculation;
- `verification_status_counts`.

Neither writer may copy or independently reimplement the hash algorithm. Python orchestration must not create a separate Python implementation. Where Python needs a result, it must obtain it through the shared JavaScript implementation or through active worker evidence produced by that implementation.

### 3.3 Hash contract version 1

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

Each row is compact UTF-8 JSON in the fixed array order above. Canonical row strings are sorted lexicographically. Exact duplicate rows retain their multiplicity.

The SHA-256 input is:

```text
uk-aq-observation-content-hash:v1\n
<canonical row 1>\n
<canonical row 2>\n
...
```

The final row also ends with `\n`.

The hash must not depend on:

- Parquet compression;
- row-group layout;
- Parquet file splitting;
- physical input or Parquet row order;
- writer run ID;
- wall-clock timestamps;
- object ETag;
- manifest formatting outside the canonical hash input.

### 3.4 Verification status

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

For other connectors, `verification_status` remains null unless that connector has a separately documented source field with equivalent provisional or ratified meaning. Operational sensor state, ingestion status and unrelated QA flags must not be put into this field.

Ratified observations are not locked. A later source correction to a ratified value or status is valid changed content and must change `observation_content_hash`.

### 3.5 Legacy compatibility

Readers and Integrity canonicalisation must resolve an existing Parquet status in this order:

1. `verification_status` when present;
2. legacy nullable `status` when present;
3. otherwise null.

New writers emit only `verification_status`. They must not write both fields.

For an SOS legacy `status`, the same canonical P/R/null normalisation applies. For a non-SOS legacy status with no documented equivalent meaning, canonical `verification_status` remains null.

A missing legacy status column and an explicit null are semantically equivalent.

### 3.6 Manifest fields

Every newly written non-empty v2 observation pollutant manifest must contain:

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

- is calculated from the same canonical rows used for hashing and Parquet;
- always has the keys `P`, `R`, `null` in that order;
- contains non-negative integers;
- sums exactly to `observation_content_hash_row_count`;
- is deterministic and contains no run-scoped value.

### 3.7 Integrity comparison algorithm

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

Row counts remain the first fast structural check. They are not sufficient evidence of content equality.

A full row-by-row pre-repair diff is not required. On a hash mismatch, bounded diagnostic samples and difference-category counts may be produced. The repair unit remains the complete day/connector/pollutant partition.

### 3.8 Legacy hashless partitions

A missing `observation_content_hash` is not automatic proof that the Parquet content is wrong.

For an otherwise readable legacy hashless pollutant partition, Integrity must read the Dropbox Parquet and calculate its hash through the shared helper:

- calculated R2 hash equals source hash: metadata-only pollutant-manifest repair, preserving Parquet;
- calculated R2 hash differs from source hash: complete pollutant data repair;
- unreadable or non-canonicalisable Parquet: fail closed.

For SOS history that lacks source status, source P/R values may make the calculated hashes differ and legitimately require a complete rebuild.

For non-SOS history whose authoritative status is null, an absent physical status column must not force a data rebuild when the logical content otherwise agrees.

### 3.9 Post-repair verification

After a real observation data repair, Integrity must:

1. GET or read the newly written pollutant Parquet from live R2;
2. recalculate its content hash through the shared helper;
3. require exact equality with the authoritative source hash;
4. require the written pollutant manifest fields and status counts to equal that verified result;
5. only then continue to parent manifests, indexes and AQI work.

The required audit chain is:

```text
old R2 differs from source
complete pollutant partition rebuilt
new live R2 hash equals source hash
```

### 3.10 SQLite ownership

Integrity SQLite continues to store source state, comparison evidence, findings, repair planning and audit history.

It must not become a duplicate authoritative store for the R2 content hash.

The initial implementation calculates source hashes during the existing source parsing and canonical-row pass.

If real TEST operations later prove that source-hash creation is materially slow, a non-authoritative SQLite source-hash cache may be added as a separate measured optimisation. That later cache must be invalidated by all canonical-content inputs, including:

- exact source-file identities and SHA-256 values;
- source parser and timestamp contract version;
- source-label registry snapshot identity;
- station, timeseries and pollutant mapping identities;
- connector, day and pollutant scope;
- verification-status normalisation contract;
- observation-content-hash contract version.

Do not implement that cache in the initial work.

### 3.11 Dropbox backup

No new backup object or directory is added.

The existing v2 observation day-folder backup carries:

- Parquet containing `verification_status`;
- pollutant manifest containing the hash and status counts;
- parent manifests whose child identities change normally.

The existing backup inventory and checkpoint structure should work unchanged. Modify backup code only if focused inspection proves that an existing field allow-list would otherwise drop or reject the new deterministic manifest fields.

## 4. Scope

### 4.1 In scope

- Add the shared observation-content-hash implementation.
- Add canonical `verification_status` to new v2 observation Parquet.
- Preserve and normalise UK-AIR source status in normal Prune Daily writes.
- Preserve and normalise UK-AIR source status in Integrity source-to-R2 writes.
- Add `verification_status_counts` to pollutant manifests.
- Make Prune Daily and Integrity use the same exact hash helper.
- Add count-then-hash source comparison to Integrity.
- Handle legacy hashless Parquet and legacy `status` reads safely.
- Require post-repair live R2 hash equality.
- Update active observation readers and validators needed to read new and legacy Parquet.
- Preserve manifest and index byte-stability.
- Preserve the existing Dropbox backup path.
- Provide bounded structured diagnostics and audit evidence.
- Add only the one focused deterministic helper check and directly relevant existing tests needed for structural viability.

### 4.2 Out of scope

- LIVE repositories or resources.
- Website presentation of provisional or ratified status.
- WHO calculation, backfill, publication or fallback changes.
- AQI formula or rolling-window changes.
- New per-timeseries hashes.
- A full pre-repair semantic diff.
- A new standalone R2 hash object.
- An authoritative R2-hash cache in SQLite.
- The optional future source-hash cache.
- Broad SQLite retention or compaction changes.
- A full historical repair during Codex implementation.
- Database migrations unless inspection proves the current normal target-day source interface cannot expose its already-existing observation status.
- Broad test suites, fixture programmes, shadow comparisons or soak tests.
- Editing `system_docs/` by Codex.

## 5. Protected behaviour

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
- PM context as AQI-calculation-only data;
- existing pruning, completion and history gates;
- current task-health, logging and failure semantics.

## 6. Phase 0: focused inspection and implementation map

**Owner:** VS Code Codex  
**Recommended model:** GPT-5.6 Codex with High reasoning  
**Permission:** Level 1

This phase is part of the same Codex implementation request as Phases 1 to 5.

Before editing:

1. Read the authoritative documents listed in Section 2.
2. Use `grep`, not `rg`.
3. Inspect the active paths responsible for:
   - normal Prune Daily target-day observation selection;
   - v2 observation row normalisation and Parquet creation;
   - v2 pollutant, connector and day manifest construction;
   - Integrity source acquisition and canonical source evidence;
   - Integrity current source-to-Dropbox count comparison;
   - Integrity repair proposal and source-to-R2 writer;
   - live R2 post-write verification;
   - observation-history API and cache-proxy Parquet reads;
   - R2 manifest and index validation;
   - Dropbox backup inventory and changed-unit copying.
4. Confirm the current status flow:
   - normal IngestDB/Prune Daily source field name and availability;
   - SOS flat-file status parsing;
   - any legacy `status` Parquet writer and reader paths;
   - whether other connectors currently use `status` for a different meaning.
5. Confirm the current schema/version constants and strict validators. Determine the smallest compatible way to distinguish newly written canonical Parquet from legacy v2 Parquet while retaining the `history/v2` path.
6. Confirm the smallest way for Python Integrity orchestration to receive source hashes produced by the shared JavaScript helper without reimplementing the algorithm.
7. Confirm that the existing backup copies complete manifests rather than projecting an allow-list that would omit the new fields.

Expected likely implementation files include, but are not limited to:

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

No external source scans, R2 operations, Dropbox operations, deployments, database operations or long-running jobs are allowed in this phase.

A genuine blocker is one of:

- normal Prune Daily cannot obtain the source status without a database/RPC change;
- the active Integrity detector cannot obtain canonical source rows or hash evidence without changing the approved repair boundary;
- a strict public compatibility requirement prevents a safe additive reader path;
- the manifest/schema version contract cannot be made backwards-compatible without a broader migration.

If a blocker is found, stop and report it before broadening scope.

## 7. Phase 1: implement the shared hash and verification-status contract

**Owner:** VS Code Codex  
**Recommended model:** GPT-5.6 Codex with High reasoning  
**Permission:** Level 1, with Level 2 only for the focused deterministic helper check

### 7.1 Archive changed active code

Follow `AGENTS.md`.

Before changing substantial active non-test code, archive the current version under:

```text
archive/2026-07-25/
```

Archive only active non-test implementation code that will be changed. Do not archive:

- plans;
- `system_docs/`;
- tests or fixtures;
- workflows;
- generated files;
- reports.

A newly created helper has no previous version to archive.

### 7.2 Shared module

Add the shared module expected by the contracts:

```text
workers/shared/uk_aq_observation_content_hash.mjs
```

It must export clearly named constants and functions for:

- hash algorithm;
- contract version;
- canonical column list;
- source verification-status normalisation where appropriate;
- canonical row validation and encoding;
- `computeObservationContentHash(rows)` or an equivalently explicit API.

The returned result must contain at least:

```text
observation_content_hash
observation_content_hash_algorithm
observation_content_hash_contract_version
observation_content_hash_row_count
observation_content_hash_columns
verification_status_counts
```

The helper must fail clearly on invalid canonical content.

### 7.3 Status-normalisation ownership

Keep source-specific meaning outside generic guessing.

The preferred boundary is:

- UK-AIR/SOS source adapter maps raw `P`, `Provisional`, `R`, `Ratified`, blank and null to canonical values;
- other adapters provide null unless they have a documented equivalent field;
- the generic hash helper accepts only canonical `P`, `R` or null and rejects any other supplied value.

Do not hard-code an undocumented operational status as ratification evidence.

### 7.4 Focused helper check

One small deterministic helper check is genuinely required because inconsistent hashing would make every Integrity comparison unreliable.

Use the repository's existing focused test conventions. Prove only:

- identical logical rows in different input orders produce the same hash;
- changing value, timestamp, timeseries, station, connector, pollutant or verification status changes the hash;
- `P`, `Provisional`, `R`, `Ratified`, blank and null normalise as contracted for UK-AIR;
- an unknown non-empty UK-AIR status fails;
- exact duplicate multiplicity affects the hash;
- finite negative values are preserved;
- negative zero is normalised consistently;
- `verification_status_counts` sums to the hash row count;
- the value encoding is deterministic.

Do not create a broad hash test suite.

## 8. Phase 2: integrate Prune Daily normal observation writes

**Owner:** VS Code Codex  
**Recommended model:** GPT-5.6 Codex with High reasoning  
**Permission:** Level 1

Update the normal Phase B observation path so that:

1. The target-day source selection preserves its source status field.
2. Canonical rows use `verification_status`, not legacy `status`.
3. UK-AIR/SOS values are normalised to `P`, `R` or null.
4. Other connectors receive null unless a documented equivalent source field exists.
5. Rows are grouped by pollutant.
6. The exact canonical rows passed to Parquet are passed to the shared hash helper.
7. One hash and one status-count object are produced per non-empty pollutant partition.
8. The pollutant manifest contains all required fields.
9. `columns` declares `verification_status`.
10. Parent manifests and indexes continue to use the final pollutant `manifest_hash`.
11. The writer fails closed and keeps pruning blocked if row normalisation, hash metadata, status counts or row-count agreement is invalid.
12. PM context rows are not written and do not contribute to the hash or status counts.
13. Finite negative history observations remain in R2 even though AQI calculation may ignore them.
14. Equivalent canonical input remains idempotent and changed-only.

### 8.1 Schema compatibility

Preserve `history_version=v2` and existing R2 paths.

Because the canonical Parquet column set changes, Codex must apply a clear backwards-compatible observation schema version policy based on Phase 0 inspection:

- newly written observation manifests must identify the new canonical schema distinctly from legacy observation manifests;
- active readers must accept both legacy and new observation schema forms;
- AQI history schema versions must not be changed by this work;
- do not use a version bump merely to rename the `history/v2` path.

If current code incorrectly couples manifest schema and observation data schema versions, separate the constants only as far as necessary for clear compatibility. Report the final version decision in the handover.

### 8.2 No database migration by default

No database migration is expected if the existing target-day source table/RPC already contains status.

If the source interface cannot expose status without a schema or RPC change, stop and report the exact missing interface and required TEST schema-repo change rather than silently omitting status or broadening the task.

## 9. Phase 3: integrate Integrity comparison and repair

**Owner:** VS Code Codex  
**Recommended model:** GPT-5.6 Codex with High reasoning  
**Permission:** Level 1

### 9.1 Source evidence

Extend active source evidence so each selected day/connector/pollutant has:

- total source row count;
- per-timeseries row counts;
- canonical source `observation_content_hash`;
- source `verification_status_counts`;
- hash contract metadata;
- source-file and mapping identities already required by Integrity.

The source hash must be produced by the shared JavaScript helper. Python must not independently encode or hash rows.

Detector and proposal stages must agree on:

- selected source files;
- canonical mapped rows;
- skipped missing-binding groups;
- counts;
- hash;
- status counts;
- contract version.

A mismatch between detector and proposal evidence fails closed.

### 9.2 Count-first comparison

Retain total and per-timeseries row counts as the fast first check.

Change the successful count-match path so it proceeds to content-hash comparison rather than declaring the partition correct.

Required finding/status distinctions include:

```text
row_count_mismatch
observation_content_hash_mismatch
observation_content_hash_missing
observation_content_hash_invalid_contract
observation_content_hash_verified
```

Names may follow established repository conventions, but reports must make these states unambiguous.

### 9.3 Legacy hashless comparison

For a hashless legacy pollutant manifest:

1. Read the Dropbox Parquet.
2. Resolve `verification_status`, then legacy `status`, then null.
3. Apply SOS-specific canonical P/R normalisation only for the SOS connector.
4. Calculate the R2 hash through the shared helper.
5. Compare it with source truth.
6. Plan metadata-only repair if content agrees.
7. Plan complete pollutant data repair if content differs.
8. Fail closed if the Parquet cannot be read or normalised.

Do not rewrite a non-SOS partition merely to add an all-null physical column when its logical hash agrees with source.

### 9.4 Repair unit and diagnostics

A count or hash mismatch repairs the complete selected day/connector/pollutant partition.

Do not introduce per-timeseries patching.

A complete row-by-row pre-repair diff is not required. Keep diagnostics bounded. Suitable evidence includes:

- source hash;
- R2 hash;
- row counts;
- status counts;
- affected partition identity;
- limited examples or category counts where already inexpensive.

Do not emit unbounded canonical rows into logs or SQLite.

### 9.5 Replacement writer

Update the Integrity source-to-R2 writer so new Parquet:

- uses `verification_status` only;
- uses the exact canonical rows passed to the shared helper;
- writes the required hash and status-count manifest fields;
- retains finite negative values;
- preserves duplicate conflict rules;
- preserves UK-AIR timestamp and annual-boundary behaviour;
- preserves selected-pollutant and exact-prefix repair scope.

### 9.6 Post-write verification

After writing a selected pollutant partition:

- GET/read the live R2 Parquet;
- canonicalise it through the shared helper;
- require equality with the source hash and status counts;
- verify the pollutant manifest contains the same result;
- only then rebuild parent manifests, indexes and AQI.

A failed post-write hash check is a failed repair and must not be reported as completed.

### 9.7 SQLite

Store compact comparison and audit evidence only.

Do not add a persistent authoritative R2 hash cache or the optional future source-hash cache.

Avoid storing complete canonical row sets or unbounded semantic diffs.

## 10. Phase 4: update active readers, validators and backup compatibility

**Owner:** VS Code Codex  
**Recommended model:** GPT-5.6 Codex with High reasoning  
**Permission:** Level 1

Update only the active readers and validators required for compatibility.

### 10.1 Observation readers

Active R2 observation readers must:

- read canonical `verification_status` when present;
- fall back to legacy `status`;
- otherwise return null;
- expose the canonical name `verification_status` in any observation result that includes this quality field;
- avoid returning both names;
- remain able to read legacy Parquet without the column.

This likely includes the observation-history API worker and cache-proxy station-history reader. Inspect actual active code rather than assuming all listed files require edits.

Public website display of the field is out of scope.

### 10.2 Manifest validation

Update strict validation so:

- new canonical manifests require valid hash fields and status counts;
- legacy manifests remain readable and are classified as hashless rather than corrupt solely because the new fields are absent;
- hash row count equals manifest row count;
- status counts sum to row count;
- hash column list and contract version are exact;
- unknown algorithms or contract versions fail closed where semantic comparison is required.

### 10.3 Index handling

Preserve existing index byte-stability.

Indexes should continue to refer to the pollutant `manifest_hash`. Do not duplicate full observation-content hashes into every index unless current index validation genuinely requires it.

Do not add run timestamps or other volatile fields.

### 10.4 Dropbox backup

Confirm the existing backup copies the changed manifests and Parquet without a new path.

Do not change backup code when complete manifest bytes and day units are already copied correctly.

If a strict allow-list must be updated, make the smallest deterministic change and explain why it was required.

## 11. Phase 5: minimal structural checks and Codex handover

**Owner:** VS Code Codex  
**Recommended model:** GPT-5.6 Codex with High reasoning

Run only the smallest checks needed to establish structural viability:

1. Syntax/type checking for changed JavaScript/TypeScript/Python.
2. The focused shared-helper deterministic check from Phase 1.
3. Existing directly relevant writer/reader checks where they are fast and local.
4. One focused legacy-Parquet compatibility check only if needed to prove missing/new/legacy status-column handling.
5. `git diff --check`.

Do not:

- call Supabase, R2, Dropbox, GCP, Cloudflare or external source APIs;
- run Prune Daily;
- run Integrity;
- create broad new tests;
- perform historical repairs;
- edit `system_docs/`;
- commit or push unless the user explicitly asks.

Codex must provide a handover containing:

- files changed;
- archive files created;
- final schema/version decision;
- exact canonical status normalisation;
- shared helper interface;
- Prune Daily source-status path;
- Integrity detector and proposal hash evidence path;
- legacy hashless behaviour;
- reader compatibility behaviour;
- manifest fields and validators;
- SQLite changes, including confirmation that no R2 hash cache was added;
- backup/index changes or confirmation none were needed;
- checks run;
- exact manual TEST deployment/execution steps;
- expected Prune Daily, R2, Dropbox and Integrity evidence;
- rollback notes;
- affected authoritative system documents for ChatGPT review.

Phases 0 to 5 should be completed in one Codex implementation request unless Phase 0 finds a genuine blocker.

## 12. Phase 6: review and place the implementation on TEST main

**Owner:** User/operator and ChatGPT in Chat mode

After Codex finishes:

1. Provide the Codex handover and diff summary to ChatGPT.
2. ChatGPT checks the implementation against the authoritative system documents and this plan.
3. Resolve any clear contract mismatch before operational use.
4. The user reviews, commits and pushes the focused implementation to TEST `main` through the normal repository workflow.
5. Apply or deploy only through the current established TEST path identified by the handover.

Do not start a historical repair in this phase.

If Codex reports that a schema-repo change is genuinely required, pause here and create a separate narrow apply step before running Prune Daily.

## 13. Phase 7: real TEST Prune Daily validation

**Owner:** User/operator, with ChatGPT analysing the run

Run one normal Prune Daily Phase B operation through the current TEST execution path.

This is the primary functional validation for the normal writer.

Confirm only:

- the task completes under existing success/failure rules;
- pruning remains blocked if observation hash or status validation fails;
- each non-empty observation pollutant manifest contains valid hash fields;
- `verification_status_counts` sums to the row count;
- the manifest column list contains `verification_status`;
- SOS rows contain canonical `P`, `R` or null;
- other connectors use null unless an equivalent status is documented;
- no Parquet contains both `status` and `verification_status` from the new writer;
- PM context is absent from observation Parquet, hash and status counts;
- parent manifests and targeted indexes refer to the final child manifest hashes;
- unrelated days do not churn;
- task-health and structured logs contain bounded hash diagnostics;
- no secrets or canonical rows are dumped to logs.

One successful normal TEST operation and representative output inspection are sufficient unless a real failure identifies a specific additional check.

## 14. Phase 8: Dropbox backup validation

**Owner:** User/operator, with ChatGPT analysing the backup evidence

Run or wait for the next normal TEST R2-to-Dropbox backup after the accepted Prune Daily write.

Confirm:

- the affected day folder is copied through the existing path;
- the Dropbox pollutant manifest contains exactly the R2 hash and status-count fields;
- the Parquet contains canonical `verification_status`;
- no separate hash object, inventory category or checkpoint section was created;
- only genuinely changed units were recopied;
- index and manifest byte-stability did not cause unrelated broad backup churn.

This successful backup establishes the baseline required for normal Integrity comparison.

## 15. Phase 9: scoped Integrity functional validation

**Owner:** User/operator, with ChatGPT analysing logs and outputs

Use the dedicated Integrity machine and its normal dispatcher.

### 15.1 Recent hash-bearing day

Run one narrowly scoped check against a day produced by the new Prune Daily writer after its Dropbox backup.

Expected result:

```text
source and R2 counts agree
source and manifest observation_content_hash agree
verification_status_counts agree
no observation data repair is planned
```

### 15.2 Historical hashless or incorrect day

Use `2025-01-01` as the preferred bounded SOS validation day because it also exercises the already-corrected previous-year UK-AIR source discovery.

Run a scoped real repair only after reviewing the check or dry-run evidence supplied by the implementation.

Expected behaviour:

- Integrity downloads or reuses both required annual years;
- count equality no longer ends comparison;
- a legacy missing hash causes Dropbox Parquet hash calculation;
- shifted timestamps, changed values or missing verification status create a hash mismatch even when counts match;
- only affected day/connector/pollutant prefixes are rebuilt;
- new live R2 hash and status counts equal source truth;
- AQI is rebuilt only for changed PM2.5, PM10 or NO2 partitions;
- O3 observation repair does not queue AQI;
- final verification succeeds.

Do not broaden immediately to a month or year.

### 15.3 Post-repair Dropbox confirmation

After the scoped repair succeeds, run the next Dropbox backup and then rerun a normal check for the same day.

Expected final result:

```text
counts agree
source hash equals Dropbox manifest hash
status counts agree
no observation repair remains
```

## 16. Phase 10: ChatGPT implementation reconciliation

**Owner:** ChatGPT in Chat mode using Thinking

Using the Codex handover, committed code and real TEST evidence:

1. Compare implementation with:
   - `system_docs/r2_history/integrity.md`;
   - `system_docs/r2_history/aqi_history_write_pipeline.md`;
   - `system_docs/r2_history/README.md`.
2. Correct any documentation detail that differs from the accepted implementation, without weakening the fixed behaviour.
3. Add exact schema/version and operational details discovered during implementation.
4. Preserve one authoritative home for each rule.
5. Do not copy implementation plans into system documentation.
6. Keep the dated pre-hash snapshot historical and untouched.

No system-document update is needed merely to repeat behaviour already documented accurately.

## 17. Phase 11: controlled historical adoption

**Owner:** User/operator, with ChatGPT preparing and reviewing each bounded run

Proceed only after Phases 7 to 10 are accepted.

Repair historical SOS observation history in explicit operator-approved, month-sized ranges, ending before the current UTC day.

For each range:

1. Confirm a current Dropbox baseline.
2. Run the selected Integrity repair with explicit pollutants.
3. Review count and hash mismatch summaries.
4. Confirm complete selected-pollutant repairs only.
5. Confirm live R2 post-write hash equality.
6. Confirm AQI rebuild scope.
7. Run the next Dropbox backup.
8. Confirm a subsequent check reports count and hash agreement.

Do not require a complete row diff.

Do not run the whole historical period in one invocation.

WHO historical calculation should not be treated as authoritative until the relevant underlying observation dates have completed this adoption and verification process.

## 18. Phase 12: optional measured source-hash cache

**Owner:** ChatGPT for design, VS Code Codex for a later implementation, user/operator for TEST validation

This phase is not part of the initial implementation.

Consider it only if real Integrity timings show source hash creation is a material bottleneck.

Any later cache must:

- be non-authoritative;
- store source-side hashes only;
- never replace the R2 manifest hash as R2 truth;
- use complete invalidation identities listed in Section 3.10;
- remain bounded and have an explicit retention/cleanup policy;
- report cache hit/miss evidence;
- preserve exact results compared with uncached calculation.

Do not add it merely because the existing SQLite database is large. Measure the source-hashing cost first.

## 19. Rollback

### 19.1 Before a real TEST write

Revert the implementation commit. No R2 or Dropbox rollback is needed.

### 19.2 After a new Prune Daily write but before historical repairs

- Revert the implementation if the new writer is defective.
- Do not delete the affected R2 partition manually.
- Use an approved scoped Integrity repair or rerun through the corrected writer once the defect is fixed.
- Keep pruning blocked while hash or manifest verification is unreliable.

Legacy readers must remain able to read the new column, so a code rollback must be assessed against any already-written schema-version change.

### 19.3 During historical adoption

Stop at the current bounded range.

Do not continue to later months until the failed range is understood. Rerun the same selected scope from the authoritative source and chosen Dropbox baseline after fixing the implementation.

Do not restore one-hour-shifted or status-losing Parquet merely to recreate the previous state.

## 20. Codex implementation prompt

```text
Use GPT-5.6 Codex with High reasoning.

Implement Phases 0 to 5 of:
plans/2026-07-25 Observation Content Hash & Verification Status/2026-07-25_Observation_Content_Hash_and_Verification_Status_plan.md

Work primarily in TEST-uk-aq/uk-aq-ops. Follow AGENTS.md. Use grep, not rg. Do not inspect or modify LIVE.

Read the authoritative system documents listed in the plan. They are read-only. Do not edit system_docs/.

This is a TEST system. Perform minimal pre-deployment checking. Do not deploy, run Prune Daily, run Integrity, call Supabase, R2, Dropbox, Cloudflare, GCP or external source APIs, or perform historical repairs.

Implement one coordinated observation-content-hash and verification-status contract:

1. Add one shared JavaScript helper, expected at workers/shared/uk_aq_observation_content_hash.mjs.
2. Use one observation_content_hash per non-empty day_utc + connector_id + pollutant_code partition.
3. Store the hash and verification_status_counts in the existing pollutant manifest.
4. Include connector_id, station_id, timeseries_id, pollutant_code, observed_at_utc, binary64 value and verification_status in hash contract version 1.
5. Use canonical verification_status values P, R or null.
6. For UK-AIR/SOS map P/Provisional to P, R/Ratified to R, blank/null to null and fail closed on any other non-empty value.
7. Do not lock ratified rows.
8. Make both Prune Daily and Integrity source-to-R2 use the exact same helper and canonical rows.
9. New Parquet writes verification_status only. Readers fall back to legacy status, then null.
10. Keep total and per-timeseries counts as the first Integrity check, but require source hash versus Dropbox pollutant-manifest hash when counts match.
11. Treat a hashless legacy manifest as requiring a Dropbox Parquet hash calculation, not automatic data replacement.
12. Repair the complete selected day/connector/pollutant partition on count or hash mismatch.
13. Do not add per-timeseries hashes or require a complete pre-repair row diff.
14. After a real repair, require the live R2 Parquet hash and status counts to equal source truth before parent manifests, indexes or AQI continue.
15. Do not add an authoritative R2 hash cache or the optional source-hash cache to SQLite.
16. Preserve existing Dropbox paths, manifest/index byte-stability and all protected behaviour in the plan.

Before changing substantial active non-test code, create the required archive copies under archive/2026-07-25/. Do not archive documentation, plans, workflows, tests or fixtures.

Inspect first and change only proven active files. If normal Prune Daily cannot obtain the existing source status without a database/RPC change, stop and report the exact missing interface rather than omitting status or broadening to a schema migration.

Run only:
- syntax/type checks for changed code;
- one focused deterministic shared-helper check;
- directly relevant existing fast writer/reader checks;
- one focused legacy status-column compatibility check only if genuinely needed;
- git diff --check.

At the end provide:
1. files changed;
2. archive files created;
3. final schema/version decision;
4. shared helper interface and canonical encoding;
5. verification-status source mapping;
6. Prune Daily integration;
7. Integrity count/hash comparison and repair integration;
8. legacy hashless and legacy status behaviour;
9. reader, manifest, index and backup compatibility;
10. SQLite changes and confirmation no hash cache was added;
11. checks run;
12. exact manual TEST deployment and execution steps;
13. expected Prune Daily, R2, Dropbox and Integrity evidence;
14. rollback notes;
15. concise handover for ChatGPT to reconcile system_docs after real TEST acceptance.
```

## 21. Acceptance criteria

The work is accepted when all of the following are true:

- both writers call one shared hash helper;
- canonical new Parquet uses `verification_status`;
- UK-AIR statuses normalise to P/R/null and unknown values fail closed;
- ratified data remains correctable;
- each non-empty pollutant manifest contains valid hash fields and status counts;
- count equality alone no longer proves Integrity success;
- changed values, timestamps or statuses are detected by hash mismatch;
- legacy hashless partitions are classified through Parquet content comparison;
- non-SOS all-null status compatibility does not force unnecessary data rewrites;
- a complete pollutant partition is the repair unit;
- a complete pre-repair diff is not required;
- live post-repair hash equality is mandatory;
- no duplicate authoritative R2 hash cache exists in SQLite;
- Dropbox uses its existing backup path;
- one normal TEST Prune Daily operation succeeds;
- one recent hash-bearing Integrity check succeeds;
- one bounded historical Integrity repair and later Dropbox-backed recheck succeed;
- system documentation is reconciled by ChatGPT after implementation and real TEST evidence.