# 2026-07-19 Integrity canonical repair alignment

## Status

Implementation plan and VS Code Codex prompt for the UK AQ TEST system.

- Repository: `TEST-uk-aq/uk-aq-ops`
- Scope: TEST only
- Plan date: 19 July 2026
- Recommended Codex configuration: Codex with High reasoning
- Codex execution model: VS Code Codex working only in the local checkout
- Permission level: Level 1 code changes plus the smallest necessary local structural validation
- Real TEST operations: performed manually by the user or with ChatGPT guidance
- System documentation owner: ChatGPT in Chat mode after implementation and real TEST validation

This plan supersedes the active implementation direction in:

```text
plans/2026-07-18_R2_connector_day_transactional_repair/
```

Do not edit or delete that older plan. It remains historical evidence of the abandoned generation-and-receipt design.

## Objective

Bring the active v2 Integrity implementation into line with the authoritative contract in:

```text
system_docs/r2_history/integrity.md
```

The completed implementation must:

1. acquire or reuse authoritative connector source data before comparison;
2. compare source/cache with the chosen Dropbox R2 v2 mirror, not live R2;
3. apply the Dropbox readiness gate in every normal Integrity mode;
4. keep check-only, repair dry-run and real repair behaviour distinct;
5. create a sparse local repair overlay only after detection and repair planning;
6. rebuild an observation data fault as a complete canonical connector-day from source/cache;
7. preserve metadata-only repair when Dropbox Parquet is valid;
8. write directly to canonical R2 v2 paths without generation directories or permanent receipts;
9. delete and replace a canonical observation connector-day only after its complete local replacement is structurally validated;
10. use the validated overlay first and the chosen Dropbox baseline second for all later local manifest, AQI and index work;
11. perform no live-R2 read during detection or repair planning;
12. GET-verify every object written during a real apply;
13. restart an interrupted repair from the beginning with a new overlay; and
14. retain repair audit evidence in local Integrity SQLite, task logs and JSON/Markdown reports.

## Decision status

No further product or operational design decision is required before implementation.

The following decisions are fixed by the system document and this plan:

- no `generation=<transaction>` observation paths;
- no permanent `transactions/.../data-receipt.json` objects;
- no R2 receipt authority or receipt-based recovery;
- no transaction resume;
- no preservation of old canonical Parquet in R2 for rollback;
- a failed or interrupted repair is rerun from the beginning;
- `--allow-stale-dropbox` only bypasses the readiness gate;
- metadata-only findings remain metadata-only;
- a real observation data repair replaces the complete connector-day;
- source/cache and Dropbox are the planning inputs;
- live R2 is used only for the tightly scoped real-apply mutation and post-mutation verification work described below.

Existing generation or receipt objects already present in R2 are not a reason to introduce a bulk cleanup operation in this task. They must not be read as authority, inventoried specially or created again. A complete connector-day replacement may naturally remove legacy objects beneath that connector-day prefix. Any wider historical cleanup requires a separate operator-approved task after TEST validation.

## Confirmed current implementation differences

Codex must confirm these findings locally before editing, but the current `main` implementation has already been reviewed and shows the following differences from the authoritative document.

### 1. Backup gate and mode handling differ

In `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py`:

- the backup readiness gate is currently required only when `args.run_backfill` is true;
- check-only therefore does not currently receive the same readiness protection;
- the repair overlay is created before source acquisition, Dropbox comparison and repair planning;
- the same `args.dry_run` flag is passed into source adapters, and at least the OpenAQ adapter uses it to return a sample plan without acquiring source data;
- the parser permits combinations whose effective mode is not reported explicitly.

The required behaviour is:

- readiness gate for check-only, repair dry-run and real repair, unless `--allow-stale-dropbox` is supplied;
- source acquisition before comparison in every mode;
- no overlay in check-only;
- overlay creation only after detection and repair planning in repair dry-run or real repair;
- one explicit effective run mode in reports and SQLite.

