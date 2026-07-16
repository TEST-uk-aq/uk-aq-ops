# UK AQ latest snapshot invalid-values refactor plan

Date: 2026-07-16
Status: Ready for phased implementation on TEST
Repository: `TEST-uk-aq/uk-aq-ops`
System area: Latest Snapshot

## Purpose

Fix the defect where a newer invalid pollutant observation, such as `-99`, replaces the previous valid row in `latest_snapshots_state/v1/latest_state.json` before later output filtering removes it.

For the known Manchester Piccadilly PM2.5 sequence:

```text
08:00  value=21.793  valid
09:00  value=-99    invalid
```

latest state must remain:

```text
observed_at=2026-07-16T08:00:00Z
value=21.793
```

The `09:00` row remains raw history and is still handled and acknowledged by the dedicated latest-snapshot subscription.

This plan covers only Latest Snapshot. The wider work remains in:

- `2026-07-16 Invalid values refactor - main areas.md`

## Authoritative documents

Read before each implementation phase:

1. `AGENTS.md`
2. `system_docs/README.md`
3. `system_docs/documentation_contract.md`
4. every file under `system_docs/latest_snapshot/`
5. this plan

`system_docs/latest_snapshot/contract.md` is the behavioural authority. `system_docs_legacy/`, archives and older plans are historical context only.

## Locked design

### Current-value eligibility

For the existing matrix, a row may become latest state only when:

1. it is structurally valid;
2. metadata resolves it to PM2.5, PM10 or NO2;
3. the value is finite;
4. the value is `>= 0`;
5. existing upper bounds are satisfied.

| Pollutant | Minimum | Maximum |
|---|---:|---:|
| PM2.5 | 0 | 500 |
| PM10 | 0 | 600 |
| NO2 | 0 | No additional maximum currently configured |

Zero is valid. Negative values, including `-99`, are invalid current values.

### Raw-data separation

This work must not change raw observation publishing or storage. Invalid rows remain in raw `observations`, `observs` and R2 history.

### State rules

State identity remains `(connector_id, timeseries_id)`.

A newer invalid row must not:

- create state;
- replace valid state;
- update the retained timestamp;
- update retained `ingested_at`;
- refresh apparent age;
- change state bytes when it is the only incoming row.

The state key, schema and entry shape remain unchanged. Existing same-time valid-row tie-breaking remains unchanged.

### Message handling

A decoded invalid row is successfully handled when classification completes. It must be skipped for state, counted internally, and remain eligible for normal acknowledgement.

If metadata or state persistence fails, acknowledgement must not move ahead of the failure.

### One policy

State application and `buildSourceRows()` must use the same latest-snapshot value policy. Output filtering remains as defence in depth.

## Functionality that must not change

The implementation must preserve everything protected by `system_docs/latest_snapshot/contract.md`, including:

### Public v2 contract

- `latest_snapshots/v2` and its manifest path;
- all 15 pollutant/window combinations;
- query parameter names and meanings;
- cache-proxy route;
- top-level and row fields;
- scalar network fields;
- connector provenance fields;
- omitted v1/membership fields;
- v2 response header;
- fail-closed v2 behaviour.

### Metadata and visibility

- core metadata source and cache key;
- metadata refresh cadence;
- `station.network_id -> networks.id`;
- missing-metadata behaviour;
- network public-display filtering;
- geography eligibility;
- display-name formatting;
- no connector-derived network fallback.

### Snapshot generation

- window definitions;
- sorting and cursor derivation;
- deterministic JSON;
- hash-gated writes;
- manifest shape and partial-failure preservation;
- maximum state size.

### Runtime and deployment

- scheduler cadence and retries;
- CPU, memory, concurrency and instance limits;
- child timeout behaviour;
- Pub/Sub batch and acknowledgement limits;
- subscription architecture;
- R2 configuration;
- API Worker and cache proxy.

The only permitted ordering change is loading metadata before Pub/Sub pull/application when required for safe classification. If used, a metadata failure should occur before messages are pulled.

## Out of scope

Do not change in this plan:

- connector ingestion;
- `timeseries.last_value` or `last_value_at`;
- connector checkpoints or polling;
- AQI or WHO calculations;
- public chart/history behaviour;
- website code;
- database schema or RPCs without a separate approved cross-repository decision.

## Current implementation discrepancy

Current order is effectively:

1. load state;
2. pull rows;
3. apply by timestamp only;
4. persist state;
5. acknowledge rows;
6. load metadata;
7. filter while building public rows.

The defect is step 3. Metadata and value eligibility are applied too late.

The existing seed scripts are not authoritative poisoned-state recovery tools:

- the existing-R2 script rebuilds from already-derived snapshot objects;
- the Supabase script rebuilds from a latest-value RPC which may omit a preceding valid raw row.

## Phase summary

| Phase | Goal | Output |
|---|---|---|
| 0 | Structural review | Exact safe implementation shape |
| 1 | Prevent recurrence | Central policy, safe state application, focused checks |
| 2A | Choose repair source | Read-only raw-history source decision |
| 2B | Repair existing state | Report-first targeted/full repair tool |
| 3 | TEST operation | Deploy prevention, repair state, regenerate snapshots |
| 4 | Validation | Website restored and protected behaviour confirmed |

Prompts are stored in:

```text
plans/2026-07-16 Invalid values refactor/codex_prompts/latest_snapshot/
```

## Phase 0: structural review

Confirm before editing:

- metadata can be available before state replacement;
- one area-specific policy can be shared by Deno runtime and Node recovery tooling;
- pure state logic can be tested without executing the worker main function;
- `buildSourceRows()` can call the same policy;
- the deployment workflow can run the focused check without configuration changes;
- existing v2, timeout and overlap checks remain intact.

No code changes in this phase.

Prompt:

- `codex_prompts/latest_snapshot/phase_0_structural_review.md`

## Phase 1: prevent invalid state

Preferred narrow structure, subject to Phase 0 confirmation:

```text
workers/uk_aq_latest_snapshot_cloud_run/
  run_job.ts
  latest_value_policy.mjs
  latest_state_core.mjs
  latest_state_core_test.ts
```

An area-local `.mjs` policy is preferred so both Deno and Node can import it.

Required implementation:

- load metadata before rows can be applied;
- resolve each row to a supported matrix pollutant;
- classify eligibility before timestamp comparison;
- preserve existing ordering for eligible rows;
- keep invalid decoded rows acknowledgeable;
- add internal invalid-skip telemetry;
- keep output filtering using the same policy;
- do not change state schema or public output.

A targeted deterministic check is genuinely required. Cover:

1. valid row creates state;
2. negative row creates no state;
3. newer valid replaces older valid;
4. newer negative does not replace valid;
5. older valid does not replace newer valid;
6. zero is valid;
7. PM2.5 over 500 is rejected;
8. PM10 over 600 is rejected;
9. negative NO2 is rejected;
10. invalid between two valid rows does not block the later valid row;
11. invalid-only batch does not alter state bytes or retained `ingested_at`;
12. serialisation order and schema remain unchanged;
13. invalid decoded rows remain handled for acknowledgement.

Run only focused local checks and existing fast Latest Snapshot checks. No external operations.

Before modifying existing files, archive them under:

```text
archive/2026-07-16_latest_snapshot_invalid_values_refactor/<original-relative-path>
```

Prompt:

- `codex_prompts/latest_snapshot/phase_1_runtime_prevention.md`

## Phase 2A: recovery-source audit

This is read-only.

The recovery should:

1. read current state and metadata;
2. identify invalid state entries using the Phase 1 policy;
3. fetch descending raw history for affected identities;
4. select the newest valid row;
5. preserve already-valid entries;
6. replace only affected entries;
7. remove an invalid entry only when no valid history exists and report that explicitly.

Inspect active access to:

- recent ingest observations;
- Obs AQI `observs` history;
- committed R2 observation history;
- existing internal service-role or RPC paths;
- reusable active R2 history readers.

The source must be raw history, not existing latest snapshots or a latest-value RPC alone.

