# TEST observation-history exact physical-leaf candidate

This isolated TEST candidate exercises the selected index_v3 physical leaf
mechanism without changing canonical station-history or observation-history.
Its logical history contract remains v2. Its fixed physical design is:

- `timeseries-aligned-v2`;
- one timeseries per row group;
- an aligned row cap of 1,024;
- exact-timeseries physical leaf indexes;
- exact `observed_at_utc` and `value` byte ranges;
- no runtime Parquet-footer fetch or parse; and
- no runtime `timeseries_id` decode.

The prototype namespace remains:

```text
history/_prototype/observation-history/timeseries-aligned-v2/candidate=physical-leaf-index-v1/cap_rows=1024/
```

The production-intended shared read implementation is
`workers/shared/uk_aq_observation_history_exact_leaf_reader_v3.mjs`. The
deployed `-v3-leaf-candidate` Worker is only a TEST wrapper around that shared
implementation; it does not carry a second reader implementation.

## Response and diagnostics modes

A request without `diagnostics` uses the production-shaped response and the
existing candidate Cache API policy. Its observation payload contains the
logical/index/candidate/layout/writer identities, pollutant partition,
timeseries and connector identities, requested bounds, cache scope, row count,
completeness/gap/partial fields, compact `physical_page` paging state, and the
ordered `rows`. It does not contain `coverage.exact_reader_diagnostics`, R2
keys, physical SHA-256 identities, selected-coordinate arrays, or requested
byte-range arrays. The response-cache generation is
`physical-leaf-index-v1-1024-page-4-production-shaped`, so an older cached
candidate response cannot survive a later deployment of this schema.

Two explicit TEST-only diagnostic modes bypass Cache API and return
`Cache-Control: no-store`:

- `diagnostics=workload_v1` is verbose structural troubleshooting. The HTTP
  response exposes `coverage.exact_reader_diagnostics` once; its completion
  log contains only correlation fields and a compact structural summary, not a
  second serialized copy of the full reader diagnostics.
- `diagnostics=cpu_v1` is the default deployed leaf measurement mode. Its HTTP
  response and single completion log contain only the diagnostic request ID,
  CF-Ray when available, and a bounded `cpu_measurement` summary: outcome,
  page number/path, continuation supplied, pagination complete, physical
  segments/rows decoded, returned rows, scoped-manifest/leaf/index reads,
  index bytes, discovery/sort flags, identity HEADs, R2 range reads/bytes, and
  the footer/`timeseries_id` decode flags. It does not serialize full reader
  diagnostics, keys, SHA objects, byte-range arrays, or selected-coordinate
  arrays.

Neither mode performs in-Worker timing. Cloudflare invocation `cpuTime` from
tail or Workers Analytics remains the authoritative CPU source; verbose
diagnostic serialization must not be treated as production reader cost.

## Physical paging contract

A low-level logical request must be non-empty and at most 24 hours. It may
cross UTC midnight, so a page may validate indexes from two UTC-day
partitions, but one Worker invocation opens and decodes at most one complete
physical segment and at most 1,024 physical rows.

When more intersecting segments remain, the response includes:

```json
{
  "response_complete": false,
  "has_gap": false,
  "partial_reasons": ["physical_pagination_incomplete"],
  "physical_page": {
    "pagination_complete": false,
    "next_cursor": "<opaque base64url cursor>"
  }
}
```

`has_gap` is reserved for genuine coverage loss. A final page is complete only
when physical pagination and index coverage are both complete.

The first page owns complete bounded discovery for the one or two UTC scopes
touched by the request. It validates each scoped manifest and selected exact
leaf, establishes coverage/gap state, finds the complete intersecting segment
count, and returns cursor schema v2 when another segment remains. Cursor v2
carries only bounded discovery state: one state/leaf descriptor/segment count
and first relevant coordinate per UTC scope, plus the exact next segment. It
never carries an unbounded remaining-segment list.

