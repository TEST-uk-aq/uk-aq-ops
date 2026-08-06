# R2 v2 hierarchical backup runbook

## Purpose

This runbook implements the contract-backed hierarchical v2 backup inventory for TEST.

The long-term inventory covers:

- observation history through root -> year -> month -> day manifests;
- timeseries-binding objects through stable 1,000-ID inventory ranges;
- small global units such as observation run manifests.

The physical timeseries-binding objects remain unchanged at:

```text
history/_index_v2/timeseries_binding/timeseries_id=<id>.json
```

Only the backup inventory groups those objects into stable ranges.

## Inventory paths

```text
history/_index_v2/backup_inventory_v2/root.json
history/_index_v2/backup_inventory_v2/observations/year=YYYY/month=MM.json
history/_index_v2/backup_inventory_v2/timeseries_binding/root.json
history/_index_v2/backup_inventory_v2/timeseries_binding/range=000000-000999.json
history/_index_v2/backup_inventory_v2/timeseries_binding/range=001000-001999.json
...
history/_index_v2/backup_inventory_v2/global/observation_run_manifests.json
```

The fixed binding range size is 1,000 IDs. Range boundaries must not change without a separately documented migration.

## Observations traversal

The root follows the authoritative observations aggregate hierarchy:

```text
history/v2/observations/_manifests/manifest.json
  -> year manifests
    -> month manifests
      -> existing day manifests
```

The monthly inventory shard records both the authoritative day `manifest_hash` and the physical SHA-256 of the day manifest file.

Normal inventory runs compare the observations root hash first. Unchanged years and months are skipped.

## Timeseries-binding traversal

The builder lists the current binding objects under:

```text
history/_index_v2/timeseries_binding
```

Each binding is assigned to a fixed range. A range shard records:

- range start and end;
- each `timeseries_id`;
- source relative path;
- source file SHA-256;
- source size;
- R2 MD5 and modification-time metadata when available;
- the stable logical `source_range_hash` for the complete current range.

The binding inventory root records all current ranges and derives one stable `source_root_hash` from those range identities.

On a normal run, existing unit hashes are reused when R2 metadata still matches. On the first hierarchical binding build, the builder can adopt matching identities from the legacy flat inventory `history/_index_v2/backup_inventory_v2.json`, avoiding unnecessary re-reading of every binding object.

`--full-scan` deliberately disables metadata reuse and independently hashes all binding objects.

## Dropbox state layout

The final matching Dropbox checkpoint layout is:

```text
_ops/checkpoints/r2_history_backup_state_v2/root.json
_ops/checkpoints/r2_history_backup_state_v2/observations/year=YYYY/month=MM.json
_ops/checkpoints/r2_history_backup_state_v2/timeseries_binding/range=000000-000999.json
_ops/checkpoints/r2_history_backup_state_v2/timeseries_binding/range=001000-001999.json
...
_ops/checkpoints/r2_history_backup_state_v2/global/observation_run_manifests.json
```

Observation monthly state shards record individual completed day identities. Binding range state shards record individual copied binding identities and only advance `processed_source_range_hash` once every required binding in that range is complete.

The Dropbox sync implementation is the next stage. The inventory and state helper primitives already use the final range paths and fixed range size.

## Initial TEST inventory build

The observations hierarchy has already been full-scan validated. After deploying the binding-range code, run a normal inventory build first so matching binding identities can be adopted from the existing legacy inventory:

```bash
mkdir -p tmp logs

node scripts/backup_r2/build_hierarchical_backup_inventory_v2.mjs \
  --source-root "uk_aq_r2_test:uk-aq-history-cic-test" \
  --report-out "tmp/r2_hierarchical_inventory_v2_report.json" \
  2>&1 | tee "logs/r2_hierarchical_inventory_v2.log"
```

Expected binding report behaviour on the first run:

- `previous_unit_source` is `legacy` when legacy binding identities are available;
- most or all unchanged bindings are counted in `reused_from_legacy`;
- one inventory range shard is created for each populated 1,000-ID range;
- `timeseries_binding/root.json` is created;
- the top-level `root.json` is rewritten last to reference the binding root and ranges.

## Subsequent normal inventory runs

Use the same command without `--full-scan`.

A normal unchanged run should:

- skip unchanged observation years and months;
- list binding metadata but reuse unchanged binding hashes;
- read and hash only binding objects whose metadata changed;
- leave unchanged range shards byte-stable;
- leave the binding inventory root and top-level root unchanged when no binding identity changed.

## Explicit full scan

Use only for an independent audit or recovery:

```bash
node scripts/backup_r2/build_hierarchical_backup_inventory_v2.mjs \
  --source-root "uk_aq_r2_test:uk-aq-history-cic-test" \
  --full-scan \
  --report-out "tmp/r2_hierarchical_inventory_v2_full_scan.json"
```

This independently reads all committed observation day manifests and all timeseries-binding objects rather than trusting metadata reuse.