### 2. Observation repair is still transaction, generation and receipt based

The active file:

```text
workers/uk_aq_backfill_local/targeted_observation_transaction.mjs
```

currently owns:

- chunk transaction state;
- transaction finalisation;
- generation-key construction;
- permanent receipt-key construction;
- receipt evidence;
- immutable pre-write HEAD/GET inspection; and
- permanent receipt publication.

`workers/uk_aq_backfill_local/run_job.ts` currently imports that helper and its targeted observation writer:

- selects only complete affected-pollutant rows rather than the complete connector-day source result;
- writes Parquet under generation-specific keys;
- creates and publishes a permanent receipt;
- inspects live R2 generation and receipt objects before the first PUT;
- leaves older unreferenced objects in place; and
- delegates canonical metadata publication to a separate receipt-aware executor.

All active generation, receipt and transaction-resume code must be removed.

### 3. The existing canonical writer is not yet a safe local prepare/apply split

The non-targeted v2 observation writer in `run_job.ts` already has useful canonical path, partition, manifest and GET-verification code. However it currently builds and writes incrementally.

For Integrity data repair it must be refactored so that:

1. the complete connector-day source result is assembled first;
2. every canonical Parquet body and child manifest is built locally;
3. all local objects and deletion scope are structurally validated;
4. no R2 mutation occurs before that validation succeeds; and
5. apply and verification happen only after the complete local proposal is ready.

Reuse canonical builders and writer code where practical. Do not create a second independent observation manifest schema.

### 4. The combined-local resolver uses the wrong overlay states

In `scripts/backup_r2/uk_aq_execute_v2_observations_repair.mjs`, the combined-local resolver currently:

- exposes only overlay objects already marked `r2_verified`;
- hides Dropbox objects only after a tombstone is marked `r2_delete_verified`;
- exposes observation data receipts from run state; and
- contains unreachable or attempted `live_r2` provenance branches.

The required local resolution order is:

1. structurally validated current-run overlay replacement;
2. current-run tombstone, meaning absent from the proposed final state;
3. chosen Dropbox baseline.

Dry-run must be able to use locally built and structurally validated overlay objects without pretending they were uploaded or verified. A proposed tombstone must hide the Dropbox object while later local proposals are built, without claiming the live deletion has happened.

### 5. The metadata executor still uses live manifests and permanent receipts as authority

The metadata executor currently includes:

- observation receipt validation;
- permanent receipt discovery by listing local and live R2 transaction prefixes;
- live pollutant-manifest GET fallback;
- live R2 Parquet fallback;
- generation-key validation; and
- receipt-based manifest source selection.

Remove all of these paths.

Observation metadata planning must use only:

- validated canonical overlay Parquet/manifests from the current run; and
- unchanged canonical objects from the chosen Dropbox baseline.

A metadata-only pollutant-manifest repair must inspect the scoped canonical Dropbox `part-*.parquet` files for that pollutant. It must not use a receipt or live R2 to decide which data is authoritative.

### 6. AQI currently has a live-R2 observation read exception

The current ordered repair flow rebuilds AQI using committed live R2 observations written earlier in the same run, and reports a special live-R2 read exception.

Remove that exception. AQI proposal/build work must consume the combined local view:

```text
validated current-run observation overlay
then unchanged chosen Dropbox observations
```

AQI data/debug replacement objects must be built and structurally validated locally before their own R2 prefixes are mutated. AQI apply remains after the observation hierarchy is successfully applied and verified.

### 7. Backup inventory still scans permanent observation receipts

`scripts/backup_r2/build_backup_inventory.mjs` currently:

- defines an observation transaction receipt pattern;
- recursively scans `transactions/.../data-receipt.json`;
- adds those receipts to observation run-manifest inventory units.

Remove that special receipt scan and its counters/tests. Normal committed canonical data, manifests, indexes, run manifests and stable bindings remain covered by the normal v2 backup inventory.

