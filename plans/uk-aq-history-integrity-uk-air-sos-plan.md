# UK-AQ History Integrity — `uk_air_sos` Implementation Plan

## Naming rules for this phase

Use these source keys exactly:

```text
sensorcommunity
uk_air_sos
```

Do **not** add or reintroduce:

```text
sensor-community
uk-air-sos
```

The `uk_air_sos` implementation should follow the same integrity model as the other sources, but it is an API snapshot source rather than an archive-file source.

---

## Decisions to confirm before coding

### Decision 1 — Canonical snapshot format

Recommendation: use canonical **NDJSON** for `uk_air_sos` station/day snapshots.

Reason:

- Easy to stream/write.
- Easy to diff and inspect.
- Stable hash input.
- Avoids retaining volatile raw API metadata.

Canonical row shape should be minimal and stable:

```json
{"station_ref":"...","timeseries_id":123,"timeseries_ref":"...","observed_at_utc":"2026-05-10T00:00:00Z","value":12.3}
```

Rows should be sorted by:

```text
timeseries_id, observed_at_utc
```

### Decision 2 — Cache retention policy

Recommendation for first implementation:

```text
CIC-Test/dev: keep all uk_air_sos canonical snapshots
LIVE routine: keep changed/reappeared snapshots only
```

Add a config setting:

```bash
UK_AQ_HISTORY_INTEGRITY_KEEP_API_SNAPSHOTS=changed
```

Allowed values:

```text
none
changed
all
```

Default:

```text
changed
```

### Decision 3 — Source unit and repair unit

Use the hybrid model:

```text
Source check unit: station_ref + day_utc
Evidence/count unit: timeseries_id + day_utc
Observation repair unit: affected timeseries_ids + day_utc
AQI rebuild unit: connector_id + day_utc
```

This gives station/day-level source baselining, while preserving narrow timeseries repair.

### Decision 4 — Temporary SOS errors

Recommendation:

```text
404/no source data: record missing/no_data, do not backfill automatically
502/503/504/timeouts: record temporary_error, do not update baseline, do not backfill
successful fetch with zero rows: record successful empty snapshot/counts
```

Do not treat failed API calls as changed source data.

---

# Phase 7.1 — `uk_air_sos` source key, CLI, and lookup plumbing

## Goal

Add `uk_air_sos` as a supported history-integrity source without doing API fetching yet.

The implementation should keep the codebase consistent with the current source-key naming:

```text
openaq
sensorcommunity
uk_air_sos
```

No hyphenated source keys should be introduced.

## Requirements

- Add `uk_air_sos` to allowed `--source` choices.
- Ensure `--source all` includes `uk_air_sos` only when explicitly intended.
- Do not accept or emit `uk-air-sos`.
- Do not reintroduce `sensor-community`; use `sensorcommunity` only.
- Update any source-key mapping so connector code `uk_air_sos` maps to source key `uk_air_sos`.
- Rebuild/import core lookup so active `uk_air_sos` station/timeseries mappings are available in `source_station_timeseries_lookup`.
- Validate that `source_station_timeseries_lookup` can provide:

```text
source_key = uk_air_sos
station_ref
source_location_id or equivalent station ref
connector_id
station_id
timeseries_id
is_active
```

- Add report/log output showing how many active `uk_air_sos` stations and timeseries are available.
- No source API fetching in this phase.
- No backfills in this phase.

## Codex prompt

