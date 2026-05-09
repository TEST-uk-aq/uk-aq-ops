## 1) Executive Summary
Best Phase 0A/Phase A path is **Option 1D hybrid**, implemented now as **Option 1B Cloud Run scheduled builder** (every 60s), with later ingest-triggered debounced runs added on the same code path.

Key decisions:
- Build **latest snapshots from committed ingestdb state** via the same shape as `uk_aq_latest_rpc` (not raw Pub/Sub).
- Start with **3 pollutants x 3 windows x networks=all** (`pm25|pm10|no2` x `3h|6h|1d`).
- Use **stable keys + deterministic JSON + SHA-256 + ETag + unchanged-write skip**.
- Use **manifest-per-family + build report**.
- Handle partial failures by **keeping prior good entries**; do not publish broken pointers.
- For 24h chart cache: **defer rolling-from-latest design** for v1; it is non-authoritative and can miss intermediate points. If added early, build it from DB windows, not from `/latest` deltas only.

Why this is best:
- Lowest delivery risk.
- Strong Supabase egress reduction once website latest route is cut to R2-backed cache.
- Likely near-free GCP runtime for this workload; avoids Workers Free cron CPU limits.

## 2) Decision Table
| Decision Area | Recommended Option | Why |
|---|---|---|
| Builder location | **1D (start as 1B, evolve to 1D)** | 60s schedule now with low risk/cost; ingest-trigger later for freshness/efficiency. |
| Latest source | **2B using ingestdb RPC shape of 2A** | Correct, committed, already website-compatible. |
| Snapshot matrix | **3A** | High cache hit-rate, bounded object count, aligned with current main UX. |
| Compression | **4A now**, optionally 4B later | Lowest complexity; Cloudflare can compress to clients; add precompressed `.br` only if measured gain. |
| 24h chart in first release | **No (5A)** | Avoid correctness regressions and hidden data loss from minute sampling. |
| Manifest strategy | **6B + 6D** | Clean separation + debuggable run telemetry. |
| Failure handling | **7B + versioned pointer from 7D-lite** | No broken public state on partial failures, easy rollback. |

## 3) Detailed Option Analysis

### Section 1 — Builder location

| Option | Pros | Cons | Complexity/Risk | Supabase Egress Impact | DB-size Impact | Cost/Limits | Recommendation |
|---|---|---|---|---|---|---|---|
| 1A Cloudflare scheduled Worker | Native R2 binding, low latency to edge | Workers Free cron CPU limit is very restrictive for DB fetch/build/write; likely needs Paid | Medium runtime risk on Free | Large reduction after cutover; builder still does 9 periodic reads | None | Free-plan CPU/request limits are the blocker; Paid likely required | Good only if you already run Paid Workers for scheduled compute |
| 1B Cloud Run scheduled service | Existing pattern in your repos; easier long-running CPU budget; strong logs | Cross-cloud R2 credentials + signing needed | Low-medium | Same egress profile as 1A | None | Cloud Run likely within free tier for this shape; Scheduler job cost is small | **Best initial implementation** |
| 1C Ingest services write snapshots inline | Freshest possible updates | Coupled ingest+publish path; failure blast radius; difficult rollback semantics | High | Potentially lowest read egress, but high correctness risk | None | Operationally expensive when ingest bursts | Not recommended for Phase A |
| 1D Hybrid | Combines safe baseline + future low-latency trigger | Two trigger modes to govern later | Medium overall, low for Phase A | Best long-term efficiency | None | Start cheap/simple, optimize later | **Overall recommended architecture** |

### Section 2 — Latest snapshot source

| Option | Pros | Cons | Freshness/Correctness | Supabase Egress Impact | DB-size Impact | Recommendation |
|---|---|---|---|---|---|---|
| 2A `/latest` endpoint or its RPC shape | Exact payload compatibility | Extra function hop overhead | Correct if endpoint healthy | Slightly higher than direct RPC due hop | None | Use shape, but call direct RPC in builder |
| 2B ingestdb tables/RPCs direct | Committed latest source; no extra function layer | Must keep contract parity with frontend | Best for latest-map truth | Lowest among DB-based options | None | **Best for latest snapshots** |
| 2C obs_aqidb | Good for recent history/AQI windows | Not the freshest operational latest | Can lag latest | More/heavier reads for latest use case | None | Better for chart/AQI, not map-latest |
| 2D Raw Pub/Sub messages | Very fresh arrival stream | Not canonical, ordering/replay/gaps risk | Unsafe as source of truth | Could avoid DB reads but correctness poor | None | **Do not use** |
| 2E Existing R2 history | Cheap reads | Not realtime latest | Stale for latest | Lowest DB reads but wrong freshness | None | Not suitable for latest |

