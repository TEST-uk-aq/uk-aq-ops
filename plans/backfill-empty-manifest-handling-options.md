# Backfill empty-manifest handling — options

## 1. Hypothesis verification

The hypothesis is **partly correct on symptom, but not on mechanism**.

- `run_job.ts` clearly has no-data reuse semantics (`no_data_manifest_reused`, `empty_payload_confirmed`) but those are implemented in the **UK-AIR SOS adapter fetch path**, not in the OpenAQ connector/day write path. The fields are defined in UK-AIR SOS result types and emitted by UK-AIR SOS fetch/parse flows. They are not consumed by OpenAQ for connector/day manifest creation. (workers/uk_aq_backfill_local/run_job.ts:170-171,187,5675-5716,5873-5893).
- In `source_to_r2`, OpenAQ with timeseries filtering does run a targeted pre-filter on location IDs when `UK_AQ_BACKFILL_TIMESERIES_IDS` is set. That can reduce candidate locations and, if no source files are found for those locations/day, the run is skipped before any manifest write. (workers/uk_aq_backfill_local/run_job.ts:10467-10540,10619-10639).
- Independently of timeseries filtering, there is a downstream generic guard: if derived observation rows are empty (or AQI rows empty in non-`observations_only` mode), the connector/day is marked skipped and exits before export functions are called. (workers/uk_aq_backfill_local/run_job.ts:11049-11101).
- The export path itself can already write an empty connector manifest (`file_count: 0`, `source_row_count: 0`, `files: []`) because `exportObsConnectorRowsToR2` chunks rows, writes zero parts when empty, then still writes connector manifest. So the blocker is the pre-export skip guard, not exporter capability. (workers/uk_aq_backfill_local/run_job.ts:3229-3332,2245-2265).

**Conclusion:** the observed failures are consistent with a no-row fast-skip in `runSourceToAll` for OpenAQ timeseries-scoped runs, not with Bash wrapper validation and not with a missing ability to serialize empty manifests.

## 2. Early-exit map (file:line citations)

Below are all relevant early exits in the OpenAQ `source_to_r2` path that can occur for zero-data windows and prevent empty manifest writes.

1. **Timeseries filter resolves to no bindings (metadata-level zero match)**
   - `targetedTimeseriesIds.length === 0` ⇒ skip + continue (`no_matching_requested_timeseries_ids`).
   - This occurs before source fetch.
   - (workers/uk_aq_backfill_local/run_job.ts:10467-10495).

2. **Timeseries filter resolves to no location IDs (metadata-level zero match after join)**
   - `candidateLocationIds.length === 0` after targeted station-ref projection ⇒ skip + continue (`no_matching_location_ids_after_timeseries_filter`).
   - This occurs before source fetch.
   - (workers/uk_aq_backfill_local/run_job.ts:10496-10539).

3. **No source files found for day/location set (source-level zero availability)**
   - After iterating candidate locations, `locationFilesFound === 0` ⇒ skip + continue (`no_location_day_source_files`).
   - This is a direct fit for upstream outage days (the described incident pattern).
   - (workers/uk_aq_backfill_local/run_job.ts:10552-10617,10619-10639).

4. **Post-parse zero rows guard (data-level zero payload)**
   - Even when files exist, if parsed/mapped output yields no rows (`obsHistoryRows.length===0`) then connector/day is skipped (`no_observation_rows`) and exits before any manifest write.
   - In non-`observations_only` mode an additional zero-AQI guard also skips.
   - (workers/uk_aq_backfill_local/run_job.ts:11049-11101).

Related structural behavior:

- Manifest writing only happens after these skip guards; empty rows never reach export today.
- (workers/uk_aq_backfill_local/run_job.ts:11138-11201).

## 3. Options

### Option A — Convert no-row skip into explicit empty-manifest write (narrow OpenAQ branch)

**Approach**

