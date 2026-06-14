# UK AQ R2 History v2 Pollutant Split Plan and Codex Prompts

Status: planning  
Target first environment: CIC-Test  
Repeatable target environment: LIVE after CIC-Test soak testing  
Created: 2026-06-13  
Purpose: design and implement a faster, more efficient R2 history layout for observations and AQI levels while keeping rollback simple.

## 1. Background

The AQI levels v1 hard rebuild fixed an important correctness problem in the AQI bands pipeline. The old hybrid AQI shape mixed wide pollutant-specific fields with a more normalised row model. The v1 refactor moved AQI levels to a cleaner hourly contract with one row per connector, station, timeseries, pollutant and UTC hour.

That improved correctness, but it made the browser-facing AQI history path heavier. CIC-Test 90-day chart loads began returning Cloudflare Worker 1102 errors from the AQI history R2 API Worker.

The logs showed:

```text
/api/aq/aqi-history -> 503
Cloudflare Error 1102
Worker exceeded resource limits
Worker: uk-aq-aqi-history-r2-api.cic-test.workers.dev
```

The key diagnosis was:

- The old LIVE hybrid AQI file for a sample connector/day was much smaller.
- The new CIC-Test hourly AQI file has similar row count but many more columns and a much larger parquet payload.
- The current AQI index can locate the connector/day file, but the file still contains hundreds of timeseries and all pollutants.
- The Worker still has to decode a broad parquet object to extract one timeseries/pollutant.
- 24-hour charts usually work because they use recent ObsAQIDB retention.
- 90-day charts fail when older chunks require R2 historical AQI parquet.
- Observation history is much lighter, but future pollutants will make the current observations layout less efficient over time.

This plan creates R2 history v2 alongside v1 rather than hard-migrating v1 again.

## 2. Goals

1. Keep the public website/API path fast.
2. Keep AQI correctness and diagnostic capability.
3. Avoid Cloudflare Worker resource limit failures.
4. Split history files by pollutant so chart requests do not read irrelevant pollutants.
5. Keep v1 untouched during v2 build and soak testing.
6. Allow fast rollback by switching the Worker/read version back to v1.
7. Make LIVE rollout safer by building v2 alongside v1 before switching.
8. Keep the design simple enough to implement and maintain.
9. Avoid adding precomputed JSON or timeseries buckets in the first v2 pass unless testing proves they are needed.

## 3. Non-goals for first v2 implementation

1. Do not delete v1 during initial v2 build.
2. Do not add timeseries buckets in the first pass.
3. Do not add precomputed AQI band JSON in the first pass.
4. Do not add debug indexes unless a real use case appears.
5. Do not make observations look hourly if the source observations are not necessarily hourly.
6. Do not reintroduce old wide pollutant-specific AQI fields into the website path.
7. Do not require a website code rollback for v2 rollback if the Worker response contract can stay stable.

## 4. Decided v2 layout

### 4.1 Observations v2

Observations should remain close to the current layout, but with pollutant partitioning.

Use:

```text
history/v2/observations/day_utc=YYYY-MM-DD/manifest.json
history/v2/observations/day_utc=YYYY-MM-DD/connector_id=<id>/manifest.json
history/v2/observations/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json
history/v2/observations/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/part-00000.parquet
```

Do not use:

```text
history/v2/observations/hourly/data/...
```

Reason:

- Observations are raw or near-raw observations and are not necessarily hourly.
- Some networks, such as Sensor.Community, can be more granular.
- Daily/monthly future outputs are only expected for AQI bands, not raw observations.
- This should be “same as now, plus pollutant”.

### 4.2 Observation v2 parquet columns

Recommended minimal columns:

```text
connector_id
station_id
timeseries_id
pollutant_code
observed_at_utc
value
```

`pollutant_code` remains in the parquet row even though it is also in the path.

Reasons:

- The file remains self-describing if copied outside its R2 path.
- DuckDB validation remains simple.
- The Worker can assert the row pollutant matches the requested pollutant and path.
- The API response can include pollutant identity without deriving it only from the path.
- Parquet compression should make the repeated pollutant value cheap.

Optional fields may be kept only if current observations really need them. Avoid turning observations v2 into a wide debug format.

### 4.3 AQI levels v2

AQI levels should be split by grain and purpose.

Use:

```text
history/v2/aqilevels/hourly/data/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json
history/v2/aqilevels/hourly/data/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/part-00000.parquet
history/v2/aqilevels/hourly/debug/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json
history/v2/aqilevels/hourly/debug/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/part-00000.parquet
```

Also include appropriate day and connector manifests, for example:

```text
history/v2/aqilevels/hourly/data/day_utc=YYYY-MM-DD/manifest.json
history/v2/aqilevels/hourly/data/day_utc=YYYY-MM-DD/connector_id=<id>/manifest.json
history/v2/aqilevels/hourly/debug/day_utc=YYYY-MM-DD/manifest.json
history/v2/aqilevels/hourly/debug/day_utc=YYYY-MM-DD/connector_id=<id>/manifest.json
```

Reserved future layout:

```text
history/v2/aqilevels/daily/data/...
history/v2/aqilevels/monthly/data/...
history/v2/aqilevels/daily/debug/...
history/v2/aqilevels/monthly/debug/...
```

### 4.4 AQI hourly data parquet columns

The Cloudflare Worker and website should use the compact data parquet.

Recommended columns:

```text
connector_id
station_id
timeseries_id
pollutant_code
timestamp_hour_utc
daqi_index_level
eaqi_index_level
daqi_calculation_status
daqi_missing_reason
eaqi_calculation_status
eaqi_missing_reason
```

Status/reason remain in the data parquet because the website and debug logs need to distinguish:

```text
missing row
```

from:

```text
row exists, but DAQI or EAQI is null for an explicit reason
```

### 4.5 AQI hourly debug parquet columns

The debug parquet should preserve the diagnostic value of the AQI refactor, but should not carry old compatibility fields unless they are still genuinely useful.

Candidate debug fields:

```text
connector_id
station_id
timeseries_id
pollutant_code
timestamp_hour_utc

daqi_input_value_ugm3
daqi_input_averaging_code
daqi_index_level
daqi_source_observation_count
daqi_required_observation_count
daqi_calculation_status
daqi_missing_reason

eaqi_input_value_ugm3
eaqi_input_averaging_code
eaqi_index_level
eaqi_source_observation_count
eaqi_required_observation_count
eaqi_calculation_status
eaqi_missing_reason

hourly_sample_count
algorithm_version
computed_at_utc
```

Compatibility mean/index fields should be removed from v2 debug unless Codex proves they are still useful for validation or migration.

### 4.6 DAQI and EAQI rules to preserve

The v2 design must preserve the AQI v1 calculation rules:

```text
PM2.5 DAQI: rolling_24h_mean
PM10 DAQI: rolling_24h_mean
NO2 DAQI: hourly_mean

PM2.5 EAQI: hourly_mean
PM10 EAQI: hourly_mean
NO2 EAQI: hourly_mean
```

## 5. Index v2

Use a separate index namespace:

```text
history/_index_v2/...
```

### 5.1 Observation v2 index

Use data indexes only.

```text
history/_index_v2/observations_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json
```

The observation index should help locate files for:

```text
day + connector + pollutant + timeseries_id
```

### 5.2 AQI levels v2 data index

Use data indexes only.

```text
history/_index_v2/aqilevels_hourly_data_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json
```

The AQI Worker should read the v2 data index, not the v1 index, when v2 read mode is enabled.

### 5.3 No debug indexes

Do not build debug indexes in the first pass.

Reason:

- The public Worker should not read debug parquet.
- Debug and audit tooling can use local DuckDB scans or direct R2 inspection.
- Avoid extra object count and maintenance until needed.

## 6. Timeseries buckets

Do not implement timeseries buckets in the first v2 pass.

Reason:

- Pollutant splitting plus data/debug split should reduce AQI Worker cost substantially.
- Timeseries buckets add more files, more manifests, more index complexity and more upload/backup objects.
- They can be added later if v2 pollutant-split files are still too large.

The path design should not prevent a future bucket layer, for example:

```text
history/v2/aqilevels/hourly/data/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=pm25/timeseries_bucket=0000-0499/part-00000.parquet
```

But do not implement this now.

## 7. Precomputed AQI band JSON

Do not implement precomputed chart AQI band JSON in the first v2 pass.

Reason:

- It may be the fastest public path, but it adds derived artefacts and invalidation complexity.
- Compact, pollutant-split AQI data parquet should be tested first.
- If the v2 Worker still struggles, precomputed JSON can be considered as a separate optimisation.

## 8. Read/write switching

Use explicit environment variables.

Recommended names:

```text
UK_AQ_R2_HISTORY_READ_VERSION=v1|v2
UK_AQ_R2_HISTORY_WRITE_VERSION=v1|v2
```

### 8.1 Read switch

Applies to website-facing APIs and Cloudflare Workers.

- `v1`: read current v1 layout.
- `v2`: read v2 layout.

