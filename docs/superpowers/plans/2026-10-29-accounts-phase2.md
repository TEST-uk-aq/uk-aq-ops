# Accounts Phase 2 implementation plan

Goal: implement the approved TEST-only subscriber administration and canonical blocked status, without deployment or subscriber operations.

Authority: latest Accounts dashboard contract section 8 and Media News email contract section 26 in TEST-uk-aq/uk-aq-system-docs (read through GitHub because the local snapshot predates approval).

Architecture: keep the private Supabase lifecycle authority, a separate bounded service-only administrative mutation RPC, existing hosted/local personal Access verification, and shared Accounts detail UI. Check authoritative recipient eligibility at direct SMTP and optional Pro submission boundaries. Preserve Media D1 history.

- [x] Schema: archive canonical SQL; rename permanent block status/fields, add transactional individual mutations and UUID/timestamp tombstones, add a fresh eligibility action; create one forward migration with the same canonical function definitions and preserved historical migrations.
- [x] Media: archive affected source; pass an eligibility snapshot to the final send boundary and optional Pro; fail closed on deleted, blocked or stale work without altering accepted/unknown handling.
- [x] Ops: archive affected source; implement POST /api/accounts/subscriptions/:uuid/actions with bounded JSON, explicit confirmation, stale-detail revision checks and CSRF protection, using identical hosted/local validation and fixed response projection. Keep GET Email Delivery unchanged.
- [x] UI: add active-only preference form and individual confirmed Block/Unblock/Unsubscribe/Delete actions; refresh authoritative counts/detail and preserve private-state cleanup.
- [x] Website: inspect public lifecycle integration; change only if it consumes permanent subscription status/fields.
- [x] Verify syntax/types, SQL parsing and canonical/migration equality, configuration and diff hygiene. No speculative functional suite or remote data operations.
- [x] Review whole change and resolve findings. Document coordinated paused-sender migration/deployment order, rollback limits, retention blocker and real post-deployment TEST acceptance.
- Delivery: commit/push the three TEST review branches and open main PRs; report immutable commit IDs and links in the final task response.

Review focus: token/subscription lock ordering during deletion; stale queued work and optional fallback delay; blocked opt-out/resubscription; Daily cursor preservation and preference revisions; signed personal authentication, cross-origin writes and private uncached projections.

Decisions: use POST actions with explicit confirmed=true and expected_updated_at; no new login, secrets or deletion purge schedule. Existing SUPABASE_URL/SB_SECRET_KEY are reused by the optional Pro sender and must be supplied there before enabling it. Retention agreement gates deletion deployment, not preparation of reviewable code.

Review outcome: independent review found two recovery gaps (lost Pro cancellation receipt; historical confirmation reconciliation after deletion). Both are corrected and the same reviewer verified the fixes. No remaining critical/important findings. Structural verification only; operational acceptance remains pending deployment and retention agreement.
