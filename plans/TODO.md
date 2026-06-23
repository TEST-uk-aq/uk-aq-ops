# TODO

## Integrity for R2_v2

## R2 History Worker Refactor

## Egress Reduction

- Route-shape follow-up (Option 3 after Option 2 baseline): split cache profiles into `/api/aq/meta/*` (long TTL) and `/api/aq/realtime/*` (short TTL). Use `realtime` naming (not `live`) to avoid confusion with test/live environments.

## Network Data Feed Down Message

- Badge: Network feed offline

- Tooltip / small helper text: We are not receiving data from this network at the moment. The map will update when the feed is restored.

## Networks to add

- Add SaddleSense London cycling network.

## API Exposure

- After deployment stabilizes, plan Option B: add `uk_aq_public` proxy RPCs so only `uk_aq_public` needs to be exposed.

## Ingest Reliability and Checkpointing

- Review and improve UK-AIR SOS checkpointing and ingest flow: edge path still uses `uk_air_sos_timeseries_checkpoints`; if needed, migrate edge selection to the newer station-level model (`uk_air_sos_station_checkpoints`) now used by Cloud Run.
- Look at lag/interval samples on OpenAQ gap mode. `st_checkpoints` isn't getting updated.
- Phase B backup follow-up: keep existing single-day v1 backup as-is for now; add one-off migration task to rewrite that day to v2 backup schema later (drop `created_at`/`status` in migrated artifacts while preserving row-level granularity and manifest integrity).

## Data Model and Integrity

- Tidy up pollutants/phenomena. Mapping table from connector versions to phenomena.
- Investigate prune-repair edge case where `history_count > ingest_count` for a `(connector_id, hour_start)` bucket. Confirm if this can occur with current pipeline ordering/duplication behavior, and if needed add safe remediation path (history-side dedupe/remove or strict guardrail workflow).
- AQI follow-up: add expected-count/cadence completeness fields (`expected_count`, validity boolean) for helper-hour rows after v1 sample-count-only rollout. Keep hourly source shape simple for now.
- Legacy bridge review: keep ingest-side `uk_aq_history.observations` + `uk_aq_public.rpc_observations_window` for now; re-check live usage before removing in a future cleanup.


## fix coverage metadata so successful paged reads do not keep misleading r2_coverage_partial

The cache proxy calls the observations R2 worker with limit=1000.
The observations worker may return response_complete=false because one page hit the limit.
The cache proxy then correctly pages again and gets the rest of the data.
But it still keeps the earlier page-level “partial” metadata.
So the final combined response can be marked r2_coverage_partial even though the paged read actually succeeded.


## Prune Daily v2 still using a v1 path

history/v1/_ops/observations/runs/run_id=.../run_manifest.json

## Fix AQILevels Debug writer_git_sha 

Ensure the Cloud Run prune daily deployment passes the current Git commit SHA into the Phase B writer so future AQILevels data/debug manifests populate writer_git_sha instead of null.

## Network selector card

Netrwork counts don't update when switching between UK and C&R