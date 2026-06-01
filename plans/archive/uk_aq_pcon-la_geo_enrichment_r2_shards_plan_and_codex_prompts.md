# UK-AQ Geography Enrichment Plan (R2 Shards, No Public API)

## Confirmed Requirements (User Decisions Already Made)

- The daily stations enrichment logic stays in the ingest repo.
- Setup/build/upload functionality lives in the ops repo, following the postcode-lookup pattern.
- This is not a public API design. No Worker lookup endpoint is planned for this feature.
- Layer 1 input must come from Dropbox GeoJSON boundary files.
- Use one live R2 bucket for both test and live: `uk-aq-pcon-la-lookup`.
- Use `v1` as the R2 prefix root.
- Use the same Cloudflare account approach as postcode/cache (live account for both envs).
- Include Aiven comparison testing as part of Layer 1 (before switching daily enrichment away from Aiven).

## Goal

Replace Aiven/PostGIS station geography enrichment for:

```text
lat/lon -> PCON
lat/lon -> LA
```

with R2 shard lookups that are built offline in ops and consumed by ingest.

## Architecture

```text
Layer 1 (ops repo):
Dropbox GeoJSON -> build compact grid shards -> upload to R2 -> run Aiven comparison gate

Layer 2 (ingest repo):
Daily stations script -> fetch only needed R2 shard(s) -> point-in-polygon -> update station rows

Layer 3 (future, optional):
mobile strategy (current polygon -> neighbours -> grid fallback)
```

## R2 Layout (Confirmed)

Bucket:

```text
uk-aq-pcon-la-lookup
```

Prefix root:

```text
v1
```

Suggested object layout:

```text
v1/
  manifest.json
  pcon/
    detailed/
      grid_0.05/
        51.50_-0.15.json
  la/
    detailed/
      grid_0.05/
        51.50_-0.15.json
  adjacency/
    pcon_2024.json
    la_2024.json
```

## Layer 1 (Ops): Build + Upload + Aiven Gate

### Layer 1A: Resolve boundary files from Dropbox

Use Dropbox as source of truth for boundary files.

Inputs expected:

- `PCON_GEOJSON_DROPBOX_BASE`
- `PCON_GEOJSON_DROPBOX_PATH` (optional direct override)
- `LA_GEOJSON_DROPBOX_BASE`
- `LA_GEOJSON_DROPBOX_PATH` (optional direct override)
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_REFRESH_TOKEN`

The ops flow should resolve and download the concrete GeoJSON file(s), then pass local paths to shard builder.

### Layer 1B: Build grid shards

Build from detailed PCON + LA geometries.

Rules:

- Support `Polygon` and `MultiPolygon`.
- Detect code/name fields robustly via candidate lists.
- Include a feature in every tile that its bbox overlaps.
- Do not allocate by centroid only.
- Preserve enough geometry detail for exact point-in-polygon checks.

Output files:

- per-tile shard JSON for `pcon` and `la`
- `manifest.json`
- adjacency JSON files (can be approximate initially)

### Layer 1C: Upload shards to R2

Upload JSON outputs to `uk-aq-pcon-la-lookup` under `v1`.

Use postcode-style upload conventions:

- S3-compatible R2 upload
- JSON content type
- concise upload summary (bucket, prefix, shard count, feature count, bytes)

### Layer 1D: Aiven comparison test (required gate)

Before Layer 2 rollout, run a comparison script:

```text
Aiven/PostGIS lookup vs R2 shard lookup
```

on sample stations and/or explicit station IDs.

Gate criteria:

- produce mismatch report
- review mismatch reasons (boundary vintage, edge coordinates, geometry detail)
- only then switch daily enrichment provider to R2 mode

## Layer 2 (Ingest): Daily Station Enrichment Using R2

### Scope

- Keep daily enrichment execution in ingest repo.
- Replace Aiven lookup path with R2 shard lookup path.
- Keep Aiven mode available temporarily behind config until cutover is complete.

### Runtime behavior

For each station with missing `pcon_code` or `la_code`:

1. validate geometry/lat/lon
2. compute tile key
3. fetch `pcon` tile shard
4. fetch `la` tile shard
5. bbox prefilter
6. exact point-in-polygon
7. write updates to existing station fields
8. continue on errors (no full job abort)

### Caching

- in-memory cache during run
- optional local cache directory (`.cache/...`) for repeated runs
- never load full UK boundary files in daily job

### Rollout mode switch

Use provider flag (example):

```text
UK_AQ_GEO_LOOKUP_PROVIDER=aiven|r2_shards
```

Start with `dry-run` in `r2_shards` mode, then switch writes on.

## Layer 3 (Future): Mobile Enrichment Foundation

Not required now.

Future strategy:

1. check current polygon
2. check neighbours
3. fallback to grid shard lookup

This requires by-code polygon fetch and adjacency reuse.

## Env Vars (Planned)

### Ops (Layer 1 build/upload)

- `UK_AQ_GEO_R2_BUCKET` default `uk-aq-pcon-la-lookup`
- `UK_AQ_GEO_R2_PREFIX` default `v1`
- `UK_AQ_GEO_GRID_SIZE_DEGREES` default `0.05`
- `UK_AQ_GEO_BOUNDARY_DETAIL` default `detailed`
- `UK_AQ_GEO_SHARD_OUTPUT_DIR` default `tmp/geo_lookup_v1`
- `UK_AQ_GEO_PCON_VERSION` default `2024`
- `UK_AQ_GEO_LA_VERSION` default `latest-configured`
- `PCON_GEOJSON_DROPBOX_BASE`
- `PCON_GEOJSON_DROPBOX_PATH`
- `LA_GEOJSON_DROPBOX_BASE`
- `LA_GEOJSON_DROPBOX_PATH`

R2 auth should reuse existing repo conventions with fallback chain, mirroring postcode scripts.

### Ingest (Layer 2 runtime)

- `UK_AQ_GEO_LOOKUP_PROVIDER` (`aiven` or `r2_shards`)
- `UK_AQ_GEO_R2_BUCKET` default `uk-aq-pcon-la-lookup`
- `UK_AQ_GEO_R2_PREFIX` default `v1`
- `UK_AQ_GEO_GRID_SIZE_DEGREES` default `0.05`
- `UK_AQ_GEO_BOUNDARY_DETAIL` default `detailed`
- `UK_AQ_GEO_ENRICH_DRY_RUN`
- `UK_AQ_GEO_ENRICH_LIMIT`
- `UK_AQ_GEO_ENRICH_STATION_IDS`

### Note on `UK_AQ_EDGE_UPSTREAM_SECRET`

This feature does not need `UK_AQ_EDGE_UPSTREAM_SECRET` in the core design because no Worker API is used. Keep it out unless a future internal Worker hop is added.

## Decision Log (Locked)

Chosen options:

- `1A` Layer 2 integration shape: extend existing `scripts/uk_aq_refresh_station_geo_aiven.py` with provider modes (`aiven` and `r2_shards`) for initial rollout.
- `2A` Shard payload shape: include full geometry in each tile shard for initial rollout.
- `3B` Tile-edge fallback behavior: exact tile first, then up to 8 neighbours on no-match.

## Decision Details

### Decision 1: Layer 2 integration shape in ingest

Option A: Extend existing `scripts/uk_aq_refresh_station_geo_aiven.py` with provider modes (`aiven` and `r2_shards`)

Pros:

- lowest operational change (same script/workflow path)
- easier rollback to Aiven
- Supabase endpoint egress impact: neutral (same read/write pattern)
- DB-size impact: neutral (same columns updated)

Cons:

- one script carries both old and new logic
- more conditional branches over time

Option B: Create new R2 script (`scripts/uk_aq_refresh_station_geo_r2.py`) and keep Aiven script untouched

Pros:

- clearer separation of concerns
- easier code cleanup after cutover
- Supabase endpoint egress impact: neutral
- DB-size impact: neutral

Cons:

- workflow orchestration complexity (two scripts)
- rollback relies on job-level switching, not internal flag

Recommendation:

- Option A for initial cutover speed and safety, then remove Aiven branch after acceptance.

### Decision 2: Shard payload shape for Layer 1

Option A: Tile shard contains full geometry features directly

Pros:

- simplest implementation
- fastest path to first working rollout
- easiest debugging from a single shard file
- DB-size impact: neutral

Cons:

- larger shard objects due to geometry duplication across overlapping tiles
- higher R2 read bytes per lookup vs reference-based design
- slightly higher Cloudflare/R2 cost risk as lookup volume grows

Egress/cost impact:

- Supabase egress: neutral
- R2/Cloudflare bytes and Class B read payload size: higher

Option B: Tile shard stores feature refs; geometries stored once under `by_code/`

Pros:

- lower duplicated storage and lower bytes per tile read
- better long-term cost profile at high lookup volume
- DB-size impact: neutral

Cons:

- significantly more implementation complexity
- more object reads unless extra caching strategy is added

Egress/cost impact:

- Supabase egress: neutral
- R2 read bytes: lower per tile, but may increase read count without caching

Recommendation:

- Option A for Layer 1 and Layer 2 initial rollout.
- Revisit Option B only if R2 request/byte costs become material.

### Decision 3: Tile-edge fallback behavior in Layer 2

Option A: Exact tile only

Pros:

- minimum R2 reads
- simpler diagnostics
- DB-size impact: neutral

Cons:

- more boundary-edge misses
- potentially more manual backfill/repair

Egress/cost impact:

- Supabase egress: neutral
- R2 read ops/bytes: lowest

Option B: Exact tile then up to 8 neighbours on no-match

Pros:

- better edge-case accuracy
- fewer false no-match outcomes
- DB-size impact: neutral

Cons:

- can increase R2 reads in hard boundary areas
- slightly more complex logging

Egress/cost impact:

- Supabase egress: neutral
- R2 Class B/read bytes: higher only for no-match fallback cases

Recommendation:

- Option B with guarded fallback (only when exact tile returns no match).

## Implementation Order

1. Layer 1A/1B/1C in ops (Dropbox resolve, build shards, upload R2)
2. Layer 1D Aiven comparison gate in ops
3. Layer 2 in ingest (dry-run first, then write mode)
4. switch default provider to `r2_shards`
5. remove Aiven path after acceptance period
6. Layer 3 later only when mobile use case is active

---

# Codex Prompt — Layer 1A/1B/1C (Ops Build + Upload)

```text
You are working in the uk-aq-ops repo.

