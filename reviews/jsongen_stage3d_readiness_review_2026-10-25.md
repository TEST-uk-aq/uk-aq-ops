# UK AQ JSONgen Stage 3D architecture and readiness review — 25 October 2026

**NON-AUTHORITATIVE REVIEW AND CONDITIONAL TEST PLAN.** This document proposes no immediate runtime activation. Active system_docs contracts remain authoritative. No application code, schema, configuration, workflow or authoritative documentation is changed by this review. Implementation, deployment and real operations require separate authorisation.

## 1. Executive assessment and evidence boundary

**Confirmed:** the accepted boundary is independent original-event authentication, immutable selected retention and atomic event registration for two genuine AURN first publications, followed by seven bounded, separate metadata inspections. Stage 3D is **not ready for publication enablement**. Current code deliberately reports unknown writer coverage/freshness and disables monthly selection. Original authenticity, current metadata agreement, complete writer coverage, authenticated supersession and publication eligibility are different claims. [D1] [O1] [O2]

**Recommended:** first implement one small, truthful Integrity v3 final-view handover and its independent consumer, with selection still disabled. Separately design a writer-owned, scope-bound canonical publication inventory and immutable checkpoint. Reuse existing finalisation, the shared observation-operation lock, private derived R2 retention and strong-ETag CAS. Do not treat a larger inspector, a new event counter, an optional outbox or metadata rechecks as the missing authority. A complete authority solution needs a new canonical provenance invariant; that contract decision is an explicit prerequisite, not an existing capability.

### Evidence labels

- **Confirmed** means directly established by inspected, pinned TEST source/contracts. Where the fact concerns operations, it means the authoritative documentation records the stated acceptance, with its original evidence qualification; it does not mean this reviewer repeated the operation.
- **Inferred** means an engineering conclusion or proposed design derived from that evidence. Proposed interfaces, limits and phases below are recommendations, not approved contracts or implemented mechanisms.
- **Unknown** means installed/deployed state, private evidence, completeness or performance could not be independently established here. Unknown is a publication blocker when required authority depends on it.

### Reviewed snapshots and access

| TEST repository | Pinned main commit | Use |
| --- | --- | --- |
| uk-aq-ops | 0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8 | JSONgen, writer/finaliser, lock, configuration and workflow source |
| uk-aq-system-docs | 4addadb675c6fd7082ee3b1544a06381216e9ed9 | Read-only authoritative routing/contracts and dated operational statements |
| uk-aq-schema | 74d673f186172c8574b118ccc370d921e9939de1 | Existing Prune acceptance, reader and canonical SQL ownership |
| uk-aq-integrity-factory | 22eb343583c96cea4253c6005e4da4f66a4d5add | Bounded check of current IFW source/control versus repair ownership |

The workspace Ops and System Docs checkouts were older than these heads. Shell GitHub fetch failed because the managed proxy was unreachable. Current source was therefore read through the GitHub connector at the pinned commits; conclusions do not rely on missing files in the stale checkouts. No LIVE repository was read. No database, R2, Dropbox, installed Pro runner, private reconciliation report or cloud credential value was inspected. Environment status supplied no configured cloud credentials/outbound identities; its network policy state was unknown. GitHub source access worked through the connector.

### Accepted operational baseline, carried forward exactly

| UTC event day | Original scopes / observations | Selected PM2.5, PM10, NO2 scopes / observations |
| --- | --- | --- |
| 2026-10-15 | 940 / 22,540 | 433 / 10,382 |
| 2026-10-17 | 919 / 19,301 | 433 / 9,496 |

**Confirmed as documented/operator-reported:** each original contains 37 pollutants. The 34 unsupported pollutants remain authenticated and accounted for. The combined selected set is 866 distinct day-scopes / 19,878 observations. Seven read-only invocations inspected 128, 128, 128, 128, 128, 128 and 98 scopes, with all reported original-authenticated, fully inspected, matching current metadata and read_consistent=true. Local cross-report checks reportedly established identical exact-read managed control, identical partition manifest/scope-set identity and disjoint complete coverage. The private reports were **not supplied or independently examined**. Their new exact control SHA/revision is not asserted. [D1]

**Confirmed limit:** these are seven source-as-of observations, not one coherent canonical snapshot or an all-writer completeness/freshness proof. The 16 October event remains no_intent / not_captured: no retrospective original-source reconstruction or VERIFIED classification is permitted. Keep Prune scheduling, monthly selection, automatic processing and default chart switching disabled. Existing future monthly-baseline, adjacent-month PM context, paired UUID pubID and selector-CAS gates remain outside this review's implementation recommendation. [D1] [D2]

## 2. Writer coverage and actual completion boundaries

### Coverage matrix

| Writer / authority | Actual final boundary and durable evidence | Independent JSONgen authority today | Missing authority / operational qualification |
| --- | --- | --- | --- |
| Prune Daily v3 | Whole applicable UTC-day batch finalisation validated in finalizePublishedPhaseBConnectors; then original matched candidate/connector gate transaction, optional outbox insert and acknowledged COMMIT. Frozen source, private pending gzip, original before/binding/final metadata bundle and immutable PostgreSQL outbox are retained where capture succeeded. | **Confirmed:** independent restricted original-outbox SELECT plus exact retained source/evidence authentication; first publication, connector 1, schema-3 effective P/R/null only. Selected descriptor/receipts and complete-event CAS have the two documented accepted events. | **Confirmed:** optional evidence may fail while canonical publication/deletion succeeds; AURN-only handover is not inventory of all Prune publications. Previous-present replacement, removals and overlay authority cannot be minted by this adapter. No complete canonical inventory/fence. [O3] [O4] [O5] [D3] |
| Generic Integrity v3 | Fixed-v3 Python coordinator invokes the generic Node APPLY bridge, then run_v2_final_verification over its resolved final local view, persisted APPLY/GET/delete evidence, source comparisons and binding checks. Accept only successful non-dry-run final invocation verification after required parents/indexes. | **Confirmed:** blocked adapter in writer-authentication.mjs. Writer-internal frozen source partitions, staged objects, tombstones, dependency/provenance graph, journal and final report exist in source. **Unknown:** exact installed TEST Pro version and surviving original final-source/effective-status closure. | No writer-owned exported independently authenticatable final handover, durable JSONgen completion inventory or missing-handover census. Canonical acceptance of a repair is not acceptance of a JSONgen handover. The scoped WAQN December 2025 acceptance recorded in the R2 router must not be extended to SAQN, all sources or JSONgen. [O1] [O6] [O7] [D4] |
| SOS-light v3 | Dedicated fixed-v3 APPLY publishes frozen complete selected days and then shared index tail; Python summarize_ordered_apply_verification authenticates persisted ordered single-logical-GET evidence and deletions, followed by binding checks. The inactive JSONGEN marker follows final verification. | **Confirmed:** no pending-source exporter, JSONgen verified receipt, independent source/status/binding consumer or complete inventory is emitted at that marker. Full-day proposal and preserved baseline rows are writer inputs, not JSONgen source authority. | Must authenticate the complete final day, including untouched/preserved connectors/pollutants, exact removed membership and all shared-tail success. Installed runner and retained 8 October evidence are documented historically but **unknown to this reviewer**. A successful early day is not final invocation acceptance. [O8] [O9] [D5] |
| IFW | **Confirmed:** current repository implements a manual Nodes source-refresh/read-only finder slice: immutable source generation G, D1 run/work/attempt/authority/finding records and run-lock coordination. It has no accepted canonical repair-finalisation path. | None. Source refresh, finder success, D1 finding or Warehouse history is not verified canonical mutation. | Canonical repair/VERIFY implementation, complete source/removal handover, durable publication inventory and independent consumer all remain future. README provisioning statements are historical, not fresh deployment inspection. IFW's existing source-generation identity and D1 atomic work transitions can be reused later, not substituted for repair authority. [F1] [F2] [D6] |

