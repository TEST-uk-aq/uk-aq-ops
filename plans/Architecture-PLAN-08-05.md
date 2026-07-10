# UK-AQ Architecture Review and Recommendation (Planning-Only, May 8, 2026)

## Executive Summary

Recommended direction is a **hybrid model (Option E)**:

1. Keep current functional split short-term:  
   `ingestdb` for freshest operational/latest paths, `obs_aqidb` for AQI + larger observation history windows, `R2` for committed history.
2. Add **R2 latest snapshots** for website map/cache delivery now.
3. Build snapshots from **committed DB state** (not raw Pub/Sub messages), then serve via stable cache-proxy URLs.
4. Keep 60-second polling as fixed fallback.
5. Add realtime later as **metadata-only “snapshot_updated” notifications** (Durable Object/WebSocket), with browser re-fetching the same stable snapshot endpoint.

Do **not** attempt R2-only for observations right now. It increases correctness, dedupe, repair, and debugging risk.
R2-only sounds attractive because egress is low, but it makes these harder:
- deduplicating observations
- late-arriving corrections
- updating “latest” accurately
- joining sensor metadata
- AQI recalculation
- debugging odd sensor behaviour
- backfills
- small targeted queries
- data quality checks
- admin reports

---

## Current Architecture Map

```text
Cloud Run ingest workers (sos, sensorcommunity, breathelondon, openaq worker path)
  -> commit latest state + observations in ingestdb (uk_aq_core)
  -> publish history rows to Pub/Sub (pubsub_only mode)

Pub/Sub writer Cloud Run
  -> drain batches
  -> dedupe (connector_id, timeseries_id, observed_at)
  -> upsert to obs_aqidb (uk_aq_observs.observations)

AQI hourly Cloud Run
  -> helper/read from ingestdb + upsert AQI tables in obs_aqidb

Prune/Phase-B history export (daily)
  -> export committed day slices to R2 (observations + aqilevels)
  -> rebuild history indexes

Website
  -> Cloudflare cache proxy
  -> /latest, /timeseries, /stations-chart, /pcon-hex, /la-hex, /aqi-history
  -> currently latest map path still DB-backed via /latest
```

### Current Stores and What Lives There

| Store | Main contents | Current main readers |
|---|---|---|
| `ingestdb` (Supabase) | core metadata (`connectors`, `stations`, `timeseries`), freshest latest values (`timeseries.last_value`), observations table, public RPCs for latest/hex/chart | `uk_aq_latest`, `uk_aq_pcon_hex`, `uk_aq_la_hex`, `uk_aq_stations_chart`, ingest workers |
| `obs_aqidb` / AQI DB | mirrored core metadata, high-volume `uk_aq_observs.observations`, AQI tables (`timeseries_aqi_hourly` etc) | Pub/Sub writer upserts, AQI hourly compute, AQI history worker recent window, `uk_aq_timeseries` recent segment |
| Cloudflare R2 | committed historical parquet domains + manifests/indexes under `history/v1/observations`, `history/v1/aqilevels`, `history/_index` | observations history R2 worker, AQI history R2 worker, prune/export/index jobs |

### Current Feature-to-Store Mapping

- Latest hex map data: `uk_aq_latest` -> `ingestdb` RPC (`uk_aq_latest_rpc`) via cache proxy.
- Line chart data: `uk_aq_timeseries` stitched path:  
  `ingestdb` (fresh) + `obs_aqidb` (recent window) + R2 history (older window).
- Historical observations: R2 history API worker.
- AQI/DAQI/EAQI display: AQI history worker = `obs_aqidb` recent + R2 older.
- Station/timeseries metadata: primary in `ingestdb`, mirrored in `obs_aqidb`.

### Confirmed Duplication

- Metadata duplicated between `ingestdb` and `obs_aqidb`.
- Observations duplicated across `ingestdb`, `obs_aqidb`, and later in R2 history.
- AQI duplicated between `obs_aqidb` tables and R2 AQI history.

### Likely Expensive Paths

- Frequent `/latest` browser polling path (public endpoint response egress + backend RPC load).
- `/timeseries` for active chart interactions (less volume per call, but high call count under active sessions).
- R2 class B reads if cache-hit ratio drops (many unique query keys).

### Current Runtime Facts (read-only checks, May 8, 2026 UTC)