Direct answers:
- Raw Pub/Sub as source of truth: **No**.
- Is ingestdb best for latest-map snapshots: **Yes**.
- Is obs_aqidb better for 24h chart/AQI: **Yes, for authoritative recent history/AQI**.
- Should first implementation query same shape as `/latest`: **Yes** (contract compatibility is key).

### Section 3 — Latest object matrix and keys

| Option | Pros | Cons | Cache Hit-rate | R2 Ops/Object Count | Frontend Complexity | Realtime Compatibility | Recommendation |
|---|---|---|---|---|---|---|---|
| 3A 3 pollutants x 3 windows x all | Bounded, high utility, easy rollout | Does not cover 7d/all initially | High | Low/controlled | Low | Good | **Best start** |
| 3B Add 7d/all now | More parity with all UI states | More build reads/writes, larger payloads | Medium | Higher | Medium | Good | Defer until measured need |
| 3C Default only | Very cheap | Product regression in UI flexibility | Very high for one key, poor coverage | Lowest | High fallback logic | Weak | Too narrow |
| 3D Predefined network groups now | Future-proof keys | More objects immediately | Lower per-key | Medium-high | Medium | Good | Add later after all-only stabilizes |
| 3E Arbitrary combinations | Maximum flexibility | Cache fragmentation, key explosion | Low | Very high | High | Hard | Avoid |

### Section 4 — Compression/storage format

| Option | Pros | Cons | Browser/Serve Complexity | R2 Cost/Worker CPU | Recommendation |
|---|---|---|---|---|---|
| 4A Plain JSON only | Simplest, debuggable, deterministic | Larger transfer than precompressed | Lowest | Lowest write complexity | **Start here** |
| 4B JSON + `.json.br` | Better transfer for some clients | Double object management + manifest complexity | Medium | More Class A writes/storage metadata | Add only if measured benefit warrants |
| 4C Brotli only | Small payloads | Compatibility/ops complexity, harder debugging | High | Medium-high | Avoid for v1 |
| 4D JSONL/chunked JSON | Better stream/update patterns | More parsing complexity in UI/worker | Medium-high | Neutral | Not needed for v1 latest |
| 4E Parquet/columnar for 24h | Efficient analytics storage | Browser consumption not native, conversion needed | High | Higher build/serve complexity | Not for public chart v1 |

### Section 5 — Rolling 24-hour chart cache

Core judgement: **“Build 24h cache from latest every 60s” is not authoritative.** It can lose intermediate observations and late corrections if `/latest` only exposes newest state.

| Option | Pros | Cons | Correctness | Missing-run/late-data behavior | Egress/DB-size | Cost/Limits | Recommendation |
|---|---|---|---|---|---|---|---|
| 5A No 24h cache now | Lowest risk | No chart offload yet | Strong (existing path unchanged) | Existing proven behavior | No change now | Lowest | **Recommended for Phase A** |
| 5B Single 24h object per pollutant | Simple | Rebuild/merge hotspots | Medium | Gaps if runs missed | Some DB offload once used | Moderate | Possible later |
| 5C Per pollutant + network group | Scalable grouping | More objects/ops | Medium | Similar to 5B | Better selective reads | Moderate-high | Later when groups needed |
| 5D Minute tick objects + manifest | Append-friendly | Many objects, high Class A/B | Medium-high | Better missed-run recovery | Good cacheability, more ops | Higher ops cost | Too complex for first release |
| 5E Hour chunks + current ticks | Balanced reads/writes | Chunk stitching logic | High if DB-sourced | Better resilience | Good long-term | Medium-high | Good Phase B candidate |
| 5F Per-timeseries 24h objects | Fast station reads | Massive key count | High but heavy footprint | Good | High R2 ops/object count | High | Avoid |
| 5G Durable Object SQLite rolling store | Strong realtime path | Stateful ops complexity | Medium-high | Better continuity | Not DB-size heavy | Worker plan/limits sensitive | Phase C/realtime only |
| 5H Query DB for 24h each run then publish | Authoritative snapshots | More DB read cost per run | **High** | Handles missed runs/late data best | Higher read egress than latest-only | Moderate | Best 24h method if you include 24h early |

