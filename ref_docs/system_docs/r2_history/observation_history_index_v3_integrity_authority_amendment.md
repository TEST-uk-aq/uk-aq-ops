# Observation-history index v3 Integrity-version authority amendment

## Authority and scope

This document is the authoritative narrow amendment for how `UK_AQ_R2_HISTORY_INTEGRITY_VERSION` is sourced and verified during the observation-history index-v3 migration and cut-over.

It amends [`observation_history_index_v3_operator_contract.md`](observation_history_index_v3_operator_contract.md) only where that contract describes `UK_AQ_R2_HISTORY_INTEGRITY_VERSION` as a persistent GitHub repository authority or requires operator gates to read that value from GitHub.

All other operator, migration, rollback, candidate, cache, writer-freeze and acceptance rules remain unchanged.

This amendment records the authority model accepted during the TEST rehearsal on 29 August 2026 after the post-cut-over verifier exposed that no repository variable exists for the Integrity semantic version.

## Decision

`UK_AQ_R2_HISTORY_INTEGRITY_VERSION` remains an independent Integrity semantic version and MUST NOT be changed merely because the observation-timeseries index generation changes.

For the current TEST and later restricted LIVE index-v3 migration, it is a **loaded environment/profile value**, not a persistent GitHub repository authority.

The required value remains exactly:

```text
UK_AQ_R2_HISTORY_INTEGRITY_VERSION=v2
```

The migration and cut-over do not create, require or justify a GitHub repository variable named `UK_AQ_R2_HISTORY_INTEGRITY_VERSION`.

A GitHub variable MUST NOT be added solely to satisfy migration tooling or verification.

## Persistent authority boundary

The persistent repository authority relevant to the observation-history generation boundary remains:

```text
UK_AQ_R2_HISTORY_VERSION=v2
UK_AQ_R2_HISTORY_INDEX_VERSION=v2|v3
```

The expected transition is:

```text
before cut-over
  UK_AQ_R2_HISTORY_VERSION=v2
  UK_AQ_R2_HISTORY_INDEX_VERSION=v2
  loaded UK_AQ_R2_HISTORY_INTEGRITY_VERSION=v2

after cut-over
  UK_AQ_R2_HISTORY_VERSION=v2
  UK_AQ_R2_HISTORY_INDEX_VERSION=v3
  loaded UK_AQ_R2_HISTORY_INTEGRITY_VERSION=v2
```

The stable Worker-name and other environment-identity repository variables remain governed by their existing contracts. This amendment changes only Integrity semantic-version authority.

## Operator-gate requirements

Operator tooling MUST require a non-empty loaded `UK_AQ_R2_HISTORY_INTEGRITY_VERSION` value and MUST require it to equal `v2` for this migration unless a separate authoritative Integrity semantic-version migration has first been agreed and implemented.

Where immutable migration evidence records Integrity semantic version, the loaded value MUST agree with that accepted evidence.

For example, an accepted migration plan or rollback record may contain:

```text
integrity_version = v2
```

That evidence is a migration/rollback identity assertion. It does not make GitHub the configuration source for the Integrity semantic version.

Operator tooling MUST fail closed if:

- the loaded Integrity semantic-version value is missing;
- the loaded value is not exactly `v2` for the current migration;
- accepted pinned migration or rollback evidence records a contradictory Integrity semantic version.

Operator tooling MUST NOT fail merely because `gh variable get UK_AQ_R2_HISTORY_INTEGRITY_VERSION` is unavailable, because that GitHub variable is not part of the accepted authority model.

## Preflight requirement

The read-only preflight MUST independently verify persistent GitHub values that genuinely have repository authority, including the logical history and observation index versions, but it MUST validate the Integrity semantic version from the loaded environment and pinned migration evidence rather than requiring a GitHub variable.

The preflight remains fail-closed for all real contradictions.

This amendment does not weaken the requirement that expected environment identity and actual persistent configuration be established independently where an independent persistent source actually exists.

## Post-cut-over verifier requirement

The post-cut-over verifier MUST establish the accepted boundary as:

```text
persistent GitHub logical history authority = v2
persistent GitHub observation index authority = v3
loaded Integrity semantic version = v2
accepted migration/rollback evidence Integrity semantic version = v2 where applicable
```

It MUST NOT describe this as three persistent GitHub `v2/v3/v2` authorities.

The accepted TEST post-cut-over verifier implementation follows this rule.

## Implementation reconciliation

As of this amendment, the TEST post-cut-over verifier has been corrected to follow this authority model.

The pre-migration `scripts/index_v3_migration/index_v3_preflight.sh` still requires reconciliation if it attempts to read `UK_AQ_R2_HISTORY_INTEGRITY_VERSION` from GitHub.

That implementation mismatch is a blocker for relying on the preflight in the later LIVE runbook. It MUST be corrected and rehearsed on TEST before LIVE migration execution.

The required correction is narrow: retain the loaded `v2` check and migration-evidence checks, while removing any requirement for a GitHub Integrity-version variable. It MUST NOT weaken any unrelated environment, repository, scheduler, backup, maintenance, writer-freeze or migration-authority gate.

## Superseded operator-contract wording

Within [`observation_history_index_v3_operator_contract.md`](observation_history_index_v3_operator_contract.md), the following concepts are superseded by this amendment:

- wording requiring operator gates to read a configured GitHub `UK_AQ_R2_HISTORY_INTEGRITY_VERSION` value;
- wording describing post-cut-over `v2/v3/v2` as three persistent GitHub history/index/integrity authorities.

The intended interpretation is instead:

```text
persistent GitHub history/index authority + loaded Integrity semantic version
```

## Change rule

Any future decision to make `UK_AQ_R2_HISTORY_INTEGRITY_VERSION` a persistent repository authority, rename it, or change its semantic meaning requires an explicit Integrity contract change and coordinated implementation update. It MUST NOT happen implicitly as part of an observation-history index-generation migration.
