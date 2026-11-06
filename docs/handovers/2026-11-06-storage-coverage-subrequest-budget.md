# TEST Storage Coverage Calendar — bounded subrequests

Status: local implementation and structural validation, 6 November 2026.
Baseline: `8757b5af8ae9dd82b2f3123ae30d22c26eface5c`.
All changes remain uncommitted. No push, PR, deployment, restart, database
operation, Dropbox API operation, settings change or LIVE work was performed.
GitHub was used read-only to confirm repository history. Existing local TEST
checkpoint files were read as format/dependency evidence, not executed.

## Root cause and chosen architecture

The old calendar reused `fetchDashboardBaseData()` with metric context enabled.
It downloaded every referenced Dropbox month alongside unrelated account/size/
egress work, then fetched ObsAQIDB summaries and IngestDB RPC chunks. The same
collection path could be reached by `/api/dashboard`; upstream HTTP enrichment
also contained a second whole-history Dropbox reader.

The existing synced TEST v3 checkpoint has 40 observation-month references.
All 40 local files match their root's raw-byte SHA-256 and pass the new reader's
schema/copy-evidence validation; they contain 1,178 checkpoint days. This is an
existing local snapshot, not a fresh hosted-cloud inspection. The authoritative
root has month references/hashes, not a complete daily array. It cannot replace
reading its children. The deployed count must be confirmed after deployment.

Forty shard reads plus OAuth/root reads use 42 external requests. Seven IngestDB
RPC calls and three summary pages make 52 before an uncached R2 lookup or other
metrics; a cold R2 lookup makes at least 53. Limiting concurrency cannot fix this.
Cloudflare documents the Free limit as 50, including redirect-chain calls;
Cache API operations also share the quota:
https://developers.cloudflare.com/workers/platform/limits/

The smallest chosen solution uses the existing Worker and Cache API:

1. `/api/storage_coverage` reads only selected-generation R2 history and the two
   database coverage sources. Dropbox is explicitly pending/unknown.
2. The shared browser follows `source=dropbox` continuations on the same route.
   Each invocation checks at most eight checkpoint shards and never runs database
   or unrelated metric collection. No Worker-to-self request is used.
3. Verified historical shard receipts are reusable only when the current
   authenticated root supplies their identical SHA-256. Complete publication
   requires every referenced month, a final observation-root identity check and
   fresh canonical serving-generation validation.

No producer change, new cloud service, database, subscription, credential,
endpoint configuration or environment-specific application code is needed.
Local Python, MySQL and the request-correlated local Refresh protocol are unchanged.

## Exact files changed

| File | Purpose |
| --- | --- |
| `workers/uk_aq_dashboard_online_api_worker/src/lib/coverage_request_budget.ts` | New request-owned 40-operation guard for fetch and Cache calls; redirects are manual. |
| `workers/uk_aq_dashboard_online_api_worker/src/lib/storage_coverage_dropbox.ts` | New bounded checkpoint reader, strict hash/schema/copy validation, immutable continuation steps and complete snapshot cache. |
| `workers/uk_aq_dashboard_online_api_worker/src/lib/direct.ts` | Remove whole-history Dropbox loop, use a lightweight calendar path, defer backup, reuse existing Dropbox configuration/OAuth helpers and expose bounded request counts. |
| `workers/uk_aq_dashboard_online_api_worker/src/lib/storage_coverage_http_enrichment.ts` | Remove the duplicate whole-history Dropbox reader; retain generation-validated independent R2 enrichment and bounded source diagnostics. |
| `workers/uk_aq_dashboard_online_api_worker/src/lib/storage_day_presence.ts` | Recognise subrequest exhaustion separately while preserving authoritative RPC validation, chunking and caching. |
| `workers/uk_aq_dashboard_online_api_worker/src/lib/upstream.ts` | Carry internal request budget; meter any existing calendar proxy/cache operations without enabling upstream mode. |
| `workers/uk_aq_dashboard_online_api_worker/src/lib/service_egress_metrics.ts` | Do not follow redirects on the reserved telemetry request. |
| `workers/uk_aq_dashboard_online_api_worker/src/routes/compat.ts` | Dispatch the bounded Dropbox source after canonical generation resolution; avoid duplicate metric enrichment on the calendar path. |
| `dashboard/index.html` | Follow continuations, show bounded progress, preserve per-source independence and prior complete backup evidence, expire retained markers, expose a safe Console summary. |
| This handover | Protocol, budget accounting, structural evidence, deployment/acceptance and rollback. |