The Worker response shape should remain stable so the website does not need to know which R2 version is being read.

### 8.2 Write switch

Applies to jobs that write R2 history, especially prune daily.

- `v1`: write current v1 layout.
- `v2`: write v2 layout.

Initial preference: do not add `both` mode unless Codex finds a strong operational reason.

Rationale:

- Historical v2 rebuild can populate v2 separately.
- Prune daily should switch to v2 only when v2 is proven.
- Writing both in the scheduled job increases risk and complexity.

## 9. Prune daily behaviour

`uk_aq_prune_daily` should write either v1 or v2 based on:

```text
UK_AQ_R2_HISTORY_WRITE_VERSION
```

When `v2`, it should write:

```text
history/v2/observations/...
history/v2/aqilevels/hourly/data/...
history/v2/aqilevels/hourly/debug/...
history/_index_v2/... if the writer currently owns index update, or leave index rebuild to the index builder if that is the existing pattern
```

When `v1`, it should continue current behaviour unchanged.

## 10. Migration approach

### 10.1 CIC-Test first

1. Implement v2 writer support.
2. Build historical v2 in CIC-Test alongside v1.
3. Build index v2.
4. Add AQI history Worker support for read switch.
5. Add observations Worker/history support for read switch if needed.
6. Keep website response contract unchanged.
7. Set CIC-Test Worker read version to v2.
8. Test 24h, 7d, 31d and 90d chart loads.
9. Compare v1 and v2 responses for selected sensors.
10. Soak test.
11. Switch prune daily to write v2.
12. Keep v1 data available for rollback.
13. Delete v1 only after explicit decision.

### 10.2 LIVE later

1. Build LIVE v2 alongside LIVE v1.
2. Build LIVE index v2.
3. Deploy Worker code that supports read switch but leave LIVE reading v1.
4. Validate v2 via manual endpoint/tests.
5. Switch LIVE read version to v2.
6. Soak test.
7. Switch LIVE write version to v2.
8. Keep v1 for rollback.
9. Remove v1 later after successful soak period.

## 11. Rollback

Rollback should be possible by setting:

```text
UK_AQ_R2_HISTORY_READ_VERSION=v1
```

If prune daily has already switched to v2 writes, decide whether to switch:

```text
UK_AQ_R2_HISTORY_WRITE_VERSION=v1
```

or keep v2 writing while investigating read issues.

The website should not require rollback if the Worker response shape remains stable.

## 12. Validation targets

### 12.1 Performance

For known failing 90-day AQI history cases, confirm:

```text
no Cloudflare Error 1102
no 503 from /api/aq/aqi-history
no Cloudflare HTML response body
response_complete true where expected
structured partial JSON where incomplete
```

Known test cases:

```text
timeseries_id=354, station_id=1575, pollutant=pm25
timeseries_id=327, station_id=661, pollutant=pm25
timeseries_id=396, station_id=7609, pollutant=pm25
```

Test windows:

```text
2026-04-10 -> 2026-04-17
2026-04-17 -> 2026-04-24
2026-04-24 -> 2026-05-01
2026-05-01 -> 2026-05-08
```

### 12.2 Accuracy

Compare v1 and v2 for selected sensors/days:

```text
row count
first/last timestamp
DAQI levels
EAQI levels
null counts
missing reason counts
```

Differences must be explained.

### 12.3 Size

Compare v1 and v2 object sizes:

```text
observations v1 connector/day file size
observations v2 connector/day/pollutant file sizes
aqilevels v1 connector/day file size
aqilevels v2 hourly/data connector/day/pollutant file sizes
aqilevels v2 hourly/debug connector/day/pollutant file sizes
```

### 12.4 Worker metrics

Ensure debug coverage can report:

```text
R2 object reads
R2 list operations
parquet bytes read
parquet row groups scanned
parquet chunks decoded
matched rows
duration
index hit/miss
read version
path/version used
```

### 12.5 R2 costs

Track:

```text
object count
storage size
Class A operations during rebuild/index/backup
Class B operations during chart use
```

R2 storage is currently low enough that v2 alongside v1 is acceptable, but Class A/B operations still need watching.

## 13. Open decisions for Codex to confirm

