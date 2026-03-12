# UK AQ Ops Backfill Plan
Date: 2026-03-06

## 1) Goal
Add a backfill capability to `uk-aq-ops` that can run in three modes:

1. Rebuild or extend ObsAQI DB from data you already hold locally.
2. Rebuild or extend Cloudflare R2 History from local history data.
3. Backfill older historic data from network APIs or downloaded files, then write canonical Observs + AQI outputs into R2 History.

The design should follow the current Ops repo pattern of Cloud Run workers with manual and scheduler trigger modes. The repo already uses that pattern for prune, outbox flush, partition maintenance, DB size logging, and the station AQI worker targeting ObsAQI tables. The current ObsAQI worker also already exposes a `run_mode` concept (`sync_hourly` and `backfill`), which is a good precedent for this backfill feature. Source refs: `uk-aq-ops` README and current worker layout; `uk_aq_aqi_station_aggdaily_cloud_run/run_service.ts`.  

## 2) Relevant repo findings

### Ops repo
Current `uk-aq-ops` responsibilities already include:
- prune verified ingest rows after parity checks against history
- flush ingest outbox rows into history DB
- maintain history partitions/index policy/retention
- log DB sizes
- compute station AQI into ObsAQI DB

That means the repo is already the right place for a cross-database backfill/orchestration service rather than putting this into ingest. Source: `uk-aq-ops` README.  

Important project rule: Phase B observations backup is mandatory, and the repo explicitly says not to reduce backup coverage just to save cost or egress. So the backfill design must preserve full R2 History integrity. Source: `uk-aq-ops/AGENTS.md`.  

### Schema repo
The ObsAQI schema already contains:
- mirrored `uk_aq_core` metadata tables
- `uk_aq_ops` and `uk_aq_public` patterns
- DB size metrics objects
- `uk_aq_aqilevels.station_aqi_hourly` as a key derived-data table

That means ObsAQI is already positioned as a derived/read-optimized destination DB, not the source of truth for raw observations. Source: `schemas/obs_aqi_db/uk_aq_obs_aqi_db_schema.sql`.  

### Ingest repo
The ingest repo confirms:
- shared schema is applied from the schema repo
- fresh setup uses a MAIN DB and a HISTORY DB
- history observations are keyed by `(connector_id, timeseries_id, observed_at)`
- outbox delivery is for current ingest->history flow, not historic external backfill

This supports treating History DB as the local raw canonical store for any older backfill you successfully ingest. Source: `uk-aq-ingest` README.  

## 3) Recommended high-level design
Use **one new Cloud Run worker in `uk-aq-ops`** with multiple run modes, instead of three separate workers.

Suggested worker path:
- `workers/uk_aq_backfill_cloud_run/`

Suggested trigger styles:
- `trigger_mode=scheduler|manual`
- `run_mode=local_to_aqilevels|obs_aqi_to_r2|source_to_r2`

Why this is the best fit:
- matches the existing Ops Cloud Run pattern
- gives you one deployment, one auth surface, one logging stream, one run table family
- allows shared checkpointing, dry-run, chunking, connector filters, and observability
- keeps the backfill feature clearly operational rather than mixing it into live ingest

Main downside:
- the worker will be broader in scope than the existing single-purpose workers

Mitigation:
- keep the implementation internally split into separate modules per mode, with a small router entrypoint

## 4) Mode names
Your draft names are understandable, but I would make them shorter and more operation-oriented.

### Recommended public run mode names
1. `local_to_aqilevels`
   - meaning: rebuild ObsAQI from data already held in your stack
   - better than `backfill_aggdailydb_from_local` because it is shorter and still clear

2. `obs_aqi_to_r2`
   - meaning: export historical observations from History DB into R2 History layout
   - better than `backfill_cflarer2_from_obs_aqidb` because it is shorter and matches source->destination naming

3. `source_to_r2`
   - meaning: acquire historic data from API/download/manual file and write canonical Observs + AQI outputs to R2 History
   - better than `backfill_all_from_web` because some inputs are not “web” in the narrow sense; they may be local files

### Alternative names if you want “backfill” visible everywhere
- `backfill_local_to_aqilevels`
- `backfill_obs_aqi_to_r2`
- `backfill_source_to_r2`

### Recommendation
Use the shorter forms internally and externally:
- `local_to_aqilevels`
- `obs_aqi_to_r2`
- `source_to_r2`

