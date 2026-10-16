# JSONgen final-authority handover investigation

**Review date:** 17 October 2026. **Scope:** TEST, source inspection only; no runtime implementation or operational acceptance.

## 1. Executive conclusion

**Early immutable PENDING uploads followed by small final-evidence messages are feasible without an additional routine canonical Parquet download, but the current implementation cannot safely make those uploads VERIFIED.** Prune has the complete connector-day rows before publication; fixed-v3 SOS-light has a complete assembled publication graph, including carried-forward baseline observations. Both need a writer-owned, durably retained connection between those rows and the original successful final publication. Neither upload acknowledgment, an invocation success flag, nor an index match supplies that connection.

Prune's main gaps are loss of original status, source cleanup before finalisation, compacted/in-memory publication evidence, and missing durable original gate acceptance. Integrity has stronger retained source/proposal/object/journal evidence, but no accepted complete resolved-view/status export bound to final invocation VERIFY. The fixed-v3 implementation **is available in GitHub**; the installed Pro revision and actual retained run artifacts were not accessible in this investigation. They must not be represented as verified deployed behaviour.

The minimum solution is two bounded writer adapters, one common evidence envelope, independent pending-byte/content/authority verification, and a durable R2 outbox feeding existing control/CAS/reconciliation. No new global event sequence, database, queue or canonical lock is justified. Preserve `selectManagedPublications()`'s protection throughout this work.

### Evidence basis and limits

All repository inspection used the GitHub connector, with files cached only as investigation scratch. No Dropbox repository inspection, LIVE repository access, service tests, workflow dispatch, database execution, historical dataset reads or R2 mutations occurred. A shell GitHub clone failed because its proxy was unreachable; GitHub connector reads remained available.

Pinned snapshots: TEST Ops main `af771b261f187cb09d6bde48175c2a675496c6fd`; system-docs main `c6d2ed60cf33c379ceecfc0e1ebae581bb92014e`; PR #98 head `3baeb033b89fe8ca90eae384afb654486bd5ce56`. A narrow TEST-schema inspection used `2f5b2f6de447b8b3426744ea70ceaf970232d13f`. Applicable root/Prune instructions and the requested documentation routes were read. Additional contracts were limited to Prune safety/source ownership, observation naming/status, Integrity and SOS three-phase authority.

The authoritative [JSONgen contract][contract] and [ingestion amendment][amendment] govern the proposed design; the [12 October plan][plan] is planning context. Their descriptions of #98's transport lag its present head: **#98 is still open, but now uses the signer**, rather than the earlier direct-credential uploader. This discrepancy requires documentation-owner follow-up; no authoritative docs were changed.

Source aliases below identify exact repository paths; `P:2960–3093`, for example, means those lines in the pinned file linked as P. “Fact” describes inspected code, “proposal” describes required future work, and “unknown” means operational evidence was unavailable.

## 2. Prune publication and evidence lifecycle

| Stage / exact function | Available identities and evidence | Lifetime, failure and authority |
|---|---|---|
| Acquire: P `acquireFrozenCompactSource`, 2960–3093 | One connector and UTC day; repeatable-read transaction; metadata RPC plus compact observation cursor; NDJSON path, row/byte counters, expected candidate count; `computePruneConnectorSourceIdentity` | Complete intended snapshot after count/hash validation and transaction commit. Acquisition/caps/budget/mapping failure rolls back and removes temp source. No committed R2 authority yet. |
| Freeze/normalise: P `expandPhaseBCompactSourceRow`, `normalizeFrozenObservationRow`, 2865–2933; H `computePruneConnectorSourceIdentity`, 35–58 | Numeric connector/station/timeseries; pollutant, millisecond UTC timestamp, value, one status field; source hash/version/count | Raw `status` name/provenance is lost. Hash sorts canonical encodings, retaining multiplicity, and includes effective verification status; it is neither NDJSON-byte identity nor final-publication proof. |
| Admission/replay: P `writeFrozenCandidateObservationsToV2`, 3959–4042; G `admitPruneFrozenConnectorSnapshot`, 155–253 | Complete rows reloaded and count/scope checked; existing root/year/month/day/connector/pollutant and exact-v3 authority checked before PUT | Despite its name this selects v3. First publication may proceed. Already committed different **or identical** history is blocked without original-attempt proof. A fresh invocation cannot adopt committed data merely by matching rows. |
| Build Parquet: P `publishFrozenV3Observations`, 3631–3823 → S `buildObservationHistoryV3SteadyStatePartition`, 363–446 → T `buildCanonicalObservationTimeseriesAlignedFiles`, 959 onward | Full day/connector/pollutant rows; canonical content hash/count/status counts; timeseries counts; aligned segments and file-byte SHA-256 intents | Built from the same canonical row projection. Physical sort/segmentation differs from frozen NDJSON order. Source still exists. Intended rows and generated-byte identity are structurally connected, but publication has not completed. |
| Objects/connector/exact scope: O `createObservationHistoryV3CanonicalConnectorPublisher`, 845–1033; S `runObservationHistoryV3ConnectorPublication`, 1024–1362 | Verified file descriptors; pollutant manifests; complete connector child set; connector manifest SHA/size/logical hash; exact/scoped publication results | Parquet checksum PUT/HEAD and JSON readback can fail independently. Prune owns the complete connector snapshot, not changed-only child merging. Connector success is provisional relative to parent/root/latest finalisation. |
| Connector verification: P `verifyObservationConnectorHistory`, 4818–5011 | Reread connector equals writer payload; child hashes/counts/files; each file's stored SHA/size; exact-v3 scoped root readback matches writer evidence | Metadata and object identity verification; no extra observation decoding here. Mandatory comparison remains separate. Immediately afterward P:6879–6900 clears file lists/manifest payloads and deletes frozen source. Only compact evidence remains in memory. |
| Final batch: P `finalizeSelectedObservationRun`, `validatePhaseBV3RunFinalizationResult`, 3840–3957; S `runObservationHistoryV3RunFinalization`, 1518–2030 | Day parents, month/year/root hierarchy, exact scopes and latest/global result; exact affected-day set; parent reread under lock | Finaliser must establish aggregate authority, expected scopes and latest success. A completed connector or day milestone alone is insufficient. Source has already gone; later batches can still occur. |
| Candidate/connector gate: P `finalizePublishedPhaseBConnectors`, 4182–4241; `markCandidateAndConnectorGateComplete`, 2273–2313 | After validated final batch: original run, connector manifest key/hash, counts, source hash/version/count, completion source; candidate gets `PRUNE_FIRST_DELETE_READY:v1` | Candidate/gate update is one PostgreSQL transaction. Per-connector gate failure is distinct from successful R2 finalisation and must remain ineligible. Aggregate day gate is separately maintained; it cannot substitute for or veto an independently valid connector gate. |
| Deletion: D `runPruneConnectorDayDeletionTransaction`, 494–805 | Repeatable-read locked candidate/gate, original READY/run/manifest, current/candidate/gate source identity, whole-connector/day counts and existing comparison requirements | Only existing deletion safety authorises deletion. Failure/partial drain rolls back. Successful drain atomically records CONSUMED and clears gate `history_done`; a later reader cannot require that gate still be true as proof of original acceptance. |
| Cleanup/report: P:2860–2863, 6898–6941; `writeRunManifest`, 6309–6331 | Temp source removed on normal connector completion and failure; later run manifest stores hashed summary and checks existence | No retained observation bundle in main. Run summary/logs are not an immutable detailed source-to-final attestation. Canonical data remains authoritative independently of derived handover. |

