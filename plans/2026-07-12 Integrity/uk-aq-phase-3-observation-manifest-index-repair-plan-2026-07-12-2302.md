# UK-AQ Phase 3 Observation Manifest and Index Repair Plan

Generated: 12/07/2026 23:02 Europe/London

Plan filename:

```text
uk-aq-phase-3-observation-manifest-index-repair-plan-2026-07-12-2302.md
```

Expected repository location:

```text
plans/2026-07-12 Integrity/uk-aq-phase-3-observation-manifest-index-repair-plan-2026-07-12-2302.md
```

> Historical implementation record. Current history-integrity phase status is
> authoritative only in `uk-aq-v2-history-integrity-phased-plan.md`.

## Purpose

This plan prepares Phase 3 only: safe repair of observation manifest-only and index-only faults without rewriting valid observation parquet.

Phase 4 data repair and any AQI rebuild work remain out of scope.

Phase 2 implementation is committed on main across `7e1b352..4438499`. Local non-DuckDB validation completed with 249 tests passing and zero skips; `py_compile` passed; `git diff --check` passed. The runtime Python DuckDB dependency has now been installed separately on the test integrity machine, but no real integrity run is being performed in this planning task. Runtime Phase 2 validation remains pending until the integrity command is run. No Phase 3 write behaviour has been executed.

## Hard repository boundary

The only writable repository is:

```text
TEST-uk-aq/uk-aq-ops
```

Do not create, edit, rename, delete, format, generate, stage or otherwise modify any file in:

```text
uk-aq-ingest
TEST-uk-aq-ingest
uk-aq-schema
TEST-uk-aq-schema
the website repository
any sibling repository
any parent directory outside uk-aq-ops
```

The schema repository may be read only where an existing test requires canonical SQL.

Continue only on `main`.

## No commit, deploy or runtime-copy rule

Codex must not:

```text
commit
amend a commit
stage files
create a branch
switch branches
create a tag
push
open or update a pull request
deploy
apply SQL
copy files to the integrity machine
write to R2
mutate history data
begin Phase 4
```

All changes must remain uncommitted and unstaged for user review.

## Implementation decision

Use the existing Node writer and index helpers as the single authority.

Do not create a parallel Python writer contract.

If Phase 3 needs a single repair entrypoint, add only a narrow Node orchestration wrapper that composes the current helpers. Keep manifest hashing, payload shaping, skip-unchanged PUT logic and index composition in the current Node modules.

Current authoritative surfaces:

```text
workers/uk_aq_prune_daily/phase_b_history_r2.mjs
workers/shared/r2_sigv4.mjs
workers/shared/uk_aq_r2_history_index.mjs
scripts/backup_r2/uk_aq_rebuild_r2_day_manifest_from_connectors.mjs
scripts/backup_r2/uk_aq_build_v2_observations_from_dropbox_v1.mjs
scripts/backup_r2/uk_aq_build_r2_history_index.mjs
```

Current test anchors:

```text
scripts/uk-aq-history-integrity/tests/test_v2_phase2_validation.py
scripts/uk-aq-history-integrity/tests/test_v2_observations_integrity.py
scripts/uk-aq-history-integrity/tests/test_v2_aqilevels_integrity.py
scripts/uk-aq-history-integrity/tests/test_backup_gate_and_repair_plan.py
```

Representative current cases to preserve:

- `test_parent_connector_and_day_manifest_scopes_remain_separate`
- `test_manifest_only_repair_precedes_index_only_for_same_partition`
- `test_manifest_only_gap_remains_manifest_only_for_o3`
- `test_check_only_plan_shape_makes_no_writes_by_construction`
- `test_healthy_partition_is_ok`
- `test_missing_index_manifest`

## Phase status

| Phase | Name | Status | Notes |
| --- | --- | --- | --- |
| 3a | Writer contract and deterministic builders | In progress | The Phase B builders are exported for repair reuse; CIC-Test runtime dry-run remains pending. |
| 3b | Repair planning and dry-run orchestration | In progress | Narrow v2 observations plan input is implemented and mock-validated; runtime acceptance remains pending. |
| 3c | Explicitly gated R2 execution and verification | In progress | CIC-Test-only repair writes are explicit-gate protected; no real R2 verification has occurred. |

Allowed status values:

```text
Not started
In progress
Blocked
In progress
```

## Phase 3a: Writer contract and deterministic builders

### Goal

Lock down the observation writer contract so manifest and index repair always use the same deterministic Node builders.

### Scope

Confirm and reuse the following exports as the authoritative contract:

```text
buildHistoryV2PollutantManifestForTest
buildHistoryV2ConnectorManifestForTest
buildHistoryV2DayManifestForTest
buildObservationDayManifestFromConnectorManifests
buildAqilevelsDayManifestFromConnectorManifests
buildHistoryV2TimeseriesPollutantIndexPayload
buildHistoryV2TimeseriesMetadataIndexPayload
buildHistoryV2TimeseriesLatestPayload
buildDomainIndexPayload
rebuildR2HistoryIndexes
updateR2HistoryIndexesTargeted
buildAwsSignedRequest
r2PutObjectIfChanged
r2GetObject
r2HeadObject
r2ListAllObjects
r2PutObject
sha256Hex
```

