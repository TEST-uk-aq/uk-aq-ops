# GCP Cloud Logging analysis archive

## Status

**Future implementation authority.** The TEST implementation is being prepared in `TEST-uk-aq/uk-aq-ops` but this area MUST NOT be treated as evidence that the collector has been installed or accepted on the MacBook Pro.

## Purpose

This area owns the agreed behaviour for the UK AQ TEST Google Cloud Logging analysis archive: read-only retrieval from TEST Cloud Logging, long-term raw retention in the locally Dropbox-synchronised filesystem, local resumable state, archive identity protection, redaction compatibility and safe operator recovery.

The archive is for retrospective performance and cost analysis. Google Cloud Logging remains the recent operational troubleshooting source.

## Reading order

1. Read [`contract.md`](contract.md) for required archive, identity, retrieval, publication, checkpoint and recovery behaviour.
2. Read [`../operator_execution/README.md`](../operator_execution/README.md) when changing long-running backfill progress, persistent run logs or structured run reports.
3. Read the implementation runbook in `TEST-uk-aq/uk-aq-ops/local/gcp_logging_archive/README.md` for installation and operator commands.
4. Read `plans/2026-09-22 GCP Cloud Logging Dropbox Archive/PLAN.md` only for implementation sequencing and historical planning context.

## Ownership and boundaries

- TEST Google Cloud Logging is the source for the retained log entries.
- The Dropbox archive is derived, analysis-oriented retention and is not a live logging authority.
- Local checkpoints record successfully published source progress; they are not proof that archive files are valid.
- The archive identity manifest binds an archive generation to its source scope, resolved destination and redaction policy.
- Per-run logs and reports are diagnostic evidence and do not become source or checkpoint authority.
- GCP billing truth remains owned by the separate GCP billing subsystem.
- LIVE collection is a later, separate decision and MUST NOT be inferred from TEST configuration.

## Implementation ownership

The local collector, launchd template, configuration example and runbook belong in `TEST-uk-aq/uk-aq-ops`.

Codex and other coding agents treat this area as read-only. Behavioural changes discovered during implementation must be handed back to ChatGPT in Chat mode for authoritative documentation review.
