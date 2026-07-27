# 2026-07-27 Implement Integrity Github

## Status

Proposed phased implementation plan for the UK AQ TEST system.

This plan does not authorise implementation, schema application, deployment, scheduling changes, Dropbox migration, R2 writes or changes to active `system_docs/`. Work starts only when the user explicitly asks Codex to perform a named phase.

- Date: 27 July 2026
- Primary repository: `TEST-uk-aq/uk-aq-ops`
- Related schema repository: `TEST-uk-aq/uk-aq-schema`
- Environment: CIC-Test only
- Plan path: `plans/2026-07-27 Implement Integrity Github/2026-07-27_Implement_Integrity_Github_plan.md`
- Draft contract path: `plans/2026-07-27 Implement Integrity Github/2026-07-27_Integrity_Github_System_Docs_Contract_Draft.md`
- Recommended coding configuration: Codex with High reasoning
- Default permission: Level 1 unless the user explicitly grants a higher level

## 1. Purpose

Add a second History Integrity execution implementation named `integrity_github` that runs in GitHub Actions while preserving the existing local implementation, named in this plan as `integrity_local`.

The two implementations are operationally separate but represent one logical task:

```text
ops.history_integrity
```

They must never execute at the same time in the same environment.

The intended first accepted state is:

```text
integrity_local
  - remains available on the dedicated Integrity machine
  - retains its persistent local SQLite working database
  - retains local operational and repair capability
  - uses Supabase for shared run coordination and shared cross-runtime state

integrity_github
  - is a separate executable and GitHub Actions workflow
  - uses a complete uk-aq-ops checkout
  - uses runner-local temporary working files and temporary SQLite only
  - reads the selected R2 backup baseline from Dropbox
  - uses a dedicated compressed Dropbox source cache
  - starts as manual and check-only
  - does not become scheduled or repair-capable during the first implementation
```

## 2. Fixed decisions

These decisions are already made and must not be reopened by Codex unless current authoritative contracts or repository facts make one structurally impossible.

### 2.1 Separate implementations, one logical task

The runtime names are:

```text
integrity_local
integrity_github
```

Both use:

```text
task_key = ops.history_integrity
```

Run metadata must distinguish the executor without creating a second daily-task-health task key.

Expected executor identities are:

```text
uk-aq-history-integrity-local
uk-aq-history-integrity-github
```

### 2.2 No overlapping runs

No local or GitHub Integrity run may overlap another Integrity run in the same environment, including check-only, dry-run, manual, daily-profile and repair runs.

GitHub workflow concurrency is additional protection only. The authoritative cross-host exclusion mechanism is an atomic Supabase execution lease.

### 2.3 Supabase owns shared facts

Supabase becomes authoritative for state that both implementations must agree on, including:

- the active execution lease;
- shared run identity and lifecycle;
- executor identity;
- daily-profile completion and catch-up state;
- source-file identity and current source-cache pointers;
- Dropbox object paths, revisions and hashes required across runtimes;
- report and evidence references;
- future repair ownership and status where shared coordination is required.

### 2.4 SQLite remains local working storage

The existing local SQLite database remains available to `integrity_local` for local joins, expanded counts, detailed evidence, debugging, local audit data and local cached copies of shared state.

It is not copied wholesale into Supabase.

`integrity_github` may create a temporary SQLite database for one workflow run. That database is not durable authority and is discarded after the run.

### 2.5 Dropbox remains the comparison baseline

Integrity detection and repair planning continue to use a completed Dropbox R2 backup as the R2 comparison baseline. `integrity_github` must not replace that baseline with routine live-R2 reads.

Each run pins one completed backup inventory and records the selected inventory identity before downloading scoped objects.

### 2.6 Dedicated compressed GitHub source cache

`integrity_github` uses a dedicated Dropbox namespace separate from the local source-cache directory.

The cache must:

- store immutable, content-addressed source objects;
- preserve already compressed upstream files without recompressing them;
- gzip plain CSV, JSON or equivalent text files individually;
- avoid one monolithic ZIP, tar or database archive;
- maintain small indexes that point to immutable objects;
- use revision-safe index updates;
- support derived per-day evidence so a normal selected-day run does not repeatedly download and parse all large annual source files;
- remain authoritative in Dropbox, with GitHub Actions cache used only as an optional acceleration layer.

### 2.7 Initial GitHub capability is manual and check-only

The first accepted `integrity_github` workflow is manually dispatched and check-only.

It must not:

- write, delete or repair live R2;
- update prune completion gates;
- clear shared catch-up state as though a repair run completed;
- become scheduled automatically;
- disable or replace the local schedule;
- add a repair input that is merely hidden or undocumented.

### 2.8 Scheduling and repair remain later decisions

The implementation may prepare the structure needed for a future scheduled or repair-capable GitHub executor, but it must stop before either is enabled.

Before scheduling, the user must decide:

1. whether `integrity_local` or `integrity_github` is the one active daily scheduler;
2. the exact UTC schedule;
3. whether local scheduling is disabled before GitHub scheduling is enabled.

