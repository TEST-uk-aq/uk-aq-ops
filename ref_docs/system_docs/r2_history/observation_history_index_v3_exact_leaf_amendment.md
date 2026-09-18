# Observation-history index v3 exact-leaf and station-history paging amendment

## Authority and status

This document is the authoritative amendment for the selected post-cut-over observation-history index-v3 physical layout, exact-timeseries leaf index, low-level physical paging contract and station-history consumption boundary.

It is **future implementation authority until the v3 cut-over is accepted**. It constrains the replacement v3 implementation and migration, but it is not evidence that the current deployed observation-history runtime already uses this design.

It amends and, where conflicting, supersedes:

- [`observation_history_index_v3_contract.md`](observation_history_index_v3_contract.md);
- [`observation_history_index_v3_migration_contract.md`](observation_history_index_v3_migration_contract.md);
- [`observation_history_index_v3_operator_contract.md`](observation_history_index_v3_operator_contract.md);
- [`interfaces.md`](interfaces.md);
- [`../aqi-levels/station-history-contract.md`](../aqi-levels/station-history-contract.md).

For the selected v3 design, this amendment specifically supersedes older wording that requires or assumes:

- `physical_layout_version = timeseries-bounded-v1`;
- 8,192-row target / 16,384-row maximum row groups;
- keeping a complete dense timeseries in one row group merely because it fits below 16,384 rows;
- 1,000-timeseries child shards as the active exact-read lookup unit;
- runtime Parquet-footer fetching or parsing to discover byte offsets;
- runtime `timeseries_id` decoding as a correctness check on the hot path;
- an unbounded station-history physical-page walk;
- a browser-visible or cache-proxy-visible encrypted station-history continuation protocol.

The logical observation-history version remains v2. This amendment does not change canonical row meaning or multiplicity, `observation_content_hash`, verification status semantics, timeseries-binding/continuity authority, AQI algorithms, Integrity source authority, backup/rollback ownership or Prune Daily deletion gates.

## Selected physical layout

The selected v3 observation physical layout is:

```text
physical_layout_version = timeseries-aligned-v2
maximum chronological segment / row-group rows = 1024
```

The 1,024-row maximum is a selected physical safety and CPU bound, not a temporary tuning experiment. It MUST NOT be increased or reduced merely to simplify implementation. A later change requires new explicit contract authority supported by real TEST evidence.

Within each canonical UTC-day / connector / pollutant partition:

- rows MUST remain deterministically ordered by `timeseries_id`, then `observed_at_utc`, with the existing deterministic canonical tie-break for otherwise equal logical identity;
- each independently decodable row group MUST contain exactly one timeseries;
- a timeseries with more than 1,024 rows MUST be split into ordered chronological segments;
- every segment / row group MUST contain at most 1,024 physical rows;
- multiple row groups MAY share one Parquet object;
- Parquet-file packing MUST remain deterministic and deliberately bounded;
- physical file boundaries MUST NOT change logical row multiplicity or content identity.

The old accepted `timeseries-bounded-v1` 8,192/16,384 row-group calibration is historical evidence only for the superseded layout. It is no longer the migration or steady-state writer authority.

Migration and steady-state writers MUST use the same selected `timeseries-aligned-v2` physical contract. A migration-only packing layout remains prohibited.

## Exact-timeseries leaf hierarchy

The active exact v3 read hierarchy MUST use deterministic scoped manifests plus exact-timeseries physical leaves rather than requiring a 1,000-ID child shard to be decoded for each request.

The production index root remains conceptually:

```text
history/_index_v3/observations_timeseries
```

For each UTC-day / connector / pollutant scope, the scoped manifest MUST be the authoritative selector for exact-timeseries leaf membership. It MUST map each authoritative timeseries to a descriptor that pins the exact leaf body by at least:

```text
key
byte_size
sha256
```

The exact leaf key MUST be deterministic from the configured v3 index root, scope and timeseries ID. The exact leaf MUST describe only the requested timeseries for that scope and MUST carry complete ordered segment metadata for that timeseries.

