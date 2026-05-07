# UK-AQ R2 Snapshots & Realtime Updates Plan

**Status:** Draft plan  
**Goal:** keep the public UK-AQ website as up-to-date as practical while sharply reducing Supabase egress and avoiding fragmented Cloudflare cache keys.

## 1. Executive summary

The recommended architecture is:

1. **Publish stable latest-data snapshots to Cloudflare R2.**
2. **Serve those snapshots through the existing Cloudflare cache proxy using stable cache keys.**
3. **Remove `since` / `since_id` from the public website's main latest-data request path.**
4. **Keep 60-second polling as the default reliable mode and future fallback.**
5. **Add realtime update notifications later using a Durable Object WebSocket broadcaster.**
6. **In realtime mode, push only “new snapshot available” messages, not the full AQ dataset.**
7. **Browsers fetch the updated snapshot via the same stable cached endpoint.**

This gives a clean phased path:

- **Phase A:** R2 snapshots.
- **Phase B:** stable cache proxy endpoint.
- **Phase C:** website switch from `/latest` with cursors to `/latest-snapshot` without cursors.
- **Phase D:** observability and purge/debug controls.
- **Phase E:** realtime notifications with 60-second polling fallback.
- **Phase F:** optional payload reduction by serving map summaries first and sensor details on demand.

The main principle is: **Cloudflare edge/R2 should absorb public website traffic; Supabase should not be hit by every browser refresh or polling cycle.**

---

## 2. Current issue being solved

The website currently makes repeated latest-data calls and uses client-side cursor state such as `since` and `since_id`. That helps reduce response size for an individual browser session, but it fragments public cache keys because different browsers can end up asking for different URLs.

Typical current public latest request shape:

```text
/api/aq/latest?pollutant=pm25&window=6h&scope=all&limit=10000&since=...&since_id=...
```

The problem is not only the 60-second polling. The bigger problem is that many small URL variations reduce cache sharing. A stable snapshot endpoint should instead look like:

```text
/api/aq/latest-snapshot?pollutant=pm25&window=6h&scope=all
```

or, later:

```text
/api/aq/latest-map-summary?pollutant=pm25&window=6h&area=pcon
/api/aq/latest-map-summary?pollutant=pm25&window=6h&area=la&region=london
```

---

## 3. Target architecture

```text
Ingest jobs / post-ingest snapshot builder
  |
  | writes stable JSON snapshots
  v
Cloudflare R2 bucket
  |
  | read by cache proxy
  v
Cloudflare Worker cache proxy
  |
  | stable cache keys, ETag, Cache-Control
  v
Website browsers
  |
  | Phase E only: optional websocket notification
  v
Durable Object realtime broadcaster
```

### Data path in normal polling mode

```text
1. Ingest updates sensors in Supabase.
2. Snapshot builder creates fresh latest snapshots.
3. Snapshot builder writes snapshots and a manifest to R2.
4. Website polls every 60 seconds.
5. Cache proxy serves `/latest-snapshot` from edge cache or R2.
6. Browser uses ETag / 304 where possible.
```

### Data path in later realtime mode

```text
1. Ingest updates sensors in Supabase.
2. Snapshot builder creates fresh latest snapshots.
3. Snapshot builder writes snapshots and a manifest to R2.
4. Snapshot builder sends a small update event.
5. Durable Object broadcasts “snapshot updated” to connected browsers.
6. Browser fetches `/latest-snapshot` using ETag.
7. If websocket fails, browser falls back to 60-second polling.
```

---

## 4. Decisions to make before implementation

These decisions do not block writing the plan, but they should be made before coding each phase.

### Decision 1 — Where are snapshots generated?

#### Option 1A — Generate snapshots inside each ingest job

Each ingest job updates Supabase, then also updates relevant R2 snapshots.

**Pros**

- Snapshot is updated immediately after ingest.
- Fewer separate scheduled jobs.
- Conceptually simple: source update and public snapshot update happen together.

