# Latest Snapshot Codex prompts

Recommended model for every prompt: **GPT-5.6 Codex, High reasoning**.

Use in order:

1. `phase_0_structural_review.md`
2. `phase_1_runtime_prevention.md`
3. Deploy Phase 1 to TEST after the minimal checks defined in the prompt and `system_docs/latest_snapshot/validation.md`.
4. Validate recurrence prevention through normal TEST scheduler, Pub/Sub, R2 and website operation.
5. `phase_2a_recovery_source_audit.md`
6. `phase_2b_recovery_tool.md`
7. Run the recovery tool report-only on TEST, then perform targeted write mode only after reviewing the report.
8. Complete the Phase 3 and Phase 4 manual deployment, repair and validation steps in the main plan.

## TEST-first validation rule

Do not build or run broad pre-deployment suites.

Before deploying to TEST, use only:

- syntax/type validation for changed files;
- one compact deterministic regression check for the state policy or recovery merge being changed.

Functional testing is performed after deployment through the real TEST pipeline.

## Authority

All prompts must follow:

- `AGENTS.md`;
- `system_docs/latest_snapshot/contract.md`;
- the remaining documents under `system_docs/latest_snapshot/`;
- `../../uk_aq_latest_snapshot_invalid_values_refactor_plan.md`.

The prompts must not expand the task into connector, AQI, WHO, chart, website or checkpoint work.