### Prune details and preserved deletion guarantees

**Confirmed:** the v3 finalisation validator requires canonical aggregate authority, parent re-read under lock, exact-scope completion and latest/global completion. Optional evidence assembly/upload/readback is outside and before the protected gate transaction. Its INSERT is SAVEPOINT-isolated; recognised optional failure can leave a valid committed gate without an outbox. COMMIT ambiguity is not acknowledged gate success; a later original committed SELECT can recover an existing immutable record. Current mutable READY/CONSUMED gate state is not a replacement for the immutable original outbox. [O3] [O4] [D3]

**Confirmed:** the consumer authenticates all original pollutants before selected planning. It binds private gzip hashes/lengths and original complete source/status, root-to-connector-to-pollutant publication, exact scope membership, original first-publication absence, binding closure and original finalisation to the committed event. Capabilities are invocation-local WeakMap tokens; a caller's success flag, valid-looking receipt or matching digest cannot authenticate the originating writer. [O5] [O10]

**Confirmed:** retain mode conditionally writes and reads back the descriptor and every selected bundle/receipt before one whole-event control CAS. Interruption can leave immutable unregistered objects, recoverable by deterministic original-event replay. Ambiguous CAS reads authoritative current control and can confirm the same event in a newer revision. Preserve these properties when paging control; do not replace atomic group registration with page-by-page visibility. [O11] [O12]

**Inferred:** all Prune publishers need inventory accounting, including connectors outside the current selected policy and successful gates with unavailable optional evidence. A writer census must distinguish canonical publication, original gate acceptance, source handover availability and derived registration. Making the optional outbox mandatory would contradict the accepted best-effort policy and must be rejected.

### Integrity routing correction and source boundary

**Confirmed source discrepancy:** WRITER_SEAMS.integrity_v3 names bin/uk-aq-history-integrity_impl.py, whose CURRENT_INTEGRITY_HISTORY_VERSION is v2. Actual fixed-v3 generic and dedicated SOS execution routes are in bin/uk-aq-history-integrity-sos-light-v3_impl.py, whose version is v3. run_canonical_apply_executor selects uk_aq_apply_generic_v3_proposal.mjs or uk_aq_apply_sos_light_v3_proposal.mjs from execution_path. The diagnostic also simplifies dedicated SOS verification to run_v2_final_verification, although that branch uses summarize_ordered_apply_verification. These strings currently grant no authority, but copying them into an implementation plan would target the wrong hook. [O1] [O6] [O8] [O13]

**Confirmed:** loadImmutableSourcePartition validates original writer-owned source evidence, complete enumeration, row bytes/counts/hashes and selected ownership. The final generic view resolves validated overlay, tombstones and pinned Dropbox baseline; dedicated SOS verifies frozen ordered publication evidence. Neither a source-only partition nor a deletion sidecar alone proves every final physical-timeseries/day replacement. Whole-day preservation can force republication of byte-identical baseline objects; final staged ownership must reflect that promotion. [O7] [O8] [D7]

**Inferred minimum adapter:** while original source and resolved final rows are still legitimately present inside that writer invocation, package a bounded complete replacement/removal bundle and original provenance; only successful final invocation VERIFY may attest it. Capture/export belongs to the writer. JSONgen must not decode SQLite, logs, raw overlays, Dropbox or canonical Parquet to infer missing original evidence. Existing local audits/journals can support writer implementation investigation and recovery of already retained proof; they are not a new external source interface. Historical repairs without that original closure stay unavailable. [D2]

### Additional mutators and exclusions

**Confirmed:** the four WRITER_SEAMS entries are not an exhaustive canonical writer registry:

- The dedicated UK-AIR Black Carbon writer is documented as accepted for controlled TEST writes on 24 September. Its protected reconciler uses the shared v3 selected-scope writer, explicit removals and aggregate/index verification; it also classifies unchanged no-op scopes. It owns bc/uv370, outside today's selected PM2.5/PM10/NO2 policy, but can advance shared parents. Include it in the canonical writer census, or prove scope-disjoint exclusion. Shared-root drift from this writer is not automatic supersession of AURN. No JSONgen handover for it is established. [O14] [D8]
- Core/binding publication and standalone hierarchy refresh join the same observation global lock through observation_binding_publication_lock.mjs. Their completed binding/source/refresh identities can invalidate selected JSONgen authority without replacing measurement rows. Include this authority owner in checkpoints and dependency invalidation. [O15]
- Migration, explicit maintenance, restore and supported backfill are mutation classes under canonical ownership. A roster must explicitly admit or exclude them for the covered epoch/scope. A configuration claim that they are disabled is not independent proof of absence; unknown participation prevents completeness. The normal Dropbox backup is a coordinated baseline publisher, not a new original observation writer. [D9]
- Future verification-overlay publishers can change effective P/R without changing observation bytes. They require a separate authority inventory/transition seam before acceptance; IFW activation or any newly introduced writer invalidates an older closed writer roster until re-admitted. [D10]

**Confirmed documentation discrepancy:** the general selected-scope-removal contract still labels the mechanism future, whereas the current Black Carbon contract calls its shared capability active and describes controlled TEST acceptance. Source contains the explicit shared removal path. Do not infer universal generic/SOS JSONgen removal acceptance from either statement. Hand the status discrepancy to the documentation owner; retain source-specific admission and real removal acceptance gates. [D8] [D11] [O16]

## 3. Supersession authority

### What exists

**Confirmed:** currentness.mjs has a conservative candidate comparison: another independently authenticated event must have the same physical scope, exact later.before equal to earlier.after, a different original event ID, and a final scope matching inspected canonical metadata. Multiple candidates are contradictory. Today only AURN first-publication adapters authenticate, so this cannot establish replacement of a previously present scope. Coverage/freshness remain unknown even if a candidate matches. Original receipts remain valid historical evidence after current state changes. [O2] [O10]

