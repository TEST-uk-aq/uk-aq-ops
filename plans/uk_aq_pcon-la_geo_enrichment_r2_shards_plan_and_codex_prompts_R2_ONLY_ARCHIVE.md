# UK-AQ Geography Enrichment Plan (R2 Shards, No Public API)

## Confirmed Requirements (User Decisions Already Made)

- The daily stations enrichment logic stays in the ingest repo.
- Setup/build/upload functionality lives in the ops repo, following the postcode-lookup pattern.
- This is not a public API design. No Worker lookup endpoint is planned for this feature.
- Layer 1 input must come from Dropbox GeoJSON boundary files.
- Use one live R2 bucket for both test and live: `uk-aq-pcon-la-lookup`.
- Use `v1` as the R2 prefix root.
- Use the same Cloudflare account approach as postcode/cache, using the live Cloudflare account for both test and live workflows.
- Aiven/PostGIS is no longer available, so there must be no Aiven comparison gate and no runtime provider switch between Aiven and R2.
- Validation should instead compare R2 lookup results against existing station `pcon`/`la` values already stored in Supabase.
- The validation script should randomly sample existing stations that already have stored PCON and LA values, with optional explicit station IDs for repeatable investigations.

## Goal

Replace the old Aiven/PostGIS station geography enrichment path for:

```text
lat/lon -> PCON
lat/lon -> LA
```

with R2 shard lookups that are built offline in ops and consumed by ingest.

The first rollout target is station enrichment only. The mobile/current-location lookup idea remains future work.

## Architecture

