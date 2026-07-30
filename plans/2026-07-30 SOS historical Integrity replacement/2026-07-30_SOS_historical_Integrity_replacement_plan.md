# SOS historical Integrity replacement plan

Date: 30 July 2026  
Target: CIC-Test  
Repository: `TEST-uk-aq/uk-aq-ops`  
Status: ready for implementation

## Codex execution

Use the latest available Codex model with **High reasoning**.

Implement all phases in one Codex task, one branch and one pull request. The phases below are implementation boundaries, not separate prompts or approval gates. Do not repeat repository analysis between phases.

Keep the change as small as possible. Reuse the current source acquisition, canonical row, Parquet, manifest, index, lock, audit, Timeseries reconciliation and Latest Snapshot reconciliation modules. Do not create a second R2 writer or duplicate existing canonical logic.

## Objective

Create a dedicated, simplified write-enabled SOS historical observation-repair path inside the existing Integrity execution method.

The operator must continue calling the existing local dispatcher:

```text
<local Integrity root>/bin/uk-aq-history-integrity.sh
```

That dispatcher must continue selecting the environment and repository checkout, then invoke the repository-owned Python and supporting scripts. No new locally installed command is required.

A qualifying real SOS run must rebuild explicitly selected connector 1 observation pollutant partitions from complete authoritative SOS source evidence, publish them safely to R2, verify each changed object once, then retain the existing Timeseries and Latest Snapshot reconciliation stages.

The immediate purpose is to make historical SOS observations reliable enough to proceed with WHO guideline calculations without AQI or generic multi-source Integrity complexity blocking the work.

## Authoritative contracts

Read and follow these before changing code:

1. `system_docs/r2_history/sos_historical_repair_contract.md`
2. `system_docs/r2_history/README.md`
3. `system_docs/r2_history/integrity.md`
4. `system_docs/r2_history/integrity_apply_safety_contract.md`
5. `system_docs/r2_history/current_state_reconciliation.md`
6. `system_docs/latest_snapshot/integrity_reconciliation.md`
7. `system_docs/r2_history/history_writer_coordination.md`
8. `system_docs/r2_history/implementation_safety_contract.md`

For the dedicated write-enabled SOS path, `sos_historical_repair_contract.md` overrides conflicting broader wording only where it explicitly says so.

## Scope

The dedicated path applies only when all of these are true:

- `--source sos`;
- `--run-backfill`;
- history version `v2`;
- explicit `--from-day` and `--to-day` or equivalent explicit day scope;
- explicit `--repair-pollutants` subset;
- mutation connector is SOS connector `1` only.

Supported pollutants remain:

```text
pm25
pm10
no2
o3
```

The destructive repair unit is exactly:

```text
day_utc + connector_id=1 + pollutant_code
```

## Non-goals

Do not include any of the following:

- Prune Daily changes;
- shared-writer extraction or broad writer refactoring;
- support for non-SOS connectors in the dedicated path;
- AQI hourly generation;
- AQI debug generation;
- AQI manifest, index or latest-metadata work;
- changes to the local operator command method;
- removal of the existing generic Integrity path;
- resume or replay of a prior failed Integrity run;
- new R2 transaction, rollback or receipt systems;
- a broad speculative pre-deployment test suite;
- LIVE deployment or LIVE data changes.

## Existing behaviour to retain

Retain unchanged unless the dedicated SOS contract explicitly overrides it:

- current SOS annual-file discovery, cache use and hour-ending timestamp handling;
- source-label registry and supported status normalisation;
- canonical observation row format;
- shared observation-content hashing;
- verification-status counts;
- exact selected-prefix tombstones;
- canonical Parquet and manifest schemas;
- connector-day, day-finalisation and global-index locks;
- child-before-parent publication;
- immutable run audit records;
- the existing private monotonic Timeseries reconciliation RPC;
- the existing authenticated Latest Snapshot owner-service route;
- independent `r2_history_status`, Timeseries, Latest Snapshot and overall statuses;
- generic check-only, dry-run and non-SOS Integrity behaviour.