- Connectors in `ingestdb`: `sos`, `breathelondon`, `openaq`, `sensorcommunity`.
- `OBSERVS_WRITE_MODE` and connector modes in `.env`: `pubsub_only`.
- `openaq` connector currently `poll_enabled=false` in `ingestdb` at review time.
- Row estimates:
  - `ingestdb.uk_aq_core.observations` ~1.2M
  - `obs_aqidb.uk_aq_observs.observations` ~3.2M
  - `obs_aqidb.uk_aq_aqilevels.timeseries_aqi_hourly` ~0.49M
- Freshness snapshot at query time:
  - `ingestdb` latest value timestamp near `22:29 UTC`
  - `obs_aqidb` observations max `22:00 UTC`
  - `obs_aqidb` AQI hourly max `18:00 UTC`
- Last-24h endpoint-response metrics in `ingestdb` show `uk_aq_latest` is the largest public response endpoint by bytes.

---

## Current Flow Summary (4 Active Worker Paths)

1. Ingest workers run on GCP Cloud Run and write committed operational state into `ingestdb`.
2. In `pubsub_only`, history-observation payloads are sent to Pub/Sub.
3. Pub/Sub writer Cloud Run drains subscription batches, dedupes, and upserts into `obs_aqidb` observations.
4. AQI hourly Cloud Run computes AQI rows into `obs_aqidb` AQI tables.
5. Prune/export flow writes closed-day history from DB state into R2 parquet + manifests.
6. Website currently uses cache proxy routes that still hit DB-backed `/latest` and stitched `/timeseries`; AQI history already has R2+DB split.

### Batch/flush behavior affecting freshness

- Pub/Sub writer deploy defaults indicate hourly scheduler (`0 * * * *`) unless overridden.
- AQI hourly deploy defaults indicate hourly cron (`20 * * * *`) but scheduler enablement is env-controlled.
- Result: freshest “latest” is in `ingestdb`; `obs_aqidb` and AQI can lag depending on flush/scheduler cadence.

---

## Options Table (A–E)

| Option | Core idea | Website speed | Supabase endpoint egress | Supabase DB size | R2 ops cost | Worker cost | GCP cost | Complexity | Risk | Realtime-ready |
|---|---|---|---|---|---|---|---|---|---|---|
| A | Keep DB split, add R2 latest snapshots | Fast | Large reduction | No immediate change | Moderate increase | Moderate increase | Small increase | Low-Med | Low | Strong |
| B | Consolidate to one DB + R2 snapshots | Fast | Large reduction | One DB grows, one shrinks/removed | Moderate | Moderate | Medium migration overhead | High | Med-High | Strong |
| C | R2-first heavy | Very fast reads if done well | Very low | Potential reduction if DB retention shrinks | High (many writes/reads) | Higher | Medium-High | High | High | Medium |
| D | R2-only / almost-only for observations | Can be fast | Lowest | Lowest DB observation footprint | Very high operational dependency | High | Medium | Very High | Very High | Weak-Medium |
| E | Hybrid: committed-state snapshots + existing stitched model, selective consolidation later | Fastest safe path | Largest practical reduction now | Controlled; can optimize later | Moderate, controllable | Moderate | Small-Medium | Medium | Low-Med | Strongest |

---

## Detailed Pros/Cons Per Option

## Option A — Keep split, add R2 latest snapshots

- Pros:
  - Lowest disruption.
  - Matches current data responsibilities.
  - Immediate public egress win by moving map/latest reads off Supabase endpoints.
  - Keeps existing chart/timeseries stitched path intact.
- Cons:
  - Duplication remains.
  - Two DB mental model remains operationally heavier.
- Implementation complexity: Medium.
- Operational risk: Low.
- Website load speed: High.
- Supabase egress effect: Strong reduction for public map/latest.
- Supabase DB size effect: Neutral short-term.
- R2 storage/ops cost: Moderate increase (new snapshot writes + reads).
- Worker request/CPU cost: Moderate increase from snapshot serving.
- GCP cost effect: Small increase (snapshot builder job).
- Free-tier fit: Good if snapshot key count is constrained.
- Debuggability: Good (DB truth + snapshot artifacts both visible).
- Realtime later: Easy (broadcast “snapshot updated” only).
- 60-second polling fallback: Fully supported.
- Future DO websocket notifications: Fully supported.

