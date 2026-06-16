# UK-AQ History Integrity v1/v2 Implementation Plan

## 1. Executive summary

The active UK-AQ integrity tooling is partly history-integrity tooling and partly AQI-gap tooling:

- `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py` is the main integrity runner. Its R2 cross-check currently compares upstream/source-derived timeseries row counts with v1-style observations timeseries index manifests under `history/_index/observations_timeseries`, and its AQI health check defaults to v1-style AQI history under `history/v1/aqilevels/hourly`.
- `scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py` is a local AQI logical gap checker. Its R2 source mode is also hard-coded to v1 paths: `history/v1/observations` and `history/v1/aqilevels`.
- `scripts/aqi_gaps/check_r2_aqi_gaps.sh` is an older/manual DuckDB shell checker. It hard-codes CIC-Test Dropbox paths and v1 observations/AQI/index patterns.

The index builder already has substantial v2 awareness in `workers/shared/uk_aq_r2_history_index.mjs`: v2 data/index prefix constants exist, v2 env vars are read, and a v2 rebuild path can rebuild observations and AQI hourly data timeseries indexes.

The integrity tooling itself is not version-aware yet. It can therefore report a v1-oriented “healthy” result while v2 is missing, especially for the 2026-06-11 case where data exists in v1 observations but the site reads v2. To fix this safely, add a central history-version path resolver and make every R2/local-Dropbox integrity check explicitly run against `v1`, `v2`, or `both`, with report output that always includes the checked history version.

## 2. Current integrity architecture

### 2.1 Main runner: `uk-aq-history-integrity.py`

The main runner does several things:

1. Loads environment and guardrails via the shell launcher.
2. Imports a core snapshot from the local Dropbox R2 backup.
3. Runs source adapters for OpenAQ, Sensor.Community, and UK Air SOS.
4. Stores source file and source-file-timeseries row counts in SQLite.
5. Runs a source-vs-R2 cross-check for observations using local R2 index manifests.
6. Optionally queues/executes observation repair backfills.
7. Optionally runs AQI health checks and queues AQI rebuilds.
8. Writes JSON and Markdown summary reports.

The R2 cross-check path is currently driven by `run_r2_cross_checks()`, which reads local R2 history root `UK_AQ_R2_HISTORY_DROPBOX_ROOT` and a single observations index prefix, defaulting to `history/_index/observations_timeseries`.

The AQI health path is currently driven by `run_aqi_health_checks()`, which reads the AQI prefix from `UK_AQ_R2_HISTORY_AQILEVELS_PREFIX`, defaulting to `history/v1/aqilevels/hourly`.

The main orchestration passes these env vars directly into the two R2-related functions:

- `UK_AQ_R2_HISTORY_DROPBOX_ROOT`
- `UK_AQ_R2_HISTORY_OBSERVATIONS_TIMESERIES_INDEX_PREFIX`
- `UK_AQ_R2_HISTORY_AQILEVELS_PREFIX`

### 2.2 AQI gap checker: `uk-aq-aqi-gap-check.py`

The AQI gap checker compares expected logical AQI rows derived from observations against actual backed-up AQI rows. It supports two source modes:

- `--source r2-dropbox`
- `--source db-dump`

The CLI currently has no history-version option.

In `r2-dropbox` mode, it discovers local R2 parquet files from hard-coded v1 locations:

- `root/history/v1/observations/day_utc=...`
- `root/history/v1/aqilevels/day_utc=...`

The `obsaqidb` profile uses `build_r2_day_manifest_days()` to exclude days that already appear to be present in R2. That exclusion currently checks only `root/history/v1/aqilevels`.

### 2.3 Older manual DuckDB checker

`check_r2_aqi_gaps.sh` is a fixed-parameter/manual checker. It hard-codes:

- a local CIC-Test Dropbox backup root,
- a single timeseries/station/pollutant,
- fixed April/May 2026 date patterns,
- v1 observations,
- v1 AQI,
- v1 observations index,
- v1 AQI index.

This script should be treated as diagnostic/example tooling unless still operationally used.

## 3. Current v1 assumptions

### 3.1 Main integrity runner v1 assumptions

The main hard-coded defaults are:

| Current constant/env behavior | v1 assumption |
| --- | --- |
| `R2_OBSERVATIONS_TIMESERIES_INDEX_PREFIX = "history/_index/observations_timeseries"` | v1 observations index prefix |
| `R2_AQILEVELS_PREFIX = "history/v1/aqilevels/hourly"` | v1 AQI prefix |
| `UK_AQ_R2_HISTORY_OBSERVATIONS_TIMESERIES_INDEX_PREFIX` | unversioned env var, effectively v1 unless manually pointed elsewhere |
| `UK_AQ_R2_HISTORY_AQILEVELS_PREFIX` | unversioned env var, effectively v1 unless manually pointed elsewhere |