### Required replacement/removal proof — proposed, not implemented

**Inferred:** a common versioned writer handover should commit to:

1. Explicit configured environment, selected complete-v3 generation, writer/build/run/attempt and stable event identity; typed writer-owned original completion authority, not a self-declared boolean.
2. Exact selected DCP and physical-timeseries/day before and after membership. Include the union of prior and final physical scopes, not merely the physical series still present after repair. An entire omitted series otherwise disappears from the handover.
3. Before authority captured under canonical ownership; a link to the previous committed per-scope publication identity and exact content/status/binding dependencies. Link scope authority, not only broad root bytes that also change for unrelated days.
4. Complete final observation rows for present scopes, preserving multiplicity, canonical millisecond timestamps, IEEE-754 values, effective P/R/null and authenticated raw-source status or explicitly unavailable provenance. Missing raw provenance may be legitimate; unknown effective canonical status is not.
5. Explicit authoritative-empty/removal records with source absence semantics, complete former membership, writer-authorised removal set and final parent/index non-membership. A referenced-object 404, absent handover or unavailable provider file is not a removal.
6. Final verified canonical root/child/exact/scoped/aligned references, physical/hash-contract versions, completed binding authority and applicable verification authority, all bound to the same final writer result.
7. Immutable compressed/uncompressed bundle lengths/digests, completeness counts/digests, final verification evidence and original authority lookup. Retention and replay identity must be independent of receipt arrival time.

**Inferred:** predecessor links are useful evidence, but current committed canonical scope authority decides dominance. Walk a bounded authenticated A→B→C chain when available; do not classify A current because B arrived late or is absent from registration. Missing links leave reconciliation required. A complete accepted later state may support a separately defined checkpoint/bootstrap boundary, but must not retrospectively manufacture a missing original event. Do not introduce a numerical cross-writer sequence as authority. [D2]

| Case | Required treatment / unresolved risk |
| --- | --- |
| Replacement and removal in one event | Authenticate both sets as one complete declared event; reject duplicates, overlaps or an undeclared omitted prior series. Preserve unrelated children. |
| Source absent/unavailable | Follow source-specific preservation versus authoritative-no-data semantics. Missing RData file/column or temporary BC gap cannot be converted into an empty replacement. |
| Different roots, identical selected data | Inspect scope-specific measurement/status/binding authority; unrelated parent publication is not a selected replacement. |
| Two different successors of one before identity | Contradiction until current canonical authority and accepted predecessor evidence resolve it. No last-arrival-wins rule. |
| Missing, late or out-of-order handover | Record missing coverage; retry only deterministic retained-proof replay with bounded work. A delayed stale event remains historical and cannot override current authority. |
| ABA: A bytes → B → A bytes | Identical endpoint hashes cannot exclude intervening mutations. Require non-reused canonical publication identities and complete applicable inventory, or keep freshness unknown. |
| Interrupted upload / registration | Conditional immutable object writes, exact readback, one complete-event visibility change; reconcile ambiguous outcomes by identity. Preserve incomplete/unregistered objects. |
| Partial or failed canonical APPLY | Never final-VERIFIED from an early day or local success flag. Account for unresolved published children/parents and block a fresh checkpoint until canonical recovery establishes a valid boundary. |

### Status-only and schema-4 changes

**Confirmed:** current Prune authentication only admits schema-3 embedded effective status. Stage 3C can parse physical schema identities but has no accepted overlay transition adapter; seeing latest or passing a caller mode string does not grant transition acceptance. [O5] [O17]

**Confirmed contract:** future schema 4 is measurement-only, six columns, writer parquet-wasm-zstd-v4 and measurement-hash contract v2; it is not history generation v4. Existing status-inclusive v1 identities keep their meaning. An accepted connector overlay overrides legacy embedded schema-3 status; immutable connector manifests publish before verification latest, and mixed schema-3/4 scopes must remain supported. Verification latest is an authority selector; observation latest is discovery metadata, not a root authentication parent. [D10]

**Inferred:** initially keep Stage 3D limited to accepted schema-3 source cases. Later add explicit connector transition acceptance, selected immutable overlay manifest, exact periods/default/null semantics and independent verification-only events. Checkpoint identity must include measurement, status and binding frontiers separately. A status-only update must invalidate the relevant derived dependencies even when measurement hashes and exact leaves are unchanged. Never compare hash-v1 and hash-v2 strings as if they have identical fields.

## 4. Completeness, freshness and coherent snapshots

### What the current inspector actually proves

**Confirmed:** authority.mjs follows root/year/month/day/connector/pollutant membership, authenticates exact/scoped/aligned metadata against the canonical pollutant, validates physical members/counts and completed binding source/root/ranges, and inspects applicable verification authority. Missing child membership in a validated complete parent can establish current metadata absence; a referenced 404 remains an error. Shared first-read cache, all observed-object/404 rechecks and a closing root read support read_consistent for the selected bounded pass. No canonical observation Parquet is read. [O17]

**Confirmed:** its source_as_of explicitly says no transaction/lock, no completeness fence and possible intervening-writer/ABA escape. Rechecking every object is stronger than rechecking only a root, but remains a sequence of endpoint reads. Neither an unchanged root, lock nonce, physical digest, time, managed-control revision nor seven matching partition manifests establishes an all-writer snapshot. [O17] [O18]

**Confirmed:** the global lock is exclusive, session-level and database-local, with bounded acquisition and fail-closed session loss. It is not durable inventory, a read transaction, a freshness lease or a cross-R2/PostgreSQL commit protocol. Writers can leave new children under an older parent when they fail. JSONgen must not acquire this lock or make canonical writers wait for derived calculation/publication. Generation v3 selects a namespace; it is not an ever-advancing publication fence. Existing migration evidence and backup-root equality are narrower authorities with their own meanings. [D9] [D2] [O19]

### Minimum authority properties for a new checkpoint

**Inferred:** a useful writer-owned checkpoint C must authenticate all of the following, with a declared finite scope and covered epoch:

- A closed applicable writer/authority roster, its admitted code/configuration identities and effective scope rules; explicit unknown/missing participants and outstanding partial publications.
- Immutable paged inventory roots for every applicable completed canonical publication, including unavailable/failed handovers. Inventory completeness is distinct from receipt completeness and from possessing full replacement data.
- Exact per-scope current authority and non-reused publication identity, with authenticated before/after links, removals, measurement/status/binding frontiers and complete scope membership/count/digest.
- A real canonical-owner capture boundary. Selected metadata and every authority frontier must be stable together, or provide an explicitly validated compatible vector. Observation-global ownership alone must not be presumed to cover every future independent overlay publisher.
- Exact immutable metadata bodies/pages required for later partition inspection. Mutable canonical paths with stored hashes are insufficient if later overwrites make the old bodies unavailable.
- A complete partition directory, covered scope-set identity and source-as-of identity. Every continuation and aggregate report must name the same C. Never combine pages from different C values.

