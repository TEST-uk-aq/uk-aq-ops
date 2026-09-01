# TEST observation-history physical-index-1024 candidate

## Status: selected physical design

As of 2026-09-01, this TEST-only candidate records the selected physical design
for the next index_v3 implementation:

- physical layout version: `timeseries-aligned-v2`;
- maximum chronological segment / row-group size: **1,024 rows**;
- one timeseries per independently decodable row group;
- dense timeseries split chronologically at the 1,024-row cap;
- many row groups may still share one Parquet object;
- the physical index maps a timeseries to chronological time-range segments;
- each segment carries exact physical ranges for `observed_at_utc` and `value`;
- the runtime does not fetch or parse the Parquet footer;
- the runtime does not decode `timeseries_id`;
- the Parquet object remains strongly identity-pinned before indexed ranges are
  read.

This is still an isolated, non-authoritative TEST prototype. Selecting the
physical design does not make this namespace canonical and does not change
`history/v2` or canonical `history/_index_v3` objects.

## Why 1,024 was selected

The original purpose of index_v3 is to move physical-discovery work out of the
request-time Worker and into offline index generation. The final candidate does
that all the way down to the required Parquet column bytes:

```text
timeseries
  -> UTC-day partition
  -> chronological segment(s) intersecting the requested time range
  -> pinned Parquet object
  -> exact observed_at_utc/value byte ranges
  -> direct column decode
```

The 1,024 and 2,048 physical-index candidates returned identical logical rows in
the deployed TEST comparison. For the representative Sensor.Community cases:

| Workload | Cap | Returned | Physical rows decoded | R2 range reads | R2 bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| normal TS7421 24h | 1,024 | 288 | 288 | 1 | 2,222 |
| normal TS7421 24h | 2,048 | 288 | 288 | 1 | 2,222 |
| dense TS7421 1h | 1,024 | 527 | 1,024 | 1 | 4,840 |
| dense TS7421 1h | 2,048 | 527 | 2,048 | 1 | 9,263 |

Every paired response in the focused correctness run had one shared
`rows_sha256` for the two caps.

The cap decision was then calibrated with two repeated deployed TEST batches,
for 20 CPU observations per workload and cap. Cloudflare invocation CPU was:

| Workload | Cap | Mean CPU | Median CPU | P90 | Max |
| --- | ---: | ---: | ---: | ---: | ---: |
| normal TS7421 24h | 1,024 | 7.3 ms | 6.5 ms | 9 ms | 15 ms |
| normal TS7421 24h | 2,048 | 7.9 ms | 7 ms | 9 ms | 19 ms |
| dense TS7421 1h | 1,024 | 7.65 ms | 7 ms | 11 ms | 16 ms |
| dense TS7421 1h | 2,048 | 10.2 ms | 9 ms | 16 ms | 16 ms |

The dense one-hour workload is the deciding case. It returns 527 observations,
but the 1,024 design halves both the maximum physical rows decoded and the
selected Parquet bytes compared with 2,048. It also reduced the repeated TEST
CPU distribution without materially penalising the normal 24-hour case.

A one-pass dense full-day comparison also favoured 1,024 (73 ms versus 85 ms),
despite using 13 chronological segments rather than 7. Full dense-day reads are
not the reason to make segments smaller, though: they genuinely contain 12,505
returned rows and remain a separate CPU/response-size concern.

The row-group-cap calibration is therefore complete. Do not keep reducing the
segment cap speculatively. Further CPU optimisation should target remaining
fixed request-path work instead.

## Physical-index contract demonstrated by this candidate

This directory owns the isolated, non-authoritative TEST experiment that maps
a timeseries directly to chronological segments and exact Parquet column-chunk
bytes. It is fixed to the existing aligned-v2 1,024-row fixture and creates no
Parquet objects.

The runtime still HEADs each selected aligned Parquet object and requires the
stored SHA-256, byte size and R2 ETag before any indexed range is read. It then
decodes only `observed_at_utc` and `value` through Hyparquet's lower-level
column decoder. Page headers and dictionary pages are included in each indexed
column-chunk range; neither a footer nor `timeseries_id` is read at runtime.

