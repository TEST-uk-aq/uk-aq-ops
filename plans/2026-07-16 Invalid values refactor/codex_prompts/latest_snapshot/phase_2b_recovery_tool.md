# VS Code Codex prompt: Latest Snapshot Phase 2B

Recommended model: **GPT-5.6 Codex, High reasoning**

```text
Implement Phase 2B of:
plans/2026-07-16 Invalid values refactor/uk_aq_latest_snapshot_invalid_values_refactor_plan.md

Use Level 1 or Level 2 from AGENTS.md only. Do not query external services during implementation, write R2, deploy or commit.

Read:
- AGENTS.md
- every file under system_docs/latest_snapshot/
- the phase plan above
- the completed Phase 1 implementation
- the approved Phase 2A recovery-source report

If Phase 2A did not identify a clear safe existing raw-history source, stop with options. Do not invent a source, use a derived latest-value source, or add cross-repository schema changes without user approval.

Implement a new report-first latest-state repair tool using the approved source architecture.

Preferred path:
- scripts/backup_r2/uk_aq_repair_latest_snapshot_invalid_state.mjs

Requirements:
- default report-only;
- explicit --write-r2 required for any state write;
- targeted --connector-id and --timeseries-id mode;
- explicit --all-invalid-state mode for broad audit or repair;
- --report-out support;
- read current latest state and current core metadata;
- use the exact central policy created in Phase 1;
- preserve already-valid state entries exactly;
- identify invalid state entries and select the newest eligible valid raw observation for each affected identity;
- preserve source observed_at and value, plus other state fields where available;
- use a documented deterministic ingested_at fallback when unavailable;
- remove an invalid entry only when no valid replacement exists and report that explicitly;
- write the existing state schema and state key;
- use the normal deterministic state serialisation helper;
- do not edit individual snapshot objects;
- do not alter either existing bootstrap seed script's behaviour unless separately approved.

Known target case:
connector_id=1
timeseries_id=360
expected replacement if no newer valid row exists:
observed_at=2026-07-16T08:00:00Z
value=21.793
The later -99 at 09:00 remains in raw history.

Keep pre-deployment checks minimal because this is the TEST system. Add only one compact pure recovery check covering:
- selection of the preceding valid Manchester-style row;
- valid entries remain unchanged;
- target mode cannot change unrelated identities;
- invalid-only history produces no invalid replacement;
- report-only mode cannot call the write path;
- runtime and repair use the same policy.

Do not create a broad recovery test suite. Functional source access will be tested after implementation using the real TEST report-only command.

Archive any existing file you modify under:
archive/2026-07-16_latest_snapshot_invalid_values_refactor/<original-relative-path>
Do not archive new files.

Do not change:
- public snapshot or API contract;
- normal builder scheduling or resources;
- raw observation history;
- latest-snapshot R2 API Worker;
- cache proxy;
- website;
- connector or AQI logic.

Run only syntax/type validation and the one compact pure recovery check.

Report:
1. files archived;
2. files added or changed;
3. approved source used;
4. minimal checks and results;
5. exact report-only command for connector 1 and timeseries 360;
6. exact explicit write command, but do not run it;
7. exact all-invalid-state report command, but do not run it;
8. rollback procedure;
9. source coverage limits;
10. immediate post-deployment TEST checks.
```
