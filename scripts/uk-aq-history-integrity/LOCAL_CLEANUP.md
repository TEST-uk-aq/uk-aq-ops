# Active v3 local working-file cleanup

This implementation prevents eligible working copies from accumulating. The
approximately 60 GB manually removed from TEST/LIVE tmp directories establishes
the priority; it does not establish a breakdown by file category. The 398 MiB
TEST / 431 MiB LIVE measurements were taken after that removal. SQLite has
virtually no unused pages, and SQLite optimisation, shared source-cache redesign
and R2 generation retirement are outside this change.

## Execution paths and authority

At Ops main `982c094aca0fdc5b2255d9688669e257f93e7350`, both normal
`deploy-bin/integrity-run-monthly-{TEST,LIVE}.sh` scripts invoke the deployed
`uk-aq-history-integrity-sos-light-local-wrapper-v3.sh`. That dispatcher reads
`<LOCAL_ROOT>/env/{TEST,LIVE}.env`, selects `UK_AQ_OPS_REPO_ROOT`, and invokes
`bin/uk-aq-history-integrity-sos-light-v3.sh` in the selected repository. The
runner loads that repository's `.env` and invokes the v3 Python coordinator.
SOS historical replacement and generic WAQN/SAQN processing share that active
coordinator. The canonical manifest format still uses some v2 names; those
names do not imply execution of the fixed-v2 coordinator.

Stable monthly scripts select the separate stable v3 wrapper/frozen tree.
Fixed-v2 and frozen stable implementations are unchanged. This PR modifies only
the TEST-owned active v3 coordinator and normal TEST monthly script. It neither
updates the deployed wrappers/monthly scripts nor changes a LIVE repository.
Installed Mac selectors, wrapper revisions and LaunchAgent/manual invocations
cannot be established from this checkout. Before deployment, compare those
paths and revisions read-only; do not infer installation from repository routing.

Authority: current TEST system-docs `r2_history/integrity.md`,
`sos_light_three_phase_authority_contract.md`,
`proposal_run_state_transition_contract.md`,
`integrity_apply_progress_persistence_contract.md`,
`integrity_preflight_generation_and_journal_completion_contract.md`,
`sos_run_scoped_source_acquisition_contract.md`,
`official_network_rdata_historical_integrity_contract.md`,
`history_integrity_monthly_operator_runbook.md` and the routed backup contracts.

## File lifetimes and eligibility

| File category | Final consumer / disposal boundary | Behaviour |
| --- | --- | --- |
| `overlay/generated-objects/<v3 observation or index key>` | `_capture_local_v2_observation_scope`, after source/Parquet equality and canonical-copy validation | Unlink only if SHA-256 and byte count equal the distinct, still-present validated canonical staged body. The Node worker writes these generated files; later planning/APPLY/verification read canonical staged paths. |
| Matching `overlay/detector-source-evidence/generated-objects/<key>` | Detector has exited; independent source persistence and proposal/capture validation have finished | Same exact-copy check. Different serialisations and unregistered files remain. |
| `overlay[/detector-source-evidence]/official-rdata-input/{waqn,saqn}-DAY-connector-ID.json` | Synchronous official proposal subprocess returns valid successful output | Retain complete original bytes as verified gzip evidence, then unlink the working input. A handled helper failure may retire its input at the later scope boundary; unexpected exceptions retain it. |
| Detector `day_utc=DAY/connector_id=ID/{source-evidence,obs_history_rows,preserved_baseline_rows}.json` | Both workers returned and agreement/guard handling has finished; all-unmapped scope finishes after independent evidence handling | Retain complete original bytes as verified gzip evidence, then unlink working inputs. This also preserves rejected/failed evidence and all diagnostics. |
| Completed dedicated SOS `sos-source-cache/` acquisition | Detector and proposal workers consume individual partitions; later normal consumers use retained source evidence | **Preserved in full.** The authoritative acquisition contract requires the completed root to reject mutation/replacement. Partition disposal requires an explicit contract amendment, even after its final reader. |
| Final canonical bodies in `run_state.objects` | Final verification, current-state reconciliation, report completion, then exact monthly backup/materialisation acceptance | Only proposed, structurally validated, `r2_verified=true` bodies at exact `overlay/<v3 observation/index key>` paths enter the new completion record. Normal TEST monthly orchestration disposes of them after `.ok` and matching receipts. |
| Proposal artifacts, source authority files, journals, deletion sidecars, core/registry/bridge snapshots, run state, recovery state, reports, monthly receipts/logs, verification-view links | Audit/recovery and orchestration references outlive processing | Preserved. No broad directory removal, including the former generated-root/view `rmtree(ignore_errors=True)`, is added or used by this cleanup. |

