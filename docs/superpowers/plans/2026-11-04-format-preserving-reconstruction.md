# Format-preserving fixed-v3 reconstruction implementation plan

> Execute inline using the executing-plans workflow. The user-supplied Stage 2E specification is the authority; repository contracts override implementation assumptions.

**Goal:** preserve each authenticated selected exact-index format during fixed-v3 reconstruction, and block unsupported proof/publication paths.
**Architecture:** retain checkpoint-authenticated compact latest as format authority even when its summary fast path is unusable. Require explicit per-scope selection at the rebuild boundary. Reuse the independent canonical/physical verifier for a read-only existing-schema-2 reconstruction preparation helper; do not connect it to operational APPLY.
**Tech stack:** existing Node ESM, canonical/index validators and offline Parquet inspector.

## Global constraints

No operational service access, repair APPLY, conversion, schema-2 activation, new observation event, backup-policy change or authoritative system-doc edits. Archive active files before editing. Deliver branch/commit/push/PR to TEST main, without merge or deployment.

## Review focus

- Missing or corrupt latest must not be treated as evidence for schema 1.
- Existing scope missing from an authenticated registry is unknown, not new.
- Mixed scopes must retain separate format dependencies.
- Old proof JSON cannot replace fresh independent inspection.
- Legacy migration/APPLY must reject unsupported schema-2 inputs before mutation.

## Tasks

- [x] Add targeted failing checks for format propagation, missing selection, schema-2 proof blocker and mixed latest.
- [x] Archive planner, direct verifier and any additionally changed active guard before editing.
- [x] Add explicit selected-format resolution and preparation-only reconstruction with the existing verifier; carry selection metadata through planner output.
- [x] Reject schema-2 inputs at legacy migration/Integrity adapters that would otherwise rebuild schema 1.
- [x] Run syntax/import and targeted checks; compare any relevant failures to unchanged dd068f93. Broad Node suite only if required by repository rules (root rules require targeted checks, not a full suite).
- [x] Write readiness/documentation handover, review diff, commit, push and open/attach TEST PR.

Ruling: no extra design confirmation or worktree is needed in this dedicated cloud checkout; the user and AGENTS.md expressly authorise direct execution on a new branch. No broad suite is required by applicable AGENTS.md, and the user limits complete-suite runs to that condition.

Completion: targeted checks and paired baseline comparison recorded in docs/investigations/fixed-v3-stage2e-reconstruction-2026-11-04.md. Dedicated SOS-light validation was additionally archived and guarded after tracing its separate direct-byte APPLY route. Read-only reviewer findings were resolved. Delivery uses the explicitly requested TEST branch/commit/push/PR path; no merge or deployment.