```text
Layer 1 (ops repo):
Dropbox GeoJSON -> build compact grid shards -> upload to R2 -> validate against existing station rows

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

## Runtime Usage Confirmation (Current State)

- Current active station-geo enrichment call site is the ingest daily workflow:
  - `uk-aq-ingest/.github/workflows/uk_aq_stations_daily.yml`
  - step: `python3 scripts/uk_aq_refresh_station_geo_aiven.py` (to be replaced by R2 path)
- Connector station upsert paths (scripts and Edge/RPC upserts) currently do not perform inline PCON/LA polygon lookup; they upsert station rows and daily geo enrichment fills PCON/LA afterward.
- Practical implication: mixed-version read risk is limited to the stations-daily runtime window (plus any manual stations-daily rerun).
- Operational rule for this rollout: run shard uploads outside the stations-daily window and avoid manual stations-daily runs during upload.

## Layer 1 (Ops): Build + Upload + Validation

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
- Include useful metadata in `manifest.json`, including source file names, source file hashes, grid size, build time, boundary version labels, feature counts, shard counts and bbox coverage.

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

### Layer 1D: Stored station parity validation gate

Aiven is no longer available, so do not compare against Aiven/PostGIS.

Instead, add a non-mutating validation script that randomly samples existing station rows and checks whether the new R2 lookup returns the same PCON/LA already stored on the station.

Comparison target:

```text
Existing station lat/lon + existing station pcon/la fields
vs
R2 shard lookup from the same lat/lon
```

This script must not modify station rows.

Recommended sample logic:

1. Select only stations with valid latitude and longitude.
2. Select only stations that already have stored PCON and LA code values for the normal parity test:
   - `pcon_code`
   - `la_code`
3. Randomly sample from that eligible set.
4. Allow explicit station IDs for repeatable debugging.
5. Allow a seed so a random sample can be reproduced.
6. Support a limit, for example 100 by default.
7. Add stratified samples in addition to pure random:
   - per connector/network bucket
   - geographic spread bucket (for example region/area bands)
   - boundary-near bucket (stations close to polygon edges)

Recommended comparison rules:

- Treat code matches as the primary signal.
- Treat name matches as secondary, because names can differ slightly between boundary vintages or naming conventions.
- Record code mismatch, name mismatch, no R2 match and invalid coordinate separately.
- Record whether the R2 result came from the exact tile or neighbour fallback.
- Record which R2 shard keys were fetched.
- Record the manifest metadata used by the lookup.
- Do not fail the whole script on individual station errors.

Recommended report shape:

```json
{
  "summary": {
    "sampled": 100,
    "eligible": 1234,
    "pcon_code_matches": 99,
    "pcon_code_mismatches": 1,
    "pcon_missing_r2": 0,
    "la_code_matches": 98,
    "la_code_mismatches": 2,
    "la_missing_r2": 0
  },
  "manifest": {
    "prefix": "v1",
    "grid_size_degrees": 0.05,
    "pcon_version": "2024",
    "la_version": "latest-configured"
  },
  "rows": []
}
```

Recommended acceptance logic:

- Default validation sample size: 100 stations.
- Default parity threshold: zero unexpected wrong-code mismatches for explicit small samples, and no systematic mismatch pattern in larger random samples.
- Any mismatch above roughly 1% in random validation should be reviewed before write mode.
- Boundary-edge mismatches may be accepted only when the report makes the reason clear.
- The validation gate is not a pure pass/fail oracle, because the stored station values may have come from a different boundary vintage.
- For the first rollout, the gate should be used to catch obvious systematic errors, such as tile key mistakes, lat/lon reversal, bad property detection, missing shard uploads or broken point-in-polygon logic.
- A small number of mismatches should be reviewed manually, especially near boundaries.
- Any systematic mismatch pattern should block rollout until understood.
- High-confidence mismatches should be recorded as issues to investigate before enabling write mode.

## Layer 2 (Ingest): Daily Station Enrichment Using R2

### Scope

- Keep daily enrichment execution in ingest repo.
- Replace the Aiven lookup path with R2 shard lookup.
- Do not keep an Aiven/R2 provider switch, because Aiven is unavailable.
- Keep dry-run support for safety.
- Prefer creating a clearly named R2 script or renaming/refactoring the existing Aiven script so the production path is no longer named after Aiven.

### Runtime behaviour

For each station with missing `pcon_code` or `la_code`, or if explicitly running a refresh/backfill mode:

1. validate geometry/lat/lon
2. compute tile key
3. fetch `pcon` tile shard
4. fetch `la` tile shard
5. bbox prefilter
6. exact point-in-polygon
7. if no match, try neighbour fallback tiles
8. write updates to existing station fields, unless dry-run is enabled
9. continue on errors (no full job abort)

### Caching

- in-memory cache during run
- optional local cache directory (`.cache/...`) for repeated runs
- never load full UK boundary files in the daily job

### Rollout flow

1. Build shards in ops from Dropbox boundary files.
2. Upload shards to R2.
3. Run stored station parity validation in ops.
4. Review mismatches.
5. Implement or enable ingest R2 daily enrichment in dry-run mode.
6. Run limited write mode on a small station subset.
7. Run normal write mode.
8. Remove or archive old Aiven-specific naming and docs once the R2 path is accepted.

## Layer 3 (Future): Mobile Enrichment Foundation

Not required now.

Future strategy:

1. check current polygon
2. check neighbours
3. fallback to grid shard lookup

This requires by-code polygon fetch and adjacency reuse.

## Aiven Retirement and Archive Policy

Aiven is unavailable and should be removed from the active code path. The implementation should not leave Aiven code, Aiven env vars or Aiven-named production files in non-archive directories.

Use today's archive directory for this change:

```text
archive/2026-06-01/pcon-la-r2-cutover/
```

Archive rules:

1. Move old Aiven-only files into the archive directory, preserving enough path context to understand where they came from.
2. Before changing any existing file, copy its original version into the same archive directory.
3. After the change, active non-archive files must not contain Aiven lookup code, Aiven DSNs, `PCON_AIVEN_PG_DSN`, provider-switch logic, or docs implying Aiven is still usable.
4. Keep a small archive README explaining why the files were archived, the date, and the replacement R2 path.
5. Do not delete Aiven code without first archiving it.

Suggested archive layout:

```text
archive/2026-06-01/pcon-la-r2-cutover/
  README.md
  uk-aq-ingest/
    scripts/
      uk_aq_refresh_station_geo_aiven.py
    changed-before/
      path/to/original/file.ext
  uk-aq-ops/
    changed-before/
      path/to/original/file.ext
