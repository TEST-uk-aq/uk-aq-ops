# Six-hour recent hourly prototype — TEST only

Implementation ready for review; deployment and functional/CPU acceptance are
separate operator actions. No browser integration, R2 access, caching, JSONgen,
schedules, schema changes or LIVE changes are included.

## Routes and request syntax

Public: `GET /api/aq/recent-hourly-prototype`.
Private: `GET /v1/recent-hourly-prototype`, through the existing cache-proxy
`STATION_HISTORY` Service Binding only. `workers_dev=false`,
`preview_urls=false`, and no public routes/domains on station history preserve
that boundary. No operator token or cookie is forwarded to Supabase or the
private Worker. The cache proxy authenticates before calling the binding.

Exactly two query parameters are accepted, with no duplicates, extra keys,
caller-selected windows, endpoints or limits:

```text
/api/aq/recent-hourly-prototype?timeseries_id=324&pollutant=pm25
/v1/recent-hourly-prototype?timeseries_id=324&pollutant=pm25
```

An operator can issue a public request **after separately authorised TEST
deployment**, using a valid session already established through normal website
authentication:

```bash
curl --fail-with-body --get "$TEST_CACHE_ORIGIN/api/aq/recent-hourly-prototype" \
  --data-urlencode 'timeseries_id=324' --data-urlencode 'pollutant=pm25' \
  --header "Origin: $TEST_WEBSITE_ORIGIN" \
  --cookie "uk_aq_edge_session=$TEST_SESSION" \
  --header "X-UK-AQ-Prototype-Operator-Token: $TEST_PROTOTYPE_OPERATOR_TOKEN"
```

Supply credentials securely; do not paste tokens, cookies or credential-bearing
commands into logs or evidence. Repeat the request with an explicitly approved
physical PM10/NO2 ID and `pollutant=pm10`/`pollutant=no2`. No additional IDs have
been assumed or approved by this implementation. The existing
`/api/aq/recent-aqi-prototype?timeseries_id=324&pollutant=pm25` remains separate
and unchanged.

## Configuration and security

Both Workers require exact `UK_AQ_ENV_NAME=TEST` and
`UK_AQ_RECENT_AQI_PROTOTYPE_ENABLED=true`. Both public prototype routes require
an allowed website Origin, real valid `uk_aq_edge_session`, and timing-safe
validation against the existing 32–512 character secret
`UK_AQ_RECENT_AQI_PROTOTYPE_OPERATOR_TOKEN`. Local-development bypass and
session-free display-route policy do not apply. All responses are `no-store`.
Failures expose stable codes, never arbitrary upstream error text or bodies.

Station history recognises the existing
`UK_AQ_RECENT_AQI_PROTOTYPE_TIMESERIES_ID` as one AURN PM2.5 permission. With
the current approved value `324`, this permits physical connector 1,
timeseries 324, pollutant pm25; station 441 is resolved from authoritative
metadata, never supplied by the caller. The old route uses only this old
configuration and remains PM2.5-only.

The new optional **TEST-only GitHub variable**
`UK_AQ_RECENT_HOURLY_PROTOTYPE_ALLOWLIST` extends only the six-hour route.
Its value is a JSON array of 1–16 objects, at most 4096 characters. Each object
must contain exactly three fields: a positive safe-integer numeric
`timeseries_id`, numeric `connector_id=1`, and `pollutant` equal to `pm25`,
`pm10` or `no2`. Example using the already approved physical series:

```json
[{"timeseries_id":324,"connector_id":1,"pollutant":"pm25"}]
```

An operator may add independently verified/approved AURN PM10 and NO2 entries
in the same format. Duplicate array IDs, conflicting permission for the old
ID, malformed entries or non-AURN connectors fail closed with HTTP 503
`prototype_allowlist_unavailable`. A matching old-ID entry is allowed.
The old ID plus 16 additional entries gives at most 17 permissions. With both
settings absent, access fails closed. Unlisted requests fail with HTTP 400
before any Supabase call. Authoritative metadata must match the approved
physical timeseries, connector and pollutant; inactive/unusable/mismatched
metadata fails closed. Sensor.Community and other networks are excluded.

