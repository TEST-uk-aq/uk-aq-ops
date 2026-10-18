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

The schema-1 final envelope has one additive field:

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
Source/event identities are unchanged. Original P/R/null and explicit unavailable
provider source-status provenance are unchanged.

## Binding ownership and closure

Neither the normal Prune observation publisher nor its finaliser reads or verifies
Core's timeseries bindings. The actual owner is the selected-generation Core
Snapshot chain in `uk_aq_core_snapshot_to_r2.mjs`,
`reconcileR2HistoryV2TimeseriesBindings`, and
`refreshAndCommitTimeseriesBindingSource`. The v2-named helpers describe payload
semantics; the selected-v3 physical prefix is exclusively
`history/_index_v3/timeseries_binding/`.

That separate publisher owns the same global operation lock. It reconciles
physical bindings, publishes ranges/root, then refresh state, and commits its
`_source_state.json` completion marker last. The original Prune writer now takes
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

Before, binding and final metadata share the original **8 MiB raw / 4,096 object /
1 MiB per object** capture envelope, counting distinct retained versions of a key.
The final evidence remains **1 MiB total**, including base64 and source membership.
Base64 adds roughly one third; per-scope references also consume inline capacity.
The pending source remains 1,024 scopes, 100,000 rows, 32 MiB raw and 8 MiB gzip;
the general receipt/consumer limit remains 128 scopes.

Binding capture makes only bounded JSON GETs: at most `3 + distinct ranges +
physical scopes`, with caching inside the attempt. No listing, HEAD, PUT, Core
table read or Parquet access occurs. GETs use `r2GetObjectBounded`, the remaining
capture byte allowance and the remaining time in the **same original 15-second
optional signer/PUT episode**. Existing canonical publication/finalisation headroom
is rechecked before requests. No new reserve or deadline extension is introduced.
Large daily sources may fail the time/byte envelope; accepted maximum throughput
and full-AURN sizes have not been measured by this code-only task.

Failure states distinguish unavailable bytes/lock context, genuinely absent
binding metadata, contradictory physical/closure identities, deadlines and size
limits. None establishes an empty before-state. On inline overflow the entire
authority payload is replaced with explicit `oversized` diagnostics; no subset is
presented as complete. Legacy final evidence may still fit and be retained, with
this event ineligible for receipts. If legacy metadata also exceeds its existing
limit, the existing `not_captured` / null-bytea outbox behaviour remains.

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

The SQL event, final envelope and post-COMMIT reference remain schema 1. Existing
strict SQL validations accept the additional field without changing their meaning.
No new schema migration or Schema PR is necessary. The current PR #112 decoder
can continue authenticating its legacy snapshot, whose object namespaces and roles
are unchanged. Its unconditional `PRUNE_RECEIPT_AUTHORITY_GAPS` remains fail closed
until that PR explicitly implements this extension's independent decoder:

1. Authenticate the immutable original outbox SELECT and all existing source,
   bytea, writer, pending-private-byte, status and finalisation checks unchanged.
2. Require extension version/kind, complete states, original event/source identity,
   original lock relationship, exact source physical scope coverage and publication
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
| `scopes[i].before` | Exact matching `extension.before.scopes[].before` |
| `source.binding_authority` | `extension.binding.root` (standard four-field byte reference); root/range/physical closure is retained in this authenticated original extension |
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

Changed active modules and the focused test file pass `node --check`.
Focused existing checks (Node v24, `--test-isolation=none --test-reporter=tap`):

```sh
node --test --test-isolation=none --test-reporter=tap \
  --test-name-pattern='(original authority captures|unavailable contradictory and oversized|first publication ignores|prior committed 100-row)' \
  tests/uk_aq_prune_committed_history_guard.test.mjs
node --test --test-isolation=none --test-reporter=tap \
  --test-name-pattern='(pre-commit final preparation|mismatched signer metadata)' \
  tests/jsongen_prune_pending_source.test.mjs
UK_AQ_R2_HISTORY_VERSION=v3 node --test --test-isolation=none --test-reporter=tap \
  --test-name-pattern='(optional Prune outbox|optional evidence constraint|duplicate immutable event|candidate mismatch|unrecoverable outbox|default-off Prune|lost or ROLLBACK|Phase B accepts the real v3|default-off v3|Phase B v3 finalization validation)' \
  tests/uk_aq_prune_history_gate.test.mjs
```

Results: **4 + 2 + 20 passed**, no failures, cancellations or reported skips.
Other tests were excluded by name filters. No broad regression suite was run,
following this task's explicit validation scope. `git diff --check` and new archive
equivalence checks pass. Existing dated archives were reused without modification.

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