```

Codex should inspect the repos first and adapt the exact archive paths to the existing repo layout. The important rule is that every removed Aiven file and every pre-change version of a modified file is preserved under the dated archive directory.


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

### Ops (Layer 1 validation)

- `SUPABASE_URL`
- `SB_SECRET_KEY`
- `UK_AQ_GEO_R2_BUCKET` default `uk-aq-pcon-la-lookup`
- `UK_AQ_GEO_R2_PREFIX` default `v1`
- `UK_AQ_GEO_VALIDATE_LIMIT` default `100`
- `UK_AQ_GEO_VALIDATE_RANDOM_SEED` optional
- `UK_AQ_GEO_VALIDATE_STATION_IDS` optional CSV
- `UK_AQ_GEO_VALIDATE_OUTPUT` default `logs/geo_validate/latest.json`

### Ingest (Layer 2 runtime)

- `UK_AQ_GEO_R2_BUCKET` default `uk-aq-pcon-la-lookup`
- `UK_AQ_GEO_R2_PREFIX` default `v1`
- `UK_AQ_GEO_GRID_SIZE_DEGREES` default `0.05`
- `UK_AQ_GEO_BOUNDARY_DETAIL` default `detailed`
- `UK_AQ_GEO_ENRICH_DRY_RUN`
- `UK_AQ_GEO_ENRICH_LIMIT`
- `UK_AQ_GEO_ENRICH_STATION_IDS`
- `UK_AQ_GEO_ENRICH_REFRESH_EXISTING` default `false`

### Removed env vars

Do not add these for the new design:

- `PCON_AIVEN_PG_DSN`
- `UK_AQ_GEO_LOOKUP_PROVIDER=aiven|r2_shards`

### Note on `UK_AQ_EDGE_UPSTREAM_SECRET`

This feature does not need `UK_AQ_EDGE_UPSTREAM_SECRET` in the core design because no Worker API is used. Keep it out unless a future internal Worker hop is added.

## Decision Log (Locked)

Chosen options:

- `1B` Layer 2 integration shape: use a clearly named R2 enrichment path in ingest, without an Aiven/R2 provider switch.
- `2A` Shard payload shape: include full geometry in each tile shard for initial rollout.
- `3B` Tile-edge fallback behaviour: exact tile first, then up to 8 neighbours on no-match.
- `4B` Validation gate: compare R2 lookup results against existing station PCON/LA values in Supabase, using random sampling plus optional explicit station IDs. Normal parity mode must only sample stations that already have stored PCON and LA values.

## Decision Details

### Decision 1: Layer 2 integration shape in ingest

Option A: Extend existing `scripts/uk_aq_refresh_station_geo_aiven.py` with provider modes

Pros:

- lowest change if the existing script is already wired into jobs
- can reuse existing station read/write behaviour

Cons:

- misleading Aiven naming after Aiven is gone
- unnecessary provider switch
- keeps dead Aiven concepts in docs and env vars

Option B: Create or rename to a clearly R2-based enrichment script

Example path:

```text
scripts/uk_aq_refresh_station_geo_r2.py
```

Pros:

- clearer production path
- no dead Aiven config
- simpler runtime logic
- easier to explain and operate

Cons:

- may require updating workflow/script references
- Codex must carefully inspect current Aiven script before refactoring to avoid losing existing station update behaviour

Recommendation:

- Use Option B now, because Aiven is unavailable and there is no realistic rollback to the old provider.
- Codex should still inspect the old Aiven script and reuse useful station query/update logic where appropriate.

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

Tile-key specification (locked for this rollout):

- Use integer tile indices as canonical keys (`ix`, `iy`) derived from:
  - `ix = floor((lon - min_lon) / grid_size)`
  - `iy = floor((lat - min_lat) / grid_size)`
- Use integer index keys in object naming to avoid float rounding/sign drift between build and lookup runtimes.
- Optional human-readable lat/lon labels may be present in manifest metadata only; they are not lookup keys.

### Decision 3: Tile-edge fallback behaviour in Layer 2

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

- Option B with guarded fallback, only when the exact tile returns no match.

### Decision 4: Validation gate after Aiven removal

Option A: No validation gate

Pros:

- fastest implementation
- no extra Supabase reads

Cons:

- high risk of silent tile/key/geometry bugs
- no confidence before production writes

Option B: Compare R2 lookup against existing stored station PCON/LA values

Pros:

- uses data you already have
- no Aiven dependency
- good at detecting systematic lookup bugs
- can be random, repeatable and station-specific
- does not modify station rows

Cons:

- stored station values may be stale or from a different boundary vintage
- mismatches need interpretation rather than blind failure
- does not validate stations with no stored PCON/LA values

Option C: Compare R2 lookup against an external public API or downloaded reference service

Pros:

- independent of current station values

Cons:

- introduces a new dependency
- may have rate limits, boundary version differences or licensing questions
- unnecessary for first rollout

Recommendation:

- Use Option B.
- Treat it as a confidence gate and diagnostic tool, not a perfect oracle.

## Implementation Order

1. Layer 1A/1B/1C in ops (Dropbox resolve, build shards, upload R2)
2. Layer 1D stored station parity validation in ops
3. Layer 2 in ingest (dry-run first, then limited write mode)
4. archive old Aiven files and copies of every file that will be changed
5. switch the scheduled daily enrichment path to the R2 script
6. remove Aiven code from all non-archive files
7. Layer 3 later only when the mobile use case is active
8. env governance updates required for env var add/remove/rename:
   - update `CIC-test-uk-aq-ops/env-vars-master.csv`
   - update ingest `config/uk_aq_github_env_targets.csv`
   - update ingest `scripts/uk_aq_sync_github_secrets.sh` if env sync targets/rules changed

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
- Do not add Aiven/PostGIS dependencies.
- Do not add any Worker lookup endpoint.

Required tasks:

1) Inspect repo conventions first.
   Reuse existing R2 helpers, env patterns, script style and package script style used by postcode/cache scripts.

2) Add Dropbox resolver/downloader step in ops.
   Suggested script path:
   scripts/geography/resolve_dropbox_geojson.py
   (you may adapt/reuse existing Dropbox logic if appropriate)

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
   - do not assign features by centroid only
   - use integer tile indices as canonical keys (ix, iy) for object naming
     (avoid float-formatted lat/lon as canonical lookup keys)
   - preserve enough geometry for exact point-in-polygon checks at lookup time
   - emit manifest.json + per-layer tile shards
   - include source filenames/hashes, grid size, build time, boundary version labels, feature counts, shard counts and bbox coverage in manifest.json
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
   - validation command placeholder
   - known edge cases
   - note that Aiven is no longer part of this design

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

# Codex Prompt — Layer 1D (Ops Stored Station Parity Validation)

```text
You are working in the uk-aq-ops repo.

