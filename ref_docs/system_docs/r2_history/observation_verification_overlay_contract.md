# Observation verification overlay contract

## Status and authority

**Status: future implementation authority; not current runtime behaviour until deployed and accepted through real TEST operation.**

This contract defines the agreed future storage and serving model for observation verification status in canonical R2 history.

It amends, for this future transition:

- [`observation_history_schema_contract.md`](observation_history_schema_contract.md);
- [`aurn_validation_status_contract.md`](aurn_validation_status_contract.md);
- [`prune_daily_observation_only_phase_b_contract.md`](prune_daily_observation_only_phase_b_contract.md);
- [`official_network_rdata_historical_integrity_contract.md`](official_network_rdata_historical_integrity_contract.md);
- the selected v3 writer/reader contracts only where they currently require `verification_status` to be physically stored in observation Parquet or included in observation-content identity.

Until this future model is deployed and accepted, the current runtime continues to use the existing persisted `verification_status` column.

## Core decision

Observation measurement data and observation verification state are separate authorities.

The canonical measurement identity is:

```text
connector_id
station_id
timeseries_id
pollutant_code
observed_at_utc
value
```

Verification state is a parallel R2 authority and is not part of the future canonical Parquet row.

A change that only advances or otherwise changes verification state MUST NOT require rewriting otherwise unchanged observation Parquet, observation manifests or the exact observation-timeseries index.

Conceptually:

```text
measurement values/identity changed
        -> rewrite affected canonical observation partition and dependent observation authority

verification state only changed
        -> update verification overlay authority only
```

## Canonical effective field name

The semantic/API field name remains:

```text
verification_status
```

The future overlay does not rename that API/presentation semantic. It changes where the value is persisted and how it is derived.

For a valid classifiable observation the supported verification states remain:

```text
P
R
```

A connector/timeseries with no applicable verification authority resolves to null at the trusted presentation boundary. Absence of an overlay entry MUST NOT be interpreted as provisional unless the connector-specific verification contract explicitly defines provisional as the default for an existing mapped timeseries.

## Future observation Parquet schema

After verification-overlay cut-over, newly written canonical observation Parquet MUST NOT contain:

```text
verification_status
status
vstatus
```

The future canonical Parquet columns, in exact order, are:

```text
connector_id
station_id
timeseries_id
pollutant_code
observed_at_utc
value
```

This is a new physical schema identity. It MUST NOT silently reuse the current seven-column schema identity merely because the remaining six column names resemble an older layout.

The target physical schema identity is:

```text
history_schema_version = 4
writer_version = parquet-wasm-zstd-v4
```

The accepted v3 storage generation and `timeseries-aligned-v2` physical packing/index architecture remain otherwise unchanged. This schema change does not create an observation-history generation v4 and does not rename `history/v3/observations`.

## Existing seven-column Parquet

Existing canonical objects written with physical schema version 3 and a `verification_status` column remain readable legacy canonical history.

They do not require an immediate whole-archive rewrite merely to remove the embedded status field.

After a connector has crossed to authoritative verification-overlay serving:

- the embedded status in an old seven-column Parquet object is not the effective verification authority;
- readers MUST derive effective status from the verification overlay;
- later ordinary rewrites of that observation partition use the new six-column physical schema;
- old seven-column objects may age out or be replaced through normal maintenance without a dedicated status-removal rewrite.

A reader may continue to understand the legacy column for migration, recovery and pre-cut-over compatibility, but MUST NOT let it override the authoritative overlay after connector cut-over.

## Observation content hash

Future canonical observation content identity excludes verification status.

A new observation-content-hash contract version MUST be used for new six-column output:

```text
observation_content_hash_contract_version = 2
```

with exactly these logical hash fields:

```text
connector_id
station_id
timeseries_id
pollutant_code
observed_at_utc
value
```

The v2 hash MUST use a distinct canonical prefix from the existing status-inclusive v1 hash.

New observation manifests MUST NOT publish `verification_status_counts` as observation-content-hash metadata.

Existing status-inclusive v1 content hashes remain valid identities for already-written objects. Mixed historical reading MUST distinguish the hash contract version explicitly. A comparison that asks whether measurement content changed may decode a legacy object and compute the new measurement-only hash; it MUST NOT claim equality merely by comparing incompatible v1 and v2 hash strings.

## Verification R2 layout

The verification authority is parallel to observation data.

Connector verification manifests are immutable and content-addressed. The canonical key shape is:

```text
history/v3/verification/
  connector_id=<id>/
    manifests/
      <manifest_sha256>.json
```

The SHA-256 in the object key MUST equal the SHA-256 of the exact canonical manifest bytes.

The mutable compact discovery/authority object lives at:

```text
history/_index_v3/verification/latest.json
```

`latest.json` is the only normal current-authority selector. It identifies, for each activated connector, the exact immutable connector manifest by connector ID, key, byte size and SHA-256.

A connector manifest object that exists in R2 but is not referenced by the current validated `latest.json` is not current verification authority. This includes a newly uploaded manifest whose publication failed before latest was advanced.

A status-only change MUST NOT mutate:

```text
history/v3/observations/**
history/_index_v3/observations_timeseries/**
```

unless observation measurement content independently changed in the same operation.

### Publication ordering and crash safety

Verification publication is:

```text
build canonical connector manifest bytes
        -> calculate SHA-256
        -> PUT immutable SHA-addressed manifest
        -> verify exact stored byte size/SHA-256
        -> build latest referencing that immutable identity
        -> publish and verify latest last
```

The current latest object MUST remain valid throughout connector-manifest upload. Overwriting a mutable fixed connector-manifest key before latest publication is prohibited.

If a refresh stops after the immutable manifest is written but before latest changes, readers and backup continue using the previous manifest referenced by latest. The new unreferenced object is an orphan candidate, not partial authority.

A later garbage-collection operation MAY remove unreferenced immutable manifests only under explicit retention/recovery rules and MUST NOT infer unreferenced state from a failed or unreadable latest object.

## Connector manifest model

Each connector manifest MUST contain deterministic, sorted timeseries entries sufficient to derive effective status for one canonical observation timestamp.

Each timeseries entry MUST identify at least:

- `timeseries_id`;
- `station_id`;
- canonical `pollutant_code`;
- source verification model;
- semantic source provenance;
- default status, when the connector contract defines one;
- zero or more non-overlapping ordered verification periods.

Canonical verification periods use half-open UTC timestamp intervals:

```text
[from_observed_at_utc, to_observed_at_utc)
```

with status `P` or `R`.

An open start or open end MAY be represented explicitly where required. Periods MUST be deterministic, sorted, non-overlapping and collapsed so adjacent periods with the same status are not stored separately.

### Semantic manifest identity versus refresh audit evidence

The connector manifest is canonical **effective verification authority**, not a download log.

Its bytes and SHA-256 SHOULD change when, and only when, effective verification authority or stable semantic provenance changes. It MUST NOT churn merely because the same semantic authority was re-fetched at a later time or because a source file gained unrelated observations.

Connector-manifest provenance MAY contain stable source-native semantic fields required to explain the authority, for example:

```text
source system / connector
site and pollutant identity
ratified_to
source year or stable source URL family
verification model
```

Exact acquisition evidence belongs in the verification-refresh run/audit evidence rather than in the canonical connector manifest when that evidence would cause semantically identical manifests to change. Such run evidence includes, as applicable:

```text
exact fetched URL
retrieved_at_utc
byte size
source-file SHA-256
HTTP/source identity
decoder identity
mapping diagnostics
```

The refresh process MUST still pin exact source bytes strongly enough to prove how the canonical periods were derived. Separating that evidence from the canonical manifest does not weaken source auditability.

For AURN in particular, an annual CSV gaining later ordinary provisional observations MUST NOT invalidate all historical verification cache merely because the whole CSV file SHA-256 changed while the effective verification periods for an already represented timeseries remained unchanged.

## Source models

Two source models are currently agreed. Both publish the same canonical R2 verification-period representation.

### Ratification-boundary source

WAQN connector `9` and SAQN connector `10` derive status from Ricardo/WSP OpenAir metadata `ratified_to`.

For a valid mapped timeseries:

```text
UTC observation calendar date <= ratified_to -> R
UTC observation calendar date >  ratified_to -> P
```

The whole stated `ratified_to` day is ratified.

The canonical period boundary for a `ratified_to` date is therefore the next UTC midnight. The source-native `ratified_to` value is retained as provenance, while the serving representation is the canonical period form.

Explicit `Never` or an otherwise valid mapped pollutant with missing `ratified_to` has default status `P` and no invented ratified period. Missing or ambiguous metadata identity remains a source defect and fails closed.

### Per-observation source status

AURN / connector `1` UK-AIR CSV status remains authoritative source evidence on each source observation.

The publisher MUST collapse consecutive identical source P/R states into canonical periods rather than persist the same status on every observation row.

The representation MUST support arbitrary legitimate transitions, including:

```text
R -> P
P -> R
R -> P -> R
```

It MUST NOT assume that AURN can always be represented by one `ratified_to` date.

The October 2026 archive review found no isolated P observation inside an R block across the supplied archive, but that empirical result is not a permission to discard future source exceptions. Exact source semantics win.

