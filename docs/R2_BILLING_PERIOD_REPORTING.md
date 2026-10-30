# R2 operations billing-period reporting

Implementation guide for the shared dashboard, local Python backend and hosted API Worker. Authoritative prose remains in `TEST-uk-aq/uk-aq-system-docs`; the handover below identifies its required updates. This change does not establish deployment or account acceptance.

Required pre-change archives under `archive/2026-10-30/` preserve the original checked-out revision `ea7212e85a01e2dc65b73ed0204d3dca9af73066`. The implementation was subsequently rebased onto newer TEST `main`; those once-per-day archives were retained unchanged. Use the PR's parent revision for rollback to the immediately preceding current application.

## Scope

Class A and Class B analytics use verified Cloudflare current-period timestamps. The existing Standard storage size, object count, 10 GB comparison, percentage and progress bar are unchanged. Storage remains available when billing metadata or operations are unavailable. There are no GB-month, average-storage, cost or additional storage metrics.

The operator has confirmed TEST's date range as the 18th–17th and LIVE's as the 30th–29th where those dates exist. Exact UTC timestamps and missing-date renewal behaviour have not been verified. These observations are acceptance evidence, not runtime recurrence rules. No environment dates are embedded in the implementation and no manual period schedule is supported.

## Environment configuration

Existing configuration is reused:

- Account: `UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID`, otherwise the existing same-environment `CLOUDFLARE_ACCOUNT_ID` setting.
- Analytics token: `UK_AQ_R2_CLOUDFLARE_API_TOKEN`, otherwise the existing same-environment `CFLARE_API_READ_TOKEN`.
- New `UK_AQ_R2_BILLING_SUBSCRIPTION_ID`: the exact R2 subscription identifier, confirmed by the operator and verified at runtime. It must match `[A-Za-z0-9_-]{1,32}` without whitespace. The account must be a 32-character hexadecimal account ID.
- Optional new `UK_AQ_R2_BILLING_API_TOKEN`: a dedicated token restricted to that same account with Account → Billing → Read. Omit this setting entirely to reuse the analytics token, which must then also have Billing Read. An explicitly present empty dedicated token is invalid. A dedicated token that fails is never retried using another credential.

Do not grant Billing Write or substitute a deployment token. GraphQL still requires Account Analytics Read. Neither the subscription ID nor a token value is invented by this change.

Local: set the chosen values in the Ops checkout's existing `.env`, loaded by `local/scripts/run_dashboard.sh` for both HTTP and `--cache-refresh` processes. Do not put the billing token into browser `UKAQ_*` configuration, a committed file or MySQL reader/writer credential files.

Hosted: use a GitHub repository variable for `UK_AQ_R2_BILLING_SUBSCRIPTION_ID` and, only if required, a GitHub secret for `UK_AQ_R2_BILLING_API_TOKEN`. Existing environment-sync target mappings are extended accordingly. Align the operator's ignored `env-vars-master.csv` with those names and classifications; that catalogue is absent from the cloud checkout and has not been fabricated here. The existing synchroniser can then use the updated target CSV. Do not execute it merely to review this PR.

The deployment workflow passes the ID explicitly through `wrangler deploy --var`, including an empty value, so removing its repository variable cannot silently retain a previous ID. The optional token follows the existing nonempty Worker-secret upload mechanism. That mechanism does not delete an already installed secret when its GitHub value is removed: an operator switching back to the existing read token must separately arrange removal of the dedicated Worker secret. No such setting changes are performed by this implementation.

Manual Worker deployments must likewise supply the verified ID through the deployment's environment-specific configuration/`--var`; the committed Wrangler default is empty. This has no calendar-month default. The same code and setting names apply to separately authorised LIVE adoption. Never reuse another environment's values.

## Runtime verification

For the configured account, the resolver reads:

1. `GET /client/v4/accounts/{account_id}/subscriptions/{subscription_id}`.
2. `GET /client/v4/accounts/{account_id}/billable-usage` with no date parameters (current billing period).

It requires the exact subscription ID, monthly frequency, a usable subscription state (`Paid`, `Provisioned`, `Trial` or `AwaitingPayment`), and timezone-aware `current_period_start`/`current_period_end` containing now. It then requires current Billable Usage rows with matching `BillingAccountId`, `SubscriptionId`, `ServiceFamilyName=R2` and `BillingPeriodStart` equal to the subscription start.

