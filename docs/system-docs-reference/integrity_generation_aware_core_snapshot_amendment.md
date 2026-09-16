# Integrity generation-aware core snapshot amendment

## Authority and scope

This amendment is authoritative for R2 History Integrity runs whose selected observation-history generation is `v2` or `v3`.

It supplements and, where necessary, supersedes conflicting v2-only generation wording in:

- [`integrity.md`](integrity.md);
- [`integrity_core_snapshot_identity.md`](integrity_core_snapshot_identity.md);
- [`sos_light_model.md`](sos_light_model.md);
- older Integrity implementation notes that hard-code `history/v2/core/...` for every invocation.

It does not change the source-authority model, repair unit, proposal/apply ownership, observation-content semantics, global observation-operation lock, AQI retirement, or backup-state format versions.

## Core decision

The selected observation-history generation owns the matching committed core snapshot namespace used by that Integrity invocation.

The normal generation selector is:

```text
UK_AQ_R2_HISTORY_VERSION=v2|v3
```

For Integrity, the canonical generation mapping is:

```text
v2
  -> observations: history/v2/observations/...
  -> core:         history/v2/core/...

v3
  -> observations: history/v3/observations/...
  -> core:         history/v3/core/...
```

A fixed-v3 Integrity invocation MUST NOT consume a `history/v2/core/...` snapshot merely because an older helper or contract was written when v2 was the only supported generation.

Likewise, a v2 Integrity invocation MUST NOT consume a `history/v3/core/...` snapshot.

The core snapshot generation is therefore coupled to the selected observation-history generation for that invocation. There is no independent normal Integrity core-generation selector.

`UK_AQ_R2_HISTORY_INTEGRITY_VERSION` remains an Integrity semantic/configuration version and MUST NOT be used as the storage-generation selector.

Backup/checkpoint schema names or format identifiers that retain `v2` in their names, including `r2_history_backup_state_v2`, do not select the observation or core storage generation.

## Run-scoped core identity

At run initialisation, Integrity MUST select the latest available complete committed core snapshot from the selected generation in the chosen Dropbox baseline.

The canonical manifest key is:

```text
history/<generation>/core/day_utc=<core_snapshot_day_utc>/manifest.json
```

where `<generation>` is exactly the selected `UK_AQ_R2_HISTORY_VERSION` for the Integrity invocation.

Examples:

```text
v2 -> history/v2/core/day_utc=2026-09-15/manifest.json
v3 -> history/v3/core/day_utc=2026-09-15/manifest.json
```

That exact snapshot is pinned for the entire invocation. Detection, source mapping, source-evidence workers, proposal builders, apply stages and final verification MUST all consume the same immutable run-scoped identity.

Crossing midnight UTC MUST NOT change the selected snapshot. A later, separate Integrity invocation may independently select a newer complete snapshot from the same selected generation.

## Process-boundary validation

Whenever a child process receives the pinned core identity, it MUST validate the supplied identity against the selected generation.

At minimum the child MUST prove:

1. the supplied manifest key is canonical for the selected generation;
2. the supplied manifest key exactly matches the coordinator-recorded identity;
3. the pinned manifest exists in the chosen combined-local or Dropbox-backed view;
4. supplied manifest hash and byte SHA-256 identities match the pinned manifest where present;
5. the manifest itself describes the same selected day and immutable identity;
6. no helper reconstructs a different-generation core path.

A fixed-v3 child receiving:

```text
history/v2/core/...
```

MUST fail closed.

A v2 child receiving:

```text
history/v3/core/...
```

MUST fail closed.

Validation MUST NOT be weakened by accepting either generation indiscriminately, stripping the generation segment before comparison, or treating a v2-specific helper name as authority for v3.

## Check-only, dry-run and apply

Generation selection and core identity are independent from mutation permission.

For a given selected generation, `--check-only`, repair dry-run and repair apply MUST use the same generation-matched core snapshot selection and pinning rules.

`--check-only` may read the generation-matched core snapshot and may acquire diagnostic source evidence, but it MUST NOT gain canonical write permission merely because it is permitted to launch a source-evidence child.

For the fixed-v3 check-only worker boundary, the intended contract remains:

```text
worker_purpose=source_evidence_only
canonical_writes_allowed=false
```

Core-generation selection does not change that permission boundary.

## Fixed-v3 Integrity admission boundary

This amendment does not authorise generic/manual v3 backfill execution.

Where the implementation currently restricts v3 to explicitly authorised Integrity paths, those restrictions remain load-bearing.

In particular:

- a fixed-v3 Integrity evidence/proposal child may consume `history/v3/core/...` only after passing the existing v3 Integrity admission checks;
- direct canonical v3 source repair remains coordinator-owned where the active Integrity contracts require proposal validation and coordinator publication;
- generic full-index rebuild support is not introduced by this amendment;
- AQI R2 history is not reintroduced for v3.

## Core table object keys

After the pinned manifest is accepted, every core child object used by the invocation MUST come from that pinned manifest or from paths proven to belong to the same selected core generation.

Connector, station, timeseries, phenomenon, observed-property and source-identity lookups MUST NOT silently fall back to another generation.

Shared parsing or validation code may be reused across generations when the physical format is intentionally compatible. Reuse of a helper whose name contains `v2` does not authorise a v2 namespace when the selected generation is v3.

## Failure behaviour

Integrity MUST fail before proposal construction or canonical mutation when:

- the supplied core manifest key belongs to a different generation from the selected observation-history generation;
- coordinator and child core identities differ;
- the pinned manifest or required child objects are unavailable;
- manifest byte/hash identity does not match the pinned identity;
- a child independently selects or reconstructs a different core generation;
- generation identity becomes ambiguous.

The error must identify the selected generation, requested/pinned manifest key and affected stage without exposing credentials.

## Documentation precedence

For generation selection and canonical core namespace, this amendment supersedes conflicting v2-only wording in `integrity.md` and `integrity_core_snapshot_identity.md`.

For the detailed latest-complete snapshot selection, immutable pinning, semantic-warning eligibility, cross-midnight behaviour, process-boundary propagation and audit requirements, `integrity_core_snapshot_identity.md` remains authoritative where it does not conflict with this amendment.

For the overall independent v2/v3 observation-generation architecture and the single normal `UK_AQ_R2_HISTORY_VERSION` selector, [`observation_history_v3_side_by_side_generation_contract.md`](observation_history_v3_side_by_side_generation_contract.md) remains authoritative.

For fixed-v3 worker write permissions and proposal/apply safety, the active Integrity safety contracts remain authoritative. This amendment changes generation identity, not write authority.

## Minimal structural validation

Before deployment, perform only targeted deterministic validation of this boundary.

The focused checks should prove:

1. v2 Integrity accepts a canonical `history/v2/core/day_utc=.../manifest.json` identity;
2. authorised fixed-v3 Integrity accepts a canonical `history/v3/core/day_utc=.../manifest.json` identity;
3. v3 rejects a v2 core identity;
4. v2 rejects a v3 core identity;
5. coordinator/child identity equality and manifest byte/hash validation remain enforced;
6. unauthorised generic v3 remains rejected;
7. check-only source-evidence mode remains noncanonical.

Functional acceptance occurs through the normal real TEST Integrity operation after deployment, not through a speculative local end-to-end run.
