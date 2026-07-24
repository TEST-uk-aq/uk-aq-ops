# R2 history integrity

## Authority and scope

This document defines the required v2 Integrity detection, repair-planning and repair-execution contract. It supplements the stable binding-index contract and does not reintroduce retired cumulative timeseries metadata.

`scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity.py` is the orchestrator for the UK AQ history Integrity run.

Where active code differs from this document, this document is authoritative and the code must be brought into line before a real repair run.

## Supported pollutant scope

Active observation Integrity is limited to these four canonical pollutant codes:

- `pm25`
- `pm10`
- `no2`
- `o3`

This four-pollutant scope applies to observation detection, source comparison, repair planning, observation data repair, observation manifests and indexes, and final verification.

A connector is checked and repaired only for the pollutants in this list that it actually provides. A connector not providing one of the four pollutants is not itself an Integrity fault. For example, Sensor.Community may be repaired for `pm25,pm10` without being required to provide `no2` or `o3`.

Observation data for any other observed property that already exists in the Dropbox R2 mirror or live R2 is outside the active Integrity scope. Integrity MUST:

- ignore it during detection and source comparison;
- not create findings or repair actions for it;
- not require source completeness, mapping or canonical-row evidence for it;
- not allow it to block a repair of one or more of the four supported pollutants;
- not delete, rewrite or relocate it;
- preserve its existing canonical objects and existing parent-manifest child entries when rebuilding metadata for an affected connector-day.

Existing out-of-scope pollutant objects are opaque preserved baseline content. Integrity does not validate their Parquet bodies, counts or indexes. When parent metadata must be rebuilt, existing out-of-scope child entries and their recorded aggregate values are carried forward from the chosen Dropbox baseline. If that preservation cannot be proven structurally, the repair MUST block rather than broaden its deletion scope.

Integrity MUST NOT create new out-of-scope pollutant data.

AQI eligibility remains separate from observation Integrity scope. AQI rebuilds remain limited to `pm25`, `pm10` and `no2`. An `o3` observation repair or metadata-only finding does not queue AQI work.

## Supported runtime model

Run history Integrity from a complete `uk-aq-ops` repository checkout. The checkout location is operator-specific and is not part of the system contract.

A complete checkout is the only supported runtime model because the orchestrator uses shared source-adapter, R2 writer, manifest, index and observation-content-hash code from elsewhere in the repository. Do not copy a partial `bin/` or `env/` directory and do not rely on an undocumented runtime bundle.

`--history-version v2` is the only accepted history version. `v1` and `both` remain rejected. `--check-only` and `--run-backfill` are mutually exclusive.

Source, connector, day-range, pollutant and other scope filters MUST have the same meaning in every mode. Changing mode MUST NOT silently broaden the requested scope.

A destructive observation repair MUST use an explicit pollutant subset through `--repair-pollutants`. Accepted values are limited to `pm25`, `pm10`, `no2` and `o3`. The selected set passes unchanged through detection evidence, proposal generation, validation, tombstone planning, apply and final verification.

## Authoritative inputs

Integrity uses these inputs:

1. The relevant historical connector gateway or its existing local source cache for authoritative historical observations within the selected four-pollutant scope.
2. The Dropbox `R2_history_backup` mirror for the R2 v2 data, manifests and indexes being checked.
3. The committed v2 core snapshot in Dropbox for connector, station, timeseries and observed-property identity.
4. The local Integrity SQLite database for source state, findings, repair planning and audit evidence.

The authoritative R2 observation-content hash is stored in the v2 pollutant manifest in R2 and its Dropbox mirror. Integrity SQLite MUST NOT become a duplicate authoritative store for R2 observation-content hashes.

Source acquisition happens before comparison. When the required historical source file is already cached locally, Integrity reuses it. Otherwise the relevant source adapter fetches it. Source unavailability or an uncertain empty result blocks the affected selected-pollutant scope.

Source files MUST still be enumerated and identity-pinned sufficiently to prove that all rows for the selected pollutants were considered. Rows for other observed properties may be ignored after parsing and must not become selected-row blocking evidence.

### UK-AIR timestamp and annual-file boundary