The station-history deployment workflow maps the new GitHub variable into the
Worker alongside existing runtime settings, passing JSON through a shell
environment variable and `jq --arg` so embedded JSON quotes are preserved.
The ops sync target catalogue includes it as `variable`. No GitHub variables,
secrets or cloud settings were populated by this change. `env-vars-master.csv`
is not present in this repository/workspace's documentation checkout; its
external catalogue entry requires a separate documentation-owner amendment.

## Selection, query and calculation

One authoritative `uk_aq_core.timeseries` lookup includes `last_value_at`.
One POST to the existing `uk_aq_public.uk_aq_timeseries_rpc` uses
`window_label=30d`, `include_status=false`, `limit_rows=129`, and a fixed
metadata-anchored `since_ts`. The active configured public schema is honoured.
No Edge Function, six-per-endpoint reads, retries or database writes occur.
Pre-auth/request rejection generates zero Supabase requests; a valid successful
request generates two HTTP calls total: one identity lookup and one observation
RPC. Failure stops at its current stage, with at most those two calls.

For PM, `since_ts = last_value_at - 53h`: 29 hours of required represented
context plus the existing 24-hour selected-endpoint backtrack allowance. For
NO2 it is `last_value_at - 30h`: six represented hours plus the same allowance.
The metadata timestamp is only an anchor. The maximum actual valid exact UTC
hour timestamp no later than the latest completed clock hour selects endpoint
`n`. Returned source rows are parsed once and grouped without deduplication.
No sub-hour rounding is permitted; eligible sub-hour input fails with
`source_timestamp_convention_unverified`. Rows later than the latest completed
clock hour are excluded and counted separately.

Output endpoints are `n-5, n-4, n-3, n-2, n-1, n`, with represented intervals
`(endpoint-1h, endpoint]`. For example, `n=12:00Z` yields 07:00 through 12:00Z,
representing `(06:00Z,12:00Z]`. A later invalid observation is reported separately
from the latest selected valid endpoint. Observation age is measured against
request time; successful old readings are not described as current-hour data.

PM requires context endpoints `n-28` through `n`, i.e. `(n-29h,n]`; the first
output's rolling window contains exactly `n-28` through `n-5`. The full context
must fit inside both `since_ts` and the RPC's 30-day start. Failure produces
`source_context_outside_metadata_anchor` or `source_window_limit_exceeded`
(HTTP 422), never a calculation claimed complete over truncated context. Missing
valid observations within that bounded query remain explicit source gaps.

The shared `lib/aqi/aqi_levels.mjs`, algorithm `aqilevels_hourly_v2`, receives
one chronological hourly grid (29 rows for PM, six for NO2). It calculates
rolling PM context once for the whole sequence; only six rows are normalised
and returned. PM DAQI requires 18 of 24 valid hourly means; PM EAQI uses the
current hourly mean. NO2 DAQI and EAQI both use the hourly mean. Missing/invalid
current hours do not suppress an independently valid PM rolling DAQI. The
existing prototype adaptation labels entirely empty PM windows
`insufficient_samples`, as required by the active contract; shared mathematics,
breakpoints and helper code are unchanged. No output extends beyond `n`.

Fixed limits remain 128 source rows (129th sentinel rejects truncation),
48 KiB upstream observation response, 8 KiB identity response, 2.5 seconds per
upstream operation and four seconds elapsed checked between stages. The new
JSON output also has a 48 KiB cap. Approximately 53 hourly input rows for a
normally current PM source fit these bounds; duplicates and anomalously broad
metadata lag still count toward the cap. No high-frequency assumption is made.

CPU decisions: one shared read/parse, one numeric-timestamp grouping pass,
bounded chronological grid, no source-array sorting, no six independent rolling
helper invocations, no R2, no caching, no per-observation application logs.
The shared helper's bounded internal sort/timestamp processing is retained;
its algorithms were not changed for this experiment. A source response is
serialised only once for delivery. These choices do not establish CPU acceptance.

