# Addendum: direct TEST cutover with no legacy metadata compatibility

**Date:** 17 July 2026  
**Status:** Supersedes the dual-read and rollback-window parts of the original plan  
**Recommended Codex model:** **GPT-5.6 Sol, High reasoning**

## Decision change

The migration will no longer keep the cumulative v2 per-timeseries metadata index as a compatibility path.

Retire this active index immediately during the binding implementation:

```text
history/_index_v2/timeseries/timeseries_id=<id>.json
```

Replace it with:

```text
history/_index_v2/timeseries_binding/timeseries_id=<id>.json
```

There will be:

- no dual-read period;
- no legacy R2 metadata fallback;
- no legacy metadata feature flag;
- no continued cumulative metadata generation;
- no `timeseries_metadata_v2` entry in the active Dropbox inventory;
- no requirement to preserve the legacy index for backwards compatibility.

The existing Supabase connector lookup may remain as a separate last-resort fallback if it is already part of the current API contract. This decision only removes fallback to the cumulative R2 metadata index.

## Revised implementation scope

Codex Phase 1 must now implement the complete active cutover, not an additive compatibility phase.

### Required active read path

```text
connector_id supplied by caller
        |
        v
use request connector_id directly
```

When `connector_id` is absent:

```text
R2 timeseries binding
        |
        +--> found: use binding.connector_id
        |
        +--> missing: existing Supabase lookup, only if that fallback remains part of the current contract
```

The proxy must never call:

```text
/v1/timeseries-metadata
```

### Required active write path

Daily and full v2 index updates must continue writing:

```text
history/_index_v2/observations_timeseries/
history/_index_v2/aqilevels_hourly_data_timeseries/
```

They must stop writing:

```text
history/_index_v2/timeseries/
```

Bindings must be derived separately from the authoritative core snapshot. Prune daily must not create or update bindings.

### Required backup behaviour

The active v2 backup inventory must include:

```text
timeseries_binding_v2
```

and must exclude:

```text
timeseries_metadata_v2
```

Existing legacy checkpoint entries may remain harmlessly in the checkpoint JSON, but active inventory planning and copying must ignore them. Do not spend implementation time building a backwards-compatible migration for unused checkpoint entries unless the current parser would otherwise fail structurally.

### Required code retirement

Remove active uses of:

```text
buildR2HistoryV2TimeseriesMetadataIndexKey
buildHistoryV2TimeseriesMetadataIndexPayload
extractHistoryV2TimeseriesMetadataEntry
mergeHistoryV2TimeseriesMetadataEntries
updateR2HistoryV2TimeseriesMetadataIndexesTargeted
rebuildR2HistoryV2TimeseriesMetadataIndexes
timeseriesMetadataMode
UK_AQ_R2_HISTORY_V2_TIMESERIES_METADATA_INDEX_PREFIX
/v1/timeseries-metadata
timeseries_metadata_v2
```

Functions may be deleted immediately when no active code or focused local check requires them. There is no need to retain dead compatibility code in active paths.

## Revised deployment and cleanup order

Because this is the TEST system, use a direct cutover:

1. Implement the stable binding publisher and binding endpoint.
2. Remove all active cumulative metadata readers and writers in the same branch.
3. Change the backup inventory from `timeseries_metadata_v2` to `timeseries_binding_v2`.
4. Deploy the binding publisher or reconciliation command.
5. Backfill TEST bindings.
6. Deploy the observations history Worker and cache proxy.
7. Deploy prune/index and backup changes.
8. Exercise normal TEST website chart requests.
9. Run one normal TEST prune-daily operation.
10. Run the TEST Dropbox backup.
11. After those operations succeed, delete:
    ```text
    R2:      history/_index_v2/timeseries/
    Dropbox: the mirrored history/_index_v2/timeseries/ tree
    ```

The deletion command must still default to dry-run and report key count and total bytes before execution. This is operational safety, not backwards compatibility.

## Minimal pre-deployment checks

Keep local checking narrow:

- changed files parse and type-check;
- stable binding payload is deterministic;
- explicit `connector_id` bypasses binding lookup;
- missing `connector_id` uses the binding route;
- no active code references `/v1/timeseries-metadata`;
- prune/index code no longer calls cumulative metadata builders;
- active backup inventory includes bindings and excludes legacy metadata.

Do not create a broad speculative test suite.

Functional validation happens after deployment through real TEST operations:

- representative website charts;
- one controlled request without `connector_id`;
- one prune-daily run;
- one Dropbox backup;
- confirmation that adding a day changes zero binding files unless core mappings changed.

## Revised Codex instruction for work already in progress

Send this instruction to the Codex task currently implementing Phase 1:

```text
Change of plan for the Phase 1 work currently in progress.

Use GPT-5.6 Sol with High reasoning.

This is a TEST-only direct cutover. Do not implement dual-read compatibility for the old cumulative timeseries metadata index.

Retire this active index now:

history/_index_v2/timeseries/timeseries_id=<id>.json

Replace it with:

history/_index_v2/timeseries_binding/timeseries_id=<id>.json

Update your current implementation as follows:

1. Do not keep or add a legacy R2 metadata fallback.
2. Do not add UK_AQ_TIMESERIES_LEGACY_METADATA_FALLBACK_ENABLED.
3. The cache-proxy lookup order must be:
   - request connector_id;
   - R2 timeseries binding;
   - existing Supabase lookup only if it remains part of the current API contract.
4. Remove active calls to /v1/timeseries-metadata.
5. Remove /v1/timeseries-metadata from the active observations history Worker routes.
6. Stop targeted and full v2 index updates from building cumulative per-timeseries metadata.
7. Remove cumulative metadata from prune-daily warnings, verification and completion dependencies.
8. Keep observations_timeseries and aqilevels_hourly_data_timeseries unchanged.
9. Bindings must be derived from the authoritative core snapshot and must not be written by prune daily.
10. Replace timeseries_metadata_v2 with timeseries_binding_v2 in the active Dropbox inventory immediately.
11. Existing legacy checkpoint fields may be ignored if they do not break parsing. Do not add compatibility machinery solely to preserve unused checkpoint entries.
12. Remove legacy cumulative metadata functions, environment variables, help text, tests and documentation where they are no longer referenced.
13. Add a dry-run-first cleanup command or exact manual command for deleting the legacy R2 and Dropbox trees after the first successful TEST chart, prune and backup operations.
14. Keep pre-deployment checks minimal and local. Functional validation happens through real TEST operations after deployment.

Before editing any newly affected file, follow the AGENTS.md archive requirement.

Do not deploy or delete cloud objects. Provide exact manual deployment, backfill, validation and cleanup commands.
```

## Effect on the original phases

The original Phase 0 audit remains useful.

The original Phase 1 and Phase 3 are merged into one implementation phase:

```text
binding creation + active cutover + legacy code retirement
```

The original Phase 2 remains the real TEST operational validation stage.

The original Phase 4 is reduced to immediate post-validation deletion of the old R2 and Dropbox object trees. There is no extended rollback window.
