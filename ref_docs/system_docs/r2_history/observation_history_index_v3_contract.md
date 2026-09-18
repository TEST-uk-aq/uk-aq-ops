# R2 observation history index v3 and ranged Parquet read contract

## Authority and scope

This document is authoritative for the target observation-history physical layout, observation-timeseries index generation v3 and ranged Parquet reader.

It is an authoritative amendment to:

- [`interfaces.md`](interfaces.md);
- [`history_writer_coordination.md`](history_writer_coordination.md);
- [`implementation_safety_contract.md`](implementation_safety_contract.md);
- [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md);
- [`integrity_global_index_publication_order_contract.md`](integrity_global_index_publication_order_contract.md);
- [`observations_manifest_hierarchy_contract.md`](observations_manifest_hierarchy_contract.md);
- [`connector_gate_file_identity.md`](connector_gate_file_identity.md);
- [`../aqi-levels/station-history-contract.md`](../aqi-levels/station-history-contract.md);
- [`../backup_and_recovery/r2_history_dropbox_backup_contract.md`](../backup_and_recovery/r2_history_dropbox_backup_contract.md).

Where older wording conflicts with this document for observation-history physical packing, exact observation-timeseries indexing, ranged observation reads, or post-cut-over observation-history reader behaviour, this document is authoritative.

This contract does not change the logical meaning of canonical v2 observation rows, timeseries-binding semantics, Prune Daily deletion-gate ownership, Integrity source authority or station continuity semantics. It does not reintroduce calculated AQI / `aqilevels` as an active R2 history product; that domain remains retired under [`aqi_r2_retirement_contract.md`](aqi_r2_retirement_contract.md).

## Version boundary

The canonical logical observation-history version remains:

```text
UK_AQ_R2_HISTORY_VERSION=v2
```

The new observation-history index generation is:

```text
history/_index_v3/...
```

The observation-timeseries v3 root is:

```text
history/_index_v3/observations_timeseries
```

The existing:

```text
UK_AQ_R2_HISTORY_INDEX_VERSION
```

is the observation-timeseries generation control and cut-over assertion for this domain only.

Phase 0 established that the variable does not currently select a deployed steady-state reader or writer. The v3 implementation MUST therefore give it observation-timeseries-only semantics rather than extending the existing generic history-version branching to unrelated domains.

Unaffected active domains such as timeseries binding, backup inventory/checkpoint state and Integrity semantics retain their existing v2 configuration and MUST NOT acquire v3 semantics merely because observation-timeseries indexing moves to v3. Retained historical AQI/`aqilevels` objects remain legacy data only and MUST NOT be treated as an active v2 writer/index domain.

The migration transition remains operationally:

```text
currently deployed observation runtime: v2
    -> offline hard cut-over
post-cut-over observation runtime: v3 only
```

The target v3 runtime MUST NOT implement a normal `v2|v3` reader/writer/index compatibility selector. Once the v3 generation is authoritative, active v3 observation code MUST require the v3 observation-timeseries generation and fail closed if configured otherwise.

Before the hard cut-over, the currently deployed v2 runtime may continue operating while v3-only replacement code is developed but not wired into normal scheduled/runtime paths. This temporary development state is not a hybrid runtime: no production request or steady-state writer may dynamically choose between v2 and v3 implementations.

A new configuration variable MUST NOT be introduced merely to provide a second v2/v3 selector. Explicit v3 prefix variables MAY be introduced only where needed to express the observation-timeseries v3 domain unambiguously.

## V2 observation-code retirement boundary

The target active implementation after cut-over is v3-only for observation-timeseries indexing and observation-history physical reads/writes.

Observation-index-specific v2 reader, writer, resolver and index-generation code that is superseded by v3 MUST NOT remain as an active compatibility path or fallback after accepted cut-over.

Before removing or replacing active non-test v2 observation code, the repository archive rules in `AGENTS.md` MUST be followed. Superseded v2 observation-index-specific code MUST then be archived/retired rather than left callable from active runtime paths.

