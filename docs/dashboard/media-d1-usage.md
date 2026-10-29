# Media → D1 Usage: TEST implementation and operator handover

Implementation only, 29 October 2026. No dashboard deployment, credential
provisioning, D1 SQL, database changes or LIVE application changes were performed.
The authoritative contracts in `uk-aq-system-docs/system_docs/` remain read-only.

## Behaviour

`dashboard/assets/media.js` adds D1 Usage immediately after Sources, retains
Articles as the default and uses the existing Media cards, pills and errors.
The shared frontend calls only same-origin `GET /api/media/d1-usage`.

The 7/30/90 UTC-day view includes today. A rows-read/rows-written graph has
separate LIVE and TEST series, gaps for missing days, and an accessible bounded
daily table. A UTC-day selector drives both account summaries and the query day.
Today is marked partial. Account-wide totals include **all D1 databases in that
account**, matching account-wide quotas. They are never combined across accounts.
The separate on-demand Top D1 Queries section is scoped to the explicitly
configured Media database in the selected account. It returns at most five
Cloudflare query groups ordered by total rows read, with executions, total reads,
reads/execution and writes where available. SQL text is replaced on the backend
with an allowlisted operation label and a 20-character SHA-256 fingerprint. No
literal, identifier, comment or other provider SQL text reaches the browser/logs.
Fingerprints preserve provider group identity; this is not a SQL replay tool or
an application-specific query classifier.

Each account has independent availability, retrieval timestamps, plan and limits.
Only a confirmed `free` plan with positive configured daily limits produces
percentages. A `paid`, unknown or invalid plan/allowance never receives an assumed
Free allowance. Advisory thresholds are injected settings; the deployment
workflow and local template propose 75% and 90%. Analytics are adaptive and may
be delayed; they are not an exact billing counter or proof of optimisation savings.

## Provider structural evidence and bounds

Reviewed Cloudflare's [D1 analytics documentation](https://developers.cloudflare.com/d1/observability/metrics-analytics/),
[settings-node documentation](https://developers.cloudflare.com/analytics/graphql-api/features/discovery/settings/),
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) and
[current Wrangler insight implementation](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/d1/insights.ts)
on 29 October 2026. The latter uses query count, `sum.rowsRead`, `sum.rowsWritten`,
query/database dimensions, hour filters and `sum_rowsRead_DESC`; its current CLI
limits an insight interval to 31 days. This page requests one UTC day for insights.

Both runtimes load the same fixed queries from
`workers/uk_aq_dashboard_online_api_worker/src/lib/media_d1_queries.json`. Daily sums use
`d1AnalyticsAdaptiveGroups`, grouped **only by date**, with no database filter.
Insights use `d1QueriesAdaptiveGroups`, grouped by query and filtered by the
configured database UUID. The account is always separately specified.

Before data retrieval, the settings query checks dataset availability, required
fields, `maxDuration`, `maxPageSize` and `notOlderThan` for the actual account.
Optional read/write query counts and insight writes are selected only when
available. Daily requests are chunked into at most 31 days, further reduced by
the actual provider query/page limits, with at most 12 daily requests plus one
settings request per account. Insights require a supported one-day window and
five groups, and use at most two requests. Unsupported windows fail explicitly.
Provider responses are capped at 768 KiB each; SQL input is bounded to 100,000
characters before hashing; the browser receives at most 90 daily rows/account
or five insight rows. No raw provider response/error body is returned or logged.

**90-day selection does not imply 90-day retention.** Fully available UTC days
are queried within each account's reported retention. Older days are marked
`outside_retention`; absent groups are `missing`, with null metrics. Only an
explicit provider zero becomes zero. No ingestion/storage is added to fabricate
older history. Account-specific schema/retention access has not been observed
here because no read-only analytics credentials were configured in Codex Cloud.

