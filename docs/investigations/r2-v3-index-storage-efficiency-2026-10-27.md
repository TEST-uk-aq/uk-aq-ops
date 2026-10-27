# R2 v3 observation-history index storage efficiency

Date: 27 October 2026; expanded to investigate JSONgen replacing historical chart loading. Status: architectural investigation and recommendations; **no implementation or operational authority**.

**Revised user requirements, 27 October:** [Exact-only index decision retaining website Parquet retrieval](v3-exact-only-index-decision-2026-10-27.md). This later focused analysis retains canonical v3 and a permanent efficient physical reader, excludes new witness/catalogue infrastructure, and recommends direct canonical reconciliation before eventual `_aligned` retirement. Earlier evidence and conditional recommendations below remain as recorded.

**Final architecture follow-up, 27 October:** [v2/v3, JSONgen and complete-system decision](uk-aq-history-architecture-decision-2026-10-27.md). The companion explicitly compares returning to canonical v2, retaining v3 with smaller metadata, alternative serving/storage designs and retaining on-demand serving without JSONgen. It supplies the final architectural recommendation and decision gates; the measurements, provenance and earlier conditional index scenarios below remain unchanged.

## 1. Executive summary

The selected v3 physical observation layout has useful performance properties that should be retained: exact timeseries lookup, authenticated membership, offline-derived Parquet column ranges, one timeseries per independently decodable row group, a 1,024-row segment cap and bounded private pagination. Its current **index representation is substantially more redundant than those requirements demand**.

The shared builder writes the same timeseries segments into both 1,000-ID `_aligned` source shards and individual exact leaves. Every leaf also repeats scope/version fields, paths and referenced file identities. All these objects use sorted, **two-space pretty-printed, uncompressed JSON**. Exact-query readers fetch the exact scoped manifest and selected leaf; they validate the shape of `_aligned` references but do not fetch the referenced `_aligned` objects. Nevertheless, writers, publication graphs and the post-write verifier currently depend on those objects. Deleting `_aligned` under today's format would break integrity expectations. [C1–C5]

The supplied figures support the following conclusions, without assuming equal TEST/LIVE populations:

- TEST's complete `_index_v3` is **1.426 times** its complete `history/v3` size. The supplied LIVE comparison is **1.189 times**. These are prefix ratios, not matched observation-only compression ratios.
- `_aligned` represents **1.523 GiB, or 34.6%**, of the supplied LIVE `observations_timeseries` index. That is a measured opportunity envelope for retiring the duplicate representation, before replacement metadata and migration retention. Its object-count share is unknown.
- Individual day folders contain another **2.884 GiB**. Their fixed per-timeseries/day envelopes and repeated metadata are the principal remaining target. The supplied complete LIVE index averages approximately **3,433 bytes per object**; that is not a measured exact-leaf average.
- A single representation retaining **40–60% of the current day-folder bytes**, with `_aligned` retired, would reduce the complete 4.420 GiB index to approximately **1.17–1.74 GiB**: **2.68–3.25 GiB saved, about 61–74%**. This is a planning sensitivity range, **not a measured compression result or promised outcome**. A 25% retained-byte case gives 83% savings but is an optimistic case, not the planning baseline.

**Updated recommendation: decide retirement before redesign.** JSONgen is intended to serve published historical charts from monthly compressed observation/AQI pairs, replacing on-demand Parquet chart loading for that coverage. It is not yet the default TEST source, and current contracts retain the R2-first recent/open-month seam pending a separate decision. More importantly, JSONgen's own currentness inspector GET-authenticates exact leaves **and `_aligned`**, and canonical writers/verifiers, WHO provenance and administrative consumers remain. Moving charts alone therefore releases **no index objects today**. Section 7.3 traces those dependencies and distinguishes eventual retirement from current requirements.

JSONgen initially **adds** a second derived store, retained source/evidence bundles, receipts, control and publication versions; compression does not itself reclaim existing R2 bytes. Conditional gross retirement ceilings in the supplied comparison population are **1.523 GiB for `_aligned`**, **2.884 GiB for the exact day-folder tree**, or **4.407 GiB for both**. They require replacement proofs/remaining-consumer decisions, and net savings must subtract any replacement catalogue and additional JSONgen storage. Their individual object counts are not supplied. Canonical Parquet, binding and backup authority remain required.

If efficient exact physical access remains necessary after that decision, the preferred **conditional** redesign is one authoritative scoped directory and bounded packs of independently authenticated exact-timeseries records within selected v3. Hoist common metadata, retire duplicate `_aligned` proof through equivalent canonical reconciliation, and start with compact JSON; optional record compression depends on real TEST results. If only batch currentness/rebuild consumers remain, prefer a smaller canonical membership/change catalogue and explicit offline access over maintaining a low-latency daily chart index. Do not implement a new packed chart-reader index merely to preserve a serving path intended for retirement.

Packing can reduce the number of **leaf payload objects** by roughly 97–99.6% where packs average 32–256 records. That is conditional on occupancy and excludes directories and unrelated index families. There is insufficient supplied inventory to claim a percentage or absolute count for the entire 1,382,268-object index. Sparse scopes may gain little from packing. Fewer objects mainly help generation, listing, verification and operations; they do not inherently reduce the two cold-path index reads for one timeseries/day.

The conditional packed-index design can leave **all canonical Parquet bytes, observation values, identities, logical hashes, canonical manifests and bindings unchanged**. Existing TEST inspection code can reconstruct exact metadata from authenticated existing aligned Parquet without serialising it again. However, today's rebuild/migration commands do not implement either that new index-only transition or complete index retirement: bounded operators, authority/consumer changes, publication evidence and recovery handling are required. This report supplies design boundaries, not executable migration instructions. [C6, C9]

## 2. Scope, evidence and authority

### Evidence classes

| Label | Meaning in this report |
| --- | --- |
| Proven implementation finding | Established by the named TEST source functions at the pinned revision; does not establish deployed configuration. |
| Contract requirement | Established by active authoritative TEST system documentation, including its more specific amendments and explicitly future status. |
| Supplied measurement | The user's 27 October rclone aggregates; not independently remeasured here. |
| Existing TEST evidence | Operational measurements already recorded in TEST documents/reports; qualified by date and workload. |
| Estimate / assumption | Arithmetic model or proposed design; requires the stated missing evidence before acceptance. |

Application source baseline: **TEST-uk-aq/uk-aq-ops `main` at `45a7f75078b1592074dc876b2a29df2dc1b50ea3`**. The initial checkout was older; the report branch was created from fetched current TEST `main`, and changed in-scope reader/finaliser code was inspected. Authoritative documentation baseline: **TEST-uk-aq/uk-aq-system-docs `origin/main` at `a21f53b636dcd526d7d21358b1367e29cb751054`**, read using Git object views where newer than the workspace checkout. Website consumption was checked against TEST website `origin/main` `c430fe6` and its unchanged in-scope loader/controller files. No LIVE repository, bucket, endpoint, credentials or service was inspected. LIVE-named operator files present in TEST were not executed.

The investigation began at `system_docs/SYSTEM_OVERVIEW.md`, followed `r2_history/README.md`, the exact-v3 steady-state/migration interfaces, and the backup/recovery and station-history routes. The governing hierarchy is:

1. The side-by-side complete-generation contract and website amendment select coherent observation, Core, binding and backup-inventory prefixes using **`UK_AQ_R2_HISTORY_VERSION`**. Do not revive the retired independent normal index-version selector. [D1]
2. The exact-leaf amendment supersedes older 8,192/16,384-row, runtime-footer and 1,000-ID hot-path assumptions in the base index contract. The current selected segment maximum is 1,024. [D2–D3]
3. Canonical row naming, logical content hashing and binding/continuity semantics remain separate from derived-index encoding. A compact index must not rename canonical Parquet fields. [D4–D5]
4. SOS-light's three-phase contract overrides older retained-live-dependency planning assumptions. Normal backup excludes the bulk derived observation index. [D7–D8]
5. The later lock-free **reader-only** v2/v3 activation amendment is narrow; it is not permission to build or rewrite an index without writer coordination. Its historical one-off LIVE exception is not reusable authority for this proposal. [D10]

Some older contract paragraphs retain superseded prefix/selector wording. This report applies explicit precedence rather than treating them as competing current options. The proposed packed-record format is **not currently permitted by the exact-leaf schema**: it needs an explicit contract amendment before implementation. Authoritative documentation has not been changed.

No functional tests, new tests, benchmarks against services, SQL, R2 listing/reads/writes, migrations, configuration changes or deployments were performed. Local arithmetic and document/diff checks are analysis checks only.

## 3. Current v3 architecture

### 3.1 Versions and physical layout

The complete selected v3 generation maps to:

```text
history/v3/observations/                         canonical observations and manifests
history/v3/core/                                 selected Core snapshots
history/v3/_ops/observations/runs/                observation run evidence
history/_index_v3/observations_timeseries/         derived query/repair hierarchy
history/_index_v3/observations_timeseries_latest.json
history/_index_v3/timeseries_binding/             stable identity/continuity
history/_index_v3/backup_inventory_v2/             backup inventory format v2
```

Logical observation semantics remain `history_version=v2`. Selected physical layout is `timeseries-aligned-v2`; current writer limits are 1,024 target/max row-group rows, 65,536 target/131,072 max file rows, 4 MiB target/8 MiB max file bytes and at most 128 row groups per file. Multiple timeseries row groups can share a file. They need not align with index-ID ranges. These constants are in `uk_aq_observation_history_writer_limits_v3.mjs`; packing and actual-footer validation are in the shared target writer. [C6]

Within a UTC day/connector/pollutant scope, rows are ordered by timeseries, timestamp and deterministic canonical tie-break. Each segment is a complete, single-timeseries row group. A dense timeseries has several chronological segments; a sparse hourly timeseries commonly needs only one. Reducing the number of index files does **not** require changing these physical boundaries.

### 3.2 Structure and consumer inventory

Paths below are relative to the observation index root unless stated otherwise.

| Structure | Contents and purpose | Consumers / required role | Duplication and granularity assessment |
| --- | --- | --- | --- |
| `_aligned/day_utc=D/connector_id=C/pollutant_code=P/range=START-END.json` | Groups timeseries by 1,000 numeric IDs. Carries common versions/scope, its own key, full canonical pollutant-manifest descriptor, referenced file table and per-timeseries ordered segments with projected-column ranges. | Shared builder; explicit leaf/publication dependencies; steady-state and migration verification; Integrity proposal reconstruction. Not fetched by the normal exact concentration reader. | Segments are copied into exact leaves. File tables repeat across shards if shared files cross ranges. Persistent duplicate is an implementation dependency today, not a second physical-read requirement. [C1, C3, C5] |
| `_aligned/.../manifest.json` | Pins canonical source descriptor and all aligned shards, with their size/SHA and range bounds. | Publication graph and verifier; source provenance/reconciliation layer. | Repeats a source authority available in canonical manifests. Cannot remove without replacing direct reconciliation and dependency edges. |
| `day_utc=D/connector_id=C/pollutant_code=P/timeseries_id=NNNNNNNNN.json` | One exact timeseries for one scope: versions, key, counts/bounds, `source_aligned_child`, referenced file descriptors and complete ordered segments/ranges. | Normal exact reader, direct continuation, daily metadata/provenance reader, writers, independent verification and migration closure. | Narrow logical access is essential. One separate R2 object per logical record is not essential if a record remains directly locatable, bounded and authenticated. |
| `day_utc=D/connector_id=C/pollutant_code=P/manifest.json` | Exact membership authority. Common physical identity/decode profile; coverage; `source_aligned_scoped_manifest`; `leaves_by_timeseries_id` maps every ID to `[key, byte_size, sha256]`. | Page-one exact discovery; authoritative absence; writers/finalisers; verification. | Query fetches/parses the whole scope directory to select one ID. SHA-pinned membership must remain; repeated full leaf paths can be replaced by deterministic IDs/coordinates under a new schema. |
| `observations_timeseries_latest.json`, beside root | Global schema/layout identity, days and day summaries containing every scoped-root descriptor, counts and bounds. It is a historical scope registry, **not the latest reading per sensor**. | Shared run finaliser; migration/post-write verification; one mandatory compact backup unit; SOS-light unchanged-root fast path. | Repeats aggregate summaries and scope identities, but is only 7.105 MiB in supplied LIVE figures. Not a mandatory authentication parent on normal exact queries. Keep its operational role; do not prioritise this tiny fraction over leaf duplication. [C1, C4, C9] |
| Canonical pollutant/connector/day manifests in `history/v3/observations` | File membership, physical identities and canonical counts/hashes; connector/day commitment and publication evidence. | Canonical writers, Prune gates, repair, hierarchy finalisation, backup, independent verification. | Separate canonical authority, not dispensable observation-index duplication. Normal exact reads do not walk these ancestors. |
| Canonical month/year/root `_manifests` | Immediate child identities only, with deterministic aggregate `content_hash`. | Changed-day finalisers, stable-root selection, backup currentness, Integrity and migration. | Minimal hierarchy intentionally avoids repeating child summaries. Maintain it; do not substitute the query index for canonical authority. [D6] |
| `timeseries_binding/timeseries_id=ID.json` plus `_manifests/range=...` and root | Stable physical routing identity and optional complete continuity-family payload; source manifests authenticate physical membership. No daily observation coverage. | Binding API, station-history date-valid continuity selection, Core reconciliation, backup packs and restore, Integrity identity. | Family copies repeat by design to start from any member. Tiny supplied footprint; preserve independent semantics and exact runtime lookups. [C8, D5] |
| `backup_inventory_v2` | Hierarchical inventory of selected canonical backup source units and exact source identities; distinct from Dropbox processed-state checkpoints. | Backup inventory/sync, currentness and recovery evidence. | Not an alternate query index. Supplied 2.544 MiB is negligible; preserve selected-generation routing and independent identities. [C10, D7] |

