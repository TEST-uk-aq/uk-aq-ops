# 2026-07-21 Modularise Integrity Backfill

## Purpose

Modularise the UK AQ Integrity and local backfill implementation so that the two very large orchestration files are easier to understand, change and diagnose without altering system behaviour.

The principal files are:

- `workers/uk_aq_backfill_local/run_job.ts`
- `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py`

The refactor must retain the existing public entrypoints, command-line interface, environment variables, log events, R2 keys, schemas, manifests, repair ordering and fail-closed safety rules.

## Required start condition

Do not begin the modularisation implementation until the focused SOS Integrity pollutant-scope repair has been completed, merged and proven through one successful real CIC-Test operation.

The modularisation must not be used to hide or combine that functional repair. The known SOS repair belongs in its own focused change so that any later refactor failure can be distinguished from the original defect.

## Execution model

This plan lists every Codex phase first, followed by the phases owned by Mike or ChatGPT.

For safer delivery, the Codex work is divided into release groups. Each release group must produce a separate draft pull request. The relevant Mike/ChatGPT deployment and operational-validation phase at the end of this plan must be completed before the next release group is merged.

**Recommended Codex model for every implementation phase: GPT-5.6 Codex with High reasoning.**

## Local-only Codex working rule

All Codex work for this plan must be performed locally through VS Code in the existing local checkout of `TEST-uk-aq-ops`.

Codex must:

1. Use the local repository files as the authoritative working copy.
2. Use local `git` commands to inspect status, create and switch branches, review diffs, commit changes and push branches.
3. Create a separate local feature branch for each release group before changing production code.
4. Never make modularisation changes directly on local `main`.
5. Push the completed local feature branch to `origin` only when its release group is ready for review.
6. Create draft pull requests from the locally created and pushed branch, using the local `gh` CLI where available.
7. Keep each draft pull request limited to its stated release group.
8. Never merge a pull request. Mike will review and merge it.
9. Never use Codex Cloud, a remote Codex worktree, the ChatGPT GitHub connector, GitHub web editing or another remote editing mechanism to modify the repository, create branches, make commits or open pull requests.
10. Do not create a replacement clone or work against a separate remote checkout. Use the existing local repository unless Mike explicitly instructs otherwise.
11. Before beginning a phase, confirm the local repository path, current branch and working-tree status.
12. If unrelated local changes are already present, preserve them and stop before doing anything that could overwrite, discard, stage or include them.
13. Do not reset, clean, stash, amend, rebase, force-push or delete branches unless Mike explicitly authorises that action.
14. Show the final local branch name, commit SHA, changed files and draft pull request reference at the end of each release group.

The expected workflow for an implementation release group is:

```text
local main updated
→ local feature branch created
→ changes made locally
→ structural checks run locally
→ diff reviewed locally
→ changes committed locally
→ branch pushed to origin
→ draft pull request opened from the local branch
→ stop for Mike/ChatGPT review
```

A GitHub pull request is necessarily hosted on GitHub, but its branch, commits, checks and PR creation must all originate from the local VS Code/Codex session.


## Global constraints for all Codex phases

Codex must follow these rules throughout the modularisation:

1. Preserve behaviour. This is a structural refactor, not an opportunity to redesign algorithms or repair unrelated defects.
2. Keep these entrypoints stable:
   - `workers/uk_aq_backfill_local/run_job.ts`
   - `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py`
   - `scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill.sh`
3. Do not rename, remove or reinterpret existing environment variables.
4. Do not change CLI arguments, defaults or validation unless a separate approved functional change requires it.
5. Do not change structured log event names or their established fields.
6. Do not change R2 object keys, directory layouts, manifest shapes, Parquet schemas, source-evidence formats or SQLite schemas.
7. Do not change the order of source acquisition, immutable evidence, proposal creation, local validation, canonical apply or final verification.
8. Keep all existing fail-closed checks.
9. Do not move unrelated files or perform repository-wide formatting.
10. Do not create a speculative test suite before deployment.
11. Before each commit, perform structural validation only:
    - the repository's existing formatter, type checker or lint command where already configured and relevant;
    - `bash -n` for any touched shell script;
    - `python3 -m py_compile` for touched Python modules;
    - `git diff --check`;
    - import and stale-reference checks;
    - confirmation that no unexpected file or generated artefact is included.
