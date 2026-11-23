# One-off stranded Prune source reconciliation

Use this standalone procedure for one reviewed connector and UTC day with a failed, blocked candidate and an incomplete original gate. See the [authoritative reconciliation contract](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/185702f68bb0ae7a494f6c94fd4ef37d0ca18068/system_docs/r2_history/prune_one_off_stranded_source_reconciliation_contract.md).

## Select a real TEST scope

1. Start with the existing TEST IngestDB and its selected-v3 R2 bucket. Confirm the connection and bucket assignments independently. In a read-only transaction, look for candidates with the authority-blocked marker, a positive expected count, incomplete gates and no exceptional receipt. Review the marker's previous manifest key and SHA-256, candidate metadata and gate fields for each shortlisted scope. Confirm that the target has raw rows, a complete canonical projection and no subsequent arrivals or unrelated rows in the scope.
2. Use the original TEST Prune workflow to identify the connector/day publication and the interruption that prevented its gate from completing. Check the original log against the candidate marker and the currently selected manifest. Review the canonical hierarchy, latest/scoped index references, actual Parquet, original cutoff, row count, hour coverage and pollutant set. The plan repeats the physical history checks independently. Pick a substantive whole connector-day that exercises the actual indexes and database write path. Use the scope's observed count, hash and pollutants.
3. Check concurrent ingestion and history writers, and identify downstream consumers that still depend on this IngestDB scope. Confirm that the existing selected history is readable and that draining this particular hot-source scope is acceptable. Choose a quiet window and monitor writers. Check the approved backup location and recovery access before proceeding.
4. If no genuine scope qualifies, separately review a contained TEST-only setup using existing TEST mechanisms. It must produce a real interrupted publication with attributable evidence, protect other valid history and candidate/gate state, and be reversible or contained. Leave healthy completed gates alone. Consider a dedicated resource only if read-only inspection shows that shared resources cannot safely support a representative rehearsal.

Example shortlist after the receipt table exists. Inspect the full candidate and gate for the selected key and check writer activity separately with `pg_stat_activity`. Keep evidence private.

```sh
psql "$test_pg_url" -X -v ON_ERROR_STOP=1 <<'SQL'
begin read only;
select c.day_utc, c.connector_id, c.expected_row_count, c.last_error
from uk_aq_ops.history_candidates c
join uk_aq_ops.prune_connector_day_gates g using (day_utc, connector_id)
where c.status = 'failed'
  and starts_with(c.last_error, 'PRUNE_HISTORY_AUTHORITY_BLOCKED:')
  and c.expected_row_count > 0 and g.history_done = false
  and not exists (
    select from uk_aq_ops.prune_stranded_source_reconciliations r
    where r.day_utc = c.day_utc and r.connector_id = c.connector_id
  )
order by c.day_utc desc limit 20;
rollback;
SQL
```

## Prerequisites and TEST schema

- Use Node 22+ with the repository's locked dependencies, `gh`, `jq`, `psql` and `rclone`. Use the existing `SUPABASE_DB_URL` or `DATABASE_URL` for a direct or session-preserving IngestDB connection with `sslmode=verify-full`. Confirm PostgreSQL 17+ for server-side `transaction_timeout`. The role needs unfiltered reads with `row_security=off`, access for the recursive lock and candidate/gate row locks, DELETE on observations and INSERT on the private receipt.
- Use read credentials for the selected canonical R2 bucket with the existing `R2_BUCKET`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and optional `R2_REGION`. Existing `CFLARE_R2_*` aliases are accepted.
- Use an operator-owned evidence directory outside repositories, mode `0700`, on encrypted private storage. Use a fresh directory per plan. Select an existing configured private rclone remote and restricted TEST folder for the second copy, for example a private operations folder on the existing Dropbox remote. Verify the account, folder access, absence of public/shared links, retention, and authorised retrieval independently. Choose storage that remains accessible if the working machine is lost. Use a destination separate from canonical history and keep bundle, approval and reports out of Git.
- After separate approval, run the follow-up migration from the schema checkout against TEST. Check the TEST migration ledger first. If the receipt table is absent on an existing database, apply the original migration first. A clean database built from the updated canonical schema already has the revised table.