1. Exact current v1 writer paths and code ownership.
2. Whether the v2 historical rebuild should be implemented in the local backfill worker, prune daily, or a dedicated rebuild script.
3. Whether observation v2 should keep exactly six columns or preserve any existing fields.
4. Whether AQI debug v2 needs old compatibility fields.
5. Whether the AQI data parquet should include both status and missing reason, or missing reason only.
6. Exact manifest schema for v2 day/connector/pollutant levels.
7. Exact index v2 manifest schema.
8. Whether index v2 should be built by the existing index builder with domain/grain/profile options or by a new script.
9. Whether the API Worker can share v1/v2 read code cleanly or should have a dedicated v2 path.
10. Whether the website needs any changes if Worker response contract stays stable.
11. Whether prune daily should support `both` write mode or only `v1|v2`.
12. Whether there are any old caches or band caches that must be disabled for v2.

## 14. Suggested implementation phases

### Phase 0: investigation and final design

No code changes except a plan file if requested.

Outputs:

- Confirm v2 path layout.
- Confirm v2 parquet schemas.
- Confirm v2 manifest schemas.
- Confirm v2 index schemas.
- Confirm all files likely to change.
- Produce final implementation sequence.

### Phase 1: v2 writer and local rebuild support

Implement v2 writes but do not switch live/scheduled writes.

Outputs:

- Historical rebuild can write v2 observations.
- Historical rebuild can write v2 AQI hourly data and debug.
- Manifests are written.
- No v1 behaviour changes unless env var explicitly asks for v2.

### Phase 2: index v2 support

Implement `_index_v2`.

Outputs:

- Build observations v2 timeseries indexes.
- Build AQI hourly data v2 timeseries indexes.
- No debug indexes.
- Validation reports.

### Phase 3: API Worker read switch

Implement read version support.

Outputs:

- AQI history Worker can read v1 or v2 based on env var.
- Observations/history Worker can read v1 or v2 if applicable.
- Response contract remains stable.
- Worker logs include read version and v2 path info.

### Phase 4: website and debug validation

Update website only if necessary.

Outputs:

- Website can request chart data without knowing v1/v2.
- Debug logs include R2 history read version.
- 90-day AQI bands no longer 1102 in CIC-Test.

### Phase 5: prune daily write switch

Update prune daily to write v2 when env var is set.

Outputs:

- Scheduled daily history writes can switch from v1 to v2.
- Validation confirms new days continue under v2.
- v1 remains for rollback.

### Phase 6: CIC-Test soak and LIVE rollout plan

Outputs:

- CIC-Test soak test checklist.
- LIVE build-alongside-v1 runbook.
- LIVE switch checklist.
- v1 removal plan for later.

---

# Codex Prompts

## Prompt 1: Read-only investigation and final design confirmation

```text
Codex Cloud prompt:

Please do a read-only investigation for the UK AQ R2 history v2 design. Do not edit files, do not create files, do not run formatters, and do not commit anything.

Goal:
Confirm the best implementation design for R2 history v2.

Background:
The AQI levels v1 refactor fixed AQI band correctness but made the AQI history Worker too heavy for 90-day chart loads. Cloudflare Worker 1102 errors occur when `/api/aq/aqi-history` reads older historical AQI parquet. Current v1 AQI parquet is broad by connector/day and contains all pollutants and hundreds of timeseries. The new AQI rows are much wider than the old hybrid rows.

The chosen high-level direction is:
- Build R2 history v2 alongside v1.
- Keep v1 untouched for rollback during v2 testing.
- Split observations by pollutant.
- Split AQI levels by pollutant.
- Split AQI levels into compact `data` parquet and richer `debug` parquet.
- Use `_index_v2`.
- Do not add timeseries buckets in first pass.
- Do not add precomputed AQI band JSON in first pass.
- Do not add debug indexes in first pass.
- Use env vars to switch read/write version:
  - `UK_AQ_R2_HISTORY_READ_VERSION=v1|v2`
  - `UK_AQ_R2_HISTORY_WRITE_VERSION=v1|v2`

Decided v2 observations layout:
`history/v2/observations/day_utc=YYYY-MM-DD/manifest.json`
`history/v2/observations/day_utc=YYYY-MM-DD/connector_id=<id>/manifest.json`
`history/v2/observations/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json`
`history/v2/observations/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/part-00000.parquet`

Observation v2 parquet should include:
- connector_id
- station_id
- timeseries_id
- pollutant_code
- observed_at_utc
- value

Decided v2 AQI levels layout:
`history/v2/aqilevels/hourly/data/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json`
`history/v2/aqilevels/hourly/data/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/part-00000.parquet`
`history/v2/aqilevels/hourly/debug/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json`
`history/v2/aqilevels/hourly/debug/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/part-00000.parquet`

AQI hourly data parquet should include:
- connector_id
- station_id
- timeseries_id
- pollutant_code
- timestamp_hour_utc
- daqi_index_level
- eaqi_index_level
- daqi_calculation_status
- daqi_missing_reason
- eaqi_calculation_status
- eaqi_missing_reason

AQI hourly debug parquet should include the richer diagnostic calculation fields, but old compatibility fields should only be kept if they are still genuinely useful.

Index v2:
`history/_index_v2/observations_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json`
`history/_index_v2/aqilevels_hourly_data_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json`

No debug indexes.

Please inspect:
- current v1 R2 writer code
- local rebuild/backfill writer code
- AQI history R2 API Worker
- observations history API path
- index builder
- backup inventory and Dropbox sync scripts
- current tests
- relevant system docs
- recent archive files if useful

Please report:
1. Files that likely need changing.
2. Whether the proposed paths fit the current code structure.
3. Whether observations v2 needs any columns beyond the six listed.
4. Whether AQI debug v2 needs old compatibility fields.
5. Exact v2 manifest schema recommendation.
6. Exact v2 index schema recommendation.
7. Whether read/write env vars should have different names.
8. Whether prune daily should support only `v1|v2` or also `both`.
9. Any hidden risks in backup inventory, Dropbox sync, integrity checks or Worker caches.
10. A recommended implementation order.
11. Tests to add or update.
12. Any unresolved decisions that should be made before implementation.

Do not make changes. Report only.
```

