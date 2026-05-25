You are working in the UK AQ repo, with focus on R2 history integrity.

Do NOT implement code yet. This is an investigation-only task.

Context:
- The canonical R2 layout is described in `uk-aq-r2-history-layout.md`.
- Public committed history is defined by day manifests:
  - `history/v1/observations/day_utc=YYYY-MM-DD/manifest.json`
  - `history/v1/aqilevels/day_utc=YYYY-MM-DD/manifest.json`
- Observations and AQI levels are separate R2 domains:
  - observations: `history/v1/observations/day_utc=YYYY-MM-DD/connector_id=<id>/...`
  - AQI levels: `history/v1/aqilevels/day_utc=YYYY-MM-DD/connector_id=<id>/...`
- Both domains have day manifests and connector manifests.
- Observations manifests use `source_row_count`, `min_observed_at`, `max_observed_at`.
- AQI manifests use `source_row_count`, `min_timestamp_hour_utc`, `max_timestamp_hour_utc`.
- Derived index objects are rebuilt from committed day and connector manifests only.
- Readers treat committed day manifests as the source of truth.

Problem to investigate:
We need a robust way to detect gaps where observations exist in R2 history but corresponding AQI levels do not exist when they should.

The intended check is roughly:
“For each day/connector where committed observations exist, determine whether committed AQI levels should also exist. If so, flag missing AQI day manifests, connector manifests, or suspicious zero/low AQI row counts.”

Important nuance:
This is not necessarily a strict 1:1 row-count comparison. Observations are raw observed values, while AQI levels are derived hourly/pollutant records. The investigation should clarify the expected relationship from existing code and data model before proposing validation rules.

Investigation goals:

1. Find existing scripts, workers, commands, tests, or maintenance jobs that already check R2 history integrity.
   Search for things like:
   - observations integrity
   - aqilevels integrity
   - history integrity
   - manifest validation
   - day manifest validation
   - connector manifest validation
   - R2 history audit
   - prune day gates
   - backfill verification
   - derived index rebuild/check
   - AQI export summary
   - missing AQI
   - aqilevels_latest
   - observations_latest

2. Find the code paths that write observations history.
   Identify:
   - writer/worker names
   - how day candidates are selected
   - where connector manifests are written
   - where day manifests are written
   - whether observations export has existing completeness checks

3. Find the code paths that write AQI levels history.
   Identify:
   - whether AQI export is part of prune Phase B, integrity/backfill, or another worker/script
   - how AQI candidate days/connectors are selected
   - whether AQI export depends on observations, database state, or another source table/view
   - whether AQI export can legitimately produce no rows for a day/connector with observations

4. Find existing DB tables/views/RPCs that define AQI availability or expected AQI derivation.
   Look for:
   - AQI/DAQI/EAQI tables
   - hourly aggregation tables/views
   - pollutant eligibility rules
   - timeseries-to-pollutant mappings
   - station/pollutant metadata
   - any rules that mean observations can exist but AQI should not

5. Investigate existing R2 indexes.
   The layout doc says there are:
   - `history/_index/observations_latest.json`
   - `history/_index/aqilevels_latest.json`
   - `history/_index/observations_timeseries_latest.json`
   - `history/_index/aqilevels_timeseries_latest.json`
   Check whether existing index rebuilds or descriptors already expose enough information to detect day/connector gaps cheaply without scanning parquet files.

6. Determine the best level for a new check:
   Compare these possible approaches:
   - Manifest-only check:
     Compare committed observations day/connector manifests against committed AQI day/connector manifests.
   - Index-level check:
     Compare observations latest/index summaries against AQI latest/index summaries.
   - DB-aware check:
     Use DB metadata to decide whether AQI is expected for each observation day/connector.
   - Parquet-aware check:
     Read observation/AQI parquet files only when manifests indicate a possible mismatch.
   - Hybrid check:
     Use manifests/indexes for broad detection, DB/parquet only for diagnosis.

7. Define candidate gap categories.
   At minimum consider:
   - observation day manifest exists, AQI day manifest missing
   - observation connector manifest exists, AQI connector manifest missing
   - AQI day manifest exists but omits connector that has observations
   - AQI connector manifest exists but `source_row_count` is zero
   - AQI connector manifest exists but time coverage is much narrower than observation coverage
   - AQI latest/index missing a day/connector that committed AQI manifests contain
   - AQI manifests exist but referenced parquet files are missing
   - AQI parquet files exist but day/connector manifest is missing
   - observations exist for pollutant/timeseries that is not AQI-eligible, which may be a legitimate non-gap

8. Identify where this should run operationally.
   Consider:
   - standalone audit script
   - CI/manual ops command
   - scheduled worker
   - part of integrity/backfill verification
   - part of derived index rebuild
   - part of prune Phase B post-check
   - dashboard/reporting only

9. Recommend outputs for the investigation.
   The eventual tool should probably produce a structured report such as:
   - scanned day range
   - scanned connectors
   - observation days/connectors found
   - AQI days/connectors found
   - missing AQI day manifests
   - missing AQI connector manifests
   - suspicious AQI row counts
   - suspicious AQI time coverage
   - cases marked “possibly legitimate because no AQI-eligible pollutants”
   - suggested repair command/path, if one exists
   - JSON output suitable for ops automation
   - human-readable summary

10. Look for repair/rebuild paths.
   Identify whether there is already a command, worker, route, or script that can rebuild AQI levels for a specific:
   - day
   - connector
   - day range
   - connector range
   - full history window

Do not write implementation code.

Deliverables:
A. A concise map of the relevant files/scripts/workers/tests found.
B. A summary of any existing integrity checks and whether they already cover AQI-vs-observations gaps.
C. The discovered expected relationship between observations and AQI levels.
D. A recommended validation design.
E. A list of edge cases where observations can exist but AQI levels may legitimately not exist.
F. A proposed future implementation plan, broken into small safe commits.
G. Any open questions that need a human decision before implementation.

Additional deliverable:
After analysing the codebase, produce a short list of realistic remedy options for detecting and handling AQI gaps where observations exist but AQI levels are missing when they should exist.

For each option, include:
- pros
- cons
- operational complexity
- failure modes
- recommendation

Also answer these two questions based on the codebase:
1. Should this live inside the existing integrity flow, or should it be a separate AQI-specific integrity check/tool?
2. If separate, what would be the best name and location for it?
