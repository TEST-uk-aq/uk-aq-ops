# Backup and recovery

## Current authoritative scope

This area is authoritative for:

- the scheduled logical Supabase database dump backup that writes dated backup sets to Dropbox;
- the R2 v2 history Dropbox backup inventory, checkpoint sharding and incremental-copy contract.

The broader UK AQ restore and repair area is not yet fully migrated from `system_docs_legacy/`. Until further active contracts are added here, this directory does not redefine R2 core snapshot recovery, general Integrity observation repair or other backup systems outside the explicit contracts below.

## Required reading order

### R2 v2 history Dropbox backup

Before changing the R2 history inventory builder, Dropbox sync, checkpoint layout or backup workflow, read:

1. [`../README.md`](../README.md)
2. [`r2_history_dropbox_backup_contract.md`](r2_history_dropbox_backup_contract.md)
3. [`../r2_history/observations_manifest_hierarchy_contract.md`](../r2_history/observations_manifest_hierarchy_contract.md)
4. [`../r2_history/observations_run_exclusion_contract.md`](../r2_history/observations_run_exclusion_contract.md)
5. [`../../AGENTS.md`](../../AGENTS.md)
6. `scripts/backup_r2/README.md` when present
7. the active backup workflow under `.github/workflows/`

The R2 backup contract preserves mandatory Phase B observations backup coverage while replacing repeated whole-checkpoint writes with hierarchical inventory and sharded Dropbox state.

### Supabase logical database dump backup

Before changing the Supabase logical database dump backup, read:

1. [`../README.md`](../README.md)
2. [`contract.md`](contract.md)
3. [`../../AGENTS.md`](../../AGENTS.md)
4. `system_docs/scheduling/` when an active scheduling contract is later created for the shared Cloudflare scheduler
5. `cloudflare/scheduler/README.md`
6. `cloudflare/scheduler/jobs.toml`
7. `workers/uk_aq_supabase_db_dump_backup_service/README.md`

The active Supabase contract in this directory overrides the historical GCP runtime description in:

- `system_docs_legacy/uk-aq-supabase-db-dump-backup-service.md`

The legacy file remains historical reference only.

## Implementation ownership

### R2 v2 history Dropbox backup

Current and future implementation ownership includes:

- `scripts/backup_r2/build_backup_inventory.mjs`
- `scripts/backup_r2/sync_history_to_dropbox.mjs`
- `scripts/backup_r2/lib/inventory.mjs`
- the active R2 history Dropbox backup workflow under `.github/workflows/`

### Supabase logical database dump backup

The current implementation remains under:

- `workers/uk_aq_supabase_db_dump_backup_service/core.mjs`
- `workers/uk_aq_supabase_db_dump_backup_service/health.mjs`
- `workers/uk_aq_supabase_db_dump_backup_service/job.mjs`

The directory name retains `_service` for implementation continuity. It does not imply that an HTTP or Cloud Run Service remains active.

## Change rule

Codex and other coding agents must treat `system_docs/` as read-only. Behavioural changes require a ChatGPT documentation update and an implementation handover in accordance with `AGENTS.md`.
