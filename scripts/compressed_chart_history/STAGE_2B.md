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

Those commands perform **zero remote requests**. The expected preflight row counts/gzip sizes are 664/4,223, 24/903, and 24/828 respectively. Any incomplete candidate is rejected. To publish later, after separately authorised TEST bucket setup, repeat each command prefixed with `node --env-file=.env.compressed-chart-test` and append `--derived-bucket ACTUAL-PRIVATE-DERIVED-TEST-BUCKET --publish`. The untracked, private operator environment must set `UK_AQ_ENV_NAME=TEST`, the confirmed main TEST `UK_AQ_DOMAIN_CLOUDFLARE_ACCOUNT_ID`, plus dedicated `UK_AQ_COMPRESSED_CHART_R2_ENDPOINT`, `UK_AQ_COMPRESSED_CHART_R2_ACCESS_KEY_ID` and `UK_AQ_COMPRESSED_CHART_R2_SECRET_ACCESS_KEY`. These are **not** the canonical `CFLARE_R2_*` credentials. The endpoint must identify the main TEST Cloudflare account and the access key must be scoped to the separate private derived bucket. The publisher checks that the derived endpoint account ID matches that main TEST account and rejects reuse of the canonical endpoint or access key when those canonical values are present. The bucket must be separate from `uk-aq-history-cic-test` and end `-test`. Do not print credentials. Keep a private copy of the prior selector for operational rollback. A failed object upload leaves the prior selector; an ambiguous selector PUT failure requires reading the current selector before retrying.

The source JSON is preserved byte-for-byte, including finite negative source values present in the v3 month and nullable per-observation station IDs permitted by `month.schema.json`. The top-level authoritative binding remains station 248; any non-null row station ID must also be 248. The existing shared observation normalizer and AQI builder decide whether source values can form visible/chart/AQI points; publication must not silently rewrite them.

## Private Worker and edge route

`workers/uk_aq_compressed_chart_history/worker.mjs` reads only selector-approved keys under the experimental namespace. Its Wrangler file has no route and explicitly disables `workers.dev` and preview URLs. The cache proxy alone exposes `/api/aq/chart-history-prototype/{manifest,month,aqi}` to an allowed origin with a valid existing Turnstile-backed session cookie. The local-development bypass does not apply. The proxy passes the existing `UK_AQ_EDGE_UPSTREAM_SECRET` through its service binding; the browser never sees it.

The month endpoint streams R2 gzip bytes with `Content-Encoding: gzip` and `encodeBody: "manual"`; no Parquet read, index lookup or gzip recompression occurs. Manifest selection requires the selector and immutable manifest R2 reads. Each month or AQI request additionally reads one gzip object (currently three R2 GETs/request, uncached). The AQI endpoint is separate: it decompresses the **same** selected JSON and injects its observations into the existing station-history AQI builder. This is deliberately not counted as gzip-stream delivery time. The Worker sends request IDs and selected publication digests in headers and logs only those identifiers/route metadata for telemetry correlation.

`X-UK-AQ-Prototype-AQI-Wall-MS` reports only in-Worker AQI decompression/calculation wall time. It is not a CPU measurement. The browser diagnostics also record the selected manifest/gzip digest, response/transfer/parse times, shared normalisation, cache commit, first line, range completion and D3 render timing.

The cache proxy and station-history Workers deploy to the **main TEST Cloudflare account** selected by `UK_AQ_DOMAIN_CLOUDFLARE_ACCOUNT_ID` (or its existing cache-account fallback). Cloudflare service bindings require both Workers in the same account, so the pilot Worker and its private derived R2 bucket must also be in that main TEST account. Canonical observation history remains in the separate Sleepercar account; it is not a pilot storage or runtime binding. The publisher uses the main account's S3-compatible R2 endpoint and a dedicated derived-bucket-scoped access key. These account, bucket and credential values have not been provisioned or verified in Cloudflare by this code task.

The baseline `workers/uk_aq_cache_proxy/wrangler.toml` contains only the existing `STATION_HISTORY` service binding. Normal push/dispatch deployments work without the pilot Worker and the authenticated prototype route returns `prototype_binding_unavailable` (HTTP 503) while the binding is absent. Only a `workflow_dispatch` with `activate_compressed_chart_history=true` checks that the configured pilot Worker has a deployed version in the **same main TEST account**, then appends `COMPRESSED_CHART_HISTORY` to the generated deployment config. The workflow uses the same secret payload and station-history binding in both modes. A later ordinary proxy deployment returns to the baseline without the pilot binding; reactivation is explicit.

