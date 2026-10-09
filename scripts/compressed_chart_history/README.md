# Stage 2A: bounded offline compressed chart-history export

## Current precomputed-AQI extension (code prepared; deployment separate)

The exporter now writes a schema-v2 candidate containing paired observation and
precomputed AQI gzip JSON. It reads the preceding UTC day once from the same
canonical generation, runs the shared station-history AQI implementation in
non-overlapping UTC-day output batches, and records unresolved PM context as
incomplete AQI. Observation export completeness remains independent. The
publisher verifies both objects, evidence, source identity, daily status and
digests before moving the existing publish-last selector. Published schema-v1
single-object references remain readable and retain request-time AQI.

The Stage 2A account below describes the original observation-only pilot and
its historical measurements. Its statements that AQI is not exported and that
the candidate is schema v1 apply to that earlier implementation only. For the
current bounded September operation use `--generations v3` and a fresh output
directory, then run `publish.mjs` first without `--publish` for local preflight.
The retained v2 one-day sample remains diagnostic; do not export or publish a
fabricated full September v2 month. No automatic publication is configured.

This is a manually invoked, read-only TEST experiment. It creates local JSON,
gzip, pinned-source evidence, a candidate manifest and a comparison report. It
does not publish anything, modify canonical history/indexes/bindings, acquire
mutation locks, call Integrity, change runtime generation selection, or change
any chart, Worker, scheduler or backup path. It has no deployment component.

Authority remains in `TEST-uk-aq/uk-aq-system-docs`:

- `plans/2026-10-08_compressed_chart_history_json_v2_v3_feasibility_and_test_prototype_plan.md`
- `system_docs/station_charts/compressed_history_json_test_prototype_contract.md`
- The routed canonical observation schema, side-by-side generation, exact-leaf,
  verification-overlay and physical-timeseries binding contracts.

The schema/paths below are **experimental proposals**, not production decisions.

## Run

Run from the TEST ops repository with installed dependencies (`npm ci` if absent).
Node must support `--env-file` (20.6+). The existing Parquet dependency loader
resolves `hyparquet` and `hyparquet-compressors` from this repository. No new
package, environment variable, credential catalogue or workflow is needed.

Perform structural checks before extraction:

```sh
node --check scripts/compressed_chart_history/source_reader.mjs
node --check scripts/compressed_chart_history/extract.mjs
node --check scripts/compressed_chart_history/export.mjs
node scripts/compressed_chart_history/export.mjs --help
```

Example complete one-day overlap; supply a **new** output directory on each run:

```sh
node --env-file=.env scripts/compressed_chart_history/export.mjs \
  --connector-id 1 --timeseries-id 212 --pollutant pm25 \
  --start-utc 2026-09-01T00:00:00Z --end-utc 2026-09-02T00:00:00Z \
  --generations v3,v2 \
  --output-dir /Users/mikehinford/uk-aq-work/compressed-chart-history/new-one-day-run
```

For the month use `--end-utc 2026-10-01T00:00:00Z`; use `--generations v3` for
a complete v3-only candidate. V2 is read only when explicitly requested. The
pilot admits AURN connector `1`, pollutants `pm25`, `pm10` and `no2`, and requires
an authoritative physical binding. WAQN/SAQN cannot be selected. There is no
continuity stitching: each export contains only the named physical timeseries.

Reuse existing private `UK_AQ_ENV_NAME=TEST`, `CFLARE_R2_ENDPOINT`,
`CFLARE_R2_BUCKET=uk-aq-history-cic-test`, `CFLARE_R2_ACCESS_KEY_ID`,
`CFLARE_R2_SECRET_ACCESS_KEY` and optional `CFLARE_R2_REGION` (`auto` by default).
Do not print these values. `UK_AQ_R2_HISTORY_VERSION` is not changed or used as
implicit adapter selection. The reader uses the existing SigV4 signer with
bounded GET streaming and no retries; it exposes no write/list/head operation.

