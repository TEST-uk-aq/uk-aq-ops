# Bounded immutable migration-generation verification

Implementation/review handover, 16 October 2026. This document is not operational
authorisation, a system contract, or evidence of real TEST acceptance. No LIVE
repository, R2, Supabase, deployment, scheduler or generation was changed.

The new entry point is `index_v3_bounded_immutable_verify.mjs`. It verifies the
same frozen side-by-side migration generation as the existing full-memory LIVE
verifier. It preserves `pre-cutover` (selected v2) and `read-cutover` (selected v3).
Read-cutover remains valid only before the first normal v3-only history write.
Neither path verifies deployed website/cache acceptance or releases writers.

## Why memory grew

The old path retains the complete authenticated journal and its completed-object
Map, deep-clones the checkpoint, then creates additional completed-evidence Maps.
The sharded plan reader reconstructs the entire plan despite bounded shard files.
Replay accumulates every publication evidence record. Reconstruction holds all
prepared metadata, canonical manifests, exact-leaf bodies, global publication
objects, graph Maps, dependency Maps and reconciliation classifications together.
Large stable serialisations create additional transient copies. Independent
logical verification buffers all source/target Parquet files in a partition,
decoded row collections, normalised rows and sorted encoded rows. Lower R2
concurrency alone does not remove those allocations.

## Structure and authentication

1. Admission reuses LIVE repository/environment checks. An explicit TEST mode
   requires TEST main, independently checked GitHub main/environment/selector,
   a matching loaded bucket and a non-LIVE R2 account. Both require the existing
   supervised observations global operation lock with the migration owner/run ID.
2. Original checkpoint bytes/size/SHA are bounded-read and matched against the
   authenticated manifest. The accepted input is the original empty immutable
   `authenticated-journal-v1` checkpoint with sharded authority. Converted,
   rewritten, inline or legacy checkpoints are rejected; the old verifier remains
   available for its existing formats. Never rewrite evidence to gain admission.
3. Each plan shard is size/hash/canonical authenticated in descriptor order.
   Recursive array/string spans, exact shard set, master identity and reconstructed
   full-plan SHA are checked. A SQLite JSON tree receives the values. A depth-first
   canonical stream hashes the entire plan and its plan-identity subtree without
   materialising either. Pinned generation, source, runner, bindings, empty-source
   connectors, writer limits and complete unit order are checked independently.
4. The journal directory must contain exactly sequences 1..head. One bounded
   entry is parsed at a time; its complete canonical payload SHA, checkpoint and
   authority identities, sequence, previous SHA and terminal head are checked.
   All completion occurrences are authenticated. Equivalent duplicates retain
   their original sequence; any changed evidence field fails. Prepared records,
   state changes, completion identities, publication records and journal SHAs are
   written to disposable SQLite tables. Unknown updates, incomplete preparation,
   regressing final state or absent clean-start evidence fail closed. The disk
   journal is branded only after complete chain authentication.
5. The original shared replay-digest function accepts ordered disk iterators.
   Its domain, fields and encoding are unchanged; no second digest definition is
   introduced. Complete prepared identities, staging progress, order, completions,
   clean-start admission and terminal flags remain bound. Prepared bodies and
   prepared-plan hashes receive full existing validation before reconstruction.
6. The exact LIVE exceptional run retains its independently pinned original
   journal anchor, original completion/publication counts, original writer Git
   blobs and all approval epochs. The existing epoch validator verifies each
   approval phrase/hash, sequence, ancestry, frontier SHA, approved implementation
   files/Git ancestry, source, account, bucket and historical GCP runner. Indexed
   journal SHA lookups and SQL counts replace the global journal array/Map.
   Verification on the Pro does not claim to resume the historical GCP runner.
7. Existing deterministic builders reconstruct one bounded scope at a time.
   Every leaf/scoped manifest receives the existing semantic validation.
   Canonical parents are built one day at a time with exact parsed child-body
   property order; only three-field day summaries enter global aggregates.
   Compact validated root descriptors build and validate latest. No global leaf
   body array survives. Expected object identities and both graph-edge types are
   stored in SQLite; all authenticated completions must be explained.
