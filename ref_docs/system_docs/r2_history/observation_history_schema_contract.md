# R2 observation-history schema and canonical naming contract

## Accepted future verification-overlay transition

The future [observation verification overlay contract](observation_verification_overlay_contract.md) records an accepted transition that separates observation measurement storage from effective P/R verification authority.

Until that future model is deployed and accepted through real TEST operation, this file's current seven-column `verification_status` Parquet contract remains the runtime authority.

After connector-scoped overlay cut-over, the overlay contract is authoritative for the new six-column physical schema, measurement-only content hash and reader derivation of effective `verification_status`. Existing seven-column schema-version-3 Parquet remains readable legacy measurement history and does not require a whole-archive rewrite solely to remove the embedded status field.

Because cut-over is connector-scoped and old Parquet is retained, a normal logical history read may span both schema-version-3 and schema-version-4 physical objects. Readers MUST validate the physical identity selected by each authoritative scope/file rather than impose one request-wide schema/writer identity. The exact-v3 mixed-scope rules are owned by the verification-overlay and exact-leaf contracts.

## Purpose

This contract is the authoritative UK AQ definition of
persisted schema names for canonical R2 observation history.

Its purpose is to prevent implementation refactors, abbreviations, compatibility
helpers or presentation shorthand from silently changing persisted field names.

It owns:

- canonical observation Parquet column names and order;
- canonical logical observation-row field names;
- observation content-hash field names;
- permitted legacy-read compatibility names;
- deliberate database/source/API boundary mappings;
- canonical observation-history R2 path vocabulary;
- the rule for changing persisted names.

Behavioural contracts such as SOS-light, Integrity apply safety, manifest hierarchy
and exact-v3 indexing retain ownership of their processing, authority and publication
rules. They should reference this contract for names rather than define competing
names for the same semantic field.

## Canonical observation row

The canonical logical observation row is exactly:

```text
connector_id
station_id
timeseries_id
pollutant_code
observed_at_utc
value
verification_status
```

These names are exact.

A current implementation MUST NOT introduce an alternative persisted name for any
of these fields without an explicit authoritative contract amendment and an explicit
schema/data-migration decision.

## Canonical observation Parquet schema

The canonical current observation-history Parquet columns, in exact order, are:

```text
connector_id
station_id
timeseries_id
pollutant_code
observed_at_utc
value
verification_status
```

The fields mean:

| Column | Meaning |
|---|---|
| `connector_id` | Internal UK AQ connector integer ID |
| `station_id` | Internal UK AQ station ID, subject to the canonical observation-row nullability rules |
| `timeseries_id` | Internal UK AQ timeseries integer ID |
| `pollutant_code` | Canonical lower-case pollutant/property code |
| `observed_at_utc` | Observation timestamp in UTC |
| `value` | Canonical finite observation value |
| `verification_status` | Canonical observation verification status |

A current observation-history writer MUST emit `verification_status`.

A current observation-history writer MUST NOT emit either of these names as the
canonical R2 verification-status column:

```text
vstatus
status
```

## Verification-status naming

The sole canonical persisted R2 field name is:

```text
verification_status
```

`verification_status` is also the canonical logical field used by the observation
content-hash contract.

`vstatus` is a prohibited historical error name. It is not a canonical
database, R2, Parquet, manifest, index, API or implementation field name.

Outside authoritative system documentation that records this prohibition or describes
already-written historical corruption, and immutable repository archive snapshots as
defined below, `vstatus` MUST NOT appear in active executable code, tests, filenames,
configuration, schemas, manifests, indexes, APIs, generated artefacts, maintenance
tooling or newly written data.

Exact historical/rollback snapshots under the repository's established `archive/`
tree are exempt from the active-code naming prohibition. An archive snapshot MAY retain
the historical name in file contents or filenames only when it is an exact preserved
pre-change artefact or other genuine historical record. Such archive content MUST remain
non-executable, MUST NOT be imported or used as a runtime fallback, and MUST NOT be
edited, renamed or deleted merely to remove the historical name. Where the repository's
normal archive-safety rules require a pre-change snapshot, that exact snapshot MAY retain
the historical name.

