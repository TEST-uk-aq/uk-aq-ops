# 2026-07-18 R2 connector-day transactional repair

## Status

Implementation plan for the UK AQ TEST system.

- Repository: `TEST-uk-aq/uk-aq-ops`
- Scope: TEST only
- Plan date: 18 July 2026
- Recommended Codex configuration: Codex with High reasoning
- Codex execution model: VS Code Codex working only in the local checkout
- Default permission level: Level 1 code changes and minimal local validation
- Real TEST operations: performed manually by the user or with ChatGPT guidance
- System documentation owner: ChatGPT in Chat mode after implementation and real TEST validation

## Objective

Replace the current targeted v2 observation-repair finalisation path with a reusable connector-day transaction that:

1. stages all targeted repair chunks without changing the committed connector-day;
2. finalises one complete connector-day containing repaired and unaffected data;
3. generates every v2 observation manifest through one canonical manifest compiler shared with the normal writer;
4. publishes the completed hierarchy safely from data children to parent manifests;
5. returns a structured commit receipt describing exactly what was committed;
6. verifies the committed result against fresh live R2 evidence rather than the pre-repair Dropbox mirror; and
7. uses authoritative `timeseries_id -> observed_property_code` identity rather than label-based pollutant guessing.

The same implementation must support metadata-only reconstruction when the Parquet data is already valid but pollutant, connector or day manifests are incomplete, stale or noncanonical.

The immediate TEST recovery target is:

- day: `2026-07-12`
- connector: Sensor.Community, `connector_id=7`

The immediate recovery must not rewrite the observation Parquet again unless the implemented canonical inspection proves a real data discrepancy.

## Local-only Codex rule

Every Codex instruction in this plan is for VS Code Codex operating against the local repository checkout.

Codex must:

- work only in:
  `/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops`;
- inspect the local source tree, local `system_docs/` and the six local evidence files listed below;
- make local file edits only;
- run only fast local, non-destructive structural checks;
- use `grep` and `find` for discovery, as required by `AGENTS.md`;
- make no GitHub API, GitHub connector, web search, remote repository or online documentation calls;
- make no commits or pushes;
- make no R2, Dropbox, Supabase, GCP, Cloudflare or other external operational changes; and
- stop after code implementation, minimal local checks, exact operator commands and the ChatGPT documentation handover.

The user or ChatGPT can inspect the online repository, run the TEST operation, run the Dropbox backup, review the resulting evidence and complete the system documentation later.

## Evidence files

The six evidence files exist only in the local checkout. They are not expected to exist in GitHub.

Codex must inspect these exact files before editing:

```text
/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/logs/2026-07-18T171648Z-summary.json
/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/logs/2026-07-18T184522Z-summary.json
/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/logs/all_v2_run_backfill_2026-07-12_run1.log
/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/logs/run-2026-07-18T171648Z.log
/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/logs/run-2026-07-18T184522Z.log
/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/logs/v2_check_2026-07-12_after_repair.log
```

Codex should treat:

- the `17:16:48Z` files and `all_v2_run_backfill_2026-07-12_run1.log` as evidence from the repair-enabled operation; and
- the `18:45:22Z` files and `v2_check_2026-07-12_after_repair.log` as evidence from the later read-only operation after the new Dropbox backup.

Codex must verify that classification from the file contents rather than relying only on the filenames.

## Why this is a long-term change

The incident appears to expose several related weaknesses rather than one isolated condition:

- targeted repair chunks can stage and finalise separately;
- the final write can represent only the pollutants included in the targeted repair rather than every valid child already present for the connector-day;
- different write or repair paths can produce different manifest fields;
- post-write verification can read the older Dropbox backup rather than the newly committed live R2 object;
- source/R2 comparison can fall back to a limited label normaliser that does not represent every observed property; and
- a manifest-only defect can currently lead towards an unnecessary data backfill.

A narrow patch for `2026-07-12` would leave the same failure modes available for future connectors, pollutants and repair scopes. This plan therefore defines one reusable connector-day transaction and one canonical manifest-generation path.

## Mandatory diagnosis confirmation before implementation

The diagnosis in this plan is a working hypothesis, not permission to assume the cause.

Before making any implementation edit, Codex must:

