# Accounts & Subscriptions: TEST review and deployment handover

Source implementation for the approved read-only first release. Nothing in this
note establishes deployment, database application or operational acceptance.
Authoritative system documentation remains read-only and unchanged.

## Repository dependencies and changes

Apply in order **Schema → Media read API → Dashboard API → Pages/local dashboard**.
All three repositories use branch `codex/accounts-subscriptions-read-only` and
pull requests targeting TEST `main`. Do not merge a deployment-triggering PR
until TEST deployment has separately been authorised. Media and Ops Pages have
existing automatic deployment workflows on relevant `main` changes.

| Repository / files | Purpose |
| --- | --- |
| Schema `schemas/ingest_db/uk_aq_news_email.sql` | Canonical restricted read RPC and default-order index; lifecycle RPC and private tables unchanged |
| Schema `schemas/migrations/20261028_001_ingest_accounts_subscriptions_admin_read.sql` | Existing IngestDB transition; not applied |
| Schema `docs/accounts_subscriptions_admin_read.md` | Exact RPC DTO, grants, query limits and apply/rollback instructions |
| Media `apps/media-admin/src/news-email-delivery.ts`, `src/index.ts` | Dedicated authenticated GET delivery capability, separate from editorial and email-operator mutations |
| Media `migrations/0054_news_email_dashboard_reads.sql` | Date/subscription indexes over existing D1 delivery/outbox tables; not applied |
| Media admin Wrangler/types/example, deployment workflow, environment targets, README | Read-secret injection and query-string log redaction |
| Ops `dashboard/index.html`, `_redirects`, `assets/accounts.js`, `assets/accounts.css` | Fourth route/navigation, pill mini-pages, read-only list/detail and delivery views |
| Ops Worker `src/routes/accounts.ts`, `src/lib/accounts_auth.ts` | Protected Accounts route dispatch, verified Access identity, strict inputs and response projection |
| Ops Worker `src/index.ts`, `src/lib/direct.ts`, `src/lib/upstream.ts` | Early private-route dispatch and reuse of existing IngestDB PostgREST helpers |
| Ops local `uk_aq_dashboard_accounts.py`, `uk_aq_dashboard_accounts_auth.py`, `uk_aq_dashboard_api_core.py`, `requirements.txt` | Same API on Python, before optional bearer/cache dispatch, with signed Access verification |
| Ops Worker package/lock, Wrangler, deployment workflow, environment targets, `local/dashboard/accounts-env.example` | Pinned JOSE verification dependency, backend configuration and log redaction |
| All three dated `archive/2026-10-28/` snapshots | Exact pre-change active implementation; reference only, never execute or promote to LIVE |

## Authentication and configuration

Every Accounts request, including direct Worker/Python listener requests and
non-GET methods, verifies `Cf-Access-Jwt-Assertion` against public keys fetched
only from the configured Access team's `/cdn-cgi/access/certs`. RS256 signature,
issuer, audience, expiry, optional not-before, issued-at, application-token type,
subject and an explicit email allow-list are checked. Plain identity headers,
the existing optional upstream bearer, service tokens and browser visibility do
not authorise these reads. Only public signing keys are temporarily cached.
Missing configuration fails closed with 503, missing/invalid identity with 401,
and a valid identity outside the allow-list with 403.

| Server setting | Existing/new and source |
| --- | --- |
| `SUPABASE_URL`, `SB_SECRET_KEY` | Existing IngestDB connection; reuse on Worker and Mac, never the `OBS_AQIDB_*` connection |
| `UK_AQ_PUBLIC_SCHEMA` | Existing schema selector, default `uk_aq_public` |
| `DASHBOARD_ACCESS_TEAM_DOMAIN` | New variable: full `https://<team>.cloudflareaccess.com` origin |
| `DASHBOARD_ACCESS_AUD` | New variable: one Access application audience for this backend |
| `DASHBOARD_ACCOUNTS_ADMIN_EMAILS` | New **secret**: comma-separated administrative email allow-list |
| `UK_AQ_MEDIA_ADMIN_URL` | Existing Media Admin origin, reused for the new read path |
| `UK_AQ_MEDIA_NEWS_READ_TOKEN` | New shared server secret in Media Admin, dashboard Worker and Mac; must differ from `UK_AQ_MEDIA_ADMIN_TOKEN` |

