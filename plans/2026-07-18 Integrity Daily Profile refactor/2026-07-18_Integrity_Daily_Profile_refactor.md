# 2026-07-18 Integrity Daily Profile refactor

## Status

Implementation plan for the UK AQ TEST system.

- Repository: `TEST-uk-aq/uk-aq-ops`
- Scope: TEST only
- Implementation date: 18 July 2026
- Recommended Codex configuration: Codex with High reasoning
- Default permission level: Level 1 code changes, followed by operator-run TEST deployment and validation

## Objective

Refactor the History Integrity `daily` profile so that one daily run checks:

1. the seven most recent calendar days ending on the latest observations day actually present in the committed v2 R2 history tree; and
2. the allocated historical day number or day numbers for every earlier month represented in R2.

The refactor must stop deriving the daily R2 end date from `INGESTDB_RETENTION_DAYS` or another retention variable. The configured retention remains relevant to Prune Daily and Phase B eligibility, but it must not be treated as proof of what is currently present in R2.

The work must also add small, idempotent daily-profile state to the existing local Integrity SQLite database, change the scheduled TEST operation to one daily run, preserve all existing Integrity behaviour outside date selection, and include a later investigation of the SOS connector readings P/R status.

## Authoritative reading and operating constraints

Before changing code, Codex must read, in this order:

1. `AGENTS.md`
2. `system_docs/README.md`
3. `system_docs/documentation_contract.md`
4. `system_docs/r2_history/README.md`
5. `system_docs/r2_history/integrity.md`
6. `system_docs/r2_history/contract.md`
7. `system_docs/r2_history/operations.md`
8. `system_docs/r2_history/validation.md`
9. `system_docs/r2_history/aqi_history_write_pipeline.md`
10. every implementation file identified by the R2 History area ownership list and by the existing Integrity launcher or scheduler

Codex must treat `system_docs/` as read-only. It must not create, edit, move, rename or delete files under `system_docs/`. After implementation and TEST validation, Codex must provide a documentation handover for ChatGPT in Chat mode. ChatGPT will update the authoritative system documentation from the implemented code and real TEST results.

The implementation must follow the TEST System Validation Policy in `AGENTS.md`:

- perform only the smallest structural checks before deployment;
- do not create or run a broad test suite;
- perform functional validation after deployment through real operation on the TEST system;
- do not touch LIVE repositories, services, databases, R2 accounts or schedules.

## Existing behaviour that must not change

This refactor changes the scheduled daily date-selection policy and cadence only. Preserve the following load-bearing behaviour unless a conflict is found and explicitly reported:

- Integrity remains v2-only. `v1` and `both` remain rejected.
- A complete `uk-aq-ops` checkout remains the only supported runtime model.
- `--check-only` and `--run-backfill` remain mutually exclusive.
- The configured source filters and source-adapter semantics remain unchanged.
- Repair runs retain the existing Dropbox backup-readiness gate and `--allow-stale-dropbox` recovery override.
- The Dropbox R2 history mirror remains the normal local view used by Integrity detection and repair planning.
- The repair overlay, tombstone, exact-byte GET verification and final-verification behaviour remain unchanged.
- The existing observation, AQI, manifest, targeted-index and stable-binding checks remain unchanged.
- Missing or unreadable child data must continue to fail closed rather than permitting incomplete parent or latest-index proposals.
- O3 and other non-AQI observation children must continue to be retained correctly.
- Source-provided DAQI/index observations remain source observations and must not be conflated with UK AQ calculated AQI history.
- R2 history index byte-stability requirements remain unchanged.
- Existing JSON and Markdown reports, SQLite run history and daily-task-health reporting remain available.
- Existing manual profile behaviour must remain available.
- Existing weekly and monthly CLI profile behaviour must remain available unless a separately documented decision intentionally retires it. They do not need to remain scheduled after the daily schedule has been proven.
- The current scheduled invocation's source, check-only or repair mode, limits, backup behaviour and environment loading must be preserved. Do not silently change a check-only schedule into a repair schedule or vice versa.

