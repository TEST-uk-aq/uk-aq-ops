# Connector-day gate file-identity validation

## Authority and purpose

This document defines the authoritative physical-file identity and opaque-child validation rules used before a connector-day deletion gate may be set complete.

It supplements and clarifies:

- [`prune_connector_day_gate.md`](prune_connector_day_gate.md);
- [`integrity.md`](integrity.md);
- [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md).

Where those documents require read-back validation without defining the physical identity representation, this document is authoritative.

The purpose is deletion safety. A completed connector-day gate permits removal of the corresponding observations from IngestDB, so object existence and byte length alone are not sufficient proof that the permanent R2 object is the object referenced by its manifest.

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

The gate MUST fail closed when `files[].etag_or_hash` is:

- missing or blank;
- an unquoted value that is not a lower-case 64-character SHA-256 digest;
- a malformed quoted ETag;
- inconsistent with the live object;
- associated with a byte-count mismatch.

The implementation MUST classify the representation before comparison and MUST compare like with like.

## Shared implementation

Prune Daily Phase B and Integrity connector-day gate completion MUST use one shared physical-file identity validator.

The shared validator owns:

- representation classification;
- byte-count validation;
- SHA-256 byte validation;
- quoted ETag normalisation and comparison;
- fail-closed errors for unsupported or mismatched identities.

The two gate paths MUST NOT maintain separate equivalent rules.

## Active and opaque observation children

Integrity detection, source comparison and data repair remain limited to:

```text
pm25
pm10
no2
o3
```

AQI remains limited to `pm25`, `pm10` and `no2`.

Existing observation children outside the four-pollutant Integrity scope remain opaque preserved baseline content. Integrity MUST NOT reinterpret, recalculate, modernise, delete or rewrite their logical observation data merely to establish a connector-day gate.

However, a real Integrity repair that establishes a connector-day deletion gate MUST structurally prove every child referenced by the final connector manifest, including opaque preserved children. This structural gate validation does not broaden the active Integrity repair scope.

### Active Integrity pollutants

For `pm25`, `pm10`, `no2` and `o3`, gate completion requires the full active contract, including:

- canonical child-manifest identity and self `manifest_hash`;
- exact parent-linked child `manifest_hash`;
- canonical file keys and aggregate counts;
- valid `observation_content_hash` metadata;
- valid `verification_status_counts`;
- physical Parquet identity and byte-count validation under this document;
- required connector-targeted index identity and coverage.

Any failure remains fail-closed.

### Opaque preserved children

For an existing out-of-scope child, gate completion requires structural preservation proof only:

- the canonical child manifest exists and parses;
- its identity fields match its canonical path, day, connector and pollutant;
- its self `manifest_hash` verifies;
- the connector manifest references the exact same child `manifest_hash`;
- its file list, file keys, row counts, file counts, byte counts and aggregate arithmetic are structurally valid;
- every referenced Parquet object exists;
- every referenced Parquet object passes byte-count and physical identity validation under this document;
- the required connector-targeted index exists and remains tied to the same child manifest identity and recorded coverage.

For opaque preserved children, Integrity gate completion MUST NOT:

- require current four-pollutant `observation_content_hash` or `verification_status_counts` fields when they are legitimately absent from preserved legacy metadata;
- parse or canonicalise Parquet observation rows;
- recalculate logical observation-content hashes;
- rewrite the child manifest or Parquet solely to modernise metadata;
- add the pollutant to source detection, repair planning or deletion scope.

A quoted ETag permits opaque Parquet physical identity verification through HEAD without downloading the body. An opaque child whose file identity is an unquoted SHA-256 still requires GET and byte hashing because SHA-256 cannot be proven from HEAD metadata alone.

A missing child manifest, missing Parquet, malformed identity, parent/child hash conflict, byte-count mismatch, physical identity mismatch or missing/contradictory required index remains fail-closed.

## Normal Prune Daily versus Integrity gate completion

Normal Prune Daily Phase B is the authoritative writer for its connector-day and continues to apply the full current writer and gate validation contract to all children it writes or safely adopts.

Integrity connector-day gate completion supplies the explicit four-pollutant active scope. It applies full logical validation to those active children and structural opaque-preservation validation to all other existing children.

This scoped validation MUST NOT weaken the final connector-level proof. Every child referenced by the connector manifest must still be structurally and physically tied to the live R2 objects before the gate becomes complete.

## Bounded recovery operation

A bounded Integrity gate-recovery operation may verify already-repaired live connector-days and update only the listed connector-day gate rows.

It MUST:

- accept an explicit list of `day_utc + connector_id` pairs;
- verify each pair independently against live canonical R2 history;
- mark only a successfully verified listed pair complete;
- leave a failed listed pair incomplete and report the exact fault;
- leave unlisted connector-day gates untouched;
- avoid rewriting observation Parquet, pollutant manifests or AQI data;
- avoid deleting R2 objects.

Required connector-targeted index verification remains part of the gate contract. A byte-identical targeted index update may be attempted through the existing changed-only index path where that path is required to establish or confirm canonical index coverage. Any actual changed index write must be reported explicitly and must not be described as a read-only recovery.

## Failure rule

A connector-day gate MUST remain incomplete whenever the live object cannot be proven to match the identity and byte count recorded by the final canonical manifest chain.

A same-size but different Parquet object is a physical identity mismatch and MUST fail closed.

A failure for one connector-day MUST NOT alter another connector-day gate.

## Validation policy

This is deletion-safety functionality, so a narrow deterministic pre-deployment check is genuinely required.

The focused checks must prove at least:

- an unquoted SHA-256 identity is validated from downloaded bytes and not from the R2 ETag;
- a quoted ETag identity is validated against the live quoted ETag and byte count;
- a same-size object with a different SHA-256 fails;
- a same-size opaque object with a different quoted ETag fails;
- an active pollutant with invalid content-hash metadata fails;
- a valid opaque legacy child is preserved without applying the active logical hash contract;
- a missing or contradictory opaque child remains incomplete;
- only the exact successfully verified connector-day gate is completed.

Do not add a broad speculative suite. Functional acceptance occurs through a bounded real TEST gate-recovery operation after code review and a current R2 backup.