The cross-check manifest reader expects a connector/day manifest at:

```text
<r2_history_root>/<manifest_prefix>/day_utc=YYYY-MM-DD/connector_id=<id>/manifest.json
```

That is compatible with the current v1 index shape, but not with the stated v2 index shape because v2 adds `pollutant_code=<pollutant>` below `connector_id`.

### 3.2 AQI health v1 assumptions

`run_aqi_health_checks()` checks one connector/day manifest:

```text
<r2_history_root>/<aqilevels_prefix>/day_utc=YYYY-MM-DD/connector_id=<id>/manifest.json
```

This is v1-oriented. It does not understand v2 AQI data partitions:

```text
history/v2/aqilevels/hourly/data/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/part-00000.parquet
history/v2/aqilevels/hourly/debug/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/part-00000.parquet
```

### 3.3 AQI gap checker v1 assumptions

The AQI gap checker discovers v1 paths by composing `root/history/v1/<domain>/day_utc=...`.

It passes `domain="observations"` and `domain="aqilevels"`, so it looks for:

```text
history/v1/observations/day_utc=...
history/v1/aqilevels/day_utc=...
```

This does not match the v2 observation or AQI layouts.

### 3.4 Deploy workflow v1 assumptions

The prune daily Cloud Run deploy workflow still defaults to v1-oriented write/staging/run prefixes:

```text
UK_AQ_R2_HISTORY_STAGING_PREFIX = history/v1/_ops/observations/staging
UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX = history/v1/observations
UK_AQ_R2_HISTORY_RUNS_PREFIX = history/v1/_ops/observations/runs
```

Those values are then deployed as Cloud Run environment updates.

This supports the reported operational context: prune daily can have v2-capable code, while the workflow still deploys v1-oriented vars.

## 4. Existing v2 support, if any

### 4.1 Strong v2 support exists in the index builder

`workers/shared/uk_aq_r2_history_index.mjs` already defines both v1 and v2 defaults:

- v1:
  - `history/v1/observations`
  - `history/v1/aqilevels/hourly`
  - `history/_index/observations_timeseries`
  - `history/_index/aqilevels_timeseries`
- v2:
  - `history/v2/observations`
  - `history/v2/aqilevels/hourly/data`
  - `history/_index_v2/observations_timeseries`
  - `history/_index_v2/aqilevels_hourly_data_timeseries`

It also reads v2 env vars such as:

- `UK_AQ_R2_HISTORY_INDEX_V2_PREFIX`
- `UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX`
- `UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX`
- `UK_AQ_R2_HISTORY_V2_OBSERVATIONS_TIMESERIES_INDEX_PREFIX`
- `UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_TIMESERIES_INDEX_PREFIX`

Its v2 rebuild path calls `rebuildR2HistoryV2TimeseriesIndexes()` for observations and AQI hourly data, and the v2 result includes `history_version: "v2"`.

### 4.2 Integrity runner has little/no native v2 support

The integrity runner does not expose `--history-version`, has no `v1|v2|both` mode, and its R2 checks use only unversioned/v1-oriented env vars.

A user could manually point `UK_AQ_R2_HISTORY_OBSERVATIONS_TIMESERIES_INDEX_PREFIX` at `history/_index_v2/observations_timeseries`, but the checker still expects connector/day manifests without pollutant partitions, so that would not be sufficient for v2 correctness.

### 4.3 AQI gap checker has no v2 support

The AQI gap checker has no CLI/env history version selection and hard-codes `history/v1`.

## 5. Required v1/v2 path mapping

Add a central path config model. Proposed shape:

```python
@dataclass(frozen=True)
class HistoryPathConfig:
    history_version: Literal["v1", "v2"]
    observations_data_prefix: str
    aqilevels_hourly_data_prefix: str
    aqilevels_hourly_debug_prefix: str | None
    observations_timeseries_index_prefix: str
    aqilevels_timeseries_index_prefix: str
    observations_latest_index_key: str
    aqilevels_latest_index_key: str
    observations_partition_levels: tuple[str, ...]
    aqilevels_partition_levels: tuple[str, ...]
```

### v1 mapping

| Logical domain | Path |
| --- | --- |
| Observations data | `history/v1/observations` |
| AQI hourly data | `history/v1/aqilevels/hourly` |
| AQI debug | Not applicable / none |
| Observations timeseries index | `history/_index/observations_timeseries` |
| Observations latest index | `history/_index/observations_timeseries_latest.json` |
| AQI timeseries index | `history/_index/aqilevels_timeseries` |
| AQI latest index | `history/_index/aqilevels_timeseries_latest.json` |

