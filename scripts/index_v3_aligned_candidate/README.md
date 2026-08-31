# TEST observation-history aligned-v2 candidate

This directory owns the isolated, non-authoritative TEST calibration path for
`timeseries-aligned-v2`. It never writes canonical history or index keys.

The tools require R2 credentials to already be exported as configuration data:
`CFLARE_R2_ENDPOINT`, `CFLARE_R2_BUCKET`, `CFLARE_R2_ACCESS_KEY_ID`, and
`CFLARE_R2_SECRET_ACCESS_KEY`. They also require `UKAQ_ENV_NAME=TEST`.

## Stage and generate locally

```bash
export UKAQ_ENV_NAME=TEST
node scripts/index_v3_aligned_candidate/stage_source.mjs \
  --output-root tmp/index_v3_aligned_candidate_source \
  --replace

python3 -m venv /tmp/uk_aq_aligned_v2_env
/tmp/uk_aq_aligned_v2_env/bin/pip install \
  -r scripts/index_v3_aligned_candidate/requirements.txt
/tmp/uk_aq_aligned_v2_env/bin/python \
  scripts/index_v3_aligned_candidate/generate.py \
  --environment TEST \
  --source-root tmp/index_v3_aligned_candidate_source \
  --output-root tmp/index_v3_aligned_candidate \
  --replace

node scripts/index_v3_aligned_candidate/validate_local.mjs \
  --output-root tmp/index_v3_aligned_candidate
```

`stage_source.mjs` performs GET requests only. Generation and validation are
local. The fixed candidate object root is:

```text
history/_prototype/observation-history/timeseries-aligned-v2/cap_rows=<cap>/
```

For an additional reviewed calibration namespace, `--prototype-prefix` may add
one safe `candidate=<slug>` component before `cap_rows`. The publisher requires
the exact prefix from the generated plan as its confirmation, and the Worker
must receive that same prefix through `UK_AQ_ALIGNED_V2_PROTOTYPE_PREFIX`.

## Publish after review

The first command is idempotent and skips objects whose stored SHA-256 is
already identical. It stops on a differing object. Add `--replace-existing`
only after reviewing the exact same cap/partition namespace.

```bash
export UKAQ_ENV_NAME=TEST
node scripts/index_v3_aligned_candidate/publish.mjs \
  --plan tmp/index_v3_aligned_candidate/publication-plan.json \
  --confirm-test-prefix history/_prototype/observation-history/timeseries-aligned-v2
```

## Deploy and measure after the changes are pushed

```bash
gh workflow run uk_aq_observs_history_r2_api_v3_aligned_candidate_deploy.yml \
  --ref main

BASE_WORKER_NAME="$(gh variable get UK_AQ_OBSERVS_HISTORY_R2_API_WORKER_NAME)"
ALIGNED_WORKER_NAME="${BASE_WORKER_NAME}-v3-aligned-candidate"
npx --yes wrangler@4 tail "${ALIGNED_WORKER_NAME}" --format json \
  | tee tmp/index_v3_aligned_candidate_tail.jsonl
```

In another terminal, with the existing upstream secret exported:

```bash
export UK_AQ_V3_ALIGNED_CANDIDATE_URL="https://${ALIGNED_WORKER_NAME}.<test-account-subdomain>.workers.dev"
node scripts/index_v3_aligned_candidate/measure.mjs \
  --endpoint "${UK_AQ_V3_ALIGNED_CANDIDATE_URL}" \
  --repeat 2
```

Use each result's diagnostic request ID or CF-Ray to correlate the tail and
Cloudflare invocation/analytics record. CPU time comes from Cloudflare; the
runner deliberately leaves it null rather than deriving it from wall time.
