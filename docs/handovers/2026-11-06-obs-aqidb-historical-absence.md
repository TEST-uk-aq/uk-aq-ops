# TEST ObsAQIDB historical absence — consumer correction

Status: local implementation and structural validation, 6 November 2026.
Baseline: `5492b69a3a8266f933a02d66c8e8f04ead5abdf8`.
Changes remain uncommitted. No deployment, commit, push, PR, service restart,
database operation, schema/producer change or LIVE work was performed.
Repository history was inspected read-only through GitHub, not Dropbox.

## Root cause and exact files

The producer publishes exact daily counts only between the minimum and maximum
actual observation dates. The hosted consumer treated every date absent from
that returned interval as unknown. It therefore reported the whole historical
prefix as incomplete despite a successful full-scan product proving absence.

Changed:

- `workers/uk_aq_dashboard_online_api_worker/src/lib/direct.ts`: add optional
  response-range proof to the existing fetch helpers, then apply it only to the
  ObsAQIDB consumer. Infer historical absence only from a complete coherent fresh
  summary; keep internal gaps/tail dates unknown; cap all affected cache layers
  at the source freshness deadline.
- This handover.

Today's existing `archive/2026-11-06/.../direct.ts` was reused unchanged. Other
implementation files, `dashboard/index.html`, generated config, local Python,
MySQL safeguards and the completed subrequest-budget solution were not modified.
No environment setting, endpoint, credential or schema was added.

## Evidence required before historical absence

The selected source remains the canonical
`uk_aq_public.uk_aq_obs_aqidb_day_counts_current`, filtered to `dataset=observs`
and the existing calendar range through the existing ObsAQIDB service connection.
The checked-in final-state producer is
`TEST-uk-aq-schema/schemas/obs_aqi_db/zz_2026-07-29_retire_persisted_aqilevels.sql`,
function `uk_aq_ops.uk_aq_obs_aqidb_day_counts_refresh_current`.

That function scans actual observations, generates min-to-max UTC dates with
explicit zeroes, updates all source stamps and deletes obsolete dates in its
transaction. Published fresh uniform `recorded_at` values are therefore evidence
from a successful committed producer snapshot under this contract. A successful
HTTP read alone is insufficient. This does not assume that an arbitrary sparse
summary/table has the same authority.

The same existing summary GETs now request `Prefer: count=exact`. Response
`Range-Unit: items` and `Content-Range` must prove correct offsets/body lengths,
a consistent exact result total and complete retrieval. The returned row count
must also match that total, so a filtered malformed body cannot prove completeness.
The optional range-proof plumbing has no behaviour change for other consumers.
The standard metadata is documented by PostgREST:
https://postgrest.org/en/stable/references/api/pagination_count.html

The consumer additionally requires:

- valid unique in-range UTC dates and existing row-count validation;
- strict daily continuity/order from the first through last returned date;
- valid timestamps, no future source timestamp beyond the existing allowance,
  the existing three-hour freshness limit, and one uniform producer source stamp;
- a positive first row when the returned interval starts after the calendar
  boundary, consistent with the producer's actual minimum-observation boundary.

Only after those checks does it fill calendar dates **before the first summary
row** with false. Returned positive counts remain true; returned zeroes remain
false. No dates after the last summary row are filled by this inference.

Gaps, missing/unverified count metadata, truncation or mixed snapshot stamps
prevent prefix inference and retain an explicit incomplete-summary error. Valid
fresh returned daily evidence remains available in those cases. Empty, stale or
malformed summaries retain the existing fail-closed behaviour and cannot prove
historical absence. Missing dates after the last row remain null and continue to
contribute to the unavailable-date diagnostic. Confirmed prefix absence does not.

## Caching, subrequests and preserved behaviour

The existing connection/schema/range cache identity, successful-evidence caching,
source timestamp field, explicit Refresh bypass and revision guards remain.
Five minutes remains the normal Obs cache ceiling. The inner Obs cache and both
enclosing storage/dashboard payload caches now also expire by source timestamp
plus three hours. An outer cache therefore cannot continue serving newly inferred
absence after that proof is stale.

No HEAD, separate count lookup, producer-health query or new RPC is made. The
exact count arrives in the same GET response. It adds server-side count work
over the small filtered summary, not another network request or a scan of the
observation table. The 18-row case still needs one
summary subrequest; valid cache hits need none. Exact end-of-result proof can
remove the previous extra empty-page request for a full final page. Pagination
and the existing request-budget guard otherwise remain unchanged. Near the source
freshness deadline, an expired cache correctly requires a new ordinary lookup
rather than returning stale proof; no lookup is added to an individual collection.

The R2 boundary remains generation-selected committed observation history, with
no hard-coded October date or historical cutoff. IngestDB, R2 and Dropbox flags,
RPC chunking, Dropbox eight-shard continuations/hash caching, request guards,
frontend/Console diagnostic and three-position Month/Year layout are unchanged.
Calculated AQI remains retired.