Direct answers:
- Does latest-only rolling 24h work: **Partially**.
- Accurate enough for line charts: **Only if data cadence is <= polling cadence and no corrections**.
- If sensors report >1/min: **Intermediate points can be lost**.
- Multiple observations between polls with `/latest` newest-only: **Older points are dropped**.
- If builder misses 5–10 minutes: **Gap unless backfilled from authoritative history**.
- Should 24h cache be non-authoritative: **Yes**.
- First object shape if you still include 24h now: **5H-style authoritative snapshot per pollutant (`chart24h/v1/network_group=all/pollutant=<p>.json`) with explicit `source_window` metadata**.

### Section 6 — Manifest design

| Option | Pros | Cons | Proxy/Frontend Ease | Failure/Debug | Recommendation |
|---|---|---|---|---|---|
| 6A One global manifest | Single lookup | Big blast radius on write errors | Medium | Weaker isolation | Not ideal |
| 6B One manifest per family | Scoped updates | Multiple files | High | Better isolation | **Best** |
| 6C Per pollutant/window manifests | Granular | Too many pointers | Medium | Debug noisy | Avoid for v1 |
| 6D Manifest + per-run build report | Great observability/rollback context | Extra writes/storage | High | Excellent | **Add** |

Manifest fields you listed are correct; keep all, plus:
- `source_query_contract_version`
- `response_complete` (for partial scans)
- `previous_object_key` (optional for rollback trace)
- `warnings[]`

### Section 7 — Failure and rollback

| Option | Pros | Cons | Stale/Broken Risk | Rollback | Recommendation |
|---|---|---|---|---|---|
| 7A Fail whole build | Atomicity | Drops all freshness on one failure | High stale risk | Simple | Not preferred |
| 7B Partial write, keep previous failed entries | Preserves good data | Requires merge logic | Low broken risk | Good | **Best baseline** |
| 7C Only publish when all succeed | Strong consistency | Stale on any partial issue | Medium-high stale risk | Simple | Use only for strict atomic families |
| 7D Versioned manifests + current pointer | Safe promotion/rollback | Extra pointer management | Low broken risk | Excellent | **Use with 7B** |

## 4) Cost/Limits Estimate (Recommended Shape)

Assumptions:
- 60s schedule, 3 pollutants x 3 windows, latest only.
- Builder does direct RPC reads and changed-only writes.

Estimated monthly:
- Runs: `1,440/day`, `43,200/month`.
- DB calls per run: `~9` latest RPC calls.
- R2 writes per run: worst `10` (9 snapshots + 1 manifest), typical `3–5` with unchanged-skip.
- R2 reads per run: `1–4` (manifest + occasional HEAD/GET checks).
- R2 Class A/month: worst `~432k`; typical `~130k–220k`.
- R2 Class B/month (builder side): `~43k–170k`.
- Snapshot storage growth: current-pointer model is small (typically tens of MB). Build reports add linear growth (roughly tens of MB/month depending report size).

Platform limits/cost posture:
- Workers Free cron CPU (`10ms`) is high risk for this job class.
- Cloud Run request-based + Cloud Scheduler is likely low cost for this workload; Scheduler adds small per-job monthly cost beyond free-job allowance.
- Supabase egress: major reduction after website latest route moves to R2-backed endpoint; remaining egress mostly builder fetches, not per-visitor polling.

## 5) Recommended Phase 0A/Phase A Implementation Shape

- Builder location: **Cloud Run scheduled HTTP service now**, code structured for later ingest-trigger debounce (Hybrid 1D).
- Latest source: **ingestdb via `uk_aq_latest_rpc` contract-compatible payload**.
- Matrix: **`pm25|pm10|no2` x `3h|6h|1d` x `network_group=all`**.
- Keys: stable, explicit dimensions in path; reserve dimensions for future groups.
- Format: deterministic plain JSON now; ETag + SHA-256.
- Write policy: compare hash; skip unchanged object writes.
- Manifest: per-family manifest + per-run build report.
- Failure handling: 7B + versioned manifest pointer pattern.
- 24h cache: **defer in first cut**. If included, use authoritative DB 24h window snapshots (5H), not latest-rolling only.
- Rollout:
1. Publish snapshots and manifests without website cutover.
2. Add cache-proxy route(s) for latest snapshot read.
3. Cut website latest calls to snapshot route.
4. Measure egress, latency, cache-hit, drift vs current latest.
5. Decide whether to add authoritative 24h cache.