Once bucket creation, secret configuration and deployment are separately authorised, use the actual bucket name in a temporary copy of `workers/uk_aq_compressed_chart_history/wrangler.toml` in the same Worker directory. Run `npx --yes wrangler@4.130.0 deploy --dry-run --config <temporary-config>` before any deploy. Then deploy the private Worker under the configured name using the **main TEST account**, set its `UK_AQ_EDGE_UPSTREAM_SECRET` from the existing TEST secret source using `wrangler secret put`, and verify it has **no public route, workers.dev or preview URL**. Publish the three approved samples only after the private bucket and scoped credentials are ready. No part of this correction task performs those actions.

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

The last command prompts for the existing TEST secret; do not pass it on the command line. Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` securely for the main TEST account before those future Wrangler commands. Do not commit `wrangler.deploy.toml` or leave its sentinel value in a real deployment. The normal cache-proxy workflow remains deployable before the pilot Worker exists; only explicit pilot activation requires it.

After separate review and authorisation, `gh workflow run uk_aq_cache_proxy_deploy.yml --repo TEST-uk-aq/uk-aq-ops` deploys the normal proxy **without** the pilot binding. After the private Worker, bucket, secret and approved publications are ready, `gh workflow run uk_aq_cache_proxy_deploy.yml --repo TEST-uk-aq/uk-aq-ops -f activate_compressed_chart_history=true` explicitly enables the binding. That activation fails before deploy if the pilot Worker has no deployed version in the main TEST account. The website entry point is `gh workflow run pages.yml --repo TEST-uk-aq/TEST-uk-aq.github.io -f refresh_blog_feed=false`; its existing content-hash pipeline includes the isolated page. None of these commands is run by this task.

The derived bucket's Worker binding is `UK_AQ_COMPRESSED_CHART_BUCKET`; `UK_AQ_ENV_NAME=TEST` and `UK_AQ_EDGE_UPSTREAM_SECRET` reuse existing TEST configuration names. The private Worker is intended for Workers Free, but CPU and subrequest limits must be checked from Cloudflare telemetry after real deployment. The AQI endpoint's decompression and shared calculation is the likely CPU-sensitive boundary; no CPU claim is made from local/browser timings.

## Real TEST comparison after authorised deployment

Open the isolated `compressed-chart-history-test/` page and select the normal v3 and JSON v3/v2 one-day modes, then normal v3 and JSON v3 September modes. Never select v2 September as a complete month. Download diagnostics for each cold and warm run. Compare response start, transfer, parsing, normalisation, cache commit, first line, observation-range completion, SVG render and total load. Compare `X-UK-AQ-Prototype-Compressed-Bytes`, R2 read counts, success/partial state and publication SHA. Match browser request IDs to private Worker logs, then inspect Cloudflare invocation CPU, duration and R2 operations. Browser wall time is not Worker CPU. Verify 24-row v2/v3 one-day equality independently of chart visuals and inspect PM AQI partial reasons. The first 23 hours of a file may lack preceding PM context; this pilot marks AQI incomplete rather than silently substituting normal-path observations. A later complete authorised context source is required for complete first-day PM AQI. September is a 30-day chart sample, not a 90-day proof.

The initial benchmark deliberately uses `Cache-Control: no-store` throughout the prototype. A later separately approved stage must assess immutable gzip-object caching, manifest refresh/version selection, browser cache behaviour and end-to-end correction freshness against the preferred one-to-two-hour window. This task does not change normal TEST cache invalidation or TTLs.

Rollback of the viewer/proxy is by the established TEST deployments; the normal route is untouched. Immutable published objects may remain in the private derived bucket. Restore a previously saved complete selector only after checking its referenced manifests and objects; do not alter canonical history.

System-doc handover: record the private derived bucket/binding name, exact selector and publication schema, `/api/aq/chart-history-prototype` authenticated route, optional JSON observation-provider seam, and the PM context/Workers Free validation outcome after real TEST operation in the owning station-chart and deployment contracts. Do not edit authoritative system docs as part of this code task.