Existing dated code archives were reused unchanged. Previously unarchived
`upstream.ts` and `service_egress_metrics.ts` were copied once into matching
relative paths under `archive/2026-11-06/`. The two new modules have no pre-change
source to archive. No archive is an execution dependency. `config.js` is unchanged.

## Protocol, authority and completeness

A base calendar response adds:

```json
{"dropbox_coverage":{"protocol":"checkpoint_batches_v1","status":"pending","complete":false}}
```

The browser requests `GET /api/storage_coverage?source=dropbox`. A pending response
returns a server-created `collection_id`, next integer `cursor`, checked/total/
remaining shard counts and an opaque observation-checkpoint identity. Subsequent
requests add `collection_id` and `cursor`. No account path, caller-selected shard
path, token or credential is returned. Continuations are opaque Cache API records,
not browser-authorised source paths; each request independently resolves the
canonical descriptor and scopes cache lookup to its complete generation/config.
Existing Cloudflare Access and API routes are unchanged.

Every root and month must match schema 1/logical backup v2. The root must match
the selected physical observation generation. Month paths must be exactly under
that descriptor's checkpoint prefix, with unique valid year/month identities.
Each shard's original bytes must hash to its parent reference. Day identities,
manifest hashes and successful copy timestamps are validated. Historical copy
stamps may be old; future or missing copy evidence is invalid. Retired calculated
AQI is not read or displayed.

The observation-checkpoint identity covers the complete descriptor, observation
processed-root/year identities and all normalised month paths/processed hashes/
byte hashes. Unrelated binding/Core progress in the shared root does not invalidate
observation receipts. Every continuation re-reads the authenticated root; final
publication re-reads its observation identity and the canonical serving descriptor.
An observation checkpoint change, mixed-generation result or child-before-parent
race fails/restarts the candidate instead of combining incompatible months.

`complete` means all referenced checkpoint shards have been collected/validated.
`checkpoint_complete` separately reports whether the producer has completed its
observation checkpoint. A fully read but partial producer checkpoint reports
`status: partial`: confirmed copied days are true and unconfirmed days are null.
It is not published into the verified-complete snapshot cache. Only a complete
producer checkpoint permits false for days without recorded backup success.

Every valid checkpoint day is returned by the source reader. The browser only
applies those flags to existing calendar rows; it never creates dates outside
the committed R2 boundary or infers backup success from R2. R2, IngestDB and
ObsAQIDB remain independent of that backup result.

A failed/unexamined shard cannot make the collection complete or make any new
negative backup flags. Failure returns a bounded source-specific unavailable
state, with progress counts where available. Successfully verified receipts may
survive for retry, but failed/partial collections do not replace a prior complete
snapshot. The client separately retains its last complete backup snapshot for
at most five minutes, clearly marked stale while pending/unavailable. A guarded
expiry timer repaints retained cells as unknown even on an idle tab. Unknown
markers and day tooltips distinguish retained values from current unknown backup. A newly
observed generation clears incompatible source state immediately.

## Cache and Refresh behaviour

- Collection steps are immutable keys `(config/generation, random UUID, cursor)`
  with an absolute ten-minute lifetime. Concurrent/replayed steps are idempotent;
  a slower completion cannot overwrite a later step. Only data, never provider
  I/O promises, survives an invocation.
- There is one receipt slot per month/config/generation, with a one-day lifetime.
  A cached receipt is used only after its hash and processed identity match the
  freshly read root. Changed hashes require a new body download and validation.
  Filename, age, ETag or R2 presence cannot establish equality.
- Complete snapshots are keyed by config/generation and observation-checkpoint
  identity, and expire after five minutes. Failures never write that cache. An
  older candidate cannot replace another checkpoint identity. A warm complete
  snapshot still requires a fresh authenticated root and generation check.
- Explicit Refresh bypasses existing database/R2 evidence caches, starts a fresh
  authoritative root check and may reuse proven-unchanged historical receipts.
  The button stays Updating throughout hosted continuations. A slow collection
  that outlives IngestDB evidence fetches a fresh lightweight database response
  before final assembly. Browser sequence and manual-session guards reject
  superseded responses.