**Cons**

- Each ingest worker needs R2 credentials/bindings or a snapshot-publish API.
- More duplicated logic unless snapshot generation is shared.
- If one ingest job fails halfway through, snapshot freshness can vary by connector.

**Supabase egress impact**

- Good reduction for public website traffic once website uses R2 snapshots.
- Snapshot generation still reads from Supabase, but only from controlled ingest/snapshot jobs, not from every public browser.

**Supabase DB size impact**

- Neutral. Does not add Supabase tables unless logging is added.

**Cloudflare paid/cost items**

- R2 writes and storage.
- Possibly Worker requests if ingest calls a Cloudflare snapshot-publish endpoint.

**Recommendation**

- Not the first choice unless existing ingest workers already have a clean shared post-ingest hook.

#### Option 1B — Generate snapshots in a separate scheduled snapshot builder

A Cloud Run job, Cloudflare Worker Cron, or other scheduled job runs after ingest and writes snapshots to R2.

**Pros**

- Keeps ingest jobs focused on ingestion.
- Easier to retry and observe independently.
- One place to define snapshot schema and object keys.
- Safer rollout: can compare R2 snapshots against current `/latest` before switching website.

**Cons**

- Slightly less immediate unless triggered after ingest.
- Another deployable component.
- Needs coordination with ingest schedule.

**Supabase egress impact**

- Strong reduction for public website traffic after cutover.
- Snapshot builder will query Supabase on a schedule, but this is predictable and small compared with public traffic.

**Supabase DB size impact**

- Neutral unless adding audit tables.

**Cloudflare paid/cost items**

- R2 writes/storage.
- Worker requests if implemented as Worker Cron.
- If implemented in Cloud Run, Google Cloud runtime/network costs may apply.

**Recommendation**

- **Recommended for Phase A.** Start with a separate snapshot builder so behaviour can be tested before changing the website.

#### Option 1C — Generate snapshots on-demand in the cache proxy and write-through to R2

The first request after expiry causes the Worker to query Supabase, generate a snapshot, write it to R2, and serve it.

**Pros**

- No separate snapshot job.
- Snapshot only generated when needed.

**Cons**

- First user after expiry pays the slow path.
- Can cause stampedes unless locking is added.
- Harder to keep Supabase egress predictable.
- More complexity inside the public request path.

**Supabase egress impact**

- Better than current behaviour if lock/coalescing works, but worse than scheduled snapshots.

**Supabase DB size impact**

- Neutral.

**Cloudflare paid/cost items**

- Worker CPU/duration.
- R2 writes/reads.
- Potential Durable Object cost if locking is implemented with Durable Objects.

**Recommendation**

- Avoid for the first version.

---

### Decision 2 — What snapshot granularity should be written?

#### Option 2A — Full latest rows per pollutant/window/scope

Example objects:

```text
latest/v1/scope=all/window=6h/pollutant=pm25.json
latest/v1/scope=all/window=6h/pollutant=pm10.json
latest/v1/scope=all/window=6h/pollutant=no2.json
```

**Pros**

- Closest to current website data model.
- Easier cutover.
- Lowest implementation risk.

**Cons**

- Larger payloads than the map strictly needs.
- Browser still performs more filtering/aggregation.
- Higher R2 reads/edge bandwidth than summary payloads, though R2 has no egress bandwidth charge.

**Supabase egress impact**

- Large reduction because public traffic no longer hits Supabase for latest rows.

**Supabase DB size impact**

- Neutral.

**Cloudflare paid/cost items**

- R2 storage and operations.
- Worker requests and CPU.

**Recommendation**

- **Recommended first cut.** It keeps the migration simple.

#### Option 2B — Map summaries first, sensor rows on click

Example objects/endpoints:

```text
latest-map-summary/v1/area=pcon/window=6h/pollutant=pm25.json
latest-map-summary/v1/area=la/region=london/window=6h/pollutant=pm25.json
latest-area-sensors/v1/area=pcon/code=E140....../window=6h/pollutant=pm25.json
```