Shared code that still owns unrelated active v2 domains, such as timeseries binding, MUST NOT be removed merely because observation indexing moved to v3. Where observation-v2 and unrelated-v2 behaviour currently share one module, implementation MUST separate the observation-specific path cleanly enough to retire it without damaging those unrelated domains. Retired AQI/`aqilevels` code is not an active v2 domain that must be preserved for steady-state operation.

Rollback is operational, not hybrid. A rollback restores the archived/recoverable v2 deployment/configuration and pre-migration canonical history; the active v3 runtime MUST NOT contain a hidden automatic or manual request-time fallback to the v2 observation implementation.

## Logical observation identity remains v2

A physical rewrite MUST preserve the canonical logical observation contract.

At minimum, canonical logical identity continues to include the fields already governed by the active v2 contracts, including:

```text
connector_id
station_id
timeseries_id
pollutant_code
observed_at_utc
value
verification_status
```

The deterministic `observation_content_hash` remains independent of physical representation.

A pure physical rewrite MAY change:

- Parquet bytes and compression output;
- file count and file boundaries;
- row-group and page boundaries;
- deterministic physical row order;
- physical SHA-256/ETag identities;
- derived index objects.

It MUST NOT change:

- canonical row multiplicity;
- logical row values;
- verification status values;
- timestamps;
- canonical pollutant identity;
- logical row count;
- the deterministic observation-content hash.

Unexpected logical row-count or observation-content-hash change MUST fail closed.

## Physical layout identity

Index generation v3 is not the same concept as the existing observation Parquet column-schema/writer identifiers.

The current verification-status schema already uses identifiers including:

```text
history_schema_version = 3
writer_version = parquet-wasm-zstd-v3
```

Those identifiers MUST retain their existing meaning and MUST NOT be silently repurposed to mean the new timeseries-aware bounded packing architecture.

The new physical packing contract MUST therefore carry a separate unambiguous layout identity. The initial target identity is:

```text
physical_layout_version = timeseries-bounded-v1
```

This layout identity describes deterministic timeseries-aware ordering, bounded row groups/files and exact segment metadata. It is independent of:

```text
logical history version = v2
observation Parquet column schema version = 3
existing Parquet writer version = parquet-wasm-zstd-v3
observation-timeseries index generation = v3
```

A later packing-only change MAY advance `physical_layout_version` without implying a new logical history version or observation-timeseries index generation, provided the active reader/index contract explicitly supports that layout.

## Deterministic physical ordering and timeseries contiguity

The shared canonical observation writer MUST impose one deterministic physical order.

Rows MUST be ordered primarily by:

```text
timeseries_id ASC
observed_at_utc ASC
```

Rows equal on those fields MUST use one deterministic canonical tie-break over the remaining canonical row identity so duplicate multiplicity is preserved while physical output remains reproducible.

Rows for one timeseries SHOULD remain contiguous. Observation time within a timeseries MUST remain ordered.

A timeseries MAY continue into a later row group or file when an enforced bound requires it. Such continuation MUST be represented explicitly by multiple ordered exact index segments.

## Bounded row groups and bounded files

Every observation Parquet row group MUST be deliberately bounded.

Every observation Parquet file MUST be deliberately bounded.

The physical writer MUST distinguish and enforce bounded values for the applicable target/max row-group and target/max file limits and for maximum row groups per file.

The numerical tuning values are physical-writer parameters. They MAY change after real TEST measurement without changing the logical v2 observation contract.

Exactly one row group per file is NOT required.

A bounded Parquet file MAY contain one or more bounded row groups. Row groups and exact logical segments are the primary physical query units. Files are R2 packaging, strong-identity and footer-cache units.

Keeping one complete timeseries together MUST NOT justify an unbounded row group or file.

### Accepted Phase 6 writer limits

The accepted Phase 6 limits for `timeseries-bounded-v1` are:

```json
{
  "target_row_group_rows": 8192,
  "max_row_group_rows": 16384,
  "target_file_rows": 65536,
  "max_file_rows": 131072,
  "target_file_bytes": 4194304,
  "max_file_bytes": 8388608,
  "max_row_groups_per_file": 8
}
```