If the implementation and an authoritative document disagree, stop and report the conflict rather than silently choosing one.

## Target daily selection contract

### 1. Logical run date

Use a stable `logical_run_date` for the scheduled daily profile.

- Prefer the existing scheduled date supplied to daily-task-health reporting when available.
- Otherwise derive it in `Europe/London`, not from the latest R2 date and not from a potentially different UTC calendar day around midnight.
- A retry for the same scheduled day must reuse the same logical date.
- Manual `--from-day` and `--to-day` overrides must continue to take precedence and retain their current contiguous-window meaning.

### 2. Latest R2 observations day

For the scheduled `daily` profile, discover the latest observations day from the local Dropbox mirror of the committed v2 observations tree.

- Use the greatest strictly parsed `day_utc=YYYY-MM-DD` directory under the active committed v2 observations prefix.
- Exclude staging, temporary, overlay, archive and non-v2 paths.
- Do not calculate this date from `INGESTDB_RETENTION_DAYS`, the current date or a fixed offset.
- Do not require the AQI day to be complete before selecting the observations day. A missing AQI day is something Integrity must detect.
- Do not require the selected observations day manifest or all of its children to be valid before selecting it. A malformed or incomplete latest day must remain inside the integrity scope so that the existing checks can report it.
- If no valid observations day directory can be discovered, fail the scheduled selection safely and report the reason. Do not silently fall back to the retention-derived calculation.

The current example is:

- logical run date: `2026-07-17`
- latest R2 observations day: `2026-07-12`
- recent scope: `2026-07-06` through `2026-07-12`, inclusive

### 3. Recent seven-day scope

Create seven consecutive calendar dates ending on the latest discovered R2 observations day:

```text
recent_start = latest_r2_observations_day - 6 days
recent_end   = latest_r2_observations_day
```

Include every calendar date in that interval, even when a day directory or manifest is missing. Missing objects are integrity findings and must not be hidden by filtering the selection to existing complete days.

### 4. Historical target-day rotation

The logical run date determines the historical target day number or numbers. The latest R2 date does not determine this rotation.

For logical run days 1 to 25, use the same single day number.

For the final days of the logical run month, allocate missing 29th, 30th and 31st target numbers as follows:

| Length of logical run month | Day 26 | Day 27 | Day 28 | Day 29 | Day 30 | Day 31 |
|---|---:|---:|---:|---:|---:|---:|
| 31 days | 26 | 27 | 28 | 29 | 30 | 31 |
| 30 days | 26 | 27 | 28 | 29 | 30 and 31 | n/a |
| 29 days | 26 | 27 | 28 and 30 | 29 and 31 | n/a | n/a |
| 28 days | 26 and 29 | 27 and 30 | 28 and 31 | n/a | n/a | n/a |

This mapping means each target day number from 1 to 31 is allocated exactly once during every logical calendar month.

The allocation applies to the logical run month only. When applying a target day number to an earlier historical month:

- include it when that date is valid for that historical month;
- skip impossible dates such as 31 April or 30 February;
- do not remap an impossible historical date to the historical month's final day.

### 5. Historical month scope

Discover represented months from actual v2 observations day directories in the local R2 mirror.

For each distinct represented month strictly before the month containing the latest R2 observations day:

1. apply every target day number allocated to the logical run date;
2. include each calendar-valid historical date even if that exact day directory or manifest is absent, so missing historical data can be detected;
3. skip a month only when the observations tree contains no represented day for that month;
4. do not use source archive file presence as proof that the month exists in R2.

The month containing the latest R2 observations day is covered by the recent seven-day scope. Do not add a separate historical target for that month.

### 6. Final explicit target set

Build one deterministic, sorted and deduplicated set of explicit target dates containing:

- the recent seven dates;
- the historical dates allocated for the current logical run date;
- any historical target allocation carried forward from missed daily logical dates, as described below.

Each selected date must retain one or more reasons:

- `recent`
- `historical:<target-day-number>`
- `catch_up:<missed-logical-run-date>:<target-day-number>`

Do not implement the new daily scope as one `from_day` to `to_day` range spanning the earliest historical date through the latest recent date. That would incorrectly process every intervening day. The selected-day set must remain explicit through source selection, R2 checks, reporting and repair planning.

`from_day` and `to_day` may remain in compatibility output as the minimum and maximum selected dates, but downstream daily-profile logic must not interpret those bounds as a complete continuous range.

## SQLite state contract

Add a small daily-profile state/history table to the existing local Integrity SQLite database. Keep it local to the Integrity database. No Supabase or schema-repository migration is required for this local SQLite state.

A suitable logical model is one row per environment and logical run date, for example:

- `env_name`
- `logical_run_date`
- `integrity_run_id`, nullable until the main run row exists
- `latest_r2_observations_day`
- `recent_start_day`
- `recent_end_day`
- `historical_target_days_json`
- `selected_days_json` or an equivalent compact deterministic representation
- `represented_month_count`
- `status`: at least `planned`, `running`, `complete`, `failed` and `stopped_limit`
- `started_at_utc`
- `completed_at_utc`
- `error_message`
- `updated_at_utc`

Use a unique key on `(env_name, logical_run_date)` and idempotent upsert behaviour. Rerunning the same logical day must update the same state record rather than silently creating duplicate scheduling state.

The permanent detailed evidence should continue to live in the existing run, cross-check and report structures. Do not duplicate all integrity findings into the scheduling-state row.

### Missed-run catch-up

Use the SQLite state to detect logical daily dates after the last completed daily profile that have no completed state.

- On the first run after this feature is deployed, seed from the current logical date. Do not retrospectively generate catch-up work for all dates before deployment.
- For later missed or failed logical dates, calculate the historical target day number allocation that would have applied on each missed date and add those historical target dates to the next daily explicit selection.
- Deduplicate catch-up dates against the current recent and historical selection.
- Preserve the existing download and runtime limits. If a run stops because of a soft limit, record it as incomplete and leave the remaining logical-date allocation eligible for a later catch-up. Do not mark it complete.
- A successfully completed retry must clear the pending status through the idempotent state update.

## Report and task-health changes

Extend the existing JSON report, Markdown report, logs and daily-task-health summary with a compact date-selection section containing:

- `selection_mode`
- `logical_run_date`
- `latest_r2_observations_day`
- discovery source and active observations prefix
- `recent_start_day`
- `recent_end_day`
- `historical_target_day_numbers`
- represented historical month count
- selected date count
- selected dates with reasons
- caught-up logical dates, when any
- state-row status

Keep the existing run summary fields for compatibility. Make it obvious that a non-contiguous selected-day set was used and that no full minimum-to-maximum historical range was processed.

## Phased implementation

### Phase 0: repository and contract discovery

1. Read the authoritative documents listed above.
2. Use `grep`, as required by `AGENTS.md`, to identify:
   - every use of `PROFILE_START_WINDOWS_DAYS`;
   - every use of `resolve_integrity_end_back_days` and `compute_window`;
   - all loops that expand `from_day` to `to_day`;
   - all source-adapter entry points;
   - all R2 observations and AQI integrity entry points;
   - the SQLite schema and migration helpers;
   - JSON, Markdown and daily-task-health report construction;
   - the current shell launcher, launchd or scheduler definitions and any repo-managed templates;
   - tests directly covering profile defaults, date selection or adapters.
3. Record the implementation ownership map in the implementation report before editing.
4. Confirm whether the scheduled TEST invocation is check-only or repair-enabled and preserve it.
5. Confirm whether weekly and monthly schedules currently exist. Do not remove or disable anything during this phase.

Deliverable: a concise implementation map and a list of authoritative behaviours that will be preserved.

### Phase 1: structural design and compatibility boundary

