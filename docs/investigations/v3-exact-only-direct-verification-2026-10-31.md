# Exact-only v3 direct verification and publication preparation

31 October 2026. TEST code only, under the
[accepted future exact-only contract](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/main/system_docs/r2_history/observation_history_index_v3_exact_only_future_contract.md).
Starts at TEST `main` `2854c0d0`, with compatibility PR #155 merged at
`f41e23c37c6f2d46f18193d0e4ca848f495eab7f` confirmed as an ancestor. Its
[implementation handover](v3-exact-only-compatibility-2026-10-31.md) remains the
compatibility/dependency baseline.

## Changed implementation

| File under `workers/shared/` | Result |
| --- | --- |
| `uk_aq_observation_history_exact_leaf_index_v3.mjs` | Explicit internal `exactSchemaVersion: 2` construction using existing wrappers/stages, complete numerical leaf membership, semantic revision hashes and canonical encoding. Default schema 1, aligned artifacts and original bytes remain selected by existing writers. |
| `uk_aq_observation_history_target_writer.mjs` | Adds a physical inspector that accepts actual pinned bytes, decodes every stored column losslessly, checks full schema/footer/group/chunk/page/dictionary boundaries and compares the projected direct-column decoder with the full stored rows. Existing writer/inspector exports and emitted bytes remain unchanged. |
| `uk_aq_observation_history_exact_only_verifier_v3.mjs` | Read-only canonical-child preparation and independent completed root-to-DCP/direct physical verification. Operation-local opaque proof and fresh identity rechecks; no permanent catalogue or cross-run layout cache. |
| `uk_aq_observation_history_index_v3.mjs` | Publication graph pins schema-2 immutable/selector roles in its schedule identity. Adds immutable reuse/conflict handling, exact readback, unknown-write reconciliation and lifecycle hooks. A hard inactive gate rejects schema-2 publication before mutation adapters. Publication body bytes are rehashed before dispatch to reject substituted mutable plans. |
| `uk_aq_observation_history_exact_only_publication_v3.mjs` | GET-only preparation of original selector/latest identity guards, immutable dependencies, compact-latest update and a latent lifecycle for completed-root acceptance and existing run finalisation. Its finalise entry goes through the shared hard inactive gate. |

The new target-writer pre-change archive is an exact copy of TEST main at
`archive/2026-10-31/workers/shared/uk_aq_observation_history_target_writer.mjs`.
The two other modified active files already have their one-per-day copies from
PR #155; those historical copies are reused, unchanged. Archives are never
imported or executed. The bounded plan is recorded under
`docs/superpowers/plans/2026-10-31-exact-only-direct-verification.md`.

## Independent verification guarantees and limits

`prepareObservationHistoryExactOnlyScopeV3()` requires durably readable canonical
Parquet and its pollutant manifest. It reads/authenticates that body, independently
inspects all pinned files, then invokes the shared builder. It does not require a
completed root before bottom-up child publication. Its proof explicitly has
`canonical_hierarchy_complete: false` and cannot establish final success.

`verifyObservationHistoryExactOnlyScopeV3()` authenticates the current complete
root/year/month/day/connector/pollutant chain. It recomputes existing aggregate
and canonical manifest hashes, validates accepted canonical manifest schemas and
physical declarations, checks complete agreeing child aliases and selected child
summaries/file tables. It authenticates the actual DCP body size/SHA and explicit
canonical observation-content-hash contract version. No canonical schema field is
added or silently defaulted. Existing `observation_content_hash_contract_version`
is explicit accepted hash-version provenance; a competing version field must
agree.

For the entire DCP, verification reconciles full series membership, per-file and
per-series counts, file set/order/ordinal identities, row groups, row positions,
coverage/bounds and exact projected ranges. It reads the actual full pinned
Parquet bodies and checks their SHA, stored project SHA, size and current ETag.
The inspector independently derives physical metadata from those bytes and
lossless stored rows. Reconciliation compares all proposed/stored leaves to that
physical result, not another copy of emitter claims. Projected schema, codecs,
page/dictionary headers and compressed boundaries are checked, and the exact
reader's column decoder is checked against the complete stored-value decode.
Duplicates, nullable station IDs, P/R/null and float values retain their existing
canonical meanings.

Actual supported inspector combination is **physical schema 3, writer
`parquet-wasm-zstd-v3`, observation hash v1, `timeseries-aligned-v2`,
`hyparquet-direct-column-v1`**. Schema 4 and hash-v2 inspection/rebuild are
explicitly unsupported and fail closed. Existing schema-4 reader compatibility
is unchanged and is not claimed as rebuild capability. The schema-2 construction
path likewise currently takes the accepted schema-3 target metadata.

All verification is offline relative to the chart reader. It does not change
chart paging, APIs, caches, generation selection or hot-path CPU limits. It does
not reuse target-writer layout evidence: this phase always performs physical
inspection. There is no transient footer cache to survive an operation or batch.
The proof handle lives only in a module-private WeakMap and continuously checks
the original held-operation callback and every pinned body/ETag/stored file SHA.
Lock loss invalidates it permanently. Serialised/copied reports cannot substitute
for this operation-local handle. Reports are returned to the caller, not stored
as another authority tree.

