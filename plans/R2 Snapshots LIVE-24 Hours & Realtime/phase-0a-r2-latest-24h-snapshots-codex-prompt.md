# Codex Prompt — Phase 0A / Phase A: R2 Latest + 24h Snapshot Builder

You are working in my UK-AQ project. This is an implementation task, but proceed carefully and keep changes focused.

## Goal

Implement the first R2 snapshot publishing phase for the UK-AQ website.

This combines lightweight Phase 0 baseline/guardrails with Phase A snapshot publishing:

- Add a scheduled/manual snapshot builder.
- Build from committed database state, not raw Pub/Sub messages.
- Generate **latest map snapshots**.
- Generate **24-hour chart lookup snapshots** at the same time.
- Write stable JSON snapshots to Cloudflare R2.
- Write a rich manifest with hashes, ETags, row counts, sizes, timestamps, and build metadata.
- Use deterministic JSON and skip unchanged snapshot object writes.
- Keep this compatible with future stable cache proxy endpoints and future realtime `snapshot_updated` notifications.

Do **not** implement the website cutover in this task.
Do **not** implement the cache proxy `/latest-snapshot` endpoint in this task unless it already has obvious small metadata support needed for testing.
Do **not** implement realtime / Durable Objects / WebSockets in this task.
Do **not** change existing public website behaviour in this task.

## Current architecture context

Important current facts:

- Active ingest is now GCP Cloud Run based.
- Ignore old Supabase Edge ingest functions as active ingest paths.
- All 4 active network ingest workers are in `pubsub_only` mode.
- Do not include `erg_laqn` as an active/current ingest network.
- Active network paths are expected to be:
  - `uk_air_sos`
  - `breathelondon`
  - `openaq`
  - `sensorcommunity`
- `ingestdb` holds the freshest operational/latest state and current latest/map/chart RPCs.
- `obs_aqidb` holds observation/AQI history and can lag because of Pub/Sub/hourly flush/AQI schedules.
- Current public latest map path is DB-backed and uses `/latest` with cursor-style behaviour in the website.
- R2 already exists for older/history exports.
- We are adding R2 snapshots as a public/cache delivery layer, not replacing the databases.
- Snapshots must be built from committed DB state, initially from `ingestdb` for latest/map data.
- Future realtime will only send metadata such as `snapshot_updated`; browsers will fetch the same stable R2/cache snapshot endpoint.

## Key locked decisions

Implement according to these decisions:

1. Phase 0 is lightweight and merged into this implementation.
2. Build snapshots from committed `ingestdb` state.
3. Implement a scheduled builder, runnable every 60 seconds, and also manually runnable.
4. Design so an ingest-triggered/debounced run can be added later, but do not wire that now.
5. Build both:
   - latest map snapshots
   - 24-hour chart lookup snapshots
6. Latest map snapshot shape should match the current `/latest` response shape as closely as possible.
7. Latest map snapshot matrix:
   - pollutants: `pm25`, `pm10`, `no2`
   - windows: `3h`, `6h`, `1d`
   - network group: `all` only
8. Include a network dimension in object keys/manifest now, but only generate `network_group=all`.
9. Do not support arbitrary network combinations.
Compression decision:
10. Use plain JSON plus precompressed Brotli .json.br. Do not use plain JSON only. The Worker/cache proxy should later prefer .json.br when the browser supports Brotli, and fall back to .json if needed.
11. Use deterministic JSON + SHA-256 hash + stable ETag.
12. Skip unchanged snapshot object writes.
13. Write a rich manifest.
14. If one snapshot fails, keep previous manifest entries for that key and continue with other snapshots where safe.
15. Do not publish broken/partial snapshot entries as fresh.
16. Keep existing chart/timeseries paths unchanged.
17. Do not remove existing `/latest`, `since`, or `since_id` code in this task.

## Repositories / areas to inspect

Inspect the relevant existing code/docs before implementing:

- GCP ingest workers and shared DB/API client code.
- Current `/latest` implementation and its response shape.
- Current chart/timeseries endpoint and 24-hour chart data shape.
- Existing R2 history publishing code and deployment patterns.
- Existing Cloud Run jobs in ops/ingest repos.
- Existing workflows/env-var patterns for Cloud Run deploys.
- Existing R2 credentials/bucket configuration patterns.
- System docs describing:
  - GCP ingest flow
  - Pub/Sub observation writer
  - cache proxy
  - R2 history layout
  - latest/chart data loading

Likely useful files include, but are not limited to:

- `workers/uk_aq_observs_pubsub_cloud_run/README.md`
- `workers/uk_aq_observs_pubsub_cloud_run/run_job.ts`
- current `uk_aq_latest` function/source
- current `uk_aq_timeseries` function/source
- R2 history export workers/services
- cache proxy system docs
- R2 history layout docs
- deploy workflows for existing Cloud Run jobs

## Implementation location

Prefer implementing this as an ops-side/GCP Cloud Run style snapshot builder rather than inside every ingest worker.

Use the existing repo conventions. If there is already a suitable ops worker directory pattern, add a new worker/service such as:

```text
workers/uk_aq_r2_snapshot_builder/
```

or the closest existing convention.

The builder must be runnable manually from CLI/Cloud Run job and schedulable every 60 seconds.

If the current project already has a standard Cloud Run job wrapper or deployment workflow pattern, follow it.

## Snapshot families

Implement two snapshot families.

### Family 1 — latest map snapshots

Purpose:

- Replace the public website's latest map `/latest` polling path later.
- Should be close to current `/latest` response shape for low-risk future cutover.

Matrix:

```text
pollutants: pm25, pm10, no2
windows: 3h, 6h, 1d
network_group: all
```

Initial object key pattern:

```text
snapshots/v1/latest/network_group=all/window={window}/pollutant={pollutant}.json
```

Examples:

```text
snapshots/v1/latest/network_group=all/window=3h/pollutant=pm25.json
snapshots/v1/latest/network_group=all/window=6h/pollutant=pm10.json
snapshots/v1/latest/network_group=all/window=1d/pollutant=no2.json
```

Data source:

- Use committed `ingestdb` latest data source.
- Prefer reusing the same RPC/query logic as the current `/latest` endpoint, rather than reimplementing business logic incorrectly.
- Do not use raw Pub/Sub messages.
- Do not use `obs_aqidb` as source for latest v1 unless the existing latest path already does so.

### Family 2 — 24-hour chart lookup snapshots

Purpose:

- Provide a future cacheable/R2 source for the default 24-hour line-chart mode via the hex map.
- Existing chart/timeseries endpoints should continue working unchanged for now.

Matrix:

```text
pollutants: pm25, pm10, no2
range: 24h
network_group: all
```

Initial object key pattern:

```text
snapshots/v1/chart24h/network_group=all/pollutant={pollutant}.json
```

Examples:

```text
snapshots/v1/chart24h/network_group=all/pollutant=pm25.json
snapshots/v1/chart24h/network_group=all/pollutant=pm10.json
snapshots/v1/chart24h/network_group=all/pollutant=no2.json
```

Data source:

- Use committed database state.
- Prefer the same source/path used by the existing default 24-hour chart/timeseries data, so the future cutover is low risk.
- If current chart data is stitched from multiple stores, preserve correctness over speed. For this first builder, use the existing chart source logic if possible.
- Do not create per-timeseries R2 objects at a 60-second cadence.
- Do not implement arbitrary custom chart ranges.

Important:

- The 24-hour snapshot object may be large. Keep it bounded to `network_group=all` and pollutant only for now.
- Log JSON and byte sizes so we can decide later whether to split by network or use another shape.

## Manifest

Write a rich manifest after snapshot object processing.

Manifest key:

```text
snapshots/v1/manifest.json
```

The manifest should be deterministic and include at least:

```json
{
  "schema_version": 1,
  "generated_at": "2026-05-08T20:31:00.000Z",
  "builder": {
    "name": "uk_aq_r2_snapshot_builder",
    "version": "...",
    "source": "ingestdb",
    "run_id": "...",
    "duration_ms": 1234
  },
  "snapshot_families": {
    "latest": {
      "all:3h:pm25": {
        "family": "latest",
        "network_group": "all",
        "window": "3h",
        "pollutant": "pm25",
        "json_key": "snapshots/v1/latest/network_group=all/window=3h/pollutant=pm25.json",
        "content_type": "application/json; charset=utf-8",
        "etag": "\"sha256-...\"",
        "sha256": "...",
        "row_count": 1234,
        "bytes_json": 123456,
        "min_observed_at": "...",
        "max_observed_at": "...",
        "built_at": "...",
        "source": "ingestdb",
        "status": "ok"
      }
    },
    "chart24h": {
      "all:24h:pm25": {
        "family": "chart24h",
        "network_group": "all",
        "range": "24h",
        "pollutant": "pm25",
        "json_key": "snapshots/v1/chart24h/network_group=all/pollutant=pm25.json",
        "content_type": "application/json; charset=utf-8",
        "etag": "\"sha256-...\"",
        "sha256": "...",
        "row_count": 1234,
        "bytes_json": 123456,
        "min_observed_at": "...",
        "max_observed_at": "...",
        "built_at": "...",
        "source": "ingestdb",
        "status": "ok"
      }
    }
  },
  "errors": []
}
```

Exact structure can be adjusted to fit the repo style, but keep the same information.

The manifest should support future cache proxy/realtime usage. Future `snapshot_updated` events should be able to identify snapshots using the same dimensions:

```text
family
network_group
window or range
pollutant
etag
json_key
generated_at
```

## Deterministic JSON and hashing