**Earliest useful PENDING upload:** after successful acquisition/replay and prior-authority admission, while the frozen complete source still exists, before canonical connector publication. No source reconstructed after cleanup should be called the original frozen snapshot.

**Earliest VERIFIED evidence:** only for connectors in `finalized.completed`, after the entire applicable v3 batch has passed validation **and** their original protected candidate/gate transaction committed. Do not wait for unrelated later batches or aggregate-day gate completion; do not verify a `gate_failures` entry. Capture original gate acceptance before it is consumed, independently of later deletion.

**Evidence retention trap:** O `createR2ReadbackDurabilityRecorder`, 813–843, rereads an object and returns `durable:true`; it does **not** persist an independent receipt. S `buildRunFinalizationEvidence`, 1425–1481, deliberately compacts partitions to scope/scoped-root references and reduces exact results to ok/status. Finalisation returns useful evidence, but it is not retained as a replayable handover attestation. Retain exact manifest/index bytes or immutable references while available; stable canonical keys may later be overwritten.

### PR #98 and execution budget

At the inspected head, `preparePrunePendingSource` / `validatePrunePendingSourceRows` preserve the frozen NDJSON bytes, validate source identity and create deterministic gzip plus compressed/uncompressed SHA/length (Q:12–49). The hook is default-off, v3-only, after admission (QH:4016–4060). `uploadPrunePendingSource` requests a 60-second object-specific signer intent and performs one conditional direct PUT; 2xx means only `put_acknowledged_unverified`, 412 requires reconciliation, and 409/5xx/transport failures are ambiguous (U:87–150). The inactive V `verifyPrunePendingSource` checks bounded stored bytes, decompression, intent identity and source hash; it grants no final authority.

The hook requires publication allowance + v3 finalisation reserve + 15-second optional deadline + 5-second margin. Main's allowances are P:143–168; QH:4017–4023 adds optional headroom. Read/hash/gzip is synchronous within the elapsed deadline (U:87–95), so an abort timer cannot interrupt its CPU work. Retain conservative size/CPU admission and headroom; measure the actual capped preparation cost in later authorised TEST acceptance. Do not add serial source readbacks, confirmation retries or receipt polling to Prune. Independent readback/registration belongs outside its critical path. Upload failure must continue canonical publication and existing cleanup/deletion unchanged.

## 3. Integrity / SOS-light publication and evidence lifecycle

**Located implementation, not a wrapper substitution:** the TEST local dispatcher selects the repository runner; `bin/uk-aq-history-integrity-sos-light-v3.sh`:212–220 fixes v3 and selects its Python entrypoint. That entrypoint executes sibling **`uk-aq-history-integrity-sos-light-v3_impl.py`** (I) at lines 20–29 of the entrypoint. I `run_canonical_apply_executor`, 27644–27773, selects the dedicated SOS bridge for `sos_light` and the generic-v3 bridge for `generic_integrity`. Both are present. The stable-fallback directory, old fixed-v2 runner and future IFW finder are not substitutes. Repository routing proves code selection; it does not prove the installed Pro checkout or scheduler revision.