These values were accepted unchanged after the required 2026-08-22 read-only/local calibration against verified real TEST Dropbox observation-history partitions. The calibration covered hourly AURN PM2.5, high-cardinality AURN NO2, high-frequency connector 7 PM2.5/PM10 and an additional threshold-proximity PM2.5 partition. It preserved logical row/hash/status identity in every sample.

Observed real output remained comfortably inside the hard bounds. The largest sampled complete timeseries contained 12,503 rows and remained intact in one row group below the 16,384 hard maximum. Across the sampled high-frequency partitions, current 25-26-file layouts reduced to 10 files while retaining bounded row groups. The largest generated file was 147,762 bytes, far below the 4 MiB target and 8 MiB hard byte limits, so the byte limits behaved as safety rails rather than normal split thresholds.

The exact JSON above is therefore the accepted Phase 6 migration and steady-state writer limit set. The migration plan/checkpoint MUST pin that exact limit set, and the post-cut-over shared steady-state writer MUST use the same accepted values. The operator MUST NOT silently substitute different values at execution time.

A later material writer-limit change remains physical-layout tuning. It MUST preserve all hard bounds and logical/hash invariants, MUST be justified by real TEST evidence, and SHOULD trigger a complete TEST rehearsal before the accepted LIVE runbook is derived from it.

## Physical files are independent of logical index-shard boundaries

Observation-timeseries v3 shard boundaries are logical lookup boundaries only.

Physical Parquet files MUST NOT be required to align with them.

A physical file MAY contain timeseries IDs that fall into more than one v3 shard. Each affected shard MAY reference the same physical file, but each shard MUST:

- list only timeseries IDs belonging to that shard;
- independently pin the exact physical file identity it references;
- contain only exact segments needed for its timeseries IDs.

The initial v3 observation-timeseries shard width is 1,000 timeseries IDs.

That width is an index-schema parameter, not a Parquet packing rule. A future derived-index shard-width migration SHOULD NOT require canonical Parquet repacking solely because the logical shard boundary changed.

## Exact segment metadata

The v3 index MUST answer:

```text
timeseries_id + requested time interval
```

with the exact ordered physical segments required for that interval.

Each exact segment MUST identify at least:

```text
timeseries_id
physical file identity
row_group_ordinal
exact row start
row_count
min_observed_at_utc
max_observed_at_utc
```

Each referenced file MUST carry enough pinned evidence to validate that the segment still refers to the intended bytes, including at least:

```text
key
byte size
strong project-owned physical identity such as SHA-256
writer version
physical schema version
physical_layout_version
```

ETag MAY be carried for conditional/cache use and corroboration. It MUST NOT silently replace the stronger file identity where the active file-identity contract requires SHA-256.

Segment coverage for one indexed timeseries/partition MUST be complete, ordered and non-overlapping and MUST agree with canonical manifest counts and verified Parquet metadata.

Contradictory, missing, overlapping or impossible segment evidence MUST fail closed.

## Writer-produced exact metadata

Normal new canonical writes MUST produce the exact logical metadata needed by v3 while packing. Newly written Parquet MUST NOT need to be reread merely to rediscover exact timeseries membership as the normal path.

The shared writer SHOULD calculate during packing:

- exact per-file timeseries membership;
- per-timeseries row counts per file;
- per-timeseries observation-time bounds;
- exact segment row starts/counts;
- intended row-group membership.

After serialization, the writer MUST inspect and validate the actual Parquet footer before publication.

Footer validation MUST verify the supported schema/writer/layout identity, actual row-group structure and the metadata on which the v3 reader depends. A mismatch between intended packing metadata and serialized output MUST fail before publication.

Every canonical observation Parquet object intended to be readable by the v3 ranged reader MUST be PUT to R2 with the writer-calculated SHA-256 supplied through the supported R2 checksum mechanism. After PUT, the writer/publication path MUST establish through R2 object metadata that the stored object has the expected byte size and stored SHA-256 before any canonical manifest or v3 index object may make that Parquet identity authoritative.

