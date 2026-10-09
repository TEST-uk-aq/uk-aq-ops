# TEST History Integrity cache invalidation

Implementation and deployment-correction handover, 8 October 2026.
The original implementation is committed and pushed to TEST main as
`15844b9c6aca04d7c4b357ad08636b8491136103`. Its deployment is partial:

| GitHub Actions run | Confirmed result |
| --- | --- |
| [Reader and dashboard, 37839646067](https://github.com/TEST-uk-aq/uk-aq-ops/actions/runs/37839646067) | Successful. The existing reader now has `history-test.sleepercar.co.uk`. Adding the route without an explicit `workers_dev` setting disabled the old reader hostname. The dependent dashboard also deployed. |
| [Station history, 37839645358](https://github.com/TEST-uk-aq/uk-aq-ops/actions/runs/37839645358) | Failed configuration validation before secret writes/deployment: the existing GitHub upstream URL still points to the reader's workers.dev origin. |
| [Cache proxy, 37839645326](https://github.com/TEST-uk-aq/uk-aq-ops/actions/runs/37839645326) | Wrangler 4 dry-run passed, and the bulk-secret step succeeded. Final wrangler-action deployment failed under its default Wrangler 3.90.0 when parsing the shared JSON import attributes. The failed deploy did not publish the new proxy code; earlier secret writes did occur. |

These results were checked against the actual Actions logs. They do not establish
functional cache-invalidation acceptance or healthy old-host consumers.
Only the corrections described below are currently local and uncommitted.
This correction task did not deploy, change Cloudflare resources/GitHub variables,
purge caches, execute repairs or edit authoritative system documentation.
Functional acceptance remains a real TEST operation after the corrected deployment.

## Local deployment corrections

| File | Correction |
| --- | --- |
| `.github/workflows/uk_aq_station_history_deploy.yml` | Explicit Node 22; Wrangler 4.130.0 for dry-run, secret upload and final wrangler-action; package dry-run before remote secret writes; actionable strict custom-domain validation error, including rejection of non-default ports. |
| `.github/workflows/uk_aq_cache_proxy_deploy.yml` | Explicit Node 22; Wrangler 4.130.0 for every CLI call and final wrangler-action, so package validation and deployment use the same bundler. |
| `.github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml` | Explicit TEST-only top-level `workers_dev = true` alongside the existing Custom Domain. This retains authenticated WHO-summary/provenance/descriptor compatibility endpoints; observation and binding reads still require the owned custom domain. |
| `workers/uk_aq_observs_history_r2_api_worker/worker.mjs`; `worker_v3.mjs` | Keep authenticated, always-no-store WHO daily-validation provenance ahead of the domain guard. The cached observation/binding routes remain custom-domain-only. |
| This handover | Actual deployment status, consumer migration prerequisites, deployment-toolchain evidence and remaining acceptance. |

The [pinned action](https://github.com/cloudflare/wrangler-action/blob/da0e0dfe58b7a431659754fdf3f186c529afbe65/action.yml)
supports `wranglerVersion`; leaving this input absent was the
cause of the final-build mismatch. The JSON import remains the shared writer/purger
definition and uses syntax supported by the corrected toolchain. Account selection,
Worker names, binding target resolution, routes, secrets and authentication are
unchanged except for explicitly retaining the reader compatibility hostname in TEST.
Cloudflare's [Wrangler configuration rules](https://developers.cloudflare.com/workers/wrangler/configuration/)
make `workers_dev` default to false when routes are configured, so compatibility
retention must be explicit.

## Original implementation in commit 15844b9c6aca

| Files | Change |
| --- | --- |
| `config/uk_aq_history_cache.json`; `workers/shared/uk_aq_history_cache.mjs` | Shared TEST tag, dependency-header and initial key contract |
| `workers/uk_aq_observs_history_r2_api_worker/worker.mjs`; `worker_v3.mjs` in the same directory | Authenticated reader tags, owned-host check and canonical key cut-over |
| `workers/uk_aq_station_history/src/index.mjs` | Authenticated physical/continuity/context dependency propagation |
| `workers/uk_aq_cache_proxy/src/index.ts` | Fresh/stale write tagging, dependency/hostname cache gates and key cut-over |
| `.github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml`; `uk_aq_station_history_deploy.yml`; `uk_aq_cache_proxy_deploy.yml` | TEST activation configuration, reader Custom Domain and narrow upstream validation |
| `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py`; `uk-aq-history-integrity-sos-light-v3_impl.py` | Frozen plan, verified event, independent report and post-lock delivery hooks |
| `scripts/uk-aq-history-integrity/bin/integrity/history_cache.py`; `history_cache_rows.mjs` | Source-neutral authenticated identity comparison, durable event and purge delivery |
| `scripts/uk-aq-history-integrity/bin/uk-aq-history-cache-invalidation-retry.py`; matching `.sh` | Bounded original-event operator retry |
| `config/uk_aq_github_env_targets.csv`; ignored local `env-vars-master.csv` | Operator-only purge configuration and existing TEST upstream/environment values |
| This handover | Deployment, validation, rollback and documentation implications |

The nine pre-change code/workflow copies are under `archive/2026-10-08/`,
preserving their repository-relative paths. No archive is used at runtime.

## Serving and purge ownership

The existing `caches.default` architecture and normal TTLs remain in place.
There is no new cache product, per-request revision lookup, public purge endpoint,
database schema, migration or queue.

| Layer | Worker / serving boundary | Owning zone | TEST zone ID |
| --- | --- | --- | --- |
| Authenticated observation reader | Existing TEST reader, deployed Custom Domain `history-test.sleepercar.co.uk` | `sleepercar.co.uk` | `76ce2d07b41572e3efe08c3dc2496bc0` |
| Public history cache, fresh and stale | Deployed `uk-aq-cache-test`, route `cic-test.chronicillnesschannel.co.uk/api/aq/*` | `chronicillnesschannel.co.uk` | `4b72b6262bcbb226dddefcb620aa901d` |

The proxy ownership was resolved from read-only deployed Worker route/domain
configuration, independently of the reader account. Both zone IDs were obtained
through read-only Cloudflare configuration during implementation. The successful
Actions deployment subsequently attached the reader Custom Domain; this correction
task made no remote route or domain changes.
The temporary probe hostname is not used by the implementation.

`config/uk_aq_history_cache.json` is the single writer/purger tag definition.
For example, physical timeseries `35030410` on selected generation `v3` receives
`ukaq-test-history-v3-ts-35030410`. JS and Python consume the same template.
Tag purging covers all stored request windows for that physical identity; it
does not require a list of public URLs. Each owning zone receives only
`POST /client/v4/zones/{zone_id}/purge_cache` with `{"tags":[...]}`.
HTTP 200 plus `success:true` and no reported errors means accepted delivery,
not demonstrated eviction. No Purge Everything or local-only deletion is used.

The reader preserves upstream-secret authentication and refuses TEST history
observation/binding requests on other hostnames after activation. Existing
unrelated WHO-summary, daily-validation-provenance and generation-descriptor
entry handlers retain their behaviour.
Their workers.dev reachability was lost in the successful original deployment;
the explicit TEST compatibility setting restores it only after redeployment.
Do not put Cloudflare Access in front of the private reader. The existing public
site Access boundary, proxy session authentication and Service Binding remain.
On other proxy hostnames, TEST history responses are not reusable cached entries.

## Dependencies and initial cut-over

The reader tags eligible complete physical observation responses. Station history
derives dependencies after authoritative binding/identity resolution. Combined
responses include all temporally selected continuity members and the PM AQI
23-hour context. The proxy validates the private upstream dependency header and
attaches `Cache-Tag` at both fresh and stale cache-write boundaries.
The internal header also survives the removal of `Cache-Tag` from an upstream
HTTP response by Cloudflare.

Missing, invalid or more than 128 dependency tags means `no-store`. Incomplete
responses retain existing `no-store`. Legacy timeseries stitching and legacy
persisted AQI paths without the complete authenticated observation dependency
set are not cached under this TEST feature. Their response schemas and algorithms
are unchanged. Unrelated proxy routes are unaffected.

TEST history cache keys add the fixed component
`__uk_aq_history_tags=tagged-history-1`, including proxy fresh/stale keys and
the reader's canonical v2/v3 keys. This bypasses previously untagged entries
without clearing unrelated content. Cache hits also require the internal
dependency proof for observation-dependent entries.

The local `RESPONSE_CACHE_GENERATION` was checked against GitHub and already
equals `side-by-side-v3-exact-leaf-4`; it was not overwritten or incremented.
The cut-over component is separate from both this recovery baseline and
`UK_AQ_R2_HISTORY_VERSION`. Never change either marker as a routine repair step.

Code review covered the reader's canonical v2/v3 cache keys and writes, authenticated
station dependencies after binding/continuity selection, PM context intervals,
proxy fresh/stale cache hits and writes, frozen changed/removal identities,
post-verification event persistence, post-lock delivery and original-event retry.
The selective tag vocabulary, no-store gates, normal lifetimes and `-4` baseline
remain unchanged. The only runtime correction is the authenticated no-store WHO
provenance route exemption from the cache-owned hostname guard; no correction was
identified in the selective invalidation/event/retry paths.
This is a structural/code review conclusion; deployed eviction, continuity and
failure/retry behaviour still require the real TEST acceptance below.

## Consumers of the old reader hostname

Read-only GitHub variable inspection still finds
`UK_AQ_OBSERVS_HISTORY_R2_API_URL=https://uk-aq-observs-history-r2-api.cic-test.workers.dev`.
The consumers use this existing shared variable rather than a hard-coded old host:

| Consumer | Effect and migration |
| --- | --- |
| Station history (`index.mjs`, `continuity.mjs`, `r2_observations.mjs`) | Observation and binding requests require the owned custom domain. The station deployment correctly remains blocked until the existing variable is updated. |
| Cache proxy legacy observation stitching | Must receive the custom-domain URL through its existing secret payload when redeployed. No workers.dev data fallback is enabled. |
| Cache proxy WHO summary (`who_summary_route.ts`) | Derives `/v1/who-summary` from the configured origin. Its reader handler remains authenticated and separate from history cache tagging. Explicit workers.dev retention protects compatibility until the proxy receives the new URL. |
| Cache proxy WHO daily series (`who_daily_series_route.ts`) | Private `/v1/daily-validation-provenance` enrichment uses the configured reader origin. The corrected reader preserves this authenticated, always-no-store route on workers.dev during migration. Redeploy the proxy with the custom-domain URL; existing degraded-mode behaviour is preserved. |
| Online dashboard (`history_generation.ts`, `station_snapshot_v2.ts`) | The successfully deployed dashboard still received the old URL. Descriptor resolution can fail while workers.dev is disabled; snapshot observation reads also require the custom domain. Redeploy the dashboard after updating the shared URL. Retaining workers.dev only restores the authenticated descriptor compatibility path. |
| AQI reader optional observation fallback (`worker.mjs`) | If enabled, it also requires the new observation URL. Its existing deployment workflow copies the same variable; redeploy before enabling/using that fallback. |

The explicit v3 candidate workflow uses a separate candidate reader identity and
remains isolated; do not replace its candidate authority with the stable service.
Bounded searches found no literal old-host consumer in the active TEST ingest,
website, Integrity Factory or ops worker/local/config paths searched (archives,
dependency trees, logs and secret catalogues excluded). No unrelated reader-route
implementation or authentication was changed.

## Verified event and independent delivery

The active normal and fixed-v3 coordinators call the shared source-neutral
`bin/integrity/history_cache.py`. Before APPLY they freeze the physical change
set from the final staged proposal and pinned Dropbox baseline. They reuse the
existing Parquet decoder and canonical observation hash/status normalization.
Partition file SHA256/bytes are checked; historical opaque ETags require the
existing canonical partition content hash. Per-timeseries comparisons preserve
duplicate multiplicity, timestamps, values and canonical status. Authoritative
removals use baseline identities, including zero-row final partitions.

Unchanged physical observations are excluded from data replacement invalidation.
Serving-relevant index corrections are considered separately; shared file or
source-aligned identity changes caused by another member's data repair do not
alone make that member a changed timeseries. Index membership must map to the
authenticated canonical partition. Source-unavailable preserved scopes are
excluded. Scope decoding is bounded to 500,000 rows and 512 MiB per partition;
unresolvable scopes remain explicit pending audit entries, never global purges.

A successful APPLY and final verification (`ran:true`, `status:ok`) are required.
The immutable event is persisted before independent current-state reconciliation.
Its frozen publication fingerprint covers physical partitions/indexes and source
authority. It deliberately excludes day/global parent bytes that APPLY legitimately
regenerates while merging unchanged live siblings. Existing APPLY gates and final
verification continue to authenticate the full publication. Dry-run, check-only,
failed APPLY and failed final verification never produce a repair-success purge.

The outer normal operator invocation delivers only after the global observation
operation lock is released. Cache planning/persistence/delivery failures do not
change the canonical repair criteria or subprocess exit status. Timeseries and
Latest Snapshot reconciliation retain their existing order and semantics; failure
there does not suppress an already verified cache event.

Existing retained run directories provide durable state:

- `run-state.json`: frozen plan, verified final evidence and independent delivery reference/result;
- `history-cache-invalidation.json`: immutable event/digest, per-layer accepted tags, errors, cooldown and latest attempt;
- `history-cache-invalidation-attempt-NNNNNN.json`: retained individual invocation audits.

The existing run log and JSON/Markdown report receive the post-lock delivery result.
No delivery status changes the existing repair status. Reports may retain the
initial pending reference in the repair section; the top-level post-lock result
and retained audit are authoritative for subsequent delivery. Operator retry
updates the run state and audit; its printed JSON is the latest retry outcome.
An unchanged run requires no purge requests and reports `not_required`.

Each invocation sends at most ten requests total, at most 100 tags per request,
paced at 12 seconds within a layer. It stops that layer on failure, records
`Retry-After`/cooldown, and still independently handles the other layer. Results
are `accepted`, `pending`, `partial` or `failed`, with retry eligibility. Errors
contain bounded classifications/status/error codes, not tokens or response bodies.
Accepted chunks are retained; an interrupted request can safely be repeated.

## Operator configuration

The local, ignored `env-vars-master.csv` catalogue has been updated, preserving
existing LIVE fields and unrelated rows. It is not visible in ordinary Git diff.
`config/uk_aq_github_env_targets.csv` marks the four new operator fields as `local`;
environment sync does not upload them to GitHub or Workers.

Add these values to the selected TEST ops repository root `.env` through the
existing operator secret process; token values are intentionally blank in the
catalogue:

```dotenv
UK_AQ_ENV_NAME=TEST
UK_AQ_HISTORY_CACHE_READER_ZONE_ID=76ce2d07b41572e3efe08c3dc2496bc0
UK_AQ_HISTORY_CACHE_PROXY_ZONE_ID=4b72b6262bcbb226dddefcb620aa901d
UK_AQ_HISTORY_CACHE_READER_PURGE_TOKEN=<reader-zone-scoped-token>
UK_AQ_HISTORY_CACHE_PROXY_PURGE_TOKEN=<proxy-zone-scoped-token>
UK_AQ_OBSERVS_HISTORY_R2_API_URL=https://history-test.sleepercar.co.uk/v1/observations
```

Provision separate TEST Cloudflare API tokens with **Zone: Cache Purge** permission
and resource scope restricted to the respective owning zone/account. Deployment
tokens are not automatically reused for purging. These secrets stay local to the
authenticated operator/service and are not sent to browser code, Worker deployment
secret payloads, public APIs or reports. No remote secrets were created here.
Both hostname zones also host other content, so explicit tag-only operations and
the TEST tag namespace remain necessary even with zone-scoped credentials.

## Manual TEST recovery deployment, in dependency order

These are future operator commands, not commands executed during implementation.
The original implementation is already on TEST main and partially deployed.
First review these local corrections and make them available at an operator-chosen
TEST repository ref. Actions cannot deploy the new uncommitted corrections until
that separate step is performed. Avoid concurrent station/proxy activation during
recovery. Changing a GitHub variable alone does not update deployed Worker secrets.

From the TEST ops checkout, the operator must update the existing upstream variable
(not performed by this task). `UK_AQ_ENV_NAME` is already confirmed as `TEST`:

```bash
gh variable set UK_AQ_OBSERVS_HISTORY_R2_API_URL --repo TEST-uk-aq/uk-aq-ops --body https://history-test.sleepercar.co.uk/v1/observations
```

Keep the already selected TEST `UK_AQ_R2_HISTORY_VERSION` and all existing Worker
names, R2 bucket, account credentials, upstream secret, Service Binding, access
configuration and public proxy route. No schema apply or database migration is
required. Populate the local purge configuration before the first repaired run.

1. Deploy the reader from the reviewed ref:

   ```bash
   gh workflow run uk_aq_observs_history_r2_api_worker_deploy.yml --repo TEST-uk-aq/uk-aq-ops --ref <reviewed-ref>
   gh run watch <reader-run-id> --repo TEST-uk-aq/uk-aq-ops --exit-status
   ```

   The corrected workflow retains the already attached Custom Domain and explicitly
   retains workers.dev for authenticated WHO/provenance/descriptor compatibility routes. Verify the attachment is exactly
   `history-test.sleepercar.co.uk`, with the existing bucket and upstream secret.
   Confirm normal authenticated reads work there before deploying its consumers.
   An unauthenticated history request must still fail authentication. An
   authenticated history request to the old workers.dev endpoint must return
   `503/history_custom_domain_required` with `no-store`; unrelated entry routes
   remain available. Confirm authenticated `/v1/who-summary`, `/v1/daily-validation-provenance` and
   `/v1/history-generation` on both configured origins, and authentication failures
   without the existing secret. Daily provenance and the descriptor remain `no-store`; observation and binding
   requests remain custom-domain-only.

2. Deploy station history:

   ```bash
   gh workflow run uk_aq_station_history_deploy.yml --repo TEST-uk-aq/uk-aq-ops --ref <reviewed-ref>
   gh run watch <station-run-id> --repo TEST-uk-aq/uk-aq-ops --exit-status
   ```

   The validator permits exactly the configured TEST hostname, HTTPS,
   `/v1/observations`, no non-default port/credentials/query/fragment, and the stable Worker identity.
   Non-TEST validation remains unchanged. The Worker remains private via binding.

3. Deploy the proxy:

   ```bash
   gh workflow run uk_aq_cache_proxy_deploy.yml --repo TEST-uk-aq/uk-aq-ops --ref <reviewed-ref>
   gh run watch <proxy-run-id> --repo TEST-uk-aq/uk-aq-ops --exit-status
   ```

   Verify the existing `uk-aq-cache-test` identity, STATION_HISTORY service and
   `cic-test.chronicillnesschannel.co.uk/api/aq/*` route were preserved. Both fresh
   and stale history entries must use the new fixed cut-over component.

4. Redeploy the dashboard with the updated URL; if the optional AQI reader
   observation fallback is used, redeploy that consumer too:

   ```bash
   gh workflow run uk_aq_ops_dashboard_api_worker_deploy.yml --repo TEST-uk-aq/uk-aq-ops --ref <reviewed-ref>
   gh run watch <dashboard-run-id> --repo TEST-uk-aq/uk-aq-ops --exit-status
   # Only if this optional consumer is used:
   gh workflow run uk_aq_aqi_history_r2_api_worker_deploy.yml --repo TEST-uk-aq/uk-aq-ops --ref <reviewed-ref>
   gh run watch <aqi-reader-run-id> --repo TEST-uk-aq/uk-aq-ops --exit-status
   ```

   Verify WHO summary and daily provenance enrichment, dashboard generation and
   snapshots, and any enabled AQI fallback use the intended stable reader with
   their existing secrets. Do not enable new fallback paths as part of migration.

5. Use the existing active TEST Integrity repository/local wrapper, which selects
   this checkout. No database schema or wrapper redeployment is needed for the
   normal active path. Do not activate a repair until all three serving Workers
   and the local scoped purge settings are in place.

## Retry without another repair

Use the original retained run state after any failure/partial delivery:

```bash
bash scripts/uk-aq-history-integrity/bin/uk-aq-history-cache-invalidation-retry.sh \
  --run-state /Users/mikehinford/uk-aq-history-integrity/state/TEST/tmp/run-<original-run-id>/run-state.json \
  --max-batches 10
```

The shell wrapper reads only the trusted repository settings through a Python
assignment parser, without executing `.env` shell content. No repair/runtime
module is loaded. Retry checks the original environment, run identity, physical
publication fingerprint, immutable event digest and final-verification proof.
It neither reads/mutates R2 nor calls reconciliation. A concurrent retry is refused
by the local audit lock. Exit 0 means accepted/not-required; exit 2 means delivery
is still unresolved. Respect the recorded cooldown before retrying again.

Unresolved physical mapping remains pending and cannot be fixed by editing an
event or retrying a wider purge. Inspect the original authenticated run evidence;
resolve that specific evidence problem before claiming complete acceptance.
Retain run state/event/attempt artifacts for the full retry/audit period.

## Real TEST acceptance after deployment

Use an operator-authorised actual scoped repair through the existing active
runner, with its usual source/currentness/global-lock/APPLY gates. Do not invent
a repair or force republish merely to manufacture a cache test. The former
Cardiff case (connector 9, timeseries 35030410, PM2.5, 2 October 2026) is a useful
identity example, not an instruction to repeat an already completed repair.

Before the next genuine correction, record normal authenticated reader and public
history requests for the affected and an unrelated physical identity. Warm each
to HIT using exactly the same request window/authentication/format as the browser.
Keep response/cache headers and actual hours/values, not only screenshots.

After verified publication, inspect the original cache event and each zone/layer
acceptance independently. Repeat the same normal requests after accepted purge;
the affected response must MISS/refresh and expose the corrected or removed hours
without the former 24-hour wait. The unrelated physical response should retain
its independent cache state. Follow actual browser refresh behaviour; edge purge
cannot clear browser-local chart caches.

Also validate a genuine zero-final-row authoritative removal; a continuity
response whose visible/context interval depends on the changed member; calculated
PM AQI context; fresh and eligible stale proxy entries; and unchanged/source-
unavailable/check-only/dry-run exclusion. Incomplete responses must remain no-store.
Inspect the tag/event identities and actual API rows, not just rendering.

For a deliberately authorised purge failure (for example a temporarily unavailable
one-layer purge credential), verify canonical R2 success is preserved and that
the other layer is recorded independently. Restore the credential and run only
the retry command above. Confirm the same event/tag set is used, accepted chunks
are not re-sent, new attempt audit is retained, and no R2 operations/reconciliation
are performed. A rate-limit failure must expose cooldown, not an immediate loop.

## Structural evidence, rollback and documentation handover

The original standalone esbuild/module checks did not exercise the final pinned
wrangler-action default or route inference. They therefore missed the Wrangler
3.90.0 mismatch and the implicit workers.dev disablement.

Correction checks use Node 22.23.3 and Wrangler 4.130.0 with actual
`wrangler deploy --dry-run`, without externalizing dependencies:

- Station history: existing `wrangler.toml`, deployed TEST Worker name.
- Cache proxy: `wrangler.deploy.toml` generated by the actual workflow's binding/media
  preparation script, existing TEST binding and media origin.
- Reader: TEST configuration generated by the actual workflow's domain-preparation
  script, existing TEST bucket, v3 authority, Custom Domain and explicit workers.dev.

Reader JS syntax, YAML/embedded Bash, Node and Python parsing, the actual station
validator accepting the owned TEST URL and rejecting the old hostname, matching
CLI/action Wrangler pins and
Git whitespace checks supplement those package checks. No functional suite,
synthetic repair or deployment was run. Generated validation configs are removed.
These local checks exercise the deploy command/bundler version selected by the
corrected workflows; they do not claim that new GitHub Actions runs have succeeded.
CodeQL already includes active Python. Exact pre-change active source was preserved
under today's archive convention; archives remain reference-only.

For rollback, first stop new active repair invocations and disable delivery by
withholding the two local purge tokens; retain all pending events for later retry.
Revert only reviewed implementation hunks in normal source paths, preserving
unrelated local work, and redeploy the required TEST Workers in dependency order.
Do not execute archived scripts, revert repaired R2 data or run compensating SQL.
Keep the owned custom-domain authentication boundary and fixed cut-over cache key
while rolling back an individual component: reverting directly to legacy cache
keys can expose pre-tagged stale objects. A full serving rollback must explicitly
retain a fresh TEST cache-key component or temporarily keep those history paths
uncached. Never assume reverting to the old `-4` code alone restores freshness.
Removing the explicit Wrangler pin or workers.dev retention reintroduces the
confirmed deployment/compatibility failures. Local working-tree rollback does not
undo the already deployed reader domain or the proxy secret writes.

Remaining boundaries: the separate future Integrity Factory is not integrated.
The protected frozen `stable-sos-light-v3/` emergency fallback is unchanged and does
not acquire this new automatic post-repair stage; normal active SOS-light and
generic repair paths do. An externally supplied already-held global operation
lock also has no outer post-lock delivery hook: its verified pending event can
be delivered with the operator retry after that lock is released.

Chat-mode system-doc handover should record the implemented tag template,
reader/proxy owning zones, fixed initial marker, bounded audit/retry artifacts,
local credential names, normal active-route integration and the frozen fallback
boundary. Keep implementation/deployment/functional acceptance status separate.
Record the partial deployments/failures above and the authenticated workers.dev
compatibility route boundary; the recovery corrections are still uncommitted and
undeployed. The shared GitHub URL and deployed consumers still need migration.
Add real TEST acceptance evidence only after those operations occur; no LIVE
activation or probe cleanup is included in this task.