UK-AIR annual CSV timestamps are hour-ending UTC timestamps.

The shared parser MUST apply these rules before day selection, mapping, counts, source evidence or hashing:

```text
23-07-2026 01:00 -> 2026-07-23T01:00:00.000Z
23-07-2026 23:00 -> 2026-07-23T23:00:00.000Z
23-07-2026 24:00 -> 2026-07-24T00:00:00.000Z
31-12-2025 24:00 -> 2026-01-01T00:00:00.000Z
```

Only exact `24:00` is accepted as an hour-24 value. Invalid variants such as `24:01`, `24:30` or `25:00` fail closed.

Rows are assigned to `day_utc` from the normalised UTC timestamp, not from the raw CSV date. For requested UTC day D, UK-AIR source discovery considers source dates D-1 and D. Therefore 1 January requires both the preceding year's annual file and the current year's annual file.

### UK-AIR CSV source-label registry

The Integrity SQLite database owns the approval registry for UK-AIR annual CSV headings. A heading is `mapped`, `ignore` or `review`. Only explicitly approved `mapped` labels with an explicit expected unit may target `pm25`, `pm10`, `no2` or observation-only `o3`. `ignore` labels are known non-target fields. Newly discovered labels are `review` and are skipped with an aggregated warning.

An automatic `mapped` decision is seeded only when exactly one active core mapping exists, it targets a supported pollutant and it supplies an explicit unit. Multiple active mappings require review. Previously seeded, unreviewed decisions that no longer meet these rules return to `review`, while operator-reviewed decisions are preserved.

A mapped registry decision is authoritative for heading-to-pollutant routing. An active matching core mapping is a consistency check, not a second approval. Python discovers cached headings, updates the registry and writes one immutable per-run snapshot for detector and proposal stages. The SOS flat-file worker never opens the Integrity SQLite database; non-SOS adapters neither receive nor load this snapshot.

For an approved mapped label, a source site/pollutant group with no authoritative active timeseries binding is warning-only and is skipped with `no_authoritative_timeseries_binding`. Integrity MUST NOT invent a station or timeseries identity. Those skipped rows are excluded consistently from canonical rows, expected totals, per-timeseries counts, observation-content hashes, Parquet, manifests and proposal-validation expectations while other valid groups continue.

Contradictory or ambiguous mappings, incompatible units and invalid selected canonical rows remain fail-closed. Unit evidence is validated per source column/header section. Zero target-day values need no target-day unit; blank target-day units are accepted only after compatible non-empty evidence exists in that same section.

## Verification status contract

Canonical R2 v2 observation rows contain a nullable string field named:

```text
verification_status
```

For UK-AIR SOS observations, the canonical values are:

```text
P = provisional
R = ratified
null = no source verification status supplied
```

UK-AIR SOS source values are normalised after trimming and case-insensitive comparison:

```text
null or blank -> null
P or Provisional -> P
R or Ratified -> R
```

Any other non-empty UK-AIR SOS status MUST fail closed for the affected selected source scope. It MUST NOT be silently mapped to provisional, ratified or null.

For connectors other than UK-AIR SOS, `verification_status` remains null unless that connector has a separately documented source field with equivalent provisional or ratified meaning. Operational sensor state, QA flags with different meanings and ingestion status MUST NOT be placed in this field.

Ratified observations are not immutable. A later change to a ratified concentration or a later change in verification status remains valid source correction evidence. It changes the observation-content hash and can trigger the normal complete pollutant-partition repair.

### Legacy read compatibility

During migration, readers and Integrity canonicalisation MUST resolve the status in this order:

1. canonical `verification_status` when present;
2. legacy nullable `status` when present;
3. otherwise null.

Legacy `status` is a read-compatibility alias only. New observation writers MUST emit `verification_status` and MUST NOT emit both fields.

A missing legacy status column and an explicit null status are semantically equivalent. Existing SOS partitions without preserved status may differ from authoritative UK-AIR source content and therefore require complete pollutant-partition repair. A non-SOS partition whose authoritative status is null does not require data replacement merely to add an all-null physical column when its canonical content otherwise agrees; it may use the legacy hashless metadata-adoption path.

## Operational environment

