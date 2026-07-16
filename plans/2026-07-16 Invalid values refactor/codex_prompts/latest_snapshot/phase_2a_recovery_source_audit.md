# VS Code Codex prompt: Latest Snapshot Phase 2A

Recommended model: **GPT-5.6 Codex, High reasoning**

```text
Perform Phase 2A of:
plans/2026-07-16 Invalid values refactor/uk_aq_latest_snapshot_invalid_values_refactor_plan.md

This is read-only analysis. Do not edit files, create archives, commit, deploy, query external services, write R2 or create migrations.

Read:
- AGENTS.md
- every file under system_docs/latest_snapshot/
- the phase plan above
- the completed Phase 1 implementation and focused tests

Determine the safest authoritative raw observation source for repairing invalid entries in latest_snapshots_state/v1/latest_state.json.

Do not use existing latest snapshot objects or uk_aq_latest_rpc as the sole source. They may already omit the preceding valid observation.

Assess active access paths for:
- recent ingest database observations;
- Obs AQI observs history;
- committed R2 observation history;
- existing internal service-role or RPC access;
- reusable active R2 history readers.

The recommended source or fallback chain must support:
1. identifying invalid current state entries with the Phase 1 policy;
2. descending raw-history lookup for one connector_id/timeseries_id;
3. selecting the newest valid row under the same policy;
4. preserving observed_at and value, plus status, value_float8_hex and ingested_at where available;
5. recovering connector 1, timeseries 360 to 21.793 at 2026-07-16T08:00:00Z despite the later -99;
6. handling older affected identities without silently dropping them because one source has short retention;
7. bounded queries and pagination;
8. deterministic ingested_at handling when the source does not expose it.

Do not recommend a broad full-state rebuild from an incomplete source.

Return:
- recommended source architecture;
- exact existing files, modules or RPCs involved;
- available fields;
- existing environment inputs required;
- query bounds and pagination;
- source coverage and fallback behaviour;
- deterministic ingested_at rule;
- failure and partial-coverage handling;
- whether a schema-repo addition is genuinely required;
- exact proposed Phase 2B file list.

If no clear safe existing source exists, stop with ranked options. Do not implement.
```