### v2 mapping

| Logical domain | Path |
| --- | --- |
| Observations data | `history/v2/observations` |
| AQI hourly data | `history/v2/aqilevels/hourly/data` |
| AQI debug | `history/v2/aqilevels/hourly/debug` |
| Observations timeseries index | `history/_index_v2/observations_timeseries` |
| Observations latest index | `history/_index_v2/observations_timeseries_latest.json` |
| AQI hourly data timeseries index | `history/_index_v2/aqilevels_hourly_data_timeseries` |
| AQI hourly data latest index | `history/_index_v2/aqilevels_hourly_data_timeseries_latest.json` |

### v2 observations check paths

For each selected `day_utc`, connector, and pollutant:

```text
history/v2/observations/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json
history/v2/observations/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/part-00000.parquet
history/_index_v2/observations_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json
history/_index_v2/observations_timeseries_latest.json
```

### v2 AQI hourly data check paths

For each selected `day_utc`, connector, and pollutant:

```text
history/v2/aqilevels/hourly/data/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/part-00000.parquet
history/_index_v2/aqilevels_hourly_data_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json
history/_index_v2/aqilevels_hourly_data_timeseries_latest.json
```

### v2 AQI debug check paths

Debug should be optional and reported separately:

```text
history/v2/aqilevels/hourly/debug/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/part-00000.parquet
```

Recommended policy:

- Default: do not fail overall v2 AQI integrity solely because debug is missing.
- Add explicit flag/env:
  - `--include-aqi-debug`
  - `UK_AQ_R2_HISTORY_INTEGRITY_CHECK_AQI_DEBUG=true|false`
- Report debug coverage as `optional_debug_missing` unless explicitly required.

## 6. Recommended version-selection model

### 6.1 Support one version or both

Implement:

```text
--history-version v1
--history-version v2
--history-version both
```

and env fallback:

```text
UK_AQ_R2_HISTORY_INTEGRITY_VERSION=v1|v2|both
```

### 6.2 Default

Recommended default: `v1` initially, for backward compatibility.

However, every report must include:

```json
"history_version": "v1"
```

or, for both mode:

```json
"history_versions": ["v1", "v2"]
```

This preserves existing behavior while preventing ambiguity.

### 6.3 Avoid false health when v2 is missing

Rules:

1. A run for `--history-version v1` may only report v1 health.
2. A run for `--history-version v2` may only report v2 health.
3. A run for `--history-version both` should produce separate v1 and v2 sections and a comparison section.
4. Do not compute a single top-level “healthy” result by OR-ing v1 and v2 coverage.
5. If site read version is known from env/config, include it in the report as contextual metadata, but do not silently substitute that version.

Proposed top-level report:

```json
{
  "history_integrity_schema_version": 2,
  "history_version_mode": "both",
  "site_read_version": "v2",
  "version_results": {
    "v1": { "status": "ok" },
    "v2": { "status": "fail" }
  },
  "comparison": {
    "v1_present_v2_missing": []
  }
}
```

## 7. Recommended CLI/env interface

### 7.1 Main integrity runner

Current real command:

```text
scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh --env CIC-Test ...
```

The shell launcher forwards options to Python. Add to `uk-aq-history-integrity.sh` usage text and Python argparse:

```text
--history-version v1|v2|both
```

Environment fallback:

```text
UK_AQ_R2_HISTORY_INTEGRITY_VERSION=v1|v2|both
```

Future exact commands after implementation:

```bash
scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh \
  --env CIC-Test \
  --profile manual \
  --source all \
  --from-day 2026-06-11 \
  --to-day 2026-06-11 \
  --history-version v1 \
  --check-only
```

```bash
scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh \
  --env CIC-Test \
  --profile manual \
  --source all \
  --from-day 2026-06-11 \
  --to-day 2026-06-11 \
  --history-version v2 \
  --check-only
```

```bash
scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh \
  --env CIC-Test \
  --profile manual \
  --source all \
  --from-day 2026-06-11 \
  --to-day 2026-06-11 \
  --history-version both \
  --check-only
```

### 7.2 AQI gap checker

Current real command:

```text
scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py ...
```

Add:

```text
--history-version v1|v2
```

Do not add `both` here in phase 1 unless needed. This checker reads concrete parquet rows and computes AQI gaps; doing both in one run would complicate expected/actual row sets. Prefer one version per run first.

Future exact commands:

```bash
scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py \
  --env CIC-Test \
  --source r2-dropbox \
  --from-day 2026-06-11 \
  --to-day 2026-06-11 \
  --history-version v1
```

```bash
scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py \
  --env CIC-Test \
  --source r2-dropbox \
  --from-day 2026-06-11 \
  --to-day 2026-06-11 \
  --history-version v2
```

### 7.3 Prefix overrides

Support version-specific env overrides:

```text
UK_AQ_R2_HISTORY_INTEGRITY_V1_OBSERVATIONS_PREFIX
UK_AQ_R2_HISTORY_INTEGRITY_V1_AQILEVELS_HOURLY_PREFIX
UK_AQ_R2_HISTORY_INTEGRITY_V1_INDEX_PREFIX

UK_AQ_R2_HISTORY_INTEGRITY_V2_OBSERVATIONS_PREFIX
UK_AQ_R2_HISTORY_INTEGRITY_V2_AQILEVELS_HOURLY_DATA_PREFIX
UK_AQ_R2_HISTORY_INTEGRITY_V2_AQILEVELS_HOURLY_DEBUG_PREFIX
UK_AQ_R2_HISTORY_INTEGRITY_V2_INDEX_PREFIX
```

But prefer reusing existing shared env names where possible:

```text
UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX
UK_AQ_R2_HISTORY_AQILEVELS_PREFIX
UK_AQ_R2_HISTORY_INDEX_PREFIX
UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX
UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX
UK_AQ_R2_HISTORY_INDEX_V2_PREFIX
```

The index builder already uses these names.

## 8. Recommended report schema changes

### 8.1 Main summary report

Add fields:

```json
{
  "history_integrity_schema_version": 2,
  "history_version_mode": "v1|v2|both",
  "site_read_version": "v1|v2|null",
  "checked_versions": ["v1"],
  "version_results": {
    "v1": {
      "history_version": "v1",
      "paths": {
        "observations_prefix": "history/v1/observations",
        "aqilevels_hourly_data_prefix": "history/v1/aqilevels/hourly",
        "observations_timeseries_index_prefix": "history/_index/observations_timeseries",
        "aqilevels_timeseries_index_prefix": "history/_index/aqilevels_timeseries"
      },
      "observations": {},
      "aqilevels": {},
      "indexes": {}
    }
  }
}
```

### 8.2 Gap entries

Use consistent gap records:

```json
{
  "history_version": "v2",
  "domain": "observations",
  "severity": "error",
  "gap_type": "data_manifest_missing",
  "day_utc": "2026-06-11",
  "connector_id": 123,
  "pollutant_code": "no2",
  "expected_path": "history/v2/observations/day_utc=2026-06-11/connector_id=123/pollutant_code=no2/manifest.json",
  "related_paths": [
    "history/v2/observations/day_utc=2026-06-11/connector_id=123/pollutant_code=no2/part-00000.parquet"
  ],
  "source_evidence": {
    "v1_present": true,
    "source_counts_present": true,
    "db_dump_present": null
  },
  "suggested_repair": {
    "kind": "v1_to_v2_observations_backfill",
    "requires_index_rebuild": true,
    "commands": []
  }
}
```

### 8.3 Gap types

#### Data-level

- `day_dir_missing`
- `connector_dir_missing`
- `pollutant_dir_missing`
- `data_manifest_missing`
- `data_manifest_invalid_json`
- `data_manifest_schema_mismatch`
- `data_manifest_empty`
- `parquet_missing`
- `parquet_empty_or_placeholder`
- `parquet_unreadable`
- `row_count_mismatch`
- `pollutant_missing`

#### Index-level

- `index_day_dir_missing`
- `index_connector_dir_missing`
- `index_pollutant_dir_missing`
- `index_manifest_missing`
- `index_manifest_invalid_json`
- `index_manifest_missing_timeseries_counts`
- `index_manifest_empty_timeseries_counts`
- `latest_index_missing`
- `latest_index_invalid_json`
- `latest_index_stale_or_incomplete`

#### Comparison-level

- `v1_present_v2_missing`
- `v2_present_index_missing`
- `v1_v2_row_count_delta`
- `v1_only`
- `v2_only`

### 8.4 Markdown report changes

The Markdown report currently has an “R2 Cross-check” section with counts but no version field.

Add:

```text
## R2 Cross-check — history_version=v2

- History version: v2
- Observations prefix: history/v2/observations
- Observations index prefix: history/_index_v2/observations_timeseries
```

For `both` mode:

```text
## R2 Cross-check — v1
...

## R2 Cross-check — v2
...

## v1/v2 comparison
- v1 present, v2 missing: ...
```

## 9. Recommended implementation phases

### Phase 1: Version-aware path config and reporting only