A continuation validates the cursor request/index/layout/profile identity and
the deterministic day/timeseries leaf key before any index read. It reads the
pinned current leaf directly, verifies its bytes against the carried size and
SHA-256, completely validates that leaf, and validates the selected and next
coordinates. Ordinary same-leaf continuations read zero scoped manifests and
do not reconstruct or globally sort the whole logical-range segment list.
Cross-scope continuation uses the first segment pinned during initial
discovery, then directly verifies the second scope's deterministic leaf before
decoding. It still decodes only one segment.

Malformed, cross-request, stale-index, stale-leaf, stale-coordinate, or
out-of-root cursors fail closed. The decode profile is the exact shared
`hyparquet-direct-column-v1` production constant selected by wrapper
configuration; no cursor-supplied decoder metadata is trusted.
Cursor v2 is not signed: the leaf route already requires the established
upstream-auth secret, and signing would not remove the need to validate every
object-routing field. The cursor is still parsed as untrusted input; its
coverage fields must be internally derivable from its bounded scope states,
and any leaf/file key that can direct I/O must match deterministic configured
roots before the first read.

`since_utc` and `limit` are rejected by this low-level endpoint. They do not
compete with `physical_cursor`; higher-level range and limiting semantics must
be applied by a later station-history page walker.

The reader verifies the manifest-pinned leaf byte size and SHA-256 and the
pinned aligned Parquet SHA-256, byte size, and ETag before range reads. It
never reads R2 outside the wrapper-provided candidate prefixes.

## Generate and validate locally

Use Node 20.20.2 with the existing aligned, physical-1024, and leaf fixtures:

```bash
node scripts/index_v3_physical_leaf_candidate/generate.mjs \
  --environment TEST \
  --aligned-root tmp/index_v3_aligned_candidate \
  --output-root tmp/index_v3_physical_leaf_candidate \
  --replace

npx --yes node@20.20.2 \
  scripts/index_v3_physical_leaf_candidate/validate_local.mjs \
  --aligned-root tmp/index_v3_aligned_candidate \
  --physical-root tmp/index_v3_physical_candidate_1024 \
  --leaf-root tmp/index_v3_physical_leaf_candidate

npx --yes node@20.20.2 \
  scripts/index_v3_physical_leaf_candidate/measure.mjs --dry-run

git diff --check
```

The focused validator page-walks normal TS7421 24h, dense TS7421 1h, and
dense TS7421 24h. It expects the existing fixture evidence of 1, 1, and 13
pages respectively, proves no invocation decodes a second segment, and
compares the assembled rows and SHA-256 with the existing physical-index-1024
reader. It also invokes the Worker in normal, `workload_v1`, and `cpu_v1`
modes, proves identical ordered response rows and the fixed deployed response
hashes, checks the diagnostic cache/no-store boundaries, and records response
bytes per page. The page counts are fixture assertions, not runtime configuration.
It also proves cursor replay/staleness rejection, a missing required leaf as a
genuine gap, the 24-hour boundary, and the explicit `since_utc`/`limit`
rejections. With the optional multiday extension fixtures it also proves a
two-page request crossing UTC midnight follows
`initial_discovery -> cross_scope_continuation`, with zero manifest reads on
the second page.

## Prototype publication (only after separate authorization)

The existing checksum-aware publisher accepts JSON only under the exact
isolated leaf prefix and rejects canonical and Parquet keys:

```bash
node scripts/index_v3_physical_leaf_candidate/publish.mjs \
  --plan tmp/index_v3_physical_leaf_candidate/publication-plan.json \
  --confirm-test-prefix history/_prototype/observation-history/timeseries-aligned-v2/candidate=physical-leaf-index-v1/cap_rows=1024
```

Do not run this as part of code review. No R2 publication is required for the
shared-reader change when the existing TEST fixture is already deployed.

## Deploy and tail on TEST only after explicit review

The separate Worker keeps `workers_dev=true`, `preview_urls=false`, and the
short `-v3-leaf-candidate` suffix:

```bash
gh workflow run uk_aq_observs_history_r2_api_v3_leaf_candidate_deploy.yml \
  --ref main

BASE_WORKER_NAME="$(gh variable get UK_AQ_OBSERVS_HISTORY_R2_API_WORKER_NAME)"
PHYSICAL_1024_WORKER_NAME="${BASE_WORKER_NAME}-v3-physical-1024-candidate"
PHYSICAL_LEAF_WORKER_NAME="${BASE_WORKER_NAME}-v3-leaf-candidate"

npx --yes wrangler@4 tail "${PHYSICAL_1024_WORKER_NAME}" --format json \
  | tee tmp/index_v3_physical_1024_candidate_tail.jsonl
```

