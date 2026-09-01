# TEST observation-history physical-index candidate

This directory owns the isolated, non-authoritative TEST experiment that maps
a timeseries directly to chronological segments and exact Parquet column-chunk
bytes. It is fixed to the existing aligned-v2 2,048-row fixture and creates no
Parquet objects. It never writes canonical `history/v2` or `history/_index_v3`
keys.

The runtime still HEADs each selected aligned Parquet object and requires the
stored SHA-256, byte size, and R2 ETag before any indexed range is read. It then
decodes only `observed_at_utc` and `value` through Hyparquet's lower-level
column decoder. Page headers and dictionary pages are included in each indexed
column-chunk range; neither a footer nor `timeseries_id` is read at runtime.

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

The fixed index namespace is:

```text
history/_prototype/observation-history/timeseries-aligned-v2/candidate=physical-index-v1/observations_timeseries/
```

The referenced Parquet objects remain under the existing fixed aligned-v2
`cap_rows=2048/observations/` namespace.

## Publish only after review

This is the only publication command. It accepts JSON candidate-index objects
under the exact isolated prefix and rejects Parquet and canonical keys. It is
checksum-aware and skips byte-identical existing objects. Export the established
TEST R2 credentials/configuration first, including `UKAQ_ENV_NAME=TEST`.

```bash
node scripts/index_v3_physical_candidate/publish.mjs \
  --plan tmp/index_v3_physical_candidate/publication-plan.json \
  --confirm-test-prefix history/_prototype/observation-history/timeseries-aligned-v2/candidate=physical-index-v1
```

Do not add `--replace-existing` unless the exact differing prototype objects
have been reviewed.

## Deploy, tail, and compare only after review/push

```bash
gh workflow run uk_aq_observs_history_r2_api_v3_physical_candidate_deploy.yml \
  --ref main

BASE_WORKER_NAME="$(gh variable get UK_AQ_OBSERVS_HISTORY_R2_API_WORKER_NAME)"
ALIGNED_WORKER_NAME="${BASE_WORKER_NAME}-v3-aligned-candidate"
PHYSICAL_WORKER_NAME="${BASE_WORKER_NAME}-v3-physical-candidate"

npx --yes wrangler@4 tail "${ALIGNED_WORKER_NAME}" --format json \
  | tee tmp/index_v3_aligned_candidate_tail.jsonl
```

In a second terminal, tail the physical candidate:

```bash
npx --yes wrangler@4 tail "${PHYSICAL_WORKER_NAME}" --format json \
  | tee tmp/index_v3_physical_candidate_tail.jsonl
```

After the first four direct responses have been checked for identical rows and
complete coverage, run one A/B pass:

```bash
export UK_AQ_V3_ALIGNED_CANDIDATE_URL="https://${ALIGNED_WORKER_NAME}.<test-account-subdomain>.workers.dev"
export UK_AQ_V3_PHYSICAL_CANDIDATE_URL="https://${PHYSICAL_WORKER_NAME}.<test-account-subdomain>.workers.dev"

node scripts/index_v3_physical_candidate/measure.mjs \
  --aligned-endpoint "${UK_AQ_V3_ALIGNED_CANDIDATE_URL}" \
  --physical-endpoint "${UK_AQ_V3_PHYSICAL_CANDIDATE_URL}" \
  --repeat 1
```

Only after that correctness pass should `--repeat` be increased. The runner
compares AURN TS218 24h, normal Sensor.Community TS7421 24h, dense TS7421 1h,
and dense TS7421 24h. The aligned requests always specify row cap 2,048. CPU is
left null for correlation by diagnostic request ID or CF-Ray with Cloudflare
invocation telemetry; client wall time is not reported as Worker CPU. Each
record includes `rows_sha256`, allowing the aligned and physical response rows
for the same case and attempt to be compared exactly without duplicating them
in the measurement artefact.
