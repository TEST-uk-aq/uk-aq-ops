# Historical JSON reader: local TEST implementation handover

2 November 2026. All edits are local and uncommitted. **Deployment, publication and real TEST
functional/performance acceptance remain outstanding.** No branch, commit, push, PR, database
mutation, R2 upload/selection, Prune run, managed JSONgen activation or LIVE work was performed.
The supplied candidate and retained algorithm-v2 evidence were read only and remain unchanged.

## Implementation by repository

**TEST Ops** now owns a separate manual paired-selection schema/admission CLI, lightweight
private read routes and authenticated forwarding through the existing proxy. The original
Bootstrap observation/AQI gzip objects are served directly, without serving-time decompression,
full-object hashing or AQI calculation. The existing private binding and server-only auth are reused.
Normal station history and the old fixed-admission compressed prototype are unchanged.

**TEST website** now has a reusable optional shared JSON provider, shared-cache immutable object
storage and optional raw-row identity preservation, controller-owned selection snapshots and
300-second discovery/Refresh, shared diagnostics and a dedicated comparison page. The page uses
one real controller/cache/normalizer/renderer. Neither Hex Map nor Sensors selects the provider.
Newest-month first loading feeds older work through the existing shared settlement planner.

**Ingest/system-docs:** no implementation or authoritative documentation edits.

## Exact changed files

Paths below are relative to their named repository.

TEST Ops — modified:

- `workers/uk_aq_cache_proxy/src/index.ts`
- `workers/uk_aq_compressed_chart_history/worker.mjs`

TEST Ops — added:

- `workers/shared/uk_aq_historical_json.mjs`
- `workers/uk_aq_compressed_chart_history/historical-json.mjs`
- `scripts/historical_chart_json/admit.mjs`
- `scripts/historical_chart_json/initial-test-policy.json`
- `scripts/historical_chart_json/README.md`
- `scripts/historical_chart_json/IMPLEMENTATION_HANDOVER.md`
- `docs/superpowers/plans/2026-11-02-historical-json-reader.md`

TEST website — modified:

- `shared/station-chart/station-chart-cache.js`
- `shared/station-chart/station-chart-controller.js`
- `shared/station-chart/station-chart-diagnostics.js`
- `shared/station-chart/station-chart-runtime.js`
- `scripts/uk_aq_finalize_page_metadata.mjs`

TEST website — added:

- `shared/station-chart/historical-json-client.js`
- `historical-json-chart-test/index.html`
- `historical-json-chart-test/viewer.js`
- `historical-json-chart-test/viewer.css`

Exact pre-change source snapshots (restoration only):

- Ops: `archive/2026-11-02/workers/uk_aq_cache_proxy/src/index.ts`
- Ops: `archive/2026-11-02/workers/uk_aq_compressed_chart_history/worker.mjs`
- Website: `Archive/2026-11-02/shared/station-chart/station-chart-cache.js`
- Website: `Archive/2026-11-02/shared/station-chart/station-chart-controller.js`
- Website: `Archive/2026-11-02/shared/station-chart/station-chart-diagnostics.js`
- Website: `Archive/2026-11-02/shared/station-chart/station-chart-runtime.js`
- Website: `Archive/2026-11-02/scripts/uk_aq_finalize_page_metadata.mjs`

Unrelated existing Ops files `who-copy-check.txt`, `who-destination-after.json`, `who-new.json`,
`who-old.json` and `who-source-after.json` were preserved. No normal Worker, DDL, deployment
workflow, environment catalogue or existing deployment configuration was changed.

## Structural evidence

Passed:

- Node syntax parsing for 12 changed/new JS/MJS/TS files, including proxy TypeScript parsing.
- Native ESM imports of provider/controller and private Worker. The browser runtime's existing
  D3/ChartCore prerequisites are supplied by the HTML shell, not replaced by another chart.
- Initial admission policy JSON parsing; new HTML parsing and existence of local JS/CSS assets.
- Both repository `git diff --check` checks.
- Read-only admission inspection of the **actual existing candidate**, including retained original
  Bootstrap checkpoint/source chain, physical binding, verification metadata, COMPLETE/report/
  descriptor/gzip/decoded hashes, day accounting, terminal/context proof and endpoint grid.
- One narrow in-memory **actual-candidate** adapter/normalizer/cache compatibility check: 744
  monthly and 24 daily AQI endpoints, 585 original raw rows plus one separate authenticated terminal
  input, independent missing-input null counts, the 12 August 14:00 input-16/level-1/count-24 endpoint,
  and no additional transport request on immutable warm reuse. This had no network operations,
  generated publication files or remote readback. In-memory admission flag was used only to
  establish schema compatibility; it is not evidence of remote admission.
- Frozen renderer instrumentation compatibility. Independent read-only code review identified
  and prompted corrections to interior-month terminal proofs, legitimate raw multiplicity,
  concurrent selection contexts and incomplete following-body handling.

No new tests or broad suites were added/run. No Cloudflare CPU, real browser performance,
remote auth, Access hosting coverage, R2 publication or functional acceptance is inferred.
The final guard check preserved the existing algorithm's null source count for `missing_input`;
null was not converted to zero and the algorithm/data were not changed.

The candidate's independent index counts remain DAQI 588 valid/156 blank; EAQI 584 valid/160 blank.
Compressed source payloads are 4,834 observation bytes and 26,737 AQI bytes (decoded 60,100 and
938,194 bytes). These are stored object sizes, not measured HTTP transfer totals.

## Prerequisites, commands, validation and rollback

See [operator instructions](README.md) for exact local prepare/readback CLI invocations,
conditional immutable S3 PUTs, independent S3 GET verification and atomic publish-last selection;
existing Worker/proxy/Pages deployment commands; focused 24-hour and full-August operation;
cache/Refresh/cancellation checks; per-route CPU p50/p95/p99/max/exceededCpu, R2 and transfer
measurements; selector and source rollback; and ChatGPT documentation handover.

There is **no missing source-ownership prerequisite**. Before deployment, the operator still must
confirm the dedicated page is covered by the existing TEST Access application (including alternate
hostnames), dedicated R2 credentials/configuration and invocation telemetry are available, and the
old pilot remains usable for the existing proxy deployment probe. None was inspected or changed
remotely. Managed freshness/Core authority remains explicitly unresolved; the tool only admits the
separately authorised isolated manual sample. Additional month sources/continuity policies and the
future open-month/IngestDB seam remain separately gated.