Goal:
Implement the Layer 1 validation gate for PCON/LA R2 shard lookup after Aiven removal.

Aiven/PostGIS is no longer available, so do not use Aiven, do not require PCON_AIVEN_PG_DSN, and do not compare against any old lookup service.

Instead, compare the new R2 shard lookup result against the existing PCON/LA values already stored on station rows in Supabase.

This script must not modify station rows.

Required tasks:

1) Add script:
   scripts/geography/validate_r2_geo_lookup_against_stations.py

2) Inputs:
   SUPABASE_URL
   SB_SECRET_KEY
   UK_AQ_GEO_R2_BUCKET (default uk-aq-pcon-la-lookup)
   UK_AQ_GEO_R2_PREFIX (default v1)
   UK_AQ_GEO_GRID_SIZE_DEGREES (default 0.05)
   UK_AQ_GEO_BOUNDARY_DETAIL (default detailed)
   UK_AQ_GEO_VALIDATE_LIMIT (default 100)
   UK_AQ_GEO_VALIDATE_RANDOM_SEED (optional)
   UK_AQ_GEO_VALIDATE_STATION_IDS (optional CSV)
   UK_AQ_GEO_VALIDATE_OUTPUT (default logs/geo_validate/latest.json)

3) Station selection:
   - read from the stations table using existing Supabase conventions
   - include only stations with valid lat/lon
   - include only rows that already have stored PCON and LA code values for normal parity mode
   - randomly sample eligible rows up to UK_AQ_GEO_VALIDATE_LIMIT
   - include stratified sampling buckets in addition to pure random:
     - connector/network bucket
     - geographic spread bucket
     - boundary-near bucket
   - support UK_AQ_GEO_VALIDATE_RANDOM_SEED so the random sample can be reproduced
   - support UK_AQ_GEO_VALIDATE_STATION_IDS for explicit repeatable investigations

