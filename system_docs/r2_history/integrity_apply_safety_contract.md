# R2 history Integrity apply safety contract

## Authority and scope

This document is an authoritative amendment to:

- [`integrity.md`](integrity.md);
- [`history_writer_coordination.md`](history_writer_coordination.md);
- [`implementation_safety_contract.md`](implementation_safety_contract.md);
- [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md).

It defines the required proposal ownership, final pre-mutation validation, live R2 semantic verification, publication order and bounded verification-cache behaviour for real Integrity observation repairs.

Where older wording or active code conflicts with this document, this document is authoritative for these subjects.

The purpose is to ensure that a correct source-derived repair cannot be replaced by stale compatibility metadata and that no live R2 mutation begins until the complete final proposal is internally consistent.

## Immutable source evidence

For each selected:

```text
day_utc + connector_id + pollutant_code
```

Integrity MUST persist immutable current-run source evidence before proposal generation.

The evidence MUST include, or deterministically identify:

- the canonical selected observation rows;
- total and per-timeseries row counts;
- `verification_status_counts`;
- `observation_content_hash` and its contract version;
- the identity-pinned source files and source-normalisation inputs used to produce the evidence.

Later proposal, compatibility, metadata, apply and verification stages MUST NOT modify or replace this evidence.

## Proposal ownership and compatibility metadata

A structurally validated source-derived observation repair owns its canonical selected-pollutant Parquet and pollutant-manifest keys for the current run.

A legacy or canonical compatibility stage MAY create a proposal only when the canonical key is not already owned by a current-run source-derived repair.

A compatibility proposal MUST NOT unconditionally replace, rewrite or take precedence over an existing source-derived repair proposal.

When a compatibility stage encounters a canonical key already proposed by the source-derived repair, it MUST do one of the following:

1. independently derive the expected metadata from the final staged Parquet and confirm that its substantive body and dependency identities are identical to the existing source-derived proposal; or
2. fail closed with an explicit proposal-collision error.

It MUST NOT rebuild a replacement from stale Dropbox baseline metadata and then overwrite the current-run proposal.

For canonical-key resolution during planning and finalisation, precedence is:

1. a structurally validated current-run source-derived replacement;
2. a compatible current-run proposal whose substantive body is proven identical;
3. a current-run exact tombstone where applicable;
4. otherwise the chosen Dropbox baseline.

A disagreement between two producers for the same canonical key is a blocking planning defect, not a last-writer-wins condition.

## Final proposal graph validation before R2 mutation

After all builders, compatibility preparation and metadata finalisers have completed, Integrity MUST validate the complete final proposal graph before the first R2 DELETE or PUT.

For every selected repaired pollutant partition, the validator MUST independently recompute the canonical observation result from the final staged Parquet and require exact agreement between:

```text
immutable source evidence
=
final staged Parquet semantic result
=
final proposed pollutant manifest
```

The comparison MUST include at least:

- canonical row identity and duplicate multiplicity;
- total row count;
- per-timeseries row counts where required by the manifest and indexes;
- pollutant identity and canonical object keys;
- `observation_content_hash`;
- observation-content-hash contract metadata;
- `verification_status_counts`;
- Parquet part identities referenced by the manifest.

The final proposal validator MUST also require that:

- every parent manifest references the final validated child manifest identity;
- every scoped index is derived from final validated child metadata;
- a staged current-run key is not unexpectedly resolved from Dropbox;
- all exact tombstones remain limited to the selected pollutant prefixes;
- preserved unselected and out-of-scope children remain structurally accounted for.

Any mismatch MUST fail the run before any live R2 mutation. The report MUST identify the canonical key, competing proposal owners and differing fields.

Structural validation performed before a later finaliser modifies the proposal is not sufficient. The validation applies to the final immutable proposal that will be sent to the R2 apply stage.

## Live R2 verification against source truth

After writing a selected pollutant Parquet object, Integrity MUST GET/read the actual live R2 object and parse its semantic observation content through the shared canonical helper.

The live semantic result MUST first be compared directly with the immutable current-run source evidence. The mutable proposed manifest is not the authoritative expected result for this comparison.

Integrity MUST then require:

```text
immutable source evidence
=
verified live R2 Parquet semantic result
=
proposed and written pollutant manifest
```

The checks MUST establish exact agreement for the canonical content hash, row count, status counts and all other required manifest fields.

A correct live R2 Parquet paired with an incorrect proposed manifest MUST be reported as a manifest or proposal defect. It MUST NOT be reported as incorrect live observation data.

A pollutant repair is successful only after:

1. the written Parquet bytes have been GET-verified;
2. the live Parquet semantic result equals immutable source evidence;
3. the pollutant manifest equals that verified live semantic result;
4. the written pollutant manifest has itself been GET-verified.

Only then may publication continue to connector manifests, indexes, day parents and global metadata.

## Bounded reuse of GET-verified Parquet bodies

