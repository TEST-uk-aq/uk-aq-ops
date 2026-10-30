# JSONgen Stage 3D Phase 2: Integrity v3 and SOS-light writer authority

Investigation and implementation handover, 30 October 2026. **Blocked for an
independent writer adapter; documentation only.** No implementation files changed.

## Decision and evidence boundary

Neither examined writer currently provides a demonstrated, durable, independently
authenticated final-source-to-JSONgen-bundle handover. Both have substantial
writer-internal source, proposal, semantic-verification and persistence machinery.
That machinery is valuable for implementing a writer-owned export; it is not a
portable original completion authority that JSONgen may reconstruct for itself.

Do not implement an adapter accepting a caller's final_verified flag, run-state
hash, journal chain, successful report, retained overlay, upload acknowledgement
or matching content hash as proof of the originating writer's completed invocation.
No adapter, completion endpoint, wire schema, scheduling or publication is added
by this change. The next bounded step is an Integrity-only writer-owned evidence
capture after the missing completion/retention contract is accepted.

Source baseline: TEST Ops main
`e5fe94fd63375d1bd86e7e356d11ed7593a40208`, including PR #148 merge
`aecfeaa58214519a7a539cdfc55b6772e7929192`.
The attached local checkout was older (`ea7212e8`). Git transport could not
connect to its configured proxy. Relevant current public sources were
therefore read at the pinned Ops commit through the GitHub connector; the PR branch
was created from the current remote main commit, not the old checkout.

No installed Mac runner or genuine run evidence was supplied in this workspace.
Repository code does not establish installed behaviour or survival of any
particular historical file. No TEST PostgreSQL, R2, Dropbox, Supabase or deployed
service was contacted.
Only TEST GitHub repository reads and the requested branch/document/PR writes
are part of this task.

The existing accepted Prune registrations and bootstrap candidates were left
unchanged, as requested. They do not establish Integrity/SOS-light handover
authority or complete writer coverage.

## Active implementation paths and existing authority

This repository handover contains findings supported by public Ops source and
the user's explicit task requirements. It does not reproduce private system-doc
text or historical operator evidence. References identify pinned active public
files and functions; proposed requirements are not new accepted contracts.

### Integrity v3: generic selected-scope mode

1. The repository local-wrapper template reads only
   `UK_AQ_OPS_REPO_ROOT` from its selected local TEST selector and executes the
   repository fixed-v3 shell. That shell fixes the generation and selects
   `uk-aq-history-integrity-sos-light-v3.py`, whose sibling implementation is
   [the fixed-v3 coordinator][I]. Generic Integrity and dedicated SOS-light share
   that coordinator. The older generic `uk-aq-history-integrity_impl.py` path
   named by `WRITER_SEAMS.integrity_v3` is stale as an active-v3 location; it must
   not guide a new adapter. Stable/frozen runners are separate operator choices.
2. The coordinator's apply dispatch chooses
   `uk_aq_apply_generic_v3_proposal.mjs` for
   `execution_path=generic_integrity` ([I], around line 27783).
   [The generic APPLY bridge][G] requires the existing global-lock context,
   explicit R2 configuration and coordinator freeze, then calls
   `applyValidatedProposal()` in [the shared APPLY implementation][A] with
   `generation=v3` and the generic validators from [V].
   The older disconnected writer adapters are not this active dispatch.
3. `loadImmutableSourcePartition()` ([A], line 1844) checks the
   `source-evidence.json` and `obs_history_rows.json` byte identities, complete
   enumeration, rows, counts and semantic hashes. For official RData it also
   checks `preserved_baseline_rows.json` and returns **finalTargetRows** and
   **finalTargetMetadata**. Source-only rows/hash are not the final target when
   authenticated unavailable windows require preservation.
4. `validateFinalProposalGraph()` and
   `validateFinalGenericV3ProposalGraph()` validate the frozen final target,
   selected outcomes, exact tombstones and parent/index dependency closure.
   Source-unavailable preservation is distinct from authenticated empty targets.
   `verifyLiveObservationPartition()` ([A], line 2500) binds the writer's normal
   live semantic readback to immutable source or, for official RData, the complete
   final-target metadata. That is the existing canonical verification, not a
   JSONgen verification opportunity.