**Critical gap, inferred from confirmed contracts:** a best-effort post-verification outbox alone cannot establish complete inventory. A canonical writer may succeed without it. A writer may also start and fail between snapshot reads, or complete A→B→A without a visible hash change. A post-hoc assertion that all known receipts were read cannot repair this gap.

Consequently, **a durable writer-owned provenance identity must be inseparable from mandatory canonical publication metadata, or an equivalent independently accepted canonical publication witness must exist**. For example, a non-reused opaque publication ID plus authenticated predecessor and handover-availability descriptor could participate in already mandatory canonical manifest/index publication and hash propagation. This is a proposed contract extension, **not a field that can simply be added today**. Missing derived evidence must be representable as unavailable without making canonical success depend on the derived service. No new pre-change JSONgen reservation/fence, global numeric counter or mandatory derived acknowledgement is proposed.

If this witness cannot be placed without weakening canonical publication/deletion guarantees, **do not implement a freshness-positive result**. Continue bounded diagnostics with unknown coverage; stage the exporter work independently. Approval of the general architecture is not proof that a particular insertion point is structurally safe.

An epoch cut-in cannot erase earlier gaps. Its initial scope map can pin current metadata, but cannot certify missing historical originals or make an incomplete month an authenticated baseline. Explicitly distinguish inventory completeness since the admitted boundary from original-history completeness; the unavailable 16 October handover remains unavailable across any new epoch.

### Two viable approaches and trade-offs

| Approach | Mechanism and required changes | Benefits | Costs / constraints |
| --- | --- | --- | --- |
| **A. Writer-owned R2 inventory and immutable checkpoint — recommended target** | After canonical verification, writer-owned finalisation retains immutable publication descriptors/inventory pages and publishes a small authenticated checkpoint pointer last. Canonical metadata carries a non-reused scope publication witness through mandatory publication, so unavailable optional handovers remain detectably unavailable. An existing lock-owning canonical operation can capture a bounded scope checkpoint; JSONgen only reads it. | Reuses canonical finalisers, JSON metadata/hash validation, private immutable R2 bundles and conditional publication. No general all-writer application DB dependency. Immutable pages let independent 128-scope passes share one real source-as-of. | Requires an explicit canonical provenance/retention contract and every applicable writer's participation. Inventory/checkpoint outages give missing authority, not eligibility. Token insertion/hash propagation and atomicity limits need targeted structural resolution. Do not retain whole-archive metadata under a long new lock. |
| **B. Restricted writer-owned database ledger plus R2 witnesses and checkpoint vector** | Canonical writers record immutable completed publications/missing handovers in a restricted ledger; a canonical owner under the existing lock authenticates a scope-bound ledger snapshot and observation/status/binding vector, retaining immutable R2 pages. Mandatory canonical publication witnesses still detect the R2→DB failure window. | Natural bounded queries, durable indexes, original authority lookups and missing-registration reconciliation; Prune already has a PostgreSQL original-acceptance pattern and IFW has D1 control transactions. | R2 and PostgreSQL/D1 are not one transaction. A ledger row alone never closes that gap; all writers need restricted access, ownership and deployment changes. IFW D1 belongs to IFW and must not silently become global canonical authority. New canonical SQL owner/migration/grants or IFW control contracts are needed. |

**Inferred:** both approaches are viable designs only with the canonical witness invariant and accepted failure/recovery semantics. Approach A minimises new cross-system credentials and schema ownership, so prefer it for a bounded TEST checkpoint after the exporter seam is established. Approach B is reasonable if operators deliberately choose a shared publication ledger and accept its database coupling; it is not a small extension to the AURN outbox. A full immutable canonical-generation/MVCC redesign could also provide durable snapshots, but changes publication/deletion/storage topology much more widely and is disproportionate to this stage.

**Rejected as authority:** larger timeouts/caps; parallel unrestricted scans; discovery timestamps/SQL insertion order; a new numeric cross-writer sequence alone; GitHub job order; treating observation latest as an authentication parent; taking the observation lock inside JSONgen; or introducing pre-change derived reservations. A post-finalisation optional pointer with no canonical witness also fails ABA and missing-publication detection. Pure per-writer vector reads without a common authenticated capture boundary cannot justify cross-writer coherence.

### Concurrency and permitted freshness claim

**Inferred:** immutable checkpoint C makes a coherent **source-as-of-C** claim possible across many bounded invocations even after writers advance. It does not make C instantaneously current. A later checkpoint invalidates currentness claims for affected scopes, while retained C and original receipts stay historical evidence. If the new inventory/frontier cannot be read, result is unavailable/unknown, not unchanged.

A selector in a later separately authorised stage must revalidate the chosen complete scope frontier and desired changes, then use derived CAS with stale-candidate rejection/rebase. A canonical writer can still advance after that check and before the derived CAS, because there is no pre-change fence and the generator does not own the canonical lock. Thus the defensible claim is coherent verified source-as-of with explicit pending/unknown freshness, not atomic latest-canonical-at-selection. Stronger instantaneous freshness would require a different cross-domain coordination contract, which this review does not recommend.

## 5. Scalability and resource risks

**Confirmed budgets:** [O20] [O18] [O11]

| Boundary | Current limit / implication |
| --- | --- |
| Combined inspector scope accounting | At most 1,024 distinct physical day-scopes across requested/registered/discovered input; only one deterministic partition of at most 128 is inspected. CLI partition indices are 0–7. Passing a smaller scopes file does not avoid all-control admission. |
| Receipt / event references | 32 retained, registered and combined receipt references; authenticated event references are also bounded. One selected 433-scope event currently has six pollutant-separated receipt partitions, not merely ceil(433/128)=4. |
| Inspector | 60 seconds, four metadata readers, 8 MiB shared metadata cache, 64 MiB charged total, bounded cancellation/draining, 4 MiB wire report. |
| Metadata GETs | Ordinary budget is 256. Inspector ceiling is 2×(13×128+4)+1 = 3,337, further reduced to the actual deduplicated key plan including rechecks and closing root. Different selected layouts have different cost. |
| Original handover authentication | Separate 120-second / 192 MiB charged-byte profile; pending source still ≤1,024 original scopes / 100,000 rows / 8 MiB gzip / 32 MiB NDJSON. Evidence bundle ≤8,192 objects, 32 MiB raw metadata, 64 MiB expanded JSON and 32 MiB gzip. |
| Managed control | One mutable 4 MiB admission-bounded object containing registered receipts and month dependency state. Event registration is atomic but control growth and full-object CAS are not an accepted long-term scale policy. |

**Inferred near-term failures:**

