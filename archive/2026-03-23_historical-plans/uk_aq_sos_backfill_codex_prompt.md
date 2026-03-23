# UK AQ SOS Backfill Codex Prompt

Please extend the UK AQ backfill functionality to support `connector_id=1`, which is the UK Gov SOS / REST API connector (AURN and related UK-AIR SOS stations).

## Goal

- Add `connector_id=1` to the existing backfill framework.
- The backfill calling script should accept the same style of variables and behavior already used by the current backfill connectors.
- Reuse the existing live SOS/REST ingest logic as much as practical, rather than inventing a separate historical implementation.

## Locked requirements

- Connector to add: `connector_id=1`
- Source path for this connector: UK Gov SOS / REST API
- This is the same source family already used for live ingest, so historical backfill should reuse the same core fetch / parse / mapping logic where practical
- The calling script should support the same style of date-range inputs as existing backfill connectors:
  - UTC start day
  - UTC end day
  - inclusive range
  - if start and end are the same date, process one day only
- Support `UK_AQ_BACKFILL_FORCE_REPLACE=true|false`
- Match existing backfill framework behavior and conventions as closely as practical
- Output must be processed into the normal UK AQ R2 format, matching normal ingest/processing output
- Do not create a connector-specific backfill-only R2 format

## Important context

- Live ingest for this connector is already working through the SOS / REST path
- This work should mostly be about wiring the same logic into the backfill framework for historical date ranges
- Prefer reuse of existing connector-specific logic over duplication
- Keep changes focused and minimal

## What I want implemented

### 1. Extend the backfill connector logic

- Add support for `connector_id=1` to the backfill worker / orchestration flow
- Wire it into the same overall framework style as the existing backfill connectors
- Reuse day-loop, overwrite/skip, logging, checkpoint, and R2 write conventions where practical

### 2. Calling script compatibility

- Ensure the backfill calling script can invoke this connector using the same style of variables as the other backfill connectors
- Same date-range semantics
- Same force-replace semantics
- Same operator experience as far as practical

### 3. Historical fetch path

- Use the existing SOS / REST connector logic as the source of truth for fetching and parsing data
- Adapt that logic so it can run historically over a UTC date range rather than only live/current operation
- Avoid unnecessary reimplementation if the live connector already has suitable fetch and transform helpers
- Keep the implementation clean and explicit about date windows

### 4. Candidate station / timeseries handling

- Reuse the existing SOS / REST station and timeseries mapping logic already present in the repo
- Use the same connector-specific station/timeseries relationships already established for live ingest
- Avoid introducing a second incompatible discovery/mapping approach
- Only fetch what is actually needed for the requested backfill range

### 5. Work unit behavior

- The requested run should accept start and end UTC day
- Process the range day-by-day, one day at a time
- Within each day, use the existing SOS/REST fetch logic to retrieve the needed measurements for that connector/day
- Keep execution ordering simple and deterministic

### 6. Force replace behavior

- Support `UK_AQ_BACKFILL_FORCE_REPLACE=true|false`
- Match current backfill semantics as closely as possible
- If `false`, skip already-produced outputs using the same style of decision logic as the existing framework
- If `true`, rebuild/replace for the relevant connector/day outputs in the same style as the current framework

### 7. Processing and transformation

- Reuse the existing live SOS / REST transformation and mapping logic where practical
- Transform historical source data into the same canonical downstream shape expected by the UK AQ pipeline
- Then write outputs into the same normal R2 format as if the data had been ingested and processed normally
- Do not introduce a special SOS backfill format
- Preserve alignment with existing connector conventions and downstream expectations

### 8. Retention / output behavior

- Follow the current backfill framework behavior and conventions as closely as possible
- Preserve the established project approach around retention and history output rather than inventing a new connector-specific rule set
- The important requirement is that historical backfill produces the same normal expected R2 output shape

### 9. Logging, checkpoints, and reporting

- Follow existing backfill logging and progress reporting patterns as closely as possible
- Make logs clear enough to show:
  - target day
  - `connector_id=1`
  - station / timeseries or fetch unit being processed
  - whether output was skipped due to `force_replace=false`
  - whether output was processed and written successfully
  - any failures
- Reuse existing checkpoint / ledger patterns where practical rather than inventing a disconnected SOS-only mechanism

### 10. Code reuse

- Reuse existing SOS / REST live ingest logic wherever practical rather than duplicating complex fetch / parse / mapping behavior
- Reuse existing backfill patterns for day loops, overwrite/skip logic, logging, checkpoints, and output writes
- Keep the implementation as small and consistent as possible while still being clean

### 11. Naming / consistency

- Use current backfill naming and current function/flow names
- Keep comments accurate and current
- Avoid stale references to older naming where current naming differs

## What I want changed

- Update the backfill worker and any closely related supporting files needed to add `connector_id=1`
- Update the calling/orchestration path so the same style of backfill invocation works for this connector
- Add or update any helper functions needed for:
  - day-by-day SOS/REST backfill execution
  - reusing existing live connector fetch logic for historical windows
  - writing normal UK AQ R2 outputs
- Keep changes focused and scoped

## Constraints

- Do not redesign the entire backfill framework
- Do not create a second historical output format
- Do not duplicate large chunks of SOS live-ingest logic unless necessary
- Do not add unnecessary new discovery logic if the existing connector mapping already supports the needed fetches
- Do not over-query external systems unnecessarily

## Please do the following in your response

1. Briefly summarize the implementation plan
2. List the files you changed
3. Explain any env vars added or reused
4. Explain which parts of the existing SOS / REST live-ingest logic were reused
5. Flag any places where backfill needed a nearest-equivalent behavior rather than direct reuse