## Prompt 2: Create or update the plan/docs only

```text
Codex Cloud prompt:

Please create/update the project plan document for R2 history v2 pollutant splitting. This is a documentation-only task. Do not change runtime code.

Before changing anything:
1. Archive any plan/docs files you will edit into:
   `archive/YYYY-MM-DD-r2-history-v2-pollutant-split/`
2. Do not archive generated dependency/build/cache files.

Plan title:
`UK AQ R2 History v2 Pollutant Split Plan`

The plan must cover:
- Why v2 is needed.
- Why v1 should remain untouched during v2 build and soak testing.
- Observations v2 path layout.
- AQI levels v2 path layout.
- AQI data/debug split.
- Observation v2 parquet schema.
- AQI hourly data parquet schema.
- AQI hourly debug parquet schema.
- `_index_v2` layout.
- No debug indexes.
- No timeseries buckets in first pass.
- No precomputed AQI band JSON in first pass.
- `UK_AQ_R2_HISTORY_READ_VERSION=v1|v2`.
- `UK_AQ_R2_HISTORY_WRITE_VERSION=v1|v2`.
- Prune daily writes either v1 or v2 based on write version.
- API Workers read either v1 or v2 based on read version.
- CIC-Test build-alongside-v1 sequence.
- LIVE build-alongside-v1 sequence.
- Rollback approach.
- Validation plan.
- Future options:
  - timeseries buckets
  - precomputed AQI band JSON
  - v2-only code cleanup
  - removing v1 data after soak

Use these decided layouts.

Observations v2:
`history/v2/observations/day_utc=YYYY-MM-DD/manifest.json`
`history/v2/observations/day_utc=YYYY-MM-DD/connector_id=<id>/manifest.json`
`history/v2/observations/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json`
`history/v2/observations/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/part-00000.parquet`

AQI v2:
`history/v2/aqilevels/hourly/data/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json`
`history/v2/aqilevels/hourly/data/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/part-00000.parquet`
`history/v2/aqilevels/hourly/debug/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json`
`history/v2/aqilevels/hourly/debug/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/part-00000.parquet`

Index v2:
`history/_index_v2/observations_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json`
`history/_index_v2/aqilevels_hourly_data_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json`

Please include a section listing future v2-only cleanup work, but do not implement it now.
```

## Prompt 3: Implement v2 writer and local rebuild support

