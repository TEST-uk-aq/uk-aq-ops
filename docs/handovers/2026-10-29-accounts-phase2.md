# Accounts & Subscriptions Phase 2: TEST review handover

Implementation only. No merge, deployment, SQL application, subscriber operation or outbound email has been performed. This change is not independently deployable repository by repository.

Authority: latest TEST system-docs Accounts dashboard contract section 8, Media News email contract section 26, and the 27 October Accounts plan updated 29 October. The local system-docs checkout predates these approvals; the latest files were read from GitHub. Authoritative documentation remains untouched.

## Repository changes

| Repository | Implementation |
| --- | --- |
| `uk-aq-schema` | Canonical private News schema; forward migrations `20261029_001_ingest_news_subscriber_administration.sql` and `20261029_002_ingest_news_email_retention.sql`; permanent `blocked` status/metadata; service-only bounded admin mutation RPC; UUID/time deletion table; final recipient eligibility action. Applied migrations remain unchanged. |
| `uk-aq-media` | `/operations/block` replaces `/operations/suppress`; typed subscription status; fresh eligibility before direct SMTP envelope and DATA; optional Pro rechecks eligibility after its own connection/auth delay and before DATA. Existing D1 history and message identities remain intact at subscriber Delete; separate bounded retention removes eligible terminal history after thirty days. |
| `uk-aq-ops` | Shared subscription-detail controls; protected hosted/local mutation routes; blocked list/filter/count/projection, plus Not retained labels for minimised inactive preference/consent fields; explicit confirmation, bounded bodies, stale-detail revision rejection, same-origin protection and no-store receipts. |
| `TEST-uk-aq.github.io` | Inspected public `news/subscription.js` and subscription pages. They consume preference/ok responses, not permanent lifecycle status or block metadata. No change or PR is necessary. Existing neutral anti-enumeration responses remain. |

Source archives are under each changed repository's `archive/2026-10-29/`, preserving source-relative paths. They are reference only, must stay in TEST and must not be promoted or executed. Imported Media snapshot newline artefacts were corrected against the real Git source before final validation.

## Private API and state transitions

`POST /api/accounts/subscriptions/:uuid/actions` requires the existing verified personal Access identity, JSON content type, `X-UKAQ-Accounts-Action: 1`, matching same-origin Origin and no cross-site fetch metadata. Preflight is denied. The local backend compares Origin with the request Host only for CSRF; Host never selects JWT issuer/audience or establishes identity. Its existing signed local JWT verifier remains unchanged. Hosted requests retain `ctx.access.getIdentity()` verification; no second login or additional credentials.

The body is at most 4096 bytes, accepts only action-specific fields, and always requires `action`, literal `confirmed: true` and `expected_updated_at` from the latest detail. The URL alone selects the subscriber. Additional fields are rejected. The write capability returns only an action receipt, never tokens or subscriber snapshots. Missing subscriber returns 404; stale revision or disallowed transition returns 409. Other failures use fixed privacy-safe envelopes, with no upstream body, address, reason or identity in logs. Neither writes nor reads use shared caches.

| Action | Extra fields | Effect |
| --- | --- | --- |
| `edit` | `delivery_mode`: immediate/daily; `daily_time_local`: HH:MM | Active only. Preserve verified identity and consent. A Daily time change preserves the cursor; Immediate→Daily starts at now; mode switches update mode_since_at. |
| `block` | `reason`: 1–200 characters on one line | Any status→blocked; revoke all live links. No News or confirmation eligibility. Public subscribe retains a neutral response and cannot clear the block. |
| `unblock` | none | Blocked→pending; clear current verification/block metadata and digest cursor; revoke old links. No send is triggered. Subscriber uses the ordinary public subscription flow and fresh confirmation. Existing confirmation cooldown/backoff remains. |
| `unsubscribe` | none | Preserve opt-out semantics and revoke links. A blocked subscriber returns conflict, retaining the block. |
| `delete` | none | Any status: lock subscription, remove its tokens and row, write only UUID + timestamptz atomically. No email, operator identity, token, preference snapshot or general change ledger. |

