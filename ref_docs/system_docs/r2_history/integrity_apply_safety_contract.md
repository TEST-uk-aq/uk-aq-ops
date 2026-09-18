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

### Source-evidence row storage and canonical loading

The established `obs_history_rows.json` row format remains:

```text
timeseries_id
station_id
pollutant_code
observed_at
value
verification_status
```

The file MUST NOT be changed merely to duplicate `connector_id` into every row or to rename `observed_at` to `observed_at_utc` for the apply verifier.

The immutable-source loader already knows the connector and day from the enclosing evidence partition and `source-evidence.json`. It MUST reconstruct each canonical observation row by:

1. taking `connector_id` from the validated enclosing `day_utc + connector_id` evidence scope;
2. preserving `station_id`, `timeseries_id`, `pollutant_code`, `value` and `verification_status` from the stored row;
3. mapping stored `observed_at` to canonical `observed_at_utc`;
4. normalising the timestamp to the exact UTC millisecond format required by the canonical observation-content-hash contract;
5. validating the reconstructed row through the shared canonical observation-row normaliser.

The loader MUST fail closed when:

- the enclosing connector or day identity disagrees with `source-evidence.json`;
- a stored row contains a conflicting embedded connector identity if a future schema adds one;
- `observed_at` is absent, invalid or outside the selected UTC day;
- any other canonical row field is invalid;
- the reconstructed rows do not match the counts and content hashes recorded in `source-evidence.json`.

Tests and fixtures for this path MUST use the real stored `obs_history_rows.json` schema. They MUST NOT use already-expanded canonical rows containing `connector_id` and `observed_at_utc` as a substitute for testing the loader adapter.

## Proposal ownership and compatibility metadata

A structurally validated source-derived observation repair owns its canonical selected-pollutant Parquet and pollutant-manifest keys for the current run.

A legacy or canonical compatibility stage MAY create a proposal only when the canonical key is not already owned by a current-run source-derived repair.

A compatibility proposal MUST NOT unconditionally replace, rewrite or take precedence over an existing source-derived repair proposal.

### Existing source-derived manifest

When a compatibility or metadata stage encounters a pollutant-manifest key already owned by a structurally validated source-derived repair, it MUST NOT build a second complete manifest and require complete JSON equality.

Instead, it MUST:

1. independently derive the content-defining manifest facts from the final staged Parquet;
2. verify that those facts agree with the existing source-derived manifest;
3. verify that the existing manifest's dependency identities agree with the final staged Parquet objects;
4. retain the existing source-derived manifest body and ownership unchanged when those checks pass;
5. fail closed before any R2 mutation when a content-defining field or dependency identity differs.

The semantic comparison MUST include at least:

- history version, domain, manifest kind, day, connector and pollutant identity;
- canonical Parquet object keys;
- per-part byte sizes, SHA-256 identities and row counts;
- total row count and source row count;
- required per-timeseries row counts;
- `observation_content_hash`;
- observation-content-hash algorithm, contract version, row count and columns;
- `verification_status_counts`;
- physical schema fields where they describe the staged Parquet contract;
- all dependency identities used by parent manifests or scoped indexes.

Differences only in run-scoped or operational metadata MUST NOT create a proposal collision when the content-defining facts and dependencies agree. Examples include:

- `run_id`;
- `backed_up_at_utc`;
- `writer_git_sha`;
- a derived `manifest_hash` that changes only because one of those operational fields differs;
- other explicitly documented non-content operational metadata.

These operational fields MUST remain whatever the authoritative source-derived manifest builder produced. The compatibility stage MUST NOT rewrite them.

A collision failure MUST report the exact differing content-defining fields and the competing proposal owners. A generic `substantive_body` or complete-body mismatch is insufficient for this path.

The compatibility stage MUST NOT rebuild a replacement from stale Dropbox baseline metadata and then overwrite the current-run proposal.

For canonical-key resolution during planning and finalisation, precedence is:

1. a structurally validated current-run source-derived replacement whose staged-Parquet semantics have been verified;
2. a compatibility proposal only when no current-run source-derived owner exists;
3. a current-run exact tombstone where applicable;
4. otherwise the chosen Dropbox baseline.

A disagreement between producers over a content-defining field for the same canonical key is a blocking planning defect, not a last-writer-wins condition.

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

- every source-derived repaired pollutant partition has exactly one matching exact pollutant-prefix tombstone where replacement requires prefix deletion;
- every exact pollutant-prefix tombstone has its matching staged Parquet and pollutant manifest;
- every parent manifest references the final validated child manifest identity;
- every scoped index is derived from final validated child metadata;
- a staged current-run key is not unexpectedly resolved from Dropbox;
- all exact tombstones remain limited to the selected pollutant prefixes;
- preserved unselected and out-of-scope children remain structurally accounted for.

Any mismatch MUST fail the run before any live R2 mutation. The report MUST identify the canonical key, competing proposal owners and exact differing fields.

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

The checks MUST establish exact agreement for the canonical content hash, row count, status counts and all other required content-defining manifest fields.

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
- compatibility encounters with existing source-derived owners;
- whether an existing source-derived manifest was retained after semantic validation;
- exact content-defining collision fields when validation fails;
- source-evidence row-adapter validation status;
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

- compatibility metadata cannot overwrite a source-derived manifest;
- an existing source-derived manifest is retained when its content-defining fields and dependencies match the final staged Parquet;
- differences only in `run_id`, timestamps, `writer_git_sha` or derived operational hash fields do not create a collision;
- a content-defining difference reports the exact differing field and fails before the first R2 mutation;
- the source-evidence loader accepts the real stored `obs_history_rows.json` schema;
- the loader injects the validated enclosing `connector_id` and maps `observed_at` to canonical `observed_at_utc`;
- a conflicting embedded connector identity or invalid timestamp fails closed;
- the reconstructed source rows match the recorded evidence counts and hashes;
- every repaired staged pollutant partition has its required exact tombstone and vice versa;
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
2. confirm an existing source-derived manifest is retained after compatibility semantic validation;
3. confirm the real stored source-evidence rows are reconstructed into canonical rows successfully;
4. confirm the final proposal graph passes before the first R2 mutation;
5. confirm live R2 Parquet semantic content equals immutable source evidence;
6. confirm the written pollutant manifest equals the verified live result;
7. confirm publication follows the required child-to-parent order;
8. confirm the bounded cache reuses the already verified GET body without a second GET where eligible;
9. confirm the next successful Dropbox backup and later check-only run report the repaired scope as valid.

Functional acceptance occurs through the real CIC-Test operation. Pre-deployment checks remain structural and narrowly targeted.
