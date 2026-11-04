# TEST station-history version comparison: implementation and operational handover

This is code-only delivery for later review. No merge, deployment, invocation,
Cloudflare resource/configuration change or traffic allocation was performed.
The historical Stage 3/Stage 4 Workers, AQI mathematics, source readers, R2
indexes and preserved numerical baseline are unchanged. LIVE is out of scope.

## Structural viability and implementation

All six required boundaries were established before implementation:

1. The existing historical comparison adapter supplies `fetchApi` to the shared
   calculated client. Its run-scoped wrapper can attach selection without
   changing ordinary chart clients, controllers or rendering.
2. Both `/api/aq/station-series` and progressive `/api/aq/timeseries` pass through
   the authenticated cache proxy. Their feature flags must still select the
   private station-history route; unavailable routes fail without direct fallback.
3. The proxy calls `env.STATION_HISTORY.fetch(new Request(...))`, the documented
   HTTP Service Binding interface for version overrides.
4. Normal fresh/stale Cache API ownership can be bypassed using the existing
   `shouldUseCache` and stale-support gates, without changing ordinary requests.
5. Normal routing omits selection entirely. `stage3` and `stage4` are explicit
   logical labels; no UUID or physical Worker name is accepted from the browser.
6. The existing approved Worker-name variable/resolver supplies both the Service
   Binding and the runtime dictionary key. GitHub variables supply UUIDs through
   the existing generated Wrangler configuration; the secret-bulk step supplies
   the separate operator credential.

The website retains Source, UTC range, three-/seven-day older chunks, Load /
repeat, Refresh and diagnostics download. Worker selection is deliberately
disabled/reset to Normal TEST for JSON and hybrid sources, with an explanation.
JSON requests never carry comparison headers. No shared public chart defaults
or source-selection policy changed. The Worker still owns the initial head span.

Load / repeat creates a new controller/cache. Selection or operator-token edits
destroy/abort the old controller and invalidate its run. The cache contract
includes the logical version. Refresh retains the controller and its existing
same-version cache/retry semantics; use Load / repeat for fresh CPU comparisons.
Every concurrently scheduled calculated fetch captures its current run's token
and selection. Aborted/obsolete dispatches and responses are rejected; old events
cannot be recorded against another selection. No second chart is implemented.

## Request and authentication contract

Normal TEST sends neither comparison header. Selected calculated requests send:

```text
X-UK-AQ-Station-History-Version-Selection: stage3 | stage4
X-UK-AQ-Station-History-Version-Operator-Token: <dedicated operator credential>
```

The proxy requires the existing allowed-Origin policy and a valid signed,
origin-bound session cookie, then `UK_AQ_ENV_NAME=TEST`, an eligible GET route,
a configured 32–512-character dedicated token and constant-time token equality.
Local-development/session bypass credentials do not satisfy this check. The
prototype's bounded token-validation pattern is reused, with a separate secret
to avoid sharing prototype authority. Session/CORS failures retain existing
error semantics. Unknown labels are 400, invalid/missing comparison configuration
is 503, absent/invalid operator authority is 403 (unconfigured authority 503),
and non-TEST selection is 403. Existing disabled-route 404s remain possible.

Only after validation does the proxy construct:

```text
Cloudflare-Workers-Version-Overrides: <configured-physical-worker>="<configured-version-uuid>"
```

The key is a validated lower-case Structured Fields dictionary key (at most 63
characters); both UUIDs must have canonical UUID shape and differ. The value is
a quoted, lower-case UUID string. This header is set only on the eligible
`STATION_HISTORY.fetch()` request. Fresh internal headers exclude browser raw
Cloudflare overrides, operator credentials and session cookies. Other services,
prototype paths and public charts cannot acquire selection through this code.
CORS adds only the two browser comparison headers and exposes the three
requested-version diagnostic headers; raw Cloudflare overrides are not allowed
by preflight. Existing Origin policy is unchanged.

The password field uses `autocomplete=off`; the token is captured only in the
page's transport closure, cleared from the field on pagehide, and never placed
in config objects, URLs, local/session storage, diagnostics or application logs.
Selected browser requests reject redirects. Operators must not capture raw
credential-bearing request headers in exported HARs or external logging.

