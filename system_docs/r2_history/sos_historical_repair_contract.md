# SOS historical observation repair contract

## Authority and scope

This document is the authoritative mode-specific amendment for write-enabled UK-AIR SOS historical observation repairs. It supplements:

- [`integrity.md`](integrity.md);
- [`integrity_apply_safety_contract.md`](integrity_apply_safety_contract.md);
- [`history_writer_coordination.md`](history_writer_coordination.md);
- [`implementation_safety_contract.md`](implementation_safety_contract.md);
- [`current_state_reconciliation.md`](current_state_reconciliation.md);
- [`../latest_snapshot/integrity_reconciliation.md`](../latest_snapshot/integrity_reconciliation.md).

Where those broader contracts conflict with this document, this document is authoritative only for the dedicated write-enabled SOS historical replacement path defined here. The generic Integrity path, check-only mode, dry-run mode, other connectors and Latest Snapshot owner-service behaviour remain unchanged unless this document explicitly says otherwise.

The purpose is to provide the smallest accurate operational path for rebuilding authoritative historical SOS observations so that historical analysis, including WHO guideline calculations, is not blocked by unrelated AQI or generic multi-source repair complexity.

## Operator entrypoint and mode selection

The operator continues to invoke the established local dispatcher:

```text
<local Integrity root>/bin/uk-aq-history-integrity.sh
```

The local dispatcher continues to select the environment and repository checkout, then invokes the repository-owned Python orchestrator and supporting repository scripts. No second locally installed dispatcher is introduced.

A real run uses the dedicated SOS historical replacement path when all of these are true:

- `--source sos` is selected;
- `--run-backfill` is selected;
- the history version is `v2`;
- an explicit day or date range is supplied;
- an explicit supported pollutant subset is supplied.

The dedicated path is limited to the authoritative UK-AIR SOS connector, currently connector `1`. It MUST reject any request that broadens the write scope to another connector or source adapter.

The existing generic Integrity entrypoint remains available. This contract changes the internal route selected for a qualifying SOS write-enabled historical repair; it does not replace the operator command or remove the generic implementation.

## Supported observation scope

The dedicated path supports only these canonical observation pollutants:

```text
pm25
pm10
no2
o3
```

Each destructive repair unit is exactly:

```text
day_utc + connector_id=1 + pollutant_code
```

The requested date range and pollutant subset MUST pass unchanged through source acquisition, source evidence, proposal construction, tombstone planning, apply, live verification, audit and current-state reconciliation.

## Complete selected-partition replacement

Every selected pollutant partition is rebuilt as a complete authoritative replacement. The dedicated path MUST NOT merge individual rows from the existing R2 selected partition into the replacement and MUST NOT require old selected-partition rows to survive.

For each selected partition, Integrity MUST:

1. acquire and identity-pin all required SOS source files;
2. prove source enumeration completed for the selected UTC day and pollutant;
3. classify every selected source group;
4. canonicalise every usable source row;
5. persist immutable current-run source evidence;
6. build complete replacement Parquet and a complete pollutant manifest;
7. create one exact selected-pollutant-prefix tombstone;
8. delete the existing exact selected pollutant prefix;
9. write the complete replacement;
10. rebuild affected parent manifests and observation indexes;
11. verify the final live R2 result through the single ordered live phase defined below.

The complete replacement rule applies on first execution and on later reruns of an already completed day. A rerun with unchanged authoritative source content produces the same logical canonical observations. A later source correction produces the newly authoritative canonical observations.

Existing object bytes or operational manifest fields may still change between runs, but execution time alone MUST NOT change logical observation content, source counts, status counts or observation-content hashes.

## SOS source completeness

Source completeness remains fail-closed. The selected partition MUST NOT be deleted or replaced when:

- a required annual file cannot be obtained from the approved local cache or source;
- required source-date coverage for the requested UTC day is incomplete;
- a required file cannot be parsed;
- source enumeration ends with an uncertain empty result;
- the source-evidence body, counts, status counts or content hashes cannot be reproduced;
- canonical replacement construction fails.

The existing UK-AIR hour-ending timestamp and annual-file boundary rules remain authoritative.

An explicitly proven authoritative no-data result may replace a selected partition with the contractually valid empty representation. An uncertain empty result MUST leave the existing R2 partition unchanged.

## Missing authoritative timeseries bindings

A source site and pollutant group with no authoritative active timeseries binding is warning-only.

Required behaviour is:

```text
no authoritative timeseries binding
-> do not invent an identity
-> exclude those rows from canonical replacement content
-> record one aggregated warning with bounded examples and row counts
-> continue with all other valid mapped rows
```

Excluded rows MUST be omitted consistently from:

- canonical source evidence;
- replacement Parquet;
- pollutant manifests;
- source and replacement row counts;
- per-timeseries counts;
- `verification_status_counts`;
- `observation_content_hash`.

