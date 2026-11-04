# Stage 2G: Station History selected-format compatibility

Code-only TEST review and correction, 4 November 2026. Based on current TEST Ops
`main` at `8b8575d465dd350b7fbd8884a34719c244415d61`, including merged PR #177
(`0127c448e374fd2dab600df63045c70386a50a2b`). Authoritative contracts were read
from TEST system-docs `origin/main` at `11e03809603f42d2888fcf702145527f6cf96072`,
using `git show` without changing its working tree. `system_docs/` remains untouched.

## Demonstrated defect and correction

`readObservationHistoryExactLeafPageV3()` previously authenticated current scoped
selectors only for cursor 4. Cursor 3 resumed its deterministic schema-1 leaf
directly. After an index-only schema-1 → schema-2 selector switch, retained old
schema-1 leaves still passed the cursor's body and physical checks. Two local
reproductions read superseded data rather than rejecting the cursor: a same-day
continuation and a cross-day continuation after the already-consumed day's
selector changed. Both checks failed with **Missing expected rejection** on the
unchanged reader and pass after the correction.

All continuations now validate each deterministic day/connector/pollutant selector
before opening Parquet. Cursor 3 requires the selected format to remain schema 1,
the per-scope physical identity to agree, and the requested member's exact leaf
descriptor to remain selected. Missing/new scopes, removed membership and format
or physical-identity changes fail closed. Cursor 4 retains its additional complete
selector byte-size/SHA check. No global index/latest scan, canonical hierarchy
walk or additional leaf search was added.

**Cursor-3 representation is unchanged:** same accepted fields, request identity,
schema-1 leaf key meanings, per-scope physical identity and chronological position.
It still permits an unrelated schema-1 selector change when the requested leaf
descriptor and physical identity remain unchanged; cursor 3 never carried the
whole selector's byte identity. Cursor 4 continues pinning the complete selector
and rejects any selector-byte revision, even with unchanged canonical observations
and retained old immutable leaves. Its original five-minute lifetime survives
further pages; the 12,288-character ceiling remains unchanged.

## Compatibility and readiness matrix

“Structurally validated” means code inspection and injected local checks. Every
changed/dependent schema-2 serving behaviour still awaits separately authorised
deployment and real TEST acceptance.

| Area | Classification | Actual owner and evidence |
|---|---|---|
| Schema-1 reading | Implemented and structurally validated | `validateManifest()`, `validateLeaf()`, cursor-3 request/discovery validation and production-writer reader regression checks. Aligned source references and decoding retain their existing meaning. |
| Schema-2 direct reading | Implemented and structurally validated | `exactLeafFormatV3()`, `assertExactRecordFieldsV2()`, `validateExactCanonicalSourceV2()`, `validateManifest()` and `validateLeaf()`. Exact canonical JSON, body size/SHA, deterministic immutable revision, direct canonical descriptor and projected ranges remain required. Local actual schema-3 writer bytes read successfully with no aligned objects present. |
| Mixed-format paging | Implemented and structurally validated | `createDiscoverySnapshot()`, `encodeNextCursor()` and the existing page walker retain each scope's format. Both schema-1/schema-2 day orders pass four physical pages with exact chronology, one segment per invocation and cursor 4 throughout. |
| Cursor 3 selection/currentness | Implemented and structurally validated | Corrected continuation branch in `readObservationHistoryExactLeafPageV3()` rejects a schema-2 switch in either scope before Parquet, including an already-consumed scope. Cursor contents are never reinterpreted as schema 2. |
| Cursor 4 selection/currentness | Implemented and structurally validated | Existing `decodeAndValidateCursorRequest()`, `validateCursorDiscovery()`, `compareCursorSelectedSegment()` and exact selector checks reject format, selector, leaf, request, position, physical identity, expiry/lifetime and size substitutions. Selected revision changes invalidate old cursors. |
| Cache identity/invalidation | Implemented and structurally validated | Existing `prepareObservationHistoryExactLeafRequestV3()` hashes every relevant selector's deterministic key, size, SHA and complete schema/kind/version format; missing scopes have a distinct identity. Worker `fetch()` prepares/validates selection **before** `caches.default.match()`. Actual local Worker warm-hit checks authenticate selectors, miss after index-only changes, and keep missing coverage/no-store out of cache. No cache generation bump needed. |
| Conditional Parquet ranges | Implemented and structurally validated | Existing `createR2PinnedObservationHistoryV3RandomAccessFile()` and `createPinnedObservationHistoryV3RandomAccessFile()` require actual size/project SHA, current strong ETag and conditional ranged GET consistency. Existing focused adapter regression plus the new local binding exercise this path. No footer or whole-file runtime read. |
| Station History completeness/continuity | Implemented and structurally validated | Existing `readV3R2Observations()` / `normalizeV3PhysicalPage()` accept the unchanged API envelope, split UTC pieces, follow private cursors, check order/identity, and share `createStationHistoryV3ReadBudget()`. A real local Worker-to-Station-History check consumes both formats and stops with explicit page/row-budget partial reasons. Continuity, PM context and AQI semantics are preserved by inspection, not claimed as new numerical acceptance. |
| Daily provenance reading | Implemented and structurally validated | Existing `readObservationHistoryExactLeafDailyMetadataV3()` uses the same selected parent/leaf validators. Mixed days pass without opening Parquet or manufacturing source/writer evidence. The independent authenticated overlay remains the status authority. |
| R2 request/byte budgets | Implemented and structurally validated | Existing four discovery objects/8 MiB and two ranges/8 MiB remain. Initial mixed discovery reads four objects; continuation uses at most two selectors plus one leaf. Cursor 3 gains one or two required bounded selector GETs compared with its old leaf-only continuation; cursor 4's GET count is unchanged. Cold cache misses reuse prefetched selector bytes. |
| Workers Free CPU | Implemented but awaiting deployment/real TEST acceptance | No CPU headroom established by local Node checks. Each Worker has its own 10 ms invocation CPU ceiling; current Station History performance acceptance remains open. Measure the added cursor-3 selector checks and existing decode/calculation paths on the actual deployed TEST versions. |
| Producer activation, repair APPLY and universal historical reconstruction | Outside this bounded task | Existing inactive schema-2 publication, pre-READY Prune rejection, cross-invocation recovery and repair/restore restrictions remain controlling. Consumer code does not close those independent blockers. |