```text
Repo: /workspaces/uk-aq-ops

Please implement Phase 7.1 of the UK-AQ History Integrity `uk_air_sos` source support.

Important naming requirements:
- Use `uk_air_sos` exactly.
- Do not use or introduce `uk-air-sos` anywhere.
- Use `sensorcommunity` exactly.
- Do not reintroduce `sensor-community` anywhere.

Context:
The history-integrity system currently supports source adapters such as `openaq` and `sensorcommunity`. We now need to add `uk_air_sos` as an API-based source, but this first phase is only CLI/source-key/lookup plumbing. No API fetching yet.

Tasks:
1. Locate the active history-integrity implementation under scripts/uk-aq-history-integrity/.
2. Add `uk_air_sos` to the allowed `--source` choices.
3. Ensure `--source all` includes `uk_air_sos` only if the current code structure expects all active sources to run.
4. Update source-key mapping so connector code `uk_air_sos` maps to source key `uk_air_sos`.
5. Ensure no hyphenated `uk-air-sos` references are added.
6. Ensure no hyphenated `sensor-community` references are added or reintroduced.
7. Update core lookup import/rebuild logic so active `uk_air_sos` stations/timeseries are represented in `source_station_timeseries_lookup`.
8. The lookup should support source_key=`uk_air_sos`, station_ref/source_location_id, connector_id, station_id, timeseries_id, and is_active where available.
9. Add a check-only or dry-run report/log line showing the count of active `uk_air_sos` stations and active `uk_air_sos` timeseries found in the lookup.
10. Do not add SOS API fetching in this phase.
11. Do not trigger backfills in this phase.
12. Add/update tests if available for source argument validation and lookup mapping.

Acceptance criteria:
- `--source uk_air_sos --check-only` is accepted.
- `--source uk-air-sos` is not accepted unless existing CLI parsing already aliases unsupported values; prefer rejecting it.
- No `sensor-community` string exists in active integrity code.
- No `uk-air-sos` string exists in active integrity code.
- A dry/check-only run can show active SOS lookup counts without fetching source data.
```

---

# Phase 7.2 — `uk_air_sos` canonical snapshot command/function

## Goal

Create a stable way to fetch SOS source observations for a station/day and emit canonical rows for integrity hashing/counting.

This can be implemented either:

```text
A. inside history-integrity Python
B. as a small command/script that history-integrity calls
C. by refactoring/reusing existing SOS backfill/ingest fetch helpers
```

Recommendation: prefer reuse of existing SOS fetch/parsing logic if practical, but keep the integrity output contract simple: canonical NDJSON rows.

## Requirements

For a given:

```text
station_ref
day_utc
active timeseries for the station
```

fetch SOS observations and emit canonical rows containing:

```text
station_ref
timeseries_id
timeseries_ref
observed_at_utc
value
```

Rules:

- Normalise timestamps to UTC ISO strings ending in `Z`.
- Keep only rows in `[day_start_utc, day_end_utc)`.
- Normalise numeric values consistently.
- Drop volatile request metadata.
- Sort rows by `timeseries_id`, then `observed_at_utc`.
- Output stable NDJSON bytes.
- Return structured status:

```text
ok
no_data
not_found
temporary_error
permanent_error
```

- Do not write R2.
- Do not write Supabase.
- Do not run backfill.

## Codex prompt