| Stage / exact function | Verified implementation fact and remaining gap |
|---|---|
| Detection/proposal | I `run_v2_observations_integrity_checks` (12708 onward), complete source-evidence loading/persistence (17565–18090), and `_assert_detector_and_proposal_source_evidence_agree` (19758 onward) retain enumeration, source-file/mapping identities, counts and canonical hashes. These names retain “v2” logical semantics inside fixed-v3 code. Source acquisition/detector input is not necessarily the final preserved publication view. |
| Resolve complete view | I `assemble_sos_light_complete_days`, 24935–25290, combines source-built connector-1 replacement with authoritative pinned Dropbox baseline objects, stages preserved children and resolves complete parent dependencies. Source unavailable is not empty. M `inspectPinnedBaselinePollutantPartition`, 209–280, checks baseline SHA/size and decodes **local** pinned Parquet; M:1160–1223 builds/checks exact-v3 metadata from resolved local rows. This is a usable pre-publication export seam, not a pre-existing NDJSON export. |
| APPLY preparation | I `_require_complete_persisted_file_backed_proposal` (27602–27642) and `run_canonical_apply_executor` require final write-set provenance, exact persisted state, Core identity and transition fingerprint before launching Node. Dedicated bridge `applyValidatedSosLightV3Proposal` validates lock/run, proposal graph and connector gate (SB:46–127). Generic bridge `applyValidatedGenericV3Proposal` explicitly supplies generation=v3, generic freeze and graph validators (GB:28–64). |
| Canonical replacement | A `runPersistedSosLightV3Apply`, 377 onward, freezes the schedule before mutation, performs complete-day deletion/republication, per-object checksum/write/readback, exact-scope removal and the shared publication tail (1014–1129). It explicitly records `canonical_v3_writer_invoked:false` and `frozen_proposal_apply:true` (484–492). Do not mistake `scripts/backup_r2/lib/observation_history_integrity_writer_v3.mjs:259`'s separately exported `runValidatedSosHistoricalReplacementObservationHistoryV3Writer` helper for this active APPLY path. |
| Semantic/physical proof | AP `verifyLiveObservationPartition`, 2500–2640, compares GET-verified published observations to retained immutable source/final-target hashes and manifest hashes/counts. Dedicated SOS consumes its bounded verified GET cache rather than making a second changed-Parquet GET; baseline-carried partitions without source-evidence entries skip this source comparison and rely on pinned proposal/baseline/object identity. A:675–755 retains key/SHA/bytes, operation id, uploaded/skipped disposition, one post-PUT GET and durable evidence. |
| Final invocation VERIFY | I:30361–30420 selects **`summarize_ordered_apply_verification`** (29752–29904) for dedicated SOS, plus final binding verification. Generic fixed-v3 uses **`run_v2_final_verification`** (26657–26968): overlay/tombstone/baseline resolved local checks, persistence checks, binding checks and remote publication/deletion evidence. Dedicated SOS deliberately avoids a second broad R2 scan. Neither is merely an APPLY return. |
| After VERIFY/retention | I:30421–30437 contains the inactive JSONgen marker, before separate current-state reconciliation. It is a comment, not a success guard or emitter. `_verify_sos_light_v3_apply_persistence` (26159–26385) verifies journal byte hash/count/tail chain, operation evidence, completion event and deletion sidecars. Run-state/report/overlay/source evidence can survive; success cleanup removes generated-object duplicates and disposable final-verification view only after reporting (26971–26986, 35840–35860). Files surviving does not by itself authenticate their final membership. |

**Generic Integrity nuance:** AP `loadImmutableSourcePartition`, 1844–2048, reconstructs canonical source rows. Official RData additionally loads pinned `preserved_baseline_rows.json`, verifies final-target counts/hashes and exposes `finalTargetRows`. Export that resolved target where applicable, not `source.rows` alone. Generic selected scopes and dedicated SOS's complete-day graph require different adapters even though their external handover can be identical.

**Upload/verify boundaries:** freeze complete final rows only after assembly and final proposal/transition validation, before first destructive APPLY action; reuse already decoded local rows to avoid another normal readback. Final evidence follows successful real APPLY, the applicable final invocation VERIFY, and binding checks for the complete invocation. Dry-run, planned/no-op, failed or provisional per-day results are ineligible.

**Interruption:** AP `createApplyPersistence`, 591–610, opens `apply-mutation-events.jsonl` with `wx`. Blindly relaunching APPLY in the same run directory is not supported replay; it cannot overwrite that journal. Partial publication and shared-tail failures remain unverified. Preserve the original journal/proposal and pending identity. A newly authorised attempt must revalidate its original/currentness authority and get a distinct attempt identity; equal observation bytes alone cannot transfer final verification between attempts.

## 4. Complete observation-bundle availability and comparison