4) For each sampled station:
   - read station id, station name, network/source fields if available, lat/lon, stored PCON fields and stored LA fields
   - run R2 shard lookup for PCON and LA using the same lookup helper intended for ingest if possible
   - compare code and name values
   - treat code matches as primary
   - treat name matches as secondary
   - record no-match, invalid-coordinate and lookup-error separately
   - record lookup diagnostics, including exact tile key, neighbour fallback usage, shard keys fetched and manifest metadata

5) Output:
   - print concise summary counts to the console
   - write detailed JSON report to UK_AQ_GEO_VALIDATE_OUTPUT
   - include enough detail to manually inspect mismatches
   - do not fail the whole script because one station lookup fails

6) Acceptance guidance in docs:
   Add docs explaining that this is a confidence gate, not a perfect oracle.
   Existing station values may use a different boundary vintage, so a small number of mismatches may be genuine boundary/version differences.
   Systematic patterns, such as widespread mismatches, all stations returning no match, lat/lon reversal symptoms, missing shards or one layer failing entirely, must block rollout until investigated.

7) Add package script:
   geo:validate-stations

8) Add tests for:
   - deterministic random sampling with a seed
   - explicit station IDs overriding random sampling
   - mismatch classification
   - report summary counts

Output required:
- files changed
- exact validation command
- required env vars
- output report path
- assumptions made
```

---

# Codex Prompt — Archive and Remove Aiven Geography Code

```text
You are working in the uk-aq-ingest repo and, if relevant, the uk-aq-ops repo.

Goal:
Retire the old Aiven/PostGIS PCON/LA geography lookup code before completing the R2 cutover.

Aiven is no longer available. Active non-archive code and docs must not contain Aiven geography lookup code, Aiven provider switches, Aiven DSN env vars, or instructions that imply Aiven can still be used for PCON/LA enrichment.

Use this archive directory for this change:
archive/2026-06-01/pcon-la-r2-cutover/

Required tasks:

1) Inspect the repos for Aiven geography lookup files, references and docs.
   Look for:
   - scripts with Aiven in the filename
   - PCON_AIVEN_PG_DSN
   - UK_AQ_GEO_LOOKUP_PROVIDER
   - aiven|r2_shards provider switch logic
   - PostGIS PCON/LA lookup code
   - workflow/package script references to old Aiven geography enrichment

2) Archive old Aiven-only files.
   Move Aiven-only PCON/LA geography files into:
   archive/2026-06-01/pcon-la-r2-cutover/

   Preserve enough path context to see where each file came from.

3) Before changing any existing non-archive file, copy its original version into:
   archive/2026-06-01/pcon-la-r2-cutover/<repo>/changed-before/<original-path>/

4) Remove Aiven geography code from active files.
   Active non-archive files must not contain:
   - Aiven lookup code
   - PCON_AIVEN_PG_DSN
   - UK_AQ_GEO_LOOKUP_PROVIDER=aiven|r2_shards
   - provider switch branches for Aiven vs R2
   - docs or commands that say to use Aiven for PCON/LA enrichment