### 8. Audit and report fields still contain receipt and six-stage assumptions

The Python coordinator, metadata executor and reports currently contain receipt fields, receipt validation, generation capture, `live_r2` source labels and six-stage terminology tied to the superseded implementation.

Replace them with mode, local proposal, apply and verification evidence matching the system document. Planned operations and completed operations must remain separate.

## Existing behaviour to preserve

Preserve these behaviours unless direct local code evidence shows a small compatibility adjustment is required:

- v2-only Integrity;
- UTC backend and storage dates;
- source filters and day/profile scope;
- authoritative core snapshot identity;
- all-property observation support;
- AQI pollutant eligibility rules;
- AQI data/debug separation;
- stable timeseries binding validation and dedicated reconciliation ownership;
- metadata-only repair for valid Parquet;
- deterministic manifest and index ordering;
- R2 history index byte stability;
- JSON, Markdown, SQLite and daily-task-health reporting;
- manual, daily, weekly and monthly profile selection;
- source/cache unavailability failing closed;
- uncertain empty source results never being treated as authoritative no-data;
- current TEST/LIVE guardrails.

Do not broaden the scope to unrelated prune-daily, source gateway, schema, workflow or public API changes.

## Local-only Codex rule

Work only in:

```text
/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops
```

Codex must:

- use Codex with High reasoning;
- read `AGENTS.md` first;
- read `system_docs/r2_history/integrity.md` as the authoritative behaviour contract;
- read the related R2 history system documents needed to preserve schema and index contracts;
- treat all of `system_docs/` as read-only;
- inspect only the local checkout and locally available logs/reports;
- use `grep` and `find`, not `rg`;
- edit local files only;
- make no GitHub, connector, web or remote-repository calls;
- make no commit or push;
- make no R2, Dropbox, Supabase, GCP, Cloudflare or other external operation;
- not run a real Integrity, backfill, backup or repair operation;
- run only the smallest local structural checks described in this plan; and
- stop with an implementation handover and exact manual TEST commands.

## Archive requirement

This is a substantial change to active non-test code.

Before changing or deleting an active non-test code file, archive its current version under:

```text
archive/<execution-date>/<original-relative-path>
```

Follow `AGENTS.md` exactly:

- archive each changed active code file once for the execution date;
- reuse an existing same-day archive instead of duplicating it;
- preserve the original relative path;
- archive a file before deleting it;
- do not archive plans, tests, fixtures, logs, generated files or `system_docs/`;
- never wire archive paths into active execution.

## Mandatory confirmation before editing

Before making implementation edits, Codex must inspect current local code and report each item below as:

- confirmed;
- partially confirmed; or
- not confirmed.

For every conclusion, name the exact local file and function or code block.

Confirm or reject:

1. The backup gate currently runs only for `--run-backfill`.
2. The repair overlay is currently created before detection and planning.
3. Repair dry-run currently prevents at least one source adapter from acquiring or reusing the source data required for comparison.
4. Check-only performs no live R2 access through any indirect executor or writer path.
5. The observation repair path creates transaction state, generation Parquet and a permanent R2 receipt.
6. The targeted writer currently writes affected pollutant partitions rather than a complete source-derived connector-day.
7. The standard canonical writer currently mutates R2 while it is still building the replacement.
8. The combined-local resolver currently requires R2-verified overlay objects and verified deletions before they affect later local planning.
9. The metadata executor currently reads live R2 manifests, transaction receipts or Parquet before metadata PUTs.
10. AQI currently reads same-run committed live R2 observations rather than the combined local view.
11. The backup inventory currently scans permanent observation receipts.
12. Receipt/generation assumptions remain in run state, reports, tests, environment variables or shell wrappers.
13. Current SQLite persistence does or does not retain the object-level audit evidence required by the system document.
14. Every active caller of the Integrity CLI and backfill wrapper, including scheduled check-only use, is identified before mode or environment-variable compatibility is changed.