- In OpenAQ branch, treat `locationFilesFound === 0` as a valid “no data for this connector/day” condition when metadata filters were otherwise valid; route to a new helper that writes empty observation connector/day manifests (and AQI as applicable) instead of `status=skipped`.
- Also change the downstream generic no-row guard for `sourceAdapter === "openaq"` (and maybe only when `SOURCE_TO_R2_TARGETED_MERGE` or requested timeseries is present) to write empty manifests rather than skip.
- Main edit area: OpenAQ acquisition/skip path + no-row guard + small helper near export flow.
- (workers/uk_aq_backfill_local/run_job.ts:10467-10639,11049-11101,11138-11201,3229-3332).

**Behavioural contract**

- Object keys unchanged (same connector/day manifest key and day manifest key paths).
- Connector manifest exists with `source_row_count=0`, `file_count=0`, `files=[]`, null min/max timestamps, and deterministic `manifest_hash` computed over this empty payload shape.
- Day manifest includes connector entry and totals reflecting zero rows for that connector/day; `manifest_hash` changes accordingly.
- Downstream systems:
  - integrity cross-check sees manifest present and stops flagging manifest-missing for those day/connector pairs.
  - dropbox backup inventory/checkpoint model already key off manifest bytes/hash and should ingest this as a normal changed manifest unit.
  - cache proxy / index rebuilder already consume manifest structure and should treat zero-file manifests as empty coverage day (no parquet reads).

**Backwards-compat / risk**

- Risk: this may newly “succeed” runs that today skip due to transient source fetch absence; if a missing file is actually a temporary retrieval issue, empty-manifest commit could mask retriable failure.
- Mitigation: only activate on explicit allow-conditions (e.g., OpenAQ adapter + non-error fetch path + connector/day scoped no-source result), and preserve error paths for transport failures.

**Scope of change**

- ~40–90 lines, medium risk, localized to `runSourceToAll` plus helper.
- Test surface: OpenAQ targeted and connector-wide no-data days; integrity-triggered observations-only mode.

**Pros**

- Closest to desired behavior; directly fixes manifest-missing integrity failure mode.
- Keeps existing manifest schema and downstream contracts.

**Cons**

- Requires careful distinction between “authoritative no data” vs “source unavailable/error.”

### Option B — Generalize no-row handling: always export manifests even when rows are empty

**Approach**

- Remove/relax the `noObservations` skip guard so export is always called in non-error paths.
- Rely on existing `exportObsConnectorRowsToR2` ability to emit empty connector manifests (no parquet parts + manifest only).
- For `observations_only`, this is straightforward. For full scope, decide whether AQI export should also run with empty rows (it likely can, but validate symmetry with `exportAqiConnectorRowsToR2`).
- (workers/uk_aq_backfill_local/run_job.ts:11049-11101,11138-11201,3229-3332).

**Behavioural contract**

- Any non-error connector/day with zero observation rows writes an empty observation connector manifest + day manifest.
- `manifest_hash` remains deterministic from payload bytes; changes only when payload changes.
- Downstream behavior same as Option A, but broader: more scenarios produce empty manifests.

**Backwards-compat / risk**

- Broadest behavioral shift; may convert many currently-skipped states (including potentially misconfigured filters) into committed empty manifests.
- Could reduce signal from skip reasons used operationally for diagnosing filter mismatches.

**Scope of change**

- ~20–60 lines, medium-high risk because semantics change across adapters.
- Test surface expands to all source adapters.

**Pros**

- Simple and robust: one rule for all adapters.
- Reuses existing exporter behavior.

**Cons**

- Too permissive unless paired with stricter classification of legitimate “should fail” states.

### Option C — Add explicit mode flag for empty-manifest-on-no-data in integrity-triggered runs

**Approach**

- Add env switch (e.g., `UK_AQ_BACKFILL_WRITE_EMPTY_MANIFEST_ON_NO_DATA=true`) checked in no-data skip points.
- Keep current default behavior unchanged; integrity workflow turns flag on.
- Implement in OpenAQ no-source/no-row exits and optionally generic no-row guard.
- (workers/uk_aq_backfill_local/run_job.ts:10467-10639,11049-11101).

**Behavioural contract**

- With flag off: current skip behavior.
- With flag on: no-data paths write empty manifests using existing keys/hash semantics.
- Downstream systems observe same manifest shapes as Option A.