| Requirement | Prune selected-v3 | Fixed-v3 Integrity / SOS-light |
|---|---|---|
| Complete intended observations | Full frozen connector/day before publication; counts and source hash | Full selected partition target for generic repairs; full assembled day graph for SOS, including carried-forward connectors |
| Added / modified / unchanged | All frozen rows; no changed-only overlay | Include source replacements **and** preserved final rows; assembled baseline objects are essential |
| Removed observations | Initial-publication admission normally prevents historical corrections; do not invent removal events from missing source | Diff authenticated before membership against resolved after membership; omit removed rows and emit explicit zero-row scope records for wholly removed timeseries |
| Authoritative empty | Current frozen acquisition/replay/source hash requires non-empty connector/day; no generic “empty upload” shortcut | Some selected partition empties/removal plans exist. Empty pollutant manifests alone do not enumerate disappeared physical timeseries; retain before member sets |
| Final boundary | Validated complete batch + original connector candidate/gate commit | Complete APPLY/shared tail + applicable final invocation VERIFY/binding |
| Retained proof today | Compact in-memory finalisation evidence, mutable candidate/gate, summary | Pinned proposal/source artifacts, publication descriptors, journal/deletion sidecars, run-state and report; no accepted handover attestation |
| Original status today | One frozen status field; original distinction lost | Raw source status often normalised away; carried-forward Parquet supplies effective status only |
| Minimum adapter | Preserve source/provenance before cleanup; retain original final batch/gate proof | Export exact resolved local proposal/target rows; retain membership/status/binding and bind to final VERIFY |
| Operational unknown | No live Prune timing/gate evidence inspected | Installed TEST Pro revision and successful/failed invocation artifacts unavailable |

Physical bundle unit is connector + station/binding + timeseries + pollutant + UTC day. Preserve canonical timestamps, numerical values and row multiplicity; do not deduplicate or fill hours. Some upstream source adapters already normalise/deduplicate: the handover must reproduce the **accepted canonical final rows**, not reintroduce rejected/raw duplicates.

A proposed exporter should retain the complete containing day/connector/pollutant partition as proof input, even when the eventual chart bundle covers fewer timeseries. Existing partition content hashes are not per-timeseries hashes; one subset's count cannot prove its values or completeness. Compare the entire proof partition to the canonical hash, then partition it losslessly into eligible physical scope records. This avoids adding a new canonical hash layout.

## 5. source_status / verification_status

**Prune fact:** the compact transport returns `status`; the TEST-schema migration defining `uk_aq_phase_b_history_compact_rows_v1` selects `o.status` directly ([schema source][compact]). P:2918–2932 passes it into `normalizeFrozenObservationRow`, which stores it only as `verification_status` (2865–2879). It does not independently preserve raw source status or explain its upstream meaning. Do not infer that `o.status` is always the untouched provider flag.

**Integrity fact:** B:10110–10116 normalises the UK-AIR CSV status cell immediately; B:10444–10448 normalises it again in dedicated acquisition. The canonical rows/evidence later expose only P/R/null. AP:1673–1738 decodes persisted `verification_status` or compatible legacy `status`, then returns canonical rows. I:19965's SQL alias `AS source_status` is only a local decode variable; the returned item retains the physical column name (19988–20004). It does not establish provider provenance.

C `normalizeUkAirVerificationStatus`, 52–58, maps R/ratified to R and everything else to P. `resolveLegacyVerificationStatus`, 66–81, preserves canonical P/R/null but interprets a legacy `status` using connector rules. `preservePersistedRatifiedStatus`, 208–233, may retain R for otherwise identical connector-1 observations. Thus original provider status and effective status are not interchangeable.

C `normalizeCanonicalObservationRow` / `encodeCanonicalObservationRow` (97–153) project seven canonical fields, excluding original status; `computeObservationContentHash` (236–271) authenticates those rows including effective verification status. H uses the same encoding with a different hash-domain prefix. Raw-source, canonical-content and gzip-byte hashes are three different identities. Canonical timestamp handling is exact milliseconds, and the canonical normaliser maps negative zero to zero; the adapter must reproduce accepted canonical semantics while separately retaining original source provenance.

**Minimum proposal:** retain raw status before normalisation with row-level source artifact/mapping provenance, and separately record the exact accepted effective P/R/null decision and any persisted-R precedence. Use a versioned companion provenance object or writer-owned source envelope; pass the existing seven-field projection to canonical writers. Reapply this preservation through frozen replay, acquisition, target assembly and bundle construction. This need not change canonical Parquet bytes, existing hashes or historical writer semantics.

For carried-forward rows, the original provider status may be unrecoverable from the retained canonical Parquet **even if downloaded again**. A null raw status is valid only with proof that the source actually supplied none; it cannot conceal lost provenance. Existing historical inputs with missing original status need explicit fail-closed eligibility or a separately approved provenance policy/recovery decision.

Verification authority also needs an explicit accepted connector mode. J `selectVerificationStatusAuthority`, 89–104, distinguishes embedded schema-3 evidence from accepted schema-4 overlay authority; pointer absence alone establishes neither. Bind to the selected `history/v3/observations`, `history/_index_v3/observations_timeseries` and matching `history/_index_v3/timeseries_binding`, retaining logical v2 semantics.

## 6. Existing proof chain and missing links

Classification: **Proven** = existing implementation establishes the stated limited fact; **Adapter** = structural evidence exists but needs export/validation; **Retain** = additional durable evidence needed; **Read/recover** = unavailable evidence cannot currently be reconstructed from metadata; **Unknown** = operational evidence unavailable.