- Cache eviction or a different data-centre cache can require restarting the
  collection. The browser retries once, then reports unavailable while keeping
  other valid sources and any still-valid previous backup snapshot. No incomplete
  collection is silently promoted and no hosted dependency on the Mac is added.

The local backend does not receive the new protocol marker and therefore retains
its existing MySQL/Refresh handshake. Its failed-rebuild publication rules and
configured physical R2 intersection remain unchanged. No local restart or MySQL
rebuild/migration is needed for these code changes; reload the shared frontend.

## Per-invocation accounting

All calendar-owned fetches and Cache API calls use a request-owned guard of 40,
leaving ten slots below the Free limit for descriptor/telemetry overhead. Redirects
are not followed. The selected direct calendar and Dropbox paths need no more
than two descriptor reads and one reserved telemetry request: hard ceiling 43.
An unexpectedly oversized database collection fails closed at the guard, without
truncating the calendar or presenting incomplete database evidence as false.

For the actual 2,502-day range and normal 1,000-row summary pagination:

| Invocation | Upper bound including non-Dropbox work |
| --- | --- |
| Cold database/R2 calendar | 1 descriptor + 1 R2 + 7 IngestDB RPC + 3 ObsAQIDB pages + 1 telemetry = **13** |
| Cold initial/nonfinal eight-shard batch | 1 descriptor + 1 token + 1 root + 1 state/snapshot match + 24 receipt match/download/put operations + 1 progress put + 1 telemetry = **30** |
| Cold final eight-shard batch | 2 descriptors + 1 token + 2 root reads + 1 state match + 24 receipt operations + 1 complete-snapshot put + 1 telemetry = **32** |
| Proven-unchanged complete snapshot | 2 descriptors + 1 token + 1 root + 1 snapshot match + 1 telemetry = **6** |

The final cold bound contains 14 external fetches and 18 Cache operations. The
40-operation guard counts both. No recursive Worker or browser call is hidden in
these totals. With 40 cold shards, initial loading normally uses one database
request plus five bounded backup requests. A warm unchanged snapshot needs one
backup request; if its short-lived aggregate expired, historical month receipts
still avoid downloading unchanged years again.

`/api/dashboard` can still perform its own metrics work, but no longer walks any
Dropbox historical shard tree. Existing structured history reads likewise cannot
reach the removed whole-history loop. This is not a whole-application audit of
unrelated metrics pagination, Dropbox mtime listing or other Worker APIs.

IngestDB still uses `uk_aq_rpc_observation_day_presence_v1`, complete chunks of
at most 366 UTC dates, strict response/time checks and five-minute successful
caching. ObsAQIDB still uses its authoritative summary with the three-hour source
freshness rule and null for missing dates. A shorter range is not used: the
confirmed R2 start remains **2020-01-01**. Database recovery from the observed
exhaustion must be demonstrated after deployment; no validator was weakened.

## Structural evidence

- Existing Worker `npm run check` passes.
- The dashboard inline JavaScript parses; three fixed visual positions remain.
- The request guard rejects operation 41; final cold-batch accounting is 32.
- The actual strict reader accepted the existing local TEST root and all 40
  hash-matching shards/1,178 copied days; a generation mismatch was rejected.
  An unrelated Core update leaves observation identity unchanged.
- A focused clock-boundary check verified that retained Dropbox flags become
  unknown through the expiry callback without another network response.
- `git diff --check`, complete diff review and configuration/archive hash checks
  were performed. A focused independent reviewer found the expiry gap; it was
  corrected. No speculative test suite was added.

These are structural/local-data checks, not deployed functional acceptance.
Actual Free runtime/CPU behaviour, Cache API availability/locality, provider
recovery, Access and browser operation still require the following real TEST run.

## Separately authorised TEST deployment and acceptance

Do not run these as part of the current local-only task. Once separately approved
changes exist on a reviewed TEST Git ref, deploy API first and Pages second from
the same ref using existing environment configuration:

```bash
calendar_budget_ref='<reviewed-TEST-ref-containing-this-change>'
gh workflow run uk_aq_ops_dashboard_api_worker_deploy.yml \
  --repo TEST-uk-aq/uk-aq-ops --ref "$calendar_budget_ref"
gh run list --repo TEST-uk-aq/uk-aq-ops \
  --workflow uk_aq_ops_dashboard_api_worker_deploy.yml --limit 1
gh run watch <API-run-id> --repo TEST-uk-aq/uk-aq-ops --exit-status

gh workflow run uk_aq_ops_dashboard_pages_deploy.yml \
  --repo TEST-uk-aq/uk-aq-ops --ref "$calendar_budget_ref"
gh run list --repo TEST-uk-aq/uk-aq-ops \
  --workflow uk_aq_ops_dashboard_pages_deploy.yml --limit 1
gh run watch <Pages-run-id> --repo TEST-uk-aq/uk-aq-ops --exit-status
```