12. Functional validation must happen after deployment through real CIC-Test operations, as described in the Mike/ChatGPT phases.
13. Stop and report rather than guessing if an extraction reveals an undocumented dependency, import cycle, mutable module-global state problem or behaviour that cannot be preserved confidently.

## Target architecture

The exact final module names may be adjusted where the existing code makes another boundary clearer, but the intended ownership is:

```text
workers/uk_aq_backfill_local/
├── run_job.ts
├── config/
│   ├── env.ts
│   └── run_scope.ts
├── source_adapters/
│   ├── breathelondon.ts
│   ├── openaq.ts
│   ├── sensorcommunity.ts
│   └── sos.ts
├── integrity/
│   ├── complete_connector_day.ts
│   ├── source_evidence.ts
│   └── proposal_stage.ts
├── observations/
│   ├── export.ts
│   ├── parquet.ts
│   └── manifests.ts
├── aqilevels/
│   ├── rebuild.ts
│   ├── export.ts
│   └── manifests.ts
└── r2/
    ├── object_access.ts
    └── history_paths.ts

scripts/uk-aq-history-integrity/bin/
├── uk-aq-history-integrity.py
├── uk-aq-history-integrity_impl.py
└── integrity/
    ├── cli.py
    ├── config.py
    ├── database.py
    ├── core_snapshot.py
    ├── source_checks/
    │   ├── openaq.py
    │   ├── sensorcommunity.py
    │   └── sos.py
    ├── detection/
    │   ├── observations.py
    │   └── aqilevels.py
    ├── repair/
    │   ├── planning.py
    │   ├── source_evidence.py
    │   ├── coordinator.py
    │   ├── metadata.py
    │   └── canonical_apply.py
    ├── reporting.py
    └── task_health.py
```

This is a guide, not permission to create empty or artificial modules. A module should be extracted only when it owns a coherent responsibility and materially reduces the orchestration file.

# Codex phases

## Codex Phase 1: Produce the dependency and extraction inventory

**Release group:** Read-only preparation  
**Codex model:** GPT-5.6 Codex, High reasoning

Inspect the current implementation after the SOS pollutant-scope repair has been merged.

Create:

```text
plans/2026-07-21_modularise_integrity_backfill/modularisation_inventory.md
```

The inventory must identify:

- the major responsibility blocks in `run_job.ts`;
- the major responsibility blocks in `uk-aq-history-integrity_impl.py`;
- module-level mutable state and caches;
- functions that depend directly on environment variables;
- functions that depend on R2 credentials or remote access;
- source-adapter-specific code;
- shared types and helpers;
- Integrity proposal and source-evidence boundaries;
- observation and AQI writer boundaries;
- Python database, source acquisition, detection, planning, repair, reporting and task-health boundaries;
- likely circular-import risks;
- the functions that must remain in the entrypoint or orchestration layer;
- the proposed file destination for every extraction block.

Do not change production code in this phase.

Structural viability check:

- confirm that the proposed TypeScript modules can import without requiring top-level execution;
- confirm that the proposed Python package can be imported when the entrypoint is invoked directly;
- identify any globals that require an explicit runtime context object rather than direct extraction;
- confirm that existing module resolution supports the proposed paths.

Commit only the inventory document and push the locally created branch and open a draft PR using the local gh CLI. Do not merge it automatically.

## Codex Phase 2: Establish stable TypeScript module contracts

**Release group:** TS-A  
**Codex model:** GPT-5.6 Codex, High reasoning

Create the smallest shared TypeScript types and runtime contracts required by later extractions.

Scope:

- move cohesive type declarations from `run_job.ts` into one or more narrowly named type files;
- extract pure environment parsing and run-scope calculation where it can be moved without behaviour changes;
- retain eager versus lazy environment evaluation exactly as it currently behaves;
- keep the same defaults, validation messages and environment-variable precedence;
- avoid introducing a broad service container or unnecessary framework;
- keep `run_job.ts` responsible for starting the run.

Do not move source adapters, R2 writers or Integrity proposal logic yet.

Structural validation:

- existing TypeScript type or check command;
- verify all environment names and defaults against the pre-refactor file;
- `git diff --check`;
- confirm `run_job.ts` remains the executable entrypoint;
- confirm no structured log names changed.

