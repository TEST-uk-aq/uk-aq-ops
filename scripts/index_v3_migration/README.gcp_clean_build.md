# TEST GCP complete observation-history build

This is an unaccepted implementation for the later clean TEST rehearsal. Do not
transfer it into the checkout running the existing migration or its independent
verification. No cloud action is part of development validation.

The normal runner remains
`scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs`. Its partition
concurrency defaults to 1, maximum 4; publication defaults to 1, maximum 16.
It never raises those limits based on detected hardware.

The GCP entrypoint is
`scripts/backup_r2/uk_aq_observation_history_migration_v3_gcp.mjs`. It uses the same
planner, CPU transformation, physical writer, publication schedulers, journal,
lock coordinator and complete independent verifier. It adds admission and audit
configuration, not another migration implementation. It addresses the slow serial
partition transformation and large exact-leaf publication of the TEST rehearsal.

The sole initial profile is `gcp-c4a-32`: GCE `c4a-standard-32`, Node `arm64`, at
least 32 available CPUs and 120 GiB visible memory. Defaults are 16 persistent
partition workers and 64 independent publications/reads; overrides are bounded
to 1..24 and 1..96 respectively. Workers are retained across their phase. The
remaining CPU capacity serves supervision, networking, journal persistence and
the OS. Both complete logical verification and transformation use real Worker
Threads. There is no process or thread per partition.

