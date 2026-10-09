# Stage 2A findings — 09/10/2026

The bounded offline exporter works against actual TEST v3 and the available
retained v2 scope. Both generations can support monthly-format gzip JSON, but
retained v2 cannot support an equivalent **September month** comparison for
this sample. A complete one-day overlap is equivalent; the missing remainder
is preserved as unknown, not filled from v3 or labelled canonical absence.

Implementation and usage are in [README.md](README.md); the proposed payload
shape is [month.schema.json](month.schema.json). Only the new
`scripts/compressed_chart_history/` directory belongs to this implementation.

## Source identities

Bucket: `uk-aq-history-cic-test`; environment: TEST. The selected physical
hourly AURN series is connector `1`, timeseries `212`, station `248`, PM2.5
(`pm25`), binding phenomenon `2` / observed property `9`. No continuity members
were merged, and no WAQN/SAQN observations were read or generated.

| Generation | Canonical observation root | Authoritative index root |
|---|---|---|
| v3 | `history/v3/observations` | `history/_index_v3/observations_timeseries` |
| v2 | `history/v2/observations` | `history/_index_v2/observations_timeseries` |

Each generation used its own
`history/_index_<generation>/timeseries_binding/timeseries_id=212.json`.
Day/pollutant scope: `day_utc=2026-09-01/connector_id=1/pollutant_code=pm25`.
V3 additionally selected `timeseries_id=000000212.json` through the scoped
exact-leaf manifest. The selected canonical file in both generations on that
day was `part-00000.parquet`, with independent identities:

- V3: 101,934 bytes;
  SHA-256 `005e38d7fff7c71b31c8b2ff02064228b49e050f91e27b3c8cd64808e145a2b3`.
- V2: 7,370 bytes;
  SHA-256 `1052c2e30712952da32957435058ae74ea8a6d36a0d80dde63e3586517f8907b`.

Both sampled generations use physical schema `3`, writer
`parquet-wasm-zstd-v3`. Generation labels are independent of the retained
logical `history_version: v2` and physical schema version. The selected current
v3 verification discovery had no activated connector entries; embedded/effective
status was null in this sample, retained losslessly by both adapters.

All consumed source objects, index/manifest digests, binding and applicable
verification identity are in each local digest-named source-evidence file.
Metadata revalidation detected no source changes during each successful run;
this is not a simultaneous source freeze.

## Real measured results

Month interval: `[2026-09-01T00:00:00Z, 2026-10-01T00:00:00Z)`.
Overlap interval: `[2026-09-01T00:00:00Z, 2026-09-02T00:00:00Z)`.
Sizes below are exact bytes. Timings are individual local extraction runs,
including source reads and metadata revalidation, not statistical benchmarks.

| Scope / generation | State | Rows | JSON | gzip | Consumed source bytes | Parquet bytes | Source objects / Parquet | GETs | Extraction wall s | Local extraction CPU ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| September / v3 | complete | 664 | 35,822 | 4,223 | 5,233,889 | 2,078,683 | 122 / 30 | 214 | 25.890 | 1,711.818 |
| September / v2 | incomplete | 24 | 4,930 | 952 | 33,202 | 7,370 | 4 / 1 | 181 | 23.910 | 2,290.394 |
| 1 September / v3 | complete | 24 | 2,805 | 903 | 199,250 | 101,934 | 6 / 1 | 11 | 1.821 | 407.599 |
| 1 September / v2 | complete | 24 | 2,665 | 828 | 33,202 | 7,370 | 4 / 1 | 7 | 0.916 | 51.520 |

The September two-source run took 49.835 seconds overall. The complete overlap
run took 2.764 seconds overall. Encoding and local writes took 12.043/8.966 ms
for month v3/v2 and 8.075/5.359 ms for overlap v3/v2. Reports contain read/decode
wall time, encoding CPU, runtime versions and all other counters. Node was
`v25.8.1`, zlib `1.2.12`, gzip level 9. R2 writes were **zero** throughout.

On the overlapping day, row multisets matched exactly for timestamp/value/
station, embedded status, effective status and full observation tuples. The
generation-specific provenance produces different payload sizes/digests despite
equivalent observations. V3 decoded 24 rows; v2 decoded 1,764 to select the same
24. V3's exact layout improves decoding precision, while its full-file download
is larger here. This pilot deliberately does not implement ranged Parquet reads.

