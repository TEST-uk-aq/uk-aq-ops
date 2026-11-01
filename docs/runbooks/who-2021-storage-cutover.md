# WHO independent storage: implementation and operator handover

Authority: TEST system-docs `d799c1daf5da84187c012c474694132a53e26aed`, WHO relocation and independent dataset-backup contracts. This runbook does not authorise execution. No deployment, database apply, snapshot, copy, restore, workflow dispatch or deletion was performed during implementation. AQI retirement is excluded.

## Implementation and configuration

`workers/shared/uk_aq_who_2021_storage.mjs` owns the required `UK_AQ_WHO_2021_R2_PREFIX`. It resolves one trailing slash, rejects missing/unsafe paths and requires a directory ending in `who_2021`. It supports both `history/v2/who_2021/` and `who_2021/`. There is no default, environment fallback or observation-generation coupling. SQL uses the same validation rule and a required `p_output_prefix` named parameter. Both canonical definitions and grants are updated in the Schema PR.

Operator actions **before the first deployment or scheduled run of the new code**:

- Provision the non-secret GitHub repository variable `UK_AQ_WHO_2021_R2_PREFIX=history/v2/who_2021/`. Reader deployment receives it through Wrangler; publisher receives it through Actions. Do not select the new root yet.
- Provision `UK_AQ_WHO_2021_BACKUP_WRITER_EXCLUSION_CONFIRMED=true` only after confirming that all WHO writers use the existing single workflow concurrency group, and installed/manual writers are held or cannot overlap capture. This new acknowledgement does not acquire a distributed lock or stop a scheduler. Never set it merely to bypass the guard. The publisher fails before calculation/publication if enabled publication lacks this acknowledgement or Dropbox credentials.
- Update the **private** `env-vars-master.csv` with these two variables and the existing target catalogue. Do not commit that file. No private variable master is available in this checkout.
- Verify existing `CFLARE_R2_*`/`R2_*` aliases select exactly one authorised account/bucket; contradictory credential/target aliases fail. Existing `UK_AQ_DROPBOX_ROOT`, `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN` are reused. No new secret, bucket, public endpoint, direct public R2 binding or independent cron is introduced.
- Confirm actual TEST bucket/account, lifecycle/access rules, all WHO writers/readers, workflow admission controls and rollback owner. The CLI requires `UK_AQ_ENV_NAME=TEST` and `--confirm-bucket` matching the configured bucket for migration/restore. A label alone does not authenticate an account: inspect operator credential/bucket identity independently.
- Preserve disabled Prune and the accumulated Prune/JSONgen integration observations. Do not run either system for these checks.

## Distinct operational phases (each separately authorised)

1. **Preparation:** review paired Ops/Schema PRs and preserve their exact commits. Configure the old root explicitly. Stage reader changes with old-root configuration. The public API paths and browser payload stay unchanged. Do not allow scheduled Actions to pick up an incompatible publisher during a merge/apply gap.
2. **Schema and caller transition:** hold WHO workflow admission and drain in-flight and installed/manual writers. Apply Schema `schemas/migrations/20261101_001_obs_aqidb_who_output_prefix.sql` to the independently verified TEST Obs AQI DB using the existing approved SQL apply mechanism. It transactionally removes the old six-argument RPC and installs the required-root seven-argument signature, revokes public/anon/authenticated execution, grants service-role and requests PostgREST schema reload. Then release the matching Ops caller with the old root. No incompatible caller may run between these steps. The canonical SQL files are desired-state definitions, not an alternative ad hoc migration. Apply/deploy is not authorised by this runbook.
3. **Writer hold and bootstrap:** at the migration window hold/drain WHO again, confirm exclusion and take a standalone old-root snapshot using the tool below. Verify its manifest, immutable completion marker, latest-complete selector, byte hashes and coverage. Report upload or database dump is not this proof.
4. **R2 copy:** create a fresh plan with source old-root and target new-root; independently review exact keys, metadata, source/destination bucket, totals and plan SHA-256. Resolve any destination collision or source change; do not overwrite a different object. Execute only that approved plan. Inspect operation evidence and independently verify the destination. Original objects remain untouched. The 92 objects / 773,057 bytes from the historical capture are comparison evidence, not hard-coded current expectations. Preserve the sparse 15-Parquet/77-JSON footprint; no calendar data or missing historical days are fabricated.
5. **Reader switch:** while writers remain held deploy the authenticated reader with prefix `who_2021/`. Verify cold and conditional ETag reads, unchanged hits, private authentication, public summary, error/stale distinctions and physical-key cache isolation. No automatic old-root fallback exists; do not change the public proxy/browser configuration.
6. **Publisher switch:** provision the same new root for the publisher, verify the installed RPC/caller match, then release only the authorised WHO schedule/admission. Preserve `UK_AQ_R2_HISTORY_VERSION` and canonical observation inputs. The moved Parquet logical hash includes the old absolute key; copied metadata is retained, and the first normal publication may rewrite once using the new-key logical identity.
7. **Real publication/backup acceptance:** authorise an ordinary TEST cycle separately. Confirm daily/correction and rolling/calendar semantics, Parquet before dated JSON before latest, new-root output only, existing scientific results/public schema and no old-root writes. Backup follows successful enabled JSON and/or Parquet publication even when all logical writes are unchanged; disabled/deferred/dry-run publication remains `not_requested`. `dataset_backup.publication_status=published` survives a backup failure; that failure makes workflow/task health fail without rolling back publication. Existing report upload remains independent. Validate a complete new-root snapshot and source identities, not only bounded report arrays.
8. **Isolated restore:** validate an explicitly approved immutable completed snapshot and hash, then restore to the tool's generated `who_2021_restore/<UUID>/who_2021/` prefix. Verify every restored byte and metadata identity and representative JSON/Parquet. No serving restore/overwrite option is implemented.
9. **Rollback hold:** retain all snapshots and original R2 objects at least 14 days after accepted cut-over, extended for unresolved issues. After new publications, hold WHO and reconcile newer accepted data back before changing reader/publisher to the old root; merely pointing at frozen old latest loses corrections. Preserve the required-root RPC when rolling back configuration. An old six-argument binary requires an explicit coordinated schema rollback under exclusion; do not remove the new interface beneath its caller. Old-root object retirement requires a different per-object approval; this tool has no delete command. Release any Prune/JSONgen hold only through its separately authorised test.