```text
Codex Cloud prompt:

Please implement R2 history v2 writer support for CIC-Test, but do not switch scheduled writes to v2 by default.

Before changing anything:
1. Archive every file that will be changed into:
   `archive/YYYY-MM-DD-r2-history-v2-pollutant-split/`
2. Preserve relative paths inside the archive where practical.
3. Do not archive generated dependency/build/cache files.

Goal:
Add support for writing R2 history v2 alongside v1.

Required env var:
`UK_AQ_R2_HISTORY_WRITE_VERSION=v1|v2`
Default must be `v1`.

When write version is `v1`, current behaviour must remain unchanged.

When write version is `v2`, write:

Observations:
`history/v2/observations/day_utc=YYYY-MM-DD/manifest.json`
`history/v2/observations/day_utc=YYYY-MM-DD/connector_id=<id>/manifest.json`
`history/v2/observations/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json`
`history/v2/observations/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/part-00000.parquet`

Observation v2 parquet columns:
- connector_id
- station_id
- timeseries_id
- pollutant_code
- observed_at_utc
- value

AQI levels:
`history/v2/aqilevels/hourly/data/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json`
`history/v2/aqilevels/hourly/data/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/part-00000.parquet`
`history/v2/aqilevels/hourly/debug/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json`
`history/v2/aqilevels/hourly/debug/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/part-00000.parquet`

AQI data parquet columns:
- connector_id
- station_id
- timeseries_id
- pollutant_code
- timestamp_hour_utc
- daqi_index_level
- eaqi_index_level
- daqi_calculation_status
- daqi_missing_reason
- eaqi_calculation_status
- eaqi_missing_reason

AQI debug parquet columns:
- connector_id
- station_id
- timeseries_id
- pollutant_code
- timestamp_hour_utc
- daqi_input_value_ugm3
- daqi_input_averaging_code
- daqi_index_level
- daqi_source_observation_count
- daqi_required_observation_count
- daqi_calculation_status
- daqi_missing_reason
- eaqi_input_value_ugm3
- eaqi_input_averaging_code
- eaqi_index_level
- eaqi_source_observation_count
- eaqi_required_observation_count
- eaqi_calculation_status
- eaqi_missing_reason
- hourly_sample_count
- algorithm_version
- computed_at_utc

Do not keep old compatibility fields unless they are still genuinely required. If they are kept, explain exactly why.

Likely files:
- `workers/uk_aq_prune_daily/phase_b_history_r2.mjs`
- `workers/uk_aq_backfill_local/run_job.ts`
- scripts under `scripts/AQI-levels-refactor-June-2026/`
- tests for phase B/history writing
- system docs if needed

Implementation requirements:
1. Keep v1 writes unchanged by default.
2. Add v2 path builders.
3. Add v2 manifest writers.
4. Add v2 observations pollutant partitioning.
5. Add v2 AQI data/debug partitioning.
6. Ensure manifests include:
   - schema version/name
   - history version
   - domain
   - grain where relevant
   - purpose/profile for AQI data/debug
   - connector id
   - pollutant code
   - row counts
   - file sizes
   - min/max timeseries id
   - min/max timestamp
   - source row count
7. Add tests or update existing tests.
8. Add validation commands to docs or test output.

Do not switch any production/CIC-Test env vars in code. Only add support.

Please summarise:
- files changed
- archive location
- v1 compatibility behaviour
- v2 paths written
- schemas emitted
- tests run
- manual validation commands
```

## Prompt 4: Implement index v2 support

```text
Codex Cloud prompt:

Please implement `_index_v2` support for R2 history v2. Do not switch runtime readers yet.

Before changing anything:
1. Archive every file that will be changed into:
   `archive/YYYY-MM-DD-r2-history-v2-index/`
2. Preserve relative paths where practical.

Goal:
Add v2 index support for pollutant-partitioned observations and AQI hourly data.

Do not create debug indexes.

Required index paths:

Observations:
`history/_index_v2/observations_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json`

AQI hourly data:
`history/_index_v2/aqilevels_hourly_data_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json`

The index must help the Worker select by:
- day
- connector
- pollutant
- timeseries id

Expected manifest fields:
- schema_version
- generated_at
- source
- history_version = `v2`
- domain
- index_kind
- bucket
- day_utc
- connector_id
- pollutant_code
- data_prefix
- connector/pollutant manifest key
- source row count
- file count
- indexed file count
- index coverage
- min_timeseries_id
- max_timeseries_id
- min/max timestamp
- files[] with:
  - key
  - row_count
  - bytes
  - etag_or_hash
  - pollutant_code
  - min_timeseries_id
  - max_timeseries_id
  - min/max timestamp

Likely files:
- `workers/shared/uk_aq_r2_history_index.mjs`
- `scripts/backup_r2/uk_aq_build_r2_history_index.mjs`
- backup inventory scripts if they need to discover `_index_v2`
- tests for index builder

Requirements:
1. Keep v1 index building unchanged.
2. Add v2 index building behind explicit options/env vars.
3. Build only data indexes, not debug indexes.
4. Support observations v2 and aqilevels hourly data v2.
5. Make it possible to run:
   - build observations v2 index only
   - build aqilevels v2 data index only
6. Add tests.
7. Add clear validation output.

Do not switch runtime readers yet.

Please summarise:
- files changed
- archive location
- exact commands to build v2 indexes for CIC-Test
- tests run
- example index manifest shape
```

## Prompt 5: Implement AQI history Worker v2 read switch