Main proposal source evidence under `overlay/day_utc=.../connector_id=...`
remains at its original paths. Dedicated per-pollutant copies under
`overlay/source-evidence/` remain available to APPLY and the later current-state
reader. Immutable SQLite source evidence/canonical rows, native RData downloads,
annual SOS CSVs and shared caches remain untouched. Binding packs and all
unrecognised files are excluded from final staging disposal.

The gzip evidence lives at
`cleanup-evidence/<original-run-relative-path>.<sha256>.gz`. Its decompressed
SHA-256 and byte count are checked before unlink, and original evidence JSON,
hashes and manifests are never rewritten. The append-only receipt records the
mapping, so an auditor can recover exact working-input bytes in a separate
inspection location. A gzip file left incomplete by interruption blocks disposal
on retry; it is not silently overwritten. This is evidence retention, not a new
replay/resume facility.

### Follow-up consumer trace (PR #106)

The active v3 paths were reviewed against system-docs main
`c6d2ed60cf33c379ceecfc0e1ebae581bb92014e`; the relevant Integrity contracts
are unchanged from the initial review. These are the producer/reader boundaries,
including the distinction between working and authoritative source evidence:

| Retired working file | Producer | Readers and final consumer |
| --- | --- | --- |
| `official-rdata-input/*.json`, under either proposal or detector root | Python `_prepare_official_rdata_proposal` serialises pinned source rows, preservation inputs and acquisition audit | `official_network_rdata_proposal.mjs` reads it once at entry, then writes separate source/proposal outputs. `subprocess.run` waits for the entire helper and both output pipes. Retirement follows successful JSON-result validation. There is no subsequent input-path reader in planner, APPLY, verification or reconciliation. A handled helper failure retains complete rejected input until the later scope boundary; an escaping exception leaves the original. |
| Detector `source-evidence.json` | SOS `run_job.ts` evidence-only worker, or official RData proposal helper | Python `_load_complete_connector_day_source_evidence` validates it; `_persist_complete_connector_day_source_evidence` commits immutable SQL evidence; dedicated SOS additionally copies it through `_retain_dedicated_sos_partition_source_evidence`. Proposal agreement consumes the loaded detector dictionary. Final consumer is scope agreement/guard handling, or retained-evidence handling for all-unmapped SOS. |
| Detector `obs_history_rows.json` | Same workers/helpers | The same loader authenticates row bytes and semantic counts, and SQLite stores canonical rows. Dedicated SOS copies the original bytes to per-pollutant authority first. No later operation opens the detector pathname. |
| Detector `preserved_baseline_rows.json` | Official RData helper for preservation scopes | The detector loader verifies its SHA/length and validates complete final-target preservation. Later authority uses the **separate main proposal** copy at `overlay/day_utc=.../connector_id=.../preserved_baseline_rows.json`. That main copy is excluded from retirement. |

Later generic APPLY uses `sourceEvidencePaths` / `loadImmutableSourcePartition`
and the official preservation validator on the main proposal directory. Dedicated
SOS APPLY uses `source_evidence_partitions` at the retained per-pollutant paths.
Generic frozen-authority validation also reloads the main proposal evidence.
First-value reconciliation uses the exact persisted SQLite evidence ID;
dedicated current-state reconciliation reads the retained per-pollutant files.
Generic final verification reads canonical staged bodies and mutation evidence;
dedicated final verification uses ordered-APPLY evidence and retained source
authority. None needs an original compressed working-file pathname.

Recovery remains a new appropriately scoped run, not a replay of detector inputs.
Exact compressed bytes plus SHA/length/path receipts preserve all working
diagnostics without replacing the required SQL identity, pinned raw acquisition,
proposal source authority or mutation journals. Handled failures and dry-runs
retain those authorities and complete diagnostic input bytes. The compression
allowlist does not include main proposal evidence or immutable SOS acquisition.

## Completion, failures and concurrency

Cleanup metadata occupies the top-level `cleanup` field, outside the explicit
Python/JavaScript frozen-state fingerprint projections. Phase updates use the
existing `write_run_state` and its persistence-write accounting. Object identities,
source identities, authenticated proposal bytes and journal chains are unchanged.
The completion record includes the existing transition fingerprint, exact report,
environment, source, date range, run ID and staged-body identities.

Phase disposal happens inside the existing coordinator lifetime and operation
exclusion. Subprocesses have returned and pipe-draining threads have joined
before their file consumers are considered finished. No active v3 asynchronous
JSONgen consumer is installed at the retired handover marker. Adding any future
consumer must extend the relevant lifetime before enabling disposal.

Handled failures and dry-runs may lose proven generated duplicates and retired
working inputs whose complete compressed evidence survives. Their canonical
staging and recovery evidence remain. An unexpected interruption has no blanket
cleanup handler. Process termination or a terminal status never grants deletion
authority. Historical runs lack the new completion record and are refused.

