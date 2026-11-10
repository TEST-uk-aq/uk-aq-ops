# Bounded cyclic TEST Prune discovery

Repository-only implementation, 10 November 2026. No migration, deployment,
Prune invocation or operational database/R2 access was performed.
Authority: TEST system-docs `system_docs/r2_history/prune_late_arrival_discovery_contract.md`.

## Behaviour

`server.mjs` uses `late_arrival_discovery.mjs` for discovery/scheduling and
`late_arrival_progress.mjs` for private PostgreSQL progress. It invokes the same
`runLateArrivalDirectDeleteDay` and `runPruneSingleWindow` functions, sharing the
normal run's processed-connector/day set. Phase B, committed-history admission,
source identity, connector gates, READY/CONSUMED atomic deletion, global operation
exclusion and PR #190's conditional ObsAQIDB comparisons are unchanged.

The existing `uk_aq_public.observations` view supplies an ordered one-row earliest
timestamp seek. Complete dates use `uk_aq_rpc_observation_day_presence_v1(date,date)`;
validation requires exact bounds, schema/completeness/cardinality, consecutive
dates, Boolean presence and consistent UTC timestamps (within five minutes of
the application clock). A partial cutoff date uses a separate exact timestamp
seek with `observed_at < cutoff`. Presence includes null-valued observations.
There is no row-offset fallback, observation scan/count/sort in the application,
new observation RPC/index, fixed history floor or new environment variable.

Limits per invocation are fixed:

- 31 calendar dates per page, at most 8 presence pages (248 complete dates).
- At most 10 discovery HTTP requests including earliest/boundary seeks.
- 20-second HTTP request timeout, capped by the remaining discovery deadline.
- 120 seconds to admit requests/new day work, including time spent processing
  earlier days. An already-started existing day operation finishes safely before
  checkpoint/stop; this is not a cancellation deadline for an atomic deletion.
- At most 14 repair days and, separately, 14 direct-delete days.
- Progress SQL: 15-second connection/statement and 20-second client query limits.

The normal 48-hour Prune window is unchanged. Each sweep freezes its start as an
exclusive cutoff, but historical coverage extends to the actual earliest row.
If configuration moves the current cutoff earlier, restart conservatively rather
than process now-ineligible dates. On completion, the next invocation starts a
fresh sweep with the current cutoff and earliest observation, revisiting inserts
behind the old cursor. One invocation does not repeatedly cycle the same dates.

The private singleton row is protected by a dedicated retained PostgreSQL session
advisory lock (not the canonical observations-global lock). Claims are nonblocking;
overlap reports attention required. Claim transactions are short. Checkpoints
compare owner UUID and version and atomically record the bounded considered-day
outcomes with advancement. No transaction spans RPC/R2/day work. Closing/crashing
the session releases the lock; the next owner resumes the last acknowledged or
committed checkpoint. The connection must be direct/session-preserving, as for
the existing Prune PostgreSQL safety paths; transaction-pooling is unsuitable.

Absent days and explicitly reported gate-blocked days can advance. Deferred
positive dates remain at the cursor; ambiguous processing/repair/deletion errors,
malformed RPC responses and ownership/checkpoint failures stop without advancing
that date. Unknown checkpoint acknowledgements are reported explicitly and not
blindly retried. Replays remain subject to the unchanged single-use deletion gates.
The dry-run path reads the state without claiming or saving and labels simulated
progress separately from the stored cursor.

Reports distinguish examined/absent/discovered/processed/blocked/failed/deferred
dates, bounded positive outcomes, cursor/cutoff, requests/pages, sweep completion
and wraparound. Remaining calendar dates are known; remaining positive dates are
unknown until checked. `processed` does not mean `deleted`. `last_report` is the
bounded latest invocation checkpoint, not a new historical authority ledger.
Detailed existing day logs/reports remain in use. Deferred, failed and blocked
late-arrival work makes the outer run attention-required rather than green.

## Deployment order and operational acceptance (separate authorisation)

1. Review/merge the Schema dependency and apply only
   `20261110_001_ingest_prune_late_arrival_progress.sql` using its handover.
   The presence RPC was already confirmed installed; do not reapply its migration.
2. Confirm the private table and actual Prune role's access. Do not broaden access
   or bypass missing-state failures. Then merge/activate the reviewed Ops code.
   The active repository workflow `.github/workflows/uk_aq_prune_daily.yml` runs
   `workers/uk_aq_prune_daily/job.mjs` from its selected checkout; it needs no new
   environment setting or workflow change. Code activation and workflow dispatch
   are separate operator actions; this task does neither.
3. Authorise one dry-run: confirm 20–23 October where still present, exact cutoff,
   finite requests/time, deferred cursor, and zero discovery-state mutations.
   Record actual latency: existing TEST evidence includes a sequential EXISTS plan,
   so fewer rows transferred is not a guaranteed index-only plan or runtime bound
   for PostgreSQL scanning. HTTP timeout does not prove server-side cancellation.
4. Authorise controlled write-enabled TEST work: verify cursor versions/outcomes,
   14-day caps, continuation, blocked-scope reporting and a later wraparound.
   Observe overlap/restart handling without manufacturing source mutations or
   weakening gates. Check existing full connector-day/R2/source/READY safeguards
   on any naturally eligible deletion. A green workflow alone proves neither
   complete discovery nor deletion eligibility.

On rollback, stop/deactivate the changed consumer before reverting code; retain
the additive table/report for diagnosis. Returning to the old scanner restores
its known incompleteness and is not accepted as healthy discovery. Do not reset
history candidates/gates, reissue READY or delete source rows to repair a cursor.
No LIVE work, merge, deployment or automatic historical reconciliation is included.

## Documentation handover

Chat mode may update the authoritative discovery contract with the exact limits,
private singleton/session-lock/version model, next-invocation wraparound and
attention-required deferred outcomes after reviewing the PRs. Record code-only
status until separate TEST application and operational acceptance. Codex made no
system-doc changes. The original server is preserved under
`archive/2026-11-10/workers/uk_aq_prune_daily/server.mjs` for reference only.
