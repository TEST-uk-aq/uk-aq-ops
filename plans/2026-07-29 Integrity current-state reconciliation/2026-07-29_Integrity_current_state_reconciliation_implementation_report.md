# Integrity current-state reconciliation implementation report

Implementation date: 29 July 2026

Status: implementation and deployment complete; the bounded real CIC-Test
validation completed from this workstation is recorded below.

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
R2 History and Latest Snapshot contracts can now be changed to implemented.
The exact names and behaviour to record are those in this report.

## Deployment and validation

- Schema commit `c927d80` was pushed to TEST schema `main` and migration
  `20260729_001_ingest_timeseries_current_state_reconcile.sql` was applied to
  the TEST IngestDB. The function is security-definer with an empty
  `search_path`; `anon` and `authenticated` have no execute privilege and
  `service_role` does.
- Operations commit `0eba5e7` was pushed to TEST operations `main`.
- GitHub Actions run `30441785749` deployed the Latest Snapshot service and
  scheduler successfully. Run `30442003052` repeated the deployment and
  completed the new Cloud Run invoker IAM step successfully.
- Repository variable `GCP_LATEST_SNAPSHOT_INTEGRITY_INVOKER_PRINCIPAL` is set
  to the existing TEST operations service account
  `uk-aq-ops-job@project-53835517-a266-48e3-8d9.iam.gserviceaccount.com`.
- The deployed private route rejects unauthenticated calls with HTTP 403.
- A service-role call to the deployed TEST RPC with an empty candidate array
  returned HTTP 200 and all zero counts. This was a real, non-mutating endpoint
  check.
- A normal scheduled Latest Snapshot operation completed after deployment at
  `2026-07-29T10:06:10.759Z`: manifest build status `ok`, three pollutant
  products successful, zero failed, and all configured windows present.
- On 29 July 2026, an authenticated empty-candidate call using an
  audience-specific token from the impersonated TEST operations service
  account returned HTTP 200. All three products succeeded, no durable state or
  product content changed, and all three unchanged products were skipped.
- The local Integrity token helper required explicit service-account
  impersonation when requesting the configured audience. It now constructs one
  audience-specific `gcloud` command from the standard Cloud SDK account and
  impersonation environment variables, and the incorrect audience-less
  fallback has been removed. No Cloud Run, IAM or schema redeployment was
  required for this correction.
- A repair-bearing Integrity run was deliberately not invented: real
  reconciliation still requires an operator-selected authoritative source/day
  scope. Once supplied, the normal CIC-Test Integrity command will exercise
  both reconciliation targets after its final R2 verification phase.

Pre-deployment validation was deliberately narrow: Python compilation, Deno
type checking, workflow YAML parsing, whitespace checks, the existing focused
Latest Snapshot tests, and one deterministic newer/older/equal/
same-timestamp-correction transition check. No browser, mock-environment, broad
or speculative test suite was added or run.