The monthly helper independently validates the `.ok` marker, Integrity success
receipt/log/report, real non-dry-run status, new matching run-state completion,
v3 generation, backup success, exact caller/workflow IDs, `reuse_matching` mode,
checkpoint key and expected/observed materialisation hashes. It takes a per-run
cleanup lock and revalidates. Every body is authenticated again immediately
before its individual unlink. Directory handles are pinned without following
symlinks, hard-linked/non-regular files are refused, and identity changes block
disposal. No remote operation or database access occurs in the helper.

Final body disposal is conservative: no removal immediately after PUT. Normal
R2-to-Dropbox backup and materialisation do not read Integrity staged bodies, but
this initial implementation waits for their existing accepted outcome. Derived
index bodies do not become an expanded Dropbox backup obligation. Failed
backup/materialisation leaves staging pending. Monthly retries of an already
accepted month retry cleanup only; they do not rerun Integrity. Cleanup failures
are logged and never invalidate a legitimately accepted month.

Non-monthly/manual runs keep final staging pending until a matching accepted
monthly chain is available. There is no age-based migration of old runs, daily
sweeper, scheduled installation, or automatic adoption of legacy evidence.

NI is a reserved monthly source name, not an implemented Integrity source. The
monthly cleanup function now returns an explicit `CLEANUP SKIPPED source=ni`
before invoking Python. The helper continues to accept only SOS, WAQN and SAQN;
NI file lifetimes and cleanup authority must be designed with NI Integrity.

### Completion-field compatibility

`stage_overlay_object` and `stage_file_backed_proposal_object` initially record
`proposed=true`, `structurally_validated=false`, exact `local_path`, SHA and length,
and `r2_verified=false`. Validation sets `structurally_validated=true`. SOS-light
complete-day baseline assembly creates equivalent canonical entries and validates
their staged content. These fields are not inferred by cleanup.

Dedicated SOS uses `runPersistedSosLightV3Apply`; its tracked post-PUT GET validates
SHA/length and updates the original `operation.entry` with `r2_verified=true`
and exact identities, including verified skipped-unchanged PUTs. Generic WAQN/SAQN
uses `applyValidatedGenericV3Proposal` and the shared `applyValidatedProposal`;
`putAndVerify` updates the original entry after GET verification. Their complete
state writers retain these object fields and the unrelated cleanup metadata.
Python then reloads the child-written state, performs final verification and
reconciliation, and writes `coordinator.status=succeeded` plus the final result.

The completion list contains every **eligible registered** object; it is not an
inventory of every file under the run. It excludes unverified, non-proposed,
unrecognised or noncanonical bodies. A missing completion, malformed identity or
path mismatch blocks disposal rather than weakening the gate. Proposed flags
must be actual booleans, and recorded SHA/length must have valid types.

Normal successful SOS and WAQN/SAQN monthly repairs can therefore satisfy the
same cleanup gates. No source-specific relaxation or new v2 path is required.
The report's completion list must exactly equal the persisted run-state list,
which is recomputed from the unchanged object entries before each cleanup retry.
Failed, dry-run, noop-without-freeze or otherwise unproven runs remain ineligible.

### Cleanup-only I/O failure corrections

Optional cleanup checkpoints now use `persist_cleanup_state`. On failure they
report an error and restore the normal writer's attempted persistence-counter
increments; required proposal/APPLY/verification checkpoints still fail closed.
The original authenticated fingerprint projections and normal state writer are
unchanged. Missing persisted completion keeps final staging ineligible.

The optional post-cleanup report refresh writes exclusive temporary files and
flushes them before replacing the completed reports, publishing JSON last.
Rendering/write failures leave the previously completed JSON intact; failures
are logged without reversing a verified repair. A report/completion mismatch
retains staging for review. The required initial report write is still required
for normal Integrity completion.

Absent-file receipt failures during deferred retries are caught and reported
without being counted as deletions. A receipt with a torn trailing record blocks
further receipt writes/unlinks until reviewed; it is never automatically repaired.
An actual unlink remains counted even if its result receipt fails. An unrecorded
or uncertain historical outcome is not retrospectively counted as a new deletion.
Partial gzip output is now included in evidence-byte accounting, marked incomplete
and retained with its original; only a fully verified evidence copy permits unlink.
If its length cannot be measured, accounting marks that uncertainty and reports
net bytes released as unknown rather than claiming a numeric saving.

## Accounting and limits

`cleanup-receipts.jsonl` records durable per-file intent, evidence creation,
successful unlinks, absent files, mismatches and errors with UTC timestamps.
Phase totals appear in run state and JSON reports. Deferred cleanup prints totals
for that invocation to the monthly summary and appends to the same receipt;
it does not rewrite the accepted report or completed run state. Retries do not
count already-absent files as deletions. Receipt-write failures are also surfaced.