## 6) What Should Be Explicitly Avoided

- Raw Pub/Sub as latest source of truth.
- Arbitrary network-combination keys.
- “24h from latest-only minute polling” treated as authoritative history.
- Whole-build invalidation on single snapshot failure.
- Brotli-only storage for public web v1.
- Coupling snapshot writes directly into ingest hot path for Phase A.

## 7) Open Questions

1. Do you want `7d` window served by old path during Phase A, or included in snapshot matrix from day one?
2. Is your Cloudflare account already on Workers Paid? (Changes whether 1A is viable at all.)
3. For Phase A cutover, should `/api/aq/latest` be switched directly, or introduced under a new route first for side-by-side validation?
4. How long should per-run build reports be retained in R2?

## 8) Files/Code/Docs Inspected

- [uk_aq_cache_proxy/src/index.ts](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/workers/uk_aq_cache_proxy/src/index.ts)
- [uk-aq-cache-proxy.md](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/system_docs/uk-aq-cache-proxy.md)
- [uk_aq_latest/index.ts](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq-ingest/supabase/functions/uk_aq_latest/index.ts)
- [uk_aq_stations_chart/index.ts](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq-ingest/supabase/functions/uk_aq_stations_chart/index.ts)
- [uk_aq_timeseries/index.ts](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq-ingest/supabase/functions/uk_aq_timeseries/index.ts)
- [uk_aq_rpc.sql](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema/schemas/ingest_db/uk_aq_rpc.sql)
- [run_job.ts](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq-ingest/workers/uk_aq_observs_pubsub_cloud_run/run_job.ts)
- [uk_aq_edge_functions.md](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq-ingest/system_docs/uk_aq_edge_functions.md)
- [wrangler.toml](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq-ingest/workers/uk_aq_dispatcher/wrangler.toml)
- [uk_aq_observs_history_r2_api_worker/README.md](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/workers/uk_aq_observs_history_r2_api_worker/README.md)
- [uk_aq_aqi_history_r2_api_worker/README.md](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/workers/uk_aq_aqi_history_r2_api_worker/README.md)
- [hex_map.html](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC%20UK-AQ%20Webpage/CIC-test-uk-aq/hex_map.html)
- [index.html](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC%20UK-AQ%20Webpage/CIC-test-uk-aq/index.html)
- [sensors_chart.html](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC%20UK-AQ%20Webpage/CIC-test-uk-aq/sensors_chart.html)
- [uk_aq_r2_core_snapshot.yml](/Users/mikehinford/Dropbox/Projects/CIC%20Website/CIC%20Air%20Quality%20Networks/CIC-test-uk-aq%20Operations/CIC-test-uk-aq-ops/.github/workflows/uk_aq_r2_core_snapshot.yml)

External references used for limits/pricing:
- Cloudflare Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare Workers pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
- Cloudflare R2 S3 API compatibility: https://developers.cloudflare.com/r2/api/s3/api/
- Cloud Scheduler pricing: https://cloud.google.com/scheduler/pricing
- Cloud Run pricing: https://cloud.google.com/run/pricing
- Cloud Run billing settings: https://docs.cloud.google.com/run/docs/configuring/billing-settings
- Cloudflare compression behavior: https://developers.cloudflare.com/speed/optimization/content/compression/

## 9) Assumptions

- Date of analysis: **May 9, 2026**.
- You want to optimize **Supabase billable egress**, not upload ingress metrics.
- Phase A prioritizes correctness and safe cutover over maximum initial feature scope.
- `network_group=all` is the only group in initial rollout.
- Realtime is deferred; 60-second polling remains mandatory fallback.
- Existing stitched chart path (`ingestdb + obs_aqidb + R2 history`) remains authoritative until explicitly replaced.
- No active erg_laqn network in this phase’s design.