Commit this phase separately.

## Codex Phase 3: Extract the SOS source adapter

**Release group:** TS-A  
**Codex model:** GPT-5.6 Codex, High reasoning

Extract SOS and UK-AIR annual CSV behaviour before the other adapters because it has the most complex Integrity-specific source contract.

The SOS module should own, where practical:

- SOS source binding selection;
- selected-pollutant filtering;
- historical flat-file mapping validation;
- annual CSV path resolution and reading;
- UK-AIR CSV parsing orchestration;
- source-file identity collection;
- no-data manifest handling;
- candidate timeseries results;
- SOS-specific source checkpoint fields and structured events.

Preserve:

- complete connector-day source enumeration;
- explicit selected-pollutant scope;
- the rule that complete connector-day mode must not use a timeseries-ID filter;
- the current handling of HG4, HULR and STOR unmapped PM10 rows;
- fail-closed handling for missing or unreadable files, ambiguous configured mappings, duplicate canonical identities and invalid canonical rows;
- the existing `source_integrity/blocked_rows.ts` contract;
- source evidence counts, hashes and event names.

The extracted adapter should return a typed result to the orchestration layer. It must not perform canonical R2 apply independently.

Structural validation:

- existing TypeScript check;
- exact comparison of environment-variable reads and structured event names;
- confirm mapping guard invocation still occurs before parsing creates a repair proposal;
- confirm no timeseries filter is added in complete connector-day mode;
- `git diff --check`.

Commit this phase separately in the TS-A draft PR.

## Codex Phase 4: Extract the remaining source adapters

**Release group:** TS-B  
**Codex model:** GPT-5.6 Codex, High reasoning

Extract the remaining source adapters one at a time, using a separate commit for each:

1. Sensor.Community
2. OpenAQ
3. Breathe London

Each adapter module should own only its source-specific discovery, acquisition, parsing, source checkpoint data and structured source events.

Preserve:

- adapter enable and disable flags;
- connector-code resolution and fallbacks;
- station and timeseries filtering;
- source mirror and cache behaviour;
- retry and pending classifications;
- no-data classifications;
- candidate unit counts;
- structured log event names and fields;
- existing source acquisition ordering.

Do not create a generic adapter abstraction unless the current implementations share a genuinely stable interface. Prefer a small typed return contract over inheritance or a new framework.

Structural validation after each adapter extraction:

- existing TypeScript check;
- stale-reference search;
- event-name and environment-name comparison;
- `git diff --check`.

## Codex Phase 5: Extract Integrity source evidence and proposal staging

**Release group:** TS-B  
**Codex model:** GPT-5.6 Codex, High reasoning

Move the Integrity-specific local staging logic out of the general backfill orchestration.

Intended module ownership:

- complete connector-day guard validation;
- source-evidence-only phase normalisation;
- source-file identity normalisation and hashing;
- canonical source-row serialisation;
- pollutant-scoped evidence metadata;
- proposal directory handling;
- proposal chunk staging and finalisation;
- local proposal object metadata;
- prevention of direct R2 mutation during proposal-only phases.

Preserve the exact stage order and current error messages where they are operationally relied upon.

Keep canonical apply outside this extracted module unless the current code has a clean, already-defined boundary.

Structural validation:

- existing TypeScript check;
- confirm evidence JSON field names and hash inputs are unchanged;
- confirm proposal paths and filenames are unchanged;
- confirm the evidence-only phase cannot write to R2;
- `git diff --check`.

## Codex Phase 6: Extract observation history writing

**Release group:** TS-C  
**Codex model:** GPT-5.6 Codex, High reasoning

Extract observation history responsibilities into cohesive modules:

- row normalisation and deduplication;
- v1 and v2 Parquet row conversion where still required;
- Parquet creation and part splitting;
- pollutant, connector and day manifest construction;
- observation object planning;
- local-overlay object creation;
- observation write result summaries.

Preserve:

- column names and order;
- schema and writer versions;
- row sorting and deduplication keys;
- part size and row-group settings;
- manifest fields and counts;
- object-key construction;
- replacement and deletion planning;
- all structured events.

Do not change storage layout or remove v1 compatibility in this refactor unless a separate approved retirement plan exists.

