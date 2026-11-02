# Threads Stage 2 dashboard compatibility and acceptance handover

Revised 2 November 2026 on existing TEST Ops PR #165,
`codex/threads-stage-2-dashboard`. This is a narrow status/history correction,
not a redesign of the publishing controls. No merge, deployment, publishing
setting change, provider call, LIVE change or authoritative-documentation edit
was performed.

## Pinned Media dependency and migration order

This integration targets [TEST Media PR #9](https://github.com/TEST-uk-aq/uk-aq-media/pull/9),
commit `8df0842fed5b0b3ee8046bdac96d329c6239403f`. Its exact
[settings and history handler](https://github.com/TEST-uk-aq/uk-aq-media/blob/8df0842fed5b0b3ee8046bdac96d329c6239403f/apps/media-admin/src/threads.ts)
and [operational handover](https://github.com/TEST-uk-aq/uk-aq-media/blob/8df0842fed5b0b3ee8046bdac96d329c6239403f/docs/threads-stage-2.md)
own the backend behavior. This replaces the earlier dependency on `44fd4c0`
with the implemented capture-only API.

Media migrations `0057_threads_automatic_publications.sql` and
`0058_threads_capture_only.sql` must apply forward before the updated Media
Workers. 0057 supports independent remote automatic intent/settings; 0058 adds
default-off capture, separate capture watermark/cursor and enabled periods,
permanent capture provenance and provider-request guards. Both preserve previous
manual settings, identity, publication history and receipts. Deployment does not
activate either mode. Ops adds no migration or environment configuration.

Only these Ops files change:

- `dashboard/assets/media.js`: independent automatic settings/acknowledgement,
  capture-aware status/holds, disabled automatic control during capture, and
  distinct captured history.
- `docs/dashboard-threads-stage-2.md`: this final compatibility/acceptance handover.

The existing same-day source archive
`archive/2026-11-02/dashboard/assets/media.js` comes from the preceding Stage 1
work. It is reused unchanged under the once-per-day rule, not overwritten with
another baseline. No new archive is created; documentation needs no source
archive. No archive was executed or copied to LIVE.

## Actual API mapping and preserved requests

The unchanged authenticated hosted/local proxies forward:

| Browser request | Media target |
|---|---|
| `GET /api/media/threads/settings` | `GET /admin/threads/settings` |
| `PUT /api/media/threads/settings` | `PUT /admin/threads/settings` |
| `POST /api/media/threads/connection-check` | `POST /admin/threads/connection-check` |
| `GET /api/media/articles/{id}` | Existing detail with independent Threads history |

No new route, proxy allowlist, secret, browser credential, Meta request or
cross-environment fallback is introduced. Existing server-held credentials,
configured upstream, bounded bodies, idempotency forwarding and no-store behavior
remain. Opening/refreshing settings reads only; it never activates capture or
publishing.

The automatic checkbox reflects the actual persisted boolean. It remains off on
a disabled installation, requires the existing separate future-post acknowledgement
before a normal false-to-true save, and is unavailable without backend eligibility.
During capture, or when Media reports `remote_requests_blocked=true`, it is
disabled even if the stored automatic value is true; the stored value is
preserved, not silently reset. The submit guard also prevents changing automatic
while the reported block is active. The explanation makes clear that capture
does not enable remote automatic publication.

The original Manual publishing enabled checkbox, cooldown, account/verification,
connection check, expiry and errors remain. Stage 2 PUT bodies still include only
changed settings; omitted manual/automatic/cooldown values remain untouched.
There is no `capture_only_enabled` input, capture activation button or capture
field added to a dashboard PUT. Capture activation/deactivation belongs to the
existing authenticated Media API and the agreed operator acceptance workflow.
No additional dashboard activation control is required.

Example ordinary remote enable, only with eligibility and separate authority:

```json
{"automatic_publishing_enabled":true,"acknowledge_future_auto_approvals":true}
```

Independent ordinary remote disable, outside capture:

```json
{"automatic_publishing_enabled":false}
```

Manual-only and cooldown-only edits still send only their changed key. No-change
Save sends no PUT. Old Stage 1 responses retain their known manual/cooldown request
shape and cannot enable automatic publication. The four manual destination
checkboxes, All/None behavior, unchecked consent defaults, eligibility, request
flags and clearing logic are unchanged.

## Capture status, holds and history

The dialogue uses the pinned backend fields directly:

- `settings.capture_only_enabled`: active/off capture status;
- `capture_only_enablement_available` and `capture_only_unavailable_reason`:
  read-only activation availability/reason when unavailable, with no new control;
- `capture_only_intent_count`: actual global captured-intent count;
- `capture_only_events_pending_count`: actual outstanding capture-event count;
- `remote_requests_blocked`: explicit Threads API request block;
- `dispatch_hold_reason`: reason-aware hold presentation.

During capture it shows **Capture-only active: no Threads API requests permitted**.
Counts are displayed from Media even after capture is off, so retained capture
history remains visible. Missing counts display a dash, not an invented zero.
Existing remote activation/cursor, availability, queue/error and identity fields
remain visible.

A `threads_capture_only` hold is an intentional non-remote mode. It is not called
an unknown remote outcome and does not ask for reconciliation. A genuine
`unknown_remote_state` reason or positive `held_publication_count` still shows the
original operator-reconciliation warning. If genuine unknown outcomes coexist
with capture, both distinct facts are shown. Other hold reasons receive a generic
bounded hold explanation rather than an invented unknown outcome.

Article history uses actual numeric `publication.capture_only=1` to label a row
**Captured, not published**, regardless of its underlying blocked/error code.
The latest-status summary uses that same label when the latest returned row is
captured. Captured rows show their actual automatic reason, approval-event ID,
time, attempts and bounded code, but no remote container/post ID or post link.
Non-capture manual/automatic IDs, statuses and validated provider-returned HTTPS
Threads links retain their existing behavior.

The separate Captured intents article summary uses Media's
`threads.capture_only_count`. Successful posts continues to use the authoritative
`threads.post_count`; the pinned backend counts posted rows and its schema
prevents captured rows from being posted. Captured/request counts are never added
to remote successes or inferred as successful from an event/container. The
article count and settings count have article/global scopes respectively; neither
is recomputed from a limited history page.

## Minimal structural validation

Passed:

- `node --check dashboard/assets/media.js`;
- existing `node scripts/dashboard/check_media_image_policy_admin.mjs`;
- `npm --prefix workers/uk_aq_dashboard_online_api_worker run check`;
- focused source comparison of unchanged manual selection/default/All-None/reset
  code, manual control and existing proxy sources; payload/field inspection
  against the exact pinned Media handler;
- `git diff --check`; the existing daily archive remains unchanged.

No new automated suite, fixture program or simulated provider/browser acceptance
was added. Actual hosted and local browser behavior remains to be accepted after
separately authorised TEST deployment.

## Deployment and real hosted/local TEST acceptance

These are future operator actions; none was performed by this coding task.

1. Review final Media and Ops files and obtain separate merge/deploy authorisation.
   Deploy Media's reviewed version first, with 0057 then 0058 before its Workers;
   verify TEST account/D1 ownership, disabled defaults, preserved history and
   unchanged Queue bindings. There is no separate TEST Threads account: keep
   Threads credentials/account configuration absent and both remote switches off.
2. A separately authorised Ops merge touching `dashboard/**` runs the existing
   Pages deployment workflow. Inspect its result before rerunning it. The API
   Worker/proxies are unchanged and need no redeployment for this frontend change.
   If a separately authorised Pages rerun is needed:

   ```bash
   gh workflow run uk_aq_ops_dashboard_pages_deploy.yml --repo TEST-uk-aq/uk-aq-ops --ref main
   ```

   Update the local TEST checkout to the same approved files and restart/inspect
   only the installed TEST dashboard service:

   ```bash
   launchctl kickstart -k "gui/$(id -u)/uk.co.ukaq.dashboard.test"
   launchctl print "gui/$(id -u)/uk.co.ukaq.dashboard.test"
   ```

   A manual TEST start uses `local/scripts/run_dashboard.sh` from that TEST
   checkout. Do not start a duplicate service, alter LIVE or restart the Tunnel.
3. On both protected hosted/local TEST dashboards, hard-refresh and open
   Media > Threads. Opening and Refresh status must use the existing settings GET,
   with no PUT, publish request, token exposure or Meta call. Compare the rendered
   identity, expiry, cooldown, remote watermark, availability, capture status and
   counts with the actual response. Confirm no capture activation control exists.
4. With both remote switches off, an authorised operator enables capture through
   the existing authenticated Media API, using a fresh `Idempotency-Key`:

   ```text
   PUT /admin/threads/settings
   ```

   ```json
   {"capture_only_enabled":true,"acknowledge_capture_only":true}
   ```

   The equivalent protected proxy route is `/api/media/threads/settings`.
   Follow Media's handover if activation reports an in-flight request/posting job;
   do not clear claims or bypass eligibility with SQL. Capture needs no account,
   token or verified identity and does not initialise remote activation.
5. Refresh both dashboards. Verify the exact capture-active/no-API status, actual
   captured and outstanding-event counts, held reason `threads_capture_only`,
   and disabled automatic checkbox. Its checked state must still match persisted
   data. A capture hold with zero unknown outcomes must show no reconciliation
   warning. Existing manual/identity/expiry/cooldown controls remain. Connection
   check remains the same action; in capture the backend returns a local 409
   `threads_capture_only`, with no provider request.
6. Save without edits: no PUT. Make an authorised cooldown-only change and inspect
   the PUT: only `cooldown_minutes` plus the existing idempotency header; manual,
   automatic and capture fields omitted. Refresh and confirm those booleans and
   both activation boundaries are unchanged. Restore the cooldown deliberately.
   A permitted manual-only edit likewise omits untouched fields. Do not enable a
   remote channel or bypass the frozen automatic checkbox to test its rendering.
7. Through real normal TEST discovery, observe a genuinely new `auto_approved`
   event after capture activation. Do not insert synthetic events, replay
   historical approvals or reset articles. Media must create one event-scoped
   captured row. Refresh settings and that article's detail in both dashboards:
   actual counts, Automatic approval reason, actual event ID, **Captured, not
   published**, zero remote attempts, no remote IDs/link and unchanged successful
   post count. The latest-status summary must also say Captured, not published
   when appropriate. Compare global and article counts to their respective DTOs.
8. Observe ordinary Queue reconciliation/rediscovery: the same real event/row
   remains unique. Retained manual and non-capture automatic results keep their
   own statuses, IDs and real links. Inspect any existing genuine unknown outcome:
   its reconciliation warning remains; if none exists, record that operational
   path as unexercised rather than deliberately causing an ambiguous post.
9. Disable capture through the same authenticated API with a fresh key:

   ```json
   {"capture_only_enabled":false}
   ```

   Keep both remote switches off. Refresh both dashboards: capture becomes Off,
   captured rows retain their label and no links, counts remain historical facts,
   and automatic availability returns to Media's normal missing-credential rules.
   If re-enable acceptance is authorised, use a new acknowledged capture request;
   retained watermark/period rules must exclude disabled-gap backlog and old row
   identities must not duplicate. Refresh status after every operator API change.
10. Recheck the existing single/bulk approval and direct-publish groups: exactly
    Bluesky, Facebook, Threads and All/None; unchecked defaults; eligible-only
    master selection; mixed state and consent clearing. Capture is not a fourth
    destination or another group checkbox. Do not submit a post merely to test
    selection. Confirm ordinary approval/public-feed and independent
    Facebook/Bluesky/email behavior under their existing authorised TEST settings.
11. Finish with capture and both remote switches off unless continued capture is
    separately authorised. Record frontend/backend versions, hosted/local results,
    actual counts/event identities, payload preservation and evidence of no
    Threads provider requests. TEST capture is non-remote acceptance, not a real
    Meta publishing success.

Only after real TEST non-remote acceptance may the user separately approve
promotion of complete unchanged TEST files, never archives or TEST data/credentials.
The first actual automatic Meta post is tested in LIVE only after that promotion,
another explicit LIVE authorisation, a successful account check, source-volume
review and normal automatic activation. It must use a new genuine future approval,
not captured or historical events. Record TEST capture acceptance and LIVE provider
acceptance separately; the original manual pilot exception is consumed.

## Rollback and system-doc ownership

A frontend rollback does not disable persisted capture/manual/automatic settings.
An authorised operator must examine/stop the appropriate modes explicitly before
rollback as needed. Restore the complete approved frontend file and local TEST
source; never execute archives, reverse Media's forward schema or delete history.
Older frontends may mislabel capture, so do not rely on them for capture acceptance.

Chat-mode documentation ownership should record this pinned dependency and
capture-aware dashboard presentation, then real TEST/LIVE evidence only when it
exists. Authoritative Threads/dashboard system documentation stays read-only.