ETag MAY additionally be captured for conditional reads and corroboration, but it MUST NOT replace the stored SHA-256. A missing or mismatching R2-stored SHA-256 makes the Parquet object ineligible for v3 authority. The reader and migration tooling MUST NOT repair that missing evidence by reverting to routine whole-object downloads merely to hash the file again.

## Parquet footer and byte-offset boundary

The UK AQ v3 index MUST NOT store physical Parquet byte offsets as authoritative routing data.

Byte offsets and compressed page/column-chunk lengths SHOULD be discovered from the strongly pinned Parquet footer.

The reader MUST establish that the footer belongs to the physical file identity pinned by the index before trusting those offsets.

For an R2-backed canonical Parquet object, the normal v3 identity gate is the exact indexed byte size plus the R2-stored SHA-256 exposed by object metadata, with ETag only as optional corroboration/conditional-read evidence. Footer and data ranges MUST NOT be read from an object that fails that identity gate.

## V3 ranged-read strategy

The normal v3 observation read path is:

```text
requested timeseries/time interval
    -> deterministic scoped v3 manifest
    -> validate scoped manifest as canonical child-selection authority
    -> select authoritative descriptor for the requested 1,000-ID shard/timeseries
    -> fetch the pinned child shard
    -> verify exact child body byte size and SHA-256 against the scoped descriptor
    -> validate child semantics against the scoped descriptor
    -> select exact segment(s)
    -> establish pinned Parquet identity from R2 object metadata
    -> selected row group(s)
    -> footer/page metadata
    -> required pages where supported
       or projected column chunks for the selected row group
    -> decode required observation columns
```

The scoped v3 manifest is authoritative for child membership on the exact read path. A valid scoped manifest that does not contain the requested shard/timeseries establishes authoritative absence for that scope and the reader MUST NOT probe a stale or orphaned child object at the deterministic child key. If the scoped manifest is missing, if it pins a child that is missing, or if the fetched child body does not match the pinned byte size/SHA-256, the reader MUST return the contractually appropriate incomplete/fail-closed result rather than treating a stray child as authoritative.

The compact latest/global observation-timeseries object remains discovery/operational-summary metadata. It is not an additional per-request authentication parent for a deterministic scoped manifest unless a later contract explicitly changes that authority boundary.

Page-level selection is an optimisation, not a correctness dependency.

If valid page/offset indexes are unavailable for a supported writer/layout version, the reader MAY use the exact required projected column chunks for the selected row group/segment.

The normal v3 reader MUST NOT silently fall back to `_index_v2` or the old broad whole-object observation reader.

Missing v3 coverage, stale file identity, unsupported physical schema/writer/layout version or contradictory scoped/child/segment/footer evidence is a v3 failure or explicit incomplete result according to the active interface contract.

## Required projected observation columns

The normal low-level exact observation-history query SHOULD decode only:

```text
timeseries_id
observed_at_utc
value
```

Other canonical columns remain stored because they are part of canonical history, but normal exact history reads SHOULD NOT decode unrelated columns merely because they share the file.

`timeseries_id` SHOULD remain projected so decoded rows can be validated against the requested physical identity.

## R2 range-read budgets

The v3 observations-history Worker SHOULD use direct R2 binding range reads where supported by the deployment architecture.

Every range GET counts as an R2 read operation.

The reader MUST bound or pre-plan:

- distinct files;
- footer/index reads;
- range GET operations;
- bytes requested;
- selected row groups/pages/chunks;
- decoded rows;
- decompression work;
- response rows.

Adjacent ranges MAY be coalesced under a bounded over-read policy when that reduces operation count without recreating large irrelevant whole-object reads.

Range concurrency MUST be bounded.

Class B operation count is a tuning and observability concern, not a requirement to preserve the old whole-object reader. Real TEST operation is authoritative for tuning the balance between operations, bytes, CPU, decompression and cache behaviour.

## Footer metadata caching

Immutable footer/page metadata MAY be cached by strong physical file identity.

A cache identity MUST prevent metadata from one physical generation being reused for different bytes at the same logical key.

A cache miss MUST remain correct and bounded. A cache hit MUST NOT weaken required identity validation.

