# UK AQ R2 Core Snapshot

This document describes the daily `uk_aq_core` metadata snapshot written from ingest DB to R2 History.

## Purpose

- Persist a daily metadata snapshot in R2 for backfill/recovery workflows.
- Keep a manifest + checksums per day so Dropbox backup/restore can validate object integrity.
- Reduce dependency on live ingest DB for historical replay tooling.

## Workflow

GitHub workflow:

- `.github/workflows/uk_aq_r2_core_snapshot.yml`

The workflow reports daily task health under `ops.r2_core_snapshot` with `Started`, `Finished`, and `Failed` lifecycle updates.

Intended schedule:

- `12:05 UTC` daily via `cloudflare/scheduler/ops` in the ops repo.
- Previous GitHub cron: `15 4 * * *` (UTC).

Dispatch inputs:

- `dry_run`: build exports/manifests without writing to R2.
- `day_utc`: optional `YYYY-MM-DD` override (default: current UTC day).
- `tables`: optional comma-separated table list override.

## Script

Script:

- `scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs`

Default output prefix:

- `history/v1/core`

Per-day output layout:

- `history/v1/core/day_utc=YYYY-MM-DD/manifest.json`
- `history/v1/core/day_utc=YYYY-MM-DD/checksums.sha256`
- `history/v1/core/day_utc=YYYY-MM-DD/table=<table>/rows.ndjson.gz`

The script:

1. Exports selected `uk_aq_core` tables in deterministic PK order.
2. Writes each table as newline-delimited JSON (gzip compressed).
3. Computes SHA-256 hashes for compressed payloads (plus uncompressed hash metadata).
4. Builds `checksums.sha256` and `manifest.json` with totals and table metadata.
5. Skips R2 writes when the new `manifest_hash` matches the existing manifest for the day.
6. Retries the database export phase on transient connection/cursor failures before giving up.

R2 reads and writes already use the shared `workers/shared/r2_sigv4.mjs` retry logic for transient HTTP and request failures.

## Default table set

- `connectors`
- `categories`
- `observed_properties`
- `phenomena`
- `offerings`
- `features`
- `procedures`
- `networks`
- `sos_networks`
- `sos_network_pollutants`
- `stations`
- `station_metadata`
- `timeseries`

## Required configuration

Environment:

- `UK_AQ_INGEST_DATABASE_URL` (or `SUPABASE_DB_URL`)
- `CFLARE_R2_ENDPOINT`
- `CFLARE_R2_BUCKET`
- `CFLARE_R2_REGION` (default `auto`)
- `CFLARE_R2_ACCESS_KEY_ID`
- `CFLARE_R2_SECRET_ACCESS_KEY`

Optional:

- `UK_AQ_R2_HISTORY_CORE_PREFIX` (default `history/v1/core`)
- `UK_AQ_CORE_SNAPSHOT_SCHEMA` (default `uk_aq_core`)
- `UK_AQ_R2_CORE_SNAPSHOT_CURSOR_BATCH_ROWS` (default `5000`)

## Local run

```bash
node scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs \
  --day-utc 2026-03-11 \
  --report-out ./tmp/uk_aq_core_snapshot_to_r2_report.json
```

Dry-run with subset:

```bash
node scripts/backup_r2/uk_aq_core_snapshot_to_r2.mjs \
  --dry-run \
  --tables connectors,stations,timeseries
```