5) Add archive README:
   archive/2026-06-01/pcon-la-r2-cutover/README.md

   Include:
   - date archived: 2026-06-01
   - reason: Aiven account/service unavailable and PCON/LA enrichment is moving to R2 shards
   - list of files moved
   - list of files copied before modification
   - replacement active script/docs paths

6) Update active package scripts/workflows/docs only as needed so they point to the R2 path.

7) Run tests or at least repo lint/check commands if available.

Output required:
- files moved to archive
- files copied to changed-before
- active files changed
- grep/search confirmation that active non-archive files no longer contain Aiven geography lookup references
- assumptions made
```

---

# Codex Prompt — Layer 2 (Ingest Daily R2 Lookup Integration)

```text
You are working in the uk-aq-ingest repo.

Goal:
Keep daily station enrichment in ingest and replace the old Aiven/PostGIS geography lookup path with R2-shard lookup for PCON/LA updates.

Critical constraints:
- Do not move daily logic to ops.
- Do not load whole UK boundary files during daily runs.
- Read only needed shard(s) from R2.
- Do not add a provider flag for Aiven vs R2.
- Do not require any Aiven env vars.
- Keep dry-run support.

Use this bucket/prefix:
- UK_AQ_GEO_R2_BUCKET=uk-aq-pcon-la-lookup
- UK_AQ_GEO_R2_PREFIX=v1

Required tasks:

0) Before modifying existing files, follow the archive policy in this plan. If the old Aiven script is being replaced, move it into archive/2026-06-01/pcon-la-r2-cutover/. If any existing workflow, package file or docs are changed, copy the pre-change version into the same archive tree first.

1) Inspect the existing daily station geography enrichment path.
   It may currently be Aiven-based or named after Aiven.
   Reuse safe station read/write behaviour, batching, logging, dry-run behaviour and error handling where appropriate.

2) Create or refactor to a clearly R2-based script.
   Suggested path:
   scripts/uk_aq_refresh_station_geo_r2.py

   Do not keep a runtime provider switch like:
   UK_AQ_GEO_LOOKUP_PROVIDER=aiven|r2_shards

3) Add reusable lookup module (python) for:
   - manifest fetch/read
   - tile key calculation
   - shard fetch + cache
   - bbox prefilter
   - exact point-in-polygon for Polygon and MultiPolygon
   - exact tile first, then neighbour fallback only on no-match
   - diagnostics for shard keys, fallback usage and match strategy

4) Update script behaviour:
   - process stations missing pcon_code or la_code by default
   - support explicit station IDs
   - support a limit
   - support dry-run
   - optionally support UK_AQ_GEO_ENRICH_REFRESH_EXISTING=true for deliberate refresh/backfill of already-enriched rows
   - skip invalid/missing coordinates
   - continue on per-station errors
   - update existing station columns only
   - do not overwrite existing values with null just because lookup failed

5) Add tile-edge fallback mode:
   - exact tile first
   - neighbour fallback up to 8 surrounding tiles only when exact tile returns no match
   - record match_strategy such as exact_tile, neighbour_tile, no_match, invalid_coordinate, error

6) Add docs for runtime env vars and rollout steps.
   Include:
   - dry-run command
   - limited write command for explicit station IDs
   - normal write command
   - how to read logs
   - how to interpret no-match and mismatch cases
   - note that Aiven is no longer part of the runtime design

8) If env vars are added/removed/renamed as part of this work, update required env-governance files:
   - `CIC-test-uk-aq-ops/env-vars-master.csv`
   - ingest `config/uk_aq_github_env_targets.csv`
   - ingest `scripts/uk_aq_sync_github_secrets.sh` (when sync targets/rules change)

9) Add tests for:
   - tile calc
   - bbox prefilter
   - point-in-polygon
   - mock shard lookup
   - neighbour fallback
   - dry-run not writing
   - failed lookup not overwriting stored values with null

Output required:
- files changed
- dry-run command
- limited write-mode command
- normal write-mode command
- env vars
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
Do not add a public Worker API unless explicitly requested later.

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