Do not implement a speculative fix for an item that is not confirmed. Where the system document requires a behaviour but the assumed current cause is wrong, implement the smallest accurate change that satisfies the document and explain the corrected diagnosis.

## Target architecture

### Effective modes

Resolve one explicit effective mode early in the Python entrypoint:

```text
check_only
repair_dry_run
repair_apply
```

Preserve active CLI compatibility after inspecting all callers. At minimum:

- `--check-only` resolves to `check_only`;
- `--run-backfill --dry-run` resolves to `repair_dry_run`;
- `--run-backfill` without `--dry-run` resolves to `repair_apply`;
- `--check-only` and `--run-backfill` remain mutually exclusive.

Any legacy no-write invocation that is still active must be mapped explicitly to check-only behaviour rather than silently retaining a fourth mode. Record the effective mode in SQLite and reports.

### Detection inputs

For all modes:

1. run or explicitly bypass the Dropbox readiness gate;
2. load the Dropbox core snapshot;
3. read or fetch authoritative connector source/cache data;
4. read the scoped Dropbox v2 mirror;
5. compare source/cache with Dropbox;
6. build one deterministic repair plan.

No live R2 HEAD, GET or LIST is permitted in this phase.

### Local repair proposal

Only repair dry-run and repair apply create a new run-specific overlay, after the repair plan exists.

For each data-repair connector-day:

1. expand the repair scope to the complete authoritative connector-day, not only mismatching timeseries IDs;
2. acquire or reuse all required connector-day source data;
3. merge acquisition chunks locally if chunking is needed;
4. build canonical pollutant Parquet as `part-<number>.parquet` under canonical paths;
5. build canonical pollutant and connector manifests locally;
6. stage proposed deletions as local tombstones;
7. build the day manifest and affected indexes from overlay first, tombstones second and Dropbox third;
8. build any required AQI data/debug and metadata proposals from the same combined local view; and
9. structurally validate the complete proposal before its first R2 mutation.

Chunking is an acquisition/build implementation detail only. It must not create resumable transaction state, R2 generations or receipts.

### Real apply

For each validated observation data-repair connector-day:

1. delete the existing canonical observation connector-day prefix;
2. verify that stale surplus files are absent;
3. upload canonical pollutant Parquet;
4. GET-verify exact bytes or SHA-256 for every Parquet object;
5. upload and GET-verify pollutant manifests;
6. upload and GET-verify the connector manifest;
7. upload and GET-verify the rebuilt day manifest;
8. upload and GET-verify affected pollutant indexes;
9. upload and GET-verify the global latest index last;
10. apply and verify required AQI work in its documented order; and
11. run one exact-scope final read-only verification.

A prefix listing used strictly to execute and verify prefix deletion is permitted during real apply. It must never be used as a comparison source or to preserve live R2 content in the replacement proposal.

For metadata-only repair:

- do not delete or rewrite valid Parquet;
- rebuild only required manifests or indexes from the chosen Dropbox baseline and validated current-run overlay dependencies;
- apply and GET-verify those canonical metadata objects in dependency order.

### Failure model

- A failed or interrupted run remains failed.
- Do not resume it from transaction state, a receipt or an old overlay.
- A rerun creates a new overlay and rebuilds the selected scope from the beginning.
- `--allow-stale-dropbox` may be used to reuse the same chosen Dropbox baseline.
- Correct files written by an earlier interrupted run may be overwritten with the same correct canonical content.

## Implementation phases

Codex should complete all code phases below in one implementation task before stopping. Do not wait for a real TEST run between code phases.

### Phase 1: inventory active dependencies and archive files

