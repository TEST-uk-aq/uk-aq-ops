# Legacy v2 observation manifest compatibility

This document supplements `system_docs/r2_history/integrity.md` for metadata-only repair of early v2 observation manifests. It does not permit legacy data rewrites or broaden the active Integrity pollutant scope.

## Supported compatibility case

The compatibility path applies only when a selected day contains an early v2 observations connector manifest whose child manifests use `pollutant=<legacy-code>` paths instead of the current `pollutant_code=<canonical-code>` manifest paths.

The connector identity must be proven before any compatibility object is staged:

- the object itself is read from the exact expected connector manifest path;
- `history_version`, `domain`, `manifest_kind`, `day_utc` and numeric `connector_id` match that path and the requested repair scope;
- when the early manifest has no `manifest_key`, its `current_prefix` must exactly match the connector prefix;
- every legacy pollutant child key must remain inside that same connector-day prefix;
- the child path code and declared pollutant code must resolve to the same canonical code.

A mismatch blocks the metadata proposal.

## Pollutant aliases

Aliases are explicit, not inferred by punctuation removal. The supported early Sensor.Community alias is:

- `pm2.5` to canonical `pm25`.

Equivalent recorded forms `pm2_5`, `pm 2.5` and `pm₂.₅` resolve to the same canonical code. Unknown or conflicting aliases block repair.

## Canonical reconstruction

For each compatible legacy pollutant child, Integrity:

1. reads the immutable Parquet objects from the chosen Dropbox baseline;
2. derives row counts, object bytes and SHA-256, timeseries ranges, timestamp ranges and per-timeseries counts from those Parquet objects;
3. builds a canonical `pollutant_code=<canonical-code>/manifest.json` with the authoritative v2 manifest builder;
4. stages that manifest in the sparse local overlay as its own proposal;
5. rebuilds the connector manifest from the final validated pollutant child set;
6. rebuilds the day manifest from the final connector child set.

The existing Parquet objects remain at their baseline keys. This compatibility path does not rewrite, relocate, delete or tombstone observation data.

The proposal order is pollutant manifests, connector manifest, then day manifest. The real repair remains subject to the normal canonical apply and GET-verification contract.

## Fail-closed conditions

Compatibility must block when any required connector or pollutant identity is uncertain, a legacy child escapes the connector scope, a canonical alias is unknown or ambiguous, required Parquet is absent or unreadable, derived Parquet metadata is inconsistent, or the final connector/day hierarchy cannot preserve every baseline Parquet object and declared child.
