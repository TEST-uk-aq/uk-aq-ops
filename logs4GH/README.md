# Station-history TEST Worker CPU profiles (4 November 2026)

These are three original Cloudflare CPU `.pprof` captures of UK AQ **TEST** Worker `uk-aq-station-history-test`, collected during calculated station-history AQI CPU investigation. **Profiles 1 and 2 were captured after Stage 2 (PR #171) and before Stage 3 (PR #175). The 14:59-named profile was saved after Stage 4 (PR #181) was deployed.** These are sampled diagnostic profiles, not per-request Worker CPU measurements.

| File | Size | Profile duration | Approximate recorded samples |
| --- | ---: | ---: | ---: |
| [`worker-uk-aq-station-history-test-cpu-1.pprof`](worker-uk-aq-station-history-test-cpu-1.pprof) | 3,883 bytes | 20 seconds | 140 ms |
| [`worker-uk-aq-station-history-test-cpu-2.pprof`](worker-uk-aq-station-history-test-cpu-2.pprof) | 8,588 bytes | 20 seconds | 476 ms |
| [`worker-uk-aq-station-history-test-cpu-1459.pprof`](worker-uk-aq-station-history-test-cpu-1459.pprof) | 9,702 bytes | 30 seconds | 524 ms |

**Provenance:** Captured through Cloudflare Workers → `uk-aq-station-history-test` → Observability → Flamegraph (CPU). The dashboard screenshot for the profiling session showed Worker version `c5070eb7`, deployed on 3 November 2026 at 23:34 UTC. Verify the exact source/version for each profile before relying on its stacks: a screenshot alone does not prove that every sampled isolate used that version. The deployment includes the Stage 2 calculated-history optimisation. PR #175 was subsequently merged and deployed on 4 November 2026 and is **not** represented by these files.

## New Stage 4 capture and investigation context

The new `worker-uk-aq-station-history-test-cpu-1459.pprof` was **saved at approximately 14:59 UTC on 4 November 2026**; the filename records the **save time, not a verified capture-start time**. Its duration (30 seconds) and total sampled activity (524 ms) were independently confirmed using `go tool pprof`.

TEST PR [#181](https://github.com/TEST-uk-aq/uk-aq-ops/pull/181) merged as `c591126134bf2f172037821f08a0b5aa5043d943`, and [deployment run 41849475319](https://github.com/TEST-uk-aq/uk-aq-ops/actions/runs/41849475319) succeeded on **4 November at 14:38:27 UTC**. A Cloudflare dashboard screenshot showed version `a0f3d935`, deployed at 14:38 UTC with 100% of traffic. This is strong session context, **not conclusive identification of the isolate used by every profile sample**. SHA-256 of the new file: `04159af4a8b5137b2ad1344ef16895b8e099886b8f38f4f2f6ccfe15fce8320f`.

Stage 4 removed the second timestamp parse for each accepted R2 observation by reusing the already-validated first/last accepted timestamps of a physical page. The complete 11–18 August 2026 API response (AURN PM10 timeseries 43, station 1581) remained **byte-for-byte identical**, with 168 AQI rows and 168 observation rows; SHA-256: `3c679301c9ad9daac36780396ab5aebefbdf03b9640fd12d127e18cf8bc62e7b`.

Initial **unprofiled** measurements indicated a concerning increase in seven-day median Worker CPU: **September 14.752 → 32.285 ms**, and **August 14.915 → 30.193 ms**, with five invocations in each window. These are small observational samples, not evidence of cause. The initial September three-day Stage 4 window contained 18 invocations versus nine browser requests, so it is **not directly comparable** to its Stage 3 baseline. Further seven-day browser diagnostic runs around 14:52 UTC provide request-level evidence but do not measure Worker CPU.

The new profile includes about **97 ms fetch self CPU**, **30 ms `handleObservationHistoryChunk` self CPU**, **29 ms garbage collection**, **21 ms `normalizeV3PhysicalPage` self CPU**, and **21 ms `pivotNarrowRowsToHelperRows` self CPU**. These are *sampled aggregate* totals and must not be compared as per-request measurements. The earlier captures lasted 20 seconds versus the new 30 seconds and may contain different traffic mixes.

## How to use these profiles

- Open each file with a pprof-compatible CPU profiler. Examine **self versus inclusive CPU** and the parent/child relationships in the sampled stacks; inclusive percentages overlap and must **not** be summed.
- Look at `readV3R2Observations()`, `fetchObservationJson()`, `normalizeV3PhysicalPage()`, `buildR2ObservationRequestUrl()`, `calculateLogicalAqi()`, `pivotNarrowRowsToHelperRows()` and normalised AQI row creation. These were recurring investigation candidates, not proven optimisation opportunities.
- Identify runtime and garbage-collection samples separately. Samples around `fetch` are **not** a measure of upstream Parquet decoding or wall-clock network wait.
- All captures can mix request classes (initial stable head and older history), platform activity and idle time. Sampling is statistical; the recorded totals are **not** a per-request CPU measurement and the different sample totals do **not** show a before/after regression.
- Correlate any proposed code change with the exact **then-deployed** code and current TEST contracts. The first two captures predate PR #175, while the new capture follows deployment of PR #181. Do not infer Stage 4 causality or per-request savings from comparing their raw totals.
- For Workers Free CPU acceptance, use separate **unprofiled deployed TEST invocation measurements**, checking request class, counts, errors, over-10-ms frequency and reliable tails. Preserve numerical/output equivalence and keep R2 index work separate from AQI preparation work.

## Privacy and handling

The two earlier profile files were inspected before public upload for embedded URLs, account IDs, credentials, tokens, email addresses, personal names, local paths and request payloads; none were found. A basic raw-pattern check of the new 14:59-named file did not identify obvious URLs, emails, bearer credentials, secret patterns or /Users/ paths. All three disclose internal JavaScript function names and performance information. **Do not assume future profiles are equally safe:** inspect each new capture before adding it to this public repository.

No executable code or production configuration is provided or changed by these profiles.