1. Read the authoritative documents and current active callers.
2. Use `grep` to inventory every active reference to:
   - `targeted_observation_transaction`;
   - `transaction_state_schema_version`;
   - `generation=`;
   - `data-receipt.json`;
   - `permanent_data_receipt`;
   - `observation_data_receipts`;
   - receipt commit/status helpers;
   - targeted-stage receipt environment variables;
   - live-R2 metadata authority and AQI read exceptions.
3. Exclude `archive/`, historical plans and `system_docs/` when deciding what active code must change.
4. Archive every active non-test code file that will be changed or deleted.
5. Do not edit code until the mandatory confirmation report is complete.

### Phase 2: align run modes, source acquisition and overlay lifecycle

Refactor the Python orchestrator so that:

- all normal modes use the readiness gate;
- `--allow-stale-dropbox` is the only bypass;
- source acquisition/reuse is not disabled by repair dry-run;
- check-only completes acquisition, comparison, planning, SQLite/report output and then stops;
- check-only creates no repair overlay or replacement files;
- repair dry-run and repair apply create a new overlay only after detection and planning;
- dry-run writes only disposable local proposal data and audit/report evidence;
- effective mode and chosen Dropbox baseline are explicit in SQLite and reports;
- existing source/day/profile filters keep the same meaning.

Do not make external calls while validating this code locally.

### Phase 3: replace the targeted transaction writer with a canonical local connector-day builder

Refactor the v2 observation repair path so it has a clear local prepare result and a separate apply operation.

Requirements:

- data-repair work is deduplicated by day and connector;
- the builder requests the complete connector-day source scope;
- all active authoritative source rows for that connector-day are represented;
- chunking may merge into local temporary state but has no resume contract;
- canonical part keys contain no generation component;
- canonical pollutant and connector manifests are built with shared current builders;
- status values and all supported observed-property codes are preserved;
- local counts, keys, hashes, partitions and manifests are validated before mutation;
- uncertain empty source results block the scope;
- authoritative no-data follows the existing documented source-adapter contract;
- the builder returns a structured local proposal, not a receipt.

Delete `workers/uk_aq_backfill_local/targeted_observation_transaction.mjs` after its active imports and useful non-receipt logic have been removed or relocated. Archive it before deletion.

Do not retain renamed transaction or receipt abstractions that reproduce the same design under different names.

### Phase 4: align the temporary overlay and combined-local resolver

Implement the overlay contract exactly:

- sparse current-run canonical objects only;
- same relative keys as canonical R2;
- structurally validated overlay object wins before upload;
- proposed tombstone hides Dropbox during local planning;
- Dropbox supplies unchanged fallback objects;
- states remain distinct: proposed, built, structurally validated, uploaded, GET-verified, deleted, deletion-verified, failed/blocked;
- dry-run never marks remote operation states;
- failed overlay cannot be reused by a later run;
- no receipt collection in run state;
- no generation paths;
- no live-R2 source branch in the local resolver.

Remove the old distinction that makes only `r2_verified` overlay objects visible to local planners.

### Phase 5: simplify metadata and index planning to overlay plus Dropbox

Refactor `uk_aq_execute_v2_observations_repair.mjs` and related helpers so that:

- receipt validation and receipt discovery are removed;
- live R2 manifest, receipt and Parquet fallback are removed;
- a data-repair pollutant leaf uses canonical overlay Parquet;
- a metadata-only pollutant leaf uses scoped canonical Dropbox Parquet;
- parent manifests use every valid final child from the combined local view;
- unaffected connector children for a day come from Dropbox;
- proposed tombstones prevent stale Dropbox children or parts reappearing;
- index proposals use final combined-local manifests and Parquet metadata;
- global latest indexes are staged after scoped pollutant indexes;
- byte-stability remains intact;
- repair notes and provenance say `overlay`, `dropbox` or `repair_generated`, never `live_r2` where no live read occurred.

The metadata/index executor must be able to produce a complete dry-run proposal without any live-R2 access.

### Phase 6: implement ordered canonical apply and local-source AQI rebuilding

