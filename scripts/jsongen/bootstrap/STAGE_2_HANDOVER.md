# JSONgen Stage 2 implementation handover

Code only in TEST Ops. No bootstrap, source-service operation, merge, deployment,
publication or LIVE change is part of this delivery. Authoritative system docs
were read from fetched TEST `main`
`0dc4775eeb2ffdddc4a4cb32047071e9b75db09c` and were not edited.

## PR #163 completion-gate correction

The follow-up changes only `generate.mjs` and this handover. All-series success
now explicitly requires `discovery.state === 'complete'` in the overall completion
decision and every manifest completeness declaration, including `aqi_complete`.
Final report handling also clears manual-review eligibility for unestablished
inventory, preventing `COMPLETE.json` and retaining the existing nonzero CLI exit.
Existing invocation-wide fatal failures keep their failed state.

One selection-wide `all_eligible_inventory_not_established` failure records the
discovery state, unresolved discovery scopes and unproved selected/excluded
identities. Finalization is idempotent and adds no duplicate per-identity failures.
It leaves independently completed private candidates and their evidence intact.
Explicit-ID and legacy modes bypass this all-series-only gate. Source admission,
currentness, decoder, AQI and resource handling are unchanged; the existing
same-day generator archive is reused without modification.

Checks: generator syntax, inert import, completion-condition inspection and diff
checks only. The authoritative contracts were re-read at TEST docs `main` for this
correction. No real Dropbox/R2 operation or functional validation was performed;
operator acceptance remains pending. ChatGPT can record the review correction in
the authoritative Stage 2 implementation status after review, without implying
operational acceptance or managed-publication authority.

## Changes and structural feasibility

- `generate.mjs`: boolean `--all-eligible-timeseries`, mutually exclusive with
  explicit IDs; shared month-range processing, one series/month in candidate
  memory, requested-candidate accounting, raw/dependency completeness and metrics.
- New `bulk.mjs`: authenticated discovery, shared day/connector/pollutant decode,
  private partition spools, per-series binding failure containment and cleanup.
- `source.mjs`: reuse canonical membership and v3 pack authentication; validate
  each physical member's own historical station/day bounds without stitching.
- `dropbox-reader.mjs`: separate Parquet transfer/cache counters and source-cache
  participation in the combined temporary-byte budget. Existing transport retries,
  byte/hash checks, configuration and source separation are retained.
- `extract.mjs`: reuse the multi-series decoder with optional decode accounting,
  physical-identity failure callback and null-concentration admission for this
  bootstrap. Persisted status validation covers every decoded row. Existing
  consumers retain their default null-value rejection and failure behaviour.
- `failures.mjs`: exhausted invocation temporary-disk budget is globally fatal.
- Ops, JSONgen and bootstrap READMEs/help document selection, bounds and operation.
  Existing dated archives are unchanged. Newly in-scope source, failure and decoder
  originals are preserved under `archive/2026-11-01/`; existing same-day snapshots
  of generator/reader are reused under the once-per-day rule. Archives never run.

Before implementation, source inspection established that canonical Dropbox
manifests authenticate physical count maps, missing maps can use the existing
multi-series decoder, and the existing reader supplies pinned disk-cache bytes.
The existing candidate writer, shared AQI interface, source stability and bounded
initial/final locked metadata comparison can be reused without another exporter,
new environment settings, schema changes or publication interfaces.

## Discovery and decoding

The opt-in all-series mode requires connector 1 and `--months`; selected pollutants
remain a subset of PM2.5/PM10/NO2. It walks authenticated **Dropbox** reporting-day
hierarchies. Positive `timeseries_row_counts` summing to the canonical row count
provide complete physical membership. Where absent, bounded full-file decoding
establishes membership and retains validated partitions for reuse. Missing source
coverage stays unknown. The union receives candidates in every requested month;
source gaps do not silently remove identities. Selected, unproved and dependency-
only excluded identities carry reasons. Inventory is never truncated to a cap.

Both explicit and all-series month modes share one source-day result. Each
referenced file is authenticated and decoded once, including unselected file
members. Adjacent month PM/terminal consumers and discovery fallback reuse the
decoded partitions. File digest/size/schema/count errors invalidate the shared
day's dependent products. Binding/station/date-validity errors affect the physical
series concerned. Missing metadata inventory remains a reported incomplete scope.