`uk_aq_news_subscriptions_admin_write(p_request jsonb)` is separately bounded from the read and lifecycle APIs. Only the existing server `service_role` has EXECUTE; private tables and tombstones remain inaccessible to anon/authenticated and service-role direct table access. Explicit schema-qualified references and a pinned search_path constrain the privileged write function. The tombstone has no foreign key to the removed row or D1. A deleted address gets a new UUID and fresh double opt-in on normal resubscription; previous tokens cannot resolve it.

The Media `send_eligible` lifecycle action returns only a boolean receipt using current Supabase state. News checks active status, confirmation generation/time and delivery mode; Daily also checks the preference revision and cursor. Confirmation checks the exact live unexpired token generation and pending status. A confirmed ineligible recipient produces cancelled work; source failure fails closed as a retryable pre-submission failure. The Pro request includes a small eligibility snapshot without tokens; it reuses that environment's existing `SUPABASE_URL` and `SB_SECRET_KEY`. Missing/invalid source configuration does not fall back to another environment or stale eligibility.

Supabase and D1 have no shared transaction. The last eligibility check precedes SMTP submission; an envelope/body already underway or a message already accepted can complete after a concurrent admin action. This change cannot retrospectively cancel that submission. Existing accepted/unknown outcomes and idempotency records remain authoritative; no automatic unknown resend or fallback is introduced.

Review corrections preserve recovery across deletion/cancellation: a lost Pro cancellation receipt can retire unknown work without retrying, advancing the cursor or keeping a stale Daily window held; confirmation outcomes can reconcile authoritative historical evidence after token deletion only against the matching minimal tombstone. Neither path recreates private records or broadens manually entered SMTP evidence.

## Deployment prerequisites and approved retention

1. Retention is resolved: thirty rolling UTC days under the updated Media section 26. The new restricted Schema RPC and Media scheduler/Queue implement expiry and minimisation; active identity, enforcing opt-out/block records, valid credentials and specific visible unresolved dependencies remain protected. UUID-only history is pseudonymous, not assumed anonymous.
2. Review the final coordinated release and existing pending migrations/workflows. Main-path merges can automatically deploy Media email and Ops Pages; merging is therefore part of the separately authorised operational window, not an innocuous preparatory step.
3. If the optional Pro transport is used, provision its existing TEST IngestDB URL/key through the ignored runtime environment and update/restart the sender during the pause. Its checked-in template has blank environment-specific URLs. No new persistent secret or variable name is introduced; existing GitHub secret target mappings remain unchanged.

## Coordinated merge, migration and deployment order

The order below is a future operator runbook, not permission granted or actions taken by this task. Use TEST settings only, and keep both public lifecycle requests and administrative APIs unavailable during the incompatible status cutover.

1. Review all three PRs together, including the approved retention implementation. Arrange a maintenance window. Disable News submissions using `NEWS_EMAIL_ENABLED=false` AND explicitly pause the existing Queue/scheduler processing (retention now continues independently of the send switch); stop the optional Pro sender. Wait for already-running invocations/SMTP attempts to settle and reconcile accepted/unknown outcomes through the existing procedure. Do not assume changing a variable cancels an invocation already running with old settings. Prevent old hosted/local/public lifecycle consumers from running against the new schema.
2. Merge the Schema PR (no application deployment). Apply only the new forward transition to the already-current TEST IngestDB, with the prior read capability migration present:

   ```sh
   psql "$TEST_INGEST_DATABASE_URL" -X --set ON_ERROR_STOP=1 --file schemas/migrations/20261029_001_ingest_news_subscriber_administration.sql
   ```

   Apply the new retention migration immediately afterwards, before any consumer resumes:

   ```sh
   psql "$TEST_INGEST_DATABASE_URL" -X --set ON_ERROR_STOP=1 --file schemas/migrations/20261029_002_ingest_news_email_retention.sql
   ```

   Each migration executes as one transaction. The first takes a bounded table lock, changes old status values, renames the permanent metadata without rewriting timestamps/reasons/consent, and replaces all affected functions. A failed transaction rolls back fully. Use the existing PostgREST schema-cache reload procedure if required; never expose `uk_aq_news` or add broad grants. A clean install follows `schemas/CANONICAL_APPLY_ORDER.md`, not historical migrations.
