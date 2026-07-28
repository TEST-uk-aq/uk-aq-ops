# Prune Daily runtime budget

## Authority and scope

This document is an authoritative amendment to:

- [`implementation_safety_contract.md`](implementation_safety_contract.md);
- [`prune_connector_day_gate.md`](prune_connector_day_gate.md);
- [`history_writer_coordination.md`](history_writer_coordination.md);
- the GitHub Actions execution contract for `.github/workflows/uk_aq_prune_daily.yml`.

Where older code, configuration, tests, plans or documentation conflict with this file, this file is authoritative for the overall Prune Daily and Phase B runtime envelope.

This contract changes time available for the existing work. It does not relax connector-day deletion safety, source-identity requirements, lock ordering, manifest verification, index verification, graceful stopping or reporting requirements.

## Required timeout hierarchy

The normal GitHub Actions Prune Daily path MUST use these ordered limits:

```text
Phase B effective work deadline     1,680 seconds / 28 minutes
Phase B internal maximum            1,740 seconds / 29 minutes
Prune Daily worker hard timeout     1,800 seconds / 30 minutes
GitHub Actions job timeout          40 minutes
```

The required implementation values are:

```text
UK_AQ_PRUNE_DAILY_PHASE_B_MAX_SECONDS_PER_RUN=1740
UK_AQ_PRUNE_DAILY_PHASE_B_STOP_BEFORE_TIMEOUT_SECONDS=60
shell worker timeout=30m
timeout --kill-after=30s 30m node workers/uk_aq_prune_daily/job.mjs
GitHub Actions timeout-minutes=40
```

The limits MUST remain strictly ordered:

```text
effective Phase B deadline
< internal Phase B maximum
< worker hard timeout
< GitHub Actions job timeout
```

The 60-second Phase B stop-before reserve and the additional 60 seconds between the internal maximum and the worker hard timeout provide a total two-minute controlled shutdown runway before forced termination.

The GitHub Actions job timeout is deliberately longer than the worker timeout so checkout, dependency installation, report writing and artifact upload remain possible even when the worker uses its complete 30-minute hard envelope.

## Phase B budget variable names

The budget variables are owned by Prune Daily Phase B, not by every R2 history writer. Their names MUST therefore include the complete operational scope:

```text
UK_AQ_PRUNE_DAILY_PHASE_B_MAX_SECONDS_PER_RUN
UK_AQ_PRUNE_DAILY_PHASE_B_STOP_BEFORE_TIMEOUT_SECONDS
```

The recently introduced broad names are retired:

```text
UK_AQ_R2_HISTORY_MAX_SECONDS_PER_RUN
UK_AQ_R2_HISTORY_STOP_BEFORE_TIMEOUT_SECONDS
```

Because the broad names have not yet become an established deployed interface, the implementation MUST perform a clean rename and MUST NOT retain them as aliases or fallbacks.

Module-local constants may remain concise where their enclosing Phase B module makes scope unambiguous.

This rename does not create authority to rename every older `UK_AQ_R2_HISTORY_*` or `UK_AQ_PHASE_B_*` setting in the same change. Wider environment-variable naming consolidation is separate work.

## Phase B budget behaviour

Phase B MUST calculate its effective deadline as:

```text
max_seconds_per_run - stop_before_timeout_seconds
1740 - 60 = 1680 seconds
```

At or before that effective deadline, Phase B MUST:

- stop starting new connector-day work;
- avoid starting a stage whose conservative minimum completion allowance exceeds the remaining budget;
- release any held advisory lock through normal `finally` paths;
- leave incomplete connector-day gates false;
- preserve a safe resumable checkpoint or perform the established bounded cleanup;
- return a controlled retry-safe budget-stop result;
- allow the top-level Prune Daily job to write its report and task-health outcome.

A budget stop MUST NOT rely on exit code `124` or the shell timeout as normal control flow. The shell timeout remains the final process guard only.

## Budget-related configuration

The active GitHub workflow MUST pass explicit defaults for both Phase B budget variables rather than relying only on source-code defaults:

```text
UK_AQ_PRUNE_DAILY_PHASE_B_MAX_SECONDS_PER_RUN
UK_AQ_PRUNE_DAILY_PHASE_B_STOP_BEFORE_TIMEOUT_SECONDS
```

Both variables MUST also be present in the repository's environment-variable catalogue with the correct GitHub variable target.

The retired broad names MUST be absent from:

- the active workflow;
- runtime environment parsing;
- environment-variable catalogues;
- README configuration lists;
- focused tests;
- current implementation documentation.

Source-code defaults, workflow defaults, configuration catalogues, focused tests and operational documentation MUST agree on the values in this contract.

## Settings that are not automatically scaled

The change from a 15-minute to a 30-minute worker timeout does not by itself justify doubling every independent timeout.

The following are separate safety or service limits and MUST be reviewed for structural compatibility, but changed only where the implementation shows they were derived from the old overall envelope:

- PostgreSQL statement and query timeouts;
- PostgreSQL connection timeouts;
- advisory-lock acquisition timeouts and retry intervals;
- individual HTTP, R2 and Dropbox request timeouts;
- per-stage conservative minimum completion allowances;
- deletion batch sizes and candidate-count limits.

Per-stage minimum completion allowances express the minimum remaining time required to begin a stage. They are not stage maximum durations. They MUST remain conservative and internally consistent with the new 1,680-second effective budget, but MUST NOT be blindly doubled.

`UK_AQ_R2_HISTORY_MAX_CANDIDATES_PER_RUN` remains an independent work-volume bound. It MUST NOT be increased or renamed merely because the runtime envelope increased.

## Failure and reporting

If the internal Phase B budget is exhausted, the run MUST produce a reportable controlled outcome that distinguishes:

- completed connector-day observation gates;
- incomplete connector-day work;
- AQI work skipped or incomplete because of budget;
- day or global finalisation not started because of budget;
- safe resumable state;
- whether any deletion authority was established.

A worker hard-timeout event is abnormal. The GitHub Actions artifact-upload step MUST still run through `if: always()` and preserve any report that was successfully written before termination.

## Focused structural validation

Before deployment, only narrow deterministic checks are required. They MUST prove:

- the workflow worker command uses a 30-minute hard timeout;
- the workflow job timeout is 40 minutes;
- workflow and source defaults use `1740` and `60` through the Prune Daily Phase B variable names;
- the retired broad variable names are absent from active code and configuration;
- the calculated effective Phase B deadline is 1,680 seconds;
- a stage is not started when its minimum allowance exceeds the remaining budget;
- a budget stop returns a controlled retry-safe result and does not depend on forced termination;
- report upload remains configured with `if: always()`;
- no deletion gate is completed for unfinished connector-day observation work.

Do not add a broad speculative pre-deployment test suite. Functional acceptance occurs through a real TEST Prune Daily operation after deployment.

## Functional acceptance in TEST

After deployment:

1. run one normal TEST Prune Daily operation;
2. confirm the worker may continue beyond the old 15-minute limit without forced termination;
3. confirm Phase B stops safely before the 30-minute worker hard limit when its internal budget is exhausted;
4. confirm the final report and task-health outcome are written;
5. confirm any incomplete connector-day remains unpruned with its gate false;
6. confirm completed connector-day deletion authority remains governed by [`prune_connector_source_identity.md`](prune_connector_source_identity.md), manifest and index contracts.
