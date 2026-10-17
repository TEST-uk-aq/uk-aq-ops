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

After successful v3 batch finalization and the original protected gate return,
Prune can prepare an original-final evidence envelope from already available
connector manifests, child content hashes and status counts, canonical file
identities, selected-v3 exact-scope references and final batch results. It runs
only for an acknowledged pending upload. The envelope and gate-return statement
remain transient and unverified; later gate consumption is allowed, but there
is no retained original gate transaction proof. No canonical Parquet reread or
additional derived-bucket write/readback occurs here. Thus neither event can
authorize a Stage 1 VERIFIED receipt, JSONgen selection or monthly publication.
Before TEST activation, verify real signer permissions, conditional PUT and
private readback, budget limits, canonical finalization and gate results,
interruption recovery, and a durable independently authenticated final evidence
chain in a separately authorized deployment.
The [gate durability review](../../docs/investigations/jsongen_prune_final_evidence_durability_boundary.md)
records why the current mutable candidate/gate rows and late run manifest do
not provide a replayable original gate receipt. An additive transactional
acceptance/outbox design needs schema-owner review before this hook can retain
trusted final evidence.
