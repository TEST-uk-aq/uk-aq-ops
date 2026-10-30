# R2 operations billing-period reporting

Implementation guide for the shared dashboard, local Python backend and hosted API Worker. Authoritative prose remains in the separate system-docs repository; the handover below identifies the required updates. Deployment and operational acceptance are separate from this implementation.

## Scope and pre-implementation contract check

Class A/B analytics use an R2-specific Billable Usage v1 start and, only when adequately verified, an account monthly-cycle end. Standard storage size, object count, the existing 10 GB comparison, percentage and progress bar are preserved exactly. No GB-month, average-storage or cost calculation is introduced.

The operator's actual account evidence establishes that Billable Usage v1 and its info endpoint work with an account-scoped Billing Read token. The R2 usage subscription is **not** retrievable through generic subscription detail (error 1295). The account subscription list works and returns different monthly IDs agreeing on the current boundaries. Usage v2 is Alpha, Restricted and returns error 1171. Neither subscription detail nor usage v2 is a resolver dependency.

Before implementation, the published Cloudflare OpenAPI schemas and billing documentation were checked against that evidence:

- V1 `result` is an array of usage records. `BillingAccountId`, `SubscriptionId`, `ServiceFamilyName` and `BillingPeriodStart` support the required identity/start selection. The no-query route is described as current-period usage, but real responses can contain historical rows too.
- Info `result` is an object with `covered` and `subscriptions`. Subscription items have `id`, `start_timestamp`, `billing_cycle_anchor_timestamp` and an optional cancellation `end_timestamp`. Info has no R2 family discriminator: its subscription ID must be joined to the R2 usage rows.
- V1 deliberately has **no authoritative BillingPeriodEnd**. The schema explicitly warns against calendar arithmetic. Charge-period ends, subscription lifecycle ends and anchors are not renewal boundaries.
- The account subscription list has no pagination parameters and is documented to list all account subscriptions. Its monthly frequency, usable state, ID and timezone-aware `current_period_start`/`current_period_end` can supply corroborating current-cycle boundaries. The IDs need not equal the R2 usage subscription ID.
- Cloudflare documents an account-wide monthly billing cycle (annual subscriptions have another cycle), but also documents replacement usage subscriptions with separate cycles. Therefore account scope or an arbitrary monthly row alone is insufficient: the complete usable monthly set must agree and match the R2-specific start.

This is structurally viable with the existing account, subscription and token settings. No new setting or wider permission is required. Actual account field values, usable states and runtime convergence remain post-deployment acceptance checks; this environment has no Cloudflare credentials or permitted Cloudflare API access.

Official references:

- [Billable Usage v1](https://developers.cloudflare.com/api/resources/billing/subresources/usage/methods/get_account_usage_v1/) and [published schemas](https://github.com/cloudflare/api-schemas/blob/main/openapi.yaml), especially `billable-usage-api_usage_record` and `billable-usage-api_usage_info_response`.
- [Account subscription list](https://developers.cloudflare.com/api/resources/accounts/subresources/subscriptions/); `current_period_end` is the end of the current period and when next billing is due.
- [Account monthly and annual billing cycles](https://developers.cloudflare.com/billing/understand/how-billing-works/#billing-cycles).
- [Billable usage subscription replacement and separate cycles](https://developers.cloudflare.com/billing/manage/billable-usage/#switch-between-subscriptions).
- [Billing permissions](https://developers.cloudflare.com/billing/understand/billing-permissions/).
- [R2 analytics datasets and query limits](https://developers.cloudflare.com/r2/platform/metrics-analytics/).

## Environment configuration

Reuse the existing settings, all from the intended environment:

- Account: `UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID`, otherwise the existing same-environment `CLOUDFLARE_ACCOUNT_ID`. A 32-character hexadecimal ID is required.
- Analytics credential: `UK_AQ_R2_CLOUDFLARE_API_TOKEN`, otherwise the existing same-environment `CFLARE_API_READ_TOKEN`, with Account Analytics Read.
- `UK_AQ_R2_BILLING_SUBSCRIPTION_ID`: the **R2 usage** subscription ID, matched between R2 v1 rows and info, not one of the unrelated IDs in the generic account subscription list. Format remains `[A-Za-z0-9_-]{1,32}` without whitespace.
- `UK_AQ_R2_BILLING_API_TOKEN`: optional dedicated Account Billing Read credential scoped to the same account. The operator's working dedicated token fits this existing setting. If omitted entirely, reuse the analytics credential, which must then also have Billing Read. An explicitly empty dedicated credential is invalid; a failing dedicated credential is never retried with another credential.

No Billing Write, deployment token, manual start/end, day-of-month, alternative account or v2 permission is needed. The selected account never changes in response to an API failure.

Local values belong in the Ops checkout's existing `.env`, loaded by `local/scripts/run_dashboard.sh` for both HTTP and cache-refresher processes. Do not put secrets in browser `UKAQ_*` settings or MySQL credential files.

Hosted values use the existing GitHub variable for the subscription ID and optional GitHub secret for the billing token, with the existing `config/uk_aq_github_env_targets.csv` mappings and Worker workflow. No mappings, Wrangler variable declarations or deployment workflow changes are needed by this correction. The ignored operator `env-vars-master.csv` is absent from this cloud checkout: retain/align the existing two entries locally, without creating another catalogue.

The existing workflow passes the ID explicitly via `--var`, including empty values. Manual deployments must also supply it; the committed default is empty. The existing nonempty-secret mechanism does not delete an installed Worker secret when its GitHub value is removed. Switching back to the analytics token therefore requires deliberate removal of the dedicated Worker secret through the separately authorised configuration process.

## Resolver and failure semantics

The resolver performs only these account-scoped GETs, using the selected billing credential:

1. `billable-usage/info`: require `covered=true`, exactly one entry for the configured R2 usage ID, valid timezone-aware lifecycle/anchor timestamps no later than now, and no cancellation end.
2. `billable-usage`, without date parameters: filter by exact account, configured subscription and R2 family. Select the **latest valid nonfuture start** no earlier than the subscription lifecycle start or anchor. Historical starts in the same response are expected and do not cause an all-rows-equal check.
3. `subscriptions`: accept an end only if at least one usable monthly row exists, all usable monthly rows have distinct valid IDs and the exact R2 start, and all agree on a single valid end containing now. Valid usable states remain `Paid`, `Provisioned`, `Trial`, `AwaitingPayment`. Known retired states and known nonmonthly frequencies are excluded. Unknown/malformed eligible rows, conflicting starts/ends, duplicates, empty results and access failures prevent end verification. The period cannot exceed the analytics 31-day bound.

The generic account subscriptions corroborate the documented monthly account cycle; they do not establish R2 subscription ownership. Their IDs are recorded separately. No list order, rate-plan name, ID equivalence, environment date or calendar recurrence is assumed.

When the end cannot be verified, return **start-only reporting**: preserve the R2 start, anchor, lifecycle and identity provenance, set end/source to null and IDs to an empty array, and report `start_only` with an explicit error. A fresh response containing an old start is not proof of renewal. Consequently current Class A/B values, percentages and query windows remain null and no operations query runs in this mode. Storage remains available. No zero figures are fabricated.

Start-only metadata is fresh for at most five minutes; fully verified metadata is fresh for at most one hour, capped at the returned end. Both have a conservative maximum reported-start age of 31 days. These are reporting safety limits, **not calculated billing ends**. Expiry reports `stale`, hides current operation figures and requires fresh upstream verification. Failed renewal never extends an old current interval. An unavailable/missing source remains explicitly unavailable.

## API and caches

Existing routes and operation fields are preserved. R2 JSON carries:

```text
billing_period_source = cloudflare_r2_billable_usage_v1
billing_period_start_utc
billing_period_end_utc                         # nullable
billing_period_verified_at_utc
billing_period_fresh_until_utc                 # freshness deadline, not a billing end
billing_period_account_id
billing_period_subscription_id                 # R2 usage ID
billing_period_anchor_utc
billing_period_subscription_start_utc
billing_period_end_source = cloudflare_account_monthly_subscriptions_v1  # nullable
billing_period_end_subscription_ids             # distinct generic monthly IDs
billing_period_status = verified | start_only | stale | unavailable
billing_period_error
```

Unavailable metadata has an explicit error/status and may lack the other provenance fields. No raw billing records or credentials are returned. `class_ops_window_start_utc` and `class_ops_window_end_utc` describe the analytics query `[R2 start, query cutoff)`, distinct from the exclusive billing end. The existing 31-day analytics maximum and post-query validity check remain.

Python and TypeScript guards reject legacy source markers, wrong account/subscription, missing provenance, expired freshness and expired/unverified ends. They null only operations and preserve storage. Process caches, MySQL current products/latest snapshots, composed metric context, upstream proxy caches and browser rendering enforce this boundary. Successful cache TTLs are capped by freshness, including renewal; invalid responses are retried on a bounded one-minute cadence when configuration is valid. A stale/error response may be retained for one minute while its operation values remain null. This prevents reader traffic from repeatedly calling billing APIs.

The writer remains hourly in normal verified operation, is due no later than freshness/renewal, and retries start-only/unavailable metadata every minute. Rolling history retains the new provenance alongside its existing cumulative snapshot values. Snapshots are never summed, legacy rows are never relabelled, JSON schema/tables and 30-day retention are unchanged. No history deletion or migration is needed.

The browser shows the verified UTC pair and exclusive end or the reported start with an explicit end/renewal-unavailable or stale label. It hides expired bars before reading replacements, including after tab resume, and polls start-only/unavailable states each minute while active. Hosted mode remains independent of local MySQL. Analytics may lag and are not authoritative invoices.

## Existing Refresh and calendar behaviour

Explicit R2 and metric-bearing main Refresh retain the existing force/bypass path. With local MySQL, readers signal the same writer marker, return promptly with `r2_refresh_pending`, and follow pending work with short reads for up to two minutes. Each writer collection bypasses its process cache. Successful R2 collection schedules metric-context rebuilding, including when an older build is in flight. Without MySQL, force Refresh directly bypasses the process cache.

Storage-calendar Refresh, history-generation selection, direct R2 day-presence checks, calendar cadence, failure preservation and unrelated dashboard functionality are unchanged.

## TEST activation and acceptance

This PR does not merge, deploy, change settings, call collectors or access databases. Pre-deployment checks are Python/JavaScript syntax, Worker types and existing configuration/schema viability only. No speculative tests are added.

After review and separately authorised TEST deployment:

1. Set the existing same-account subscription ID and working dedicated Billing Read token using the mechanisms above. Do not replace the R2 ID with a generic monthly ID. Use the normal dashboard API Worker and Pages workflows and restart **both** local HTTP and cache-refresher processes using the existing commands in `local/dashboard/README.cache.md`.
2. Inspect only the bounded GETs above, without logging credentials or entire billing responses. Confirm exact account/R2 identity, info coverage/lifecycle/anchor, latest R2 start, usable monthly states and agreeing start/end. Verify that historical R2 rows do not block current selection and that subscription detail/v2 are never called.
3. Compare `/api/r2_metrics` and metric-bearing `/api/dashboard` locally and hosted against those actual UTC boundaries. Check end provenance lists the contributing generic IDs separately from the R2 ID. Compare Class A/B with analytics queried over that interval; preserve Standard storage size/objects/10 GB/bar exactly.
4. Click R2 and main Refresh. Confirm real new collections, advancing source timestamps, pending-to-complete state and metric-context convergence. Warm local reads remain MySQL-backed; hosted operation requires no Mac/MySQL availability.
5. With separately authorised controlled configuration/API failure conditions, verify missing/invalid ID, wrong account/subscription, denied billing access, unavailable subscriptions and disagreeing monthly periods. Valid R2 metadata plus an unverifiable end must show the reported start and null current operations; failed/stale verification must never restore old A/B counts. Restore configuration afterwards.
6. Observe a real renewal and an open/resumed tab: expiry hides old bars first; the writer polls; updated account boundaries with delayed R2 rows produce start-only/unavailable operations; matching new R2 metadata then restores current figures. Check process, MySQL, proxy and composed responses all converge. Do not fabricate a short billing period to simulate renewal.
7. Confirm calendar-only Refresh remains independent, failed collections preserve storage/history, retention remains 30 days, and no credentials appear in browser assets/responses.

Rollback restores matching frontend/backend revisions and restarts both local processes, retaining JSON history. Reverting only this correction restores PR #147's unsupported resolver and is expected to make operations unavailable again. Use this PR's parent revision for exact rollback; once-per-day archives are reference snapshots, not necessarily that immediate parent. Existing daily archives are retained unchanged; newly archived resolver modules preserve their exact pre-correction contents.

## Separate Chat-mode system-doc handover

Authoritative system_docs are not edited. ChatGPT in Chat mode should update:

- `system_docs/dashboards/data_sources.md`: R2 v1 identity/latest-start selection, info lifecycle/anchor cross-check, conditionally corroborated account monthly end, start-only/unavailable/stale semantics, query cutoff versus renewal; preserve all Standard storage metrics.
- `system_docs/dashboards/local_mysql_cache.md`: freshness-capped products, latest/history provenance, renewal polling, null stale operations, existing Refresh/pending/metric-context handling and unchanged tables/retention/calendar behaviour.
- `system_docs/dashboards/hosted_dashboard.md`: identical resolver/guards, direct/upstream expiry, partial failure preserving storage, no MySQL dependency.
- `system_docs/dashboards/operations.md`: reuse existing R2 ID/dedicated Billing Read settings and mappings, distinguish usage and generic IDs, three bounded GETs, both local restarts, coordinated rollback.
- `system_docs/dashboards/validation.md`: actual TEST identity, mixed historical/current rows, agreeing/mismatching monthly boundaries, start-only/stale handling, Refresh and genuine rollover acceptance. Record acceptance evidence only after deployment.