**Pros**

- Much smaller initial page payload.
- Better for mobile and high traffic.
- Reduces repeated transfer of detailed sensor rows that most users never inspect.

**Cons**

- Requires more front-end changes.
- More object variants.
- Need a sensor-detail fetch path for clicked hex/local authority.

**Supabase egress impact**

- Excellent after cutover.
- Snapshot builder queries controlled data once; public users read from Cloudflare.

**Supabase DB size impact**

- Neutral.

**Cloudflare paid/cost items**

- More R2 objects and operations.
- Potentially fewer bytes read overall.

**Recommendation**

- **Recommended after stable snapshots are working.** Make this Phase F, not Phase A.

#### Option 2C — One giant all-pollutant/all-window snapshot

One object contains everything the page might need.

**Pros**

- One fetch can populate the app.
- Very simple cache key.

**Cons**

- Downloads data the user may not need.
- Any update invalidates the entire object.
- Bad for mobile and slower connections.

**Supabase egress impact**

- Good reduction against Supabase, but not optimal for user bandwidth/Cloudflare operations.

**Supabase DB size impact**

- Neutral.

**Cloudflare paid/cost items**

- Fewer R2 read operations, larger object transfers.

**Recommendation**

- Avoid.

---

### Decision 3 — Should snapshots be compressed in R2?

#### Option 3A — Store plain JSON only

**Pros**

- Easiest to inspect and debug.
- Browser/Worker handling is simple.

**Cons**

- Larger object reads and transfers.
- More bandwidth through Worker/edge path.

**Supabase egress impact**

- No direct impact once public traffic is off Supabase.

**Supabase DB size impact**

- Neutral.

**Cloudflare paid/cost items**

- R2 charges operations/storage, not egress bandwidth, but bigger objects may increase CPU/time and user transfer.

**Recommendation**

- Acceptable for initial testing only.

#### Option 3B — Store JSON plus precompressed Brotli or gzip

Example:

```text
latest/v1/scope=all/window=6h/pollutant=pm25.json
latest/v1/scope=all/window=6h/pollutant=pm25.json.br
```

**Pros**

- Smaller responses.
- Avoids compressing on every request.
- Good for public traffic.

**Cons**

- Slightly more snapshot-builder work.
- Need correct `Content-Encoding` handling.
- Need uncompressed copy or good tooling for debugging.

**Supabase egress impact**

- No direct impact once public traffic is off Supabase.

**Supabase DB size impact**

- Neutral.

**Cloudflare paid/cost items**

- More R2 objects/storage, but likely small.
- Lower Worker CPU than runtime compression.

**Recommendation**

- **Recommended for production.** Keep plain JSON in staging or alongside `.br` for debugging.

---

### Decision 4 — How fresh should public snapshots be?

#### Option 4A — Snapshot every 60 seconds

**Pros**

- Matches current 60-second polling mental model.
- Good enough for AQ map UX.
- Predictable.

**Cons**

- May write snapshots even when no data changed unless builder detects changes.

**Supabase egress impact**

- Controlled and predictable.

**Supabase DB size impact**

- Neutral.

**Cloudflare paid/cost items**

- R2 Class A writes for each snapshot written.
- Worker/Cloud Run job invocations.

**Recommendation**

- **Recommended initial target.** Skip writes when the content hash/ETag has not changed.

#### Option 4B — Snapshot only after ingest completes

**Pros**

- No pointless writes when data has not changed.
- Fastest freshness after actual updates.

**Cons**

- Requires clean ingest-complete signalling.
- More coupling between ingest and snapshot builder.

**Supabase egress impact**

- Best controlled pattern.

**Supabase DB size impact**

- Neutral.

**Cloudflare paid/cost items**

- Fewer R2 writes than fixed schedule if ingest is less frequent.
- Possible Queue operations if using a queue event.

**Recommendation**