Structural validation:

- existing TypeScript check;
- compare schema constants, manifest keys and object-key builders before and after;
- `git diff --check`.

## Codex Phase 7: Extract AQI rebuild and AQI history writing

**Release group:** TS-C  
**Codex model:** GPT-5.6 Codex, High reasoning

Extract the AQI path without changing calculations.

Intended ownership:

- loading observation history required for AQI;
- PM rolling-context acquisition;
- conversion to AQI helper rows;
- AQI generation diagnostics;
- AQI Parquet creation;
- data and debug manifest construction;
- AQI object planning;
- AQI write result summaries.

Preserve:

- DAQI and EAQI calculation functions and thresholds;
- PM2.5 and PM10 rolling-context rules;
- NO2 handling;
- data versus debug schema;
- diagnostic counters and reason strings;
- object keys and manifest hierarchy;
- fail-closed retention and context checks.

Structural validation:

- existing TypeScript check;
- compare imported AQI calculation functions and call order;
- compare schema constants and manifest fields;
- `git diff --check`.

## Codex Phase 8: Extract R2 access and reduce `run_job.ts` to orchestration

**Release group:** TS-C  
**Codex model:** GPT-5.6 Codex, High reasoning

Extract only cohesive R2 access and history-path helpers that are still embedded in `run_job.ts`.

Then reduce `run_job.ts` to:

- parse the run configuration;
- initialise shared runtime state;
- select the run mode;
- call source adapters and writer modules in the existing order;
- collect summaries;
- emit final run events;
- handle top-level failure.

Avoid creating a large catch-all utilities module. Keep domain-specific helpers with their owning domain.

Completion target:

- `run_job.ts` should be recognisably an orchestration entrypoint;
- extracted modules must not depend on importing the entrypoint;
- no circular imports;
- no module should perform work merely because it was imported.

Structural validation:

- existing TypeScript check;
- import graph inspection;
- search for top-level side effects;
- search for stale duplicate implementations;
- `git diff --check`.

Update the relevant system documentation to reflect code ownership without changing the functional contract.

## Codex Phase 9: Establish the Python Integrity package and stable contracts

**Release group:** PY-A  
**Codex model:** GPT-5.6 Codex, High reasoning

Begin Python modularisation only after the TypeScript release groups have been deployed and accepted through the Mike/ChatGPT phases.

Create the package structure under:

```text
scripts/uk-aq-history-integrity/bin/integrity/
```

First extract:

- CLI construction and argument validation;
- environment loading and path guardrails;
- shared constants and small dataclasses;
- SQLite connection and schema initialisation helpers;
- common date and JSON utilities.

Preserve direct-script execution. `uk-aq-history-integrity.py` must continue to work from its existing path without installation as a package.

Avoid moving detector, repair or source-adapter logic in this phase.

Structural validation:

- `python3 -m py_compile` for all touched modules;
- direct import check from the existing entrypoint directory;
- search for duplicate constants and stale imports;
- `git diff --check`.

## Codex Phase 10: Extract core snapshot and source acquisition checks

**Release group:** PY-B  
**Codex model:** GPT-5.6 Codex, High reasoning

Extract the imported-core snapshot and read-only source acquisition/check logic.

Intended ownership:

- core snapshot discovery, validation and SQLite import;
- OpenAQ source metadata and cache checks;
- Sensor.Community source metadata and cache checks;
- SOS source metadata, UK-AIR flat-file cache checks and mapping evidence;
- source-file state and event persistence;
- source row-count extraction used by read-only detection.

Keep shared database writes explicit. Prefer passing the SQLite connection and run context to functions rather than creating new module-level connections.

Preserve:

- cache paths and file identity calculations;
- source state classifications;
- download limits and retry behaviour;
- source event fields;
- connector and timeseries lookup construction;
- existing concurrency behaviour.

Structural validation:

- `python3 -m py_compile`;
- import checks;
- confirm source event and SQLite table names are unchanged;
- confirm no network or R2 operation occurs during module import;
- `git diff --check`.

## Codex Phase 11: Extract v2 detection and repair planning

**Release group:** PY-C  
**Codex model:** GPT-5.6 Codex, High reasoning

Extract the read-only v2 Integrity detectors and repair-plan construction.

