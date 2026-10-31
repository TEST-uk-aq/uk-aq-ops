# ChatGPT documentation handover: proposed Prune staging removal

Status: investigation/proposal only. No application implementation, authoritative documentation or operational configuration has changed.

See [the investigation](../investigations/r2-observation-staging-retirement-assessment-2026-10-31.md) for pinned source evidence, complete TEST file list, safety boundaries and acceptance proposal.

No behavioural contract amendment is required to permit removal: active contracts require verified canonical publication, retry-safe failure handling and source-deletion gates, not the obsolete R2 age sweep. Preserve those contracts without weakening their verification, global lock, READY/CONSUMED or backup/recovery requirements.

After a separately reviewed implementation, ChatGPT in Chat mode may clarify `system_docs/r2_history/prune_daily_observation_only_phase_b_contract.md` and, only if needed, `prune_daily_runtime_budget.md`: normal Prune has no legacy R2 staging producer or recurring cleanup, local frozen-source disposal remains, and canonical/migration/Integrity recovery stores keep their existing authority. Avoid duplicating the implementation inventory in system docs. Do not describe the proposal as deployed or accepted until real evidence is supplied.

Schema: none. Configuration: retire `UK_AQ_R2_HISTORY_STAGING_PREFIX`, `UK_AQ_R2_HISTORY_STAGING_RETENTION_DAYS` and HTTP `historyStagingRetentionDays`; align the Ops workflow, target map, private ignored catalogue and separately authorised TEST settings. No replacement v3 prefix or environment-specific code. Reporting: new summaries omit `staging_cleanup`; historical reports remain readable and intact.

The investigation establishes structural viability only. Subsequent implementation must supply syntax/configuration and required focused Node regression evidence, followed by real TEST normal v3 publication/finalisation/atomic source deletion, correct reporting and absence of staging access. Existing deterministic failure checks remain; do not deliberately corrupt operational data to create a retry.

Keep PR #152's staging exclusion until separately accepted LIVE removal. Any later staging-namespace retirement requires its own final paginated inventory, manual/installed-producer and recovery/hold disposition, evidence record and approval. An empty inventory adds no deletion entries; this handover does not expand the empty approved manifest or authorise R2/Dropbox/configuration mutations.
