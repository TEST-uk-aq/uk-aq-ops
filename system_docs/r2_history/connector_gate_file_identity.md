# Connector-day gate file-identity validation

## Authority and purpose

This document defines the authoritative physical-file identity and opaque-child validation rules used by Prune Daily before a connector-day observation deletion gate may be set complete.

It supplements and clarifies:

- [`prune_connector_day_gate.md`](prune_connector_day_gate.md);
- [`history_writer_coordination.md`](history_writer_coordination.md);
- [`integrity.md`](integrity.md);
- [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md).

Where those documents require read-back validation without defining the physical identity representation, this document is authoritative.

The purpose is deletion safety. A completed connector-day gate permits removal of the corresponding observations from IngestDB, so object existence and byte length alone are not sufficient proof that the permanent R2 object is the object referenced by its manifest.

Integrity and migration use the same physical-identity validator when verifying live R2 repairs, but they do not complete, invalidate or recover Prune Daily deletion gates.

## `files[].etag_or_hash` representations

Every referenced Parquet file must have one unambiguous supported identity in `files[].etag_or_hash`.

Two representations are supported.

### SHA-256 representation

An unquoted string matching exactly:

```text
^[0-9a-f]{64}$
```

is the SHA-256 digest of the complete Parquet object bytes.

Validation MUST:

1. GET the complete live R2 object;
2. verify that its byte count equals the manifest `files[].bytes` value;
3. calculate SHA-256 over the returned bytes;
4. compare the calculated lower-case digest exactly with `files[].etag_or_hash`.

The R2 HTTP ETag MUST NOT be compared with a SHA-256 representation.

### R2 ETag representation

A non-empty quoted string is the supported R2 HTTP ETag representation.

Validation MUST:

1. HEAD the live R2 object unless its body is already required for another active validation;
2. verify that its byte count equals the manifest `files[].bytes` value;
3. require the live R2 response to contain a quoted strong ETag;
4. compare the manifest and live ETag after trimming whitespace, removing the surrounding quotes and normalising the inner token to lower case.

A quoted ETag is treated as an R2 object identity token. It MUST NOT be interpreted as SHA-256 or assumed to be MD5.

### Unsupported or ambiguous identity

Validation MUST fail closed when `files[].etag_or_hash` is:

- missing or blank;
- an unquoted value that is not a lower-case 64-character SHA-256 digest;
- a malformed quoted ETag;
- inconsistent with the live object;
- associated with a byte-count mismatch.

The implementation MUST classify the representation before comparison and MUST compare like with like.

## Shared implementation

Prune Daily, Integrity and migration MUST use one shared physical-file identity validator.

The shared validator owns:

- representation classification;
- byte-count validation;
- SHA-256 byte validation;
- quoted ETag normalisation and comparison;
- fail-closed errors for unsupported or mismatched identities.

The writers MUST NOT maintain separate equivalent rules.

Using the same validator does not confer gate ownership. Only Prune Daily may set or clear `uk_aq_ops.prune_connector_day_gates`.

## Active and opaque observation children

Integrity detection, source comparison and data repair remain limited to:

```text
pm25
pm10
no2
o3
```

AQI remains limited to `pm25`, `pm10` and `no2`.

Existing observation children outside the four-pollutant Integrity scope remain opaque preserved baseline content. Integrity MUST NOT reinterpret, recalculate, modernise, delete or rewrite their logical observation data merely because it is rebuilding selected active pollutants.

A real Integrity repair that rebuilds a connector manifest MUST structurally preserve every unchanged child referenced by the final connector manifest, including opaque preserved children. This structural validation does not broaden the active Integrity repair scope and does not create prune-gate authority.

### Active Integrity pollutants

For `pm25`, `pm10`, `no2` and `o3`, real repair verification requires the full active contract, including:

- canonical child-manifest identity and self `manifest_hash`;
- exact parent-linked child `manifest_hash`;
- canonical file keys and aggregate counts;
- valid `observation_content_hash` metadata;
- valid `verification_status_counts`;
- physical Parquet identity and byte-count validation under this document;
- required connector-targeted index identity and coverage.

Any failure remains fail-closed for the Integrity repair.