- Only 158 accounting slots remain after 866 selected scopes. Another comparable 433-scope day yields 1,299, so the current all-control inspector cannot simply continue daily growth. Per-original-event source limits remain separate: the 940-scope day itself already uses 91.8% of its 1,024 cap.
- Five similarly partitioned events would use 30 receipt references; six would use 36 and breach 32, even if scope admission were fixed. Zero-selected descriptors also consume event bookkeeping. Raising only the scope cap postpones another failure.
- The documented control object is 1,308,652 bytes for the two accepted events. This is operator-reported size, not a fresh read or a throughput benchmark. Linear extrapolation is not an acceptance argument; receipt/month growth and full-CAS serialisation need redesign before the 4 MiB ceiling.
- Reconciliation authenticates each selected original event once per invocation, then reconstructs/verifies its expected selected group and retained receipts/bundles. The WeakMap cache survives only that invocation. Seven passes therefore repeat original authentication, even though only 128 current scopes are inspected each time. The 192 MiB handover budget is shared across that invocation's events, not reset for every event; future days can exhaust it before metadata work.
- The inspection clock starts before control/source processing; original authentication consumes elapsed time on that same 60-second outer budget even though it has a separate 120-second handover ceiling. These are overlapping protective clocks, not permission for a 180-second reconciler. Aggregate original-authentication/resource telemetry also needs to remain visible rather than being mistaken for the inspector's own budget counters.
- From the documented response sizes, the two originals' pending/evidence bodies total 3,825,269 bytes per authentication pass; seven equivalent full passes would transfer 26,776,883 bytes just for those source objects, before descriptors/selected receipts/bundles/metadata. This is arithmetic, **not measured seven-report network cost**. Thousands of metadata objects inside a gzip bundle do not mean thousands of consumer GETs.
- Charged transfer/decompression budgets do not enforce JS heap/RSS. Parsed JSON/base64, Buffers, decoded rows, descriptor construction, receipts and compact/expanded reports can coexist. Earlier documented one-event RSS measurements cannot establish a safe many-event memory ceiling. Canonical metadata GETs and private evidence GETs must remain separately attributed.

### Bounded scale design

**Inferred:** split historical authentication, immutable event indexing and current-snapshot inspection into explicit bounded operations:

1. Keep original whole-event authentication intact initially. Maintain the 1,024-original-scope cap and honest optional overflow. Do not split an original authentication across unbound partial reads or silently ignore unsupported pollutants.
2. Add a versioned compact, trusted verifier result only after its trust model is approved: it must bind original DB authority/source/evidence digests, validator/adapter version, selected policy, full original/unsupported coverage and every immutable receipt page. A stored hash or old VERIFIED label alone is not an authentication certificate. Original replay remains necessary when that trusted result is absent or incompatible. This certificate is an optional later optimisation, not a prerequisite for the first Integrity exporter.
3. Page immutable event and scope inventories by deterministic stable keys under a pinned root, with page counts, membership digests, unique ordering and terminal completeness evidence. Continuations include environment, generation, checkpoint, policy, inventory root, last key/page and operation version. A changed root creates a new operation; never acknowledge an unseen page by advancing a time watermark.
4. Retain ≤128 physical scopes and ≤32 receipt references per work unit, plus the existing byte/row/GET/time budgets. A finite directory can describe more than 1,024 total scopes without materialising all scopes in one invocation. Partition by bytes/rows/references as well as scope count; one indivisible oversized scope fails with an explicit recovery requirement.
5. Inspect immutable metadata captured at C, not new reads from overwritten canonical paths in every continuation. Each page report binds C; a bounded streaming aggregation verifies page identity, non-overlap and full directory coverage. An aggregate points to retained page evidence instead of embedding all rows/references into another giant report.
6. For long-term control, build immutable event/group pages before exposing one complete group through a small CAS root/directory. Keep existing schema-1/2/3 receipt meanings and old controls readable; introduce explicit new control/report schemas rather than silently dropping old entries. Per-month control sharding may follow once needed, preserving cross-month PM dependency rules. Do not implement an entire generic distributed database at this stage.
7. Every invocation has a fixed deadline, byte/GET/conflict budget and durable continuation or precise incomplete result. Retry only bounded idempotent work. Keep telemetry of charged bytes, actual transfer, elapsed time and observed heap/RSS; no unlimited retries/fan-out or default timeout expansion.

**Unknown:** real daily scope distributions, multi-event memory, installed Integrity export latency, and coherent checkpoint capture costs. Obtain those through later authorised normal TEST operations, not speculative fixture suites or unsanctioned service reads. A paged plan without retained C authority remains scalable diagnostics only, with freshness unknown.

## 6. Environment-independent implementation

**Confirmed reuse:** environment.mjs requires explicit UK_AQ_ENV_NAME; admission.mjs requires UK_AQ_GITHUB_REPO and checks GitHub repository/manual-dispatch context. r2-config.mjs uses explicit UK_AQ_JSONGEN_R2_ENDPOINT/BUCKET and separate READ versus WRITE credential pairs, rejects canonical credential reuse and carries the configured environment through private evidence. The outbox reader checks its dedicated TLS URL against configured SUPABASE_URL and disallows mutation/acceptance privileges. UK_AQ_R2_HISTORY_VERSION selects the complete generation. Existing config/uk_aq_github_env_targets.csv owns variable/secret/local classifications. [O21] [O22]

**Confirmed gap:** current canonical SQL in schemas/ingest_db/main_db_dualwrite_bootstrap.sql still fixes the outbox environment/default, bundle bucket checks, function evidence environment and reader RLS to TEST values. The original migrations mirror that design. Generic application-side environment admission does **not** make this schema environment-independent. Other TEST-bound operator code, including the BC reconciler, is not a reusable cross-environment handover adapter without its own bounded configuration remediation. [S1] [O14]

**Inferred plan:** use identical application code and approved schema semantics for both environments, with endpoints, repository identity, resource IDs and secrets supplied externally. For database-enforced identity, choose an explicit trusted per-database deployment binding/configuration mechanism with restricted ownership; do not accept arbitrary environment/bucket strings from the inserting caller and do not merely remove checks. Update canonical schema plus an existing-database migration in the schema repository; never patch only LIVE. Preserve old immutable TEST event meanings and private least-privilege reader policy during migration. The particular SQL binding mechanism remains an operator/schema-owner decision.

Before introducing any new key, inspect existing catalogue and sync targets. Reuse UK_AQ_ENV_NAME, UK_AQ_GITHUB_REPO, UK_AQ_R2_HISTORY_VERSION, configured canonical R2, existing private derived target/credentials and signed transport where their semantics fit. An Integrity source-authority reader or signer capability must have separately scoped permissions; never reuse the Prune writer token merely because it exists. A new name requires a documented semantic need, canonical catalogue/target update and coordinated private env-vars-master.csv maintenance. That private master and applied settings were unavailable and were not read. No cross-environment fallback, inferred target or environment-specific application patch is acceptable.

## 7. Phased TEST implementation plan and acceptance gates