There is **no additional daily observation-index parent fetched on the exact hot path**. The daily summaries inside latest and canonical day manifests serve other roles. Do not count every canonical ancestor as an index GET for each query.

### 3.3 Reader call chain

`workers/uk_aq_observs_history_r2_api_worker/worker.mjs` dispatches selected v3 to `worker_v3.mjs`. That worker calls `readObservationHistoryExactLeafPageV3()` using `createR2ObservationHistoryV3Source()`. Page one:

1. Derives one or two deterministic UTC scopes for an interval of at most 24 hours.
2. GETs each scoped manifest; validates format, scope, physical identity and complete lookup shape.
3. Selects only the requested ID's descriptor. If absent in a valid manifest, it does not probe a stray deterministic leaf.
4. GETs the selected leaf and verifies exact body length and SHA-256, then validates segments, file roots, chronological bounds and ranges.
5. Selects one intersecting segment. HEADs its Parquet object and requires matching size, stored project-owned SHA-256 and a current ETag.
6. Uses conditional ranged GETs for `observed_at_utc` and `value`, coalescing adjacent ranges with zero allowed gap. Decodes at most one segment/1,024 physical rows. No footer or `timeseries_id` decoding occurs.

`validateManifest()` and `validateLeaf()` check the **descriptor shape/path** of `source_aligned_*`; they do not GET those source objects. Same-scope continuation GETs and authenticates the pinned exact leaf directly instead of repeating the manifest walk. The private cursor is untrusted, pins bounded discovery and is checked against deterministic roots and current leaf identity. The inspected reader already has mixed schema-3/schema-4 support and cursor schema 3 in code; this does not establish overlay deployment. [C2–C3]

### 3.4 Writer, publication and repair call chains

`buildObservationHistoryV3SteadyStatePartition()` calls the same aligned target writer and `buildObservationHistoryExactLeafIndexV3ScopedHierarchy()` used by migration/repair. It emits canonical file PUT intents, a pollutant manifest and **both** index representations. `runObservationHistoryV3ConnectorPublication()` publishes verified connector-scoped products; `runObservationHistoryV3RunFinalization()` finalises affected days/aggregates and updates latest. Prune, generic Integrity, SOS replacement and supported backfill adapters share this machinery but retain distinct source and deletion authority. [C1, C4]

The publication scheduler distinguishes content dependencies from order prerequisites. Objects are not eligible until predecessors have exact verified durable evidence. `finalizeObservationHistoryIndexV3Publication()` uses put-if-changed, authenticates changed bodies by GET unless the adapter supplies that exact post-PUT proof, persists durable evidence, then unblocks dependants. Merely sorting filenames is insufficient. [C5]

At the inspected current TEST head, global dependency verification is already bounded/concurrent, with at most eight active reads, and Prune has a 16,384-entry run-local evidence cache tied to continuous global-lock ownership. This is **writer evidence reuse**, not a public raw-index cache. The base contract's 24 October subsection still labels the optimisation future; the later dated JSONgen operational record supplies narrower actual TEST evidence: the 24 October one-day Prune used **5,453 dependency GETs, 310,230 ms exact latest/global verification and eight concurrent reads**. Same-run reuse and changed-reference recovery counters were zero, so those cases remain unexercised. This is an existing operational cost independent of future chart hits; do not implement the concurrency feature again or bypass its invalidations. [C4, D3, D13]

`verifyV3Authority()` in the steady-state post-write verifier explicitly GET-authenticates both `source_aligned_scoped_manifest` and every leaf's `source_aligned_child`, in addition to exact leaves and canonical Parquet identities. Migration builds, plans, journals and independent verification also pin exact artifact bytes. This is why `_aligned` is **currently required operationally even though the query does not fetch it**. [C5, C9]

Fixed-v3 SOS-light reconstructs affected indexes from a pinned Dropbox canonical baseline plus repair overlay. `inspectPinnedBaselinePollutantPartition()` authenticates existing Parquet and `inspectCanonicalObservationTimeseriesAlignedFiles()` validates it without rewriting. The compact latest can retain strictly validated unaffected scope descriptors; if that fast path fails, canonical reconstruction or failure is required. It must not discover retained dependencies from current R2 before APPLY. [C6, C9, D8]

### 3.5 Backup and restoration

Normal backup copies canonical observations/manifests, run evidence, Core, binding content through its selected transport, and one selected compact latest summary. It **does not recursively inventory or copy either exact or `_aligned` observation-index tree**. Derived indexes must be reconstructable from canonical backup plus repair overlay. Backup inventory is R2-side control; Dropbox checkpoints independently prove copied/processed identity. Neither is a substitute for the other. Selected-v3 prefix rules in the website amendment override older v2-only paragraphs. [D1, D7–D8]

Existing binding backup packs are useful operational precedent for deterministic bundling and root-last recovery, but their JSON `body_base64` envelope is a transport format. They retain individual R2 runtime binding objects and are **not a random-access observation index**. Copying that format verbatim would add base64 expansion and full-pack parsing. The dedicated binding restore materialises exact individual bytes, validates source range/root identities and publishes authority last; it does not establish a complete generic observation-index restore implementation. [C10, D9]

## 4. Why index bytes and objects grow so quickly

### 4.1 Fixed envelopes dominate sparse observations

For every populated timeseries/day/pollutant scope the builder creates a leaf even if there is only one observation. Scope/version/writer/layout strings, long deterministic paths, SHA-256 strings, source descriptors, file tables and range field names cost roughly a similar envelope whether the day contains 1, 24 or 1,024 rows. Canonical Parquet compresses repeated identities and timestamps across rows; the JSON index does not share that columnar compression. More daily timeseries and pollutants can therefore grow indexes much faster than the compressed observation payload.

The complete index is **not a second set of observation values**. It is a verbose set of routing and integrity descriptions of many very small physical selections. A larger index than archive is plausible from this implementation without proving corruption or an intrinsically necessary size.

### 4.2 Two complete descriptions of segments

`timeseriesEntry()` copies the same normalized segment list into `_aligned` shard `timeseries[]`; `buildExactLeaf()` puts it into the individual leaf `segments[]`. Both include row-group ordinals, row starts/counts, time bounds and both columns' byte ranges/page offsets/value counts. The exact reader needs these facts once, not twice in storage. [C1]

Each segment repeats its file key, although that file is already in `files[]`; each leaf repeats its own key and its parent scope; each manifest repeats a long deterministic leaf path. The same file identity may appear in many leaves and several aligned shards. A digest is essential, but repeatedly storing identical digests and paths is an encoding choice.

### 4.3 Pretty JSON and lack of compression

`encodeObservationHistoryIndexV3Json()` recursively canonicalises keys, then uses `JSON.stringify(..., null, 2)` plus a newline. `artifact()` measures/hashes those exact UTF-8 bytes and marks them `application/json; charset=utf-8`. Neither it nor the R2 index source compresses/decompresses index bodies. Parquet's ZSTD profile does **not** compress adjacent JSON objects. An HTTP response's transfer encoding likewise does not establish compressed stored R2 index bytes. [C1, C3, C5]

Whitespace removal alone leaves long keys, paths and hashes. For scale, a purely illustrative six-digit ID mapped to a nine-digit leaf path of the current shape, 3,433-byte size and 64-character digest occupies **234 bytes** as a standalone pretty JSON map versus **211 bytes** compact. This local encoding arithmetic is not a sampled TEST leaf and not a whole-index minification ratio. At 1,000 such descriptors, a scope lookup is of order 0.22 MiB before fixed fields. A large network with 10,000 IDs can require order 2.2 MiB of scope JSON on each uncached day read. Current reader semantics include `Object.keys()` over the lookup, so directory CPU/memory also grows with scope cardinality. [C2]

Repeated random file/record hashes establish a compression floor; dictionary sharing and compact binary digests may help, but deleting required digests is unacceptable. Per-record compression gives less cross-timeseries redundancy elimination than whole-shard compression. A realistic model must account for that difference.

### 4.4 Churn beyond a leaf's own coverage

There is a code/contract tension worth addressing in the next format. The base contract's child identity and byte-stability sections say unrelated scope changes must not alter an unchanged child's bytes, and canonical manifest identity should be an external publication prerequisite. However, `buildAlignedSourceShard()` embeds the whole canonical source-manifest descriptor; `buildExactLeaf()` embeds the aligned shard's body identity. Consequently a source-manifest change can propagate through a shard SHA to every leaf in that shard, even when a leaf's own segments/files did not change. [C1, D3]

The exact-leaf amendment requires authenticated exact coverage but does not explicitly repeal this stability principle. This is a finding to reconcile with the contract owner, not authority to silently alter current hashes. A direct canonical prerequisite outside each record, with canonical reconciliation at the scoped parent, removes this avoidable dependency in the proposed representation. Physical Parquet repacking can still legitimately change many referenced file identities.

### 4.5 Physical layout versus index object count

Let `Q` be populated day/connector/pollutant scopes, `L = sum(Tq)` their timeseries memberships, `A` occupied aligned 1,000-ID ranges across scopes and `S` total segments. The selected builder emits approximately:

```text
L exact leaves + A aligned shards + 2Q scoped manifests + 1 global latest
```

This excludes bindings, backup inventory and other namespaces. Each dense timeseries adds segment bytes, but still only one leaf per scope; additional days add leaves and parents. One Parquet object may contain up to 128 row groups, so **one leaf per timeseries is not forced by one file per timeseries**. ID sparsity can make fixed numeric range packs mostly empty. Never infer `A = L/1000`, or exact leaf counts from the supplied total object count.

### 4.6 Residue, supersession and the supplied deletions

Deterministic keys and put-if-changed avoid unlimited new versions of an unchanged current leaf at the application level. But finalisers remove authoritative scope references; they do not establish a general mark-and-sweep collector for every obsolete exact leaf or `_aligned` shard. The Prune contract explicitly permits removing obsolete authority without immediate physical deletion. Fewer timeseries, disappearing pollutants, interrupted publication, earlier topology output or changed ID occupancy can therefore leave objects behind. Whole selected-day replacement in some Integrity modes is different from a global residue collector. [C1, C4, D11]

The reported removal of obsolete connector-7 Parquet may leave:

- **Still-referenced missing data:** an integrity failure; the exact reader must fail/return incomplete. Deleting indexes cannot recreate the lost observations.
- **Unreferenced old index objects:** potential cleanup after a complete authoritative reachability and recovery-retention decision.
- **An obsolete whole generation retained intentionally:** rollback/recovery material, not automatically garbage.

None can be quantified from aggregate prefix totals. This report assigns **zero guaranteed savings** to cleanup and does not use connector-7 deletions as evidence of format inefficiency.

## 5. Existing historical retrieval requirements and actual costs

This section describes the current reader and its compatibility boundary during transition. It is **not a requirement to retain chart-driven daily lookup latency indefinitely after JSONgen replaces that workload**. Section 7.3 determines which capabilities still have real consumers and where batch/recovery requirements can replace the current serving objective.

### 5.1 Supported request patterns

The exact low-level endpoint accepts a non-empty interval of at most 24 hours, including a possible UTC-midnight crossing. `since_utc` and `limit` compete with physical paging and are rejected there. Multi-day queries are orchestrated by station history, which splits each date-valid continuity interval at UTC midnights and follows private pages serially. [C2, C7]

An older observation-history chunk accepts at most **7 days**, with a 5,000-row output/R2 assembly bound and one invocation-wide **16 physical-page budget**, shared with continuity and AQI observation work. PM calculation includes preceding 23-hour context. A calendar month/year is therefore multiple chunks, not one supported unbounded Worker request. The website controller uses progressive coverage/cache settlement with window-specific older chunk spans: **6 hours for `24h`, 1 day for `7d`, 3 days for `31d`, and 7 days for `90d`**, unless a caller supplies another span. Its unrecognised-window policy returns 1 day; the seven-day constant is a further fallback, not the usual choice for every window. Primary observation concurrency defaults to 3, additional observations to 2 and primary AQI work to 2. Do not replace this progressive policy with blanket daily browser requests. [C7, C11, D2, D12]

### 5.2 Cold baseline for a single physical timeseries

For a UTC-aligned scope with one intersecting segment, no result cache hit and two nonadjacent projected column ranges:

```text
1 scoped-manifest GET + 1 leaf GET + 1 Parquet HEAD + 2 Parquet range GETs
= 4 GETs + 1 HEAD = 5 Class B operations
```

Adjacent projected ranges may coalesce into one GET, reducing this to four operations. Empty/absent scopes, missing manifests and multiple segments have different paths. These are source-derived operation counts, **not measured R2 bill totals**. A same-scope continuation normally adds one leaf GET, one identity HEAD and one or two data range GETs, without rereading the scoped manifest. It still parses that complete leaf. [C2–C3]

| Requested visible range | Low-level work, if complete and one segment per UTC day | Minimum 7-day chunks for the visible interval | Cold baseline GETs / HEADs / total Class B* |
| --- | --- | --- | --- |
| One UTC day | 1 daily logical request / physical page | 1 | 4 / 1 / 5 |
| Week | 7 daily pieces/pages | 1 | 28 / 7 / 35 |
| 30-day month | 30 daily pieces/pages distributed across chunks | 5 | 120 / 30 / 150 |
| Several months: 90-day example | 90 daily pieces/pages | 13 | 360 / 90 / 450 |
| One 365-day year | 365 daily pieces/pages | 53 | 1,460 / 365 / 1,825 |
| More than one year | Proportional to UTC-day pieces; multiple supported chunks | `ceil(days/7)` | Approximately `4D / D / 5D` |