3. Merge Media only when its automatic TEST email deployment is explicitly authorised. Review existing pending D1 migrations first; this extension adds `0055_news_email_retention.sql` and preserves editorial/shared data. Apply its additive D1 schema/indexes/triggers before starting the new Worker; only unattended eligible News-specific cleanup later deletes history. Keep the rendered `NEWS_EMAIL_ENABLED=false` throughout deployment. If a manual run is needed, use the existing workflow:

   ```sh
   gh workflow run uk_aq_media_email_deploy.yml --repo TEST-uk-aq/uk-aq-media --ref main
   ```

   Update the complete optional Pro files/configuration, including same-environment `SUPABASE_URL`/`SB_SECRET_KEY`, before allowing that transport. Old callers of `/operations/suppress` must move to `/operations/block`; no deprecated alias remains.
4. Merge Ops when its automatic Pages deployment is authorised. Deploy its API Worker through `uk_aq_ops_dashboard_api_worker_deploy.yml`; deploy Pages through the existing automatic path or `uk_aq_ops_dashboard_pages_deploy.yml` if needed. Update the full TEST Mac checkout and restart the installed TEST dashboard LaunchAgent using its supported procedure, retaining its existing local issuer/audience and signed JWT verification. Do not alter Tunnel/Access applications or LIVE.
5. Confirm the deployed Schema/Media/Ops versions all agree on blocked and action DTOs before restoring access and processing. Restore only the intended TEST sender/scheduler configuration. Complete the controlled real TEST checks below. User-operated complete-file LIVE promotion follows separate approval and operational acceptance; exclude archive directories.

## Post-deployment TEST acceptance (separate authorisation required)

- Record controlled pre-migration suppressed UUIDs, reasons, timestamps and consent through the protected operational process; after migration verify every row is blocked with the exact preserved metadata and no old permanent status/columns remain. Do not put those private records in Git or logs.
- Verify hosted/local subscription lists, four global counts, bounded search/status/mode filters, detail, consent and UK GMT/BST timestamps. Confirm blocked reasons are private and escaped.
- Edit an active Immediate subscriber to Daily, change Daily time, switch back and verify cursor/no-replay behavior. Confirm non-active edits fail, stale-detail actions conflict and confirmation/consent are preserved.
- Block pending and active controlled subscribers; confirm tokens revoke, new confirmations/News stop, public resubscribe is neutral and cannot reactivate. Unblock returns pending with no send; ordinary subscribe plus fresh email confirmation is required. Existing cooldown/backoff and Turnstile remain effective.
- Unsubscribe active/pending subscribers and confirm existing public opt-out behavior; attempt it while blocked and verify the block remains.
- Delete one controlled subscription in each existing status with explicit confirmation. Verify row and dependent tokens disappear atomically and only its UUID/UTC timestamp appear in the minimal private tombstone; no email, reason, identity or ordinary-action audit rows. Verify old confirm/manage/unsubscribe links fail.
- Confirm Media D1 approval/outbox/delivery/digest/idempotency history and historical UUID references remain unchanged by deletion. Re-subscribe the deleted address: new UUID, fresh opt-in, no inherited old delivery state.
- Hold controlled queued/retrying confirmation, Immediate and Daily work; delete/block/change eligibility before consumption and during transport setup. Confirm fresh source checks prevent new submission, including delayed optional Pro requests. Simulate source unavailable through an authorised controlled TEST exercise: no fail-open submission. Observe and document already-in-progress SMTP separately from new attempts.
- With controlled transport fault injection after deployment, verify a cancelled Pro attempt whose HTTP reply is lost can reconcile from its durable receipt without resend/cursor advancement or a frozen Daily window. Reconcile a historical unknown confirmation after deleting its subscriber; provider evidence must update retained D1 history without restoring subscriber/token data.
- Check hosted/local action route parity and fixed 400/403/404/409 behavior. No retries on an ambiguous action receipt; refresh authoritative detail first.
- Verify missing/forged/expired/wrong-audience/service-token/direct Worker and direct-loopback requests remain denied for reads and every write. Verify missing custom header, foreign Origin, cross-site metadata and cross-origin preflight cannot mutate.
- Verify no-store and no shared/browser persistent caching; no private table reads through public/anon/authenticated APIs, no token/service key leaks, no raw PII logs. Check the existing Ingest/Operations/Media and read-only Email Delivery features are unchanged.
- Exercise the ordinary public subscribe/confirm/Manage/Unsubscribe lifecycle, neutral anti-enumeration, cooldown, Turnstile, Queue idempotency, and accepted versus unknown delivery semantics with controlled TEST operations only.

