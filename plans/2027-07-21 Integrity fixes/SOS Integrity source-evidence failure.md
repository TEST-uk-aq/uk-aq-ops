Investigate and fix the repeated SOS Integrity source-evidence failure locally in the `TEST-uk-aq-ops` repository.

Use GPT-5.6 Codex with High reasoning.

## Failure being investigated

A CIC-Test SOS Integrity dry-run covered 16 to 19 July 2026. It correctly found the missing v2 observation and AQI connector-days for 17, 18 and 19 July.

The initial SOS flat-file scan completed successfully:

* source: SOS / UK-AIR annual CSV files
* connector ID: `1`
* selected repair pollutants: `pm25`, `pm10`, `no2`
* 188 cached annual files checked
* 11,828 selected mapped rows found
* 12 known unmapped PM10 groups for `HG4`, `HULR` and `STOR`
* those unmapped groups were reported as warnings

The subsequent immutable detector source-evidence worker failed independently for all three missing days.

The wrapper output confirms that the previous pollutant argument propagation change is present:

```text
repair_pollutants: no2,pm10,pm25
complete_connector_day: true
```

Each local backfill then fails immediately after:

```text
source_lookup_resolved
```

The outer Integrity log truncates the important stderr and reports only:

```text
...[truncated]...
ef_pollutant=0
source_to_r2 encountered 1 connector-day errors
```

The Integrity summary consequently records:

```text
immutable_detector_source_evidence_failed:RuntimeError
```

No observation rows were staged, no object operations were planned and no R2 write was attempted.

## Run artefacts

Inspect these complete files first:

```text
/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/uk-aq-backfill-local-logs/source_to_r2_2026-07-21_22-17-26_1_2026-07-17_to_2026-07-17.log

/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/uk-aq-backfill-local-logs/source_to_r2_2026-07-21_22-17-34_1_2026-07-18_to_2026-07-18.log

/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/uk-aq-backfill-local-logs/source_to_r2_2026-07-21_22-17-37_1_2026-07-19_to_2026-07-19.log

/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/uk-aq-history-integrity/logs/run-2026-07-21T221710Z.log

/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/CIC-Test/uk-aq-history-integrity/reports/2026-07-21T221710Z-summary.json

/Users/mikehinford/Dropbox/Projects/UK-AQ Website & Network/TEST UK-AQ GH Repos/TEST-uk-aq-ops/logs/run-state.json
```

The first local backfill log should contain the complete error that was truncated from the Integrity log. Compare all three local logs to establish whether the exact failure is identical.

## Relevant implementation

Start with:

```text
workers/uk_aq_backfill_local/run_job.ts
scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py
scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill.sh
scripts/uk_aq_backfill_local.sh
```

Trace any imported SOS mapping, source-integrity, blocked-row, UK-AIR CSV and complete connector-day helpers used by `run_job.ts`.

Also examine the recent changes that introduced or propagated:

```text
repair_pollutants
UK_AQ_BACKFILL_REPAIR_POLLUTANTS
UK_AQ_BACKFILL_INTEGRITY_COMPLETE_CONNECTOR_DAY
UK_AQ_BACKFILL_INTEGRITY_SOURCE_EVIDENCE_ONLY
```

Read the relevant `system_docs` before changing behaviour.

## Phase 1: Confirm the exact fault

Do not modify code until you have identified the first specific failure event in the complete 17 July local backfill log.

Report:

1. The exact event name, error message and guard or code path that fails.
2. Whether the 18 and 19 July runs fail for the identical reason.
3. The values being compared by the failed guard.
4. Whether the failure is caused by:

   * the selected pollutant scope;
   * complete connector-day enumeration;
   * SOS source-to-timeseries mapping;
   * the known unmapped HG4, HULR and STOR rows;
   * a stale or incompatible reference count;
   * an environment-variable mismatch;
   * or another cause.
5. Why the initial Python SOS scan can count 11,828 mapped rows while the TypeScript source-evidence worker fails before producing canonical evidence.
6. The commit or recent change that introduced the mismatch, where this can be established from local Git history.