5. `createApplyPersistence()` writes the hash-linked mutation journal and
   compact progress/checkpoints; dependency durability gates precede parent
   publication. `applyValidatedProposal()` finishes affected indexes and shared
   parent finalisation before `canonical_apply_successful_completion`
   ([A], line 3626). An APPLY checkpoint is still not final invocation VERIFY.
6. `run_v2_final_verification()` ([I], line 26693) checks the pinned core,
   rechecks the resolved local final view and requires the normal remote
   write/delete and persistence evidence. `_create_final_verification_view()`
   ([I], line 25700) creates a disposable **symlink** view of structurally
   validated overlay objects, explicit tombstones and the pinned Dropbox
   baseline. It does not seal final rows or create a durable standalone snapshot.
7. `run_v2_integrity_repair_flow()` selects this generic final verifier, then
   reaches the inactive JSONGEN marker ([I], line 30471), ahead of separate
   current-state reconciliation. The marker is a comment, not a success guard or
   export. Any future optional export must explicitly reject failed, blocked,
   dry-run, planned and no-change outcomes; merely inserting work after the
   comment would also encounter unsuccessful branches.

### SOS-light v3: dedicated complete-day mode

The same coordinator dispatches `execution_path=sos_light` to
[the dedicated APPLY bridge][S] and `runPersistedSosLightV3Apply()` in [P].

The coordinator and [S]/[P] implement Step 0 followed by source/baseline detection,
complete-day proposal, and APPLY/VERIFY of a frozen mutation set. The task requires
preserving that sequence; it does not authorise pre-APPLY live-R2 planning,
dependency discovery or an extra backup domain for JSONgen.

The complete-day proposal contains selected connector-1 source repairs **and**
preserved Dropbox-backed rows/objects, including unselected pollutants and other
connectors. [P] freezes child-before-parent day publication and the shared tail,
retains `apply.v3_publication_evidence`, mutation journal/progress and deletion
sidecars, and performs the existing readback/semantic verification. Exact removed
index scopes are separately admitted. A deleted object-key list describes
physical mutation, not the complete set of removed observation identities.

Crucially, dedicated final verification uses
`summarize_ordered_apply_verification()` ([I], line 29802), **not** the generic
`run_v2_final_verification()` called out by the older SOS seam description.
The summary validates the persisted ordered APPLY evidence; the coordinator also
performs applicable final pack-mode binding checks before reaching the marker.
It explicitly reports `second_broad_r2_scan_invoked=false`. Preserve that rule.

`verifyLiveObservationPartition()` returns early for dedicated pollutant
partitions without retained `source_evidence_partitions` ([A], line 2513).
Consequently source-semantic verification of selected SOS partitions is not a
blanket original-source certification of every preserved connector/pollutant in
the republished day. Warning-only preservation/omission of other-connector
content in the SOS implementation cannot be relabelled authoritative JSONgen
empty/removal or VERIFIED provenance.

### Cleanup and retention in both modes

Reports are written before `cleanup_successful_repair_overlay()`
([I], around line 35910). Current cleanup records completion and defers canonical
staged-body disposal to the exact accepted month/backup/materialisation chain.
It does not immediately delete the entire overlay on success.

[The cleanup implementation][L] preserves main immutable
source evidence, SOS acquisitions, journals, deletion sidecars, core/registry
snapshots, run state and diagnostics. Eligible detector/helper working JSON may
be losslessly compressed; registered canonical observation/index staging may
later be unlinked after matching monthly acceptance. Thus a standalone successful
run may retain staging, but **normal eventual cleanup does not guarantee the
complete final view remains readable forever**. The symlink view does not change
that lifetime. A mutable Dropbox mirror is not an immutable original final view.

### JSONgen interfaces that can and cannot be reused

- [writer-authentication.mjs][J] independently authenticates only admitted Prune
  inputs through an invocation-local authenticated handover. Integrity and
  SOS-light still return `reconciliation_required` with
  `authenticated=false`. Its two stale seam locations are findings, not
  permission to change report meanings in this task.
- [inputs.mjs][JI] validates immutable derived bytes, bounded decompression,
  complete scope records, row multiplicity and semantic hashes. It explicitly
  returns `writer_authenticated=false`; byte integrity is not writer origin.