Scope:

- Add central `HistoryPathConfig` / resolver.
- Add `--history-version v1|v2|both` to main integrity runner.
- Add env fallback `UK_AQ_R2_HISTORY_INTEGRITY_VERSION`.
- Preserve current v1 behavior as the default.
- Make reports include `history_version_mode`, `checked_versions`, and per-version paths.
- Do not change repair execution behavior yet.
- Do not change index builder behavior.

Expected result:

- Existing v1 runs behave the same.
- v2 mode can at least resolve and display correct paths.
- Both mode can run current v1 checks and mark v2 implementation as “not yet implemented” only if phase 1 intentionally stops short of full v2 checks.

### Phase 2: v2 observations integrity

Scope:

- Implement v2 observations coverage checks.
- Check data partitions by `day_utc`, `connector_id`, and `pollutant_code`.
- Check pollutant-level `manifest.json`.
- Check referenced parquet file(s).
- Check `_index_v2/observations_timeseries/.../pollutant_code=.../manifest.json`.
- Check `_index_v2/observations_timeseries_latest.json`.
- Add 2026-06-11-specific regression fixture/unit tests using temp directories.

Expected result:

- `--history-version v2 --from-day 2026-06-11 --to-day 2026-06-11` reports v2 observations/index gaps even if v1 exists.

### Phase 3: v2 AQI hourly data integrity

Scope:

- Implement v2 AQI hourly data checks.
- Check `history/v2/aqilevels/hourly/data`.
- Check `_index_v2/aqilevels_hourly_data_timeseries`.
- Check latest v2 AQI index summary.
- Add optional debug coverage checks.

Expected result:

- v2 AQI data/index gaps are distinguished from v2 observations gaps.
- AQI debug missing is reported as optional unless explicitly required.

### Phase 4: Repair planning

Scope:

- Generate repair plans only; keep execution separate/opt-in.
- Add suggested repair kind and commands.
- Do not execute repair commands unless an explicit future flag is added.

Repair decision matrix:

| Condition | Suggested repair |
| --- | --- |
| v1 data present, v2 data missing, v2 index missing | Generate v2 from v1/source, then rebuild `_index_v2` observations |
| v2 data present, v2 index missing | Rebuild `_index_v2` only |
| source data present, v1 and v2 missing | Run source-to-history backfill for target version(s), then rebuild index |
| v2 observations present, v2 AQI missing | Run AQI rebuild from v2 observations, then rebuild v2 AQI index |
| source only in R2 v1/Dropbox backup | Plan v1-to-v2 conversion/backfill and note Dropbox backup dependency |

### Phase 5: Optional comparison mode

Scope:

- Implement `--history-version both` fully.
- Compare v1 and v2 by day/connector/pollutant where possible.
- Report:
  - v1 present but v2 missing,
  - v2 present but index missing,
  - v1/v2 row count deltas,
  - v2 present but site latest index stale/missing.

Expected result:

- The 2026-06-11 incident is reported clearly:

```text
v1 present, v2 missing. Suggested repair: generate v2 observations from v1/source for 2026-06-11, then rebuild _index_v2 observations.
```

## 10. Specific file-by-file implementation plan

### 10.1 `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py`

#### Phase 1 changes

Add a version resolver near the existing R2 constants.

Add:

```python
HISTORY_VERSION_CHOICES = ("v1", "v2", "both")

DEFAULT_V1_PATHS = HistoryPathConfig(...)
DEFAULT_V2_PATHS = HistoryPathConfig(...)

def resolve_history_version_mode(args: argparse.Namespace) -> str:
    ...

def resolve_history_path_config(history_version: str, env: Mapping[str, str]) -> HistoryPathConfig:
    ...
```

Add argparse option:

```python
p.add_argument(
    "--history-version",
    choices=["v1", "v2", "both"],
    default=os.environ.get("UK_AQ_R2_HISTORY_INTEGRITY_VERSION", "v1"),
    help="R2 history layout version to check.",
)
```

Add report metadata:

```python
summary["history_version_mode"] = history_version_mode
summary["checked_versions"] = checked_versions
summary["history_path_configs"] = { ... }
```

#### Phase 2 changes

Refactor `run_r2_cross_checks()`.

Change to either:

```python
def run_r2_cross_checks(..., history_config: HistoryPathConfig, ...)
```

or wrap with:

```python
def run_r2_cross_checks_for_version(..., history_version: str, history_config: HistoryPathConfig, ...)
```

Implement v2 manifest reading:

- v1 reader:
  - existing `day_utc/connector_id/manifest.json`