## V3 index hierarchy

The v3 hierarchy MUST provide deterministic day/connector/pollutant discovery plus bounded timeseries-ID child shards.

A representative key shape is:

```text
history/_index_v3/observations_timeseries/
  day_utc=YYYY-MM-DD/
    connector_id=<id>/
      pollutant_code=<code>/
        manifest.json
        range=000000-000999.json
        range=001000-001999.json
        ...
```

Implementation MAY refine the exact key shape if the current shared index/finaliser architecture has a cleaner equivalent, provided all of these remain true:

- the child shard is deterministically locatable from `timeseries_id`;
- child objects are bounded;
- physical files may be referenced by multiple child shards;
- unchanged children remain byte-identical;
- parents identify child dependencies deterministically;
- publication is dependency-aware.

A compact v3 latest/global observation-timeseries summary MUST continue the current latest/discovery role.

## Child identity, scoped reconciliation and targeted finalisation

The exact child shard is an independently byte-stable physical-routing object. Its authoritative body identity MUST be derived only from information that describes that child's own exact coverage, including:

- scope and shard-range identity;
- exact timeseries IDs and ordered segment metadata;
- only the physical Parquet file descriptors referenced by those segments;
- supported history-schema, writer and physical-layout identity;
- deterministic coverage derived from the child's own timeseries and segments.

Referenced Parquet identities are content dependencies of the child.

The child body MUST NOT embed the complete canonical scoped observation-manifest identity merely to prove publication order or overall-scope authority. A canonical manifest change caused only by changes outside one child's exact coverage MUST NOT change that unchanged child's body or SHA-256.

The canonical scoped observation manifest is instead an explicit publication-order prerequisite for a changed child. That prerequisite is outside the child body/SHA identity and MUST pin the exact canonical-manifest object identity sufficiently for publication validation, including object key, byte size and SHA-256. Its scope MUST agree with the child scope.

The scoped v3 manifest is the canonical reconciliation point. It MUST:

- pin the authoritative canonical observation manifest for the whole day/connector/pollutant scope;
- pin every child shard in the authoritative scoped child set;
- reconcile complete timeseries coverage and child row totals to the canonical scope;
- reconcile shared physical file identities deterministically where files cross child-shard boundaries;
- fail closed on missing, duplicate, contradictory or incomplete child evidence.

For exact reads, each selected child MUST additionally be authenticated against the scoped descriptor before its routing metadata is trusted: the fetched child body byte size and SHA-256 MUST match the scoped descriptor exactly, and the child's validated semantic descriptor MUST reconcile to that parent descriptor.

`observation_content_hash` remains authoritative evidence from the canonical observation manifest. A v3 index builder or targeted finaliser MUST NOT claim to reconstruct that logical hash from child index metadata when it cannot actually do so.

For normal targeted partial-merge finalisation, unchanged child descriptors MAY be retained while the canonical manifest changes, provided the retained children remain semantically valid and the complete retained-plus-replacement child set reconciles to the new canonical scope. In partial-merge mode, omission from a replacement set MUST NOT imply deletion. Child removal must be an explicit finaliser input and fail closed on contradictory replace/remove instructions.

An active caller contract MAY instead define an authoritative complete-snapshot replacement boundary. In particular, [`prune_daily_complete_snapshot_child_set_contract.md`](prune_daily_complete_snapshot_child_set_contract.md) defines the frozen Prune Daily connector-day source as the complete pollutant child set. In that mode the caller/finaliser MUST derive explicit removals for previously authoritative pollutant scopes absent from the accepted complete snapshot. This is not generic omission-implies-deletion behaviour; it is an explicit complete-snapshot semantic supplied by the owning caller contract.

Similarly, targeted latest/global finalisation MAY retain unchanged scoped-root descriptors and replace only affected scopes. Scope removal MUST be explicit, including removals derived from an accepted complete-snapshot caller mode. Targeted output for an equivalent final state MUST be byte-identical to a complete rebuild of that state.

## Byte stability

V3 index byte stability is load-bearing.

