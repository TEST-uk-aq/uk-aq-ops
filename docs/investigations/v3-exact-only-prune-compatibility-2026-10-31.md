# Exact-only Prune and independent post-write compatibility

31 October 2026. TEST code only, from TEST main `2adfe2af71c50ca194b639d35def5844518c21aa`,
which merged PR #157 including its `77671dbd` cost correction. Read together with
[the previous direct-verification handover](v3-exact-only-direct-verification-2026-10-31.md)
and the [accepted future exact-only contract](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/main/system_docs/r2_history/observation_history_index_v3_exact_only_future_contract.md).

**Schema-2 publication remains hard-disabled. Schema-2 Prune gate/deletion and
durable original-evidence handover are not activated.** This phase implements
read-only format compatibility and explicit failure at the unresolved original
handover boundary, rather than manufacturing a new receipt authority.

## Files and consumer behaviour

| File | Bounded change |
| --- | --- |
| `workers/shared/uk_aq_observation_history_exact_only_consumer_v3.mjs` | New shared adapter for an already selected schema-2 scope. Pins exact selector/registry and canonical body identities, establishes actual checksum-HEAD capability, invokes the existing complete canonical/physical verifier and compares its final identities. Provides the explicit unsupported durable-handover error. No catalogue, receipt or writer state is persisted. |
| `workers/shared/uk_aq_observation_history_exact_only_verifier_v3.mjs` | Advances the internal direct verifier identity to `exact-only-canonical-physical-v2`. Accepts the real authenticated native GET shape without fabricating stored checksum metadata: always computes full-body SHA; declared size and any supplied checksum must agree; canonical file reconciliation still checks that exact computed SHA. The existing HEAD recheck remains strict. |
| `workers/uk_aq_prune_daily/committed_history_guard.mjs` | Explicit schema/kind/version dispatch. Schema 1 retains its aligned canonical binding. Schema 2 invokes complete root-to-DCP/actual-file verification, then retains the original full frozen-source comparison and the unconditional block on replacing already committed history, including identical duplicates. No already-committed scope becomes first-publication or deletion authority. |
| `workers/uk_aq_prune_daily/phase_b_history_r2.mjs` | Supplies the existing supervisor/run-local-cache lifetime assertion and native HEAD adapter to committed-history admission. At connector verification, explicitly rejects schema 2 before returning gate evidence because the completed direct original handover is not accepted and the completed root does not yet exist at this seam. All normal schema-1 writes/finalisation/READY handling remain. |
| `scripts/jsongen/prune-final-evidence.mjs` | Only the Prune-owned original-envelope preparation interface changes: inspect retained exact-index metadata with explicit dispatch; schema 2 raises `PRUNE_EXACT_ONLY_DURABLE_HANDOVER_UNSUPPORTED` / `exact_only_durable_handover_unsupported`. It does not silently serialize a new direct-proof claim into old evidence. No JSONgen Parquet pass, receipt/digest or consumer authority change. |
| `scripts/index_v3_migration/index_v3_steady_state_post_write_verify.mjs` | Shared format-aware compact-latest validation, retained schema-1 aligned checks, complete direct schema-2 verification and exact selected/canonical file reconciliation. Independent report verifier version advances from 2 to 3. CLI reuses the existing global observations-operation lock around the existing read-only operation, with the original session-loss assertion. Embedded schema-2 calls without a held-operation assertion fail closed. |
| `tests/uk_aq_prune_committed_history_guard.test.mjs` | Give the existing schema-1 selector fixture its required schema/version fields; add one narrow real-Parquet schema-2 consumer/source-retention/post-write/original-handover check. |

Exact pre-change snapshots for the four newly modified existing consumer files
are under `archive/2026-10-31/`, preserving relative paths. The direct verifier's
existing daily snapshot from PR #157 is reused unchanged. Archives are not
imported or executed. Authoritative `system_docs/` is unchanged.

## Independent proof, source identity and lock lifetime

Schema 2 takes no aligned parent/shard dependencies. It authenticates the entire
current canonical root/year/month/day/connector/pollutant chain and the specific
selected selector/leaf set using PR #157's verifier. Every canonical member,
file/group/row position, count, bound and projected range is reconciled against
actual full-file lossless decoding and physical inspection. The wrapper compares
the result to the **original** discovered selector identity and previously pinned
canonical body; later same-key advancement does not become replacement authority.