Traffic is operator-driven only, with no scheduled cadence or autonomous load
generation. At N successful requests/day, there are 2N Supabase HTTP calls
(N identity GETs and N RPC POSTs), with a peak of two per invocation and no
retries. Platform-generated gateway/PostgREST logs still result. Added daily
log bytes are unmeasured and depend on operator volume and Supabase accounting;
compare organisation usage against the authoritative 30 MB/day budget after
deployment. No per-request Supabase log/metric writes are added.

## Response schema and illustrative rows

`schema_version` is `recent_hourly_prototype_v1`. Successful responses contain:

| Field | Meaning |
|---|---|
| `request` | Physical timeseries, connector, station, pollutant and request UTC timestamp |
| `selection` | Actual selected endpoint, latest eligible source timestamp/validity, age, clock bound, metadata anchor and six-hour interval |
| `observations.rows` | Exactly six chronological slots, physical identity, interval, `valid`/`invalid`/`missing`, hourly mean, valid/invalid counts and all source timestamps/values in that output slot |
| `observations.missing_hour_endpoints_utc` | Output slots without a valid mean, including invalid-only slots; never imputed |
| `aqi` | Shared algorithm/version, source, averaging codes, per-index gaps and six rows |
| `aqi.rows` | Physical identity, interval, independent DAQI/EAQI indices, input concentrations, source/required counts, calculation statuses and missing reasons |
| `source` | IngestDB-only authority limit, separate transport/query/canonical completeness, context bounds/gaps/counts, future exclusions, input bytes, RPC elapsed ms and request counts |

Every AQI row includes `connector_id`, `station_id`, `timeseries_id` and
`pollutant_code` from the resolved authoritative identity; the algorithm version
is provided by `aqi.algorithm_version`.
The following excerpts illustrate fields; they are documentation examples,
not measured TEST output or complete six-row responses:

```json
{
  "timestamp_hour_utc":"2026-10-16T12:00:00.000Z",
  "period_start_utc":"2026-10-16T11:00:00.000Z",
  "period_end_utc":"2026-10-16T12:00:00.000Z",
  "connector_id":1,"station_id":441,"timeseries_id":324,"pollutant":"pm25",
  "status":"valid","hourly_mean_ugm3":8,
  "valid_source_row_count":1,"invalid_source_row_count":0,
  "source_observations":[{"observed_at":"2026-10-16T12:00:00+00:00","value":8,"status":"valid"}]
}
```

An internal missing PM hour can have a valid rolling DAQI independently of EAQI:

```json
{
  "timestamp_hour_utc":"2026-10-16T10:00:00.000Z",
  "period_start_utc":"2026-10-16T09:00:00.000Z",
  "period_end_utc":"2026-10-16T10:00:00.000Z",
  "connector_id":1,"station_id":441,"timeseries_id":324,"pollutant_code":"pm25",
  "daqi_index_level":1,"daqi_input_value_ugm3":8,
  "daqi_source_observation_count":23,"daqi_required_observation_count":18,
  "daqi_calculation_status":"ok","daqi_missing_reason":null,
  "eaqi_index_level":null,"eaqi_input_value_ugm3":null,
  "eaqi_source_observation_count":0,"eaqi_required_observation_count":1,
  "eaqi_calculation_status":"missing_input","eaqi_missing_reason":"no_input_value"
}
```

Invalid-only observation slots have `status=invalid`, null hourly mean and the
invalid source count; absent slots have `status=missing` and an empty source
array. Valid source values and timestamps are preserved. Non-numeric/non-finite
values are represented as null and invalid; negative numeric inputs remain
visible in the source array but never contribute to the mean. Multiplicity at
one timestamp contributes to that hour's mean, not extra PM rolling hours.

