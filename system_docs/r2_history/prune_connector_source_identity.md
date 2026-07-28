# Prune Daily connector-day source identity

## Authority and scope

This document defines the authoritative source-identity contract for Prune Daily observation deletion.

It is an authoritative amendment to:

- [`prune_connector_day_gate.md`](prune_connector_day_gate.md);
- [`implementation_safety_contract.md`](implementation_safety_contract.md);
- [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md);
- [`history_writer_coordination.md`](history_writer_coordination.md).

Where older wording, code, schema, tests, plans or reports conflict with this document, this document is authoritative for:

- connector-day source-content identity;
- candidate completion preservation;
- connector-gate source evidence;
- pre-repair and post-repair deletion revalidation;
- handling of existing rows with no source identity;
- transaction and concurrency requirements for final deletion.

This contract applies only to Prune Daily observation deletion authority. Integrity, migration and generic shared-writer code do not own or update this evidence.

## Safety problem

Row count and minimum/maximum timestamps are not sufficient source identity.

The following source change can preserve all three aggregate values:

```text
same connector-day row count
same minimum observed_at
same maximum observed_at
changed observation value or verification_status
```

A previously completed candidate or gate MUST NOT remain eligible for deletion merely because those aggregate values are unchanged.

The system must prove that the current canonical IngestDB connector-day content is the same content that was frozen, written and verified in R2.

## Canonical connector-day source identity

The source identity covers every canonical observation row for one exact:

```text
day_utc + connector_id
```

The version-1 identity columns, in canonical order, are:

```text
connector_id
station_id
timeseries_id
pollutant_code
observed_at_utc
value
verification_status
```

The implementation MUST reuse the canonical observation normalisation and row encoding owned by:

```text
workers/shared/uk_aq_observation_content_hash.mjs
```

It MUST NOT introduce a separate SQL text-concatenation format, locale-sensitive numeric formatting, database-dependent JSON representation or another competing canonical row encoder.

The connector-day identity uses:

```text
algorithm: SHA-256
contract version: 1
prefix: uk-aq-prune-connector-source-content-hash:v1\n
row order: encoded canonical rows sorted byte-stably
row separator: \n
```

The connector-day source hash is a distinct operational identity from each pollutant partition's `observation_content_hash`. It reuses the same canonical row encoder but has its own prefix and contract version so the two scopes cannot be confused.

The identity result contains:

```text
source_content_hash
source_content_hash_contract_version
source_content_hash_row_count
```

For version 1:

- `source_content_hash` is a lower-case 64-character SHA-256 hexadecimal value;
- `source_content_hash_contract_version` is `1`;
- `source_content_hash_row_count` equals the exact number of canonical connector-day rows included in the hash.

A connector-day with no current IngestDB observations requires no deletion gate and no source identity. A candidate or gate that is being used to delete observations MUST have a non-empty identity with a positive row count.

## Operational schema

The following private operational relations MUST persist the connector-day source identity:

```text
uk_aq_ops.history_candidates
uk_aq_ops.prune_connector_day_gates
```

Each relation adds nullable fields equivalent to:

```text
source_content_hash text
source_content_hash_contract_version integer
source_content_hash_row_count bigint
```

The schema MUST enforce basic fail-closed validity:

- all three fields are null together or populated together;
- populated hash is lower-case 64-character hexadecimal SHA-256;
- populated contract version is positive;
- populated row count is positive;
- the relation remains private to operational roles;
- no public view or RPC exposes the new evidence unless a separate contract explicitly requires it.

The schema migration is additive. Existing rows are not assigned invented source identities.

## Existing candidates and gates

Existing candidate or gate rows whose source-identity fields are null are legacy evidence.

They:

- MAY remain stored for audit purposes;
- MUST NOT authorise observation deletion;
- MUST NOT be bulk-backfilled from current R2 objects or aggregate counts;
- MUST be reprocessed by normal Prune Daily when corresponding IngestDB observations still exist;
- remain irrelevant when no corresponding IngestDB observations exist.

No historical adoption, Integrity or migration process may populate the new source-identity fields in prune-gate evidence.

## Candidate discovery and completion preservation

Count and timestamp aggregates may remain as an inexpensive initial change detector, but they are not sufficient to preserve `complete` status.

For every completed candidate whose IngestDB connector-day rows still exist, Prune Daily MUST obtain the current canonical connector-day source identity before preserving completion.

A completed candidate may remain complete only when all of the following match:

```text
current source_content_hash
candidate source_content_hash
current source_content_hash_contract_version
candidate source_content_hash_contract_version
current source_content_hash_row_count
candidate source_content_hash_row_count
```

If any field is missing, malformed, unsupported or different, Prune Daily MUST:

1. mark the affected candidate pending or otherwise requiring canonical reprocessing;
2. invalidate only the matching `day_utc + connector_id` prune gate;
3. leave other connector-days unchanged;
4. retain the IngestDB observations.

A value-only change or `verification_status`-only change MUST therefore invalidate old completion evidence even when count and timestamp bounds are unchanged.