- [prune-receipts.mjs][JR] `retainImmutable()` supplies conditional-create,
  exact readback and ambiguous-write handling. Reuse those storage semantics
  after genuine authority exists; it does not authenticate a writer.
- [prune-evidence-bundle.mjs][JB] supplies useful exact-byte/size/gzip limits,
  but its envelope, intent and decoder are expressly original AURN Prune
  structures. They cannot be relabelled as Integrity proof.
- [The original Prune consumer][JA] obtains origin through the restricted
  original PostgreSQL acceptance reader, private pending source and original
  retained metadata/binding/final hierarchy, using private WeakMap capabilities.
  An arbitrary local JSON object or hash cannot manufacture that capability.
  Integrity has no corresponding original committed acceptance in this path.
- [schema.mjs][JS] receipt v1 has generic reference fields but supplies no new
  trust root. Receipt v2 and selected receipt v3 bind original AURN Prune
  PostgreSQL authority and first-publication semantics. The
  [selected event descriptor][JE] is likewise Prune-specific. Replacement,
  authoritative-empty or a different writer must not be smuggled into them.
- [scope-authority.mjs][JD] projects already-authenticated exact physical
  metadata. [currentness.mjs][JC] requires authenticated original authority
  before comparing metadata or proving a before-to-after supersession link.
  Matching metadata, lock ownership, timestamps, receipt arrival or control CAS
  revision do not supply writer authority or chronology.
- [The current signer][JW] admits `prune_daily_v3` only at
  `POST /v1/upload-intents`; it has no Integrity completion-acceptance route.
  Reusing the Prune writer token/identity to upload an Integrity event would
  weaken the existing admission boundary.

## Evidence requirements: classification for each writer

A = already available and independently authenticatable.
B = available internally but missing a required binding or durability guarantee.
C = available only during the writer operation or a bounded staging lifetime.
D = unavailable or not demonstrated.

These classifications assess the **complete JSONgen authority requirement**,
not whether a local checksum can be recomputed. No A classification is claimed
for a genuine Integrity/SOS-light event in this investigation because no original
authenticated handover or installed-run evidence was available.

