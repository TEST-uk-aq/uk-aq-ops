# Historical JSON reader implementation plan

**Goal:** Reusable paired historical chart reader, activated only on a dedicated TEST page.
**Spec:** User attachment and read-only system_docs/station_charts/compressed_history_json_precomputed_aqi_test_contract.md (2 November decision).
**Architecture:** Local Bootstrap admission produces a small isolated monthly selection after immutable byte readback. Existing private Worker streams original gzip through authenticated proxy. Optional shared chart provider preserves controller, cache, settlement and renderer ownership.
**Constraints:** Local uncommitted TEST edits only; no deployment, uploads, managed JSONgen, SQL, Prune or normal chart switch. No speculative tests. User instruction supersedes skill confirmation, worktree, commit and TDD defaults.

- [x] 1. Define isolated paired selection schema and offline Bootstrap evidence/admission/readback CLI. Verify hashes, source/terminal/context, exact physical identity, reporting grid and algorithm; retain explicit manual authority limitations.
- [x] 2. Add private /v2/history-json routes and authenticated /api/aq/history-json forwarding using existing binding/secrets. Only small manifests parsed; gzip streamed without monthly calculations.
- [x] 3. Add shared historical JSON client and cache storage; optional controller provider prepares versioned cache namespaces and controls five-minute checks/Refresh. Existing clients remain defaults.
- [x] 4. Add thin historical-json-chart-test page with equivalent August day/month calculated-vs-JSON selection and bounded diagnostics.
- [x] 5. Run bounded syntax/import/schema and admission checks; review final diff. Write deployment/publication/real TEST validation, rollback and documentation handover.

Review focus: shifted endpoint grids; unavailable adjacent months; aborted generations; mismatched object/pubID/source; effective selection age and explicit Refresh; independent blank DAQI/EAQI; immutable metadata trust and readback before selection.

Progress: structural inspection completed. Both runtime source owners confirmed in TEST Ops (origin TEST-uk-aq/uk-aq-ops). Existing unrelated Ops untracked WHO evidence is preserved. Candidate has unresolved managed authority; isolated manual admission must retain it without granting managed eligibility.

Review: independent read-only review completed. Corrected cross-month boundary proof checks, preserved raw multiplicity through optional cache row IDs, and returned per-load contexts to close concurrent selection races. Failed next-month bodies remain incomplete rather than contradictory.
Validation: syntax/import/HTML reference checks, actual retained Bootstrap source-chain and pair schema inspection, and in-memory actual-candidate/shared-normalizer compatibility passed. No new test suite, remote operation, publication preparation or functional/performance acceptance. See scripts/historical_chart_json/README.md and IMPLEMENTATION_HANDOVER.md.