```sh
# Existing TEST database only, subject to the ledger checks above
psql "$test_pg_url" -X -v ON_ERROR_STOP=1 -f schemas/migrations/20261122_001_ingest_prune_stranded_source_reconciliation.sql
psql "$test_pg_url" -X -v ON_ERROR_STOP=1 -f schemas/migrations/20261123_001_ingest_prune_stranded_receipt_positive_count.sql
```

The follow-up expects the original count constraint, retains existing receipts, and leaves uniqueness on connector/day, operation ID and plan digest in force. Verify the positive count constraint and the new approval column before proceeding.

## Prepare original evidence and plan

Set `day`, `connector`, `invocation`, `cutoff`, `manifest_sha`, `repo`, `run_number`, `evidence`, `backup_prefix` and `plan_expiry_utc` from the reviewed case and approved local configuration. Confirm the raw count and check for rows with missing or post-publication `created_at` using the same UTC half-open bounds. Derive the canonical hash and coverage from a separate read-only export using the established Prune v1 encoder. The command prints identity and coverage only.

```sh
set -o pipefail
umask 077
mkdir -m 700 "$evidence"
psql "$test_pg_url" -X -qAt -v ON_ERROR_STOP=1 -v day="$day" -v connector="$connector" <<'SQL' |
begin read only;
set local time zone 'UTC';
select jsonb_agg(to_jsonb(h)) from uk_aq_ops.uk_aq_phase_b_history_rows_v2(
  :'connector'::integer, (:'day' || 'T00:00:00Z')::timestamptz,
  (:'day' || 'T00:00:00Z')::timestamptz + interval '24 hours', null, null) h;
rollback;
SQL
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { computePruneConnectorSourceIdentity } from "./workers/shared/uk_aq_prune_connector_source_identity.mjs";
  const rows = JSON.parse(readFileSync(0, "utf8"));
  const hourly_counts = Array(24).fill(0);
  for (const row of rows) hourly_counts[new Date(row.observed_at_utc).getUTCHours()]++;
  console.log(JSON.stringify({
    row_count: rows.length, hourly_counts, pollutants: [...new Set(rows.map((row) => row.pollutant_code))].sort(),
    source_content_hash: computePruneConnectorSourceIdentity(rows).source_content_hash
  }));
' > "$evidence/source-identity.json"
```

Review the identity file against the original publication and pinned connector manifest. The original connector event must report the same expected, written and source identity row counts, the same v1 content SHA-256, and connector publication awaiting batch finalisation. The v1 hash covers actual observations and binds the independently derived hours and pollutants to the original content. Also compare the pollutant codes to the pinned connector manifest. Use equivalent separately reviewed source evidence when preparing the future LIVE baseline below.

Download the original record and complete original attempt log directly from GitHub. For a rerun, use `gh run view --attempt N --log` for the original attempt and confirm the recorded workflow metadata and writer commit. Review the sequence following publication. This utility accepts the v3 budget-stop pattern where the affected-day batch starts, the writer reports `failure_outcome=budget_stop`, the Prune batch reports the matching trigger and zero completed gates, and the stopped Phase B summary lists the day as blocked. A GitHub `success` conclusion can accompany this internal stop. Any contradictory completion evidence blocks the operation.

