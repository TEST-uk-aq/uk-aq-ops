# TEST GCP ingestion cost evidence: 21 November 2026

**Status:** Point-in-time user-supplied billing evidence; **non-authoritative investigation**, not a reconciled billing export or approved cost forecast.

**Source:** Two Google Cloud Billing Reports screenshots supplied in the 21 November 2026 conversation, captured at approximately **12:32 and 12:34 UK time**, for the TEST billing account. Report settings show `Current month` charge period, grouped by label `job_name`. The first screenshot has **Savings (none)**, and the second has **Savings (2 of 3)** selected. The chart shows actual coloured bars up to **20 November** and grey **forecast** bars thereafter. Only **rows 1–10 of 11** are visible in the table; the missing row and any unlabelled charges cannot be reconstructed from these screenshots.

## Visible costs (GBP)

The first numeric column is the screenshot's `Usage cost` with savings not selected. The second is the `Subtotal` from the screenshot showing two savings selections; it is **not independently reconciled against the invoice or billing export**.

| Label / service | Usage cost, savings none | Subtotal, savings selected |
| --- | ---: | ---: |
| `uk-aq-latest-snapshot-service` | £1.59 | £1.01 |
| `uk-aq-blondon-communities-ingest-service` | £1.27 | £0.60 |
| `uk-aq-blondon-nodes-ingest-service` | £1.20 | £0.46 |
| `uk-aq-saqn-ingest-service` | £1.16 | £0.37 |
| `uk-aq-waqn-ingest-service` | £0.86 | £0.39 |
| `uk-aq-sos-ingest-service` | £0.54 | £0.25 |
| `uk-aq-ni-ingest-service` | £0.50 | £0.21 |
| `[Charges for other usage]` | £0.21 | £0.21 |
| `uk-aq-observs-pubsub-writer-service` | £0.06 | £0.03 |
| `uk-aq-openaq-ingest-service` | £0.00 | £0.00 |

**Visible six recurring ingest services** (Communities, Nodes, SAQN, WAQN, SOS and NI): **£5.53** in usage cost and **£2.28** in displayed subtotal after savings. The retained Latest Snapshot service is separately **£1.59** usage cost / **£1.01** displayed subtotal. The figures are rounded to pennies per service, so subtotals derived by addition may differ slightly from underlying billing export figures.

**Interpretation boundary:** These screenshots do **not** establish that migrating the six ingests will save £2.28 in a future month. Cloud Run allowances, discounts, credits, charge attribution and other project/account spending may redistribute after migration. Nor do these figures represent the full GCP bill, because the table has an unseen row and may exclude unlabelled or differently grouped costs.

## Context affecting before/after comparisons

- The checked-in six-service cadence change to `*/30` from `*/15` was committed **18 November 2026 at 23:18 UTC**: [ingest change `7fa1b02`](https://github.com/TEST-uk-aq/uk-aq-ingest/commit/7fa1b02). Effective D1 sync time and deployed settings were **not verified** in the supplied investigation.
- The Breathe London Communities database transport/write-profile work changed around 15–16 November, separately affecting cost and log usage. Do not attribute those changes to the interval adjustment.
- As of 21 November, fewer than three complete days had elapsed since the configuration commit, so the screenshots cannot establish a like-for-like full-week impact of the 30-minute cadence.
- OpenAQ has separate self-scheduling through Cloud Tasks. A disabled Cloudflare safety row does not by itself establish that OpenAQ has no live work; this screenshot shows only the visible label's reported cost.

## Financial decision still open

Use the existing [GCP billing collector](https://github.com/TEST-uk-aq/uk-aq-ops/blob/main/local/gcp_billing/README.md) and authoritative BigQuery billing exports, with **Standard** financial totals and **Detailed** resource attribution (do not add them together), to establish:

1. Matched complete UTC-day or weekly charge windows before/after the effective D1 schedule change, and a reconciled reporting/credit basis.
2. Actual per-connector Cloud Run billed CPU, memory, requests, no-op checks, revisions, and runtime counts.
3. Remaining Latest Snapshot, Pub/Sub, consumer, Scheduler, Cloud Tasks, Logging and network charges, plus unattributed/unlabelled amounts.
4. Incremental alternative-hosting costs, Mac power use, any new Cloudflare charges, fallback invocation costs and the resulting **net** monthly saving.
5. Equivalent source coverage, observation freshness, downstream publication and recovery reliability.

**Related investigation:** [UK AQ ingestion architecture review](2026-11-21-ingest-hosting-cost-review.md). Its recommendation is to retain GCP primary until the avoidable **net** charge is measured; keep Latest Snapshot on GCP.

**Future work:** The broader Cloudflare Workers/Containers, GitHub Actions, MacBook, Supabase and alternative-provider analysis was requested separately and has not been incorporated in this evidence note.
