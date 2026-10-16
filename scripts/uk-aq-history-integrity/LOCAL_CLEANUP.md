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
