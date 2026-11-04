# Stage 2F offline reconstruction implementation plan

> **For agentic workers:** Use superpowers:executing-plans for inline implementation and one final independent review.

**Goal:** Prepare exact selected-format index bytes from accepted offline canonical backup and repair inputs, without admitting publication.

**Architecture:** Reuse the direct verifier's canonical hierarchy and independent physical inspector through a separate local-byte context that has no ETag, held-operation assertion or publication proof. Connect it to the existing fixed-v3 checkpoint/local-store interfaces through an explicitly preparation-only entry point. Authenticate the baseline selector by deterministic byte identity before preparing any changed overlay identity.

**Tech Stack:** Node ESM, existing canonical/index builders and Parquet inspector.

**Spec:** User's Stage 2F request; authoritative exact-only, SOS-light three-phase and backup contracts; Stage 2E investigation report.

## Global constraints

- TEST code only, based on `a77c9a96cc239c48762f67312a27439e2bf554b1` (current main).
- No authoritative system-doc edits, remote operations, publication, conversion, APPLY or new backup payload.
- Schema 3 / writer v3 / hash v1 / accepted direct-column profile only.
- Keep schema-1 bytes and aligned dependencies; schema 2 has direct canonical dependencies.
- Existing dated archives are reused; never overwrite them or execute archive code.
- Repository/user narrow validation requirements supersede generic skill full-suite/approval defaults.

## Design and approach

The supported subset is a scope whose complete pinned canonical hierarchy and actual files reconstruct a selector with exactly the checkpoint-selected key/size/SHA. That identity commits the full leaf map, so retained leaf bodies are unnecessary for this subset. Optional historical leaf fields (such as R2 ETags) or unsupported emitter/profile differences may prevent reproduction: report the mismatch and missing original bodies, never guess them. Reusing the operational verifier with fake local ETags/lock assertions is rejected. Expanding backup retention is outside scope.

For changed overlays, independently authenticate the original baseline first, then authenticate every consumed staged byte against current-run state and the complete proposed hierarchy. Reuse immutable source-evidence loading and compare its final target semantic metadata with the independently inspected proposed canonical content. Distinguish prior selected identity from prepared identity. A local store that hides required original bytes under tombstones cannot prove the baseline and must block; callers must supply an unmasked pinned baseline store separately from the overlay store.

The API returns bounded per-scope results, no global latest or executable write plan. Existing mixed-format latest builders remain usable for separate local reconciliation. Operational schema-2 reconstruction/removal and repair APPLY remain blocked.

## Review focus

- Checkpoint previous selection must never become current selector/strong-ETag authority.
- Caller metadata and stale overlay SHA must not replace hashing actual bytes.
- Required baseline bytes must not be silently substituted with changed overlay bytes.
- Unknown selected semantic fields must fail exact identity reproduction.
- Local mutation during inspection must fail rechecks; results mint no operational proof.

### Task 1: Offline physical reconstruction and accepted-source adapter

**Files:**
- Modify `workers/shared/uk_aq_observation_history_exact_only_verifier_v3.mjs`.
- Modify `scripts/backup_r2/uk_aq_plan_sos_light_v3_observation_metadata.mjs`.
- Create `scripts/backup_r2/tests/uk_aq_offline_reconstruction_v3.test.mjs`.

**Interfaces:**
- `prepareOfflineObservationHistoryScopeV3({scope, getObject, exactSchemaVersion})`: authenticates complete local canonical chain and actual files; returns deterministic hierarchy, canonical source/chain and inspected semantic metadata, with no physical proof handle.
- `prepareOfflineExactV3Reconstruction({runState, baselineStore, scopes, repairOverlay = null})`: consumes the accepted checkpoint, unmasked local baseline store, explicit finite scopes and optional `{store}` current-run overlay; returns preparation-only per-scope prior/prepared identities.

- [x] Write targeted checks for unchanged schema-2 reproduction without any retained derived bodies or operational authority, exact schema-1 bytes, changed-source provenance, mixed dependencies, missing/altered inputs, unsupported physical/profile authority, unprovable historical identities and mutation during inspection.
- [x] Run the new checks and observe the missing-interface failure.
- [x] Implement local-only reconstruction using existing chain/physical/builder functions; never register in the operational proof WeakMap.
- [x] Connect checkpoint and source-evidence authentication; preserve ordinary planner/APPLY rejection.
- [x] Run the new checks and directly relevant existing schema-1/schema-2/planner checks. Run syntax/import checks and `git diff --check`.

### Task 2: Evidence, review and delivery

**Files:** Create `docs/investigations/fixed-v3-stage2f-offline-reconstruction-2026-11-04.md`.

- [x] Record source evidence matrix, supported subset, identity limitations, independent domains and future APPLY/acceptance prerequisites.
- [x] Perform independent branch review; address material findings with targeted verification.
- Commit/push working branch and create a PR to TEST main; delivery identity is recorded in GitHub PR metadata. Do not merge/deploy.

## Execution ledger

Pre-flight: Task 2 consumes Task 1's actual interfaces and verification evidence; no conflicting interfaces. Implementation remains inline under the existing repository authorization.

Task 1: complete; 90/90 focused checks pass (14 new plus 76 existing), syntax/import/diff checks pass. Initial missing-function checks failed as expected. Source evidence is rechecked after preparation; its stale-source rejection was observed failing before the guard.

Final review: independent read-only reviewer found two P2 overlay issues. Fixed exact/prefix tombstone fallback and unchanged-record shadowing, each with observed failing checks followed by passing checks. Further actual-byte source-label and independently pinned source-evidence checks pass. No deferred minors.

Final ruling: remote checkpoint acceptance/currentness, live publication and real backup/restore acceptance remain unproved and separately gated, as required by the user. This interface consumes accepted prior offline authority only; treating it as operational authority would be unsafe, so every relevant eligibility flag is false and no operational proof handle exists.