8. SQLite implements the original eligible-node order (stage, then UTF-8 key).
   The ORIGINAL canonical publication-schedule encoder consumes indexed disk
   array views. Every publication occurrence must match key, size, SHA, position,
   schedule SHA, stage when recorded and verification flags. Every required v3
   object must have publication evidence; changed/external dependency closure is
   checked completely. Cycles, omissions and contradictory edges fail closed.
9. Fresh bounded JSON GETs verify every expected canonical/index/binding body.
   Target Parquet additionally requires current exact HEAD/stored-SHA evidence;
   whole-file hashing never substitutes for missing stored SHA. Source bindings,
   source manifests and every source/target Parquet file are independently read
   and hashed. One bounded Parquet file is decoded at a time. Canonical v1 row
   strings are sorted by a SQLite index, including duplicate multiplicity, then
   streamed through the existing v1 hash prefix/encoding. ASCII is asserted so
   SQLite BINARY order exactly matches JS string sort. Source/target/planned row
   counts, full content metadata, P/R/null counts and every target stable binding
   must agree. No sampling or approximate identity is used.
10. The unchanged v2 source root is checked before and after all current R2
    checks. Checkpoint and recovery anchors are rechecked before completion.
    Every expected R2 dependency and every partition must have completed.

Current verifier roots include the new modules and the lock supervisor. Their
actual literal relative-import closure is authenticated against tracked regular
files at clean current HEAD, including imports/re-exports/dynamic literal imports.
Worker/supervisor URL entrypoints remain explicit roots. No archive is executed.
The historical ten-file semantic dependency list is **unchanged**. TEST schema-4
work is neither copied nor adopted as historical semantics. Imports present only
in TEST are not unconditional LIVE requirements. A historical semantic mismatch
is still STOP, never an instruction to weaken the pin.

## Resource controls and storage

Use Node 25.8.1 on the Intel Pro as requested. `node:sqlite` is built into that
runtime; the boundary check also passed with Cloud's Node 24.19.0. No npm/native
addon dependency or package/lock/engine change is required. The new path requires
a runtime with unflagged `node:sqlite`; existing Node >=20 paths do not import it
until this new store is opened. Supported target runtime/OS acceptance is pending.

Defaults and admission limits:

| Resource | Bound |
|---|---|
| Node old-space setting | Operator command uses 4096 MiB |
| Process RSS | Fail incomplete if observed above 6 GiB at progress boundaries |
| R2 concurrency | 1; configurable 1..4 |
| Transaction/yield batch | 128; configurable 1..1024 |
| GET body | 128 MiB maximum; configurable up to 256 MiB |
| One Parquet decode | 250,000 rows / 256 MiB declared uncompressed bytes; caps configurable up to 500,000 / 512 MiB |
| Checkpoint/report/master/shard | 4 MiB each |
| Journal entry | 128 MiB |
| Scope reconstruction | Prepared JSON <=32M code units (64 MiB UTF-16), <=32,768 segments, <=8,192 files |
| Plan value / compact summary collection | 64 MiB accounting budget; depth <=128 |
| Exceptional epochs | <=128 entries, <=1 MiB each |
| SQLite cache / mmap | 32 MiB / disabled |
| SQLite main DB page cap | 32 GiB default; configurable `--max-scratch-gib` |
| Free-space reserve | 8 GiB, checked periodically |

The engineering target is approximately 4–6 GB RSS, not a measured full-archive
result. Small-boundary RSS is not archive-scale evidence. SQLite indexes grow with
the archive on disk; bounded records/summaries/file decodes and network buffers
bound RAM. Any individual limit exhaustion is an incomplete failure requiring
investigation. No limit authorises dropping rows, publications or journal entries.

Default admission requires **40 GiB available on the scratch volume** (32 GiB DB
budget plus 8 GiB reserve), in addition to space already occupied by the immutable
archive/extracted evidence, repository and installed dependencies. The supplied
evidence is about 683 MB compressed and 9.3 GB extracted; account for both when
provisioning a new volume. Extra room is advisable for other Pro services,
rollback journals and SQLite spills. This is capacity admission, not proof that
the real archive index fits 32 GiB. Real TEST must measure index expansion.