\*Excludes binding/identity lookup, eligible IngestDB/continuity/AQI context, verification-overlay discovery, HTTP/cache-proxy work, retries and cross-chunk boundary overlap. Assumes no missing coverage and no cache reuse. The chunk column is a **minimum using the API's allowed seven-day maximum**, not the actual browser request count: its normal `7d`/`31d` policies use smaller pieces, and the initial recent head/cache changes how much older work remains. A year-or-longer observation request needs an orchestrating caller issuing bounded requests; no single annual observation endpoint or annual browser selection is established here. This is **not permission to bypass page/row budgets**. A non-midnight seven-day window touches eight UTC scopes. PM context can add another piece; dense data can exceed budgets before seven days. Even a single-day >5,000-row series cannot be promised as a complete station-history result. Budget exhaustion stays explicit/no-store.

If `Mq` is the scope-manifest size, `Lq` selected leaf size and `Bq` selected projected-column bytes, first-page payload is approximately `Mq + Lq + Bq`; HEAD bodies are negligible but request latency remains. A year costs the sum over days and repeated context pieces, not a whole-archive download. Sparse observations can make `Mq` the dominant transferred and parsed payload even though the selected leaf is small.

### 5.3 Latency, CPU, memory and concurrency

The cold critical path is manifest → leaf → identity HEAD → one/two bounded data ranges, with the data ranges fetched concurrently up to 2. UTC pieces and cursor pages inside a station-history read are chronological/serial. Browser chunk concurrency can overlap independent work. Fewer stored objects does not shorten this dependency chain unless the new representation changes the number of fetched objects.

Worker CPU includes UTF-8 decode, JSON parsing/validation and SHA-256 over leaf bytes, then ZSTD column decompression, Parquet decoding, row handling and response serialisation. Station history additionally parses HTTP JSON, resolves continuity, merges R2/ingest observations and calculates AQI. I/O waiting affects wall time rather than CPU directly. Source budgets are at most 4 index objects per low-level page, **8 MiB per index object**, at most 2 data ranges/8 MiB requested and one decoded segment/1,024 physical rows. The implementation does not establish a single 8 MiB aggregate cap across all four index objects. JSON allocations, string/object expansion and response copies mean payload bytes are not peak heap usage. [C2–C3, C7]

The authoritative current station-history contract requires headroom below **10 ms uncached invocation CPU**, with 5–7 ms a typical engineering target. The existing 12 October TEST CPU investigation records a supplied 1,297-invocation export with 15 ms station-series median versus 4 ms observation-history median, and 17 versus 5 ms within AQI-on/off cohorts. Those are different workloads and older deployment populations, not controlled current v3 compression evidence. Its 13/33 ms examples do not isolate index cost. No current latency distribution, heap peak, index-size histogram or format-specific CPU measurement is available here. [D12, E1]

### 5.4 Cache and fallback boundaries

The R2 source adapter itself has **no raw manifest/leaf cache**. The v3 API uses the Worker Cache API for complete responses: 300-second recent / 86,400-second historical TTL constants, historical classification after 24 hours, with response-generation and verification-mode identity in cache keys. Partial, diagnostic and unfinished physical-page responses use no-store. Therefore dense pagination does not obtain the same response-cache benefit as a complete one-segment day. The browser/controller and proxy add separate coverage caches. No hit rate is established by code. [C3, C8, C11]

At current TEST head, the concentration route requires explicit `UK_AQ_OBSERVS_HISTORY_R2_VERIFICATION_OVERLAY_ENABLED=true|false`. Disabled mode avoids overlay discovery and returns null status; enabled mode loads bounded verification discovery/connector authority and adds its identity to cache keys. Additional reads depend on this setting/cache state; neither is known from the supplied storage figures. Null status is not proof of corrupted stored P/R. Daily validation provenance is a distinct supported route and must retain its own authority. [C8, D2, D4]

The daily metadata reader can inspect up to 366 days using exact scoped manifests/leaves without opening Parquet for complete UTC days, with separate object/64 MiB aggregate budgets; partial boundary-day provenance may read physical pages. It also must be made pack-aware. [C2, C8]

There is no automatic v3-to-v2, broad Parquet scan or footer-discovery fallback. Current station history has bounded **provisional recent IngestDB recovery only for explicitly unpublished scopes**, within a 29-day lookback and at most 8 recovery reads. It must not mask a missing published leaf, bad identity or exhausted page/row budget, and it remains incomplete/no-store. That is not an index-integrity recovery mechanism. [C12, D12]

### 5.5 Characteristics to preserve

- Authenticated membership and authoritative absence; orphan existence never grants authority.
- Exact selected timeseries/column access without other-series decode, runtime footer work or broader fallback.
- Per-scope supported schema/writer/layout identity, including mixed physical-schema readiness.
- Strong Parquet SHA/size/ETag gate and conditional range-read race protection.
- Fixed page/row/concurrency limits, strict chronology, untrusted stale-cursor rejection and explicit incomplete reasons.
- Continuity inside station history; exact-timestamp R2 precedence; PM context and unchanged logical values/multiplicity.
- Complete-response cache eligibility, generation isolation, correction invalidation and retryable no-store failures.
- Cold-path headroom as well as warm cache performance. Storage savings alone cannot establish any of these.

## 6. Quantitative storage, growth and charges

### 6.1 Supplied measurements and derived arithmetic

All sizes below use the user's binary MiB/GiB labels. Rounding explains small component differences.

| Metric | TEST supplied / derived | LIVE supplied comparison / derived |
| --- | --- | --- |
| `_index_v3` | 918.259 MiB = 0.8967 GiB | 4.420 GiB; ~1,382,268 objects |
| Complete `history/v3` | 643.978 MiB = 0.6289 GiB | 3.718 GiB; ~310,756 objects |
| Index / complete v3 bytes | 1.426 | 1.189 |
| Total history | 3.817 GiB | 8.156 GiB after supplied deletions |
| Index share of total history | 23.5% | 54.2% |
| Remaining history outside these two prefixes | ~2.291 GiB | ~0.018 GiB by rounded subtraction |
| Complete index mean object body | Not calculable: no count supplied | ~3.35 KiB |
| Complete v3 mean object body | Not calculable: no count supplied | ~12.55 KiB; **not a Parquet-only mean** |
| Index objects / complete v3 objects | Unknown | 4.448; not leaves per Parquet file |

The TEST residual must not be attributed to a particular legacy family without an inventory. The complete `history/v3` prefix also includes non-observation domains. Thus “the observation index exceeds the whole selected-generation prefix” is supported; an exact matched observation-only overhead ratio is not supplied.

| Supplied LIVE index component | Size | Interpretation |
| --- | --- | --- |
| `observations_timeseries` | 4.407 GiB | ~99.7% of complete `_index_v3` bytes |
| `_aligned` within it | 1.523 GiB | 34.6% of observation index bytes |
| Individual day folders within it | 2.884 GiB | 65.4%; combines leaves and scoped manifests, not leaves alone |
| Latest operational summary | 7.105 MiB | ~0.16% of complete index |
| Bindings | 3.706 MiB | ~0.08% |
| Backup inventory | 2.544 MiB | ~0.06% |

There are no per-component counts, live leaf-size samples, compression measurements or current TEST `_aligned` breakdown in the supplied evidence. Applying the LIVE 34.6% distribution to TEST as if measured would be invalid.

### 6.2 Savings sensitivity

For the supplied comparison population, define `r` as the final fraction of **all existing day-folder bytes retained**, including replacement directories, records, pack framing and new shared metadata. Keep the other approximately 0.013 GiB of complete index unchanged:

```text
new complete index GiB ≈ 2.884 × r + 0.013
saved GiB ≈ 4.420 − new complete index
```

| Scenario | New index | Savings | Index reduction | Total history after cleanup, if other data stays fixed |
| --- | --- | --- | --- | --- |
| Retire duplicate `_aligned` only, `r=1` | 2.897 GiB | 1.523 GiB | 34.5% | 6.633 GiB |
| Conservative planning case, `r=0.60` | 1.743 GiB | 2.677 GiB | 60.6% | 5.479 GiB |
| Strong planning case, `r=0.40` | 1.167 GiB | 3.253 GiB | 73.6% | 4.903 GiB |
| Optimistic sensitivity, `r=0.25` | 0.734 GiB | 3.686 GiB | 83.4% | 4.470 GiB |

`r=1` is itself conditional on moving required source/reconciliation evidence elsewhere without material extra cost. These are replacement-state figures **after separately authorised retirement**, not peak migration sizes. While old and new representations coexist, storage increases. Deterministic compression, dictionary sharing and fewer repeated paths make the planning range plausible; only real TEST artifacts can establish `r`. Do not add separate compression/minification/deduplication percentage claims together: they overlap.

If the same 61–74% reduction later happened to apply to TEST's entire index population, it would save approximately 556–676 MiB. That is merely a scale illustration; TEST needs its own component measurements before budgeting savings.

### 6.3 Object count and growth

With bounded packs, `P = sum(occupied packs per scope)` replaces `L` leaf objects. Retiring `_aligned` also removes `A + Q` objects. Retaining one exact scoped directory gives approximately:

```text
old observation-index objects = L + A + 2Q + 1
new observation-index objects = P + Q + 1
```

For an **illustrative dense-ID** population of 1,000 scopes, each with 1,000 IDs, one aligned range and four packs of up to 256 IDs: old = 1,003,001 objects; new = 5,001, a 99.5% reduction in this observation-index family. This is not the supplied population. At one ID per scope, both parent and pack overhead dominate and packing saves no leaf objects; removal of duplicate aligned parents still helps. Actual occupancy, scope counts, oversized records and retained generations determine savings.

A new network increases daily physical timeseries memberships, not just station count. A station's additional pollutants normally add distinct timeseries; don't multiply pollutant count again if it is already included in `T`. For illustration only, at 2 KiB per exact record and another 50% in aligned/parent overhead:

| Active physical timeseries every day | New leaf objects / year | Illustrative added index / year |
| --- | --- | --- |
| 1,000 | 365,000 | 1.04 GiB |
| 10,000 | 3,650,000 | 10.44 GiB |
| 100,000 | 36,500,000 | 104.43 GiB |

This simple model excludes outages, changing station membership, segment growth and retained generations. It shows why daily envelopes matter. Packing changes object-growth slope to occupied scope/bucket count, but **does not eliminate linear growth in exact routing records/segments**. More dense rows increase `S`; longer history increases both `L` and `S`. Large single-network scopes also grow directory read/parse costs and may eventually require a separately designed bounded directory hierarchy.

### 6.4 Financial significance

Cloudflare's public Standard R2 pricing, checked 27 October 2026, lists $0.015/GB-month, $4.50/million Class A operations and $0.36/million Class B operations; GET and HEAD are Class B, PUT/LIST are Class A, deletion is free, and R2 egress is free. Included monthly allowances are 10 GB-month, 1 million Class A and 10 million Class B; usage is rounded to billing units. Actual account-wide allowances, storage class and invoice remain unknown. [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)

Using decimal GB for that illustrative marginal-rate calculation, 2.68–3.25 GiB removed continuously saves approximately **$0.043–$0.052/month before allowances/rounding**, not a material current storage bill by itself. Rewriting a million individual index objects has roughly **$4.50 of marginal PUT cost**, plus readback/other work; a million additional GET/HEAD operations is roughly $0.36. At a million uncached single-day requests, the five-operation baseline is roughly $1.80 of Class B work before allowances. Fewer stored objects do not lower this read bill unless fetched operation counts change.

Account usage may make actual invoice savings zero or stepwise. Engineering value here is primarily bounded generation/verification, fewer operational objects and long-term growth. Avoid adding a database/service whose maintenance and availability cost outweigh pennies of present storage savings. Recheck prices and account totals when implementation is approved.

## 7. Comparison of optimisation alternatives

Estimates below refer to index bytes, not canonical observations. Component percentages are alternative/overlapping scenarios, not additive. No candidate has been functionally benchmarked in this investigation.

### 7.1 Storage and query trade-offs