## Bounds and incomplete batches

One file's retained rows are buffered before flushing private series/day JSONL
partitions. Each series/month is loaded separately, with spool SHA-256/size/count
checks, before calling the existing private gzip writer. Retention covers `[S,E)`,
preceding 23-hour PM inputs and exact `E` only. Spools are removed after their last
consumer, retaining boundary days for the next month. Original authenticated
source-cache bytes remain until final revalidation. Controlled exits remove work.

The existing file-row/object/source/decoded/selected/output/series/time limits stay
finite. CLI-only `--max-temp-mib` (2048 default; 32768 maximum) bounds combined
source-cache and spool payload bytes; filesystem overhead needs additional free
space. Legacy modes retain their original source-byte cache cap unless the new
flag is explicitly supplied. No persistent configuration names or credentials were added. Per-candidate
selected-row overflow is incomplete for that candidate; global budget exhaustion
stops work. Known pending series/months and unproved inventory scopes are reported.
The unchanged default 256-series cap may be too small for all AURN: an operator
must explicitly review larger caps or request smaller ID/month batches.

Fresh follow-on invocations require reviewed checkpoint/root pins, original source
and both currentness comparisons. There is no resume, automatic checkpoint change
or complete cross-batch snapshot claim. A failure before final proof retains staged
products as diagnostics; it cannot assert newly completed candidates. Independently
final-proved results survive later incomplete scopes where safely established.

## Preserved evidence and science

The existing initial/final shared locks compare bounded canonical R2 metadata
only. Dropbox reads, source/cache hashing, decoding and spooling stay outside the
locks. R2 Parquet and observation indexes are never discovery or observation
sources. No source fallback exists. Original checkpoint identity, canonical
ancestry, binding/verification packs, scoped currentness, source stability,
candidate descriptors, SHA-256/gzip evidence and private manifest/report remain.

Raw timestamps, values (including negative/null concentrations), multiplicity and
P/R/null/provider-status provenance are retained. Null concentrations supply no AQI
sample. DAQI/EAQI calculation code is unchanged. Endpoints remain `S < n <= E`.
An unknown source day is never labelled a natural missing measurement. PM and
terminal failures cannot turn independently proved raw data into invalid raw
data; they block the derived pair. Conservative completed-following-day terminal
admission and automatic current-month cutoff are unchanged.

Any incomplete requested candidate/inventory scope yields nonzero/incomplete and
prevents global `COMPLETE.json`. Complete private pairs remain unselected and
`managed_publication_eligible=false`; independent current Core/verification-
transition authority, all-writer freshness and managed baselines remain unresolved.

## Structural checks and operational acceptance

Development checks are limited to changed-module syntax, inert imports, CLI help
and option interfaces, whitespace/diff review, and archive identity checks. No new
functional suite, fixtures, source fetches, lock operations or benchmarks were run.

After separate authorisation, real TEST operations on the MacBook Pro must verify:

1. Complete all-series membership and fallback discovery against the chosen backup;
   explicit selection compatibility, full/partial-month admission and rollover.
2. Representative original rows/status/multiplicity/binding validity and independently
   calculated AQI, PM boundaries and closing-midnight inputs, including null/gap cases.
3. Shared-file, physical-binding, raw-month, PM and terminal failure containment;
   exact incomplete scopes, nonzero/no completion marker and fresh smaller batches.
4. Actual decode passes, transfers/cache/spool reuse, rows, resource bounds, memory,
   disk and month/pollutant timing. Counter structure alone proves no speed claim.
5. Initial/final scoped proofs and original-source stability; every product,
   descriptor, manifest/report digest and completion marker where eligible.

No contract conflict was identified for private reconstruction. Remaining limits
are the conservative terminal policy, finite operator-reviewed caps, unknown
membership where source authentication fails, unmeasured real performance and
the existing independent managed-authority gates. No apply/deploy command is
required. Rollback is to stop invoking the new mode or revert the PR; private
diagnostic data remains unselected.

ChatGPT documentation handover: update only implementation status in the routed
month-range/initial-bootstrap contracts and Station Charts README after review.
Describe the all-series flag, metadata/fallback inventory, shared spools, physical
validity/failure isolation and metrics. Record operational acceptance only after
separately authorised evidence; retain all currentness, terminal and managed gates.
