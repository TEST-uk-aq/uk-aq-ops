# One-off stranded Prune source reconciliation

This manual command implements the [authoritative incident contract](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/c2269d17eb8bdf4093cc18b971c69e4d94f6793e/system_docs/r2_history/prune_one_off_stranded_source_reconciliation_contract.md). Deployment, a real isolated TEST rehearsal, LIVE promotion and any DELETE require separate authorization.

## Operator prerequisites

- Use Node 22+ with the repository's locked dependencies, OpenSSL with Ed25519 support, AWS CLI v2 and, for preparation, `gh`, `jq` and `psql`.
- Use the existing `SUPABASE_DB_URL` (or `DATABASE_URL`) for explicitly selected IngestDB on PostgreSQL 17+. Use a direct, TLS-verified connection with `sslmode=verify-full`. Transaction pooling is incompatible. The role must have exact source, metadata, candidate/gate and receipt read access. Execution additionally requires permission for the recursive table lock, row locks on the candidate and gate, DELETE on the observations parent and INSERT on the private receipt. PostgreSQL must allow unfiltered reads with `row_security=off`. Apply the separately reviewed IngestDB schema PR before rehearsal or planning.
- Select the intended canonical R2 bucket explicitly using existing `R2_BUCKET`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and optional `R2_REGION` (normally `auto`). Existing `CFLARE_R2_*` aliases are accepted. Use credentials restricted to canonical R2 reads and a complete selected-v3, schema-1 exact-index hierarchy.
- Supply a separately provisioned, trusted operator Ed25519 public PEM outside the evidence directory. The operator controls the corresponding private signing key. The CLI receives only the public key. Keep the evidence directory outside repositories, operator-owned with mode `0700`, on encrypted private storage. Use one new directory for each reviewed attempt.
- Use a private AWS S3 general-purpose backup bucket with versioning, Object Lock COMPLIANCE, all four public-access blocks, an explicit non-public bucket policy and bucket-owner-enforced object ownership. Use existing AWS CLI credential resolution, for example `AWS_PROFILE`. The account, bucket, region and exact object version are signed into approval. The execution identity needs only provider read access for backup verification. Keep the evidence bundle and reports under the agreed private retention policy.

The transaction write fence is a recursive `SHARE ROW EXCLUSIVE` lock on `uk_aq_core.observations`. **All connectors writing to the parent or any descendant may wait, time out or fail.** Ordinary readers can continue. The operator chooses a quiet maintenance window, approves the maximum blocking duration, and monitors ingestion. The SQL transaction budget is at most 120 seconds. The recursive lock statement, including waits across partitions, is limited to 5 seconds. Shorter bounds can be signed into approval. If impact is unacceptable, retain the data.

## Prepare original evidence and plan

Set and verify the intended IngestDB and R2 configuration, the incident variables and a fresh private directory. The rehearsal and LIVE values are described below.

```sh
umask 077
mkdir -m 700 "$evidence"
gh run view "$run_number" --repo "$repo" \
  --json databaseId,url,headSha,workflowName,startedAt,updatedAt,status,conclusion,jobs \
  > "$evidence/workflow.json"
gh run view "$run_number" --repo "$repo" --log > "$evidence/workflow.log"
workflow_url=$(jq -er '.url' "$evidence/workflow.json")
writer_sha=$(jq -er '.headSha' "$evidence/workflow.json")
record_sha=$(sha256sum "$evidence/workflow.json" | cut -d ' ' -f1)
log_sha=$(sha256sum "$evidence/workflow.log" | cut -d ' ' -f1)
jq -n --arg day "$day" --argjson connector "$connector" --arg run "$invocation" \
  --arg cutoff "$cutoff" --arg source "$source_sha" --arg manifest "$manifest_sha" \
  --arg url "$workflow_url" --arg writer "$writer_sha" --arg record "$record_sha" --arg log "$log_sha" \
  '{version:1, day_utc:$day, connector_id:$connector, row_count:22543, pollutant_count:37,
    original_run_id:$run, publication_cutoff:$cutoff, source_content_hash:$source,
    manifest_key:("history/v3/observations/day_utc="+$day+"/connector_id="+($connector|tostring)+"/manifest.json"),
    manifest_hash:$manifest, workflow_url:$url, writer_git_sha:$writer,
    workflow_record_sha256:$record, workflow_log_sha256:$log}' > "$evidence/baseline.json"
```