| Alternative | Storage / R2 object reduction | Lookup latency and read operations | Bytes, Worker CPU and memory | R2 storage/operation effect |
| --- | --- | --- | --- | --- |
| **A. Compress existing individual objects** | Unknown measured ratio. A 30–60% retained-byte assumption would save 40–70% of compressible objects; **0% object reduction**. Small objects have framing/digest floors. | Same lookup chain/count. Less transfer; decompression can offset latency gains. | Whole leaf is already the exact unit, so independent leaf gzip needs no random access. Whole scoped directory still inflates/parses. Requires compressed and decompressed size limits. | Byte charge falls; query GET/HEAD and per-object publication/verification count stay similar. |
| **B1. Whole grouped JSON, ID-range shards** | Leaf payload objects fall by `1−1/b` for mean occupancy `b`; storage reduction only from shared envelopes/compression, not grouping itself. | Potentially same two index GETs; large shard transfer and decoding can worsen single-ID latency. Extra directory levels add GETs. | Reading/parsing unrelated records can cost `b` times the record payload. Numeric 1,000-ID width is not a safe byte bound. | Fewer PUT/readback/list units; single-query bytes may rise sharply. Reject large whole-shard reads as default. |
| **B2. Packs with exact record ranges** | Same conditional leaf-object reduction; packed compact records can share scope/file metadata. No whole-pack compression gain unless independently blocked. | Target same scoped-directory GET + one record range GET; no added discovery HEAD in selected design. New authenticated range adapter required. | Selected record only; bounded directory remains. Per-record decompression optional. Avoid whole-pack parse/inflate. | Lower publication/list units; query operations can remain unchanged. Immutable superseded pack retention must be bounded. |
| **C. Compact representation** | Minification, path derivation, tuples/dictionaries and digest representation reduce bytes; **0% object reduction alone**. No measured ratio. | Same operation count; shorter parsing/hashing input can help latency. | Compact JSON remains debuggable. Binary can avoid object-heavy parsing but adds strict decoder/precision work. | Lower byte cost; unchanged count unless combined with packing. |
| **D1. Retire `_aligned`, retain exact-only authority** | Supplied size envelope ~34.6% of observation index / 34.5% of complete index, less replacement evidence. Removes `A+Q` objects, count unknown. | Normal exact reads already skip `_aligned`: no intrinsic hot-path operation saving or penalty. | Serving CPU roughly unchanged; writer/verifier traversals simplify once direct reconciliation is equivalent. | Lower stored bytes and generation/readback work. Cannot achieve by deletion alone. |
| **D2. Retire exact leaves, serve `_aligned` directly** | Supplied day folders are ~65.4% of observation-index bytes, but some parent remains needed; cannot claim all as removable. | Would retrieve/decode up to 1,000 IDs for one ID unless adding ranges, effectively becoming B2. | Reintroduces superseded coarse-shard hot-path overhead. | Fewer objects but potentially much more query work. Reject as a direct switch. |
| **E1. D1 relational index** | R2 index objects could nearly disappear; bytes move to SQL rows, tables and B-tree indexes. Net total-storage saving unmeasured. | Indexed `(scope,timeseries)` queries could fetch exact records or batch days. Adds a new serving dependency; cannot relax existing paging contracts. | Less Worker JSON routing work possible; query/result cost and database contention remain. | R2 operations replaced by SQL reads/writes/storage; no demonstrated financial benefit. |
| **E2. KV authority** | Moves per-record objects out of R2, without eliminating envelopes or another copy if R2 remains baseline. | Cached reads may be fast; stale/missing authority can persist across locations. | Adds cache/consistency coordination; immutable SHA-keyed cache is safer than mutable authority. | New KV charges and replication/write work; no proven net saving. Reject as authoritative replacement. |
| **E3. Existing PostgreSQL capabilities** | Same relocation caveat as D1; SQL compression/index footprint unknown. | Composite-key lookup/batching possible, but remote DB/RPC availability/latency joins every uncached query. | Connection/RPC/results and load compete with operational services. | Moves cost to existing DB capacity/egress rather than removing it. Not justified for current savings. |
| **F. Residue collection / generation hygiene** | Unknown; zero guaranteed reduction. Only truly unreferenced, unneeded objects qualify. | No normal lookup effect if membership authority stays intact. | Mostly operator/verification work. | One-time listing/read cost and smaller future inventories. Cannot repair referenced missing data. |

### 7.2 Generation, migration and operational trade-offs

| Alternative | Generation/update cost | Implementation and migration complexity | Integrity consequences | Backup/restore, maintainability and risk |
| --- | --- | --- | --- | --- |
| A | Per-object deterministic compression; same number of artifacts, hashes and readbacks. | Moderate: codec-aware reader/writer, encoded-byte identities, bounded inflation and versioned metadata. In-place Content-Encoding alone is insufficient. | Parent SHA/size must pin actual stored bytes; canonical decode/profile validation still applies. | Keep derived-tree exclusion. Restore/rebuild needs pinned codec settings/version. Extra CPU risk on tiny cold reads. |
| B1 | Fewer writes; updating one member may rewrite a whole group. | Moderate for basic grouping, high once bounds and complete membership are preserved. | Parent selects complete membership; grouped bytes must be authenticated. | Larger blast radius and memory/over-read; simple operators, poorer exact workload fit. |
| B2 | Bounded pack rebuild/readback instead of per-leaf PUT; record hashes and full coverage checks remain O(records/segments). | High initially: range directory, cursor pinning, staged-byte publication, allowlists and index-only transition. | Requires record-length/SHA/range proof and complete direct canonical reconciliation; pack whole-body proof at publication/verification. | Rebuildable from canonical backup; immutable pack garbage retention required. Good long-term fit if format stays small and shared. |
| C | Less serialization and I/O; compact schema mapping/validation adds work. | Low–moderate for minified JSON, higher for tuples/binary. Existing exact JSON hashes cannot be preserved after encoding changes. | Never remove required strong identities or silently rename canonical persisted fields. | Compact JSON simplest to inspect; binary needs durable format documentation/tools. |
| D1 | Removes duplicate generation and dependency verification; no second segment tree. | High enough to require coordinated shared writers/verifiers/repair/migration changes and a new format identity. | Replace `_aligned` dependency closure with canonical-source and exact-record reconciliation, not a skipped check. | No new backup payload; direct rebuild remains mandatory. Lowest ongoing duplication. |
| D2 | Simpler writer representation at the expense of reader cost. | Moderate apparent switch, high to regain exact access. | Existing exact-reader contract does not allow broad-shard fallback. | Rejected unless redesigned as B2. |
| E1 | Transactional batch ingestion plus coordinated R2/SQL publication; SQL indexes add writes. | High: new database/binding, schema ownership, capacity partitioning, deployment and recovery. | Cross-store commit needs immutable generation identity and fail-closed routing; one SQL transaction does not make R2 publication atomic. | Separate recovery/export/readiness dependency; greater operational surface than this problem warrants. |
| E2 | Per-key writes and eventual propagation; immutable cache population possible. | High for safe mutable-authority replacement. | KV lacks the desired immediate multi-object authority boundary; fail-closed alone would cause availability failures during propagation. | Rebuild/cache loss and invalidation management; do not add for byte saving alone. |
| E3 | Uses existing DB operational machinery but requires permanent index tables and refresh workload. | High cross-area/schema and restoration coupling. | SQL rows must remain derived and generation-pinned; database cannot silently replace canonical Parquet authority. | Database recovery becomes historical-query availability dependency. No evidence of spare capacity or cost advantage. |
| F | Bounded mark/reachability classification, dry-run evidence, then separately authorised cleanup. | Moderate to high for safe historical retention decisions. | Must distinguish committed references, interrupted publications, active cursors and recovery evidence. | Beneficial housekeeping after format acceptance; do not couple format migration to canonical data deletion. |