Bounds: 93 intersected UTC days, 100,000 selected rows, 1,000,000 rows per source
file, 2,048 GET attempts per generation, 16 MiB metadata/64 MiB Parquet per
object, and 128 MiB consumed source bodies per generation by default.
`--max-source-mib N` permits 1–512 MiB. Reads and decoding are sequential;
in-memory full-file buffering is deliberate for this bounded pilot. Output must
be outside the multi-repository workspace, is private locally, and cannot reuse
an existing directory. No generated files enter this repository or canonical
source paths. Exit 0 means all selected generations completed; 2 means a source
was incomplete/failed and a diagnostic report was written; 1 means the run
stopped, for example on invalid options or local output failure. A partially
written directory must not be treated as a usable manifest.

## Extraction and authority

Both adapters use the shared `getObservationHistoryGeneration()` roots and
the existing offline `hyparquet` dependency loader, physical-schema validation,
legacy verification resolver and current v3 overlay loader.

- **V3:** read the scoped exact-leaf manifest, validate and pin the selected
  timeseries leaf by its advertised byte size/SHA-256, cross-check its Parquet
  references against the canonical pollutant manifest, download the full
  referenced files and decode only complete selected row groups. Check row
  group offsets/counts, physical identities, schema, file digests and scoped
  row counts. Exact selected timestamp/value chunk bytes are recorded separately.
- **V2:** require its own complete file-range index and canonical pollutant
  manifest; cross-check manifest hash and every file identity/range, download
  candidate files, decode their rows, then filter the physical timeseries.
  There is no glob/list discovery, cross-generation fallback or v3 backfill.
- Missing scopes remain **unknown/unexported** unless a validated canonical
  parent omits that child or an available scoped index/canonical manifest proves
  absence. Missing bindings or invalid referenced objects fail closed. A
  successful empty payload is not substituted for failed authority.
- Persisted schema 3 `verification_status`, including null, is preserved.
  Legacy schema 2 `status` uses the shared AURN compatibility resolver. Schema 4
  requires explicit canonical schema/writer identity and activated verification
  authority; identical six-column names never imply schema 4. V3 effective
  status uses its current selected overlay, with that timeseries' applicable
  semantic provenance recorded; v2 retains its independent legacy semantics.
  A manifest declaring both schema 2 and 4 with indistinguishable six-column
  files is rejected rather than guessed; resolving such a mixed file requires
  an explicit per-file identity in a later extension.
- All selected metadata (including previously missing keys) is re-read at the
  end. A changed selector/manifest/binding fails the generation. This guard is
  not a lock or atomic frozen snapshot. Every successfully consumed source
  object is pinned by SHA-256, size and observed ETag in local evidence.

Samples are sorted deterministically without deduplication, aggregation,
rounding, interpolation or hour filling. Finite canonical binary64 values,
negative values, null station IDs, timestamps and multiplicity are retained;
JSON numbers use JavaScript's round-trip representation (canonical negative
zero serializes as zero). Calculated AQI is not exported. Source gaps stay gaps.

## Proposed monthly JSON v1

See [month.schema.json](month.schema.json). UTC timestamps are canonical ISO
milliseconds ending in `Z`. Month and requested intervals are `[start,end)`.
Partial-month exports explicitly state the narrower request; `complete` means
all requested source scopes were resolved, not that every hour has a sample or
that the entire calendar month was requested.

```text
schema_version: 1
kind: uk_aq_compressed_chart_history_month
identity: {connector_id, timeseries_id, station_id, pollutant_code}
source: {generation, bucket, source_evidence, physical_schemas, verification}
coverage: {
  month_utc, month_start_utc, month_end_exclusive_utc,
  requested_start_utc, requested_end_exclusive_utc,
  state, complete, row_count, unique_timestamp_count,
  duplicate_timestamp_row_count, min_observed_at_utc, max_observed_at_utc,
  days: [{day_utc, state, row_count}]
}
row_columns: [observed_at_utc, value, station_id, source_status, verification_status]
observations: [[UTC timestamp, numeric value, physical row station ID or null,
                persisted status/legacy source text or null,
                effective P/R/null], ...]
```

Binding station ID identifies the selected physical series; each tuple preserves
the actual canonical row's nullable station ID. Observation units remain owned
by the existing timeseries metadata; this exporter makes no unit conversion.
The schema describes shape; runtime guards enforce identity, interval, digest,
count and completeness relationships.

Paths are local proposals, with full lowercase SHA-256 names:

```text
v3/connector_id=1/timeseries_id=212/month_utc=2026-09/<JSON-SHA256>.json.gz
v3/connector_id=1/timeseries_id=212/month_utc=2026-09/<JSON-SHA256>.json
v3/source-evidence.<evidence-SHA256>.json
candidate-manifest.<manifest-SHA256>.json
comparison.json
comparison.md
```

V2 uses the same structure under `v2/`. JSON is UTF-8, recursively sorted object
keys, compact encoding and one trailing newline. gzip level 9 has no acquisition
timestamp or filename. Both uncompressed and compressed byte digests/sizes are
recorded; gzip is round-tripped and written payloads are read back before the
manifest is created. Repeatability assumes identical pinned sources, selected
range and encoding/runtime version (Node/zlib versions are in the report).

## Proposed manifest v1

The candidate contains `schema_version`, `kind`, `export_schema_version`,
`environment`, `identity`, `requested_interval`, overall `complete`, per-source
state/binding/evidence/day coverage, and `objects` with:

```text
{month_utc, month_start_utc, month_end_exclusive_utc,
 requested_start_utc, requested_end_exclusive_utc, state, row_count,
 path, byte_size, sha256, json_path, json_byte_size, json_sha256,
 content_type: application/json, content_encoding: gzip,
 source_evidence: {path, byte_size, sha256}, publication_eligible}
```

`publication_state` is always `local_only_not_published`. `publication_eligible`
is a local completeness signal, never publication authority. Diagnostic
incomplete files remain labelled and ineligible; failed generations produce no
monthly files. The complete v3 result can be exported alone even when a
two-source candidate is incomplete. Evidence contains all read object
identities, binding and verification provenance; it is independent of volatile
timing/capture metrics, which are in `comparison.json`.

A later publisher must verify **all** newly referenced gzip/evidence objects,
publish the manifest last, and retain the previous complete selection on
failure. Confirm explicit absence/removal separately from pending/failed
export. No mutable selector, remote publish state, upload logic, scheduler or
retention mechanism is implemented here. Raw JSON is local diagnostic output,
not an additional proposed delivery object. Evidence is private audit overhead;
the viewer need not fetch it with each chart payload.

## Measurements and Stage 2B

Reports record extraction wall/process CPU, source-read wall time, decode time,
encoding/local-write wall/CPU, consumed body bytes, metadata/Parquet bytes,
unique source objects, GET attempts (including revalidation/404s), decoded rows
and row groups, selected rows, payload sizes, evidence size and manifest size.
Process CPU is local Node CPU, not Cloudflare Worker CPU. Export wall time starts
after module loading; reports exclude HTTP/TLS overhead and initial structural
inspection requests. Class B candidates are the measured GETs; Class A writes
are zero. Distinguish source file storage, read amplification and targeted v3
column bytes; neither entire multi-series files nor column-only bytes are an
exact attributable canonical-series storage baseline.

The 09/10/2026 functional evaluation used actual TEST AURN physical timeseries
212, station 248, PM2.5, with existing private credentials. See
[stage2a_findings.md](stage2a_findings.md) for real sizes and limitations. The
one-day comparison uses independent row multisets (measurements, embedded
status, effective status and full tuples), preserving discrepancies with counts
and bounded examples. Incomplete scopes are explicitly non-comparable.

Stage 2B should use the complete v3 month and the equal one-day v2/v3 overlap,
then an explicitly approved 90-day/context sample if available. Privately
publish only verified immutable sample files and a publish-last selection;
reuse the existing station chart controller, renderer and AQI behaviour through
its data-source seam. Measure real TEST cold/warm transport, parse/normalisation,
first useful line, current head, full-range settlement, merge/AQI/render, R2
operations and Cloudflare CPU/outcomes under the existing 03/10 diagnostics
definitions. No offline result here establishes Workers Free performance or
browser-render speed. Unpublished Cardiff WAQN observations remain excluded.

Only new files were added. Existing implementation files required no archive
copy; no active source was replaced. Rollback is to stop invoking this tool and
remove its new directory/local outputs; deployed systems are unaffected. The
authoritative system documentation was not edited. A documentation handover
should record this offline pilot and its measured evidence; publication and
chart integration remain a separately authorised Stage 2B task.