Goal:
Implement Layer 1 geography setup (Dropbox -> shard build -> R2 upload) for PCON/LA lookup data.

Important constraints:
- This is NOT a public API.
- Follow postcode setup style (local build script + upload script).
- Use Dropbox GeoJSON sources for Layer 1.
- Target one shared live bucket/prefix:
  - UK_AQ_GEO_R2_BUCKET=uk-aq-pcon-la-lookup
  - UK_AQ_GEO_R2_PREFIX=v1

Required tasks:

1) Inspect repo conventions first.
   Reuse existing R2 helpers, env patterns, and script style used by postcode scripts.

2) Add Dropbox resolver/downloader step in ops.
   Suggested script path:
   scripts/geography/resolve_dropbox_geojson.py
   (you may adapt/reuse logic from ingest script if appropriate)

   Inputs:
   DROPBOX_APP_KEY
   DROPBOX_APP_SECRET
   DROPBOX_REFRESH_TOKEN
   PCON_GEOJSON_DROPBOX_BASE
   PCON_GEOJSON_DROPBOX_PATH (optional direct file override)
   LA_GEOJSON_DROPBOX_BASE
   LA_GEOJSON_DROPBOX_PATH (optional direct file override)

   Output:
   local GeoJSON file path(s) for PCON and LA.

3) Add shard builder script:
   scripts/geography/build_pcon_la_lookup_shards.mjs

   Inputs via args/env:
   UK_AQ_GEO_PCON_GEOJSON_PATH (resolved local file)
   UK_AQ_GEO_LA_GEOJSON_PATH (resolved local file)
   UK_AQ_GEO_SHARD_OUTPUT_DIR (default tmp/geo_lookup_v1)
   UK_AQ_GEO_GRID_SIZE_DEGREES (default 0.05)
   UK_AQ_GEO_BOUNDARY_DETAIL (default detailed)
   UK_AQ_GEO_PCON_VERSION (default 2024)
   UK_AQ_GEO_LA_VERSION (default latest-configured)
   UK_AQ_GEO_R2_PREFIX (default v1)

   Requirements:
   - support Polygon and MultiPolygon
   - robust code/name property detection with candidate lists
   - include features in every overlapped bbox tile
   - emit manifest.json + per-layer tile shards
   - adjacency output is optional but recommended

4) Add upload script:
   scripts/geography/upload_pcon_la_lookup_shards_to_r2.mjs

   Requirements:
   - upload all json files to R2 bucket/prefix
   - default bucket/prefix to:
     UK_AQ_GEO_R2_BUCKET=uk-aq-pcon-la-lookup
     UK_AQ_GEO_R2_PREFIX=v1
   - support existing R2 credential conventions with fallbacks
   - set content type application/json
   - print concise summary (bucket, prefix, shards, features, bytes)