Repair tooling for already-written objects containing the prohibited historical name
MUST identify the affected physical schema structurally without encoding that name in
executable implementation. It MUST fail closed on any unexpected competing status
field or ambiguous physical shape, preserve the existing logical P/R/null value exactly,
and write only the canonical `verification_status` field.

The presence of a historical object written with the prohibited name does not create a
supported compatibility alias. No current reader or writer may expose, emit or select
that name as an implementation field.

Historical observation Parquet may also contain:

```text
status
```

or may pre-date persisted verification status entirely.

`status` is a historical/source compatibility field, not a second canonical R2
verification-status name. Readers MAY support explicitly documented historical forms
where required, but all current canonical R2 output MUST use `verification_status`.

## AURN verification-status semantics

The [AURN validation-status contract](aurn_validation_status_contract.md) owns the
connector `1` P/R classification, authoritative source evidence, and legacy
missing-column presentation fallback. This contract owns its R2 field name.

## Observation content-hash naming

The canonical observation-content-hash fields are exactly:

```text
connector_id
station_id
timeseries_id
pollutant_code
observed_at_utc
value
verification_status
```

Physical legacy aliases MUST be normalised to those canonical logical names before
hashing.

A physical compatibility mechanism MUST NOT create a second logical observation field
or a second content-hash schema.