| Requirement | Integrity v3 | SOS-light v3 |
| --- | --- | --- |
| 1. Origin, invocation and final verified publication | **B/D.** Run ID, environment, transition fingerprint, APPLY evidence and final result exist in [I], [A], [V]. No independently authenticated original completion record binds them to a derived source. | **B/D.** [S], [P] and the ordered summary record invocation/proposal/publication results. No original completion acceptance makes that local audit independently authoritative. |
| 2. Complete physical connector/station/timeseries/pollutant/day change set | **B.** Selected scopes, final-target rows and manifests are available to the writer. No exported before/after union accounts for disappeared series, additions, preserved windows and every affected physical binding. Object keys/pollutant scopes alone are too coarse. | **B.** Complete-day frozen membership and prefix deletions exist, but selected SOS source membership is narrower than whole-day republication. No sealed physical inventory accounts for preserved, omitted and removed scopes across that day. |
| 3. Exact original/final observation identity, changed values, additions and removals | **B/C.** [A] preserves exact final source plus authenticated RData baseline rows and compares their semantics. Original baseline remains writer-internal; no immutable paired before/final row membership or complete-scope derived copy is retained for JSONgen. | **B/C.** Selected source cache plus staged/preserved baseline bodies form the assembled result. A source-only export omits preserved rows; an overlay-only export may omit baseline or removed identities. No exact portable full final result is sealed. |
| 4. Authoritative empty membership | **B/D.** [V] distinguishes source-unavailable preservation and accepted empty-target outcomes; tombstones and final hierarchy support writer-local verification. No exported before physical identities and final absence lineage authenticate per-series empty replacements. | **B/D.** Explicit admitted complete-day/index removals are verified by [P]. Prefix deletion followed by republication, an all-unmapped source, missing file or warning-only omission does not itself authenticate an empty physical day-scope. |
| 5. Effective verification status and overlays | **B/D.** Status-inclusive final-target hashes/counts exist in [A]. No completion-bound status-transition/overlay authority and original provider-status provenance have been exported. Never infer raw status from effective P/R/null. | **B/D.** Selected SOS status evidence exists; preserved rows can have different provenance. Successful byte readback does not authenticate all source/effective-status transitions. No portable accepted transition proof is demonstrated. |
| 6. Physical binding and source provenance | **B.** Core identity and source/mapping evidence are pinned and revalidated; applicable final binding checks exist in [I]. No durable exported selected-v3 binding root/range/source/refresh/physical chain binds every final scope and source-status provenance to the handover. | **B.** Same core/binding infrastructure plus SOS acquisition identity and pinned baseline. No complete export covering preserved rows and final physical bindings; the SOS cache alone does not cover them. |
| 7. Exact final object and manifest/index authority | **B/C.** Frozen staged bodies, recorded hashes and verified parent/index results exist in [A], [V], [I]. Replaceable canonical paths and local stage references are not retained immutable original metadata. Eligible staging may later disappear under [L]. | **B/C.** [P] records final live SHA, verified publication evidence and shared tail; local exact bodies survive only under normal lifecycle rules. No independently retained exact original hierarchy is bound to JSONgen. |
| 8. Complete retained source rows equal the verified final canonical result | **B.** Existing semantic verification is a strong foundation: official RData must use finalTargetRows/finalTargetMetadata, including preservation. It never binds an actual separate JSONgen serialization/digest and its physical scope inventory to final invocation success. | **B/D.** Selected partitions have source-semantic checks, whole-day objects have normal readback. That does not certify a separately built complete bundle, especially preserved partitions with no retained selected-source entry. |
| 9. Independently verifiable completion and source-as-of boundary | **D.** APPLY completion and final VERIFY are distinguishable, but no independently authenticated durable completion includes the source bundle, all final metadata and accepted status/binding boundary. A timestamp/global lock is not an event order. | **D.** Ordered final summary is writer-owned evidence, not an independent acceptance source. No sealed complete-invocation handover or coherent all-writer source-as-of fence exists. |
| 10. Durable availability after normal cleanup | **B/C/D.** [I] and [L] retain substantial internal evidence but may release final staged observation/index bodies after exact monthly acceptance. No derived complete source plus original completion/metadata retention is demonstrated after that lifecycle. | **B/C/D.** Immutable SOS acquisition survives but lacks preserved whole-day content and completion binding. Deferred staging disposal can remove final assembled bodies; historical retained artefacts do not prove a durable handover. |

The current public authority helpers distinguish schema-3 embedded status from
an independently accepted overlay mode. See `selectVerificationStatusAuthority()`
and `readCanonicalScopes()` in `scripts/jsongen/authority.mjs`. Measurement-only
hashes and pointer presence do not supply a missing status-transition acceptance.
Those helpers also require the selected-v3 physical binding namespace. This
investigation supplies no new status or binding transition authority.

## Smallest writer-owned change and proposed contract amendment

This is a proposal for ChatGPT review, **not an accepted new wire format**.
The user's task requires complete writer-owned replacement packaging. Public
Ops code leaves the actual Integrity completion origin and durable original
evidence binding unresolved, as the fail-closed branches in [J] demonstrate. Do not design a new event bus,
cross-writer sequence, canonical verifier or multi-writer publisher to fill it.

The first implementation should cover **one admitted generic Integrity v3
invocation**, with a complete explicitly bounded original scope, rather than
adding two adapters. It belongs beside the fixed-v3 coordinator marker and its
existing source/final-target/normal verification helpers, not in a JSONgen reader
of run-state, SQLite, journals or Dropbox.

ChatGPT must specify these missing acceptance details before an authority adapter
can safely be committed:

1. **Original completion trust.** Define the independently readable immutable
   completion record and the authenticated originating writer/invocation allowed
   to create it, after successful canonical APPLY, required parents/indexes and
   final invocation VERIFY. Bind the actual execution path and code identity.
   The authority must be obtained independently of caller-supplied bundle/report
   JSON. Existing Prune SQL acceptance, tokens, relation and first-publication
   identity cannot be reused with different meaning. The signer currently issues
   upload URLs only; an upload intent is not this completion acceptance.
2. **Exact complete source binding.** While the writer still has its authoritative
   resolved rows, serialize whole physical UTC-day replacements, retaining exact
   timestamps, float64 values and duplicates. For official RData use the validated
   final target including preserved unavailable windows, not source-only rows.
   Retain both compressed/uncompressed digests and lengths. Bind the completed
   source bytes and deterministic complete membership to the same final target
   already verified by the writer. Capture at existing consumers; do not add a
   second canonical Parquet verification.