1. Extract daily-profile selection into a small, deterministic helper or module rather than embedding additional branches in the 18,000-line orchestrator.
2. Define one explicit target-date representation that can carry reasons and be passed through adapters and R2 checks.
3. Preserve manual contiguous-window behaviour.
4. Preserve weekly and monthly CLI behaviour.
5. Decide the smallest compatibility changes required for functions that currently accept only `from_day` and `to_day`.
6. Ensure no daily call can accidentally expand the historical selection into a continuous multi-year range.
7. Confirm how the existing local Dropbox v2 observations root is resolved and reuse that resolution rather than introducing a second path contract.

Deliverable: structurally viable implementation design, with no deployment or external calls.

### Phase 2: pre-change archive

Before editing substantial active non-test code, archive every active code file that will be changed under:

```text
archive/2026-07-18/<original-relative-path>
```

Follow the `AGENTS.md` pre-change archive policy exactly:

- archive active non-test implementation code only;
- do not archive plans, documentation, tests, fixtures or generated outputs;
- archive each code file only once for the date;
- never execute or import archive paths.

Deliverable: dated rollback copies for all in-scope active code.

### Phase 3: implement explicit daily date selection

1. Replace the retention-derived daily end-date calculation with local v2 observations-day discovery.
2. Implement the seven-day recent selection.
3. Implement the historical target-day allocation table.
4. Discover represented historical months from actual v2 observations day directories.
5. Produce the sorted, deduplicated explicit target-date set with reasons.
6. Keep manual, weekly and monthly semantics unchanged.
7. Fail safely when no R2 observations day can be discovered.
8. Remove or retire daily-only use of `INGESTDB_RETENTION_DAYS` without removing retention behaviour needed by other systems.
9. Keep legacy summary bounds only as compatibility metadata, not processing scope.

Deliverable: daily selection is data-driven from the local R2 mirror and produces an explicit non-contiguous date set.

### Phase 4: pass explicit dates through adapters and R2 checks

1. Update the orchestrator and affected helper functions so daily runs process only selected dates.
2. Update OpenAQ and Sensor.Community selection loops without changing their source-file semantics, cache rules, limits or comparison logic.
3. Update SOS selection to accept the explicit target dates while retaining the existing strict `site_ref + pollutant_code + day_utc` validity-window mapping and the existing `site_ref + year` source-file identity.
4. Update v2 observations and AQI checks to inspect exactly the selected dates and to report absent selected days as gaps.
5. Preserve repair-plan deduplication and stage ordering.
6. Preserve the rule that observation repair scope drives AQI repair only where already defined.
7. Ensure report totals distinguish selected dates from checked partitions, connectors, pollutants and timeseries.

Deliverable: no adapter or R2 check expands the explicit daily selection into an unintended continuous date range.

### Phase 5: add SQLite daily-profile state and catch-up

1. Add the local SQLite table through the existing `SCHEMA_SQL` and in-place migration style.
2. Plan and upsert the state row before source work begins.
3. Link it to the existing `integrity_runs` row once available.
4. Mark completion only after the existing final run status has been determined.
5. Mark failures and `stopped_limit` states without losing the planned selection.
6. Implement post-deployment-only catch-up behaviour for missed logical dates.
7. Expose state in JSON, Markdown, logs and daily-task-health summaries.
8. Keep the database path, WAL behaviour, Dropbox copy behaviour and guardrails unchanged.

Deliverable: idempotent local scheduling state supports retries and missed-run catch-up.

### Phase 6: schedule one TEST daily run

1. Identify the current authoritative TEST schedule mechanism and repo-managed launcher or template.
2. Change the intended schedule to one daily invocation of the existing daily profile.
3. Preserve the existing environment, source filter, history version, check-only or repair mode, limits, lock, logging and daily-task-health settings.
4. Keep weekly and monthly CLI profiles available.
5. After the new daily operation has been proven in TEST, disable redundant scheduled weekly or monthly invocations if they exist. Do not delete the profiles from the CLI as part of this refactor.
6. If the active launchd plist or scheduler configuration lives outside the repository, do not edit it automatically. Provide the exact operator command or file change required after the code is deployed.
7. Do not run `launchctl`, deploy workflows or other external operations unless the user explicitly grants Level 4 permission.