In a second terminal:

```bash
npx --yes wrangler@4 tail "${PHYSICAL_LEAF_WORKER_NAME}" --format json \
  | tee tmp/index_v3_physical_leaf_candidate_tail.jsonl
```

The tail output is a stream of complete JSON values (despite the `.jsonl`
suffix). After a `cpu_v1` run, extract authoritative invocation CPU and its
page/request correlation with:

```bash
jq -c '
  . as $invocation
  | [
      .logs[]?.message[]?
      | fromjson?
      | select(.event == "observation_history_v3_physical_leaf_candidate_cpu_measurement")
    ][0] as $measurement
  | select($measurement != null)
  | {
      cpuTime: $invocation.cpuTime,
      outcome: $invocation.outcome,
      diagnostic_request_id: $measurement.diagnostic_request_id,
      cf_ray: $measurement.cloudflare_ray_id,
      page_number: $measurement.page_number,
      physical_page_path: $measurement.physical_page_path,
      continuation_supplied: $measurement.continuation_supplied,
      physical_rows_decoded: $measurement.physical_rows_decoded,
      returned_rows: $measurement.returned_rows
    }
' tmp/index_v3_physical_leaf_candidate_tail.jsonl
```

## Focused post-deployment measurement

```bash
export UK_AQ_V3_PHYSICAL_1024_CANDIDATE_URL="https://${PHYSICAL_1024_WORKER_NAME}.<test-account-subdomain>.workers.dev"
export UK_AQ_V3_PHYSICAL_LEAF_CANDIDATE_URL="https://${PHYSICAL_LEAF_WORKER_NAME}.<test-account-subdomain>.workers.dev"

npx --yes node@20.20.2 \
  scripts/index_v3_physical_leaf_candidate/measure.mjs \
  --physical-1024-endpoint "${UK_AQ_V3_PHYSICAL_1024_CANDIDATE_URL}" \
  --physical-leaf-endpoint "${UK_AQ_V3_PHYSICAL_LEAF_CANDIDATE_URL}" \
  --diagnostic-mode cpu_v1 \
  --repeat 1
```

The measurement client follows `physical_page.next_cursor` to completion,
records every page's path, manifest/leaf object counts, index bytes, discovery
and sorting flags, physical/returned rows, diagnostic request ID, and CF-Ray,
and fails if assembled rows differ from the physical-1024 response. It never
reports client wall time as Worker CPU. CPU evidence must be correlated per
invocation from Cloudflare tail or Workers Analytics telemetry. There is no
CPU-reactive adaptive limiter; telemetry can only support a later manual
reconsideration of the fixed cap. The cap remains 1,024 rows and one physical
segment per Worker invocation.

`cpu_v1` is the leaf default. Use `--diagnostic-mode workload_v1` only when a
full structural diagnostic response is required. The physical-1024 comparison
Worker continues to use its existing `workload_v1` mode.

## Station-history integration and system-doc handover

The TEST station-history implementation now composes arbitrary required R2
ranges internally from UTC-aligned logical pieces of at most 24 hours and
follows the private `physical_cursor` within a fixed 16-page invocation
budget. The browser-facing station-history routes do not expose a continuation
protocol. This repository change does not itself deploy or retarget either
canonical Worker.

The active system contract still describes the earlier
`timeseries-bounded-v1`/footer-derived reader. Chat-mode documentation work
must reconcile that contract with `timeseries-aligned-v2`, exact stored
ranges, one-segment physical paging, the private bounded station-history walk,
and the budget-exceeded partial reason. The shelved higher-level encrypted
station-history continuation is retained under
`archive/2026-09-02/index_v3_station_history_continuation/` for historical
reference only.

The write-side selection is now implemented in the shared production target
writer and exact-leaf index builder. This directory remains TEST calibration
and measurement evidence only; it is not a migration or steady-state runtime
dependency.