All phases below are **conditional future work**, not implementation authorisation. Keep selector/scheduling/chart switches disabled throughout Stage 3D. No historical source synthesis is allowed. Before coding, perform only the structural checks listed below; functional validation occurs after separately authorised deployment through real TEST operations. No new tests, migrations, deployment files or production code are included in this review.

### Phase 0 — close structural prerequisites and choose authority ownership

**Depends on:** operator decisions A–D in section 8.

**Likely components:** writer-authentication.mjs seam descriptions; fixed-v3 coordinator routing; uk_aq_apply_generic_v3_proposal.mjs; uk_aq_apply_sos_light_v3_proposal.mjs; canonical manifest/index validators and finalisers; schema canonical owner; configuration catalogue. No initial runtime edit is required to perform these inspections.

**Essential targeted checks before finalising the implementation patch plan:**

- Compare installed TEST Pro entrypoint/build identity with the pinned fixed-v3 generic/SOS routes, and locate genuinely retained original source/final-view/status/binding evidence. A missing installed runner or private original evidence blocks choosing an exact exporter hook; it does not block accepting this review's finding of missing authority.
- Establish where the writer has complete physical before/after membership and complete final rows, including preserved members and removals, without new canonical Parquet reads. Check source-specific unavailable/no-data semantics and cleanup timing.
- Trace every mandatory canonical manifest/index hash constructor, serializer, validation and parent dependency that would carry a proposed non-reused publication witness. Determine whether it can be embedded under existing publication guarantees, how failed child/parent writes are exposed, and whether all observation/binding/status owners participate. **No currently inspected field proves that invariant.** If this cannot be shown, approve only diagnostics/exporter work and leave completeness-positive work blocked.
- Confirm exact conditional-write/strong-ETag/readback support and scoped permissions for the selected immutable/checkpoint storage; reuse the existing R2 CAS implementation, not a second locking service. This is source/capability inspection; do not perform remote writes during planning.
- Confirm SQL/environment binding ownership and existing configuration names. No credential values, remote migration or deployment is needed for these structural decisions.

**Gate:** a bounded admitted source/scope matrix, exact final hook, independent original completion lookup, witness/checkpoint protocol and failure model are reviewable. If source/status/binding closure is absent, report the specific missing contract rather than fabricate a success seam. This is a genuine dependency for detailed implementation, not a reason to run a pre-implementation functional test programme.

### Phase 1 — one Integrity v3 writer handover, no coverage-positive claim

**Depends on:** Phase 0 source/installed boundary; operator-approved one real schema-3 source case.

**Likely files/components:** bin/uk-aq-history-integrity-sos-light-v3_impl.py at original source preparation and the post-final-VERIFY marker; relevant source partition/proposal capture in scripts/backup_r2/uk_aq_apply_integrity_proposal.mjs or its generic bridge; scripts/jsongen/writer-authentication.mjs and new small Integrity handover codec/exporter/consumer modules alongside existing Prune modules. Reuse bounded private signed PUT transport and immutable retention primitives without giving the canonical writer broad derived credentials. Do not route JSONgen through the disconnected observation_history_integrity_writer_v3 adapter solely because its name looks suitable.

**Schema/config implications:** versioned writer-specific completion authority and common complete-scope wire format. Preserve all existing Prune receipts/descriptors. Add only the minimal independent completion lookup/export authority actually needed; if SQL is chosen, canonical DDL and migration belong to uk-aq-schema, with separate restricted grants. Extend signer writer admission only after explicit source/security design; current AURN signer admission is not Integrity authorisation.

**Structural viability:** parse changed modules and check their direct import/wire-schema compatibility; trace bounded resource admission and hook ordering. Do not create speculative tests or a fixture programme. If later scope touches Prune's protected branching/gates/locking, first reconcile that expanded scope with its local regression policy; this recommendation deliberately preserves those paths.

**Post-deployment real TEST gate:** one separately authorised genuine non-dry-run selected Integrity operation exports complete original final evidence; independent consumer authenticates source/status/binding/finalisation and all declared membership. Incomplete optional transport leaves canonical repair success intact and JSONgen incomplete. Retained immutable evidence replays identically without repeating canonical repair or Parquet verification. Selection remains disabled, and writer coverage/freshness remain unknown.

### Phase 2 — replacements, removals and SOS-light independently

**Depends on:** Phase 1 and source-specific authority decisions.

**Likely files/components:** fixed-v3 coordinator's generic and dedicated verification paths; scripts/backup_r2/lib/sos_light_v3_apply_persistence.mjs; the generic/SOS proposal admission/capture components only where final membership is owned; scripts/jsongen/currentness.mjs, writer-authentication.mjs, schema.mjs and new common replacement-authority validation. Preserve the shared final staged write-set and parent/index ordering contracts. Existing shared selected-scope removal code is reused only for explicitly admitted callers.

**Schema/config implications:** explicit typed predecessor/current authority, authoritative-empty/removal records and complete event group metadata. Do not reinterpret Prune first-publication receipt schema 2/3 to mean later replacement. SOS complete-day membership and preserved rows need their own independently validated authority, not an assumed generic adapter. IFW stays unavailable until its separate canonical repair contract is accepted. Overlay support remains a separate later subphase.

**Post-deployment real TEST gate:** genuine authorised replacement proves exact earlier-after/later-before closure; genuine source-authorised removal proves complete former membership and final absence; dedicated SOS proves whole-day and shared-tail completion. Do not manufacture a source correction or destructive operation merely to populate a case. Unsupported/unobserved cases remain individually unaccepted; contradictory or missing authority remains ineligible.

### Phase 3 — complete writer inventory and one bounded coherent checkpoint

**Depends on:** Phase 0's canonical witness contract and complete applicable writer roster, plus Phases 1–2 for the writers whose source events are needed. This authority design can proceed alongside exporter implementation, but cannot be inferred from exporter success.

**Likely files/components for approach A:** shared canonical publication/finaliser modules workers/shared/uk_aq_observation_history_operational_writer_v3.mjs and uk_aq_observation_history_steady_state_writer_v3.mjs, relevant manifest/index codecs and hash validators; Prune Phase B finalisation evidence hooks without changing its transaction/deletion gates; generic/SOS finalisation capture; observation_binding_publication_lock.mjs and binding owner completion; a small writer-owned inventory/checkpoint module. Account for BC, backfill, maintenance/restore and future status publishers through the same admitted protocol. Do not blanket-edit every writer before its ownership is understood.

**Schema/config implications:** new immutable canonical publication/inventory/checkpoint metadata contract, predecessor and availability states, roster/epoch identity and retention ownership. A canonical witness is canonical evidence and needs an explicit decision on existing backup/recovery coverage. Private JSONgen bundles/control/output remain outside Dropbox. If approach B is selected, also add an explicitly owned restricted ledger in the schema repository or deliberate IFW contract change; no ops-local SQL authority.