- v2 reader:
  - enumerate pollutant dirs under `day_utc=.../connector_id=.../pollutant_code=*`
  - read each `manifest.json`
  - aggregate timeseries counts across pollutants if needed
  - record pollutant-specific gaps

Replace the current connector-level-only manifest reader with a dispatcher:

```python
def read_timeseries_manifest_counts(config, root, day_utc, connector_id):
    if config.history_version == "v1":
        return read_v1_connector_manifest_counts(...)
    return read_v2_pollutant_manifest_counts(...)
```

#### Phase 3 changes

Refactor `run_aqi_health_checks()`:

```python
def run_aqi_health_checks(..., history_config: HistoryPathConfig, ...)
```

For v1:

- Preserve existing manifest check.

For v2:

- Check `history/v2/aqilevels/hourly/data/day_utc=.../connector_id=.../pollutant_code=...`.
- Treat missing debug as optional unless configured.
- Check v2 AQI timeseries index manifests.

#### Phase 4 changes

Update planned repair command generation.

Add version-specific env in suggested commands only after confirming the backfill wrapper supports it:

```text
UK_AQ_R2_HISTORY_READ_VERSION=v2
UK_AQ_R2_HISTORY_WRITE_VERSION=v2
UK_AQ_BACKFILL_OUTPUT_SCOPE=...
```

Do not invent actual execution commands until the wrapper contract is verified.

### 10.2 `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh`

Add usage text for `--history-version`. The shell launcher forwards unrecognized args already, so implementation is mostly documentation.

Add env documentation:

```text
UK_AQ_R2_HISTORY_INTEGRITY_VERSION
  Optional default for --history-version: v1, v2, or both.
```

### 10.3 `scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py`

Add one-version-only support first:

```python
parser.add_argument(
    "--history-version",
    choices=["v1", "v2"],
    default=os.environ.get("UK_AQ_R2_HISTORY_INTEGRITY_VERSION", "v1"),
)
```

Refactor:

- `build_r2_day_manifest_days(root, warnings)` -> `build_r2_day_manifest_days(root, history_config, warnings)`
- `discover_r2_parquet_files(root, domain, days, warnings)` -> `discover_r2_parquet_files(root, history_config, domain, days, warnings)`
- `load_r2_rows(root, selected_days, warmup_days, bindings, warnings)` -> add `history_config`

For v2:

- Observations:
  - glob `history/v2/observations/day_utc=.../connector_id=*/pollutant_code=*/*.parquet`
- AQI:
  - glob `history/v2/aqilevels/hourly/data/day_utc=.../connector_id=*/pollutant_code=*/*.parquet`
- Use `hive_partitioning=true` in DuckDB where helpful.
- Confirm v2 parquet column names before assuming identical v1 column names.

### 10.4 `scripts/uk-aq-history-integrity/tests/test_aqi_gap_check_paths.py`

Add tests for:

- default history version is v1,
- v1 observations path resolution,
- v2 observations path resolution,
- v2 AQI data path resolution,
- v2 debug path optionality,
- report includes `history_version`.

### 10.5 Add new tests for main integrity path resolver

Recommended new file:

```text
scripts/uk-aq-history-integrity/tests/test_history_version_paths.py
```

Test cases:

- v1 default paths,
- v2 default paths,
- env overrides,
- invalid version,
- both mode expands to `['v1', 'v2']`,
- v2 latest index keys,
- 2026-06-11 fixture:
  - v1 path exists,
  - v2 path missing,
  - result includes `v1_present_v2_missing`.

### 10.6 `workers/shared/uk_aq_r2_history_index.mjs`

No immediate changes required for path constants. It already has v2 path defaults and v2 rebuild behavior.

Potential future change:

- Export/share a machine-readable path mapping if Node/Python duplication becomes a risk.
- Ensure generated v2 index manifests include fields needed by Python integrity without breaking byte-stability.

Important: preserve byte-stability requirements for index outputs per repo instructions.

### 10.7 `.github/workflows/uk_aq_prune_daily_cloud_run_deploy.yml`

Not part of integrity implementation phase 1 unless explicitly requested, but note it as operational follow-up.

Current workflow defaults are v1-oriented.

Potential future deployment change:

- Add `UK_AQ_R2_HISTORY_WRITE_VERSION`.
- Add v2 write prefixes.
- Make v1/v2 behavior explicit in deploy env.
- Do not change production/live defaults without explicit approval.

## 11. Validation plan

### 11.1 Static checks

After implementation:

```bash
python3 -m py_compile scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py
python3 -m py_compile scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py
python3 -m unittest discover -s scripts/uk-aq-history-integrity/tests
```

### 11.2 Existing behavior preservation