The workflows deploy a Git ref, not an uncommitted working tree. No current-task
commit/push/PR authority is implied. No schema, provider/backup deployment,
Cloudflare setting, new secret, local service restart or database work is required.

On `https://cic-test-uk-aq-admin.ukaq.co.uk/ops` through Access:

1. Reload, open Network and click calendar Refresh once. Confirm the base
   `/api/storage_coverage` response and bounded `source=dropbox` continuations.
   Each backup response has at most eight newly checked shards. No database calls
   are repeated by those source requests. Updating must span all continuations.
2. Confirm generation v3, first date **2020-01-01**, current UTC final date,
   continuous calendar dates and **186 confirmed R2 observation days in 2020**.
   Month/Year navigation must keep all historical coverage available.
3. Confirm IngestDB `status: ok`, real Boolean daily evidence, exact calendar
   bounds and unchanged five-minute check/expiry semantics. ObsAQIDB must return
   validated daily flags or its own bounded error, with missing dates unknown.
   Neither database may fail merely because Dropbox is unavailable.
4. Confirm `dropbox_coverage.complete: true`, all referenced shards checked and
   none remaining; normal accepted producer state should also have
   `checkpoint_complete: true`. Compare day indicators/counts with the actual
   generation-matched authoritative checkpoint. If the producer is in progress,
   accept only explicitly partial positives/nulls, never a claimed complete backup.
5. Refresh again: the authenticated root must be checked, while unchanged month
   bodies are reused by hash. Warm complete snapshot reuse should avoid shard
   downloads. Inspect bounded `request_budget_used`/limit values and existing
   safe Worker diagnostics; no subrequest exhaustion may occur.
6. Confirm three positions in Month and Year: red IngestDB, blue observations,
   orange R2 with the original small Dropbox badge. Check an IngestDB/R2/Dropbox
   overlap, backup-only evidence, unknown markers, tooltips and date navigation.
7. On a naturally occurring source failure, or a separately authorised controlled
   failure, confirm other sources remain visible. An incomplete/failed backup
   collection must not replace the previous verified complete cache entry. The
   UI must label retained evidence stale and turn retained markers unknown at
   five minutes, including while the tab is idle. No source failure should erase
   successful database/R2 flags. A changed generation must discard incompatible
   rows immediately. Do not change credentials/settings just to run this check.
8. Reload the existing local TEST page. Confirm the unchanged local MySQL Refresh
   request correlation and failed-refresh preservation; this frontend must not
   call the hosted-only source protocol for local payloads without its marker.

After the real page has loaded/refreshed, this compact Console diagnostic reads
only the responses already used by the UI, with no extra downloads or credentials:

```js
ukAqStorageCoverageDiagnostic()
```

It reports status, generation, range, source error categories, confirmed/absent/
unknown source-day counts, the 2020 R2 count, checkpoint collection/producer
completeness, checked/remaining shards and request counts. It deliberately does
not print provider bodies, account configuration or checkpoint paths. A non-UI
API consumer must follow the documented `source=dropbox` protocol to obtain the
complete backup source; the base response alone deliberately reports it pending.

## Documentation handover and rollback

Chat-mode system-doc owner: update dashboard data sources/hosted runtime/Refresh
contracts with the additive bounded source protocol, separate database and backup
invocations, observation-identity/hash reuse, completeness versus producer state,
failure preservation and expiry. The backup producer/checkpoint format itself is
unchanged. No authoritative system docs were edited here.

Before deployment, reverse only this task's reviewed diff against `8757b5a`,
preserving the prior R2 start-date correction, three-position presentation and
Stage 2 authority/caching safeguards. Existing same-day archives may predate those
fixes; do not wholesale-copy them over active files. After a separately authorised
deployment, restore a matched approved API/Pages release. New cache entries are
derived/versioned/expiring and need no authoritative-data rollback or MySQL work.
The baseline release has the known subrequest exhaustion; reverting is not proof
of restored functional backup coverage.
