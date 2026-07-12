# History Integrity

`scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py` is the
orchestrator for the UK-AQ history integrity run.

## Current flow

1. Load environment and preflight the selected environment.
2. Check Dropbox backup readiness for scheduled runs.
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
r2_backup_inventory,r2_history_dropbox_sync
```

## v2 hierarchy validation

The v2 integrity checks now validate parent manifest content against the live
child directories instead of trusting a single manifest representation.

This emits dedicated gap types for:

- missing child representations in connector/day manifests;
- file-count, unlisted-parquet, and listed-parquet mismatches;
- total-byte mismatches;
- timeseries row-count mismatches.

## Repair planning

Each v2 run now includes a `repair_plan` array in the report summary. The plan
is non-executing and is ordered so manifest repairs happen before any rebuilds.

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