### Preserved boundaries

- Supported concentration decoding remains the explicit schema-3/writer-v3 or
  schema-4/writer-v4 pair, `timeseries-aligned-v2`, cap 1,024 and
  `hyparquet-direct-column-v1` with the corresponding seven-/six-column root
  profile. Existing physical-schema-4 coverage is structural; the new actual-file
  fixtures use schema 3/hash v1. Unknown physical identities/profiles and unknown
  observation-hash versions reject; accepting a supported hash descriptor does
  not independently recompute its canonical logical hash or prove offline rebuild
  capability. The reader is narrower than the offline verifier.
- No schema-2 missing-leaf fallback to retained schema-1/aligned, previous
  generation or canonical whole-object data exists. Missing selectors/leaves
  produce explicit coverage loss; contradictory authority fails closed.
- Worker `cacheKey()` retains verification enabled/disabled separation and the
  selected connector verification-manifest SHA, using the existing bounded
  verification discovery cache. `historyCacheKeyUrl()`, dependency tags and the
  custom-host check remain unchanged. Incomplete, diagnostic and continuation
  responses stay no-store. No unrelated cache entries are cleared.
- The per-hit selection guarantee above applies to the **low-level observation
  Worker cache**. Public/browser response caching retains its existing contracts;
  this PR does not add selector metadata to public cache keys or change routing.
- Station History still owns date-valid physical continuity, independent visible
  versus AQI completeness, prior-23-hour PM context, R2-over-recent exact-timestamp
  precedence and `mergePhysicalObservations()` / `calculateLogicalAqi()` from one
  authoritative observation stream. `chunkHeaders()` and the stable-head response
  keep incomplete results no-store. Natural missing measurements remain distinct
  from unread/missing canonical scopes or exhausted work budgets.
- Shared invocation limits remain 16 physical pages and 5,000 accepted R2 rows.
  Recent IngestDB seam rows retain their separate post-R2 meaning. Private cursors
  are consumed internally and no browser-visible cursor is introduced.

## Changed files and rollback

1. `workers/shared/uk_aq_observation_history_exact_leaf_reader_v3.mjs`: the bounded
   current-selector validation correction; no reader replacement.
2. `archive/2026-11-04/workers/shared/uk_aq_observation_history_exact_leaf_reader_v3.mjs`:
   exact pre-change code, Git blob `8e1cef28afc73d4cd2c910b7e19bf19cef0063c6`,
   matching the base commit. Reference/rollback only, never imported or executed.
3. `tests/uk_aq_exact_leaf_selection_compatibility.test.mjs`: 11 focused
   deterministic selection/cursor/cache/consumer checks using actual local writer
   bytes and injected R2 index/HEAD/conditional-range adapters.
4. This non-authoritative investigation and Chat-mode handover.

Rollback restores the prior approved deployed complete reader file through the
normal reviewed deployment route, not an archive runtime import. The old reader
retains the demonstrated cursor-3 gap; do not select schema 2 while rolling back
to incompatible consumers. No data/schema/configuration change requires undoing.