Intended modules:

- observation partition and manifest detection;
- AQI data and debug detection;
- parent manifest and index detection;
- source availability classification;
- typed repair action planning;
- repair pollutant and connector scope calculation.

Preserve:

- gap type names;
- fault classes;
- severity rules;
- source-scope behaviour;
- allowed connector filters;
- selected-day handling;
- repair plan action fields;
- dry-run and check-only semantics.

Structural validation:

- `python3 -m py_compile`;
- confirm gap type strings and repair action kind strings are unchanged;
- confirm detectors remain read-only;
- `git diff --check`.

## Codex Phase 12: Extract repair execution and canonical apply

**Release group:** PY-C  
**Codex model:** GPT-5.6 Codex, High reasoning

Extract the ordered v2 repair flow while preserving its explicit stages:

1. observations proposal;
2. observation metadata proposal;
3. AQI proposal;
4. canonical apply;
5. final verification.

Intended ownership:

- immutable detector source-evidence invocation and validation;
- local proposal orchestration;
- metadata and targeted-index proposal executors;
- object-operation recording;
- canonical apply;
- remote GET verification;
- final verification;
- repair result summaries.

Preserve:

- the current overlay layout;
- stage names and order;
- object operation states;
- dependency blocking;
- R2 write and delete guards;
- backup readiness behaviour;
- `--allow-stale-dropbox`;
- explicit repair pollutant scope;
- no remote mutation during dry-run.

Structural validation:

- `python3 -m py_compile`;
- import-cycle check;
- compare stage names, status values and result fields;
- confirm canonical apply is the only remote mutation boundary;
- `git diff --check`.

## Codex Phase 13: Extract reporting, daily state and task health, then slim the Python implementation

**Release group:** PY-D  
**Codex model:** GPT-5.6 Codex, High reasoning

Extract:

- report assembly and report-file writing;
- daily profile state persistence;
- backup readiness checks;
- daily task-health reporting;
- top-level status calculation.

Reduce `uk-aq-history-integrity_impl.py` to composition and orchestration:

- load configuration;
- initialise the run;
- import the snapshot;
- run selected source checks;
- run detectors;
- optionally create and execute the repair flow;
- produce the report and task-health result;
- close resources and release the lock.

Preserve:

- report schema and field names;
- daily logical-run identity;
- task-health task keys and status values;
- lock behaviour;
- exit status behaviour;
- exception reporting.

Structural validation:

- compile every Python module;
- direct entrypoint import and `--help` check;
- stale-reference and duplicate-code search;
- `git diff --check`.

Update `system_docs/r2_history/integrity.md` and related ownership documentation to reflect the new module locations. Do not alter the documented functional contract.

## Codex Phase 14: Final structural review of the modularisation series

**Release group:** Review only  
**Codex model:** GPT-5.6 Codex, High reasoning

Review the complete modularisation series without introducing further redesign.

Produce a concise report covering:

- final line counts of the two orchestration files;
- final module list and ownership;
- remaining large responsibility blocks that were intentionally not moved;
- all preserved CLI arguments and environment variables;
- all preserved structured log event names;
- all preserved R2 schemas, paths and manifest contracts;
- any compatibility wrappers retained;
- any follow-up refactors that should be considered separately.

Run the existing repository structural checks only. Do not create a new test suite or perform live R2 writes.

# Mike or ChatGPT phases

## Mike/ChatGPT Phase 1: Confirm the functional SOS repair before modularisation

Before merging any modularisation PR:

1. Merge and deploy the focused SOS pollutant-scope repair.
2. Pull the updated `main` on CIC-Test.
3. Run one real scoped SOS Integrity repair using the explicit selected pollutants, for example:

   ```text
   --repair-pollutants pm25,pm10,no2
   ```

4. Confirm:
   - immutable detector evidence completes;
   - the known unmapped SOS rows are recorded without blocking mapped repairs;
   - the local proposal validates;
   - canonical apply performs only the expected R2 operations;
   - remote GET verification succeeds;
   - final verification runs;
   - the report records the expected remaining gaps;
   - no unrelated connector or pollutant is changed.

This is the baseline operational result for the refactor series.

## Mike/ChatGPT Phase 2: Review and deploy each TypeScript release group

