# JSONgen Stage 3D Phase 0A — generic Integrity v3 evidence and implementation readiness

**NON-AUTHORITATIVE REVIEW ONLY — 25 October 2026.** This document does not authorise implementation or operations. Application code, schemas, configuration, workflows, the PR #133 document and authoritative system_docs remain unchanged. Findings marked **confirmed** are established by the pinned TEST source or explicitly qualified documentation; **inferred** denotes analysis/proposals; **unknown** denotes unavailable installation, original evidence or acceptance.

## Decision and scope

**Conditional answer:** the current GitHub generic fixed-v3 RData path has writer-owned original source rows, authenticated preservation rows, proposed final targets, scope decisions, staged publication evidence and final verification. A future exporter can use those materials **inside the genuine invocation** without reconstructing observations from canonical R2 Parquet. However, there is **no existing independently authenticated Integrity-to-JSONgen handover**, and the current final-verification result is not a self-contained, externally authenticated original completion record. Exact before/after physical membership, selected binding closure, final parent metadata capture and original completion authentication still need an explicit export contract and implementation. [P4] [P5] [P6] [P7] [J1]

**Phase 1 implementation readiness: blocked for the complete authenticated handover.** The source-level hook and source-row route are located. Approval still requires installed TEST runner identity, an actual retained candidate evidence inventory, a bounded source/preservation/scope admission decision and a trusted original completion-authentication contract. Source-code feasibility is not installed-runner or evidence acceptance. Phase 0B publication witnesses, all-writer inventories and coherent checkpoints are deliberately not designed here; they are not prerequisites to investigating or exporting one original Integrity event.

The strongest **candidate for operator-assisted inspection**, not a selected ready case, is the documented TEST WAQN connector 9 December 2025 operation. Its source status is clear and its generic v3 publication was accepted for that exact scope. Present retention, complete byte closure and installation identity are unknown. Do not rerun or force a repair to manufacture a handover case.

### Evidence basis and access

| Source | Pinned revision | Boundary |
| --- | --- | --- |
| TEST-uk-aq/uk-aq-ops main | 0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8 | Current GitHub implementation and relevant TEST operator entrypoints |
| TEST-uk-aq/uk-aq-system-docs main | 4addadb675c6fd7082ee3b1544a06381216e9ed9 | Read-only routed contracts and dated, scoped operational records |
| Ops PR #133 head | da96fa2a73133f7ccccf35e08b10b305bbf3f71e | Non-authoritative Stage 3D starting review; still open when checked |

The two main heads were rechecked for this investigation and match the earlier review's pins. Current GitHub sources were obtained through the GitHub connector; the older workspace checkouts are not the implementation authority. Applicable AGENTS.md and the existing SYSTEM_OVERVIEW → station_charts/README → JSONgen contract → relevant r2_history routes apply. Further reading was limited to generic proposal/source/finalisation, Core/binding and cleanup ownership. No sibling TEST repository was needed for new implementation findings.

The [earlier Stage 3D review][R1] is starting analysis, not authoritative implementation acceptance.

**Unknown installed state:** this managed Linux workspace has no attached MacBook Pro filesystem/session tool, configured private-machine identity or VPN. Environment status reports no configured cloud secrets or outbound identities; no usable Mac connection is exposed by available tools. No private run-state, report, SQLite file, source acquisition, binding pack or installed wrapper was supplied. No attempt was made to infer access from an old local path or to use Dropbox for GitHub code. Operator-assisted local evidence is required; section G gives a bounded procedure.

The accepted JSONgen baseline remains the two original AURN events of 15 and 17 October and 866 selected scopes across seven separately bounded Stage 3C inspections. That acceptance is documented/operator-reported; private reports were not examined here. Coverage/freshness remain unknown, authenticated later supersession unavailable, monthly selection/automatic processing disabled and default chart serving unchanged. The missing 16 October original handover remains unavailable and must not be reconstructed. [D1]

## A. Exact execution path and completion boundary

### A1. Operator entrypoint, installation and process ownership

**Confirmed source path:** [P1] [P2] [P3]

1. The normal TEST monthly launcher is scripts/uk-aq-history-integrity/deploy-bin/integrity-run-monthly-TEST.sh. It requires --source sos|waqn|saqn|ni, calls the installed uk-aq-history-integrity-sos-light-local-wrapper-v3.sh, and later orchestrates backup/materialisation/cleanup. Its current fixed month list is January and February 2025, not the historical December WAQN acceptance. It is **not an inspection command** and must not be run for this review.
2. The installed local wrapper's repository source is deploy-bin/uk-aq-history-integrity-sos-light-local-wrapper-v3.sh. It parses only UK_AQ_OPS_REPO_ROOT from local env/TEST.env, resolves that checkout and executes its repository-owned bin/uk-aq-history-integrity-sos-light-v3.sh. Foreground and launchd routing use that same selected repository runner. The non-secret selector must be inspected without executing shell text; it is not the shared secret-bearing repository .env.
3. The repository shell runner loads its selected repository environment, fixes history/index/Integrity selectors to v3, derives TEST local state paths, takes its local process lock and invokes the repository .venv Python with bin/uk-aq-history-integrity-sos-light-v3.py. It can create directories/locks and remove ignored macOS metadata before substantive work. Do not invoke even check-only merely to inspect installation.
4. The Python entrypoint executes sibling uk-aq-history-integrity-sos-light-v3_impl.py in its module namespace. That implementation declares CURRENT_INTEGRITY_HISTORY_VERSION = v3. The similarly named uk-aq-history-integrity_impl.py declares v2 and is not this route.
5. main() calls resolve_and_pin_integrity_target_writer_git_sha: it records the selected checkout HEAD, requires a clean worktree including untracked files, rejects conflicting inherited target SHA and pins that identity for children. A mutable installed wrapper or older installation is not thereby proven identical to current GitHub. The SQLite integer run ID, UTC run_compact, inherited logical invocation and global-lock run ID are distinct existing identifiers; do not substitute one for another or invent a Prune-style UUID. [P4]

Direct anchors: [Python entrypoint][P11] and [clean-checkout writer provenance][P12].

**Confirmed discrepancy:** scripts/jsongen/writer-authentication.mjs currently points integrity_v3 at the fixed-v2 implementation file. Its sos_light_v3 string names run_v2_final_verification even though the dedicated v3 branch uses summarize_ordered_apply_verification. These are blocked diagnostic seams, not authenticators. Correct hooks are documented below; this review does not edit the strings. [J1]