## Option B — Consolidate DBs, keep R2 snapshots/history

- Pros:
  - Cleaner logical model long-term.
  - Removes one class of cross-DB sync issues.
- Cons:
  - Migration risk is high (AQI helpers, RPCs, retention tooling, permissions, existing workers).
  - Temporary instability risk during cutover.
  - One DB may become the cost/size hotspot.
- Implementation complexity: High.
- Operational risk: Medium-High.
- Website load speed: High once done.
- Supabase egress effect: Similar to A after snapshot cutover.
- Supabase DB size effect: Consolidates into one larger footprint.
- R2 storage/ops cost: Similar to A.
- Worker request/CPU cost: Similar to A.
- GCP cost effect: Medium during migration period.
- Free-tier fit: Worse during migration; maybe better later if one DB can be pruned aggressively.
- Debuggability: Initially harder; later simpler.
- Realtime later: Good once stable.
- 60-second polling fallback: Supported.
- Future DO websocket notifications: Supported.

## Option C — R2-first / R2-heavy

- Pros:
  - Excellent public read scaling.
  - Very low Supabase endpoint-read dependency.
- Cons:
  - Higher write orchestration complexity.
  - Harder correction/backfill semantics for “latest” when many object variants exist.
  - Higher R2 class A exposure if too many objects are written per cycle.
- Implementation complexity: High.
- Operational risk: High.
- Website load speed: Very high.
- Supabase egress effect: Very low for public reads.
- Supabase DB size effect: Can be reduced if DB retention trimmed.
- R2 storage/ops cost: Can rise quickly.
- Worker request/CPU cost: Higher.
- GCP cost effect: Medium-high (more orchestration).
- Free-tier fit: Good only with strict key discipline.
- Debuggability: Medium-hard.
- Realtime later: Possible, but more moving parts.
- 60-second polling fallback: Supported.
- Future DO websocket notifications: Supported.

## Option D — R2-only / almost R2-only for observations

- Pros:
  - Maximum offload of public read traffic.
- Cons:
  - Hard for dedupe correctness, ad-hoc diagnostics, joins to metadata, targeted repairs, late corrections, and AQI recomputation workflows.
  - Loses many strengths of SQL for operational truth.
  - Raises blast radius when object/manifests are wrong.
- Implementation complexity: Very High.
- Operational risk: Very High.
- Website load speed: Potentially high.
- Supabase egress effect: Lowest.
- Supabase DB size effect: Lowest for observation rows.
- R2 storage/ops cost: Highest dependency.
- Worker request/CPU cost: High.
- GCP cost effect: Medium (may shift more logic off GCP but not free).
- Free-tier fit: Poor unless traffic and keyspace stay small.
- Debuggability: Poor.
- Realtime later: Harder to keep robust.
- 60-second polling fallback: Technically yes.
- Future DO websocket notifications: Yes, but brittle under data-correction scenarios.

## Option E — Recommended hybrid (committed-state snapshots + progressive simplification)

- Pros:
  - Captures nearly all public egress savings quickly.
  - Preserves proven DB-backed correctness for ingest/dedupe/AQI.
  - Adds realtime-readiness without forcing realtime now.
  - Lets you postpone risky DB consolidation until measured need.
- Cons:
  - Does not immediately remove all duplication.
  - Requires one new snapshot pipeline and observability surface.
- Implementation complexity: Medium.
- Operational risk: Low-Medium.
- Website load speed: High.
- Supabase egress effect: Best practical near-term reduction.
- Supabase DB size effect: Controlled; can reduce later with measured retention/partition policies.
- R2 storage/ops cost: Moderate and predictable if keyspace is bounded.
- Worker request/CPU cost: Moderate.
- GCP cost effect: Small-Medium.
- Free-tier fit: Best practical balance.
- Debuggability: Strong.
- Realtime later: Best fit (metadata broadcast + stable snapshot fetch).
- 60-second polling fallback: Fully supported.
- Future DO websocket notifications: Fully supported.

---

## R2 Snapshot-Source Recommendation (Direct Answers)

