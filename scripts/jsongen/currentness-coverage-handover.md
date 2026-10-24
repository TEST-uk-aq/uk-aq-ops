# Stage 3C currentness, coverage and capacity handover

TEST code only, 18 October 2026, existing PR #114. The authoritative
[Prune verification boundary](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/main/system_docs/station_charts/jsongen_prune_verification_handover_quick_reference.md)
and its current linked contracts still govern. No authoritative system docs were
edited. This hardens reviewed commit `b54196aa`; it does not activate a publisher.

## Problems found and inspection strategy

The old 256-GET allowance could not inspect 128 ordinary distinct series: exact
leaves and physical bindings alone require 256 initial GETs and 256 rechecks.
Shared hierarchy, indexes, Core completion and status metadata add more. The
existing cache deduplicated GETs, but hierarchy, scoped membership, aligned shard,
Core root/range and status validation were repeated for many scopes. The detailed
1,024-scope report also exceeded 4 MiB through repeated physical identities,
metadata references, receipt/event authority, source-as-of descriptions and
identical diagnostic prose.

The hardened inspector processes **one deterministic selection of at most 128
whole physical scopes per invocation**, while accounting for the entire declared
set of up to 1,024. It reuses the existing metadata reader and validators; it does
not implement a second authority tree. Inspection-local memoization shares
hierarchy, scoped membership, aligned shard, Core root/range and status validation.
Per-leaf validation remains in the existing exact reader. All source buffers and
validation caches end with that inspection; they are never reused as current
across unrelated invocations.

## Request, memory and time model

`createBudget()` retains its legacy 256-GET ceiling. The Stage 3C reconciler/CLI
uses `createInspectionBudget()` with a **selected-key-derived** allowance:

```text
K = distinct deterministic metadata keys required by the selected scopes
C = distinct selected connectors (one possible immutable status manifest each)
initial GET allowance = K + C
operation metadata GET allowance = 2 * (K + C) + 1
```

The second term reserves every initial identity/missing-object recheck; the final
one reserves the closing observations-root GET. The fixed profile ceiling is
`2 * (13 * 128 + 4) + 1 = 3,337`, a conservative structural ceiling for all
hierarchy/index/leaf/shard/binding/status keys in 128 scopes. It is **lowered to
that invocation's actual key plan** and never increased for concurrency. Invalid
unplanned dependencies fail before a GET. Unknown status-manifest keys are bounded
by their selected connector and immutable SHA-addressed namespace.

The ordinary dense 128-series synthetic fixture uses **541 actual GETs** under a
543-GET plan: 270 distinct initial keys, their 270 rechecks, and one closing root.
The two unused requests reserve a possible connector status manifest. A cache hit
or shared in-flight request is not charged as another GET. Successful, failed,
missing-object and aborted request starts are counted. Rechecks have no exemption.
The report records actual initial/recheck key sets and all three request counts.
It separately records initial, recheck and closing-root body bytes, alongside the
prior retained-original-metadata counters. Validation reconstructs successful
inspection byte totals from the exact references and rejects counter mismatches.

Four fixed workers share one operation budget and first-read/in-flight cache.
Output order and scope partitions are deterministic. A shared abort controller
uses the **remaining original operation deadline**, not a fresh timeout per page.
Capacity exhaustion, request timeout or observed metadata drift aborts the shared
inspection. Bounded GETs receive that signal; workers settle before evidence is
returned, byte reservations are released, and a closed session rejects late cache
or evidence writes, including adapters that ignore cancellation.

Unchanged bounds include 60 seconds for the operation, 64 MiB cumulative data,
200,000 rows, 32 receipt references, 128 scopes per receipt/bundle, 8 MiB per
metadata object and 4 MiB per serialized report. The shared **raw metadata cache**
is separately capped at 8 MiB. Concurrent requests reserve available bytes before
starting and charge returned bodies once. Report encoding/expansion is bounded by
4 MiB wire/32 MiB expanded bytes; artifact admission also checks data counters plus
expanded and wire serialization against the 64 MiB envelope and the shared deadline.
These are byte/object/row safeguards, not a measurement of peak JavaScript heap or
real R2 latency. Interrupted transport bytes are not supplied by the existing GET
adapter; the attempted request remains accounted and the inspection is incomplete.