```text
Repo: /workspaces/uk-aq-ops

Please implement Phase 7.2 of the UK-AQ History Integrity `uk_air_sos` support: canonical SOS source snapshots.

Important naming requirements:
- Use `uk_air_sos` exactly.
- Do not use or introduce `uk-air-sos` anywhere.
- Use `sensorcommunity` exactly.
- Do not reintroduce `sensor-community` anywhere.

Goal:
Create a stable source snapshot mechanism for `uk_air_sos` so history-integrity can hash and count SOS API data. This phase should not write R2, should not write Supabase, and should not run backfills.

First inspect existing SOS source/backfill/ingest code in the repo, especially workers/uk_aq_backfill_local/run_job.ts and any SOS helper functions. Reuse existing SOS fetch/parsing logic where practical so integrity matches production/backfill behaviour.

Required behaviour:
For a given station_ref, day_utc, and active station timeseries list, fetch SOS observations and produce canonical NDJSON rows with this stable shape:

{"station_ref":"...","timeseries_id":123,"timeseries_ref":"...","observed_at_utc":"2026-05-10T00:00:00Z","value":12.3}

Canonicalisation rules:
- Timestamps must be UTC ISO strings ending in Z.
- Keep only rows with observed_at_utc in [day_start_utc, day_end_utc).
- Normalise numeric values consistently.
- Drop volatile request/API metadata.
- Sort rows by timeseries_id, then observed_at_utc.
- Encode as stable NDJSON bytes, one JSON object per line.

Status handling:
Return or expose structured statuses:
- ok: fetch succeeded and rows may be non-empty
- no_data: fetch succeeded but no rows for that day/station
- not_found: source indicates the station/timeseries/day does not exist
- temporary_error: timeout, 502, 503, 504, network/transient failure
- permanent_error: non-retryable malformed response or unsupported source state

Important safety:
- Temporary errors must not update the source baseline.
- Failed source checks must not create backfill candidates.
- Successful zero-row checks should be represented as successful empty snapshots/counts.

Implementation choice:
It is OK to implement this as a Python helper inside history-integrity, or as a small script/command under scripts/uk-aq-history-integrity/bin/ that the Python script can call. Prefer the simplest approach that reuses existing SOS fetch semantics and is testable.

Tests:
Add unit/helper tests if available for:
- sorting stability
- day-window filtering
- canonical hash stability
- zero-row successful snapshot
- temporary error does not produce baseline bytes

Acceptance criteria:
- Given synthetic SOS rows out of order, canonical output is deterministic and sorted.
- Given rows outside the day window, they are excluded.
- Given an empty successful response, output is a valid empty snapshot with zero counts.
- No R2/Supabase writes occur in this phase.
```

---

# Phase 7.3 — `uk_air_sos` adapter state, cache, and counts

## Goal

Add the actual history-integrity adapter that checks SOS station/day source units, creates canonical snapshots, records source state/events, and stores per-timeseries counts.

## Source unit

Use:

```text
source_file_key = uk_air_sos:station_ref=<station_ref>:day_utc=<YYYY-MM-DD>
```

Although this table is named `source_file_state`, for SOS it represents an API source history unit.

## Source cache path

Recommended path:

```text
<source-cache>/uk_air_sos/station_ref=<station_ref>/day_utc=<YYYY-MM-DD>/snapshot.ndjson
```

## Cache retention

Add:

```bash
UK_AQ_HISTORY_INTEGRITY_KEEP_API_SNAPSHOTS=changed
```

Allowed:

```text
none
changed
all
```

Behaviour:

```text
none     — never keep canonical SOS snapshot after hashing/counting
changed  — keep changed/reappeared snapshots only
all      — keep every successful SOS snapshot, useful for CIC-Test debugging
```

## Requirements

For each active `uk_air_sos` station/day in the selected window:

1. Fetch canonical snapshot.
2. Hash canonical bytes.
3. Compute per-timeseries row counts.
4. Compare against previous `source_file_state`.
5. Record outcome:

```text
first_seen
unchanged
changed
reappeared
missing_first_seen
missing_after_seen
temporary_error
```

6. Insert source events.
7. Delete and reinsert `source_file_timeseries_counts` for successful source checks.
8. Do not backfill directly for `first_seen`.
9. Do not backfill from `temporary_error`.
10. Let Phase 6.5/6.6 determine repair candidates from cross-check and real source changes.

## Codex prompt