These additions are necessary because the existing bearer is optional and the
Media editorial credential authorises writes. The new Media token can authorise
only `GET /admin/news-email/delivery`; it cannot reach any other admin route or
trigger the existing POST queue-wakeup hook. There is no full-admin fallback.

Use the hosted Access application's audience in the Ops Actions settings. Use
the local Tunnel Access application's audience in that Mac checkout's `.env`;
they can differ. Local browser operation uses the existing Access-protected
Tunnel. Direct unauthenticated localhost Accounts reads intentionally fail.
There is no local password prompt, bearer bypass or new public login feature.

Set each repository's existing environment-sync catalogue/secret stores through
the normal operator mechanism. The private ignored `env-vars-master.csv` is
absent from this Cloud workspace: the operator must add these names/types there
before the next sync. Application code contains no environment-specific origin,
audience, project ID, credential or cross-environment fallback.

## UI and API behavior

`/accounts` works alongside `/ingest`, `/ops` and `/media`, including direct
loads, refresh, canonical no-trailing-slash URLs and browser history. The only
mini-pages are **Subscriptions** (default) and **Email Delivery**. Navigation and
subscriber state are not persisted. Leaving Accounts clears its DOM and memory
and aborts outstanding reads. Accounts requests always use same-origin `/api`.

- `GET /api/accounts/subscriptions`: literal normalised email substring search,
  status/mode filters, server-side `email|created_at|updated_at|status` sorting,
  `asc|desc`, UUID tie-break, `limit=1..100` (25 default), `offset=0..10000`.
  Returns `{items,counts,pagination}`; the four status counts are explicitly
  **global totals**, independent of list filters.
- `GET /api/accounts/subscriptions/:uuid`: approved subscriber fields and consent
  text version only; missing UUID returns 404 with `{subscription:null}`.
  Confirmation is derived from `confirmed_at`, independently of current status.
- `GET /api/accounts/email-delivery`: optional `subscription_id` UUID, the same
  page bounds and `days=1..30` (7 default). Returns bounded authoritative Media
  `{available,summary,deliveries,outbox,pagination,window_days}`. Both lists use
  the selected page/window; `has_more` means either list has another row.

Dates display in `Europe/London` with GMT/BST. Daily time is the subscriber's
selected UK wall time, not a fixed UTC offset. Delivery reads distinguish raw
states, retry holds, selected/attempted transport and fixed safe error classes.
**Accepted means SMTP acceptance, not confirmed inbox delivery or reading.**
The date window is based on creation time, so this view does not claim to list
every older unresolved delivery. Missing delivery configuration/migration/API
shows an explicit unavailable state while Subscriptions remains independent.

Responses and errors are `Cache-Control: no-store`, with no cross-origin read
permission. They bypass the compatibility edge cache, upstream proxy and local
MySQL layer. Query strings are redacted from Worker invocation logs; Python's
existing request logging remains disabled. Search values are not put in browser
history, persistent storage, metrics or error text. No export or mutation route
exists. No token hashes, management/unsubscribe links, future account IDs,
payloads, raw SMTP diagnostics or privileged keys are returned to the browser.

## Local structural verification

Only local structural checks are used before deployment: Worker and Media
TypeScript compilation, frontend and inline JavaScript syntax, Python parsing,
SQL/PLpgSQL parsing and canonical/migration comparison, configuration parsing,
environment-injection checks, archive comparison and active-file diff whitespace checks.
The exact HTML archive retains baseline trailing whitespace; it is not rewritten
to satisfy a new-file whitespace check.
No remote database query, migration application, resource mutation, deployment,
mail send or functional test suite is part of this implementation task.

The default-order index is additive. Substring search/global counts can still
scan source rows. The RPC's function-local 5-second timeout does not guarantee
an already-started outer statement is shortened; verify the effective
PostgREST session timeout and real query duration after TEST application. The
backends also enforce upstream timeouts, response sizes and result bounds.

## Exact operator sequence after separate TEST authorisation

1. Review all three PRs and provision the server settings above in TEST only.
   Ensure Access issues an `app` assertion carrying the intended admin email
   for the hosted hostname and the local Tunnel; do not relax verification.
2. Review/merge the Schema PR, then apply **only** its new transition to TEST
   IngestDB from the Schema checkout (normal index creation can briefly block
   subscriber writes; select a suitable window):

   ```sh
   psql "$TEST_INGEST_DATABASE_URL" -X --set ON_ERROR_STOP=1 --file schemas/migrations/20261028_001_ingest_accounts_subscriptions_admin_read.sql
   ```

   Confirm the existing PostgREST exposed schema is `uk_aq_public` and perform
   its normal schema-cache reload if needed. Do not expose `uk_aq_news` or add
   table grants. A fresh database uses canonical apply order instead.
