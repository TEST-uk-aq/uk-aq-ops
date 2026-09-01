# TEST observation-history physical-index candidate

## Status: retained 2,048-row calibration baseline

This directory contains the isolated, non-authoritative TEST physical-index
candidate over the existing aligned-v2 **2,048-row** fixture.

It proved the key index_v3 serving idea: a timeseries can map directly to
chronological segments and exact Parquet column bytes, allowing the Worker to
skip footer discovery and avoid decoding `timeseries_id` at request time.

The 2,048-row cap is **not the selected physical design**. Deployed TEST
calibration completed on 2026-09-01 and selected **1,024 rows** as the maximum
chronological segment / row-group size. Keep this 2,048 candidate available as a
comparison baseline while the remaining CPU hot path is optimised.

The selected candidate is documented in:

```text
scripts/index_v3_physical_candidate_1024/README.md
```

Nothing in this baseline namespace is canonical. It never writes canonical
`history/v2` or `history/_index_v3` keys.

## What this candidate proved

The runtime still HEADs each selected aligned Parquet object and requires the
stored SHA-256, byte size and R2 ETag before any indexed range is read. It then
decodes only `observed_at_utc` and `value` through Hyparquet's lower-level
column decoder. Page headers and dictionary pages are included in each indexed
column-chunk range; neither a footer nor `timeseries_id` is read at runtime.

The resulting serving path is:

```text
timeseries
  -> chronological segment(s)
  -> pinned Parquet object
  -> exact observed_at_utc/value ranges
  -> direct column decode
```

That physical-index design is retained in the selected 1,024-row candidate.
Only the segment cap changed.

## 1,024 versus 2,048 decision

For the representative dense Sensor.Community one-hour request, both physical
candidates returned the same 527 logical rows and the same `rows_sha256`, but:

| Cap | Physical rows decoded | R2 bytes |
| ---: | ---: | ---: |
| 1,024 | 1,024 | 4,840 |
| 2,048 | 2,048 | 9,263 |

Two repeated deployed TEST calibration batches produced 20 CPU observations per
workload and cap:

| Workload | Cap | Mean CPU | Median CPU | P90 | Max |
| --- | ---: | ---: | ---: | ---: | ---: |
| normal TS7421 24h | 1,024 | 7.3 ms | 6.5 ms | 9 ms | 15 ms |
| normal TS7421 24h | 2,048 | 7.9 ms | 7 ms | 9 ms | 19 ms |
| dense TS7421 1h | 1,024 | 7.65 ms | 7 ms | 11 ms | 16 ms |
| dense TS7421 1h | 2,048 | 10.2 ms | 9 ms | 16 ms | 16 ms |

The 1,024 cap reduced the dense short-read CPU distribution without a material
penalty to the normal 24-hour case, so row-cap calibration is complete. Do not
promote 2,048 merely because it has fewer row groups for very dense full-day
reads.

## Generate and validate locally

The aligned fixture must already exist at
`tmp/index_v3_aligned_candidate`. Run with Node 20.20.2:

```bash
node scripts/index_v3_physical_candidate/generate.mjs \
  --environment TEST \
  --aligned-root tmp/index_v3_aligned_candidate \
  --output-root tmp/index_v3_physical_candidate \
  --replace

node scripts/index_v3_physical_candidate/validate_local.mjs \
  --aligned-root tmp/index_v3_aligned_candidate \
  --candidate-root tmp/index_v3_physical_candidate
```

The fixed baseline index namespace is:

```text
history/_prototype/observation-history/timeseries-aligned-v2/candidate=physical-index-v1/observations_timeseries/
```

The referenced Parquet objects remain under the fixed aligned-v2
`cap_rows=2048/observations/` namespace.

## Publish only after review

This command accepts JSON candidate-index objects under the exact isolated
prefix and rejects Parquet and canonical keys. It is checksum-aware and skips
byte-identical existing objects. Export the established TEST R2
credentials/configuration first, including `UKAQ_ENV_NAME=TEST`.

```bash
node scripts/index_v3_physical_candidate/publish.mjs \
  --plan tmp/index_v3_physical_candidate/publication-plan.json \
  --confirm-test-prefix history/_prototype/observation-history/timeseries-aligned-v2/candidate=physical-index-v1
```

Do not add `--replace-existing` unless the exact differing prototype objects
have been reviewed.

## Deploy and measure baseline only when needed

```bash
gh workflow run uk_aq_observs_history_r2_api_v3_physical_candidate_deploy.yml \
  --ref main

BASE_WORKER_NAME="$(gh variable get UK_AQ_OBSERVS_HISTORY_R2_API_WORKER_NAME)"
PHYSICAL_WORKER_NAME="${BASE_WORKER_NAME}-v3-physical-candidate"

npx --yes wrangler@4 tail "${PHYSICAL_WORKER_NAME}" --format json \
  | tee tmp/index_v3_physical_candidate_tail.jsonl
```

Use Cloudflare invocation telemetry for CPU. Client wall time is not Worker CPU.
The baseline should now be used only where comparison with the selected 1,024
physical design materially helps a subsequent optimisation decision.