## Scope accounting and source-as-of consistency

`selection` contains the complete sorted scope set, its hash, every exact partition
membership/hash, total scope/partition counts and the selected partition index.
Original connector-day registration and receipt groups remain complete and
separate. For an event of 1,024 scopes, default selections are indices `0..7`.
One invocation can establish current metadata for 128, with the other **896
explicitly uninspected**. It never trims original receipts or bundles.

Every inspected scope authenticates selected complete-v3 root/year/month/day/
connector/pollutant membership, exact/scoped/aligned physical authority, selected-v3
binding and matching Core source/refresh completion, plus applicable status.
Observation latest remains discovery, not an authentication parent. Only complete
linked membership proves absence; 404s do not prove empty physical scopes.

All selected scopes share one first-read cache, exact byte identities and a final
recheck of **every attempted/observed identity**, including rechecks of missing
objects and a closing root confirmation. Recheck evidence identifies matched,
changed, unavailable and not-rechecked objects. A changed, failed or incomplete
recheck cannot produce `read_consistent=true`. Source-as-of identity covers the
exact generation, selected physical-scope set, metadata references and unavailable
metadata keys, with explicit start/end times and ABA/freshness limitations.

Per-scope assessment distinguishes fully inspected, metadata unavailable, resource-
limited, unselected and incompatible source-as-of evidence, independently from
original authentication, metadata match/difference, supersession and registration.
Unselected scopes have no current source-as-of identity and cannot be current.

**A complete coherent 1,024-scope currentness inspection is not implemented.**
Separate invocations have separate caches, deadlines and source-as-of identities.
Even eight individually successful passes are not combined as one snapshot.
Generation labels, close timestamps, common event IDs, identical root key names
or even matching endpoint root bytes cannot establish a new aggregate boundary.
Binding/status authority and all relevant dependencies need a trustworthy shared
boundary too. The selection explicitly says cross-invocation consistency is not
established. Missing, overlapping, contradictory or foreign-partition authority
is rejected; no import/merge shortcut is provided. A future complete aggregate
needs independently authenticated cross-partition authority/fencing. No canonical
lock is acquired; identical endpoint checks never exclude an intervening ABA writer.

## Lossless report schema 3

`reconcileManagedInputs()` returns expanded schema 3. `reconciliationArtifact()`
and the manual CLI serialize it as schema 3 with `encoding=interned_json_tree_v1`.
A single immutable JSON object contains a deterministic bottom-up `nodes` table,
root index, expanded SHA-256 and exact expanded byte size. Nodes are scalar values,
arrays of backward indices, or objects with sorted field-name/index pairs.
Repeated metadata references, physical identities, original PostgreSQL acceptance,
source-as-of objects, diagnostic text and scalar strings are stored once. Every
meaningful field of the expanded report is preserved. No observation rows or
credentials enter this diagnostic format.

`decodeCompactReport()` expands the wire representation; `assertReconciliationReport()`
accepts either representation and applies full semantic validation after expansion.
It rejects missing/forward/cyclic references, duplicate/unused/reordered nodes,
wrong hashes/sizes, expansion bombs, missing scopes or partitions, conflicting
source pins, absent rechecks, resource bypasses, unsupported status authority,
false writer completeness and publication eligibility. Partition membership and
request allowances are independently reconstructed from supplied scope identities.
Only one report file is needed; no external partition files or second mutable
source of truth are introduced. The 1,024-scope fixture now serializes to
**2,636,246 bytes** from **5,264,766 expanded bytes**, below 4 MiB without removing
evidence, including unresolved and uninspected scopes. Its selected 128 scopes
span two physical ranges and use 545 GETs within a 547-GET plan. These byte/count
results describe synthetic fixtures only.

**Legacy report schemas 1 and 2 retain their existing strict meanings and limits.**
Their bytes are not silently reinterpreted as the new encoding. Receipt schemas
1/2, bundle formats, managed control/CAS and original Stage 3B authority are
unchanged. Existing optional immutable diagnostic retention still uses exact
SHA-addressed identity, conditional writes and readback; it is not activated here.

## Preserved authority and publication boundaries

