# Controlled index-v3 Phase B acceptance helper

`index_v3_controlled_phase_b_acceptance.sh` is the operator wrapper for the first bounded steady-state Phase B write after observation-history index-v3 cut-over.

It is environment-neutral and is intended to be rehearsed on TEST and then reused on restricted LIVE with environment-specific repository, Git SHA, bucket, site URL and candidate identity values.

## Strict dry-run

`--dry-run` is a wrapper-level strict read-only planner. It does not call `runPhaseBBackup()` and does not write database, R2, Dropbox, GitHub or Cloudflare state.

It validates the loaded v2/v3/v2 history/index/Integrity authority, Git repository identity, maintenance state, disabled migration-sensitive scheduler rows, absence of an active Prune Daily workflow and Node 20. It then derives the exact next Phase B connector-day using read-only database queries, including source-content identity revalidation of current complete candidates.

The dry-run prints the candidate day, connector, row count, exact source-content hash/contract version and complete source pollutant set. These values are pinned as `--expected-*` arguments for `--apply`.

## Apply

`--apply` requires `--writers-frozen`, the exact candidate identity from a reviewed dry-run and a report path. It repeats the same preflight, acquires the existing global observations-operation lock as `prune_daily`, and invokes only `runPhaseBBackup()` with:

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

A source change between the read-only apply preflight and Phase B's own frozen source acquisition can cause the acceptance to fail after a valid normal Phase B write has occurred. The operation still retains the IngestDB source and does not enter source deletion. Keep maintenance ON and writers frozen on any failure and inspect the resulting generation before retrying.

Do not use the ordinary Prune Daily `dry_run` input as a substitute for this helper. Historical Prune/Phase B dry-run semantics are not the strict read-only contract implemented here.
