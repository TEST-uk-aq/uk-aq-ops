# WHO summary cache-proxy contract

Status: authoritative for the public WHO homepage summary route and its authenticated R2-reader boundary.

## Scope

This contract governs:

- the public cache-proxy route used by the website homepage WHO guideline card;
- the authenticated history R2 API route that reads the fixed WHO object;
- UTC-day request identity;
- Worker edge-cache and browser local-cache behaviour;
- stale-data retry behaviour;
- failure and website fallback behaviour.

It does not change the WHO calculation, readiness, summary publication, scheduling, R2 object schema, homepage wording or card layout.

## Public route

The cache proxy MUST expose:

```text
GET /api/aq/who-summary?as_of=YYYY-MM-DD
```

`HEAD` MAY be used for diagnostics and MUST return the same status and headers without a body.

The route is public read-only data and MUST NOT require a Turnstile session or private database credentials in the browser.

`as_of` MUST be a valid UTC calendar day. Invalid or missing values MUST return HTTP 400 with `Cache-Control: no-store`.

## Authenticated R2-reader route

The cache proxy MUST obtain the payload through the existing history R2 API Worker boundary:

```text
GET /v1/who-summary?as_of=YYYY-MM-DD
```

The R2-reader route MUST require the existing `X-UK-AQ-Upstream-Auth` secret and MUST NOT be exposed as an unauthenticated public data source.

The cache proxy MUST derive this route from the existing `UK_AQ_OBSERVS_HISTORY_R2_API_URL` origin and MUST reuse `UK_AQ_EDGE_UPSTREAM_SECRET`. It MUST NOT require a direct R2 bucket binding in the cache-proxy Worker. This preserves deployments where the public cache proxy and history R2 readers are in different Cloudflare accounts.

The new wrapper route MUST delegate every existing observations-history request unchanged to the existing observations R2 API implementation.

## Source of truth

The authenticated R2-reader route MUST read this exact object from its environment-specific `UK_AQ_HISTORY_BUCKET` binding:

```text
history/v2/who_2021/latest_who_2021.json
```

Neither the cache proxy nor the R2 reader may query Supabase for this route.

A successful payload MUST contain:

- a valid `data_as_of_day_utc` UTC day;
- a `cards` array.

Missing objects return HTTP 404. R2 read failures or invalid payloads return HTTP 502. These error responses MUST use `Cache-Control: no-store`.

## UTC-day cache identity

The website computes the expected latest complete day as yesterday in UTC and supplies it as `as_of`.

Both Worker cache keys MUST include:

- the relevant route;
- the requested `as_of` day;
- an internal cache-contract version.

Unrelated query parameters MUST NOT create request-by-request cache variants.

Timestamp or random cache busters MUST NOT be used for normal website traffic.

## Freshness and Worker cache TTL

Freshness is determined by comparing the payload's `data_as_of_day_utc` with the requested `as_of` day.

The authenticated R2 reader and public cache proxy MUST retain their cacheable internal response before creating the browser-facing response. The browser-facing response MUST then use:

```text
Cache-Control: no-store
```

This separation prevents a zone-wide Cloudflare Browser Cache TTL override from extending WHO staleness beyond the website's UTC-day local-storage policy.

### Current or newer payload

When `data_as_of_day_utc` is equal to or newer than `as_of`:

- the response is current for that request;
- both Worker cache layers MUST use a TTL of 86,400 seconds;
- the stable per-day URL means the next UTC day uses a different cache key;
- the browser-facing response MUST remain `Cache-Control: no-store`;
- the website's current local-storage payload suppresses further network requests for that expected UTC day.

### Behind payload

When `data_as_of_day_utc` is older than `as_of`:

- the response MUST remain HTTP 200 so the newest available data can be displayed;
- both Worker cache layers MUST use a TTL of 1,800 seconds;
- the browser-facing response MUST remain `Cache-Control: no-store`;
- the response MUST identify that it is behind;
- the response MUST advertise a 1,800-second retry interval through `X-UK-AQ-WHO-Retry-After-Seconds`.

The 30-minute interval is intentionally long enough to prevent repeated page-load traffic while allowing the homepage to pick up the newly published daily object reasonably soon.

## Response diagnostics

Successful public responses MUST include:

- `X-UK-AQ-WHO-Requested-As-Of`;
- `X-UK-AQ-WHO-Data-As-Of`;
- `X-UK-AQ-WHO-Freshness` with `current`, `behind` or `ahead`;
- `X-UK-AQ-Cache` with `HIT` or `MISS` for the public cache-proxy layer;
- `X-UK-AQ-WHO-Worker-Cache-Control` containing the internal cache policy that was used before the browser-facing response was changed to `no-store`.

The authenticated R2 reader SHOULD also expose `X-UK-AQ-WHO-Origin-Cache` with `HIT` or `MISS`.

Behind responses MUST also include:

```text
X-UK-AQ-WHO-Retry-After-Seconds: 1800
```

## Website browser cache

The website MUST retain the newest usable WHO payload in local storage. HTTP browser caching MUST NOT control WHO freshness.

On a normal homepage load:

1. Compute yesterday in UTC as the expected `as_of` day.
2. If the locally cached `data_as_of_day_utc` is equal to or newer than the expected day, render it and MUST NOT make a network request.
3. If the locally cached payload is behind, render it immediately.
4. A behind payload MAY be checked again only when the local 1,800-second retry window has elapsed.
5. Network or API failure MUST keep the cached payload visible. If there is no cached payload, the static card values remain visible.
6. An older network payload MUST NOT replace a newer locally cached payload.

The current homepage inline code requests the earlier R2-shaped path. The shared website cache helper MAY intercept that exact request and translate it to `/api/aq/who-summary` as a compatibility step. This compatibility mapping MUST be exact-path only and MUST NOT alter unrelated `fetch` calls.

## Cache and publication separation

The API cache policy MUST NOT change WHO publication timing or readiness rules.

A behind response means the daily summary publisher has not yet produced the requested `data_as_of_day_utc`. The cache proxy displays the newest available object and retries later; it MUST NOT attempt to calculate or publish WHO data itself.

## Preserved behaviour

This change MUST preserve:

- every existing cache-proxy route and its current authentication and cache policy;
- every existing observations R2 API route and exact physical-read behaviour;
- the WHO R2 object key and payload schema;
- the existing static homepage fallback values;
- the homepage card wording, layout and source label;
- the Cloudflare Scheduler and GitHub Actions WHO publication process.

## Structural validation

Before deployment:

- the new JavaScript and TypeScript entry points MUST be structurally checkable;
- both resolved Wrangler configurations MUST retain their existing bindings and contain no unresolved placeholders;
- no direct R2 binding may be added to the cache-proxy Worker;
- the public route MUST store a cacheable internal response before returning a separate `Cache-Control: no-store` browser response.

Functional validation occurs after deployment on TEST:

1. request the public route with the expected UTC day;
2. confirm the browser-facing `Cache-Control` is `no-store`;
3. confirm `X-UK-AQ-WHO-Worker-Cache-Control` reports the current 86,400-second or behind 1,800-second internal policy;
4. where a behind object is available, confirm it retains the 1,800-second retry header;
5. reload the homepage and confirm a current local payload causes no WHO network request;
6. confirm cached/static fallback remains visible during a forced route failure;
7. confirm an existing observations-history route still responds normally through the unchanged implementation.