3. **Before/after and removal closure.** Seal the exact affected physical union
   from the pinned original baseline and final target, including newly present
   series, disappeared series and explicit authorised empty outcomes. Retain the
   original before and final hierarchy/absence evidence, scope row counts and
   coverage digests. Do not interpret source-unavailable windows, absent proposed
   objects or a broad prefix deletion as authoritative empty scope membership.
   Full old rows need not become a new JSONgen baseline; any original-row claims
   must have authenticated retained evidence rather than reconstructed guesses.
4. **Original metadata/status/binding.** Retain the exact verified replaceable
   metadata bytes and closure needed to authenticate observation hierarchy, exact
   physical index, selected generation and applicable status/binding/source
   authority at completion. Seal known provider status or evidenced unavailability
   separately from effective status. A checksum over seven canonical fields does
   not authenticate an additional raw-provider-status claim.
5. **Retention and failure.** Retain the complete derived source and original
   completion evidence independently of normal local staging disposal; verify
   immutable retention/readback before calling that handover complete. Use the
   existing authenticated presigned/direct-private-R2 pattern and bounded
   immutable helpers where compatible, not writer-held derived R2 credentials.
   Missing configuration, oversize/partial evidence, failed/ambiguous upload,
   incomplete final verification or uncertain retention leaves handover
   incomplete. Canonical success and lock release continue on their existing
   schedule. Optional JSONgen failure must not become a repair, cleanup or backup
   gate. No historical evidence may be reconstructed to invent a missing original.
6. **Compatibility and admission.** Specify the minimal separate completion
   envelope/reference and its trusted read boundary, plus retry/idempotence,
   resource limits and retention ownership. Keep receipts 1/2/3, existing
   descriptors/control and diagnostic meanings immutable. Generic v1 references
   are reusable only if an accepted independent authority genuinely fits; v2/v3
   are not generic replacement envelopes. A new version, if required, needs an
   explicit accepted amendment before code. Keep manual/default-off admission,
   explicit environment targeting and separate original/selected coverage;
   unsupported pollutants may not be silently dropped. Leave terminal-midnight
   affected_months compatibility unresolved.

Once these decisions exist, implement writer-side capture first and its
independent bounded reader next. The reader may validate derived source bytes,
original retained metadata and writer completion, then mint a private capability.
It must not repeat canonical Parquet verification. Original event authentication
still does not establish current dominance, an all-writer inventory or monthly
publication eligibility.

For SOS-light, reuse only mechanisms whose authority is identical. A future
dedicated export must bind the full assembled final result, preserved
Dropbox-backed rows and admitted removals to the ordered final VERIFY.
Warning-only preserved/omitted scopes must remain explicitly unproven where their
provenance cannot qualify; selected-source evidence cannot manufacture whole-day
authority. No SOS adapter is justified merely because the coordinator is shared.

## Later operator-controlled TEST procedure

**Not performed and not authorised by this document.** There is currently no
Integrity/SOS-light JSONgen export/acceptance CLI. Do not invent a command or run
the Prune consumer against these files. The first two steps are bounded evidence
inspection; positive handover acceptance remains blocked until the amendment and
implementation above exist.

1. Record the actual installed TEST local-wrapper path, its SHA-256, the local
   TEST selector's single UK_AQ_OPS_REPO_ROOT assignment, selected repository
   origin/HEAD/dirty status and exact entrypoint/helper hashes. Inspect the
   invoked code, not only the repository deployment template. Distinguish normal
   generic, dedicated SOS and stable/frozen invocation paths.

   Example read-only commands, after filling the actual TEST paths:

   ~~~sh
   task_repo='/absolute/operator-selected/TEST/uk-aq-ops'
   task_local_root='/absolute/installed/integrity-root'
   git -C "$task_repo" remote get-url origin
   git -C "$task_repo" rev-parse HEAD
   git -C "$task_repo" status --short
   awk '/^[[:space:]]*UK_AQ_OPS_REPO_ROOT[[:space:]]*=/' "$task_local_root/env/TEST.env"
   shasum -a 256 \
     "$task_local_root/bin/uk-aq-history-integrity-sos-light-local-wrapper-v3.sh" \
     "$task_repo/scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3.sh" \
     "$task_repo/scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3.py" \
     "$task_repo/scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3_impl.py" \
     "$task_repo/scripts/backup_r2/uk_aq_apply_generic_v3_proposal.mjs" \
     "$task_repo/scripts/backup_r2/uk_aq_apply_sos_light_v3_proposal.mjs"
   ~~~

   Do not source/dump .env, expose credentials, invoke the repair runner or change
   selectors. Different/missing installed code means installed behaviour
   **unknown**, not authenticated evidence.