- Good later improvement. Start with scheduled snapshots, then trigger after ingest when stable.

---

### Decision 5 — How should the realtime notification be delivered?

#### Option 5A — Keep polling only

Website polls `/latest-snapshot` every 60 seconds.

**Pros**

- Simple.
- Reliable.
- Easy to debug.
- No live connection cost.

**Cons**

- Browsers still ask even when nothing changed.
- Update delay is up to 60 seconds.

**Supabase egress impact**

- Very low after R2 snapshot cutover.

**Supabase DB size impact**

- Neutral.

**Cloudflare paid/cost items**

- Worker requests every 60 seconds per active browser.
- R2 reads on cache miss.

**Recommendation**

- **Keep this as default/fallback.**

#### Option 5B — Durable Object WebSocket notification channel

Browsers connect to a Durable Object. When a snapshot changes, the Durable Object broadcasts a small message.

Example message:

```json
{
  "type": "snapshot_updated",
  "pollutant": "pm25",
  "window": "6h",
  "scope": "all",
  "etag": "abc123",
  "updated_at": "2026-05-07T20:31:00Z"
}
```

**Pros**

- Near-realtime UX.
- Avoids polling when no data has changed.
- Can keep 60-second polling as fallback.
- Durable Object WebSocket hibernation can reduce idle connection duration cost.

**Cons**

- More moving parts.
- Need reconnect/backoff logic.
- Need channel design and limits.
- Need to avoid broadcasting full datasets.

**Supabase egress impact**

- No direct Supabase impact if browsers still fetch from R2 snapshots.
- Reduces unnecessary Cloudflare Worker requests compared with polling-only.

**Supabase DB size impact**

- Neutral.

**Cloudflare paid/cost items**

- Durable Object compute/storage billing.
- Worker requests for websocket connects and update publish calls.
- Potential Queue operations if update events are queued.

**Recommendation**

- **Recommended after R2 snapshots and stable cache keys are working.** Do not implement realtime first.

#### Option 5C — Server-Sent Events

Browser opens an event stream and receives one-way update events.

**Pros**

- One-way stream fits this use case.
- Simpler browser API than WebSockets.

**Cons**

- Long-lived streaming through Workers can be awkward.
- Durable Object WebSockets are a cleaner Cloudflare-native choice for many connected clients.

**Supabase egress impact**

- Similar to WebSocket notification mode.

**Supabase DB size impact**

- Neutral.

**Cloudflare paid/cost items**

- Worker duration/request costs for open streams may matter.

**Recommendation**

- Do not use initially.

---

### Decision 6 — How should update events reach the realtime broadcaster?

#### Option 6A — Snapshot builder directly calls broadcaster endpoint

Snapshot builder calls:

```text
POST /api/aq/realtime/publish
```

**Pros**

- Simple.
- No Queue required.
- Good enough for low update volume.

**Cons**

- If broadcaster call fails, update notification may be lost.
- Needs retry logic.

**Supabase egress impact**

- Neutral.

**Supabase DB size impact**

- Neutral.

**Cloudflare paid/cost items**

- Worker request and Durable Object invocation.

**Recommendation**

- Fine for the first realtime implementation.

#### Option 6B — Snapshot builder sends message to Cloudflare Queue

Snapshot builder writes a queue message; queue consumer publishes to Durable Object.

**Pros**

- More reliable delivery.
- Better decoupling.
- Easier retries.

**Cons**

- More Cloudflare components.
- Queue operation costs after included usage.

**Supabase egress impact**

- Neutral.

**Supabase DB size impact**

- Neutral.

**Cloudflare paid/cost items**

- Queue operations.
- Worker request/CPU for queue consumer.
- Durable Object costs.

**Recommendation**

- Add if direct publish proves unreliable or if multiple ingest jobs need decoupled update delivery.

---

### Decision 7 — Keep or remove the existing cursor/delta endpoint?

#### Option 7A — Remove cursor/delta use from public website, keep backend endpoint for admin/testing