Prune remains the sole canonical observation verifier. There is no canonical
Parquet download, observation rescan, new verification/deletion gate, canonical
writer modification, SQLite/journal/overlay/log reconstruction or fabricated event.
Original schema-2 receipts are authenticated through the actual immutable private
PostgreSQL outbox and retained pending gzip; separate immutable receipt/bundle
readbacks and deterministic whole-event registration semantics remain intact.
Original receipt history is never rewritten or removed after drift.

Currentness compares exact physical file/segment/schema identity and binding,
excluding unrelated parent/aligned-shard references. Changed shared files remain
conservatively changed. AURN schema-3 P/R/null and unavailable raw provider status
are preserved. A selected overlay/schema-4 or unsupported transition stays
unresolved; a mode string or namespace cannot supply accepted transition evidence.
Genuine later supersession requires independently authenticated final writer
proof and an exact before-to-original-after link. The current first-publication
AURN adapter cannot prove later replacement/removal of a present scope.

Known original receipts, retained/unregistered receipts, missing retention,
missing registration, unmatched current scopes and pending outbox discovery remain
separate. Optional AURN outbox inserts can miss valid canonical publications.
Overlapping discovery and historical resweeps remain necessary; accepted_at is
insertion time, never canonical event order or a completeness watermark. Integrity,
SOS-light and IFW complete handovers/inventories/fences remain unavailable.
Writer coverage, all-required-receipt retention/registration and freshness stay
`unknown`; publication eligibility stays **false** even for 128 matching scopes.

## Manual operation and configuration

For a later separately authorised TEST operation only:

```sh
node scripts/jsongen/reconcile-cli.mjs --execute-read-only \
  --scopes-file work/physical-scopes.json \
  --retained-receipts-file work/retained-references.json \
  --inspection-partition 0 --output work/currentness-partition-0.json
```

The report itself carries the complete partition manifest; use distinct explicit
output paths for later partition invocations. Scope files contain an array of
`{identity:{connector_id,timeseries_id,station_id,pollutant_code},day_utc}`. Receipt
files contain exact immutable descriptors. Existing control receipts are always
accounted. Duplicate explicit selections are rejected. Optional `--discover`
continues bounded overlapping/resweep discovery. The local schema-3 output is
atomically renamed from a mode-0600 temporary file only after full admission.
Logs contain counts/codes, not credentials or observations. Exit 2 still means
reconciliation required. Importing modules does not execute the interface.

Source the existing TEST environment before any separately authorised invocation.
Admission now reuses `UK_AQ_ENV_NAME` and `UK_AQ_GITHUB_REPO`, the existing sourced
Ops repository identity already used by the WHO runner. Both are mandatory:
`UK_AQ_ENV_NAME` must be exactly `TEST`; `UK_AQ_GITHUB_REPO` must be a nonempty
`OWNER/REPO` identifier for that environment. The required `--execute-read-only`
flag remains the explicit manual opt-in; no new enable key is needed.

The shared `admission.mjs` check runs before local input or remote reads in the
Stage 3C CLI, and before client construction in the optional private outbox reader.
An absent, empty or malformed configured repository fails closed. A supplied
`GITHUB_REPOSITORY` must exactly match it. Under `GITHUB_ACTIONS=true`, that runtime
identity is mandatory and `GITHUB_EVENT_NAME` must be `workflow_dispatch`, reusing
the existing manual diagnostic admission convention. Local operation may omit
GitHub runtime metadata. Runtime identity, Git remotes and another environment
are never configuration fallbacks; LIVE and missing environment names are rejected.

`UK_AQ_GITHUB_REPO` is now recorded as `variable` in
`config/uk_aq_github_env_targets.csv` for Prune Actions admission, while retaining
its sourced local meaning. See the [manual signer preflight](prune-signer-preflight.md).
No GitHub setting, credential, SQL schema or service is provisioned by that correction.
The operator-owned ignored `env-vars-master.csv` is absent in this
checkout; retain/verify its existing `UK_AQ_GITHUB_REPO` definition when preparing
the external TEST environment. No value is inferred or automatically supplied.
The independent consumer also uses the private reader, so it now requires this
same repository configuration before connecting.

Existing TEST/v3 canonical and derived R2 configuration, dedicated credentials
and restricted private reader URL remain unchanged. An absent real control blocks
rather than initializing it. No automatic remote write, retention, dispatch,
schedule, generator or chart route is added. The manual interface was not executed.