**Structural viability:** demonstrate publication identity participates in every required hash/dependency path, unavailable handover remains detectable, and snapshot bodies can be retained immutably within bounded capture. Preserve child-before-parent, per-object verification/durability, existing lock lifetimes and canonical failure rules. No new JSONgen-held lock or pre-change reservation.

**Post-deployment real TEST gate:** at an actual canonical-owner boundary, obtain one small coherent checkpoint with complete roster/inventories and measurement/status/binding vector. Later real writer activity or a naturally interrupted/missing handover must appear as new/unavailable authority, never a false unchanged frontier. If ABA/interruption safety lacks real accepted evidence, keep that capability unaccepted and publication disabled; do not schedule destructive synthetic operations under this review. Checkpoint-positive authority is source-as-of only.

### Phase 4 — bounded continuation beyond 1,024 and control growth

**Depends on:** Phase 3 for coherent multi-invocation authority. An earlier diagnostic-only paging slice is permissible if it retains unknown freshness.

**Likely files/components:** reconcile.mjs, authority.mjs, inspection-plan.mjs, inspection-runtime.mjs, reconcile-cli.mjs, inputs.mjs, control.mjs, schema.mjs, prune-event-schema.mjs, prune-selected-event.mjs, report-codec.mjs and report-validation.mjs. Add small immutable directory/continuation codecs; keep limits.mjs protective profiles rather than merely increasing them. A trusted cached original-authentication certificate is optional and needs its separate trust decision before use.

**Schema/config implications:** new explicit control/report/continuation version with immutable event/scope pages and complete-group visibility under one CAS root. Preserve exact old event replay and original descriptors, unsupported counts and authority meanings. No new endpoint/secret by default. Manual workflow changes are needed only if a future approved operation requires them; keep scheduling disabled.

**Post-deployment real TEST gate:** with enough genuine retained events to exceed the existing accounting/reference thresholds, bounded continuations cover the entire pinned directory exactly once within each operation's resource limits. All partitions aggregate under the same checkpoint, with no silent scope loss. Changed checkpoint/control, missing page, conflicting CAS or exhausted budgets yields continuation/reconciliation-required, not success. Do not alter controls or register synthetic events just to force the limit.

### Phase 5 — stop and assess readiness; monthly publication remains separate

**Depends on:** accepted relevant writer adapters, complete inventories, checkpoint protocol and bounded scale.

**Gate:** operators can separately judge whether an expressly approved scope has authentic complete canonical source-as-of authority. Even then, an authenticated whole-month baseline, preceding-month PM context, following-23-hour DAQI effects, paired immutable observations/AQI generation/readback, UUID pubID selection and safe derived CAS/rebase remain separate future work. No Stage 3D success automatically enables selectManagedPublications, chart serving, Prune scheduling or LIVE promotion. Do not include those implementations in the first exporter PR.

## 8. Decisions for operator approval and unresolved risks

These are decisions for subsequent work, not permission requests to complete this review.

| Decision | Recommended disposition | Risk if unresolved |
| --- | --- | --- |
| A. First admitted Integrity case and installed evidence | Name one genuine TEST schema-3 source/scope and supply a bounded installed-runner/evidence inspection route before choosing the exporter hook. | Implementing against the wrong runner, incomplete preserved rows or unbound effective status can falsely authenticate a replacement. |
| B. Canonical witness ownership and contract change | Approve design of approach A, including non-reused scope publication provenance; require the Phase 0 structural result before implementation. Do not make an optional JSONgen outbox mandatory. | Unknown all-writer inventory, invisible skipped handovers and ABA remain permanent blockers; a post-hoc checkpoint could falsely certify completeness. |
| C. Closed scope/epoch and writer roster | Explicit selected pollutants/physical identities, epoch start, admitted mutators and proof of excluded writers. New writer activation reopens acceptance. | A valid known receipt set may omit a capable writer; a missing removed timeseries can disappear from coverage entirely. |
| D. Completeness versus freshness claim | Accept coherent source-as-of checkpoints with pending/unknown freshness between them. Reject instantaneous latest-canonical claims. | Users could see internally consistent but stale products labelled current; derived CAS cannot close the canonical race. |
| E. Missing original/history boundary | Preserve 16 October and all other unavailable originals as unavailable. Any future bootstrap/rebuild is separately authorised and labelled, never retrospective VERIFIED reconstruction. | Destroyed source provenance could be replaced with plausible current rows and misrepresented as historical authentication. |
| F. Removal/status rollout | Accept specific replacement/removal source cases independently; keep schema-4/overlay cut-over outside the first slice. | False deletion, P/R promotion/demotion or measurement-hash equality hiding a status-only change. |
| G. Trust of reusable verifier certificates | Defer until paging needs demonstrate benefit; define issuer/version/original-authority binding, compatibility and retention first. | Persisted hashes or an old code verdict could be accepted without independent originating authority, or every page continues expensive full reauthentication. |
| H. Inventory storage and DB/environment binding | Prefer R2 canonical-owned inventories; choose restricted per-database environment identity for existing SQL remediation, with schema-owner review. | Silent database/R2 commit gaps, overprivileged adapters or TEST-only constraints undermine identical-code promotion and environment isolation. |
| I. Retention, backup and cleanup | Retain unresolved originals, descriptors, receipts, predecessor links and checkpoint pages. Decide canonical witness backup coverage separately; keep private derived data out of Dropbox. | GC/cleanup can erase the only replay/snapshot proof; a hash to overwritten metadata cannot restore coherence. |
| J. Resource envelope and control migration | Approve immutable paging/continuation design while preserving per-unit limits and atomic complete-event visibility. | Third comparable day blocks inspection; reference, control-byte, memory and deadline ceilings follow even after a scope-cap increase. |
| K. IFW and other future writer activation | Require separate accepted canonical repair/finalisation and equivalent inventory/handover participation. Do not treat read-only D1 success as a publication. | A future repair writer becomes invisible to an apparently closed JSONgen inventory. |

**Unknown / concrete blockers:** installed Pro source/evidence closure; accepted all-writer canonical publication witness; exact new metadata/hash protocol; trusted SQL environment binding; real capture/paging resource measurements; accepted overlay transition authority; full-month/context/publication implementation. None prevents producing this review/PR. Each relevant missing authority prevents a future positive readiness claim. Historical documentation sometimes retains superseded code-only statuses; use the latest dated acceptance for that exact capability and do not extrapolate it.

## 9. Separate ChatGPT Chat-mode documentation handover

**For the authoritative documentation owner; no system_docs file was edited.** This is a proposed handover, not a request to promote this review into runtime authority.