Scratch must be an existing directory outside evidence, the Git checkout and
Dropbox (real paths checked). Each invocation creates a private unique
`index-v3-verify-*` child. SQLite spill placement uses its standard process-local
`SQLITE_TMPDIR` directed at that child. No new repository environment key is added.
SQLite page limits, visible scratch-size checks and available-space reserve checks
fail closed; ENOSPC cannot turn progress into acceptance. SQLite spills may be
unlinked while open, so the free-space check also matters. These are scratch-only
writes, never evidence repair or migration authority.

Bounded GET has one attempt and an existing 30-second request/body deadline;
existing HEAD transport retains its bounded retry policy. There is no full-run
deadline, aggressive polling or unlimited retry loop. One logical decoder and
concurrency 1 preserve headroom for operational services, Plex, Dropbox and Time
Machine. Use nice priority as below.

## Proposed Pro procedure (requires later operational authorisation)

First accept the code through real TEST. Any later LIVE promotion is separate and
must preserve historical semantic files rather than copying unrelated TEST
schema-4 changes. Do not execute an unreviewed working tree. No deployment, merge,
promotion or operational run is authorised by this implementation PR.

On the Pro itself:

1. Keep AC power and network available, allow no idle sleep, and keep the lid in
   a state that permits operation. `caffeinate` does not guarantee survival of
   lid closure, power loss or reboot. The Air is not needed once launched.
2. Use the existing environment/profile loader locally on the Pro. Required
   loaded values are `UKAQ_ENV_NAME` and/or existing environment aliases,
   `UK_AQ_R2_HISTORY_VERSION` (v2 for pre-cutover, v3 for read-cutover),
   `UK_AQ_R2_HISTORY_INTEGRITY_VERSION=v2`, `CFLARE_R2_ENDPOINT`,
   `CFLARE_R2_BUCKET`, `CFLARE_R2_ACCESS_KEY_ID`, `CFLARE_R2_SECRET_ACCESS_KEY`,
   and optional existing `CFLARE_R2_REGION`. The lock coordinator requires the
   existing session-preserving `SUPABASE_DB_URL` or `DATABASE_URL` for the SAME
   environment. GitHub CLI authentication must allow read-only main/variable
   checks. Do not print credentials or manually manufacture lock-context values.
3. Review the exact current verifier main SHA independently. Make that SHA
   available as the shell-local `VERIFIER_SHA` below. The checkout must be clean,
   on that environment's `main`, equal GitHub main, and retain all historical Git
   objects named by the original manifest and every exceptional epoch. The
   original LIVE writer stays `e84f52a6b0ddb6212fc6f321b875bb15244c4090`; it is
   deliberately distinct from today's trusted verifier SHA.
4. Retain the original archive and its already verified SHA. Extract a complete
   copy containing the original checkpoint, report, sharded master/all shards,
   recovery manifest/head/all entries and exceptional epoch directory with its
   private ownership/modes preserved. Select the extracted run directory as
   `EVIDENCE_ROOT`. No conversion, hand edits, journal-head repair or repinning.
5. Retain the existing writer freeze and all separate scheduler/runtime/rollback
   preflight evidence. This verifier's success is immutable-data verification;
   it does not replace current v2 runtime rollback or deployed-path acceptance.
6. Set the shell-local placeholders below from reviewed evidence/configuration;
   they are not new repository configuration variables. `CHECKPOINT` and
   `PLAN_REPORT` must name original files, `MIGRATION_RUN_ID` must equal the report,
   `SCRATCH_DIRECTORY` must have the capacity above, and `RUN_LOG_DIRECTORY`
   must be a new directory outside evidence/Dropbox/the checkout. For LIVE the
   supplied run ID is `live-v3-20261015T114250Z-e84f52a` and plan SHA is
   `1e960674e53cd2ddb3c5d08a3318fcce1abc72ebe7a2dc92e11e9ce9a4d79600`.

Run from the reviewed Ops checkout. The following command always enters through
the existing coordinator, retaining its same-session heartbeat and process-group
supervision. Its 60-second timeout is **lock acquisition**, not run duration.
Use `VERIFICATION_ENV=TEST` for separately authorised real TEST acceptance; choose
LIVE only after separate reviewed promotion and operational authorisation.

