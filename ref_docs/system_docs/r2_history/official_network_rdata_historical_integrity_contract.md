# WAQN and SAQN RData historical Integrity contract

## Status and authority

**Status: future implementation authority; not current runtime behaviour.**

This contract defines the agreed historical-observation source and Integrity boundary for:

- Welsh Air Quality Network (WAQN), connector `9`;
- Scottish Air Quality Network (SAQN), connector `10`.

It supplements the generic observation-history Integrity contracts. It does not make the current runtime connector `9` or `10` historical-repair capable until the implementation is deployed and accepted through real TEST operation.

This contract owns the RData source authority, source-range acquisition, WAQN/SAQN verification-status derivation and source-to-Integrity boundary. Generic Integrity continues to own DETECT, PROPOSE, APPLY, final verification, writer coordination, canonical observation publication and affected index finalisation.

It MUST NOT be interpreted as permission to change connector `1` SOS-light semantics.

## Purpose

The first operational requirement is to make at least the most recent 90 days of WAQN and SAQN hourly observations available in canonical R2 history so those networks can appear across the normal line-chart history window.

The implementation MUST NOT impose an artificial 90-day source limit. It MUST accept an inclusive requested historical date range and obtain every site-year source object needed by that range.

A request that crosses 1 January MUST combine the required yearly source files without requiring separate operator runs.

## Authoritative upstream files

Historical hourly observations are taken from the Ricardo/WSP OpenAir RData publication.

### WAQN

Base data directory:

```text
https://airquality.gov.wales/sites/default/files/openair/R_data/
```

Metadata file:

```text
WAQ_metadata.RData
```

Hourly site-year file:

```text
<SITE_CODE>_<YEAR>.RData
```

The hourly R object inside the workspace is expected to be named:

```text
<SITE_CODE>_<YEAR>
```

### SAQN

Base data directory:

```text
https://www.scottishairquality.scot/openair/R_data/
```

Metadata file:

```text
SCOT_metadata.RData
```

Hourly site-year file and hourly R object follow the same:

```text
<SITE_CODE>_<YEAR>.RData
<SITE_CODE>_<YEAR>
```

pattern.

Daily, rolling, 15-minute and other additional R objects that may exist in the same workspace are not the hourly observation authority for this path.

## Source acquisition and identity

One Integrity run MUST acquire a stable source view before proposal work for the selected connector/date/pollutant scope.

For each selected network, source acquisition MUST:

1. resolve the authoritative selected site/timeseries bindings;
2. enumerate each distinct site-year RData file overlapping the requested inclusive date range;
3. fetch each required site-year file no more than once for the run;
4. fetch the network metadata file no more than once for the run;
5. retain immutable source identity evidence for every downloaded file, including URL, byte size and a cryptographic content hash;
6. load the hourly site-year object and filter it to the requested UTC history range;
7. expose canonical source rows to Integrity without refetching the same site-year file for each day.

The implementation MAY cache source bytes locally, but a cache hit MUST be authenticated against the pinned source identity used by the run. An uncertain, truncated, unparsable or contradictory source file MUST NOT be interpreted as authoritative no-data.

## RData decoding

The upstream workspaces are native R workspaces and may contain features unsupported by Python-only RData readers.

The implementation MUST use an R-native decoding path compatible with the upstream workspace format, such as `Rscript` plus R's native `load()`, or another decoder whose compatibility with these actual WAQN and SAQN workspaces has been explicitly proven.

The implementation MUST NOT depend on `pyreadr` merely because it can read simpler RData files.

Introducing an R-native extraction step does not make R an observation authority. The downloaded Ricardo/WSP file bytes and their pinned identity remain the source evidence.

## Site, pollutant and timeseries mapping

Connector identity is fixed:

```text
WAQN -> connector_id=9
SAQN -> connector_id=10
```

The source adapter MUST reuse the existing authoritative UK AQ station/timeseries identity for these connectors. It MUST NOT invent new station IDs, timeseries IDs or pollutant codes from source column names alone.

Only source parameters that map unambiguously to an authoritative selected UK AQ timeseries may enter canonical history.

The live official-network ingest mapping is the semantic starting point for source parameter names. Historical mapping MUST remain compatible with the existing connector identity rather than creating a separate historical identity namespace.

A missing, duplicate or ambiguous authoritative binding for a non-empty selected source group fails that group closed and is reported. It MUST NOT be silently mapped to a different station or pollutant.

## Timestamp contract

OpenAir hourly RData uses a date-beginning convention, while the public network portal convention may be hour-ending.

The current WAQN/SAQN live site adapter interprets Ricardo graph timestamp calendar/time components as `Europe/London` wall-clock time and converts them to UTC before persistence. That live-source rule is authoritative under [`../ingest/waqn_saqn_ni_connector_contract.md`](../ingest/waqn_saqn_ni_connector_contract.md).

The historical adapter MUST explicitly normalise the RData source timestamp to the same canonical `observed_at_utc` semantic used by UK AQ for connector `9` and connector `10`.

It MUST NOT assume that the raw RData timestamp is already the correct persisted UK AQ timestamp. The live graph's `Europe/London` interpretation does not, by itself, resolve the separate RData date-beginning/hour-ending alignment question.

Before implementation of the timestamp normaliser is finalised, one narrow targeted alignment check is genuinely required:

1. select one WAQN hourly observation and one SAQN hourly observation that are present both in the current official-network ingest source and in the corresponding RData file;
2. identify whether the existing canonical connector timestamp represents beginning-of-hour or hour-ending semantics;
3. document and implement the exact deterministic conversion;
4. stop and report a conflict if the two current connector paths do not agree.