A missing scoped manifest, a manifest-pinned leaf that is missing, a leaf whose body does not match the pinned size/SHA-256, or contradictory leaf semantics MUST fail closed or produce the contractually appropriate explicit incomplete result. A stale/orphaned leaf at a deterministic key MUST NOT become authoritative merely because it exists.

Compact latest/global v3 metadata MAY remain for discovery and operations, but it is not an additional per-request authentication parent unless a later contract explicitly makes it one.

## Exact physical segment and byte-range metadata

Each exact segment MUST identify enough information to select and validate one independently decodable row group, including at least:

```text
timeseries_id
physical file identity
row_group_ordinal
exact logical row start
row_count
min_observed_at_utc
max_observed_at_utc
```

For the selected hot path, the offline writer/index generation MUST also persist the exact physical byte ranges needed to decode:

```text
observed_at_utc
value
```

Those ranges MUST include any required page-header or dictionary bytes for the pinned decode profile.

This requirement supersedes the old rule that physical Parquet byte offsets must not be authoritative index routing data. For `timeseries-aligned-v2`, validated exact byte ranges are deliberately part of the authoritative physical leaf metadata.

The offline writer/index path MUST validate the actual serialised Parquet structure before publishing those ranges. It MAY inspect and parse the footer during generation/validation. A mismatch between intended row-group identity, actual serialised Parquet metadata and the ranges to be published MUST fail before authority is published.

The runtime exact reader MUST NOT fetch or parse the Parquet footer to rediscover those ranges.

## Runtime projected columns and decode profile

The selected runtime exact reader decodes only:

```text
observed_at_utc
value
```

It MUST NOT decode `timeseries_id` merely to re-prove a row-group identity that the offline aligned writer and exact leaf have already pinned and authenticated.

The decode profile MUST be explicit and fail closed. The currently selected profile is:

```text
hyparquet-direct-column-v1
```

A request MUST fail closed for an unsupported writer/layout/decode-profile combination rather than falling back to broad whole-object decoding, runtime footer discovery, `_index_v2`, or a different physical layout.

## Parquet physical identity gate

Before any indexed Parquet byte range is read, the runtime MUST establish that the object is the exact physical object pinned by the leaf/index evidence.

For the selected design, runtime identity validation MUST include the pinned byte size and project-owned SHA-256. The selected exact-leaf implementation also binds the current R2 ETag as corroborating object identity and MUST fail closed when the required pinned/current object identity disagrees.

SHA-256 remains the strong project-owned identity. ETag MUST NOT silently substitute for SHA-256.

No CPU optimisation may remove this fail-closed physical identity boundary without an explicitly contracted equivalent guarantee.

## Low-level logical request boundary

One low-level exact observation-history logical request MUST be non-empty and MUST span no more than 24 hours.

A request MAY cross UTC midnight. Therefore one low-level request may touch one or two UTC-day scopes, but it MUST NOT exceed the 24-hour logical bound.

The low-level exact endpoint MUST reject legacy logical paging controls that compete with physical paging, including:

```text
since_utc
limit
```

when using the exact-leaf physical-page contract.

Higher-level range and response-row limits belong to station history, not to the low-level physical cursor.

## One physical segment per observation-history Worker invocation

One low-level observation-history Worker invocation MUST decode at most:

```text
1 physical segment
1024 physical rows
```

It MUST NOT decode a second segment merely because more segments intersect the same logical interval.

Page 1 owns the complete bounded discovery needed for the one or two UTC scopes touched by the request. It validates the required scoped manifest(s) and exact leaf/leaves, establishes coverage/gap state and identifies the ordered intersecting segment sequence.

When another physical segment remains, page 1 returns an opaque `physical_cursor`.

A normal same-scope continuation MUST use the cursor's pinned bounded discovery state to read and validate the deterministic current exact leaf directly. It MUST NOT repeat whole-range manifest discovery or reconstruct and globally sort an unbounded remaining-segment list.

A cross-scope continuation MAY validate the deterministic next scope leaf pinned by the initial bounded discovery, but still decodes at most one physical segment.

## `physical_cursor` contract

