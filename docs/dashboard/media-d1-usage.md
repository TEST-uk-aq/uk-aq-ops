# Media D1 Usage implementation handover

This corrects merged [PR #145](https://github.com/TEST-uk-aq/uk-aq-ops/pull/145).
Its dual-account architecture and configuration instructions are superseded.
Authority is the 29 October 2026 correction to
[Media dashboard section 11](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/main/system_docs/dashboards/media_dashboard_contract.md#11-media-d1-usage-mini-page-environment-local-analytics-corrected-29-october-2026),
together with `hosted_dashboard.md`, `local_dashboard.md` and
`architecture_contract.md` in that authoritative area. System documentation
remains read-only for this implementation.

## Architecture

**One dashboard = one environment = one Media Cloudflare account.**
The separately deployed TEST dashboard reads only its configured TEST Media
account. After acceptance, the operator may separately promote complete approved
files to LIVE with LIVE external values. Both use identical code, setting names
and templates. There is no account selector, comparison graph, second summary,
environment-labelled credential lookup or fallback. Hostname, environment label
and browser storage cannot select an account.

Media → D1 Usage retains 7/30/90 UTC-day history, rows-read/rows-written metric
selection, an accessible table, selected-day summary, today/partial labels,
missing/retention gaps, allowance progress, warning/critical indicators,
on-demand top-five fingerprints and manual Refresh. Other Media pages and
health operate independently of analytics availability.

Cloudflare GraphQL account analytics is the source. Daily totals include **all
D1 databases in the current Media account**, matching the account-wide Free
allowance. Query insights use only its explicitly configured Media database UUID.
The dashboard never runs SQL against Media tables to measure usage and never
persists analytics in D1 or MySQL. Adaptive analytics may be delayed or sampled;
missing data is unknown, not zero.

## Three required settings

The same names apply to hosted and local backends:

| Name | TEST Ops GitHub source | Meaning |
| --- | --- | --- |
| `UK_AQ_MEDIA_CLOUDFLARE_ACCOUNT_ID` | Actions Variable | Current environment's Media account ID |
| `UK_AQ_MEDIA_CFLARE_D1DB_ID` | Actions Variable | Its Media database UUID, not a name |
| `UK_AQ_MEDIA_D1_ANALYTICS_TOKEN` | Actions Secret | Account Analytics: Read token scoped to that account |

The first two reuse Media's existing identity names; their Ops target catalogue
entries were absent and are added exactly once. The analytics token is distinct
from write-capable deployment and Media admin tokens. All values remain in
server-side settings, never generated browser configuration. Missing/invalid
account, database or token configuration makes this feature explicitly
unavailable before cache/provider reads, without disrupting the rest of Media.

### Operator token migration and cleanup

The existing TEST analytics-only token is currently stored under
**`UK_AQ_MEDIA_D1_TEST_ANALYTICS_TOKEN`**. The operator must re-add its **existing
value**, without revealing it or rotating it for this correction, under
**`UK_AQ_MEDIA_D1_ANALYTICS_TOKEN`** in **TEST Ops GitHub Secrets and local TEST
Ops `.env`**. Codex has not read, exposed, copied or modified the secret value.
There is no automatic fallback to the old name.

Remove obsolete `UK_AQ_MEDIA_D1_LIVE_*` and `UK_AQ_MEDIA_D1_TEST_*` entries from
the operator's active local `.env`/catalogue. Separately review obsolete TEST
GitHub/Worker bindings after acceptance; remote cleanup requires separate
operator authorisation. This PR does not delete or synchronise remote secrets.
Unused old bindings cannot select a target in the corrected code. Preserve the
existing Media identity settings and all unrelated bindings. No LIVE changes
are authorised here.

## Shared Free-plan defaults

Both Media accounts permanently use Cloudflare D1 Free. No PLAN setting or
plan-dependent runtime branch remains. Both backends define these common
product limits/UI policy in code; no override variables are required:

| Setting | Built-in default | Optional environment-neutral override |
| --- | ---: | --- |
| Daily rows read | 5,000,000 | `UK_AQ_MEDIA_D1_DAILY_READ_LIMIT` |
| Daily rows written | 100,000 | `UK_AQ_MEDIA_D1_DAILY_WRITE_LIMIT` |
| Warning | 75% | `UK_AQ_MEDIA_D1_WARNING_PERCENT` |
| Critical | 90% | `UK_AQ_MEDIA_D1_CRITICAL_PERCENT` |

Supplied overrides must be positive decimal safe integers; thresholds must
satisfy `0 < warning < critical <= 100`. Explicit empty, malformed, non-positive
or invalidly ordered runtime values produce `INVALID_ALLOWANCES` and clear
unavailability, never silent defaults. Leave local overrides **unset**, not
empty, to use defaults. Limits are currently confirmed Free-plan allowances,
not a guarantee that Cloudflare will never change them.

## Hosted and local configuration

The TEST deployment workflow reads the two identity Actions Variables and the
analytics Actions Secret through its existing private temporary `--secrets-file`
mechanism with pinned Wrangler. Optional overrides are passed only when non-empty
in Actions; they are not deployment prerequisites. Only the three required
feature names are included even when empty, preventing a missing required value
from silently retaining an old target. Unrelated empty settings remain omitted.
No secret deletion/synchronisation or full replacement of bindings is added.

Omitted optional overrides preserve existing remote bindings under Wrangler's
normal behaviour. To restore a previously configured Worker override to its code
default, the operator must separately remove that exact override binding;
clearing its GitHub Variable alone does not delete it. Do not delete unrelated
bindings. This PR performs no such action.

Local TEST uses its own checkout's existing `.env` loader; see
`local/dashboard/media-d1-env.example`. Reuse the existing Accounts signed Access
JWT verifier, local-only `UK_AQ_LOCAL_ACCOUNTS_ACCESS_ISSUER` and
`UK_AQ_LOCAL_ACCOUNTS_ACCESS_AUD`, and installed `PyJWT[crypto]` dependency from
`local/dashboard/server/requirements.txt`. Preserve the working Tunnel, listener
and local Access application. A hosted hostname is not a substitute for local
Access trust. The supported entrypoint is `local/scripts/run_dashboard.sh`.

The operator's private `env-vars-master.csv` is not tracked or available in Codex
Cloud. Align its three required names and, only if used, optional common names
with `config/uk_aq_github_env_targets.csv`; remove obsolete dual-account/PLAN
entries. Do not run environment synchronisation scripts as part of this PR.

## Endpoint and DTO

Both backends expose `GET /api/media/d1-usage`, allowing only:

- `days=7|30|90` (default `7`);
- `view=daily|queries` (default `daily`);
- `day=YYYY-MM-DD` for queries only, within the selected UTC range (default today);
- `refresh=0|1` (default `0`).

Unknown/duplicate parameters, malformed queries and all account/environment/
database selectors are rejected. Responses have bounded `view`, `days`, `dates`,
`selected_day`, `today` and one **`usage` object**, replacing `accounts`.
`usage` includes `daily_limits`, `thresholds`, `status`, `error`, `retrieved_at`,
`rows`, and provider `scope`/`retention_start` when available. Configuration
failures have null limits/thresholds, null retrieval, an error code and no rows.

Daily rows contain UTC date, partial flag, availability, reads/writes and query
counts when available. Insights return at most five execution/read/write totals,
average reads and safe operation/fingerprint descriptions. Account/database IDs,
credentials, raw SQL and Cloudflare error bodies never reach the browser. SQL is
length-bounded and hashed server-side; only an opaque digest and operation label
are returned. There is no arbitrary GraphQL, target or SQL proxy.

## Preserved security, bounds and caches

Authentication remains before method/parameter handling, cache/provider reads,
upstream forwarding and compatibility/MySQL caches. Hosted requests require the
runtime-provided personal Access identity; caller-supplied headers cannot supply
it. Local requests, including direct localhost and every method, require the
existing signed personal Access JWT verifier. All privileged responses remain
`Cache-Control: no-store`.

The shared GraphQL templates remain unchanged: `d1AnalyticsAdaptiveGroups`,
`d1QueriesAdaptiveGroups` and dataset settings. Retention, available fields,
max duration/page size, at most twelve daily chunks plus one settings request
(or settings plus one top-five insights request), 768 KiB response limits,
timeouts and redirect denial remain enforced. No alternate account or credential
is attempted after errors.

Backend caching remains process/isolate-local, best effort, about 15 minutes,
32 entries maximum, keyed by a credential/identity digest, range and query day.
There is one refresh gate per view: at most four attempts/minute, one manual
refresh/minute and one in-flight retrieval. Transient failures may return clearly
stale data up to an hour; known access/schema failures invalidate that identity's
cache. No raw credentials enter keys or logs. Parent dashboard rerenders do not
repeatedly fetch the mini-page. Cache loss affects availability only.

## Validation and deployment prerequisites

Pre-deployment checks establish structural viability only: frontend syntax,
Worker TypeScript/local bundle, Python compilation, directly relevant endpoint
bounds/auth/configuration checks without provider calls, workflow parsing and
shell/secret-payload structure, catalogue uniqueness and archive/diff hygiene.
No speculative functional suite, remote SQL, database change, deployment or LIVE
action is included. Compilation does **not** establish operational acceptance.

Before separately authorised TEST deployment, the operator must migrate the token
name, configure TEST Media account/database values in hosted/local settings,
align the private catalogue and confirm dataset permissions/retention and
existing Access setup. Deploy matching Pages and API Worker revisions because
the DTO changed. Update and restart the local TEST process only when separately
authorised. The operator-confirmed local TEST LaunchAgent restart is
`launchctl kickstart -k "gui/$(id -u)/uk.co.ukaq.dashboard.test"` after updating
the complete TEST checkout and `.env`; this command was not run here.

## Real TEST acceptance after separately authorised deployment

1. Hosted TEST Media → D1 Usage shows only TEST Media: one series, one summary,
   no switching. Confirm daily values agree with Cloudflare account analytics.
2. Local TEST shows the same TEST account and figures through its protected
   hostname; neither dashboard makes cross-environment requests.
3. Exercise 7/30/90 UTC-day ranges, both metrics, daily table, selected day,
   today/partial labels, true zero and missing/outside-retention gaps.
4. With overrides unset, confirm 5,000,000 read / 100,000 write limits and 75%
   warning / 90% critical thresholds. Observe boundaries through real available
   TEST usage or separately authorised temporary overrides; do not generate
   expensive D1 work to reach a threshold. Record unobserved cases as pending.
   Invalid supplied overrides must produce explicit unavailability.
5. Check top-five query ranking/counts against the configured TEST Media database
   for a selected UTC day. Verify safe fingerprints and no SQL/ID leakage.
6. Check Refresh, fresh/cached timestamps, repeat-refresh bounds, and explicit
   stale/unavailable information; analytics delay is not real-time measurement.
7. Confirm personal Access authentication on hosted/local paths and direct
   origin/listener denial. Missing, forged, expired, wrong-audience and service
   identities must fail before cache/provider access on every method.
8. Under separately controlled TEST configuration, missing/invalid account,
   database or token must fail closed clearly with no fallback or credential/
   provider-error leakage. Reject unknown/duplicate parameters and selectors.
9. Confirm existing Articles, AI-title workflow, Runs, Sources, health and other
   dashboard functions work with analytics both available and unavailable.
10. Record real hosted/local evidence before operator-led LIVE promotion.

## Rollback and archives

Prefer disabling only D1 Usage by invalidating/removing its analytics token under
separate operator authorisation; normal Media functions remain independent.
If code rollback is required, restore matching Pages, Worker and local revisions
together because the DTO changed. **Do not re-enable PR #145's dual-account
analytics or provision its obsolete credentials as a rollback shortcut.** Keep
this feature unavailable until a safe single-account revision is restored.

Existing 29 October archives are reused unchanged. Exact new pre-change
snapshots cover only the two newly modified analytics backends. Archive code is
never executed or promoted. Git history retains PR #145 for reference. This
correction performs no merge, deployment, secret/settings changes, LIVE work or
authoritative system-documentation edits.