### A2. Generic versus dedicated SOS-light

**Confirmed:** select_sos_historical_replacement_route selects dedicated execution_path=sos_light only for qualifying real source=sos connector-1 replacement with explicit dates/pollutants, fixed v3 and the accepted protected connector set. WAQN/SAQN use execution_path=generic_integrity. Parser support also lists openaq and sensorcommunity; it does not establish their operational publication acceptance. NI is a reserved monthly shell choice, absent from the active Python parser. [P4] [D2]

The main process first checks the request's IngestDB boundary, then, absent valid inherited ownership, delegates/re-enters through run_integrity_under_global_operation_lock and scripts/operations/uk_aq_with_observations_global_operation_lock.mjs. The Node supervisor owns the retained PostgreSQL lock session. Under that ownership, main pins accepted Dropbox checkpoint/root currentness and matching latest-complete v3 Core identity, performs source acquisition/mapping and detection, creates the run overlay, then calls run_v2_integrity_repair_flow. This legacy function name does not select physical v2. Existing source/currentness/core/lock failures remain canonical blockers. [P4] [D3]

### A3. Generic PROPOSE → APPLY → final VERIFY

**Confirmed generic fixed-v3 call chain:** [P4] [P5] [P6]

| Stage | Actual function/component and result |
| --- | --- |
| Source preparation | check_official_network_rdata creates the run's pinned native-R RData/metadata context. run_v2_gap_backfills uses independent detector evidence and proposal preparation; _prepare_official_rdata_proposal supplies source and preserved rows to integrity/official_network_rdata_proposal.mjs. |
| Freeze original inputs | _load_complete_connector_day_source_evidence validates enumeration, raw byte/hash identities and semantic/acquisition evidence; _persist_complete_connector_day_source_evidence commits original detector evidence/rows internally before destructive proposal authority. Detector/proposal agreement is checked independently. |
| Stage proposal | _capture_local_v2_observation_scope compares complete final-target semantic hashes/status counts to locally generated Parquet, validates/stages canonical objects; metadata proposal builds exact/scoped/aligned/latest and affected parent dependencies from the pinned local baseline plus overlay. |
| Freeze selected authority | _finalise_generic_integrity_selected_scope_authority records exact DCP replacement, authoritative-no-data, preserved and metadata-only outcomes; final file-backed ingestion/provenance and transition fingerprints are persisted before APPLY. |
| Launch actual APPLY | run_canonical_apply_executor chooses scripts/backup_r2/uk_aq_apply_generic_v3_proposal.mjs, not the disconnected observation_history_integrity_writer_v3 adapter. The bridge enforces generic_integrity, inherited Integrity lock and configured v3; it invokes applyValidatedProposal in uk_aq_apply_integrity_proposal.mjs with generation=v3 and generic coordinator-freeze/local-graph validators. |
| Apply and finalise | The shared executor enforces Core identity, complete frozen proposal/schedule, source/final-target equality, explicit deletions, durable child verification before parent publication and complete schedule execution. It publishes affected indexes and calls runCanonicalObservationsGlobalFinalizer for the canonical hierarchy. It durably closes APPLY evidence and writes terminal run-state. |
| Reload original operation result | Python reloads the exact child-written run-state after Node exits. It does not merely trust stdout. Failed child execution stays failed; no canonical resume is implied. |
| Final generic verification | run_v2_final_verification validates pinned Core, builds the resolved final local view, performs source/observation/exact-index rechecks, verifies APPLY progress/journal/schedule and deletion sidecars, checks binding semantics and collects blocked/uncertain/application states. Genuine remote execution uses require_remote_state=true. |

**Exact proposed completion hook:** inside run_v2_integrity_repair_flow in uk-aq-history-integrity-sos-light-v3_impl.py, after the generic run_v2_final_verification call has returned and all binding/persistence/remaining-scope checks are available, at the existing inactive post-VERIFY JSONGEN marker (approximately lines 30484–30500), before independent current-state reconciliation. For an admitted changed event require non-dry-run generic execution, APPLY=succeeded, final ran=true/status=ok/remaining_gap_count=0, complete expected operation accounting and no unresolved publication state. A dry-run planned result or skipped_noop is not a new change event. Those checks must be explicit in a future adapter, not inferred from the marker or the word ok alone. [P4]

Direct anchors: [generic final verification][P15] and [post-VERIFY marker][P16].

**Confirmed sequencing detail:** first-value-at reconciliation currently occurs after successful APPLY and **before** this final verification; the broader current-state reconciliation follows the marker. The eventual coordinator/process status can fail for a downstream reconciliation after canonical verification succeeded. Export the precisely attested canonical result and retain separate ancillary outcomes; neither treat process exit as sole publication authority nor let optional JSONgen failure rewrite canonical or existing reconciliation outcomes.

**Dedicated SOS-light difference:** it launches uk_aq_apply_sos_light_v3_proposal.mjs → runPersistedSosLightV3Apply, publishes complete selected days then shared tail and uses summarize_ordered_apply_verification plus binding checks. That summary accepts ordered per-object logical verification/deletion evidence without a second broad remote scan. It is not the generic final-view verification path, and is outside this first handover. [P4] [D4]

## B. Evidence availability and the nine authority questions

### B1. What supplies actual final rows

**Confirmed positive seam:** in uk_aq_apply_integrity_proposal.mjs, loadImmutableSourcePartition reads the generic overlay/day_utc=…/connector_id=…/source-evidence.json and obs_history_rows.json. For official RData it also validates preserved_baseline_rows.json and its exact bytes/count/hash. It returns both:

- rows / encodedRows / metadata: the selected pollutant's **source-only** representation;
- finalTargetRows / finalTargetEncodedRows / finalTargetMetadata / finalTargetTimeseriesRowCounts: the complete selected final target, including authenticated preserved rows.

These are not interchangeable. Using rows alone can silently omit observations preserved during source-unavailable windows. Node validates final-target counts, per-pollutant and per-timeseries membership, content hashes and embedded verification-status counts. The disconnected Integrity writer adapter currently accesses source.rows; it must not be adopted as the generic JSONgen exporter merely because its name looks appropriate. The actual generic APPLY bridge does not use it. [P5] [P6]

Direct anchors: [the returned source/final-target fields][P13], [original source evidence validation][P17] and [resolved final-view construction][P14].