Integrity operational runs occur on the dedicated Integrity machine through its local `uk-aq-history-integrity.sh` dispatcher. It selects the repository and environment, then invokes the repository runner, which derives state and source-cache paths from the Integrity local root.

A VS Code development laptop is not a functional-test environment because Dropbox and source-cache files can be online-only placeholders. Functional validation, source scans and repair proposals run only on the dedicated Integrity machine.

Integrity detection and repair planning do not use live R2 as a comparison source.

## Observation content hash contract

### Purpose and scope

`observation_content_hash` is the authoritative deterministic digest of the logical observation content in one R2 v2 observation pollutant partition.

There is exactly one observation-content hash for each existing:

```text
day_utc + connector_id + pollutant_code
```

The hash covers all timeseries rows in that pollutant partition. There is no separate authoritative hash per timeseries, connector-day or day. Parent connector and day manifest identities change naturally because they include the changed pollutant manifest hash.

The hash is a logical content identity. It is not a hash of:

- Parquet bytes;
- compression settings;
- row-group layout;
- physical row order;
- file splitting;
- manifest formatting;
- run IDs or wall-clock timestamps.

### Manifest fields

Every non-empty v2 observation pollutant manifest MUST contain:

```json
{
  "observation_content_hash": "<64 lowercase hexadecimal characters>",
  "observation_content_hash_algorithm": "sha256",
  "observation_content_hash_contract_version": 1,
  "observation_content_hash_row_count": 1234,
  "observation_content_hash_columns": [
    "connector_id",
    "station_id",
    "timeseries_id",
    "pollutant_code",
    "observed_at_utc",
    "value",
    "verification_status"
  ],
  "verification_status_counts": {
    "P": 600,
    "R": 620,
    "null": 14
  }
}
```

`observation_content_hash_row_count` MUST equal the pollutant manifest `row_count` and the number of rows supplied to the hash helper.

`verification_status_counts` is derived from the same canonical row collection. Its `P`, `R` and `null` values MUST be non-negative integers and MUST sum exactly to `observation_content_hash_row_count`. The keys are fixed and always present in the order shown, including when one or more counts are zero.

The pollutant manifest's existing `manifest_hash` includes these fields. Connector and day manifests continue to reference child `manifest_hash` values. No separate R2 hash object or backup path is introduced.

### Shared helper ownership

Prune Daily and the Integrity source-to-R2 worker MUST use one shared implementation, expected at:

```text
workers/shared/uk_aq_observation_content_hash.mjs
```

The shared module owns the hash contract version, row normalisation, verification-status normalisation, canonical encoding, ordering, status counts and SHA-256 calculation. Neither writer may copy or independently reimplement the algorithm.

The shared function should be exported with an explicit name such as:

```text
computeObservationContentHash(rows)
```

It returns the hash, algorithm, contract version, row count, canonical column list and `verification_status_counts` required by the manifest builder.

### Contract version 1 canonical encoding

For contract version 1, each row is normalised from these fields:

```text
connector_id
station_id
timeseries_id
pollutant_code
observed_at_utc
value
verification_status
```

Required normalisation:

- `connector_id` is a positive integer;
- `station_id` is a positive integer or `null`;
- `timeseries_id` is a positive integer;
- `pollutant_code` is the validated canonical lower-case code;
- `observed_at_utc` is an exact UTC ISO timestamp with millisecond precision and trailing `Z`;
- `value` is a finite IEEE-754 binary64 value;
- finite negative values are preserved;
- negative zero is normalised to positive zero;
- null, NaN and infinite values are invalid canonical observation values;
- `verification_status` is canonical `P`, canonical `R` or null under the verification-status contract above.

The value is encoded as 16 lower-case hexadecimal characters containing the big-endian IEEE-754 binary64 bytes. Each canonical row is then encoded as compact UTF-8 JSON with this fixed array order:

```text
[connector_id, station_id, timeseries_id, pollutant_code, observed_at_utc, value_float64_hex, verification_status]
```

Canonical row strings are sorted lexicographically, exact duplicate rows are retained, and the SHA-256 input is:

```text
uk-aq-observation-content-hash:v1\n
<canonical row 1>\n
<canonical row 2>\n
...
```

The final row also ends with `\n`. This contract makes the result independent of source order and Parquet physical order while preserving duplicate multiplicity.

A change to `verification_status`, including `P` to `R`, `R` to `P`, null to a known status or a known status to null, MUST change the content hash when all other row fields remain unchanged.

### Writer requirements

The Prune Daily writer calculates the hash from the exact canonical pollutant rows passed to the Parquet serializer. The Integrity source-to-R2 writer calculates source and replacement hashes through the same helper.

A writer MUST fail closed rather than publish a manifest when:

- any selected row cannot be canonicalised;
- any non-empty UK-AIR SOS verification status is not recognised;
- the hash row count differs from the selected pollutant row count;
- `verification_status_counts` does not match the canonical rows or sum to the row count;
- the returned contract metadata is missing or invalid;
- the manifest fields do not exactly represent the hash result.

### Integrity comparison algorithm

For every selected day, connector and pollutant:

1. Compare source and R2 total and per-timeseries row counts as the fast structural check.
2. If any count differs, classify an observation data mismatch and rebuild the complete selected pollutant partition. A content-hash comparison is not needed to prove that repair is required.
3. If counts match, calculate the authoritative source `observation_content_hash` and compare it with the hash in the Dropbox pollutant manifest.
4. If the hashes match and the manifest contract metadata and `verification_status_counts` are valid, the observation content is verified.
5. If the hashes differ, classify an observation data mismatch and rebuild the complete selected pollutant partition.
6. A hash mismatch may produce bounded diagnostic samples and difference-category counts. A complete row-by-row pre-repair diff is not required because the repair unit is the complete day/connector/pollutant partition.

The comparison result MUST distinguish at least:

- `row_count_mismatch`;
- `observation_content_hash_mismatch`;
- `observation_content_hash_missing`;
- `observation_content_hash_invalid_contract`;
- `verification_status_invalid`;
- `verification_status_counts_mismatch`;
- verified count, hash and status-count agreement.

### Existing manifests without the hash

Missing observation-content-hash fields in an otherwise readable historical pollutant manifest are a metadata gap, not automatic proof that the Parquet data is wrong.

For a legacy hashless partition, Integrity MUST read the Dropbox Parquet and calculate its observation-content hash through the shared helper, applying the legacy status fallback before hashing:

- if the calculated R2 hash matches the source hash, plan a metadata-only pollutant-manifest repair and preserve the Parquet;
- if it differs, plan a complete selected-pollutant observation data repair;
- if the Parquet cannot be read or canonicalised, fail closed for that scope.

Once a valid hash is present, routine source comparison uses the manifest value. Existing manifest, file-identity and hierarchy validation remains required. The content hash does not excuse an unreadable or structurally invalid partition.

### Post-repair verification

After a real observation repair, Integrity MUST:

1. GET/read the written pollutant Parquet from live R2;
2. recalculate its observation-content hash and `verification_status_counts` through the shared helper;
3. require exact equality with the authoritative source hash and source status counts;
4. require the written pollutant manifest fields to equal that verified result;
5. only then treat the observation repair as successful and continue to parent manifests, indexes and AQI work.

The audit chain is:

```text
old R2 hash differs from source hash
complete pollutant partition rebuilt
new live R2 hash and verification-status counts equal source truth
```

### SQLite ownership and optional future source cache

Integrity SQLite stores comparison and audit evidence, including the source hash used, source and R2 verification-status counts, the R2 manifest hash, comparison result, repair run identity and post-repair verification. It does not store a duplicate authoritative R2 observation-content-hash cache.

The initial implementation SHOULD calculate source hashes during the existing source parsing and canonical-row pass. If real TEST operations show that source hash creation is materially slow, a later additive SQLite source-hash cache MAY be introduced.

Any future source-hash cache MUST be non-authoritative and MUST be keyed or invalidated by all inputs that can change canonical content, including:

- exact source-file identities and SHA-256 values;
- source timestamp/parser and verification-status normalisation contract versions;
- source-label registry snapshot identity;
- station/timeseries and observed-property mapping identities;
- day, connector and pollutant scope;
- observation-content-hash contract version.

