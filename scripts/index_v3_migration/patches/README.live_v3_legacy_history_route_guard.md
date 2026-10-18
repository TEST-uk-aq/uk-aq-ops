# LIVE v3 legacy history route guard (staged patch only)

This directory holds a **non-deploying patch** for the active cache-proxy source.
No Worker code, runtime variable, CI configuration or R2 object is changed by
committing this file. The patch was prepared against the common routing block in
TEST and LIVE Ops on 18 October 2026. It has **not** been applied or exercised
against a deployed TEST or LIVE Worker.

## Contract and reason

The active TEST system contracts are
`system_docs/r2_history/observation_history_v3_side_by_side_generation_contract.md`
and `system_docs/r2_history/observation_history_v3_website_cutover_scope_amendment.md`.
The selected observation storage generation is **only**
`UK_AQ_R2_HISTORY_VERSION=v2|v3`. Under v3 there must be no request-time v2
fallback. Legacy persisted calculated AQI is not an active canonical R2 product
(`system_docs/r2_history/aqi_r2_retirement_contract.md`).

The existing cache proxy may otherwise route legacy
`/api/aq/timeseries?v=2` requests to its v2 R2-stitcher (which sends
`since_utc` and `limit`, rejected by the v3 physical observation reader), or
fall through to its Supabase timeseries origin if the old feature flag is
disabled. Retained `/api/aq/aqi-history` requests can read legacy stored AQI.
The normal calculated station-history consumer does **not** need either path.

## Scope of this patch

File changed **when applied**:
`workers/uk_aq_cache_proxy/src/index.ts`.

- With the selected generation **v2**, existing routing is unchanged.
- With **v3**, a `/api/aq/timeseries` request is accepted for progressive
  `/v1/observations-history` routing only, and only if the stable
  `STATION_HISTORY` binding exists.
- With **v3**, explicit `v=2` timeseries requests, non-progressive timeseries
  requests, and public `/api/aq/aqi-history` requests fail with HTTP **410**
  and `{"error":"legacy_history_route_retired_for_v3"}`, without cached or
  upstream fallback.
- Invalid/missing selected generation fails with HTTP **500**; absent required
  station-history binding fails with HTTP **503**.
- Current `/api/aq/station-series` requests, private station-history AQI
  comparison reads, R2 observation storage and all writer paths are untouched.
- The old AQI-history Worker can remain on its historical v2 configuration.

The guard runs after the established origin and session checks, but before
the cache lookup or any fallback/upstream fetch. It is deliberately
fail-closed rather than translating the old `v=2` response shape to v3.

## Admission and application (separately authorised operation)

**Do not apply/push as a side effect of reviewing this patch.**
A push to `main` changing `workers/uk_aq_cache_proxy/**` triggers its
automatic Cloudflare Worker deployment workflow. Obtain explicit TEST
deployment permission, apply and accept it on real TEST, and only then
promote the reviewed change to LIVE under separately authorised LIVE
deployment and migration controls.

From an up-to-date **TEST Ops** checkout, or after copying this patch
unchanged into the equivalent **LIVE Ops** checkout:

```bash
cd /path/to/uk-aq-ops
git apply --check scripts/index_v3_migration/patches/live_v3_legacy_history_route_guard.patch
```

Before modifying the active cache source, preserve its exact original content
under the repository's `archive/YYYY-MM-DD/` code-history convention (unless
the day's exact snapshot already exists). Then, **only when authorised**:

```bash
git apply scripts/index_v3_migration/patches/live_v3_legacy_history_route_guard.patch
git diff --check
git diff -- workers/uk_aq_cache_proxy/src/index.ts
```

The archive is reference/rollback only and must not be executed.
Do not treat a successful `git apply --check` as functional acceptance.
The required real-operation checks occur after an authorised TEST deployment,
while v2 remains selected and again under a controlled v3 read-cut-over:

- v2 timeseries and public chart serving are unchanged before cut-over.
- Under v3, an authenticated progressive history request uses the stable
  station-history v3 route, including calculated DAQI/EAQI.
- Under v3, explicit `v=2`, legacy non-progressive and old public AQI routes
  return HTTP 410 with `Cache-Control: no-store`, without any origin fallback.
- The immutable migration checkpoint, global writer lock and LIVE
  post-cut-over deployed-path verifier remain **separate required gates**.

For rollback **before v3-only writers resume**, restore the reviewed v2
cache-proxy code/deployment and select the intact v2 generation under the
existing protected cut-over procedure. Once v3 writes have advanced, v2 is
no longer an automatically current rollback source.

The correct copied LIVE read-only verification entry point is
`scripts/index_v3_migration/index_v3_live_post_cutover_verify.sh`.
Never release the migration lock solely because this patch is present.
