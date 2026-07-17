# Latest snapshot validation

## Validation principle

Latest Snapshot runs on the UK AQ TEST system. Pre-deployment validation must remain deliberately small so functional validation happens through the real deployed pipeline.

Follow `AGENTS.md`:

- perform as little pre-deployment testing as reasonably possible;
- run only the smallest structural or syntax/type check needed;
- do not create new automated tests by default;
- add a targeted deterministic check only for a specific high-risk regression that is difficult to detect through normal TEST operation;
- do not run broad suites, exhaustive edge cases, shadow comparisons or soak tests unless explicitly requested.

For a reversible Latest Snapshot change, one successful normal operation and one representative output check are generally sufficient.

## Structural review before implementation

Confirm only the dependencies that could make the proposed structure invalid.

For the current all-only and warm-cache architecture, the load-bearing structural checks are:

- no active consumer requires finite physical objects;
- the physical manifest is treated as a stored-product manifest rather than a public request catalogue;
- the cache proxy and website continue forwarding the same public window parameter;
- the Worker can read and parse the pollutant's physical `all` payload within its runtime limits;
- state, Pub/Sub acknowledgement and metadata ordering are not accidentally changed;
- the long-running parent and per-invocation child share the same container filesystem;
- `/tmp` is available under the existing child permissions;
- R2 remains part of every local-cache reuse decision;
- no active consumer requires a successful scheduled `_runs` object every minute.

Do not inspect archive code as an active dependency.

## Minimal pre-deployment checks

Use only:

- syntax or type validation for changed files;
- workflow parsing where deployment configuration changed;
- at most one directly relevant existing fast check when genuinely useful.

A targeted state-transition check is justified only when the latest-current-value policy or state application ordering changes. The compact regression is:

```text
08:00  21.793  valid
09:00  -99     invalid
```

Required state:

```text
observed_at=08:00
value=21.793
```

A new broad cache test suite is not required. One narrow deterministic check may be justified only if a specific ETag, local-integrity or report-mode resolution risk cannot reasonably be confirmed through TEST operation.

Do not expand this into a broad API, cache, network or website test suite before deploying to TEST.

## Current architecture acceptance

### Physical builder product

A successful normal run must show:

- `success_count=3`;
- `failure_count=0`;
- `matrix.windows=["all"]`;
- three manifest entries;
- each object key ends with `window=all.json`;
- unchanged physical payloads continue skipping writes;
- no new metadata, timeout, overlap or R2 errors;
- dedicated Pub/Sub acknowledgement remains healthy.

### Representative finite response

One representative finite request, normally PM2.5 `3h`, is sufficient unless it exposes a problem.

Confirm:

- HTTP `200`;
- `X-UK-AQ-Snapshot-Contract: v2` is accepted through the normal path;
- top-level and row field names remain unchanged;
- every returned row has a parseable `last_value_at` within the inclusive cutoff from the start of the current UTC minute;
- `count` matches returned data;
- `next_since` and `next_since_id` match the newest returned timestamp and tie-break ID;
- the response uses a derived finite ETag.

Do not compare every pollutant and every public window unless the representative check identifies a defect.

### `window=all`

When specifically relevant, confirm that `window=all` is served from the physical object and retains its physical ETag. A separate all-response check is not required for every reversible change.

### Website output

Load the normal TEST map or station search once and confirm Latest Snapshot data displays. Do not run broad browser automation or a manual regression programme by default.

## Latest-valid state acceptance

When state policy or recovery is in scope, confirm only the affected behaviour:

- raw invalid observations remain retained by the raw-data path;
- invalid pollutant values do not create or replace latest state;
- zero remains valid;
- the previous valid row remains in the physical `all` object;
- finite public windows use that valid row's timestamp;
- decoded invalid messages are acknowledged after handling;
- the public response does not emit an invalid current value.

The historical Manchester Piccadilly identity may be used as a concrete diagnostic example, but it is not a mandatory repeated test for unrelated changes.

## Warm local-cache acceptance

The local cache is acceptable when all of the following remain true:

- a cold start or missing entry uses R2 and may populate local files;
- a later child in the same warm container can report at least one `warm_hit`;
- every warm hit followed successful R2 ETag validation;
- an R2 ETag mismatch falls back to R2 GET and refreshes the local entry;
- missing, corrupt or invalid local files are ignored;
- metadata freshness still uses the durable payload's `generated_at` and configured refresh interval;
- state and manifest local copies are updated only after successful R2 PUTs;
- local write failures are warnings and do not advance acknowledgement or replace R2 failure handling;
- disabling the feature returns to direct R2 loading without a migration;
- generated state, manifest and public bytes remain unchanged for identical input.

### Minimal deployed check

For this TEST system, the normal validation is:

1. first invocation after a new revision may show cold misses;
2. confirm the normal physical build still succeeds;
3. observe one later invocation handled by the same warm container and confirm a validated warm hit;
4. make one representative public or website check.

A cold miss caused by a real container replacement is expected and not a defect. Do not run a soak period merely to increase the hit count.

### Cache telemetry

Inspect the `local_cache` object in `latest_snapshot_job_summary`:

```text
enabled
cache_dir
disabled
cold_miss
warm_hit
fingerprint_mismatch
corrupt
validation_error
write_failure
skipped_missing_etag
```

One compact summary per completed run is sufficient. Do not require per-object success logs.

Persistent `corrupt`, `validation_error`, `write_failure` or `skipped_missing_etag` counts merit investigation. A single cold miss does not.

## Run-report policy acceptance

With the default `failures` mode:

- a successful scheduled run writes no new `_runs` object;
- the structured `latest_snapshot_job_summary` remains present;
- the physical manifest remains current;
- `run_reports.mode` is `failures`;
- `run_reports.write` is `false`;
- `run_reports.reason` is `scheduled_success`.

Additional mode expectations:

- `all` preserves one report for every completed run;
- `off` writes no run-report objects;
- an explicit invalid mode fails clearly;
- the legacy boolean is used only when the new mode is absent;
- legacy `true` maps to `all` and `false` maps to `off`;
- a completed manual run in `failures` mode remains reportable;
- a completed build with failed matrix items in `failures` mode remains reportable;
- report creation does not determine build or manifest success.

Do not deliberately cause a data or service failure merely to verify failure reporting. The scheduled-success path is the required operational check. A single successful manual report check is optional when straightforward.

## Public response cache validation

Finite response identity changes with:

- source physical ETag;
- requested window;
- effective UTC minute.

A matching `If-None-Match` may return `304`. Test this only when public ETag or conditional-request code changes.

The builder's local R2 cache uses the current durable object's ETag for validation. This is a separate internal concern and does not change public finite-response ETag rules.

## Failure and rollback validation

### Warm-cache and report amendment

The configuration-only rollback is:

```text
UK_AQ_LATEST_SNAPSHOT_LOCAL_CACHE_ENABLED=false
UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_MODE=all
```

After redeployment, confirm one normal build and one representative public request. No state, R2 product or local-file migration is required.

### All-only architecture

When both the deriving Worker and builder change, deploy the Worker first and the builder second.

If rollback is required after both are deployed:

1. roll back the builder so finite objects resume updating;
2. roll back the Worker;
3. make one representative public request.

Do not modify latest state or raw observations for an architecture rollback.

## Current TEST status

The all-only builder and deriving R2 API Worker were deployed and confirmed running successfully on TEST on 17 July 2026.

The ETag-validated warm local cache and failures-by-default run-report policy were implemented in commit `1557133debc6d8ab426eb55bce9043bca2a5ff55` and reported complete on TEST on 17 July 2026.

## Acceptance criteria

The system conforms to this documentation when:

1. latest-valid state rules remain intact;
2. R2 remains durable authority for state, metadata cache and manifest;
3. local reuse requires valid local JSON and SHA-256 plus a matching current R2 ETag;
4. cold, corrupt, mismatched or disabled local entries use the direct R2 path;
5. durable writes finish before local write-through;
6. the builder stores only three physical `window=all` objects;
7. the physical manifest contains only those three entries;
8. the default report mode skips successful scheduled `_runs` objects while keeping structured summaries;
9. the API continues accepting `3h`, `6h`, `1d`, `7d` and `all`;
10. finite responses derive from `last_value_at` at the UTC-minute cutoff;
11. finite order, counts and cursors are correct;
12. finite ETags are time-aware;
13. public v2 fields, route and query parameters remain unchanged;
14. Pub/Sub acknowledgement and normal scheduled operation remain healthy;
15. one representative website output works;
16. no broad or speculative testing is required unless a real problem is found.