## Frozen source and connector-gate completion

For a current Phase B attempt, the source identity MUST be calculated from the exact frozen canonical source rows used for the R2 observation write.

The same identity is persisted on:

- the completed `history_candidates` row;
- the completed `prune_connector_day_gates` row.

The candidate and gate source identities MUST be identical.

The completed gate therefore binds both sides of deletion evidence:

```text
source_content_hash
    exact frozen IngestDB canonical content

history_manifest_hash
    exact verified R2 connector manifest
```

Gate completion remains subject to all existing requirements for manifest identity, child objects, physical Parquet identity, observation hashes, status counts, connector indexes, read-back verification and `completion_source=prune_daily_phase_b`.

AQI remains outside this observation deletion authority.

## Final deletion revalidation

Both the pre-repair and post-repair deletion paths MUST freshly revalidate the current connector-day source identity immediately before deleting observations.

Deletion requires equality across all three evidence locations:

```text
current canonical IngestDB source identity
=
history_candidates source identity
=
prune_connector_day_gates source identity
```

The gate's existing manifest and count evidence MUST also remain valid.

A mismatch, missing identity, unsupported contract version, canonicalisation error or hash-calculation failure MUST fail closed and retain the observations.

## Transaction and concurrency contract

Current source revalidation and the corresponding IngestDB deletion MUST occur in one PostgreSQL transaction using `REPEATABLE READ` isolation or a stronger equivalent.

Within that transaction, Prune Daily MUST:

1. read and validate the exact candidate evidence;
2. read and validate the exact connector-day gate evidence;
3. read the current canonical IngestDB rows for the exact connector-day deletion scope;
4. calculate the current versioned source identity using the shared canonical encoder;
5. compare current, candidate and gate identities;
6. delete only the rows represented by the validated transaction snapshot;
7. commit.

No R2, Dropbox, HTTP or other external network work belongs inside this deletion transaction.

If a relevant row is concurrently changed after the transaction snapshot, the transaction MUST fail or retain that changed row rather than deleting content that was not represented by the verified source identity.

Rows inserted after the transaction snapshot are not covered by the identity and MUST remain for a later Prune Daily run.

The implementation MUST NOT split final source revalidation and deletion across unrelated database sessions or transactions.

If the current deletion architecture cannot satisfy this atomicity contract without a database RPC or another material design change, implementation must stop and report that exact decision rather than weakening the contract.

## Schema and repository ownership

The additive operational schema migration is owned by the TEST schema repository:

```text
TEST-uk-aq/uk-aq-schema
```

The Prune Daily calculation, persistence, revalidation and deletion behaviour are owned by:

```text
TEST-uk-aq/uk-aq-ops
```

The schema migration must be structurally ready before the ops code is deployed. Functional acceptance occurs after both changes are deployed to TEST.

LIVE migration remains a later separate deployment step through the corresponding LIVE schema and ops repositories.

## Required diagnostics

Prune Daily reports should record bounded evidence equivalent to:

```text
source_identity_contract_version
source_identity_match
source_identity_failure_reason
source_identity_rows
candidate_source_identity_present
gate_source_identity_present
source_identity_invalidated_connector_days
```

Logs and reports MUST NOT emit raw observation rows. Emitting the lower-case SHA-256 identity is permitted operational evidence.

Failure reasons should distinguish at least:

```text
source_identity_missing
source_identity_contract_unsupported
source_identity_mismatch
source_identity_row_count_mismatch
source_identity_canonicalisation_failed
source_identity_transaction_conflict
```

## Focused structural validation

Before deployment, only narrow deterministic checks are required. They MUST prove:

- the connector-day hash changes when only `value` changes;
- the connector-day hash changes when only `verification_status` changes;
- row input order does not change the hash;
- canonical `-0` and `0` follow the existing canonical row rule;
- candidate completion is not preserved without complete matching source identity;
- an old null-identity gate is ineligible;
- a source mismatch invalidates only the affected connector-day;
- candidate and gate completion persist the same identity;
- both deletion paths require current, candidate and gate identity equality;
- revalidation and deletion use one transaction and one database session;
- unfinished or mismatched work cannot complete or reuse deletion authority.

Run only the smallest syntax, import, SQL-structure and directly relevant deterministic checks required to establish structural viability. Do not add a broad speculative pre-deployment test suite.

## Functional acceptance in TEST

After the schema and ops changes are deployed to TEST:

1. create or identify an eligible connector-day and complete its verified Prune Daily R2 observation write;
2. confirm candidate and gate rows store identical versioned source identity;
3. change only one TEST observation value without changing count or timestamp bounds;
4. run Prune Daily and confirm the old gate is invalidated and no affected observation is deleted;
5. repeat with a `verification_status`-only change where available;
6. allow normal reprocessing and confirm a new identity and verified R2 history are stored;
7. confirm deletion occurs only after final same-transaction identity revalidation;
8. confirm another connector on the same day remains unaffected;
9. confirm existing null-identity evidence fails closed and is reprocessed rather than backfilled.
