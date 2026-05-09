## Phase A Plan: Latest R2 Snapshots Now, 24h Deferred

### Summary
Implement latest snapshots on **GCP Cloud Run** (scheduled every 60s), publish to R2 with stable keys/manifests, and cut website latest reads to snapshot-backed cache routes. Defer 24h cache until after metrics confirm Phase A outcomes.

### Options Considered (with Egress and DB-Size Impact)
1. **Chosen: Latest snapshots only (Phase A)**
- Pros: biggest immediate Supabase egress reduction; low delivery risk; no schema/storage churn in DB.
- Cons: chart/timeseries path still uses existing stitched flow until later phase.
- Supabase egress impact: strong reduction after `/latest` cutover.
- Database-size impact: neutral (no new DB tables/data growth).

2. **Not chosen now: Latest + 24h chart cache together**
- Pros: could reduce chart-path DB reads earlier.
- Cons: higher correctness risk and more moving parts in first rollout.
- Supabase egress impact: potentially larger later win, but slower/safer rollout is harder.
- Database-size impact: still neutral in DB, but higher R2 object/ops footprint.

### Implementation Shape
1. **Builder runtime and triggers**
- Use **Cloud Scheduler -> Cloud Run** every 60 seconds.
- Keep design ready for later ingest-triggered debounce path to same service.
- Do not implement realtime transport in this phase.

2. **Snapshot source and contract**
- Query committed latest data from ingestdb using the same response contract as current latest RPC usage.
- Initial matrix: `pollutant in {pm25, pm10, no2}` and `window in {3h, 6h, 1d}` with `network_group=all`.

3. **Object keys and format**
- Deterministic JSON only in Phase A.
- Stable key dimensions include snapshot family/version/network_group/pollutant/window.
- Compute SHA-256 and ETag per object.
- Skip object write when hash unchanged.

4. **Manifest and failure behavior**
- Use per-family manifest for latest snapshots.
- Include rich metadata: schema version, generated time, key, encoding/type, hash, etag, row count, min/max observed_at, duration, changed flag, source.
- Partial failure policy: keep last known-good object references for failed entries; do not delete prior good snapshots.

5. **Website and cache cutover**
- Add snapshot-backed latest route in cache layer.
- Switch website latest fetch path to snapshot-backed route after validation.
- Keep existing chart/timeseries path unchanged for now.
- Maintain 60-second polling fallback as-is.

### Test and Acceptance Plan
1. **Builder correctness**
- For each matrix key, snapshot payload matches current latest endpoint semantics.
- Unchanged input produces no-op writes.
- Manifest reflects accurate hashes/counts/timestamps.

2. **Failure safety**
- Simulated single-key build failure preserves prior good public data for that key.
- Manifest remains readable and non-broken for successful keys.

3. **Cutover validation**
- Compare old vs new latest payloads for representative keys.
- Confirm cache headers/ETag behavior and high cache-hit behavior with stable keys.
- Confirm no regression in map load latency and pollutant/window switching.

4. **Post-cutover metrics**
- Track Supabase endpoint egress reduction for latest routes.
- Track R2 Class A/B ops and Worker/cache hit rates.
- Track snapshot staleness age and build success rate.

### Deferred to Next Phase
- Rolling 24h chart cache.
- Realtime notification channel (metadata-only signal to refetch stable snapshot URL).
- Additional windows/groups beyond `3h/6h/1d` and `network_group=all`.

### Assumptions
- Active ingest remains GCP/pubsub_only.
- Snapshots are public-read artifacts served through existing cache architecture.
- 24h cache is explicitly non-scope for this phase.