5) Add docs:
   docs/geo_pcon_la_r2_shards.md
   Include:
   - Dropbox source inputs
   - shard layout
   - build command
   - upload command
   - env vars
   - known edge cases

6) Add package scripts if appropriate:
   geo:resolve-dropbox
   geo:build-shards
   geo:upload-shards

7) Add tests for tile key logic and bbox-overlap tile assignment.

Output required:
- files changed
- exact resolve/build/upload commands
- env vars required
- assumptions made
```

---

# Codex Prompt — Layer 1D (Ops Aiven Comparison Gate)

```text
You are working in the uk-aq-ops repo.

Goal:
Implement the required Layer 1 validation gate by comparing Aiven/PostGIS lookup results with the new R2 shard lookup results.

This script must not modify station rows.

Required tasks:

1) Add script:
   scripts/geography/compare_r2_geo_lookup_with_aiven.py

2) Inputs:
   SUPABASE_URL
   SB_SECRET_KEY
   PCON_AIVEN_PG_DSN
   UK_AQ_GEO_R2_BUCKET (default uk-aq-pcon-la-lookup)
   UK_AQ_GEO_R2_PREFIX (default v1)
   UK_AQ_GEO_COMPARE_LIMIT (default 100)
   UK_AQ_GEO_COMPARE_STATION_IDS (optional CSV)
   UK_AQ_GEO_COMPARE_INCLUDE_ALREADY_ENRICHED (default false)
   UK_AQ_GEO_COMPARE_OUTPUT (default logs/geo_compare/latest.json)

3) For each sampled station:
   - read lat/lon from stations table
   - run Aiven lookup for pcon/la
   - run R2 shard lookup for pcon/la
   - compare code and name values
   - keep diagnostics

4) Print summary counts and write detailed mismatch report.

5) Add docs section for interpretation of mismatches.

6) Add package script:
   geo:compare-aiven

Output required:
- files changed
- exact command
- required env vars
- output report path
- assumptions made
```

---

# Codex Prompt — Layer 2 (Ingest Daily R2 Lookup Integration)

```text
You are working in the uk-aq-ingest repo.

Goal:
Keep daily station enrichment in ingest and add R2-shard lookup mode for PCON/LA updates.

Critical constraints:
- Do not move daily logic to ops.
- Do not load whole UK boundary files during daily runs.
- Read only needed shard(s) from R2.

Use this bucket/prefix:
- UK_AQ_GEO_R2_BUCKET=uk-aq-pcon-la-lookup
- UK_AQ_GEO_R2_PREFIX=v1

Required tasks:

1) Find existing daily station geography enrichment path (currently Aiven-based).

2) Integrate R2 mode into existing script (preferred) with provider flag:
   UK_AQ_GEO_LOOKUP_PROVIDER=aiven|r2_shards

3) Add reusable lookup module (python) for:
   - tile key calculation
   - shard fetch + cache
   - bbox prefilter
   - exact point-in-polygon (Polygon and MultiPolygon)

4) Update script behavior:
   - process stations missing pcon_code or la_code
   - skip invalid/missing coordinates
   - support dry-run
   - continue on per-station errors
   - update existing station columns only

5) Add tile-edge fallback mode:
   - exact tile first
   - optional neighbour fallback (8 tiles) only on no-match

6) Add docs for runtime env vars and rollout steps.

7) Add tests for tile calc, bbox prefilter, point-in-polygon, and mock shard lookup.

Output required:
- files changed
- dry-run command
- write-mode command
- env vars
- rollback path to Aiven mode
- assumptions made
```

---

# Codex Prompt — Layer 3 (Future Mobile Foundation, Optional)

```text
You are working in uk-aq-ops and uk-aq-ingest as needed.

Goal:
Add reusable foundation for future mobile PCON/LA enrichment without enabling production mobile processing yet.

Strategy:
1) test current polygon
2) test neighbours
3) fallback to grid shards

Do not integrate into production flows yet.

Required tasks:
- add by-code polygon support only if needed
- add reusable mobile lookup helper
- add lightweight test CLI
- document match_strategy values

Output required:
- files changed
- test command
- env vars
- remaining work before production mobile rollout
```