```sh
gh run view "$run_number" --repo "$repo" \
  --json databaseId,url,headSha,workflowName,startedAt,updatedAt,status,conclusion,jobs \
  > "$evidence/workflow.json"
gh run view "$run_number" --repo "$repo" --log > "$evidence/workflow.log"
workflow_url=$(jq -er '.url' "$evidence/workflow.json")
writer_sha=$(jq -er '.headSha' "$evidence/workflow.json")
record_sha=$(sha256sum "$evidence/workflow.json" | cut -d ' ' -f1)
log_sha=$(sha256sum "$evidence/workflow.log" | cut -d ' ' -f1)
jq --arg day "$day" --argjson connector "$connector" --arg run "$invocation" \
  --arg cutoff "$cutoff" --arg manifest "$manifest_sha" \
  --arg url "$workflow_url" --arg writer "$writer_sha" --arg record "$record_sha" --arg log "$log_sha" \
  '. + {version:2, day_utc:$day, connector_id:$connector,
    original_run_id:$run, publication_cutoff:$cutoff,
    manifest_key:("history/v3/observations/day_utc="+$day+"/connector_id="+($connector|tostring)+"/manifest.json"),
    manifest_hash:$manifest, workflow_url:$url, writer_git_sha:$writer,
    workflow_record_sha256:$record, workflow_log_sha256:$log}' \
  "$evidence/source-identity.json" > "$evidence/baseline.json"

tool=scripts/operations/uk_aq_reconcile_stranded_prune.mjs
node "$tool" plan --directory "$evidence" --backup-prefix "$backup_prefix" \
  --expires-at "$plan_expiry_utc"
```

Use canonical UTC instants with milliseconds and set expiry within 24 hours. Review `plan.json` for the exact scope and count, UTC-hour counts, pollutant codes, partition layout, candidate/gate and physical history proof. The command takes the existing global operations lock for verification and writes local evidence only. The plan embeds an operation-specific remote path, while `backup-bundle.json` holds the exact raw rows and complete evidence. The tuple witness detects changes between planning and execution. An identical reinsert or backdated timestamp before planning remains possible.

## Retain and independently read back the backup

Use the operation-specific locator from the plan. Keep the local bundle and independently durable remote copy under the agreed private retention policy. The upload uses rclone's immutable option for this copy, so it refuses to replace a different existing object. Check private access and retention at the provider as part of the operator review. Before approval, retrieve the exact remote object in a fresh read, compare bytes and compute the SHA-256. The executor independently reads the same remote object again and verifies its exact bytes, plan, rows and evidence before the SQL fence.

```sh
backup_locator=$(jq -er '.plan.backup.locator' "$evidence/plan.json")
rclone copyto --immutable "$evidence/backup-bundle.json" "$backup_locator"
rclone cat "$backup_locator" > "$evidence/backup-readback.json"
cmp "$evidence/backup-bundle.json" "$evidence/backup-readback.json" &&
  sha256sum "$evidence/backup-readback.json"
```

Use the SHA-256 from the confirmed readback. If upload, privacy, durable retention, readback or checksum fails, retain the source.

## Approve once, execute and verify

Run in a terminal within the reviewed UTC maintenance window, allowing time for approval, remote and R2 checks, and the full SQL allowance.

```sh
node "$tool" execute --directory "$evidence"
```

Provide your name and approval reference, UTC window, maximum SQL transaction duration, recursive lock wait and independently reviewed backup SHA-256. Review the displayed plan digest, operation ID, connector/day, count, backup locator, hash and size. Check the residual row-incarnation uncertainty and backup privacy/durability attestation. Confirm the exact displayed approval phrase only if all details and risks are accepted.

The recursive `SHARE ROW EXCLUSIVE` lock applies to the parent and all descendants. **Writes for every connector using these tables may wait, time out or fail during the lock.** Ordinary reads can continue. The maximum SQL allowance is 120 seconds and the recursive lock statement is limited to 5 seconds, with shorter bounds available. The global operations lock continues through COMMIT. The tool revalidates source and layout on the first snapshot after the fence, then commits the exact DELETE and private receipt together. All external readback is outside the table lock.

Success requires an acknowledged COMMIT and a matching digested `post-commit.json` from independent read-only checks. Confirm zero raw/canonical source, one matching receipt and unchanged failed candidate, gate and selected R2/index evidence. Retain the attempt record and reports privately alongside the independently durable bundle, using separate non-overwriting names.

```sh
node "$tool" inspect --directory "$evidence"
```