1. read the current code, local logs, local reports and relevant system documentation;
2. trace each suspected failure through the current Integrity coordinator, source-to-R2 writer, targeted-stage code, manifest builders and final-verification path;
3. state separately for every finding whether it is:
   - confirmed;
   - partially confirmed; or
   - not confirmed;
4. cite the exact local filename, timestamp or JSON field and exact code function for every conclusion; and
5. make no implementation change until the relevant failure path is confirmed.

Codex must specifically confirm or reject each of these hypotheses:

1. The repair chunks completed their subprocesses, with earlier chunks staging and the final chunk writing the combined result.
2. The immediate post-write guard read a pre-repair Dropbox manifest rather than fresh live R2 evidence.
3. The final committed Sensor.Community connector manifest represented only the targeted PM children and omitted valid unaffected meteorological children from its parent hierarchy.
4. The PM Parquet row total written by the repair matches the fresh source total, but the PM pollutant manifests are missing fields required by the canonical v2 contract.
5. The humidity, pressure and temperature source/R2 mismatches in the later check are false positives caused by the source-count property filter failing to resolve those observed-property codes.
6. Connector and day parent manifests were compiled from an incomplete or noncanonical child set.
7. AQI data for the affected day remained valid and does not require rebuilding solely because the observation parent metadata is faulty.
8. The current code lacks a safe metadata-only connector-day manifest reconstruction path.

If a hypothesis is not confirmed, Codex must not implement a speculative fix for it. It must stop that part of the implementation, explain the contradictory or insufficient evidence, and identify the smallest targeted check needed to resolve it.

If the issue is real but this plan's proposed cause is wrong, Codex must correct the diagnosis before proposing or implementing the solution.

## Authoritative reading and constraints

Before editing code, Codex must read:

1. `AGENTS.md`
2. `system_docs/README.md`
3. `system_docs/documentation_contract.md`
4. `system_docs/r2_history/README.md`
5. `system_docs/r2_history/integrity.md`
6. `system_docs/r2_history/contract.md`
7. `system_docs/r2_history/operations.md`
8. `system_docs/r2_history/validation.md`
9. `system_docs/r2_history/aqi_history_write_pipeline.md`
10. the current v2 observation writer, manifest builders, targeted-stage implementation, Integrity repair planner and live-R2/Dropbox verification helpers
11. the six local evidence files listed above

`system_docs/` is read-only to Codex. Codex must not create, edit, move, rename or delete anything under `system_docs/`.

After implementation and real TEST validation, Codex must provide a concise documentation handover. ChatGPT in Chat mode will update the system documentation from the implemented code, the handover and the real TEST results.

This is a TEST system. Follow the TEST System Validation Policy in `AGENTS.md`:

- run only the smallest structural checks before real operation;
- do not create or run a broad test suite;
- do not perform soak testing, exhaustive fixtures, shadow comparisons or repo-wide validation;
- functional validation happens through one controlled real operation on TEST;
- do not touch LIVE repos, R2, databases, services or schedules;
- do not run the real repair, backup or Integrity operation from Codex; and
- provide exact commands for the user or ChatGPT to run.

Codex should implement only the code and configuration needed for this plan. It must not expand into unrelated cleanup, documentation rewriting, historical data repair, workflow redesign or broad refactoring.

Because this is a substantial change to active non-test code, follow the archive policy in `AGENTS.md` for the active code files actually changed. Do not archive tests, plans, logs or system documentation.

## Existing behaviour that must remain

Preserve the following unless confirmed evidence shows that one must change:

- Integrity remains v2-only.
- UTC remains authoritative for backend, R2, database, scheduler and Integrity dates.
- The Dropbox backup-readiness gate remains mandatory before a repair operation.
- Dropbox remains the normal independent local mirror used for read-only detection and later audit.
- `--check-only` and `--run-backfill` remain mutually exclusive.
- Source filters and explicit selected-day behaviour remain available.
- O3, source-provided index observations and every other valid observation child must remain preservable even when they are not included in a targeted repair.
- AQI remains limited to its supported pollutants and remains separate from source observations.
- Missing or unreadable child data must fail closed.
- R2 history index byte-stability requirements remain unchanged.
- Existing JSON, Markdown, SQLite and daily-task-health reporting remain available.
- Existing manual, daily, weekly and monthly profile behaviour remains available unless this implementation genuinely requires a documented compatibility change.
- No repair may silently remove an unaffected pollutant, timeseries, file or child-manifest reference from a committed connector-day.