**Confirmed:** the generic final filesystem view is created by _create_final_verification_view. It symlinks the pinned baseline's selected day/index/binding paths, suppresses exact and prefix tombstones, then overlays structurally validated staged bodies. It contains paths to Parquet and JSON, not an immutable complete NDJSON export. Its final rechecks read **local writer-owned** Parquet and source cache as part of existing Integrity verification; that is different from JSONgen downloading canonical R2 Parquet. No new Parquet verification is needed to obtain the RData finalTargetRows already exposed by the writer. [P4] [P8]

**Inferred:** for one admitted RData DCP, export the complete finalTargetRows grouped by physical identity/day and bind them to the verified final target and final canonical physical manifests. The frozen proposal must close the full DCP even if receipt selection later targets only PM2.5/PM10/NO2. Preserve zero-row removed prior series through a separate membership/removal set. Final target rows alone cannot enumerate series that no longer exist.

### B2. Evidence matrix

All availability statements below are **confirmed code capability**, not an assertion that the historical files currently exist. Independent JSONgen authentication is absent unless explicitly noted.

| Required evidence | Producer / available representation | Lifetime and existing durable evidence | Independent authentication / exact remaining gap |
| --- | --- | --- | --- |
| Original invocation/build | main, logical-run propagation, clean checkout target Git SHA, UTC run_compact, SQLite run row, lock run ID and frozen transition/proposal identity | Recorded in differing run-state/report/source/progress structures; installed versions unknown | No current JSONgen original Integrity authority lookup or approved completion issuer. Export the linked identities; a local Git SHA/report is not independent proof of final success. |
| Raw provider provenance | check_official_network_rdata, native-R decoder, pinned RData and metadata bytes, acquisition manifest, source file identities and availability/column classifications | Raw RData/source cache and run evidence are outside the bounded working-file cleaner; actual retention unknown | Preserve original SHA/length, mappings and semantic/acquisition versions. Hashes identify original acquisitions but do not, alone, prove final publication or supply final rows. |
| Source observation rows | Detector and proposal source-evidence.json + obs_history_rows.json, internally persisted source_connector_day_evidence.canonical_rows_json | Detector JSON can be losslessly compressed after last consumers. Main proposal files remain for APPLY/final verification. SQLite is writer-internal | Export original row bytes through a writer-owned interface during invocation. JSONgen must not query the SQLite or inspect raw internal directories. |
| Preserved unchanged rows | _prepare_official_rdata_proposal obtains only required unavailable-window rows from the pinned local Dropbox baseline; preserved_baseline_rows.json and dependency identities commit exact inputs | Main preservation file survives later consumers; helper/detector copies can be compressed. Baseline is a mutable local mirror after the owning run releases its lock | Include actual preserved rows and original baseline dependency closure in the export. A preservation hash or an unavailable source file is not an empty replacement or the preserved row body. |
| Complete final target | loadImmutableSourcePartition.finalTargetRows and exact canonical encoding/hash/counts; local staged Parquet is checked against it | JS arrays are process-local and disappear on child exit; source/preserved sidecars can still supply original target within the invocation | No exported bounded common bundle exists. Capture from the validated original input route; do not use source.rows or reconstruct from current remote Parquet. |
| Resolved final view | _create_final_verification_view symlinks validated overlay over tombstone-filtered baseline; local exact_v3_verification checks membership/physical routing | Disposable directory, not a retained immutable snapshot; symlinks depend on staging/baseline lifetime | Useful writer verification context, not a consumer interface. Export selected data and authority bytes before their last consumers/cleanup. |
| Effective and source status | Canonical rows contain verification_status; RData mapper derives P/R from matching site_id+parameter metadata ratified_to, after canonical +1-hour time conversion; preservation keeps baseline status | Source semantic evidence/status counts and original metadata identities; preserved row status survives in the target | Export exact effective P/R/null and its source-derived/protected-baseline provenance. Do not invent an original provider per-observation P/R field when the source is a ratified_to rule. AURN's explicitly unavailable source-status origin schema is not the RData origin contract. |
| Exact before membership | Pinned baseline hierarchy, pollutant manifests/timeseries counts, source/preservation dependency objects under the original locked currentness boundary | Some baseline identities are frozen for preservation and metadata-only authority; no general exported per-physical-scope before map | Must capture/authenticate complete original selected before membership and physical/status/binding dependencies, including prior members absent after replacement. A deleted-key filename list cannot supply those semantics. |
| Removal/final absence | generic_integrity_selected_scope_authority, explicit pollutant tombstones, source-available no-data decisions, exact removal schedule, verified deleted-key sidecars and parent/index proposal closure | Internal run-state, durable mutation journal and sidecars survive bounded cleanup | Source authority is DCP-level; external physical-timeseries/day removal mapping is not exported. Need exact prior/final membership and final authenticated parent/index absence. Missing file/column remains preservation, never inferred deletion. |
| Canonical physical publication | Staged canonical Parquet/manifests/exact/scoped/aligned/latest objects with original bytes/hashes; validation graph and per-object remote verification are persisted | Canonical staging survives final verification/report; may be retired after accepted exact month/backup/materialisation | Future exporter can retain metadata from existing writer inputs/verification. There is no complete externally retained source→final physical evidence envelope. JSONgen does not repeat the canonical Parquet verification. |
| Aggregate parents/global completion | publishAffectedIndexes → runCanonicalObservationsGlobalFinalizer → hierarchy finaliser; terminal APPLY schedule and journal | global_index_finalization and hierarchy results retain content-hash/action/size/verification summaries; they do not necessarily retain final aggregate JSON bytes | Capture exact original aggregate metadata through the existing finaliser IO while available. Do not assume staged proposal bytes or the final local view equal every aggregate body actually published by the finaliser. |
| Core/binding authority | Pinned latest-complete v3 Core identity and consumer audits; run_timeseries_binding_verification checks connector-scoped semantics through individual or authenticated pack provider | Pack provider verifies root/ranges/members and materialises selected bytes in a temporary view; that view is removed on context exit, before the post-VERIFY hook. Audit survives; original packs may survive | Retain selected original member bytes and authenticated root/range/pack closure while yielded. Pinned Core identity plus pack audit is not, alone, exported canonical binding source-state/root/range/refresh completion proof. Define exactly how that closure binds the original publication. |
| Original final VERIFY result | run_v2_final_verification return; later coordinator/report and progress persistence | Result initially exists in memory. It is later embedded in coordinator/run-state and reports; no original externally authenticated JSONgen completion record | Need a domain-specific finalisation predicate and durable trusted completion record. A computed immutable hash or unauthenticated success report cannot create one. |

