# History Integrity

`scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py` is the
orchestrator for the UK-AQ history integrity run.

## Current flow

1. Load the integrity environment and then the configured backfill environment.
2. Check Dropbox backup readiness for scheduled runs before Dropbox-inspecting preflight checks.
3. Import the current core snapshot.
4. Run the configured source adapters.
5. Run R2 history cross-checks.
6. For `history_version=v2`, validate both:
   - observations partitions and manifests;
   - AQI hourly partitions and manifests.
7. Build a repair plan and write JSON/Markdown reports.

## Backup gate

Scheduled runs now call the Obs AQI DB RPC
`uk_aq_public.uk_aq_rpc_daily_task_backup_readiness(date, timestamptz, text[])`
before any Dropbox history scan starts.

- If the required backup tasks are not ready, the run exits early with
  `status=blocked_backup_not_ready`.
- `--allow-stale-dropbox` bypasses the gate for manual recovery runs.

The required task keys default to:

```text
ops.r2_history_dropbox_backup
```

This is the factual daily-task key for the single GitHub workflow that builds
the R2 backup inventory and then runs the inventory-driven Dropbox sync. The
workflow reports `Finished` only after both ordered steps complete successfully.

The gate calls the RPC through the exposed `uk_aq_public` PostgREST schema and
uses the Obs AQI DB credential order: dedicated daily-task-health variables,
`OBS_AQIDB_SUPABASE_URL`/`OBS_AQIDB_SECRET_KEY`, then established generic
fallbacks. The request includes the scheduled date, integrity start timestamp,
and required task keys. Missing credentials, invalid inputs, RPC failures, or
unexpected response shapes block the run safely.

## v2 hierarchy validation

The v2 integrity checks start from actual day, connector, pollutant, and parquet
paths in the scoped Dropbox mirror. They validate parent manifest content
against valid child manifests instead of trusting a single parent
representation.

DuckDB reads the actual parquet files and calculates whole-partition and
per-timeseries row counts. The report keeps these comparisons separate:

1. source counts versus actual parquet counts;
2. actual parquet counts versus pollutant manifest counts;
3. pollutant manifests versus connector/day hierarchy representations.

`duckdb` is therefore required for a complete v2 check. An unavailable reader
or unreadable parquet is reported explicitly and fails closed.

This emits dedicated gap types for:

- missing child representations in connector/day manifests;
- file-count, unlisted-parquet, and listed-parquet mismatches;
- total-byte mismatches;
- timeseries row-count mismatches.

Missing connector and day manifests are reported directly. Parent validation
also covers row/source-row/file/byte aggregates, min/max timeseries identifiers,
supported timestamp ranges, parquet key sets, and child manifest hashes.

Each finding includes `fault_class`, distinguishing data, pollutant-manifest,
connector-manifest, day-manifest, index, metadata, source-mapping, and
source-unavailable faults. Both source-only and R2-only per-timeseries count
differences are retained in the report.

## Repair planning

Each v2 run includes a deterministic, deduplicated `repair_plan` array. Phase 2
plans are non-executing (`executes=false`, `status=planned`) and include
`data_changes_required`, `requires_index_rebuild`, and all contributing gap
types.

Readable valid parquet with a missing or invalid pollutant manifest is a
manifest-only fault. Its plan rebuilds the manifest without rewriting parquet.
Manifest-only O3 findings do not queue AQI.

Relevant repair kinds include:

- `observation_pollutant_manifest_repair`
- `observation_connector_manifest_repair`
- `observation_day_manifest_repair`
- `aqi_pollutant_manifest_repair`
- `aqi_connector_manifest_repair`
- `aqi_day_manifest_repair`
- `aqi_rebuild`

## Manual validation

Typical local checks:

```bash
python3 -m unittest scripts/uk-aq-history-integrity/tests/test_backup_gate_and_repair_plan.py
python3 -m unittest scripts/uk-aq-history-integrity/tests/test_v2_observations_integrity.py
python3 -m unittest scripts/uk-aq-history-integrity/tests/test_v2_aqilevels_integrity.py
```

For a full run, use the existing shell wrapper after loading the environment
for the target environment.


### Phase 2b validation clarifications (2026-07-12)

- The v2 checker remains read-only: it inspects the Dropbox/R2 history mirror and produces planned, non-executing repair actions only.
- Source comparison now distinguishes a successful empty source count map from unavailable source evidence. Successful empty source counts are authoritative and can report R2-only rows; unavailable source evidence does not masquerade as zero source rows.
- V2 writer manifests require integer `row_count`, `source_row_count`, `file_count`, and `total_bytes` aggregates on pollutant, connector, and day manifests. Min/max id and timestamp aggregates are required when child data supplies those values; absent optional min/max fields on empty child sets are not faults.
- The authoritative writer only builds v2 pollutant partitions from non-empty candidate row sets; a zero-row pollutant partition is therefore reported as `data_partition_zero_rows`, not as a malformed integer. Parent zero aggregates are valid only when they accurately summarize empty child sets.
- Phase 2b validates stored parent/child hash consistency and required stored hash presence. It does not claim complete canonical manifest hash verification beyond writer-compatible stored-hash consistency.
- Parquet statistics count all rows separately from non-null `timeseries_id` rows. Null `timeseries_id` rows are reported as `parquet_null_timeseries_id_rows` data faults.
- Repair planning uses evidence: readable parquet matching available source evidence can be manifest-only, source/parquet disagreement or structural parquet faults require data repair, and missing parquet with unavailable source evidence is blocked for operator review rather than planned as manifest-only.