The deployed implementation baseline was inspected through successful TEST
[Pages run 40901253630](https://github.com/TEST-uk-aq/uk-aq-ops/actions/runs/40901253630)
and [Worker orchestrator run 40901253835](https://github.com/TEST-uk-aq/uk-aq-ops/actions/runs/40901253835),
both at `89f40166394b74202046f271e168c1d12956ddfe`. The orchestrator's
`deploy_dashboard_api / deploy` job succeeded. Its checked-in Media frontend,
route wiring, Accounts trust helpers and deployment configuration were inspected.
No authenticated browser session or deployed analytics route was available;
this is source/deployment provenance, not functional acceptance of this feature.

## API and cache

Allowed selectors only:

```text
GET /api/media/d1-usage?days=7
GET /api/media/d1-usage?days=30&refresh=1
GET /api/media/d1-usage?days=90&view=queries&account=LIVE&day=YYYY-MM-DD
```

`days` is 7, 30 or 90; `view` is daily (default) or queries; `refresh` is 0 or 1.
The account is LIVE or TEST and is accepted only for insights. The day must be
one of the selected range's UTC dates. Duplicate/unknown selectors and arbitrary
URLs, account IDs, tokens, SQL or GraphQL are rejected. Daily selectors cannot
carry an insight account/day. Request queries are limited to 256 characters.

Privileged responses, including auth errors, are always `Cache-Control: no-store`.
No analytics response enters the compatibility edge cache, MySQL or D1. The
15-minute backend cache is process/isolate memory with at most 32 DTO entries,
keyed by credential/account/database identity, product, range and insight day.
Both daily row metrics are cached together. It is best effort and resets when
the Python process or Worker isolate restarts; no globally distributed throttle
or durable cache is claimed. Requests authenticate before any cache lookup.

Manual refresh is limited to once per minute per account/product. New cache
misses are limited to four per minute per account/product, permitting range/day
selection without an upstream request on every parent Media rerender. Concurrent
hosted identical requests coalesce; concurrent local requests use a bounded busy
state. Network/5xx failure may return explicitly stale data, at most one hour old,
with its original successful-retrieval timestamp. Known access/schema failures
clear affected credentials' cached DTOs. Missing/replaced credentials never
select another account's cache. The UI retains only current display state in
memory, does not persist analytics in browser storage and labels aged data stale.

## Configuration to provision later (no values in source)

For **each** `<ACCOUNT>` equal to `LIVE` and `TEST`:

| Name | GitHub target / local source | Meaning |
|---|---|---|
| `UK_AQ_MEDIA_D1_<ACCOUNT>_ACCOUNT_ID` | variable / local .env | Explicit Cloudflare account ID |
| `UK_AQ_MEDIA_D1_<ACCOUNT>_DATABASE_ID` | variable / local .env | That account's Media database UUID; required for insights |
| `UK_AQ_MEDIA_D1_<ACCOUNT>_ANALYTICS_TOKEN` | secret / local .env | Account Analytics: Read, scoped only to the intended account(s) |
| `UK_AQ_MEDIA_D1_<ACCOUNT>_PLAN` | variable / local .env | Confirmed `free`, `paid` or `unknown` |
| `UK_AQ_MEDIA_D1_<ACCOUNT>_DAILY_READ_LIMIT` | variable / local .env | Positive daily rows-read allowance, used only for confirmed Free |
| `UK_AQ_MEDIA_D1_<ACCOUNT>_DAILY_WRITE_LIMIT` | variable / local .env | Positive daily rows-written allowance, used only for confirmed Free |

Also set `UK_AQ_MEDIA_D1_WARNING_PERCENT=75` and
`UK_AQ_MEDIA_D1_CRITICAL_PERCENT=90` (ordered positive integers at most 100).
Cloudflare currently documents 5,000,000 daily reads and 100,000 daily writes for
Free, but the operator must confirm each account's plan and allowance before
configuring those limits. None are inferred from deployment credentials.

Two narrowly scoped tokens are preferred. One token explicitly scoped read-only
to both accounts can instead be supplied separately under the two token names.
Never supply a deployment/admin token or give this feature D1/write privileges.
The existing general Cloudflare read credential is deliberately not reused:
its account/scope semantics do not express these independent Media mappings.
Equal LIVE/TEST account IDs are rejected. Database names are not used for identity.

The checked-in target catalogue `config/uk_aq_github_env_targets.csv` and existing
API Worker deployment workflow contain all names. Runtime settings pass through
the workflow's existing server-only secrets-file mechanism; they are excluded
from generated frontend config. Empty D1 settings are preserved in that file so
a later authorised deployment can disable a previously configured account instead
of silently retaining an old Worker secret. This code change does not itself
provision, remove or change any remote setting. The private ignored
`env-vars-master.csv` is absent in Codex Cloud: the operator must add these names
to their existing catalogue before using its normal secure sync process.

Use `local/dashboard/media-d1-env.example` as the local configuration template.
Reuse existing `UK_AQ_LOCAL_ACCOUNTS_ACCESS_ISSUER` and
`UK_AQ_LOCAL_ACCOUNTS_ACCESS_AUD`; they identify the **local** Access application.
Use the installed backend's existing `requirements.txt`, including PyJWT[crypto].
The complete repository must be present because Python reads the shared GraphQL
template from the Worker source directory. Template changes are covered by the existing Worker deployment path filter. No Tunnel/LaunchAgent/listener changes are needed.

## Authentication decisions

The hosted endpoint reuses `authorizeAccountsRequest`: a personal identity from
the runtime's `ctx.access.getIdentity()`, rejecting missing runtime context and
service-token identities. Caller-provided Access headers are insufficient. The
handler is dispatched before OPTIONS, Media forwarding, upstream mode and caches.
Direct Worker access without runtime-verified identity fails closed.

The local endpoint reuses `authorize_accounts_request`, which verifies the local
Access JWT using the configured issuer, audience, RS256 signing key, validity
claims and personal identity. It intercepts every HTTP method in `parse_request`
before optional bearer auth, Media dispatch and compatibility/MySQL caches. Direct
localhost calls cannot bypass this check. Authentication is not relaxed when
analytics credentials or JWT dependencies are absent. No browser token input,
new login flow or general Cloudflare proxy is introduced.

## Structural verification

The following checks passed, from the Ops repository root unless stated otherwise:

```bash
node --check dashboard/assets/media.js
npm --prefix workers/uk_aq_dashboard_online_api_worker run check
python3 -m py_compile local/dashboard/server/uk_aq_dashboard_media_d1_usage.py local/dashboard/server/uk_aq_dashboard_api_core.py
git diff --check
```

Worker packaging passed using its existing Wrangler 4.130.0 installation with a
local-only dry run and workspace configuration/log/output paths. A disposable hosted boundary
check exercises missing runtime auth (GET/HEAD/POST/OPTIONS), forged Access
headers, bounded/rejected selectors and missing per-account configuration with
zero provider calls. A targeted Python AST check verifies the early all-method
local interception and authentication before account retrieval. Shared query
templates, all 14 workflow variable/secret/target mappings and six exact archive
copies passed structural checks. All three existing workflow shell blocks pass
`bash -n`. No new committed functional test suite is introduced. These checks
do not establish deployed authentication, account access or metric accuracy.

## Later authorised TEST operation: all acceptance checks pending

Do not infer any of these from syntax/type/build checks:

- [ ] Hosted Media → D1 Usage loads through administrative Access.
- [ ] Updated local dashboard shows the same information through its local Access app.
- [ ] LIVE and TEST account-wide daily totals independently match their Cloudflare accounts; insight database UUIDs are correct.
- [ ] 7/30/90 UTC-day views work, including honest retention gaps and missing versus zero.
- [ ] Today is labelled partial in graph, summaries, table and insights.
- [ ] Confirmed Free limits, percentages and 75%/90% indicators are correct; paid/unknown plans have no invented daily allowance.
- [ ] Top five query attribution, counts, reads/execution and writes match Cloudflare; fingerprints expose no SQL literals or metadata.
- [ ] Manual refresh, rate limits, 15-minute cache, aged display and transient-failure stale labels behave correctly.
- [ ] Missing/invalid/revoked credentials fail independently, including both accounts absent, with no cross-account fallback.
- [ ] Direct unauthorised Worker/local API calls and forged/expired/wrong-audience JWTs are denied; service identities are rejected.
- [ ] Browser payloads, page source and logs contain no credentials, account IDs or raw SQL.
- [ ] Existing Articles, AI-title controls, Runs and Sources continue working.

After PR review/merge is separately authorised, use the existing TEST Pages/API
deployment workflows and local TEST update/restart procedure. No deployment or
remote secret-setting command is part of this handover's authorised execution.
Rollback uses the previous compatible TEST Pages/API revision and previous local
revision/restart. There are no schema/data writes to reverse. Exact pre-change
active code is retained under `archive/2026-10-29/` and is never executed.
No contract changes are required; ChatGPT in Chat mode can later update the
authoritative implementation/deployment status after real TEST evidence exists.