Before GitHub repair is enabled, the user must approve a separate repair-authority phase after real TEST validation.

## 3. Existing behaviour that must remain unchanged

Unless an authoritative system contract is deliberately changed through ChatGPT after implementation and acceptance, preserve:

- v2-only Integrity behaviour;
- complete `uk-aq-ops` checkout requirement;
- source, connector, pollutant and date-scope meanings;
- the four-pollutant active observation Integrity scope currently defined by the contract;
- source parser, mapping, verification-status and canonicalisation rules;
- observation-content-hash rules;
- Dropbox backup-readiness gate semantics;
- explicit selected-day daily-profile behaviour;
- recent seven-day and historical allocation rules;
- source acquisition before comparison;
- fail-closed handling of uncertain source results;
- repair overlay, tombstone, write ordering, GET verification and final verification;
- Phase B and prune completion safety requirements;
- existing local manual, daily, weekly and monthly profile semantics;
- current JSON and Markdown evidence unless this plan explicitly adds fields;
- local repair capability during the initial GitHub implementation;
- no live R2 comparison source for normal detection and planning.

## 4. Explicitly out of scope

- LIVE repositories, databases, Dropbox roots, R2 buckets, schedules or services.
- Replacing the local Integrity implementation.
- Copying the complete local SQLite database into Supabase or Dropbox for every run.
- Storing raw source payloads or expanded per-timeseries count tables directly in Supabase by default.
- Redesigning source parsers, mappings, observation hashes, manifests, indexes or R2 repair behaviour.
- Changing the active daily date-selection algorithm.
- Running local and GitHub Integrity concurrently for comparison.
- Adding a GitHub cron schedule during the initial implementation.
- Enabling GitHub repair during the initial implementation.
- Updating active `system_docs/` before real TEST acceptance.
- Broad speculative test suites, fixture programmes, shadow systems or soak tests.

## 5. Required reading

Before every Codex phase, read the active files at the current repository revision. Do not rely on this plan as a substitute for current contracts.

### Ops repository

1. `AGENTS.md`
2. `system_docs/README.md`
3. `system_docs/documentation_contract.md`
4. `system_docs/r2_history/README.md`
5. `system_docs/r2_history/contract.md`
6. `system_docs/r2_history/integrity.md`
7. `system_docs/r2_history/daily_profile_selection.md`
8. `system_docs/r2_history/prune_connector_day_gate.md`
9. `system_docs/r2_history/aqi_history_write_pipeline.md`
10. `system_docs/r2_history/operations.md`
11. `system_docs/r2_history/recovery.md`
12. `system_docs/r2_history/validation.md`
13. relevant files under `system_docs/r2_history/decisions/`
14. current Integrity implementation, launchers, environment resolution, reports and tests
15. current Dropbox backup workflow and scripts
16. current daily-task-health reporter and any shared Supabase helpers

### Schema repository

1. `AGENTS.md`
2. `AGENTS_BASE.md`
3. canonical Obs AQI schema files
4. daily-task-health schema and RPC definitions
5. any existing operational lease or advisory-lock schema

## 6. Global Codex stop rules

Every Codex phase must stop without implementing an assumption when any of these occurs:

- active code conflicts with an authoritative `system_docs/` rule;
- an equivalent shared lease or shared state system already exists and ownership is unclear;
- the exact canonical schema file cannot be identified;
- the Dropbox backup inventory cannot pin one internally consistent completed baseline;
- the current source cache contains file types or mutation rules not covered by the proposed object model;
- a source cache path contains data whose authoritative ownership is unclear;
- a shared state field would change the meaning of current local Integrity state;
- local state cannot be mirrored without weakening current recovery or audit behaviour;
- the GitHub runner cannot execute the shared Integrity code without copying or reimplementing load-bearing logic;
- a required GitHub secret, repository variable, Dropbox permission or Supabase RPC contract is unknown;
- the implementation would require broad live R2 reads for detection or planning;
- a destructive action would be needed;
- the next step requires choosing a schedule, disabling local scheduling or enabling GitHub repair.

When stopping, Codex must report:

1. the exact finding;
2. the files and contract sections involved;
3. why proceeding would be an assumption;
4. the smallest concrete decision options;
5. its recommendation;
6. no code changes beyond safe discovery output.

## 7. Cross-phase implementation rules

- Use `grep`, not `rg`, for repository text search.
- Do not edit active `system_docs/`.
- Follow the dated pre-change archive policy for substantial active non-test code only.
- Do not archive plans, documentation, workflows, tests, fixtures, SQL apply notes or generated files.
- Keep canonical SQL DDL in `TEST-uk-aq/uk-aq-schema`.
- Keep TEST validation minimal before deployment.
- Add one targeted deterministic test only where the shared lease or cache identity contract cannot be safely validated through syntax or parsing alone.
- Do not apply SQL, run Dropbox migration, dispatch workflows, change schedules or run Integrity unless the user explicitly grants the required permission.
- Each phase must provide exact manual apply, deployment and rollback commands where relevant, but must not execute them at Level 1.
- Each phase must provide a concise handover for the next phase.

