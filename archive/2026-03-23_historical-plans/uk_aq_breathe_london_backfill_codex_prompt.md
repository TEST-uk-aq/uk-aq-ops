# UK AQ Breathe London Backfill Codex Prompt

Please extend the UK AQ backfill functionality to support the Breathe London connector using the Breathe London API directly.

## Goal

- Add historical backfill support for the Breathe London connector to the existing backfill framework.
- Use the Breathe London API directly for historical backfill.
- Follow the same operator experience and variable style as the existing backfill connectors as closely as practical.
- Keep the implementation focused and avoid redesigning the whole framework.

## Locked requirements

- Historical source for this connector: **Breathe London API directly**
- Use the existing Breathe London API key already available for the project
- Do not introduce a second historical source in phase 1
- Prefer reusing existing live Breathe London ingest logic where practical rather than inventing a separate historical implementation
- The backfill calling script should support the same style of date-range inputs as the other backfill connectors:
  - UTC start day
  - UTC end day
  - inclusive range
  - if start and end are the same date, process one day only
- Support `UK_AQ_BACKFILL_FORCE_REPLACE=true|false`
- Match existing backfill framework behavior and conventions as closely as practical
- Output must be processed into the normal UK AQ R2 format, matching normal ingest/processing output
- Do not create a Breathe London-specific backfill-only R2 format

## Important API facts to respect

- Breathe London exposes `/ListSensors` for sensor/site metadata and `/SensorData` for observations.
- `startTime` and `endTime` can be used to request historical periods.
- `startTime` and `endTime` must be used together with at least one of `SiteCode`, `Borough`, `Sponsor`, `Facility`, or `Latitude`/`Longitude`/`RadiusKM`.
- If `SiteCode` is not provided, the requested period must be shorter than 366 days.
- Species filtering supports `NO2`, `PM25`, `NO2Index`, and `PM25Index`.
- Be conservative with pacing and concurrency and do not risk blowing the API or ignoring usage limits.

## Recommended connector strategy

Use the Breathe London API **site-by-site, day-by-day**.

That means:
- candidate station list should come from `/ListSensors`
- historical backfill fetches should use `/SensorData`
- the natural work unit is one **site-day**
- use `SiteCode + startTime + endTime` for deterministic historical pulls
- avoid borough-wide or broad spatial historical pulls in phase 1

## What I want implemented

### 1. Extend the backfill connector logic

- Add support for the Breathe London connector to the backfill worker / orchestration flow
- Wire it into the same overall style as the existing backfill connectors
- Reuse day-loop, overwrite/skip, logging, checkpoint, and R2 write conventions where practical

### 2. Calling script compatibility

- Ensure the backfill calling script can invoke the Breathe London connector using the same style of variables as the other backfill connectors
- Same date-range semantics
- Same force-replace semantics
- Same operator experience as far as practical

### 3. Historical fetch path

- Use the Breathe London API directly as the source of truth for historical backfill
- Reuse the existing live connector logic where practical
- Adapt that logic so it can run historically over a UTC date range rather than only live/current operation
- Keep the implementation clean and explicit about date windows

### 4. Candidate station handling

- Use `/ListSensors` as the source for candidate station/site metadata
- Reuse any existing project station mapping logic for the Breathe London connector where practical
- Avoid introducing a second incompatible discovery/mapping path
- Only fetch what is needed for the requested backfill range

### 5. Work unit behavior

- The requested run should accept UTC start day and UTC end day
- Process the range day-by-day, one day at a time
- Within each day, process candidate Breathe London sites one site at a time
- For each site-day, use `SiteCode`, `startTime`, and `endTime` with `/SensorData`
- Keep execution ordering simple and deterministic

### 6. Species / fields

- Include the normal Breathe London connector pollutants already used by the project
- Support the API's relevant species set for this connector, which includes at least:
  - `NO2`
  - `PM25`
  - `NO2Index`
  - `PM25Index`
- Reuse existing project logic for which fields are stored and transformed where practical
- Do not silently introduce incompatible field behavior

### 7. Force replace behavior

- Support `UK_AQ_BACKFILL_FORCE_REPLACE=true|false`
- Match current backfill semantics as closely as possible
- If `false`, skip already-produced outputs using the same style of decision logic as the existing framework
- If `true`, rebuild/replace the relevant Breathe London outputs in the same style as the current framework

### 8. Processing and transformation

- Reuse the existing live Breathe London transformation and mapping logic where practical
- Transform historical source data into the same canonical downstream shape expected by the UK AQ pipeline
- Then write outputs into the same normal R2 format as if the data had been ingested and processed normally
- Do not introduce a special Breathe London backfill format
- Preserve alignment with existing connector conventions and downstream expectations

### 9. Retention / output behavior

- Follow the current backfill framework behavior and conventions as closely as possible
- Preserve the established project approach around retention and history output rather than inventing a new connector-specific rule set
- The important requirement is that historical backfill produces the same normal expected R2 output shape

### 10. API safety

- Be conservative with request pacing and concurrency
- Use a low initial concurrency, ideally one in-flight work unit at a time unless existing framework behavior already constrains this appropriately
- Avoid broad requests when site-specific requests are available
- Keep rate-limit / quota safety in mind even if the API does not document a detailed public rate-limit header scheme
- Prefer deterministic, resumable day-by-day, site-by-site fetching over large historical sweeps

### 11. Logging, checkpoints, and reporting

- Follow existing backfill logging and progress reporting patterns as closely as possible
- Make logs clear enough to show:
  - target day
  - site code / site being processed
  - whether output was skipped due to `force_replace=false`
  - whether output was processed and written successfully
  - any failures
- Reuse existing checkpoint / ledger patterns where practical rather than inventing a disconnected Breathe London-only mechanism

### 12. Code reuse

- Reuse existing Breathe London live ingest logic wherever practical rather than duplicating complex fetch / parse / mapping behavior
- Reuse existing backfill patterns for day loops, overwrite/skip logic, logging, checkpoints, and output writes
- Keep the implementation as small and consistent as possible while still being clean

### 13. Naming / consistency

- Use current backfill naming and current function/flow names
- Keep comments accurate and current
- Avoid stale references to older naming where current naming differs

## What I want changed

- Update the backfill worker and any closely related supporting files needed to add the Breathe London connector
- Update the calling/orchestration path so the same style of backfill invocation works for this connector
- Add or update any helper functions needed for:
  - day-by-day Breathe London backfill execution
  - site-by-site `/SensorData` historical fetches
  - reuse of existing live connector logic for historical windows
  - writing normal UK AQ R2 outputs
- Keep changes focused and scoped

## Constraints

- Do not redesign the entire backfill framework
- Do not create a second historical output format
- Do not duplicate large chunks of existing Breathe London live-ingest logic unless necessary
- Do not switch to borough-wide or broad geo historical pulls in phase 1 when `SiteCode` gives cleaner deterministic work units
- Do not over-query the external API unnecessarily

## Please do the following in your response

1. Briefly summarize the implementation plan
2. List the files you changed
3. Explain any env vars added or reused
4. Explain which parts of the existing Breathe London live-ingest logic were reused
5. Flag any places where backfill needed a nearest-equivalent behavior rather than direct reuse