2. Select exactly one genuine completed generic Integrity TEST invocation with
   known source, dates and pollutants. Privately retain its original report,
   run-state, immutable source/final-target files, original core/binding pins,
   proposal closure, mutation journal/checkpoints/deletion sidecars and any
   still-present canonical staging. Hash exact files; record missing files and
   symlink targets without hydrating Dropbox or scanning remote stores. This is
   writer investigation only, never JSONgen normal input reconstruction.
   Require successful real APPLY, final VERIFY, complete parents/indexes, matching
   invocation/fingerprint and no blocked/uncertain scopes. With today's code,
   even a consistent set is **writer-internal evidence only; independent handover
   unavailable**, because the completion/source export does not exist. Stop;
   do not write receipts, control or recover historical rows.

3. Only after a separately accepted contract, reviewed implementation and
   explicitly authorised TEST installation, choose one genuine necessary
   Integrity repair within its admitted bounded scope. Agree the existing
   repair/deletion effects separately. Run the writer's normal APPLY and VERIFY
   once with the new handover explicitly opted in. Capture complete before/final
   physical membership, source/preserved provenance, exact derived source
   references and original completion/evidence record. Do not rerun either known
   Prune event or the completed bootstrap.

4. In a separately authorised **read-only** handover check, use independently
   configured TEST completion-reader and private derived read credentials.
   Authenticate the original completion and exact source bytes/metadata closure.
   No canonical Parquet GET, Dropbox, SQLite/journal/log fallback, global lock,
   receipt retention or managed-control write is permitted in this check.

   Expected classifications (acceptance criteria, not new current report enums):

   | Evidence observed | Required result |
   | --- | --- |
   | Complete authentic original completion, exact whole-scope source, original/final/status/binding closure | Original event authenticated; registration/publication remain separate |
   | Pending source only, successful report/VERIFY without original completion, missing original metadata or provenance | Unverified/incomplete; name exact missing authority |
   | Missing derived object | Missing retention; no reconstruction |
   | Ambiguous reader/timeout/configuration or exhausted budget | Unknown/reconciliation required; never infer absence |
   | Wrong invocation/generation, conflicting scope/status/binding or truncated membership | Reject contradictory/partial evidence |
   | Source-unavailable scope or unproven SOS omission claimed empty | Reject empty/removal authority |
   | Authentic original superseded or currentness unavailable | Retain historical truth; currentness/supersession remains unresolved |

   Observe naturally occurring failure evidence or existing retained failed
   attempts; do not corrupt real evidence, trigger destructive failures or
   introduce a synthetic functional test programme.

5. After separately authorised normal backup/materialisation/cleanup, verify the
   exact derived source and original completion/evidence remain readable under
   the same bounded independent check. Do not change cleanup order or delete a
   file to force this demonstration. Missing retained data blocks handover
   durability. Later authorised retention/registration must be its own bounded
   review, with exact readbacks and complete event coverage.

6. SOS-light has a separate later acceptance case, only after independently
   justified implementation: prove selected source plus preserved complete-day
   membership and removals, ordered final VERIFY, binding/status authority and
   durable post-cleanup source. Generic acceptance does not cover it.

Every step leaves `selectManagedPublications()` disabled. Neither multiple
bounded source-as-of inspections nor matching roots/times create a coherent
cross-partition canonical snapshot. No universal writer coverage, scope
supersession, current-source fence, managed baseline/context or paired CAS
publication is accepted by this procedure alone.

## Changes, structural validation and ChatGPT handover