Implement a real apply path that consumes only the already validated local proposal.

Observation apply must:

- delete only the planned connector-day prefix for a data repair;
- record and verify deletion separately from proposed tombstones;
- upload canonical objects in dependency order;
- GET-verify each object immediately after its PUT;
- not read live R2 to decide replacement content;
- stop and report failure on any uncertain mutation or failed verification.

AQI work must:

- consume corrected observations from overlay and unchanged observations from Dropbox;
- remove the current same-run live-R2 observation read exception;
- build AQI data/debug replacement objects locally before AQI mutation;
- preserve current AQI eligibility and debug optionality;
- apply AQI data, manifests and indexes in documented order;
- GET-verify every changed AQI object.

Do not add a new remote service or storage layer.

### Phase 7: remove receipt/generation support and align audit/backup reporting

Remove active receipt/generation code from:

- Python orchestration and run state;
- TypeScript/JavaScript writers;
- metadata executor;
- shell wrappers and environment plumbing;
- backup inventory;
- report fields and messages;
- active tests.

Remove the permanent observation receipt scan from `build_backup_inventory.mjs`. Preserve normal v2 domain, committed connector, run manifest, index and stable binding inventory behaviour.

Audit requirements:

- every mode records effective mode, requested scope, chosen Dropbox baseline, stale override, source acquisition result, findings and repair plan;
- real repair additionally records planned and actual deletion/write operations, local hash/bytes, upload result, GET verification, delete verification, rebuilt metadata/indexes, AQI result and final verification;
- planned operations never populate completed-operation fields;
- failed and interrupted scopes remain visible.

First confirm whether current SQLite tables already persist this evidence adequately. If they do not, add the smallest local SQLite structure needed for durable object-operation audit evidence. Prefer a bounded normalised table keyed to the Integrity run and object key over putting unbounded object JSON into `integrity_runs.notes`.

Do not add Supabase schema work for the local Integrity SQLite database.

### Phase 8: minimal local structural validation

This change controls deletion of a complete connector-day prefix, so one narrowly targeted local safety check is genuinely required before the first real TEST operation.

Run only:

1. Python syntax compilation for changed Python files.
2. The smallest existing TypeScript/JavaScript syntax or type check that directly covers changed files.
3. One focused local temporary-directory check using tiny synthetic source and Dropbox data, with mocked/local object adapters only, proving that:
   - check-only creates no overlay and invokes no live-R2 adapter;
   - repair dry-run acquires/uses source data, creates a local overlay and performs no remote operation;
   - a data fault builds a complete canonical connector-day before mutation;
   - planned part keys are canonical and contain no `generation=`;
   - no receipt is created;
   - a proposed tombstone hides stale Dropbox parts for later local planning;
   - metadata-only repair leaves valid Parquet untouched;
   - the planned deletion prefix is limited to the intended connector-day;
   - apply cannot start when local structural validation is incomplete.
4. A focused active-code grep, excluding archives, historical plans and system docs, confirming that no active receipt/generation authority remains.

Do not create or run a broad test suite. Do not run external source gateways, R2, Dropbox, Supabase or any real repair.

## Files expected to require review

At minimum inspect:

```text
scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py
scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill.sh
scripts/backup_r2/uk_aq_execute_v2_observations_repair.mjs
scripts/backup_r2/build_backup_inventory.mjs
workers/uk_aq_backfill_local/run_job.ts
workers/uk_aq_backfill_local/targeted_observation_transaction.mjs
workers/uk_aq_prune_daily/phase_b_history_r2.mjs
workers/shared/uk_aq_r2_history_index.mjs
```

Also inspect the directly relevant existing tests and any active wrapper/configuration references discovered by `grep`.

This list is not permission for broad refactoring. Change only files genuinely needed to satisfy the authoritative contract.

## Acceptance criteria for Codex implementation

The local implementation is ready for manual TEST validation only when all of these are true:

1. Check-only performs source acquisition/reuse, Dropbox comparison and reporting without creating an overlay or accessing live R2.
2. Repair dry-run performs the same detection and can build exact local proposals without live-R2 access.
3. The backup readiness gate applies to every normal mode and `--allow-stale-dropbox` only bypasses it.
4. Data repair is planned and built as one complete connector-day.
5. All canonical replacement objects exist and pass local structural validation before the first mutation.
6. Canonical observation part keys have no generation component.
7. No active permanent receipt is built, read, written, inventoried or required.
8. Metadata-only repairs do not rewrite valid Parquet.
9. Overlay validated objects and proposed tombstones affect later local planning before remote apply.
10. Metadata and index planning uses only overlay plus Dropbox.
11. AQI proposal building uses overlay plus Dropbox observations, not live R2.
12. Real apply order and post-write GET verification match the system document.
13. Interrupted runs are not resumable and a new run creates a new overlay.
14. Planned and completed operations are separate in SQLite and reports.
15. Existing v2, profile, source scope, binding and index byte-stability behaviour is preserved.
16. Active code grep finds no receipt/generation authority outside historical archives/plans/system docs.
17. No real TEST or external operation was performed by Codex.

## Manual TEST validation after Codex stops

Codex must provide exact commands derived from the active local wrappers and environment files. It must not execute them.

The initial TEST validation target remains:

```text
day: 2026-07-12
source: sensorcommunity
connector_id: 7
```

### Required targeted pre-mutation check

Because real apply deletes a complete connector-day prefix, one repair dry-run is required before the first mutation. This is the only targeted pre-mutation functional check required by this plan.

The operator will:

1. run the exact scoped `--run-backfill --dry-run` command, using `--allow-stale-dropbox` only when deliberately reusing the selected Dropbox baseline;
2. confirm the proposal is limited to Sensor.Community connector 7 on 12 July 2026;
3. confirm the complete local connector-day replacement passed validation;
4. confirm only canonical `part-*.parquet` paths are proposed;
5. confirm there are no generation or receipt paths;
6. confirm the deletion scope is exactly the observation connector-day prefix;
7. confirm metadata/index/AQI proposals use overlay plus Dropbox and show no completed writes.

### Real TEST operation

After the dry-run evidence is accepted, the operator will run the exact scoped real repair command.

Success requires:

- connector-day deletion verified;
- every canonical Parquet PUT GET-verified;
- pollutant, connector and day manifests GET-verified;
- affected indexes GET-verified;
- required AQI work completed and GET-verified;
- final exact-scope verification reports no actionable remaining fault;
- SQLite, JSON, Markdown and task-health evidence agree.

### Later normal verification

After a successful Dropbox backup, run the normal scheduled-style check-only operation without the stale override and confirm that the repaired scope remains clean.

## Rollback and failure handling

There is no receipt- or generation-based rollback.

If a real TEST repair fails or is interrupted:

1. retain its failed audit evidence and overlay for diagnosis;
2. do not resume the old overlay;
3. correct any code/configuration issue;
4. start a new repair run from the beginning;
5. use `--allow-stale-dropbox` only when intentionally reusing the same chosen Dropbox baseline;
6. allow the new run to overwrite canonical files already written correctly by the interrupted run.

Repository rollback is through Git history or the required archive copies. Data recovery remains source-based repair plus the independent Dropbox/Time Machine history available to the operator.

## Codex final response

Codex must finish with:

1. the confirmation table for all mandatory findings;
2. a concise implementation summary;
3. files added, changed and deleted;
4. archive files created or reused;
5. minimal local checks run and their results;
6. confirmation that no external or real TEST operation was performed;
7. exact manual repair dry-run command;
8. exact manual real repair command;
9. exact later check-only command;
10. expected evidence and stop conditions for each command;
11. rollback/failure notes; and
12. a concise system-document handover for ChatGPT, without editing `system_docs/`.