- In station_charts/compressed_history_json_verified_writer_regeneration_contract.md, preserve the 25 October operator-reported evidence qualification, two-event counts, seven distinct source-as-of boundaries and disabled publication. After decisions B–D, define the chosen roster/epoch, canonical witness, inventory/checkpoint and honest freshness semantics; explicitly distinguish them from original authentication and derived registration.
- Reconcile writer-seam routing to actual fixed-v3 generic versus dedicated SOS verification boundaries. Keep installed-runner availability and original final-view/source/status closure as acceptance prerequisites. Document new handover wire/authority versions only after the design is approved; preserve Prune receipt meanings, original outbox optionality, gate/deletion independence and no reconstructed historical originals.
- In r2_history writer coordination/manifest/finalisation contracts, specify any approved canonical provenance token/hash propagation, partial-publication failure, complete membership/removal, immutable snapshot retention and backup/recovery ownership. Add Core/binding, BC and future verification publishers to the scope-bound inventory rules. Do not extend the global lock lifetime for JSONgen computation or create a pre-change derived fence.
- Reconcile the future-labelled selected-removal contract with the narrower current BC capability/acceptance, and retain per-source operational qualifications. Record no new generic JSONgen removal or overlay acceptance from this review.
- Record new continuation/control/report versions, resource bounds, certificate trust if selected, environment/configuration/schema ownership and real TEST evidence only after their respective phases. Existing database environment/bucket/RLS literals need an approved schema-owner configuration contract before cross-environment reuse.
- IFW remains future canonical repair authority. Its source-generation/D1/findings are not writer completion evidence. Keep private JSONgen source/output/control outside Dropbox; explicitly decide backup coverage if new canonical witness objects become canonical recovery evidence.

**Current changes/evidence:** one non-authoritative Markdown review only. Source reading and document/link/whitespace/PR-diff checks, not functional verification. No new tests or migrations, no deployment or real service operation. After future implementation, the handover must name exact changed components/schema/configuration, structural checks, separately authorised TEST operations and remaining acceptance limits; this review supplies none of that future acceptance.

## 10. Review validation and delivery boundary

Confirmed by source inspection: required nine JSONgen starting modules and their load-bearing authority/partition/configuration dependencies, actual generic and dedicated v3 finalisation routes, shared writer removal/finalisation paths, global lock/binding participation, selected IFW/schema ownership and relevant routed contracts. Reference links below pin evidence to the reviewed commits.

Only document structural checks were appropriate: required sections/evidence labels, cited file/line existence, whitespace and the final one-file GitHub comparison. No automated test suite, new test, database query, R2 request, workflow dispatch, dependency install, deployment or canonical/derived operational mutation was performed. All 38 current workflow definitions were read to check the review-only path: their declared triggers do not match this Markdown branch push or PR, and there is no downstream workflow event trigger chain. This is a source-level trigger assessment, not an independent check of GitHub settings or external automations.

The intended GitHub change is exactly reviews/jsongen_stage3d_readiness_review_2026-10-25.md on a dedicated review branch targeting TEST main. Do not merge or deploy it. Stop after delivering this review and PR; implementation requires separate authorisation.

## Evidence references

Reference definitions below identify authoritative contracts and inspected implementation, not private operational reports. All repositories are TEST-uk-aq.

[D1]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/4addadb675c6fd7082ee3b1544a06381216e9ed9/system_docs/station_charts/compressed_history_json_verified_writer_regeneration_contract.md#L3
[D2]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/4addadb675c6fd7082ee3b1544a06381216e9ed9/system_docs/station_charts/compressed_history_json_verified_writer_regeneration_contract.md#L440
[D3]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/4addadb675c6fd7082ee3b1544a06381216e9ed9/system_docs/r2_history/prune_connector_day_gate.md#L203
[D4]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/4addadb675c6fd7082ee3b1544a06381216e9ed9/system_docs/r2_history/README.md#L1
[D5]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/4addadb675c6fd7082ee3b1544a06381216e9ed9/system_docs/r2_history/sos_light_three_phase_authority_contract.md#L330
[D6]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/4addadb675c6fd7082ee3b1544a06381216e9ed9/system_docs/integrity_factory/README.md#L3
[D7]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/4addadb675c6fd7082ee3b1544a06381216e9ed9/system_docs/r2_history/final_staged_write_set_provenance_contract.md#L25
[D8]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/4addadb675c6fd7082ee3b1544a06381216e9ed9/system_docs/r2_history/ukair_black_carbon_history_contract.md#L526
[D9]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/4addadb675c6fd7082ee3b1544a06381216e9ed9/system_docs/r2_history/observations_run_exclusion_contract.md#L1
[D10]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/4addadb675c6fd7082ee3b1544a06381216e9ed9/system_docs/r2_history/observation_verification_overlay_contract.md#L3
[D11]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/4addadb675c6fd7082ee3b1544a06381216e9ed9/system_docs/r2_history/observation_selected_scope_removal_contract.md#L3
[O1]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/jsongen/writer-authentication.mjs#L9
[O2]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/jsongen/currentness.mjs#L1
[O3]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/workers/uk_aq_prune_daily/phase_b_history_r2.mjs#L4541
[O4]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/workers/uk_aq_prune_daily/phase_b_history_r2.mjs#L2370
[O5]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/jsongen/prune-consumer-authentication.mjs#L215
[O6]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/backup_r2/uk_aq_apply_generic_v3_proposal.mjs#L27
[O7]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/backup_r2/uk_aq_apply_integrity_proposal.mjs#L1844
[O8]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3_impl.py#L26705
[O9]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/backup_r2/lib/sos_light_v3_apply_persistence.mjs#L1060
[O10]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/jsongen/prune-original-authority.mjs#L70
[O11]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/jsongen/prune-selected-event.mjs#L20
[O12]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/jsongen/control.mjs#L149
[O13]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3_impl.py#L27792
[O14]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/ukair_bc/uk_aq_ukair_bc_observation_reconciler_locked.mjs#L873
[O15]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/backup_r2/lib/observation_binding_publication_lock.mjs#L7
[O16]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs#L1313
[O17]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/jsongen/authority.mjs#L119
[O18]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/jsongen/reconcile.mjs#L30
[O19]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/workers/shared/uk_aq_r2_history_writer.mjs#L25
[O20]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/jsongen/limits.mjs#L4
[O21]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/jsongen/r2-config.mjs#L14
[O22]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df1e9ea999d5cdd4a6a3e763597fefc0a7cf5b8/scripts/jsongen/prune-outbox-reader.mjs#L56
[F1]: https://github.com/TEST-uk-aq/uk-aq-integrity-factory/blob/22eb343583c96cea4253c6005e4da4f66a4d5add/src/coordinator/factory_run.mjs#L16
[F2]: https://github.com/TEST-uk-aq/uk-aq-integrity-factory/blob/22eb343583c96cea4253c6005e4da4f66a4d5add/README.md#L1
[S1]: https://github.com/TEST-uk-aq/uk-aq-schema/blob/74d673f186172c8574b118ccc370d921e9939de1/schemas/ingest_db/main_db_dualwrite_bootstrap.sql#L891