## Target architecture

### 1. One canonical v2 observation manifest compiler

Create or consolidate one shared implementation responsible for producing canonical v2 observation manifests.

It must compile:

1. a pollutant manifest from the actual Parquet objects for that pollutant partition;
2. a connector manifest from every valid pollutant child for the connector-day; and
3. a day manifest from every valid connector child for the day.

The compiler must derive parent fields from child evidence rather than accepting independently calculated totals.

At minimum, canonical output must include every field required by the existing v2 contract, including the appropriate:

- manifest identity and hierarchy fields;
- history version, domain, profile and grain;
- day, connector and pollutant identity;
- file and object-key lists;
- total row counts;
- per-timeseries row counts where required;
- child-manifest references and hashes;
- pollutant or connector identity sets;
- schema and writer identity fields;
- deterministic ordering; and
- manifest hashing.

Codex must establish the exact canonical field set from the current authoritative normal writer, valid existing manifests and the system documentation. It must not invent a second schema for repairs.

The canonical compiler should live with the active writer/shared JavaScript or TypeScript code. Python Integrity orchestration must invoke the shared compiler or a small CLI built on it. Do not create a separate Python manifest generator that can drift from the normal writer.

### 2. Authoritative observed-property identity

Replace label-based pollutant inference in source/R2 count comparison with authoritative identity from the imported core snapshot.

The preferred relationship is:

```text
timeseries_id -> phenomenon or mapping -> observed_property_code
```

The implementation must work for every active observed property represented by the core snapshot, including meteorological and future properties. It must not depend on adding humidity, pressure and temperature to another hardcoded normaliser.

Text normalisation may remain only as a diagnostic fallback where authoritative metadata is genuinely absent. A fallback must be reported explicitly and must not silently compare the full connector source total against an individual property partition.

### 3. Chunk staging without live partial commits

Chunking may remain for large Sensor.Community repairs, but chunks must contribute only to one staged connector-day transaction.

Each non-final chunk must:

- parse or obtain its targeted source rows;
- merge its replacement scope into the transaction's staged state;
- persist enough deterministic staged metadata to resume or finalise safely;
- write no committed connector, day or index manifests; and
- never be reported as a completed repair transaction.

The final chunk must not infer the final connector pollutant set from only the targeted chunk rows.

### 4. Complete connector-day finalisation

The finaliser must assemble the complete connector-day from:

```text
valid existing unaffected pollutant and timeseries data
+ repaired replacement data
- explicitly replaced old data for the repair scope
```

It must preserve unaffected children such as humidity, pressure, temperature, O3 or source index observations whenever those children remain valid under the v2 contract.

The finaliser must read or verify every existing child needed for the complete connector-day. Missing, unreadable or conflicting child evidence must fail closed before the committed parent hierarchy is changed.

### 5. Safe publish boundary

Use the smallest safe publish model compatible with the current R2 readers and object-key contract.

The required ordering is:

1. prepare and verify complete staged data;
2. write new or replacement Parquet objects;
3. write canonical pollutant manifests;
4. write the canonical connector manifest;
5. write the canonical day manifest;
6. rebuild only the affected indexes after the connector-day commit has been verified.

Treat the connector manifest as the minimum connector-day commit point unless the current architecture already has a stronger generation or commit-pointer abstraction.

Do not introduce a broad new reader-generation system in this implementation unless Codex confirms it is already supported or is necessary for correctness. If immutable generations and a pointer would require changes across multiple readers, report that as a later hardening option rather than expanding this plan.

Old unreferenced objects should not be deleted by the repair transaction. Existing cleanup or a separately controlled garbage-collection process can remove them later.

### 6. Structured commit receipt

The final writer result must expose a machine-readable receipt containing at least:

- transaction or run identity;
- history version and domain;
- day and connector identity;
- targeted replacement timeseries IDs;
- complete committed pollutant set;
- connector manifest key;
- connector manifest hash or equivalent stable object identity;
- committed connector row count;
- committed per-timeseries row counts or their canonical hash;
- written object keys;
- preserved child count;
- replaced child or timeseries count; and
- finalisation status.

Integrity must consume this receipt rather than treating a generic `rows_read` value as proof of the committed connector contents.

### 7. Fresh live-R2 post-write verification