## Known failure this plan must remove

A current SOS repair can fail because existing R2 NO2 partitions contain legacy R2-only timeseries IDs that are not represented in the current SOS continuity bridge.

For a complete selected-partition replacement, those legacy R2-only identities are diagnostic evidence only. They must not block replacement when current SOS source enumeration is complete and every included replacement row has valid canonical identity.

The dedicated path must distinguish:

```text
fresh SOS source group with no authoritative active binding
-> exclude rows, aggregate warning, continue valid work

legacy R2-only identity inside the complete selected partition being replaced
-> report if useful, do not require continuity mapping, do not block

ambiguous, contradictory or invalid fresh SOS mapping
-> fail closed before mutation
```

If source rows exist but every row in a selected partition is excluded because no authoritative binding exists, leave the existing R2 partition unchanged and report the partition as skipped. Do not treat it as authoritative no-data.

# Implementation phases

## Phase 1: route qualifying runs to the dedicated SOS path

Inspect the active local-dispatcher-to-repository call chain and identify the smallest internal routing point.

Implement a dedicated repository-owned SOS historical replacement route selected automatically by the existing supported arguments.

Requirements:

1. Do not change how the operator invokes the local dispatcher.
2. Keep the local dispatcher responsible only for environment and checkout selection.
3. Keep current public CLI arguments and meanings.
4. Route only qualifying real SOS write-enabled v2 runs to the dedicated path.
5. Reject any attempted write scope outside SOS connector 1.
6. Leave check-only, dry-run, generic and non-SOS paths unchanged.
7. Record in the run summary that the dedicated SOS historical replacement path was selected.

Do not add a second broad orchestrator by copying the current implementation. Prefer a small explicit mode selector and a narrow orchestration module that calls existing owners.

## Phase 2: build complete SOS replacement proposals

For each selected day and pollutant:

1. Acquire and identity-pin all required SOS annual files.
2. Prove required source-date coverage and enumeration completed.
3. Apply the existing timestamp, source-label, unit and verification-status rules.
4. Classify every selected source group.
5. Exclude established `no_authoritative_timeseries_binding` groups consistently and record one aggregated warning with bounded examples and row counts.
6. Fail closed for incomplete source acquisition, parse failure, uncertain empty source, ambiguous mapping, contradictory mapping, invalid canonical rows or unreproducible evidence.
7. Persist immutable source rows, counts, per-timeseries counts, status counts and observation-content hashes.
8. Build a complete replacement Parquet and pollutant manifest from the included canonical rows.
9. Create exactly one exact selected-pollutant-prefix tombstone.
10. Do not merge individual old R2 rows into the selected replacement.
11. Do not require continuity mapping for legacy R2-only IDs that will be removed by complete replacement.
12. Leave an all-unmapped non-empty selected partition unchanged.

Build affected connector, day and observation-index metadata locally from:

```text
chosen Dropbox baseline
+ validated current-run selected replacements
- exact current-run selected-prefix tombstones
```

The qualifying Dropbox backup may be reused across supported repairs and same-scope reruns. Do not require a new backup merely because a previous SOS repair completed or the same day is being run again.

Do not access live R2 during source acquisition, detection, proposal construction or final local proposal validation.

Before mutation, require:

```text
immutable SOS source evidence
=
final staged canonical Parquet semantic content
=
final staged pollutant manifest content
```

Retain all existing exact-tombstone, ownership, dependency, schema, hash, status-count and parent-child structural checks that remain relevant.

## Phase 3: remove AQI from the dedicated path

The dedicated SOS path repairs observation history only.

Ensure it does not invoke, generate, validate or publish:

- AQI hourly data;
- AQI debug data;
- AQI manifests;
- AQI indexes;
- AQI latest or discovery metadata.

Existing AQI objects remain untouched. Do not delete or migrate them.