| Link | Classification | Reason / minimum missing evidence |
|---|---|---|
| A: pending transfer identity | Proven as isolated helper, not active end-to-end | #98 Q/U/V provide gzip/original hashes, lengths, invocation/scoped intent and independent bounded byte verification. PUT acknowledgment alone is not verified retention. Main signer is issuance-only and persists no intent inventory (worker:104–142). |
| A → B: original writer/invocation | Retain | Authenticate producer workload/caller and pin environment, repository revision, run/attempt, proposal/source identity and intent/object. A caller-supplied `ok`, GitHub run result or writable report hash cannot mint authority. |
| Source → intended canonical membership | Adapter | Prune's complete rows and S/T canonical partition hashes; Integrity's resolved local graph/final-target evidence. Compute full-partition hashes from pending proof rows, including counts/status counts, and compare to **original final** canonical manifests. Do not compare H's connector-domain hash directly to C's pollutant-domain hash. |
| Intended rows → final verified C | Retain | Preserve original file SHA/size/write verification, parent/root/exact-index pins and final batch/VERIFY result under a trusted writer attestation. Prune must also retain its original successful gate commit. Current memory/summary or unhashed booleans are insufficient. |
| C → complete physical D | Adapter + Retain | Canonical hierarchy, aligned/exact leaves and timeseries counts exist (J:149–281). Persist authenticated before/after member sets, containing partition hash, binding identities and explicit removed/empty scopes. Never interpret referenced-object 404 as authoritative absence. |
| D → status/binding E | Adapter + Retain; historical raw status may be Read/recover | Applicable embedded-status/overlay and binding metadata are inspectable (J:284–338); original source status is not covered by canonical content hash. Needs separate retained provenance and accepted mode. |
| Original verified publication → current authority | Adapter | J `readCanonicalScopes` checks root/year/month/day/connector/pollutant, aligned/exact files, binding and status metadata and rereads observed metadata for consistency (106–376). It deliberately returns `authority_complete:false`. Add authenticated original writer proof, current-scope comparison and coverage; latest is discovery, never an authentication parent. |
| Receipt → durable eligible register | Retain | K `authenticateFinalPublication` always returns unauthenticated/reconciliation-required. R diagnoses unregistered receipts but proves no complete inventory. L retains receipts as `pending_writer_adapter`; selector stays disabled. |
| Missing full source after deletion/cleanup | Read/recover | Counts, manifests and logs cannot recreate observation values. Only retained authenticated source/bundles can support automatic replay. Otherwise require exceptional separately authorised canonical/source recovery; Parquet may still lack raw status. |
| Installed TEST outcome | Unknown | Need exact deployed Prune/Pro code identity and retained original success/interruption evidence, not assumptions from merge dates or documentation of an earlier successful run. |

A non-circular authority chain is: authenticated original writer execution + complete pending rows/provenance → existing canonical partition hash and verified physical descriptors → original final parent/index/VERIFY and gate evidence → independent current canonical metadata check → immutable verified bundle and receipt. A checksum is one edge, not the chain.

## 7. Failure, retry and recovery

| Case | Existing behaviour / safe disposition | Additional durable requirement |
|---|---|---|
| 1. Upload succeeds; canonical publication fails | Pending remains ineligible. Partial objects or day milestones do not establish authority. | Preserve pending identity and failed attempt; retry only against a newly authenticated successful original attempt. No age-only deletion of unresolved proof. |
| 2. Upload fails; canonical publication succeeds | Canonical finalisation/deletion proceed; Prune temp cleanup and eventual IngestDB deletion can make source unrecoverable. | Record missing handover/unknown freshness in writer inventory. If complete source never became durable, metadata cannot recover it; exceptional operator-authorised bootstrap/reconstruction may be necessary. |
| 3. R2 succeeds; finalisation or gate fails | Failed final batch is ineligible; successful final R2 plus failed PG gate remains blocked. P:4302–4324 records `review_original_publication_evidence_before_gate_only_recovery`; G blocks adoption. | Retain original source/final evidence. Automatic gate-only recovery is currently disabled; do not enable it as incidental JSONgen work or infer acceptance later from current valid manifests. |
| 4. All final checks succeed; final message lost | Existing summaries/journals may aid investigation but no JSONgen outbox exists. Later gate may be consumed. | Immutable final attestation + independently discoverable outbox; retry exact message/receipt idempotently without canonical rerun. Crash before durable final evidence remains unresolved. |
| 5. Prune retries identical observations | H may match, but run id differs. G:245–253 rejects already-committed identical history without original-attempt authority. After CONSUMED, identical reinsertion is blocked. | Reconcile original retained attempt, not a fabricated new success. Preserve immutable bytes and separate run/attempt identity. |
| 6. Prune retries changed observations | Source mismatch invalidates old candidate/gate evidence; already committed different source blocks historical replacement. | New pending digest is a new attempt, never verification for the old bundle. Historical correction requires the authorised Integrity/repair path. |
| 7. Interrupted Integrity APPLY | Some writes/deletions may have occurred; journal/checkpoints retain partial state. Same journal path uses exclusive creation. Final VERIFY cannot be borrowed from a later attempt. | Preserve source/proposal/fingerprint/journal; reviewed writer-owned recovery must revalidate authority. No automatic “resume succeeded” claim or blind APPLY rerun. |
| 8. Later Integrity supersedes verified publication | Canonical same-key parents/indexes can change; old receipt remains historical evidence. | Scope-specific current canonical/status/binding checks. Reject superseded scopes, retain independently current ones. Changed root alone need not supersede unrelated days. |
| 9. Different verified days in one month | Existing CAS prevents control overwrite, but missing receipt coverage still blocks selection. | Coalesce all required current scopes into authenticated monthly baseline; rebase/recompute on CAS/dependency change. Receipt arrival or GitHub finish order cannot drop either correction. |
| 10. PM correction/removal affects next month | F `affectedMonths` (145–159) includes following day for PM. This is planning support, not an implemented generator. | Recompute endpoints through t+23h, authenticate previous-23h context/adjacent JSON and algorithm; select a new paired pubID in the next month if needed even when its visible observations are unchanged. |