This cross-check prevents an unrelated monthly subscription from silently selecting R2's period. If R2 is not exposed by the generic subscriptions API, access is denied, required fields are absent or billing data has not caught up after renewal, operations explicitly report unavailable. Operator acceptance must prove this API contract for the actual TEST account. No unavailable metadata is reconstructed from the confirmed day numbers, charge-period end, anchor, subscription lifecycle end or a fixed interval.

Read-only operator verification before acceptance should inspect those exact returned fields, without copying credentials or the whole billing response into logs. Existing token access, the actual subscription ID, exact timestamps and R2 support in the endpoint remain unverified in the implementation environment, which has no Cloudflare credentials or permitted `api.cloudflare.com` network access.

Official references:

- [Subscription GET and Billing Read permission](https://developers.cloudflare.com/api/resources/accounts/subresources/subscriptions/methods/get_by_identifier/).
- [Current Billable Usage v1](https://developers.cloudflare.com/api/resources/billing/subresources/usage/methods/get_account_usage_v1/). Its billing start is useful for verification; it has no billing-period-end counterpart.
- [Billing permissions](https://developers.cloudflare.com/billing/understand/billing-permissions/).
- [R2 analytics datasets and query limits](https://developers.cloudflare.com/r2/platform/metrics-analytics/).

## API and caching

Existing routes and operation fields are preserved. Successful `r2_usage` responses additionally carry:

```text
billing_period_start_utc
billing_period_end_utc
billing_period_verified_at_utc
billing_period_source = cloudflare_r2_subscription_v1
billing_period_account_id
billing_period_subscription_id
billing_period_error
```

Account/subscription identifiers are nonsecret provenance used to reject mismatched caches. No token or raw billing records are returned. `class_ops_window_start_utc` and `class_ops_window_end_utc` still describe the analytics query, not the next renewal. Queries use `[period start, query cutoff)` in UTC and reject ranges over Cloudflare's 31-day analytics maximum. Slow fetches are checked again before being presented as current.

Process responses, MySQL `r2_metrics`/`metric_context`, latest rolling snapshots and proxy responses validate provenance and period. Legacy calendar-month JSON cannot become current by having a coincidentally matching start date. Invalid or expired operations are nulled with an explicit error; storage fields are retained. Same-period historical snapshots are cumulative, never summed into a total. Rolling history includes period metadata when available; legacy history remains without a verified period.

Successful current products/process caches expire no later than period end. The R2 writer is scheduled at that boundary and retries unavailable metadata on a bounded cadence when static configuration is valid. Invalid static configuration does not generate repeated reader-triggered cloud collections. A successful new R2 collection triggers a new metric-context build, including after an older build was already in flight. No schema migration, new tables, retention change or cache-history deletion is required.

Hosted direct mode remains independent of MySQL. Upstream mode keys its cache by configured billing identity, validates hits and caps cache TTLs at period end; an invalid hit requests a fresh upstream response. Response guards also remove legacy/expired operation counts supplied by an older upstream. Browser responses remain `no-store` through the existing history diagnostics path.

The browser shows the full UTC boundary pair with an exclusive end and separately displays the analytics query cutoff. It labels the operation counts as analytics, not an authoritative invoice or cost. At rollover, or on resuming an expired tab, old bars are hidden before requesting replacement data; retry failures do not restore those bars. It never calculates the next period.

## Refresh

The existing R2 `force=1` route remains supported. Without MySQL, explicit R2 and metric-bearing dashboard Refresh bypass the process R2 cache. With MySQL, the HTTP reader signals the existing environment-local writer marker and returns promptly with additive `r2_refresh_pending` state. Every writer R2 collection bypasses its in-memory usage cache and performs new metadata/metrics requests. A metric-bearing main Refresh also signals that R2 dependency.

The browser follows a pending R2 refresh with short ordinary reads for up to two minutes, without repeatedly signalling new refreshes. It displays pending and the original source timestamp until a post-request collection exists. A still-pending collection may be checked again manually or on a subsequent load. Background fetch time remains dependent on Cloudflare. The storage-calendar Refresh handshake, generation selection, direct R2 presence checks and calendar cadence are unchanged.

## TEST rollout and acceptance

Before deployment, perform syntax/type/configuration parsing only. This implementation adds no test suite. Do not execute the collector or databases as a pre-deployment structural check.

After review and separately authorised TEST activation:

1. Verify the TEST R2 subscription and Billing Read access using the bounded reads above. Compare returned exact UTC dates with the operator-confirmed 18th–17th range. If the endpoint cannot establish them, retain explicit unavailable operations and report the missing metadata/access; do not set a midnight or recurrence assumption.
2. Set the existing configuration mechanisms, then use the normal dashboard API Worker and Pages deployment workflows. This PR does not merge, deploy, run workflows or modify Cloudflare settings. No provider/history deployment or MySQL migration is introduced.
3. Restart **both** local TEST processes after the code/configuration is installed:

   ```bash
   launchctl kickstart -k "gui/$(id -u)/co.uk.chronicillnesschannel.aq.dashboard-cache.test"
   launchctl kickstart -k "gui/$(id -u)/co.uk.chronicillnesschannel.aq.dashboard.test"
   ```

4. In real TEST operation, compare `/api/dashboard` metric context and `/api/r2_metrics` on local and hosted: same verified period, distinct query cutoff, sensible A/B counts for that interval, unchanged storage display and generation diagnostics. Analytics and billing data can lag and are not guaranteed to be invoice-equivalent.
5. Click R2 Refresh and the main dashboard Refresh. Observe a real new Cloudflare collection, advancing R2 `as_of_utc`, pending then completed state, and convergence of metric context. Confirm warm local reads remain MySQL-backed and fast and hosted needs no Mac/MySQL availability.
6. Through controlled TEST configuration changes when authorised, check missing/invalid ID, unrelated subscription, insufficient Billing Read and metadata failure. Expect explicit unavailable A/B, preserved storage and no calendar-month fallback or environment crossover.
7. Observe a genuine renewal: old operation bars disappear, writer collection is due at the returned boundary, new verified metadata replaces them, and neither MySQL nor proxy caches resurrect the old interval. Delayed billing records may temporarily leave operations unavailable. For later authorised LIVE adoption, obtain the actual February and March boundaries; no behaviour for absent 30th/31st dates is inferred here.
8. Confirm calendar-only Refresh still refreshes only its coverage product, existing 30-day retention and failed-collection history preservation remain, and browser assets contain no credentials.

Rollback restores matching frontend/backend revisions and restarts both local processes; existing JSON history is retained and needs no destructive migration. A rollback to calendar-month code must also restore its matching UI, not keep new billing-period labels against old metrics.

## Separate Chat-mode system-document handover

Do not copy this guide into authoritative docs without recording implementation/deployment status. ChatGPT in Chat mode should update these precise contracts:

- `system_docs/dashboards/data_sources.md`: explicit subscription timestamps and R2 Billable Usage identity cross-check; analytics interval versus billing end; operation unavailable semantics. Record that the current Standard storage volume, objects and existing 10 GB comparison/bar are intentionally preserved, with no new billing-period storage metric.
- `system_docs/dashboards/local_mysql_cache.md`: R2 provenance/expiry guards in current products and rolling snapshots, boundary scheduling, unavailable retries, forced writer collection, pending reader responses, post-R2 metric-context refresh, unchanged JSON schema/30-day retention and independent calendar Refresh.
- `system_docs/dashboards/hosted_dashboard.md`: identical Python/TypeScript period semantics, direct process cache and upstream edge validation, partial failure preserving storage, continued exclusion of MySQL from hosted.
- `system_docs/dashboards/operations.md`: new subscription ID and optional Billing Read secret, existing token reuse, target/catalogue mapping, explicit deployment variable, account verification, both local process restarts and rollback. Link from `local_dashboard.md` if needed rather than duplicating the rules.
- `system_docs/dashboards/validation.md`: minimal syntax/type/config checks and evidence from actual TEST collection, force refresh, invalid configuration and rollover. Exact timestamps and February behaviour remain unresolved until authoritative account evidence exists.

No authoritative system-doc file is edited by this implementation. No LIVE code/configuration, database schema or cloud resource is changed.
