# Observs partition maintenance contract

## Authority and scope

This document is the authoritative current-runtime contract for:

`TEST-uk-aq/uk-aq-ops/workers/uk_aq_observs_partition_maintenance_service/`

and the GitHub Actions wrapper:

`.github/workflows/uk_aq_observs_partition_maintenance.yml`

It supersedes partition-maintenance behaviour described in `system_docs_legacy/uk-aq-observs-partition-maintenance.md`.

The service maintains `uk_aq_observs.observations` daily partitions in Obs AQI DB. It may create/repair partitions and indexes, report default-partition diagnostics, and remove old database partitions under the safety rules below.

It is **not** an R2 history writer. It MUST NOT create, mutate, repair or delete canonical observation-history objects in R2.

## Selected observation-history generation

Observs partition maintenance MUST follow the same single observation-history generation selector used by the active observation-history runtime:

`UK_AQ_R2_HISTORY_VERSION`

The selected generation MUST be resolved through the shared observation-history generation contract/runtime helper. For the supported generations, the canonical observations prefix is:

```text
v2 -> history/v2/observations
v3 -> history/v3/observations
```

Partition maintenance MUST NOT independently select observation history through:

- a hard-coded `history/v2/observations` path;
- a hard-coded `history/v3/observations` path;
- `UK_AQ_R2_HISTORY_V2_OBSERVATIONS_PREFIX`;
- a service-specific v2/v3 selector;
- a guessed/default generation when `UK_AQ_R2_HISTORY_VERSION` is missing or invalid.

The workflow MUST provide `UK_AQ_R2_HISTORY_VERSION` and MUST treat a missing or invalid selector as a configuration failure before any retention deletion can be authorised.

The service MAY retain generic R2 endpoint/bucket/credential configuration required to read the selected-generation manifest.

## Day-manifest deletion authority

For a UTC day `D`, the selected-generation deletion-authority object is exactly:

```text
history/<selected-generation>/observations/day_utc=<D>/manifest.json
```

A non-empty Obs AQI DB partition MUST NOT be dropped merely because a day manifest exists in another generation.

Historical v2 objects are not current deletion authority while v3 is selected, even when they are individually valid and even when the same day existed before cut-over.

Before a selected-generation day manifest can authorise deletion, partition maintenance MUST establish all of the following from the fetched object:

- the object exists at the exact selected-generation key;
- the body is valid JSON and is an object;
- `manifest_kind` is `day`;
- `domain` is `observations`;
- `day_utc` exactly equals the candidate partition day;
- `manifest_key` exactly equals the selected-generation key being checked;
- `manifest_hash` is present and equals the SHA-256 of the manifest payload excluding `manifest_hash`.

The manifest's logical `history_version` field MUST NOT be used as the storage-generation selector. Existing canonical observation manifests may retain their established logical history-version identity while residing in the selected v3 storage generation.

Missing, malformed, contradictory or wrong-generation evidence MUST fail closed for a non-empty partition.

## Retention and drop behaviour

The configured retention cutoff determines which daily partitions are candidates for removal. Being a drop candidate is not itself permission to delete data.

For each candidate partition:

1. If partition-drop dry-run mode is active, do not drop the partition and record the dry-run skip.
2. Otherwise, check and validate the selected-generation day manifest as defined above.
3. If the selected-generation manifest is confirmed, the partition may proceed to the normal drop RPC.
4. If the selected-generation manifest is not confirmed, check whether the Obs AQI DB day contains rows.
5. If the day is confirmed empty, the empty partition may be dropped without a history manifest.
6. If the day contains rows, or row presence cannot be established safely, do not drop it. Record a bounded skipped-drop reason/evidence.
7. If the drop RPC reports that the drop was not applied, retain the partition and report the skip.

This is a fail-closed deletion boundary. A history lookup failure must result in retaining non-empty database data, not in bypassing the R2-history gate.

## Successful-drop housekeeping

After a successful partition drop, the service may best-effort remove the matching Observs row from the current day-count operational table through the existing RPC.

Failure of that day-count housekeeping MUST NOT imply that the observation partition should be recreated or that canonical R2 history is invalid. The normal day-count refresh path may reconcile the operational count later.

## Partition and index maintenance

The service continues to own:

- ensuring the required UTC-day partitions through the configured future horizon;
- applying the configured hot/cold index policy;
- reporting default-partition diagnostics;
- applying the configured Observs retention horizon.

These behaviours are unchanged by the observation-history v3 routing correction.

## Daily Task Health summary

A successful maintenance run MAY finish with structured warnings when safety conditions cause candidate drops to be skipped.

In particular, if one or more candidate partitions are retained because their selected-generation history evidence is not confirmed, the existing summary warning such as:

```text
skipped drops: <count>
```

is appropriate.

A skipped drop is a safety decision, not evidence that the maintenance workflow itself failed.

The detailed report SHOULD retain bounded per-partition skip evidence sufficient to identify the partition day, selected-generation manifest key/check result and row-presence result.

## Scheduling

The active scheduled execution path is the GitHub Actions workflow `uk_aq_observs_partition_maintenance.yml`, invoked by the ops scheduler configuration.

The current scheduler entry is daily at `03:00 UTC`.

Historical Cloud Run scheduling instructions in legacy documentation are not current authority for this task.

## Configuration safety

The service MUST fail before retention deletion when required Obs AQI DB or R2 access configuration is absent.

The selected observation-history generation MUST come from `UK_AQ_R2_HISTORY_VERSION`. A missing selector MUST NOT silently fall back to v1, v2 or any service-local prefix.

No schema migration is required merely to correct generation routing.

## Structural validation before deployment

Before deployment, validate only structural viability of the changed implementation/configuration, including:

- JavaScript syntax for changed JavaScript;
- YAML parsing for the changed workflow;
- the existing shared observation-history generation resolver being used with the expected `v2`/`v3` prefix mapping;
- no remaining active partition-maintenance path that hard-codes the v2 observations prefix as deletion authority.

Do not add a speculative pre-deployment functional test suite.

Because this service controls destructive database retention, one small deterministic check of the generation-routing/deletion-authority boundary is justified if the existing repository checks cannot establish that a selected v3 run cannot accept a v2 manifest path.

## TEST operational acceptance

After deployment to TEST, run the real Observs Partition Maintenance workflow.

When TEST is selected to v3, acceptance requires:

1. the report identifies/checks `history/v3/observations/day_utc=<D>/manifest.json` for non-empty old partitions;
2. no v2 day manifest is accepted as deletion authority;
3. a valid selected-generation day manifest permits the normal eligible partition drop;
4. a missing/invalid selected-generation manifest retains a non-empty partition and reports a skipped drop;
5. an empty old partition may still be dropped through the existing empty-day path;
6. Daily Task Health remains `Finished` when the workflow succeeds, with a warning only when one or more drops are actually skipped;
7. canonical R2 history is not mutated by the maintenance run.

For the currently observed TEST condition from 23/09/2026, rerunning after the generation-routing fix should cause the previously v2-404-skipped partitions to use v3 authority. If their v3 day manifests are present and valid, they should become eligible for normal deletion. Any partition still skipped must retain its selected-v3 check result in the report for diagnosis.

## Rollback

Rollback is code/configuration rollback only.

No R2 data rollback, database schema rollback or history-generation migration is required for this correction. A rollback MUST NOT reintroduce a non-selected-generation manifest as deletion authority.