`physical_cursor` is private low-level plumbing between station history and the exact observation-history reader.

It MUST:

- bind the original logical request identity;
- bind the required v3 index/layout/decode-profile identity;
- carry only bounded discovery state sufficient to reach the exact next segment;
- be parsed as untrusted input;
- fail closed for malformed, cross-request, stale-index, stale-leaf, stale-coordinate or out-of-root state;
- never permit cursor-supplied object keys to bypass deterministic configured roots and leaf-key rules.

The selected cursor schema is version 2.

A separate cryptographic signature is not required while the low-level route remains protected by the established upstream-auth boundary and all routing/identity fields are independently validated. Authentication does not make cursor content trusted.

Physical pagination incomplete by itself is not a source-data gap. When additional physical pages remain, the low-level response MUST distinguish work incompleteness from genuine coverage loss, using:

```text
response_complete = false
has_gap = false
partial_reasons includes physical_pagination_incomplete
physical_page.pagination_complete = false
physical_page.next_cursor = <opaque cursor>
```

A missing required scope/leaf or other genuine coverage failure remains a distinct gap/incomplete condition.

## Station-history consumption

The browser and cache proxy MUST NOT receive or supply `physical_cursor`.

Station history remains the higher-level owner of browser-facing historical chunking, physical continuity selection, R2/ingest seam handling and calculated-AQI context.

When station history consumes v3 exact observation history it MUST:

1. split each required physical-timeseries source interval deterministically at UTC-day boundaries so every low-level logical piece is no more than 24 hours;
2. issue page 1 for a piece;
3. follow private `physical_cursor` pages in strict chronological order until that piece completes or a station-history safety budget is exhausted;
4. append completed UTC pieces in chronological order;
5. merge continuity members only inside station history;
6. preserve existing R2-over-ingest exact-timestamp precedence and hidden PM context rules;
7. expose no new browser/public station-history continuation protocol.

The existing browser progressive chunk strategy MUST NOT be replaced by blanket 24-hour browser requests merely because the low-level exact reader has a 24-hour bound.

## Station-history physical-page and R2 row budgets

One station-history invocation MUST have one shared physical-page budget across all v3 observation reads performed by that invocation, including continuity members and any observation reads needed for calculated AQI.

The selected physical-page budget is:

```text
16 low-level physical pages per station-history invocation
```

The page budget is a fixed safety bound, not an environment tuning variable and not a public pagination control.

The v3 R2 observation assembly budget is:

```text
5000 accepted R2 observation rows per station-history invocation
```

This 5,000-row bound applies to observation rows assembled from v3 exact observation-history pages before the normal R2/recent-IngestDB seam merge. It is not an absolute post-merge `/v1/station-series` row ceiling. Valid recent IngestDB seam rows MUST NOT be truncated merely to keep the final combined station-series response below 5,000 rows.

Existing browser-facing history-chunk request limits remain governed by the station-history interface/chunk contract. The v3 R2 assembly budget is an additional internal work bound and MUST NOT be reinterpreted as a new public pagination contract.

The v3 page walker MUST enforce the R2 assembly row budget while walking physical pages rather than fetching an arbitrarily larger R2 result and only noticing the limit after serialisation work is complete. If appending an inspected physical page would take the accepted R2 row count above 5,000, the page MUST NOT be appended in full and further physical walking MUST stop for that invocation. The implementation MAY instead retain only a deterministic chronological prefix from that already fetched page if explicitly supported without weakening completeness semantics. In either case it MUST NOT claim completeness while R2 work remains.

The physical-page and R2-assembly-row budgets are independent. Hitting either bound MUST stop further v3 physical walking for that invocation.

Physical-page exhaustion MUST include the machine-readable partial reason:

```text
observation_history_physical_page_budget_exceeded
```

R2 row-budget exhaustion MUST include the machine-readable partial reason:

```text
observation_history_row_budget_exceeded
```

Budget exhaustion is a work/response bound, not proof that canonical source data is absent. Completeness diagnostics MUST distinguish budget exhaustion from genuine source-coverage gaps.