# Codex implementation phases

All Codex code and schema phases come before operator deployment and functional validation phases.

## Phase 0: repository, state and storage discovery

**Owner:** Codex  
**Permission:** Level 1, read-only discovery  
**Recommended configuration:** Codex with High reasoning

### Objective

Produce a fact-based implementation map. Do not edit code or schema.

### Required work

1. Read all required contracts and repository rules.
2. Identify every local Integrity entry point, dispatcher, launcher, scheduled invocation and environment resolver.
3. Identify the code that:
   - checks `daily_task_health` for a running Integrity run;
   - records `Started`, `Finished` and `Failed`;
   - creates and updates local `integrity_runs` and `daily_profile_state` rows;
   - copies the SQLite database to Dropbox;
   - selects the Dropbox backup baseline;
   - reads the core snapshot;
   - reads and writes source-cache files;
   - builds reports and daily-task-health summaries;
   - invokes repair workers and live R2 verification.
4. Record the complete current SQLite table inventory, approximate row counts and ownership purpose without copying data.
5. Record the source-cache tree by connector, file type, compression type, file count and total bytes.
6. Measure, without modifying files:
   - bytes already compressed;
   - bytes stored as plain text;
   - estimated deterministic-gzip size for a small representative sample from each plain-text file class;
   - files that are mutable in place versus replaced by source identity.
7. Confirm how the current Dropbox R2 backup inventory identifies a completed backup, and whether the Dropbox copy exposes the inventory revision/hash needed to pin one baseline.
8. Confirm whether existing repository Dropbox helpers can provide recursive listing, exact file download, content identity, revision-safe upload and conflict detection. Do not assume the workflow's current `rclone` usage satisfies all five requirements.
9. Inspect the schema repository for an existing general execution-lease, advisory-lock or task-run ownership object.
10. Identify the canonical schema file or files that must contain any new lease and shared-state DDL.
11. Identify the smallest shared Python or JavaScript modules that can be extracted or reused by both executors without copying the Integrity algorithm.
12. Confirm current GitHub workflow conventions for:
    - `workflow_dispatch`;
    - concurrency;
    - Python and Node setup;
    - Dropbox authentication;
    - daily-task-health reporting;
    - bounded artefact upload;
    - secrets and repository variables.
13. Identify every contract section that would later need updating after accepted implementation.

### Stop conditions

Stop if any fixed decision conflicts with active `system_docs/`, or if a required ownership boundary cannot be identified.

### Deliverable

A discovery report containing:

- authoritative documents read;
- current local execution and state flow;
- current running-run gate behaviour and race characteristics;
- schema ownership map;
- proposed shared-module ownership map;
- source-cache inventory and compression findings;
- Dropbox baseline and revision findings;
- exact files likely to change in later phases;
- unresolved decisions, if any;
- confirmation that Phase 1 is structurally viable or the reason it is not.

### Copy-paste Codex prompt

```text
Use Codex with High reasoning. Work at Level 1 in TEST-uk-aq/uk-aq-ops and TEST-uk-aq/uk-aq-schema. Perform Phase 0 of plans/2026-07-27 Implement Integrity Github/2026-07-27_Implement_Integrity_Github_plan.md exactly. Read all required AGENTS and active system_docs files first. Use grep, not rg. Do not edit any file, apply SQL, call Dropbox or R2 broadly, run Integrity, dispatch workflows, or change schedules. Produce the required fact-based discovery report. Do not assume missing details. Stop and give concrete decision options if any ownership, contract, schema, cache or baseline rule is unclear.
```

## Phase 1: canonical Supabase lease and shared-state schema

**Owner:** Codex  
**Permission:** Level 1  
**Repository:** `TEST-uk-aq/uk-aq-schema` first, with only required client-contract changes in ops

### Entry gate

Begin only after Phase 0 confirms the canonical schema locations and finds no conflicting existing lease system.

If an equivalent object exists, stop and report whether it should be reused or deliberately replaced. Do not create duplicate authority.

### Required behaviour

Implement the minimum canonical Supabase schema required for shared cross-host coordination.

The schema must provide:

1. An environment-scoped History Integrity execution lease.
2. An atomic acquire RPC that:
   - accepts the environment and executor identity;
   - uses the single logical task key `ops.history_integrity`;
   - refuses acquisition while an unexpired lease exists;
   - may reconcile an expired lease only under the contract's stale-run rules;
   - creates the factual `Started` `daily_task_runs` row in the same transaction;
   - returns the lease token and daily-task run ID.
3. A heartbeat RPC that succeeds only for the current matching lease token.
4. A finish RPC that atomically:
   - records the shared run result;
   - marks the factual daily-task run `Finished`;
   - releases the matching lease.
5. A fail RPC that atomically:
   - records the shared run failure;
   - marks the factual daily-task run `Failed`;
   - releases the matching lease.