## Configuration catalogue and injection

| Name | Source / injection | Validation and purpose |
| --- | --- | --- |
| `UK_AQ_ENV_NAME` | Existing GitHub variable / existing runtime secret injection | Exact `TEST` required for selection. |
| `UK_AQ_STATION_HISTORY_WORKER_NAME` | Existing GitHub variable, approved resolver, same placeholder in `[[services]]` and `[vars]` | Reused physical identity; browser never chooses it. |
| `UK_AQ_STATION_HISTORY_STAGE3_VERSION_ID` | New GitHub variable; cache-proxy workflow writes generated Wrangler `[vars]` | Approved pre-PR-181 version; UUID syntax; differs from Stage 4. |
| `UK_AQ_STATION_HISTORY_STAGE4_VERSION_ID` | New GitHub variable; same injection | Approved post-PR-181 version; UUID syntax; differs from Stage 3. |
| `UK_AQ_STATION_HISTORY_VERSION_OPERATOR_TOKEN` | New dedicated GitHub secret; existing protected temporary secret-bulk payload | Random 32–512 ASCII characters; never a Pages build value. |

Existing allowed origins, edge-session signing/upstream secrets and station-series/
timeseries route flags remain required. The generic cache-bypass secret is not
shared with the browser: successful comparison authorisation implies a narrowly
scoped response-cache bypass. An explicit existing `cache=bypass` request still
requires its original bypass credential; the page does not add that query.

Both UUID defaults are empty. Normal traffic needs none of the comparison
configuration. If either UUID is supplied at deployment, the workflow requires
TEST, both valid UUIDs and different values. Runtime checks independently fail
closed. A supplied operator secret is checked for TEST and length before bulk
upload. UUIDs and Worker name are not source constants; account IDs, API bases
and credentials use their existing configuration owners.

`config/uk_aq_github_env_targets.csv` registers the two variables and one secret;
this handover documents their purpose and injection. No `env-vars-master.csv`
exists in the supplied implementation workspaces. If maintained externally,
its owner must add the same three entries; no system-documentation file was edited.

Removing a GitHub secret alone does not delete a previously uploaded Worker
secret: secret bulk preserves omitted keys. Disable selection by clearing both
UUID variables and performing an approved proxy deployment, or separately
authorise deletion of its dedicated runtime token. Never alter ordinary secrets.

## Cache and diagnostic isolation

Explicit selection disables all normal proxy fresh/stale cache lookups, writes
and stale fallback. Conditional browser headers are not forwarded. Responses
have `Cache-Control: no-store`, `X-UK-AQ-Cache: BYPASS`, no ETag/Last-Modified and
no proxy Cache-Tag. An unexpected upstream 304 fails as 502 rather than reusing
another version's body. HTTP failures retain their upstream status and are not
replaced by stale success. Existing source-proof headers and response bodies
are retained; low-level source-object caching is unchanged and must be measured.

Downloads use schema 3 and include logical requested version, configured UUIDs
observed in response headers, run start, exact selected range, older chunk size,
per-request UTC start/settlement, head/older classification, HTTP status, browser
settlement/transfer/parse timing and existing source completeness/fetch counts.
There are no observation/AQI arrays or credentials in diagnostics. Requests that
fail before forwarding may have no configured UUID metadata.

The proxy's `Requested-Version-ID` proves only what it requested. It cannot prove
what Cloudflare executed. The UI/download always retain
`verified_executed_version: null`, `version_verification: unverified` and
`comparison_valid: false`. They never promote HTTP 200 into successful override
verification. Browser elapsed time is not Worker CPU time.

## Validation evidence and limits

- JavaScript/TypeScript syntax checks and `git diff --check` passed.
- The existing website station-history loader harness passed.
- A focused local adapter check passed selection on head/older/concurrent
  requests, omission in normal/JSON/hybrid modes, obsolete-response rejection,
  start/settlement timestamps and credential exclusion.
