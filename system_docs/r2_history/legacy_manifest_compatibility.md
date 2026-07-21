# Early v2 observation manifest compatibility

This document supplements `system_docs/r2_history/integrity.md` for metadata-only repair of early v2 observation manifests. It does not permit observation-data rewrites or broaden the active Integrity pollutant scope.

## Supported compatibility cases

The compatibility path is limited to two early v2 shapes:

1. connector children stored under `pollutant=<legacy-code>` instead of `pollutant_code=<canonical-code>`;
2. children already stored under the canonical `pollutant_code=<canonical-code>` path but missing only the current explicit observation-manifest metadata fields.

For the second case, compatibility is permitted only when strict validation fails exclusively for:

- `grain_not_explicit_null`;
- `profile_not_explicit_null`;
- `timeseries_row_counts_not_object_or_null`.

Any additional schema, identity, hash or value failure remains blocked.

## Identity requirements

The connector identity must be proven before any compatibility object is staged:

- the object is read from the exact expected connector manifest path;
- `history_version`, `domain`, `manifest_kind`, `day_utc` and numeric `connector_id` match that path and requested repair scope;
- when an early connector manifest has no `manifest_key`, its `current_prefix` must exactly match the connector prefix;
- every pollutant child key remains inside that connector-day prefix;
- the child path code and declared pollutant code agree;
- canonical child manifests have the exact expected `manifest_key`, day, connector and pollutant identity.

Early connector manifests may record the same child in both `pollutant_manifests` and `child_manifests`. Compatibility treats those entries as one child only when their exact `manifest_key` and normalised `pollutant_code` agree. The same key with different pollutant identities blocks immediately. The same pollutant identity on different keys is not deduplicated and remains subject to downstream conflict detection.

A mismatch blocks the metadata proposal.

## Pollutant aliases

Aliases are explicit, not inferred by punctuation removal. The supported early Sensor.Community alias is:

- `pm2.5` to canonical `pm25`.

Equivalent recorded forms `pm2_5`, `pm 2.5` and `pm₂.₅` resolve to the same canonical code. Unknown, conflicting or mixed legacy/canonical child layouts block repair.

## Canonical reconstruction

For each compatible child, Integrity:

1. reads the immutable Parquet objects from the chosen Dropbox baseline;
2. derives row counts, object bytes and SHA-256, timeseries ranges, timestamp ranges and per-timeseries counts from those Parquet objects;
3. builds the canonical pollutant manifest with the authoritative v2 manifest builder;
4. stages that manifest in the sparse local overlay as its own proposal;
5. forces the connector manifest to be rebuilt from the final validated pollutant child set;
6. rebuilds the day manifest from the final connector child set.

For a legacy path, the proposal uses the canonical `pollutant_code=<canonical-code>/manifest.json` key. For an early canonical path, the proposal replaces only that manifest at its existing canonical key.

The existing Parquet objects remain at their baseline keys. Compatibility does not rewrite, relocate, delete or tombstone observation data.

The proposal order is pollutant manifests, connector manifest, then day manifest. A real repair remains subject to canonical apply and GET verification.

## Fail-closed conditions

Compatibility blocks when any connector or pollutant identity is uncertain, a child escapes the connector scope, an alias is unknown or ambiguous, legacy and canonical declarations are mixed, required Parquet is absent or unreadable, derived metadata is inconsistent, an early canonical child has failures beyond the three permitted compatibility fields, or the final hierarchy cannot preserve every baseline object and declared child.