Unchanged canonical source data, unchanged physical file identities and unchanged supported index schema MUST produce byte-identical derived v3 index objects.

At child-shard level the rule is stronger: unchanged exact timeseries/segment coverage and unchanged referenced physical file identities MUST produce the same child body and SHA-256 even when the canonical manifest for the wider scope changes because of changes outside that child.

V3 index payloads MUST NOT churn because of wall-clock-only timestamps, run IDs, unstable map/object iteration or other non-source-derived state.

Put-if-changed behaviour MUST remain the normal write path.

## Publication order

The v3 dependency graph MUST be explicit.

The publication graph distinguishes two relationships:

```text
content dependency
publication-order prerequisite
```

A content dependency contributes to the semantic identity represented by the dependent index object. A publication-order prerequisite is scheduling evidence only and MUST NOT be added to a dependent object's body/SHA merely to enforce ordering.

For changed observation history, the dependency relationship is:

```text
Parquet file(s)
    -> canonical pollutant/connector manifests
    -> changed exact v3 child shard(s)
    -> scoped v3 root/manifest
    -> affected aggregate/day finalisation
    -> v3 latest/global observation-timeseries parent
```

For a changed child, referenced Parquet files are content dependencies and the current canonical scoped observation manifest is a publication-order prerequisite. This preserves canonical-manifest-before-child publication without forcing unrelated unchanged children to churn.

Both relationship types MUST be explicit graph edges. Missing or contradictory content-dependency or publication-prerequisite identity MUST fail closed.

Every changed content dependency or publication-order prerequisite MUST be PUT, post-PUT GET-verified and durably evidenced before a changed dependent object is published. For canonical Parquet in the v3 observation path, that verification MUST include the R2-stored SHA-256 and byte size required by the reader identity gate. An already-existing prerequisite may satisfy an edge only through exact verified durable identity evidence.

Lexical key order MUST NOT substitute for dependency order.

The active global publication-order contract remains applicable and is extended to v3 exact child/root/latest objects by this contract.

## Shared writer ownership

One shared canonical physical observation writer MUST own the v3-target packing semantics.

The same implementation MUST be used by:

- Prune Daily Phase B observation writes after cut-over;
- generic Integrity observation repair;
- dedicated SOS historical complete-partition replacement;
- supported historical migration/backfill paths.

Shared ownership includes:

- canonical normalisation;
- verification-status semantics;
- observation-content hashing;
- deterministic physical ordering;
- timeseries-aware packing;
- row-group/file bounds;
- Parquet writer settings and writer/physical schema/layout versioning;
- footer validation;
- exact segment metadata;
- checksum-aware R2 Parquet publication and stored-SHA/byte-size verification;
- canonical manifests;
- exact v3 index builders/finalisers required by normal writes.

Caller authority remains distinct. Migration and Integrity MUST NOT create Prune Daily deletion-gate eligibility. Prune Daily remains the only owner of prune gates and IngestDB deletion decisions. Caller mode also determines whether child-set semantics are partial merge, connector complete snapshot, or another explicitly contracted replacement boundary.

## Station-history and calculated AQI

The low-level v3 observations-history API remains an exact physical-timeseries reader. Continuity-family orchestration remains in the private station-history Worker.

Station-history calculated AQI remains server-side. The browser MUST NOT calculate AQI from raw observation history as part of this change.

Where calculation requires hidden preceding observation context, including the existing PM context requirement, the same v3 exact observation-history route MUST fetch the visible interval plus the required hidden context interval.

Hidden context MUST remain excluded from the visible observation range.

Calculated AQI is derived from canonical observations when needed. Retained historical R2 AQI/`aqilevels` objects are legacy data only under the retirement contract; they are not current station-history authority, are not refreshed by the v3 observation writer, and are not a prerequisite for v3 read/write acceptance. This change does not introduce a new persisted calculated-AQI cache or browser calculation path.

## Backup boundary

Canonical observation Parquet and canonical manifests remain mandatory Dropbox backup content.

The scoped v3 `observations_timeseries` tree is derived and reconstructable and SHOULD remain excluded from bulk Dropbox backup, matching the current treatment of scoped v2 observation-timeseries indexes.