- A local 28-scenario proxy boundary check passed real signed-session validation,
  dedicated operator checks, environment/configuration failures, both routes,
  concurrent forwarding, raw-override sanitisation, conditional-response refusal,
  error propagation, CORS and ordinary traffic without comparison configuration.
  Selected requests made zero proxy Cache API reads or writes.
- Workflow YAML and every shell step parsed. Seven empty/valid/invalid injection
  cases passed; generated Service Binding and runtime Worker identity matched,
  and new catalogue entries have the correct variable/secret targets.
- The three directly relevant existing proxy test files report **19/22 passing**.
  The same three failures reproduce on untouched current source: deployment-test
  expectation of two literal deploy commands versus one; expected station-series
  cache contract `3` versus `5-explicit-response-parts`; and the stale validator's
  unsupported-contract expectation. They were not repaired outside this scope.
- Deno type checking reports the same eight nullable-upstream-route errors on
  untouched current source and modified source; no new type errors were found.

These are bounded local checks, not a green full suite, deployed acceptance,
proof of actual version selection, numerical parity or Worker CPU improvement.
Local focused harnesses remain scratch work; no speculative broad suite was added.

## Later operational plan — do not execute without separate approval

1. Preserve the accepted complete August 11–18, 2026 response unchanged:
   SHA-256 `3c679301c9ad9daac36780396ab5aebefbdf03b9640fd12d127e18cf8bc62e7b`,
   168 AQI rows and 168 observations. Do not recreate it from modified code.
   Record approved existing Stage 3/Stage 4 UUIDs, physical Worker, account,
   deployment ID and immediately preceding rollback state. Inspect immutable
   versions/bindings using the existing configured account credentials.
2. Coordinate a deployment freeze for station history, including workflows,
   secret changes and manual deployments. Its existing
   `.github/workflows/uk_aq_station_history_deploy.yml` runs on matching `main`
   pushes and workflow dispatch, uploads secrets and executes ordinary
   `wrangler deploy --name ...`. That can replace a two-version deployment with
   one newly deployed version at 100%. Do not run it during the experiment.
   No workflow setting or Cloudflare deployment was changed by this delivery.
3. Under the future approval, inspect the current deployment and existing
   immutable version identities, then create a deployment containing **Stage 4
   at 100% and Stage 3 at 0%**. Both must be active deployment members, not merely
   uploaded previews. Example commands, with approved environment variables and
   the existing account selection already established:

   ```bash
   npx --yes wrangler@4.130.0 deployments list --name "$UK_AQ_STATION_HISTORY_WORKER_NAME"
   npx --yes wrangler@4.130.0 versions view "$UK_AQ_STATION_HISTORY_STAGE3_VERSION_ID" --name "$UK_AQ_STATION_HISTORY_WORKER_NAME"
   npx --yes wrangler@4.130.0 versions view "$UK_AQ_STATION_HISTORY_STAGE4_VERSION_ID" --name "$UK_AQ_STATION_HISTORY_WORKER_NAME"
   npx --yes wrangler@4.130.0 versions deploy "${UK_AQ_STATION_HISTORY_STAGE4_VERSION_ID}@100%" "${UK_AQ_STATION_HISTORY_STAGE3_VERSION_ID}@0%" --name "$UK_AQ_STATION_HISTORY_WORKER_NAME" --yes
   npx --yes wrangler@4.130.0 deployments list --name "$UK_AQ_STATION_HISTORY_WORKER_NAME"
   ```

   The last two commands mutate/inspect deployment state and are examples only.
   Verify globally active membership before any measurements. Do not upload or
   edit either historical Worker, and do not introduce a public Worker URL.
4. Configure the TEST repository variables and dedicated operator secret above;
   retain existing allowed origins, session and source authentication. Coordinate
   the approved Ops merge/deployment first, then the approved website deployment.
   Both repositories deploy on `main` pushes: merging is operationally relevant,
   and must wait for separate approval. Use the existing cache-proxy and Pages
   workflows with approved revisions. No station-history source deploy is needed.
5. Smoke-check Normal TEST, denied credentials/origins, invalid configuration and
   both selected versions before measuring. Inspect CORS/BYPASS/no-store and
   absence of conditionals. Independently establish actual version routing below.
