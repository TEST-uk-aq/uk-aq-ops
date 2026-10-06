# Cross-repo map: TEST-uk-aq-ops

## Main repo
- `TEST-uk-aq-ops` is the main repo for this project and the default starting point for cross-repo tasks.

## Purpose
This repo runs UK AQ operational Cloud Run services (prune, outbox, partition maintenance, DB size logging, and backfill) and related deployment/setup documentation.

## Repo structure (top-level)
- `workers/`: Cloud Run service code and job entrypoints.
- `scripts/`: Deployment and ops helper scripts.
- `system_docs/`: Setup/runbook docs for each ops service.
- `.github/workflows/`: Cloud Run deploy pipelines.
- `config/`: Environment target mappings.

## How this repo connects to the others
- **Ingest repo**: `TEST-uk-aq-ingest` provides ingest/edge pipelines that feed and consume the same databases.
- **Schema source**: `TEST-uk-aq-schema` defines SQL schemas/RPCs used by these workers.
- **Change flow**: schema changes may require worker query/RPC updates here and ingest updates there.

## Setup & run (lightweight)
### Required env vars (names only; discoverable in code)
- `SUPABASE_URL`, `SB_SECRET_KEY`
- `OBS_AQIDB_SUPABASE_URL`, `OBS_AQIDB_SECRET_KEY`
- Service-specific vars documented in `README.md` and `system_docs/*`.

### Commands
- See `README.md` for local run commands and deployment workflow references.

## Where to start
- `README.md`
- `workers/`
- `system_docs/`

## Conventions
- Project-wide naming conventions live in ingest repo `AGENTS.md`.
- Schema DDL canonical location is schema repo under `schemas/`.

## Permissions (REQUIRED)
- The agent may edit normal TEST working-tree files required by the bounded task without asking for permission.
- When `AGENTS.md` requires a pre-change archive copy, creating that required copy is also authorised without a separate confirmation.
- Existing archived content remains read-only reference/rollback material and must not be modified or used as active runtime code.

## Links
- Existing README: `README.md`
- Ingest repo (sibling): `../TEST-uk-aq-ingest`
- Schema repo (sibling): `../TEST-uk-aq-schema`
- Naming conventions (ingest repo): `../TEST-uk-aq-ingest/AGENTS.md`

## WORKING STYLE (IMPORTANT)

REQUIRED OUTPUT FORMAT

Summary (2–5 bullets)
Files changed (paths)
Implementation details (short, specific)
Supabase steps (instructions only,)
Verification checklist (clear pass/fail)

Planning requirement:
- For plan proposals, always assess both egress and database-size effects. Include those effects in options/pros/cons and reference them in the final recommendation.
