# Compressed chart-history TEST pilot, Stage 2B

This pilot is restricted to AURN connector 1, physical timeseries 212, station 248, PM2.5. It does not write canonical history or make a normal chart-route cut-over. The only approved selections are complete v3 September 2026 and the independently complete v2/v3 1 September 2026 scopes. Retained v2 for 2–30 September is unavailable and must not be represented as complete.

## Local preflight and publication

`publish.mjs` defaults to a local-only preflight. It accepts only a digest-named Stage 2A candidate with complete source/evidence/day coverage, validates the uncompressed schema and physical identity, rechecks both SHA-256 digests and gzip round trip, and prepares a content-addressed publication manifest. It uploads only the gzip object, source evidence, and publication manifest. The mutable `experimental/compressed-chart-history/v1/latest.json` selector is written last after read-back verification. It never uploads raw JSON or local diagnostic reports. One operator at a time must publish: R2 selector replacement is not a compare-and-swap transaction.

From the ops checkout, using the existing local TEST export files:

```sh
node scripts/compressed_chart_history/publish.mjs \
  --candidate /Users/mikehinford/uk-aq-work/compressed-chart-history/stage2a-v3-complete-month/candidate-manifest.d3e42c3f0417ff52759f9fa2746ce39a0d88dc40795e49c4470736b99ec5dd84.json \
  --sample-id v3-september-2026
node scripts/compressed_chart_history/publish.mjs \
  --candidate /Users/mikehinford/uk-aq-work/compressed-chart-history/stage2a-final-overlap/candidate-manifest.d582983bfc30504014ed7076962f55092f4e2e46eda58391d3bca99ecedf5001.json \
  --sample-id v3-2026-09-01
node scripts/compressed_chart_history/publish.mjs \
  --candidate /Users/mikehinford/uk-aq-work/compressed-chart-history/stage2a-final-overlap/candidate-manifest.d582983bfc30504014ed7076962f55092f4e2e46eda58391d3bca99ecedf5001.json \
  --sample-id v2-2026-09-01
```

Those commands perform **zero remote requests**. The expected preflight row counts/gzip sizes are 664/4,223, 24/903, and 24/828 respectively. Any incomplete candidate is rejected. To publish later, after separately authorised TEST bucket setup and with bucket-scoped private credentials in a local, untracked `.env`, repeat each command prefixed with `node --env-file=.env` and append `--derived-bucket <actual-private-derived-test-bucket> --publish`. `UK_AQ_ENV_NAME` must be `TEST`; the bucket must be separate from `uk-aq-history-cic-test` and end `-test`. Do not print credentials or use canonical bucket credentials with write access to source data. Keep a private copy of the prior selector for operational rollback. A failed object upload leaves the prior selector; an ambiguous selector PUT failure requires reading the current selector before retrying.

The source JSON is preserved byte-for-byte, including finite negative source values present in the v3 month. The existing shared observation normalizer and AQI builder decide whether such values can form visible/chart/AQI points; publication must not silently rewrite them.

## Private Worker and edge route

`workers/uk_aq_compressed_chart_history/worker.mjs` reads only selector-approved keys under the experimental namespace. Its Wrangler file has no route and explicitly disables `workers.dev` and preview URLs. The cache proxy alone exposes `/api/aq/chart-history-prototype/{manifest,month,aqi}` to an allowed origin with a valid existing Turnstile-backed session cookie. The local-development bypass does not apply. The proxy passes the existing `UK_AQ_EDGE_UPSTREAM_SECRET` through its service binding; the browser never sees it.

The month endpoint streams R2 gzip bytes with `Content-Encoding: gzip` and `encodeBody: "manual"`; no Parquet read, index lookup or gzip recompression occurs. Manifest selection requires the selector and immutable manifest R2 reads. Each month or AQI request additionally reads one gzip object (currently three R2 GETs/request, uncached). The AQI endpoint is separate: it decompresses the **same** selected JSON and injects its observations into the existing station-history AQI builder. This is deliberately not counted as gzip-stream delivery time. The Worker sends request IDs and selected publication digests in headers and logs only those identifiers/route metadata for telemetry correlation.

`X-UK-AQ-Prototype-AQI-Wall-MS` reports only in-Worker AQI decompression/calculation wall time. It is not a CPU measurement. The browser diagnostics also record the selected manifest/gzip digest, response/transfer/parse times, shared normalisation, cache commit, first line, range completion and D3 render timing.

