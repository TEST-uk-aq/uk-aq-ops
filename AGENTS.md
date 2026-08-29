# UK AQ coding-agent rules

## Scope

- This is the TEST ops repository and the default starting point for cross-repository UK AQ work.
- Do not inspect, modify or propagate changes to any LIVE repository unless the user explicitly asks for LIVE work.
- Work only on the bounded task requested. Do not broaden into adjacent services merely because related code exists.

## System-contract routing

Before implementation:

1. read this file;
2. read the active system map at `../TEST-uk-aq-system-docs/system_docs/SYSTEM_OVERVIEW.md`;
3. follow the relevant area `README.md`;
4. read only the broad/narrow contracts that router selects for the task;
5. inspect only the implementation files needed by that bounded route.

Do not recursively read all of `system_docs/`, `system_docs_legacy/`, plans, drafts or archive material.

Active `system_docs/` contracts are authoritative. If the user request, code or another document conflicts with an active contract, report the conflict rather than silently overriding or weakening it.

`system_docs_legacy/`, plans, drafts and archived documentation are not current authority unless an active contract explicitly incorporates a decision from them.

Coding agents may read `system_docs/` but MUST NOT create, edit, move, rename or delete files there. When implementation requires a system-doc change, provide a concise handover for ChatGPT in Chat mode covering behaviour, files changed, schema/configuration/deployment implications and validation evidence.

## Default operating mode

Default is code-only implementation in TEST.

Unless the user explicitly asks for the operation, do **not**:

- create/amend commits, push, create branches or create PRs;
- run SQL against TEST or LIVE databases or apply migrations;
- deploy Cloud Run, Workers, Pages or workflows;
- run backfills, reconciliations, bulk/long-running jobs or destructive data operations;
- make changes in GCP, Supabase, Cloudflare, R2, Dropbox or GitHub settings;
- run broad external-API fetches or repeatedly poll cloud logs.

When an external apply/deploy/run is required but not authorised, make the repository changes only and provide exact manual commands, expected result, rollback notes and post-deployment TEST checks.

## Validation policy

Before deployment, run only the smallest fast local checks needed to establish structural viability of the changed code/configuration, such as syntax/type parsing or one directly relevant existing deterministic check.

Do not create new automated tests or run broad suites by default. Add a targeted pre-deployment check only when it is genuinely needed for a high-risk boundary such as destructive data/schema behaviour, message acknowledgement or another failure that normal TEST operation would not safely expose.

Functional validation normally happens after deployment through real TEST operation. Do not add speculative fixture programmes, shadow comparisons, soak tests or exhaustive edge-case suites unless the user explicitly asks.

## Archive safety

- Archive paths are retired for active execution. Active scripts/workers/services/default runner paths MUST NOT execute or fall back to `archive/` content.
- Before a substantial or high-risk change to active non-test implementation code, preserve the exact pre-change in-scope code under the repository's existing dated `archive/YYYY-MM-DD/` convention, preserving relative paths where practical.
- Archive a code file at most once per calendar day; reuse today's copy if it already exists.
- If additional active code becomes in scope later, archive it before changing it.
- Do not create code-style archive copies for `system_docs/`, other documentation, tests/fixtures/test data, generated output, logs, caches, build/dependency artefacts or other non-code files.
- Archive copies are reference/rollback only and must not be modified or wired into active execution.

## Configuration and schema

- Reuse existing secrets, variables, environment keys, service names, workflow inputs and shared configuration when their current meaning fits. Search before introducing a new name.
- Add a new configuration name only when no suitable equivalent exists or reuse would create materially different semantics/unsafe coupling. Explain the reason and update the relevant active catalogue/target mapping.
- Keep `env-vars-master.csv` and existing environment-sync targeting/tooling aligned when repository environment configuration changes.
- Canonical SQL DDL and existing-database migrations belong in the sibling `TEST-uk-aq-schema` repository under its active `schemas/` ownership/migration structure. Do not make an ops-local SQL file the sole canonical definition.

## Repository-specific safety

- `codeql-noarchive` currently scans Actions and JavaScript/TypeScript. If active Python source is added outside `archive/`, update `.github/workflows/codeql-noarchive.yml` to include Python.
- Preserve source-provided DAQI/index observations as source observations unless the relevant active ingest/R2 contract explicitly changes that behaviour. Do not confuse them with retired persisted UK AQ calculated AQI history.
- For changes involving R2-history indexes, backup, AQI/WHO, cache behaviour or other specialised areas, follow the relevant system-doc route rather than carrying architecture rules in this file.

## Reporting

After implementation, report:

- files changed;
- contract behaviour changed or explicitly preserved;
- structural checks run;
- any manual apply/deploy/run commands;
- post-deployment TEST validation;
- rollback considerations;
- system-doc handover needed, if any.

If no implementation files changed, say so explicitly.

## Search

Prefer `grep` for text search/file discovery; do not use `rg` unless explicitly requested.
