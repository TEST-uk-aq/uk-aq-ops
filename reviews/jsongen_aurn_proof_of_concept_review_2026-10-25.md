# UK AQ JSONgen: AURN proof-of-concept review and GO/NO-GO plan — 25 October 2026

**Non-authoritative review; no implementation or operational authorisation.** This report adds no code, schema, tests, deployment configuration or derived data. Authoritative system_docs remain read-only. PRs [#133](https://github.com/TEST-uk-aq/uk-aq-ops/pull/133) and [#134](https://github.com/TEST-uk-aq/uk-aq-ops/pull/134) remain independent and unchanged.

## 1. Executive recommendation

**Inferred recommendation:** evaluate the already prepared precomputed-AQI extension of the isolated compressed-history pilot. Do not build the Stage 3D managed publisher first. Reuse its offline exporter, authenticated private transport, publish-last pair and shared chart pipeline; replace fixed sample assumptions with a bounded configuration-selected experiment. Use one primary AURN station with PM2.5, PM10 and NO2, plus a second station for short-window switching. Produce genuine closed historical data, offline AQI and immutable paired outputs, then compare against normal index_v3 station-history delivery.

Use a continuous seven-day slice for the first functional demonstration; reuse a complete month to assess monthly payload behaviour, and extend the same primary station to 90 days before claiming the intended long-range benefit or recommending GO. These are extents within one experiment, not separate network pilots. No complete-month **managed publisher** is needed: the existing exporter already splits an explicitly selected interval into monthly objects.

**Confirmed:** most of this path exists in repository code. Schema-v2 export calculates AQI offline; publication validates the pair; the Worker streams precomputed AQI; the isolated browser client consumes it through the existing controller/normaliser/renderer. However, hard-coded station/PM2.5/September allowlists prevent the requested scope and interactions today. The authoritative deployed account still describes the earlier observation-only publication and request-time AQI. Prepared source is not proof of deployed precomputed operation. [O1] [O2] [O4] [O5] [O6] [W1] [W2] [D2]

**Unknown:** current private source availability, deployed extension version, credentials, observed CPU headroom and material benefit. This review makes no GO decision. Missing Integrity handovers and writer inventories block verified production claims, but do not block an explicitly qualified, frozen experimental source set.

**Readiness:** structurally credible for a separately authorised, bounded P1 implementation after the small P0 source/configuration checks below. Not ready for unattended generation, verified monthly selection, default chart adoption or all-network operation.

## 2. Evidence and reviewed state

Labels used throughout:

- **Confirmed:** inspected pinned TEST code/contracts, or an operational fact expressly recorded there. Recorded operations were not repeated or independently reauthenticated in this review.
- **Inferred:** proposed design or engineering judgement, not implemented or accepted behaviour.
- **Unknown:** private/deployed state, source evidence or measurements unavailable here.

| Repository, all under TEST-uk-aq | Main snapshot inspected |
| --- | --- |
| uk-aq-ops | 0df7453c25889591633a1cdbe72647249aca6b9a |
| uk-aq-system-docs | 5b345e6982a418af1ff3b3028649773f790e0e8d |
| TEST-uk-aq.github.io | 6fce23bfd8394d462c93b43b291ba1d219e31522 |

Read the system overview and station-chart router first, then the JSONgen, isolated prototype, precomputed AQI, shared chart, pollutant switching, AQI and routed history contracts. Prior investigations [R1] [R2] supply non-authoritative writer analysis, not new source authority. No LIVE repository, database, R2 object, Dropbox backup, private report or installed Integrity runner was inspected. Current main was accessed through the GitHub connector; stale workspace checkouts were not used as current source.

### Accepted evidence, without extending its meaning

| AURN original event day | Original observations | Selected PM2.5/PM10/NO2 observations | Selected physical scopes |
| --- | ---: | ---: | ---: |
| 15 October 2026 | 22,540 | 10,382 | 433 |
| 17 October 2026 | 19,301 | 9,496 | 433 |

**Confirmed as documented:** original authentication, immutable selected retention and registration were accepted for these two events. Seven separate bounded invocations reported all 866 selected day-scopes original-authenticated and matching canonical metadata, with identical control evidence and disjoint complete coverage. They are not a coherent snapshot, complete writer inventory or freshness proof. The 16 October original was not captured and remains unavailable. Neither day establishes a complete month or preceding PM context. Monthly publication and automatic selection remain disabled. [D1]

**Additional confirmed documentary evidence:** the original pilot rendered a complete v3 September observation publication and matching v2/v3 1 September samples. The implementation handover records 664 September observations / 4,223 gzip bytes for physical timeseries 212, station 248, PM2.5. Completeness here means resolved source coverage, not a reading in every hour. The retained v2 month is incomplete and must remain excluded. [D2] [O12]

The later documented Dropbox bootstrap produced local seven-day candidates for 433 AURN scopes / 71,704 observations in 316 seconds. Its initial PM2.5 example had 166 observations, 168 evaluated hourly endpoints, 168 available DAQI and 166 available EAQI, with observation/AQI gzip sizes 2,095/7,955 bytes. These are historical operator-reported local results: not monthly coverage, independent AQI parity, current R2 freshness or authenticated serving benchmarks. AQI can exceed observation payload size. [D1] [O10]

## 3. Precise experimental scope and source/context requirements

**Inferred minimum scope:**

| Item | Proposed bound and purpose |
| --- | --- |
| Primary station | One genuinely bound AURN station offering the three pollutants; prefer the existing station 248 where all selected series and coverage can be established. Do not invent its PM10/NO2 IDs. |
| Switching reference | One additional genuine AURN station, the same pollutants where available, with one 24-hour visible range plus PM context. This exercises station changes without duplicating a 90-day dataset. |
| Functional slice | Seven continuous closed historical days, genuine gaps retained, with complete source resolution and the required preceding PM context. |
| Payload/performance extent | One complete closed month, then a continuous 90-day primary-station range. For example, 3 July–1 October exclusive spans three monthly objects per pollutant; actual dates depend on legitimate available evidence. |
| Views | Matched 24-hour, month and 90-day requests; observation-only, AQI-enabled, repeated load, range change, pollutant change, station change and explicit Refresh. |
| Output | Private, disposable, provenance-qualified observation/AQI pairs and evidence in a configuration-supplied isolated namespace; manual invocation and selection only. |

One primary station over three intersected months plus three one-day reference series needs at most 12 pairs, before revisions. About 6,480 nominal hourly primary observations over 90 days is a sizing illustration, not a row cap or a claim that every hour exists. Preserve subhourly readings and multiplicity. Use the exporter's existing explicit day/row/file/byte/time bounds; review them against actual source file sizes before execution.

**Are 15/17 October sufficient?** Yes for two independent event-day fidelity checks and reuse of accepted retained evidence, subject to exact scope access. **No for the complete proposed comparison.** A missing 16 October cannot be bridged, and two dates supply neither continuous PM context nor month/90-day response sizes. Do not rebuild its original Prune input or promote a later reconstruction into the original-event chain.

Obtain additional legitimate historical source through one explicitly chosen route:

1. **Preferred shortest route:** manually export selected canonical v3 exact-leaf/Parquet observations with current binding and verification interpretation, retaining exact source bytes/size/digests and start/end metadata checks. The existing bounded reader does this without source writes. Label the resulting dataset **exploratory canonical export, source-as-read, not writer-complete VERIFIED publication**. Re-read stability is not an atomic checkpoint; changing metadata makes the export unusable for this comparison. Keep it wholly outside managed registration/selection. [O1] [O3] [D7] [D8]
2. **Alternative when a suitable completed backup is already retained:** use the bounded Dropbox bootstrap's pinned checkpoint/pack chain and explicitly established backup-specific verification mode. Its candidate format is distinct from the pilot format, so reuse calculation/source handling but add one explicit translation boundary. Do not send bootstrap candidates directly to the existing pilot publisher. The documented AURN transition acceptance prerequisite remains unresolved; absence from an overlay pointer cannot establish it. No fallback to R2 within this route. [O10]

Do not inspect both storage systems by default. Pick the route with usable legitimate pins and the least new integration. Reuse the previous September material only after authenticating its actual retained bytes, current compatibility and context; the documentary record alone cannot supply missing payloads.

**Confirmed AQI obligations:** call the shared station-history calculation with the actual algorithm identity, initially aqilevels_hourly_v2. PM DAQI uses endpoints n−23 through n and at least 18 valid hours; NO2 DAQI and EAQI are hourly, with independent statuses. Pin algorithm/parameters and status interpretation. Preserve negative/invalid exclusion and existing breakpoint conventions. Visible represented interval S…E owns S < n ≤ E, with each band spanning (n−1 hour,n]. Compute hidden context using that convention, not a guessed number of visible rows. Include the preceding day where needed, and do not duplicate context as visible output. [D3] [D4] [O8] [O9]

For the simplest sample choose stable physical bindings with no transition in the selected interval. If a genuine continuity transition is included, resolve date-valid members before calculation using shared orchestration; otherwise record continuity-transition coverage as untested. Do not manufacture a transition. Preserve P/R/null and unavailable original source-status provenance; no inferred ratification from age. Preserve actual observations without rounding, deduplication, hourly interpolation or gap filling. Shared AQI aggregation remains the shared algorithm's responsibility.

Complete source resolution can contain legitimate missing readings and correctly evaluated insufficient_samples outcomes. Keep observation source coverage, display gaps, DAQI/EAQI availability and unresolved context separate. The production rule requiring authenticated adjacent-month **publication** context is not replaced by this experiment's explicitly pinned offline inputs. [D1] [D3] [D4]

## 4. Reuse, prepared code and missing integration

| Component | Confirmed implementation/status | Smallest remaining experiment work |
| --- | --- | --- |
| Prune authenticity | Original-event consumer, retained selected bundles and event registration exist; two accepted events as above. [O11] [D1] | Optional day-fidelity cross-check; do not expand authentication machinery to obtain a performance sample. |
| Source extraction | Bounded v3 exact-leaf/full-file authenticated reader, bindings, status handling and end rechecks; no automatic generation fallback. Export admits the three pollutants but only connector 1. [O1] [O3] | Generic invocation/config allowlist; explicit qualified provenance and sample limits. |
| Offline AQI | Export v2 uses buildCalculatedHistory in daily batches; shared AQI library and station-history orchestration exist. [O2] [O8] [O9] | Preserve context/endpoint compatibility, parameter pins and independent completeness through expanded scope. |
| Immutable publication | Publisher validates local bytes, paired source/digest/coverage, remote upload/readback, then publish-last selection. Current authority is exact September PM2.5 samples. [O4] [O5] | Parameterise scope/ranges; retain the same fail-closed pair semantics and experiment-only selector. |
| Serving | Worker has v1 request-time calculation and v2 gzip streaming; selector/manifest checks and private binding exist. [O6] | Admit configured samples and require the precomputed mode for the measured JSON arm. Do not accidentally benchmark v1 as precomputed. |
| Authenticated proxy | Session/origin checks, opt-in flag, Access credentials, upstream secret and redirect refusal exist. Proxy streams the response and sets no-store. [O7] | Reuse this boundary; supply deployment resources/configuration outside shared code. Check route/header compatibility. |
| Browser | Isolated viewer/client accept both modes; shared controller, cache, normaliser, renderer and diagnostics are reused. [W1] [W2] [W3] [W4] [W5] [W6] | Configured station/pollutant/range selection, multiple-month retrieval, publication-aware reuse and switching within the mounted chart. |
| Default control | Normal station-series/timeseries and canonical index_v3 remain the comparison arm. [D4] [W3] | Confirm selected generation/context and identical source rows during evaluation; do not change defaults. |

**Confirmed limitation:** the current viewer fixes station 248/PM2.5 and September, restricts maxSelection to one, and destroys the controller on source-mode change. That already supports a simple A/B reload; it does not demonstrate in-chart station/pollutant switching or 90-day composition. Client completeness currently derives partly from present hours and all-ok AQI statuses. P1 must align those translations with shared independent source/availability semantics rather than relabel genuine gaps as transport failures. Existing code is reusable, not already accepted parity. [W2] [W3] [D4] [D6]

**Confirmed serving cost shape:** current Worker code reads selector + publication for a manifest request, and those plus one payload for each observation/AQI request. It still parses/hashes small control objects. Streaming removes month calculation from that path, not all Worker CPU or R2 operations. The proxy currently forces no-store: do not claim long-lived HTTP/CDN caching is already implemented. [O6] [O7]

## 5. Stage 3D classification

A = essential isolated experiment; B = required before relevant verified production publication, deferred here; C = work for complete all-network rollout; D = optional/unnecessary as proposed. Where a component has different scope levels, those levels are classified separately.

| Component | Class | Consequence of deferral / minimum retained now |
| --- | --- | --- |
| Additional Integrity handover for any writer able to change the published scope | B | Static qualified export can be evaluated; no verified currentness or production eligibility. #134 remains relevant for that later authority work. |
| Dedicated SOS-light authentication | C; B before publishing affected scopes | Not needed for the selected stable AURN sample. All-network adapters must authenticate complete final views and preservation/removals. |
| Black Carbon writer/publication accounting | C; B wherever its writes affect selected authority | No BC expansion in this three-pollutant experiment; later inventory cannot silently omit a canonical writer. Network inclusion does not decide pollutant policy. |
| Core/binding/verification writer inventory | B | Pin actually consumed sample dependencies now (A); no claim that all possible later changes are known. |
| All-writer completeness witness | B | No positive complete-writer claim. Optional outbox events alone remain insufficient. |
| Coherent multi-partition checkpoint/fence | B | Qualified source-as-read experiment only; start/end rechecks are not a production snapshot guarantee. |
| Authenticated supersession/frontier | B | Experiment compares fixed revisions; cannot infer that absent later events mean no later canonical change. |
| Inspector paging beyond 1,024 physical scopes | B when production scale needs it | Not on this experiment's path. Two accepted days already use 866; a third 433-scope day would exceed the current accounting cap. |
| Large managed-control redesign | D as a POC prerequisite | Do not enlarge/rebuild control to measure charts. Any production redesign needs measured capacity and accepted inventory/checkpoint design; a specific redesign is not itself mandatory. |
| Complete monthly VERIFIED baseline | B | Full-month performance can use a qualified resolved export. It is not a managed baseline and cannot seed verified incremental selection. |
| Genuine input coverage and preceding PM hours | A | Without them, AQI parity is incomplete; known insufficient readings are valid outcomes, missing source authority is not. |
| Adjacent-month selected publication authority and forward PM invalidation | B | Production must authenticate context and propagate t…t+23 effects; manual pinned context is enough for this experiment. |
| Paired observation/AQI digests, one revision, readback and publish-last selection | A | Essential even experimentally: no mixed revisions or partial pair acceptance. Future managed UUIDv4 pubID/CAS/frontier integration is B. |
| Real chart retrieval/rendering, shared calculations and diagnostics | A | Otherwise no credible benefit/correctness decision. |
| Manual Refresh, revision isolation and cache behaviour measurement | A | Required to expose stale/mixed output. Manual operation cannot establish unattended freshness. |
| Five-minute manifest polling, repair hooks, automated generation/retries/scheduling | B for an automatically refreshed production route | Defer all activation. Static charts and manual republication cannot prove the future repair-to-chart freshness SLA. |
| Every-network validated adapters and continuity/removal/status variants | C | AURN calculation/rendering success does not authenticate any other network's originals. |
| New renderer, browser AQI algorithm, new canonical AQI store, all-network POC backfill | D | Unnecessary duplication or contrary to the selected architecture. |

The production blockers in #133/#134 remain intact. Their recommended Integrity work is not the shortest prerequisite for this separately qualified experiment. [R1] [R2]

## 6. Isolated architecture and likely changes

**Inferred data flow:**

Selected genuine TEST source + exact scope/configuration → bounded manual offline extraction with source pins → shared daily AQI calculation with hidden context → immutable observations.gz + aqi.gz + evidence → authenticate both remote readbacks → publish experiment pair manifest/selection last → authenticated TEST cache proxy → protected private Worker streams selected gzip → isolated browser data adapter → existing normaliser/controller/cache/renderer.

In parallel, the unchanged normal station-history client supplies the matched canonical v3/on-demand arm. Compare exact source identities/statuses/context; if current canonical data differs from the experimental snapshot, classify the live-route comparison as non-equivalent. Use the pinned rows with the same shared calculation for correctness, and select/re-export a stable interval before drawing comparative latency conclusions. Preserve the shared chart's existing controller, cache and independent request-settlement ownership. [D5]

Use one publication identity per pair, carried end-to-end in requests/responses and cache keys with source generation, physical/logical identity, pollutant, interval and algorithm. The existing experiment uses publication manifest SHA-256; keep that unambiguous identity for the small pilot rather than pretending it is the future managed UUIDv4 pubID. Across months pin the exact set of pair identities at chart load. A changed selection must trigger rediscovery/reload, never merge old observations with new AQI.

**Likely P1 files, not edits authorised now:**

| Repository/files | Intended bounded change |
| --- | --- |
| Ops scripts/compressed_chart_history/{export,extract,publish}.mjs and source_reader.mjs if needed | Configuration-driven allowlist/identity/range, context and qualified provenance; retain bounded reads and publish-last readback. |
| Ops workers/shared/uk_aq_compressed_chart_pilot.mjs | Shared parameterised descriptor validation with an operator-selected finite allowlist; never accept arbitrary browser keys. |
| Ops workers/uk_aq_compressed_chart_history/worker.mjs | Configured scope, streaming-only precomputed arm and bounded manifest selection; preserve auth and refusal paths. |
| Ops workers/uk_aq_cache_proxy/src/index.ts, only if necessary | Preserve protected route; remove environment/domain literals from any newly shared implementation through validated deployment configuration, without opening arbitrary-origin proxying. |
| TEST website compressed-chart-history-test/{index.html,client.js,viewer.js} | Configured samples and 24h/month/90d selection; reuse mounted-chart station/pollutant actions, source-isolated caches and multi-month client reuse. |
| Existing shared chart/AQI modules | Import/reuse; modify only for a demonstrated shared contract incompatibility, never clone into AURN files. |
| Existing Worker deployment files and environment catalogues, later only | Supply bucket/prefix, enabled flag, upstream URL/origins and credentials via existing bindings/keys and deployment targeting; no scheduler. |

Current code embeds AURN identity, TEST gates and September paths; the proxy also validates a fixed upstream domain suffix. These are existing pilot constraints, not a suitable new shared architecture. Move experiment scope into generic invocation/configuration and environment admission/deployment targeting. Keep application code identical between environments, while the authorised deployment remains TEST-only. Do not add AURN branches, endpoint URLs, bucket/account/project/origin literals to new shared code. Search existing catalogue/target mappings before introducing names; document any genuinely new configuration meaning and align the existing catalogues. No database/schema change is needed. [O5] [O6] [O7] [O13]

Initially retain the protected no-store transport for honest uncached measurements. Reuse immutable data in the existing client/cache ownership, keyed by publication; avoid repeated month downloads for each daily chart chunk. Inspect the actual scheduler/client call pattern before deciding whether a small adapter-level promise/object cache is needed. Evaluate one manual new revision and explicit Refresh. Long HTTP caching plus selector discovery is later production work, unless measurements show it is essential to establish benefit; any such limited addition stays isolated.

## 7. Structural prerequisites, costs and blockers

**Confirmed structural viability:** shared imports and schema-v2 producer/publisher/Worker/browser seams exist; source reads are bounded; private authenticated transport and normal comparison mode exist. No new all-writer authority service, database or scheduler is necessary for P1.

**P0 must establish, without generating data:** exact station/series/binding availability for all three pollutants and the reference station; usable historical source/context pins; the selected verification interpretation; descriptor compatibility; terminal endpoint mapping through daily/monthly joins; generic scope configuration; and access/deployment admission for the already private path. A bounded operator-supplied evidence inventory or metadata-only inspection when read access is available can resolve private availability. This review has neither credentials nor that inventory.

**Genuine blockers to P2/decision:** unavailable source/context, ambiguous binding/status authority, mismatched baseline rows, inability to collect invocation CPU, lack of authorized private deployment/access, or incompatible producer/consumer semantics. Resolve these narrowly. Missing historical originals stay missing. Neither missing Integrity completion evidence nor 1,024-scope paging should be made a P1 blocker for this qualified static experiment.

**Inferred effort:** a bounded integration task across exporter/validator/Worker/browser, rather than a new JSONgen architecture. Scope configuration and multi-month browser composition are the largest code uncertainties; operational credentials/data and telemetry are the largest execution uncertainties. Source authentication failures or a genuine continuity seam could materially increase work. Calendar/person-day estimates are unknown without P0; the previous 143/316-second generations are not a forecast for 90 days.

Measure offline wall/process CPU, peak RSS/disk, download/decode/encode time, source amplification, output count/bytes and failure/restart behaviour. Existing exporter full-file buffering is acceptable only within its explicit limits; sparse selected rows may still require large multi-series Parquet reads. Worker/browser memory is unknown unless exposed by reliable telemetry/profiling; report that limitation instead of assigning offline Node memory to Cloudflare.

Use measured totals:

- Retained storage = sum of observation gzip + AQI gzip + evidence/manifests for every retained revision. Raw diagnostic JSON/local backup copies are separate.
- Regeneration operations = actual source reads + metadata rechecks + immutable uploads/readbacks + manifest/selector operations, including failures. Current paired publisher uploads observation, AQI, evidence and publication manifest before selector work; it is not merely two PUTs.
- Chart operations = selector/publication discovery + payload reads and any repeated chunk requests, split by browser/proxy/Worker cache state. Use actual logs rather than the nominal per-request code count alone.
- Projected network cost = measured per-scope sizes/cadence × genuine network inventory, adjusted for context, source frequency, repair churn and retention. AURN hourly data cannot supply an unsupported numerical all-network estimate.

Manual, infrequent publication keeps experimental operational complexity small. It does not prove affordable frequent corrections, unattended retries, all-network storage or long-term retention. Keep a small explicit revision set; resource retirement requires later operational authorisation.

## 8. Measurable comparison and decision rules

**Inferred protocol for separately authorised P2:** record deployed SHAs, source hashes/status mode, algorithms, exact UTC windows, publications, browser/device/network and cache state. Run matched normal-v3 and precomputed arms in alternating order. Include genuinely cold loads, browser-warm repeat loads and backend cache states separately; report sample counts and raw timings. Inspect actual rendered charts as well as diagnostics. No speculative functional test suite is proposed now.

| Criterion | Evidence and defensible rule |
| --- | --- |
| Observation correctness | Exact scoped row multiset/value/timestamp/status/nullable physical identity parity; no unexplained loss, duplication, resampling or gap filling. Shared display gaps, units, source selection and latest-observation AQI-band cap must agree. Any unexplained mismatch fails correctness. |
| AQI correctness | Same pinned observations/context through shared calculation: per-hour DAQI/EAQI value, band, status, missing reason and endpoint parity, including daily/monthly joins. Expected insufficient samples are acceptable; silently missing context or terminal endpoints are not. |
| Initial loading | First useful concentration line, current-head settlement, AQI settlement and full requested range for 24h/month/90d. Report distributions, failures and render/parse/merge/transfer components. GO needs a repeatable user-visible or reliability benefit beyond measurement noise, without a material agreed regression in other required views. Do not select an arbitrary improvement percentage. |
| Interaction | Repeat, widen/narrow range, station and pollutant switching, cancellation/stale-response exclusion, tooltip/AQI presentation and Refresh. No stale identity/bands, cross-source cache contamination or unnecessary repeated whole-month transfer. |
| Workers Free CPU | Measure each involved Worker invocation separately: manifest, observation, precomputed AQI, proxy/auth and normal control. Report p50/p95/p99 where sample counts support them, maximum, share over 10 ms, exceededCpu and error outcomes. Require reliable headroom **below 10 ms on uncached paths**, not just a passing average or tolerated overrun. The routed 5–7 ms typical target helps engineering headroom; it does not waive outlier analysis. Missing route-attributed telemetry prevents a CPU pass. [D4] |
| Transfer/client resources | Actual compressed and decoded bytes, request count and parse/normalise/merge/render time, memory where observable. Count both AQI and observations plus metadata. A 24h request downloading whole monthly objects may regress; require acceptable measured behaviour under pre-agreed usage priorities. |
| R2 storage/operations | Measured total/revision, upload/readback and chart Class A/B counts, source amplification and failure overhead. Operator agrees a cost/resource envelope before evaluation; absent budgets remain explicitly unresolved. |
| Generation/correction | Offline wall/CPU/RSS/disk, source/context reads, bytes, restart and manual republish/discovery time. Use two genuine pinned revisions if available; a new identity with unchanged genuine data can demonstrate cache discovery only, not semantic repair propagation. No canonical mutation for benchmarking. |
| Availability/freshness | Unavailable/contradictory pairs refuse selection and retain the last complete revision. A chart never mixes revisions. Refresh discovers the newly selected valid pair. Record manual source-age/republish delay; this cannot establish automatic five-minute discovery or the approximately 1–2 hour repair visibility objective. |
| Maintenance/generalisation | Count changed modules/configuration and manual steps; identify every unresolved authority/adapter/continuity/status/removal requirement and estimated operational ownership. GO requires a credible common-interface path to every applicable network, with no dependence on permanent AURN conditionals. |

The earlier same-minute 36.98 ms maximum was not attributed to a route and is not a current baseline or a Free pass. Browser elapsed/AQI-wall headers and offline process CPU are not Cloudflare invocation CPU. Preserve unknowns where telemetry or cross-origin timing restrictions hide a phase. [D2] [D3]

Before running, the operator records acceptable latency/cost/freshness priorities and a bounded repeated-load measurement plan. Do not tune thresholds after seeing results. A tiny sample cannot establish a reliable p99 or production failure rate; no synthetic precision is claimed.

**P3 decision record:** source/deployment pins; comparison validity; correctness/AQI results; CPU headroom/outcomes; latency and interactions; transfer/storage/operations; generation/freshness limitations; all-network architectural risks; operator budgets; residual uncertainty; decision, owner and date.

- **GO** only when correctness, actual end-to-end rendering, Workers Free headroom and a material justified benefit are demonstrated, with acceptable measured costs and a credible every-network design. GO authorises no cut-over by itself.
- **NO-GO** when benefits fail to justify measured costs/complexity, Free headroom is unsustainable, correctness cannot be maintained, or the operator declines the remaining all-network work. Retain current charts and plan authorised retirement of unused experimental resources.
- Missing measurements are **not a GO**. Complete the bounded evidence collection before the binary operator decision; an incomplete review is not an implied cancellation or an invitation to indefinite network pilots.

## 9. GO means every applicable network

**Inferred subsequent objective:** one shared JSON/pair/serving/chart implementation with explicit validated writer-authority adapters, not successive permanent network-specific pilots. Complete the source/writer matrix for all applicable networks, including Prune, generic Integrity, dedicated SOS-light, relevant BC/Core/binding/verification paths and future writers before they gain mutation authority.

Adapters must authenticate genuine final originals, effective/source verification-status meaning, preserved rows, authoritative removals, complete affected-day membership, binding/continuity dependencies and final completion evidence. A successful AURN render proves none of another writer's original authority. Scope-based all-writer inventory/witness, coherent checkpoints, authenticated supersession and capacity-safe discovery/control then gate verified monthly baseline and incremental publication. Choose the concrete inventory/control design after acceptance of its authority invariant; do not assume optional outbox completeness. [R1] [R2]

All-network implementation must cover full-month baseline/context, continuity transitions, next-month PM effects, algorithm/status/binding invalidation, paired UUIDv4 pubID/CAS, retries/recovery and bounded publication discovery. Preserve fail-closed incremental generation: missing baseline/context/event authority must not silently trigger canonical Parquet download or a full rebuild. Explicit manual bootstrap/rebuild stays separate. Automatic repair integration, five-minute manifest discovery/Refresh semantics and production freshness need real TEST acceptance later. Open/current-month R2-first recent-ingest stitching remains a separate accepted policy; do not bypass live AQI for newer ingestdb observations. [D1] [D3] [D4]

“Every network” is independent of pollutant coverage. This experiment selects PM2.5/PM10/NO2 under current calculated-AQI support; it does not decide all 37 AURN pollutants or add BC AQI. Source-provided index observations remain source data, not replacement calculated AQI. Sensor.Community remains excluded by the present phase contract; any later inclusion requires an explicit policy decision, not silent expansion from “every applicable network.” [D3]

The routed prototype mentions Cardiff Centre PM2.5 as a problem case. That is not permission to expand this explicitly AURN-only review into another network. Use a genuine AURN slow/gappy case if available and record that the Cardiff/general continuity/high-frequency cases are unproven. The user's AURN-only evaluation scope controls this experiment.

## 10. Minimal implementation and operational plan

| Phase | Bounded work and exit evidence | Authority boundary |
| --- | --- | --- |
| P0 — structural readiness | Record finite sample/series/date/context inventory, chosen legitimate source route/status interpretation, import/schema/request/normaliser/endpoint compatibility, generic config and telemetry availability. Resolve only genuine blockers. | Supplied inventories or bounded metadata-only reads; no source generation, data mutation or speculative functional suite. |
| P1 — isolated implementation | Parameterise existing pilot, preserve offline shared AQI, immutable paired readback/selection, protected streaming and source-qualified provenance. Add isolated multi-month and in-chart interactions through existing owners. Perform smallest syntax/import/schema/config checks; archive affected active code per repository rules. | Separately authorised code/config changes only; no deployment, default switch, managed selection or scheduler implied. |
| P2 — real TEST evaluation | After explicit deployment/run authorisation, authenticate selected source, generate bounded outputs, publish/read back privately, render seven-day/24h then month/90d views, collect matched metrics and manual revision/Refresh/refusal evidence. Save exact reports and rendered demonstration links privately as appropriate. | No canonical repair/mutation, Integrity/Prune invocation, automatic scheduling, LIVE operation or default chart cut-over. |
| P3 — binary operator decision | Complete the decision record above. GO proposes the minimum every-network production authority/integration programme; NO-GO stops JSONgen and plans safe resource retirement. | No merge, cut-over, deployment or retirement operation follows merely from the report/decision. |

Do not wait for Integrity Phase 0A/0B to write the isolated P1 integration. Do not claim operational readiness until P0 source/access prerequisites and P2 measurements exist.

## 11. ChatGPT Chat-mode documentation handover

No authoritative documentation changed here. For a separately requested Chat-mode update, follow the system overview → station-charts router and preserve the distinction between current runtime and future requirements.

Record this proposed isolated AURN evaluation in the existing prototype/precomputed contracts and routed JSONgen context: source-as-read versus original-event authority; incomplete 15/17-only baseline; exact configured sample/date/context bounds; existing prepared v2 extension versus actually deployed mode; shared calculation/rendering reuse; publication identity and private auth path; normal charts and managed selection unchanged.

After P1, link actual implementation PRs/files, format/configuration deltas, generic environment targeting, source-mode interpretation and smallest structural checks. After P2, add actual deployment SHAs, genuine source pins, readback/row/AQI/render evidence, route-attributed Free CPU and cost/timing results, with unresolved metrics labelled unknown. Record no deployment success or performance pass from source inspection.

If GO, document every-network adapters, authority/checkpoint/supersession/baseline/context gates, pollutant-policy boundaries, failure/recovery, cache discovery and independently authorised rollout/rollback. If NO-GO, record retained normal behaviour and only actually authorised/completed retirement. Keep #133/#134's findings and missing historical originals intact.

## 12. Review validation and limits

Checked pinned producer/consumer source and authoritative contract compatibility at review depth; conclusions identify missing integration rather than asserting functional acceptance. Review references and document structure/whitespace are checked before commit. No application tests or generated data were added/run. No application implementation, configuration/schema/workflow edit, authoritative-document edit, workflow dispatch, deployment, Integrity/Prune/reconciler invocation, R2/Dropbox/database operation, schedule/control activation, merge or LIVE access was performed.

## Pinned references

References below identify the reviewed source, not a claim that that source is deployed.

[D1]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/5b345e6982a418af1ff3b3028649773f790e0e8d/system_docs/station_charts/compressed_history_json_verified_writer_regeneration_contract.md
[D2]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/5b345e6982a418af1ff3b3028649773f790e0e8d/system_docs/station_charts/compressed_history_json_test_prototype_contract.md
[D3]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/5b345e6982a418af1ff3b3028649773f790e0e8d/system_docs/station_charts/compressed_history_json_precomputed_aqi_test_contract.md
[D4]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/5b345e6982a418af1ff3b3028649773f790e0e8d/system_docs/aqi-levels/station-history-contract.md
[D5]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/5b345e6982a418af1ff3b3028649773f790e0e8d/system_docs/station_charts/contract.md
[D6]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/5b345e6982a418af1ff3b3028649773f790e0e8d/system_docs/station_charts/pollutant-switch-contract.md
[D7]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/5b345e6982a418af1ff3b3028649773f790e0e8d/system_docs/r2_history/observation_history_index_v3_exact_leaf_amendment.md
[D8]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/5b345e6982a418af1ff3b3028649773f790e0e8d/system_docs/r2_history/observation_history_schema_contract.md
[O1]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/compressed_chart_history/README.md
[O2]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/compressed_chart_history/export.mjs
[O3]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/compressed_chart_history/extract.mjs
[O4]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/compressed_chart_history/publish.mjs
[O5]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/uk_aq_compressed_chart_pilot.mjs
[O6]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/uk_aq_compressed_chart_history/worker.mjs
[O7]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/uk_aq_cache_proxy/src/index.ts
[O8]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/lib/aqi/aqi_levels.mjs
[O9]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/uk_aq_station_history/src/calculated_history.mjs
[O10]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/jsongen/bootstrap/README.md
[O11]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/jsongen/README.md
[O12]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/compressed_chart_history/STAGE_2B.md
[O13]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/config/uk_aq_github_env_targets.csv
[W1]: https://github.com/TEST-uk-aq/TEST-uk-aq.github.io/blob/6fce23bfd8394d462c93b43b291ba1d219e31522/compressed-chart-history-test/README.md
[W2]: https://github.com/TEST-uk-aq/TEST-uk-aq.github.io/blob/6fce23bfd8394d462c93b43b291ba1d219e31522/compressed-chart-history-test/client.js
[W3]: https://github.com/TEST-uk-aq/TEST-uk-aq.github.io/blob/6fce23bfd8394d462c93b43b291ba1d219e31522/compressed-chart-history-test/viewer.js
[W4]: https://github.com/TEST-uk-aq/TEST-uk-aq.github.io/blob/6fce23bfd8394d462c93b43b291ba1d219e31522/shared/station-chart/station-chart-controller.js
[W5]: https://github.com/TEST-uk-aq/TEST-uk-aq.github.io/blob/6fce23bfd8394d462c93b43b291ba1d219e31522/shared/station-chart/station-history-client.js
[W6]: https://github.com/TEST-uk-aq/TEST-uk-aq.github.io/blob/6fce23bfd8394d462c93b43b291ba1d219e31522/shared/station-chart/station-chart-renderer.js
[R1]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/da96fa2a73133f7ccccf35e08b10b305bbf3f71e/reviews/jsongen_stage3d_readiness_review_2026-10-25.md
[R2]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/91eb38698376801f77e5abc4637553529efbe203/reviews/jsongen_stage3d_phase0a_integrity_readiness_2026-10-25.md