For valid non-null AURN observations, absence of ratified evidence continues to mean `P`. Therefore the AURN timeseries entry may use default status `P`, with source-confirmed periods preserving explicit transitions.

## Source regressions and contradictions

Normal ratification progression is expected to move observations from `P` to `R`.

An existing effective `R` state MUST NOT be silently downgraded to `P` merely because a later metadata file regresses, loses a ratification boundary or otherwise contradicts previously accepted authority.

For WAQN/SAQN a backwards `ratified_to` movement is a contradiction and fails closed.

For AURN, an explicit later authoritative source may in principle correct a previously ratified state, but an `R -> P` change in already accepted overlay authority is not treated as routine ratification progression. It MUST be surfaced as a source correction requiring explicit repair/review authority rather than silently applied by an ordinary refresh.

## Verification refresh ownership

Verification refresh is a distinct mutation concern from observation-data repair.

It may be orchestrated by History Integrity, but its mutation stage and evidence are separate:

```text
Observation Integrity
    -> measurement values, missing/extra rows, identities, canonical Parquet

Verification refresh
    -> ratified_to / source P-R evidence
    -> canonical verification periods
    -> connector verification manifest
    -> verification latest index
```

If only verification changes, the operation MUST NOT rebuild observation Parquet.

If both measurement data and verification change, the observation repair and verification publication remain separately evidenced and each publishes only its own authority.

The normal refresh schedule/cadence is an operational decision to be implemented separately. The storage contract does not require verification work to be divided into individual observation days.

## Prune Daily boundary

Prune Daily must change when this future model is implemented.

Current code may populate `verification_status` for connector `1` and null for other connectors, but the physical writer still creates the status column. Under the overlay model that behaviour is retired.

Future Prune Daily canonical publication MUST:

- write the six-column physical schema with no verification-status column;
- compute the measurement-only content hash;
- stop synthesising null verification fields for connectors without verification authority;
- stop embedding SOS P/R into Parquet;
- keep its connector-day deletion gate based on canonical measurement-history evidence.

Prune Daily does not become the sole verification authority merely because its frozen source rows may contain status. The dedicated verification-refresh authority owns the durable overlay. A Prune operation MUST NOT rewrite measurement history solely to follow a later P/R change.

## Reader and API boundary

A trusted history reader that exposes verification status MUST combine:

```text
canonical observation measurement
+
current authoritative connector verification manifest
```

The public semantic may remain `verification_status` or an established presentation alias such as `source_validation_status`.

The browser MUST NOT calculate ratification itself.

For a connector declared authoritative in `history/_index_v3/verification/latest.json`, the reader MUST use the exact immutable manifest identity referenced by latest even when an old Parquet row still carries an embedded status.

For a connector not declared authoritative in verification latest, the reader follows the pre-cut-over compatibility rules for that connector until its overlay migration is accepted.

A missing referenced immutable manifest, byte-size mismatch, SHA-256 mismatch or semantically invalid manifest fails closed. A stale unreferenced manifest at another key MUST NOT be substituted.

### Mixed schema 3 / schema 4 reading

Connector cut-over does not require a whole-archive rewrite, so normal v3 reads MUST support schema-version-3 and schema-version-4 Parquet in the same logical request.

Physical schema/writer identity is therefore **scope/file authority**, not one global request-wide constant.

A request that crosses UTC day scopes may legitimately encounter, for example:

```text
older scope -> history_schema_version 3 / parquet-wasm-zstd-v3
newer scope -> history_schema_version 4 / parquet-wasm-zstd-v4
```

The exact reader MUST derive and validate the supported physical identity pinned by each authoritative scoped manifest/leaf/file. It MUST NOT force all selected scopes to match one hard-coded schema/writer pair.

Schema 3 and schema 4 may coexist only where their exact scope/file metadata proves their identities. An unsupported or contradictory identity fails closed.

If API diagnostics expose physical schema/writer identity, they MUST describe the actual selected identities. A singular top-level identity MAY be retained only when all selected physical scopes use the same identity; a mixed response MUST expose a deterministic list such as `physical_schemas` and MUST NOT falsely label the whole response as writer v3 or writer v4.

## Cache identity

Any API/cache response whose body includes effective verification status MUST vary on verification authority identity as well as observation-data identity.

For an activated connector, the response-cache identity MUST include the SHA-256 of the exact immutable connector manifest selected by validated `latest.json` (or another authenticated identity that commits to that exact manifest).

A status-only manifest update must therefore invalidate status-bearing response cache without pretending that observation Parquet changed.

### Verification-authority caching

The trusted API MUST NOT require an R2 GET of both verification latest and connector manifest before every response-cache lookup.

Two cache classes are permitted:

1. **mutable discovery cache** for `history/_index_v3/verification/latest.json`, with a deliberately short bounded freshness window;
2. **immutable connector-manifest cache** keyed by the content-addressed manifest key/SHA-256, which may use a much longer cache lifetime because the bytes at that key MUST never change.

The selected initial maximum freshness window for cached verification latest is:

```text
60 seconds
```

A reader MAY refresh sooner. It MUST NOT serve a cached latest beyond that bound as current discovery authority.

A newly published verification state may therefore take up to the bounded latest-cache freshness window to become visible to an individual Worker/cache location. This is accepted eventual visibility for the overlay and MUST NOT be extended by a stale response-cache key: once the new latest identity is observed, the new connector-manifest SHA produces a different response-cache identity.

A content-addressed connector-manifest cache hit MUST still be keyed by, and validate against, the identity selected by latest. Cache optimisation MUST NOT permit one manifest's bytes to satisfy another SHA-addressed key.

## Observation indexes

The exact observation-timeseries index remains an index of measurement location/physical identity.

Verification periods do not belong in the exact observation-timeseries leaves.

A verification-only change does not require rebuilding observation exact leaves, scoped roots, day authority or observation latest index.

The parallel verification latest object is the discovery/index boundary for verification authority.

## Migration and cut-over

Implementation MUST avoid a forced whole-archive Parquet rewrite.

The safe transition is connector-scoped:

1. make readers understand verification overlay, legacy embedded status and mixed schema-3/schema-4 scopes;
2. build a complete authoritative connector manifest from pinned source evidence;
3. publish and verify the new immutable SHA-addressed connector manifest;
4. update and verify `latest.json` last so that it references the exact immutable manifest;
5. perform real TEST trusted-read/cache and backup acceptance while observation writers still remain schema 3;
6. only after that authority is accepted may new canonical observation writes for that connector omit embedded status and use schema 4/hash v2;
7. readers then ignore embedded status for that authoritative connector;
8. old seven-column Parquet remains readable measurement history until normally replaced.

Before a connector is added to verification latest, its existing current-runtime status rules remain in force.

Cut-over MUST NOT assume a request will touch only one physical schema. Reader support for mixed schema 3/4 is a prerequisite to the first schema-4 writer activation.

## Failure behaviour

Verification publication fails closed when:

- source acquisition identity cannot be pinned in refresh audit evidence;
- timeseries mapping is missing or ambiguous for a selected source group;
- source periods overlap or cannot be ordered deterministically;
- a `ratified_to` boundary cannot be mapped deterministically;
- a routine refresh would regress accepted R evidence to P;
- the canonical connector manifest bytes do not hash to the SHA encoded in their immutable key;
- connector manifest identity cannot be verified durable before latest publication;
- latest would reference a missing or mismatched immutable connector manifest.

A failure after an immutable connector manifest has been uploaded but before latest publication MUST leave the previous latest authority valid. The unreferenced manifest is non-authoritative and may be retained for diagnosis/rollback history until normal retention permits garbage collection.

Reader failure to resolve a current latest/manifest identity MUST NOT fall back to a different unreferenced manifest or embedded status for a connector already declared overlay-authoritative.

Failure to refresh verification MUST NOT authorise rewriting otherwise unchanged observation Parquet as a workaround.

## TEST acceptance

Functional acceptance occurs after deployment through real TEST operation.

At minimum TEST acceptance must demonstrate:

- one AURN timeseries whose source P/R sequence is represented by periods;
- one WAQN and one SAQN timeseries whose `ratified_to` produces the expected effective P/R boundary;
- connector manifests use immutable SHA-addressed keys and the embedded/key SHA identity agrees exactly;
- a simulated/interrupted manifest-first publication leaves the previous latest/reader authority usable until latest is changed;
- a P-to-R-only change updates verification authority without changing any observation Parquet SHA;
- a trusted history API returns the new effective status after the bounded latest-cache freshness window;
- status-bearing response-cache identity changes when the verification manifest changes;
- repeated source acquisition with unchanged effective periods does not create a semantically different canonical manifest merely because retrieval time/source-file hash changed;
- a connector with overlay authority ignores a conflicting legacy embedded status;
- a connector without overlay authority retains its pre-cut-over compatibility behaviour;
- one logical read spanning schema-3 and schema-4 scopes succeeds with each scope validated against its own physical identity;
- API diagnostics do not falsely report one writer/schema identity for a mixed physical response;
- an attempted unreviewed R-to-P regression fails closed;
- Dropbox backup/restore covers the immutable connector manifests referenced by latest under the dedicated backup amendment.

Do not create a broad speculative pre-deployment test suite. Before implementation, only targeted structural checks needed to prove writer/reader/schema/publication/cache viability are required.