Review the complete original workflow and attempt before signing. Confirm genuine first publication and 22,543 source and written rows. For the same Prune invocation, confirm the target-day v3 batch started after publication and emitted two `phase_b_history_v3_run_finalization_failed` records in order. The writer record reports `failure_outcome=budget_stop` with the batch's affected days and connector count. The Prune batch record repeats the trigger and publication count and reports `stopped_for_budget=true` and zero completed connector gates. The following Phase B `stopped_budget` summary must list the observation day as blocked. GitHub's `success` conclusion is compatible with this internal stop. The program verifies the signed log and record hashes, workflow identity, publication scope and cutoff second, and this sequence. A completed finalization or connector gate for the target is contradictory evidence. For a re-run, export the original attempt's complete log with `gh run view --attempt N --log` and confirm the record corresponds to that attempt.

```sh
openssl pkeyutl -sign -rawin -inkey "$operator_private_key" \
  -in "$evidence/baseline.json" -out "$evidence/baseline.sig"
tool=scripts/operations/uk_aq_reconcile_stranded_prune.mjs
node "$tool" plan --directory "$evidence" --approval-key "$operator_public_key" \
  --expires-at "$plan_expiry_utc"
```

The expiry is canonical UTC with milliseconds, within 24 hours. Review `plan.json` for the exact half-open scope, IngestDB and selected-R2 proofs, source and hour counts, partition layout, candidate/gate and physical file evidence. Planning is read-only at IngestDB and canonical R2. It creates local `backup-bundle.json` with the exact raw rows, evidence and plan. Current physical tuple evidence guards changes between planning and execution. It cannot establish original row incarnation, including an identical reinsert or a backdated timestamp.

## Retain the immutable backup and approve

Select the private backup account and bucket, its AWS region and a retention expiry beyond plan expiry. The object is a sensitive raw-row backup. The backup operator uploads it with conditional creation and COMPLIANCE retention. Execution independently checks privacy, retention, exact content and readback from that specific version.

```sh
backup_key=$(jq -er '.plan.backup.key' "$evidence/plan.json")
backup_bytes=$(wc -c < "$evidence/backup-bundle.json" | tr -d ' ')
backup_sha=$(sha256sum "$evidence/backup-bundle.json" | cut -d ' ' -f1)
backup_checksum=$(openssl dgst -sha256 -binary "$evidence/backup-bundle.json" | openssl base64 -A)
AWS_IGNORE_CONFIGURED_ENDPOINT_URLS=true aws --region "$backup_region" s3api put-object --bucket "$backup_bucket" \
  --expected-bucket-owner "$backup_account" --key "$backup_key" --if-none-match '*' \
  --body "$evidence/backup-bundle.json" --checksum-algorithm SHA256 --checksum-sha256 "$backup_checksum" \
  --object-lock-mode COMPLIANCE --object-lock-retain-until-date "$backup_retain_until" \
  --output json > "$evidence/backup-upload.json"
backup_version=$(jq -er '.VersionId' "$evidence/backup-upload.json")
AWS_IGNORE_CONFIGURED_ENDPOINT_URLS=true aws --region "$backup_region" s3api get-object \
  --bucket "$backup_bucket" --expected-bucket-owner "$backup_account" --key "$backup_key" \
  --version-id "$backup_version" "$evidence/backup-readback.json" > "$evidence/backup-readback-metadata.json"
cmp "$evidence/backup-bundle.json" "$evidence/backup-readback.json"
jq -e --arg version "$backup_version" --argjson size "$backup_bytes" \
  '.VersionId == $version and .ContentLength == $size and .ObjectLockMode == "COMPLIANCE"
    and (.ObjectLockRetainUntilDate | type == "string")' "$evidence/backup-readback-metadata.json"

jq --arg ref "$approval_reference" --arg start "$window_start" --arg end "$window_end" \
  --argjson transaction_ms "$transaction_ms" --argjson lock_ms "$lock_ms" \
  --arg bucket "$backup_bucket" --arg account "$backup_account" --arg region "$backup_region" \
  --arg key "$backup_key" --arg version "$backup_version" --arg sha "$backup_sha" \
  --argjson bytes "$backup_bytes" --arg retain "$backup_retain_until" \
  '{version:1, plan_sha256, operation_id:.plan.operation_id, reference:$ref,
    window_start:$start, window_end:$end, transaction_ms:$transaction_ms, lock_ms:$lock_ms,
    accepted_row_incarnation_limitation:.plan.row_incarnation_limitation,
    accepted_cross_connector_impact:.plan.write_fence_impact,
    backup:{bucket:$bucket, owner_account:$account, region:$region, key:$key, version_id:$version,
      sha256:$sha, bytes:$bytes, retain_until:$retain}}' "$evidence/plan.json" > "$evidence/approval.json"
openssl pkeyutl -sign -rawin -inkey "$operator_private_key" \
  -in "$evidence/approval.json" -out "$evidence/approval.sig"
```