## Operator utility

Entry point: `node scripts/who_2021/dataset.mjs`. Importing the module performs no I/O. All commands require the existing authorised environment; commands below are examples for **later approval**, not commands executed by this change. Use unique private local report/manifest files. Store the plan's SHA-256 and reports durably before proceeding.

Standalone bootstrap (requires a real writer hold; writes Dropbox only):

```bash
node scripts/who_2021/dataset.mjs --mode backup --execute true --report work/who-bootstrap-result.json
```

Read-only source/destination planning (remote LIST/GET only, local immutable plan write):

```bash
node scripts/who_2021/dataset.mjs --mode plan --confirm-bucket "$CFLARE_R2_BUCKET" --target who_2021/ --manifest work/who-plan.json --report work/who-plan-result.json
```

Copy only after independent review and explicit approval of the exact plan SHA:

```bash
node scripts/who_2021/dataset.mjs --mode copy --execute true --confirm-bucket "$CFLARE_R2_BUCKET" --target who_2021/ --manifest work/who-plan.json --approve "$APPROVED_WHO_PLAN_SHA256" --report work/who-copy-result.json
```

Validate a completed snapshot without R2 writes, then separately authorise its isolated restore:

```bash
node scripts/who_2021/dataset.mjs --mode restore --confirm-bucket "$CFLARE_R2_BUCKET" --snapshot "$APPROVED_WHO_SNAPSHOT_ID" --approve "$APPROVED_WHO_MANIFEST_SHA256" --report work/who-restore-validation.json
node scripts/who_2021/dataset.mjs --mode restore --execute true --confirm-bucket "$CFLARE_R2_BUCKET" --snapshot "$APPROVED_WHO_SNAPSHOT_ID" --approve "$APPROVED_WHO_MANIFEST_SHA256" --report work/who-restore-result.json
```

The `APPROVED_*` shell variables above are per-invocation approval inputs, not new repository settings. Snapshot IDs/hashes come from verified backup evidence. Restore validates that snapshot's immutable `complete.json`, so an older bootstrap remains selectable after later snapshots advance latest-complete.

## Backup, retry and safety semantics

Snapshots live below `<UK_AQ_DROPBOX_ROOT>/who_2021/datasets/snapshots/<UTC-time-and-UUID>/objects/<relative-key>`. Each manifest records source bucket/root, exact source keys, ETags, byte SHA-256, sizes, content type/custom metadata, aggregate counts/bytes and absent optional-family coverage. Objects are copied and downloaded for independent SHA verification before manifest, per-snapshot completion marker and root latest-complete selector are published, in that order. Previous generations and selectors survive failures before selector publication. Ambiguous writes are reconciled by byte readback, never assumed successful. A selector transport failure can conservatively report failure even if an already verified complete generation was selected; inspect readback before retrying.

Budgets: at most 10,000 objects, 8 MiB per object, 64 MiB aggregate held in memory, sequential transfer, three transport attempts, 30-second request/body timeouts, and a 20-minute source-capture budget. Exceeding limits fails closed. No automatic cleanup or deletion. Each fresh backup invocation gets a new immutable ID; failed partial generations remain unselected and retained. Restart by taking a new snapshot under writer exclusion; do not reuse an ID for a changed source. Migration copy retries require the same approved manifest and unchanged source; conditional create refuses overwrite, and exact existing destination bytes/metadata permit recovery of already copied members. A changed source requires a new review/plan, not expansion of the approved set.

The source is completely listed with strict continuation validation and checked again after transfer, including a second body/metadata/ETag check. This detects changes but does not replace actual writer exclusion. No tool acquires or alters an observation-history lock. Snapshot completion means full preservation of the existing validated object set, not complete scientific/date coverage.

Unknown key shapes, missing/changing objects, invalid summaries/Parquet or embedded WHO output references fail closed. This first implementation deliberately refuses encoded HTTP representations and embedded absolute WHO reference transforms rather than claiming exact-byte migration while changing bodies. Current WHO summaries contain no required output-reference contract. If actual refreshed data needs a transform or encoded transport, resolve that through a bounded approved extension before copying; observation-source references/hashes are never rewritten. The utility does not restore over serving data, implement serving rollback reconciliation, or delete old roots. Those remain separately approved operator procedures.

## Review evidence and remaining acceptance

The implementation record lists exact archives, checks and paired PR dependency. Local checks are structural/deterministic only. Actual bucket access, complete old/new-root snapshots, isolated restore, reader/cache transitions, source stability, schedules/flags and scientific/public acceptance remain unverified until separately authorised TEST operation. LIVE uses the same code but requires its own inventory, configuration, approvals and acceptance; no LIVE changes are included.
