# Agent Notes

- `codeql-noarchive` in this repo currently scans `actions` and `javascript-typescript` only.
- If Python source files are added outside `archive/`, update `.github/workflows/codeql-noarchive.yml` to include `python` in the language matrix.

## Backup Policy

- The Phase B observations backup is mandatory in this project.
- Never suggest disabling, skipping, or reducing Phase B backup coverage to lower egress or cost.
- Egress optimizations must preserve full backup integrity and intended backup behavior.

## Schema Placement Policy

- Canonical SQL DDL belongs in the schema repo (`.../CIC-test-uk-aq-schema/schemas/...`), not only in ops worker directories.
- If ops introduces or changes AggDaily tables, the change must also be reflected in:
  - `schemas/aggdaily_db/uk_aq_aggdaily_schema.sql` (main AggDaily schema), and
  - a schema-repo SQL file under `schemas/aggdaily_db/` when a targeted apply file is needed.