6. Expired-lease reconciliation that marks an abandoned factual `Started` run `Failed`, never `Finished`.
7. Service-role-only access through stable RPCs.
8. Shared run metadata sufficient to identify:
   - environment;
   - executor kind `local` or `github`;
   - executor identity;
   - logical run date;
   - mode and scope summary;
   - daily-task run ID;
   - platform run ID;
   - selected Dropbox baseline identity;
   - report references;
   - lifecycle timestamps and final status.
9. Shared daily-profile state that can become authoritative across both executors while preserving the current selection and catch-up semantics.
10. Shared source-object and source-file pointer metadata sufficient to locate immutable Dropbox source objects and detailed sidecars without putting large payloads in Supabase.
11. A `hybrid` or equivalent explicit platform value for the existing `ops.history_integrity` task definition. If the existing schema cannot represent this without a wider platform contract change, stop and present options.

### Fixed lease timings

Unless Phase 0 proves these values are structurally unsafe:

```text
heartbeat interval target: 60 seconds
lease expiry after missing heartbeat: 15 minutes
```

If they are unsafe, stop and report measured evidence. Do not silently choose different values.

### Schema placement

- Update the canonical main Obs AQI schema file required by repository policy.
- Add one targeted TEST apply SQL file under the canonical `schemas/obs_aqi_db/` location if the repository convention requires it.
- Keep the targeted file aligned with the canonical schema.
- Do not apply it.

### Minimal structural validation

Run only:

- SQL parsing or the repository's existing smallest schema validation;
- one narrow transaction-level test of lease acquisition exclusivity and token ownership if an existing local Postgres test method is available without external access.

A targeted lease exclusivity check is genuinely required because check-then-insert behaviour would not enforce the no-overlap contract.

### Deliverable

- schema files changed;
- complete object and RPC list;
- transaction and race-safety explanation;
- exact manual TEST apply command;
- expected apply result;
- rollback SQL or rollback procedure;
- affected system-docs sections for later ChatGPT update;
- no database application.

### Copy-paste Codex prompt

```text
Use Codex with High reasoning. Implement Phase 1 of plans/2026-07-27 Implement Integrity Github/2026-07-27_Implement_Integrity_Github_plan.md at Level 1. Start from the Phase 0 report and current repository state. Read TEST-uk-aq/uk-aq-schema AGENTS.md and AGENTS_BASE.md plus all required active ops system_docs. Put canonical DDL in the schema repo and do not apply SQL. The lease acquire must atomically acquire the environment-scoped ops.history_integrity lease and create the factual Started daily-task row in one transaction. Do not implement check-then-insert locking. Do not create duplicate authority if an equivalent object exists. Run only minimal structural checks and the one narrow exclusivity check genuinely required by the contract. Stop before coding if any schema ownership or platform-value decision remains unresolved.
```

## Phase 2: shared Integrity state client and local executor integration

**Owner:** Codex  
**Permission:** Level 1  
**Primary repository:** `TEST-uk-aq/uk-aq-ops`

### Entry gate

Begin only after the Phase 1 schema is final in source control. It does not need to be applied yet for code authoring, but exact RPC and field contracts must be fixed.

### Required work

1. Add one shared Integrity Supabase client module for:
   - acquire;
   - heartbeat;
   - finish;
   - fail;
   - shared daily-profile state read/write;
   - shared source-object pointer read/write;
   - bounded run-summary publication.
2. Do not duplicate generic REST/RPC request code where a compatible repository helper already exists.
3. Integrate `integrity_local` with the shared lease:
   - acquire before creating local run state or performing source acquisition;
   - run an independent heartbeat while long work continues;
   - fail closed when the lease cannot be acquired or heartbeat ownership is lost;
   - finish or fail through the atomic Supabase RPC;
   - preserve the local SQLite audit trail.
4. Change local daily-profile cross-run decisions so shared Supabase daily state is authoritative after the schema is enabled.
5. Keep the local `daily_profile_state` table as a mirror/cache for local operations and audit compatibility.
6. Record the authoritative Supabase row IDs and versions in SQLite where needed to reconcile local mirrors.
7. Define deterministic mirror rules:
   - Supabase shared fact first;
   - SQLite mirror second;
   - local-only detailed evidence stays local;
   - mirror failure after a successful shared write stops dependent work and is reported;
   - shared state is never overwritten from stale SQLite state.
8. Preserve existing local commands, modes, scope meanings, reports and repair behaviour.
9. Replace the current running-run preflight gate only when the shared lease is available. Do not leave two conflicting authorities.
10. Add cancellation and signal handling that attempts to mark the run failed and release the lease. Expiry remains the final recovery mechanism for abrupt termination.
11. Do not make local Integrity dependent on GitHub-specific environment variables.
12. Do not remove the local SQLite-to-Dropbox diagnostic copy unless a later explicit decision retires it.

### Migration compatibility

The code must support a controlled deployment sequence. It must not silently use half-applied shared state.

Use one explicit feature/configuration gate whose default preserves the current local behaviour until the schema is applied and the user enables shared coordination. Phase 0 must confirm the appropriate configuration ownership and naming before this phase implements it.

The transition gate must not permit local and GitHub repair to overlap. `integrity_github` remains unavailable until shared coordination is enabled.

### Minimal validation