For every snapshot:
1. Generate deterministic JSON.
2. Use stable key ordering where practical.
3. Keep the snapshot body data-driven. Do **not** include build/run timestamps or other fields that change every run unless they are part of the actual data.
4. Compute SHA-256 over the exact uncompressed JSON bytes.
5. Derive the JSON ETag from that SHA-256, for example:
   ```text
   "sha256-{hash}"

6. Create the Brotli variant from the same JSON bytes.
7. Compute SHA-256 over the exact Brotli bytes as well.
8. Derive the Brotli ETag from the Brotli SHA-256, for example:

"sha256-br-{hash}"

9. Compare the new hashes with the existing manifest and/or existing R2 object metadata.
10. If the JSON hash is unchanged, skip rewriting the .json object.
11. If the Brotli hash is unchanged, skip rewriting the .json.br object.
12. Still include the snapshot in the new manifest with status unchanged, changed, partial_changed, or equivalent.
13. Put build/run timestamps, build duration, and publish status in the manifest or build report, not in the snapshot object body.

Do not use timestamps inside the snapshot object in a way that forces a new hash every minute when the underlying snapshot data has not changed.

## R2 writes

Use existing R2 patterns in the repo where possible.

For each JSON object:

- `Content-Type: application/json; charset=utf-8`
- Include metadata where supported, such as:
  - `sha256`
  - `etag`
  - `family`
  - `pollutant`
  - `window` or `range`
  - `network_group`
  - `row_count`
  - `min_observed_at`
  - `max_observed_at`
  - `built_at`

If R2/S3-compatible metadata limitations make this awkward, ensure the manifest contains all required metadata.

## Failure behaviour

Use resilient partial-build behaviour:

- Attempt all configured snapshots.
- If one snapshot fails, log the error and continue with the others where safe.
- Do not replace a good manifest entry with a broken entry.
- Do not publish a broken snapshot as fresh.
- A valid empty result is allowed only when the source query succeeded and `row_count=0` is genuinely correct.
- Write the manifest only after processing snapshot objects.
- If manifest writing fails, log loudly and exit non-zero.
- Snapshot object write failure should mark that snapshot as failed and keep previous manifest entry where possible.

## Baseline / guardrail logging

This task should add useful baseline outputs, not a full dashboard.

Log, at minimum:

- run id
- start/end/duration
- source database/project/ref used, without secrets
- configured snapshot matrix
- per snapshot:
  - family
  - pollutant
  - window/range
  - network_group
  - row_count
  - min/max observed timestamp
  - JSON bytes
  - SHA-256
  - whether object was written or skipped unchanged
  - R2 key
  - error, if any
- totals:
  - snapshots attempted
  - snapshots written
  - snapshots skipped unchanged
  - snapshots failed
  - total JSON bytes

If existing metrics/log tables exist for endpoint egress or worker runs, do not modify them heavily unless there is an obvious existing pattern. Prefer structured logs first.

## Scheduling / deployment

Add deployment/scheduling support following existing repo patterns.

The builder must support:

1. Manual run.
2. Scheduled run every 60 seconds if the platform supports that cleanly.

If existing Cloud Scheduler patterns only support minute-level cron, use every minute:

```text
* * * * *
```

If Cloud Scheduler/Cloud Run cannot safely guarantee exactly every 60 seconds under existing patterns, document the closest supported schedule.

Add env vars/secrets as needed, following existing naming conventions.

Likely env/config items:

```text
SNAPSHOT_R2_BUCKET
SNAPSHOT_R2_ACCOUNT_ID or equivalent
SNAPSHOT_R2_ACCESS_KEY_ID / SECRET_ACCESS_KEY or existing R2 binding method
SNAPSHOT_PREFIX=snapshots/v1
SNAPSHOT_POLLUTANTS=pm25,pm10,no2
SNAPSHOT_WINDOWS=3h,6h,1d
SNAPSHOT_NETWORK_GROUPS=all
SNAPSHOT_CHART24H_ENABLED=true
SNAPSHOT_LATEST_ENABLED=true
SNAPSHOT_SKIP_UNCHANGED=true
SUPABASE_INGESTDB_URL / keys using existing secret naming conventions
```

Use the project's existing environment/secrets convention instead of inventing a totally new one.

## Tests / validation

Add tests where practical.

At minimum, include validation for:

- snapshot matrix generation
- deterministic JSON/hash behaviour
- unchanged snapshot skip logic
- manifest merge/retain-previous-on-failure behaviour
- key generation
- timestamp min/max extraction

If automated tests are not already common for this worker style, add a small local validation script or document manual test commands.

## Acceptance criteria

The task is complete when:

1. A new scheduled/manual snapshot builder exists.
2. It builds latest snapshots for:

```text
pollutants: pm25, pm10, no2
windows: 3h, 6h, 1d
network_group: all
```

3. It builds 24-hour chart lookup snapshots for:

```text
pollutants: pm25, pm10, no2
range: 24h
network_group: all
```

4. It writes plain JSON snapshot objects to R2 under stable keys.
5. It writes `snapshots/v1/manifest.json` after successful processing.
6. It computes SHA-256 hashes and stable ETags.
7. It skips unchanged snapshot writes.
8. It logs row counts, sizes, timestamps, and write/skip/failure status.
9. It can be run manually.
10. It has deployment/scheduling config consistent with the repo's existing patterns.
11. It does not change website behaviour.
12. It does not remove or modify the existing `/latest` public path.
13. It does not implement realtime.
14. It does not build snapshots from raw Pub/Sub messages.
15. It documents how to run it and how to inspect the manifest in R2.

## Important non-goals

Do not do these in this task:

- Do not switch the website to R2 snapshots.
- Do not add the public `/api/aq/latest-snapshot` cache proxy endpoint unless needed only as a tiny internal test helper.
- Do not implement Cloudflare Durable Objects, WebSockets, or realtime.
- Do not create arbitrary network-combination snapshots.
- Do not create per-timeseries 24-hour snapshot objects.
- Do not redesign database architecture.
- Do not consolidate `ingestdb` and `obs_aqidb`.
- Do not remove `since` / `since_id` logic.
- Do not modify old Supabase Edge ingest functions except docs if absolutely necessary.

## Output expected from Codex

When done, provide:

1. Summary of what changed.
2. Files changed.
3. How to run the builder manually.
4. How scheduling/deployment was added or should be enabled.
5. Required env vars/secrets.
6. Example R2 object keys written.
7. Example manifest snippet.
8. Test/validation results.
9. Any risks or follow-up decisions.
10. Any places where existing code/docs were unclear.
