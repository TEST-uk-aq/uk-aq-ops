# History Integrity

`scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py` is the
orchestrator for the UK-AQ history integrity run.

## Supported runtime model

Run history integrity, including the Phase 3 executor, from the complete ops
checkout at:

```text
/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops
```

This is the only supported runtime model. The Phase 3 executor imports shared
R2/index code and the Phase B writer from elsewhere in the repository, whose
Node dependencies are also required. Do not copy a partial `bin/` or `env/`
directory and do not rely on an undocumented runtime bundle.

## Current flow

1. Load the v2-only integrity environment and then the configured backfill environment when daily-task health needs it.
2. Check Dropbox backup readiness for scheduled runs before Dropbox-inspecting preflight checks.
3. Import the current `R2_history_backup/history/v2/core` snapshot using the v2 core writer manifest/table contract.
4. Run the configured source adapters.
5. Run R2 history cross-checks.
6. Validate v2 only:
   - observations partitions and manifests;
   - AQI hourly partitions and manifests.
7. Build a repair plan and write JSON/Markdown reports.

`--history-version v2` is the only accepted history version. `v1`, `both`,
and `--run-backfill` are rejected before scanning or repair work. The current
integrity CLI is read-only while the single v2 repair orchestrator is completed;
the Phase 3 executor remains the authoritative manifest/index finaliser.

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

The RPC's canonical SQL definition is owned by
`TEST-uk-aq-schema/schemas/obs_aqi_db/uk_aq_rpc_daily_task_backup_readiness.sql`.
The ops contract test reads that sibling schema source directly; no ops SQL
mirror is maintained.

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