- Build latest snapshots from raw Pub/Sub messages? **No** (not source-of-truth safe).
- Build from committed `ingestdb` state? **Yes, for latest observation/map payloads.**
- Build from `obs_aqidb`? **Yes only for AQI-specific snapshot fields when needed.**
- Separate scheduled snapshot builder? **Yes, first version.**
- Trigger after successful flush later? **Yes, phase-2 improvement after baseline.**
- First version schedule every 60 seconds? **Yes** (fixed requirement-compatible), then evolve to triggered/debounced publish.
- Safest source of truth for public latest snapshots: **Committed DB state, not transient message stream.**

---

## 24-Hour Line Chart Snapshot Recommendation

### Should 24h chart data be added to R2 snapshots now?

- **Not in phase 1.** Start with latest map snapshots first.
- Add 24h chart snapshots later only for highest-traffic chart paths.

### Object-shape recommendation

- One object per pollutant only: **Good first step for latest map**, not enough for per-timeseries charts.
- One object per pollutant + network: **Reasonable later for map-group optimization**.
- One object per timeseries: **Do not do this at 60-second cadence**.

### Rough object-count / cost implications

Assume 60-second snapshot cadence:

- 3 objects/minute (pollutant-only latest): ~129,600 writes/month.
- 15 objects/minute (3 pollutants x 5 windows): ~648,000 writes/month.
- 21 objects/minute (3 pollutants x 7 groups): ~907,200 writes/month.
- ~4,894 objects/minute (per-timeseries): ~211M writes/month (not acceptable).

Given R2 class A pricing/free tier, per-timeseries near-realtime snapshots are cost-risky; bounded keyspaces are manageable.

### Frontend speed and Supabase egress impact

- Latest map snapshots: strong speed and egress improvement quickly.
- 24h per-timeseries snapshots: can speed charts but cost complexity is high; better to defer.
- Keep longer ranges on existing stitched history/R2 paths.

---

## Network Filtering and Cache-Key Strategy

## Strategy 1 — `networks=all` only, filter in browser

- Cache hit-rate: Best.
- R2 object count: Lowest.
- Browser payload size: Largest.
- Cost: Lowest ops complexity; great for free-tier protection.
- Recommendation: **Default now.**

## Strategy 2 — predefined groups (`all`, `official`, `community`, `aurn`, `openaq`, `breathelondon`, `sensorcommunity`)

- Cache hit-rate: Good if groups are fixed and few.
- R2 object count: Moderate.
- Browser payload size: Smaller per request.
- Cost: Manageable but watch class A writes if all groups are refreshed every minute.
- Recommendation: **Phase-later optimization, not phase-1 baseline.**

## Strategy 3 — arbitrary network combinations

- Cache hit-rate: Poor (combinatorial key explosion).
- R2 object count: High.
- Browser payload size: Potentially smaller per request, but fragmented cache hurts.
- Cost: Higher Worker/R2 ops.
- Recommendation: **Avoid for public default endpoints.**

---

## Cost / Free-Tier Practical Analysis

## Supabase egress

- Biggest near-term win is moving public `/latest` map traffic to cached R2 snapshots.
- Keep separating:
  - endpoint-response egress (`uk_aq_endpoint_egress_metrics_minute`)
  - write/upload payload metrics (`uk_aq_observation_rpc_metrics_minute`, ingress-side signal)
- In current last-24h sample, `uk_aq_latest` is the largest public-response endpoint by bytes.

## Supabase DB size

- Short term with Option E: stable.
- Medium term: tune retention/partition windows and reduce duplicate hot-window storage only after measuring freshness/correction needs.
- Avoid abrupt consolidation until AQI and history retention pipelines are proven equivalent in target DB.

## Cloudflare R2

- Storage is cheap; cost pressure is mostly operation counts (especially class B reads and class A writes).
- Keep snapshot keyspace small and stable.
- Avoid per-timeseries minute-level writes.

## Cloudflare Workers / Durable Objects

- Workers Free request limit can be exceeded quickly under continuous 60-second polling at scale.
- Paid baseline may be necessary once traffic grows; keep cache-hit ratio high to limit CPU and origin fetches.
- Durable Objects should be postponed until snapshot path is stable; when added, send metadata-only notifications.

## GCP (Cloud Run / Pub/Sub / Scheduler)

- Current pattern is friendly to small-cost operation if jobs stay lightweight and schedules are bounded.
- Extra scheduled snapshot job is usually cheap compared with DB egress avoided.
- Pub/Sub pricing impact is generally low at these payload sizes if batching remains effective.