A cache entry MUST NOT survive a change to any of those identities. Adding such a cache is a separate measured performance change, not part of the initial hash implementation.

### Dropbox backup

The existing v2 history Dropbox backup copies the observation day folder and its pollutant manifests. Therefore `observation_content_hash`, `verification_status_counts` and the canonical status column are preserved through the existing manifest/day backup path.

No separate hash object, backup inventory category or Dropbox checkpoint section is added. A changed pollutant manifest changes its own bytes and hash, its parent manifest identities and the existing backup inventory entry, causing the normal changed units to be copied.

## Current flow

1. Load the v2-only Integrity environment and configured source/backfill environment.
2. Check Dropbox backup readiness unless `--allow-stale-dropbox` is supplied.
3. Import the current `R2_history_backup/history/v2/core` snapshot.
4. Read or fetch relevant historical connector data through configured source adapters and caches.
5. Normalise source timestamps, mappings, verification status and canonical selected-pollutant rows.
6. Compare source and Dropbox row counts.
7. For count-matching scopes, compare the source `observation_content_hash` with the Dropbox pollutant-manifest hash.
8. Validate status counts, Parquet, manifests, indexes and stable bindings and classify any remaining metadata faults.
9. Build a deterministic repair plan after detection completes.
10. Stop after reporting in `--check-only` mode.
11. With `--run-backfill --dry-run`, calculate exact local repair proposals without writing R2.
12. With a real `--run-backfill`, build and validate corrected objects locally, apply the repair in the required order and GET-verify every written object.
13. Run one final read-only verification and write SQLite, JSON, Markdown and task-health evidence.

Equivalent source/cache input, selected pollutant scope, hash contract and chosen Dropbox baseline MUST produce the same findings, repair plan and canonical replacement content.

## Run mode contracts

### `--check-only`

`--check-only` is the normal scheduled detection mode. It answers what is wrong within the selected four-pollutant scope and what repair would be required.

It MUST:

1. Apply the backup readiness gate unless `--allow-stale-dropbox` is supplied.
2. Import the Dropbox core snapshot and scoped R2 v2 mirror.
3. Read or fetch the authoritative connector source/cache.
4. Apply count, verification-status and observation-content-hash comparison.
5. Check all relevant parts of the seven logical v2 areas.
6. Record source state, comparison evidence, findings and the repair plan in SQLite and reports.

It MUST NOT invoke an R2 writer, deletion path or metadata executor; create an uploaded-object overlay; access live R2; change Dropbox; or claim post-write verification.

An actionable finding is a failed Integrity result even when detection completed successfully.

### `--run-backfill --dry-run`

Dry-run performs the same acquisition, comparison, findings and repair planning as check-only. It may run local-only builders needed to calculate exact canonical replacement files, manifests, deletions, indexes and dependencies.

It may write disposable local files, SQLite evidence and reports. It MUST NOT read, write or delete live R2, change Dropbox, or claim that a planned object was uploaded or GET-verified.

### Real `--run-backfill`

A real repair performs the same acquisition, comparison and planning, then applies the repair contract below.

It MUST NOT mutate R2 until every local replacement object and preserved-baseline dependency required for the first selected mutation scope has been structurally validated.

## Temporary repair overlay

The repair overlay is a run-specific sparse local working directory containing only objects created, changed or marked for deletion by the current run. It uses canonical relative object keys and is never copied into Dropbox or treated as an authoritative backup.

Later local stages resolve an object in this order:

1. a structurally validated replacement object in the current overlay;
2. a current-run exact pollutant-prefix tombstone;
3. otherwise the matching object from the chosen Dropbox baseline.

Only structurally validated overlay objects may feed later manifest, parent-manifest, AQI or index stages. The overlay is not a resume mechanism. An interrupted or failed repair is rerun from the beginning with a new overlay.

## Seven logical v2 areas

Integrity checks:

1. Core snapshot.
2. Observation data and manifests.
3. Observation timeseries indexes, including the latest index.
4. AQI hourly data and manifests for AQI-eligible pollutants.
5. AQI debug data and manifests for AQI-eligible pollutants.
6. AQI timeseries indexes, including the latest index.
7. Stable timeseries bindings.

