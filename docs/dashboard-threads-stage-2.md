# Threads Stage 2 dashboard handover

Prepared 2 November 2026 in TEST Ops, based on `c192a767`. Implementation only:
no merge, deployment, settings mutation, provider call, LIVE change or authoritative
system-documentation edit was performed.

## Exact dependency and implementation scope

The operator explicitly selected the current API in
[TEST Media PR #9](https://github.com/TEST-uk-aq/uk-aq-media/pull/9), commit
`44fd4c079df74c7bd8b43774226fd68ea1a3a002`. The source of truth for this integration
is that commit's
[Threads settings handler](https://github.com/TEST-uk-aq/uk-aq-media/blob/44fd4c079df74c7bd8b43774226fd68ea1a3a002/apps/media-admin/src/threads.ts),
not an assumed future interface. This is not evidence of backend merge,
deployment or operational acceptance.

Changed files:

- `dashboard/assets/media.js`: separate automatic control and acknowledgement;
  actual Media activation, eligibility, holds, counts and intent errors; changed
  fields only in Stage 2 settings writes; approval event in the existing mixed
  automatic/manual Threads history.
- `docs/dashboard-threads-stage-2.md`: this implementation/acceptance handover.

The repository already contains the same-day source archive at
`archive/2026-11-02/dashboard/assets/media.js` from the preceding Stage 1 work.
That earlier snapshot was retained unchanged under the once-per-day rule rather
than replaced with a Stage 2 baseline. There are no new archive copies,
generated files, dependencies, environment settings, migrations or proxy changes.
No archive was executed or copied to LIVE.

The existing Manual publishing enabled control, cooldown, expected/observed
identity, verification and connection timestamps, read-only connection-check
action, expiry, errors, posted counts and real returned links remain. The three
manual destinations and All/None, eligibility rules, unchecked consent defaults,
request flags and clearing behavior remain unchanged.

## Settings API mapping

The shared frontend continues to use the authenticated hosted/local proxy:

| Browser request | Existing Media target |
|---|---|
| `GET /api/media/threads/settings` | `GET /admin/threads/settings` |
| `PUT /api/media/threads/settings` | `PUT /admin/threads/settings` |
| `POST /api/media/threads/connection-check` | `POST /admin/threads/connection-check` |
| `GET /api/media/articles/{id}` | Existing article detail, including Threads history |

Both proxies already allow these methods and forward bounded JSON and the
`Idempotency-Key`; their sources, server-held credentials, configured upstream
and no-store behavior are unchanged. No browser-visible credential, account
default, Meta fetch or alternate environment/service is introduced.

The checkbox is checked only when Media reports
`settings.automatic_publishing_enabled === true`. On a first disabled installation
it remains off. The UI requires Stage 2's
`automatic_enablement_available` and activation field before allowing an enable;
a Stage 1 response with automatic=false alone is insufficient. A currently
enabled switch can still be turned off when availability is lost.

Before a false-to-true save, the operator must check a separate acknowledgement
describing future genuine automatic approvals and retained queued post-activation
work. That acknowledgement starts unchecked, appears only for a new enable action,
and clears on automatic checkbox changes or dialog refresh/reopen. It is not part
of a manual destination group.

Stage 2 PUT bodies include only values changed from the loaded settings:

```json
{"automatic_publishing_enabled":true,"acknowledge_future_auto_approvals":true}
```

```json
{"automatic_publishing_enabled":false}
```

Manual-only and cooldown-only changes send only `manual_publishing_enabled` or
`cooldown_minutes`, respectively. Untouched manual/automatic/cooldown fields and
unneeded acknowledgement are omitted, preserving the server's current values
even if another operator view changed them. Save with no changes sends no PUT.
The existing request helper supplies a new idempotency key for a deliberate save;
backend receipt/conflict handling remains Media-owned. During a staged rollout,
an older Stage 1 response leaves automatic unavailable and keeps its known
manual-plus-cooldown request shape for existing manual settings.

The dialog displays these actual backend values:

- `settings.activation_event_id` (including zero; null means Not activated) and
  `settings.automatic_events_through_id`;
- `automatic_publishing_available`, `automatic_unavailable_reason`,
  `automatic_enablement_available`, `automatic_enablement_unavailable_reason`;
- `dispatch_held`, `dispatch_hold_reason`, `held_publication_count`;
- automatic queued, paused, blocked/failed and unprocessed-event counts, plus
  manual queued count;
- `automatic_intent_held`, `settings.automatic_intent_error_code` and
  `settings.automatic_intent_error_event_id`.

Missing counters/IDs appear unavailable rather than fabricated. Unknown outcome
holds and creation failures remain visible with bounded backend codes. An unknown
hold is distinct from a disabled switch or unavailable credential. Settings
opening/refresh only reads; checking a box alone creates no request.

Article detail continues to render every returned Threads history row in backend
order. `publication_reason=auto_approved` is labelled Automatic approval, alongside
the existing manual labels. The Approval event column uses the actual positive
`approval_event_id`, or a dash if absent. Counts, errors, genuine container/post
IDs and validated Media-returned HTTPS Threads links remain independent; a
container or a queued/captured intent is never represented as a successful post.

## Structural validation

Passed before commit:

- `node --check dashboard/assets/media.js`;
- `node scripts/dashboard/check_media_image_policy_admin.mjs`;
- `npm --prefix workers/uk_aq_dashboard_online_api_worker run check`;
- Python AST parsing of the unchanged local Media proxy;
- source comparison confirming manual selection/default/reset/All-None code and
  both proxy files are unchanged; exact settings fields/acknowledgement and history
  fields inspected against the pinned backend handler;
- `git diff --check` and verification that the existing daily archive is untouched.

No new automated suite, fixture program, browser/provider simulation, remote
settings write or real publishing operation was added/run. Real hosted/local
browser operation remains a separately authorised TEST acceptance step.

## Current TEST operational prerequisite

The latest authoritative Stage 2 contract now requires capture-only non-remote
TEST acceptance because the operator has confirmed there is no separate TEST
Threads account. The selected Media PR #9 commit predates that requirement and
provides no capture-only API. This dashboard intentionally invents no capture-only
field, mode, bypass or endpoint. It does not permit remote automatic enablement
without Media's existing verified-identity/credential eligibility.

Missing-config/disabled UI, real settings reads and safe non-remote edits can be
accepted against the selected API. Positive capture of a fresh genuine automatic
approval remains a **separate Media backend prerequisite**. Resolve that prerequisite
and recheck the reviewed API before claiming complete Stage 2 TEST acceptance or
proposing promotion. Never add LIVE credentials to TEST to make the checkbox work.
The current contract allows the eventual external Meta acceptance only after real
non-remote TEST acceptance, separately approved complete-file promotion and a
further explicit LIVE provider-test authorisation; none is performed by this PR.

## Operator deployment and real TEST acceptance checklist

These are future operator actions, not operations performed by this task.

1. Review both dependencies and obtain separate merge/deploy authorisation. The
   selected Media backend needs its forward migration `0057` before updated
   Workers. Verify its actual deployed version and settings DTO against the pinned
   API; resolve the capture-only prerequisite before full Stage 2 acceptance.
   Both automatic and any later capture-only mode must stay off on deployment.
2. A separately authorised Ops merge changing `dashboard/**` automatically runs
   the existing Pages workflow. Inspect its result before rerunning it. The
   dashboard API Worker/proxy code is unchanged and needs no redeployment for
   this frontend change. If an authorised Pages rerun is necessary:

   ```bash
   gh workflow run uk_aq_ops_dashboard_pages_deploy.yml --repo TEST-uk-aq/uk-aq-ops --ref main
   ```

   Update the operator's local **TEST** checkout to the same approved files, then
   restart/inspect only the already-installed TEST dashboard service:

   ```bash
   launchctl kickstart -k "gui/$(id -u)/uk.co.ukaq.dashboard.test"
   launchctl print "gui/$(id -u)/uk.co.ukaq.dashboard.test"
   ```

   For a manual local TEST start, use `local/scripts/run_dashboard.sh` from that
   TEST checkout with its existing TEST configuration. Do not start a second
   service, read/copy LIVE configuration or restart the shared Tunnel.
3. On **both protected hosted and local TEST dashboards**, hard-refresh, open
   Media > Threads, and inspect the actual browser network traffic. Opening and
   Refresh status should issue a settings GET through the configured Media proxy,
   with no PUT or publish request. No Meta request, browser token or environment
   fallback may appear. Existing protection/authentication must still apply.
4. Confirm Manual publishing enabled matches persisted state; Automatic publishing
   enabled is unchecked on first disabled installation; the explanation states
   future genuine approvals, first watermark and no historical backfill. Compare
   displayed identity/check/expiry/cooldown, activation, availability, holds/counts
   and bounded errors with the real GET response. With no TEST Threads credentials,
   automatic enable must remain disabled with Media's reason. Do not attempt to
   override eligibility. An unexpected persisted automatic=true requires operator
   review rather than proceeding with test publishing.
5. Save without editing: verify no PUT. Make an authorised cooldown-only change:
   confirm PUT contains only `cooldown_minutes` and an idempotency key, with both
   booleans omitted; reload and confirm both persisted switches and the activation
   watermark are unchanged. Restore the cooldown with another deliberate save.
   Repeat from the other dashboard. A permitted manual-only change must omit
   automatic/cooldown; an automatic-only disable must omit manual/cooldown. Do not
   enable a remote channel just to manufacture these cases.
6. Where legitimate backend eligibility permits a separately authorised automatic
   enable action, checking Automatic must reveal an initially unchecked future-post
   acknowledgement. Save must not submit without acknowledgement. Unchecking and
   rechecking must clear it; cancel/refresh/reopen must discard unsaved consent.
   The accepted enable body must contain only the changed automatic setting and
   `acknowledge_future_auto_approvals:true`; the actual response/refresh must supply
   the watermark and persisted state. Turning automatic off must require no
   acknowledgement and leave Manual unchanged. In credentialless TEST, successful
   remote-enable submission is unavailable: record that limitation, never fake
   eligibility or substitute LIVE credentials. The separate approved capture-only
   workflow must be accepted using its eventual reviewed backend API.
7. After the Media capture-only prerequisite is implemented and separately
   authorised, observe a **real new genuine auto-approved discovery** through the
   real TEST service. Inspect its article detail from both dashboards: exactly
   the returned event-scoped automatic row, Automatic approval label, actual
   event ID, queued/captured/held state and error information. Compare with Media's
   authoritative data and normal rediscovery to confirm the same identity. Do not
   insert synthetic events, replay historical approvals or generate fake posts.
   A manual result alongside it must retain its manual reason and actual fields.
   Empty/unknown/posted history must display honestly; use existing real data for
   other states rather than deliberately causing an ambiguous provider outcome.
8. Recheck each existing manual group: single/bulk Approved transitions and
   single/bulk direct publishing. There must still be exactly Bluesky, Facebook,
   Threads and All/None, initially unchecked. All/None must select only eligible
   destinations, show partial state, and clear correctly; unavailable destinations
   stay disabled. Changing targets, reopening dialogs and choosing a non-Approved
   status must clear consent. Only the original three destination booleans belong
   in those operations. Neither automatic setting nor its acknowledgement may
   enter a manual publication payload. Do not submit a social post solely to test
   selection. Confirm ordinary editorial approval and independent Facebook,
   Bluesky, public-feed and email operation through their authorised TEST checks.
9. Record hosted and local results separately, including the backend/frontend
   versions, auth, unchanged-setting payloads, watermark, real event/history
   evidence and any unavailable paths. The original manual pilot exception is
   consumed. This dashboard PR alone does not establish TEST capture acceptance,
   external Meta acceptance, permission to promote, or permission to activate.

## Rollback and documentation ownership

Before a separately authorised frontend rollback, examine persisted automatic
state. If it must be stopped, an authorised operator must explicitly disable it
through Media; reverting the frontend does not disable backend publishing.
Restore/redeploy the complete approved pre-change `dashboard/assets/media.js` and
update local TEST to the same source. Do not execute archives, reverse Media's
forward migration, delete queued history or change the manual switch implicitly.

Chat-mode system-doc ownership should record this dashboard implementation/PR,
its selected Media dependency, separate capture-only prerequisite and later real
hosted/local acceptance evidence. Authoritative Threads/dashboard contracts remain
read-only and unchanged by this task.
