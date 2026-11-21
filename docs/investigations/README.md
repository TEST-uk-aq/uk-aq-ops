# TEST Ops technical investigations

This directory holds **dated, point-in-time investigations, audits and architectural assessments** spanning UK AQ components and repositories. Preserve evidence and the reasoning behind proposals so that a later review can start from known findings without assuming old conclusions still describe today's deployment.

## Status and authority

- Reports here are **non-authoritative evidence**, not current runtime contracts, approved implementation plans, live configuration, migrations or deployment authorisation.
- Authoritative requirements live in [TEST System Docs](https://github.com/TEST-uk-aq/uk-aq-system-docs/tree/main/system_docs), beginning with [SYSTEM_OVERVIEW.md](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/main/system_docs/SYSTEM_OVERVIEW.md). If a report conflicts with a current contract, the contract prevails and the conflict must be reported.
- Proposed implementation decisions and their status belong in the relevant [System Docs plans](https://github.com/TEST-uk-aq/uk-aq-system-docs/tree/main/plans); an accepted future behaviour belongs in the appropriate active system contract and, where useful, an architecture decision record.
- Do not delete or silently rewrite older evidence when findings change. Date and link a new review, and add a supersession notice or follow-up link where useful. Git history tracks report revisions.

## Recommended report metadata

Record the **date**, scope/TEST environment, status (investigation, superseded, follow-up, accepted evidence), source revision or deployed configuration evidence, and links to relevant contracts. Distinguish **confirmed code facts**, **observed real operations**, **user-supplied evidence**, **assumptions/estimates**, **proposals** and **unresolved decisions**. Include cost-source dates and credit/discount treatment where applicable. Never treat repository schedule defaults as proof of active D1 settings.

Use clear dated filenames such as `YYYY-MM-DD-topic-review.md`. Cross-repository research can be archived here without duplicating the active contract prose. Keep credentials, raw secrets and private account data out of Git.

## Ingestion cost and alternative hosting (21 November 2026)

- [Ingestion architecture and MacBook/GCP failover review](2026-11-21-ingest-hosting-cost-review.md): full original first Codex review, pinned to the four TEST revisions, including per-connector feasibility, unsafe naive staggered failover and the safer completion-aware option.
- [November GCP billing screenshot evidence](2026-11-21-ingest-billing-evidence.md): gross versus selected-savings subtotals, the 30-minute change, comparability limitations and measurements still needed.
- [System Docs investigation index and decision gates](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/main/plans/2026-11-21%20GCP%20Ingestion%20Cost%20Reduction/README.md): open decisions and future cross-platform review.

**Still pending:** a broader independent comparison of Cloudflare Workers, Cloudflare Containers, GitHub Actions, Supabase, VPS and other providers. No results for that second investigation are archived yet. Do not create a placeholder report that could be mistaken for completed evidence.