The [gate contract][gate] permits narrowly authenticated original-attempt gate-only recovery, but explicitly says implementation is disabled. Retain evidence without implementing that recovery here. JSONgen is never an IngestDB deletion gate and never reverses canonical success.

## 8. Can routine canonical Parquet rereads be avoided?

**Yes, prospectively, for fully retained and independently authenticated handovers.** The independent consumer can read pending NDJSON.gz and bounded canonical **metadata**, recompute the existing canonical full-partition hash and check final physical/index/binding/status descriptors against original writer proof. It need not download/decode canonical observations again.

Integrity already performs local decoding and its required canonical write/readback/semantic checks. Export from those existing row lifetimes; this proposal does not remove or weaken those canonical checks. Preserved baseline rows may require writer-internal local decoding, not a new remote Parquet scan by JSONgen.

No-read operation is **not** guaranteed for existing historical gaps, failed source retention or lost original final evidence. Missing baselines/context fail closed. Exceptional bootstrap/manual recovery can read authorised canonical index_v3 only under separate authorisation. Re-reading Parquet does not repair lost raw provider-status provenance.

## 9. Minimum recommended implementation changes

All items below are proposals, not implemented features.

1. **Writer-owned preparation:** export complete final proof partitions plus physical-day records before cleanup/mutation. Capture original status separately without altering canonical projection; record canonical hash contract, row/member counts and before/after/removal authority. For SOS include baseline-carried rows; for official generic repairs use final targets including preservation.
2. **Immutable pending identity/confirmation:** reuse the existing private bucket, conditional signed PUT and digest-bound key codec. Persist a bounded discoverable pending descriptor/confirmation containing writer/run/attempt, intent, both byte hashes/sizes and proof-scope inventory. Signer stays a small metadata service; independent consumer performs bounded SHA/readback/decompression. Extend writer-specific signer admission for Integrity explicitly; current main accepts Prune only.
3. **Original final evidence:** retain a versioned attestation at the exact success boundary. It binds pending bytes/provenance, complete partition hashes/member inventory, original canonical descriptors/hierarchy/exact index/binding/status pins, code/run identity and final result. Prune includes original protected gate transaction outcome; Integrity includes final VERIFY, proposal fingerprint and journal/deletion evidence identity. Snapshot referenced mutable metadata or retain equivalent immutable proof while the writer still owns its safe lifetime.
4. **Independent authentication:** the small final message supplies attestation and pending references, not trusted booleans. A bounded existing GitHub Actions consumer authenticates permitted writer/invocation and trusted attestation origin, verifies source bytes/provenance and full partition equality, original gate/VERIFY and current canonical scope authority. A bearer token authorises submission; it does not by itself prove the submitted report true. Define the trusted writer-produced artifact/attestation channel and prevent submission credentials from manufacturing accepted evidence.
5. **Complete bundle/receipt:** writer adapter determines resolved rows and scopes; the consumer may mechanically validate/package those declared rows, never reconstruct from SQLite/journals/logs. Emit one complete physical-day record per scope, explicit authoritative empty records where proven, and canonical versus original-status provenance separately.
6. **Durable outbox/registration:** retain immutable verified bundle, attestation and receipt with readback, then idempotently register under existing R2 control/CAS. Use bounded R2 inventories/control references and an optional GitHub reconciler/dispatch. Canonical writers do not await JSONgen generation. Retain outcome/coverage records for successful canonical writes with unavailable handovers; discovering existing pending objects alone cannot detect uploads that never happened.
7. **Lost-message repair:** discover retained attestations/receipts independently of control; replay exact references without canonical rerun. Do not erase unresolved pending/failed evidence by TTL. Where source or original acceptance was never durably retained, report reconcile-required/operator action instead of claiming automatic freshness.
8. **Eligibility, later selection:** only authenticated, durably registered current replacement scopes become workflow inputs. Preserve independent corrections and adjacent PM dependencies; verify immutable observation/AQI pair and CAS selector against fresh dependencies. Keep the present blocker until complete writer coverage, baselines/context, supersession and separately authorised TEST acceptance are established.

### Stage 1 schema compatibility

F `assertReceipt` (161–189) already supports writer/invocation, selected-v3 source references, before/after membership, explicit authoritative empties, complete gzip bundle identity, rolling dependencies, verification/provenance/scope authority references and a retained-receipt authority. It does **not** authenticate them. F `assertBundleRecord` requires both statuses; N `readBundle` deliberately returns `writer_authenticated:false`.

**The smallest candidate preserves the Stage 1 receipt wire shape:** put new versioned attestation/provenance/member-inventory documents behind its existing authority references, while `source.final_publication` pins actual canonical authority. Use `durability.retained_receipt_authority` for a separate pre-retained handoff/outbox attestation, never the receipt's own digest; write the immutable receipt afterward. Existing validators require these references structurally but do not supply their semantics.