3. Review/merge the Media PR only when its existing automatic TEST deployment
   is authorised. The `uk_aq_media_deploy.yml` workflow renders/verifies TEST
   bindings, applies pending D1 migrations (including `0054`), injects both
   admin secrets and deploys the existing Media Workers. Review pending D1
   migrations before allowing that workflow; do not assume only `0054` is pending.
   If no automatic run was started, invoke the existing workflow once:

   ```sh
   gh workflow run uk_aq_media_deploy.yml --repo TEST-uk-aq/uk-aq-media --ref main
   ```

   This workflow deploys Public/Admin/Discovery; it does not deploy or change
   the separate email sender or scheduler. Confirm completion before Dashboard.
4. Review/merge the Ops PR only when its Pages auto-deployment is authorised.
   Deploy the API through the existing workflow:

   ```sh
   gh workflow run uk_aq_ops_dashboard_api_worker_deploy.yml --repo TEST-uk-aq/uk-aq-ops --ref main
   ```

   Pages is triggered by the merge. If it did not run automatically, invoke
   `uk_aq_ops_dashboard_pages_deploy.yml` once with the same `--repo`/`--ref`.
   A frontend arriving before the API reports unavailable and grants no access.
5. Update the complete TEST Mac checkout. Put its corresponding settings in
   `.env`, install the updated server requirements in its existing virtualenv,
   and restart through the supported entrypoint:

   ```sh
   .venv/bin/python3 -m pip install -r local/dashboard/server/requirements.txt
   local/scripts/run_dashboard.sh
   ```

   Do not set an unauthenticated localhost override. Use its protected Tunnel.

## Real TEST acceptance after deployment

Use controlled existing TEST subscriptions; this acceptance sends no email and
changes no subscriber state.

- Authorised hosted and Tunnel sessions can read. No/forged/expired/wrong-team/
  wrong-audience assertions fail; a verified non-allowlisted user fails. Test
  both the protected hostname and direct Worker URL/direct Python listener.
  A raw email identity header or optional upstream bearer must not bypass auth.
- Verify direct `/accounts`, reload, trailing-slash canonicalisation,
  Ingest/Operations/Media and Back/Forward on hosted/local. Only two Accounts
  mini-pages appear; no mutation/export controls exist.
- Search real subscriber emails and literal `%`/`_` fragments, combine filters,
  change sorting and page size, reach empty/end pages and reject invalid inputs.
  Check globally labelled counts and known detail/absent-UUID behavior.
- Confirm timestamps on both sides of a known GMT/BST boundary and preserve a
  Daily subscriber's UK wall time. Confirm unconfirmed differs from inactive.
- Compare delivery summaries/recent rows/history with real Media D1 evidence,
  including confirmation/Immediate/Daily, failed/unknown/held where present.
  Accepted rows must never claim inbox placement. Missing delivery access must
  show unavailable, not an empty-success history or a public fallback.
- Confirm the dedicated Media read token fails on unrelated GET/admin mutation
  routes and all non-GET delivery methods. Check no queue wake-up or email work
  is caused by read requests. Existing public lifecycle flows remain unchanged.
- Inspect responses, network panel, browser storage and appropriately redacted
  logs: no private extra fields, cached responses, search/email diagnostics or
  full-list downloads. Verify no-store on successes and denials. Confirm anon
  and broadly authenticated Supabase clients cannot call the read RPC.

## Rollback and documentation handover

Disable/revert the dependent Dashboard API/Pages/local release first. The
original three pages and subscription lifecycle remain available. Revert the
Media read route/config if necessary; the four additive D1 indexes may safely
remain until separately authorised removal. Never delete ledger/subscriber rows
or reapply archive files. The Schema note provides the exact additive rollback
(`DROP FUNCTION` and its new index) after consumers are disabled.

ChatGPT in Chat mode should update authoritative docs after review/application
and real acceptance: settle these DTOs/configuration names, signed Access plus
allow-list authorization, dedicated Media read capability/index migration,
global count scope, date-window semantics, route set and actual deployment
evidence. No additional product scope/contract change is needed for this
implementation. Public accounts, Settings, all subscriber actions, exports and
manual resends remain deferred.