```bash
nohup /usr/bin/caffeinate -i /usr/bin/nice -n 10 \
  /bin/bash -c '
    exit_file=$1; shift
    set +e
    "$@"
    coordinator_status=$?
    printf "%s\n" "$coordinator_status" > "$exit_file.pending"
    mv "$exit_file.pending" "$exit_file"
    exit "$coordinator_status"
  ' bounded-verifier-run "$RUN_LOG_DIRECTORY/coordinator-exit-code" \
  node --max-old-space-size=512 \
  scripts/operations/uk_aq_with_observations_global_operation_lock.mjs \
  --owner observation_history_migration_v2_to_v3 \
  --run-id "$MIGRATION_RUN_ID" --timeout-ms 60000 --heartbeat-ms 5000 \
  -- node --max-old-space-size=4096 \
  scripts/index_v3_migration/index_v3_bounded_immutable_verify.mjs \
  --environment "$VERIFICATION_ENV" --phase "$VERIFICATION_PHASE" \
  --expected-repository-git-sha "$VERIFIER_SHA" \
  --expected-bucket "$CFLARE_R2_BUCKET" \
  --plan-report "$PLAN_REPORT" --checkpoint "$CHECKPOINT" \
  --evidence-root "$EVIDENCE_ROOT" --scratch-directory "$SCRATCH_DIRECTORY" \
  --r2-concurrency 1 --batch-size 128 \
  >"$RUN_LOG_DIRECTORY/result.jsonl" \
  2>"$RUN_LOG_DIRECTORY/progress.jsonl" </dev/null &
```

Record/monitor the background job PID and the Pro-local
`coordinator-exit-code` file. The small shell wrapper above records the actual
coordinator exit status after it returns, even if the launching terminal has
disconnected. Acceptance requires that file to contain `0`; a missing file is
incomplete. Use a new log directory so an earlier exit code can never be reused.
Never infer success just because a process disappeared. Do not launch a second coordinator inside an
already held lock; integrate the protected child into the existing holder when
one continuous separately authorised cutover session is already running.

Every 15 seconds at work boundaries, stderr and an atomically replaced scratch
`progress.json` report phase, journal/completion/publication records, verified R2
dependencies, logical partitions, elapsed time, RSS/heap/external memory and
visible scratch bytes. No row data or credentials are logged. Use these files
and Activity Monitor/disk free space for unattended monitoring. Logging is a
bounded-size record per interval, with one current progress file, not per-object
logs. Keep the supervisor/coordinator and its dedicated DB session running.

## Completion, interruption, restart and cleanup

Success requires the sole final JSON result `ok:true,state:COMPLETED`, all
partitions/dependencies, exact-only reconciliation, unchanged source root and
anchors, AND successful exit of the SAME lock coordinator. The result records
the supervised session nonce and explicitly requires that exit outcome. It does
not claim deployed-path acceptance, runtime switch or writer-release permission.
Progress records always carry `accepted_result:false`; they never contain PASS.
The last progress state may be `VERIFIED_PENDING_COORDINATOR`; the separate final
JSON and successful recorded coordinator exit are still required.

Lock/session/heartbeat/coordinator loss invokes the unchanged supervisor's process
group termination, including descendants. SIGINT/SIGTERM prevents further work
and emits INTERRUPTED where shutdown time permits; unexpected errors emit FAILED.
SIGKILL, power loss or ENOSPC may leave only IN_PROGRESS. All are incomplete.
Missing/contradictory evidence, absent stored SHA, source drift, graph/row/hash
mismatch, insufficient resources or an unknown mandatory format also mean STOP.
Retain the writer freeze and resolve the operational state separately.

There is **no acceptance resume** and no R2-check reuse in this version, including
after a controlled interruption. Every invocation creates a fresh private store,
reauthenticates the complete original evidence and repeats EVERY R2/logical check
under one new protected session. An old scratch database/progress file is never
input authority. This conservative policy avoids combining unrelated lock
sessions or claiming an earlier protected R2 observation is current.

Default cleanup keeps scratch for diagnosis. After the coordinator is stopped
and result/logs have been retained, remove only that invocation's reported
`index-v3-verify-*` directory. `--cleanup-on-success true` closes and removes only
that generated directory on successful completion; external logs remain. Failure
never automatically erases diagnostics. Never remove or alter original evidence,
and never use a large temporary write or index inside its directory.

## Changed files and validation