Use read-only inspection after contention, a stale plan, a connection loss, an ambiguous COMMIT or a post-check failure. A matching receipt establishes the committed deletion even if subsequent arrivals or history changes require separate review. Investigate missing or conflicting receipts and nonzero counts. Keep the attempt file and treat the approval as spent once an attempt is recorded. A separately authorised new attempt requires fresh evidence, backup and approval.

Failures before COMMIT roll back the deletion and receipt together. After COMMIT, keep the receipt even if the utility is withdrawn. For a separately approved restore, independently retrieve the private bundle and verify its exact SHA-256, plan and raw-row digest. Stage `source_rows` with the observation table's original column types, including the recorded timestamps, status and acquisition method. The stored `value` is PostgreSQL's float8 text representation. Check round-trip float bits against `value_binary` before any insert. Reconcile conflicts with later arrivals and verify the complete raw rows and Prune v1 identity after restoration. A code or schema revert cannot restore source rows.

## Real TEST acceptance

1. After read-only selection and schema review, test the recursive fence with two real TEST database sessions before the destructive run. In session A, set session `transaction_timeout = '120s'`, begin in `REPEATABLE READ`, set local lock and statement timeouts to 5 seconds, then issue the plan's exact recursive lock before any SELECT or DML. Check the parent and leaf locks in `pg_locks`. In session B, use separate rolled-back transactions and a short lock timeout to attempt a no-change observation upsert for the target and a no-change write for an unrelated connector. Expect SQLSTATE `55P03` for both while an ordinary SELECT succeeds. Release session A promptly and confirm both writes succeed after release, then roll them back. Record elapsed time, affected partitions and outcomes.
2. Demonstrate rejection of an invalid or stale plan, for example by altering a copy's planned count while keeping its digest. Demonstrate a failed transaction by coordinating a short lock holder on a leaf when an approved attempt reaches its fence. Verify independently that each case leaves all rows and the candidate/gate intact with no receipt. Release the holder promptly and prepare a fresh plan for the successful attempt.
3. With the fresh plan and verified backup, execute once against the full reviewed scope. Check the receipt against the exact count and approval, zero raw and canonical scope, unchanged selected R2/index and candidate/gate, and replay rejection. Confirm observation writes resume and review the backup's recoverability. Retain a concise private report with the scope, timings, backup readback and evidence digests for the operator's review.

## Future LIVE operator baseline

After successful TEST acceptance, separate operator approval is required for LIVE promotion, migration and execution. The LIVE baseline is fixed.

- Repository `UK-AQ/uk-aq-ops`, workflow run `44444834653`, invocation `452723ab-4504-40a0-bd0d-239107d7285f`.
- AURN connector `1`, UTC observation day `2026-11-14`, from `2026-11-14T00:00:00Z` inclusive to `2026-11-15T00:00:00Z` exclusive. Publication cutoff `2026-11-19T03:24:31.000Z`.
- Exactly **22,543 raw and 22,543 canonical observations**, all 24 UTC hours and 37 pollutant codes, with zero raw rows recorded after the cutoff. Record the actual hourly counts and sorted pollutant codes after independently verifying them against the pinned original content.
- Original Prune v1 source SHA-256 `02193a5f12e8d3b3832401d3acc08b3814ecf0b1046438e5cbc33d168b1fbd78`.
- Committed manifest `history/v3/observations/day_utc=2026-11-14/connector_id=1/manifest.json`, SHA-256 `1ca74766cb6b48f369386af2aa09f93c220bd56b2fc45e72ebeded1fcf927848`.
- The GitHub conclusion is `success`. The internal Phase B result was `stopped_budget` after the required v3 finalisation failed under `candidate_loop_budget_stop`. Keep the complete original log with both failure records.

Promote the complete approved Ops module and runbook versions and the reviewed canonical schema and migrations. Keep TEST archives out of LIVE. The independent backup copy must survive loss of the working machine. Obtain separate affirmative approval of the exact LIVE execution plan and retain source if any baseline, provenance, backup, timing, source-scope or R2 check fails.