- Python syntax/import validation for changed modules.
- One narrow deterministic test for mirror precedence and lost-lease handling if these cannot be shown by import checks.
- No source downloads, Dropbox operations, Supabase calls, R2 calls or real Integrity runs.

### Deliverable

- files changed;
- preserved local behaviour;
- shared versus local state ownership map;
- configuration gate and deployment sequence;
- checks run;
- exact later manual validation commands;
- rollback notes;
- system-docs handover notes.

### Copy-paste Codex prompt

```text
Use Codex with High reasoning. Implement Phase 2 of plans/2026-07-27 Implement Integrity Github/2026-07-27_Implement_Integrity_Github_plan.md at Level 1 in TEST-uk-aq/uk-aq-ops. Read all required contracts first and use the exact Phase 1 RPC contract. Add one shared Supabase state client and integrate integrity_local without changing its Integrity algorithms, modes, scope or repair semantics. Supabase is authoritative for shared facts; SQLite remains local working and audit storage. Add a safe deployment gate that preserves current local behaviour until the schema is applied. Do not call external services or run Integrity. Stop if mirror precedence, feature-gate ownership, signal handling or an existing helper creates a decision not fixed by Phase 0 or Phase 1.
```

## Phase 3: Dropbox baseline reader and compressed source-cache storage

**Owner:** Codex  
**Permission:** Level 1

### Entry gate

Begin only after Phase 0 has documented the real source-cache file classes and Dropbox helper capabilities.

### Required work

1. Add a reusable Dropbox storage adapter that satisfies the contract for:
   - recursive metadata listing with pagination/cursors;
   - exact file download;
   - content identity;
   - revision-aware conditional upload;
   - conflict detection;
   - bounded retries;
   - app-folder path normalisation;
   - no secret logging.
2. Reuse a current repository helper only if Phase 0 proved it provides all required semantics. Otherwise add the smallest official Dropbox API or SDK wrapper needed.
3. Add a backup-baseline selector that:
   - identifies the completed v2 backup inventory;
   - records its Dropbox path, revision, content hash and backup run identity;
   - pins that identity for the full run;
   - downloads only selected-scope inventory, indexes, manifests and Parquet objects;
   - fails when required objects do not match the pinned inventory;
   - does not silently fall back to live R2.
4. Add the dedicated source-cache namespace, defaulting for CIC-Test to:

```text
CIC-Test/uk-aq-history-integrity-github/source-cache-v1
```

5. Implement immutable content-addressed object storage:

```text
source-cache-v1/objects/sha256/<first-two-hex>/<sha256>.<encoding>
```

6. Preserve an already compressed source file exactly as obtained when its current Integrity hash contract depends on those bytes.
7. Deterministically gzip eligible plain-text source files individually.
8. Add small connector/year or equivalent indexes that map logical source-file identities to immutable objects.
9. Update an index only with revision-safe compare-and-set behaviour.
10. Add detailed source-count sidecars outside Supabase and include their path, content hash, mapping identity and scope in shared metadata.
11. Add derived selected-day source evidence keyed by:

```text
raw source object hash
parser contract version
mapping snapshot identity
selected UTC day
```

12. Ensure derived evidence can be invalidated without deleting the immutable raw source object.
13. Add a migration/inventory tool for the current local source cache that supports:
   - inventory-only mode;
   - dry-run upload plan;
   - duplicate detection by content identity;
   - upload without deleting or modifying the local source cache;
   - bounded resumable progress through immutable objects and revision-safe indexes;
   - a JSON report.
14. Do not upload anything during this phase.
15. Do not create a single 2 GB archive or any design requiring complete-cache download per run.
16. GitHub Actions cache support may be added only as a read-through acceleration for immutable object keys. Dropbox remains authoritative.

### Minimal validation

- syntax/import checks;
- deterministic compression and content-address tests on tiny generated fixtures;
- one narrow revision-conflict test against a local fake or mock, not live Dropbox;
- no broad source-cache test programme.

### Deliverable

- storage and cache modules;
- migration/inventory tool;
- exact Dropbox tree contract;
- source object and index schemas;
- dry-run command for the later operator phase;
- expected report fields;
- rollback and cache-versioning notes;
- no Dropbox writes.

### Copy-paste Codex prompt

```text
Use Codex with High reasoning. Implement Phase 3 of plans/2026-07-27 Implement Integrity Github/2026-07-27_Implement_Integrity_Github_plan.md at Level 1. Use the Phase 0 source-cache inventory and Dropbox capability findings. Build the smallest Dropbox baseline and source-cache adapters that satisfy the draft contract. Preserve already compressed source bytes, deterministically gzip eligible plain text files individually, use immutable content-addressed objects and revision-safe indexes, and add derived selected-day evidence. Add an inventory/dry-run migration tool but do not contact Dropbox or upload data. Do not create a monolithic archive. Stop if a real file class, current hash rule, Dropbox permission or source identity is not covered by the fixed contract.
```

## Phase 4: shared Integrity core boundary and GitHub executor

**Owner:** Codex  
**Permission:** Level 1

