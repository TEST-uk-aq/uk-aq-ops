# Backup and recovery

## Current authoritative scope

This area is currently authoritative for the scheduled logical Supabase database dump backup that writes dated backup sets to Dropbox.

The broader UK AQ backup, restore and repair area is not yet fully migrated from `system_docs_legacy/`. Until further active contracts are added here, this directory does not redefine R2 history backup, R2 core snapshot, Integrity repair or other backup systems.

## Required reading order

Before changing the Supabase logical database dump backup, read:

1. [`../README.md`](../README.md)
2. [`contract.md`](contract.md)
3. [`../../AGENTS.md`](../../AGENTS.md)
4. [`../scheduling/`](../scheduling/) when an active scheduling contract exists for the shared Cloudflare scheduler
5. `cloudflare/scheduler/README.md`
6. `cloudflare/scheduler/jobs.toml`
7. `workers/uk_aq_supabase_db_dump_backup_service/README.md`

The active contract in this directory overrides the historical GCP runtime description in:

- `system_docs_legacy/uk-aq-supabase-db-dump-backup-service.md`

The legacy file remains historical reference only.

## Implementation ownership

The current implementation remains under:

- `workers/uk_aq_supabase_db_dump_backup_service/core.mjs`
- `workers/uk_aq_supabase_db_dump_backup_service/health.mjs`
- `workers/uk_aq_supabase_db_dump_backup_service/job.mjs`

The directory name retains `_service` for implementation continuity. It does not imply that an HTTP or Cloud Run Service remains active.

## Change rule

Codex and other coding agents must treat `system_docs/` as read-only. Behavioural changes require a ChatGPT documentation update and an implementation handover in accordance with `AGENTS.md`.