Immediately after the final transaction publishes, Integrity must verify the exact connector manifest identified by the receipt using a fresh live-R2 read.

Verify at minimum:

- the expected day and connector identity;
- the committed manifest hash or object identity;
- the complete pollutant set;
- the connector total derived from children;
- the per-timeseries counts or canonical count hash;
- child-manifest existence and identity; and
- required object existence.

The pre-repair Dropbox mirror must not be accepted as proof of a write performed after that backup.

Dropbox remains the independent later audit source. If fresh live-R2 verification cannot be completed, stop the repair chain before index or AQI-dependent work and report a specific verification failure such as `post_write_live_r2_verification_unavailable`.

### 8. Metadata-only connector-day reconstruction

Add a repair mode that reconstructs canonical pollutant, connector and day manifests from existing valid Parquet objects without re-downloading source data or rewriting the Parquet.

This path must:

- read the actual existing Parquet contents or authoritative object metadata;
- calculate the canonical per-timeseries and aggregate counts;
- compile canonical manifests with the shared compiler;
- preserve every valid child;
- publish child-to-parent;
- return the same commit receipt shape; and
- perform the same fresh live-R2 verification.

Integrity repair planning should choose this path when data files are readable and complete but manifests or parent aggregates are missing, stale, incomplete or noncanonical.

### 9. Repair classification

Keep detection separate from repair execution and classify findings into the smallest correct action:

- data valid, manifest invalid: metadata-only manifest reconstruction;
- manifest valid, targeted index missing or stale: targeted index rebuild only;
- data genuinely missing, unreadable or incomplete with authoritative source evidence: connector-day data transaction;
- source evidence unavailable or ambiguous: report and stop without speculative repair;
- observation parent metadata faulty but AQI data independently valid: do not rebuild AQI solely because of the parent metadata defect.

## Minimal implementation phases

Codex should perform only the following phases. The user or ChatGPT will do the real TEST operation, backup, result analysis and documentation.

### Phase 0: confirm the diagnosis locally

1. Read the documents and six local evidence files listed above.
2. Use `find` and `grep` to identify the active writer, targeted-stage, manifest compiler, Integrity planner, repair guard and source-property mapping code.
3. Produce a concise diagnosis table for the eight hypotheses.
4. Identify the smallest active code ownership set required for the confirmed fixes.
5. Stop without editing if the evidence does not support the proposed architecture or if an authoritative contract conflicts with it.

Deliverable: confirmed diagnosis and exact local file ownership map.

### Phase 1: archive the active code files that will change

Follow `AGENTS.md` exactly:

- archive active non-test implementation code only;
- use `archive/2026-07-18/<original-relative-path>`;
- do not archive logs, plans, tests, fixtures or system documentation;
- do not duplicate a file already archived on the same date; and
- never wire archive paths into active execution.

Deliverable: dated rollback copies of only the active implementation files changed.

### Phase 2: implement the shared connector-day transaction

Implement the minimum confirmed code changes needed to provide:

1. authoritative observed-property identity for source/R2 comparisons;
2. one canonical v2 observation manifest compiler;
3. staged chunk accumulation without live parent-manifest commits;
4. complete connector-day finalisation preserving unaffected children;
5. canonical child-to-parent publish order;
6. a structured commit receipt;
7. fresh live-R2 post-write verification; and
8. metadata-only connector-day reconstruction and repair classification.

Prefer small shared modules or CLIs over adding more branches to the large Python orchestrator. Reuse current writer primitives and current R2 clients wherever possible.

Do not rewrite unrelated observation, AQI, backup or index systems.

Deliverable: focused local code implementation.

### Phase 3: minimal local structural validation

Run only the smallest checks needed to show structural viability:

1. syntax or compile checks for each changed Python, JavaScript, TypeScript or shell file;
2. import or module-load checks for newly shared modules or CLIs; and
3. one narrowly targeted local temporary-directory check proving that:
   - a targeted PM replacement preserves unaffected humidity, pressure and temperature children;
   - the connector total is derived from all canonical pollutant children;
   - the generated pollutant, connector and day manifests contain the canonical required fields; and
   - the source-count classifier resolves a meteorological observed property through authoritative metadata rather than comparing the whole connector total.

This single targeted local check is genuinely required because the observed failure mode can silently remove unaffected children from parent manifests. It must use temporary local files only, make no network calls and must not become a broad new test suite.

