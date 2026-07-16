# VS Code Codex prompt: Latest Snapshot Phase 0

Recommended model: **GPT-5.6 Codex, High reasoning**

```text
You are working in TEST-uk-aq/uk-aq-ops.

This is a read-only structural analysis phase. Do not edit files, create archives, commit, deploy or call external services.

Read these first:
- AGENTS.md
- system_docs/README.md
- system_docs/documentation_contract.md
- every file under system_docs/latest_snapshot/
- plans/2026-07-16 Invalid values refactor/uk_aq_latest_snapshot_invalid_values_refactor_plan.md

Inspect the current Latest Snapshot implementation, especially:
- workers/uk_aq_latest_snapshot_cloud_run/run_job.ts
- workers/uk_aq_latest_snapshot_cloud_run/run_service.ts
- workers/uk_aq_latest_snapshot_cloud_run/service_core.ts
- current latest-snapshot tests
- .github/workflows/uk_aq_latest_snapshot_cloud_run_deploy.yml
- scripts/backup_r2/uk_aq_seed_latest_snapshot_state_from_existing_r2.mjs
- scripts/backup_r2/uk_aq_seed_latest_snapshot_state_from_supabase.mjs

The behaviour is fixed by system_docs/latest_snapshot/contract.md.

Confirm the narrowest structurally viable implementation for Phase 1.

Required behaviour:
- raw invalid observations continue through raw storage;
- invalid current pollutant values do not create or replace state;
- valid means finite and >= 0, with PM2.5 max 500 and PM10 max 600 preserved;
- zero remains valid;
- decoded invalid rows remain acknowledgeable after successful handling;
- state schema and public v2 contract do not change;
- all protected functionality in the plan remains unchanged.

Assess this preferred ordering:
1. load existing state;
2. load metadata;
3. pull Pub/Sub messages;
4. classify and apply rows;
5. persist changed state;
6. acknowledge handled decoded messages;
7. build snapshot rows using the same metadata and policy.

Identify:
1. exact files Phase 1 should change;
2. exact files that must not change;
3. recommended central eligibility-module location;
4. recommended pure state-core location;
5. how tests can import pure logic without executing worker main;
6. focused deterministic checks required by system_docs/latest_snapshot/validation.md;
7. workflow test-command changes, if any;
8. existing tests protecting v2, network, timeout and overlap behaviour;
9. any conflict between current code and authoritative docs.

Do not propose broad refactors, public fields, environment variables, schema changes or recovery implementation.

Return a concise structural report and exact proposed Phase 1 file list. Stop after the report.
```
