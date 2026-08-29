# Controlled index-v3 Phase B acceptance helper

`index_v3_controlled_phase_b_acceptance.sh` is the operator wrapper for the first bounded steady-state Phase B write after observation-history index-v3 cut-over.

It is environment-neutral and is intended to be rehearsed on TEST and then reused on restricted LIVE with environment-specific repository, Git SHA, bucket, site URL and candidate identity values.

## Strict dry-run

`--dry-run` is a wrapper-level strict read-only planner. It does not call `runPhaseBBackup()` and does not write database, R2, Dropbox, GitHub or Cloudflare state.

It validates the loaded v2/v3/v2 history/index/Integrity authority, Git repository identity, maintenance state, disabled migration-sensitive scheduler rows, absence of an active Prune Daily workflow and Node 20. It then derives the exact next Phase B connector-day using read-only database queries, including source-content identity revalidation of current complete candidates.

The dry-run prints the candidate day, connector, row count, exact source-content hash/contract version and complete source pollutant set. These values are pinned as `--expected-*` arguments for `--apply`.

## Apply

`--apply` requires `--writers-frozen`, the exact candidate identity from a reviewed dry-run and a report path. It repeats the same preflight, acquires the existing global observations-operation lock as `prune_daily`, then acquires a temporary PostgreSQL `SHARE` lock over the canonical Phase B source tables:

- `uk_aq_core.observations`;
- `uk_aq_core.timeseries`;
- `uk_aq_core.phenomena`;
- `uk_aq_core.observed_properties`.

The source-table lock is held only for the controlled apply child. It prevents source observations or their canonical metadata from changing while the acceptance runner re-derives and verifies the pinned source-content identity and while `runPhaseBBackup()` acquires its repeatable-read frozen source and publishes/finalises the selected connector-day. Normal upstream ingest may wait briefly on this lock during the acceptance operation. The lock transaction performs no persistent database mutation and is rolled back solely to release the locks when the child finishes or fails.

The source-freeze coordinator starts the controlled Phase B child with `TZ=UTC`. This is a required acceptance invariant so PostgreSQL `DATE` values have the same calendar-day semantics on an operator Mac in BST as they do in the normal GitHub Actions runtime. The UTC child timezone is included in the source-freeze evidence report.

The controlled runner invokes only `runPhaseBBackup()` with:

- `max_candidates_per_run=1`;
- accepted snapshot cap 250000 rows;
- accepted snapshot cap 268435456 bytes;
- all-property complete connector-day source;
- optional Phase B Dropbox comparison disabled;
- effectively disabled unrelated staging cleanup for the controlled run.

It never invokes the full Prune Daily job, so normal prune, late-arrival cleanup and IngestDB atomic deletion are outside this operation.

After the write it requires exactly one completed Phase B candidate, zero candidate/aggregate failures, the exact pinned source-content hash in completion evidence, unchanged retained IngestDB source identity, a completed connector-day gate owned by `prune_daily_phase_b`, and a canonical connector manifest whose pollutant child set exactly matches the dry-run source snapshot.

The JSON evidence report contains identities and counts only. It does not contain raw observation values.

## Safety boundary

The reviewed dry-run source identity is checked again after the source-table `SHARE` locks are held. Because those source tables cannot then be modified until the controlled Phase B child finishes, a source-content change cannot race between the accepted candidate/hash check and Phase B's frozen-source acquisition/publication.

If the source changed before the apply lock was obtained, the apply-side candidate/hash check fails before `runPhaseBBackup()` publishes the connector-day. If the source lock cannot be obtained within its bounded timeout, the operation stops without starting the controlled Phase B child.

Any apply failure still leaves maintenance ON and migration-sensitive writers frozen. The full Prune deletion path is never entered and the selected IngestDB source is deliberately retained for rollback-data preservation.

Do not use the ordinary Prune Daily `dry_run` input as a substitute for this helper. Historical Prune/Phase B dry-run semantics are not the strict read-only contract implemented here.
