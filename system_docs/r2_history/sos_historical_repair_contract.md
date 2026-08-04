# SOS-light historical observation repair contract

## Authority and scope

The dedicated write-enabled UK-AIR SOS historical repair path is now called **SOS-light**.

The complete authoritative behaviour is defined in:

- [`sos_light_model.md`](sos_light_model.md);
- [`sos_run_scoped_source_acquisition_contract.md`](sos_run_scoped_source_acquisition_contract.md);
- [`current_state_reconciliation.md`](current_state_reconciliation.md);
- [`../latest_snapshot/integrity_reconciliation.md`](../latest_snapshot/integrity_reconciliation.md).

Where older plans, reports or implementation names refer to “dedicated SOS historical replacement”, “direct selected-partition replacement” or “protected-connector preservation”, those names describe implementation history. The active operational model is SOS-light.

The generic Integrity path, check-only mode, dry-run mode, Prune Daily and non-SOS paths remain unchanged.

## Operator entrypoint

The operator continues to use:

```text
<local Integrity root>/bin/uk-aq-history-integrity.sh
```

A real run selects SOS-light when all of these are true:

- `--source sos`;
- `--run-backfill`;
- history version `v2`;
- an explicit day or date range;
- an explicit supported pollutant subset.

The selected source connector is connector `1` only.

## Supported source-built pollutants

SOS-light supports:

```text
pm25
pm10
no2
o3
```

Fresh identity-pinned SOS source evidence is authoritative for selected connector `1` pollutants.

The existing source rules remain strict:

- required annual sources must be obtained and identity-pinned;
- UTC day coverage must be complete;
- source parsing must succeed;
- authoritative timeseries mapping must be unambiguous;
- canonical rows, counts, status counts and content hashes must be reproducible;
- uncertain empty source results must fail before mutation;
- proven authoritative no-data may produce the valid empty representation;
- the established `no_authoritative_timeseries_binding` case remains warning-only and excluded consistently;
- a non-empty selected partition where every row is excluded for missing authoritative bindings remains skipped rather than treated as authoritative no-data.

Any unresolved connector `1` source or construction error stops SOS-light before deleting the R2 day.

## Complete local day assembly

SOS-light does not preserve or compare the existing live R2 day.

For each selected day it assembles a complete local replacement from:

```text
fresh SOS source for selected connector 1 pollutants
+
chosen Dropbox history baseline for the rest of the day
```

The exact assembly, parent-building and warning rules are defined by [`sos_light_model.md`](sos_light_model.md).

The key connector `1` rule is:

```text
final connector 1 parent
=
all final connector 1 pollutant manifests actually present in the assembled day
```

It MUST NOT be limited to the child list in the old Dropbox connector `1` parent.

Therefore, when the current run creates O3, the final connector `1` parent must include O3 even if the old Dropbox parent omitted it.

## Complete-day replacement

After local assembly and validation succeed, the destructive R2 target is:

```text
history/v2/observations/day_utc=<selected day>/
```

SOS-light MUST:

1. delete the existing complete selected observation day prefix;
2. upload the complete assembled replacement day;
3. publish child-before-parent;
4. rebuild affected observation indexes from the Dropbox baseline plus assembled day;
5. verify changed objects written by the run.

### Complete publication schedule

Because the complete day prefix is deleted before upload, the apply publication schedule MUST contain every object required to reconstruct the final assembled day.

This requirement applies even when an assembled object is byte-for-byte identical to the chosen Dropbox baseline or to the object that existed in live R2 before deletion. In particular:

- every preserved or rebuilt child object required by the assembled day MUST be uploaded;
- every final connector manifest required by the assembled day MUST be uploaded;
- exactly one final day manifest MUST be uploaded for each selected day;
- an unchanged day manifest is still a mandatory upload because deletion removes the existing copy;
- change detection or unchanged-object deduplication MAY be used for diagnostics and audit, but MUST NOT remove any required assembled-day object from the publication schedule.

Before the first live R2 mutation, validation MUST prove that the final publication schedule is a complete, dependency-ordered representation of the assembled day. It MUST fail closed when a required object is absent, duplicated or ordered before one of its required children.

The old live R2 day is not merged back into the replacement.

## Dropbox authority for other connectors

For connectors other than connector `1`, the chosen Dropbox baseline is the only preservation authority.

SOS-light does not require those connectors to be correct. It carries usable Dropbox content on a best-effort basis.

Problems belonging solely to other connectors:

```text
-> warning
-> omit unusable Dropbox content where needed
-> continue with connector 1
```

Existing live R2 errors, including known `404` child manifests, are irrelevant to local assembly because SOS-light does not read live R2 for preservation decisions.

## R2 access boundary

Before deletion, SOS-light MUST NOT read existing live R2 observation bodies for planning, comparison or preservation.

Live R2 is used only for:

- writer coordination;
- listing and deleting the selected complete day prefix;
- bounded deletion verification;
- uploading the assembled day and affected indexes;
- one post-PUT verification GET per changed object.

## AQI exclusion

SOS-light repairs observation history only.

It MUST NOT generate, rebuild, validate or publish AQI hourly data, AQI debug data, AQI manifests or AQI indexes.

## Current-state reconciliation

After the complete assembled R2 day and affected observation indexes are successfully written and verified:

1. derive candidates from final verified connector `1` observations;
2. reconcile Timeseries through the existing private owner route;
3. reconcile Latest Snapshot for `pm25`, `pm10` and `no2` through its existing owner route;
4. retain O3 outside Latest Snapshot while preserving its Timeseries behaviour;
5. record R2, Timeseries and Latest Snapshot outcomes independently.

Other connectors carried from Dropbox do not generate current-state candidates in a connector `1` SOS-light run.

## Failure and rerun behaviour

Local assembly must complete before the first live R2 mutation.

If connector `1` or the local replacement graph is invalid, the run fails before deleting the day.

If a live write or post-PUT verification fails after deletion has begun, the run records the highest publication level reached and must be rerun from the beginning. It is not resumed.

A supported rerun requires no newly detected gap. Explicit scope selects what is rebuilt; source validation decides whether rebuilding is safe.

## Required audit

Each run records at least:

- `mode = sos-light`;
- requested days and pollutants;
- connector `1` as the selected protected connector;
- source identities and source-enumeration results;
- chosen Dropbox baseline identity;
- confirmation that source plus Dropbox were the only assembly authorities;
- final connector `1` child set per day;
- final assembled connector set per day;
- final publication-schedule object count and required-parent count per day;
- confirmation that unchanged but required assembled-day objects remained scheduled for upload;
- warnings and omissions for Dropbox-backed other connectors;
- complete-day deletion and upload counts;
- changed-object verification results;
- affected observation index results;
- Timeseries and Latest Snapshot outcomes.

## Minimal structural validation

Before operational CIC-Test execution, perform only the smallest targeted checks required by [`sos_light_model.md`](sos_light_model.md), especially:

- complete-day deletion targeting;
- no existing live R2 body reads during assembly;
- source-built O3 appearing in the final connector `1` parent;
- connector `1` parent body and dependency evidence using the same final child set;
- every required assembled-day object remaining in the publication schedule even when unchanged;
- exactly one final day manifest being scheduled after all required children;
- unprotected Dropbox issues remaining warning-only.

Functional validation belongs in the real CIC-Test SOS-light run. Do not add a broad speculative pre-deployment test suite.
