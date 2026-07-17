# AQI levels validation

## Validation principle

The active AQI levels system runs through the TEST environment. Pre-deployment validation must remain deliberately small and must not delay functional testing through the real deployed pipeline.

Before deployment, perform only:

1. structural confirmation that every changed producer and consumer preserves the authoritative contract;
2. basic syntax or type validation for changed files;
3. compact deterministic checks for the specific AQI behaviour being changed.

Functional validation happens after deployment through real TEST operation using Prune Daily, the private R2 API Worker, the private station-history Worker, the cache proxy, R2 and the website chart.

Do not create or run a broad speculative pre-deployment test suite.

## Pre-implementation structural review

Before changing AQI calculation, timestamp handling, R2 storage, API projection or chart rendering, confirm that the proposed implementation can preserve all of the following:

- `timestamp_hour_utc` remains the canonical interval endpoint;
- a row ending at `n` represents `(n - 1 hour, n]`;
- represented request interval `S` to `E` selects endpoints `S < n <= E`;
- R2 remains authoritative over live calculation for the same canonical row;
- PM DAQI rolling context remains 24 hourly values ending at `n`;
- European AQI remains independently available when PM DAQI has insufficient context;
- missing endpoints remain gaps rather than being forward-filled or back-filled;
- data and debug R2 profiles remain aligned;
- manifest and index rebuild ordering remains bottom-up;
- partial source or scan results remain explicitly partial;
- inactive daily and monthly roll-ups remain outside the active change unless separately approved.

For a website timestamp correction, confirm structurally that the API, station-history and both website renderers can be deployed with one coherent timestamp meaning. A single-component correction that leaves another component using the old meaning is not viable.

For a Prune Daily writer change, first check the deployed TEST values of:

```text
UK_AQ_R2_HISTORY_VERSION
UK_AQ_PHASE_B_CALCULATE_AQI_FROM_OBSERVATIONS_ENABLED
UK_AQ_PHASE_B_LEGACY_AQI_RPC_EXPORT_ENABLED
```

This targeted configuration check is required because workflow defaults can be overridden and the active writer branch changes which code path must be reviewed.

For arbitrary sub-hour source observations, verify the timestamp convention of each affected connector before changing hourly bucket assignment. Do not infer a universal floor or ceiling rule from the AQI endpoint contract alone.

## Compact deterministic checks

Use focused checks only for the behaviour changed. The following cases define the load-bearing timestamp and calculation boundaries.

### Hour-ending interval

Input row:

```text
timestamp_hour_utc = 2026-07-17T07:00:00Z
```

Required boundaries:

```text
period_start_utc = 2026-07-17T06:00:00Z
period_end_utc   = 2026-07-17T07:00:00Z
```

The renderer must draw exactly from 06:00 to 07:00.

It must not draw from 07:00 to 08:00.

### Request boundary

For represented interval:

```text
S = 2026-07-17T06:00:00Z
E = 2026-07-17T09:00:00Z
```

Required endpoints:

```text
07:00
08:00
09:00
```

The endpoint at 06:00 is excluded. The endpoint at 09:00 is included.

### Final coloured section

Given concentration and AQI rows whose final endpoint is 07:00:

- the concentration marker ends at 07:00;
- the DAQI colour ends at 07:00;
- the European AQI colour ends at 07:00;
- the area after 07:00 remains uncoloured.

### Missing hour

Given AQI endpoints at 07:00 and 09:00 with no row at 08:00:

- 06:00 to 07:00 may be coloured from the 07:00 row;
- 07:00 to 08:00 remains blank;
- 08:00 to 09:00 may be coloured from the 09:00 row;
- neither neighbouring row spans the missing interval.

### PM rolling context

For a PM endpoint `n`:

- 24 valid hourly means ending from `n - 23 hours` through `n` produce DAQI status `ok`;
- 23 valid hourly means produce DAQI status `insufficient_samples` and a null DAQI level;
- a valid hourly mean at `n` may still produce European AQI status `ok` in the 23-hour case.

### Source precedence

For the same canonical key:

- one R2 row and one matching live row produce one retained R2 row;
- one R2 row and one conflicting live row retain R2 and report the mismatch;
- an older history chunk cannot replace an accepted stable-head row.

### Midnight endpoint

For represented interval:

```text
2026-07-17T23:00:00Z to 2026-07-18T00:00:00Z
```

Required endpoint:

```text
2026-07-18T00:00:00Z
```

The active R2 storage lookup must include:

```text
day_utc=2026-07-18
```

### R2 hierarchy

For a targeted changed pollutant object:

- data and debug rows use the same canonical keys;
- pollutant manifests match final parquet content;
- connector manifests include the complete final pollutant set;
- day manifests include the complete final connector set;
- indexes are generated after manifests;
- unchanged index source content produces byte-identical index output.

Do not expand these checks into a broad suite of unrelated observation, cache, WHO, latest-snapshot or deployment tests.

## Minimal local checks

Run only checks relevant to changed files, such as:

- `node --check` or the existing module-equivalent syntax check;
- `deno check` for changed Deno or Worker files where applicable;
- the smallest existing focused test file covering the changed AQI helper, Worker boundary or R2 writer;
- one compact deterministic regression for the exact timestamp or calculation boundary changed.