---

## Recommended Target Architecture

## Best short-term (now)

- Adopt **Option E**:
  - Add R2 latest snapshots from committed DB state.
  - Serve via stable cache-proxy endpoint(s).
  - Keep existing stitched timeseries and AQI history paths.
  - Keep 60-second polling fallback as fixed policy.

## Best medium-term

- Add optional predefined network-group snapshots only if measurements show payload pressure.
- Add DO websocket notifications that broadcast only snapshot metadata.
- Re-evaluate DB consolidation after observability proves where duplication is truly unnecessary.

## What not to do

- Do not build latest snapshots directly from raw Pub/Sub messages.
- Do not do per-timeseries 60-second snapshot objects.
- Do not attempt immediate R2-only observations architecture.

## What to postpone

- DB consolidation migration.
- Arbitrary network-combination snapshot keys.
- Realtime transport implementation before stable snapshot rollout.

## What to measure before deciding consolidation

- Endpoint-response egress by path and cache status.
- Snapshot build latency, publish success rate, stale age.
- R2 class A/B operation counts by endpoint/key.
- Freshness lag between ingestdb latest and obs_aqidb/AQI.
- Chart request distributions by range/window.

---

## Recommended Phased Plan

## Phase 0 — Inventory + baselines

- Lock current baselines for endpoint egress, cache-hit ratio, R2 op counts, freshness lag.
- Add dashboards/alerts for snapshot age and fallback usage.

## Phase A — R2 latest snapshots (scheduled)

- Create snapshot builder every 60 seconds.
- Build from committed DB state.
- Start with bounded keyspace (`networks=all`, fixed pollutant/window set).
- Write manifest + ETag/hash metadata.

## Phase B — Stable cache-proxy endpoint

- Add `/api/aq/latest-snapshot` (or equivalent stable route).
- Keep cache keys stable, preserve ETag/304 behavior.
- Add bypass/debug control for forced refresh.

## Phase C — Website cutover

- Switch hex map latest fetch from cursor/delta `/latest` path to stable snapshot endpoint.
- Keep existing 60-second polling cadence.
- Keep old path available for rollback/debug temporarily.

## Phase D — Observability + rollback hardening

- Track snapshot freshness, cache hits, and payload sizes.
- Add health checks and automatic fallback to current DB-backed endpoint if snapshot stale/error thresholds are exceeded.

## Phase E — Optional 24h chart snapshots

- Only if metrics show clear value.
- Start with coarse bounded variants, not per-timeseries minute snapshots.
- Keep longer ranges on existing stitched history paths.

## Phase F — Realtime metadata notifications

- Add Durable Object channel broadcasting `snapshot_updated` metadata only.
- Browser immediately refetches stable snapshot endpoint.
- Keep mandatory 60-second polling fallback active.

---

## Public API / Interface Changes (Planned)

- Add stable latest snapshot route via cache proxy, e.g. `/api/aq/latest-snapshot`.
- Snapshot manifest contract including:
  - `snapshot_id`/etag/hash
  - `generated_at`
  - `pollutant`
  - `window`
  - optional `network_group`
- Future realtime message contract:
  - `type: snapshot_updated`
  - snapshot identity fields only (no full dataset payload).

---

## Validation / Acceptance Scenarios

1. Snapshot freshness stays within target (<= 60–120s under normal operations).
2. Website map loads from snapshot route with no regression in visible data correctness.
3. Supabase endpoint-response egress for public latest path drops materially after cutover.
4. Cache-hit ratio improves for latest path due stable keys.
5. Rollback switch restores previous DB-backed latest path quickly.
6. 60-second polling continues to function when websocket/realtime is absent.
7. AQI/chart correctness remains unchanged against current stitched behavior for sampled stations/timeseries.

---

## Open Questions / Decisions Still Needed

1. Should `openaq` remain `poll_enabled=false` in production intent, or is this temporary?
2. What exact snapshot key matrix is required at launch: pollutant-only, pollutant+window, and whether any network groups are required immediately?
3. What stale-age threshold should trigger automatic fallback to current DB-backed latest endpoint?
4. Should AQI in latest snapshot be embedded in v1 or remain fetched from current AQI path for now?
5. Is DB consolidation a 2026 objective, or explicitly deferred pending snapshot/cost telemetry?

