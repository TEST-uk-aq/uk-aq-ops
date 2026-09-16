# TEST observation-history leaf fan-out candidate

This isolated coordinator measures one narrow question: whether the existing
TEST physical-leaf candidate can serve a seven-day TS7421 request as seven
concurrent one-UTC-day Service Binding invocations while both the leaf and
coordinator invocations remain inside the Cloudflare Free CPU budget.

The coordinator is named from the existing observations Worker base name:

```text
<base>-v3-leaf-fanout-candidate
```

It has `workers_dev=true`, `preview_urls=false`, no R2 binding and one fixed
`PHYSICAL_LEAF` Service Binding to `<base>-v3-leaf-candidate`. It reuses the
existing `UK_AQ_EDGE_UPSTREAM_SECRET` for caller and child authentication.

## Local structural validation

```bash
node --check workers/uk_aq_observs_history_r2_api_v3_leaf_fanout_candidate/worker.mjs
node --check scripts/index_v3_leaf_fanout_candidate/validate_local.mjs
node --check scripts/index_v3_leaf_fanout_candidate/measure.mjs
node scripts/index_v3_leaf_fanout_candidate/validate_local.mjs
node scripts/index_v3_leaf_fanout_candidate/measure.mjs --dry-run
git diff --check
```

The local validator uses a Service Binding-compatible mock, asserts the exact
2026-08-20 through 2026-08-27 UTC partition, observes seven concurrent child
calls, and requires byte-for-byte row-array JSON plus SHA-256 equality with a
mocked direct leaf response.

## Deploy only after review and push

```bash
gh workflow run uk_aq_observs_history_r2_api_v3_leaf_fanout_candidate_deploy.yml \
  --ref main
```

The separate workflow derives both Worker names from
`UK_AQ_OBSERVS_HISTORY_R2_API_WORKER_NAME`, fixes the Service Binding to the
existing physical-leaf candidate, installs only the existing upstream-auth
secret and deploys no route or storage binding.

## Tail both Workers

```bash
BASE_WORKER_NAME="$(gh variable get UK_AQ_OBSERVS_HISTORY_R2_API_WORKER_NAME)"
PHYSICAL_LEAF_WORKER_NAME="${BASE_WORKER_NAME}-v3-leaf-candidate"
LEAF_FANOUT_WORKER_NAME="${BASE_WORKER_NAME}-v3-leaf-fanout-candidate"

npx --yes wrangler@4 tail "${PHYSICAL_LEAF_WORKER_NAME}" --format json \
  | tee tmp/index_v3_physical_leaf_candidate_tail.jsonl
```

In a second terminal:

```bash
npx --yes wrangler@4 tail "${LEAF_FANOUT_WORKER_NAME}" --format json \
  | tee tmp/index_v3_leaf_fanout_candidate_tail.jsonl
```

CPU comes only from Cloudflare invocation telemetry. The coordinator and leaf
payloads intentionally report `cpu_time_ms: null` and expose diagnostic request
IDs and CF-Ray values for correlation.

## Measure direct seven-day versus fan-out seven-day

```bash
export UK_AQ_V3_PHYSICAL_LEAF_CANDIDATE_URL="https://${PHYSICAL_LEAF_WORKER_NAME}.<test-account-subdomain>.workers.dev"
export UK_AQ_V3_LEAF_FANOUT_CANDIDATE_URL="https://${LEAF_FANOUT_WORKER_NAME}.<test-account-subdomain>.workers.dev"
export UK_AQ_EDGE_UPSTREAM_SECRET='<existing TEST upstream secret>'

node scripts/index_v3_leaf_fanout_candidate/measure.mjs \
  --direct-leaf-endpoint "${UK_AQ_V3_PHYSICAL_LEAF_CANDIDATE_URL}" \
  --fanout-endpoint "${UK_AQ_V3_LEAF_FANOUT_CANDIDATE_URL}"
```

The default run contains only the seven-day comparison. Add the single 24-hour
control when useful:

```bash
node scripts/index_v3_leaf_fanout_candidate/measure.mjs \
  --direct-leaf-endpoint "${UK_AQ_V3_PHYSICAL_LEAF_CANDIDATE_URL}" \
  --fanout-endpoint "${UK_AQ_V3_LEAF_FANOUT_CANDIDATE_URL}" \
  --include-24h-control
```

The runner fails unless both seven-day responses are complete, their exact row
array JSON is identical, their calculated `rows_sha256` values are identical,
and the coordinator-reported final hash matches the returned fan-out rows.