AQI absence or failure must not affect SOS observation-repair completion.

Do not alter normal Prune Daily AQI behaviour or the generic Integrity AQI behaviour in this task.

## Phase 4: implement one ordered live R2 apply-and-verification phase

After all local proposal work succeeds, enter one bounded live phase using the existing locks and mutation modules.

### Selected observation children

For each affected connector-day:

1. Delete exact selected pollutant prefixes using the existing bounded deletion mechanism.
2. PUT all selected replacement Parquet objects.
3. GET each changed Parquet object once.
4. Verify byte length and SHA-256.
5. Parse the returned live body through the shared canonical observation helper.
6. Require exact semantic equality with immutable current-run SOS source evidence.

Do not GET the same unchanged changed-key body again within the same successful operation. Reuse the already verified body for any remaining direct checks, with the existing bounded current-operation cache or a smaller equivalent.

### Selected pollutant manifests

Only after a pollutant's selected Parquet objects pass live verification:

1. PUT the selected pollutant manifest.
2. GET that changed manifest once.
3. Verify its content-defining fields and dependencies against immutable source evidence and the already verified live Parquet result.

### Parents and observation indexes

Only after all changed pollutant manifests for the connector-day pass:

1. publish the affected connector manifest;
2. publish affected connector-scoped and pollutant-scoped observation indexes;
3. publish the affected day manifest under the day-finalisation lock;
4. publish affected global and latest observation metadata last under the global-index lock.

GET each changed parent or index once after PUT and verify it against final child identities established in the same live phase.

Do not GET unchanged Dropbox-preserved objects solely because they were carried into a rebuilt parent or index.

Do not run a second broad final R2 scan after the ordered single-read verification results have established the complete changed object graph.

Failure of a child verification must prevent publication of its dependent manifest, parent, index, day or global metadata.

## Phase 5: retain Timeseries and Latest Snapshot reconciliation

After the selected observation scope has completed the ordered live R2 phase successfully:

1. derive candidates from final verified canonical observations;
2. run the existing Timeseries reconciliation through the private monotonic RPC;
3. run the existing Latest Snapshot reconciliation through the authenticated private owner-service route for `pm25`, `pm10` and `no2`;
4. retain O3 outside Latest Snapshot while preserving existing Timeseries freshness behaviour;
5. record target outcomes independently.

Do not write Latest Snapshot R2 objects directly.

Older candidates must remain no-ops. Identical same-timestamp content must remain a no-op. Existing same-timestamp correction behaviour remains unchanged.

A Timeseries or Latest Snapshot failure must not roll back or misclassify verified R2 history. Preserve the existing separate component and overall status reporting.

## Phase 6: audit, documentation and handover

Update active implementation documentation only where necessary to describe actual code ownership and operations. Do not rewrite the new authoritative contract unless implementation reveals a genuine contradiction that must be resolved before functional use.

Ensure the run audit records at least:

- dedicated SOS path selected;
- requested dates and pollutants;
- connector 1 mutation scope;
- chosen Dropbox baseline and stale-backup override state;
- source-file identities and enumeration result;
- included, warning-excluded and invalid row counts;
- aggregated missing-binding warnings;
- legacy R2-only diagnostics where available;
- immutable source counts, status counts and hashes;
- local staged semantic equality;
- exact tombstones;
- each changed PUT and its single GET verification result;
- highest publication level reached;
- Timeseries outcome;
- Latest Snapshot outcome;
- separate component and overall statuses.

Create a concise implementation report in this plan directory containing:

- files changed;
- modules reused;
- dedicated route selection point;
- old generic stages bypassed by this mode;
- how GET-once verification is enforced;
- structural checks run;
- exact CIC-Test commands for functional acceptance;
- any operator configuration or deployment steps.

# Structural validation before deployment

Perform only the smallest checks needed to prove structural viability.

Required checks:

1. Python, JavaScript and TypeScript syntax or compilation checks for touched active files.
2. Public Integrity entrypoint import and `--help` still work.
3. The existing local dispatcher still resolves the repository-owned command without a new local executable.
4. A qualifying SOS write-enabled argument set selects the dedicated path.
5. A non-SOS or non-connector-1 write scope is rejected.
6. Check-only and dry-run do not enter the mutating dedicated route.
7. Complete replacement produces one exact tombstone and one complete selected replacement graph.
8. Missing authoritative bindings are excluded consistently without blocking other valid rows.
9. An all-unmapped non-empty partition is left unchanged.
10. Legacy R2-only identities do not block a complete selected replacement.
11. AQI modules are not invoked by the dedicated route.
12. No live R2 access occurs before the final apply phase.
13. Dependency ordering prevents a parent or index from publishing before its changed child succeeds.
14. A changed key is not GET more than once in a successful operation.
15. No second broad final R2 scan is invoked.
16. Timeseries and Latest Snapshot reconciliation remain connected only after verified R2 observation success.
17. `git diff --check` passes.

A narrow deterministic check for route selection, exact tombstone scope, AQI bypass and GET-once bookkeeping is genuinely required because those are the implementation boundaries introduced by this plan. Do not add a broad speculative test suite.

# Functional acceptance in CIC-Test

Functional validation occurs only after implementation is deployed or available on the real CIC-Test Integrity machine.

## Acceptance run 1: known problem scope

Run the normal local dispatcher for:

```text
source: sos
connector: 1
day: 2026-06-01
pollutants: no2
mode: real run-backfill
```

Use the current supported command arguments and `--allow-stale-dropbox` where required by the established operator workflow.

Acceptance evidence:

- dedicated SOS path selected;
- complete source enumeration succeeds;
- valid source rows produce a complete replacement;
- legacy R2-only IDs are diagnostic and do not block;
- no AQI or AQI debug stage runs;
- each changed object is GET-verified once in dependency order;
- no second broad final R2 scan runs;
- R2 history succeeds;
- Timeseries and Latest Snapshot retain their monotonic/idempotent outcomes.

## Acceptance run 2: same-scope rerun

Run the same 1 June 2026 NO2 scope again without waiting for another Dropbox backup.

Acceptance evidence:

- the complete replacement remains correct;
- unchanged authoritative SOS content produces the same logical canonical observations, counts, status counts and observation-content hash;
- the run does not require continuity mapping for old selected-partition identities;
- no incorrect data or duplicate logical rows are introduced.

## Acceptance run 3: intended June range

After the one-day run and rerun succeed, run:

```text
source: sos
connector: 1
from-day: 2026-06-01
to-day: 2026-06-16
pollutants: the explicit required SOS subset
mode: real run-backfill
```

Acceptance evidence:

- all selected days use complete selected-partition replacement;
- warning-only missing bindings are reported without blocking valid work;
- AQI remains outside the run;
- changed objects use ordered single-GET verification;
- Timeseries and Latest Snapshot run only after verified observation success;
- reports clearly separate R2, Timeseries, Latest Snapshot and overall outcomes.

Take a fresh Dropbox backup after meaningful repair work as the normal recovery copy. It is not a prerequisite between the supported same-scope acceptance runs.

# Completion criteria

This plan is complete when:

1. The existing local command method automatically selects the dedicated SOS path for qualifying real runs.
2. Connector 1 selected pollutant partitions are completely rebuilt from authoritative SOS evidence.
3. Legacy R2-only identities no longer block complete replacement.
4. Missing authoritative bindings remain warning-only and excluded, with all-unmapped partitions left unchanged.
5. AQI and AQI debug do not run in this mode.
6. Every changed R2 object is GET-verified once in dependency order.
7. No duplicate broad final R2 scan runs.
8. Timeseries and Latest Snapshot reconciliation remain operational after verified R2 success.
9. The one-day CIC-Test run, same-scope rerun and 1-16 June range complete according to the acceptance criteria.
10. Prune Daily and LIVE remain unchanged by this work.