They are easier to type, easier to log, and consistent with source->destination semantics.

## 5) What each mode should do

### Mode A: `local_to_aqilevels`
Purpose:
Populate or repair ObsAQI using data you already hold in Ingest DB, History DB, and optionally R2.

Recommended source priority:
1. **Ingest DB** for recent windows still inside your live retention.
2. **History DB** for older retained local raw data.
3. **R2 only as optional fallback or parity source**, not first choice.

Why:
- ObsAQI recompute wants relational querying, joins, and idempotent window scans.
- History DB is a better source for this than reading many parquet files back out of object storage.
- R2 should remain the durable backup/archive layer, not the first-line compute source.

Suggested use cases:
- rebuild a date range after schema changes
- populate newly added ObsAQI rollups
- repair gaps caused by an earlier failed ObsAQI job
- recalculate a connector after changes in derived logic

Write targets:
- `uk_aq_aqilevels.*` tables only
- optional ops run logs in ObsAQI or Ops DB schema

Recommended behavior:
- idempotent date-window recompute
- chunk by UTC day
- support `connector_code`, `station_id`, and date-range filters
- default to not touching already-complete days unless `--force` or equivalent is set

### Mode B: `obs_aqi_to_r2`
Purpose:
Export historical raw observations already stored in History DB into the Phase B R2 layout.

Recommended scope:
- read from History DB only
- write connector-day parquet part files, manifest.json files, and checkpoints to R2
- do not write ObsAQI from this mode

Why:
- keeps this mode narrow and reliable
- avoids accidental heavy cross-target fan-out during what is primarily an archive export job
- matches your stated intent that this mode is from local history data

Suggested use cases:
- backfill older R2 partitions that were never exported
- reconstruct missing R2 days after backup issues
- migrate old locally retained history into archive format

Recommended behavior:
- day-based export
- manifest-first connector-day layout with parquet part files (`part-00000.parquet`, etc.), matching your current Phase B philosophy
- verification after upload before commit markers are written
- ability to skip days already committed unless `--replace-existing` is set

Current layout note:
- your existing R2 structure is already connector-per-day, for example `history/v1/observations/day_utc=YYYY-MM-DD/connector_id=7/` containing `manifest.json` and `part-00000.parquet`
- so this plan should preserve that layout rather than invent a different one

### Mode C: `source_to_r2`
Purpose:
Acquire older historic data from network APIs, auto-download files, or manually supplied files, then build R2 History outputs in canonical connector/day layout.

Recommended flow:
1. acquire raw source data for a bounded day range
2. stage raw source files for replay in development (Dropbox mirror for Sensor.Community)
3. normalize into your canonical observation shape
4. compute AQI values in the worker from normalized observation rows (direct worker compute)
5. write/export matching parquet history files + manifests to R2 for:
   - `history/v1/observations`
   - `history/v1/aqilevels`
6. do not require History DB writes for this mode by default
7. record per-day per-connector checkpoints and provenance

Recommendation on Ingest DB:
- **do not make Ingest DB the main target for old historic backfill**
- use it only if you need a very small compatibility path for shared RPCs or helper logic

Why:
- Ingest DB is designed around short retention and live ingest operations
- using it as a historic staging store would increase churn and compete with live workloads
- R2 History is the intended durable target for this mode

Special case for “last 31/32 days”:
- If the fetched historic range overlaps your local retention horizon, dedupe against History DB first and only use Ingest DB when there is a very specific operational benefit

Sensor.Community-first delivery decision:
- process Sensor.Community first using **daily** archive files from `https://archive.sensor.community/`
- include met fields in normalization/output
- development replay files will be mirrored to:
  - `/Users/mikehinford/Library/CloudStorage/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_Backfill_raw_files/sensorcommunity`

Placeholder to revisit for Sensor.Community archive filtering:
- Archive files include non-UK stations, so source_to_r2 must not ingest blindly by connector/day.
- Backfill selection should start from the known UK station/timeseries set in core metadata (prefer R2 core snapshot, fallback to ingest `uk_aq_core`).
- We still need a defined strategy for archive stations that appear in source data but are missing from core tables:
  - detect and log unknown station refs/timeseries refs during archive parsing,
  - queue for controlled core onboarding (not automatic ingest by default),
  - then rerun source_to_r2 for the affected day/connector after onboarding.
- Keep this as an explicit Phase 9 follow-up item before enabling broad Sensor.Community source_to_r2 runs.