Sources: [P4] [P5] [P6] [P7] [P8] [P9] [P10] [D3] [D5] [D6].

### B3. Final verification: what it establishes inside the writer

Classifications: **E** = existing writer-internal evidence; **D** = derivable inside the original invocation but not exported; **C** = new handover/authentication contract required; **U** = unavailable/unknown installed evidence. These classifications describe different layers; E is not external JSONgen authentication.

| Required claim | Assessment and boundary |
| --- | --- |
| 1. Originating writer/invocation | **E + C + U.** Linked run/build/transition/lock identities exist, with clean-code admission in current source. No accepted JSONgen Integrity completion authenticator exists; installed identity is unknown. |
| 2. Non-dry-run APPLY and final VERIFY | **E + C.** Actual child result/state reload, successful complete scheduled APPLY and require_remote_state=true final result are load-bearing. dry-run status=planned and validated zero-operation no-op are distinct. The exported final attestation/predicate is unimplemented. |
| 3. Complete final observation membership | **E + D.** Source+preservation final-target count/hash/status/membership checks and local final-view rechecks exist for the selected scope. Complete physical bundle/group membership still needs export binding. |
| 4. Exact before→after membership | **D + C.** Original baseline and final scope material can support the relation; the current DCP authority and changed_scopes timeseries IDs are not a complete exported prior/final physical union. No authenticated link to a prior JSONgen receipt is established. |
| 5. Authenticated removals/absence | **E + D + C.** Original source no-data authority, tombstones and deletion verification exist for admitted operations. A removed physical member, source-unavailable preservation and empty DCP are different cases; external final parent/index absence proof is not implemented. |
| 6. Source/status provenance | **E + D + C.** RData v10 semantic/acquisition separation, availability, metadata mapping and source/preserved statuses exist. Their exact new common handover representation is not defined. |
| 7. Physical identity and binding closure | **E + D + C.** Source-to-local-physical comparison, verified staged objects, Core pinning and pack/individual semantic checks exist. Exact final selected binding bytes plus source-state/refresh authority are not retained as a JSONgen original closure. |
| 8. Parents/latest/global/index completion | **E + D.** Frozen dependency schedule, durable child barriers, finaliser return and complete schedule accounting exist; aggregate hierarchy publication is additional to staged-object schedule accounting. Explicitly bind both in a future completion envelope. Observation latest is discovery, not an authentication parent. |
| 9. No unresolved partial/failed publication | **E within this invocation + C.** Final verification rejects blocked scopes, uncertain objects, unverified PUTs/deletes, invalid persistence and inconsistent application evidence. Journal verification checks exact hash chain/tail, schedule event order/counts, terminal canonical_apply_completed and delete sidecars. This does not prove absence of other writers or later changes; those remain Phase 0B. |

**Confirmed:** verify_apply_persistence_artifacts does more than accept flags: successful journal PUT/GET sequences must match the entire frozen schedule, with no missing/duplicate/reordered positions and exact terminal chain evidence. Conversely, final status=ok is not a universal freshness/completeness certificate or proof of an external observer's access to that evidence. [P4]

### B4. Cleanup and evidence loss points

**Confirmed:** _capture_local_v2_observation_scope removes authenticated duplicate generated bodies after canonical staging is secured. _cleanup_observation_working_files retires allowlisted helper/detector JSON only after exact lossless gzip evidence is recorded/readback-verified; it preserves main proposal source authority. The current cleanup contract expressly preserves SQLite evidence, raw source acquisitions, journals/sidecars, Core/registry/bridge snapshots and main proposal source files. That is code/contract capability, not proof of retention on the Pro. [P4] [P9] [D5]

After successful real repair/reporting, cleanup_successful_repair_overlay records deferred staged-body candidates. The normal TEST monthly cleaner may delete individually authenticated canonical v3 staged bodies only after matching successful Integrity, exact backup and local-materialisation acceptance. Standalone runs without that chain are not automatically eligible. A final-verification symlink can then become unusable when its target is removed, even if the directory remains. The older fixed-v2 cleanup's broad generated/view removal is not the current fixed-v3 policy. [P9] [D5]

Two earlier loss points matter for implementation: Node's final-target arrays disappear when APPLY returns, and pack materialisation is removed before run_timeseries_binding_verification returns. Exact aggregate IO bytes can also disappear without ever being staged in run-state. Capture these original representations at their existing owner boundaries, then bind the retained candidate only after generic final verification succeeds. Copying a later mutable baseline or rebuilding a deleted view cannot replace original authority.

## C. Candidate genuine TEST source assessment

| Candidate | Confirmed capability / documented operation | Present original evidence | Decision |
| --- | --- | --- | --- |
| WAQN connector 9, December 2025 | Official RData v10 source/preservation and P/R semantics; documented TEST run 2026-10-13T201819Z for NO2/PM10/PM2.5: 39,000 observations, 2,306 GET-verified writes, 93 prefix deletions removing zero objects and zero final observation gaps. Two authenticated provider HTTP 404 files stayed preservation-only. | **Unknown.** Run-state/report/source/preserved rows, staged metadata, Core/binding packs and exact original build have not been inspected. Later manual cleanup and current cleaner installation are unknown. | Best historical evidence to inspect first. Not yet an approved handover case; the 31-day operation is not automatically within first-slice budgets. Zero-object deletions do not exercise removal of existing physical members. |
| SAQN connector 10 | Current source/proposal code supports RData semantics including missing-column preservation; the authoritative contract leaves SAQN fixed-v3 acceptance outstanding. | Unknown; no qualifying original TEST final event supplied. | Do not select based on shared code or non-TEST/fixed-v2 examples. |
| OpenAQ / Sensor.Community generic routes | Listed by the current fixed-v3 parser and source orchestration. Generic admission exists; this bounded review did not establish an accepted source-specific fixed-v3 final event with complete original closure. | Unknown. | More authority uncertainty than the documented WAQN case. Parser presence is insufficient. |
| AURN SOS historical repair | Real dedicated SOS-light evidence is documented, but qualifying connector-1 historical replacement follows the dedicated complete-day route. | Historical references are not inspected original material. | Outside generic Phase 0A. The two accepted AURN Prune events are also not generic Integrity events. |
| NI | Monthly shell reserves a selector; Python has no accepted NI source choice. | No qualifying generic v3 case established. | Unavailable. |

