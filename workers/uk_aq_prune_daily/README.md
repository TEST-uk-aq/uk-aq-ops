# Prune Daily JSONgen source handover

The selected-v3 handover is disabled by default. `UK_AQ_JSONGEN_PRUNE_PENDING_SOURCE_ENABLED=true`
enables it in TEST only. Configure `UK_AQ_JSONGEN_PRUNE_SIGNER_URL` with the reviewed,
Cloudflare Access protected HTTPS `/v1/upload-intents` route, plus dedicated
`UK_AQ_JSONGEN_PRUNE_WRITER_TOKEN`, `UK_AQ_JSONGEN_SIGNER_ACCESS_CLIENT_ID` and
`UK_AQ_JSONGEN_SIGNER_ACCESS_CLIENT_SECRET`. These are separate from canonical
and chart R2 credentials. No R2 write credential is passed to Prune for this handover.

After prior-authority admission, Prune validates and compresses the exact frozen
connector-day source. It asks the signer for a 60-second intent bound to its
invocation, scope, byte sizes and SHA-256 identities, validates the response,
and sends one conditional PUT with exactly the required signed headers. The
optional operation has a 15-second shared deadline for signer and PUT, and is
skipped unless canonical publication and v3 finalization budget is reserved.
Failures cannot block canonical publication, source cleanup or deletion gates.
The v2 path never enters this handover.

`phase_b_jsongen_pending_source_put_acknowledged` means only that R2 returned a
2xx response to the PUT. It does not mean independent byte readback or verified
retention. 412 means the conditional write did not occur; 409, 5xx and transport
failures have an ambiguous storage outcome. The warning event
`phase_b_jsongen_pending_source_unavailable` carries a safe reason code but no
secret, presigned URL or claim of recovered bytes. Reconciliation requires a
separate private, bounded reader. No descriptor, receipt, control registration,
monthly publication or remote acceptance is performed by this path.

The optional pending preparation records a versioned, reproducible description
of the complete frozen source and its exact byte identities. The compact
source's `status` is effective `verification_status`, not proven original
provider status. `original_source_status_unavailable` explicitly records that
provenance gap; its null `source_status` makes no claim that the provider sent
null. Existing canonical P/R/null values and bytes are left as written.
The acknowledgment log exposes the preparation digest and intent reference;
the description itself is not separately retained.

After successful v3 batch finalization and before the protected gate transaction,
Prune can prepare an original-final evidence envelope from already available
connector manifests, child content hashes and status counts, canonical file
identities, selected-v3 exact-scope references and final batch results. It runs
only for an acknowledged pending upload. Its version-1 shape now states that
the gate transaction has not yet been asserted; it never says `commit_returned`
before COMMIT. The optional same-connection PostgreSQL function in open TEST
Schema PR #11 can retain this preparation plus typed original-gate evidence
inside the protected transaction. It is called only when this TEST-only
handover is enabled. A savepoint isolates supported evidence-only insert
failures; the original mandatory candidate/gate checks remain fail-closed.
`outbox_missing` and `incomplete_json_source_coverage` diagnostics identify
gaps, but a missing event is not discoverable from the outbox later. A unique
identity conflict is `outbox_unresolved`: an earlier event may exist and must
be independently compared, never rewritten or treated as this call's success.

The 1 MiB preparation is a structural cap, not measured operational capacity
or complete final authority. Prune already reads the exact connector manifest
and child metadata during verification, but the envelope retains references
and hashes rather than every original mutable connector/child/parent/index/root
metadata byte. Those keys may later change. `prepared_unverified` or
`not_captured` therefore cannot authorize a Stage 1 VERIFIED receipt,
JSONgen selection or monthly publication. A separately reviewed complete
bounded snapshot or pre-gate independently verified immutable metadata
reference is still required. No canonical Parquet reread or optional derived
network operation occurs inside the PostgreSQL transaction.
Before TEST activation, verify real signer permissions, conditional PUT and
private readback, budget limits, canonical finalization and gate results,
interruption recovery, and a durable independently authenticated final evidence
chain in a separately authorized deployment.
The [gate durability review](../../docs/investigations/jsongen_prune_final_evidence_durability_boundary.md)
records why mutable candidate/gate rows and a late run manifest alone do not
provide a replayable original gate receipt. TEST Schema PR #11 remains unmerged
and unapplied; this integration is default-off and has no operational acceptance.