Treat `workers/uk_aq_prune_daily/phase_b_history_r2.mjs` and `workers/shared/uk_aq_r2_history_index.mjs` as the source of truth for manifest payloads, hashes, ordering and index composition.

Do not port these builders into Python.

If a repair wrapper is needed, keep it orchestration-only and have it call the existing Node exports.

### Required tests

- manifest payload hash stability
- byte-stable manifest rebuilds
- preserved child ordering
- preserved valid siblings
- unchanged PUTs are skipped
- index payload stability
- read-only dry-run paths stay read only
- existing observations integrity cases remain green

### Acceptance criteria

- the repair flow uses one authoritative Node contract
- no duplicate writer implementation is introduced
- hashes and payloads remain deterministic
- skip-unchanged behavior is preserved

## Phase 3b: Repair planning and dry-run orchestration

### Goal

Build deterministic observation repair plans from real live-R2 children, not from parent declarations alone.

### Scope

Use a bottom-up repair order:

```text
pollutant manifest
-> connector manifest
-> day manifest
-> observation index
-> latest index
-> metadata
-> live-R2 verification
```

Preserve valid siblings when a single pollutant is repaired.

Deduplicate actions so one scope produces one final highest-priority repair result.

Keep repair planning read only by default.

Keep check-only and dry-run paths non-executing.

Keep AQI out of Phase 3.

Keep the existing action vocabulary stable where possible so Phase 2 precedence and dependent-AQI behavior do not regress.

### Required tests

- O3 manifest-only acceptance case
- no O3 parquet rewrite
- all siblings preserved
- connector rebuilt once
- day rebuilt once
- unchanged generated manifest skips PUT
- failed connector rebuild blocks day and index
- failed live verification marks repair failed
- check-only performs no writes
- dry-run performs no writes
- live-R2 verification uses fresh remote reads

### Acceptance criteria

- one unambiguous action result exists per repaired scope
- no contradictory repair actions remain for the same partition
- valid siblings are never dropped
- observation repairs stay separate from AQI work
- all non-write modes remain non-executing

## Phase 3c: Explicitly gated R2 execution and verification

### Goal

Allow observation manifest and index repair writes only behind an explicit execution gate, then verify the changed objects against live R2.

### Scope

Use the current Node R2 helpers for GET, HEAD, LIST and PUT operations.

Add or preserve an explicit write gate such as `--write-r2` in the repair entrypoint.

Do not let the repair flow call write-capable helpers when the gate is not set.

Use the existing write-capable index helpers directly rather than duplicating them in a second CLI or a Python wrapper.

Verify changed manifest and index objects immediately after write with fresh live reads.

Treat stale mirror state as insufficient proof of repair.

Report `planned`, `executing`, `skipped_unchanged`, `succeeded`, `failed` and `blocked_dependency` outcomes explicitly.

### Required tests

- write gate refuses non-test buckets
- dry-run remains read only
- write mode changes only approved keys
- unchanged object records `skipped_unchanged`
- live verification reads fresh remote state
- verification failure blocks downstream actions
- repair output separates planning, execution and verification

### Acceptance criteria

- no R2 write occurs without the explicit gate
- live verification proves the changed objects
- execution and verification are separately reported
- no AQI or source-data repair behavior is introduced in Phase 3

## Phase 3 validation commands

When Phase 3 is implemented, validate with:

```bash
python3 -m py_compile scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py
```

```bash
python3 -m unittest discover -s scripts/uk-aq-history-integrity/tests -p 'test_*.py' -q
```

```bash
npm run check
git diff --check
```

## Implementation record

Status:

```text
Complete
```

Completed work:

```text
Corrected the unsafe filtered day-manifest rebuild so a connector filter is only an assertion: all connector siblings are enumerated and retained. Exported the authoritative Phase B v2 manifest builders and added the narrow `uk_aq_execute_v2_observations_repair.mjs` executor, which accepts only v2 observations manifest/index repair actions, rejects AQI/data/operator actions, is dry-run by default, and refuses non-CIC-Test repair writes. The executor does not reconstruct pollutant manifests without complete parquet-derived metadata. The generic index builder remains explicitly gated but is no longer CIC-Test-only, preserving legitimate normal LIVE index rebuilds. The integrity wrapper adds `--write-r2` only after its dry-run exit.
```

Tests:

```text
Focused mocked Node validation passes include the authoritative writer contract, full day-manifest sibling repair checks, generic index write-gate checks, and the O3 parent-manifest/idempotence executor fixture. Python coverage verifies the integrity wrapper reaches its targeted index command only after dry-run exits. Full-suite validation remains recorded only after the final commands in this worktree complete.
```

Remaining issues:

```text
CIC-Test runtime dry-run is pending after manual runtime copy. CIC-Test real repair execution remains pending explicit user approval. LIVE repair execution is not enabled. Local mocked verification does not prove real R2 listing, object-identity, or post-write behavior.
```
