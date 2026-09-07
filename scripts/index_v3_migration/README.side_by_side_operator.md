# First TEST side-by-side observation migration

This is the proposed manual sequence, not evidence of a real TEST run. Use the
active Node CLI directly. `index_v3_migration.sh` is a historical in-place/Dropbox
recovery wrapper and is not the side-by-side entry point. Its historical authority
arguments are rejected by active `--transition v2-to-v3` plan/migrate/verify modes.

The local runner uses partition concurrency 1 (maximum 4) and publication
concurrency 1 (maximum 16). Both are explicit bounded CLI options. For the separately
GCE-attested complete clean TEST build, see [the GCP runner guide](README.gcp_clean_build.md).

The operator builds from `history/v2/observations` and its authoritative v2 binding
hierarchy. Writes are restricted to `history/v3/observations`,
`history/_index_v3/observations_timeseries`,
`history/_index_v3/timeseries_binding`, and the v3 observations-timeseries latest
pointer. No generation switching, schema application, scheduler changes, Dropbox
restore or persistent environment changes are performed.

Before the real run, use a reviewed executable checkout containing the operator
changes and record its writer Git SHA. Keep that implementation and the whole run
directory for resume. Supply existing TEST R2 credentials and the existing
session-capable PostgreSQL lock connection (`SUPABASE_DB_URL` or `DATABASE_URL`)
through the established operator environment. The configured environment and
bucket must match the explicit TEST arguments; `UK_AQ_R2_HISTORY_VERSION=v2`
and `UK_AQ_R2_HISTORY_INTEGRITY_VERSION=v2` are required. The retired independent
index selector does not choose the source. Never synthesize lock-context variables.

Run from the Ops repository, using Bash and a unique durable local run directory:

```bash
set -euo pipefail
migration_run_id='REPLACE_WITH_UNIQUE_TEST_RUN_ID'
migration_expected_bucket='REPLACE_WITH_EXACT_TEST_BUCKET'
migration_writer_sha='REPLACE_WITH_REVIEWED_40_HEX_WRITER_SHA'
migration_work_dir="$HOME/uk-aq-work/side-by-side/$migration_run_id"
mkdir -p "$migration_work_dir"
node --input-type=module - "$migration_work_dir/writer_limits.json" <<'NODE'
import fs from 'node:fs';
import { ACCEPTED_OBSERVATION_HISTORY_WRITER_LIMITS_V3 as limits }
  from './workers/shared/uk_aq_observation_history_writer_limits_v3.mjs';
fs.writeFileSync(process.argv[2], JSON.stringify(limits, null, 2), { mode: 0o600, flag: 'wx' });
NODE
migration_cli='scripts/backup_r2/uk_aq_observation_history_migration_v3.mjs'
migration_common=(
  --transition v2-to-v3 --environment TEST
  --expected-bucket "$migration_expected_bucket"
  --migration-run-id "$migration_run_id"
  --target-writer-git-sha "$migration_writer_sha"
  --writer-limits-json "$migration_work_dir/writer_limits.json"
)
node "$migration_cli" "${migration_common[@]}" --mode plan \
  --report-out "$migration_work_dir/plan.json"
jq '.result | {ok, plan_sha256, source_root, writer_freeze_plan, blockers}' \
  "$migration_work_dir/plan.json"
migration_plan_sha=$(jq -er '.result | select(.ok == true and .status == "planned") | .plan_sha256' \
  "$migration_work_dir/plan.json")
```

The preview acquires and releases the existing global observations-operation
lock. Review its source/bucket/run identity and writer-freeze list. Before the
following mutation command, complete the separately authorized writer-pause
procedure; `--writers-frozen` is the operator's explicit confirmation, not an
automatic pause. Keep source writers excluded across plan/build if the preview
hash is to remain valid. A source change between preview and build rejects the
build's exact plan hash before mutation.

```bash
node "$migration_cli" "${migration_common[@]}" --mode migrate --apply --writers-frozen \
  --expected-plan-sha256 "$migration_plan_sha" \
  --checkpoint-out "$migration_work_dir/checkpoint.json" \
  --report-out "$migration_work_dir/migrate.json"
node "$migration_cli" "${migration_common[@]}" --mode verify \
  --expected-plan-sha256 "$migration_plan_sha" \
  --checkpoint-in "$migration_work_dir/checkpoint.json" \
  --report-out "$migration_work_dir/verify.json"
jq '.result | {ok, status, generation_topology, source_root, runtime_switch_performed}' \
  "$migration_work_dir/migrate.json" "$migration_work_dir/verify.json"
```

Each invocation reacquires the same global observations-operation lock before
source selection. Migration retains it through plan reconstruction/validation,
v3 binding/canonical/index publication, independent logical and physical
verification, and the final exact unchanged-v2-root check. The existing retained
session coordinator supervises the child process group and terminates it on lock
loss or coordinator death. Its validated owner/run/session context supplies
`assertLockHeld` to the side-by-side adapters before and after I/O.

Expected success: `ok: true`, `status: "side_by_side_build_verified"`,
`source_root.unchanged: true`, and `runtime_switch_performed: false`. A completed
checkpoint or its historical `cutover_ready` field is not authorization to switch
readers or resume writers onto v3. Real TEST output is still required acceptance
evidence; local deterministic checks are structural proof only.

Fresh runs retain an immutable `checkpoint.json` plus an authenticated append-only
`.recovery` journal from the start; they no longer rewrite a growing checkpoint or
`.publication.json` per object. For interruption, retain the checkpoint and all its
`.staging`, `.publication.json` (older runs) and `.recovery` siblings that exist. Do not edit, relocate, delete or substitute
them. Use the same run, writer, limits, plan hash and checkpoint path:

```bash
node "$migration_cli" "${migration_common[@]}" --mode migrate --apply --writers-frozen \
  --expected-plan-sha256 "$migration_plan_sha" \
  --checkpoint-in "$migration_work_dir/checkpoint.json" \
  --checkpoint-out "$migration_work_dir/checkpoint.json" \
  --report-out "$migration_work_dir/resume.json"
```

Resume reacquires the lock and verifies the exact original v2 root byte size and
SHA-256 before recovery initialization and before further target mutation. If v2
changed while interrupted, stop: this run cannot catch up. A new build requires a
new reviewed plan/run. A fresh run also refuses existing checkpoint artifacts.

Failure leaves the v2 generation intact and selected. Do not invoke historical
Dropbox rollback for a side-by-side checkpoint. Any decision to resume v2 writers,
abandon a partial v3 build or switch generation is a separate controlled operation.
A current backup can remain disaster-recovery evidence, but is not a migration
source or an ordinary side-by-side rollback prerequisite.

System-doc handover: record this active Node entry point, its locked preview and
resume semantics, and the absence of the historical Dropbox/runtime-authority
arguments. No schema/configuration/deployment changes accompany this operator edit.