## Structural validation and rollback

Validation performed before review: full Media `npm run typecheck`; dashboard Worker `tsc --noEmit`; `node --check` on shared Accounts UI and public subscription script; Python compile of both changed backends; PostgreSQL SQL and all PL/pgSQL function parsing; exact canonical/forward-definition comparison; scoped diff, archive and historical migration hygiene. No functional suite or subscriber data operation was run. The retention extension additionally receives SQL/PLpgSQL parsing and canonical/forward consistency checks, D1 migration/statement compilation, TypeScript/Python/JavaScript checks, configuration parsing and unchanged-archive/historical-migration verification. Final counts/results and commit IDs are recorded with delivery. Independent review findings concerning fences, cleanup throughput, send pauses, minimum holds and Pro replay were corrected and re-reviewed.

Before SQL commit, transaction failure leaves the old schema intact. After cutover, keep processing paused if a component fails and fix forward. Never roll back just one consumer to suppressed semantics against the blocked schema. A deliberate coordinated reverse migration would need to map blocked back to suppressed and rename metadata while preserving state; it is not supplied or authorised here. Deleted subscriber/token data cannot be restored from the tombstone; use the existing approved recovery/privacy process, never resurrect recipients automatically or erase D1 history to make rollback easier.

Chat-mode documentation handover: after actual coordinated TEST acceptance, update current-runtime Accounts sections 1–7 and Media lifecycle sections to blocked/actions and record observed evidence. Keep section 26's future/current distinction accurate until then. No new contract correction is required by this implementation; the action DTO, eligibility snapshot and rollback/deployment details above are implementation notes, not a second source of behavioural authority.


## Approved thirty-day retention extension

The old unresolved-retention deployment blocker is removed. [Media retention implementation and TEST release notes](https://github.com/TEST-uk-aq/uk-aq-media/blob/codex/accounts-subscriptions-phase2/docs/news-email-retention.md) document the precise storage rules, indexed bounded cleanup phases, singleton lease, short D1 fences, minimal visible safety holds, dependency/FK ordering, non-recipient approval guard, Pro receipt protocol and failure recovery.

The existing five-minute scheduler requests a retention message on the existing email Queue, including while sends are disabled. Supabase phases process five indexed keyset candidates; terminal D1 history processes up to100 roots atomically. Queue continuations drain known backlog without blocking behind held rows. No new credentials, cron or environment setting is required. The same complete application files run after future authorised TEST/LIVE promotion. Ops adds no retention control or audit page; it labels cleared inactive preferences/consent as Not retained, and private mode filters exclude those placeholders.

Operational visibility uses the existing operator-secret-protected `GET /operations/retention`: last-run/success/error metadata, per-batch eligible/deleted/held/minimised/initialised counts, and a bounded opaque hold list. Pro's existing-secret-protected `POST /retention/status` reports its idle-loop receipt cleanup. No private addresses, tokens or request bodies enter these status responses/logs. Legacy rows without reliable completion timestamps receive a one-time, documented conservative observation window; new completion clocks do not reset merely because cleanup reads them.

Extend the real TEST acceptance above with: terminal history/pending identity/tombstone crossing thirty days; active/blocked/opt-out enforcement retained; invalid-token cleanup without breaking valid credentials; inactive metadata minimised and labelled accurately; unknown/held work visibly retained; specific confirmation holds released on resolution; backlog capacity/continuations; interruption/authority-outage recovery; retention while sends are disabled; Pro stale-request/receipt pruning and deliberate safe retry; and no duplicate submission, unsafe cursor advancement or public/admin authentication regression. These operations require separate authorised deployment and are not performed by this task.