Review TS-A, TS-B and TS-C in order.

For each release group:

1. Check that the diff is limited to the stated extraction.
2. Confirm no environment variables, event names, schemas, R2 keys or CLI contracts changed.
3. Merge the PR into `main`.
4. Pull `main` on CIC-Test.
5. Allow the real TEST system to exercise the deployed code.

After TS-A, run the same real scoped SOS Integrity operation used for the baseline.

After TS-B, run real source checks for SOS, Sensor.Community and OpenAQ, using normal TEST operations and the smallest operational scope that exercises each adapter.

After TS-C, run:

- a real scoped observation repair;
- the corresponding AQI rebuild;
- final verification;
- a subsequent Dropbox backup.

Compare the operational reports with the baseline. Exact timestamps, run IDs and hashes will naturally differ, but scope, statuses, object paths, manifest hierarchy and result semantics should remain equivalent.

Stop the series and revert the most recent release group if behaviour changes unexpectedly.

## Mike/ChatGPT Phase 3: Review and deploy each Python release group

Review PY-A, PY-B, PY-C and PY-D in order.

After each merge:

1. Pull `main` on CIC-Test.
2. Run the normal Integrity entrypoint from its existing path.
3. Confirm the same environment and state directories are selected.
4. Confirm the same SQLite database and lock are used.
5. Run a real operation appropriate to the extracted responsibility.

Operational coverage across the Python release groups should include:

- one check-only run;
- one normal source acquisition/check run;
- one real scoped repair;
- one final verification;
- one daily-profile run or the next naturally scheduled daily run;
- task-health reporting;
- a Dropbox backup after a successful writer operation.

This is post-deployment functional validation on CIC-Test, not a pre-implementation test suite.

## Mike/ChatGPT Phase 4: Compare reports and investigate any drift

Use the baseline and post-refactor reports to compare:

- selected days;
- selected connectors and pollutants;
- source files enumerated, required and read;
- source row counts;
- evidence and proposal stages;
- planned and applied R2 operations;
- observation and AQI manifest paths;
- final verification results;
- remaining gap counts;
- task-health status;
- Dropbox backup candidates after successful writes.

Distinguish acceptable run-specific differences from behavioural drift.

Acceptable differences include:

- timestamps;
- run IDs;
- temporary paths;
- hashes caused solely by expected regenerated content metadata;
- source data that genuinely changed between runs.

Behavioural drift includes:

- new or missing connector scope;
- changed pollutant scope;
- changed event or status names;
- different R2 layout;
- changed manifest fields;
- skipped fail-closed guards;
- new writes during dry-run or proposal-only phases;
- final verification no longer running after a successful apply.

## Mike/ChatGPT Phase 5: Final documentation and repository cleanup

Once all release groups have operated successfully on CIC-Test:

1. Review the Codex structural report.
2. Update system documentation only where module ownership or operator navigation changed.
3. Keep the stable functional contracts unchanged.
4. Remove temporary planning branches and close superseded draft PRs.
5. Confirm no temporary workflows, generated files, `__pycache__` directories or modularisation artefacts remain.
6. Record the final module map in the plan directory.
7. Mark this plan complete.

## Completion criteria

The modularisation is complete when:

- `run_job.ts` is primarily orchestration rather than a collection of all implementation details;
- `uk-aq-history-integrity_impl.py` is primarily orchestration rather than a single implementation module;
- source adapters have clear ownership;
- Integrity source evidence and proposal staging have clear ownership;
- observation and AQI writers have clear ownership;
- Python detection, planning, repair, reporting and task-health responsibilities have clear ownership;
- existing entrypoints and runtime contracts remain stable;
- all release groups have completed real CIC-Test operational validation;
- no unexplained behavioural drift remains;
- system documentation identifies the new code ownership accurately.

## Out of scope

This plan does not authorise:

- combining the outstanding SOS functional repair with modularisation;
- changing AQI algorithms or thresholds;
- changing source mapping policy;
- changing R2 layouts, schemas or retention rules;
- changing Dropbox backup behaviour;
- changing Integrity date selection;
- changing CLI or environment-variable names;
- replacing SQLite;
- introducing a new dependency-injection framework;
- rewriting both large files in a single unreviewable commit;
- adding a speculative pre-deployment functional test suite.
