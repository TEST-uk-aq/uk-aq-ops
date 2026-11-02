# DEV Dashboard Threads Stage 1 handover

Implemented in TEST Ops only. No merge, deployment, remote publishing, schema
application or LIVE change is part of this work. Authoritative system docs remain
read-only and unchanged.

## Backend dependency

The operator explicitly agreed to use
[TEST Media PR #8](https://github.com/TEST-uk-aq/uk-aq-media/pull/8), branch
`codex/threads-stage-1`, commit
`28ca0e94410ae546b36466035b8e699a655da5f5`, as the integration source. This does
not claim that the backend is merged or deployed.

Deploy that reviewed implementation, including migration
`0056_threads_manual_publications.sql`, the Admin/Discovery bindings and its
dedicated Queue, before deploying this dashboard integration. Follow the backend
[handover](https://github.com/TEST-uk-aq/uk-aq-media/blob/28ca0e94410ae546b36466035b8e699a655da5f5/docs/threads-stage-1.md)
for environment configuration and credential lifecycle. No Threads credentials or
identity values are added to Ops. Existing `UK_AQ_MEDIA_ADMIN_URL` and
`UK_AQ_MEDIA_ADMIN_TOKEN` remain server-side.

The dashboard forwards `post_to_bluesky`, `post_to_facebook` and
`post_to_threads` through the existing article approve/unhide, direct publish,
bulk-approve and bulk-publish routes. It creates no publishing endpoint and never
serializes All/None. Existing durable backend idempotency, editorial transitions,
bulk transactional eligibility and independent platform outcomes remain owned by
Media.

The only new proxy routes, identical locally and hosted, are:

- `GET` / `PUT /api/media/threads/settings` -> `/admin/threads/settings`;
- `POST /api/media/threads/connection-check` -> `/admin/threads/connection-check`.

Article-specific Threads eligibility/history comes from the existing authenticated
article-detail GET. The frontend does not infer availability from thumbnail URLs,
invent provider links or contact Meta directly.

## Changed files and behaviour

- `dashboard/assets/media.js`: one shared four-checkbox group labelled Bluesky,
  Facebook, Threads and All/None for individual approval, bulk approval, individual
  direct post/repost and bulk direct publishing. Disabled destinations stay
  unchecked with explanations. The master reflects all eligible, none or mixed.
  Fresh actions, target changes and article changes clear consent. Late bulk or
  article-detail responses cannot replace a newer action's state.
- `dashboard/assets/media.css`: wrapping selection groups, unavailable reasons
  and the independent Threads history table.
- `workers/uk_aq_dashboard_online_api_worker/src/routes/media.ts`: narrow hosted
  settings/connection-check allowlist entries using the existing authenticated
  server proxy and no-store response path.
- `local/dashboard/server/uk_aq_dashboard_media_proxy.py`: equivalent local
  allowlist entries using the existing server-side authentication/forwarding path.
- This implementation handover.

The exact four pre-change implementation files are preserved at matching paths
under `archive/2026-11-02/`; their bytes were compared with TEST `main` before
commit. Archives are never used by active code.

Bulk eligibility checks at most the existing 50 selected articles, with at most
five simultaneous detail reads per action; superseded actions stop scheduling
further reads. A destination is available only if every selected
article is eligible. Manual Facebook availability uses its independent settings
gate because the integration's manual detail DTO has no Facebook availability
boolean. Bluesky keeps its backend thumbnail/waiting rules; Threads uses its own
backend availability. Mixed already-Approved/newly-approving sets retain ordinary
editorial behaviour but cannot request social publication as one action.

The Threads settings dialogue exposes only the manual enable/disable gate,
cooldown, expected/observed account, connection check, expiry, bounded errors and
unknown-outcome dispatch holds. Connection checks are queued reads with an
explicit Refresh status button. There is no token input or automatic-publishing
control. Automatic Threads publishing remains a read-only disabled statement.

Article detail shows independent Threads counts, recent publication history,
status, attempts, relevant UTC time, bounded error, genuine container/post IDs and
an optional Media-supplied HTTPS Threads permalink. A container alone is not a
successful post. Unknown remote outcomes remain visibly held for operator
reconciliation through Media; this dashboard adds no retry/reconciliation action.

## Validation performed

- JavaScript syntax: `node --check dashboard/assets/media.js`.
- API Worker: TypeScript `tsc --noEmit` using its existing configuration.
- Local proxy: Python AST syntax parsing plus a focused deterministic check of the
  new route/method allowlist and rejection of unlisted publishing/token paths.
- Existing `node scripts/dashboard/check_media_image_policy_admin.mjs` passed.
- A scratch DOM check of the actual shared selector passed for all three rendered
  group contexts: four controls, unchecked defaults, eligible All/None, partial
  indeterminate state, disabled destinations, independent Threads selection,
  exactly three request flags, reset and missing-backend fail-closed behaviour.
  No test helper, dependency or fixture was added to the repository.
- `git diff --check`; all four archives match their exact base blobs.

A headless Chromium attempt could not complete under the execution sandbox's
process/socket restrictions. The focused DOM check passed using a scratch DOM
runtime; rendered browser and real hosted/local operation remain post-deployment
acceptance. No broad suite, remote publish, provider simulation or operational
mutation was run.

## Operator deployment order and TEST acceptance

These are future operator steps, not actions executed by this task.

1. Review/accept the backend dependency and deploy its forward migration and
   Workers in the isolated TEST Media environment first. Missing Threads
   credentials must remain fail-closed. Do not copy LIVE credentials into TEST.
2. After a separately authorised Ops merge, use the existing TEST deployment
   workflows. A merge touches existing automatic Pages/orchestrator paths; check
   their results before dispatching a redundant run. If a manual run is required:

   ```bash
   gh workflow run uk_aq_ops_dashboard_api_worker_deploy.yml --repo TEST-uk-aq/uk-aq-ops --ref main
   gh workflow run uk_aq_ops_dashboard_pages_deploy.yml --repo TEST-uk-aq/uk-aq-ops --ref main
   ```

   Update the local TEST checkout to the same approved files and restart its
   existing TEST dashboard process using the current
   [operations instructions](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/main/system_docs/dashboards/operations.md).
   No new Ops environment settings are required.
3. On both protected hosted and local TEST `/media`, open Pending, Rejected and
   Hidden articles and choose Approved. Confirm exactly four checkboxes, all
   unchecked. Toggle each available destination and All/None; verify mixed state,
   unavailable reasons, and clearing when choosing another status, reopening the
   article or opening a different action. An image-less article must keep Bluesky
   unavailable while eligible Facebook/Threads remain independent.
4. Repeat with bounded bulk Pending/Rejected/Hidden selections. Wait for
   eligibility; one ineligible article must disable that destination for the whole
   selection. Change the selected rows or target while reads are pending: no late
   response may restore a prior selection. Approval with no social selection must
   remain possible and must create no manual social intent.
5. Open an already-Approved article and an all-Approved bulk selection. Confirm
   direct publishing is separate from editorial approval, with the same four
   unchecked controls and Publish/Save disabled until a destination is selected.
   Clear the master and confirm no publish request is sent. Do not submit a social
   publication merely to test checkbox behaviour.
6. With unconfigured TEST Threads, confirm its checkbox remains visibly disabled
   in every group, including after All/None. Open Threads settings: verify the
   missing-config explanation, manual enable unavailable, automatic publishing
   disabled, no credential field, and a bounded connection-check result after
   Refresh status. Other platforms and ordinary approval must still operate.
7. Inspect the browser requests during authorised editorial acceptance: only the
   three supported platform booleans may be sent; no All/None flag. Backend
   rejection must show an error without reporting success or changing a selected
   set into best-effort social publication. Check existing Bluesky waiting history,
   Facebook independent controls and the normal article/image/title workflows.
8. Inspect any existing Threads history without generating a post: independent
   counts/status/errors, held unknown outcome, real IDs and only returned post
   links. When no history exists, show the deliberate empty state. Real Threads
   publishing acceptance remains a separate explicitly authorised pilot; automatic
   publishing stays disabled.

## Rollback and system-doc handover

If rollback is needed after an authorised deployment, restore/redeploy the four
complete pre-change Ops files together and restart local TEST to the same source.
Do not execute archives or reverse the independent Media migration/history. No
Ops schema/configuration migration is introduced.

Chat-mode system-doc ownership should record the dashboard implementation/PR and
its dependency on Media PR #8 after review, then record deployment and hosted/local
acceptance only when separately evidenced. The Threads contract and dashboard
contract behaviour are implemented without editing authoritative prose here.