```text
Codex Cloud prompt:

Please add v2 read support to the AQI history R2 API Worker. Keep v1 as the default.

Before changing anything:
1. Archive every file that will be changed into:
   `archive/YYYY-MM-DD-r2-history-v2-aqi-worker/`
2. Preserve relative paths where practical.

Goal:
Allow `/api/aq/aqi-history` to read either v1 or v2 based on:

`UK_AQ_R2_HISTORY_READ_VERSION=v1|v2`

Default must be `v1`.

When `v1`, current behaviour must remain unchanged.

When `v2`, the Worker should read compact AQI data parquet from:

`history/v2/aqilevels/hourly/data/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/part-00000.parquet`

and index from:

`history/_index_v2/aqilevels_hourly_data_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json`

Do not read AQI debug parquet in the website/API path.

The Worker response contract to the website should stay stable. The website should not need to know whether v1 or v2 was used.

Required v2 data fields:
- connector_id
- station_id
- timeseries_id
- pollutant_code
- timestamp_hour_utc
- daqi_index_level
- eaqi_index_level
- daqi_calculation_status
- daqi_missing_reason
- eaqi_calculation_status
- eaqi_missing_reason

Requirements:
1. Add read version parsing and logging.
2. Add v2 path builders.
3. Add v2 index reader.
4. Add v2 data parquet reader.
5. Keep v1 path intact.
6. Do not read debug parquet.
7. Add coverage metadata showing:
   - read_version
   - index_version
   - data_profile
   - pollutant partition used
   - R2 object reads
   - parquet bytes read
   - row groups/chunks decoded
   - matched rows
8. If v2 data/index is missing, return structured JSON with partial reasons where possible, not Cloudflare HTML.
9. Keep safety limits.
10. Add tests or worker-local test scripts for known failing windows.

Known failing CIC-Test cases to validate:
- timeseries_id=354, station_id=1575, pollutant=pm25, 2026-04-10 -> 2026-04-17
- timeseries_id=327, station_id=661, pollutant=pm25, 2026-04-10 -> 2026-04-17
- timeseries_id=396, station_id=7609, pollutant=pm25, 2026-04-10 -> 2026-04-17

Please summarise:
- files changed
- archive location
- how to enable v2 read mode
- how to rollback to v1
- tests run
- manual curl commands for v1 and v2 comparison
```

## Prompt 6: Implement observations history Worker/read v2 support if applicable

```text
Codex Cloud prompt:

Please investigate and, if required, add v2 read support for the observations history API path. Keep v1 default.

Before changing anything:
1. Archive every file that will be changed into:
   `archive/YYYY-MM-DD-r2-history-v2-observations-read/`

Goal:
Make observation history reads support the v2 pollutant-partitioned layout.

Read switch:
`UK_AQ_R2_HISTORY_READ_VERSION=v1|v2`

Default must be `v1`.

Observations v2 layout:
`history/v2/observations/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/part-00000.parquet`

Index v2:
`history/_index_v2/observations_timeseries/day_utc=YYYY-MM-DD/connector_id=<id>/pollutant_code=<pollutant>/manifest.json`

Observation v2 parquet fields:
- connector_id
- station_id
- timeseries_id
- pollutant_code
- observed_at_utc
- value

Requirements:
1. First identify which Worker/API serves historical observations for the chart.
2. If it already shares code with AQI history, update shared read-version handling carefully.
3. Keep v1 behaviour unchanged by default.
4. In v2 mode, read only the pollutant partition requested.
5. Keep the website response contract stable.
6. Add coverage metadata:
   - read_version
   - index_version
   - pollutant partition
   - R2 object reads
   - parquet bytes read
   - matched rows
7. Add tests.

Please summarise:
- whether observations read support needed code changes
- files changed
- archive location
- how to enable v2
- tests run
```

## Prompt 7: Update backup inventory and Dropbox sync for v2