The targeted examination of the full local log is required because the parent Integrity log truncates the actual error.

## Required functional contract

Preserve these rules:

1. The repair scope is explicitly limited to `pm25`, `pm10` and `no2`.
2. Complete connector-day mode means complete authoritative source coverage for the selected repair pollutants. It must not silently expand to unrelated SOS pollutants.
3. The known unmapped PM10 source groups `HG4`, `HULR` and `STOR` may remain clearly recorded blocked or warning groups where that is the established contract. They must not cause all otherwise valid mapped rows for the connector-day to be discarded.
4. Do not make all mapping faults non-fatal.
5. Ambiguous mappings, duplicate canonical identities, invalid canonical rows and other genuinely unsafe conditions must remain fail-closed.
6. Immutable detector source evidence must retain the required source-file identities, hashes, selected pollutant scope, mapped-row counts and blocked-row evidence.
7. Source-evidence-only and proposal preparation must not mutate live R2.
8. Canonical R2 mutation must remain behind the existing validation and apply stages.
9. Preserve R2 paths, Parquet schemas, manifests, CLI arguments, environment-variable names and structured event names.
10. Do not alter AQI calculations or unrelated source adapters.

## Phase 2: Apply the narrowest clear fix

Once the fault has been confirmed, implement the smallest correct fix.

Follow the data and control flow rather than merely suppressing the failing guard.

In particular, verify that the selected pollutant set is used consistently by:

* the Python Integrity planner;
* the shell wrapper;
* the TypeScript environment parser;
* SOS source binding selection;
* source reference-count calculations;
* canonical source-row generation;
* complete connector-day validation;
* immutable evidence creation;
* proposal validation.

Check for a comparison where one side is pollutant-scoped and the other still represents every SOS binding or every observed property.

Do not weaken a valid fail-closed guard simply to make the run pass. Correct the inconsistent scope or calculation at its source.

## Phase 3: Improve failure reporting

The parent Integrity result currently loses the actual TypeScript failure and reduces it to:

```text
immutable_detector_source_evidence_failed:RuntimeError
```

Where practical within the same narrow change:

* retain the first `source_connector_day_error` or equivalent structured failure reason;
* propagate that reason through the wrapper result;
* include it in the Integrity repair result and summary;
* avoid relying only on a truncated stderr tail;
* do not rename existing structured events.

This should make a future source-evidence failure diagnosable from the normal Integrity report.

## Validation

Perform existing structural checks relevant to the files changed:

```text
deno check workers/uk_aq_backfill_local/run_job.ts
bash -n scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill.sh
bash -n scripts/uk_aq_backfill_local.sh
python3 -m py_compile scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py
git diff --check
```

Only run checks that apply to touched files.

After the fix, perform one targeted real CIC-Test operational check for 17 July 2026 using the same Integrity dry-run/proposal flow. This targeted check is necessary to prove that the exact failed source-evidence path now works.

Confirm that:

* the source-evidence worker completes;
* the selected pollutant scope is exactly `pm25`, `pm10`, `no2`;
* mapped source rows are produced;
* HG4, HULR and STOR remain visible as appropriately classified unmapped PM10 groups;
* immutable source evidence is written to the local run state;
* proposal objects are staged and validated locally;
* no live R2 mutation occurs during the dry-run;
* no AQI rebuild is executed before observation evidence and proposal validation succeed.

Do not run the complete three-day repair or perform live canonical R2 writes. Mike will run the full operation after reviewing the fix.

## Final response

Provide:

1. The confirmed root cause, quoting the exact full log event.
2. Why the previous pollutant-scope change was insufficient.
3. Every file changed.
4. A concise explanation of the fix.
5. Structural-check results.
6. The result of the one-day CIC-Test dry-run.
7. Any remaining warnings or limitations.
8. The exact command Mike should use to retry the full 17 to 19 July Integrity operation.

Do not commit, push, create a branch or open a pull request unless explicitly asked.
Do not modify unrelated files.