`bytes_removed` is the sum of file lengths actually unlinked;
`evidence_bytes_written` counts new compressed evidence lengths;
`net_bytes_released` is their difference. These are logical byte counts, not a
measurement of APFS physical free-space changes. Compression temporarily needs
space for the original plus one compressed evidence file before unlink. Actual
peak usage also includes immutable acquisition, required evidence, complete-day
baseline copies, the frozen final body set and any pending unaccepted runs.
No numeric per-operation peak can be derived from the historical 60 GB total.
Completed scratch plus new working files can still exhaust disk if intentionally
preserved evidence/pending staging grows; this bounded PR is not a disk quota.

Historical accumulation plausibly includes repeated generated/canonical copies,
detector/proposal row JSON, official helper inputs, full acquisition datasets,
complete-day preserved baseline bodies and failed/dry-run staging. Existing
success-only cleanup removed just generated bodies/view links, ignored errors,
and left other staging/evidence. The historical total cannot identify their
individual shares. Manual pre-13 October deletion may have removed source evidence,
journals or paths referenced by audit/recovery records. This PR neither certifies
those deletions safe nor reconstructs the missing evidence.

The expected benefit is bounded, and these categories remain distinct:

| Category | Disk-space effect / remaining growth |
| --- | --- |
| Authenticated generated duplicates | Exact copies are removed at capture and retried after successful repair; no duplicate-removal claim for mismatches or unregistered files. |
| Redundant detector/proposal JSON | Original working representations are retired; compressed complete evidence remains and may continue to grow. Failed compression can retain both original and partial output. |
| Final staged canonical bodies | Eligible registered v3 bodies are removed after exact monthly acceptance. Failed backup/materialisation or mismatched/missing evidence leaves them pending. |
| Completed SOS acquisition partitions | Preserved in full under the immutable-root contract; potentially substantial. Disposal requires an authoritative amendment, not an implementation shortcut. |
| Failed/interrupted-run working data | Earlier proven duplicates may already be gone; canonical staging, unprocessed inputs, failed acquisitions, journals and required evidence remain. No terminal-status sweep. |
| Standalone/non-monthly runs | Final bodies remain pending without a matching accepted monthly chain. A general backup-linked disposal owner would be separate follow-up. |
| Required immutable/audit evidence | Source authority, SQL records, raw downloads, journals, snapshots, reports and receipts remain. No retention period is invented here. |

Unregistered generated files and detector bodies with different serialisations
may also remain. Their sizes cannot be inferred from the historical total.
The review found no additional large category that could be removed safely by
loosening existing gates. Acquisition disposal, broad failed-run retention,
non-monthly backup integration and evidence compaction need separate authority or
design. This PR reduces eligible working-copy accumulation; it does not eliminate
all future tmp growth or establish a numeric saving from the deleted 60 GB.

## Validation, acceptance and rollback

Before deployment: syntax parsing, unchanged fingerprint/state-writer checks,
archive equality, protected-tree diff review and a small in-memory deletion
eligibility/intent check with mocked unlink. No Integrity run, real cleanup,
functional fixture suite or TEST/LIVE operation is part of this PR.

After a separately authorised deployment, accept through real TEST operations:
observe phase receipts on the intended source repair, retained source/journals,
unchanged final verification/current-state results, deferred staging while backup
is pending, and staging disposal after the exact accepted monthly chain. Inspect
dry-run/handled-failure evidence on real authorised operations, and verify an
accepted-month retry reports absent files without duplicate deletion counts.
Observe the same gates on successful real SOS and WAQN/SAQN operations: recorded
proposed/validation/verification fields, matching state/report completion lists,
eligible body counts and post-acceptance receipts. Confirm the main proposal
preserved-baseline file, retained SOS evidence and SQLite evidence IDs remain
usable through final verification and reconciliation. Inspect naturally occurring
cleanup failures separately from repair/backup outcomes; do not deliberately
damage evidence or exhaust disk to perform acceptance. NI must never invoke the
cleanup helper or produce an unsupported-source cleanup warning.
Deployment must explicitly update the normal TEST monthly script copy; changing
its repository template alone does not install the new acceptance hook.

Rollback is a code revert/redeployment under separate authorisation. It does not
restore deleted duplicates: retained canonical copies or accepted R2/backup state
provide their content; gzip evidence preserves retired working inputs. Dated
pre-change code archives are reference-only and never active fallbacks.

System-doc handover for ChatGPT in Chat mode: document these cleanup receipts,
compressed working-evidence representation, final-consumer boundaries and the
conservative accepted-month staging gate. No schema, secret, environment-variable
or R2 lifecycle change is required. A later acquisition-disposal amendment must
explicitly resolve completed-root immutability and preserve source diagnostics
before implementation; this PR leaves that contract and root unchanged.