**Changed:** this focused repository investigation/handover only.
**Code implemented:** none. **Source evidence authenticated:** none for either new
writer; current public code inspected at the pinned Ops commit only.
**Operationally validated:** neither writer's JSONgen handover.
**Managed-publication eligible:** no.

No original code archive is needed for a documentation-only change. No
receipt/control/report schema, configuration name, secret, service binding,
dependency or migration changed. No LIVE repository, authoritative system_docs,
website, bootstrap candidate, registered Prune event, lock, APPLY/VERIFY,
affected_months or cleanup behaviour changed. Rollback is removal of this
document; there is no runtime rollback/deployment step.

Structural validation is limited to pinned source/function/reference review,
current-main branch provenance, documentation diff scope and git diff --check.
Syntax/import tests and archive-fidelity checks are not applicable because no
implementation or code archive changed. No functional suites, real data reads,
migrations, regeneration, deployments or operational mutations were performed.

ChatGPT in Chat mode should update the task-named
`system_docs/station_charts/compressed_history_json_verified_writer_regeneration_contract.md`
and `jsongen_prune_verification_handover_quick_reference.md` with this blocked
investigation outcome, corrected active-v3 generic/dedicated verification
locations and the missing original completion/source/status/binding/retention
authority. Route any approved completion/export amendment through the owning
Integrity, SOS, cleanup, verification-status and binding contracts. Record the
approved version and acceptance procedure; do not broaden Prune receipts or
certify installed behaviour. Codex did not edit authoritative documentation.

Remaining gates: complete inventories for every relevant writer; authenticated
physical current-scope supersession and dominance; accepted effective
verification/binding transitions; coherent source-as-of coverage; managed
monthly baseline adoption and adjacent-month PM context; paired immutable
generation/readback and publication CAS; unresolved terminal-midnight
affected_months compatibility. This investigation resolves none of those gates.

## Pinned public source references

[I]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/e5fe94fd63375d1bd86e7e356d11ed7593a40208/scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3_impl.py
[G]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/e5fe94fd63375d1bd86e7e356d11ed7593a40208/scripts/backup_r2/uk_aq_apply_generic_v3_proposal.mjs
[A]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/e5fe94fd63375d1bd86e7e356d11ed7593a40208/scripts/backup_r2/uk_aq_apply_integrity_proposal.mjs
[V]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/e5fe94fd63375d1bd86e7e356d11ed7593a40208/scripts/backup_r2/lib/generic_v3_proposal_validation.mjs
[S]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/e5fe94fd63375d1bd86e7e356d11ed7593a40208/scripts/backup_r2/uk_aq_apply_sos_light_v3_proposal.mjs
[P]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/e5fe94fd63375d1bd86e7e356d11ed7593a40208/scripts/backup_r2/lib/sos_light_v3_apply_persistence.mjs
[L]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/e5fe94fd63375d1bd86e7e356d11ed7593a40208/scripts/uk-aq-history-integrity/bin/integrity/local_cleanup.py
[J]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/e5fe94fd63375d1bd86e7e356d11ed7593a40208/scripts/jsongen/writer-authentication.mjs
[JI]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/e5fe94fd63375d1bd86e7e356d11ed7593a40208/scripts/jsongen/inputs.mjs
[JR]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/e5fe94fd63375d1bd86e7e356d11ed7593a40208/scripts/jsongen/prune-receipts.mjs
[JB]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/e5fe94fd63375d1bd86e7e356d11ed7593a40208/scripts/jsongen/prune-evidence-bundle.mjs
[JA]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/e5fe94fd63375d1bd86e7e356d11ed7593a40208/scripts/jsongen/prune-consumer-authentication.mjs
[JS]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/e5fe94fd63375d1bd86e7e356d11ed7593a40208/scripts/jsongen/schema.mjs
[JE]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/e5fe94fd63375d1bd86e7e356d11ed7593a40208/scripts/jsongen/prune-event-schema.mjs
[JD]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/e5fe94fd63375d1bd86e7e356d11ed7593a40208/scripts/jsongen/scope-authority.mjs
[JC]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/e5fe94fd63375d1bd86e7e356d11ed7593a40208/scripts/jsongen/currentness.mjs
[JW]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/e5fe94fd63375d1bd86e7e356d11ed7593a40208/workers/uk_aq_jsongen_signer/worker.mjs