`transport_ok`, `bounded_query_complete`, and `ingestdb_response_complete=true`
mean the authorised bounded query completed within all checks. They do not
prove that every hour has readings. Input valid/invalid counts exclude
clock-future rows, which have their own count; context counts cover only the
six/29 represented hours. `outside_context_row_count` counts only non-future
rows outside that context. The valid-context, invalid-context, excluded-future
and outside-context row counts are mutually exclusive and sum to `raw_row_count`.
Context missing endpoints mean no valid mean in
this IngestDB read, not a verified canonical absence. `canonical_history_complete`
and overall `response_complete` stay false, with reason `canonical_r2_not_read`.
HTTP 200 never establishes canonical historical authority. Source mode remains
`ingestdb_only_uncommitted` and AQI source `live_calculated_ingestdb_only`.
All errors use `{"ok":false,"error":{"code":"…","route":"/v1/recent-hourly-prototype"}}`
at the private handler; public auth/routing errors retain cache-proxy conventions.

## Structural checks

Passed: `node --check` on the changed station-history modules; import of the new
handler; esbuild 0.25.12 bundles of both Worker entry points and syntax checks
on both bundles; TOML parsing of both Worker configurations; deployment YAML
and embedded shell syntax parsing; local `jq` mapping of quoted allowlist JSON;
CSV validation of the new variable; byte-for-byte pre-change archive comparison;
and `git diff --check`. Build scratch output is not committed. No functional
fixture programme, load test or real TEST request is part of this change.

## Manual TEST deployment (not executed by Codex)

Do not merge/deploy until separately authorised. Existing `main` push workflows
can deploy automatically after a later merge; this PR does not merge or trigger
deployment. An operator must verify repository identity, TEST Supabase URL,
Cloudflare account, existing session/origin settings, binding target and
approved allowlist first. Retain all unrelated deployment settings. Adding a
PM10 or NO2 entry requires its actual approved physical ID; none is invented.

From an authenticated operator checkout, use the reviewed branch/ref (replace
the value if review adds a new ref), deploying station history first:

```bash
REVIEWED_REF=codex/recent-hourly-aqi-prototype
gh workflow run uk_aq_station_history_deploy.yml \
  --repo TEST-uk-aq/uk-aq-ops --ref "$REVIEWED_REF"
gh run list --repo TEST-uk-aq/uk-aq-ops \
  --workflow uk_aq_station_history_deploy.yml --branch "$REVIEWED_REF" --limit 1
# Set STATION_RUN_ID to that dispatch's run ID; verify its head SHA is reviewed.
gh run watch "$STATION_RUN_ID" --repo TEST-uk-aq/uk-aq-ops --exit-status

gh workflow run uk_aq_cache_proxy_deploy.yml \
  --repo TEST-uk-aq/uk-aq-ops --ref "$REVIEWED_REF"
gh run list --repo TEST-uk-aq/uk-aq-ops \
  --workflow uk_aq_cache_proxy_deploy.yml --branch "$REVIEWED_REF" --limit 1
# Set CACHE_RUN_ID to that dispatch's run ID; verify its head SHA is reviewed.
gh run watch "$CACHE_RUN_ID" --repo TEST-uk-aq/uk-aq-ops --exit-status
```

These workflows perform the established secret mapping and Worker deployment;
do not substitute a bare `wrangler deploy` that omits those settings/binding
resolution. If the existing deployment uses the unrelated opt-in compressed
history pilot, preserve its approved `activate_compressed_chart_history` input
when dispatching cache-proxy deployment. Do not enable that pilot for this task.
Before dispatch, record both current Worker version IDs and relevant TEST
runtime settings for rollback. No new variables/secrets were set by Codex.

## Post-deployment operational checks (operator only)

1. Existing single-result PM2.5 still returns its original contract for 324,
   connector 1, station 441. Normal station-series/AQI-history/observation and
   browser routes retain their existing behaviour.
2. New PM2.5, approved PM10 and approved NO2 requests each return six consecutive
   endpoints ending at an actual valid source hour, no later than the completed
   UTC clock hour. Confirm physical identity and pollutant against metadata.
