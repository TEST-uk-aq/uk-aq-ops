# Media Articles syndication review: implementation handover

Adds a compact disclosure inside **Articles**, without another top-level Media
page. The shared frontend consumes Media's authoritative candidates and decisions;
the browser contains no title matcher or D1 authority.

Active files changed:

- `dashboard/assets/media.js`: bounded candidate-group/member/history pages,
  publisher-original metadata and links side by side, optional-date discrepancy
  evidence, manual classification, explicit representative and secondary visibility,
  individual undo and group reversal. Exact-text confirmation is visibly unavailable
  without complete permitted comparison evidence. Changing the comparison
  representative clears local attestations and requires fresh decisions. Revision
  conflicts leave controls disabled until the operator reloads current evidence.
- `dashboard/assets/media.css`: responsive comparison cards and audit presentation.
- `workers/uk_aq_dashboard_online_api_worker/src/routes/media.ts` and
  `local/dashboard/server/uk_aq_dashboard_media_proxy.py`: identical narrow
  GET list/detail and POST decision allowlists. Existing authenticated routing,
  configured `UK_AQ_MEDIA_ADMIN_URL` / `UK_AQ_MEDIA_ADMIN_TOKEN`, body limits,
  `If-Match` and `Idempotency-Key` forwarding are reused. The separately authorised
  metadata-population route is intentionally unavailable to browser proxies.
- `archive/2026-11-04/`: exact pre-change runtime snapshots, reference only.

The existing **Possible duplicate** automatic safety hold and Article Status controls
remain distinct from **Possible syndicated article** review. No status options,
source permissions, discovery logic or social/email controls changed. No new settings,
hard-coded environment targets or cross-environment fallbacks.

Checks performed: JS syntax (`node --check`), Python compilation, dashboard API Worker
TypeScript (`tsc --noEmit -p workers/uk_aq_dashboard_online_api_worker/tsconfig.json`)
and `git diff --check`. These are structural checks, not functional acceptance.

Deploy Media migration **0059**, public/admin/discovery Workers **before** enabling
operator use of the Ops controls, then deploy the hosted API Worker and Pages assets
through existing TEST workflows. Update/restart the local TEST dashboard separately
when authorised. Media owns the schema/API/public-presentation logic and the full
rollout, population, real TEST acceptance and rollback instructions in
[`docs/syndication-review-rollout.md`](https://github.com/TEST-uk-aq/uk-aq-media/blob/codex/cross-publisher-review/docs/syndication-review-rollout.md).

No migration, retrospective processing, deployment, remote setting mutation or
publication was performed. Relevant merge-to-main workflows may deploy automatically;
merge/deployment needs subsequent operator authorisation. No LIVE work was performed.

Rollback through reviewed active-file Git reverts and the existing TEST deployment
process, preserving unrelated changes. Restore both proxies with the frontend.
Do not execute archived code or drop Media's additive audit tables. Backend group/
member Undo restores normal editorial visibility without cancelling or replaying
publication history. Actual hosted/local, candidate, classification, reversal,
fail-open and no-publication-side-effect acceptance must be recorded after an
authorised TEST deployment before any operator-led promotion to LIVE.