**Confirmed as documented, not independently repeated:** WAQN's exact acceptance and limits are in the RData contract's 13 October TEST handover. The reported 55 affected timeseries from a separate pending cache event is not the size of a verified JSONgen source bundle or proof that those rows remain retained. No actual source/evidence byte budget is available here. [D6]

**No candidate can yet be selected for an implementation acceptance operation.** Obtain the WAQN original metadata inventory first. If fully retained, use it for writer-bound structural evidence inspection, not to mint a new historical VERIFIED event from logs/SQLite/reprocessed Parquet. Choose a naturally justified future authorised generic repair only when real source or canonical repair authority calls for it, and only after the exporter is installed. No force-replace-selected, PROPOSE, APPLY, VERIFY or other operation is authorised by this review. A day/pollutant subset of an old multi-day invocation cannot be treated as an independently finalised original invocation without a contract that authenticates the complete operation and the subset relation.

## D. Minimum handover design — proposed, conditional and fail-closed

### D1. Prepare original writer-owned data, then attest final completion

**Inferred first slice:** one admitted generic RData schema-3 source case, physical identity/day, selected PM2.5/PM10/NO2 only, with complete original scope accounting. Start with a bounded non-empty replacement; classify whole-source-unavailable, no-op, metadata-only, authoritative empty and physical-member removal explicitly. Do not silently discard a removed prior member inside an otherwise non-empty DCP. Unsupported removal/status cases block that event rather than weakening complete membership.

1. At the existing validated original proposal/source boundary, prepare deterministic complete-scope NDJSON from finalTargetRows, preserving existing canonical timestamp/value/multiplicity/status semantics. Keep source and preserved provenance distinct. Preserve complete selected DCP membership and the union of original before/final physical members, including explicit authorised removals; never invent a fake zero-row exact leaf. Retain exact source/status/mapping/availability identities and original before hierarchy while the owning invocation has them.
2. Capture original selected binding member/pack/root/range evidence while the binding provider yields it, the pinned matching Core identity and required canonical source-state/refresh closure. Capture final aggregate and physical JSON metadata through existing writer/finaliser IO or retained original staged metadata; do not add another canonical Parquet read. Preparation remains unverified until final acceptance.
3. After actual generic APPLY and final verification succeed, validate a closed event predicate and bind the original data, selected policy, full membership/removals, source/preservation hashes, proposal/transition/schedule identities, canonical final metadata and original completion authority in a small versioned envelope. Persist exact original completion bytes locally before optional network delivery where possible. A new file must be explicitly owned and retained; do not hide it in an existing cleanup-eligible staged-body category.
4. Reuse the signed **per-object transport pattern**, compressed/uncompressed hashes/lengths, conditional immutable PUT and exact readback in the private derived bucket. Existing Prune codecs and signer admission are writer-specific, not drop-in Integrity authority. No broad derived R2 credentials enter the canonical writer; no transport failure reverses canonical success or extends the observation lock for JSON calculation. Later readback/replay does not rerun canonical repair.
5. An explicit manual independent consumer reads only the exported wire envelope/source/metadata bytes and the original authority through its accepted verification mechanism. It never navigates Integrity's SQLite, run-state, journal, Dropbox mirror or raw overlay. After origin verification, independently validate bundle byte integrity, complete row/membership/status/source→final relationships, binding closure and the exact final predicate. A new typed Integrity capability is required; existing Prune capability/receipt schemas remain unchanged.
6. Stop at a separately reported authenticated original Integrity handover, with currentness/supersession not inferred. If selected receipt retention/registration is included in a later authorised slice, retain/read back every required object before one whole-event visibility change. Use a new Integrity origin/receipt variant rather than disguising it as Prune schema 2/3. Do not build control sharding, inventories or monthly publishing as part of this slice.

Any optional capture callback must isolate its own failure and mark the handover unavailable, while preserving the original binding verification/finaliser exceptions and results. Do not turn failed optional capture into a successful canonical check, or throw it through an already valid canonical verification path.

### D2. The missing independent original authority

**Confirmed blocker:** Prune has a restricted original committed PostgreSQL outbox read; Integrity has no equivalent JSONgen origin adapter. Existing hashes/journal checks, current-state OAuth, Daily Task Health, a pending-upload intent or bearer token identifying a caller do not independently authenticate a successful complete canonical invocation. A new adapter cannot set authenticated=true merely because an exported report says ok. [J1] [J2]

**Inferred decision needed:** define one explicit original completion authority. A small versioned signed completion attestation issued by the trusted writer finalisation adapter is a plausible minimal design: an independently configured consumer verification key, domain/environment/writer/build/invocation/scope-bound statement, exact original source/final metadata digests and closed completion predicate. Key custody, who may issue the statement, how the verified predicate gates issuance, rotation/retained-verification policy and whether this trust model satisfies the independent writer contract must be approved. A signature proves the trusted issuer's statement; it is not an independent re-verification of canonical Parquet or proof of complete writer inventory.

An alternative is an explicitly restricted append-only original Integrity completion store with independently readable original records, rather than self-reported mutable local reports. That adds authority/schema/permission ownership and must still specify how the real writer's verified result is admitted. **Neither mechanism exists or is approved by this review.** Choose one before a consumer can truthfully authenticate Integrity. Do not simply reuse the Prune AURN signer token, reader role or insertion function. No new secret name or database table is prescribed prematurely.

This is an original-event authentication decision for one writer, **not** Phase 0B publication-witness ownership, all-writer completeness or freshness fencing. A successfully authenticated original event still reports writer_coverage=unknown, freshness=unknown, publication_eligible=false.

### D3. Bounds and replay

**Inferred:** retain existing compatible protections: at most 128 whole physical scopes per selected receipt/work unit, 100,000 rows, 8 MiB compressed / 32 MiB uncompressed data and 8 MiB per complete scope record. Explicitly budget source, metadata capture, compression, retained completion and optional transfer separately against the writer's existing canonical headroom. Do not automatically borrow Prune's 120-second/192 MiB authentication profile, its 1,024-scope original-event cap or its evidence codec without proving an Integrity-specific aggregate envelope and ownership. Do not split an indivisible physical scope or reset budgets per loop. First-case sizes are unknown. [J3]