### Opaque preserved children

For an existing out-of-scope child, preservation requires structural proof only:

- the canonical child manifest exists and parses;
- its identity fields match its canonical path, day, connector and pollutant;
- its self `manifest_hash` verifies;
- the connector manifest references the exact same child `manifest_hash`;
- its file list, file keys, row counts, file counts, byte counts and aggregate arithmetic are structurally valid;
- every referenced Parquet object exists when live validation is required;
- every referenced Parquet object passes byte-count and physical identity validation when live validation is required;
- the required connector-targeted index exists and remains tied to the same child manifest identity and recorded coverage.

For opaque preserved children, Integrity MUST NOT:

- require current four-pollutant `observation_content_hash` or `verification_status_counts` fields when they are legitimately absent from preserved legacy metadata;
- parse or canonicalise Parquet observation rows;
- recalculate logical observation-content hashes;
- rewrite the child manifest or Parquet solely to modernise metadata;
- add the pollutant to source detection, repair planning or deletion scope.

A quoted ETag permits opaque Parquet physical identity verification through HEAD without downloading the body. An opaque child whose file identity is an unquoted SHA-256 still requires GET and byte hashing because SHA-256 cannot be proven from HEAD metadata alone.

A missing child manifest, missing Parquet, malformed identity, parent/child hash conflict, byte-count mismatch, physical identity mismatch or missing/contradictory required index remains fail-closed for the applicable writer or verifier.

## Prune Daily gate completion

Normal Prune Daily Phase B is the only writer that may complete a connector-day deletion gate.

Before Prune Daily sets the gate true, every child referenced by the final observation connector manifest must be structurally and physically tied to the live R2 objects under this document.

Prune Daily applies the full current logical and physical contract to all observation children it writes. Where it deliberately preserves an existing child, that child still requires the structural and physical proof required by the active Prune Daily contract.

The final verified connector manifest identity and aggregate counts are stored with the gate evidence as defined in [`prune_connector_day_gate.md`](prune_connector_day_gate.md).

## Integrity and migration verification

Integrity and migration use this validator to prove that live R2 writes match their manifests during connector-scoped apply and final verification.

They MUST:

- use the shared connector-day lock for live mutation;
- validate selected active pollutants under the full logical contract;
- preserve and structurally validate unselected children;
- verify exact affected objects after live mutation;
- leave audit evidence in Integrity reports and SQLite.

They MUST NOT:

- complete or invalidate a prune connector-day gate;
- describe repair verification as prune-gate completion;
- run a historical gate-recovery operation;
- backfill gate rows from valid R2 history;
- update connector-targeted indexes solely to manufacture prune eligibility.

The former bounded Integrity gate-recovery path is retired from the supported contract. `scripts/backup_r2/uk_aq_complete_integrity_connector_gates.mjs` is not a supported steady-state operation and should be removed when implementation is brought into line.

## Failure rule

Prune Daily's connector-day gate MUST remain incomplete whenever a live object cannot be proven to match the identity and byte count recorded by the final canonical manifest chain.

A same-size but different Parquet object is a physical identity mismatch and MUST fail closed.

A failure for one connector-day MUST NOT alter another connector-day gate.

For Integrity or migration, the same physical mismatch fails the affected repair or migration scope but does not write any prune-gate state.

## Validation policy

This is deletion-safety and live-repair functionality, so a narrow deterministic pre-deployment check is genuinely required.

The focused checks must prove at least:

- an unquoted SHA-256 identity is validated from downloaded bytes and not from the R2 ETag;
- a quoted ETag identity is validated against the live quoted ETag and byte count;
- a same-size object with a different SHA-256 fails;
- a same-size opaque object with a different quoted ETag fails;
- an active pollutant with invalid content-hash metadata fails;
- a valid opaque legacy child is preserved without applying the active logical hash contract;
- a missing or contradictory opaque child fails the applicable writer or verifier;
- only Prune Daily can complete the exact successfully verified connector-day gate;
- Integrity physical verification never changes prune-gate state.

Do not add a broad speculative suite. Functional acceptance occurs through real TEST Prune Daily and scoped Integrity operations after code review and a current R2 backup.