```text
Repo: /workspaces/uk-aq-ops

Please implement Phase 7.3 of the UK-AQ History Integrity `uk_air_sos` adapter: source state, source-cache snapshots, and per-timeseries counts.

Important naming requirements:
- Use `uk_air_sos` exactly.
- Do not use or introduce `uk-air-sos` anywhere.
- Use `sensorcommunity` exactly.
- Do not reintroduce `sensor-community` anywhere.

Build on Phase 7.1 and 7.2.

Source model:
For SOS, use station/day as the source history unit:

source_file_key = uk_air_sos:station_ref=<station_ref>:day_utc=<YYYY-MM-DD>

Even though the table is named source_file_state, treat this as an API source history unit, not a real upstream file.

For each active uk_air_sos station/day in the selected date window:
1. Fetch or build the canonical SOS NDJSON snapshot.
2. Hash the exact canonical NDJSON bytes.
3. Compute per-timeseries row counts.
4. Compare with previous source_file_state.
5. Record source_file_state and source_file_events.
6. Delete + reinsert source_file_timeseries_counts in one transaction for successful source checks.

Canonical source-cache path:
<source-cache>/uk_air_sos/station_ref=<station_ref>/day_utc=<YYYY-MM-DD>/snapshot.ndjson

Add config:
UK_AQ_HISTORY_INTEGRITY_KEEP_API_SNAPSHOTS=changed

Allowed values:
- none
- changed
- all

Default:
- changed

Retention behaviour:
- none: do not keep successful canonical snapshots after hashing/counting.
- changed: keep snapshots only for changed/reappeared outcomes.
- all: keep every successful snapshot, useful for CIC-Test/debugging.

Outcome semantics:
- first_seen: baseline only, not a direct backfill trigger.
- unchanged: no source-driven action.
- changed: real source-change candidate.
- reappeared: source previously missing, now exists; candidate subject to existing repair rules.
- missing_first_seen: source missing on first check; no backfill.
- missing_after_seen: source previously existed, now missing; report warning, no automatic backfill.
- temporary_error: do not update baseline, do not backfill.

Important:
- Do not include first_seen in changed_files/source_change_candidates.
- First_seen should still populate state/events/counts and run cross-check later if enabled.
- Temporary errors must not overwrite a previous good baseline.
- Failed source checks must not create repair candidates.

Metrics/reporting:
Add/report separate counts for:
- uk_air_sos stations checked
- uk_air_sos snapshots first_seen
- uk_air_sos snapshots unchanged
- uk_air_sos snapshots changed
- uk_air_sos snapshots reappeared
- uk_air_sos snapshots missing
- uk_air_sos temporary errors
- uk_air_sos rows counted

Tests:
Add/update tests for:
- first_seen stores counts but does not directly schedule backfill
- changed stores counts and is a source-change candidate
- temporary_error does not update prior baseline
- KEEP_API_SNAPSHOTS=none/changed/all behaviour
- deterministic source_file_key and source-cache path

Acceptance criteria:
- `--source uk_air_sos --check-only` can baseline station/day snapshots.
- source_file_timeseries_counts is populated for successful snapshots.
- first_seen snapshots do not directly trigger backfill.
- reports distinguish first_seen from changed.
```

---

# Phase 7.4 — Cross-check, observation repair, and AQI queue integration

## Goal

Plug `uk_air_sos` into the existing Phase 6.5/6.6/6.8 flow.

`uk_air_sos` should use the same repair model:

```text
source counts vs R2 observation counts
→ source_to_r2 observations_only for affected timeseries/day
→ queue connector/day AQI rebuild
→ r2_history_obs_to_aqilevels aqilevels_only
```

## Requirements

- Include `uk_air_sos` counts in the cross-check pass.
- Compare `source_file_timeseries_counts` against R2 observation manifest `timeseries_row_counts` from local Dropbox R2 history backup.
- For statuses:

```text
mismatch
source_only
r2_manifest_missing
```

create observation repair candidates.

- Do not backfill just because a snapshot was `first_seen`.
- For real source `changed`/`reappeared` outcomes, create source-change repair candidates according to current design.
- Deduplicate final repair candidates by:

```text
connector_id
day_utc
timeseries_id
```

- Run observation repair via integrity wrapper using:

```bash
UK_AQ_BACKFILL_RUN_MODE=source_to_r2
UK_AQ_BACKFILL_OUTPUT_SCOPE=observations_only
UK_AQ_BACKFILL_FORCE_REPLACE=true
UK_AQ_BACKFILL_CONNECTOR_IDS=<connector_id>
UK_AQ_BACKFILL_TIMESERIES_IDS=<ids>
UK_AQ_BACKFILL_FROM_DAY_UTC=<day>
UK_AQ_BACKFILL_TO_DAY_UTC=<day>
```

- Queue one AQI rebuild per affected:

```text
connector_id + day_utc
```

- AQI rebuild should use:

```bash
UK_AQ_BACKFILL_RUN_MODE=r2_history_obs_to_aqilevels
UK_AQ_BACKFILL_OUTPUT_SCOPE=aqilevels_only
UK_AQ_BACKFILL_FORCE_REPLACE=true
UK_AQ_BACKFILL_CONNECTOR_IDS=<connector_id>
UK_AQ_BACKFILL_FROM_DAY_UTC=<day>
UK_AQ_BACKFILL_TO_DAY_UTC=<day>
```

## Codex prompt

```text
Repo: /workspaces/uk-aq-ops

Please implement Phase 7.4 of the UK-AQ History Integrity `uk_air_sos` support: cross-check, observation repair, and AQI rebuild queue integration.

Important naming requirements:
- Use `uk_air_sos` exactly.
- Do not use or introduce `uk-air-sos` anywhere.
- Use `sensorcommunity` exactly.
- Do not reintroduce `sensor-community` anywhere.

Build on the existing Phase 6.5/6.6/6.8 model and the new `uk_air_sos` source_file_timeseries_counts from Phase 7.3.

Requirements:
1. Include `uk_air_sos` successful source counts in the R2 observation cross-check pass.
2. Compare source_file_timeseries_counts to local Dropbox R2 observation manifest timeseries_row_counts.
3. For cross-check statuses mismatch, source_only, and r2_manifest_missing, create observation repair candidates.
4. Do not create repair candidates just because a `uk_air_sos` snapshot is first_seen.
5. Real source changed/reappeared outcomes may still create source-change repair candidates according to existing design.
6. Deduplicate final observation repair candidates by connector_id + day_utc + timeseries_id.
7. Batch observation repairs by connector/day where practical, passing affected timeseries IDs.
8. Observation repair must use the integrity backfill wrapper and observations-only output scope:
   UK_AQ_BACKFILL_RUN_MODE=source_to_r2
   UK_AQ_BACKFILL_OUTPUT_SCOPE=observations_only
   UK_AQ_BACKFILL_FORCE_REPLACE=true
   UK_AQ_BACKFILL_CONNECTOR_IDS=<connector_id>
   UK_AQ_BACKFILL_TIMESERIES_IDS=<comma-separated ids>
   UK_AQ_BACKFILL_FROM_DAY_UTC=<day>
   UK_AQ_BACKFILL_TO_DAY_UTC=<day>
9. After successful observation repair, queue one AQI rebuild per connector_id + day_utc.
10. AQI rebuild execution should use r2_history_obs_to_aqilevels with aqilevels-only output scope:
   UK_AQ_BACKFILL_RUN_MODE=r2_history_obs_to_aqilevels
   UK_AQ_BACKFILL_OUTPUT_SCOPE=aqilevels_only
   UK_AQ_BACKFILL_FORCE_REPLACE=true
   UK_AQ_BACKFILL_CONNECTOR_IDS=<connector_id>
   UK_AQ_BACKFILL_FROM_DAY_UTC=<day>
   UK_AQ_BACKFILL_TO_DAY_UTC=<day>
11. Keep observation repair status separate from AQI rebuild status.
12. A failed AQI rebuild must not hide a successful observation repair.

SOS-specific note:
Codex review has confirmed source_to_r2 supports uk_air_sos historical day windows. However, empty-day manifest behaviour may not have parity with OpenAQ/sensorcommunity. Do not try to solve that here unless required for the tests; log/report no-row SOS cases clearly.

Tests:
Add/update tests for:
- uk_air_sos first_seen + R2 ok => no backfill
- uk_air_sos first_seen + R2 mismatch => repair candidate from cross-check
- uk_air_sos changed => repair candidate
- duplicate candidates from source-change and cross-check dedupe to one connector/day/timeseries repair
- successful obs repair queues exactly one AQI rebuild per connector/day

Acceptance criteria:
- uk_air_sos integrates with existing cross_checks table/reporting.
- uk_air_sos repair uses observations_only.
- AQI rebuild queue dedupes connector/day.
- No first_seen-only backfills are triggered.
```

