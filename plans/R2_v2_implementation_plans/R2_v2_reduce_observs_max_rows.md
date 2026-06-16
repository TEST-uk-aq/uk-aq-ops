
Here is the design recommendation and analysis for fixing the Cloudflare Worker resource limits when fetching raw observations from R2 history v2. 

### 1. Executive Summary
The most effective and safest structural fix is **Option 4 (Timeseries-aware max-size parquet splitting)**. 

Crucially, **your codebase already supports this.** The v2 observation builder (`uk_aq_build_v2_observations_from_dropbox_v1.mjs`) already sorts rows by `timeseries_id` before chunking them, and the `worker.mjs` already reads file-level `min_timeseries_id` and `max_timeseries_id` from the index to skip irrelevant files. The only reason it is currently failing is that the builder's default `--part-max-rows` is set to `500000`, causing the entire 127k-row Sensor.Community dataset to be stuffed into a single 1MB `part-00000.parquet` file. By simply lowering this threshold to ~25,000, the builder will automatically output neatly segmented files (`part-00000`, `part-00001`, etc.) without requiring any code or schema changes to the worker or index layout.

### 2. Current Bottleneck
When the frontend requests 7 days of data, the upstream `uk_aq_observs_history_r2_api_worker` queries the index and identifies seven `part-00000.parquet` files (one for each day). Because `min_timeseries_id` and `max_timeseries_id` in each file span the entire network, the worker cannot skip them. 

The worker then fetches each ~1MB file from R2 and calls `await object.arrayBuffer()`. Decompressing and holding seven 1MB ArrayBuffers in memory concurrently inside a Cloudflare Worker (V8 Isolate) exceeds the available memory/CPU limits, triggering a 503 or 524 resource exhaustion error.

### 3. Option Comparison Table

| Option | Approach | Complexity | Risk | Expected Perf. Impact |
| :--- | :--- | :--- | :--- | :--- |
| **1** | Smaller frontend chunks (e.g. 1-2 days) | Low | Low | Mitigates memory limits, but increases latency & request volume |
| **2** | Adaptive retry in cache proxy | High | Medium | Adds significant complexity; doesn't fix underlying memory spikes |
| **3** | Optimise observations R2 worker | Very High | High | Unlikely to work well; `hyparquet` requires full ArrayBuffer in memory |
| **4** | **Timeseries-aware max-size splitting** | **Low** | **Low** | **Massive speedup; worker only downloads ~150KB instead of 1MB per day** |
| **5** | Granular layout (e.g. `ts_bucket=0007/`) | High | High | Requires rewriting the v2 spec, workers, and syncing logic |
| **6** | Precomputed downsampled chart series | Medium | Medium | Violates the project's strict raw-granularity HistoryDB policy |

### 4. Detailed Pros and Cons by Option

**Option 1: Smaller frontend/API chunks**
* **Pros:** Easy to implement; immediately stops the 7-day memory crash.
* **Cons:** Forces the frontend to make 7 consecutive (or parallel) API calls, increasing Cloudflare Worker invocation costs and degrading the user experience with slower chart loads.
* **Impact on existing data/workers:** None.

**Option 2: Adaptive retry in the cache proxy**
* **Pros:** Hides the failure from the frontend.
* **Cons:** Very complex to orchestrate merging partial parquet responses in the proxy. It also wastes Cloudflare CPU time crashing and retrying.
* **Impact on existing data/workers:** None.

**Option 3: Optimise the observations R2 worker**
* **Pros:** Ideal if we could stream the parquet file.
* **Cons:** Cloudflare Workers don't support native filesystem streaming easily for Parquet. `hyparquet` must read the file into an ArrayBuffer. Optimizing the V8 engine memory usage here is a losing battle against the strict Cloudflare limits.

**Option 4: Timeseries-aware max-size parquet splitting (RECOMMENDED)**
* **Pros:** **It is natively supported today.** `buildConnectorDayPlan` in the builder script explicitly sorts by `timeseries_id` (line 588) before chunking. The worker explicitly checks `min_timeseries_id` and `max_timeseries_id` (line 339). A threshold of `25000` rows will naturally keep small networks as a single file while splitting massive ones.
* **Cons:** Increases the raw count of files in the R2 bucket and Dropbox backup.
* **Impact on data/workers:** Safely backward-compatible.
* **Impact on Dropbox backup:** Total byte size will be similar, but the file count will increase for large networks.