The local Python reader already falls back from a summary that does not cover
its full requested calendar range to authoritative partition discovery and
per-day observation fingerprints. Its verified positives become true and checked
empty historical days become false; failed source evidence remains unavailable.
It can have separate direct evidence for a day that the hosted summary has not
yet covered. No local code, MySQL product, publication guard or Refresh correlation
change is needed for this hosted consumer correction.

## Structural validation

- `npm --prefix workers/uk_aq_dashboard_online_api_worker run check` passes.
- A focused, nonpersistent execution of the actual consumer/fetch helper code
  checked the supplied 18-day shape, explicit zeroes, historical prefix, unknown
  tail/internal gaps, stale/empty/truncated/unproven results, retained valid
  positives, cache reuse and exact-full-page pagination. Provider I/O was replaced
  for this structural check; it is not deployed TEST functional acceptance.
- Each uncached checked case used one existing summary request, and the valid
  cache-hit check used zero. Other three source flags were unchanged.
- The three-hour inner and enclosing-cache expiry expressions were checked at
  the deadline. This closes the freshness issue found during independent review.
- `git diff --check` and complete modified-file review were performed. Unchanged
  config/frontend, local Python, budget/continuation modules and archive hashes
  were checked against the pre-change baseline. No test suite was added.

## Limitations and required real TEST acceptance

Empty summaries have no row-level producer success timestamp; they cannot prove
fresh historical absence with this interface and remain unknown. If a gateway
omits exact count/range metadata, or the producer no longer provides a coherent
uniform full-scan product, historical absence stays unknown. The minimum evidence
is an exact complete response plus fresh committed full-scan provenance. Restore
that existing response metadata/producer contract, or separately define an
explicit authoritative completeness/success watermark; do not guess from HTTP
200 or a DB-size metric. No producer/schema redesign is included here.

After separately authorising a deployment, make the reviewed change available on
an approved TEST ref through the separately authorised Git workflow. These
commands deploy that ref, not an uncommitted working tree:

```bash
obs_absence_test_ref='<approved-TEST-ref-containing-this-change>'
gh workflow run uk_aq_ops_dashboard_api_worker_deploy.yml \
  --repo TEST-uk-aq/uk-aq-ops --ref "$obs_absence_test_ref"
gh run list --repo TEST-uk-aq/uk-aq-ops \
  --workflow uk_aq_ops_dashboard_api_worker_deploy.yml --limit 1
gh run watch <API-run-id> --repo TEST-uk-aq/uk-aq-ops --exit-status
```

Only the API Worker needs deployment. No Pages deployment, schema apply, producer
run, local restart, cache rebuild or service-setting change is required.

Then on `https://cic-test-uk-aq-admin.ukaq.co.uk/ops` through Access:

1. Click calendar Refresh and wait for the existing database and Dropbox flows
   to finish. Inspect `/api/storage_coverage` in Network, then run:

   ```js
   ukAqStorageCoverageDiagnostic()
   ```

2. Confirm IngestDB is still `ok`, R2 still starts on 1 January 2020 with its
   correct historical days (including the previously verified 186 in 2020), and
   Dropbox still completes its authoritative 40-shard checkpoint at current data.
   The request budget must remain within its existing limit.
3. Confirm `errors.obs_aqidb` is null when the fresh complete summary covers its
   own min-to-max interval through the calendar's final date. Dates before the
   actual first observation date must have `obs_aqi_observs: false`, and their
   blue position must be empty rather than a question mark. Returned observations
   and explicit zero-count days must retain true/false respectively.
4. For the supplied unchanged 18-positive-row snapshot through 6 November, the
   illustrative result is 18 present, 2,484 absent and zero unknown. Acceptance
   must use fresh actual data, not demand those fixed counts after data/date changes.
5. If the calendar extends past the latest summary row (especially just after
   UTC midnight), those later days must stay unknown with an appropriate incomplete
   diagnostic. Internal gaps, missing metadata or stale evidence must not create
   a false historical prefix. Observe naturally occurring cases or use a separately
   authorised controlled check; do not mutate source data for this task.
6. Switch Month/Year, inspect historical/overlap tooltips and refresh once more.
   All three positions, other source flags, checkpoint cache reuse and local
   compatibility must remain unchanged.

## System-documentation handover and rollback

Chat-mode documentation owner: clarify that the canonical fresh complete full-scan
ObsAQIDB summary can establish historical-prefix absence, with exact response
count/range and coherent continuous source evidence. Internal gaps/unproven tail
stay unknown, and all payload caches must respect the source deadline. Narrow the
older statement that every missing summary date is unknown. No authoritative
system documentation was edited by this implementation.

Rollback only this task's reviewed `direct.ts` diff against `5492b69`, preserving
the completed subrequest solution and earlier Stage 2 corrections. Existing
same-day archives may predate those changes; do not copy an entire archive over
active code. After a separately authorised deployment, restore the prior approved
TEST API revision if needed; Pages and databases require no rollback. The old
revision restores the known incorrect historical unknown indicators.