These checks prove stored canonical/index consistency and actual layout. They do
**not** replace independently required source-to-final comparison, original Prune
source evidence, complete snapshot semantics, READY→CONSUMED, original outbox or
receipt authority. Reports explicitly leave `source_to_final_verified` and
`finalisation_complete` false.

## Publication and dependency semantics

Schema-2 leaves depend on their referenced canonical files and have the exact
canonical pollutant body as an order prerequisite. The selector depends on that
canonical body and the complete immutable leaf set. No aligned dependency or
whole-DCP identity is added to leaf bytes. Unchanged leaf revisions survive
unrelated parent/sibling changes; full leaf bodies are size/SHA pinned by the
selector.

The preparation path captures original selector and compact-latest body/ETag
identities under the held observations-operation session. It checks any existing
revision key for exact equality and verifies unchanged compact-latest dependency
identities. Unknown formats, ambiguous absence and conflicts fail closed. A
schema-2 selector already present requires explicit authenticated recovery; this
phase does not invent a restart ledger or treat prior selection as success.

The latent finaliser integration rechecks operation/source identities before
publication, rechecks the original selector immediately before its single-object
switch, preserves immutable existing revisions, forces exact readback and
reconciles unknown write results by exact bytes. It does not describe GET/PUT as
CAS. After selector readback it invokes the existing canonical hierarchy
finalisation adapter, independently verifies the completed current root/DCP/files/
selector/leaves and compact-latest scope formats/identities, then admits latest
and the owning writer's existing run-completion adapter with exact readback.
Selector-selected/latest-unfinalised is failure, with no blind old-selector
rollback. Callers must explicitly recover under the original accepted authority.

**No schema-2 selector can be published through the changed shared finaliser.**
`OBSERVATION_HISTORY_EXACT_ONLY_PUBLICATION_ACTIVE_V3` is a constant `false`, with
no environment variable or caller override. It rejects the actual schema-2 body
before PUT or durable-evidence adapters. No operational writer imports the new
preparation/lifecycle module. Enabling production needs a separately reviewed
change after all required consumers and authority handovers are compatible and
accepted. Schema-1 plans omit the new optional policy fields and retain their
existing schedule/production representation and aligned dependencies.

## Prune, post-write and remaining dependencies

The new read-only direct verifier is the bounded interface for future Prune and
independent post-write integration: supply authenticated GET returning the exact
requested key/body/current ETag (and stored SHA/size for Parquet), the original
held-operation assertion, exact DCP scope, and optionally a prepared hierarchy or
pinned completed root. Without a hierarchy it authenticates the actual stored
selector and every leaf. An assertion returning false or throwing fails closed.

Existing Prune/source-deletion, original-evidence/outbox, independent post-write,
Integrity/SOS-light, JSONgen and backup/reconstruction callers are unchanged.
Their schema-1/aligned guards remain controlling. This is an implementation
interface, **not a new durable original-proof format**. Binding the direct result,
full DCP/files, exact selector/leaf set, verifier/profile and completed finalisation
into the accepted original handover remains outstanding. JSONgen must authenticate
that handover without a second Parquet pass. No old receipt/digest meanings are
changed, and no all-writer delivery or freshness assertion is made.

Still required before publication: that original-evidence/Prune/post-write
integration; fixed-v3 Integrity/SOS-light key allowlists, physical digests and
reconstruction; JSONgen direct-proof handover; compatible compact-latest and
backup/reconstruction consumers; and separate TEST deployment/operational
acceptance. Unsupported schema-4/hash-v2 rebuild remains an explicit capability
gap. No new unresolved format ambiguity or authoritative contract amendment was
needed for this phase.

## Structural evidence, deployment and rollback

Checks: syntax parsing and direct imports of all five changed/new active modules;
existing `tests/uk_aq_observation_history_exact_leaf_writer_contract.test.mjs`;
one bounded scratch identity/publication-safety check using the shared writer,
1,027 rows, two series and three row groups, including nullable IDs/status and
same-time rows. It exercises complete canonical chain construction, actual
inspection, stored selection, structurally valid forged-range rejection,
immutable graph policy, inactive publication with zero mutation calls,
unsupported schema 4, explicit recovery and permanent lock-loss rejection.
Canonical schema admission was strengthened after an independent code review.
Diff/whitespace and archive identity checks also pass. No new test suite/fixture
is committed and no broad tests, external data reads or functional operations
were run.

No deployment, migration, R2/Dropbox/database data operation, deletion, conversion,
retirement, scheduler/configuration change, LIVE modification or merge occurred.
There are no apply commands for this code-only phase. Functional acceptance must
follow separately authorised deployment and controlled real TEST operations;
none is claimed here. Rollback before future activation is a code release
rollback with no data mutation. Do not downgrade a future selected schema-2 scope
to stale schema-1 authority; retain compatible reading and explicit recovery.

## Chat-mode system-documentation handover

Record this as a **TEST code milestone only**, not deployed/accepted production.
The format is unchanged from the accepted future contract. Document the five
implementation files and new read-only preparation/direct-verifier interfaces,
the schema-3/hash-v1-only inspector capability and explicit schema-4/hash-v2
failure, immutable publication graph/lifecycle preparation and hard inactive gate.
Keep original-evidence/Prune/post-write, Integrity/SOS-light, JSONgen and
backup/reconstruction closure listed as prerequisites. No authoritative
`system_docs/` file was edited. No public API/configuration/schema migration or
chart behavior changed, and no measured savings/performance result is claimed.