Prune committed-history admission retains the complete frozen pollutant set and
canonical observation-content-hash/count/status comparison. A successfully
verified identical prior publication is still blocked with retained IngestDB rows
and the original duplicate-history diagnostic. Changed values with unchanged row
counts remain blocked. First publication still follows the existing absence
route, shared writer, complete snapshot, source-to-final verification, required
final hierarchy and batch validation, protected candidate/gate transaction and
single-use READY-to-CONSUMED deletion lifecycle. Those source/deletion modules,
SQL, digest encoders and original outbox transaction code are unchanged.

The existing outer Prune supervisor owns the global operation session and
terminates its child on loss. The existing process-local evidence cache binds
owner/run/nonce/lifetime; the new assertion requires that same supervised context.
This is the already accepted run-local supervision model, not a new environment
lock flag or a lease. Direct proof context and consumer assertions permanently
reject observed lock loss. Independent post-write CLI uses
`withObservationsGlobalOperationLock()` on its retained PostgreSQL session and
keeps existing READ ONLY/rollback semantics. Acquiring/releasing the existing
advisory lock uses SELECT; no SQL/data mutation adapter is admitted. The CLI's
schema-1 proof remains aligned; it now also runs under shared operation exclusion.

## Real R2 adapter and HEAD capability

Code inspection found that native `r2GetObject()` returns `{key, bytes, body,
etag}` and does **not** expose stored SHA metadata. Requiring that missing field
would make PR #157's direct verifier unusable through the actual adapter. The v2
verifier computes SHA-256 from the complete authenticated GET body and compares
it to the authenticated canonical file SHA. If GET also supplies a checksum,
contradiction fails closed. This is actual byte proof, not a caller-invented
stored-checksum claim. Size and current ETag remain required.

`r2HeadObject()` requests `x-amz-checksum-mode: ENABLED` and normalises a returned
checksum. Requesting the header does **not** prove every object/provider returns
it. Before admitting HEAD rechecks, the consumer probes the actual required file
responses. Exact key/existence, supported SHA, byte size and current ETag must be
available; checksum and declared-size contradictions fail immediately. A missing
checksum/capability chooses full authenticated GET/hash rechecks **before** the
proof context is created. Once checksum HEAD is admitted, later uncertainty or
contradiction retains PR #157's permanent proof invalidation and no-fallback
rule. ETag alone is never SHA evidence.

The canonical pre-pass in the independent post-write verifier retains schema-1's
stored-HEAD checks. Only a selected schema-2 scope under held exclusion can use
full GET/hash when checksum metadata is absent. The subsequent direct verifier
still performs its own independent physical inspection. All such work is per
complete DCP/file pass, not per exact leaf. Checksumless providers can therefore
incur an additional canonical full-GET pass plus the direct verifier's full GET
identity recheck; there is no new permanent physical cache or configurable
bypass. Real deployed checksum availability, CPU, bytes and latency have not been
queried or accepted in this code-only task.

## Precise durable original-evidence contract gap

The accepted future contract requires the **completed original** direct verifier
result, not merely a copied operation-local report, to bind:

| Required binding | Existing accepted boundary / missing meaning |
| --- | --- |
| Specific canonical body and full DCP | Original metadata snapshot can retain canonical body bytes and complete membership; original pending source records full frozen-source identities. |
| File SHA/size and exact selector/leaf set | Exact final metadata can retain descriptors and JSON bodies, but their presence is not an attestation of actual complete physical inspection. |
| Direct verifier and physical reader/profile version | No accepted typed original-envelope/receipt field authenticates the completed direct-verifier result and its capability/profile. |
| Source-to-final and completed finalisation | Existing `original_final_batch.validation` authenticates its established v3 finalizer boundary; direct verifier reports deliberately leave `source_to_final_verified` and `finalisation_complete` false. These cannot be flipped or inferred from metadata by the receipt consumer. |
| Original gate acceptance | Existing original run/source/candidate/manifest/READY identities, exact evidence/bundle digests and same-transaction immutable outbox must remain controlling, with acknowledged original commit and unchanged receipt authentication. |

The existing outer envelope/bundle can encode JSON bytes, but that does not make
an added physical-proof assertion part of its accepted authority. A future
**explicitly versioned and accepted** original extension must define who binds
that completed direct result under the original lock, its exact field/set
encoding, finalisation timing and independent receipt authentication. It must
bind into the existing original evidence/bundle/outbox digest boundary without
reinterpreting older hashes or receipts. Do not create a separate catalogue or
reconstruct original evidence after source deletion. The appropriate future
location is the existing original handover, not another JSONgen Parquet verifier.

