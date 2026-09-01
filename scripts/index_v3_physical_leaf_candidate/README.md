# TEST observation-history exact physical-leaf candidate

This isolated TEST candidate exercises the selected index_v3 physical leaf
mechanism without changing canonical station-history or observation-history.
Its logical history contract remains v2. Its fixed physical design is:

- `timeseries-aligned-v2`;
- one timeseries per row group;
- an aligned row cap of 1,024;
- exact-timeseries physical leaf indexes;
- exact `observed_at_utc` and `value` byte ranges;
- no runtime Parquet-footer fetch or parse; and
- no runtime `timeseries_id` decode.

The prototype namespace remains:

```text
history/_prototype/observation-history/timeseries-aligned-v2/candidate=physical-leaf-index-v1/cap_rows=1024/
```

The production-intended shared read implementation is
`workers/shared/uk_aq_observation_history_exact_leaf_reader_v3.mjs`. The
deployed `-v3-leaf-candidate` Worker is only a TEST wrapper around that shared
implementation; it does not carry a second reader implementation.

## Physical paging contract

A low-level logical request must be non-empty and at most 24 hours. It may
cross UTC midnight, so a page may validate indexes from two UTC-day
partitions, but one Worker invocation opens and decodes at most one complete
physical segment and at most 1,024 physical rows.

When more intersecting segments remain, the response includes:

```json
{
  "response_complete": false,
  "has_gap": false,
  "partial_reasons": ["physical_pagination_incomplete"],
  "physical_page": {
    "pagination_complete": false,
    "next_cursor": "<opaque base64url cursor>"
  }
}
```

`has_gap` is reserved for genuine coverage loss. A final page is complete only
when physical pagination and index coverage are both complete. The opaque
cursor is bound to the logical request, index/layout/writer identity, and the
next manifest/leaf/file/row-group physical coordinates. Malformed,
cross-request, stale-index, or stale-coordinate cursors fail closed.

`since_utc` and `limit` are rejected by this low-level endpoint. They do not
compete with `physical_cursor`; higher-level range and limiting semantics must
be applied by a later station-history page walker.

The reader verifies the manifest-pinned leaf byte size and SHA-256 and the
pinned aligned Parquet SHA-256, byte size, and ETag before range reads. It
never reads R2 outside the wrapper-provided candidate prefixes.

## Generate and validate locally

Use Node 20.20.2 with the existing aligned, physical-1024, and leaf fixtures:

```bash
node scripts/index_v3_physical_leaf_candidate/generate.mjs \
  --environment TEST \
  --aligned-root tmp/index_v3_aligned_candidate \
  --output-root tmp/index_v3_physical_leaf_candidate \
  --replace

npx --yes node@20.20.2 \
  scripts/index_v3_physical_leaf_candidate/validate_local.mjs \
  --aligned-root tmp/index_v3_aligned_candidate \
  --physical-root tmp/index_v3_physical_candidate_1024 \
  --leaf-root tmp/index_v3_physical_leaf_candidate

npx --yes node@20.20.2 \
  scripts/index_v3_physical_leaf_candidate/measure.mjs --dry-run

git diff --check
```

The focused validator page-walks normal TS7421 24h, dense TS7421 1h, and
dense TS7421 24h. It expects the existing fixture evidence of 1, 1, and 13
pages respectively, proves no invocation decodes a second segment, and
compares the assembled rows and SHA-256 with the existing physical-index-1024
reader. The page counts are fixture assertions, not runtime configuration.
It also proves cursor replay/staleness rejection, a missing required leaf as a
genuine gap, the 24-hour boundary, and the explicit `since_utc`/`limit`
rejections.

## Prototype publication (only after separate authorization)

The existing checksum-aware publisher accepts JSON only under the exact
isolated leaf prefix and rejects canonical and Parquet keys:

```bash
node scripts/index_v3_physical_leaf_candidate/publish.mjs \
  --plan tmp/index_v3_physical_leaf_candidate/publication-plan.json \
  --confirm-test-prefix history/_prototype/observation-history/timeseries-aligned-v2/candidate=physical-leaf-index-v1/cap_rows=1024
```

Do not run this as part of code review. No R2 publication is required for the
shared-reader change when the existing TEST fixture is already deployed.

## Deploy and tail on TEST only after explicit review

The separate Worker keeps `workers_dev=true`, `preview_urls=false`, and the
short `-v3-leaf-candidate` suffix:

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

## Focused post-deployment measurement

```bash
export UK_AQ_V3_PHYSICAL_1024_CANDIDATE_URL="https://${PHYSICAL_1024_WORKER_NAME}.<test-account-subdomain>.workers.dev"
export UK_AQ_V3_PHYSICAL_LEAF_CANDIDATE_URL="https://${PHYSICAL_LEAF_WORKER_NAME}.<test-account-subdomain>.workers.dev"

npx --yes node@20.20.2 \
  scripts/index_v3_physical_leaf_candidate/measure.mjs \
  --physical-1024-endpoint "${UK_AQ_V3_PHYSICAL_1024_CANDIDATE_URL}" \
  --physical-leaf-endpoint "${UK_AQ_V3_PHYSICAL_LEAF_CANDIDATE_URL}" \
  --repeat 1
```

The measurement client follows `physical_page.next_cursor` to completion,
records every page's diagnostic request ID and CF-Ray, and fails if assembled
rows differ from the physical-1024 response. It never reports client wall time
as Worker CPU. CPU evidence must be correlated per invocation from Cloudflare
tail or Workers Analytics telemetry. There is no CPU-reactive adaptive limiter;
telemetry can only support a later manual reconsideration of the fixed cap.

## Canonical integration handover

The active system contract still describes the earlier
`timeseries-bounded-v1`/footer-derived reader. Before station-history adopts
this shared mechanism, Chat-mode documentation work must reconcile the active
contract with `timeseries-aligned-v2`, exact stored ranges, physical paging,
and the higher-level cursor walk. Arbitrary user date ranges will later be
composed from these bounded reads by station-history/chart orchestration. This
experiment does not edit that contract or switch either canonical Worker.