Do not run broad repository suites, Supabase queries, R2 writes, backfills, Cloudflare deployments, website automation or external API fetches before deployment unless a specific structural risk genuinely requires one targeted check.

## Diff review before deployment

Compare the complete cross-repository diff with [`contract.md`](contract.md).

Confirm there are no unintended changes to:

- breakpoint values or inclusivity;
- supported pollutants;
- DAQI or European AQI averaging codes;
- PM rolling source count;
- algorithm version;
- canonical row identity;
- R2 data or debug columns;
- R2 prefixes and manifest hierarchy;
- required-index fail-bounded behaviour;
- source precedence;
- completeness fields;
- private authentication;
- station-history privacy and Service Binding;
- cache TTLs or feature flags;
- unrelated observation rendering;
- inactive daily or monthly roll-ups.

Once these minimal checks pass, deploy to TEST rather than adding speculative pre-deployment coverage.

## TEST deployment validation

Functional validation occurs through the real TEST pipeline.

## 1. Recent on-the-fly AQI

Choose one active timeseries for each supported pollutant.

Confirm:

- authoritative connector, station and pollutant identity resolve;
- the direct ingest read covers the reported interval or the response is correctly marked incomplete;
- on-the-fly rows use endpoint timestamps;
- PM rows show the expected rolling source count;
- DAQI and European AQI statuses are independently correct;
- no negative source values contribute;
- source diagnostics contain no unexpected identity conflicts.

## 2. R2/live stable head

Use a request spanning committed R2 AQI and recent live calculation.

Confirm:

- R2 rows remain source `r2`;
- live rows occur only for R2-missing eligible endpoints;
- overlap counts are plausible;
- mismatches are reported and R2 is retained;
- no seam endpoint is omitted or duplicated;
- expected endpoint selection follows `S < n <= E`;
- the response is cacheable only when complete.

## 3. Prune Daily historical output

After the normal TEST Prune Daily run processes a suitable closed day, confirm:

- the active writer branch is reported or otherwise identifiable;
- target-day AQI rows use the correct canonical endpoints;
- PM context comes from the required preceding endpoints;
- data and debug profile row counts and keys agree;
- calculation statuses and missing reasons are retained;
- pollutant, connector and day manifests exist and agree with child objects;
- targeted indexes reflect the committed rows; stable bindings are validated
  independently against the committed core snapshot;
- no unrelated observation deletion or history gate behaviour changed.

## 4. Private AQI History R2 API

For a known historical interval, confirm:

- the request resolves through the required timeseries index;
- scan budgets are not exceeded;
- the first and final endpoints match `S < n <= E`;
- explicit period boundaries match `(n - 1 hour, n]`;
- row source is `r2` for committed history;
- completeness is true only when every expected endpoint is present;
- a deliberately missing or inaccessible index produces structured partial behaviour rather than a broad scan.

## 5. Private station-history Worker

Confirm:

- `/v1/station-series` returns independent AQI and observation sections;
- older AQI chunks extend backwards only;
- a fresh stable head replaces only its own interval;
- older history cannot replace that head;
- partial AQI does not suppress valid observations;
- partial observations do not certify AQI completeness;
- no public route or custom domain has been introduced.

## 6. Cache proxy

Confirm:

- the expected station-history feature flags route to the private Worker;
- successful complete responses use the intended short cache policy;
- partial responses are not cached as complete;
- authentication, CORS and bypass behaviour are unchanged;
- no second public AQI calculation route was introduced.

## 7. Website loader and charts

Check both active station chart implementations.

For a visible row ending at `n`, confirm:

- the concentration point is plotted at `n`;
- the DAQI rectangle starts at `n - 1 hour` and ends at `n`;
- the European AQI rectangle starts at `n - 1 hour` and ends at `n`;
- the final rectangles line up with the final concentration endpoint;
- no colour extends one hour past the last value;
- a missing AQI hour remains blank;
- valid European AQI remains visible when PM DAQI is unavailable;
- changing chart range does not alter the interval meaning.

Repeat with an interval crossing UTC midnight.

## 8. Compatibility

Compare representative responses before and after deployment.

Confirm all unrelated fields and meanings remain unchanged, including:

- identity fields;
- DAQI and European AQI values and statuses;
- source and source-coverage fields;
- partial diagnostics;
- stable-head cursors;
- cache markers;
- observation rows and guideline data.

Where the timestamp response contract is deliberately corrected, confirm every deployed consumer uses the new unambiguous start/end semantics before considering the deployment complete.

## Acceptance criteria

An AQI timestamp and interval correction is complete only when:

1. `timestamp_hour_utc` remains the canonical endpoint;
2. every returned and rendered row represents `(n - 1 hour, n]`;
3. request interval `S` to `E` selects exactly `S < n <= E`;
4. the final coloured bands end at the final valid endpoint;
5. missing hours remain blank;
6. PM rolling context and source counts remain correct;
7. European AQI remains independent of PM DAQI completeness;
8. R2 remains authoritative over live calculation;
9. data and debug history remain aligned;
10. manifest and index hierarchy remains consistent and bounded;
11. partial sources remain explicitly partial and non-cacheable as required;
12. midnight endpoint rows are read from the correct endpoint-day partition;
13. raw observation history is unchanged;
14. daily and monthly roll-ups remain inactive unless separately approved;
15. both website chart implementations show the corrected interval with no unrelated regression.
