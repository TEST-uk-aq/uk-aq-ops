# Stage 2E: selected-format-aware fixed-v3 reconstruction

## Result and boundaries

Based on TEST Ops `dd068f931ecfc944a761a59fc7a6c28049397c1b` (merged #173, including #170/#172). Current authoritative exact-only/gate amendments were read from TEST system-docs `bc8af78459085211b8e14f3e37636f990c615f61`; the local authoritative documentation tree was not edited.

**This is compatible recognition and read-only preparation, not operational schema-2 repair.** Existing selected schema-1 reconstruction retains its builder, exact bytes and aligned dependencies. A newly absent canonical scope receives schema 1 only after the pinned ancestor chain proves absence. Selected schema 2 is never sent to the default schema-1 builder. Mixed schema-1/schema-2 metadata can be reconciled without adding aligned dependencies to a schema-2 selector.

The normal offline proposal child cannot currently obtain the direct verifier's authenticated current-object/ETag and continuously held-operation adapters. Its ordinary Dropbox baseline also does not contain bulk selected selectors/leaves. Consequently, any **affected schema-2 scope** blocks that planner, including full fallback and selected schema-2 removal. The planner does not manufacture publication-eligible metadata or silently choose another format. An unchanged schema-2 scope may remain a separately identified retained compact-latest root while schema-1 scopes are prepared; this does not grant mixed-format repair execution authority.

## Active files changed

- `scripts/backup_r2/uk_aq_plan_sos_light_v3_observation_metadata.mjs`: explicit scope-format resolution, retained format authority during summary fallback, pinned canonical-root/checkpoint equality, new-scope absence proof, schema-2 preparation/removal blockers, per-selector selected-format/predecessor metadata and final plan audit.
- `workers/shared/uk_aq_observation_history_exact_only_verifier_v3.mjs`: `reconstructObservationHistoryExactOnlyScopeV3()`, a read-only existing-schema-2 preparation helper using fresh independent inspection and current identity rechecks.
- `scripts/backup_r2/lib/observation_history_migration_v3.mjs`: the schema-1 legacy v3 repack/recovery inventory rejects schema 2/unknown or missing authority, checks complete canonical scope coverage, and authenticates actual selected selector bytes against latest before permitting its existing schema-1 path.
- `scripts/backup_r2/lib/observation_history_integrity_writer_v3.mjs`: rejects schema-2/unknown selector payloads before legacy Integrity/SOS source loading.
- `scripts/backup_r2/lib/sos_light_v3_proposal_validation.mjs`: the separate direct frozen-byte SOS-light APPLY route also rejects schema-2/unknown selectors before complete-day deletion admission.

Tests: one existing planner test file updated for the explicit-format interface and fail-closed unauthenticated-latest behavior; two targeted reconstruction test files added. Five exact pre-change code copies are under `archive/2026-11-04/`, retaining original relative paths. The implementation plan is under `docs/superpowers/plans/`.

## Format and authority behavior

| Input/path | Result |
| --- | --- |
| Authenticated selected schema 1 | Same schema-1 builder/bytes and exact/aligned dependencies |
| New canonical scope | Schema 1 after pinned root/year/month/day/connector membership proves absence |
| Missing/corrupt checkpoint compact latest | Block; canonical observations alone do not establish exact-index format |
| Existing canonical scope absent from selected registry | Block; never relabel as new |
| Valid registry with unusable canonical summary fast path | Full reconstruction can retain authenticated per-scope format identities; unknown/affected schema 2 still blocks |
| Existing schema 2, fresh current canonical and physical adapters, complete selector/leaves | Read-only schema-2 reconstruction preparation reproduces exact immutable identities |
| Mixed prepared hierarchies | Latest retains each scope's explicit format; dependencies stay separate |
| Changed canonical schema-2 repair/repack or removal | Deliberately blocked in the operational/offline planner and legacy execution routes |
| Deliberate schema-1 → schema-2 conversion | Not implemented |

The read-only helper authenticates **actual current latest**, the selected selector body/size/SHA, and the complete current root/year/month/day/connector/pollutant chain, including aliases and file membership. It checks accepted explicit effective hash version, writer/schema/profile, complete series/file/group/segment/row totals and actual pinned Parquet bytes. It calls the accepted independent `canonical-aligned-offline-v1` inspector; no old emitter metadata, copied proof or previous invocation's in-memory proof replaces that inspection.

Supported capability remains **physical schema 3, `parquet-wasm-zstd-v3`, observation hash v1, `timeseries-aligned-v2`, `hyparquet-direct-column-v1`**. Schema 4, unsupported hashes/profiles, absent files/leaves, changed selectors, conflicting immutable bytes or lost exclusion fail closed. A reconstructed selector and all immutable leaf keys/SHA/size must exactly reproduce the existing selection; existing pinned file ETags are preserved and checked.

The helper returns explicit selected format and canonical-source binding with `publication_eligible: false` and `observation_event_created: false`. It returns no usable publication/Prune completion capability and performs no PUT/DELETE, PENDING upload, CONFIRMED event or JSONgen registration. The existing schema-2 direct builder/validators are reused.

## Publication prerequisites intentionally outstanding

No repair publisher or recovery mode was connected. A later authorised integration must provide the original held global observations-operation exclusion; freshly authenticated canonical and physical objects; current selected predecessor/strong ETag; immutable create-or-exact-reuse with no different-byte overwrite; supported conditional selector writes; uncertain-write exact readback; and complete canonical parent/root/latest finalisation before success.

**Canonical root equality proves observation content currentness, not current derived-index selection.** An index-only selector change can leave that root unchanged. Checkpoint compact latest is pinned planning evidence, not a substitute for current predecessor/format verification at a future selector replacement. A partial selector/latest switch or superseded/unknown authority must remain blocked. The new read-only helper checks current latest and actual selector and therefore rejects such disagreement.

Normal Prune schema-1 production, `OBSERVATION_HISTORY_EXACT_ONLY_PUBLICATION_ACTIVE_V3 = false`, Prune pre-READY rejection, candidate/gate/outbox COMMIT, atomic source deletion, original-session loss handling and managed JSONgen restrictions are unchanged. Stage 2D cross-invocation Prune recovery remains unsupported. No Station History or JSONgen physical-inspection change was made. No historical aligned/schema-1 objects or immutable revisions were deleted or retired.

## Backup/restore acceptance prerequisites

`build_backup_inventory.mjs` and `restore_history_from_dropbox.mjs` were inspected; neither changed. Ordinary backup continues to exclude the bulk exact-index tree and retain the compact latest summary. Canonical baseline manifests/Parquet plus authenticated current-run overlays can supply canonical reconstruction input and physical bytes; compact latest supplies pinned per-scope format/selector identities.

They do **not** automatically supply the actual selected schema-2 selector/leaf bytes or current object/ETag/held-operation authority consumed by this preparation helper. Missing required identities, immutable leaves, canonical bodies or supported physical capability remain explicit blockers. No automatic full index backup, new transport or broad restore executor was added.

Before schema-2 backup reconstruction is accepted, establish an approved source for missing selected identities/immutable bytes (or separately accepted reconstruction authority), connect the offline pinned-source inspector safely without inventing current-object identities, prove complete mixed-format round trips and failure/interruption behavior, and satisfy existing checkpoint/currentness, independent Core/binding/status and finalisation contracts. The existing generic restore utility remains incomplete system-wide recovery authority; packed binding restore acceptance is separate.

## Validation and baseline comparison

Node `v24.19.0`. Every check used local serialized-Parquet fixtures, synthetic configuration and injected local adapters. No PostgreSQL, R2, Cloudflare, Dropbox or LIVE service was accessed; GitHub fetch/push/PR are delivery only.

- **76 focused checks passed** across the planner/reconstruction, schema-1 writer, dormant lifecycle, independent consumer/completion and static backfill boundary checks, excluding the separately compared transport file below. This includes 15 checks in the two new reconstruction files.
- Five changed implementation files passed syntax and bounded import checks. All five dated code archives exactly match `git show dd068f93:<path>`. `git diff --check` passed.
- Existing migration tests: **20 pass / 71 fail** on both branch and unchanged `dd068f93` (91 counted assertions, including nested subtests).
- Existing Integrity writer tests: **10 pass / 1 fail** on both. The failure expects `immutable source evidence` while the existing error says `immutable_source evidence`.
- Existing proposal-transport tests: **15 pass / 9 fail** on both. All nine fail at existing generic fixed-v3 preserved-source authority admission.
- Across those three files, all **81 failure names** and **87 TAP error headers** match unchanged main. No newly failing name/header was observed. This comparison does not claim identical complete assertion state or a green suite. Migration failures include retired writer-freeze file references, existing progress/ETA expectations and clean-reviewed-source admission failures.

The root `AGENTS.md` requires narrow structural/deterministic checks and does not require the complete Node suite. Accordingly, no complete suite was run. The Stage 2D 82-pass/47-fail *test-file-process* report remains historical context; these task-specific assertion counts are not a new full-suite comparison. No Python changed, so no Python suite ran.

Exact principal commands (all with local fixture configuration):

```sh
node --import ./tests/jsongen_test_environment.mjs --test --test-isolation=none --test-reporter=tap \
  scripts/backup_r2/tests/uk_aq_plan_sos_light_v3_observation_metadata.test.mjs \
  scripts/backup_r2/tests/uk_aq_selected_format_reconstruction_v3.test.mjs \
  tests/uk_aq_exact_only_reconstruction_v3.test.mjs \
  tests/uk_aq_observation_history_exact_leaf_writer_contract.test.mjs \
  tests/uk_aq_prune_exact_only_lifecycle.test.mjs \
  tests/jsongen_prune_exact_only_completion.test.mjs \
  tests/jsongen_prune_exact_only_integration.test.mjs \
  scripts/backup_r2/tests/uk_aq_sos_light_v3_proposal_transport.test.mjs \
  tests/sos_light_v3_backfill_boundary.test.mjs
# 91 pass / 9 baseline failures (the transport file accounts for 15 pass / 9 fail)

node --import ./tests/jsongen_test_environment.mjs --test --test-isolation=none --test-reporter=tap \
  tests/uk_aq_observation_history_migration_v3.test.mjs \
  tests/uk_aq_observation_history_integrity_writer_v3.test.mjs
# 30 pass / 72 baseline failures
```

The three failing files were also run separately with the same options and shared dependencies in a clean detached `dd068f93` worktree. TAP output and comparison evidence are in the task workspace at `/workspace/work/stage2e/`. A separate read-only code review identified the migration membership/selector gap; the fix and focused rejection/unchanged-schema-1 checks are included.

## Chat-mode documentation handover and next gates

Update the authoritative exact-only and reconstruction/repair status to **selected-format recognition plus fresh-proof read-only schema-2 preparation implemented in TEST code; operational schema-2 repair/reconstruction/removal remains blocked**. Record missing offline current-selector/physical-adapter integration, retained selector/leaf availability and incomplete generic restore acceptance separately. No schema, environment variable, deployment or backup-policy change is required by this PR.

After separate authorisation, deploy compatible consumers before any schema-2 publication; validate reader/cursor/cache and CPU limits, currentness/freshness, supported writers, source correction/repack/removal, independent physical schemas, backup reconstruction and immutable selector/finalisation failure cases through real TEST operations. Physical schema 4 and cross-invocation Prune recovery need their own supported authority/capability decisions. Managed JSONgen monthly publishing and LIVE remain independent gates.

There are no apply/deploy/run commands to execute for this delivery. Review/merge and any deployment remain separate user decisions. Rollback is a code revert to the pre-change versions; archive copies are reference only and must never execute. Reverting also removes the new fail-closed reconstruction guards, so it is not permission to operate against selected schema-2 scopes.
