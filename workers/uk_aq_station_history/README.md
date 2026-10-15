# UK-AQ station history Worker

`uk-aq-station-history` is a private Service Binding Worker. It has no public route; `uk-aq-cache-proxy` retains browser authentication, CORS, bypass authorization, and public cache ownership.

## Station-series source policy

`GET /v1/station-series` resolves the authoritative timeseries identity before reading data. It performs exactly one logical recent observation read directly from the ingest database through `uk_aq_public.rpc/uk_aq_timeseries_rpc`, using the smallest supported RPC window that covers the required source interval. A required interval beyond the RPC's 30-day maximum is marked incomplete rather than treated as direct-source coverage. It never calls the stitched public `uk_aq_timeseries` Edge Function.

A request uses ingest-only mode only when the direct response covers the complete requested output, the requested end, and any PM 23-hour AQI context. Otherwise the same direct result is reused with bounded R2 sources:

- R2 AQI is authoritative over live AQI for the same canonical hour.
- R2 observations are authoritative over direct ingest observations for the same exact timestamp within the configured 1–3 hour overlap.
- Live AQI is calculated only for R2-missing eligible hours, using the shared AQI library.
- AQI and observation historical boundaries and completeness states remain independent.

Partial or gap-bearing responses use `Cache-Control: no-store`. Diagnostics report counts, boundaries, RPC window/HTTP attempt metadata, completeness, and overlap/mismatch totals but never observation values.

## index_v3 observation-history paging

When `UK_AQ_R2_HISTORY_INDEX_VERSION=v3`, station-history uses the selected
shared exact-leaf reader through the authenticated observation-history client.
The browser and cache proxy continue to use the existing station-history
routes and response shape; neither receives nor returns a `physical_cursor`.

The R2 observation adapter:

- splits every required physical-timeseries interval at UTC-day boundaries,
  so each low-level logical request is no more than 24 hours;
- issues the first exact-leaf request, then follows
  `physical_page.next_cursor` until that logical piece is complete;
- appends pages and UTC pieces in strict chronological order;
- shares one invocation-scoped read budget across all continuity members and
  compatibility phases, capped at 16 physical pages and the existing 5,000
  station-history observation rows; and
- preserves the exact-leaf reader's one-segment/1,024-row invocation bound,
  pinned object identities, exact stored byte ranges, and fail-closed cursor
  validation.

The existing maximum seven-day observation chunk plus 23 hours of PM context
can intersect at most nine UTC days. Normal hourly and current five-minute
sources therefore fit comfortably inside 16 pages. The budget also stays
below the current external-subrequest limit and would produce at most 19
Worker invocations in the full cache-proxy -> station-history ->
observation-history chain if the leaf client later moves to a Service Binding.

If page 16 still has work remaining, station-history stops with
`observation_history_physical_page_budget_exceeded`. If appending a physical
page would take the invocation above its row budget, that page is not appended
and station-history stops with `observation_history_row_budget_exceeded`.
Neither case exposes a browser continuation or claims completeness. Both flow
through the existing incomplete-response `Cache-Control: no-store` policy.

The historical response `limits.max_pages` field retains its established v2
meaning. A v3 physical-page response instead reports
`limits.max_physical_pages: 16`.

The shelved encrypted, browser-visible station-history continuation candidate
and its cap experiments are retained under
`archive/2026-09-02/index_v3_station_history_continuation/`. That design is
separate from the active private low-level `physical_cursor`.

## AQI v2 endpoint response contract

The active R2 v2 AQI path uses `timestamp_hour_utc = n` as its canonical
hour-ending endpoint. Station-series AQI sections and older AQI chunks expose
`response_contract: "aqi_hour_interval_v2"`; each AQI row carries both
`timestamp_hour_utc` and `period_end_utc`, each equal to `n`.

During the additive compatibility release, `period_start_utc` remains the
legacy endpoint alias. It must not be interpreted as a true start by a
consumer that has not first selected `period_end_utc` or `timestamp_hour_utc`.
The coordinated final contract will set the true period start to `n - 1 hour`.
The represented interval is therefore documented as `(n - 1 hour, n]`; this
Worker does not change stored R2 v2 data, writers, manifests, indexes or
metadata.

`/v1/aqi-history` is an internal HTTP route version, not R2 history v1. The
private Service Binding architecture and R2-over-live precedence are unchanged.

## Configuration

Required data-path values:

- `SUPABASE_URL` and `SB_SECRET_KEY` for authoritative identity lookup and direct recent-observation RPC calls.
- `UK_AQ_AQI_HISTORY_R2_API_URL`, `UK_AQ_OBSERVS_HISTORY_R2_API_URL`, and `UK_AQ_EDGE_UPSTREAM_SECRET` for R2 fallback/history.
- `UK_AQ_PUBLIC_SCHEMA` (default `uk_aq_public`) and `INGESTDB_RETENTION_DAYS` (default `5`).

Optional TEST tuning uses safe in-code defaults when absent:

- `UK_AQ_STATION_HISTORY_STABLE_AQI_HEAD_MAX_HOURS` (`168`).
- `UK_AQ_STATION_HISTORY_AQI_CHUNK_MAX_HOURS` (`744`).
- `UK_AQ_STATION_HISTORY_OBSERVATION_CHUNK_MAX_HOURS` (`168`).
- `UK_AQ_STATION_HISTORY_OBSERVATION_OVERLAP_HOURS` (`2`, validated to `1`–`3`).
- `UK_AQ_STATION_HISTORY_OBSAQIDB_TIMEOUT_MS` (`10000`).

The index_v3 physical-page budget is a fixed safety bound, not an environment
variable or public pagination control.

## Isolated recent AQI CPU prototype (TEST only)

`GET /api/aq/recent-aqi-prototype` reaches the private
`/v1/recent-aqi-prototype` Service Binding route through the authenticated
cache proxy. It requires the normal allowed Origin, valid session cookie, and
the dedicated `X-UK-AQ-Prototype-Operator-Token` header even when local
development bypass is enabled. The cache proxy compares this header
server-side against the TEST-only secret
`UK_AQ_RECENT_AQI_PROTOTYPE_OPERATOR_TOKEN` using timing-safe comparison; the
secret must contain 32–512 characters. A missing or malformed configured
secret fails closed before the Service Binding call. Both Workers require `UK_AQ_ENV_NAME=TEST` and
`UK_AQ_RECENT_AQI_PROTOTYPE_ENABLED=true`; the private Worker additionally
requires `UK_AQ_RECENT_AQI_PROTOTYPE_TIMESERIES_ID` to be one explicitly
approved physical AURN PM2.5 timeseries ID. All values are absent or off by
default. A missing allowlist fails closed.

The request has exactly three query parameters: `timeseries_id`,
`pollutant=pm25`, and `timestamp_hour_utc` (an exact UTC hour, currently the
latest completed hour). The response contains one calculated AQI row with
independent DAQI and EAQI statuses, its actual physical identity, the
hour-ending interval and source counts. It is never cached. A header
`X-UK-AQ-Prototype-Route: recent-aqi-ingestdb` makes this route identifiable in
Cloudflare request telemetry.

This first experiment uses **IngestDB only** through the existing
`uk_aq_timeseries_rpc`. It does not read canonical R2 and cannot claim complete
merged chart authority. It requests the 24 represented hours `(n-24h,n]`
using `since_ts`, preserves individual source rows for the derived hourly
means, and calls the shared AQI helper for rolling and index calculation.
Source timestamps within the requested interval must already be exact UTC hour
endpoints. Since the source contract does not establish an AURN sub-hour
aggregation rule, any sub-hour row in that interval fails closed with
`source_timestamp_convention_unverified`; no rounding or bucketing is applied.
The RPC's seven-day label is only a lower-window safeguard; `since_ts` is the
effective narrow filter. RPC `start` and `end` metadata describe the requested
window and are not used as proof of record coverage. The returned count must
match the data array, and the 129th-row sentinel, response-byte cap, and
identity checks must all pass before the result is marked as a complete
bounded IngestDB query. At most the hour after the requested endpoint can also
be returned; it is counted and excluded from calculation.

In the response, `transport_ok` means the RPC returned a valid bounded JSON
payload; `bounded_query_complete` and `ingestdb_response_complete` mean all
eligible rows returned by the RPC fit within the query and byte limits. They
do not establish that observations existed for every hour. `valid_hour_count`
and `aqi.has_gap` describe observed valid hourly inputs, while
`canonical_history_complete` and overall `response_complete` remain false
because canonical R2 history is not read. Missing observation hours are gaps,
not upstream errors. AQI calculation statuses independently report DAQI rolling
window availability and current-hour EAQI availability.

Fixed limits: one output endpoint, one physical timeseries, 24 hours of AQI
input, 128 raw input rows (129th sentinel), 48 KiB observation response,
8 KiB identity response, 2.5 s per upstream request and 4 s overall elapsed
budget checked between stages. Exceeded row/byte limits fail the request.
These are workload bounds, not evidence of CPU acceptance. Real TEST Worker
telemetry must establish CPU p50/p95/p99/maximum and `exceededCpu` after a
separately authorised deployment.