Cloudflare documents KV as eventually consistent, including negative lookups, with changes potentially taking 60 seconds or more to appear elsewhere; this is unsuitable as a drop-in replacement for current mutable membership authority. D1 offers a plausible exact relational lookup, but its documented per-database limits are 500 MB Free / 10 GB Paid, and each database/replica processes queries serially. Projected history growth would need capacity design; the present index is already larger than the Free limit before SQL overhead. No D1 binding is declared in the inspected history Worker configurations. A Blog Feed KV declaration is not evidence of a shared history-index service. [Cloudflare KV consistency](https://developers.cloudflare.com/kv/concepts/how-kv-works/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

Additional ideas: caching a raw scoped directory by exact identity could amortise repeated reads for different timeseries, but safely discovering current identity and correction invalidation is separate work; there is no measured hit-rate justification here. Changing Parquet file packing cannot remove daily leaf envelopes and risks the accepted decode bounds, so do not repack observations solely to reduce indexes. JSONgen's serving transition makes **retirement of obsolete physical routing** a serious alternative to optimising it. Canonical fidelity/recovery must survive, but the current exact-reader representation need not survive forever if its remaining consumers are removed or given accepted replacements.

### 7.3 JSONgen replacing historical chart loading: dependencies and net storage

#### 7.3.1 Intended role versus complete reader retirement

**Confirmed intended historical role:** the authoritative JSONgen contract selects one GitHub workflow as generator/publisher of two immutable gzip products per physical identity/pollutant/UTC month: observations and precomputed AQI. One selected UUID pubID pins the matching pair; charts fetch already encoded data rather than having a Worker select Parquet segments and calculate the historical AQI on each cache miss. The future pubID discovery path has a five-minute effective TTL, immediate authoritative Refresh checks and long-lived versioned product caching. This is a replacement historical chart **data path**, not a request-time compressed wrapper around the old Parquet reader. [D13–D14, C13–C14]

**Not yet a confirmed complete replacement for every chart request:** current authoritative documents explicitly retain the R2-first/eligible-IngestDB seam and require a separate open/current-month integration decision. They do not yet retire the low-level reader, activate all-network coverage or define universal continuity-family JSON serving. The selected first-publication consumer covers AURN PM2.5/PM10/NO₂; other pollutants/networks, logical continuity and all writers need their own accepted support. The user's clarified objective is a future JSONgen chart replacement. The gap is the **remaining seam/coverage/retirement contract**, not permission to assume those decisions are already implemented.

| Chart scenario | Intended/required handling | Is the v3 physical reader eliminated by the currently documented transition? |
| --- | --- | --- |
| Historical interval fully covered by an accepted selected JSON pair | Fetch manifest and matching monthly observation/AQI gzip; reuse the shared chart controller and normaliser. | **For those chart data fetches, yes in the target route.** Canonical metadata checks by the generator remain separate. |
| Recent/open month, eligible live IngestDB head and hidden PM context | Current R2-first/IngestDB calculation remains until an explicit replacement seam is accepted. | **No current retirement authority.** A future all-JSON historical seam could remove this need, but must specify the live/context source and correctness. |
| Prune published/deleted a day before JSONgen selected it | That day can be R2-only while selected JSON is behind. A safe design must serve it canonically or truthfully remain stale/partial until publication; an IngestDB-only tail loses coverage. | **Decision outstanding.** Do not assert either permanent reader retention or safe deletion based solely on the chart-replacement objective. |
| Missing, corrupt or unauthenticated managed JSON/context | Fail closed, retain previous safe selection and report reconciliation-required; no automatic month rebuild from Parquet. | **No automatic Parquet fallback is required or allowed by JSONgen.** Do not preserve a reader solely for an invented fallback. |
| Unadmitted networks/pollutants/continuity or ranges without accepted JSON baseline | Existing authorised route remains during rollout, or a separately accepted product-scope/serving decision is required. | **Not yet.** An AURN pilot is not all website history. |
| Explicit initial bootstrap or exceptional manual rebuild | Separately authorised canonical-v3 reconstruction, bounded and authenticated. Current offline bootstrap reads canonical Dropbox Parquet/manifests/bindings directly. | Needs recovery access, **not necessarily the online Worker or permanent exact byte-range tree**. |

Therefore the current contracts support “JSONgen replaces chart loading for accepted published historical coverage”; they do **not** yet support “switch on JSONgen, delete both v3 index trees and every observation-history Worker route.” The latter needs deliberate consumer and authority changes. [D13–D14]

#### 7.3.2 What TEST actually implements and has accepted

| Stage | Evidence and limit |
| --- | --- |
| Isolated compressed-observation viewer | The prototype contract records a 9 October TEST AURN PM2.5 viewer with a complete September v3 month. The pilot Worker is exact-allowlisted, uses `experimental/compressed-chart-history/v1`, and its legacy AQI path can still decompress observations and calculate on request. A schema-2 precomputed branch exists in code; that alone is not operational acceptance of the future managed publisher. |
| Managed wire/control/inspection code | `schema.mjs` defines monthly pair/evidence/manifest identities; `inputs.mjs` authenticates immutable bundles/receipts; `authority.mjs` and the reconciler inspect current canonical metadata. `selectManagedPublications()` at line 146 **unconditionally throws**. The checked-in JSONgen workflow is manual Stage A diagnostics, not a scheduler or monthly publisher. |
| Canonical writer handover | The dated contract records successful 24 October real TEST Prune, an AURN pending source and original external evidence bundle. Canonical verification/deletion remains independent of optional JSONgen handover success. |
| Original event authentication/registration | The latest 25 October entry records two AURN events, 12 selected bundles and 12 receipts; 866 selected day-scopes / 19,878 selected observations were original-authenticated. Seven separate bounded inspections matched 866/866 current metadata. These are operator-reported acceptance records with their documented independent metadata-listing limit, not newly reproduced operations here. |
| Still outstanding | All-applicable-writer inventory, authenticated later supersession/removal, freshness fencing and coherent cross-partition authority; full-month authenticated baseline and adjacent-month PM context; monthly paired publication/CAS selection; default chart/proxy/Refresh integration; all intended network/pollutant/continuity and open-month seam acceptance. `publication_eligible=false`, `writer_coverage=unknown` remain intentional. |

Use the latest dated acceptance sections over older README/code-only milestone language. The seven snapshots are not one coherent current-state proof. This follow-up inspected code and TEST contracts only; it did not query deployments or rerun any handover, inspector, bootstrap or chart. [C13–C14, D13–D14]

#### 7.3.3 Remaining consumers and whether they justify physical routing

| Consumer / operation | Actual dependency after charts move | Classification and retirement consequence |
| --- | --- | --- |
| **JSONgen ordinary incremental generation** | Reads authenticated existing monthly observation JSON, complete verified writer replacement bundles, adjacent-month JSON context and canonical metadata. It must not reread canonical Parquet as normal input. | Monthly serving needs no daily byte-range index. **Current metadata authentication does**, as detailed below. Efficient batch metadata/freshness is the future optimisation target. |
| **JSONgen currentness/reconciliation** | `scripts/jsongen/authority.mjs:readCanonicalScopes()` authenticates root→year→month→day→connector→pollutant, exact scoped manifest, `_aligned` scoped manifest, selected leaf and aligned shard, matching canonical file/count membership. `readCanonicalScopePages()` batches/rechecks metadata. | **Direct current code dependency on both exact and `_aligned`.** Replacing the chart reader does not remove it. A smaller equivalent proof format needs a new contract/adapter. |
| **JSONgen original event verification** | `prune-consumer-authentication.mjs` verifies retained exact original metadata/evidence and private pending rows against original committed gate authority. Source metadata is immutable historical proof, distinct from current R2 at replaceable keys. | Preserve original evidence formats/bytes. Retirement of current objects must not make old receipts unreadable or rewrite their original SHA meanings; decoders may remain without retaining an online old index. |
| **Prune, Integrity, SOS-light and supported backfills** | Shared builders generate both structures; publication/finalisation and proposal validators require them. Current post-write verification traverses `_aligned` dependencies. Black Carbon's selected-scope reconciler builds/compares expected complete exact hierarchies. | **Current writer/verification requirements**, not simply chart requirements. Remove generation and graph edges only after equivalent canonical completeness/identity verification exists. Code presence establishes a dependency, not that every optional writer is presently scheduled/deployed. |
| **Normal Dropbox backup and restore** | Bulk exact/`_aligned` trees are excluded; compact latest, canonical data, binding/verification and selected backup state remain. SOS-light reconstructs affected indexes from canonical baseline plus overlay. | No bulk-tree backup requirement justifies retention. **Current rebuild/latest-registry code does** until adapted. Canonical recovery must remain; derived chart files are never the replacement backup. |
| **Direct historical access** | Private `/v1/observations` still exposes the exact physical reader independently of chart clients. Current station-history direct observation routes also use it. | Decide whether this API remains a supported low-latency product, becomes bounded operator-only access, or retires. No external caller/access-log census was performed; absence of a website call is not proof of no consumers. |
| **WHO daily provenance** | Deployed-TEST route contract `/api/aq/who-daily-series`; `readDailyAurnProvenance()` calls `/v1/daily-validation-provenance`. With authoritative overlay, complete-day provenance reads exact metadata; partial-day boundaries may read physical pages. Without accepted overlay the upstream fails rather than inventing P/R. | A concrete **non-station-chart** dependency. Keep or replace authenticated provenance with an accepted direct canonical/verification summary. JSONgen's chart AQI is not WHO authority. The WHO homepage summary route serves a separate derived object and does not itself require the full exact tree. [D15] |
| **Hosted Station Snapshot admin** | `station_snapshot_v2.ts:handleStationSnapshotV2Rows()` calls the configured observations-history API for its R2 comparison column. Current request construction includes legacy `since_utc`, rejected by selected-v3 exact paging. | **Configured code dependency with an apparent v3 interface mismatch**, not evidence of a healthy deployed call. Repair, redesign or explicitly retire it; do not retain an expensive index just to support an unaccepted broken path. JSONgen adoption alone does not change the admin contract. [D15] |
| **Dashboard metrics/history calendar** | Metrics Worker `fetchR2HistoryCounts()` reads the selected compact latest; generation clients use the stable service descriptor. | Requires compact summaries/generation authority, **not millions of leaves**. Replacing the observation reader function is distinct from deleting its whole Worker, which also serves binding, generation and WHO summary/provenance routes. |
| **Future IFW** | TEST IFW `loadDropboxNodesDcp()` reads latest, scoped manifests and exact leaves from its history store. Current IFW contracts label it future, and normal backup excludes a full derived tree. | A future adapter/contract reconciliation issue, **not a proven current deployment requiring permanent full-tree backup**. Require canonical reconstruction/new catalogue support before that consumer becomes operational; do not expand backup to preserve obsolete indexes. |
| **Research, download and legacy diagnostics** | No separate accepted research/download endpoint requiring permanent exact-v3 low-latency access was established in the inspected active paths. `scripts/r2_query/query_r2_v2_observs_aqilevels_indexes.sh` is explicitly local v2 diagnostics; retired AQI routes/candidate Workers and old ingest timeseries compatibility are not proof of a required v3 production consumer. | Obtain an explicit supported-access inventory before final retirement. Occasional research can use authorised manifest-guided canonical Parquet/Dropbox batch access; do not silently remove a genuinely supported API, and do not preserve all indexes for hypothetical callers. |

This is a source/contract consumer inventory across the TEST ops reader/writer/JSONgen/backup/dashboard paths, relevant TEST website clients and the TEST IFW adapter. It is not an audit of current callers, private research scripts or runtime flags. The IFW code was checked at TEST `main` `22eb343583c96cea4253c6005e4da4f66a4d5add`. No LIVE source or service was used. [C13–C17]

**The decisive code difference from the chart hot path:** `authority.mjs`'s local `exact()` function GETs `source_aligned_scoped_manifest` at line 253, matches its canonical source descriptor to the root-authenticated pollutant, calls the exact daily metadata reader, GETs the selected leaf and then GETs `source_aligned_child` at line 299. It checks aligned child membership/counts and file SHA/size against canonical manifests. The chart reader only validates the shape of aligned references. JSONgen therefore currently makes `_aligned` **more than an unused legacy chart duplicate**. Its existence need not remain an architectural requirement, but its proof cannot simply be omitted.

#### 7.3.4 What is necessary, transitional or a candidate for full retirement?

| Information / representation | Necessary in the target architecture? | Treatment |
| --- | --- | --- |
| Canonical observations/manifests, actual identities/values/multiplicity and accepted verification/binding history | **Yes.** Canonical integrity/recovery authority remains independent of chart products. | Keep. No Parquet deletion/repacking is implied by JSONgen. |
| Authenticated scope membership, authoritative absence/removal, current source identity and writer completeness/freshness evidence | **Yes for JSONgen correctness.** | Keep equivalent proofs; a count or matching digest string alone cannot prove final source values, complete writer coverage or supersession. |
| Daily physical segment ordinals and projected Parquet byte ranges | Necessary only for accepted exact physical access/provenance/bootstrap implementations. Not used to stream a published monthly pair. | Candidate to drop after those consumers are replaced/retired; do not optimise it for obsolete chart traffic by default. |
| Exact leaf as one standalone JSON object per series/day | **No inherent requirement.** Current readers/inspectors require it by schema. | Transitional until an accepted compact proof/routing representation or complete retirement is implemented. |
| Persistent full `_aligned` duplicate | **No inherent need for duplicate segment storage**, but required by current JSONgen and canonical verifiers. | Strong simplification/retirement candidate once all equivalent canonical cross-checks move to direct proof. |
| Compact latest, binding indexes and backup inventory | Separate small operational/identity roles survive charts. | Retain or version a compact compatible successor. Do not delete all `_index_v3` based on retirement of `observations_timeseries/`. |
| Old chart/API deployments and old index generations | Only during a defined compatibility/recovery window with valid canonical references. | Retire after real cutover and current-data rollback closure. Indefinite duplicate indexes are not a substitute for recovery design. |
| JSONgen receipts, source/evidence bundles, selectors and immutable previous pubIDs | Required while pending, referenced or needed for accepted recovery/audit. | Retain under a bounded, dependency-aware policy; no automatic expiry is approved merely because monthly files exist. |

**Viability of a smaller non-routing catalogue:** canonical pollutant manifests already include physical files, size/SHA, total/per-file timeseries counts and scope content hashes (`fileEntry()`); shared writers already hold exact normalized rows and physical metadata. The offline Dropbox bootstrap proves bounded manifest-guided reconstruction can generate local chart candidates **without the old HTTP reader or backed-up exact tree**. These are concrete foundations for separating change/membership proofs from physical byte routing. They do not yet implement a complete JSONgen proof replacement. In particular, counts/bounds cannot detect value-only corrections, and a changed shared-file digest cannot by itself establish which timeseries receipt was superseded. The contract owner must define equivalent per-scope content/physical identity, complete before→after publication coverage and freshness fencing, using verified writer evidence rather than a new global sequence or automatic Parquet rereads. If that proof cannot be made complete and bounded, keep the necessary exact metadata instead of weakening validation. [C4, C6, C13–C14, D13]

#### 7.3.5 Does JSONgen reduce total stored data?

**Not by itself.** It adds observation JSON, derived AQI, pair manifests/evidence, control, original pending source, original metadata evidence, selected replacement bundles/receipts and retained old/candidate versions in a **separate R2 bucket/account**. Existing canonical bucket figures do not include that store. No contract says to delete canonical Parquet or the v3 tree on chart activation. A decrease in the canonical bucket while an unmeasured derived bucket grows is not evidence of a net saving.

Evidence already available in TEST:

- The 17 October offline bootstrap's one-series **seven-day** candidate contained **2,095 compressed observation bytes + 7,955 compressed AQI bytes = 10,050 bytes** for 166 visible observations. AQI was about **3.8 times** observation JSON in that sample. It is not a full-month or all-network ratio, nor a comparison against equivalent canonical storage.
- The 433-pair local candidate run wrote **11.937085 MB including evidence and reports**; this is **not** a measured aggregate of retained R2 gzip products and must not be multiplied into a production estimate.
- The 24 October producer retained **138,339 compressed source bytes** (19,301 original observations across all 37 pollutants) and an original metadata-evidence gzip of **1,816,634 bytes** representing 2,003 referenced objects / 18,682,638 uncompressed JSON bytes. Those supporting bodies alone total **1,954,973 bytes**, before selected receipts/bundles, control or monthly publication. They are not monthly chart products and cannot be used as a monthly compression ratio.
- The latest two-event acceptance records **two event descriptors + 12 selected bundles + 12 receipts + control**; control alone was **1,308,652 bytes**. This is a partial count/size observation, not a full derived-bucket inventory. Historical metadata evidence can retain copies of exact/aligned index bytes even after current index objects are eventually retired. Original byte identities must survive; avoid promising that index deletion eliminates every retained copy. [D13]

For `M` physical-series/months and one version each, monthly observation/AQI files contribute `2M` objects. Current managed schema also requires an immutable manifest and publication evidence, so its publication layer has **up to roughly `4M` objects before deduplication**, not simply two files in the entire system. With `V_m` retained versions per month, scale by `sum(V_m)`. Add replacement bundles/receipts, original event descriptors/evidence, pending uploads, control, prototype objects and diagnostics separately. A PM correction may require a new pair for the following month despite unchanged next-month observations. Each daily open-month update replaces complete monthly files rather than appending a small delta; failed/old versions need bounded retention. [C13–C14, D13]

Define `X` as gross old-index bytes retired, `K` as newly retained replacement index/catalogue bytes, and `ΔG` as **additional total JSONgen R2 bytes relative to its current state**, including versions and supporting evidence. Then:

```text
change in total R2 storage across canonical + derived accounts = ΔG + K − X
net saving requires X > K + ΔG
```

| Conditional retirement path | Gross supplied comparison-population ceiling | Object reduction, separate from bytes | What remains unproven |
| --- | --- | --- | --- |
| JSONgen serving switch with existing canonical/metadata operations unchanged | **0 GiB** | **0 existing index objects** | JSONgen adds bytes/objects; it may reduce serving operations but does not reclaim storage. |
| Remove `_aligned` through equivalent direct canonical proof | **1.523 GiB** | `A + Q` old objects from section 4.5, minus new proof objects | Current JSONgen/verifier dependence must be replaced; counts and replacement bytes unknown. |
| Remove exact day-folder tree, keeping/adapting remaining proof | **2.884 GiB** | `L + Q` old objects, minus any replacement objects | Includes scoped manifests as well as leaves. Current access, JSONgen and provenance dependencies prevent immediate removal. |
| Retire the whole `observations_timeseries/` tree | **4.407 GiB**, about **99.7% of complete `_index_v3` bytes** | `L + A + 2Q` old objects, minus compact replacement objects | Requires all remaining physical-routing consumers replaced/retired and equivalent operational metadata proofs. Latest outside this tree, bindings and inventory remain. |
| Keep necessary exact access using the earlier compact/packed option | **2.68–3.25 GiB planning savings**, not a retirement measurement | Conditional packing formula in section 6.3 | Only justified if residual access/proof workloads warrant the redesign. Net benefit still subtracts `ΔG`. |

The full-tree ceiling would reduce the supplied canonical history total from 8.156 to **3.749 GiB before replacement metadata**, while separate JSONgen storage remains additional. It is an upper-bound scenario, **not currently authorised or structurally complete migration code**. The component counts were not supplied, so do not call the whole 1,382,268 complete-index count removable; it includes surviving families. TEST has no measured observation-tree split/JSONgen bucket total here, so its 918.259 MiB complete-index figure cannot be claimed as a safe deletion amount.

Net-count accounting is similarly `new JSONgen objects + new catalogue objects − retired index objects`; fewer monthly chart files do not imply a smaller total if daily source/evidence versions accumulate. Minimise retained redundant evidence **for future events** through a reviewed proof format and justified retention, without rewriting originals or deleting unresolved handovers. Canonical and derived storage/operations must be measured separately and then summed.

#### 7.3.6 Revised priorities and prerequisites for retirement

The highest-value order is now:

1. **Complete the actual JSONgen serving and all-writer proof design.** Do not rush a new daily chart-routing format while monthly selection is blocked. Measure generation, canonical metadata verification, retained evidence and publication version growth as well as serving.
2. **Decide residual access explicitly.** Resolve recent/open-month lag, all supported chart populations and continuity, direct API/admin/WHO provenance and research access ownership. Do not keep online exact latency as an objective for a retired consumer; retain it where a real supported consumer still needs it.
3. **Prefer eliminating duplicate or unnecessary physical routing.** First candidate is `_aligned` with direct canonical reconciliation, including JSONgen's inspector. If no required physical range consumer remains, evaluate retiring both trees with a smaller accepted currentness/membership catalogue and explicit bounded offline reconstruction.
4. **Optimise only the remainder.** If the above inventory retains frequent exact access, use the compact single representation in section 8. If it retains only batch reconciliation/provenance/rebuild, optimise canonical proof batch I/O and simpler summaries; do not incur a packed range-reader migration solely for historical chart CPU.

Before deleting any index: accept managed full-month pair publication, appropriate writer/coverage/freshness authority and actual chart cutover in TEST; resolve the open-month/Prune-to-publication gap and unsupported-population policy; update or disable every writer/finaliser/verifier/JSONgen inspector that would require or recreate old objects; provide accepted WHO/admin/API replacements or retirement; demonstrate canonical backup-only reconstruction and new-format currentness; preserve original evidence and current-data rollback; and approve a concrete manifest-guided derived-only retirement set. Retiring an entire Worker also needs relocation/retention of its independent routes. None of those deletions or deployments is performed or authorised by this report.

This changes the architectural recommendation, not the integrity standard: **retain canonical truth and sufficient authenticated metadata, while treating both current physical-index representations and the old chart reader as potentially retireable implementation choices**. JSONgen readiness alone is not their retirement gate.

## 8. Conditional residual-index solution and structural design

### 8.1 One format revision, incremental activation

**Apply this section only if section 7.3's retirement/consumer decision retains efficient exact physical access or the equivalent level of routing detail.** It is a technically viable residual-index option, not the next implementation to perform automatically. If only a smaller non-routing operational catalogue is needed, retire unnecessary routing instead and specify that catalogue's proof/consumer contract first.

For the exact-access case use **D1 + C + B2**: an exact-only, compact, range-addressable derived index. Introduce a new explicit index-object schema/record-format identity, while keeping complete storage selection on `UK_AQ_R2_HISTORY_VERSION=v3`. Advancing the derived format does not require `history/v4/observations`, changed Parquet, renamed logical history or a second normal environment selector.

Do not first minify/gzip every existing object, then rebuild every leaf again for packing. That duplicates operational migration work. A single new format can support compact uncompressed records initially and an explicit supported per-record codec later. Keeping exact individual objects as a short-term fallback **design choice** is reasonable if pack acceptance fails; never implement request-time retry against another format after a selected record fails validation.

### 8.2 Scoped directory and bounded packs

The deterministic scoped `manifest.json` remains the membership selector. A **new schema**, rather than ambiguous optional old fields, would carry:

- Exact scope and supported logical/physical/index identities; decode profile.
- Direct canonical pollutant-manifest identity and reconciled scope row/coverage counts.
- A deduplicated file table containing full required Parquet identities; records use deterministic file references, with no loss of SHA/size evidence.
- A bounded pack descriptor table: deterministic in-root bucket identity, immutable pack key, stored byte length and full SHA-256.
- For each authoritative timeseries: pack reference, byte offset/length, record encoding/version, exact stored record SHA-256 and any decoded-length bound needed by the codec.

Records contain ordered exact segment/range metadata and sufficient explicit identity to validate their association with the directory's scope/timeseries/file table. Shared scope/path fields are derived by schema rule, not guessed. Numeric offsets/counts remain safe integers; timestamps retain millisecond precision and values/multiplicity stay in unchanged Parquet. No record contains the full canonical manifest identity or enclosing pack SHA just to enforce publication order.

Use fixed numeric ID buckets initially, subdivided deterministically when either a byte cap or record-count cap would be exceeded. “256 IDs” is an **illustrative starting bucket width**, not an approved constant or an assumption of 256 occupied records. Never combine sparse unrelated days/months to fill a pack. Set stored/decompressed record, pack and directory hard bounds from the existing safety limits and real TEST artifact distributions; do not silently allow larger objects. The directory already costs O(timeseries in scope) today; shorter entries reduce its growth, but there is no claim of unlimited scale. If a scope exceeds the bound, fail publication before mutation; another bounded directory design needs an explicit decision.

Content-addressed pack keys let old in-flight directory/cursor identities keep reading old immutable bytes during replacement. The directory's record tuple allows **one exact range GET** with no pack-header discovery. The reader validates the selected byte length/hash before decode, then all existing semantic/range checks against directory authority. It rejects unexpected/missing range metadata, malformed offsets, short reads and out-of-root keys. The selected-record SHA is the equivalent of today's exact-leaf body SHA; full-pack authentication occurs during publication and independent integrity verification. This equivalence must be explicit in the new contract. It must not be confused with the **unchanged mandatory HEAD/SHA/ETag gate for canonical Parquet**.

If the selected implementation instead requires an additional pack HEAD to authenticate each record, count that added serial operation and re-evaluate latency; do not conceal it in the five-operation baseline. A design that cannot authenticate the selected record without unbounded whole-pack reads is not acceptable.

### 8.3 Compression and encoding choices

Use deterministic compact JSON first: short schema-owned tuples/dictionaries, path prefixes once and file table references. Prefer auditable named envelope fields with a documented tuple schema over a general new binary codec. Binary digest bytes/base64 can reduce digest text length but cannot omit identity. Canonical observation column names are unchanged; any persisted index-field encoding change needs its own format authority. [D4]

Per-record gzip is structurally compatible with exact ranges: each frame is independently decoded, hash/length-pinned and subject to both stored and inflated bounds. Pin codec parameters/header fields and exact prepared bytes; do not allow timestamp-bearing gzip headers or library upgrades to churn unchanged output. Do not gzip the entire concatenated pack: a byte offset into an ordinary gzip stream does not permit independent record decompression. Do not depend on HTTP Content-Encoding to preserve object-offset/hash meaning.

Compression is conditional on actual uncached TEST CPU/wall-time evidence. If it consumes needed headroom, use compact uncompressed records; `_aligned` retirement, shared metadata and object packing still have value. No compression ratio is claimed before measurement.

### 8.4 Direct reconciliation replaces duplicate provenance

The new builder must establish, before selector publication:

1. Every indexed file/segment matches authenticated existing canonical Parquet or the shared writer's verified output, using the supported schema/layout/profile.
2. Segment coverage is complete, ordered, within bounds, single-timeseries and consistent with canonical row counts and logical observation-content identity.
3. Every directory timeseries appears in exactly one complete record; file references and record ranges are valid and noncontradictory.
4. Record payloads and packs have exact deterministic identities; the scoped parent pins all referenced dependencies.

The canonical manifest is a direct parent reconciliation input and publication prerequisite. It does not need to be copied into every record. This replaces the useful proof role of `_aligned`; it does not just drop provenance fields. Keep unchanged record bodies stable when only an unrelated scope member changes. A pack containing a changed record will legitimately get a new body/key, so pack-level churn is bounded by grouping rather than promised away.

### 8.5 Required component changes and viability

| Component | Concrete extension required; structural basis |
| --- | --- |
| Shared index builder | Add new directory/record/pack artifacts and validators beside the exact builder; the current builder already receives complete validated target metadata. Stop generating `_aligned` only for the new format. |
| Physical target writer / inspector | Preserve existing aligned Parquet writer. Feed metadata to either index encoder. `inspectCanonicalObservationTimeseriesAlignedFiles()` proves existing schema-3 files can be inspected without reserialization. Audit actual schema-4 populations/support separately. |
| Publication scheduler/adapters | New pack artifacts need generic exact-byte dependency/evidence support and raw byte bodies. Existing `Buffer.from(entry.body)` can carry bytes, but existing JSON-artifact validators and control-plane serialization are not automatically codec-safe. Keep file-backed staging and exact recovery identity. |
| Low-level exact reader / R2 source | Dispatch on selected manifest schema; add an authenticated index-record range adapter and bounded optional decompressor; reuse segment validation and unchanged Parquet ranged decoder. Current source exposes full `getIndexObject`, not this new adapter. |
| Private physical cursor | Pin new directory/record and pack identity plus coordinates; deterministic revalidation on continuation; reject old/mismatched cursor formats. Preserve one/two-scope discovery and one-segment work. |
| Station history and public cache | Preserve URLs, chunk/page/row budgets and chronology; accept supported low-level response identity and retire old result-cache generation at cutover. No new browser cursor or chunk model. |
| Steady-state writers and recovery callbacks | Integrate new builder in connector publication and run finalisation, including Prune's scoped-reference recovery; keep lock-bound evidence invalidations and per-UTC-day finalisation. |
| Integrity/SOS-light | Update metadata planners, semantic validators, exact-verification adapters and key allowlists for new artifacts. Current allowlists recognise exact JSON and aligned JSON paths, not arbitrary packs. Rebuild from Dropbox plus overlay and retain authoritative partial-merge/complete-replacement distinctions. |
| Migration and post-write verification | Add an index-only build/verify operator. Existing migration plans/verifiers assume exact artifacts and often canonical rewriting; they cannot be reused unchanged. Update independent closure/coverage verification, not immutable old evidence. |
| Latest / backup inventory / restore | Make latest registry parsing/strict validation understand per-scope index format. Back up that summary; retain derived-tree exclusion. Restore/rebuild must select an explicitly supported format from authenticated canonical backup and publish dependencies before selectors. |
| JSONgen / provenance consumers | Audit exact-metadata evidence codecs and current scope-authority comparisons for accepted index formats; preserve original immutable event bytes and canonical handover authentication. Daily provenance must use selected new records without expanding the Parquet hot path. |

This inventory establishes a feasible separation between existing observation storage and new index representation. It also establishes that this is **not** a one-function serializer change or an already supported configuration toggle. No new external service, database schema or secret is inherently required; format identity can travel in existing scoped authority. Any necessary environment setting must follow the existing catalogue and external TEST/LIVE configuration rules rather than hard-coded branching.

## 9. Expected benefits and performance limits

For the **conditional residual-index redesign**, the planning byte benefit is approximately **61–74% of the supplied complete index** under the stated `r=0.40–0.60` assumption. Full physical-routing retirement has the larger **4.407 GiB gross ceiling**, but section 7.3 identifies why it is not currently executable. The strongest measured duplicate-representation envelope is `_aligned`'s supplied 1.523 GiB, subject to replacing its proof role. TEST's own achievable percentage and total additional JSONgen footprint are unknown. Compression-only offers no object-count saving; packing-only can save many objects without saving much payload. All earlier savings figures are gross canonical-index savings; subtract additional JSONgen/replacement bytes to calculate total-R2 benefits.

For a cold one-segment day the intended lookup remains **one directory GET + one record range GET + one Parquet HEAD + one/two Parquet range GETs**. Shorter directory entries and records should reduce index transfer, parsing/hashing input and writer I/O. Those are directional expectations, not measured latency/CPU improvements. Extra decompression, allocations, validation or a new serial read could negate them. Warm complete-response hits will show little benefit because they already bypass physical reads.

Generation should have fewer PUT/readback artifacts, fewer graph nodes, fewer OS/Dropbox-materialisation-style tiny-file operations in local planning and fewer duplicate segment descriptions. Coverage reconciliation and per-record hashes remain necessary work. Updating one packed member amplifies pack-level writes, and immutable generations temporarily increase storage; byte/ID bounds and deterministic reuse limit that amplification.

Acceptance must preserve correctness, availability and the **remaining supported workload's** latency/CPU budgets. JSONgen monthly serving and canonical metadata verification deserve priority over an old chart lookup after its consumer retires. While the existing route remains active, preserve its applicable p50/p95/p99/max uncached bounds; if exact access remains a product, retain those guarantees through its replacement. A batch-only recovery/currentness path may use a different explicit bounded budget instead of retaining obsolete per-chart latency requirements.

## 10. Migration, compatibility, integrity and recovery

### 10.1 Index-only source and authority

Preserve canonical v3 objects unchanged. The index-only operator must pin environment/bucket, canonical root and source manifests/file identities, code/format/codec identity, exact target byte identities, publication order and durable progress. Use the existing observations global-operation lock for protected planning/publication under the new operation's contract; a lock-free historical reader-switch exception does not cover mutating index construction. Bound preparation by scope/pack and spill exact prepared bytes to run-local staging. Do not create monolithic stdout proposals or retain all pack bodies in memory. [C5–C6, D3, D8, D10]

For ordinary index conversion, existing exact metadata may accelerate preparation **only after its current closure and canonical identities are authenticated**. It cannot be the sole rebuild source because canonical backup excludes it and supplied deletions may have invalidated references. The canonical inspector path is the fail-safe basis. If an actual file is missing or contradicts canonical authority, stop/classify that scope; do not repack remaining rows and quietly redefine history.

### 10.2 Publication and atomicity

The scoped manifest is today's exact-reader selector; latest is not its per-query authentication parent. Therefore publishing latest last alone cannot atomically switch exact readers. The proposed new format uses:

```text
unchanged canonical authority
  -> exact prepared record/pack bytes
  -> PUT + full pack GET verification + durable dependency evidence
  -> scoped directory/selector PUT + GET verification
  -> latest registry finalisation and required run evidence
```

Each scope switches with one complete manifest-object replacement after its immutable dependencies exist. Deploy manifest-schema dispatch before the first new selector. Readers may encounter old-format and new-format scopes during an incremental rollout, but must use **exactly the format selected by each scope**, with no error-triggered fallback. This remains one complete v3 observation generation; schema compatibility is not cross-generation canonical fallback. It requires explicit authority because current validators demand the old exact schema.

A whole-history simultaneous atomic switch is not provided by this design and is unnecessary if every selected scope is complete and compatible. If policy demands a global atomic cutover, a new immutable-generation catalogue/pointer must become an actual reader parent, with its extra lookup/cache semantics designed explicitly. Do not claim R2 offers a multi-object transaction.

Canonical-changing writers must never publish metadata using a retired format after conversion. Select the active per-scope format through the shared finaliser, and give new scopes an explicit current default. Update or disable every unsupported writer before it can mutate converted scopes. Historical migration commands must reject an incompatible target rather than recreate `_aligned`. Frozen SOS-light snapshots are separately owned: retain immutable snapshots, and keep an unsupported version ineligible for the new index until its compatible fixed-generation replacement is accepted.

### 10.3 Checksums and unchanged logical content

New encoding changes index body SHA/size; that is expected. Old parent/checkpoint identities must not be reused for changed bytes. Preserve `observation_content_hash`, canonical manifest hashes, row/status counts and exact file SHA/size/ETag because observations are unchanged. A compact routing record is not sufficient to recalculate logical observation hashes. Pin original proof and verify canonical invariants through the existing inspector/reconciliation; never relabel a record hash as a logical observation hash.

Corrupt directory, missing record, wrong byte range, unsupported codec, inflated-size violation, stale cursor or wrong Parquet identity remains a fail-closed/incomplete result. A valid directory without an ID establishes absence; an existing loose pack/leaf does not. Preserve distinct reasons for physical work incompleteness, unpublished scope and missing published data so provisional IngestDB recovery cannot mask corruption.

### 10.4 Recovery and rollback

Before any selector write, retain exact prior directory/latest identities and an authenticated transition journal alongside prepared new artifacts. A crash before selector publication leaves inert packs. A crash after one scope switches leaves that complete scope readable through its selected format; recovery authenticates durable progress and current bytes before reuse. Never repin completed evidence to changed objects or silently regenerate different compressed bytes during APPLY.

Same-window rollback can restore prior exact scoped selectors **only while their referenced Parquet and old index dependencies still match current canonical history**. After a new-format canonical writer advances a scope, the old leaf generation may be stale even though its objects still exist. Rebuild compatible old-format indexes from the **current** canonical generation or use separately accepted recovery; do not revert to stale old selectors or old v2 observations. Keeping old-reader compatibility temporarily is useful only with explicit current-data proof. Retention is not indefinite currentness.

The observation-only backup coverage remains intact and does not acquire the complete new derived pack tree. Restore authenticates canonical Dropbox data and bindings first, regenerates new derived records/directories with a supported pinned builder, verifies them and publishes selectors/summary last. A compact-latest registry can retain unaffected identities only under its existing canonical-catalogue checks; conversion cannot assume absent backed-up pack bodies are restore prerequisites. Existing immutable migration journals and original JSONgen evidence remain original evidence; new conversion writes new authority.

### 10.5 Eventual deletion and the supplied stale references

Retire old exact leaves and `_aligned` only after deployed reader/writer/verifier/repair/restore compatibility, a complete accepted new index, relevant real TEST writer/backup/rebuild evidence and the rollback-retention decision. Use manifest-guided reachability and authenticated transition records, with separate rules for failed/candidate/previous pack generations and in-flight cursors. An elapsed retention interval alone is not proof that an old object is unreferenced.

Index garbage collection and connector-7 missing-Parquet integrity resolution are distinct operations. Neither is authorised by this report. Any later cleanup needs a concrete bounded classification/removal plan; it must not include canonical Parquet or expand into a whole-bucket deletion.

All eventual application files must be identical between TEST and LIVE, with external environment settings. Develop and accept in TEST first; the user promotes approved complete files later. Substantial TEST implementation changes require exact pre-change code archives under repository conventions. Documentation reports do not need code archives; LIVE archiving is prohibited.

## 11. Phased implementation proposal, with viability gates

These phases are **recommendations for later authorised work**, not actions performed or approval requests. **The retirement decision in section 7.3 precedes the packed-index implementation track.** Phases 1–4 below apply only if the residual consumer inventory justifies that format. No speculative pre-implementation functional suite is proposed. Functional acceptance occurs after deployment through real TEST operations.

| Phase | Structural viability established here / prerequisite | Proposed work and real TEST acceptance | Stop / recovery boundary |
| --- | --- | --- | --- |
| **0. JSONgen/consumer and measurement decision** | JSONgen monthly serving avoids physical chart reads, but its current inspector and canonical writers require both trees. Canonical per-file membership and offline bootstrap provide concrete foundations for a non-routing alternative, not completed replacement proof. | Establish the accepted chart coverage/seam, JSONgen all-writer proof and remaining direct/admin/WHO/research access inventory. Measure canonical plus derived storage, supporting evidence/version growth and metadata operations. Select complete routing retirement, `_aligned`-only retirement, or a residual exact index. Contract owner defines equivalent proof and recovery before implementation. | No mutation. Do not preserve obsolete chart-reader speed as the reason to build a new index. No full-tree retirement while an active consumer or proof contract still depends on it. |
| **R. Retirement/minimal-catalogue track, if selected** | Existing canonical manifests carry per-file identity/member counts and the offline bootstrap reads authenticated canonical backup without a full derived tree. Equivalent per-scope change/supersession/freshness proof still needs an explicit design. | Implement the bounded minimal proof/consumer replacements in TEST, including JSONgen inspection and writer/verifier changes. Accept real monthly serving and remaining consumer/rebuild/backup operations, close stale rollback, then separately authorise a concrete derived-only retirement set. | Do not infer value identity from counts, add automatic Parquet fallback, enlarge Dropbox scope or delete old evidence. If proof/access replacement fails, retain needed metadata and reconsider the conditional track. |
| **1. Implement shared format support** | Existing metadata input and dependency scheduler can support new artifacts, but source adapter/allowlists/cursors/strict latest and verification schemas need explicit extension. | Archive in-scope TEST code once before substantial edits. Implement one shared encoder/validator/reader, index-only operator and format-aware writers/verifiers/SOS/restore. Deploy TEST support while old selectors remain selected. Then generate a bounded real TEST candidate index from current authenticated canonical material; measure actual encoded/stored sizes and operational build cost. | Candidate packs have no serving authority. Unsupported schema or bytes fail before publishing a selector. |
| **2. Controlled TEST scope activation** | One scoped selector can choose an already verified immutable dependency set; no Parquet rewrite or global request-selector is required. Every in-scope writer must already understand selection. | Under the contracted coordination boundary, build/readback-verify candidate packs, switch a small set of existing TEST scopes, and exercise actual deployed historical reads, daily provenance, PM/continuity and normal incomplete/no-store cases. Observe cold CPU/wall-time, GET/range bytes, error outcomes and memory where available. Compare with retained real operational baseline. | Revert only unchanged compatible scope authority; otherwise rebuild from current canonical state. Reject additional serial work or CPU regression; compression remains disabled if it loses headroom. |
| **3. Accepted bounded index-only conversion** | Existing Parquet inspection demonstrates no-rewrite reconstruction; new operator still needs durable staged bytes, source/target identities and restart admission. | Convert coherent bounded batches with complete per-scope dependency verification and latest finalisation. Use the same builder for subsequent real TEST Prune/Integrity/SOS and a normal locked backup. Confirm unchanged canonical identities and correct advanced-generation verification; exercise an authorised rebuild/recovery through actual TEST operations. | Pause on source-root/lock drift, missing data, closure mismatch, unsupported writer or incomplete backup/rebuild proof. No automatic obsolete-object deletion. |
| **4. Retirement and operational acceptance** | Old objects can cease to be dependencies once every selector/consumer is converted; reachability and recovery inventory are still required. | Review concrete old-generation references/rollback needs, then separately authorise bounded derived-only retirement. Verify real TEST counts, bytes, query/CPU outcomes, currentness and restore ownership. Prevent old tools from recreating retired artifacts. Only then provide complete approved-file promotion instructions for the user. | Retain evidence and required old dependencies until retirement conditions are met. No LIVE change or archiving by an agent. |

**Targeted checks that cannot safely be deferred:** before the first active new-format selector, establish deterministic encoded-byte/codec identity, correct range arithmetic and decoded-size limits, no out-of-root/cross-timeseries cursor routing, complete file/record membership reconciliation, and dependency-before-selector/recovery semantics. These are narrow structural checks of a new integrity boundary; real readers must never be the first protection against publishing an unauthenticated range or unbounded decompression. Before any retirement, establish authoritative non-reachability and current rollback/rebuild authority. These do not justify a broad fixture programme, synthetic performance matrix or new pre-implementation test suite.

## 12. Risks, unknowns, outstanding decisions and references

### 12.1 Decisions and evidence still needed

| Unknown / decision | Why it matters / minimal useful evidence |
| --- | --- |
| JSONgen historical-chart replacement and residual access policy | Complete the open-month/live/PM-context/Prune-publication-lag seam, population/continuity coverage and actual default serving. Decide direct API, WHO/admin and research requirements; the old chart latency target is not automatically a future requirement. |
| Total cross-account JSONgen storage and evidence/version retention | Measure gzip products, publication manifests/evidence, original pending/evidence, selected bundles/receipts, control and old/candidate versions independently. Net saving is retired bytes minus replacement catalogue and additional derived bytes, not the canonical bucket change alone. |
| TEST counts by leaf, scope, aligned shard, binding/inventory and residue | Determines object savings and whether the supplied LIVE distribution is relevant. Read only bounded TEST measurements; do not extrapolate population equality. |
| Byte histogram by object kind, records/segments per leaf and IDs per scope/bucket | Sets pack/directory bounds and occupancy; separates fixed envelope from dense-segment cost. Include sparse and high-cardinality scopes. |
| Stored and inflated ratios for compact-only and optional record compression | Determines `r`; measure artifacts produced by the deployed TEST candidate operation, including pack/directory/framing overhead. No percentage currently proven. |
| Current reader deployment, overlay mode, CPU headroom, cache-hit rates and latency tails | Determines whether decompression or an extra operation is tolerable. Use actual invocation telemetry; diagnostics report structure but do not invent CPU milliseconds. |
| Extent of referenced missing Parquet versus unreferenced index residue | Integrity damage requires source-backed recovery; garbage candidates require reachability proof. Aggregate sizes cannot decide either. |
| Child-stability tension through `source_aligned_child` | Contract owner must confirm direct canonical reconciliation and remove non-local hash dependencies in the new schema. Preserve original object/hash meanings meanwhile. |
| Exact scope authority during concurrent publication | Current readers do not take the writer lock and latest is not their parent. Immutable packs prevent old record invalidation, but canonical writers still require established fail-closed publication/race behaviour. Don't claim a multi-object snapshot. |
| Schema-4/overlay population and no-rewrite reconstruction | Reader code supports mixed schemas; current canonical inspector shown here is schema-3-specific. If schema-4 scopes exist at conversion, extend/accept their inspector before admitting them. Never rewrite them just to fit an older inspector. |
| Pack size/ID bucket and immutable retention | Small groups limit amplification; large groups improve occupancy but risk oversized updates. Include old/candidate versions in peak storage and cleanup policy. |
| Latest and fixed SOS consumer compatibility | Strict current registries and frozen formats must not reject valid new scopes or recreate old indexes. Scope the change to active supported paths; retain historic snapshots as immutable evidence. |
| Recovery acceptance and current backups | Derived exclusion is correct only with a working canonical rebuild. Existing binding pack restore acceptance does not prove new observation-index recovery. |
| Account billing/storage class and projected growth | Current dollar savings are small; choose maintainability and reliable exact lookup over maximal compression. Avoid an unnecessary database dependency. |

### 12.2 Supporting TEST code references

All paths below are in TEST ops at the pinned application revision unless another TEST repository is named. Line anchors locate the named function; review its full body and callers.

| ID | File / function evidence |
| --- | --- |
| **C1** | [Shared exact index builder](../../workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs#L357): `buildAlignedSourceShard`, `buildAlignedSourceManifest`, `buildExactLeaf`, `buildExactScopedManifest`, `buildObservationHistoryExactLeafIndexV3ScopedHierarchy`; `latestPayload` at line 620 and `updateObservationHistoryExactLeafIndexV3Latest` at line 817. |
| **C2** | [Exact reader](../../workers/shared/uk_aq_observation_history_exact_leaf_reader_v3.mjs#L374): `validateManifest`, `validateLeaf`; `readObservationHistoryExactLeafDailyMetadataV3` at line 1001; `readObservationHistoryExactLeafPageV3` at line 1197; top-level budgets and cursor schema. |
| **C3** | [Random-access source](../../workers/shared/uk_aq_observation_history_random_access_v3.mjs#L191): `createR2PinnedObservationHistoryV3RandomAccessFile`, `createR2ObservationHistoryV3Source`, `coalesceObservationHistoryV3ByteRanges`, `readObservationHistoryV3ByteRanges`. |
| **C4** | [Steady-state shared writer](../../workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs#L622): `buildObservationHistoryV3SteadyStatePartition`, connector publication at line 1283, run finalisation at line 1777; lock-bound evidence cache at line 355 and bounded verification at line 517. |
| **C5** | [Index serializer and publication scheduler](../../workers/shared/uk_aq_observation_history_index_v3.mjs#L166): `encodeObservationHistoryIndexV3Json`, `buildObservationHistoryIndexV3PublicationPlan`, `finalizeObservationHistoryIndexV3Publication` at line 2703. Also [checksum publication](../../workers/shared/uk_aq_r2_checksum_publication.mjs): `buildR2ChecksumAwarePutIntent`, `verifyR2StoredSha256Head` and `verifyR2StoredBodyGet`. |
| **C6** | [Target writer/inspector](../../workers/shared/uk_aq_observation_history_target_writer.mjs#L805): `inspectCanonicalObservationTimeseriesAlignedFiles`, `buildCanonicalObservationTimeseriesAlignedFiles`, `validateFooter`, projected range validation; [accepted limits](../../workers/shared/uk_aq_observation_history_writer_limits_v3.mjs). |
| **C7** | [Station-history R2 orchestration](../../workers/uk_aq_station_history/src/r2_observations.mjs#L276): `readV3R2Observations`, UTC splitting, shared budgets and page validation; [chunk parser](../../workers/uk_aq_station_history/src/history_chunks.mjs): `parseHistoryChunkRequest`, `buildObservationHistoryChunk`; [calculated history](../../workers/uk_aq_station_history/src/calculated_history.mjs) and [continuity](../../workers/uk_aq_station_history/src/continuity.mjs). |
| **C8** | [v3 API](../../workers/uk_aq_observs_history_r2_api_worker/worker_v3.mjs): `parseObservationRequest`, `handleObservations`, `handleBinding`, `handleDailyProvenance`, `verificationOverlayEnabled`, `cachePolicy`, `cacheKey` and `fetch`; [generation dispatch](../../workers/uk_aq_observs_history_r2_api_worker/worker.mjs); [verification loader](../../workers/shared/uk_aq_observation_verification_overlay.mjs). |
| **C9** | [Post-write closure verifier](../../scripts/index_v3_migration/index_v3_steady_state_post_write_verify.mjs#L780): `verifyV3Authority`; [migration library](../../scripts/backup_r2/lib/observation_history_migration_v3.mjs): `executeObservationHistoryV3MigrationPlan`, `verifyObservationHistoryV3MigrationResult`, side-by-side plan/verification functions; [fixed-v3 planner](../../scripts/backup_r2/uk_aq_plan_sos_light_v3_observation_metadata.mjs#L209): `inspectPinnedBaselinePollutantPartition`, `buildExactV3HierarchyForCatalogueEntry` at line 1149. |
| **C10** | [Inventory builder](../../scripts/backup_r2/build_backup_inventory.mjs), [Dropbox sync](../../scripts/backup_r2/sync_history_to_dropbox.mjs), [hierarchical inventory format](../../scripts/backup_r2/lib/hierarchical_backup_v2.mjs), [binding pack builder](../../scripts/backup_r2/lib/timeseries_binding_backup_pack_v1.mjs#L195), [binding pack restore](../../scripts/backup_r2/lib/timeseries_binding_pack_restore_v1.mjs), [canonical aggregate hierarchy](../../workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs). |
| **C11** | TEST website [shared controller](https://github.com/TEST-uk-aq/TEST-uk-aq.github.io/blob/c430fe6/shared/station-chart/station-chart-controller.js): `defaultOlderChunkMs`, `buildOlderWorkPlan`, `runQueueWithConcurrency`, `loadOlder`; [shared cache](https://github.com/TEST-uk-aq/TEST-uk-aq.github.io/blob/c430fe6/shared/station-chart/station-chart-cache.js): `buildMissingChunkWorkList`; [history loader](https://github.com/TEST-uk-aq/TEST-uk-aq.github.io/blob/c430fe6/shared/station-chart/station-history-loader.js). Function names in a module wrapper do not create a second source owner. |
| **C12** | [Historical ingest recovery](../../workers/uk_aq_station_history/src/historical_ingest_recovery.mjs): `readHistoricalIngestRecovery`, `unpublishedScopeOnly`; [Integrity key allowlist](../../scripts/backup_r2/lib/observation_history_integrity_key_allowlist.mjs): `classifyObservationHistoryIntegrityKey`; [generic proposal validation](../../scripts/backup_r2/lib/generic_v3_proposal_validation.mjs), [SOS proposal validation](../../scripts/backup_r2/lib/sos_light_v3_proposal_validation.mjs). |
| **C13** | [JSONgen canonical authority inspector](../../scripts/jsongen/authority.mjs#L251): `readCanonicalScopes` and its `exact()` helper, aligned manifest at line 253, selected aligned child at line 299, `readCanonicalScopePages` at line 479; [currentness result](../../scripts/jsongen/currentness.mjs): explicit unknown freshness/publication ineligibility; [scope digest](../../scripts/jsongen/scope-authority.mjs): `physicalScopeDigestForKey`; [control](../../scripts/jsongen/control.mjs#L146): disabled `selectManagedPublications`; [monthly publication schema](../../scripts/jsongen/schema.mjs#L330): `assertPublication`, `assertManifestReference`; [manual Stage A workflow](../../.github/workflows/uk_aq_jsongen.yml). |
| **C14** | [Original handover authentication](../../scripts/jsongen/prune-consumer-authentication.mjs#L217): `authenticatePruneHandover`; [original authority](../../scripts/jsongen/prune-original-authority.mjs#L27): `authenticatePruneOriginalAuthority`; [metadata capture](../../scripts/jsongen/prune-original-metadata.mjs): `createPruneOriginalMetadataCapture`, `preparePruneOriginalMetadataSnapshot`; [immutable inputs](../../scripts/jsongen/inputs.mjs): `readBundle`, `readReceipt`; [offline bootstrap](../../scripts/jsongen/bootstrap/generate.mjs#L129): `runBootstrap`, manifest-guided file decode at line 229; [backup source](../../scripts/jsongen/bootstrap/source.mjs): `openBackupSource`; [pilot serving Worker](../../workers/uk_aq_compressed_chart_history/worker.mjs): `selected`, `aqiFromObject` and `fetch`. |
| **C15** | [WHO daily-series proxy](../../workers/uk_aq_cache_proxy/src/who_daily_series_route.ts#L262): `readDailyAurnProvenance`; [Station Snapshot rows](../../workers/uk_aq_dashboard_online_api_worker/src/lib/station_snapshot_v2.ts#L79): `handleStationSnapshotV2Rows`; [metrics](../../workers/uk_aq_db_size_metrics_api_worker/worker.mjs#L937): `fetchR2HistoryCounts`; [hosted generation client](../../workers/uk_aq_dashboard_online_api_worker/src/lib/history_generation.ts), [local generation client](../../local/dashboard/server/uk_aq_dashboard_history_generation.py). |
| **C16** | [Selected-scope reconciler](../../scripts/ukair_bc/uk_aq_ukair_bc_observation_reconciler_locked.mjs#L760): shared partition/exact-hierarchy preparation and `compareExactScope` use; [fixed-v3 independent verification](../../scripts/uk-aq-history-integrity/bin/integrity/exact_v3_verification.mjs); [local v2 query diagnostic](../../scripts/r2_query/query_r2_v2_observs_aqilevels_indexes.sh). These are source capabilities, not claims of current deployed invocation. |
| **C17** | TEST IFW [Dropbox v3 adapter](https://github.com/TEST-uk-aq/uk-aq-integrity-factory/blob/22eb343583c96cea4253c6005e4da4f66a4d5add/src/history/dropbox_observations_v3.mjs#L52): `loadDropboxNodesDcp`, exact manifest/leaf reads; [authority adapter](https://github.com/TEST-uk-aq/uk-aq-integrity-factory/blob/22eb343583c96cea4253c6005e4da4f66a4d5add/src/history/authority.mjs). Future implementation, not current Integrity authority or permission to add full index trees to backup. |

### 12.3 Authoritative contract references

The following links are pinned to the inspected TEST system-docs revision. Older details within a contract remain subject to its explicit amendment precedence.

| ID | Authoritative reference and relevant boundary |
| --- | --- |
| **D1** | [Side-by-side generation](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/r2_history/observation_history_v3_side_by_side_generation_contract.md), [website cutover scope](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/r2_history/observation_history_v3_website_cutover_scope_amendment.md): one selector, coherent prefixes, deferred writers, selected backup namespaces. |
| **D2** | [Exact-leaf amendment](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/r2_history/observation_history_index_v3_exact_leaf_amendment.md): exact membership, aligned-v2 1,024-row maximum, offline byte ranges, physical identity gate, private cursor, 24-hour request and 16-page/5,000-row station-history bounds. |
| **D3** | [Base index-v3 contract](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/r2_history/observation_history_index_v3_contract.md): child identity, reconciliation, byte stability, content versus order edges, bottom-up durable publication, canonical shared writer; bounded global dependency-verification amendment. |
| **D4** | [Canonical observation schema](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/r2_history/observation_history_schema_contract.md), [AURN validation status](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/r2_history/aurn_validation_status_contract.md): immutable row/field meanings, separate index-field schema, pre-overlay concentration projection exception. |
| **D5** | [Binding contract](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/r2_history/contract.md), [continuity](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/r2_history/continuity.md), [interfaces](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/r2_history/interfaces.md): physical identity versus continuity, selected source hierarchy and browser boundary. |
| **D6** | [Observation manifest hierarchy](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/r2_history/observations_manifest_hierarchy_contract.md), [writer coordination](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/r2_history/history_writer_coordination.md), [global operation exclusion](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/r2_history/observations_run_exclusion_contract.md): canonical hash chain, exact affected days, publication and retained lock ownership. |
| **D7** | [Dropbox backup umbrella](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/backup_and_recovery/r2_history_dropbox_backup_contract.md), [v3 backup amendment](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/backup_and_recovery/r2_history_index_v3_backup_amendment.md): canonical coverage, bulk derived-tree exclusion, compact latest, inventory/checkpoint distinction. |
| **D8** | [SOS-light three-phase authority](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/r2_history/sos_light_three_phase_authority_contract.md): currentness, Dropbox-only baseline planning, complete frozen overlay, rebuildability, compact registry fast path and no pre-APPLY R2 dependency discovery. |
| **D9** | [Binding packed backup/restore](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/backup_and_recovery/r2_history_timeseries_binding_pack_backup_contract.md), [pack generation namespace amendment](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/backup_and_recovery/r2_history_timeseries_binding_pack_generation_namespace_amendment.md): accepted transport proof, exact-byte binding restoration, generation isolation. |
| **D10** | [Lock-free read cutover amendment](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/r2_history/observation_history_v3_lock_free_read_cutover_amendment.md), [transition modes](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/r2_history/observation_history_index_v3_transition_modes_amendment.md), [steady-state acceptance](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/r2_history/observation_history_index_v3_steady_state_acceptance_amendment.md): narrow read-only exception, non-empty exact scopes, immutable migration versus advanced steady-state evidence. These do not already specify the proposed index-only operator. |
| **D11** | [Prune observation-only Phase B](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/r2_history/prune_daily_observation_only_phase_b_contract.md), [complete child set](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/r2_history/prune_daily_complete_snapshot_child_set_contract.md), [Prune gate](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/r2_history/prune_connector_day_gate.md), [implementation safety](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/r2_history/implementation_safety_contract.md): full verified index/parent finalisation before original gate, one-shot deletion authority, explicit scope removal, no automatic physical garbage deletion. |
| **D12** | [Station-history contract](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/aqi-levels/station-history-contract.md), [station-chart router](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/station_charts/README.md): R2 precedence, PM context, bounded provisional recovery, CPU headroom, progressive loading and independently gated JSONgen. |
| **D13** | [Verified-writer JSONgen contract](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/station_charts/compressed_history_json_verified_writer_regeneration_contract.md): latest 25 October original-event/currentness acceptance; 24 October source/evidence size and canonical dependency GET evidence; “One writer for two monthly files”, “Incremental update, overlap and source freshness”, “Storage ownership, recovery and Dropbox exclusion”, “PubID manifest discovery and chart cache”, and “Recent ingest and calculated AQI boundary”. Explicit bootstrap/manual recovery exceptions and no automatic Parquet fallback. |
| **D14** | [Compressed-history prototype](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/station_charts/compressed_history_json_test_prototype_contract.md), [precomputed AQI extension](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/station_charts/compressed_history_json_precomputed_aqi_test_contract.md): deployed observation pilot versus unaccepted monthly precomputed/default path; current seam retained; test scope excludes blanket all-network/Sensor.Community activation. |
| **D15** | [WHO daily-series runtime contract](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/cache_proxy/who-daily-series-contract.md), [Station Snapshot contract](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/dashboards/station_snapshot.md), [generation descriptor](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/r2_history/generation_descriptor_contract.md), [IFW high-level contract](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/a21f53b636dcd526d7d21358b1367e29cb751054/system_docs/integrity_factory/ifw_contract.md): surviving non-chart roles and current versus future authority. |

### 12.4 Existing TEST measurements and limitations

**E1:** [12 October CPU investigation](station-history-cpu-aqi-2026-10-12.md), evidence/active-path and CPU sections. This is a non-authoritative operational analysis, used only for its explicitly supplied historical measurements, not as a current index contract or causal benchmark.

**E2:** The binding-pack contract records 6,265 physical members bundled into 143 child packs (3,769,469 total packed/root bytes) on 4 September, with a fresh isolated copy of 1,614.03 seconds and unchanged rerun of 121.05 seconds. These demonstrate object-count/transport savings in that domain, not compression or query latency for observation indexes. The current backup umbrella additionally records the 22 October real TEST one-off reusing 152 ranges/7,446 members without rebuilding, with pack/inventory/sync stages of 118.6/46.1/25.9 seconds. Neither observation proves a gain from reading grouped observation records. [D7, D9]

**Excluded as current v3 evidence:** [the tracked May inventory artifact](../../artifacts/r2-backup-inventory-report.json) describes the retired `backup_inventory_v1.json`, AQI scope and older index-tree inventory. Its counts/timing are not current v3 measurements and were not used to estimate savings.

The deliverable is this report only. No implementation file or authoritative system document was changed; no service operation, data mutation or deployment is implied by its recommendations.