Use deterministic event identity from the real configured environment, writer, original invocation/build/attempt identity and immutable original authority; group/partition IDs bind complete scope membership and policy. Replays use exact retained bytes and the same identity. Conditional conflicts require exact readback, not overwrite; ambiguous delivery requires identity-based reconciliation. Preserve typed authority and reject conflicting reused IDs.

| Interruption / unavailable state | Safe result |
| --- | --- |
| Prepared source uploaded, canonical APPLY/VERIFY incomplete | Pending/unverified; no eligible original completion or receipt. |
| Canonical success, optional source/capture/origin persistence failed | Canonical outcome unchanged; handover incomplete/unavailable. Never fill missing original proof from later state. |
| Complete original local envelope retained; private upload incomplete/ambiguous | Replay only those exact originally bound bytes with bounded retries/readback; no repair rerun. |
| Private source/evidence retained, no trusted completion authority | Byte integrity may pass; original authentication remains unavailable. |
| Consumer authenticated, selected retention/registration interrupted | Replay immutable original proof and whole group; never declare a partially visible group complete. |
| Current canonical metadata later differs | Original event stays historical. Supersession/currentness is a different later assessment. |

A crash after canonical VERIFY but before any trusted completion is durably retained is a genuine unrecoverable handover gap unless original accepted authority already exists. This slice cannot promise recovery across that window merely from local audit files. Canonical success remains independent of optional handover availability.

## E. Implementation blockers and optional follow-ups

| Class | Blocking fact / required resolution |
| --- | --- |
| Installed-runner uncertainty | Establish the Pro's actual TEST selector, deployed wrapper identity, selected checkout HEAD/clean state and relevant file identities. Historical documentation cannot prove this. |
| Missing original evidence | Inspect one exact original generic run's report/run-state/source and preservation sidecars, proposal/schedule/journal/sidecars, Core/binding references, staging and cleanup metadata. Required facts are presence/hash/length/status/membership, not upload of original observations. |
| Origin authentication contract | Approve the trusted original Integrity final completion issuer/store and independently usable verification mechanism. No current implementation satisfies this seam. |
| Scope/source/status admission | Identify one genuine source case with complete before/final physical membership, preserved rows, source-status semantics and explicit treatment of removals. RData status provenance is not the AURN Prune unavailable-status contract. |
| Binding/final metadata export closure | Define capture of temporary pack members and original canonical source-state/refresh authority; retain finaliser aggregate bytes, not only root/action summaries. |
| Budget/retention policy | Set a bounded envelope from actual original size inventory; protect pending original proofs from existing cleanup and make optional failure independent of canonical success. |
| Optional later improvements | Shared exporter abstractions, a second generic source, reusable verifier certificates and broader receipt integration can follow the first accepted source. They are not reasons to build a speculative framework now. |
| Explicit later dependencies | All-writer coverage, supersession, freshness, coherent cross-partition snapshots and monthly publication remain unresolved/disabled; no Phase 0B design is proposed here. |

## F. Small ordered TEST implementation plan — not authorisation

1. **Close source-level admission.** Obtain section G's minimal installed/candidate facts, decide the original authority contract, exact scope/status/removal support and allowed budget. Map the genuine finalTargetRows and before membership to final physical evidence. If any material is absent, stop that candidate with a precise unavailable reason; do not run a repair or reconstruction to fill it.
2. **Define one wire and original completion predicate.** Establish a small Integrity-specific envelope/codec and authentication owner alongside scripts/jsongen/. Preserve existing Prune receipt meanings. Likely components are writer-authentication.mjs (correct blocked seam descriptions and later typed adapter), a new bounded Integrity envelope/consumer module and narrowly necessary schema validation. Do not introduce a generic all-writer registry or modify selection.
3. **Add writer-owned preparation/capture only at the real generic boundaries.** Likely files are bin/uk-aq-history-integrity-sos-light-v3_impl.py (validated source preparation, original before evidence, generic post-VERIFY hook), uk_aq_apply_generic_v3_proposal.mjs / uk_aq_apply_integrity_proposal.mjs (final-target/verified physical evidence capture), integrity/timeseries_binding_provider.py (selected bytes while owned) and the hierarchy finaliser IO adapter if exact aggregate bytes cannot otherwise be retained. Keep any shared changes generic-gated and preserve dedicated SOS/fixed-v2 behaviour. Do not route through the disconnected writer or change canonical verification/deletion/schedule rules.
4. **Add optional immutable export and explicit manual consumer.** Reuse low-level transport/immutable-readback/hash/budget mechanisms genuinely compatible with the new wire. workers/uk_aq_jsongen_signer/worker.mjs currently admits Prune-specific object types/identity; any Integrity capability/issuer must be separately scoped and reviewed. Independent authentication stays unavailable until the chosen original completion mechanism is implemented. First consumer acceptance is read-only; any subsequent manual receipt retention/registration is separately authorised.
5. **Preserve original evidence through existing lifecycle.** Protect the retained final envelope/source references from integrity/local_cleanup.py and deferred monthly staged disposal. Prefer an explicit separate handover-owned retained category; do not broaden cleanup or back up private derived data to Dropbox. No new scheduler or automatic dispatch. A targeted cleanup-contract update may be necessary; do not silently change existing mandatory canonical durability.
6. **Deploy/accept only after separate authorisation.** Install the approved TEST code/configuration, then use an independently justified normal genuine generic operation. Confirm original rows/preservation/status/physical membership, exact original authority/finalisation/binding and deterministic retained replay without a second repair/remote Parquet verifier. An unchanged no-op is legitimate but does not accept a replacement handover. Wait for a naturally applicable operation rather than force artificial source changes or destructive repairs. Keep all publication/coverage/freshness/serving flags as stated above.

**Configuration and permissions:** reuse explicit UK_AQ_ENV_NAME, UK_AQ_GITHUB_REPO, selected v3, the configured separate private derived bucket and low-level signed transport where meanings fit. Existing credentials named for Prune are not an Integrity permission grant. The catalogue has Prune transport/reader keys, no approved Integrity original-completion signing/reader authority. Any necessary new identity/key must have a clear role and update config/uk_aq_github_env_targets.csv, sync targeting and the operator's private master catalogue; the latter was not inspected. No hard-coded TEST endpoint/bucket or cross-environment fallback. The same application code must support separately configured environments. [J4]