**Pros**

- Public website becomes simple and cacheable.
- Existing logic is not destroyed immediately.
- Safer rollback/debug option.

**Cons**

- Maintains two paths for a while.

**Supabase egress impact**

- Strong reduction because public traffic moves to snapshots.

**Supabase DB size impact**

- Neutral.

**Cloudflare paid/cost items**

- Neutral.

**Recommendation**

- **Recommended.**

#### Option 7B — Delete cursor/delta endpoint entirely

**Pros**

- Less code long term.

**Cons**

- Riskier rollout.
- Removes a useful comparison/debug path.

**Supabase egress impact**

- Similar after public cutover.

**Supabase DB size impact**

- Neutral.

**Cloudflare paid/cost items**

- Neutral.

**Recommendation**

- Only after snapshots have been stable for a while.

---

## 5. Recommended decisions

| Decision | Recommendation |
|---|---|
| Snapshot generation | Separate scheduled snapshot builder first; later trigger after ingest. |
| Initial snapshot granularity | Full latest rows per pollutant/window/scope. |
| Production compression | Precompressed Brotli plus optional plain JSON for debugging. |
| Freshness | 60-second target; skip writes when content hash unchanged. |
| Realtime transport | Durable Object WebSockets later. |
| Realtime message contents | Push metadata only, not full data. |
| Fallback | Keep 60-second polling permanently as fallback. |
| Existing `since` path | Remove from public website path; keep temporarily for admin/debug. |

---

## 6. Phase plan

## Phase A — Build R2 latest snapshot publisher

### Goal

Create R2 objects that represent the current public website latest data with stable object keys.

### Scope

- Add a snapshot builder job.
- Query the current latest data source once per pollutant/window/scope.
- Write deterministic JSON snapshots to R2.
- Write a small manifest to R2.
- Include ETag/content hash metadata.
- Avoid rewriting unchanged snapshots where possible.

### Initial snapshot set

Pollutants:

```text
pm25
pm10
no2
```

Windows:

```text
3h
6h
1d
7d
all
```

Scope:

```text
all
```

Initial object key pattern:

```text
latest/v1/scope=all/window={window}/pollutant={pollutant}.json
latest/v1/scope=all/window={window}/pollutant={pollutant}.json.br
```

Manifest:

```text
latest/v1/manifest.json
```

Example manifest:

```json
{
  "schema_version": 1,
  "generated_at": "2026-05-07T20:31:00Z",
  "snapshots": {
    "all:6h:pm25": {
      "key": "latest/v1/scope=all/window=6h/pollutant=pm25.json.br",
      "content_type": "application/json; charset=utf-8",
      "content_encoding": "br",
      "etag": "\"abc123\"",
      "row_count": 1234,
      "last_updated": "2026-05-07T20:30:45Z"
    }
  }
}
```

### Acceptance criteria

- R2 has snapshots for all required pollutant/window combinations.
- Snapshot JSON shape matches current website expectations closely enough for a low-risk cutover.
- Manifest is written after snapshots are successfully written.
- Unchanged snapshots are not rewritten unnecessarily.
- Snapshot builder can be run manually.
- Snapshot builder logs row counts, content hash, duration, and errors.

### Supabase egress effect

- Public website egress does not improve until the website switches to the snapshot endpoint.
- Snapshot builder creates a predictable controlled Supabase read workload.

### Cloudflare cost items

- R2 Class A writes for object writes.
- R2 storage.
- If snapshot builder runs inside Cloudflare Workers, Worker requests/CPU.
- If using Cloud Run, Google Cloud costs also apply.

---

## Phase B — Add stable cache proxy snapshot endpoint

### Goal

Expose R2 snapshots via the existing cache proxy using stable cache keys and HTTP validators.

### New public endpoint

```text
/api/aq/latest-snapshot?pollutant=pm25&window=6h&scope=all
```

### Behaviour

