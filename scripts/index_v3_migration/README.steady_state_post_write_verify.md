# Observation-history index v3 steady-state post-write verifier

`index_v3_steady_state_post_write_verify.sh` is the strictly read-only gate for
an accepted post-cut-over steady-state observation publication. It is not a
replacement for `index_v3_post_cutover_verify.sh`: the cut-over verifier pins
the immutable migration generation, while this verifier authenticates and
validates the legitimately advanced steady-state generation.

The wrapper's `--help` output is the CLI reference. Every environment,
repository, bucket, Git SHA, accepted run/scope/content identity, worker name,
baseline input and output path is explicit. The accepted report itself is
pinned by an operator-supplied SHA-256. Use Node 20.

Evidence sources are:

- local Git plus read-only GitHub repository, variable, workflow and deployment-log reads;
- public maintenance-mode HTTP GET and one remote D1 scheduler `SELECT`;
- an explicit check that neither Prune nor the observation-history Dropbox backup workflow is active;
- the existing durable writer-freeze and immutable v2 runtime rollback validators;
- the successful controlled Phase B report, including its source-freeze coordinator evidence;
- independent IngestDB `SELECT`s, all enclosed in an explicit PostgreSQL `READ ONLY` transaction that is rolled back, and recomputation of source-content-hash v1;
- canonical R2 connector, pollutant, day and aggregate manifests plus Parquet `HEAD` checksum evidence;
- current v3 latest-global, scoped and child objects, validated by production readers;
- the authenticated completed-migration recovery journal as the post-migration/pre-steady-state hierarchy baseline;
- the pinned local Dropbox state-root identity, read only to prove the first post-v3 backup has not been started;
- a cache-bypassed ranged station-series HTTP GET using an accepted-scope timeseries selected from v3 authority.

The hierarchy comparison never uses the pre-migration Dropbox source hierarchy
as a steady-state baseline. The accepted day must be absent from the completed
migration recovery journal. All authenticated unaffected day manifests,
including `--required-unchanged-day`, must still match exactly. Only the
accepted month, year and root aggregate lineage may advance, and its current
objects must contain exactly the authenticated sibling children with the
accepted branch identity replaced. All unaffected completed-migration v3
scoped/child objects remain exact, and latest-global must contain exactly the
authenticated baseline canonical days plus the accepted day while retaining
every older day summary exactly.

Dependency outcomes are recorded as `EXACT`, `LEGACY_RECOVERY_ORDERING` or
`FAIL`. A newly written steady-state v3 scope is exact-only in both TEST and
LIVE: `FAIL=0` and `LEGACY_RECOVERY_ORDERING=0` are mandatory.
Missing/extra pollutants, source/gate/run mismatches, lost source rows,
checksum/size mismatches, non-v3 physical schema, hard writer-limit violations,
invalid baseline provenance, stale deployment evidence or an unsuccessful
deployed read all fail closed. A whole-day gate blocked solely by pending peer
connectors is valid.

Before any PASS or FAIL report can be written, `--report-out` is canonicalized
and proven distinct from every supplied input evidence file and the checkpoint,
and outside both the checkpoint recovery directory and the supplied Dropbox
root. This prevents the verifier report from overwriting migration or operator
authority evidence.

PASS means only:

```text
STEADY-STATE POST-WRITE VERIFY PASS
ELIGIBLE FOR FIRST LOCKED POST-v3 DROPBOX BACKUP.
MAINTENANCE AND WRITER FREEZE REMAIN REQUIRED.
```

It does not authorize Prune, source deletion, writer resumption, maintenance
removal, rollback-preservation closure or backup execution. The cache BYPASS
probe proves the deployed route and historical R2 rows; because it cannot prove
an inner fresh R2 read, the JSON report records that limitation as a warning.