### Objective

Create `integrity_github` without copying the local Integrity algorithm.

### Required work

1. Use the Phase 0 ownership map to extract or expose only the shared deterministic Integrity modules required by both runtimes.
2. Keep the established local command paths and imports compatible.
3. Create a separate GitHub entry point under a clearly separate active path, with final naming based on Phase 0's repository structure. The executable identity must be `integrity_github` and must not masquerade as the local launcher.
4. Use adapter boundaries for:
   - shared Supabase state;
   - Dropbox baseline access;
   - source-cache access;
   - runner-local temporary paths;
   - temporary SQLite;
   - report publication.
5. Reuse shared source parsers, mapping, canonicalisation, comparison, hash, manifest and validation code.
6. Do not copy the monolithic local orchestrator into a second independently maintained file.
7. Build the GitHub working database from:
   - shared Supabase state needed for the selected run;
   - the selected core snapshot from the pinned Dropbox baseline;
   - only selected source-object and sidecar data;
   - runner-local temporary state.
8. Enforce check-only in code, not only in workflow YAML.
9. Reject repair, write, delete, prune-gate or backfill execution paths in the first GitHub implementation.
10. Preserve date-selection semantics. A GitHub daily-profile dry/check run must use the shared daily-profile authority without marking missed dates complete.
11. Publish bounded JSON and Markdown reports to the dedicated Dropbox run-evidence namespace through revision-safe unique run paths.
12. Ensure local and GitHub report fields share a common core but identify executor, platform run ID, shared run ID, lease token identity fingerprint, pinned backup identity and cache evidence.
13. Do not include secrets or raw observation payloads in logs or GitHub artefacts.

### Minimal validation

- Python and JavaScript syntax/import checks for changed modules;
- one small deterministic comparison showing local and GitHub adapters produce the same selected scope and comparison input from the same tiny local fixture;
- no broad parity suite;
- no external service calls.

A narrow shared-core equivalence check is genuinely required because two implementations of the comparison rules would create divergent Integrity results.

### Deliverable

- separate GitHub executable;
- shared core/adapters map;
- preserved local entry points;
- check-only enforcement;
- report contract;
- checks run;
- manual run command to be used after deployment;
- rollback notes.

### Copy-paste Codex prompt

```text
Use Codex with High reasoning. Implement Phase 4 of plans/2026-07-27 Implement Integrity Github/2026-07-27_Implement_Integrity_Github_plan.md at Level 1. Create a separate integrity_github executable but do not copy or independently reimplement the local Integrity algorithm. Extract or expose the smallest shared deterministic core and use runtime adapters for Supabase, Dropbox, cache, temporary SQLite and reports. Enforce check-only in code. Preserve all local command paths and behaviour. Run only syntax/import checks and the one tiny shared-core equivalence check required by the plan. Do not call external services. Stop if a shared boundary cannot be made without changing an authoritative Integrity rule.
```

## Phase 5: manual GitHub Actions workflow and reporting integration

**Owner:** Codex  
**Permission:** Level 1

### Required workflow

Create:

```text
.github/workflows/uk_aq_history_integrity_github.yml
```

unless Phase 0 proves that this exact name conflicts with an existing active workflow.

### Workflow requirements

1. `workflow_dispatch` only.
2. No `schedule:` trigger.
3. `permissions: contents: read` unless a specifically identified additional permission is required.
4. Stable concurrency group with `cancel-in-progress: false`.
5. Acquire the shared Supabase lease before source or Dropbox work.
6. Use the same logical task key `ops.history_integrity`.
7. Record GitHub metadata as executor metadata, not a second logical task.
8. Set up the exact Python and Node versions confirmed by current repository runtime requirements.
9. Install only required dependencies, with pinned versions where repository policy already requires pinning.
10. Use existing repository secrets and variables where names and semantics match.
11. Add new secret or variable names only after Phase 0 confirms ownership and purpose.
12. Authenticate to Dropbox without printing tokens.
13. Use runner temporary directories and a temporary SQLite database.
14. Run the new executable in check-only mode.
15. Upload bounded GitHub artefacts with `if: always()` for convenience.
16. Treat Dropbox reports as durable evidence and GitHub artefacts as non-authoritative convenience copies.
17. Finalise the lease and daily-task run on success or failure.
18. Include a cancellation-safe best-effort finalisation path, while relying on lease expiry for abrupt termination.
19. Do not read live R2 for routine comparison.
20. Do not include R2 write credentials unless a specific existing read requirement is proven and authorised. The first implementation must not need R2 repair credentials.
21. Do not change Cloudflare Scheduler, `jobs.toml`, local launchd/cron or current schedule configuration.

### Inputs

Inputs must be limited to current safe check-only scope controls whose exact semantics already exist. Do not invent new scope meanings.

At minimum, Phase 0 and Phase 4 must decide whether the first workflow supports:

- daily profile only; or
- daily plus existing manual date/source filters.

If this is still undecided, stop before writing the workflow and present the smallest options with a recommendation.

### Minimal validation