A response made incomplete by either budget MUST flow through the existing station-history no-store policy. It MUST NOT silently truncate while claiming completeness and MUST NOT create a browser continuation token to work around the bound.

The 16-page and 5,000-R2-row budgets MUST be shared for the whole station-history invocation. Feature-flag combinations or internal helper paths MUST NOT accidentally create a second independent budget and thereby double the allowed physical work.

### Direct observation-history limits metadata

The established v2 direct observation-history response retains:

```text
limits.max_pages = 1
```

For the v3 direct observation-history response, physical paging is internal to station history and the response MUST instead expose:

```text
limits.max_physical_pages = 16
```

The v3 direct response MUST NOT use `limits.max_pages` to describe the physical-page budget. Other existing limit fields, including the browser-facing maximum observation rows where applicable, retain their existing meanings.

These fields are diagnostics/contract metadata. They do not expose `physical_cursor` or create a public continuation mechanism.

## Higher-level station-history continuation is not active architecture

The previously explored encrypted/browser-visible `station_history` continuation design is not part of the selected v3 architecture.

Its token encryption, nonce/key state, carried AQI state and cap experiments may remain in non-authoritative implementation archive material for possible future recovery, but active runtime code, configuration and system contracts MUST NOT depend on that protocol.

If a future workload genuinely requires multi-invocation station-history continuation, it requires a new explicit contract decision rather than silently reactivating archived code.

## Dense historical Sensor.Community boundary

Dense historical Sensor.Community archive data is valid evidence that low-level physical segmentation must remain safe. It is not a reason to make normal station-history page walking unbounded.

The current live Sensor.Community ingest cadence and any future Integrity Factory archive canonicalisation are separate concerns. This contract does not authorise changing live SComm ingestion, rewriting existing SComm history or adding sensor-specific serving logic.

The exact-leaf reader MUST remain generic and safe when dense history is encountered. Station history may return an explicitly incomplete/no-store result when the fixed page or R2 row budget is exceeded.

## Migration and cut-over amendment

The v3 migration MUST target `timeseries-aligned-v2`, the 1,024-row segment cap and the exact-timeseries physical-leaf hierarchy defined here.

The old `timeseries-bounded-v1` migration writer-limit JSON and its 2026-08-22 acceptance are superseded. Migration plans/checkpoints MUST NOT pin or require the old 8,192/16,384 row-group authority after this amendment.

Before the first incompatible TEST migration write, the migration tooling and steady-state shared writer must be structurally capable of producing the selected aligned layout and exact leaf/range metadata with the same deterministic logical identities and existing checksum-aware publication guarantees.

Migration acceptance continues to require preservation of canonical logical row count, `observation_content_hash` and applicable status-count invariants. This physical redesign does not authorise source-data changes during migration.

The migration checkpoint/plan MUST pin the selected physical-layout identity, 1,024-row cap, exact-leaf/index schema identity and supported production writer/decode identities. Prototype `_prototype` prefixes and candidate Worker names are not canonical production identities and MUST NOT be copied into the migration authority merely because they were used for calibration.

Runtime functional acceptance occurs after deployment through real TEST operation. Normal AURN, Breathe London, OpenAQ and current Sensor.Community history, PM context, bounded incomplete/no-store behaviour and actual Cloudflare invocation/CPU telemetry are the relevant operational evidence. Broad speculative pre-implementation test programmes are not required.

## Preserved migration and safety authority

Unless explicitly superseded above, the existing v3 migration/operator amendments remain authoritative, including:

- writer freeze and maintenance boundaries;
- immutable migration authority/checkpoint rules;
- exact prepared-byte recovery requirements;
- R2 backup inventory versus Dropbox checkpoint/state evidence;
- post-cut-over rollback data preservation;
- dedicated post-write steady-state acceptance;
- canonical observation run exclusion;
- checksum-aware publication and fail-closed physical identity;
- controlled TEST rehearsal before restricted LIVE beta cut-over.

This amendment changes the selected physical/index/read architecture. It does not weaken those migration, backup, recovery or writer-coordination gates.