If no clear existing source is safe, stop with options. Do not invent or add a schema change.

Prompt:

- `codex_prompts/latest_snapshot/phase_2a_recovery_source_audit.md`

## Phase 2B: report-first repair tool

Preferred new script:

```text
scripts/backup_r2/uk_aq_repair_latest_snapshot_invalid_state.mjs
```

Required modes:

- report-only by default;
- targeted connector/timeseries mode;
- explicit all-invalid-state audit mode;
- explicit write mode;
- report-file output.

The tool must:

- read current state and core metadata;
- use the Phase 1 policy;
- preserve valid entries;
- replace invalid entries from approved raw history;
- preserve source timestamp and value;
- use a documented deterministic `ingested_at` fallback if needed;
- use normal deterministic state serialisation;
- leave snapshot regeneration to the normal builder;
- never edit individual snapshot objects;
- not silently change either existing bootstrap seed script.

Focused checks cover selection, merge, target isolation, report-only write protection and policy parity.

Prompt:

- `codex_prompts/latest_snapshot/phase_2b_recovery_tool.md`

## Phase 3: TEST deployment and repair

This phase is operational and should be run manually unless explicit operational permission is granted.

### Before deployment

Preserve or record:

- current Cloud Run revision;
- latest state object;
- v2 manifest;
- representative PM2.5 snapshot objects;
- current hashes;
- current Pub/Sub backlog;
- representative public response fields.

### Deploy prevention

Use the existing Latest Snapshot Cloud Run deployment workflow. Do not alter variables or resources.

Confirm scheduled runs complete and backlog remains healthy.

### Targeted repair

Run report-only repair for connector `1`, timeseries `360`.

Expected replacement, unless a newer valid row exists:

```text
observed_at=2026-07-16T08:00:00Z
value=21.793
```

Review source coverage, target isolation and before/after hashes before explicit write mode.

After the targeted write, allow the normal builder to regenerate snapshots. Do not hand-edit R2 snapshot JSON.

### Full audit

Run report-only all-invalid-state mode. Review it separately before any broad write.

### Rollback

If needed:

1. restore the preserved previous state object;
2. restore the previous Cloud Run revision if required;
3. run the normal builder;
4. retain reports and hashes;
5. do not alter raw history.

## Phase 4: TEST validation

Confirm:

- scheduled runs complete;
- invalid rows do not redeliver endlessly;
- invalid-skip telemetry appears;
- state entry count remains plausible;
- invalid-only batches avoid unnecessary state writes;
- all 15 matrix entries remain represented;
- response fields and v2 header remain unchanged;
- network, visibility, sorting, cursor and cache behaviour remain unchanged.

For connector `1`, timeseries `360`:

- raw history retains `-99` at 09:00;
- state contains the newest valid observation;
- `window=all` includes it;
- finite windows use the valid timestamp;
- the public response never emits `-99`;
- website search finds Manchester Piccadilly when otherwise eligible;
- the hex map displays it when otherwise eligible.

## Documentation completion

After real TEST validation:

- update `system_docs/latest_snapshot/operations.md` if final ordering needs clarification;
- update `recovery.md` with the approved source and exact tool usage;
- update `validation.md` with useful TEST evidence;
- update the worker README to link to the authoritative docs if needed;
- change `contract.md` only if the approved behaviour itself changed;
- do not put current material back into `system_docs_legacy/`.

## Acceptance criteria

This phase is complete only when:

1. raw invalid observations remain stored;
2. new invalid pollutant values cannot create or replace state;
3. zero remains valid;
4. existing PM upper bounds remain unchanged;
5. invalid decoded messages are acknowledged after successful handling;
6. known poisoned state is repaired;
7. the full invalid-state audit is reviewed;
8. website search and hex-map behaviour are restored;
9. public v2, metadata, matrix, cache and scheduling behaviour are unchanged;
10. authoritative system docs match the deployed implementation.

## Later phases

This plan does not complete the wider invalid-values refactor. Connector current values, checkpoints, polling, AQI/WHO, chart history and freshness reporting remain separate approved phases.