Deliverable: code and exact operator instructions for a single daily TEST run, without silently changing operational mode.

### Phase 7: SOS connector P/R status investigation

This requirement must remain in scope, but do not guess its semantics during the profile refactor.

After the explicit-date pipeline is working, inspect and report:

1. what the SOS connector readings P/R status means in the current source and UK AQ implementation;
2. where it is sourced, stored, transformed and reported;
3. whether the current SOS Integrity adapter validates it;
4. whether the annual UK-AIR flat-file CSVs contain sufficient evidence to validate it;
5. whether a `site_ref + year` file can be read or parsed once per run and reused for every selected day in that year;
6. whether the existing source cache and `source_file_state` already avoid repeated annual-file downloads or parsing;
7. the smallest safe implementation options if a P/R integrity check is missing.

The findings must appear in the implementation report and ChatGPT documentation handover. Any semantic or repair change resulting from this investigation must be presented separately rather than silently bundled into the daily-profile refactor.

Deliverable: evidence-based P/R status findings and, only where clear, a separately identified follow-on implementation recommendation.

### Phase 8: minimal pre-deployment validation

Follow the TEST policy. Do not run broad suites or external operations.

Run only:

1. Python syntax compilation for each changed Python file.
2. Shell syntax parsing for each changed shell launcher or repo-managed schedule script.
3. One narrowly targeted deterministic date-selection check.

The targeted date-selection check is genuinely required because an error in the final-day allocation or explicit-scope boundary could schedule incorrect work across every historical month or accidentally trigger a continuous multi-year scan. Keep it small and cover only:

- a normal date such as 17 July;
- the 30-day allocation of 30 and 31;
- leap-February allocations;
- non-leap-February allocations;
- deduplication against the recent seven-day set;
- proof that the result remains an explicit set rather than a minimum-to-maximum expansion.

Do not run the full existing Integrity suite before deployment. Do not add unrelated tests.

Deliverable: structural viability confirmed with the single justified targeted check.

### Phase 9: operator deployment to the TEST runtime

Codex must stop before external operations and provide exact commands for the operator to:

1. update the complete TEST ops checkout on the MacBook Pro;
2. confirm the repository virtual environment and `duckdb` dependency are available;
3. install or reload any repo-managed launcher or external launchd schedule change;
4. perform the first real TEST daily-profile run using the existing operational mode;
5. locate the JSON report, Markdown report, log and SQLite database;
6. roll back the schedule and code if necessary.

Do not use a partial copied `bin/` directory. Deploy and run from the complete repository checkout as required by the Integrity contract.

Deliverable: exact manual deployment and rollback commands, not executed by Codex.

### Phase 10: real TEST operational validation

Functional validation happens after deployment through real TEST operation.

For the first operator-run daily profile:

1. confirm the latest discovered R2 observations day matches the latest day directory in the local R2 mirror;
2. confirm the recent selection contains exactly seven consecutive dates ending on that day;
3. confirm the historical selection contains the allocated target date for each represented earlier month where that date is calendar-valid;
4. confirm the current anchor month is not separately added as historical scope;
5. confirm the report lists explicit selected dates and reasons;
6. confirm no intervening days between the oldest historical target and the recent window were processed unless explicitly selected;
7. confirm OpenAQ, Sensor.Community and SOS adapters respect the selected dates;
8. confirm SOS annual files are not redundantly downloaded or parsed for each selected date where reuse is possible;
9. confirm SQLite has one idempotent state row for the logical date and that the existing `integrity_runs` record remains intact;
10. confirm daily-task-health receives the intended status and selection summary;
11. confirm existing v2 detection, report and repair-plan behaviour remains unchanged for the selected days.

Then allow one normal scheduled daily TEST run and check one representative report and state row. For this reversible scheduling refactor, one successful operator-run invocation plus one successful normal scheduled invocation is sufficient unless a destructive repair or another high-risk operation is separately authorised.