September v3 resolved all 30 daily authorities and retained 664 source rows,
including genuine source gaps relative to a nominal 720-hour month. V2's
index, canonical pollutant manifest and connector manifest were unavailable
for 2–30 September: 174 404s across discovery and revalidation. The v2 monthly
file contains only the 24 available rows and explicitly states `incomplete` /
`publication_eligible: false`. Nothing establishes whether the missing v2 days
were never retained or later removed, or whether other v2 dates are usable.
There was no broad inventory scan or attempted source repair.

The v3 selected timestamp/value column ranges total 440 bytes for the day and
12,501 bytes for the month. These are **indexed selected-column bytes**, excluding
identity/status columns, footer and shared metadata. Full Parquet files contain
other AURN series. Therefore 101,934/7,370 bytes are read-volume figures, not
an exact per-series storage comparison. V2 exact column attribution is unavailable
in this implementation; no row-proportional estimate is substituted.

## Derived storage overhead and local artifacts

Chart gzip is only part of proposed publication storage. The complete overlap
has 2,141-byte v3 evidence, 1,531-byte v2 evidence and a 3,699-byte candidate
manifest: **9,102 bytes** for two gzip objects + two evidence objects + manifest.
The separately exported complete v3 month has 31,975-byte evidence and a
3,845-byte manifest: **40,043 bytes** for one gzip object + evidence + manifest.
Raw diagnostic JSON and comparison reports are additional local-only files.
Evidence overhead is substantial at this tiny sample scale and should be
accounted for independently of browser transfer.

Local output root: `/Users/mikehinford/uk-aq-work/compressed-chart-history/`.

- `stage2a-final-september/comparison.md` and `comparison.json`: final two-source
  month measurement, explicitly non-comparable because v2 is incomplete.
- `stage2a-final-overlap/comparison.md` and `comparison.json`: complete, equivalent
  v2/v3 one-day sample.
- `stage2a-v3-complete-month/comparison.md` and `comparison.json`: complete
  standalone v3 candidate (20.113-second extraction in that earlier run).

Each directory contains the gzip/raw JSON, digest-named evidence and proposed
manifest. The repeated actual September exports had identical candidate
manifest digest
`9eb0d522c69f8ed70d8ac659acd36f9ac9feb5ae1a820c77bd4111d0a25acda1`.
Local byte sizes/digests, evidence references, gzip round-trips, repeat gzip
encoding and requested observation intervals were checked against these real
outputs. Syntax/import/help checks and schema JSON parsing passed before
functional extraction. No speculative fixtures or test suite were added.

## Stage 2B recommendation and limits

Use the complete v3 month and the equivalent one-day v2/v3 overlap as the first
approved samples. Keep the incomplete v2 month diagnostic only. Before a 90-day
viewer comparison, select and export a complete approved range with the context
hours required by the existing AQI contract; v2 equivalence must be measured for
that actual scope. No access to unpublished Cardiff WAQN data is implied.

Implement only the planned isolated private TEST publication/delivery and
viewer seam. Verify immutable gzip/evidence objects, then publish a complete
manifest last; retain the previous complete selection on failure. Inject the
alternate history source through the existing shared chart controller,
normalisation/continuity/AQI and renderer, retaining the ordinary TEST control.
Use actual deployed TEST cold/warm requests and existing diagnostics for
transfer/parse, first useful line, current head, complete coverage, AQI/render,
R2 reads and Cloudflare CPU/outcomes. Workers Free feasibility, delivery speed,
browser rendering and cache freshness remain unmeasured in Stage 2A.

The current pilot is limited to AURN and canonical manifests carrying sufficient
schema/authority identity. Legacy/activated-overlay and absence cases are guarded
structurally but were not exercised by the sampled schema-3, nonactivated data.
Mixed indistinguishable schema-2/schema-4 files fail closed. More networks,
general legacy adaptation, ranged source downloads and automatic regeneration
are outside this implementation.

No deploy/apply commands are required. No canonical, Integrity, Prune, backup,
chart, Cloudflare or LIVE changes were made by this task. All six new files are
unstaged/uncommitted; unrelated concurrent working-tree changes were left alone.
No existing source was replaced, so no pre-change archive copy was required.
Rollback consists of ceasing use and removing the exporter/local artifacts.
Authoritative documentation remains read-only; a later documentation handover
can record these offline files, sample evidence and pending Stage 2B decisions.
