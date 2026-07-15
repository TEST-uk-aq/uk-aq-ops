# History Integrity

`scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py` is the
orchestrator for the UK-AQ history integrity run.

## Supported runtime model

Run history integrity, including the Phase 3/4 executors, from the complete ops
checkout at:

```text
/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops
```

This is the only supported runtime model. The Phase 3/4 executor imports shared
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
7. Build the repair plan. When `--run-backfill` is set, create a sparse local
   run overlay and run the ordered v2 coordinator after all detection has
   completed.
8. Write JSON/Markdown reports.

`--history-version v2` is the only accepted history version. `v1` and `both`
remain rejected. `--check-only` and `--run-backfill` are mutually exclusive.
`--run-backfill --dry-run` records the complete stage plan without writes;
without `--dry-run`, the coordinator runs the ordered observation and AQI
stages through AQI indexes, then performs one read-only final verification. It
uses source-cache for observation truth and a disposable overlay-first,
Dropbox-second local view for observations, manifests and indexes. Any
actionable remaining scope fails the run. The AQI writer uses the already
verified live-R2 observation scope as the narrow
same-run exception; generated AQI objects are compared with the subsequent GET
before they are marked verified in the overlay.

The overlay is under `UK_AQ_HISTORY_INTEGRITY_TMP_DIR/run-<UTC>/overlay` and
contains only changed/generated objects. `run-state.json` records object hashes,
dependencies, upload/verification state, changed scopes, and blocked scopes.
Later stages resolve a verified overlay object first, then the matching
`R2_history_backup` object. The backup is never updated or copied into.
Verified tombstones hide objects deleted by a targeted replacement, so a stale
Dropbox part cannot reappear in the current run's combined view.

The metadata executor plans solely from that combined-local view. It does not
GET, HEAD, or list live R2 before a metadata PUT. For an authorised real apply,
every changed proposal is PUT and immediately GET-verified for exact bytes and
canonical structure. The only retained live-read exception is the AQI writer's
read of observation objects that the same run has already PUT/GET-verified.
An index-only O3 observation leaf can be read by exact Dropbox key for its
index, but cannot enter connector/day child discovery unless an explicit O3
leaf repair has staged a canonical leaf manifest.

The metadata executor reads parquet metadata from the final combined local
object. Observation parquet uses `observed_at_utc`, with `observed_at` accepted
only for older compatible files; a file with neither timestamp column blocks
its exact leaf scope. Missing requested pollutant parquet blocks its connector,
day manifest and targeted index rather than allowing partial parent metadata.
The resolver scans only affected day prefixes and reads the single exact global
latest-index key needed to merge those days, so untouched latest-index entries
are preserved without a broad Dropbox scan.

Integrity does not use the shared full per-timeseries metadata rebuild. It
merges each affected metadata object by `domain`, `day_utc`, `connector_id` and
`pollutant_code`, preserving all untouched observation and AQI entries before
recalculating coverage. Missing metadata blocks safely. Every final affected
connector and pollutant child is required, so an unreadable child produces no
latest-index or metadata proposal for that incomplete day.

Targeted metadata planning unions old and final pollutant-index timeseries IDs,
so removal-only IDs lose only their exact affected entry. A final-empty metadata
object blocks until verified deletion support exists. Latest-index proposals are
applied after pollutant and metadata proposals, and tombstones precede every
Dropbox fallback, including dynamic exact-key reads.

The final report includes prior R2 GET verification evidence for every changed
object and delete verification evidence for every replacement deletion. It
reports `r2_objects_written`, `r2_objects_deleted`, and their verified union as
`r2_objects_changed`; a key deleted and then recreated in the same run counts
once as a final write. On a successful non-dry-run repair, Integrity removes only the
duplicate `generated-objects` staging directory and the disposable final
verification view after the reports are written. It retains the sparse verified
overlay and `run-state.json`; failed overlays are retained unchanged.

Final repair reports keep the original detection as `pre_repair` evidence and
make the principal v2 status reflect the final verification state. A failed
final verification or `stopped_limit` is reported to daily task health as a
failed task, not a finished task.

Final verification includes each changed global metadata object by exact key.
It validates schema, identity, entry uniqueness, every coverage and top-level
aggregate, then cross-checks affected pollutant-index payload identities and
row counts without scanning the global metadata prefix. Per-key proposal
evidence retains every stage attempt, while only a GET-verified or unchanged
metadata body becomes authoritative for this final contract. A failed
application is recorded as a deterministic blocked scope before PUT, or an
uncertain R2 object after PUT was attempted, and therefore always fails the
single final verification.

## Backup gate

Scheduled runs now call the Integrity-specific Obs AQI DB RPC
`uk_aq_public.uk_aq_rpc_history_integrity_readiness(timestamptz)` before any
Dropbox history scan starts. This leaves the unrelated date-based backup
readiness RPC unchanged for its existing callers.

- The latest successful non-dry-run `ops.r2_history_dropbox_backup` must have
  started after the latest finished `ops.prune_daily` and
  `ops.r2_core_snapshot` attempts. Failed writer attempts count because they
  may have written R2 objects before failing.
- A previous `ops.history_integrity` attempt is a writer only when its task
  summary has `repair_mode=true` (or the legacy `run_backfill=true`) and
  `dry_run=false`.
- Any relevant writer still in `Started`, including a Dropbox backup attempt,
  blocks the run. The qualifying backup
  must also have finished before the current Integrity run started.
- If the gate is not ready, the run exits early with
  `status=blocked_backup_not_ready`.
- `--allow-stale-dropbox` remains an explicit recovery override and is
  recorded in the JSON and Markdown reports.

The RPC returns the qualifying backup run and timestamps, any running Dropbox
backup details, and the latest finished/running state for every relevant writer,
so the report explains the decision without inspecting R2.

The gate calls the RPC through the exposed `uk_aq_public` PostgREST schema and
uses the Obs AQI DB credential order: dedicated daily-task-health variables,
`OBS_AQIDB_SUPABASE_URL`/`OBS_AQIDB_SECRET_KEY`, then established generic
fallbacks. The request includes only the Integrity start timestamp. Missing
credentials, invalid inputs, RPC failures, or unexpected response shapes block
the run safely.

The RPC's canonical SQL definition is owned by
`TEST-uk-aq-schema/schemas/obs_aqi_db/uk_aq_rpc_history_integrity_readiness.sql`.
No ops SQL mirror is maintained.

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

Each v2 run includes a deterministic, deduplicated `repair_plan` array. The
The coordinator consumes observation and AQI metadata/index actions after data
repair and includes
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