There is a concrete namespace constraint: F `inspectSourceGeneration`, 107–127, requires source authority references to the same canonical bucket and selected-v3 namespaces. A final attestation stored only in the derived bucket cannot simply be substituted into `source.final_publication`. Keep canonical references canonical and use `verification.authority` / provenance / completeness / durability references for derived evidence.

Thus **a Stage 1 receipt version bump is not demonstrated necessary**, but an explicit versioned **evidence-document/API schema and adapter validation are necessary**. Define pending intent/reference, canonical projection/provenance identity, proof partition/member inventory, original finalisation/gate/VERIFY and retained acceptance semantics there. If review instead requires those fields inline, use a versioned receipt extension; the exact-field validator cannot silently accept additional fields. Preserve readable old receipts as historical/unverified rather than reinterpret them as authenticated.

Prune and Integrity can share that external envelope and final-evidence API. Their internal acceptance predicates and provenance are writer-specific; the generator should only consume the common authenticated receipt/bundle.

## 10. Genuine blockers requiring further decisions/evidence

- **Original status availability:** approve exact provenance representation and truthful eligibility for preserved/historical rows whose raw provider status was lost. Neither current hashes nor Parquet alone can solve that loss.
- **Trusted final-attestation origin and retention:** choose the concrete authenticated writer-artifact channel, immutable evidence schema and crash boundary. A small endpoint trusting caller `success` is insufficient.
- **Coverage under optional failure:** optional upload can legitimately fail while canonical publication/deletion succeeds. Decide how these holes are surfaced and manually recovered; continuous automatic freshness cannot be promised under that failure model without separately durable source capture. Do not solve this by gating deletion on JSONgen.
- **Installed TEST evidence:** obtain deployed Prune revision and installed Pro selector/runner Git SHA, original run-state/report, frozen proposal/fingerprint, source/acquisition and preservation evidence, publication descriptors, journal/tail/deletion sidecars and final binding/VERIFY output. Include one interrupted case. Prove local retained files correspond to the original committed publication before accepting the adapter.
- **Operational admission:** practical scope/byte/CPU/retention limits, independent confirmation and signer permissions/conditional PUT behaviour require later separately authorised TEST deployment/acceptance. No configuration, deployment or service test is authorised by this report.

No extensive canonical redesign is supported by these findings. Current metadata/CAS is adequate structure for the intended bounded approach; missing proof and coverage, not lack of a global numeric ordering scheme, are the blockers.

## 11. Proposed implementation order and explicit answer

1. Review source-status provenance and the non-circular versioned evidence schema; map it into Stage 1 references.
2. Reconcile/review #98's **current signed** uploader, bounds and confirmation inventory; keep it disabled.
3. Add Prune source/provenance preservation and original batch/gate attestation/outbox, preserving deletion semantics.
4. Add independent bounded authentication, receipt retention/replay and coverage diagnostics; keep monthly selection disabled.
5. Add fixed-v3 generic/SOS resolved-view adapters and validate installed TEST evidence against their actual final VERIFY branches.
6. After separately authorised deployment, perform bounded real TEST transport/timing/crash/gate acceptance.
7. Implement/accept authenticated monthly baselines/context, coalescing, paired generation and CAS; only then consider opt-in selection.

**Answer:** We can reliably implement early PENDING uploads and a small final VERIFIED-evidence message without routine canonical Parquet rereads **for handovers with complete retained source/status/provenance and independently authenticated original final publication**. **We cannot safely enable that with today's evidence alone.** Prune needs durable source-to-batch-and-original-gate evidence before cleanup/deletion makes recovery impossible. Fixed-v3 Integrity/SOS-light already retains richer proposal/publication/journal evidence and complete local view components, but needs a resolved-view/status adapter bound to the correct final invocation VERIFY and confirmation of the installed TEST version. Missing source/provenance or lost original acceptance remains an explicit recovery hole, never permission to publish unverified monthly JSON.

## Source map

All Ops paths below are relative to `TEST-uk-aq/uk-aq-ops` at the pinned main commit unless explicitly labelled #98.