Check the returned readback retention against the requested timestamp and plan expiry. Sign only after reviewing the plan digest and execution ID, backup version, the residual row-incarnation uncertainty, both timeout bounds, and the all-connector impact for the named UTC window. The same signed key cannot authorize another plan. Use full UTC millisecond timestamps for the window and retention. For LIVE, the approval review also requires completed and reviewed TEST rehearsal evidence and separate LIVE execution authorization.

## Execute once and verify

```sh
node "$tool" execute --directory "$evidence" --approval-key "$operator_public_key"
```

Run once inside the approved window, with enough time for the external preflight and the complete SQL allowance. The command rechecks backup and selected R2 authority outside the SQL transaction. It retains the original observations lock session through COMMIT and rechecks source and audit inside the recursive table fence. It records a private attempt file before starting the transaction. Operational success requires COMMIT acknowledgement and `post-commit.json` from an independent read-only database connection. Verify zero raw and canonical rows, one matching receipt and unchanged candidate, gate and R2 evidence. Retain the digested report privately.

If contention, timeout, stale evidence or audit insertion fails, stop. If COMMIT is uncertain, the connection was lost, or the post-check failed, inspect read-only using the same signed plan and configured target.

```sh
node "$tool" inspect --directory "$evidence" --approval-key "$operator_public_key"
```

Use the private `inspection-*.json` with fresh counts, durable receipt details and current R2 comparison. A matching receipt establishes the committed deletion even if later rows arrived or R2 subsequently changed. A missing/conflicting receipt or a nonzero count requires investigation. Never reuse an attempted approval, remove the attempt file, fabricate gate markers, or blindly retry DELETE. A separately authorized new attempt requires fresh evidence, backup and approval.

Before any commit, failure rolls back deletion and receipt together. After commit, retain the receipt and evidence. Reverting the code or schema does not restore deleted source. A separately approved restore must use the verified exact raw backup, account for subsequent arrivals, verify raw and canonical identity after restore, and retain the exceptional receipt. Revert executable files to withdraw the command. Keep the receipt schema and committed receipts as audit evidence.

## Isolated TEST operational acceptance

Perform these steps only with separate authority for an isolated IngestDB and selected-v3 R2 bucket. Use one real stranded connector-day of 22,543 raw/canonical rows, 24 UTC hours and 37 pollutants, with authentic first-publication and budget-stopped v3 finalization logs and a failed blocked candidate / incomplete gate. Any staging of the failed candidate and incomplete gate belongs in the isolated rehearsal. Record the actual connector, day, workflow, publication cutoff and committed manifest hash in the signed baseline. Independently derive the TEST source hash using the current source and existing v1 encoder. With `test_pg_url` pointing to the isolated database, `day` and `connector` set, the following prints the identity only.