3. Confirm actual source timestamps, duplicate counts/hourly means, invalid
   values, internal missing hours, separate later invalid observations and
   selected-observation age. Never infer a latest reading from metadata alone.
4. PM earliest output uses `n-28` through `n-5`, final output uses `n-23` through
   `n`, counts valid hourly means, requires 18, and preserves independent EAQI.
   Internal missing hours can retain rolling DAQI. NO2 uses current hourly means
   only. Verify insufficient samples without treating them as transport errors.
5. Confirm missing/unallowed Origin, missing/expired/wrong-origin session,
   missing/wrong operator token, HEAD, extra/duplicate query parameters,
   unlisted/wrong-pollutant IDs, disabled/non-TEST flags and malformed allowlist
   fail closed. Local-dev bypass must not help. The private Worker must have no
   public workers.dev/preview/domain access. Do not include credentials in evidence.
6. Confirm `Cache-Control: no-store` and distinct request paths/header
   `X-UK-AQ-Prototype-Route: recent-hourly-ingestdb` in bounded Cloudflare evidence.
   Successful IngestDB queries remain explicitly canonical-incomplete.
7. Attribute CPU separately to station history and cache proxy, grouped by route
   and pollutant, with p50/p95/p99/maximum, request counts, errors and
   `exceededCpu`. Provisional targets: typical preferably <=5 ms, p95 <8 ms,
   p99 and maximum <10 ms, zero `exceededCpu`. Keep the initial 5 ms/4 ms
   single-result sample as baseline evidence only, not an acceptance claim.
8. Confirm one identity GET and one RPC POST per successful request, no retries,
   no R2 reads, input response size/row bounds, output size, latency and no
   truncation; compare Supabase log usage over a clearly labelled observation
   window with operator request volume. No scheduled or unbounded polling.

## Rollback

To remove only new permissions, clear the new allowlist variable and redeploy
station history through the established workflow; the old configured PM2.5 ID
remains permitted on both routes. To disable both prototypes, set the existing
TEST enable flag false and redeploy both Workers. These settings changes require
operator authorisation and are not performed by this PR.

For complete code rollback, restore the previously recorded TEST deployments
in reverse order (cache proxy then station history), preserving their runtime
settings. From each Worker directory with the correct TEST Cloudflare identity:

```bash
npx --yes wrangler@4.130.0 rollback "$PREVIOUS_CACHE_VERSION_ID" --name "$TEST_CACHE_WORKER_NAME"
npx --yes wrangler@4.130.0 rollback "$PREVIOUS_STATION_VERSION_ID" --name "$TEST_STATION_HISTORY_WORKER_NAME"
```

Run the cache command from `workers/uk_aq_cache_proxy`, and the station command
from `workers/uk_aq_station_history`. Version rollback may not restore all
secrets/settings; restore the recorded values through the established workflow
if required. Pre-change code snapshots in `archive/2026-10-16/` are reference
only; active paths must never execute/import archived code. No data migration,
R2 object cleanup or website rollback is needed.

## Authoritative documentation handover for ChatGPT

Do not edit the read-only system-docs repository as part of this implementation.
ChatGPT should record this isolated, IngestDB-only prototype in the AQI/station
history and cache-proxy authority, clearly separate from normal R2-first chart
semantics and future JSONgen. Record the routes/schema, inherited security,
new bounded allowlist, PM 29-hour/NO2 six-hour context, 53h/30h anchor overlap,
counts/limits, source-completeness caveat and unchanged shared algorithm.
Add `UK_AQ_RECENT_HOURLY_PROTOTYPE_ALLOWLIST` to the authoritative external
`env-vars-master.csv` catalogue if maintained there: optional TEST GitHub variable,
station-history deployment target, no secret value, format/bounds above.
No SQL, RPC, schema, index, new secret or browser deployment is required.
Mark deployment and CPU/functional validation **pending** until real operator
evidence exists; do not promote local structural checks to operational acceptance.