- Validate `pollutant`, `window`, and `scope`.
- Map parameters to an R2 object key.
- Serve Brotli when browser supports it, otherwise JSON fallback if available.
- Return stable `ETag`.
- Honour `If-None-Match` and return `304` when possible.
- Set cache headers.
- Use Worker Cache API with a canonical cache key that excludes irrelevant query params.
- Add diagnostic headers.

Example headers:

```text
Cache-Control: public, max-age=60, stale-while-revalidate=30, stale-if-error=300
ETag: "abc123"
X-UK-AQ-Cache: HIT|MISS|BYPASS
X-UK-AQ-Source: r2-snapshot
X-UK-AQ-Snapshot-Key: latest/v1/scope=all/window=6h/pollutant=pm25.json.br
```

### Explicit bypass

Keep an explicit debug/admin bypass path:

```text
/api/aq/latest-snapshot?pollutant=pm25&window=6h&scope=all&cache=bypass
X-UK-AQ-Bypass-Token: <secret>
```

### No public cursor support

The snapshot endpoint must ignore/reject cursor-style public behaviour. It should not accept `since` or `since_id` as part of the cacheable public path.

Recommended behaviour:

- If `since` or `since_id` is present, either:
  - return `400 cursor_not_supported_on_snapshot_endpoint`, or
  - ignore them and add `X-UK-AQ-Ignored-Params: since,since_id`.

Recommendation: **return 400 at first**, so accidental old front-end calls are caught during testing.

### Acceptance criteria

- Same request URL produces same cache key across browsers.
- No `since` / `since_id` fragmentation.
- `If-None-Match` works.
- `cache=bypass` requires secret header.
- R2 missing object returns useful error and does not poison cache.
- CORS still works for the website origins.
- Existing `/latest` remains available during migration.

### Supabase egress effect

- Strong reduction once website uses this endpoint.
- Cache proxy no longer needs to hit Supabase for public latest snapshot traffic.

### Cloudflare cost items

- Worker requests/CPU.
- R2 Class B reads on edge cache miss.
- R2 storage.

---

## Phase C — Switch website latest data loading to snapshots

### Goal

Change the public website from cursor/delta latest requests to stable snapshot requests.

### Front-end changes

Current style to remove from public map path:

```text
/latest?...&limit=10000&since=...&since_id=...
```

New style:

```text
/latest-snapshot?pollutant={pollutant}&window={window}&scope=all
```

### Behaviour

- Keep current 60-second polling.
- Use `If-None-Match` from previous snapshot response.
- On `304`, reuse current in-memory data.
- On `200`, replace latest rows from full snapshot.
- Remove merge logic for public latest cursor deltas in the main path.
- Keep existing network filters and map rendering behaviour.
- Keep local in-browser short cache if useful, but it should no longer maintain `latestSinceByKey` and `latestSinceIdByKey` for the public snapshot path.

### Acceptance criteria

- Page loads map data from `/latest-snapshot`.
- Reloads and multiple users produce stable URLs.
- 60-second refresh works.
- `304` response does not break map state.
- Pollutant/window changes fetch correct snapshot.
- Existing debug/admin `latest` path can still be tested separately.

### Supabase egress effect

- This is the main public Supabase egress reduction phase.
- Public browsers stop hitting Supabase-backed latest endpoints for map latest data.

### Cloudflare cost items

- Worker requests every 60 seconds per active browser while polling.
- Mostly edge cache hits; R2 reads only on cache miss/expiry/edge-cold conditions.

---

## Phase D — Add observability, validation, and rollback tools

### Goal

Make it safe to run the R2 snapshot path in production.

### Items

- Add headers for snapshot key, generation time, ETag, and cache status.
- Add snapshot-builder logs.
- Add optional compare mode:
  - fetch old `/latest` and new `/latest-snapshot`
  - compare row counts, max timestamp, pollutant, and a sample of station IDs