```text
Codex Cloud prompt:

Please add backup inventory and Dropbox sync support for R2 history v2. Keep v1 behaviour unchanged by default.

Before changing anything:
1. Archive every file that will be changed into:
   `archive/YYYY-MM-DD-r2-history-v2-backup/`

Goal:
Ensure v2 objects can be inventoried and synced to Dropbox safely.

V2 paths:
- `history/v2/observations/**`
- `history/v2/aqilevels/hourly/data/**`
- `history/v2/aqilevels/hourly/debug/**`
- `history/_index_v2/**`

Requirements:
1. Keep v1 backup behaviour unchanged.
2. Add explicit domain/version options so v2 backup can be run separately.
3. Inventory v2 observations.
4. Inventory v2 AQI hourly data.
5. Inventory v2 AQI hourly debug.
6. Inventory `_index_v2`.
7. Make sure Dropbox sync does not delete or overwrite v1.
8. Add reports showing v1 vs v2 object counts and bytes.
9. Add tests.

Please provide commands to:
- build CIC-Test v2 inventory
- sync CIC-Test v2 to Dropbox
- verify v2 active backup exists
- verify v1 still exists
- report total v2 storage size

Please summarise:
- files changed
- archive location
- commands
- tests run
- rollback implications
```

## Prompt 8: Website/debug updates for v2 visibility

```text
Codex Cloud prompt:

Please update the website debug logging only as needed so R2 history v2 behaviour is visible. Do not change chart rendering unless needed.

Before changing anything:
1. Archive every file that will be changed into:
   `archive/YYYY-MM-DD-r2-history-v2-website-debug/`

Goal:
When debug logging is enabled, make it clear whether AQI bands and observation history came from v1 or v2.

Requirements:
1. Keep normal website behaviour unchanged.
2. Keep debug flag default false.
3. Add debug fields when available from API coverage:
   - read_version
   - index_version
   - data_profile
   - source path/prefix
   - pollutant partition
   - R2 object reads
   - parquet bytes read
   - matched rows
   - response_complete
   - partial_reasons
4. Confirm 90-day chart logs show v2 usage after Worker switch.
5. Do not make the website directly know R2 paths if the Worker already exposes enough coverage metadata.
6. Add no user-visible UI unless there is already a debug-only UI.

Likely file:
- `hex_map.html`

Please summarise:
- files changed
- archive location
- debug fields added
- how to test
```

## Prompt 9: CIC-Test build and validation runbook

```text
Codex Cloud prompt:

Please create a CIC-Test runbook for building and validating R2 history v2 alongside v1. Documentation only unless explicitly asked otherwise.

Before changing anything:
1. Archive any docs you change into:
   `archive/YYYY-MM-DD-r2-history-v2-cic-test-runbook/`

The runbook must include:
1. Preflight checks.
2. Required env vars.
3. Build historical v2 observations.
4. Build historical v2 AQI hourly data/debug.
5. Build `_index_v2`.
6. Build/refresh backup inventory.
7. Sync v2 to Dropbox.
8. Validate parquet schemas with DuckDB.
9. Validate manifests.
10. Validate indexes.
11. Compare v1 vs v2 for selected sensors.
12. Enable Worker v2 read mode in CIC-Test.
13. Test 24h, 7d, 31d and 90d chart ranges.
14. Confirm no Cloudflare 1102.
15. Switch prune daily write mode to v2 only after v2 read testing passes.
16. Rollback steps.
17. Soak period checks.
18. Criteria for deleting v1 later.

Known test cases:
- timeseries_id=354, station_id=1575, pollutant=pm25
- timeseries_id=327, station_id=661, pollutant=pm25
- timeseries_id=396, station_id=7609, pollutant=pm25

Known failing windows to retest:
- 2026-04-10 -> 2026-04-17
- 2026-04-17 -> 2026-04-24
- 2026-04-24 -> 2026-05-01
- 2026-05-01 -> 2026-05-08

Please include exact command templates where possible.
```

## Prompt 10: LIVE rollout plan after CIC-Test is proven

```text
Codex Cloud prompt:

Please create a LIVE rollout plan for R2 history v2, based on the CIC-Test v2 runbook. Documentation only.

Before changing anything:
1. Archive any docs you change into:
   `archive/YYYY-MM-DD-r2-history-v2-live-rollout/`

The LIVE plan must be conservative.

Requirements:
1. Build LIVE v2 alongside LIVE v1.
2. Do not delete LIVE v1 during initial rollout.
3. Confirm LIVE v2 object inventory before switching.
4. Confirm LIVE `_index_v2`.
5. Deploy Worker code that supports v1/v2 read switch but keep LIVE on v1 initially.
6. Validate LIVE v2 with manual/API tests.
7. Switch LIVE read version to v2.
8. Soak test.
9. Switch LIVE write version to v2.
10. Keep rollback instructions:
    - set `UK_AQ_R2_HISTORY_READ_VERSION=v1`
    - optionally set `UK_AQ_R2_HISTORY_WRITE_VERSION=v1`
11. Include monitoring:
    - Cloudflare 1102/503
    - R2 Class A/B
    - storage size
    - chart debug logs
    - AQI band gaps
12. Include criteria for deleting v1 later.
13. Include criteria for removing legacy v1 code later.

Do not implement anything. Documentation only.
```