---

## Files/Docs/Code Paths Inspected (Read-Only)

- [AGENTS.md](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq-ingest/AGENTS.md)
- [AGENTS.md](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema/AGENTS.md)
- [AGENTS.md](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/AGENTS.md)
- [AGENTS.md](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC%20UK-AQ%20Webpage/CIC-test-uk-aq/AGENTS.md)
- [uk_aq_cloudflare_scheduler_ingest_flow.md](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq-ingest/system_docs/uk_aq_cloudflare_scheduler_ingest_flow.md)
- [uk_aq_edge_functions.md](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq-ingest/system_docs/uk_aq_edge_functions.md)
- [run_job.ts](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq-ingest/workers/uk_aq_observs_pubsub_cloud_run/run_job.ts)
- [README.md](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq-ingest/workers/uk_aq_observs_pubsub_cloud_run/README.md)
- [index.ts](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq-ingest/supabase/functions/uk_aq_latest/index.ts)
- [index.ts](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq-ingest/supabase/functions/uk_aq_timeseries/index.ts)
- [uk_aq_core_schema.sql](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema/schemas/ingest_db/uk_aq_core_schema.sql)
- [uk_aq_rpc.sql](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema/schemas/ingest_db/uk_aq_rpc.sql)
- [uk_aq_obs_aqi_db_schema.sql](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema/schemas/obs_aqi_db/uk_aq_obs_aqi_db_schema.sql)
- [uk_aq_obs_aqi_db_ops_rpcs.sql](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema/schemas/obs_aqi_db/uk_aq_obs_aqi_db_ops_rpcs.sql)
- [uk-aq-cache-proxy.md](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/system_docs/uk-aq-cache-proxy.md)
- [index.ts](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/workers/uk_aq_cache_proxy/src/index.ts)
- [uk-aq-r2-history-layout.md](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/system_docs/uk-aq-r2-history-layout.md)
- [uk-aq-aqi-history-r2-api-worker.md](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/system_docs/uk-aq-aqi-history-r2-api-worker.md)
- [README.md](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/workers/uk_aq_observs_history_r2_api_worker/README.md)
- [server.mjs](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/workers/uk_aq_prune_daily/server.mjs)
- [phase_b_history_r2.mjs](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/workers/uk_aq_prune_daily/phase_b_history_r2.mjs)
- [uk_aq_observs_pubsub_cloud_run_deploy.yml](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq-ingest/.github/workflows/uk_aq_observs_pubsub_cloud_run_deploy.yml)
- [uk_aq_prune_daily_cloud_run_deploy.yml](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/.github/workflows/uk_aq_prune_daily_cloud_run_deploy.yml)
- [uk_aq_timeseries_aqi_hourly_cloud_run_deploy.yml](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/.github/workflows/uk_aq_timeseries_aqi_hourly_cloud_run_deploy.yml)
- [hex_map.html](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC%20UK-AQ%20Webpage/CIC-test-uk-aq/hex_map.html)
- [index.html](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC%20UK-AQ%20Webpage/CIC-test-uk-aq/index.html)
- [sensors_chart.html](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC%20UK-AQ%20Webpage/CIC-test-uk-aq/sensors_chart.html)

---

## Assumptions and Defaults Used

- Planning-only scope; no code/migration/deploy actions.
- 60-second website polling remains a fixed requirement.
- `erg_laqn` excluded as active ingest network for this review.
- “Egress” interpreted as Supabase billable egress (endpoint response bytes), not write upload bytes.
- Cost estimates are directional, not billing quotes.
- Snapshot design prioritizes stable cache keys and high cache-hit ratios over maximal per-user customization.

---

## External Pricing / Platform References Used

- Cloudflare Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
- Cloudflare Durable Objects pricing: https://developers.cloudflare.com/durable-objects/platform/pricing/
- Supabase egress usage/pricing: https://supabase.com/docs/guides/platform/manage-your-usage/egress
- Supabase pricing: https://supabase.com/pricing
- Google Cloud Run pricing: https://cloud.google.com/run/pricing
- Google Pub/Sub pricing: https://cloud.google.com/pubsub/pricing
- Google Cloud Scheduler pricing: https://cloud.google.com/scheduler/pricing