---

# Phase 7.5 — SOS error handling, 404 cooldowns, and reporting polish

## Goal

Make SOS integrity safe and quiet in the face of common API problems, missing series, and repeated upstream 404s.

## Requirements

- Clearly distinguish:

```text
successful empty source response
not_found / 404
transient upstream failure
malformed response
```

- Do not update source baseline on transient failures.
- Do not backfill on transient failures.
- Add optional cooldown/suppression for repeated known 404s.
- If using existing `error_logs` or SOS checkpoint/error patterns, keep the model consistent with ingest/backfill.
- Reports should show:

```text
uk_air_sos checked station-days
uk_air_sos successful snapshots
uk_air_sos no-data snapshots
uk_air_sos not_found count
uk_air_sos temporary_error count
uk_air_sos source changes
uk_air_sos cross-check discrepancies
uk_air_sos observation repairs
uk_air_sos AQI rebuilds queued/completed/failed
```

## Codex prompt

```text
Repo: /workspaces/uk-aq-ops

Please implement Phase 7.5 of the UK-AQ History Integrity `uk_air_sos` support: SOS error handling, optional 404 cooldowns, and reporting polish.

Important naming requirements:
- Use `uk_air_sos` exactly.
- Do not use or introduce `uk-air-sos` anywhere.
- Use `sensorcommunity` exactly.
- Do not reintroduce `sensor-community` anywhere.

Build on Phases 7.1-7.4.

Goals:
Make SOS integrity safe when the upstream SOS API returns no data, 404s, transient failures, or malformed responses.

Required behaviour:
1. Distinguish these source outcomes:
   - ok: successful snapshot with rows
   - no_data: successful snapshot with zero rows
   - not_found: upstream indicates station/timeseries/day not found, such as 404
   - temporary_error: timeout, 502, 503, 504, network/transient issue
   - permanent_error: malformed/non-retryable response
2. Successful no_data should be allowed to baseline a zero-row snapshot/count set.
3. temporary_error must not update a previous good baseline.
4. temporary_error must not create repair candidates.
5. not_found should be recorded clearly and should not create repair candidates by itself.
6. malformed/permanent errors should be reported and should not create repair candidates unless the existing system has a clear recovery path.

Optional but preferred:
Add a lightweight cooldown/suppression mechanism for repeated known 404s so the same station/day or timeseries/day is not repeatedly retried aggressively in the same run or adjacent runs.

If a suitable existing error_logs/checkpoint pattern exists in the SOS ingest/backfill code, reuse or mirror its semantics. Do not add complex suppression if it would make the first implementation risky.

Reporting:
Add/source-specific report counters:
- uk_air_sos station-days checked
- uk_air_sos successful snapshots
- uk_air_sos no_data snapshots
- uk_air_sos not_found count
- uk_air_sos temporary_error count
- uk_air_sos permanent_error count
- uk_air_sos source changes
- uk_air_sos cross-check discrepancies
- uk_air_sos observation repairs
- uk_air_sos AQI rebuilds queued/completed/failed

Tests:
Add/update tests for:
- no_data baselines zero counts
- temporary_error does not overwrite previous baseline
- not_found does not create backfill candidate
- repeated not_found can be suppressed/reported if cooldown is implemented
- report counters are populated

Acceptance criteria:
- SOS transient failures are visible but safe.
- No failed SOS source fetch creates a backfill candidate.
- Reports make SOS API health understandable.
```

---

# Phase 7.6 — Documentation and operational examples

## Goal

Update the history-integrity system documentation so `uk_air_sos` behaviour is clear.

## Requirements

Document:

- Source key naming rules:

```text
sensorcommunity
uk_air_sos
```

- SOS source unit:

```text
station_ref + day_utc
```

- SOS count/evidence unit:

```text
timeseries_id + day_utc
```