Run v1 with a targeted day and compare report shape/counts to pre-change expectations:

```bash
scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh \
  --env CIC-Test \
  --profile manual \
  --source all \
  --from-day 2026-06-11 \
  --to-day 2026-06-11 \
  --history-version v1 \
  --check-only
```

Expected:

- v1 paths shown in report.
- Existing v1 cross-check behavior preserved.
- No v2 gaps included in v1-only health.

### 11.3 v2 observations gap validation

```bash
scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh \
  --env CIC-Test \
  --profile manual \
  --source all \
  --from-day 2026-06-11 \
  --to-day 2026-06-11 \
  --history-version v2 \
  --check-only
```

Expected until v2 is backfilled:

- Report says `history_version=v2`.
- Missing `history/v2/observations/day_utc=2026-06-11/...` is reported.
- Missing `history/_index_v2/observations_timeseries/day_utc=2026-06-11/...` is reported.
- v1 presence does not make v2 healthy.

### 11.4 Both-mode comparison validation

```bash
scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh \
  --env CIC-Test \
  --profile manual \
  --source all \
  --from-day 2026-06-11 \
  --to-day 2026-06-11 \
  --history-version both \
  --check-only
```

Expected:

- Separate v1 and v2 sections.
- Comparison includes `v1_present_v2_missing`.
- Suggested repair says: generate v2 observations for 2026-06-11 from v1/source, then rebuild `_index_v2` observations.

### 11.5 AQI gap checker validation

```bash
scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py \
  --env CIC-Test \
  --source r2-dropbox \
  --from-day 2026-06-11 \
  --to-day 2026-06-11 \
  --history-version v1
```

```bash
scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py \
  --env CIC-Test \
  --source r2-dropbox \
  --from-day 2026-06-11 \
  --to-day 2026-06-11 \
  --history-version v2
```

Expected:

- v1 run reads v1 parquet paths.
- v2 run reads v2 parquet paths.
- Reports include `history_version`.
- v2 missing data does not silently fall back to v1.

### 11.6 Non-scanning behavior

For targeted day ranges, tests should assert the checker only touches paths under selected day partitions, not full bucket/tree scans.

## 12. Risks and rollback

### 12.1 Risks

- False confidence risk: If `both` mode collapses v1/v2 results, it can still hide v2 gaps. Avoid aggregate “healthy” unless all explicitly checked versions are healthy.
- Schema mismatch risk: v2 manifests are pollutant-partitioned; reusing the v1 manifest reader directly would miss or misreport v2 data.
- Performance/R2 cost risk: Avoid broad recursive scans. Use explicit day/connector/pollutant path checks when day ranges are supplied.
- Repair risk: Any automated repair could write to the wrong version unless write/read versions are explicit. Phase 4 should generate plans first, not execute.
- Index byte-stability risk: If changing index builder manifests later, ensure no wall-clock/run-scoped fields enter stable index payloads unless already part of the design.
- Debug optionality risk: Treating v2 AQI debug as mandatory could create noisy failures if debug is not intended to be complete.

### 12.2 Rollback

Phase 1 rollback is simple:

- Remove/ignore `--history-version`.
- Default remains v1.
- Existing v1 env vars and behavior remain intact.

For phases 2-5:

- Gate v2 checks behind `--history-version v2|both`.
- Keep default `v1` until v2 integrity is proven.
- Keep any repair planning non-executing by default.

## 13. Open questions before implementation

1. What exact schema do v2 observation pollutant manifests use? Do they include `timeseries_row_counts`, `source_row_count`, `total_rows`, and parquet object references?
2. Do v2 observations always write a `manifest.json` per `pollutant_code`, or can data exist with only parquet files?
3. Do v2 AQI hourly data partitions have manifests, or only parquet files plus `_index_v2` manifests?
4. Is `history/v2/aqilevels/hourly/debug` expected for every data partition, or only for diagnostics/failures?
5. Which runtime env var reflects the test site’s active read version: `UK_AQ_R2_HISTORY_READ_VERSION`, dashboard worker env, or another config?
6. Is there already a v1-to-v2 observations converter/backfill command, or should Phase 4 only suggest “run prune daily/backfill with v2 write vars”?
7. Should the main integrity runner’s default switch from `v1` to site read version after v2 stabilizes?
8. Does the integrity SQLite schema need persistent `history_version` columns on `cross_checks` and AQI queue tables, or is report-only enough in phase 1?
9. Should AQI rebuild queue rows include `history_version` to avoid queuing v1 repairs from a v2 integrity run?
10. Are there existing Dropbox backup layouts for v2 that mirror R2 exactly, or is local backup currently v1-only/incomplete?

