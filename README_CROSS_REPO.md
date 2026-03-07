# Cross-repo map: CIC-test-uk-aq-ops

## Main repo
- `CIC-test-uk-aq-ingest` is the main repo for this project and the default starting point for cross-repo tasks.

## Purpose
This repo runs UK AQ operational Cloud Run services (prune, outbox, partition maintenance, DB size logging, and backfill) and related deployment/setup documentation.

## Repo structure (top-level)
- `workers/`: Cloud Run service code and job entrypoints.
- `scripts/`: Deployment and ops helper scripts.
- `system_docs/`: Setup/runbook docs for each ops service.
- `.github/workflows/`: Cloud Run deploy pipelines.
- `config/`: Environment target mappings.

## How this repo connects to the others
- **Ingest repo**: `CIC-test-uk-aq-ingest` provides ingest/edge pipelines that feed and consume the same databases.
- **Schema source**: `CIC-test-uk-aq-schema` defines SQL schemas/RPCs used by these workers.
- **Change flow**: schema changes may require worker query/RPC updates here and ingest updates there.

## Setup & run (lightweight)
### Required env vars (names only; discoverable in code)
- `SUPABASE_URL`, `SB_SECRET_KEY`
- `HISTORY_SUPABASE_URL`, `HISTORY_SECRET_KEY`
- Service-specific vars documented in `README.md` and `system_docs/setup/*`.

### Commands
- See `README.md` for local run commands and deployment workflow references.

## Where to start
- `README.md`
- `workers/`
- `system_docs/setup/`

## Conventions
- Project-wide naming conventions live in ingest repo `AGENTS.md`.
- Schema DDL canonical location is schema repo under `schemas/`.

## Permissions (REQUIRED)
- The agent may edit any files without asking for permission, except files under any `/archive` directory.

## Links
- Existing README: `README.md`
- Ingest repo (sibling): `../CIC-test-uk-aq-ingest`
- Schema repo (sibling): `../CIC-Test-UK-AQ-Schema/CIC-test-uk-aq-schema`
- Naming conventions (ingest repo): `../CIC-test-uk-aq-ingest/AGENTS.md`

## WORKING STYLE (IMPORTANT)

REQUIRED OUTPUT FORMAT

Summary (2–5 bullets)
Files changed (paths)
Implementation details (short, specific)
Supabase steps (instructions only,)
Verification checklist (clear pass/fail)

Planning requirement:
- For plan proposals, always assess both egress and database-size effects. Include those effects in options/pros/cons and reference them in the final recommendation.
