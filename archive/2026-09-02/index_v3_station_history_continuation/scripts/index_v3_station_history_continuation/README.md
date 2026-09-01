# TEST index_v3 bounded station-history continuation experiment

This is an isolated architecture and CPU-calibration experiment. It does not
change LIVE, canonical station-history routing, the browser, the cache proxy,
or the selected physical-leaf reader.

## Gate conclusion

The bounded continuation design is structurally viable for the immutable
`/v1/observations-history` path and is safe to deploy to the existing
authenticated TEST `-v3-candidate` for CPU measurement. It is not yet approved
for canonical or browser adoption.

The existing browser already separates a stable head from ordered older
chunks and already accepts partial chunk results. A station continuation is an
inner continuation of one existing older chunk. It must be followed before
that chunk can advance to its existing `next_older_chunk_end_utc`. It does not
replace the public backward-chunk cursor and does not create a third history
direction.

The current cache proxy is deliberately unchanged. Its canonical key does not
yet include `station_history_continuation`, and its stale-cache policy caches
only complete responses. Routing this experiment through it would therefore
collide continuation pages. A later adoption must add the signed continuation
token to the canonical key and allow an immutable, gap-free work-partial page
to be cached independently. A cache hit still consumes one incoming Worker
request; it saves downstream CPU and subrequests, not the account request.

## Current Cloudflare limits used by this experiment

Official Cloudflare documentation checked on 2026-09-01:

- Workers Free has 100,000 incoming requests per account per day, 10 ms CPU
  per HTTP invocation, 50 external subrequests per invocation, 1,000 internal
  Cloudflare-service subrequests per invocation, six simultaneous outgoing
  connections, and 128 MB memory. The Workers limits page says it was last
  updated 2026-07-28:
  <https://developers.cloudflare.com/workers/platform/limits/>.
- A Service Binding call is a subrequest, does not consume an open connection,
  and a request chain can invoke at most 32 Workers. The Service Bindings page
  says it was last updated 2026-08-18:
  <https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/>.
- Workers pricing defines the request allowance as inbound requests and says
  Cloudflare does not charge/count Worker subrequests as additional requests.
  The pricing page says it was last updated 2026-08-28:
  <https://developers.cloudflare.com/workers/platform/pricing/>. Therefore the
  public leaf fetches below consume the station invocation's external
  subrequest budget but are not added again to the 100,000 incoming-request
  calculation.

The existing public `workers.dev` leaf fetch remains selected. There is no
station-history-to-leaf Service Binding in this experiment. If the existing
cache-proxy Service Binding is used later, the chain has two Workers
(cache-proxy and station-history), leaving 30 of the 32 Worker invocations.

## Continuation and trust model

The public field is `station_history_continuation`. It is a deterministic,
versioned base64url AES-GCM authenticated-encryption envelope. Authentication
and confidentiality are required: the token carries state that affects
authoritative output, including the encapsulated child cursor and compact
rolling AQI aggregates. Accepting that state unsigned would let an untrusted
client select or skip physical work or alter calculated AQI; exposing a merely
base64-encoded child cursor would violate the public/physical boundary.

The encryption and nonce-derivation keys are separately derived from the
existing upstream secret. The AES-GCM nonce is deterministically derived with
HMAC-SHA-256 from the canonical plaintext. Identical state therefore produces
the same cache key, while different state has a distinct authenticated nonce;
no random token data fragments immutable continuation caches.

The token is bound to:

- authoritative timeseries, connector, station and pollutant identity;
- the original public start/end and stable-head boundary;
- `include_observations` and `include_aqi`;
- the experiment contract version;
- a SHA-256 fingerprint of the freshly resolved binding/continuity contract;
- exact logical-slice index, expected child page number and encapsulated child
  continuation;
- compact rolling-hour, visible-hour and genuine-gap state.

The child physical cursor is never a public query field and is never accepted
outside the verified station token. Every continuation re-resolves the
authoritative binding, verifies its fingerprint, reconstructs deterministic
at-most-24-hour leaf bounds, and lets the frozen leaf Worker revalidate all
physical identities. Cross-request replay, tampering, contradictory identity,
wrong page number, cursor loops and conflicting equal-timestamp source rows
fail closed. Repeating the same valid station continuation is intentionally
idempotent so an immutable page can be cached; a repeated child cursor in the
same walk is rejected.

Tokens are capped at 12,000 characters. The selected dense physical cursor is
3,290 base64url characters in the existing local fixture. The station token
adds at most 24 compact hourly aggregates plus bounded seven-day coverage
state. A conservative local envelope containing that cursor, 24 aggregates and
168 visible/AQI-hour offsets was 7,459 characters, leaving useful space below
the experiment guard without durable server state or the Workers 16 KB URL
limit.

## Work unit and complete subrequest budget

