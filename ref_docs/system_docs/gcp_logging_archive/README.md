# GCP Cloud Logging analysis archive

## Status

**Active TEST runtime and future shared TEST/LIVE implementation authority.** The TEST collector is installed and operating on the MacBook Pro. This area also authorises the next refactor to one environment-agnostic implementation for TEST and LIVE. LIVE collection is not active until its separate environment configuration and operational acceptance are completed.

## Purpose

This area owns the agreed behaviour for the UK AQ Google Cloud Logging analysis archive: read-only retrieval from the selected TEST or LIVE environment, long-term raw retention in the locally Dropbox-synchronised filesystem, environment-isolated local resumable state, archive identity protection, redaction compatibility and safe operator recovery.

The archive is for retrospective performance and cost analysis. Google Cloud Logging remains the recent operational troubleshooting source.

## Reading order

1. Read [`contract.md`](contract.md) for required archive, identity, retrieval, publication, checkpoint and recovery behaviour.
2. Read [`../operator_execution/README.md`](../operator_execution/README.md) when changing long-running backfill progress, persistent run logs or structured run reports.
3. Read the implementation runbook in `TEST-uk-aq/uk-aq-ops/local/gcp_logging_archive/README.md` for installation and operator commands.
4. Read `plans/2026-09-22 GCP Cloud Logging Dropbox Archive/PLAN.md` only for implementation sequencing and historical planning context.

## Ownership and boundaries

- `UK_AQ_ENV_NAME`, read from the corresponding local ingest repository `.env`, selects exactly one environment: `TEST` or `LIVE`.
- The selected environment's Google Cloud Logging project/filter and credentials are the source for retained log entries; TEST and LIVE identities MUST remain separate.
- Operational runtime material belongs under `/Users/mikehinford/uk-aq-gcp-logging-archive/<ENV>/`; the GCP logging archive subsystem MUST NOT use either `~/Library/Logs/UK-AQ` or `~/Library/Logs/UK AQ` for new runtime logs/evidence.
- Raw archives remain in `/Users/mikehinford/Dropbox/Apps/github-uk-air-quality-networks/<ENV>/GCP Logs`.
- The Dropbox archive is derived, analysis-oriented retention and is not a live logging authority.
- Local checkpoints record successfully published source progress; they are not proof that archive files are valid.
- The archive identity manifest binds an archive generation to its source scope, resolved destination and redaction policy.
- Per-run logs and reports are diagnostic evidence and do not become source or checkpoint authority.
- GCP billing truth remains owned by the separate GCP billing subsystem.
- LIVE collection is explicitly authorised by this contract but MUST NOT reuse or infer TEST project, filter, archive identity, checkpoint or credential values.

## Implementation ownership

The authoritative implementation is developed and accepted first in `TEST-uk-aq/uk-aq-ops`. The collector, runner and templates MUST be environment-agnostic. After TEST acceptance, the bounded GCP logging implementation files may be promoted to the local LIVE ops repository without copying system documentation into LIVE.

Codex and other coding agents treat this area as read-only. Behavioural changes discovered during implementation must be handed back to ChatGPT in Chat mode for authoritative documentation review.