Do not run the full Integrity suite, broad fixtures, external APIs or any real R2 operation.

Deliverable: minimal structural checks passed, or a precise blocker report.

### Phase 4: stop and hand over

Codex must not run deployment or real TEST operations.

Its final response must include:

1. diagnosis status for every hypothesis;
2. root cause as confirmed from local evidence;
3. files changed;
4. archive files created;
5. implementation summary;
6. commit-receipt contract;
7. repair-classification behaviour;
8. local checks run and results;
9. exact manual commands for the user or ChatGPT to perform the TEST recovery and validation;
10. rollback instructions;
11. known limitations or deferred hardening;
12. the affected `system_docs/` files; and
13. a concise ChatGPT documentation handover.

## Real TEST recovery to be performed outside Codex

Codex must provide the exact commands but must not execute them.

The intended sequence is:

1. deploy or update the complete TEST ops checkout;
2. confirm no Integrity or backup process is already running;
3. run a metadata-only reconstruction for `2026-07-12`, `connector_id=7`;
4. verify the live-R2 commit receipt and fresh live manifest evidence;
5. run the R2 History Dropbox backup;
6. wait for local Dropbox sync to complete;
7. run a read-only Integrity check for `2026-07-12`;
8. confirm observation manifest and parent-hierarchy findings are cleared;
9. confirm AQI remains valid without an unnecessary rebuild; and
10. only run a data backfill if the canonical Parquet inspection proves a real remaining per-timeseries data discrepancy.

Codex should use the actual implemented CLI options in its commands. Do not invent a command name before the implementation has established the final interface.

## Real TEST acceptance criteria

The first controlled TEST recovery is successful when:

- every valid Sensor.Community pollutant child for connector 7 on `2026-07-12` remains represented;
- PM10 and PM2.5 canonical manifests contain the required field set and accurate per-timeseries counts;
- humidity, pressure and temperature are not reported against the complete connector source total;
- connector totals equal the sum of every canonical pollutant child;
- day totals equal the sum of every canonical connector child;
- child references and manifest hashes are internally consistent;
- the writer receipt matches a fresh live-R2 read;
- the later Dropbox-backed read-only Integrity run agrees with the committed hierarchy;
- no unnecessary AQI rebuild occurs;
- the operation does not rewrite valid Parquet when metadata-only reconstruction is sufficient; and
- the final Integrity status for the affected observation hierarchy is clear or contains only separately understood source-mapping findings.

One real metadata-only recovery and one subsequent read-only Integrity check are sufficient for this TEST system unless they expose a specific new fault.

## Rollback requirements

The implementation must preserve a clear rollback route:

- active code files can be restored from the dated archive or Git history;
- the transaction must not delete old observation objects;
- a failed transaction must stop before parent or index progression where possible;
- the receipt must list the new objects and manifests written;
- the operator instructions must explain how to restore the previous connector and day manifests when necessary; and
- no automated cleanup of superseded objects should be introduced in this plan.

## ChatGPT system-documentation handover

Codex must not edit `system_docs/`.

After the real TEST operation, ChatGPT in Chat mode will update the relevant R2 History documentation. Codex must identify the exact affected documents, expected to include at least:

- `system_docs/r2_history/integrity.md`
- `system_docs/r2_history/contract.md`
- `system_docs/r2_history/operations.md`
- `system_docs/r2_history/validation.md`
- `system_docs/r2_history/aqi_history_write_pipeline.md` where the observation-to-AQI handoff or skip behaviour requires clarification

The handover must explain:

- the canonical manifest compiler;
- connector-day staging and commit semantics;
- preservation of unaffected children;
- the commit receipt;
- fresh live-R2 verification versus later Dropbox audit;
- metadata-only reconstruction;
- authoritative observed-property identity;
- repair classification; and
- the real TEST evidence and final outcome.

## Out of scope

Do not include:

- LIVE changes;
- broad reader-generation or version-pointer redesign unless current code already supports it and it is required for correctness;
- general R2 garbage collection;
- historic repair of dates other than the explicit TEST recovery target;
- broad AQI changes;
- schedule changes;
- new Supabase schema;
- replacement of the mandatory Dropbox backup;
- system documentation edits by Codex;
- broad automated test coverage; or
- unrelated cleanup of the large Integrity orchestrator.
