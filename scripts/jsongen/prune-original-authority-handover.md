# Original AURN Prune before-membership and binding authority

Implementation record, 18 October 2026. TEST code only, not operational acceptance.
Read the authoritative [quick reference](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/main/system_docs/station_charts/jsongen_prune_verification_handover_quick_reference.md)
first. This supplements [the writer handover](prune-writer-handover.md) and the
consumer handover on [Ops PR #112](https://github.com/TEST-uk-aq/uk-aq-ops/pull/112).
Neither PR #112 nor Schema PR #12 is modified. No authoritative system docs,
configuration, pending-source flag, paused scheduler or LIVE repository changed.

## Original evidence points and supported scope

`committed_history_guard.mjs` already reads and authenticates the selected-v3
observation root and its applicable year/month/day path under Prune's existing
global operation lock, before any canonical PUT. Its existing latest-registry
check corroborates absence; latest is not an authentication parent. A missing
year, month, day or connector descriptor in that authenticated hierarchy proves
no committed connector-day, including every physical scope in its frozen source.
A missing root, arbitrary 404 or missing capture does not prove absence.

Previously committed connectors take the existing pollutant/exact/aligned-index
validation path and are rejected, even with identical observations: the writer
cannot authenticate the original unfinished attempt from content alone. The
canonical connector publisher also reads previous connector child descriptors
under its existing connector/day lock, but those reads occur too late to replace
the pre-PUT admission view. Loose same-key/orphan objects are not committed
membership. This amendment preserves those admission and lock rules.

Thus the genuinely admitted original membership here is `authoritative_empty`,
with zero committed prior rows. There are no previously committed observations
retained, replaced or removed by these admitted first publications. A present
historical scope cannot be relabelled empty or receive a successful original event.
Unknown/unavailable prior authority remains unavailable. Present/removal receipts
would require a separately accepted, authenticated original-attempt/complete-source
admission seam and original per-physical-scope index membership; this PR neither
introduces that permission nor reconstructs old observations.

The existing v3 publisher returns verified/durable canonical and exact-index byte
references; the existing run finaliser returns required day/aggregate/latest
publication. After `validatePhaseBV3RunFinalizationResult`, their exact bytes
continue to be retained in the legacy final metadata snapshot. No additional
canonical Parquet read, observation comparison, finalisation or completion gate
has been added.

## Capture timing and representation

The existing metadata capture now gives each original candidate a separate
pre-publication view. `writeFrozenCandidateObservationsToV2` supplies its existing
admission guard with a capturing GET adapter and optional `onOriginalAuthority`
callback. The guard reports its actual validated absence cut, not a later inference
from the published source. Original and final versions of the same key occupy
separate capture slots. Exact bodies are copied before replacement, with canonical
bucket/key, length and SHA-256. Retention callbacks cannot alter admission.

The outer final envelope and SQL event remain schema 1. The wire representation
now uses nested **schema-2 markers** for `original_metadata_snapshot` and
`original_authority_extension`, each naming `inline_original_metadata_gzip_v1`
and the uncompressed evidence digest. `original_metadata_evidence` is a version-1
`canonical_json_gzip_v1` descriptor with compressed/uncompressed SHA-256 and lengths,
and base64 of the gzip bytes. It contains both complete logical metadata objects
in one deterministic canonical-JSON payload; repeated identities/references and
base64 bodies compress together without losing a byte. No mutable-key lookup or
external store substitutes for original bytes.

`decodePruneMetadataEvidence()` validates codec/version, exact compressed bytes,
bounded decompression, canonical JSON, marker agreement, every raw object's
size/SHA/base64 and the combined raw byte/object counts. It returns the original
schema-1 logical snapshot and extension. It is a transport decoder, not writer
or canonical authentication. The decoded logical extension is:

```text
original_authority_extension
  schema_version = 1
  kind = uk_aq_prune_original_scope_binding_authority
  completeness = captured | unavailable | contradictory | oversized
  capture_boundary = original_global_lock_before_canonical_replacement
  identity = TEST / v3 / canonical bucket / original writer Git SHA,
             invocation+attempt / connector+day / frozen source identity
  lock = original supervisor's logical identity / owner / invocation
  before
    state = captured | unavailable | contradictory | oversized
    original_observations_root / hierarchy[] / index_discovery
    absence = parent_key / child_field / child_identity
    scopes[] = identity / day_utc /
               before { state: authoritative_empty, row_count: 0, authority } /
               transition: first_publication_no_committed_observations
  binding
    state = captured | unavailable | contradictory | oversized
    publisher / relationship / root / source_state / refresh_state
    source_root_hash / source_fingerprint
    bindings[] = exact physical identity / authority / range
  objects[] = phase (before|binding) / bucket / key / byte_size /
              sha256 / bytes_base64
  publication = pending_preparation_sha256 / source_evidence_sha256 /
                connector_manifest / original_final_batch_sha256 /
                transaction_state: prepared_before_original_gate_transaction
```

An entirely unavailable or oversized extension can contain only its version,
kind, reason and bounded diagnostics. A consumer must require the complete form.
`captured` means original bytes and relationships were retained, not independent
authentication or VERIFIED. The final-batch hash uses existing `canonicalJson`.
The source hash semantics and existing event/reference schemas are unchanged;
old events are never rewritten. New supervised runs generate a UUID before
acquiring the existing lock and reuse it for Phase B. The real inherited lock
context is validated with `expectedOwner=prune_daily` and the exact original
Prune UUID, including held/acquired, nonce, lock IDs and outcome. A caller's
`valid=true`, wrong invocation or legacy nonmatching supervisor ID is insufficient.
The supervisor's existing session-loss termination is unchanged; there is no new
lock or query. Original P/R/null and unavailable provider provenance are unchanged.

## Binding ownership and closure

Neither the normal Prune observation publisher nor its finaliser reads or verifies
Core's timeseries bindings. The actual owner is the selected-generation Core
Snapshot chain in `uk_aq_core_snapshot_to_r2.mjs`,
`reconcileR2HistoryV2TimeseriesBindings`, and
`refreshAndCommitTimeseriesBindingSource`. The v2-named helpers describe payload
semantics; the selected-v3 physical prefix is exclusively
`history/_index_v3/timeseries_binding/`.

That separate publisher owns the same global operation lock. Reviewed actual
order: physical reconciliation, changed ranges, root, refresh state, then source
state PUT/readback **when a new eligible Core proposal is being committed**.
`refreshAndCommitTimeseriesBindingSource` can instead reuse an already committed
matching source state; it does not unconditionally rewrite that marker last.
Both branches require the retained source fingerprint and refresh/root hash to
agree. A hierarchy-only refresh is not a new Core reconciliation attestation. The original Prune writer now takes
a bounded metadata-only snapshot after pending PUT acknowledgement and before
canonical observation replacement, while its original global lock remains held:

- `_manifests/root.json`, `_source_state.json`, `_manifests/_refresh_state.json`;
- every distinct applicable 1,000-ID range manifest;
- every exact physical timeseries binding for the complete pending source.

Existing root/range validators check their substantive hashes. Root/range/unit
membership, exact binding size/SHA, selected namespace, station/timeseries/
connector/pollutant identity and matching completion-marker fingerprint/root hash
must agree. Original source-table provenance remains in the captured source-state
bytes. This is explicitly a snapshot of **Core-owned completed binding metadata**,
not a claim Prune reconciled Core or reverified its table/observation data. Binding
schema-2 continuity bytes are retained; the independent consumer still validates
continuity semantics before using them. Missing completion markers, including a
generation whose migration did not populate them, leave evidence unavailable;
they cannot be invented from a physical binding key. A later authorised matching
Core publication is an operational prerequisite for such future events, not a
repair to an already incomplete original event.

## Resource and failure behaviour

Before, binding and final metadata still share **8 MiB raw / 4,096 retained
versions / 1 MiB per object**. Original capture has an explicit shared allocation
of at most **4 MiB / 2,048 versions**, leaving at least half initially available
for final metadata. Final canonical metadata has priority: if necessary, the
capture releases whole original groups, marks them `oversized` with
`final_metadata_capacity_priority_limit`, and admits final bytes within the
unchanged global limits. No partial original group remains complete. Failed
replacement is atomic: retained bytes/counts are unchanged and stale final bytes
are hidden until a valid replacement is admitted. Original/final versions of
mutable keys stay separate; contradictory original rereads cannot overwrite them.

The immutable outbox remains **1 MiB total**, including the source description,
outer identities/relationships, codec descriptor and compressed metadata base64.
The codec separately bounds its canonical JSON representation to **16 MiB**:
this accounts for base64/descriptor expansion of the existing 8 MiB raw envelope,
not an increase in raw capture or outbox capacity. Decoding checks the same
8 MiB / 4,096 / 1 MiB raw limits. If the entire encoded envelope cannot fit, all
required metadata is classified `not_captured`, final bytea is null, and the
optional gate-only event may still commit. No partial payload is presented as
complete. Unknown encodings, corrupt bytes and incomplete authority fail closed.

A deterministic synthetic 433-scope check with one large admitted canonical JSON
object retained **882,649 raw metadata bytes**. Its expanded inline form was
**1,725,771 bytes**, its compressed metadata **79,779 bytes**, and its compact
illustrative envelope **151,052 bytes**. These exact structural sizes show the
codec benefit for that fixture; they establish neither real AURN distributions
nor a guaranteed maximum. Incompressible bytes, large continuity objects, very
large parents, many ranges and the rest of the source/envelope still compete for
capacity. **1,024 scopes are not guaranteed to fit.** Pending limits remain
1,024 scopes, 100,000 rows, 32 MiB raw / 8 MiB gzip; downstream receipts remain
128 scopes with their existing coupled operation/byte limits.

Binding collection uses **eight fixed workers**, first deduplicating/validating
applicable ranges, then collecting physical bindings. Root/source/refresh reads
are a fixed group of three. Reads and parses are memoized by exact key; original
byte identities are cached. Binding requests total at most `3 + distinct ranges
+ distinct physical keys`. Full `(connector, timeseries, station, pollutant, day)`
scope identity and exact complete source row totals are checked. There is no
upfront timeseries-only scope uniqueness rule. The namespace has one physical
binding key per timeseries; every declared full scope must match that same
root/range-pinned object, so conflicting station/pollutant claims are rejected.

Every request uses `r2GetObjectBounded`, its known physical size where available,
remaining allocation and at most **15 seconds per GET**. The 21 October correction
gives binding capture a **90-second absolute window**, starting before pending
source preparation; the overlapping source preparation/signer/PUT still has its
own original **15-second** absolute deadline. The complete 90 seconds is admitted
in addition to the existing mandatory connector-publication and v3-finalisation
reserves and the five-second bundle allowance. Mandatory headroom is rechecked
around reads. The global Phase B budget and lock lifetime policy are unchanged.

The 21 October TEST log archive records only 255 requested keys / 247 retained
objects in 14,995 ms for a 940-scope day. Those counts include completion and range
metadata, with up to eight in-flight reads; they do not mean eight missing scopes.
Reads are already cached and overlapped with source preparation. The new budget
keeps concurrency at eight and permits roughly a minute of observed-throughput
work with margin; real full-day latency remains to be accepted. Diagnostics now
include `binding_capture_required_key_count` for the complete deduplicated plan.

A deadline or collection error aborts outstanding requests; HTTP and bounded
adapter paths propagate cancellation. Workers preserve the first failure and
drain; capture closes mutation, releases partial binding allocations and awaits
bounded reads/work before returning to canonical publication. Late raw adapter
responses cannot mutate settled evidence. Binding becomes captured only after
every required object and physical scope validates.

Failure diagnostics distinguish absent metadata, invalid/mismatched lock context,
unknown prior membership, contradictory Core/root/range/binding identity, timeout,
and raw/encoded capacity. None establishes an empty before-state. No LIST, HEAD,
PUT, Core table read, Parquet read or observation re-verification was introduced.

After normal finalisation the extension is bound in memory to the exact original
source, pending intent preparation, connector publication and final-batch digest.
The unchanged protected sequence remains mandatory candidate/gate checks, optional
SAVEPOINT-isolated outbox insertion, explicit COMMIT acknowledgement, then the
deterministic reference. There are no new database/R2 operations in that transaction.
Unsafe/ambiguous COMMIT still fails closed. The immutable original outbox remains
the only durable original evidence; the reference remains undelivered. Diagnostics
report capture/absence/binding states, finalisation, gate/outbox/reference outcomes
and independent authentication outstanding without metadata bodies or source rows.

## Exact PR #112 consumer handover

The SQL event, outer final envelope and post-COMMIT reference remain schema 1;
all SQL-validated writer/source/gate identity fields remain directly available.
Existing strict SQL validators are unchanged. No migration or new Schema PR is
necessary. Nested metadata markers are now version 2 and their codec descriptor
version 1: PR #112's current strict schema-1 snapshot decoder deliberately rejects
these new events until it adopts the bounded decoder. Legacy version-1 events
remain recognizable, with missing or mismatched original authority still blocked.
The PR #112 branch is unchanged. Its required decoder/admission changes are:

1. Authenticate the immutable original outbox SELECT and exact outer bytea first.
   Recognize nested marker version 2 / codec version 1 and use the bounded
   `decodePruneMetadataEvidence` transport decoder; account compressed, decoded
   JSON and raw metadata within existing consumer budgets. Then apply existing
   source, writer, pending-private-byte, status and finalisation checks to the
   decoded logical snapshot/extension. Do not use decoded shape/hashes as origin
   proof or weaken existing validators. Unsupported versions remain blocked.
2. Require extension version/kind, complete states, original event/source identity,
   original lock UUID equal to the Prune invocation/attempt, exact full physical scope coverage and publication
   hashes. Unknown versions, missing extensions and incomplete states stay blocked.
3. Hash/size-check every retained exact body with bounded accounting. Keep original
   before objects separate from final objects even when their keys match. Never
   fetch the mutable canonical key to recover the old version.
4. Authenticate the before root-to-absence path using existing aggregate/day
   validators and parent content/manifest hashes. Prove the indicated child is
   absent at the exact parent; match target connector/day and all physical scopes.
   Validate the original latest-registry corroboration without making it a parent.
5. Authenticate selected-v3 binding root/range hashes and physical membership,
   exact object bytes/identities, and the Core completion-marker relationship.
   Validate applicable schema-2 continuity without fabricating validity or source
   provenance. No canonical observation or Core-table scan is required.

Field mapping after those checks:

| Stage 1 field | Retained original representation |
| --- | --- |
| `scopes[i].before` | Exact matching decoded `extension.before.scopes[].before` |
| `source.binding_authority` | Decoded `extension.binding.root` (standard four-field byte reference); root/range/physical closure is retained in this authenticated original extension |
| Final scope/status/source | Existing PR #112 publication/source decoder, additionally bound to `extension.publication` |

No Stage 1 receipt wire-version change is needed for these two fields. Hash/shape
validation alone still cannot authenticate the writer. The original outbox and
its exact final-evidence digest must remain linked through PR #112's existing
proof-token/provenance mechanism and later receipt evidence; do not create a
second original authority store. Legacy events cannot gain original proof later.
Schema PR #12's independent reader privileges remain a separate prerequisite.

After decoder work, remaining Stage 3B work is strict receipt/bundle construction,
immutable retention and readback with ambiguous-write/crash recovery, and complete
whole-scope partition coverage registration through existing control CAS. Later
canonical currentness/supersession, monthly baselines/PM context, paired monthly
generation/publication and chart activation remain separate. No VERIFIED receipt
is issued by this writer.

## Structural validation and Chat-mode documentation handover

All eight changed/new active modules and four focused test files pass `node --check`.
Focused existing checks (Node v24, `--test-isolation=none --test-reporter=tap`):

```sh
node --test --test-isolation=none --test-reporter=tap \
  --test-name-pattern='(original authority captures|unavailable contradictory and oversized|bounded concurrent original|original capture deadline|original capture capacity|first publication ignores|prior committed 100-row)' \
  tests/uk_aq_prune_committed_history_guard.test.mjs
node --test --test-isolation=none --test-reporter=tap \
  --test-name-pattern='(pre-commit final preparation|mismatched signer metadata)' \
  tests/jsongen_prune_pending_source.test.mjs
UK_AQ_R2_HISTORY_VERSION=v3 node --test --test-isolation=none --test-reporter=tap \
  --test-name-pattern='(optional Prune outbox|optional evidence constraint|duplicate immutable event|candidate mismatch|unrecoverable outbox|default-off Prune|lost or ROLLBACK|Phase B accepts the real v3|default-off v3|Phase B v3 finalization validation|Prune Daily CLI orchestration|Prune Daily locked child)' \
  tests/uk_aq_prune_history_gate.test.mjs
node --test --test-isolation=none --test-reporter=tap \
  --test-name-pattern='fetchWithTimeout' tests/r2_sigv4.test.mjs
```

Results: **7 + 2 + 22 + 3 = 34 passed**, no failures, cancellations or reported skips.
Other tests were excluded by name filters. No broad regression suite was run,
following this task's explicit validation scope. `git diff --check` and new archive
equivalence checks pass. Existing dated archives were reused without modification.
The protected candidate/gate/COMMIT function and mandatory v3 finalisation
validator remain byte-identical to main. Node built-ins provide compression;
there is no new dependency, configuration name or environment setting.

ChatGPT in Chat mode should document the original pre-PUT admitted-absence capture,
Core-owned v3 binding closure snapshot, additive versioned extension, shared limits,
optional failure behaviour and exact consumer mapping above. No authoritative
system-doc file was edited. Operational acceptance remains outstanding: real
selected-v3 completion-marker availability, full-AURN metadata/inline sizes and
timing, original lock/finalisation/COMMIT/outbox durability, and independent consumer
authentication must be established only during later authorised TEST operations
after the full pipeline is implemented and deployed. No Prune, signer, operational
database/R2, migration apply, Actions dispatch, deployment or settings operation
was performed. Rollback is reverting this code PR; preserve original events and
pending objects, and leave the operator's settings unchanged.