Admission queries the fixed link-local GCE metadata service with
`Metadata-Flavor: Google` on requests and requires the Google response header,
HTTP 200, bounded responses and a three-second deadline per request. Instance
ID/name, project ID/number, zone and machine type must be valid and consistent.
The lock-holding child performs admission again. There is no hostname, proxy,
environment, force or skip override. `--help` performs no metadata or R2 access.
The mechanism follows [Google's metadata documentation](https://docs.cloud.google.com/compute/docs/metadata/querying-metadata)
and [predefined key formats](https://docs.cloud.google.com/compute/docs/metadata/predefined-metadata-keys).

## Clean target and authority

This builds the complete locked v2 archive into v3. It never performs a delta,
changes serving authority, deletes R2 objects or contacts LIVE. Mandatory empty
admission covers:

- `history/v3/observations/`
- `history/_index_v3/observations_timeseries/`
- `history/_index_v3/timeseries_binding/`
- `history/_index_v3/observations_timeseries_latest.json` (including any keys beginning with this name)
- `history/v3/_ops/observations/` (including the generation resolver's `runs/`)

These are object prefixes, not directories. Each check makes one strict LIST per
namespace, with at most five returned keys. This uses R2-supported S3
[ListObjectsV2 prefix/max-keys parameters](https://developers.cloudflare.com/r2/api/s3/api/)
and validates the response bucket/prefix/count/truncation fields. Any object, truncated listing, read
failure or malformed response stops admission. Diagnostics identify the namespace,
observed count (a lower bound for a truncated page), example keys, and the need for
manual cleanup. Cleanup must be separately authorized and performed externally.

Planning checks under the global observations lock before inventory. Fresh
migration reacquires the lock, reconstructs and verifies the plan, confirms writer
freeze, revalidates pinned source prerequisites, then checks every namespace again
immediately before the first target write. It journals the successful check before
publication. Final verification authenticates the recorded clean start and planning
evidence; it does not require the completed target to be empty.

A clean-build checkpoint pins the profile's admission policy in its plan identity.
The immutable base also records the initial runner/resources/concurrency and
planning check. The journal clean-start event binds the run, plan, source root,
namespaces and check time. Reports contain the initial runner and current executor.
Runtime timestamps/resources/concurrency do not enter canonical output bytes or
change deterministic scheduling authority. High limits require a non-serializable
admission permit created by this process's successful GCE check.

Execution requires a clean reviewed checkout at the exact supplied writer commit.
This development tree is deliberately uncommitted; it is not yet an executable
operational authority. Existing TEST environment/bucket checks, explicit freeze,
accepted writer limits, lock-session supervision and v3-only mutation guards remain
mandatory. No new environment variable, secret, schema change or Supabase apply is
needed. The existing session-capable database connection is used only for the lock.

## Scheduling and recovery

Fresh runs now persist `checkpoint.json` once with
`progress_format: authenticated-journal-v1`, then use the existing authenticated
`.recovery/manifest.json`, `head.json` and chained `entries/` format from the start.
Progress updates identify only changed records. No growing checkpoint or
`.publication.json` is rewritten per object. Files and parent directories are
fsynced before durability is returned. Journal writes remain serial; failed
persistence poisons further appends. Publication batches are journaled in chunks
of at most 16, even when 64 or 96 objects are in flight.

Binding ranges are read concurrently, then leaves are read concurrently within
immutable range order. Publication has barriers: all leaves durable, then
independent range manifests durable, then root. Successful siblings are persisted
in input order after each bounded batch settles; failure prevents another batch.

Partition batches select immutable plan positions. The supervisor rechecks source
authority and acquires exact pinned bytes; workers decode, hash, sort, build Arrow,
write ZSTD Parquet and derive validated footer/exact-range metadata. The supervisor
checks the returned unit/scope, source identities, logical metadata, exact output
bytes/keys, writer SHA and shared prepared-record validity before staging. Worker
environments contain no credentials, lock context or checkpoint paths.

Preparation evidence commits in plan order. After CPU failure only the safe
contiguous preparation prefix is retained; later successful CPU-only results are
discarded, with no R2 side effects. Prepared partitions publish in plan order;
independent Parquet files within each partition publish up to the publication
limit. Successful file siblings become durable even if a sibling fails. A unit is
marked published only when all files are durable. Staging is released thereafter.
Only one partition batch's source/decoded/Parquet bodies can be live at a time.

Canonical JSON and exact-leaf publication take only eligible prefixes of immutable
schedules. Parent dependencies must already be durable, never merely in flight.
At publication concurrency 1 the original shared v3 serial finalizer remains in
use. At higher values the existing dependency-aware finalizer uses larger bounded
batches. `schedule_sha256` and object positions are unchanged.

Checksum PUT results explicitly prove stored SHA and byte size, removing the
outer duplicate HEAD. Successful JSON put-if-changed returns exact post-PUT GET
identity, removing the duplicate outer GET in serial and concurrent finalizers.
ETag-only unchanged/reused objects retain strong identity reads. Complete final
verification still performs independent network checks.

Independent binding, Parquet HEAD, canonical GET, exact-leaf GET and rerun
dependency-closure checks use the publication bound. Complete independent source-versus-target decoding/hashing uses
the partition worker bound, re-reading every source/target file and checking stable
bindings for every timeseries. Failure settles the current batch and stops further
work. No sampling or checkpoint substitution is used. A second copy of all fetched
index bodies is avoided by retaining verified keys and validating their identical
pinned bytes.

Progress retains the 15-second worker heartbeat without per-object logging. ETA
uses throughput across at most ten prior emitted samples and requires at least
five prior samples, positive progress/time, and a finite result. Object work uses
object counts; partition transformation and complete logical verification use
planned source rows while also displaying partition counts. Missing estimates are
omitted. ETA never affects authority, scheduling or timeout decisions.

Keep the immutable base, complete `.recovery` directory and remaining `.staging`
together at their original paths. Do not edit or repair them. New readers reject
unknown progress formats and a missing journal manifest for a journal-marked
checkpoint; old formats are not silently relabelled. A crash between base creation
and journal initialization occurs before any staging or R2 mutation and fails
closed on resume; preserve those incomplete artifacts for review. Existing
historical journals retain their original implementation pin and may reject the
changed implementation; this is not a conversion tool for the active rehearsal.

Authenticated clean-build resume reuses the original v2 root, plan and clean-start
evidence; it does not require an already-started target to be empty. If interruption
preceded the durable clean-start event, resume must check emptiness before writing.
A local/historical checkpoint cannot be admitted as a GCP clean-build checkpoint.

## Later TEST command shape — do not run during development

On the already provisioned, separately authorized c4a-standard-32 VM, use the
reviewed clean checkout and established TEST environment described in
[the side-by-side operator guide](README.side_by_side_operator.md). Keep
`UK_AQ_R2_HISTORY_VERSION=v2` and `UK_AQ_R2_HISTORY_INTEGRITY_VERSION=v2`.
Do not synthesize lock-context variables.

```bash
set -euo pipefail
migration_cli='scripts/backup_r2/uk_aq_observation_history_migration_v3_gcp.mjs'
migration_run_id='REPLACE_WITH_UNIQUE_TEST_RUN_ID'
migration_expected_bucket='REPLACE_WITH_EXACT_TEST_BUCKET'
migration_writer_sha='REPLACE_WITH_REVIEWED_40_HEX_WRITER_SHA'
migration_work_dir="$HOME/uk-aq-work/gcp-clean/$migration_run_id"
mkdir -p "$migration_work_dir"
node --input-type=module - "$migration_work_dir/writer_limits.json" <<'NODE'
import fs from 'node:fs';
import { ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3 as limits }
  from './workers/shared/uk_aq_observation_history_writer_limits_v3.mjs';
fs.writeFileSync(process.argv[2], JSON.stringify(limits, null, 2), { mode: 0o600, flag: 'wx' });
NODE
migration_common=(
  --runner-profile gcp-c4a-32 --environment TEST --transition v2-to-v3
  --expected-bucket "$migration_expected_bucket" --migration-run-id "$migration_run_id"
  --target-writer-git-sha "$migration_writer_sha"
  --writer-limits-json "$migration_work_dir/writer_limits.json"
  --partition-concurrency 16 --publication-concurrency 64
)
node "$migration_cli" "${migration_common[@]}" --mode plan \
  --report-out "$migration_work_dir/plan.json"
migration_plan_sha=$(jq -er '.result | select(.ok == true and .status == "planned") | .plan_sha256' \
  "$migration_work_dir/plan.json")
```

Review the plan, GCE identity, empty admission and writer inventory. Complete the
separately authorized writer-freeze procedure before the next command. The explicit
`--writers-frozen` flag confirms that procedure; it does not pause anything.

```bash
node "$migration_cli" "${migration_common[@]}" --mode migrate --apply --writers-frozen \
  --expected-plan-sha256 "$migration_plan_sha" \
  --checkpoint-out "$migration_work_dir/checkpoint.json" \
  --report-out "$migration_work_dir/migrate.json"
node "$migration_cli" "${migration_common[@]}" --mode verify \
  --expected-plan-sha256 "$migration_plan_sha" \
  --checkpoint-in "$migration_work_dir/checkpoint.json" \
  --report-out "$migration_work_dir/verify.json"
```

For an interrupted run only, repeat migrate with both
`--checkpoint-in "$migration_work_dir/checkpoint.json"` and
`--checkpoint-out "$migration_work_dir/checkpoint.json"`, retaining all other
identities and the complete evidence directory.

Expected acceptance includes complete `side_by_side_build_verified` results,
unchanged v2 root, preserved clean-start evidence, no runtime switch, deterministic
interruption/resume, resource/memory measurements and improved throughput. An
uninterrupted run alone does not establish recovery acceptance.

## Review and system-documentation handover

Structural checks cannot establish real GCE/R2/lock behavior, VM power-loss durability,
worker memory high-water marks, throughput or complete migration correctness.
Remaining serial costs include source hierarchy/inventory construction, source-file
pinning, per-partition staging/durability commits, partition publication order,
whole-plan canonical/exact-leaf schedule reconstruction, hierarchy validation and
journal fsync. Slowest-sibling barriers intentionally limit scheduling overlap.
The immutable JSON schedule and checkpoint metadata remain resident; all migration
Parquet output is not retained in RAM. Worker WASM instances can retain their
allocation high-water marks until the phase pool is closed.

Before operational transfer, review these boundaries and the additive shared R2
helper changes. Preserve the exact active operational code/evidence until its
current migration and independent verification are finished. The archived
pre-change code under `archive/2026-09-07/` is reference only; no active entrypoint
executes it. Before any new migration starts, reverting the reviewed code is a
code-only rollback. After a run starts, preserve its pinned implementation and
journal; reverting code is not an operational recovery procedure.

The future GCP clean-build authority is now documented in
`system_docs/r2_history/observation_history_v3_gcp_clean_migration_contract.md`.
It authorizes the separate GCE-only concurrency profile and clean-build behavior.
The older recovery-determinism amendment still requires exact entry/head counts.
Chat mode must document the narrowly authorized single-append reconciliation
below, the optional implementation runner identity, and recovered publication
reuse. No `system_docs/` files were edited. Older in-place/Dropbox wording must
not be used to change the side-by-side runtime authority.

## Recovery correction: committed head and interrupted append

The committed frontier remains `head.json`. Normal append is:

1. Mark the live context poisoned before attempting persistence.
2. Create a unique temporary entry in `.recovery/pending/`, write and fsync it.
3. Rename it to the exact next `entries/000000000N.json`; fsync the entries
   directory and scratch directory.
4. Create/write/fsync a temporary head in `pending/`; rename it to `head.json`;
   fsync the recovery and scratch directories.
5. Update the live sequence, clear poison, then return durable success.

Any persistence error leaves the process poisoned. Publication adapters reject
subsequent mutations from that context. Parents cannot use a child before the
head commit returns durable success. `pending/` contains only uncommitted scratch
bytes: it is never read as journal authority, and leftovers from abrupt process
termination remain available for inspection. No numbered entry is removed,
truncated, inferred or invented. A temporary file in `entries/` is still an
unexpected filename and fails closed; new appends never create one there.

The exact reader remains exact. Locked mutating resume uses a separate inspection
path, permitting **only one** physical entry beyond the authenticated head. It
validates the complete committed prefix and the next entry's exact filename,
sequence, checkpoint/authority identities, envelope SHA and ancestry. Before
head repair, a private candidate replay validates the update fields, exact
prepared target identities, preparation prefix, immutable completion evidence,
publication schedule/DAG, staging transitions and final-state prerequisites.
Contradictions abort without modifying the head. The candidate entry and entries
directory are flushed again, then the repaired head is atomically written and
fsynced using the same discipline as normal append. The exact reader is run again
before the recovered checkpoint is exposed to execution.

Normal journals replay as before. More than one trailing entry, any gap, an
unexpected filename, head ahead of entries, bad SHA/ancestry/authority, or an
invalid state transition fails closed. Read-only verification never repairs a
head; a one-entry interruption must first pass the locked resume path. An
interruption during the head repair leaves the same one-entry candidate or the
fully committed new head, so repeating recovery is safe.

Existing valid schema-1 manifest/entry/head formats remain readable, including
manifests without a runner field. Historical implementation hashes are not
relaxed or repinned. New fresh journals add `recovery_implementation.runner`
(`runner_kind`, `runner_profile`), derived from immutable checkpoint authority.
Local manifests pin the shared core, workers, concurrency, binding, admission
module and existing recovery files but omit the unexecuted GCP CLI wrapper.
GCP manifests additionally pin that wrapper. The admission module is shared by
both profiles because it determines bounds. Existing deterministic writer Git
SHA and clean implementation gates remain mandatory.

## Recovered exact-leaf publication

Every recovered publication record must match the immutable schedule's key,
byte size, SHA-256, position, schedule SHA and stage (when recorded), with positive
post-PUT GET evidence. Contradictory duplicates fail; equivalent historical
duplicates collapse to one completion. A recovered changed parent requires all
its changed dependencies/prerequisites in the recovered set.

Bounded read-only GETs then prove current size, SHA-256 and body equality against
the exact planned JSON. Missing or changed objects stop recovery without a PUT.
Only after this gate are recovered keys seeded into the completed set and
publication progress. New scheduling skips those keys, accepts sparse durable
sibling successes, and retains immutable-order dependency barriers. Recovered
entries incur no PUT or duplicate publication-journal append. Concurrency 1
still uses the original serial finalizer with exact reuse adapters. Final
complete independent verification still re-reads every required object and every
source/target logical partition; journal reuse does not replace that proof.

## Settled sibling failures and validation

All new batch callers retain started failures in immutable input order. Multiple
failures produce `AggregateError.errors`; the main message identifies the first.
Structured migration reports retain recursive `failure_evidence`, including all
sibling causes, even when compact blocker lists are bounded. Read-only paths
that return blocker reports preserve each failed sibling. Safe independent
successes may be persisted before throwing; CPU preparation persists only the
contiguous prefix before the first failed position. Persistence failures also
retain the already-started sibling failures. No failed batch starts a successor.

Local structural validation includes syntax/import checks, both CLI help paths,
and `git diff --check`. The narrowly scoped disk check is:

```bash
node tests/observation_history_journal_crash_check.mjs
```

It invokes only local checkpoint/journal primitives in a temporary directory,
including an fsynced trailing entry with an old head. On 2026-09-07 this check
passed, as did syntax checks for all 15 active changed/new JS/MJS files, import
checks for 13 modules, both CLI help paths and `git diff --check`. It proves deterministic
repair/exact replay and rejection of multiple tails, bad ancestry, corrupt
payload, duplicate completion and unexpected filenames. Unrenamed scratch data
preserves the previous state. It does not simulate a migration or contact
R2/GCE. Real VM power-loss behavior, R2 reuse and performance still require the
separately authorized interrupted clean TEST rehearsal before operational
acceptance. No runtime configuration, deployment or database schema changes are
introduced by this correction.

LIVE is deliberately rejected by this entrypoint. Any later LIVE use requires
separate authorization, accepted TEST results and a reviewed environment/contract
extension; it is not enabled merely by changing a command-line environment label.