## 14. Suggested Codex implementation prompt for phase 1

```text
You are working in Codex Cloud on /workspace/uk-aq-ops.

Use GPT-5.5 with high reasoning.

Implement Phase 1 only of UK AQ history integrity v1/v2 support.

Constraints:
- Do not deploy.
- Do not touch R2 or Supabase data.
- Preserve existing v1 behavior as the default.
- Do not implement v2 data scans yet beyond path resolution/reporting.
- Do not change live defaults.
- Do not add archive runtime fallbacks.
- Respect R2 history index byte-stability rules if touching index-related code.

Goal:
Make the integrity tooling explicitly history-version-aware at the configuration/reporting layer.

Required changes:
1. In scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py:
   - Add a central history version path resolver for v1 and v2.
   - Support --history-version v1|v2|both.
   - Support env fallback UK_AQ_R2_HISTORY_INTEGRITY_VERSION.
   - Keep default v1.
   - Add report fields:
     - history_integrity_schema_version
     - history_version_mode
     - checked_versions
     - history_path_configs
   - Include history version/path details in the Markdown report.
   - Ensure existing v1 cross-check calls still use the same v1 prefixes.
   - For v2/both, it is acceptable in phase 1 to report v2 path config and mark deep v2 checks as not yet implemented, but do not silently report v2 healthy.

2. In scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh:
   - Document --history-version in usage.
   - Document UK_AQ_R2_HISTORY_INTEGRITY_VERSION.

3. Add/extend tests under scripts/uk-aq-history-integrity/tests:
   - v1 path defaults.
   - v2 path defaults.
   - both mode expands to v1 and v2.
   - env fallback.
   - invalid history version rejects.
   - report metadata includes checked version(s).

Validation:
- Run:
  python3 -m py_compile scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py
  python3 -m unittest discover -s scripts/uk-aq-history-integrity/tests

Do not commit until tests pass.
```

## 15. Investigation commands used

```bash
pwd && find .. -name AGENTS.md -print
```

```bash
cat AGENTS.md && rg -n "history/v1|history/v2|history/_index|history/_index_v2|observations_timeseries|aqilevels_timeseries|aqilevels_hourly_data_timeseries|R2_OBSERVATIONS_TIMESERIES_INDEX_PREFIX|R2_AQILEVELS_PREFIX|UK_AQ_R2_HISTORY_READ_VERSION|UK_AQ_R2_HISTORY_WRITE_VERSION|UK_AQ_R2_HISTORY_BACKUP_VERSION|UK_AQ_R2_HISTORY_OBSERVATIONS_PREFIX|UK_AQ_R2_HISTORY_AQILEVELS_PREFIX|UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX|UK_AQ_R2_HISTORY_V2_AQILEVELS_HOURLY_DATA_PREFIX|UK_AQ_R2_HISTORY_INDEX_V2_PREFIX|integrity|gap" -S --glob '!node_modules/**' --glob '!archive/**' .
```

```bash
find . -path '*/node_modules' -prune -o -path './archive' -prune -o -iname '*integrity*' -print && find . -path '*/node_modules' -prune -o -path './archive' -prune -o -iname '*gap*' -print
```

```bash
sed -n '1,240p' scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py && sed -n '1,220p' scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py && sed -n '1,180p' scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh
```

```bash
rg -n "R2|DROPBOX|aqilevel|observations_timeseries|history/v1|history/v2|_index|parquet|manifest|from-day|argparse|add_argument|report" scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py scripts/uk-aq-history-integrity/tests/test_aqi_gap_check_paths.py scripts/aqi_gaps/check_r2_aqi_gaps.sh .github/workflows --glob '!node_modules/**'
```

```bash
rg -n "def run_r2_cross_checks|R2_AQILEVELS_PREFIX|R2_OBSERVATIONS|cross_checks" scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py | head -80 && sed -n '4800,5380p' scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py
```

```bash
nl -ba scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py | sed -n '4680,4785p;5688,5715p;6336,6392p;8016,8053p;7638,7665p' && nl -ba scripts/uk-aq-history-integrity/bin/uk-aq-aqi-gap-check.py | sed -n '1009,1145p;1537,1552p;1610,1622p;1688,1705p' && nl -ba scripts/aqi_gaps/check_r2_aqi_gaps.sh | sed -n '1,20p;78,88p;112,118p;212,228p' && nl -ba workers/shared/uk_aq_r2_history_index.mjs | sed -n '123,136p;295,336p;3440,3483p' && nl -ba .github/workflows/uk_aq_prune_daily_cloud_run_deploy.yml | sed -n '60,70p;313,323p'
```