- Add manual purge or version-bump procedure.
- Add dashboard/log checks for:
  - snapshot age
  - missing objects
  - R2 read/write errors
  - cache HIT/MISS/BYPASS rates
  - frontend error rate

### Acceptance criteria

- Can prove snapshot freshness.
- Can detect stale/missing snapshots.
- Can roll website back to old `/latest` path quickly.
- Can bypass cache for debugging.

### Supabase egress effect

- Neutral to small increase during compare mode if old `/latest` is fetched for validation.
- Compare mode should be limited to staging/admin or sampled production checks.

### Cloudflare cost items

- Additional Worker requests for diagnostics if enabled.
- Possible log/analytics costs depending on tooling.

---

## Phase E — Add realtime update notifications with polling fallback

### Goal

Allow browsers to update soon after ingest/snapshot publication without waiting for the next 60-second poll.

### Recommended design

Use a Durable Object WebSocket broadcaster.

Browser connects:

```text
wss://<site>/api/aq/realtime
```

Snapshot builder publishes:

```text
POST /api/aq/realtime/publish
```

The Durable Object broadcasts:

```json
{
  "type": "snapshot_updated",
  "scope": "all",
  "window": "6h",
  "pollutant": "pm25",
  "etag": "\"abc123\"",
  "generated_at": "2026-05-07T20:31:00Z"
}
```

Browser behaviour:

1. Open WebSocket.
2. Subscribe to relevant map channels.
3. On update message, compare ETag.
4. If ETag differs, fetch `/latest-snapshot` with `If-None-Match`.
5. If WebSocket fails, use 60-second polling.
6. Even when WebSocket is working, keep a slower safety poll, for example every 5 minutes, to recover from missed messages.

### Do not broadcast full AQ data

Realtime events should be small metadata notifications only. Full data still comes from the cached snapshot endpoint.

### Acceptance criteria

- Website updates shortly after snapshot publication.
- WebSocket disconnect does not break map updates.
- Polling fallback works.
- Browser reconnect uses exponential backoff.
- No full data payload is sent through WebSocket.
- Realtime can be disabled by config flag.

### Supabase egress effect

- No direct Supabase egress increase.
- May reduce Cloudflare Worker polling requests when realtime is healthy.

### Cloudflare cost items

- Durable Object compute and possible storage.
- Worker requests for WebSocket connects and publish calls.
- If using Queues later, Queue operations.

---

## Phase F — Optional payload reduction: map summaries first, sensor detail on demand

### Goal

Reduce public payload size beyond what caching alone can do.

### Current issue

The map often does not need every individual sensor row on initial load. It needs enough to colour areas, show top summaries, and populate network counts. Detailed sensor rows are only needed when a user clicks or searches.

### Proposed endpoints

```text
/api/aq/latest-map-summary?area=pcon&pollutant=pm25&window=6h
/api/aq/latest-map-summary?area=la&region=london&pollutant=pm25&window=6h
/api/aq/latest-area-sensors?area=pcon&code=E14000000&pollutant=pm25&window=6h
```

### Pros

- Much smaller initial page load.
- Better mobile performance.
- Lower Worker/R2 read load per page view.
- Better UX for high-traffic public pages.

### Cons

- More front-end changes.
- More snapshot object types.
- Need careful cache keys for detail endpoints.

### Supabase egress effect

- Still very low if generated into R2.
- Snapshot builder may do more aggregation work, but public traffic stays off Supabase.

### Cloudflare cost items

- More R2 objects and operations.
- Likely fewer bytes transferred overall.

### Recommendation

Do this only after Phases A–E are stable.

---

## 7. Cache key rules

### Public snapshot cache key must include

```text
endpoint
schema version
scope
window
pollutant
optional area type / region / area code, for later summary/detail endpoints
content encoding variant, if needed
```

### Public snapshot cache key must not include

```text
since
since_id
random cache-busting params
session IDs
Turnstile/session tokens
browser-specific headers
```

### Example canonical key