The focused PR #114 application-diff review found no other newly hard-coded
environment-specific repository, account, bucket or service values. The optional
reader contained an equivalent pre-existing repository literal on this diagnostic
path; it now shares the external admission check. Earlier Stage A
`diagnose.mjs`/workflow repository literals and existing derived-storage account/
bucket pins in `control.mjs`, `inputs.mjs` and `schema.mjs` predate PR #114 and remain
separate portability work. Their accepted TEST scope/storage and receipt schemas
were not broadened during this review.

## Validation, remaining limits and Stage 3D handover

The narrow synthetic checks cover positive 128-series inspection, exact GET/cache/
recheck accounting, bounded concurrency, timeout/cancellation and late-response
rejection; complete 1,024-scope accounting and compact roundtrip; missing/overlapping
partitions and incompatible foreign authority; strict exhaustion, legacy reports,
original evidence gaps and the unchanged publication blocker. Fixture storage is
populated directly: no consumer write mode is executed. Syntax and diff checks
are local. These are structural checks, not operational R2 benchmarks or real
AURN timing/throughput acceptance.

Final validation passed seven focused currentness/capacity checks and two existing
receipt precision/membership checks (nine total). Active changed/new modules and
the check file pass `node --check`; `git diff --check` passes. Exact commands:

```sh
node --test --test-isolation=none --test-reporter=tap tests/jsongen_currentness.test.mjs
node --test --test-isolation=none --test-reporter=tap --test-name-pattern='receipt and gzip identities|complete-scope membership' tests/jsongen_stage2.test.mjs
```

Remaining practical limits are the same byte/row/time/report caps, original
metadata capture limits and a maximum 128 scopes inspected in one coherent
operation. Actual latency, full-source sizes and throughput require separately
authorised real TEST acceptance. Do not infer 1,024-scope coherent capacity from
compact report capacity or concatenate separately inspected partitions.

Exact remaining prerequisites for Stage 3D: restricted Schema #12 reader setup
and real TLS/ACL/RLS/GET acceptance; integrated original Prune/outbox/consumer
acceptance; writer-owned complete publication inventory and scope-bound freshness
fences covering missing handovers; genuine later-writer/overlay authority;
authenticated full-month baselines and adjacent-month PM context. A larger coherent
inspection needs a real cross-partition authority boundary. Paired JSON/AQI
generation/readback and publication CAS/real TEST acceptance remain later gates.
`selectManagedPublications()` stays disabled; pending-source true and paused
Prune scheduling are untouched. No migration, operational SQL/R2, Prune/Integrity/
signer, dispatch, deployment, monthly product, merge or LIVE operation occurred.

Chat-mode system-doc handover: record the dedicated key-derived inspection budget,
128-scope selection with complete-event accounting, four-worker cancellation and
explicit recheck evidence, and lossless schema-3 reports with strict legacy
compatibility. Original canonical verification, receipt authority, writer coverage
and publication conditions are unchanged. Rollback is reverting this reader/report
hardening; retain original outbox, bundles, receipts and diagnostic evidence. The
existing 18 October archives were reused and newly touched files archived once.

The configuration review passed 27 synthetic admission cases (4 allowed,
23 blocked): required/malformed configuration, repository mismatch, LIVE rejection,
missing Actions identity, non-manual events and absence of runtime-identity
fallback. Rejected configurations never construct a database client. Syntax
checks passed for 15 active PR modules/check files; CSV targeting, daily archive
integrity and `git diff --check` passed. Two existing focused read-only checks also
passed, without adding a test suite or executing the manual diagnostic:

```sh
node --test --test-isolation=none --test-reporter=tap --test-name-pattern='^authenticated original matches exact current scope' tests/jsongen_currentness.test.mjs
node --test --test-isolation=none --test-reporter=tap --test-name-pattern='^late visibility is recovered' tests/jsongen_prune_consumer.test.mjs
```

For later TEST acceptance, first verify the sourced
repository identity and least-privilege destinations, then use a separately
authorised manual invocation. Reverting this configuration correction restores
the older admission behaviour without altering retained data. Chat-mode system-doc
handover: record the required existing repository configuration and shared
fail-closed local/manual-Actions admission; no authoritative system_docs were edited.
