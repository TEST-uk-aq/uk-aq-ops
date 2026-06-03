You are working in the uk-aq-ops repo:
https://github.com/ChronicChannel-test/uk-aq-ops

Goal:
Create a non-mutating validation test for the new PCON/LA R2 shard lookup by comparing R2 lookup results against existing PCON/LA values already stored on station rows in Supabase.

Context:
Aiven has stopped working and must not be used. Do not use Aiven, PostGIS, PCON_AIVEN_PG_DSN, or any old Aiven lookup service.

Before implementing:
1) Search the repo carefully to confirm whether this already exists.
   Look for:
   - validate_r2_geo_lookup_against_stations
   - geo:validate-stations
   - UK_AQ_GEO_VALIDATE
   - pcon_code / la_code validation scripts
   - R2 station parity scripts
   - scripts/geography/*validate*
   - tests around PCON/LA R2 lookups

2) If an equivalent script already exists, do not duplicate it.
   Instead, report what exists, what it does, and what changes are needed.
   If no equivalent exists, implement the script below.

Known existing related files to inspect and reuse where possible:
- scripts/geography/build_pcon_la_lookup_shards.mjs
- scripts/geography/upload_pcon_la_lookup_shards_to_r2.mjs
- scripts/geography/lib/geo_boundary_shard_utils.mjs if present
- docs/geo_pcon_la_r2_shards.md
- plans/uk_aq_pcon-la_geo_enrichment_r2_shards_plan_and_codex_prompts_R2_ONLY_ARCHIVE.md
- package.json

Required new script:
scripts/geography/validate_r2_geo_lookup_against_stations.py

Purpose:
Randomly pick existing stations that already have stored PCON and LA codes, run the new R2 shard lookup for each station’s lat/lon, and compare the R2 result with the stored station values.

This script must not modify station rows.

Inputs:
- SUPABASE_URL
- SB_SECRET_KEY
- UK_AQ_GEO_R2_BUCKET default uk-aq-pcon-la-lookup
- UK_AQ_GEO_R2_PREFIX default v1
- UK_AQ_GEO_GRID_SIZE_DEGREES default 0.05
- UK_AQ_GEO_BOUNDARY_DETAIL default detailed
- UK_AQ_GEO_VALIDATE_LIMIT default 100
- UK_AQ_GEO_VALIDATE_RANDOM_SEED optional
- UK_AQ_GEO_VALIDATE_STATION_IDS optional CSV
- UK_AQ_GEO_VALIDATE_OUTPUT default logs/geo_validate/latest.json

Important:
Do not add UK_AQ_GEO_PARITY_INCLUDE_MISSING_EXISTING or any equivalent flag.
Normal validation mode must only sample stations that already have both stored PCON and LA code values.

Station selection logic:
1) Read station rows from Supabase using existing repo conventions.
2) Include only stations with valid latitude and longitude.
3) Include only stations where existing PCON code and LA code are both present.
4) If UK_AQ_GEO_VALIDATE_STATION_IDS is set, validate exactly those station IDs where possible.
5) Otherwise randomly sample up to UK_AQ_GEO_VALIDATE_LIMIT stations.
6) If UK_AQ_GEO_VALIDATE_RANDOM_SEED is set, use it so the sample is repeatable.
7) Add a clear console count for:
   - total rows considered
   - eligible rows
   - sampled rows
   - skipped rows and why

Lookup logic:
1) Fetch/read the R2 manifest.
2) Calculate canonical integer tile key from lat/lon using the same tile-key convention as the shard builder.
3) Fetch only the needed PCON and LA shard objects from R2.
4) Use in-memory caching for shard objects and manifest during the run.
5) Use bbox prefilter first.
6) Then run exact point-in-polygon for Polygon and MultiPolygon.
7) If no match in the exact tile, try up to 8 neighbouring tiles.
8) Record whether the match came from:
   - exact_tile
   - neighbour_tile
   - no_match
   - invalid_coordinate
   - error

Comparison logic:
1) Compare PCON code to existing station pcon_code.
2) Compare LA code to existing station la_code.
3) Treat code match as the primary signal.
4) Treat name match as secondary only, because names may differ by boundary version or naming style.
5) Do not fail the whole script because one station fails.
6) Classify mismatches clearly:
   - pcon_code_mismatch
   - la_code_mismatch
   - pcon_no_r2_match
   - la_no_r2_match
   - invalid_coordinates
   - lookup_error
   - possible_boundary_edge
   - possible_boundary_version_difference

Report output:
Write JSON to UK_AQ_GEO_VALIDATE_OUTPUT, default:
logs/geo_validate/latest.json

Report shape should include:
{
  "summary": {
    "eligible": 0,
    "sampled": 0,
    "pcon_code_matches": 0,
    "pcon_code_mismatches": 0,
    "pcon_missing_r2": 0,
    "la_code_matches": 0,
    "la_code_mismatches": 0,
    "la_missing_r2": 0,
    "overall_matches": 0,
    "overall_mismatches": 0
  },
  "manifest": {
    "bucket": "...",
    "prefix": "...",
    "grid_size_degrees": 0.05,
    "pcon_version": "...",
    "la_version": "..."
  },
  "rows": [
    {
      "station_id": "...",
      "station_name": "...",
      "connector_code": "...",
      "lat": 0,
      "lon": 0,
      "stored": {
        "pcon_code": "...",
        "pcon_name": "...",
        "la_code": "...",
        "la_name": "..."
      },
      "r2": {
        "pcon_code": "...",
        "pcon_name": "...",
        "pcon_match_strategy": "exact_tile",
        "la_code": "...",
        "la_name": "...",
        "la_match_strategy": "neighbour_tile"
      },
      "comparison": {
        "pcon_code_match": true,
        "la_code_match": true,
        "overall_match": true,
        "classification": []
      },
      "diagnostics": {
        "tile_key": "...",
        "neighbour_tiles_checked": [],
        "shard_keys_fetched": []
      }
    }
  ]
}

Console output:
Print a concise summary at the end, including:
- eligible count
- sampled count
- PCON matches/mismatches/no-match
- LA matches/mismatches/no-match
- output report path
- top mismatch examples

Docs:
Update docs/geo_pcon_la_r2_shards.md with:
- validation command
- required env vars
- how to run a seeded random sample
- how to run explicit station IDs
- how to interpret mismatches
- warning that this is a confidence gate, not a perfect oracle, because stored station values may come from a different boundary vintage

Package script:
Add package script if package.json conventions support it:
geo:validate-stations

Example commands to include in docs:

Seeded random validation:
UK_AQ_GEO_VALIDATE_LIMIT=100 \
UK_AQ_GEO_VALIDATE_RANDOM_SEED=42 \
UK_AQ_GEO_VALIDATE_OUTPUT=logs/geo_validate/latest.json \
npm run geo:validate-stations

Explicit station IDs:
UK_AQ_GEO_VALIDATE_STATION_IDS="id1,id2,id3" \
UK_AQ_GEO_VALIDATE_OUTPUT=logs/geo_validate/station_ids.json \
npm run geo:validate-stations

Tests:
Add tests for:
- deterministic random sampling with a seed
- explicit station IDs taking priority over random sampling
- only stations with existing PCON and LA codes are eligible
- mismatch classification
- report summary counts
- exact tile match
- neighbour fallback match
- no-match handling

Acceptance:
The script must run without Aiven.
The script must not write to Supabase.
The script must only read the R2 shards needed for sampled stations.
The script must not load full UK boundary GeoJSON files.
The script must produce a useful report for manual mismatch review.

Output required from you:
- whether an equivalent validation script already existed
- files changed
- exact command to run validation
- env vars required
- report path
- assumptions made