## 6) Options, pros, cons, egress effect, DB-size effect

### Option 1: Single worker, multi-mode router
Pros:
- fits existing Cloud Run/Ops pattern
- one deployment and shared run-state/checkpoint code
- easier operational visibility
- easiest place to add future connector-specific adapters

Cons:
- bigger codebase in one worker
- stronger need for clear internal module boundaries and tests

Egress effect:
- good overall, because you can centralize throttling, batching, and source selection

DB-size effect:
- no extra persistent DB footprint beyond run logs/checkpoints and the data you intentionally add

### Option 2: Separate worker per mode
Pros:
- simpler mental model per worker
- least risk of one mode’s dependencies affecting another

Cons:
- more deploy workflows, more env/config duplication, more maintenance
- duplicated checkpoint/logging code unless abstracted anyway

Egress effect:
- neutral to slightly worse, because duplication often leads to duplicated reads and weaker shared throttling logic

DB-size effect:
- same destination data footprint, slightly more ops metadata spread across services if each keeps its own run tables

### Option 3: Use ObsAQI rebuilds from R2 as the default “local” source
Pros:
- proves archive usability
- can work even if History DB is missing some windows

Cons:
- slower than DB-native recompute for most cases
- more object listing and object read operations
- harder SQL-like filtering and joins
- more operational complexity when combining many parquet days/connectors

Egress effect:
- Cloudflare R2 itself does not charge egress bandwidth, but reads still incur operation costs, and pulling many objects into Cloud Run still increases network movement and runtime work. Source: Cloudflare R2 pricing docs.  

DB-size effect:
- no extra DB storage by itself, but can encourage temporary staging if the pipeline is not carefully streamed

### Option 4: Historic source backfill stages through Ingest DB first
Pros:
- may reuse some existing ingest logic more directly
- can be convenient for connector code that already assumes ingest tables

Cons:
- poor fit for old history
- increases write churn in the short-retention live DB
- greater risk of contention with live polling and prune/outbox flow
- makes retention windows more awkward during large backfills

Egress effect:
- potentially worse because data may be written and re-read across more hops

DB-size effect:
- raises pressure on the Ingest DB, which is especially relevant because Supabase’s free plan still advertises a 500 MB database limit and egress quotas are limited by plan. Sources: Supabase pricing page and Supabase egress docs.  

## 7) Egress and cost recommendations

### Cloudflare R2
Cloudflare documents that R2 has **no egress bandwidth charges** for any storage class, although reads still involve request operations and Infrequent Access also has retrieval fees. For your design, that means `obs_aqi_to_r2` is usually safer from an egress-cost perspective than repeatedly reading large ranges back out of Supabase just to rebuild archive files. Source: Cloudflare R2 pricing docs.  

### Supabase
Supabase documents egress as network data transmitted out of the system, and its pricing page continues to show plan-specific DB size and egress quotas. That means heavy readback jobs from Ingest DB or History DB into Cloud Run can become the dominant egress/cost driver if you recompute broad historic windows inefficiently. Sources: Supabase pricing page and Supabase egress docs.  

### Practical recommendation
To keep egress low without compromising R2 History integrity:
- prefer **History DB as the source of truth for raw historic backfill already in your stack**
- avoid reading from both History DB and R2 for the same day unless you are doing verification or repair
- chunk by day and connector
- maintain a day-level checkpoint table so retries resume without re-reading completed windows
- support `dry_run` and `estimate_only` modes

## 8) Database-size recommendations

### Ingest DB
Recommendation:
- keep historic backfill writes out of Ingest DB as much as possible

Reason:
- it is your short-retention operational DB, and extra historic writes increase bloat, vacuum pressure, and prune complexity

### History DB
Recommendation:
- make this the canonical raw destination for historic source backfill

Reason:
- it is already the local long-lived raw store in your architecture
- easier to dedupe and re-export from here than from Ingest DB

Expected DB-size effect:
- temporary growth during overlapping windows
- sustained growth only for the days you deliberately keep locally before retention/export rules move the long tail to R2

### ObsAQI DB
Recommendation:
- store AQI-derived tables and run metadata
- avoid duplicating full historic raw observations for `source_to_r2` default path

Reason:
- keeps ObsAQI compact and purpose-built
- matches current schema role and existing AQI storage direction

