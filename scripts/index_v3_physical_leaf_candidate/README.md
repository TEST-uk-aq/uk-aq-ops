# TEST observation-history physical-leaf candidate

This directory owns the isolated, non-authoritative TEST experiment that
replaces the physical-index-v1 1,000-ID child read with one exact-timeseries
leaf. It is fixed to the existing timeseries-aligned-v2 1,024-row fixture,
creates no Parquet objects, and never writes canonical `history/v2` or
`history/_index_v3` keys.

The fixed prototype namespace is:

```text
history/_prototype/observation-history/timeseries-aligned-v2/candidate=physical-leaf-index-v1/cap_rows=1024/
```

Each day/connector/pollutant manifest contains the common decoder profile and
a compact `leaves_by_timeseries_id` lookup. Its tuple field order is pinned by
`leaf_descriptor_fields: ["key", "byte_size", "sha256"]`. Exact leaf keys use:

```text
.../timeseries_id=000007421.json
```

A leaf contains exactly one timeseries, only its aligned Parquet file
identities, and only its chronological segments and exact
`observed_at_utc`/`value` column ranges. Runtime verifies the manifest-pinned
leaf byte size and SHA-256. It also continues to HEAD each selected aligned
Parquet object and require stored SHA-256, byte size, and ETag before range
reads. Neither a Parquet footer nor `timeseries_id` is decoded at runtime.

## Generate and validate locally

Use Node 20.20.2 with the existing aligned and physical-1024 fixtures:

```bash
node scripts/index_v3_physical_leaf_candidate/generate.mjs \
  --environment TEST \
  --aligned-root tmp/index_v3_aligned_candidate \
  --output-root tmp/index_v3_physical_leaf_candidate \
  --replace

node scripts/index_v3_physical_leaf_candidate/validate_local.mjs \
  --aligned-root tmp/index_v3_aligned_candidate \
  --physical-root tmp/index_v3_physical_candidate_1024 \
  --leaf-root tmp/index_v3_physical_leaf_candidate

node scripts/index_v3_physical_leaf_candidate/measure.mjs --dry-run
git diff --check
```

The validator proves that the plan contains JSON only, every leaf contains one
timeseries, every segment/file is cap=1024 aligned data, every manifest tuple
matches the exact generated leaf bytes, and both focused TS7421 cases decode to
the same rows and hash as the current physical-index-1024 reader.

## Publish only after explicit review

The publisher is checksum-aware, accepts only JSON under the exact isolated
leaf prefix, publishes leaves before scoped manifests, and rejects canonical or
Parquet keys. Export the established TEST R2 configuration first.

```bash
node scripts/index_v3_physical_leaf_candidate/publish.mjs \
  --plan tmp/index_v3_physical_leaf_candidate/publication-plan.json \
  --confirm-test-prefix history/_prototype/observation-history/timeseries-aligned-v2/candidate=physical-leaf-index-v1/cap_rows=1024
```

Do not add `--replace-existing` unless the exact differing prototype objects
have been reviewed.

## Deploy and tail only after explicit review and push

The separate Worker uses the short `-v3-leaf-candidate` suffix,
`workers_dev=true`, and `preview_urls=false`.

```bash
gh workflow run uk_aq_observs_history_r2_api_v3_leaf_candidate_deploy.yml \
  --ref main

BASE_WORKER_NAME="$(gh variable get UK_AQ_OBSERVS_HISTORY_R2_API_WORKER_NAME)"
PHYSICAL_1024_WORKER_NAME="${BASE_WORKER_NAME}-v3-physical-1024-candidate"
PHYSICAL_LEAF_WORKER_NAME="${BASE_WORKER_NAME}-v3-leaf-candidate"

npx --yes wrangler@4 tail "${PHYSICAL_1024_WORKER_NAME}" --format json \
  | tee tmp/index_v3_physical_1024_candidate_tail.jsonl
```

In a second terminal:

```bash
npx --yes wrangler@4 tail "${PHYSICAL_LEAF_WORKER_NAME}" --format json \
  | tee tmp/index_v3_physical_leaf_candidate_tail.jsonl
```

## Run the focused A/B only after deployment

```bash
export UK_AQ_V3_PHYSICAL_1024_CANDIDATE_URL="https://${PHYSICAL_1024_WORKER_NAME}.<test-account-subdomain>.workers.dev"
export UK_AQ_V3_PHYSICAL_LEAF_CANDIDATE_URL="https://${PHYSICAL_LEAF_WORKER_NAME}.<test-account-subdomain>.workers.dev"

node scripts/index_v3_physical_leaf_candidate/measure.mjs \
  --physical-1024-endpoint "${UK_AQ_V3_PHYSICAL_1024_CANDIDATE_URL}" \
  --physical-leaf-endpoint "${UK_AQ_V3_PHYSICAL_LEAF_CANDIDATE_URL}" \
  --repeat 1
```

The runner contains only normal TS7421 24h and dense TS7421 1h. `--case <name>`
is repeatable and accepts only those matrix names. Successful pairs must have
the same `rows_sha256`; a mismatch fails the run. CPU stays null for
correlation by diagnostic request ID or CF-Ray with Cloudflare invocation
telemetry. Client wall time is recorded separately and is not Worker CPU.