The body returned by the immediate post-PUT R2 GET SHOULD be reused for semantic verification within the same apply operation.

Reuse MUST use a bounded in-memory cache keyed by:

```text
canonical R2 object key + verified byte SHA-256
```

The cache contract is:

- it is an optimisation only and is never an authoritative source or persistent record;
- it is scoped to the current connector-day apply operation, or to a smaller bounded scope;
- it stores only bodies that have already passed live R2 byte-length and SHA-256 verification;
- the semantic verifier MUST confirm that the requested key and expected verified SHA exactly match the cache entry;
- any subsequent PUT or DELETE for the same key invalidates the entry immediately;
- a missing, mismatched or invalidated entry causes a fresh live R2 GET;
- entries are discarded when the connector-day scope completes or fails;
- the cache MUST have an explicit memory bound and MUST NOT grow with the full Integrity run;
- no persistent disk cache, Dropbox cache or cross-run reuse is permitted.

Reusing the verified body MUST NOT weaken the requirement that the bytes came from live R2 after the current PUT.

## Required publication order

For each affected connector-day, publication MUST follow dependency order. Lexical path sorting alone MUST NOT determine write order.

The required observation order is:

1. selected observation Parquet parts;
2. each selected pollutant manifest, only after its live Parquet semantic verification succeeds;
3. the observation connector manifest, only after all changed pollutant manifests succeed;
4. connector-scoped and pollutant-scoped observation indexes derived from the verified manifests;
5. any connector-scoped observation-derived AQI data, debug objects, manifests and indexes required by the repair contract.

After all connector-day work for the run has completed successfully:

6. affected observation and AQI day manifests are merged and published under the day-finalisation lock;
7. global and latest discovery metadata is published last under the global index-finalisation lock.

An index MUST NOT be published before the child pollutant or connector manifest that authorises and describes its content.

A parent manifest MUST NOT be published before every changed child it references has been written and GET-verified.

Global or latest metadata MUST NOT advertise a child, connector or day that has not completed its required publication and verification chain.

## Failure and partial-apply behaviour

R2 does not provide a multi-object transaction. The implementation MUST therefore minimise reader-visible inconsistency through validation before mutation and strict child-before-parent publication.

If a failure occurs after a Parquet PUT but before its pollutant manifest is published:

- no dependent connector manifest, index, day parent or global metadata may be published for that incomplete child;
- the run remains failed and immutable in the audit trail;
- recovery is a new Integrity run from the beginning with fresh source evidence and a new overlay;
- the failed run is not resumed and its local cache is not reused.

The proposal-collision and final-graph checks are specifically required to detect deterministic proposal defects before prefix deletion or upload begins.

## Audit evidence

A real Integrity repair report MUST distinguish:

- final proposal-graph validation status;
- canonical proposal ownership for every changed manifest key;
- compatibility collisions and whether identical proposals were accepted;
- source evidence hash and status counts;
- staged Parquet semantic hash and status counts;
- live R2 byte verification;
- live R2 semantic verification against immutable source evidence;
- proposed and written manifest equality with the verified live result;
- whether the semantic check reused a verified in-memory GET body or performed a fresh GET;
- cache key, verified SHA and cache invalidation reason without recording the full body;
- the completed publication level reached before any failure.

The audit MUST keep byte verification, semantic verification and manifest verification as separate outcomes.

## Required focused structural checks

Before deployment, run only the smallest directly relevant deterministic checks needed to prove structural viability. They MUST prove:

- compatibility metadata cannot overwrite a non-identical source-derived manifest;
- identical duplicate proposals for one canonical key may be accepted deterministically;
- a non-identical proposal collision fails before the first R2 mutation;
- final staged Parquet, immutable source evidence and final manifest must all agree;
- live semantic verification compares against immutable source evidence rather than trusting the proposed manifest;
- an incorrect manifest is classified separately from correct live Parquet content;
- publication ranking places Parquet before pollutant manifest, pollutant manifest before connector manifest, connector manifest before indexes, day parents after connector work and global metadata last;
- an index cannot be written when its required child manifest has not succeeded;
- a verified GET body is reused only for an exact key and verified SHA;
- cache invalidation occurs after any later mutation of the same key;
- cache size and lifetime remain bounded to the configured apply scope.

Do not add a broad speculative pre-deployment test suite.

## Functional acceptance in TEST

After deployment, validate through real TEST operation:

1. run a scoped repair containing at least one genuine source-to-R2 observation mismatch;
2. confirm the final proposal graph passes before the first R2 mutation;
3. confirm live R2 Parquet semantic content equals immutable source evidence;
4. confirm the written pollutant manifest equals the verified live result;
5. confirm publication follows the required child-to-parent order;
6. confirm the bounded cache reuses the already verified GET body without a second GET where eligible;
7. confirm the next successful Dropbox backup and later check-only run report the repaired scope as valid.

Functional acceptance occurs through the real CIC-Test operation. Pre-deployment checks remain structural and narrowly targeted.