If source rows exist for a selected partition but every row is excluded because no authoritative binding exists, Integrity MUST leave the existing R2 selected partition unchanged and report the partition as skipped. It MUST NOT interpret this as authoritative no-data and MUST NOT delete the existing partition.

Ambiguous, contradictory or invalid mappings remain fail-closed. Warning-only treatment applies only to the established `no_authoritative_timeseries_binding` case.

## Legacy R2-only identities

Legacy timeseries IDs found only in the existing selected R2 partition do not require continuity mappings when the complete selected partition is being replaced.

Integrity MAY report:

- the count of legacy R2-only identities;
- bounded example IDs;
- the existing row count attributable to them where readily available;
- the fact that they are removed by complete selected-partition replacement.

Their absence from the current SOS continuity bridge MUST NOT block replacement when:

- SOS source enumeration is complete;
- every included replacement row has valid canonical identity;
- immutable source evidence is valid;
- the selected partition is being completely replaced.

This rule does not permit an unmapped fresh SOS row to be copied into R2 and does not weaken source completeness or canonical-row validation.

## AQI exclusion

The dedicated SOS historical replacement path repairs observation history only.

It MUST NOT generate, rebuild, validate or publish:

- AQI hourly data;
- AQI debug data;
- AQI manifests;
- AQI indexes;
- AQI latest or discovery metadata.

AQI success, failure or absence MUST NOT affect completion of the SOS observation repair.

Existing AQI objects are left unchanged. Observation-derived AQI may be regenerated later by a separately owned downstream process from verified R2 observations. This contract does not define that later process.

## Dropbox baseline contract

The chosen Dropbox R2 history mirror is the pre-run planning and preservation baseline for the dedicated SOS path.

A qualifying backup completed after Prune Daily establishes a baseline that may be reused for a sequence of explicitly scoped SOS historical repairs. A new Dropbox backup is not required merely because:

- a prior SOS repair completed;
- the same completed day and pollutant are rerun;
- the current repair will completely replace the selected pollutant partition again.

For selected replacement partitions, fresh immutable SOS source evidence is authoritative. Dropbox does not decide which rows within the selected partition survive.

For unselected children, other connectors on the same day and unaffected observation metadata, the chosen Dropbox baseline supplies the preserved local planning view. The current run's validated overlay replaces selected child entries when affected parents and indexes are rebuilt.

The dedicated path MUST NOT access live R2 during source acquisition, detection, local proposal construction or final local proposal validation.

`--allow-stale-dropbox` continues to mean that the available Dropbox mirror is accepted as the chosen planning and preservation baseline without waiting for another backup. It does not weaken source evidence, replacement completeness, local proposal validation or final live R2 verification.

Prune Daily is outside this Dropbox contract and MUST NOT use Dropbox as a source, baseline or deletion authority.

## Local proposal construction

Before the first live R2 mutation, the complete local proposal MUST establish:

```text
immutable SOS source evidence
=
final staged canonical Parquet semantic content
=
final staged pollutant manifest content
```

The local proposal MUST also contain structurally complete affected connector, day and observation-index metadata built from:

```text
chosen Dropbox baseline
+ current-run selected replacements
- current-run exact selected-prefix tombstones
```

All existing proposal ownership, canonical row, content hash, status count, dependency identity, parent-child reference and exact tombstone checks remain required before mutation.

## Single ordered live R2 phase

After all local work succeeds, the dedicated path enters one bounded live R2 apply-and-verification phase. There is no earlier live R2 comparison or planning read and there is no second broad duplicate verification scan afterwards.

The existing connector-day, day-finalisation and global-index locks remain authoritative. Locks are acquired in the established non-nested order for the exact affected scopes.

### Selected observation children

For each affected connector-day:

1. delete the exact selected pollutant prefixes and verify required absence through the existing bounded deletion mechanism;
2. PUT all selected replacement Parquet objects;
3. GET each changed Parquet object once;
4. verify byte length and SHA-256 identity;
5. parse that returned live body through the shared canonical observation helper;
6. require exact semantic equality with immutable SOS source evidence.

A changed Parquet body that passed this GET is not fetched again during the same operation.

### Selected pollutant manifests

After the selected Parquet objects for a pollutant pass live verification:

1. PUT the selected pollutant manifest;
2. GET that changed manifest once;
3. require its content-defining fields and dependencies to match the already verified live Parquet result and immutable source evidence.

A pollutant manifest MUST NOT be published before its selected Parquet objects pass their single live verification.

### Parents and observation indexes

After all changed pollutant manifests for the connector-day pass verification:

1. publish the affected connector manifest;
2. publish affected connector-scoped and pollutant-scoped observation indexes;
3. publish the affected day manifest under the day-finalisation lock;
4. publish affected global and latest observation metadata last under the global-index lock.

Each changed parent or index object is GET once after its PUT and verified against the final child identities already established during the same live phase.

No unchanged Dropbox-preserved object requires a live GET solely because it was carried into a rebuilt parent or index.

### Verification reuse and completion