The [Integrity hash contract](integrity.md#observation-content-hash-contract) owns
hash construction and metadata. Its `observation_content_hash_columns` uses the
canonical logical names above; `verification_status_counts` is hash metadata,
not an alternative observation field.

## Canonical R2 observation-history path vocabulary

The selected v3 observation-history generation stores canonical observation objects
beneath:

```text
history/v3/observations/
```

The canonical logical observation-history version remains:

```text
history_version = "v2"
```

Those are different identities and MUST NOT be conflated.

Canonical observation partition paths use:

```text
day_utc=<YYYY-MM-DD>
connector_id=<id>
pollutant_code=<code>
```

Canonical Parquet part names use:

```text
part-00000.parquet
part-00001.parquet
...
```

Canonical observation aggregate manifests use:

```text
history/v3/observations/_manifests/
```

The selected exact observation-timeseries index generation uses:

```text
history/_index_v3/observations_timeseries/
```

Its global/latest discovery object is:

```text
history/_index_v3/observations_timeseries_latest.json
```

Logical history version, storage generation, writer version, physical-layout version
and index generation are independent identities. An implementation MUST NOT treat one
as an alias for another.

## Persisted object-schema ownership

The canonical R2 object families are:

| Object family | Canonical ownership |
|---|---|
| Observation Parquet row | This schema contract |
| Pollutant, connector and day manifests | Existing canonical observation manifest contracts and implementation; [file identity](connector_gate_file_identity.md) remains specialist authority |
| Month, year and observations-root manifests | [Observation manifest hierarchy contract](observations_manifest_hierarchy_contract.md) |
| Exact-v3 index objects | [Observation-history exact-v3 index contracts](observation_history_index_v3_exact_leaf_amendment.md) |

Those object schemas MAY use different names where the structural meaning is genuinely
different.

For example, a canonical manifest may define:

```text
files[].bytes
files[].etag_or_hash
```

while an exact-index descriptor defines:

```text
byte_size
sha256
```

Those are separate defined object schemas, not accidental aliases merely because they
participate in physical object identity.

Likewise, `manifest_hash`, aggregate `content_hash` and physical-object `sha256`
have distinct meanings and MUST NOT be mechanically renamed into one another.

## Intentional database and source boundary mappings

Database/source and R2 field names do not have to be identical when an explicit
boundary mapping is defined.

The following timestamp mapping is intentional:

```text
Postgres/source observed_at
    ->
R2 observed_at_utc
```

Source or historical status may map to canonical R2 `verification_status` only under
the relevant source-specific validation and normalisation contract.

A source field named `status` is not automatically equivalent to R2
`verification_status`.

Internal IDs and external references are different identities:

```text
station_id      != station_ref
timeseries_id   != timeseries_ref
```

They MUST NOT be treated as naming aliases.

## API and presentation mappings

An API MAY expose a deliberately different presentation field only where an explicit
API/presentation contract defines that mapping.

For AURN validation provenance, the permitted presentation mapping is:

```text
R2 verification_status
    ->
API source_validation_status
```

`source_validation_status` is a presentation field only and MUST NOT become a
competing R2 persistence name.

A current API MUST NOT expose `vstatus`.

Where a private/raw observation API exposes the canonical status field directly, its
field name MUST be `verification_status` unless that API's own authoritative
contract explicitly defines a different presentation mapping.

## Legacy compatibility is one-way

Legacy-read compatibility MUST be explicit and one-way.

A current reader MAY recognise an explicitly documented historical physical schema so
that historical data can be read, inventoried or migrated.

A current writer MUST NOT reproduce an obsolete or erroneous alias merely because a
reader understands it.

Compatibility therefore flows:

```text
legacy physical representation
    ->
canonical logical representation
```

and never:

```text
canonical logical representation
    ->
legacy physical representation
```

Readers MUST fail closed when competing status fields are simultaneously present or
contradictory.

## Persisted-name change rule

A persisted-field or persisted-object-key rename is a schema migration.

Before implementation it requires:

1. an explicit amendment to the authoritative schema contract;
2. identification of affected current writers;
3. identification of affected current readers and APIs;
4. identification of existing persisted objects;
5. an explicit compatibility and migration decision;
6. an operational TEST migration/acceptance plan where persisted data is affected.

A code refactor, abbreviation, local variable rename, implementation convenience,
presentation shorthand or test fixture change MUST NOT rename persisted storage.

## Canonical naming registry

| Layer/domain | Canonical name | Permitted mapping or compatibility |
|---|---|---|
| Canonical observation validation status | `verification_status` | Historical read of `status`; `vstatus` is prohibited in active implementation and may appear only in authoritative system documentation or immutable `archive/` snapshots retained as exact historical/rollback evidence |
| R2 observation timestamp | `observed_at_utc` | Postgres/source `observed_at` at an explicit boundary |
| Manifest physical size | `files[].bytes` | Exact-index descriptors may separately define `byte_size` |
| Manifest physical digest | `files[].etag_or_hash` | Exact-index descriptors separately use `sha256` |
| Exact-index physical size | `byte_size` | No alias inside that schema |
| Exact-index physical digest | `sha256` | No alias inside that schema |
| AURN presentation status | `source_validation_status` | Maps from R2 `verification_status` |
| Internal station identity | `station_id` | `station_ref` is a separate external identity |
| Internal timeseries identity | `timeseries_id` | `timeseries_ref` is a separate external identity |
| Observation storage generation | `history/v3/observations/` | Not an alias for logical `history_version=v2` |
| Exact observation index generation | `history/_index_v3/observations_timeseries/` | Separate from canonical observation storage |

## Required current-output rule

Active observation-history writers, Integrity/SOS-light code and trusted APIs MUST
conform to this contract.

Current schema constants, executable compatibility paths and maintenance tooling
MUST NOT contain or designate `vstatus` as an implementation field. Permitted occurrences
are limited to authoritative system documentation describing its prohibition or historical
corruption, plus immutable `archive/` snapshots retained solely as exact historical or
rollback evidence.

Repository-wide compliance checks for current implementation MUST therefore distinguish
active content from `archive/`. An occurrence under `archive/` is not a naming-contract
violation by itself, but any occurrence outside authoritative system documentation and
`archive/` is a defect.

The required direction is:

```text
current canonical field = verification_status
prohibited historical name = vstatus; never active executable compatibility
archive exception = exact non-executable historical/rollback snapshots only
```

Implementation MUST provide a small deterministic structural check that ties
current writer output and schema constants to the exact canonical Parquet column
list above. Functional acceptance follows deployment through real TEST operation.

The selected exact-leaf v3 provenance reader's acquisition of P/R status remains
under its separate reader and API authority; this naming contract does not redesign it.
