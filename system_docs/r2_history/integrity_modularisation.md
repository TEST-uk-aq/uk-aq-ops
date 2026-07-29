# Integrity modularisation contract

## Authority and scope

This document is the authoritative structural contract for modularising:

```text
scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py
workers/uk_aq_backfill_local/run_job.ts
```

It supplements:

- [`integrity.md`](integrity.md) for functional Integrity behaviour;
- [`current_state_reconciliation.md`](current_state_reconciliation.md) for downstream current-state stages;
- [`../latest_snapshot/integrity_reconciliation.md`](../latest_snapshot/integrity_reconciliation.md) for the Latest Snapshot owner-service boundary.

Where this document conflicts with an implementation plan or code comment, this document is authoritative for module ownership, dependency direction and stage boundaries. It does not override functional contracts.

## Purpose

The Python and TypeScript orchestration files historically contained detection, policy classification, source evidence, repair planning, execution, reporting and external-target logic in the same modules.

The modularisation must reduce regression risk by ensuring that:

- one module owns each policy decision;
- later stages consume typed decisions rather than repeating string and gap-type condition sets;
- external side effects occur only through explicit stage boundaries;
- completed stages and target outcomes are recorded independently;
- a new run can safely re-evaluate a failed scope without rewriting already-correct R2 or current state;
- the public entrypoints and operational contracts remain stable.

This is not a cosmetic file split. Moving duplicated policy into several smaller modules without centralising ownership does not satisfy this contract.

## Stable public entrypoints

These entrypoints remain stable:

```text
scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py
scripts/uk-aq-history-integrity/bin/uk_aq_integrity_backfill.sh
workers/uk_aq_backfill_local/run_job.ts
```

The local dispatcher and repository runner continue invoking the same Python entrypoint.

Existing supported CLI arguments, environment variables, exit status meanings, structured log event names, report fields, R2 keys, manifest schemas, Parquet schemas and SQLite meanings remain unchanged except for separately approved additions.

Old-run resume arguments are not part of the supported public CLI.

## Architectural principles

### One owner for each decision

A policy decision must be made once and represented in a typed or explicitly validated result.

Downstream modules may validate whether the decision can execute, but must not independently reconstruct the decision from gap strings, suggestion text or partial evidence.

### Facts, decisions and effects are separate

The required flow is:

```text
source and R2 facts
→ detected findings
→ authoritative repair decisions
→ explicit repair plan
→ executable scope validation
→ side effects
→ final verification
→ independent current-state targets
```

Detectors emit facts. Decision modules classify. Planning serialises decisions. Executors apply approved plans. Final verification proves durable outcomes.

### Dependency direction

Domain modules must not import the public orchestration entrypoint.

Preferred dependency direction is:

```text
entrypoint
→ coordinator
→ domain services
→ pure models and helpers
```

Lower-level modules must not import higher-level coordinators.

### No import-time work

Importing a module must not:

- open SQLite;
- read or write R2;
- download sources;
- run `gcloud`;
- mutate environment variables;
- start threads or subprocesses;
- acquire locks;
- write reports.

Runtime work begins only through explicit function calls.

### Explicit runtime context

Shared mutable state, paths, environment-derived settings, logging, limits and database connections are passed through narrow runtime context objects or explicit parameters.

A broad dependency-injection framework is not required. Context objects must remain small enough to preserve visible ownership.

### Fail closed

Extraction must preserve all current fail-closed rules. An unresolved import, missing evidence field, ambiguous decision or invalid target result blocks execution rather than broadening scope.

## Python target ownership

The exact filenames may adjust where the implementation reveals a clearer boundary, but ownership must be recognisable.

Recommended structure:

```text
scripts/uk-aq-history-integrity/bin/
├── uk-aq-history-integrity.py
├── uk-aq-history-integrity_impl.py
└── integrity/
    ├── __init__.py
    ├── cli.py
    ├── config.py
    ├── runtime.py
    ├── database.py
    ├── core_snapshot.py
    ├── models.py
    ├── source_checks/
    │   ├── openaq.py
    │   ├── sensorcommunity.py
    │   └── sos.py
    ├── detection/
    │   ├── observations.py
    │   └── aqilevels.py
    ├── repair/
    │   ├── decisions.py
    │   ├── planning.py
    │   ├── scope.py
    │   ├── source_evidence.py
    │   ├── metadata.py
    │   ├── execution.py
    │   ├── canonical_apply.py
    │   └── final_verification.py
    ├── current_state/
    │   ├── auth.py
    │   ├── candidates.py
    │   ├── timeseries.py
    │   ├── latest_snapshot.py
    │   ├── audit.py
    │   └── coordinator.py
    ├── reporting.py
    ├── daily_profile.py
    └── task_health.py
```