After accepted v3 cut-over, the compact v3 latest/global observation-timeseries summary SHOULD replace the v2 compact latest summary as the backed-up operational summary.

No v3 implementation may reduce or bypass mandatory observation backup coverage.

## Migration checkpoint and rollback authority boundary

The hard cut-over migration defined by [`observation_history_index_v3_migration_contract.md`](observation_history_index_v3_migration_contract.md) MUST establish one immutable pre-migration operational authority before the first staging action or destructive canonical R2 PUT.

That authority MUST pin the TEST/LIVE environment and bucket, deterministic source inventory and canonical root identity, target writer code identity and writer limits, verified R2 backup inventory-root identity, verified Dropbox checkpoint/state-root identity, manifest-guided rollback object identities and the target schema/writer/layout/index generation.

The R2 inventory root and Dropbox checkpoint root are distinct location/authority classes. The R2 inventory root MUST NOT be required to exist beneath the Dropbox destination and neither identity may substitute for the other.

The initial operational checkpoint MUST be successfully persisted before mutation begins. Later resume, verification and rollback MUST be able to load and validate that pinned authority directly. They MUST NOT require a fresh source plan reconstructed from a canonical R2 tree that may already contain target-layout bytes under old or partially advanced manifest authority.

Migration preparation MUST remain bounded. The complete source inventory and compact deterministic target metadata MAY be retained operationally, but rewritten Parquet bodies SHOULD be prepared/staged a bounded unit at a time and released after their exact R2 identity is verified and checkpointed. Prepared canonical JSON whose exact body is plan/completion authority MUST preserve exact body/size/SHA identity across restart. Completed output is reusable only after current identity is re-established; object-key existence alone is never sufficient, and a later changed completed-object identity is contradictory recovery evidence rather than a replacement authority.

Rollback remains an operational state transition rather than a runtime compatibility path. The rollback tool MAY be entered while the observed observation index configuration is either the pre-cut-over `v2` state or the post-cut-over `v3` state, provided all environment, bucket, writer-freeze and pinned-authority guards pass. The rollback tool MUST NOT itself switch request-time reader generations, change deployment state or change `UK_AQ_R2_HISTORY_INDEX_VERSION`; explicit restoration of the v2 deployment/configuration remains a later step in the formal rollback sequence.

## V3-only active runtime

After the explicit v3 cut-over, the normal observation-history runtime has one authoritative reader/index/writer generation: v3.

The active v3 implementation MUST NOT contain a v2 observation-reader/index compatibility branch, selector or fallback.

V2 observation indexes and previous deployable v2 code MAY remain temporarily as rollback material outside active runtime paths. That retention is operational recovery material only.

Rollback MUST restore the recoverable v2 generation as a separate deployment/configuration state. It MUST NOT be implemented by switching an already-running v3 request path into a v2 compatibility branch.

## Observability

The v3 reader SHOULD expose structured diagnostics sufficient to assess real TEST behaviour, including where practical:

```text
index_generation
index_objects_read
parquet_files_selected
footer_reads
r2_range_reads
r2_bytes_requested
row_groups_selected
pages_or_chunks_selected
rows_decoded
rows_returned
partial_or_fail_closed_reason
```

Cache-hit and origin-read behaviour SHOULD be distinguished where the architecture exposes it.

Diagnostics MUST NOT require decoding extra observation data solely for metrics.

## Validation policy

Before deployment, validation is limited to the smallest structural checks genuinely needed to establish viability, including deterministic packing/index encoding, footer-to-segment agreement, byte-stable v3 index output, correct cross-shard references, bounded local range selection, explicit partial-merge versus complete-snapshot finalisation, and removal of obsolete authoritative v3 scopes for a complete Prune snapshot without mutating `_index_v2` observation authority.

Do not create a broad speculative pre-deployment test suite.

Functional acceptance belongs in real TEST operation after deployment, including representative 7-day, 30-day and 90-day station history, server-calculated AQI requiring hidden context, normal post-cut-over writer operation and Worker/R2 observability.