Stable bindings live under `history/_index_v2/timeseries_binding`. They are checked independently against imported core identities and are not rewritten by an observation data repair.

## Backup gate and stale-backup override

Every normal Integrity mode calls `uk_aq_public.uk_aq_rpc_history_integrity_readiness(timestamptz)` before inspecting the Dropbox history base.

The latest successful non-dry-run `ops.r2_history_dropbox_backup` must have started after the latest finished relevant R2 writer attempts. Unfinished writers or backup attempts block the run. The qualifying backup must have finished before the current Integrity run started.

`--allow-stale-dropbox` only bypasses this readiness gate and uses the available Dropbox mirror as the chosen baseline. It does not change fault classification, force a rebuild, disable metadata-only repair or permit live R2 to become a comparison baseline.

## Detection and hierarchy validation

The v2 checks start from actual day, connector, supported-pollutant and manifest paths in the scoped Dropbox mirror. They validate parent-manifest content against valid child manifests instead of trusting a single parent representation.

The report keeps these comparisons separate:

1. source/cache counts versus R2 recorded and, when needed, Parquet-derived counts;
2. source observation-content hash versus pollutant-manifest observation-content hash;
3. source verification-status counts versus pollutant-manifest status counts;
4. actual Parquet evidence versus pollutant manifest counts and file identities where a Parquet read is required;
5. supported-pollutant manifests versus connector and day hierarchy representations;
6. committed supported-pollutant entries versus pollutant and latest indexes;
7. stable binding objects versus imported core identities.

Existing out-of-scope pollutant partitions, manifest entries and indexes are ignored as findings and are carried through unchanged when a parent is rebuilt.

An unavailable reader, unreadable selected-pollutant Parquet, unavailable selected-pollutant source/cache, unrecognised source verification status or ambiguous selected-pollutant mapping fails closed. An absent authoritative active binding remains warning-only and is excluded from canonical evidence, counts and hashes.

## Repair planning

Each v2 run includes a deterministic, deduplicated `repair_plan` array. The plan records whether each selected scope needs data replacement, metadata repair, index repair, AQI rebuild or operator action.

A valid readable pollutant Parquet whose calculated R2 content hash and status counts match source truth but whose manifest hash fields are missing or invalid is a metadata-only fault. Metadata-only repair MUST NOT rewrite valid Parquet.

A count mismatch or observation-content-hash mismatch is an observation data fault. The destructive repair unit is one connector-day plus an explicit selected pollutant subset. The physical delete/write scope remains the exact selected day/connector/pollutant prefix.

A pollutant-scoped repair MUST identity-pin all required source files, classify every selected source group, preserve unselected children, build complete replacement content for selected pollutants and rebuild parent metadata and indexes from selected replacements plus preserved baseline content. It MUST never tombstone or delete the complete connector-day prefix.

## Repair execution contract

Before any R2 mutation, Integrity builds all corrected files locally and validates structural completeness.

For an observation data repair:

1. Read or fetch and identity-pin all required source files.
2. Build canonical selected-pollutant source evidence, including canonical `verification_status`.
3. Calculate authoritative source counts, `verification_status_counts` and `observation_content_hash` through the shared helper.
4. Exclude and report warning-only `no_authoritative_timeseries_binding` rows consistently.
5. Fail on malformed, ambiguous, contradictory, duplicate-conflicting, unrecognised-status or otherwise blocked rows.
6. Build complete corrected selected-pollutant Parquet and pollutant manifests locally.
7. Require the replacement manifest hash metadata and status counts to match the source result.
8. Validate source-to-Parquet row identity, counts, pollutant set, object keys, hashes, status counts and detector/proposal equality.
9. Resolve and preserve unselected children from the Dropbox baseline.
10. Create tombstones only for exact selected pollutant prefixes.
11. During real apply, delete and verify absence of those exact prefixes.
12. Upload selected Parquet and pollutant manifests.
13. GET/read the written Parquet, recalculate the observation-content hash and status counts and require equality with source truth.
14. GET-verify the written pollutant manifest and require it to contain the verified hash result and status counts.
15. Rebuild and GET-verify connector and day manifests.
16. Rebuild and GET-verify affected supported-pollutant indexes and the global latest index without dropping preserved entries.
17. Run AQI repair stages only for changed `pm25`, `pm10` or `no2` observations.

