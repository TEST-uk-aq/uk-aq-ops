# Stage 2B: Sleepercar TEST compressed chart-history pilot

## Precomputed-AQI extension (repository preparation)

The current code can publish paired schema-v2 observation/AQI gzip objects from
a freshly exported, complete v3 September candidate. AQI completeness is
independent of observation coverage; missing preceding PM context remains
partial. The Worker streams the selected AQI gzip object for schema v2 and
keeps the legacy request-time route for existing schema-v1 publications. The
experimental viewer labels both modes. No remote export, publication, Worker
deployment, Pages deployment or proxy activation follows from this code change.

The original Stage 2B account below records the deployed observation-only
pilot and its earlier operator setup. For this extension, regenerate the v3
September candidate with the current exporter; do not reuse the earlier
observation-only candidate if precomputed AQI is intended. Retain the current
selector bytes before an authorised `--publish` so rollback can restore them.

Status: **code prepared, not an operational deployment**. This is a TEST-only
experiment. Authoritative requirements remain in
`TEST-uk-aq/uk-aq-system-docs/system_docs/station_charts/compressed_history_json_test_prototype_contract.md`.
No normal chart route, canonical R2 history, Integrity, backups, scheduler or
LIVE runtime has been changed by this pilot. Do not deploy as a side effect of
reviewing code.

## Account and security topology

- **Sleepercar TEST Cloudflare account**: `sleepercar.co.uk`,
  `41a81f781d3bd7234fde0b25df51e879`. The dedicated private R2 bucket
  `uk-aq-chart-history-json-test` was created 09/10/2026 in WEUR, Standard.
  It was empty at creation. The TEST-only experimental Worker
  `uk-aq-compressed-chart-history-test` must be deployed **in this account**
  with an R2 binding to this bucket.
- **ukaq.co.uk Cloudflare account**: hosts the existing TEST cache proxy, which
  must remain there for its ukaq.co.uk routing. Its experimental route calls
  Sleepercar over **authenticated HTTPS**, not a cross-account service binding.
  No new experimental Worker or derived bucket belongs in this account.
- Canonical TEST observation history remains independent in Sleepercar R2.
  The publisher uses dedicated bucket-scoped credentials and never mutates
  canonical history.
- The baseline TEST proxy has `UK_AQ_COMPRESSED_CHART_ENABLED = "false"`.
  Normal pushes and ordinary deployments keep it disabled and return
  `503 prototype_binding_unavailable` for the experimental endpoint. Only
  the explicit workflow input opts in to the external service.

**Cross-account protection has two layers:** an operator-created Sleepercar
Cloudflare Access self-hosted application with **Service Auth** policy, and the
experimental Worker's existing `X-UK-AQ-Upstream-Auth` secret check. The proxy
sends `CF-Access-Client-Id`, `CF-Access-Client-Secret` and the upstream
secret server-side, after enforcing its ordinary allowed-origin and real
Turnstile-backed session cookie. Browser JavaScript never receives these tokens.
No local-dev bypass, direct unauthenticated R2 URL, public r2.dev bucket or
workers.dev/preview route is permitted. The TEST upstream origin must be a
clean HTTPS **subdomain of sleepercar.co.uk**, not a caller-supplied URL.

## Source and publication authority

Only AURN connector 1, physical timeseries 212, station 248 and PM2.5 are
admitted. The approved samples are complete v3 September 2026 (664 rows,
4,223-byte gzip) and equivalent v3/v2 1 September (24 rows each, 903/828-byte
gzip). Retained v2 for 2–30 September is unavailable. Never publish an
incomplete v2 month. Raw negative source values and nullable row station IDs
are preserved. The binding remains station 248 and each non-null row station ID
must equal 248.

The publisher is `scripts/compressed_chart_history/publish.mjs`. Its default
operation is a **local-only preflight with zero remote requests**. Examples:

```bash
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

The three sample candidates must exist at those exact local paths; use their
actual paths if the operator has regenerated the exports. Source digests,
JSON/gzip round trips, coverage and manifest identities are checked before
publication. Incomplete combined-month candidates are rejected.

A future operator-authorised publish uses `node --env-file=.env.compressed-chart-test`
plus the same arguments, `--derived-bucket uk-aq-chart-history-json-test --publish`.
The private, **untracked** environment contains:

```text
UK_AQ_ENV_NAME=TEST
UK_AQ_COMPRESSED_CHART_R2_ENDPOINT=https://41a81f781d3bd7234fde0b25df51e879.r2.cloudflarestorage.com
UK_AQ_COMPRESSED_CHART_R2_ACCESS_KEY_ID=<dedicated bucket-scoped key>
UK_AQ_COMPRESSED_CHART_R2_SECRET_ACCESS_KEY=<dedicated bucket-scoped secret>
```

These are placeholders, not actual keys. Never commit them or print secrets.
The publisher pins the exact Sleepercar account and bucket and rejects reuse of
canonical `CFLARE_R2_*` credentials where present. Only gzip, immutable source
evidence and publication manifest are uploaded. R2 read-back verification
precedes a publish-last selector update at
`experimental/compressed-chart-history/v1/latest.json`. An ambiguous selector
PUT requires inspecting remote state before retrying. Keep a saved prior
complete selector for rollback; single operator only (no R2 compare-and-swap).

## Separately authorised provisioning and activation

1. Verify the Sleepercar bucket is private, has no public r2.dev/custom R2
   domain, and is bound only to the experimental Worker. Confirm access to the
   Sleepercar account before any Wrangler command.
2. Choose an unused HTTPS subdomain of `sleepercar.co.uk` for the Worker.
   Provision a Cloudflare Access self-hosted application protecting that exact
   hostname, with a Service Auth policy allowing only the dedicated service
   token. Preserve the token ID/secret securely. Do **not** expose the origin
   before its Access policy is active.
3. The baseline Worker `workers/uk_aq_compressed_chart_history/wrangler.toml`
   deliberately has no HTTP route, workers.dev or preview URL. Create a local,
   untracked `wrangler.deploy.toml` copy, adding a verified custom-domain
   route only after step 2. Example syntax (replace the chosen hostname):

   ```toml
   [[routes]]
   pattern = "uk-aq-chart-history-test.sleepercar.co.uk"
   custom_domain = true
   ```

   Set `CLOUDFLARE_ACCOUNT_ID=41a81f781d3bd7234fde0b25df51e879` and
   authenticate to Sleepercar. Check Wrangler's dry-run config; later deploy
   `uk-aq-compressed-chart-history-test` explicitly. Provision its
   `UK_AQ_EDGE_UPSTREAM_SECRET` from the existing TEST secret source. The
   Worker retains its independent fail-closed header check.
4. Set up a dedicated Sleepercar R2 API token scoped to this derived bucket.
   After separately authorised deployment, run the three manual publications
   above with `--publish`, using only the private Sleepercar endpoint.
5. Configure the following **TEST ops GitHub repository** items for the TEST
   cache proxy's deployment account (the account hosting ukaq.co.uk):

   - Variable `UK_AQ_COMPRESSED_CHART_UPSTREAM_URL`: the selected
     `https://<sleepercar-test-subdomain>/` origin, no path or query.
   - Secret `UK_AQ_COMPRESSED_CHART_ACCESS_CLIENT_ID`: Sleepercar Access service token ID.
   - Secret `UK_AQ_COMPRESSED_CHART_ACCESS_CLIENT_SECRET`: paired Access service token secret.

   The existing proxy `UK_AQ_EDGE_UPSTREAM_SECRET` must equal the pilot
   Worker's header-auth secret, but never expose or copy it into website files.
6. Only **after** the Worker is reachable behind Access and v3 September has
   been published, manually activate using:

   ```bash
   gh workflow run uk_aq_cache_proxy_deploy.yml \
     --repo TEST-uk-aq/uk-aq-ops \
     -f activate_compressed_chart_history=true
   ```

   The workflow verifies actual Access-authenticated manifest access and
   sample identity before enabling `UK_AQ_COMPRESSED_CHART_ENABLED="true"`
   in its generated proxy config and injecting TEST-only upstream/token secrets.
   No cross-account service binding is created.

**Rollback:** an ordinary proxy deployment without the activation input
restores the disabled baseline:

```bash
gh workflow run uk_aq_cache_proxy_deploy.yml --repo TEST-uk-aq/uk-aq-ops
```

The Worker, bucket, Access application and immutable objects may remain in the
Sleepercar TEST account for independent later cleanup. No canonical history
objects should be deleted. Do not run these workflows as part of code review.

## Real TEST measurements after deployment

The isolated `compressed-chart-history-test/` page remains unchanged and
compares normal v3 history to JSON v3/v2 for the verified one-day overlap, and
normal v3 to JSON v3 for September (30 days). Capture real cold/warm browser
request, gzip transfer/parse, normalisation, cache commit, first visible line,
full history, AQI, SVG render, cache state and Cloudflare Worker CPU/outcomes.

The first 23 hours of PM context can be incomplete; report incomplete AQI rather
than substituting the normal path. Negative canonical source values (`-99`)
remain present for the shared point-eligibility rules. Workers Free CPU usage,
Access handshake and **cross-account HTTP latency** must be measured separately.
This TEST path has an extra HTTP hop compared with a possible same-account
LIVE service binding: do not automatically extrapolate end-to-end latency or
request counts to LIVE.

Initial pilot responses deliberately use `Cache-Control: no-store`. Manifest
refresh, immutable gzip caches, correction freshness (preferred 1–2 hours),
automatic regeneration and any LIVE adoption are separate future decisions.

System-documentation handover (Chat mode owner): after real deployment,
record the Sleepercar account/bucket, Access-protected HTTPS origin and tokens
by **configuration names only**, manual publish-last selector, TEST proxy
activation/rollback, optional JSON provider, PM context, Worker CPU and
cross-account-versus-LIVE latency qualification in the owning station-chart
and deployment contracts. Do not copy secret values into documentation.