```sh
psql "$test_pg_url" -X -qAt -v ON_ERROR_STOP=1 -v day="$day" -v connector="$connector" <<'SQL' |
begin read only;
select jsonb_agg(to_jsonb(h)) from uk_aq_ops.uk_aq_phase_b_history_rows_v2(
  :'connector'::integer, (:'day' || 'T00:00:00Z')::timestamptz,
  (:'day' || 'T00:00:00Z')::timestamptz + interval '24 hours', null, null) h;
rollback;
SQL
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { computePruneConnectorSourceIdentity } from "./workers/shared/uk_aq_prune_connector_source_identity.mjs";
  console.log(JSON.stringify(computePruneConnectorSourceIdentity(JSON.parse(readFileSync(0, "utf8")))));
'
```

1. Verify PostgreSQL 17+, table layout, role grants and immutable backup access. Apply only the reviewed schema migration with `psql "$test_pg_url" -X -v ON_ERROR_STOP=1 -f schemas/migrations/20261122_001_ingest_prune_stranded_source_reconciliation.sql` from the schema repository. Review the exact scope and evidence using the plan and backup steps above.
2. Exercise the fence in two SQL sessions before the destructive rehearsal. In session A, set session `transaction_timeout='120s'`, begin at `REPEATABLE READ`, `SET LOCAL lock_timeout='5s'`, `SET LOCAL statement_timeout='5s'`, and take the exact recursive lock shown in the plan. In session B, set `lock_timeout='500ms'`. In separate rolled-back transactions, first issue an actual upsert using an existing target connector, timeseries and timestamp, then an actual update using a known unrelated connector key. Use no-change assignments and expect SQLSTATE `55P03` for both. Run an ordinary SELECT to verify read access, promptly roll back session A, then rerun the no-change writes in session B and roll each back. Record backend PIDs, elapsed times, outcomes and lock coverage of parent and leaves from `pg_locks`.
3. Demonstrate an executor contention failure by holding `ROW EXCLUSIVE` on an existing observations leaf in another session when the command reaches the table-lock phase. Expect bounded failure and all rows retained, with no receipt. Release the holder promptly. Using fresh approvals, test a changed-source refusal (reversible same-value tuple update in the isolated target after planning), and provoke an audit INSERT failure with a database-owner-managed temporary withdrawal of the isolated execution role's receipt INSERT grant. For the latter, independently verify the full source and candidate/gate state and zero receipts before restoring the grant.
4. Generate a fresh plan, backup version and signed approval, then execute once. Independently inspect the receipt, zero raw/canonical rows and unchanged candidate, gate and selected R2 identities. Exercise replay rejection using the committed attempt. Save the signed baseline, backup version, approval, contention evidence, failure results and digested post-check. Check ingestion resumes within the approved window. Review these results before any LIVE authorization.

## Future LIVE operator baseline

Use `repo=UK-AQ/uk-aq-ops`, `run_number=44444834653`, `connector=1`, `day=2026-11-14`, `invocation=452723ab-4504-40a0-bd0d-239107d7285f`, and `cutoff=2026-11-19T03:24:31.000Z`.

The workflow's GitHub conclusion is `success`. Its internal Phase B result is `stopped_budget` after the required v3 finalization failed under the `candidate_loop_budget_stop` trigger. Preserve the complete original log, including both failure records.

- `source_sha=02193a5f12e8d3b3832401d3acc08b3814ecf0b1046438e5cbc33d168b1fbd78`
- `manifest_sha=1ca74766cb6b48f369386af2aa09f93c220bd56b2fc45e72ebeded1fcf927848`
- Selected manifest `history/v3/observations/day_utc=2026-11-14/connector_id=1/manifest.json`
- Exactly 22,543 raw and 22,543 canonical observations, with zero raw rows recorded after the cutoff.

Promote only the complete approved versions of the four new modules under `scripts/operations/` and `scripts/operations/lib/`, this runbook, and the approved schema canonical SQL change and migration. Keep the local TEST archive and test artifacts out of LIVE. Establish a quiet window, monitor writer latency/errors, and retain the source if any provenance, configuration, backup, timing, source-scope or R2 check fails.
