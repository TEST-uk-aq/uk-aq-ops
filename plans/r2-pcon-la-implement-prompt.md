You are working in the uk-aq-ingest repo.

Goal:
Replace the failing daily stations workflow PCON/LA enrichment step that still uses Aiven/PostGIS with the new R2 shard enrichment script.

Context:
Aiven has stopped working. The daily stations workflow currently fails at the step named:

Refresh station PCON/LA from Aiven

That step must be replaced with the R2 enrichment path.

Important constraints:
- Do not use Aiven.
- Do not require PCON_AIVEN_PG_DSN.
- Do not add a provider switch.
- Do not use UK_AQ_GEO_LOOKUP_PROVIDER.
- Keep daily station enrichment in the ingest repo.
- Do not load whole UK boundary files during the daily workflow.
- The R2 lookup should read only the needed shard objects.
- Preserve the step position in the workflow unless there is a strong reason to move it.
- Keep the workflow safe for scheduled daily use.

Before changing anything:
1) Inspect the repo for the current R2 enrichment implementation.
   Look for:
   - scripts/uk_aq_refresh_station_geo_r2.py
   - scripts/geography/*
   - modules/helpers for R2 shard lookup
   - UK_AQ_GEO_R2_BUCKET
   - UK_AQ_GEO_R2_PREFIX
   - pcon_code / la_code update logic
   - tests for the R2 lookup

2) Inspect the current daily stations workflow:
   .github/workflows/uk_aq_stations_daily.yml

3) Confirm the current failing step:
   - name: Refresh station PCON/LA from Aiven
   - env includes PCON_AIVEN_PG_DSN
   - run command calls scripts/uk_aq_refresh_station_geo_aiven.py

4) If the R2 enrichment script does not exist yet, stop and report that it needs to be implemented first.
   Do not wire the workflow to a missing script unless you also implement the script in this change.

Required workflow change:
Replace the old Aiven step with a new R2 step.

Old step to remove:
- name: Refresh station PCON/LA from Aiven
  env:
    SUPABASE_URL: ${{ vars.SUPABASE_URL }}
    SB_SECRET_KEY: ${{ secrets.SB_SECRET_KEY }}
    PCON_AIVEN_PG_DSN: ${{ secrets.PCON_AIVEN_PG_DSN }}
  run: |
    python3 scripts/uk_aq_refresh_station_geo_aiven.py

New step should be similar to:

- name: Refresh station PCON/LA from R2 shards
  env:
    SUPABASE_URL: ${{ vars.SUPABASE_URL }}
    SB_SECRET_KEY: ${{ secrets.SB_SECRET_KEY }}
    UK_AQ_GEO_R2_BUCKET: ${{ vars.UK_AQ_GEO_R2_BUCKET || 'uk-aq-pcon-la-lookup' }}
    UK_AQ_GEO_R2_PREFIX: ${{ vars.UK_AQ_GEO_R2_PREFIX || 'v1' }}
    UK_AQ_GEO_GRID_SIZE_DEGREES: ${{ vars.UK_AQ_GEO_GRID_SIZE_DEGREES || '0.05' }}
    UK_AQ_GEO_BOUNDARY_DETAIL: ${{ vars.UK_AQ_GEO_BOUNDARY_DETAIL || 'detailed' }}
    UK_AQ_GEO_ENRICH_DRY_RUN: ${{ vars.UK_AQ_GEO_ENRICH_DRY_RUN || 'false' }}
  run: |
    python3 scripts/uk_aq_refresh_station_geo_r2.py

If GitHub Actions expression defaults are not valid in this repo’s existing style, use the repo’s established pattern for defaults instead. Do not invent unsupported syntax.

Also check whether R2 credentials are needed by the script.
If the R2 script requires credentials in env, add the correct existing repo convention, for example:
- CLOUDFLARE_ACCOUNT_ID
- R2_ACCESS_KEY_ID
- R2_SECRET_ACCESS_KEY
or the repo’s established equivalents.

Use the existing naming conventions already used elsewhere in this repo. Do not create new secret names if equivalent ones already exist.

Archive requirement:
Before changing .github/workflows/uk_aq_stations_daily.yml, copy the original file to the existing dated archive location used for the PCON/LA R2 cutover if that archive exists:

archive/2026-06-01/pcon-la-r2-cutover/uk-aq-ingest/changed-before/.github/workflows/uk_aq_stations_daily.yml

If the archive path does not exist, create it.

If the old Aiven script is still present and this change is responsible for retiring it, move it into the same archive tree, preserving path context. Do not delete it without archiving.

Remove active Aiven references:
After the workflow change, active non-archive files should not contain the daily PCON/LA workflow dependency on:
- PCON_AIVEN_PG_DSN
- scripts/uk_aq_refresh_station_geo_aiven.py
- Refresh station PCON/LA from Aiven

Run searches to confirm.

Validation:
1) Run a syntax or YAML validation if available.
2) Run any relevant tests for the R2 enrichment script if available.
3) If possible, run a dry-run command locally or document the command:

UK_AQ_GEO_ENRICH_DRY_RUN=true 
UK_AQ_GEO_ENRICH_LIMIT=10 
python3 scripts/uk_aq_refresh_station_geo_r2.py

Expected output:
- .github/workflows/uk_aq_stations_daily.yml uses the R2 enrichment script.
- PCON_AIVEN_PG_DSN is removed from the active daily workflow.
- The Aiven geography script is no longer called by the active daily workflow.
- The workflow still runs the PCON/LA enrichment before the station-name/null checks.
- Any changed file was copied to archive before modification.
- Any removed Aiven-only file was archived before removal.

Output required from you:
- files changed
- files copied to archive
- files moved to archive, if any
- exact old workflow step removed
- exact new workflow step added
- R2 env vars used
- validation/test commands run
- grep/search confirmation that active workflow no longer references Aiven
- assumptions made