6. If a 0% override is ignored or cannot be proved, **stop the experiment**.
   Do not automatically retry normal routing or switch to 1%/99%. Safe next
   decisions are to wait for a Cloudflare resolution or seek explicit approval
   for a revised experiment (for example a separately reviewed nonzero split,
   isolated service, or serial single-version comparison). Each changes scope,
   routing/resources or normal traffic and requires its own review/approval.

## Independent version verification and future TEST acceptance

Use Cloudflare invocation analytics for the configured physical station-history
Worker and the downloaded UTC request windows, with GraphQL **`scriptVersion`**
as the executed version identity. Correlate each measured range and request
class with invocation records/request URL and timestamps; use invocation logs
where needed for exact correlation without recording credential headers. Check
analytics sampling and resolution: an aggregate, sampled or ambiguous window
that cannot establish every measured request is insufficient. Keep the browser
report unverified and reject the comparison until independent evidence exists.
Require one expected configured UUID per selected run and actual `scriptVersion`
equality for every measured invocation. An echoed requested UUID is not evidence.

Cloudflare documents membership in the current deployment, quoted dictionary
values and fetch Service Binding support, but
[workers-sdk issue #15536](https://github.com/cloudflare/workers-sdk/issues/15536)
reports silent normal routing for a 0% Service Binding target. The issue was open
when reviewed. This implementation neither works around nor resolves that
platform limitation. See the
[Cloudflare version override documentation](https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/).

After separately authorised TEST deployment, use AURN PM10 connector 1,
timeseries 43, station 1581. Compare identical August and September settings,
seven-day older chunks and request classes; keep the initial stable head separate
from older-history requests and any shorter range-boundary chunks. The seven-day
setting preserves the existing full-month charts; identify each exact seven-day
request by its downloaded start/end bounds. Select Stage 3/4 and use Load / repeat
for each cold browser-chart run. A Refresh run may reuse same-version historical
chart records and must not be mixed with cold-run measurements.

For every request confirm executed version, range/class, expected R2 fetch count,
HTTP success, separate observation/AQI completeness, numerical response and cache
behaviour. Low-level reader caches are unchanged: match/record source work rather
than assuming they are cold. Compare the retained baseline without regenerating
it. Collect actual station-history CPU (independently from proxy/reader CPU),
medians, maxima, over-10-ms frequency, errors and completeness across matched
classes; use sufficient unsampled evidence for the reported statistics. Avoid
concurrent profile captures. No browser wall-time result establishes CPU savings.

## Restore and rollback

After the approved experiment, restore ordinary single-version **Stage 4 at
100%**, verify its active deployment and normal invocations, clear comparison
UUID variables and deploy the approved disabled proxy configuration if retiring
the control. Example restoration (future approval only):

```bash
npx --yes wrangler@4.130.0 versions deploy "${UK_AQ_STATION_HISTORY_STAGE4_VERSION_ID}@100%" --name "$UK_AQ_STATION_HISTORY_WORKER_NAME" --yes
npx --yes wrangler@4.130.0 deployments list --name "$UK_AQ_STATION_HISTORY_WORKER_NAME"
```

If rollback is needed, first stop measurement and choose Normal TEST. Restore
the recorded approved single-version deployment, then restore the previous
proxy/website revisions through normal reviewed source/deployment processes.
Retain the existing session/upstream secrets, source data and response baseline.
The dated archives are exact pre-change reference copies, not active fallbacks.
No comparison response purge is needed because selected responses were never
stored. Re-enable normal automated deployment only after the single-version
state is confirmed and the experiment freeze is deliberately released.

## Read-only system-documentation handover

Add a narrow TEST version-selection section to the owning station-chart and
station-history/cache-proxy contracts: logical headers, real-session plus dedicated
operator gate, runtime/injection catalogue, no-store/conditional isolation,
run ownership and telemetry-only verification. Record the 0% limitation and
ordinary-deploy replacement risk. Website deployment needs no asset-identity
contract amendment: existing build-time hashing remains the owner. No algorithm,
source-proof, R2 index, normal chart route or LIVE contract changed.
