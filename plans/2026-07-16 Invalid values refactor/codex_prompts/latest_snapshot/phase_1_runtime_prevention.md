# VS Code Codex prompt: Latest Snapshot Phase 1

Recommended model: **GPT-5.6 Codex, High reasoning**

```text
Implement Phase 1 of:
plans/2026-07-16 Invalid values refactor/uk_aq_latest_snapshot_invalid_values_refactor_plan.md

Use Level 1 from AGENTS.md. Code and minimal focused local checks only. Do not commit, deploy, call external services, write R2, query Supabase or perform operational repair.

This is the TEST system. Do not delay deployment by building or running a broad pre-deployment test suite. Before deployment, use only:
- basic syntax/type validation for changed files;
- one compact deterministic state-policy regression test covering the load-bearing cases below.

Functional testing belongs after deployment through normal TEST operation using the real scheduler, Pub/Sub subscription, R2 state, public API and website.

Read before editing:
- AGENTS.md
- system_docs/README.md
- system_docs/documentation_contract.md
- every file under system_docs/latest_snapshot/
- the phase plan above
- the completed Phase 0 structural report, if present

Treat system_docs/latest_snapshot/contract.md as authoritative.

Required implementation:

1. Archive every existing file that will change under:
   archive/2026-07-16_latest_snapshot_invalid_values_refactor/<original-relative-path>
   Follow AGENTS.md exactly. Do not archive new files.

2. Extract one area-specific current-value policy usable by the Deno builder and a later Node recovery script. Prefer an area-local .mjs module unless Phase 0 identified a clearly better cross-runtime option.

3. Implement exactly the current matrix policy:
   - PM2.5: finite, >= 0, <= 500
   - PM10: finite, >= 0, <= 600
   - NO2: finite, >= 0, with no new upper maximum
   - zero is valid
   - negative values, including -99, are invalid current values

4. Refactor state application so metadata and value eligibility are resolved before any invalid row can create or replace state.

5. Prefer loading metadata before pulling Pub/Sub messages. Preserve the same metadata source, cache key, required tables, refresh cadence and network behaviour.

6. Preserve eligible-row ordering exactly:
   - observed_at remains primary;
   - ingested_at remains the current same-time tie-breaker.

7. A decoded invalid row must:
   - leave state unchanged;
   - be counted as skipped invalid current value;
   - remain successfully handled for acknowledgement after state handling;
   - not alter state bytes, top-level updated_at or retained ingested_at when it is the only incoming row.

8. Make buildSourceRows() use the same central policy as defence in depth. Do not remove output filtering.

9. Add one compact table-driven or similarly narrow deterministic regression test. It should cover, without creating a broad suite:
   - valid row creates state;
   - newer -99 does not replace the Manchester-style previous valid row;
   - invalid row between two valid rows does not block the later valid row;
   - zero is valid;
   - PM2.5 above 500 and PM10 above 600 are rejected;
   - negative NO2 is rejected;
   - an invalid-only batch leaves state bytes and retained ingested_at unchanged;
   - invalid decoded rows remain handled for acknowledgement.

10. Update the deployment workflow only if needed to run that one focused test. Do not alter resource, scheduler, timeout, retry, Pub/Sub, R2 or environment configuration.

Functionality that must not change is defined in the plan and system_docs/latest_snapshot/contract.md. In particular, do not change:
- public v2 row or API contract;
- R2 prefixes and keys;
- matrix pollutants or windows;
- network, geography or display-name logic;
- sorting or cursor derivation;
- deterministic serialisation or hash gating;
- Pub/Sub pull and acknowledgement limits;
- overlap, timeout or child-process behaviour;
- cache proxy or API Worker code;
- raw observation publishing or storage.

Do not implement recovery tooling in this phase.

Run only the minimal checks described above. Do not run unrelated repository test suites.

Report:
1. files archived;
2. files changed and why;
3. the minimal checks run and results;
4. exact deployment workflow to run immediately on TEST;
5. confirmation that protected behaviour remains unchanged;
6. post-deployment checks to perform through real TEST operation;
7. remaining Phase 2 follow-up.
```