The body returned by each changed object's single post-PUT GET is the verification body for that object. A bounded current-operation cache MAY retain it until all direct semantic or dependency checks using that exact key and SHA-256 finish, then MUST discard it.

A later verifier MUST NOT issue another GET for the same unchanged key in the same operation merely to repeat a check already completed against that verified body.

The completed object graph is accepted from the ordered single-read verification results. No separate broad final R2 scan follows the live phase.

The final invariant is:

```text
immutable SOS source evidence
=
verified live selected Parquet
=
verified live selected pollutant manifests
```

and every changed parent and index must reference the verified final child identities.

## Failure behaviour

R2 remains non-transactional. Child-before-parent publication and complete local validation are therefore mandatory.

If a selected child fails its single live verification:

- no dependent pollutant manifest, parent, index, day manifest or global metadata may be published for that failed child;
- the run remains failed in the immutable audit trail;
- current-state reconciliation does not run for the failed scope;
- recovery is a new run from the beginning with fresh SOS source evidence;
- the failed run is not resumed.

Already verified R2 history from an earlier completed run remains valid. Rerunning the same completed scope is supported by the complete replacement and idempotency rules in this contract.

## Timeseries and Latest Snapshot reconciliation

The existing current-state reconciliation contract remains active for the dedicated SOS path.

After the ordered live R2 phase succeeds for the selected observation scope:

1. derive candidates from final verified canonical observations;
2. reconcile `timeseries.last_value_at` and `timeseries.last_value` through the existing monotonic private RPC;
3. reconcile Latest Snapshot through the existing authenticated private Latest Snapshot owner-service route for `pm25`, `pm10` and `no2`;
4. retain O3 outside Latest Snapshot while allowing its existing timeseries-freshness behaviour;
5. record Timeseries and Latest Snapshot outcomes independently.

Integrity MUST NOT write Latest Snapshot state or products directly.

Older historical candidates remain no-ops. Identical same-timestamp content remains a no-op. A different final verified same-timestamp value or status may apply once as the existing correction contract permits.

A Timeseries or Latest Snapshot failure does not roll back verified R2 history and must not be reported as an R2 observation-repair failure. It may still prevent full overall run success under the existing independent-target reporting contract.

## Audit evidence

Each dedicated SOS repair records at least:

- that the dedicated SOS historical replacement path was selected;
- the operator-requested dates and pollutants;
- connector `1` as the only mutation connector;
- chosen Dropbox baseline and stale-backup override state;
- required source-file identities and source-enumeration result;
- included, warning-excluded and invalid source row counts;
- aggregated `no_authoritative_timeseries_binding` evidence;
- any legacy R2-only identity diagnostics;
- immutable source counts, status counts and content hashes;
- local staged Parquet and manifest equality;
- exact selected-prefix tombstones;
- every changed object PUT and its single verification GET result;
- the highest publication level reached;
- Timeseries reconciliation outcome;
- Latest Snapshot reconciliation outcome;
- separate R2 history, Timeseries, Latest Snapshot and overall statuses.

The audit MUST distinguish a skipped all-unmapped partition from authoritative no-data and from a failed source acquisition.

## Minimal structural validation

Before deployment, perform only the smallest structural checks needed to prove the path is viable:

- the established local dispatcher selects the dedicated repository-owned SOS path without changing the operator command method;
- non-SOS or non-connector-1 write scope is rejected;
- complete selected-partition replacement creates one exact tombstone and one complete replacement graph;
- warning-only missing bindings are excluded consistently without blocking valid rows;
- an all-unmapped non-empty source partition is left unchanged;
- legacy R2-only IDs do not block complete replacement;
- AQI code is not invoked by the dedicated path;
- local source, Parquet and pollutant-manifest semantic equality is required before mutation;
- live R2 is not accessed before the final apply-and-verification phase;
- each changed object is GET no more than once in a successful operation;
- a changed child is verified before its dependent parent or index is published;
- no second broad final verification scan runs;
- Timeseries and Latest Snapshot reconciliation still begins only after verified R2 observation success.

Do not add a broad speculative pre-deployment test suite.

## Functional acceptance in CIC-Test

Functional validation occurs through real CIC-Test operations after deployment:

1. run one known problematic scope, preferably SOS connector `1`, `2026-06-01`, `no2`;
2. confirm complete source enumeration and complete selected-partition replacement;
3. confirm legacy R2-only identities are diagnostic and do not block replacement;
4. confirm every changed object is GET-verified once in dependency order;
5. confirm no AQI or AQI debug stage runs;
6. confirm Timeseries and Latest Snapshot reconciliation retain their existing monotonic/idempotent outcomes;
7. rerun the same completed scope and confirm it remains correct without requiring another Dropbox backup;
8. after the one-day result succeeds, run the intended `2026-06-01` to `2026-06-16` SOS range.

A fresh Dropbox backup should be taken after meaningful repair work as the normal recovery copy, but it is not a prerequisite between supported same-scope reruns under this contract.
