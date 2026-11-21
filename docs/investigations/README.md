# TEST Ops implementation investigations

This public directory contains dated, **publication-safe** investigations directly associated with the Ops implementation, such as specific service diagnostics, code behaviour, performance measurements and operating evidence.

**These reports are historical, non-authoritative evidence.** Active architecture and behaviour are specified only by the appropriate contracts in TEST System Docs. Investigations do not authorise deployments, migrations, data changes or LIVE work.

## What belongs here

- Narrow Ops implementation reviews and technical diagnostics that are suitable for a **public** repository.
- Reports with date, source commit(s), observed runtime evidence and clearly labelled assumptions, outcomes and unresolved questions.
- Follow-up or supersession references where an earlier report is no longer current.

**Do not put cross-repository strategy, private GCP billing screenshots, sensitive infrastructure details, credentials or non-public operational/security assessments in this repository.** Cross-repository investigations, research alternatives and cost evidence belong in the private System Docs investigations archive. A private repository, however, is still not a place to store secrets.

Existing public reports remain available for their original context. Do not copy them into active contract locations or treat them as production authority.

## Historical public Git records

On 21 November 2026, two ingestion hosting and billing reports were mistakenly committed to this public directory. Their **current-tree copies were relocated to the private System Docs investigations archive**. Deleting a file from `main` does **not** remove earlier Git objects or commits, and those historical copies may remain publicly retrievable.

Please review publication suitability before committing future investigations. Use the top-level private System Docs archive for cross-repository or sensitive work.