For metadata-only repair, preserve the Dropbox Parquet and rebuild only the required manifests or indexes from verified baseline and overlay evidence.

The apply order is selected child data, selected child manifests, parent manifests, scoped indexes and global latest indexes last.

## R2 access rules

Integrity detection and repair planning MUST NOT HEAD, GET or list live R2. Check-only and dry-run do not access live R2.

Live R2 reads during real apply are limited to post-mutation verification and exact affected-key final verification. The Dropbox mirror remains the pre-repair baseline.

## No generation or receipt contract

Active repair uses canonical R2 v2 paths directly. It MUST NOT create generation directories, permanent R2 transaction receipts, R2 rollback copies or resumable internal transaction state.

Repair audit information belongs in Integrity SQLite, task logs and JSON/Markdown reports.

## Interrupted repair recovery

An interrupted repair is rerun from the beginning. A manual rerun may use `--allow-stale-dropbox` to reuse the same chosen Dropbox baseline without waiting for another backup.

The successful rerun completes all writes, post-write hash and GET verification, parent metadata, indexes and final verification. Failed or interrupted runs remain failed in the audit trail.

## Empty and unavailable source results

A gateway failure, missing cache file, parse failure or uncertain empty response MUST NOT be interpreted as authoritative no-data.

A selected pollutant partition may be replaced with no rows only when the source adapter explicitly classifies the result as authoritative no-data. Otherwise no R2 change is made for that scope.

A source site/pollutant group skipped because no authoritative active timeseries binding exists is neither unavailable source nor authoritative no-data. Its source rows were examined, but they cannot enter canonical history until the separate core identity owner provides a valid binding.

## Audit evidence

Every mode records its mode, requested scope, chosen Dropbox baseline, stale-backup override state, source acquisition result, count comparison, source and R2 observation-content hashes, source and R2 `verification_status_counts`, hash contract version, findings, repair plan and final result.

For a real repair, reports additionally record selected source and replacement row counts, hashes and status counts before and after repair, preserved children, object keys deleted and written, post-write GET/hash verification, manifests and indexes rebuilt, AQI work and final verification status.

Check-only and dry-run reports MUST keep planned and completed operations distinct.

## Validation model

Before implementation, confirm only that the shared helper, writer integration, manifest schema, verification-status source path and Integrity comparison paths are structurally viable. A small deterministic contract fixture is genuinely required because a hash implementation that differs between the two writers would make every comparison unreliable.

Before finalising the source normaliser, one narrow source-vocabulary inspection is genuinely required. It must inspect representative distinct UK-AIR annual-file status values and distinct SOS IngestDB status values, without launching a broad data-validation programme. Any additional non-empty source value must be reported before implementation rather than guessed.

The focused structural check should prove:

- identical hashes for identical logical rows despite different input order;
- changed hashes for value, timestamp, identity and verification-status changes;
- canonical `P`, `R` and null normalisation;
- rejection of unknown non-empty UK-AIR SOS status values;
- `verification_status_counts` agreement and sum-to-row-count behaviour;
- legacy `verification_status`, `status` and missing-column precedence;
- duplicate multiplicity;
- negative-value preservation;
- deterministic Float64 encoding.

After deployment to CIC-Test, functional validation is performed through:

1. one normal Prune Daily Phase B operation that writes a manifest containing a valid observation-content hash and status counts;
2. one real scoped historical Integrity operation, including a hash-mismatch repair or legacy hashless-manifest path;
3. post-write live R2 hash and status-count equality;
4. a later normal check against the next successful Dropbox backup.

Do not add a broad speculative pre-implementation test suite.

## Related authoritative documents

- [`README.md`](README.md)
- [`contract.md`](contract.md)
- [`operations.md`](operations.md)
- [`aqi_history_write_pipeline.md`](aqi_history_write_pipeline.md)
- [`timeseries_binding_contract.md`](timeseries_binding_contract.md)