Do not run a broad historical shadow comparison or soak test unless a real TEST failure indicates it is needed.

Deliverable: actual TEST evidence for the implementation and documentation handover.

### Phase 11: ChatGPT system documentation update

After code implementation and real TEST validation, Codex must provide a concise handover containing:

- authoritative documents reviewed;
- preserved behaviours;
- implemented daily-selection contract;
- exact files changed;
- SQLite schema and migration changes;
- report and daily-task-health changes;
- scheduler changes and operator actions;
- SOS P/R findings;
- structural checks run;
- real TEST commands and observed results;
- any conflicts, limitations or follow-on work.

ChatGPT in Chat mode will then review the actual repository changes and TEST evidence and update `system_docs/`.

At minimum, ChatGPT should assess updates to:

- `system_docs/r2_history/integrity.md`
- `system_docs/r2_history/README.md`, only if area orientation or ownership changes
- `system_docs/r2_history/validation.md`, only if the authoritative TEST validation contract needs the new operational check
- any scheduling-area document that has become authoritative by then

ChatGPT must update behavioural documentation in the same branch or pull request as the implemented behavioural change, or immediately before that branch is merged. Codex must not make these system-document edits itself.

Deliverable: authoritative system documentation matches the deployed TEST behaviour.

## Expected implementation areas

Codex must confirm exact ownership before editing, but likely areas include:

- `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py`
- a new small helper under `scripts/uk-aq-history-integrity/` for date selection, if that is the cleanest focused change
- directly affected Integrity tests only
- the existing repo-managed Integrity launcher or schedule template, if present
- active report or wrapper helpers discovered through `grep`

Do not modify unrelated workers, R2 layout writers, public APIs, AQI formula code or LIVE configuration.

## Rollback

Rollback must be simple and reversible:

1. restore changed active code from `archive/2026-07-18/` or revert the implementation commit;
2. restore the previous TEST schedule configuration;
3. reload the schedule through the operator-provided command;
4. leave the new SQLite table in place if the old code ignores it, unless a specific compatibility problem is observed;
5. do not delete existing Integrity run, source-file, cross-check or report data;
6. do not alter R2 or Dropbox history as part of scheduler rollback.

## Acceptance criteria

The refactor is complete when all of the following are true:

- The TEST Integrity schedule runs once per day.
- The daily profile no longer derives its latest R2 day from `INGESTDB_RETENTION_DAYS`.
- The latest daily anchor is discovered from the committed v2 observations tree in the local R2 mirror.
- The recent scope is exactly seven consecutive dates ending on that anchor.
- Historical target dates are allocated by the logical run date using the stated 28, 29, 30 and 31-day mapping.
- Every represented earlier R2 month is included where the target date is calendar-valid.
- The current anchor month is not duplicated as historical scope.
- The complete selection is explicit, sorted and deduplicated.
- No adapter or check expands the selection into an unintended continuous historical range.
- Manual, weekly and monthly CLI behaviour remains available.
- Existing v2 detection, backup gating, repair coordination, final verification, stable bindings, report formats and task-health behaviour are preserved.
- SQLite state is idempotent and supports retry and missed-run catch-up.
- SOS annual source files are reused efficiently where the current design permits.
- The SOS readings P/R status has been investigated and reported without guessed semantics.
- Only minimal structural validation occurred before deployment.
- Real functional validation occurred on the TEST system.
- Codex supplied a complete handover and ChatGPT updated the authoritative `system_docs/`.

## Out of scope

- Any LIVE change.
- Changing the v2 R2 object layout or manifest contracts.
- Changing AQI or DAQI calculation rules.
- Changing observation mapping or timeseries validity semantics.
- Replacing the Dropbox-mirror Integrity model with broad live-R2 listing.
- Broad test-suite expansion.
- Unrelated Integrity repair changes.
- Implementing a guessed SOS P/R interpretation without evidence.
- Allowing Codex to edit `system_docs/`.