| Alias | Exact implementation path |
|---|---|
| [P][prune] | `workers/uk_aq_prune_daily/phase_b_history_r2.mjs` |
| [G][guard] / [D][deletion] | `workers/uk_aq_prune_daily/committed_history_guard.mjs` / `source_identity_deletion.mjs` |
| [H][sourcehash] / [C][contenthash] | `workers/shared/uk_aq_prune_connector_source_identity.mjs` / `uk_aq_observation_content_hash.mjs` |
| [O][operational] / [S][steady] / [T][target] | `workers/shared/uk_aq_observation_history_operational_writer_v3.mjs` / `uk_aq_observation_history_steady_state_writer_v3.mjs` / `uk_aq_observation_history_target_writer.mjs` |
| [I][integrity] | `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3_impl.py` |
| [M][metadata] | `scripts/backup_r2/uk_aq_plan_sos_light_v3_observation_metadata.mjs` |
| [SB][sosbridge] / [GB][genericbridge] | `scripts/backup_r2/uk_aq_apply_sos_light_v3_proposal.mjs` / `uk_aq_apply_generic_v3_proposal.mjs` |
| [A][apply] / [AP][applyshared] | `scripts/backup_r2/lib/sos_light_v3_apply_persistence.mjs` / `scripts/backup_r2/uk_aq_apply_integrity_proposal.mjs` |
| [B][backfill] | `workers/uk_aq_backfill_local/run_job.ts` |
| [F][schema] / [N][inputs] / [J][authority] | `scripts/jsongen/schema.mjs` / `inputs.mjs` / `authority.mjs` |
| [K][authentication] / [R][reconcile] / [L][control] | `scripts/jsongen/writer-authentication.mjs` / `reconcile.mjs` / `control.mjs` |
| [Q][pending] / [U][upload] / [V][pendingverify] / [QH][pendinghook] (#98) | `scripts/jsongen/prune-pending-source.mjs` / `prune-signed-upload.mjs` / `prune-pending-verification.mjs` / `workers/uk_aq_prune_daily/phase_b_history_r2.mjs` |

[prune]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/af771b261f187cb09d6bde48175c2a675496c6fd/workers/uk_aq_prune_daily/phase_b_history_r2.mjs
[guard]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/af771b261f187cb09d6bde48175c2a675496c6fd/workers/uk_aq_prune_daily/committed_history_guard.mjs
[deletion]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/af771b261f187cb09d6bde48175c2a675496c6fd/workers/uk_aq_prune_daily/source_identity_deletion.mjs
[sourcehash]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/af771b261f187cb09d6bde48175c2a675496c6fd/workers/shared/uk_aq_prune_connector_source_identity.mjs
[contenthash]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/af771b261f187cb09d6bde48175c2a675496c6fd/workers/shared/uk_aq_observation_content_hash.mjs
[operational]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/af771b261f187cb09d6bde48175c2a675496c6fd/workers/shared/uk_aq_observation_history_operational_writer_v3.mjs
[steady]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/af771b261f187cb09d6bde48175c2a675496c6fd/workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs
[target]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/af771b261f187cb09d6bde48175c2a675496c6fd/workers/shared/uk_aq_observation_history_target_writer.mjs
[integrity]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/af771b261f187cb09d6bde48175c2a675496c6fd/scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3_impl.py
[metadata]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/af771b261f187cb09d6bde48175c2a675496c6fd/scripts/backup_r2/uk_aq_plan_sos_light_v3_observation_metadata.mjs
[sosbridge]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/af771b261f187cb09d6bde48175c2a675496c6fd/scripts/backup_r2/uk_aq_apply_sos_light_v3_proposal.mjs
[genericbridge]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/af771b261f187cb09d6bde48175c2a675496c6fd/scripts/backup_r2/uk_aq_apply_generic_v3_proposal.mjs
[apply]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/af771b261f187cb09d6bde48175c2a675496c6fd/scripts/backup_r2/lib/sos_light_v3_apply_persistence.mjs
[applyshared]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/af771b261f187cb09d6bde48175c2a675496c6fd/scripts/backup_r2/uk_aq_apply_integrity_proposal.mjs
[backfill]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/af771b261f187cb09d6bde48175c2a675496c6fd/workers/uk_aq_backfill_local/run_job.ts
[schema]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/af771b261f187cb09d6bde48175c2a675496c6fd/scripts/jsongen/schema.mjs
[inputs]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/af771b261f187cb09d6bde48175c2a675496c6fd/scripts/jsongen/inputs.mjs
[authority]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/af771b261f187cb09d6bde48175c2a675496c6fd/scripts/jsongen/authority.mjs
[authentication]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/af771b261f187cb09d6bde48175c2a675496c6fd/scripts/jsongen/writer-authentication.mjs
[reconcile]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/af771b261f187cb09d6bde48175c2a675496c6fd/scripts/jsongen/reconcile.mjs
[control]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/af771b261f187cb09d6bde48175c2a675496c6fd/scripts/jsongen/control.mjs
[pending]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/3baeb033b89fe8ca90eae384afb654486bd5ce56/scripts/jsongen/prune-pending-source.mjs
[upload]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/3baeb033b89fe8ca90eae384afb654486bd5ce56/scripts/jsongen/prune-signed-upload.mjs
[pendingverify]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/3baeb033b89fe8ca90eae384afb654486bd5ce56/scripts/jsongen/prune-pending-verification.mjs
[pendinghook]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/3baeb033b89fe8ca90eae384afb654486bd5ce56/workers/uk_aq_prune_daily/phase_b_history_r2.mjs
[contract]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/c6d2ed60cf33c379ceecfc0e1ebae581bb92014e/system_docs/station_charts/compressed_history_json_verified_writer_regeneration_contract.md
[amendment]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/c6d2ed60cf33c379ceecfc0e1ebae581bb92014e/system_docs/station_charts/compressed_history_json_presigned_ingestion_amendment.md
[plan]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/c6d2ed60cf33c379ceecfc0e1ebae581bb92014e/plans/2026-10-12%20JSONgen%20Presigned%20Upload%20Handover/PLAN.md
[gate]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/c6d2ed60cf33c379ceecfc0e1ebae581bb92014e/system_docs/r2_history/prune_connector_day_gate.md
[compact]: https://github.com/TEST-uk-aq/uk-aq-schema/blob/2f5b2f6de447b8b3426744ea70ceaf970232d13f/schemas/migrations/20260811_001_ingest_phase_b_compact_source_transport.sql#L45-L72