**Backwards-compat / risk**

- Lowest compatibility risk because default is unchanged.
- Operational risk moves to configuration correctness (must ensure integrity pipeline sets flag consistently).

**Scope of change**

- ~35–80 lines including env parse, branching, logging.
- Risk low-medium.

**Pros**

- Safe rollout and reversible.
- Enables targeted use for integrity recoveries / pre-2025 outages.

**Cons**

- Adds mode complexity and potential drift between manual and integrity runs.


### Option A.1 — Authoritative no-data classifier (implementation matrix)

Use this matrix inside Option A so empty manifests are only written when no-data is authoritative.

| Stage | Observed condition | Class | Action |
|---|---|---|---|
| Timeseries filter | `targetedTimeseriesIds.length === 0` | metadata-mismatch | **Skip** (`no_matching_requested_timeseries_ids`), no empty manifest |
| Location projection | `candidateLocationIds.length === 0` after timeseries filter | metadata-mismatch | **Skip** (`no_matching_location_ids_after_timeseries_filter`), no empty manifest |
| OpenAQ fetch loop | At least one location fetch returns transport/auth/rate-limit/server error (timeout, 401/403, 429, 5xx, malformed response) | source-unavailable/error | **Fail/Pending** (existing error path), no empty manifest |
| OpenAQ fetch loop | All candidate locations resolved without fetch errors, but every location is `not found`/missing for that day (`locationFilesFound===0`) | authoritative-no-data | **Write empty observation manifest** (+ day manifest rebuild) |
| Parse/map stage | Files found, zero mapped rows, and parser reports only expected exclusions (outside-day / unmapped parameters) with no fetch/parsing errors | authoritative-no-data | **Write empty observation manifest** (+ day manifest rebuild) |
| Parse/map stage | Files found, but parse failure / schema break / corruption | source-unavailable/error | **Fail** (do not write empty manifest) |

Suggested implementation detail:

- Track per-location fetch outcome counts: `found`, `missing`, `error`.
- Permit empty-manifest write only when `error===0` and `found===0` (or `found>0` with deterministic zero mapped rows and no parser errors).
- Persist classifier decision in ledger checkpoint JSON (`no_data_classification: authoritative_no_data|source_unavailable|metadata_mismatch`) for auditability.


## 4. Recommendation

**Recommend Option A** (narrow OpenAQ-path change), with an explicit decision gate that only writes empty manifests for **authoritative no-data** and still errors/skips for **source unavailable/transport failure** conditions.

Why:

- It matches your stated source-of-truth rule: if AWS OpenAQ archive files are authoritative and absent for a day/location after successful enumeration, we should commit explicit empty coverage rather than leave manifests missing.
- It keeps the fix tightly scoped to the failing OpenAQ branch (including timeseries-scoped integrity runs), minimizing cross-adapter side effects.
- It preserves operational safety by requiring a strict classifier between:
  - **authoritative no data** (write empty manifest), and
  - **source unavailable/error** (do not write empty; retain failure/pending behavior).

Relevant call sites for implementation are the OpenAQ no-source branch and the generic pre-export no-row guard, with classification logic anchored at fetch result handling so transport/auth/timeouts cannot be misclassified as no-data. (workers/uk_aq_backfill_local/run_job.ts:10467-10639,11049-11101).

## 5. Open questions for the user

1. Should empty manifests be written only for OpenAQ (`connector_id=6`) initially, or for all adapters when flag-enabled?
2. Should `no_matching_requested_timeseries_ids` remain a skip (metadata mismatch), while only source-level no-data (`locationFilesFound===0`) becomes empty-manifest write?
3. Do you want a manifest-level annotation for diagnostic provenance (e.g., `no_data_reason` / `source_gap_detected`) or keep manifest schema unchanged and put reason only in ledger/logs?
4. In `observations_only` mode, should AQI day/connector manifests be left untouched (current behavior), or should we ever emit explicit empty AQI manifests in a separate pass?
5. Should integrity orchestrator suppress repeated retries for days already known to be valid-empty once empty manifests exist, to reduce redundant backfill invocations?
