# Station-history TEST Worker CPU profiles (4 November 2026)

These are two **original Cloudflare CPU `.pprof` captures** of the deployed UK AQ **TEST** Worker `uk-aq-station-history-test`. They were collected during investigation of station-history calculated AQI CPU usage, **after TEST PR #171 (Stage 2)** and **before PR #175 (Stage 3)**. They are diagnostic evidence, not current Stage 3 CPU measurements.

| File | Size | Profile duration | Approximate recorded samples |
| --- | ---: | ---: | ---: |
| [`worker-uk-aq-station-history-test-cpu-1.pprof`](worker-uk-aq-station-history-test-cpu-1.pprof) | 3,883 bytes | 20 seconds | 140 ms |
| [`worker-uk-aq-station-history-test-cpu-2.pprof`](worker-uk-aq-station-history-test-cpu-2.pprof) | 8,588 bytes | 20 seconds | 476 ms |

**Provenance:** Captured through Cloudflare Workers → `uk-aq-station-history-test` → Observability → Flamegraph (CPU). The dashboard screenshot for the profiling session showed Worker version `c5070eb7`, deployed on 3 November 2026 at 23:34 UTC. Verify the exact source/version for each profile before relying on its stacks: a screenshot alone does not prove that every sampled isolate used that version. The deployment includes the Stage 2 calculated-history optimisation. PR #175 was subsequently merged and deployed on 4 November 2026 and is **not** represented by these files.

## How to use these profiles

- Open each file with a pprof-compatible CPU profiler. Examine **self versus inclusive CPU** and the parent/child relationships in the sampled stacks; inclusive percentages overlap and must **not** be summed.
- Look at `readV3R2Observations()`, `fetchObservationJson()`, `normalizeV3PhysicalPage()`, `buildR2ObservationRequestUrl()`, `calculateLogicalAqi()`, `pivotNarrowRowsToHelperRows()` and normalised AQI row creation. These were recurring investigation candidates, not proven optimisation opportunities.
- Identify runtime and garbage-collection samples separately. Samples around `fetch` are **not** a measure of upstream Parquet decoding or wall-clock network wait.
- Both captures can mix request classes (initial stable head and older history), platform activity and idle time. Sampling is statistical; the recorded totals are **not** a per-request CPU measurement and the different sample totals do **not** show a before/after regression.
- Correlate any proposed code change with the exact **then-deployed** code and current TEST contracts. This evidence predates the one-pass output-row optimisation in PR #175; do not infer its CPU savings from these profiles.
- For Workers Free CPU acceptance, use separate **unprofiled deployed TEST invocation measurements**, checking request class, counts, errors, over-10-ms frequency and reliable tails. Preserve numerical/output equivalence and keep R2 index work separate from AQI preparation work.

## Privacy and handling

These two particular profile files were inspected before public upload for embedded URLs, account IDs, credentials, tokens, email addresses, personal names, local paths and request payloads; none were found. They do disclose internal JavaScript function names and performance information. **Do not assume future profiles are equally safe:** inspect each new capture before adding it to this public repository.

No executable code or production configuration is provided or changed by these profiles.