Offline generation is responsible for proving that each indexed row group
contains only the declared timeseries and for recording the chronological time
bounds and physical decode information needed by the Worker.

## Remaining CPU work

With physical amplification and footer/range discovery largely removed, the
next CPU work should investigate the remaining fixed-cost hot path rather than
changing segment size again. Likely areas are:

- physical-index JSON parsing and validation;
- child-index SHA-256 verification;
- per-file HEAD / identity verification;
- response object construction and JSON serialisation.

Any integrity optimisation must preserve the fail-closed physical identity
contract or replace it with an equivalent guarantee. Do not remove checks only
because they consume CPU.

## Generate and validate locally

The aligned fixture must already exist at
`tmp/index_v3_aligned_candidate`. Run with Node 20.20.2:

```bash
node scripts/index_v3_physical_candidate_1024/generate.mjs \
  --environment TEST \
  --aligned-root tmp/index_v3_aligned_candidate \
  --output-root tmp/index_v3_physical_candidate_1024 \
  --replace

node scripts/index_v3_physical_candidate_1024/validate_local.mjs \
  --aligned-root tmp/index_v3_aligned_candidate \
  --candidate-root tmp/index_v3_physical_candidate_1024
```

The fixed index namespace is:

```text
history/_prototype/observation-history/timeseries-aligned-v2/candidate=physical-index-v1/cap_rows=1024/observations_timeseries/
```

The referenced Parquet objects remain under the existing fixed aligned-v2
`cap_rows=1024/observations/` namespace. The existing physical-index-2048
namespace and deployed Worker are retained only as the calibration baseline;
they are not the selected physical design. The shared reader requires either
fixed cap explicitly and rejects cross-cap namespaces.

## Publish only after review

This is the only publication command. It accepts JSON candidate-index objects
under the exact isolated prefix and rejects Parquet and canonical keys. It is
checksum-aware and skips byte-identical existing objects. Export the established
TEST R2 credentials/configuration first, including `UKAQ_ENV_NAME=TEST`.

```bash
node scripts/index_v3_physical_candidate_1024/publish.mjs \
  --plan tmp/index_v3_physical_candidate_1024/publication-plan.json \
  --confirm-test-prefix history/_prototype/observation-history/timeseries-aligned-v2/candidate=physical-index-v1/cap_rows=1024
```

Do not add `--replace-existing` unless the exact differing prototype objects
have been reviewed.

## Deploy, tail and compare

The isolated 1,024 Worker remains useful for continued TEST CPU optimisation:

```bash
gh workflow run uk_aq_observs_history_r2_api_v3_physical_1024_candidate_deploy.yml \
  --ref main

BASE_WORKER_NAME="$(gh variable get UK_AQ_OBSERVS_HISTORY_R2_API_WORKER_NAME)"
PHYSICAL_1024_WORKER_NAME="${BASE_WORKER_NAME}-v3-physical-1024-candidate"
PHYSICAL_2048_WORKER_NAME="${BASE_WORKER_NAME}-v3-physical-candidate"

npx --yes wrangler@4 tail "${PHYSICAL_1024_WORKER_NAME}" --format json \
  | tee tmp/index_v3_physical_1024_candidate_tail.jsonl
```

The measurement runner supports repeatable `--case <name>` filters. With no
`--case`, it retains the complete three-case matrix. For focused cap calibration
or future CPU checks:

```bash
node scripts/index_v3_physical_candidate_1024/measure.mjs \
  --physical-1024-endpoint "${UK_AQ_V3_PHYSICAL_1024_CANDIDATE_URL}" \
  --physical-2048-endpoint "${UK_AQ_V3_PHYSICAL_CANDIDATE_URL}" \
  --case sensorcommunity_normal_ts7421_24h \
  --case sensorcommunity_dense_ts7421_1h \
  --repeat 10
```

CPU is sourced from Cloudflare invocation telemetry, not client wall time. Each
measurement record carries `rows_sha256` so paired results can be checked for
exact logical equivalence.