## Validation evidence

Node `v24.19.0`; no real TEST R2, PostgreSQL, Cloudflare, Dropbox or source APIs
were used. The only remote access was repository Git/GitHub access.

```sh
node --check workers/shared/uk_aq_observation_history_exact_leaf_reader_v3.mjs
node --check tests/uk_aq_exact_leaf_selection_compatibility.test.mjs
node --test --test-isolation=none --test-reporter=tap \
  tests/uk_aq_exact_leaf_selection_compatibility.test.mjs \
  tests/uk_aq_observation_history_exact_leaf_writer_contract.test.mjs \
  tests/uk_aq_daily_validation_provenance_v3.test.mjs
node --test --test-isolation=none --test-reporter=tap \
  --test-name-pattern='R2 adapter pins HEAD' \
  tests/uk_aq_observation_history_reader_v3.test.mjs
```

**28 + 1 = 29 passing targeted checks**, plus reader/Worker dynamic imports,
syntax, `git diff --check` and exact archive-blob equality. `--test-isolation=none`
exposes individual TAP assertions in this environment rather than only child-file
process summaries. No full Node suite was run or claimed green.

Additional directly relevant existing checks were baseline-compared against a
separate unchanged worktree at `8b8575d4`:

- `uk_aq_station_history_history_chunks.test.mjs`: 9 pass, 7 fail identically on
  base and branch. Failing names: calculated high-frequency hour intervals; v3
  shared page budget; v3 overflowing row budget; configurable source/chunk limits;
  independent upstream errors; historical objects request; connector rejection.
  Several fixtures omit the now-required complete-generation selector.
- The named `continuity with calculated-history AQI disabled shares one v3
  physical-page budget` check in `uk_aq_station_history_station_series.test.mjs`
  returns 502 rather than its expected 200 on both base and branch.
- The fixed maximum-budget validator and conditional-range adapter checks pass
  on both. The new real local mixed-format Station History integration passes
  with an explicit complete-generation setting and exercises page/row exhaustion.

These eight existing failing assertions are not attributed to Stage 2G. Their
owning fixtures/interfaces remain explicit validation limitations, not a reason
to repair unrelated Station History code in this PR.

## Chat-mode documentation handover and real TEST gates

After review/merge, ChatGPT in Chat mode can update the exact-only future contract
and its Station History Stage 2G note with this milestone: cursor-3 retained-leaf
selection hole corrected; cursor 4, selected-identity cache, direct reading,
mixed-format paging and daily metadata mechanisms preserved; 29 focused passes
and eight baseline-matched existing failures; **no deployed/operational acceptance**.
No SQL, environment variable, service, public schema, JSONgen receipt/event,
backup payload or producer activation change is needed for this correction.

Before any schema-2 producer activation, separately authorise and complete:

1. Deployment of the reviewed compatible observation Worker and required dependent
   consumers to TEST. The existing dispatchable workflow is
   `.github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml`; a later
   authorised operator can use `gh workflow run uk_aq_observs_history_r2_api_worker_deploy.yml
   --repo TEST-uk-aq/uk-aq-ops --ref main` after the reviewed code is merged.
   No workflow was dispatched here.
2. Controlled finite TEST scope selection/publication under the independent
   publisher, original-attempt, completion, repair/recovery, backup and JSONgen
   compatibility gates. This PR does not lift the hard inactive flag, Prune's
   pre-READY rejection, or the Stage 2D recovery/Stage 2F restoration limitations.
3. Actual selected schema-1/schema-2 mixed requests and 24-hour/7-/31-/90-day
   chart paging; stale cursor 3 after a selector switch; cursor-4 selector/revision,
   expiry and conditional-range races; cache cold/warm/switch/missing-scope and
   overlay-change/no-store cases; daily provenance with real independent status
   authority. Preserve all old objects until separately authorised retirement.
4. Full authoritative observation/AQI rows, physical continuity, 23-hour PM context,
   seam precedence, evaluated natural gaps versus incomplete reads, and explicit
   16-page/5,000-row exhaustion. Existing numerical acceptance gaps, including the
   August PM10 boundary, are not closed by these compatibility checks.
5. Per-Worker CPU by route/window/cache state, sufficient p50/p95/p99/max samples,
   actual >10 ms and `exceededCpu`/error outcomes, plus R2 GET/HEAD/range counts,
   bytes and costs. Node wall-clock timings cannot establish Workers Free headroom.

No merge, deployment, Prune/repair execution, schema-2 publication, index conversion,
data deletion or LIVE operation is authorised or performed in this task.