- SOS source-cache canonical snapshots.
- First-seen baseline behaviour.
- SOS error handling.
- Repair and AQI rebuild flow.
- Example commands:

```bash
/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh --env CIC-Test --profile manual --source uk_air_sos --from-day 2026-05-01 --to-day 2026-05-03 --check-only

/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh --env CIC-Test --profile manual --source uk_air_sos --from-day 2026-05-01 --to-day 2026-05-03 --dry-run --run-backfill
```

## Codex prompt

```text
Repo: /workspaces/uk-aq-ops

Please implement Phase 7.6 of the UK-AQ History Integrity `uk_air_sos` support: documentation and operational examples.

Important naming requirements:
- Use `uk_air_sos` exactly.
- Do not use or introduce `uk-air-sos` anywhere.
- Use `sensorcommunity` exactly.
- Do not reintroduce `sensor-community` anywhere.

Update the history-integrity plan/docs to describe the implemented `uk_air_sos` behaviour.

Document:
1. Source key naming rules:
   - sensorcommunity
   - uk_air_sos
2. SOS source model:
   - source check unit is station_ref + day_utc
   - evidence/count unit is timeseries_id + day_utc
   - observation repair unit is affected timeseries IDs for a day
   - AQI rebuild unit is connector_id + day_utc
3. Canonical SOS snapshot cache:
   <source-cache>/uk_air_sos/station_ref=<station_ref>/day_utc=<YYYY-MM-DD>/snapshot.ndjson
4. KEEP_API_SNAPSHOTS setting:
   UK_AQ_HISTORY_INTEGRITY_KEEP_API_SNAPSHOTS=none|changed|all
5. first_seen behaviour:
   - baseline only
   - no direct backfill
   - cross-check can still trigger repair if R2 is missing/mismatched
6. SOS error handling:
   - no_data
   - not_found
   - temporary_error
   - permanent_error
7. Repair flow:
   - source_to_r2 observations_only
   - queue AQI rebuild
   - r2_history_obs_to_aqilevels aqilevels_only
8. Example commands for check-only, dry-run, and narrow manual runs.

Also update any implementation status section to show which uk_air_sos phases are done.

Acceptance criteria:
- Docs contain no `uk-air-sos` string.
- Docs contain no `sensor-community` string.
- Example commands use `--source uk_air_sos`.
```

---

# Recommended implementation order

```text
1. Phase 7.1 — source key, CLI, lookup plumbing
2. Phase 7.2 — canonical snapshot function/command
3. Phase 7.3 — adapter state/cache/counts
4. Phase 7.4 — cross-check/backfill/AQI integration
5. Phase 7.5 — error handling and reporting polish
6. Phase 7.6 — docs and operational examples
```

## First real test sequence

After implementation, test in CIC-Test only.

### Check lookup only

```bash
/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh \
  --env CIC-Test \
  --profile manual \
  --source uk_air_sos \
  --from-day 2026-05-01 \
  --to-day 2026-05-01 \
  --check-only
```

### Dry run source/cross-check/backfill planning

```bash
/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh \
  --env CIC-Test \
  --profile manual \
  --source uk_air_sos \
  --from-day 2026-05-01 \
  --to-day 2026-05-01 \
  --dry-run \
  --run-backfill
```

### Narrow real run

Pick one known station/day first.

```bash
/Users/mikehinford/uk-aq-history-integrity/bin/uk-aq-history-integrity.sh \
  --env CIC-Test \
  --profile manual \
  --source uk_air_sos \
  --from-day 2026-05-01 \
  --to-day 2026-05-01 \
  --run-backfill \
  --max-backfill-calls-per-run 1
```

---

# Key safety rules

- `first_seen` is baseline only.
- Failed SOS source checks do not create backfill candidates.
- Temporary SOS errors do not overwrite previous good baselines.
- `source_to_r2` repairs observations only.
- `r2_history_obs_to_aqilevels` owns AQI rebuild.
- AQI rebuilds are deduped by `connector_id + day_utc`.
- Use `uk_air_sos` only.
- Use `sensorcommunity` only.