```text
https://cache-proxy.internal/api/aq/latest-snapshot?pollutant=pm25&scope=all&window=6h&encoding=br&v=1
```

---

## 8. Rollback strategy

Each phase should be reversible.

### Rollback from Phase C website switch

- Keep old `/latest` endpoint available.
- Add front-end config flag:

```text
latest_data_mode=snapshot|legacy
```

- Default to `snapshot` after rollout.
- Switch back to `legacy` if snapshot endpoint fails.

### Rollback from Phase E realtime

- Disable realtime config flag.
- Website continues 60-second polling.
- Durable Object can remain deployed but unused.

---

## 9. Testing checklist

### Snapshot builder tests

- Generates all pollutant/window combinations.
- Writes manifest last.
- Does not rewrite unchanged snapshots.
- Handles empty result sets.
- Handles Supabase/API failure.
- Produces valid JSON and valid compressed variants.

### Cache proxy tests

- Stable URL returns 200.
- Same URL returns cache HIT after warmup.
- `If-None-Match` returns 304.
- `since` / `since_id` are rejected or ignored as designed.
- `cache=bypass` requires secret.
- Missing R2 object returns useful non-cache-poisoning error.

### Website tests

- Initial map load works.
- Pollutant changes work.
- Window changes work.
- Network filters work.
- Selected hex sensor panel still works.
- 304 responses keep existing map data.
- Hard refresh does not cause Supabase egress spike.

### Realtime tests

- WebSocket connects.
- Browser receives update event.
- Browser fetches snapshot only when ETag changes.
- Reconnect/backoff works.
- Polling fallback works.
- Realtime disabled mode works.

---

## 10. Cost notes and source references

These notes should be rechecked before implementation because Cloudflare pricing can change.

- Cloudflare R2 charges for storage and operations; Cloudflare states there are no egress bandwidth charges for R2 storage classes.  
  Source: https://developers.cloudflare.com/r2/pricing/

- Cloudflare Workers paid pricing includes request and CPU-time billing above included usage.  
  Source: https://developers.cloudflare.com/workers/platform/pricing/

- Cloudflare Durable Objects can incur compute and storage billing.  
  Source: https://developers.cloudflare.com/durable-objects/platform/pricing/

- Cloudflare Durable Object WebSocket hibernation can reduce costs by allowing Durable Objects to sleep while clients remain connected, so billable duration does not accrue during hibernation.  
  Source: https://developers.cloudflare.com/durable-objects/best-practices/websockets/

- Cloudflare Queues charges are based on queue operations; Queues can be used later if update publication needs reliable decoupling.  
  Source: https://developers.cloudflare.com/queues/platform/pricing/

---

## 11. Proposed Codex prompt sequence

Separate detailed Codex prompts should be written for each phase.

1. **Phase A prompt:** build R2 latest snapshot publisher.
2. **Phase B prompt:** add `/api/aq/latest-snapshot` to cache proxy with stable keys.
3. **Phase C prompt:** update website to use snapshot endpoint and remove public `since` flow.
4. **Phase D prompt:** add observability, diagnostics, validation, and rollback flags.
5. **Phase E prompt:** add Durable Object realtime notification channel with polling fallback.
6. **Phase F prompt:** add map-summary-first and sensor-detail-on-demand snapshots.

Recommended implementation order:

```text
A → B → D partial → C → D complete → E → F
```

D starts before C because diagnostics make the cutover safer.

---

## 12. Final recommendation

Do not start with realtime. Start with the architecture that makes realtime cheap and safe:

1. R2 latest snapshots.
2. Stable cache proxy keys.
3. Website snapshot mode with 60-second polling.
4. Diagnostics and rollback.
5. Realtime notification layer.
6. Payload reduction.

The realtime layer should only tell browsers that a new snapshot exists. The browser should still fetch data through the stable cached snapshot endpoint. This keeps Cloudflare caching useful, keeps Supabase egress low, and keeps the site resilient when WebSockets fail.
