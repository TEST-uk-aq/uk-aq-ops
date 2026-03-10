# Agent Notes

- `codeql-noarchive` in this repo currently scans `actions` and `javascript-typescript` only.
- If Python source files are added outside `archive/`, update `.github/workflows/codeql-noarchive.yml` to include `python` in the language matrix.

## Backup Policy

- The Phase B observations backup is mandatory in this project.
- Never suggest disabling, skipping, or reducing Phase B backup coverage to lower egress or cost.
- Egress optimizations must preserve full backup integrity and intended backup behavior.

## Schema Placement Policy

- Canonical SQL DDL belongs in the schema repo (`.../CIC-test-uk-aq-schema/schemas/...`), not only in ops worker directories.
- If ops introduces or changes Obs AQI tables, the change must also be reflected in:
  - `schemas/obs_aqi_db/uk_aq_obs_aqi_db_schema.sql` (main Obs AQI schema), and
  - a schema-repo SQL file under `schemas/obs_aqi_db/` when a targeted apply file is needed.

## R2/Cloudflare Cache Cost Policy

- For AQI history served via R2 + Cloudflare, assume cost is primarily driven by R2 operation counts (especially Class B reads) and Worker request volume, not R2 bandwidth egress.
- Prefer stable request URLs/params for normal traffic so Cloudflare cache can return warm-cache hits.
- Use cache-buster/version params only for diagnostics, forced-refresh actions, or explicit bypass-cache testing.
- When evaluating performance/cost changes, check cache-hit behavior (`CF-Cache-Status`) and distinguish cache-hit traffic from origin-fetch traffic.