`UK_AQ_STATION_HISTORY_V3_PHYSICAL_PAGE_CAP` supports the calibration values
1, 2, 4 and 8. The implementation structurally allows at most 40. It never
adapts the value at runtime.

The immutable older-history invocation performs one authenticated public leaf
binding lookup and at most `N` authenticated public leaf-page fetches. It does
not call ingest/Supabase, stored AQI validation, KV, D1, R2 directly, or a
station-to-leaf Service Binding.

| Physical-page cap | Binding fetch | Leaf fetches | External total | Headroom below 50 |
|---:|---:|---:|---:|---:|
| 1 | 1 | 1 | 2 | 48 |
| 2 | 1 | 2 | 3 | 47 |
| 4 | 1 | 4 | 5 | 45 |
| 8 | 1 | 8 | 9 | 41 |
| 40 structural maximum | 1 | 40 | 41 | 9 |

The 40-page value is a subrequest ceiling, not a CPU recommendation. The
deployed parent-Worker CPU measurement must choose a lower fixed value.
Sequential leaf fetches also stay below the six simultaneous-connection limit.

At cap 8, one invocation holds at most roughly 8,192 physical rows plus a
small rolling state. That is not an obvious 128 MB risk. JSON parsing,
normalisation, HMAC, AQI aggregation and response serialization remain real
10 ms CPU risks and are deliberately left to Cloudflare telemetry.

## PM hidden context

PM2.5 and PM10 retain the full 23-hour hidden context. Source rows are walked
once, chronologically, in deterministic half-open ranges no longer than 24
hours. A signed continuation carries the last at most 24 hourly aggregates,
the open hour and the last higher-level deduplication key. It does not carry
raw dense context rows. Consequently, a 24-hour PM output reads approximately
47 hours of source once (about 26 leaf pages for the known dense profile), not
once per station continuation.

Raw observation output remains lossless: physical order and equal timestamp
duplicates are preserved. The existing higher-level calculation semantics
remain separate: identical timestamp/value rows count once for AQI, while a
conflicting equal-timestamp row fails closed.

## Incoming-request amplification

Assumptions:

- normal source day: 1 physical page;
- known dense source day: 13 physical pages;
- conservative PM/AQI stream: one additional source day for the 23-hour
  context;
- current public plan: `24h=[1d]`, `7d=[7d]`,
  `31d=[7d + 8x3d]`, `90d=[12x7d + 6d]`;
- one selected station is the combined observation/AQI stream;
- four selected stations are one combined stream plus three observation-only
  and three AQI streams, matching the current approximate 7x request count.

The table entries are incoming cache-proxy/station public requests for one
chart load. Child leaf fetches are external subrequests, not extra account
incoming requests, under Cloudflare's current inbound-request/subrequest
pricing definition.

### Normal density

| Chart | Current 1 / 4 stations | Blanket 24h 1 / 4 | Cap 1 | Cap 2 | Cap 4 | Cap 8 | Cap 40 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 24h | 1 / 7 | 1 / 7 | 2 / 11 | 1 / 7 | 1 / 7 | 1 / 7 | 1 / 7 |
| 7d | 1 / 7 | 7 / 49 | 8 / 53 | 4 / 28 | 2 / 14 | 1 / 7 | 1 / 7 |
| 31d | 9 / 63 | 31 / 217 | 40 / 253 | 20 / 140 | 10 / 70 | 9 / 63 | 9 / 63 |
| 90d | 13 / 91 | 90 / 630 | 103 / 682 | 52 / 361 | 26 / 182 | 13 / 91 | 13 / 91 |

Cap 8 therefore leaves normal four-station 90-day traffic at the current
approximate 91 requests, about 1,098 such cold chart loads per 100,000-request
day before any other account traffic. This is why blanket 24-hour browser
chunks remain rejected.

### Known dense pathological profile

| Chart | Cap 1, 1 / 4 stations | Cap 2 | Cap 4 | Cap 8 | Cap 40 |
|---|---:|---:|---:|---:|---:|
| 24h | 26 / 143 | 13 / 73 | 7 / 40 | 4 / 22 | 1 / 7 |
| 7d | 104 / 689 | 52 / 346 | 26 / 173 | 13 / 88 | 3 / 21 |
| 31d | 520 / 3,289 | 260 / 1,658 | 130 / 829 | 69 / 432 | 19 / 109 |
| 90d | 1,339 / 8,866 | 670 / 4,453 | 335 / 2,228 | 168 / 1,134 | 39 / 270 |

The dense figures are intentionally density-sensitive worst cases, not an
assumption about all Sensor.Community history. A cap-8 four-station dense
90-day cold load is about 1,134 incoming requests, so only about 88 such loads
would consume 100,000 requests before other account use. That is substantial
pathological amplification, but it does not inflate normal traffic and is
acceptable only as a TEST CPU experiment. Browser/canonical adoption must
combine the chosen CPU-safe cap with account telemetry and, if needed, UI
limits or a compact/precomputed history product.