## 9) Recommended control plane and metadata
Add backfill ops tables, probably in the destination DB most natural for the mode, or keep them centralized in ObsAQI/Ops if you want one run ledger.

Recommended logical tables:
- `uk_aq_ops.backfill_runs`
- `uk_aq_ops.backfill_run_days`
- `uk_aq_ops.backfill_source_files`
- `uk_aq_ops.backfill_checkpoints`
- `uk_aq_ops.backfill_errors`

Minimum columns to capture:
- `run_id`
- `run_mode`
- `trigger_mode`
- `connector_id` or `connector_code`
- `source_kind` (`obs_aqidb`, `ingestdb`, `r2`, `api`, `download`, `manual_file`)
- `window_from_utc`
- `window_to_utc`
- `day_utc`
- `status`
- `rows_read`
- `rows_written_history`
- `rows_written_obs_aqilevels`
- `objects_written_r2`
- `bytes_read`
- `bytes_written`
- `checkpoint_json`
- `error_json`
- `started_at`
- `finished_at`

## 10) Recommended execution rules

### Window direction
Run **backwards through time**, as you requested.

Recommendation:
- process newest day in the selected historic window first, then move older

Why:
- faster visible value
- easier to stop early with recent history already filled
- better alignment with your local overlap zone around the 31/32 day boundary

### Chunk size
Default:
- one UTC day per work unit

Optional:
- allow smaller chunks for large file-based sources or connectors with dense data

### Pace control
Default:
- run single-day jobs and intentionally pause between days

Recommendation:
- add a configurable inter-day delay for scheduled batches (for example `UK_AQ_BACKFILL_INTER_DAY_DELAY_SECONDS`)
- keep manual operations as explicit one-day runs during early rollout

### Idempotency
All modes should be idempotent by day and connector.

### Concurrency
Start with:
- single run in flight per worker
- optional per-connector concurrency later

Why:
- simpler to reason about duplicate writes and rate limits

## 11) API keys and source adapters
Use **separate historic/backfill credentials**, as you proposed.

Recommendation:
- define connector-specific env vars such as `*_BACKFILL_API_KEY`
- never reuse live ingest secrets by default
- allow per-connector request pacing and retry budgets

Adapter contract for each connector should expose:
- discover available date coverage
- fetch one day or one bounded chunk
- identify provenance (`api`, `download`, `manual_file`)
- return normalized canonical rows plus source metadata

This is the right approach for current networks and future ones because the acquisition method varies widely even when the downstream normalization is the same.

## 12) Final recommendations

### Strong recommendations
1. Build **one new Cloud Run worker in `uk-aq-ops` with three run modes**.
2. Use these mode names:
   - `local_to_aqilevels`
   - `obs_aqi_to_r2`
   - `source_to_r2`
3. Treat **History DB as the canonical local raw source** for local-window recompute only.
4. Treat **R2 as the durable archive target**, not the primary compute source.
5. Keep **historic source backfill out of Ingest DB** unless you have a very narrow compatibility reason.
6. Add **day-level checkpoints and run logs** from the start.
7. Keep the current **connector-per-day R2 layout with `manifest.json` plus parquet part files**.
8. For `source_to_r2`, default to **source -> R2 History only** (observs + aqilevels in canonical history format).
9. Process **backwards by UTC day**.
10. Keep the design **idempotent and resume-safe**.
11. Start connector rollout with Sensor.Community daily archive files and include met fields.
12. Use slow pacing: single-day jobs with gaps between days.


### Best first implementation order
Phase 1:
- `local_to_aqilevels`
- easiest value, lowest external dependency risk

Phase 2:
- `obs_aqi_to_r2`
- extends archive completeness while staying inside your own stack

Phase 3:
- `source_to_r2`
- most useful long term, but highest connector/source variance

## 13) Confirmed decisions (2026-03-11)
1. Sensor.Community archive granularity: **daily files**.
2. Primary destination: **R2 History**.
3. AQI generation in `source_to_r2`: **direct worker compute**.
4. Sensor.Community historical processing: **include met fields**.
5. Operational pacing: **single-day runs with intentional gaps between days**.
6. Development replay source mirror:
   - `/Users/mikehinford/Library/CloudStorage/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/R2_Backfill_raw_files/sensorcommunity`

## 14) Suggested plan file location
Recommended repo location:
- `plans/uk_aq_backfill_plan.md`

That keeps it aligned with the existing `plans/` folder and your AQI planning doc.
