# Integrity current-state reconciliation implementation report

Implementation date: 29 July 2026

Status: implementation complete; deployment and real CIC-Test validation are
recorded below after execution.

## Implemented interface

- IngestDB RPC:
  `uk_aq_public.uk_aq_rpc_timeseries_current_state_reconcile(text, jsonb)`.
  It is executable only by `service_role`, accepts at most 1,000 unique raw
  latest candidates per call, locks matched timeseries rows, and returns the
  contracted monotonic outcome counts.
- Latest Snapshot route: `POST /internal/integrity-reconcile` on the existing
  `uk-aq-latest-snapshot-builder` Cloud Run service.
- Authentication: Cloud Run IAM identity token; unauthenticated invocation
  remains disabled and no application bearer secret was added.
- Integrity switch:
  `UK_AQ_INTEGRITY_CURRENT_STATE_RECONCILIATION_ENABLED`.
- Integrity configuration:
  `UK_AQ_INTEGRITY_TIMESERIES_RECONCILIATION_RPC`,
  `UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_URL`,
  `UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_AUDIENCE`, and
  `UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_TIMEOUT_SECONDS`.

## Behaviour

Integrity derives raw database candidates and Latest Snapshot source rows only
from immutable canonical source evidence for connector-days that passed final
R2 verification. Check-only and dry-run modes report the plan without calling
either mutation target. Real reconciliation runs after final verification and
records separate R2 history, timeseries, Latest Snapshot, and overall statuses.

The owner service validates request size and shape, fails closed on unreadable
durable state, resolves metadata and pollutant identity, applies the existing
eligibility policy, handles newer/older/equal/same-timestamp-correction state
transitions, and then uses the normal product and manifest builder. The route
does not consume or acknowledge Pub/Sub.

## Authoritative-document handover

Repository rules reserve `system_docs/` edits for Chat mode, so no authoritative
contract file was modified. The pending-implementation wording in the listed
R2 History and Latest Snapshot contracts should be changed to implemented only
after the deployment and validation status below is final. The exact names and
behaviour to record are those in this report.

## Deployment and validation

Pending execution.