This is a structural source-boundary check, not a broad pre-implementation test programme.

## Verification status

WAQN and SAQN verification source semantics are derived from the network metadata row for the same:

```text
site_id + parameter
```

The metadata source field is:

```text
ratified_to
```

For a valid non-null observation with an unambiguous metadata row:

```text
observation calendar date <= ratified_to -> R
observation calendar date >  ratified_to -> P
```

The comparison is by UTC calendar date. A valid `ratified_to` date covers the whole stated day.

Under the future [observation verification overlay contract](observation_verification_overlay_contract.md), these statuses are not persisted on each WAQN/SAQN Parquet row. The RData adapter retains `ratified_to` as pinned source provenance and publishes the equivalent canonical verification periods into the connector verification manifest. A change that only advances `ratified_to` updates that verification authority and MUST NOT rewrite otherwise unchanged observation Parquet or observation exact indexes.

If the selected mapped pollutant has an explicit non-date status such as `Never`, or a missing `ratified_to`, the mapped timeseries is provisional (`P`) for verification-overlay purposes and the condition is recorded in source audit evidence. A missing or ambiguous metadata row for a selected mapped pollutant remains a source-mapping defect and fails that selected group closed.

Meteorological fields such as wind direction, wind speed and temperature are not made UK AQ pollutant history merely because they are present in the RData workspace.

Every new verification refresh MUST re-read and pin the current metadata file so later source ratification can advance effective status from `P` to `R` without observation-data mutation.

An accepted effective `R` state MUST NOT be silently downgraded to `P` because a later metadata file unexpectedly regresses or loses its previous ratification boundary. A backwards `ratified_to` movement is contradictory source evidence and fails closed pending explicit review/repair authority.

## Integrity integration

WAQN and SAQN historical support MUST be added as source adapters/scopes to the active generation-aware Integrity implementation.

The implementation MUST NOT create two cloned full Integrity engines.

Conceptually:

```text
generic Integrity
  + WAQN RData source adapter (connector 9)
  + SAQN RData source adapter (connector 10)
```

The adapters provide source evidence and canonical selected rows. Existing generic Integrity contracts continue to own:

- pinned core/timeseries identity;
- baseline authority;
- DETECT;
- PROPOSE;
- selected-scope repair planning;
- APPLY ordering;
- canonical observation writer behaviour;
- parent/index finalisation;
- final verification;
- current-state reconciliation where the selected repaired range reaches current state.

Connector `1` SOS-light remains a separate dedicated mode with its existing complete-day replacement and source-acquisition authority.

## SOS-light isolation requirement

The WAQN/SAQN implementation MUST preserve current connector `1` SOS-light behaviour.

Before active Integrity implementation is changed for this work, the stable fallback defined by [`sos_light_stable_fallback_contract.md`](sos_light_stable_fallback_contract.md) MUST be created from the known-working pre-change SOS-light v3 implementation.

The WAQN/SAQN change SHOULD be additive. In particular, it MUST NOT change the semantics of existing shared SOS-light dependencies merely to make connector `9` or `10` fit the new source path.

If implementation discovers that a shared dependency used by the stable SOS-light fallback must change, work MUST stop and the fallback boundary must be reconsidered before that shared dependency is modified.

## Failure behaviour

For a selected WAQN/SAQN scope, the run fails closed before mutation when:

- a required RData or metadata file cannot be obtained and authenticated;
- RData decoding fails;
- the expected hourly object is absent or structurally unusable;
- selected source coverage is contradictory or uncertain;
- station/timeseries mapping is ambiguous;
- metadata mapping for a selected pollutant is missing or ambiguous;
- timestamp conversion is unresolved;
- canonical row construction or verification-status derivation is non-deterministic.

A proven empty selected source result may use the existing generic Integrity authoritative-no-data semantics only when the adapter can establish that absence from the pinned source evidence. Transport failure or parse failure is never authoritative no-data.

## Audit evidence

Each connector `9` or connector `10` historical Integrity run MUST record at least:

- connector and network;
- requested inclusive date range;
- requested pollutant/timeseries scope;
- source site codes and source years;
- every pinned site-year URL, byte size and content hash;
- pinned metadata URL, byte size and content hash;
- RData decoder identity;
- source timestamp convention and applied canonical conversion;
- mapped and excluded source groups;
- metadata row identity used for each selected pollutant;
- `ratified_to` value used by selected source group;
- source `P`/`R` counts;
- existing generic Integrity proposal/apply/final-verification evidence.

## Structural validation before implementation

Before code changes, structural viability is established by the already-selected source layout plus only these targeted checks:

1. confirm representative current-year WAQN and SAQN site-year files return successfully and can be loaded through native R;
2. confirm the metadata workspaces expose site/pollutant `ratified_to`;
3. perform the narrow timestamp-alignment check required above;
4. confirm the active Integrity binding provider can select connector `9` and `10` authoritative timeseries identities without schema changes.

Do not create a broad speculative pre-implementation test suite.

## TEST functional acceptance

Functional validation happens after deployment through real TEST operation.

The initial TEST acceptance SHOULD proceed from a deliberately small real connector/site/pollutant/date scope to prove source acquisition, mapping, proposal, write and final verification.

After that succeeds, run the intended recent-history operation covering at least the most recent 90 days for WAQN and SAQN so station line-chart history can be checked through the normal TEST serving path.

Acceptance requires:

- no connector `1` SOS-light regression;
- correct canonical timestamps;
- expected historical values for selected WAQN and SAQN timeseries;
- `verification_status` matching the pinned metadata ratification boundary;
- normal parent/index finalisation and serving;
- the stable SOS-light fallback remaining available and unchanged.