**Option 5: Granular layout by timeseries bucket**
* **Pros:** The ultimate lookup speed.
* **Cons:** Complete overhaul of `history/v2` schema. Massive explosion of tiny files in R2 (Class A PUT costs) and Dropbox sync operations. 

**Option 6: Precomputed downsampled chart series**
* **Pros:** Very fast for line charts.
* **Cons:** Expressly forbidden by the project's HistoryDB Granularity Policy unless the user explicitly requests downsampling.

### 5. Recommendation
Adopt **Option 4** using a dynamic threshold (essentially Option 4D). 
Because the system is already sorting and chunking, you don't need to write new explicit bucketing logic. By changing the `uk_aq_build_v2_observations_from_dropbox_v1.mjs` `--part-max-rows` argument to `25000`, a 127k-row Sensor.Community day will naturally split into ~5 files (each ~200KB).

When the worker searches for `timeseries_id=7507`, it will check the manifest/index, realise only `part-00001.parquet` contains that ID range, and download only that 200KB file instead of the full 1MB.

### 6. Proposed Phased Plan
1. **Immediate Mitigation:** Do not change the frontend yet. 
2. **Experimentation:** Run the v2 builder locally in CIC-Test for a single day and connector (e.g., connector 7 on 2026-05-18) using `--part-max-rows 25000`.
3. **Rebuild Index:** Run the R2 index builder script for that day.
4. **Validation:** Test the hex map to ensure the worker successfully skips the irrelevant parts and loads the chart without memory limits.
5. **Rollout:** Apply the new `--part-max-rows` default to the builder scripts and backfill the older v2 observations for large connectors.

### 7. Suggested R2 Commands to Quantify File Sizes
Run these commands to quantify the current file distribution (they are read-only and safe):

**1. Top largest v2 observation parquets for Connector 7 PM2.5:**
```bash
rclone lsl "uk_aq_r2:${CFLARE_R2_BUCKET}/history/v2/observations/" \
  --include "day_utc=2026-05-*/connector_id=7/pollutant_code=pm25/*.parquet" \
  | sort -nr | head -n 10
```

**2. Row counts and file bounds from the generated v2 manifests:**
```bash
for d in 2026-05-18 2026-05-19 2026-05-20; do
  echo "== $d =="
  rclone cat "uk_aq_r2:${CFLARE_R2_BUCKET}/history/v2/observations/day_utc=${d}/connector_id=7/pollutant_code=pm25/manifest.json" \
    | jq '{day_utc, source_row_count, files: [.files[]? | {key, bytes, row_count, min_timeseries_id, max_timeseries_id}]}'
done
```

### 8. Suggested CIC-Test Experiment for Timeseries-Aware Splitting
You can test the fix safely in CIC-Test on a single day without disrupting anything else.

**Step 1: Rebuild the observations with a lower threshold:**
```bash
node scripts/backup_r2/uk_aq_build_v2_observations_from_dropbox_v1.mjs \
  --from-day 2026-05-18 --to-day 2026-05-18 \
  --connector-id 7 \
  --part-max-rows 25000 \
  --write-r2 --replace
```
*(This will replace the single 1MB parquet with ~5 smaller parquets. Because it replaces the manifest, it's atomic).*

**Step 2: Rebuild the index so the worker knows about the new bounds:**
```bash
node scripts/backup_r2/uk_aq_build_r2_history_index.mjs \
  --history-version v2 \
  --targeted \
  --domain observations \
  --from-day 2026-05-18 --to-day 2026-05-18

```

### 9. What Not To Do
* **Do not** write custom bucketing logic in the builder (it already sorts by `timeseries_id` naturally, so size-based chunking achieves perfect timeseries bounding).
* **Do not** change the v2 directory layout or schema.
* **Do not** try to stream Parquet in the Cloudflare worker. V8 memory limitations make this highly complex compared to simply storing smaller files.

### 10. Specific Answers & Open Questions
> **Is a pure max-size split without timeseries ordering/bucketing useful?**
No, but your code **already sorts by `timeseries_id`** (line 588 of the builder). So a pure max-size split *in your codebase* is effectively a timeseries bucket!

> **Does the current observations worker already use file-level bounds?**
Yes, `worker.mjs` lines 334-345 explicitly skips row groups and files if the requested `timeseriesId` falls outside `min_value` and `max_value`.

**Open Question before implementation:**
* Will changing the `--part-max-rows` default to 25,000 cause too many tiny files for extremely low-volume connectors? *(Recommendation: The builder handles this cleanly; a connector with only 5,000 rows will simply produce a single `part-00000.parquet` just as it does today, so there is zero downside for small connectors).*