## Local structural validation

Run:

```bash
node --check workers/uk_aq_station_history/src/v3_continuation.mjs
node --check workers/uk_aq_station_history_v3_candidate/entry.mjs
node scripts/index_v3_station_history_continuation/validate_local.mjs
node scripts/index_v3_station_history_continuation/measure.mjs \
  --dry-run \
  --base-url https://STATION-CANDIDATE.SUBDOMAIN.workers.dev \
  --case dense-pm-hidden-context
npx wrangler deploy \
  --config workers/uk_aq_station_history_v3_candidate/wrangler.toml \
  --name structural-only \
  --dry-run --outdir /tmp/uk-aq-station-history-v3-continuation-bundle
```

The validator uses a service-compatible mocked binding/leaf interface. It
checks caps 1/2/4/8, exact resume, ordered lossless rows, equal-timestamp
duplicates, invalid/tampered/cross-request tokens, child cursor loops, genuine
gap propagation, work-partial versus gap semantics, at-most-24-hour leaf
ranges, deterministic tokens, and PM AQI equality with the existing calculated
history implementation. It does not benchmark CPU.

## Later TEST deployment and CPU calibration (do not run during review)

The workflow deploys only
`${UK_AQ_STATION_HISTORY_WORKER_NAME}-v3-candidate`; it never deploys the
already-deployed leaf dependency. For each cap, run after review from a ref
containing these files:

```bash
gh workflow run uk_aq_station_history_v3_candidate_deploy.yml \
  --ref REVIEWED_REF \
  -f observations_candidate_url="${UK_AQ_OBSERVS_HISTORY_V3_LEAF_CANDIDATE_URL}" \
  -f physical_page_cap=1
```

Repeat with `physical_page_cap=2`, `4`, then `8`. In a separate terminal tail
the parent station Worker (not the leaf Worker):

```bash
npx wrangler tail "${UK_AQ_STATION_HISTORY_WORKER_NAME}-v3-candidate" \
  --format json \
  --search station_history_v3_continuation_cpu_measurement \
  | tee "station-history-v3-cap-${PHYSICAL_PAGE_CAP}-tail.jsonl"
```

For each deployed cap run all three focused cases:

```bash
export UK_AQ_STATION_HISTORY_V3_CANDIDATE_URL="https://${UK_AQ_STATION_HISTORY_WORKER_NAME}-v3-candidate.${CLOUDFLARE_WORKERS_SUBDOMAIN}.workers.dev"

node scripts/index_v3_station_history_continuation/measure.mjs --case normal-24h \
  | tee "station-history-v3-cap-${PHYSICAL_PAGE_CAP}-normal-24h.json"

node scripts/index_v3_station_history_continuation/measure.mjs --case dense-24h \
  | tee "station-history-v3-cap-${PHYSICAL_PAGE_CAP}-dense-24h.json"

node scripts/index_v3_station_history_continuation/measure.mjs --case dense-pm-hidden-context \
  | tee "station-history-v3-cap-${PHYSICAL_PAGE_CAP}-dense-pm-hidden-context.json"
```

The repo-local dense prototype publishes 2026-04-03 but does not prove an
adjacent dense UTC day. The prepared dense PM case is therefore deliberately
contained within that day: its visible interval is
`23:00:00.001Z`–`23:59:59.999Z`, so the unchanged 23-hour context begins at
`00:00:00.001Z` and the source read ends at midnight. It exercises roughly one
dense source day plus PM rolling calculation without inventing or publishing
adjacent data. It has no complete visible clock-hour endpoint, so AQI output
rows are expected to be zero; the 47-hour/24-row PM correctness boundary is
covered locally by the service-compatible continuation validator. A later
full 24-hour dense PM deployment check requires two adjacent dense source days
already present in the selected TEST index and must not be manufactured by this
experiment.

`UK_AQ_EDGE_UPSTREAM_SECRET` must be present in the shell but is never printed.
The command reports diagnostic request IDs/CF-Rays, pages, rows, continuation
count and final observation/AQI/combined hashes. Tail `cpuTime`, outcome and
`exceededCpu` are authoritative; the Worker and measurement command do no
in-process CPU timing. Pin the cap-1 hashes with the script's `--expected-...`
options on later cap runs to require exact assembled equality.

Accept this architecture only if at least one useful multi-page cap repeatedly
has clear margin below 10 ms parent CPU, no `exceededCpu`, exact hashes across
caps, correct fetch/page counts, and tolerable shared-account request volume.
If even cap 1 or a few pages repeatedly approaches/exceeds 10 ms, stop raw-row
coordination and design a compact/precomputed station-history-ready product.