Cloudflare's Wrangler config needs a separate private TEST R2 bucket. No bucket is created by this change. Once creation, secret configuration and deployment are separately authorised, use the actual bucket name in a temporary copy of `workers/uk_aq_compressed_chart_history/wrangler.toml` in the same Worker directory (do not commit a real bucket name if it is operationally sensitive). Run `npx --yes wrangler@4.130.0 deploy --dry-run --config <temporary-config>` before any deploy. Then deploy the private Worker under the configured `uk-aq-compressed-chart-history-test` name, set its `UK_AQ_EDGE_UPSTREAM_SECRET` from the existing TEST secret source using `wrangler secret put`, and verify it has **no public route, workers.dev or preview URL**. Publish the three approved samples with `--publish` only after the private bucket and credentials are ready. Finally deploy the cache proxy through its existing TEST workflow after the private Worker exists; its Wrangler file now binds to the fixed private Worker name. The existing workflow must not be run before that binding target exists. Deploy the isolated website page through the established TEST website process. No part of this Stage 2B task performs those actions.

For the later authorised private Worker setup, the operator can render and validate the local deployment config this way from the ops checkout. The `DERIVED_TEST_BUCKET` value must name the separately created private bucket and match the publisher's `--derived-bucket` value.

```sh
cd workers/uk_aq_compressed_chart_history
DERIVED_TEST_BUCKET=replace-with-private-derived-test-bucket
sed "s/uk-aq-compressed-chart-unconfigured-test/${DERIVED_TEST_BUCKET}/" wrangler.toml > wrangler.deploy.toml
grep -F "bucket_name = \"${DERIVED_TEST_BUCKET}\"" wrangler.deploy.toml
npx --yes wrangler@4.130.0 deploy --dry-run --config wrangler.deploy.toml
# Only after separate deployment authorisation:
npx --yes wrangler@4.130.0 deploy --config wrangler.deploy.toml
npx --yes wrangler@4.130.0 secret put UK_AQ_EDGE_UPSTREAM_SECRET --config wrangler.deploy.toml
```

The last command prompts for the existing TEST secret; do not pass it on the command line. Do not commit `wrangler.deploy.toml` or leave its sentinel value in a real deployment. The cache-proxy workflow resolves its own existing station-history binding and now includes the fixed pilot service binding. Ensure the new private Worker exists before that workflow deploys the proxy.

After the changes have been separately reviewed and pushed under an authorised Git/deployment task, the existing TEST deploy entry points are `gh workflow run uk_aq_cache_proxy_deploy.yml --repo TEST-uk-aq/uk-aq-ops` and `gh workflow run pages.yml --repo TEST-uk-aq/TEST-uk-aq.github.io -f refresh_blog_feed=false`. Do not invoke them before the private Worker, secret and approved publications are ready. The website workflow builds the new page through its existing content-hash pipeline. Its `refresh_blog_feed=false` input avoids an unrelated feed refresh.

The derived bucket's R2 binding is `UK_AQ_COMPRESSED_CHART_BUCKET`; `UK_AQ_ENV_NAME=TEST` and `UK_AQ_EDGE_UPSTREAM_SECRET` reuse existing TEST configuration names. The private Worker is expected to run on Workers Free, but CPU and subrequest limits must be checked from Cloudflare telemetry after real deployment. The AQI endpoint's decompression and shared calculation is the likely CPU-sensitive boundary; no CPU claim is made from local/browser timings.

## Real TEST comparison after authorised deployment

Open the isolated `compressed-chart-history-test/` page and select the normal v3 and JSON v3/v2 one-day modes, then normal v3 and JSON v3 September modes. Never select v2 September as a complete month. Download diagnostics for each cold and warm run. Compare response start, transfer, parsing, normalisation, cache commit, first line, observation-range completion, SVG render and total load. Compare `X-UK-AQ-Prototype-Compressed-Bytes`, R2 read counts, success/partial state and publication SHA. Match browser request IDs to private Worker logs, then inspect Cloudflare invocation CPU, duration and R2 operations. Browser wall time is not Worker CPU. Verify 24-row v2/v3 one-day equality independently of chart visuals and inspect PM AQI partial reasons. The first 23 hours of a file may lack preceding PM context; this pilot marks AQI incomplete rather than silently substituting normal-path observations. A later complete authorised context source is required for complete first-day PM AQI. September is a 31-day chart sample, not a 90-day proof.

Rollback of the viewer/proxy is by the established TEST deployments; the normal route is untouched. Immutable published objects may remain in the private derived bucket. Restore a previously saved complete selector only after checking its referenced manifests and objects; do not alter canonical history.

System-doc handover: record the private derived bucket/binding name, exact selector and publication schema, `/api/aq/chart-history-prototype` authenticated route, optional JSON observation-provider seam, and the PM context/Workers Free validation outcome after real TEST operation in the owning station-chart and deployment contracts. Do not edit authoritative system docs as part of this code task.