Do not create empty modules solely to match this diagram. Each extracted module must own a coherent responsibility and remove real implementation from the orchestration file.

No module owns replay or resumption of an earlier Integrity run.

## Authoritative observation repair decision

One pure decision function owns observation-gap classification.

Its result must be equivalent to a typed record containing at least:

```text
repair_kind
data_changes_required
scope_grain
day_utc
connector_id
pollutant_code
requires_index_rebuild
source_evidence_requirement
operator_pollutant_scope_required
aqi_policy
executable_policy
reason
```

The exact class and field names may differ, but the semantics must be explicit.

The decision owner classifies at least:

- data repair;
- pollutant-manifest-only repair;
- connector-manifest repair;
- day-manifest repair;
- index repair;
- source-mapping issue;
- unsupported or ambiguous scope.

The same decision feeds:

- rendered `suggested_repair` report data;
- repair-plan construction;
- executable-scope validation;
- AQI dependency planning;
- audit evidence.

Later stages must not maintain independent copies of data-gap, metadata-gap or executable-gap sets except where a narrow domain invariant is explicitly documented.

## Missing-scope semantics

The decision contract preserves:

```text
day_dir_missing
  -> connector/day wildcard data repair, restricted to explicit --repair-pollutants

connector_dir_missing
  -> connector/day wildcard data repair, restricted to explicit --repair-pollutants

pollutant_dir_missing with a supported pollutant
  -> exact pollutant data repair

pollutant_dir_missing without a concrete supported pollutant
  -> fail closed
```

Every destructive observation repair requires an explicit operator pollutant selection. Exact and wildcard repairs must not execute when `--repair-pollutants` is absent.

AQI work remains limited to PM2.5, PM10 and NO2. O3 remains observation-only for AQI purposes.

## Python repair coordinator stages

The repair coordinator exposes and persists these distinct stages:

```text
source_acquisition
observation_detection
repair_decision
observations_proposal
observations_metadata_proposal
aqi_proposal
latest_snapshot_auth_preflight
canonical_apply
first_value_at_reconciliation
final_verification
timeseries_reconciliation
latest_snapshot_reconciliation
reporting
```

Existing public stage names used in reports remain compatible. Additional internal stage names must not make existing reports misleading.

The coordinator owns ordering only. Domain logic remains in the owning module.

## Authentication module ownership

`current_state/auth.py`, or an equivalently narrow module, owns:

- URL and audience validation;
- explicit account and service-account impersonation command construction;
- identity-token subprocess execution;
- bounded error handling;
- real-run capability preflight;
- fresh token acquisition for final invocation.

No other module constructs an alternative `gcloud auth print-identity-token` command.

The preflight occurs before canonical R2 mutation when the selected scope can affect Latest Snapshot. The final request always acquires a fresh token after final verification.

## Independent current-state targets

Timeseries and Latest Snapshot are separate target modules with separate audit results.

The current-state coordinator:

1. receives only final verified scopes;
2. derives deterministic candidates;
3. invokes the timeseries target;
4. invokes the Latest Snapshot target;
5. persists each result independently;
6. calculates overall status without erasing successful earlier stages.

A target module must not invoke source acquisition, R2 repair or another target.

Existing candidate-set and target-attempt SQLite tables may remain for historical compatibility or normal-run audit. They must not provide an old-run replay interface.

## Failure recovery ownership

A failed Integrity run remains an immutable audit record.

Recovery is owned by the normal coordinator through a new appropriately scoped run. The new run must:

- reacquire current authoritative source evidence;
- use current mappings and configuration;
- derive a new explicit repair plan;
- skip already-correct canonical R2 objects;
- apply normal final verification;
- reconcile current-state targets through monotonic and idempotent rules;
- record outcomes under a new Integrity run identifier.

The system must not reconstruct and replay candidates from an earlier run. There is no supported `--resume-current-state-run-id` or `--resume-current-state-target` interface.

## TypeScript backfill target ownership

Recommended structure:

```text
workers/uk_aq_backfill_local/
├── run_job.ts
├── config/
│   ├── env.ts
│   └── run_scope.ts
├── source_adapters/
│   ├── breathelondon.ts
│   ├── openaq.ts
│   ├── sensorcommunity.ts
│   └── sos.ts
├── integrity/
│   ├── complete_connector_day.ts
│   ├── source_evidence.ts
│   └── proposal_stage.ts
├── observations/
│   ├── export.ts
│   ├── parquet.ts
│   └── manifests.ts
├── aqilevels/
│   ├── rebuild.ts
│   ├── export.ts
│   └── manifests.ts
└── r2/
    ├── object_access.ts
    └── history_paths.ts
```

`run_job.ts` remains responsible for configuration, orchestration order, summary collection and top-level failure handling.

Source adapters own discovery, acquisition, parsing, source-specific checkpoint data and source events. They do not perform canonical apply independently.

Observation and AQI modules preserve existing calculation functions, schemas, object keys, manifest fields, sorting, deduplication, part splitting and diagnostics.

## Compatibility wrapper

The current Python wrapper executes the implementation into a shared public namespace used by focused tests and operator tooling.

Modularisation may retain a compatibility export layer so established imports and monkeypatch targets continue to resolve during migration.

The wrapper must not hide duplicate live implementations. Each compatibility name delegates to one authoritative implementation.

## Branch and implementation model

Authorised modularisation phases may be implemented in one local feature branch and one Codex session.

The work must still be divided into coherent commits, for example:

1. structural inventory and package viability;
2. central repair decision and explicit pollutant gate;
3. authentication preflight and independent target audit;
4. Python domain extraction;
5. TypeScript domain extraction;
6. orchestration slimming and documentation ownership map.

No deployment pause is required between commits. One draft pull request may contain the complete series when every commit is reviewable and the final diff remains structurally coherent.

Codex must not merge the pull request.

## Structural validation

Before deployment, validation is limited to structural viability and targeted deterministic checks genuinely needed to protect approved functional changes.

Required structural checks include:

- Python compilation for touched modules;
- direct Python entrypoint import and `--help`;
- existing TypeScript type or check command;
- `bash -n` for touched shell files;
- import-cycle and stale-reference searches;
- confirmation that imports have no side effects;
- comparison of CLI names, environment variables, log event names, stage names, schemas, object keys and manifest fields;
- `git diff --check`;
- confirmation that no generated artefacts are committed.

Targeted deterministic checks are limited to:

- connector-day repair decision consistency;
- exact and wildcard explicit pollutant gates;
- authentication command construction and preflight ordering;
- independent target audit persistence;
- monotonic timeseries and Latest Snapshot behaviour;
- failure reporting that preserves the original error;
- absence of old-run resume CLI and runtime symbols when that removal is implemented.

Do not add a broad speculative pre-deployment functional suite.

## Functional validation

Functional validation occurs after deployment through real CIC-Test operations.

Required coverage includes:

- normal check-only operation;
- one real SOS repair with explicit pollutants;
- one AQI rebuild;
- final R2 verification;
- authentication preflight before canonical mutation;
- timeseries and Latest Snapshot reconciliation;
- one later new scoped run that safely skips or no-ops already-correct state;
- one older-range no-rollback operation where genuinely needed;
- normal scheduled processing after reconciliation;
- report and task-health comparison with the pre-refactor baseline.

A failed earlier run is not resumed as part of validation.

## Completion criteria

The modularisation is complete when:

- the Python and TypeScript entrypoints are primarily orchestration;
- one authoritative repair decision feeds reporting, planning and execution;
- authentication command construction has one owner;
- current-state targets are separate and independently audited;
- a failed scope can be processed by a new run without rewriting already-correct R2 or current state;
- module imports have no side effects;
- existing public runtime contracts remain stable;
- real CIC-Test operations show no unexplained behavioural drift;
- system documentation identifies final module ownership.

## Out of scope

This contract does not authorise:

- changing AQI algorithms or thresholds;
- changing source mapping policy;
- changing R2 layouts, schemas or retention;
- changing Dropbox backup ownership;
- changing Integrity date selection;
- replacing SQLite;
- introducing a broad dependency-injection framework;
- creating a second Latest Snapshot writer;
- adding a speculative pre-deployment functional test suite;
- replaying or resuming an earlier Integrity run.
