# R2 v2 observations aggregate manifest hierarchy

## Authority and scope

This document defines the authoritative additive manifest hierarchy for canonical R2 v2 observations.

It applies only to:

```text
history/v2/observations
```

It does not introduce aggregate manifests for:

- `aqilevels`;
- `aqilevels_debug`;
- `core`.

AQI-history retirement and core-history pruning are separate decisions. This contract does not remove or reduce any current backup coverage before those decisions are implemented explicitly.

This is an additive R2 v2 change. It does not create an R2 v3 layout and does not move or rename existing observation data, pollutant manifests, connector manifests or day manifests.

Where older R2-history documentation assumes that day manifests are the highest observation aggregate, this narrower contract is authoritative for the new month, year and observations-root levels.

## Existing manifest locations remain unchanged

Existing observation objects remain beside the data they describe:

```text
history/v2/observations/day_utc=YYYY-MM-DD/manifest.json
history/v2/observations/day_utc=YYYY-MM-DD/connector_id=<id>/manifest.json
history/v2/observations/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant=<code>/manifest.json
```

The day manifest remains the authoritative aggregate for one UTC observation day. Connector and pollutant manifests remain in their existing directories.

## New aggregate paths

The additional hierarchy is:

```text
history/v2/observations/_manifests/manifest.json
history/v2/observations/_manifests/year=YYYY/manifest.json
history/v2/observations/_manifests/year=YYYY/month=MM/manifest.json
```

The hierarchy is:

```text
observations root manifest
    -> year manifests
        -> month manifests
            -> existing day manifests
```

Parents describe their immediate children only.

A month manifest must not duplicate connector, pollutant, observation-count or timeseries detail. A year manifest must not duplicate day detail. The observations-root manifest must not duplicate month or day detail.

## Minimal manifest payloads

All new aggregate manifests use:

```text
schema_version=1
content_hash_algorithm=sha256
```

### Month manifest

A month manifest represents every committed observation day manifest in one calendar month.

Its stable payload contains:

```text
kind
schema_version
domain
year
month
children[]
content_hash
content_hash_algorithm
```

Each child contains only:

```text
day_utc
manifest_key
manifest_hash
```

`manifest_hash` is the authoritative hash recorded by the existing day manifest contract.

### Year manifest

A year manifest represents every month manifest in one calendar year.

Each child contains only:

```text
month
manifest_key
content_hash
```

### Observations-root manifest

The observations-root manifest represents every year manifest.

Each child contains only:

```text
year
manifest_key
content_hash
```

## No repeated summaries

The aggregate hierarchy must not repeat values that are easy to derive from lower levels, including:

- observation count;
- connector count;
- pollutant count;
- first observation time;
- last observation time.

Avoiding repeated summaries reduces inconsistency risk and prevents parent identities changing for fields that are not required for traversal or change detection.

## Canonical content hash

`content_hash` is the deterministic logical identity of an aggregate manifest's child set.

The hash input must be built from stable child fields only. Child entries must be sorted by their canonical identifier:

- month children by `day_utc`;
- year children by two-digit `month`;
- root children by four-digit `year`.

The canonical encoding and prefix must be owned by one shared implementation. Whitespace, JSON formatting, object-key insertion order, run IDs, workflow IDs and wall-clock timestamps must not affect the result.

No wall-clock field may be included in `content_hash`. A wall-clock `generated_at` field should be omitted. If one is retained for an operational reason, it must be excluded from the hash and must not cause an unchanged manifest object to be rewritten.

Unchanged child content must produce a byte-stable unchanged aggregate manifest.

## Writer update contract

Every canonical observations writer must use the shared aggregate-manifest finaliser.

During a run, the writer collects the exact affected days. At the end of successful lower-level writing it derives the distinct affected months and years.

For one run it must:

1. complete and verify all affected Parquet, pollutant-manifest, connector-manifest and day-manifest writes;
2. rebuild each affected month manifest once from the current committed day manifests in R2;
3. rebuild each affected year manifest once from the current committed month manifests in R2;
4. rebuild the observations-root manifest once from the current committed year manifests in R2;
5. write only changed aggregate objects;
6. read back and verify every changed aggregate object.

If several days in one month change, the month manifest is rebuilt once after those day writes complete. If several months in one year change, the year manifest is rebuilt once after those month manifests complete.

The writer must derive parent content from current child manifests in R2. It must not construct a parent solely from the children changed by the current run.

## Commit order

The required publication order is bottom-up:

```text
Parquet
pollutant manifest
connector manifest
day manifest
month manifest
year manifest
observations-root manifest
```

The observations-root manifest is written last and is the highest-level completed view of the hierarchy.

A failed run may leave a newer child beneath an older parent. That is an incomplete derived hierarchy, not permission to discard the changed child. The explicit hierarchy audit must detect that mismatch.

## Deletion and missing-child behaviour

Aggregate manifests describe the current authoritative committed child set.

When a committed day is deliberately removed, its month entry must be removed. Empty months must not remain as active children unless a separate tombstone contract is introduced.

Unexpected missing, extra, malformed or hash-mismatched children are hierarchy validation failures. Writers and validation tools must fail closed rather than silently invent missing child identity.

## Hierarchy validation ownership

The initial active implementation uses an explicit lightweight hierarchy audit across all available observation history.

It compares:

```text
actual committed day manifests <-> month manifest entries
actual month manifests <-> year manifest entries
actual year manifests <-> observations-root entries
```

This audit reads manifest objects and metadata only. It does not read observation Parquet bodies.

It must detect at least:

- missing aggregate manifest;
- invalid JSON or schema version;
- missing child entry;
- unexpected child entry;
- wrong child path;
- wrong child hash;
- wrong aggregate `content_hash`;
- duplicate child identity;
- non-canonical ordering or non-byte-stable output where observable.

Integration of this audit into a future split Integrity Factory is intentionally deferred. The non-authoritative design draft is stored at:

```text
system_docs/drafts/r2_history/integrity_factory_contract.md
```

The draft does not govern current Integrity implementation.

## Full rebuild and audit

The hierarchy must be independently rebuildable from the existing committed day manifests.

An explicit full rebuild or audit mode must:

1. enumerate every committed observation day manifest;
2. construct every month manifest;
3. construct every year manifest;
4. construct the observations-root manifest;
5. compare before writing;
6. write only when explicitly running in a write-enabled mode.

The normal inventory and backup path may use the hierarchy for fast traversal, but an explicit full-scan mode must remain available to detect or repair an incomplete parent chain.

## Initial backfill

The first deployment must backfill the hierarchy from existing day manifests while the current backup discovery remains available as the safety baseline.

The backup inventory must not rely exclusively on the hierarchy until:

- all represented months and years have valid manifests;
- the root is valid;
- the explicit hierarchy audit has completed successfully on TEST;
- the explicit full-scan comparison agrees with the hierarchy.

## Versioning decision

The observation storage version remains `v2` because this change:

- does not change canonical observation rows;
- does not change the Parquet schema;
- does not move existing data paths;
- does not change physical timeseries identity;
- remains readable by existing v2 consumers that ignore the new `_manifests` prefix.

The aggregate manifest schema is versioned independently through `schema_version`.

## Structural validation policy

Before implementation is deployed, validate only that:

- the proposed paths do not collide with existing day partitions;
- canonical ordering and SHA-256 encoding are deterministic;
- repeated construction from unchanged children is byte-stable;
- bottom-up reconstruction preserves every existing child entry;
- malformed or missing child identity fails closed.

Functional acceptance occurs through real TEST writer, hierarchy audit, inventory and Dropbox backup operation after deployment.