Active implementation additions:

- `scripts/index_v3_migration/index_v3_bounded_immutable_verify.mjs`
- `scripts/index_v3_migration/bounded_verify_store.mjs`
- `scripts/index_v3_migration/bounded_verify_journal.mjs`
- `scripts/index_v3_migration/bounded_verify_baseline.mjs`
- `scripts/index_v3_migration/bounded_verify_r2.mjs`

Narrow modifications:

- `scripts/index_v3_migration/index_v3_live_immutable_verify.mjs`: export the two
  existing admission guards; its full-memory execution path remains unchanged.
- `scripts/index_v3_migration/index_v3_cutover_generation_evidence.mjs`: add
  current trust roots and authenticate their actual relative-import closure.
- `scripts/index_v3_migration/recovery_journal_authority.mjs`: export the existing
  manifest validator; old exact/mutating journal paths remain unchanged.
- `scripts/index_v3_migration/exceptional_recovery_authority.mjs`: accept only
  branded completely authenticated disk journals for bounded anchor lookups and
  counts, retaining the original epoch/approval/Git validator and old path.
- `scripts/backup_r2/lib/observation_history_migration_v3.mjs`: export existing
  prepared/canonical-parent helpers and allow ordered disk replay iterators in
  the shared unchanged digest algorithm. Mutation call sites use original inputs.
- `workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs`: export the
  existing compact-root descriptor/latest-from-roots helpers, without changing
  deterministic builders or their output.

Other additions: this README and
`scripts/index_v3_migration/check_bounded_verify_boundaries.mjs`. The latter is a
small local authentication/encoding check, not a migration simulation. It proves
disk plan canonical hashes (including recursive array spans and split surrogate
pairs), shared replay digest equality, exact chain/tail refusal, original versus
disk publication DAG/schedule equality and rejection of contradictory evidence.

Pre-change code used the existing `archive/2026-10-16/` convention. Existing
same-day snapshots were reused for the four in-scope index-v3 files; newly added
snapshots preserve `scripts/backup_r2/lib/observation_history_migration_v3.mjs`
and `workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs` at the same
relative paths. Archives are not executed.

Focused checks: Node syntax of every changed/new active module, relevant imports
and `--help`, the narrow boundary check, review of bounded loops/limits and
GET/HEAD-only capability, unchanged historical pin list and mutation call sites,
current import-closure inventory, and `git diff --check`. No broad suite,
full-evidence run, LIVE R2/Supabase access, migration, rollback or cutover was run.

## System-doc handover and remaining acceptance blockers

No authoritative `system_docs` was modified. Chat-mode handover:

- Route the bounded verifier as an alternative immutable-generation verifier;
  document the supported original sharded-journal format, Pro runtime/resource
  controls, unique scratch state and deliberately non-resumable acceptance.
- In `observation_history_index_v3_operator_contract.md` and
  `observation_history_index_v3_recovery_determinism_amendment.md`, document
  current dependency roots plus their actual authenticated import closure as the
  maintained successor to the static current list. Historical classification,
  all ten pins, replay encoding, journal schema, exception approvals, full R2
  closure and rollback/freeze/cutover semantics remain unchanged.
- Explain that final verifier output requires a successful same-session lock
  coordinator exit, and is never sufficient alone for deployed acceptance or
  writer release. Existing current-v2 runtime rollback and other cutover gates
  remain mandatory; intact v2 is not promised current after v3-only writes.
- No schema, deployment, external configuration, environment catalogue or secret
  change is required. Reverting the PR removes the new path; discard its scratch
  only. The original migration evidence and R2 generation need no rollback.

Real TEST must establish end-to-end equivalence against authenticated real
evidence, descendant drift/missing-evidence refusal, supervised interruption,
single-session acceptance, macOS/Node 25.8.1 compatibility, peak RSS/disk use and
time while the Pro's normal services run. The real archive was not supplied to
Cloud; its maximum record/scope/decode bounds and SQLite expansion remain
unmeasured. Cloud also lacks the original LIVE writer Git object, so no claim of
actual historical LIVE trust acceptance is made. Keep those objects on the Pro;
missing historical objects or semantic drift remain hard failures. Review/promotion
and separately authorised real TEST acceptance are blockers before any LIVE use.