This specific integration stops here. The mandatory connector-stage Prune guard
refuses schema-2 gate evidence even if optional JSONgen evidence is disabled;
the original-envelope preparation interface also explicitly rejects retained
schema-2 records. Optional JSONgen failure still cannot veto valid **schema-1**
canonical gates/deletion. No existing READY permission is created, broadened or
reinterpreted for schema 2. No single verifier result is all-writer delivery,
supersession, freshness or backup/reconstruction proof.

## Supported formats and remaining prerequisites

Schema 1 retains exact/aligned production and proof behaviour. Schema 2 supports
read-only selected-scope verification for physical schema 3 / writer v3 /
observation hash v1 / `timeseries-aligned-v2` /
`hyparquet-direct-column-v1`. Unknown schema/kind/version tuples, stale bodies,
contradictory file metadata and missing held-operation assertions fail closed.
Physical schema 4 and hash-v2 inspection remain unsupported by the inherited
inspector. The shared publication hard-disable constant is unchanged.

Durable original-proof semantics and their independent receipt consumer remain
blocked pending Chat-mode contract resolution and a later bounded implementation.
Also retain all remaining fixed-v3 Integrity/SOS-light, JSONgen, compact-latest,
backup/reconstruction, deployment and real TEST acceptance prerequisites. No
changes to those services or receipt/digest versions are included here.

## Structural validation and limitations

Selected checks, no operational calls:

- `node --test --test-isolation=none --test-name-pattern='first publication ignores|prior committed|pollutant omission|overwritten parent|missing or contradictory index|schema-2 committed' tests/uk_aq_prune_committed_history_guard.test.mjs`: **6 passed**.
- `node --test --test-isolation=none tests/index_v3_steady_state_post_write_verify.test.mjs`: **17 passed**.
- `node --test --test-isolation=none --test-name-pattern='connector-day gate is exact|completion persist identical|candidate mismatch|default-off|lost or ROLLBACK|identical legacy' tests/uk_aq_prune_history_gate.test.mjs`: **7 passed**.
- `node --test --test-isolation=none --test-name-pattern='source-identity mismatch|verification-status-only|actual deleted-row mismatch|non-empty final snapshot' tests/uk_aq_prune_source_identity.test.mjs`: **4 passed**.
- Syntax/import checks of the six changed/new active modules, syntax of the changed test, diff/whitespace and archive identity checks.
- Focused independent code review found no important defect.

These **34 selected tests passed, with zero runtime skips**. The name filters
intentionally exclude unrelated capture/transport/resource cases, in accordance
with the user's explicit structural/essential-safety-only limit. That limit takes
precedence over the local Prune AGENTS suggestion to run the entire Node suite.
No broad suite is claimed passed.

An initial combined run of the two relevant test files exposed existing optional
capture failures; its large capture fixture later terminated with **exit 137**.
Two narrow failures were independently reproduced on unchanged TEST main
`2adfe2af` in a temporary detached baseline: `original authority captures ...`
and `unavailable contradictory ...` expect retained capture/PENDING success,
but their fixture's `ndjsonPath: 'unused'` produces ENOENT and `no_intent`.
These baseline fixture failures were not repaired or relabelled as passes. The
large 433-scope resource fixture is not operational sizing evidence. This phase's
new real-Parquet test and essential preserved branches pass independently.

No deployment, merge, migration, operational SQL/R2/Dropbox read or mutation,
conversion, deletion, settings/environment change or LIVE modification occurred.
There are no apply commands for this code-only phase. Functional acceptance must
follow separate deployment/run authorisation; rollback now is code-only while
schema-2 publication remains inactive.

## Chat-mode documentation handover

Record a TEST code-only consumer compatibility milestone, not schema-2 readiness.
Document direct verifier v2 and post-write report verifier v3, native GET SHA
proof and observed-response HEAD admission, read-only schema-2 Prune/post-write
support, and the explicit original-handover/gate rejection. Resolve the typed
completed-direct-proof original extension/version/encoding/finalisation boundary
before its next implementation; preserve historical receipt/digest meanings.
Keep publication hard-disabled and all remaining consumer/reconstruction and
operational acceptance gates outstanding. No authoritative system-doc file was
edited and no all-writer freshness or source-deletion acceptance is claimed.