**Schema implications:** a signed-object-only authority can avoid a new SQL table, subject to its trust decision; a restricted completion-outbox alternative requires canonical DDL plus an existing-database migration and grants in TEST-uk-aq/uk-aq-schema, not ops-local SQL. No schema work is created here. Never repurpose Prune's original gate/deletion outbox as generic Integrity authority.

**Before implementation, structural checks only:** inspect installed/source compatibility; prove original final-target/before/removal membership and status equality against existing writer validators; verify selected binding/aggregate capture lifetimes; trace the closed finalisation predicate and issuer permissions; confirm the existing S3 client/signer conditional/readback capabilities and budget accounting; parse the small changed modules and wire versions when a separately authorised patch exists. No speculative fixture programme or pre-implementation functional suite. This review ran none of the Integrity code, including PROPOSE/APPLY/VERIFY.

## G. Minimal operator-assisted inspection

**Read files only. Do not run any Integrity/monthly/cleanup launcher, source acquisition, verifier, database query, R2 request or workflow.** Do not paste .env, tokens, connection strings, raw logs, SQLite rows or observation bodies. Reading an existing local TEST report is evidence inspection, not authorisation to execute its producing operation. Keep full paths and files private; return only the selected metadata listed below.

### G1. Installation identity

Locally inspect the single non-secret selector at <local Integrity root>/env/TEST.env; confirm it contains only UK_AQ_OPS_REPO_ROOT, and that it resolves to the intended TEST checkout. Do not source it or print shared .env. Set the two task variables manually from the operator-known installation; these are placeholders, not known installed paths:

```bash
integrity_test_repo='/absolute/path/to/the/selected/TEST/uk-aq-ops'
integrity_local_root='/absolute/path/to/uk-aq-history-integrity'
git -C "$integrity_test_repo" rev-parse HEAD
if integrity_checkout_status="$(git -C "$integrity_test_repo" status --porcelain --untracked-files=normal)"; then
  if test -z "$integrity_checkout_status"; then
    printf 'selected_checkout_clean=true\n'
  else
    printf 'selected_checkout_clean=false\n'
  fi
else
  printf 'selected_checkout_clean=unavailable\n'
fi
git -C "$integrity_test_repo" hash-object -- \
  scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3.sh \
  scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3.py \
  scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3_impl.py \
  scripts/backup_r2/uk_aq_apply_generic_v3_proposal.mjs \
  scripts/backup_r2/uk_aq_apply_integrity_proposal.mjs \
  scripts/backup_r2/lib/generic_v3_proposal_validation.mjs
git -C "$integrity_test_repo" hash-object -- \
  "$integrity_local_root/bin/uk-aq-history-integrity-sos-light-local-wrapper-v3.sh"
git -C "$integrity_test_repo" rev-parse \
  HEAD:scripts/uk-aq-history-integrity/deploy-bin/uk-aq-history-integrity-sos-light-local-wrapper-v3.sh
```

These commands do not execute repository Python/shell code or write Git objects (hash-object has no -w). Hash results are emitted in the listed order. Return the HEAD, clean boolean, six ordered file blob hashes and the installed/reference wrapper hash pair, plus confirmation that the selector targets TEST. If Git status errors, do not report the checkout clean; report inspection unavailable. A matching wrapper hash/HEAD is necessary source identity evidence, not proof of deployed credentials, dependencies or successful historical operation. The current code requires a clean checkout; leave unrelated user work intact.

### G2. One original candidate and remaining fact checklist

For the known historical WAQN run, if it still exists, begin with the explicit run directory named run-2026-10-13T201819Z under TEST state/tmp and its matching report. This is a documented logical-run name, not a claim that the directory exists. Select exact paths manually; do not recursively scan every run or open a LIVE directory. A small allowlisted local report summary can be produced without printing paths, bodies or error strings:

```bash
integrity_run_state='/absolute/path/to/the/existing/TEST/run-state.json'
integrity_report='/absolute/path/to/its/existing/report.json'
python3 - "$integrity_run_state" "$integrity_report" <<'PY'
import hashlib, json, pathlib, sys
state_path, report_path = map(pathlib.Path, sys.argv[1:])
def bounded_json(path):
    if not path.is_file() or path.stat().st_size > 32 * 1024 * 1024:
        raise SystemExit('original metadata unavailable or exceeds inspection bound')
    body = path.read_bytes()
    if len(body) > 32 * 1024 * 1024:
        raise SystemExit('metadata changed beyond inspection bound')
    return json.loads(body), hashlib.sha256(body).hexdigest()
s, sh = bounded_json(state_path)
r, rh = bounded_json(report_path)
if s.get('environment') != 'TEST' or r.get('env') != 'TEST':
    raise SystemExit('explicit TEST original metadata required')
f = r.get('repair_flow') or {}
v = f.get('final_verification') or {}
a = s.get('apply') or {}
authority = s.get('generic_integrity_selected_scope_authority') or {}
print(json.dumps({
  'run_state_sha256': sh, 'report_sha256': rh,
  'original_run_id': s.get('run_id'), 'source': r.get('source'),
  'from_day': r.get('from_day'), 'to_day': r.get('to_day'),
  'execution_path': s.get('execution_path'),
  'history_version_mode': r.get('history_version_mode'),
  'dry_run': r.get('dry_run'), 'effective_mode': r.get('effective_mode'),
  'report_status': r.get('status'), 'apply_status': a.get('status'),
  'planned_writes': a.get('planned_writes'),
  'completed_writes': a.get('completed_writes'),
  'failed_operations': a.get('failed_operations'),
  'final_ran': v.get('ran'), 'final_status': v.get('status'),
  'remaining_gap_count': v.get('remaining_gap_count'),
  'selected_dcp_count': len(authority.get('selected_scopes') or []),
  'blocked_scope_count': len(s.get('blocked_scopes') or []),
  'uncertain_object_count': len(s.get('uncertain_r2_objects') or {}),
  'binding_mode': r.get('timeseries_binding_backup_mode'),
  'cleanup_completion_recorded': bool((s.get('cleanup') or {}).get('completion')),
}, sort_keys=True))
PY
```

This is a small metadata projection, not an authenticator. Missing/older fields must stay null/unknown and must not be filled from later code. For a selected exact DCP, the remaining operator response can be a short table of **present / absent / unknown, original recorded SHA/length and actual local SHA/length**, with no observation rows, for:

- Main proposal source-evidence.json, obs_history_rows.json and preserved_baseline_rows.json, original acquisition/metadata identities and existing cleanup gzip mappings where applicable. Report original source/preserved/final counts and effective-status counts only when already recorded; hashes do not prove the rows are final.
- Frozen proposal/transition fingerprint, publication schedule, APPLY progress/journal and deleted-key sidecars; state whether required local staged manifests/exact/scoped/aligned/latest and final aggregate metadata bodies remain. A retained hash without the body is insufficient for export/replay.
- Original pinned Core identity/manifest and matching binding pack root/ranges/members or individual binding files, checkpoint/root identities and source-state/refresh references where genuinely retained. Do not re-fetch missing evidence or unpack/reprocess observation Parquet to replace it.
- The run's exact source/build identity and whether monthly accepted-stage cleanup or later manual disposal touched it. Existing report/core/source manifest field names and presence are enough initially; no broad filesystem search or SQLite extraction is required.

Only after that inventory can the exporter hook and first source be approved. If the material is gone, report the candidate unavailable. Do not recreate directories, restore old run-state from current Dropbox, regenerate sidecars, rerun VERIFY or infer historical acceptance from matching current canonical metadata.

## H. Separate ChatGPT Chat-mode documentation handover

**No authoritative system_docs edit was made.** The documentation owner should consider:

1. Correcting generic fixed-v3 routing and dedicated SOS verification descriptions: the shared v3 Python file branches to the generic or dedicated Node driver; function names containing v2 do not by themselves indicate physical generation. The current generic writer-seam string points at the fixed-v2 file.
2. Defining the chosen original Integrity completion authority and independent authentication trust boundary before allowing VERIFIED. Specify exact writer/invocation/build, original source/preservation/status, before/final/removal membership, physical/binding/Core closure and final parent/index completion. Keep Phase 0B coverage/freshness separate.
3. Recording that source-only rows and finalTargetRows differ for RData preservation, final-view paths are symlinks, pack member views are temporary and aggregate finalisation summaries are not retained exact JSON bytes. Capture/retention ownership must follow those lifetimes.
4. Approving the first genuine source/scope only after installed and retained evidence is inspected. Preserve the scoped 13 October WAQN acceptance, SAQN unknowns and unsupported NI boundary. Do not retroactively turn a retained historical audit into an original JSONgen completion event.
5. Updating cleanup/handover retention and configuration/permission ownership only for the eventual approved implementation, including any original-completion key/store contract. Preserve canonical Integrity verification, global lock, failure semantics and private-derived Dropbox exclusion.

After any later implementation, the Chat-mode handover must supply actual changed files, wire/schema/configuration implications, structural checks and separately authorised genuine TEST evidence. This investigation supplies source findings and conditional design only.

## Review checks and delivery

The inspection traced the actual operator/repository/lock/source/proposal/generic APPLY/final-verification/report/cleanup boundaries and the directly relevant final-target, binding, finaliser and JSONgen dependencies. It did not execute repository code, create tests, query databases, inspect private source rows, perform R2/Dropbox operations, dispatch Actions or deploy anything. Only this new review document is to be committed. PR #133 and its document remain unchanged.

Document checks cover section completeness, confirmed/inferred/unknown qualification, 28 pinned file/line references, whitespace, exact remote readback and the one-file GitHub comparison. The two operator shell examples and embedded Python were syntax-checked without executing them. The reviewed main and Markdown-only review path retain the earlier source-level workflow-trigger assessment; no operational workflow is invoked. Installation/candidate/independent-origin blockers are substantive and remain unresolved, so **Phase 1 authenticated-handover implementation is not yet structurally ready for approval**.

Stop after this review and its PR. No merge, deployment, repair, handover implementation or Phase 0B work follows without separate authorisation.

## Pinned references

[R1]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/da96fa2a73133f7ccccf35e08b10b305bbf3f71e/reviews/jsongen_stage3d_readiness_review_2026-10-25.md#L1
[D1]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/4addadb675c6fd7082ee3b1544a06381216e9ed9/system_docs/station_charts/compressed_history_json_verified_writer_regeneration_contract.md#L3
[D2]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/4addadb675c6fd7082ee3b1544a06381216e9ed9/system_docs/r2_history/history_integrity_monthly_operator_runbook.md#L21
[D3]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/4addadb675c6fd7082ee3b1544a06381216e9ed9/system_docs/r2_history/integrity_generation_aware_core_snapshot_amendment.md#L1
[D4]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/4addadb675c6fd7082ee3b1544a06381216e9ed9/system_docs/r2_history/sos_light_three_phase_authority_contract.md#L330
[D5]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/4addadb675c6fd7082ee3b1544a06381216e9ed9/system_docs/r2_history/integrity_v3_local_working_file_cleanup_contract.md#L1
[D6]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/4addadb675c6fd7082ee3b1544a06381216e9ed9/system_docs/r2_history/official_network_rdata_historical_integrity_contract.md#L20
[P1]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/uk-aq-history-integrity/deploy-bin/integrity-run-monthly-TEST.sh#L48
[P2]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/uk-aq-history-integrity/deploy-bin/uk-aq-history-integrity-sos-light-local-wrapper-v3.sh#L125
[P3]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3.sh#L210
[P4]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3_impl.py#L30034
[P5]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/backup_r2/uk_aq_apply_generic_v3_proposal.mjs#L27
[P6]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/backup_r2/uk_aq_apply_integrity_proposal.mjs#L1797
[P7]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/uk-aq-history-integrity/bin/integrity/timeseries_binding_provider.py#L538
[P8]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/uk-aq-history-integrity/bin/integrity/exact_v3_verification.mjs#L37
[P9]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/uk-aq-history-integrity/bin/integrity/local_cleanup.py#L176
[P10]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/workers/shared/uk_aq_r2_observations_manifest_hierarchy_finalizer.mjs#L132
[J1]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/jsongen/writer-authentication.mjs#L15
[J2]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/jsongen/prune-outbox-reader.mjs#L56
[J3]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/jsongen/limits.mjs#L4
[J4]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/config/uk_aq_github_env_targets.csv#L17

[P11]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3.py#L1
[P12]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3_impl.py#L14470
[P13]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/backup_r2/uk_aq_apply_integrity_proposal.mjs#L2035
[P14]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3_impl.py#L25712
[P15]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3_impl.py#L26705
[P16]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3_impl.py#L30484
[P17]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3_impl.py#L17576
