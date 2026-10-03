# AURN observation validation-status contract

## Authority and scope

This contract is the authoritative UK AQ definition of validation status for **GOV.UK AURN / connector `1` observations** in canonical R2 observation history.

It applies to the current SOS-light writer and to any future Integrity Factory & Warehouse (IFW) implementation that replaces SOS-light. It also defines the semantic source consumed by trusted server-side APIs that present AURN provenance to the website.

This contract does not add validation status to IngestDB, Obs AQI DB or Supabase observation storage.

## Accepted future persistence change

The semantic AURN P/R rules in this contract remain unchanged, but the future [observation verification overlay contract](observation_verification_overlay_contract.md) moves their R2 persistence out of individual observation Parquet rows.

After connector `1` overlay cut-over, UK-AIR CSV per-observation status is collapsed into authoritative verification periods in the connector verification manifest. New observation Parquet omits `verification_status`, trusted readers derive the same effective P/R value from the overlay, and a status-only ratification change does not rewrite observation Parquet.

Until that future model is deployed and accepted, the current persisted-field rules below remain runtime authority.

## Defra AURN lifecycle

Defra describes AURN data as a two-stage publication lifecycle:

```text
provisional / unverified
        ->
verified / ratified
```

Current Defra guidance states that provisional AURN data is published every hour with an `unverified` flag and that, after full quality-control and assurance checks, the data is reloaded with a `verified` flag under the heading **Verified (ratified) data**.

Authoritative public references:

- <https://www.gov.uk/guidance/air-pollution-monitoring-automatic-urban-and-rural-network-aurn>
- <https://uk-air.defra.gov.uk/networks/network-info?view=aurn>

UK AQ therefore uses exactly two canonical AURN validation states for a valid non-null observation:

```text
P = provisional
R = ratified
```

There is no third normal UK AQ AURN validation state.

## Canonical R2 field

The canonical persisted observation-history field, governed by the [observation-history schema contract](observation_history_schema_contract.md), is:

```text
verification_status
```

For every newly built non-null AURN observation written by an Integrity-owned source-repair/replacement path, `verification_status` MUST be exactly one of:

```text
"P"
"R"
```

The classification rule is:

```text
valid non-null AURN observation
        |
        +-- authoritative source evidence says verified/ratified -> verification_status = "R"
        |
        +-- otherwise                                           -> verification_status = "P"
```

`R` MUST be assigned only when the authoritative AURN source evidence establishes verified/ratified status.

Once a source row has passed the existing AURN validity, parsing and canonicalisation rules and produces a non-null observation, absence of ratified/verified evidence means `P`. Integrity MUST NOT create an additional `unknown`, `unverified`, `final`, `validated` or null validation state for such a non-null AURN observation.

A source row rejected by the existing source-validity/canonicalisation rules is not converted into a provisional observation merely to satisfy this contract.

## Null and legacy behaviour

A null/missing observation value is not a P/R observation and does not require an observation-level `verification_status`.

Historical R2 objects may legitimately have no persisted verification-status column. Already-written erroneous TEST objects may instead carry `vstatus`; that name is temporary read compatibility only under the schema contract. Readers MUST remain storage-compatible with genuine legacy absence, but it is not a third semantic AURN validation state.

When a trusted reader or API must present validation status for a legacy **non-null AURN observation** with no stored status evidence after supported physical aliases are read, the semantic fallback is `P`, because the observation is not established as ratified. A non-null AURN observation MUST therefore resolve to `P` or `R`, not null, at the validation-status presentation boundary.

A current writer MUST NOT omit `verification_status` from a newly written non-null AURN observation merely because the source did not carry an explicit provisional marker. If the observation is valid and non-null and there is no authoritative ratified/verified evidence, its status is `P`.

## Ownership boundary

Validation status is owned by Integrity and canonical R2 observation history:

```text
AURN source evidence
        ->
Integrity source parsing/canonicalisation
        ->
R2 observation `verification_status`
        ->
trusted history/API consumer
        ->
website presentation
```

IngestDB, Obs AQI DB and Supabase MUST NOT become persistence authorities for AURN `verification_status` merely because most newly ingested AURN observations are provisional.

The presence of an AURN observation in IngestDB/Supabase is not itself the persisted source of its validation status. Current ingest continues to publish observations without a validation-status storage dependency. Integrity is responsible for materialising `verification_status` when it builds or replaces canonical R2 AURN history.

## Current and future writer ownership

SOS-light is the current operational writer for connector `1` historical replacement and MUST implement this contract for AURN observations it writes into R2.

When IFW replaces SOS-light, IFW MUST preserve this exact R2 field and semantic contract. IFW MUST NOT introduce a competing AURN validation-status field or move persistence authority into Supabase without a later explicit contract change.

## Ratification precedence

For the same canonical AURN observation identity, `R` is stronger validation evidence than `P`.

Where a repair/reconciliation operation encounters otherwise equivalent competing P/R evidence for the same observation, `R` MUST take precedence and MUST NOT be downgraded to `P` solely because a less-authoritative provisional copy is also available.

This precedence does not prevent an authoritative later source correction or deletion from changing/removing an observation under the normal source-correction contract. It governs P/R status choice when the observation itself remains the same canonical measurement.

## API and presentation mapping

R2 persists `verification_status` as defined by the observation-history schema contract.

A trusted server-side API MAY expose the same semantic value under an existing presentation field such as:

```text
source_validation_status
```

That is a boundary mapping only. It MUST NOT create a second persistence authority.

A browser-facing API MUST NOT infer `R` from observation age, publication date, Supabase presence or a browser-side heuristic. For a valid non-null AURN observation, anything not established as `R` resolves to `P`.

For a derived daily presentation value, `R` may be claimed only when the trusted R2 provenance for the contributing non-null AURN observations establishes that the contributing set is ratified. If the day contains any contributing non-null AURN observation that is provisional or lacks stored status evidence after supported legacy reads, its presentation status is `P`.

A day with no non-null AURN observation may use null because there is no observation to classify. Null is absence of a classifiable observation, not a third validation state.

## Structural and operational validation

Before implementation, only establish structural viability:

- identify the active SOS-light AURN source parser/canonicaliser;
- identify the canonical R2 observation writer used by the relevant SOS-light generation;
- confirm that `verification_status` can be carried without changing the Supabase observation schema;
- identify the trusted history/API boundary that will map R2 `verification_status` to any presentation field.

Do not create a speculative pre-implementation test suite.

Functional validation belongs after deployment through real TEST operation using actual AURN source/history data. The operational check must demonstrate at least one provisional non-null observation as `P`, one source-confirmed ratified non-null observation as `R` where available, legacy missing-status-column non-null read compatibility resolving to `P`, and no new Supabase validation-status persistence dependency.
