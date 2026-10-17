# Prune JSONgen original-final evidence: durability boundary

**Review:** 17 October 2026, TEST Ops PR #98. Structural inspection only. No
deployment, database operation, R2 write or runtime flag change.

## Finding

The current disabled Prune adapter prepares a version-1 final evidence envelope
after validated v3 batch finalization and successful return from
`markCandidateAndConnectorGateComplete`. Its `unretained_unverified` and
`transient_writer_memory_only` states remain correct. The current IngestDB
schema cannot prove that particular original gate commit after later gate
consumption or candidate/gate replacement. Durable trusted final evidence
requires a separately reviewed schema and transaction change; a best-effort
post-commit upload would leave an unrecoverable commit-to-upload crash window.

No evidence has been promoted to VERIFIED, and no new persistence hook is wired.

## Inspected boundaries

| Boundary | Persisted outcome | Limit |
| --- | --- | --- |
| Frozen source and PENDING upload | Optional immutable gzip in private derived R2 after one conditional PUT | A 2xx response is an acknowledgment, not independent byte retention or final authority. The pending description is transient. |
| Connector and full v3 batch | Original file/manifest/index identities and validated finalizer results in writer memory; canonical R2 metadata at replaceable keys | The prepared final envelope is transient. Later GETs can see a different canonical generation. The run manifest is a late summary, not a per-attempt transactional receipt. |
| Protected gate | One transaction updates `history_candidates` to complete/READY and upserts `prune_connector_day_gates` with run, source and connector manifest identities | Both rows are keyed by connector/day and mutable. No append-only gate acceptance/outbox row is inserted in that transaction. |
| Successful deletion | The deletion transaction changes READY to CONSUMED and sets gate `history_done=false` | The remaining candidate diagnostic may carry the old run, but is mutable and is not a final publication attestation. The gate row can later be invalidated or replaced. |
| Rediscovery or changed source | Candidate and gate fields can be cleared or replaced for a new attempt | Equal observation bytes cannot reconstruct the old commit or authorize borrowing its success. |

The source identity, run ID, manifest key/hash and counts are in the *current*
candidate/gate rows while those rows still describe the original attempt.
There is no separate committed transaction ID, immutable audit event or durable
per-attempt acceptance record in the inspected TEST schema. The unrelated
raw-observation sync outbox does not participate in this protected gate
transaction. No database or operational log was queried; these are code/schema
findings, not an assertion about historical deployed rows.

## Structural questions

- **A–C, original gate:** The mutable gate/candidate rows can describe a READY
  commit at that moment, and CONSUMED can preserve some diagnostics temporarily.
  They do not constitute an immutable, discoverable original transaction proof
  after replacement. An independent later consumer cannot safely authenticate
  all required original attempt, source, manifest and READY-at-commit facts.
- **D, canonical bytes:** Prune already has full source rows and verified file
  descriptors; it reads connector/child manifests and scoped roots during the
  original publication. A bounded original metadata snapshot or byte-pinned
  evidence can be assembled without routine Parquet decoding. References to
  replaceable canonical keys alone cannot preserve original metadata bytes.
- **E, budget and semantics:** A small atomic IngestDB record could avoid
  extra critical-path network round trips, but its size, query cost, row limits,
  privileges and effect on the existing transaction require review and real
  TEST measurement. Optional derived storage failure must not undo canonical
  Prune or change deletion eligibility.
- **F, crash window:** A post-commit R2 upload or log cannot close the interval
  between gate commit and delivery. A transactional record written with the
  protected gate is needed before an asynchronous derived-bucket delivery can
  be considered crash recoverable.

## Minimum prerequisite for review

The schema owner should decide an additive, append-only, per-attempt acceptance
and delivery-outbox record in `TEST-uk-aq-schema`, with no new global sequence,
queue, D1 database or lock. The record should have a collision-resistant
identity over writer, run/attempt, connector/day and pending intent; an immutable
versioned bounded payload (or a reference to evidence independently retained
and byte-verified before commit); the frozen-source
and pending identities; original final v3 batch, effective-status/binding
authority and canonical metadata/file identities; and the exact candidate/gate
run, source, manifest and READY marker.
It must be inserted inside the *same* protected transaction that completes the
candidate and gate, after checking that both updates applied to the intended
original attempt. Transaction commit plus the retained row, rather than a
writer-supplied `commit_returned` field, would be the original gate-acceptance
evidence. Consumption and rediscovery must not rewrite or remove it.

The design must specify limits and retention for exact original manifest/index
bytes or authenticated immutable snapshots, especially where canonical keys
can change; immutable canonical file SHA-256/length descriptors; write/read
roles; idempotent conflict handling; and an indexed pending-delivery query.
An independent delivery process could conditionally copy a bounded record to
`managed/jsongen/v1/` in the existing private derived bucket, then read it
back. The transactional row remains the recovery source after a lost or
ambiguous delivery. R2 2xx, byte integrity, trusted gate proof, current
canonical authority and VERIFIED eligibility remain separate states.
No schema, transaction or delivery implementation is approved by this note.
The present post-commit `prune-final-evidence.mjs` envelope must stay
unretained/unverified until an accepted transactional design replaces its
gate-return assertion with authenticated commit evidence.

## Interrupted and later operations

| Case | Safe classification with current code |
| --- | --- |
| PENDING PUT acknowledged; connector publication or final batch fails | Pending/unverified only; no original final authority. |
| Final batch passes; connector gate fails | Explicit unproven gate recovery; no eligible handover. |
| Gate commits; derived retention fails, is ambiguous, or Prune exits before delivery | Original success may have occurred, but final handover is unprovable after mutable rows change; reconciliation required. |
| READY later becomes CONSUMED | Valid deletion behavior; current READY must not be required for later JSONgen, but the missing original acceptance proof remains a blocker. |
| Later Prune attempt has identical bytes | Separate attempt; cannot borrow original publication or gate acceptance. |
| Later Integrity repair supersedes scope | Original proof, if retained, stays historical; a separate current canonical authority check must classify supersession. |
| GitHub Actions or later verifier is unavailable | Canonical Prune continues; no dispatch or VERIFIED result; missing durable handovers cannot be reconstructed from a summary or current metadata. |

Once a trusted transactional record and exact original metadata evidence exist,
an independent consumer can read back the pending gzip, compare complete
source/content/status/physical membership against the retained original v3
publication evidence, authenticate the original committed gate, and separately
inspect *current* canonical scope and binding authority. This need not make
routine canonical Parquet rereads part of JSONgen. Stage 1 receipt shape need
not change solely for this gate record, but receipt issuance and registration
remain out of scope and blocked pending independent proof and coverage.

## System-documentation handover

For ChatGPT in Chat mode, the required decision is whether the protected
Prune candidate/gate transaction may add an immutable per-attempt acceptance
record in IngestDB and how bounded original canonical metadata bytes, delivery
retries, retention and missing-record reconciliation are governed. If accepted,
update the JSONgen writer/ingestion contract and Prune connector-day gate
contract together, then put canonical DDL/migrations in TEST-uk-aq-schema.
Keep READY/CONSUMED deletion semantics and default-off JSONgen selection
unchanged. No authoritative `system_docs/` file was edited in this PR.