- YAML parse or the repository's smallest existing workflow validation;
- shell syntax checks for embedded scripts where available;
- no workflow dispatch.

### Deliverable

- workflow file;
- required secrets and variables table;
- exact manual dispatch command or UI inputs;
- expected run stages and artefacts;
- failure and stale-lease recovery notes;
- no scheduling changes.

### Copy-paste Codex prompt

```text
Use Codex with High reasoning. Implement Phase 5 of plans/2026-07-27 Implement Integrity Github/2026-07-27_Implement_Integrity_Github_plan.md at Level 1. Add a manual workflow_dispatch-only workflow for the separate check-only integrity_github executable. Use ops.history_integrity, the shared Supabase lease and the repository's existing Dropbox and daily-task-health conventions. Do not add a schedule, change Cloudflare jobs, disable local scheduling, contact external services or dispatch the workflow. Validate only YAML and embedded shell structure. Stop if the safe initial workflow input scope or a secret/variable contract remains undecided.
```

## Phase 6: code-phase consolidation and operator handover

**Owner:** Codex  
**Permission:** Level 1

### Required work

1. Review the combined changes from Phases 1 to 5 across both repositories.
2. Confirm no active `system_docs/` file changed.
3. Confirm no LIVE file or resource changed.
4. Confirm local Integrity commands and default runtime remain intact until the shared-state feature is explicitly enabled.
5. Confirm `integrity_github` remains manual and check-only.
6. Confirm there is one logical task key and one environment-scoped cross-host lease.
7. Confirm no normal run requires downloading the complete Dropbox R2 mirror or complete source cache.
8. Confirm no full local SQLite database replication was introduced.
9. Confirm canonical schema and targeted apply SQL are aligned.
10. Produce one ordered operator runbook covering the later phases below.
11. Produce a ChatGPT system-docs handover that names exact active documents requiring updates after acceptance.
12. Do not apply, deploy, upload, dispatch or schedule anything.

### Minimal validation

Only rerun the smallest structural checks needed for files changed since their original phase checks. Do not introduce a broad combined suite.

### Deliverable

A final code handover with:

- files changed by repository;
- schema objects and RPCs;
- feature/configuration gates;
- required secrets and variables;
- exact operator commands in order;
- expected outputs;
- rollback commands;
- post-deploy TEST validation checklist;
- unresolved decisions and the exact phase where work must stop;
- system-docs update map.

### Copy-paste Codex prompt

```text
Use Codex with High reasoning. Perform Phase 6 of plans/2026-07-27 Implement Integrity Github/2026-07-27_Implement_Integrity_Github_plan.md at Level 1. Review and consolidate the completed code and schema phases only. Do not make operational changes. Confirm that active system_docs and LIVE resources are untouched, local Integrity is preserved, integrity_github is manual/check-only, and the one shared lease protects ops.history_integrity. Produce the complete ordered operator runbook, rollback instructions and ChatGPT documentation handover. Stop and report any unresolved decision rather than completing the handover with an assumption.
```

# Operator and real TEST phases

These phases occur only after the Codex code phases are complete and the user explicitly chooses to proceed.

## Phase 7: review and apply shared schema to CIC-Test

**Owner:** User, using Codex handover commands  
**Permission required:** explicit operational approval

1. Review the canonical and targeted schema changes.
2. Apply only to CIC-Test Obs AQI DB.
3. Inspect created tables, constraints, policies and RPC signatures.
4. Perform the one narrow real transaction check:
   - first lease acquisition succeeds;
   - second acquisition for the same environment while the first lease is live is rejected;
   - heartbeat with the valid token succeeds;
   - heartbeat with a wrong token fails;
   - failure finalisation releases the lease and marks the factual task run `Failed`.
5. Do not proceed if a factual run must be manually marked `Finished` to unlock it.
6. Roll back before proceeding if exclusivity or stale-run reconciliation is wrong.

## Phase 8: enable shared coordination for local Integrity

**Owner:** User with Codex-prepared commands

1. Enable the explicit shared-coordination feature for `integrity_local` in CIC-Test.
2. Run one normal scoped local check-only operation.
3. Confirm:
   - the Supabase lease is acquired;
   - the factual daily-task run uses `ops.history_integrity`;
   - executor metadata identifies local execution;
   - the local SQLite run and mirror rows are written;
   - the Supabase shared run is finalised;
   - the lease is released;
   - existing local report content remains available.
4. Perform one controlled cancellation only if the user approves this targeted recovery check:
   - cancel after the run has started;
   - confirm best-effort failure finalisation, or wait for lease expiry;
   - confirm the abandoned factual run becomes `Failed`, not `Finished`;
   - confirm a later run can acquire the lease without manual false completion.

This cancellation check is targeted and justified because it validates the existing operational failure that prompted the shared lease design.

## Phase 9: inventory and seed the GitHub Dropbox source cache

**Owner:** User with Codex-prepared commands

