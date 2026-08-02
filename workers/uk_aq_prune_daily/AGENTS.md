# Prune Daily agent instructions

These instructions apply to files under `workers/uk_aq_prune_daily/` and supplement the repository root `AGENTS.md`.

## Required contracts

Before analysing, planning or changing Prune Daily Phase B history behaviour, read:

1. `/AGENTS.md`;
2. `/system_docs/README.md`;
3. `/system_docs/r2_history/README.md`;
4. `/system_docs/r2_history/aqi_history_write_pipeline.md`;
5. `/system_docs/r2_history/prune_connector_day_gate.md`;
6. `/system_docs/r2_history/implementation_safety_contract.md`;
7. `/system_docs/r2_history/prune_daily_observation_only_phase_b_contract.md`;
8. any other R2-history contract linked by those files that is directly affected by the task.

`system_docs/` is read-only to Codex and other coding agents. Do not create, edit, move, rename or delete files under it. Report any required documentation follow-up to ChatGPT in Chat mode.

## Regression-sensitive control-flow mode

The root TEST policy normally prefers minimal pre-deployment validation. The following Prune Daily changes are a targeted exception because a small branch error can silently block pruning, bypass a deletion gate, omit required finalisation or write the wrong R2 domain:

- enabling or disabling a Phase B stage;
- changing candidate-stage branching;
- changing connector-gate completion or invalidation;
- changing observation or AQI day finalisation;
- changing aggregate day completion;
- changing deletion eligibility or source-identity checks;
- changing lock acquisition or release around these stages.

For those changes, Codex must perform efficient regression validation rather than syntax-only validation.

### Required validation sequence

1. Inspect the real call sites and existing tests before editing.
2. Archive each active non-test implementation file that will be changed, following the root pre-change archive policy.
3. Add or amend narrowly targeted deterministic tests that exercise both the changed branch and the preserved branch.
4. Run the focused Prune Daily or Phase B tests during iteration.
5. Run `node --check` on every changed JavaScript module.
6. After focused tests pass and the implementation is stable, run the repository's complete local Node test suite once.
7. Run `git diff --check`.
8. Report exact commands, pass/fail counts, skips and the reason for each skip.

Do not repeatedly run the complete suite after each edit. Use focused tests while iterating and one complete Node regression run at the end.

Do not run unrelated Python suites unless Python code was changed or a directly affected cross-language contract requires them.

Do not access Supabase, Cloudflare, R2, Dropbox, external APIs or live/test operational services during local validation. Do not deploy, run Prune Daily, run a backfill or mutate cloud state unless the user explicitly grants the required permission level.

### Test quality requirements

Tests must assert observable orchestration and safety outcomes, not merely inspect source text.

Where a stage is disabled or skipped, tests must prove its adapters or side-effecting functions are not called. Where a stage remains enabled, tests must prove the existing path is still reachable.

For gate and finalisation changes, tests must prove both:

- the intended work can still complete; and
- unrelated or disabled work cannot block, revoke or falsely complete that work.

Prefer existing dependency injection, exported test helpers and established fixtures. Add the smallest seam needed for deterministic testing when no safe seam exists. Do not create a parallel implementation solely to make testing easier.

A broad new test framework, large fixture programme, shadow production comparison or exhaustive edge-case suite is not required unless the user explicitly asks for it.

## Observation-only Phase B change

For the observation-only Phase B task, the implementation must follow `/system_docs/r2_history/prune_daily_observation_only_phase_b_contract.md`.

The intended code selection is the existing internal property:

```javascript
phase_b_calculate_aqi_from_observations_enabled: false,
```

Do not introduce a new environment variable, repository variable, secret or legacy writer selector.

The implementation must explicitly guard both:

- candidate-level observation-derived AQI calculation and output; and
- AQI day-manifest and AQI-index finalisation.

Observation writes, observation indexes, connector-day gates, observation day finalisation and safe pruning must continue. Disabled AQI must be reported as a deliberate skip and must not be recorded as a failure.