1. Run the source-cache migration tool in inventory-only mode.
2. Review per-connector file types, existing compression, planned immutable objects, duplicate savings and estimated upload bytes.
3. Stop if the inventory differs materially from Phase 0 or contains an unknown file class.
4. Run dry-run upload planning.
5. Review planned Dropbox paths and index changes.
6. Perform the initial immutable-object upload only after explicit approval.
7. Confirm revision-safe index publication and JSON migration report.
8. Do not delete, relocate or modify the local source cache.

## Phase 10: manual check-only GitHub run

**Owner:** User

1. Manually dispatch `uk_aq_history_integrity_github.yml` with the accepted safe input scope.
2. Confirm lease acquisition and executor metadata.
3. Confirm the pinned Dropbox backup inventory identity.
4. Confirm only selected-scope Dropbox objects and source objects were downloaded.
5. Confirm the workflow used temporary SQLite only.
6. Confirm the report was written to the dedicated Dropbox evidence path.
7. Confirm the bounded GitHub artefact exists.
8. Confirm the daily-task run finished and the lease was released.
9. Confirm no R2 writes, deletes, repair actions or prune-gate changes occurred.

## Phase 11: representative local and GitHub result review

Do not run the two implementations at the same time.

1. Select one representative completed Dropbox baseline and safe check-only scope.
2. Run local first and let it finish and release the lease.
3. Run GitHub second against the same pinned baseline and scope.
4. Compare only load-bearing outputs:
   - selected dates and reasons;
   - source object identities;
   - core snapshot identity;
   - checked partition counts;
   - finding identities and counts;
   - source and R2 content-hash evidence;
   - overall status.
5. Differences must be explained by executor-only metadata or temporary paths.
6. Any semantic difference blocks scheduling and repair work.

This is one representative real TEST comparison, not a broad shadow programme.

## Phase 12: scheduling decision gate

Stop here and ask the user to choose:

1. Keep `integrity_local` as the active daily scheduler and retain `integrity_github` as manual fallback/checking; or
2. Disable the local daily schedule, then enable a Cloudflare-dispatched GitHub workflow at an explicitly approved UTC time.

There must never be two active daily schedulers for the same environment.

Do not add or change `jobs.toml`, Cloudflare Scheduler or local launchd/cron until this decision is explicit.

## Phase 13: future GitHub repair decision

GitHub repair is not part of this plan's initial implementation.

A later plan is required before enabling it. That plan must address:

- repair credentials and least privilege;
- live R2 write/delete and post-write GET verification;
- prune completion gates;
- backup-readiness and stale-backup rules;
- shared repair ownership;
- failure and interrupted-repair recovery;
- disabling overlapping local repair authority;
- one real scoped TEST repair and later Dropbox verification.

## Phase 14: ChatGPT updates active system documentation

Only after the implementation and real TEST acceptance:

1. ChatGPT in Chat mode reviews:
   - implemented code and schema;
   - Codex handover;
   - applied schema state;
   - source-cache migration report;
   - local validation result;
   - GitHub validation result;
   - the scheduling decision, if made.
2. ChatGPT updates the active `system_docs/` files.
3. The draft contract in this plan directory is not copied blindly. It is reconciled with implemented behaviour and real TEST results.
4. Relevant active documents are expected to include:
   - `system_docs/r2_history/README.md`;
   - `system_docs/r2_history/integrity.md`;
   - `system_docs/r2_history/daily_profile_selection.md`;
   - an operations or runtime/state contract file if the implemented structure warrants it;
   - `system_docs/r2_history/recovery.md`;
   - `system_docs/r2_history/validation.md`;
   - the system documentation index where required.
5. Remove duplicate authority. Shared-state, lease and cache rules must each have one authoritative home.

## 8. Acceptance criteria for the initial implementation

The initial implementation is accepted only when all of the following are true:

- `integrity_local` still operates with its established local functionality.
- `integrity_github` exists as a separate executable and manual workflow.
- Both use `ops.history_integrity`.
- One atomic Supabase lease prevents all local/GitHub overlap per environment.
- An abandoned run recovers without being falsely marked `Finished`.
- Supabase owns shared facts.
- Local SQLite remains local working and audit storage.
- GitHub SQLite is temporary.
- Dropbox remains the R2 comparison baseline.
- The backup inventory is pinned for each run.
- The source cache is immutable, compressed per object and sharded.
- No normal GitHub run downloads the entire source cache or R2 mirror.
- No live R2 repair occurs from GitHub.
- GitHub scheduling remains disabled pending a user decision.
- Active `system_docs/` remain unchanged until ChatGPT updates them after real TEST acceptance.

## 9. Rollback principles

- Before shared coordination is enabled, rollback is code-only and leaves current local operation unchanged.
- After schema application but before enablement, leave unused schema objects in place or remove them with the reviewed rollback SQL.
- After local enablement, disable the explicit feature gate only when no lease is active.
- Never restore the old non-atomic running-run behaviour while `integrity_github` can execute.
- Dropbox immutable cache objects may remain after rollback because they are namespaced and not used by local Integrity. Index publication can be rolled back by restoring the previous revision.
- Disabling the GitHub workflow does not require deleting reports or source objects.
- No rollback step may rewrite R2 history or mark a failed/cancelled run `Finished`.
