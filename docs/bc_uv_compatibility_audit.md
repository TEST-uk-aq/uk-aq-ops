# Read-only Black Carbon TEST/LIVE audit

Run `scripts/ukair_bc/audit_bc_uv_compatibility.mjs` from this repository with
Node 24 and the existing locked dependencies (`npm ci --ignore-scripts`).
This operator diagnostic does not change application behaviour or invoke a
publisher, reconciler, lock, workflow, migration or deployment.

## Independent inventories

Use an already authorised, appropriately scoped profile for **one environment per
process**. Load configuration through the normal operator mechanism or Node's
existing `--env-file` option. No credentials belong in commands, reports, commits,
PRs or chat. Do not substitute TEST credentials for missing LIVE access.

Existing configuration consumed:

- `UK_AQ_INGEST_DATABASE_URL`, falling back to `SUPABASE_DB_URL`: PostgreSQL
  metadata connection with SELECT access to the relevant `uk_aq_core` tables and
  `uk_aq_raw.ukair_bc_station_refs`, schema usage and the existing PostGIS functions.
- `OBS_AQIDB_SUPABASE_DB_URL`: optional SELECT connection to the existing core
  metadata mirror. Raw routing and policy mappings are not mirror requirements.
- `UK_AQ_R2_HISTORY_VERSION=v3`: existing selected-generation configuration.
- R2 configuration resolved by the existing `resolveR2HistoryIndexConfig`:
  `CFLARE_R2_ENDPOINT`, `CFLARE_R2_BUCKET`, `CFLARE_R2_REGION` (default `auto`),
  `CFLARE_R2_ACCESS_KEY_ID`, `CFLARE_R2_SECRET_ACCESS_KEY`, with its existing `R2_*`
  aliases/precedence. Use object-read credentials for the selected history bucket;
  this tool needs no write/delete permission and performs no bucket listing.

The operator selects the correct profile. `--environment` labels the report; it
does not cross-check repository, endpoint, account, bucket suffix or database
project. No new environment variables or target guards are introduced. A target
fingerprint identifies the selected R2 configuration without exposing its values.

For example, using existing private profile files outside Git:

```bash
mkdir -p work/bc-audit
node --env-file=/path/to/existing-test-profile.env scripts/ukair_bc/audit_bc_uv_compatibility.mjs inventory --environment TEST --through 2026-11-17 --out work/bc-audit/test.json
```

Independently, on a machine with authorised LIVE access and this diagnostic
checkout (no LIVE repository edits needed):

```bash
node --env-file=/path/to/existing-live-profile.env scripts/ukair_bc/audit_bc_uv_compatibility.mjs inventory --environment LIVE --through 2026-11-17 --out work/bc-audit/live.json
```

The fixed start is 1 January 2024. `--through` is an inclusive **canonical UTC
observation day**, defaulting to today's UTC day. Use the same value for both
inventories. GMT hour-ending 24:00 belongs to the preceding source day/month;
to check a product through source day D, include canonical day D+1. Dependencies
beyond the chosen audit scope are explicitly unresolved. Future absent boundary
days can be authenticated by the selected hierarchy, not invented observations.

Outputs are created exclusively with mode 0600: choose fresh filenames on rerun.
Parent directories must exist. An inventory writes its partial report and exits
1 on required access, metadata, validation, consistency or resource failures.
Unavailable optional mirror access is recorded. A complete inventory means the
reads finished, not that every metadata finding is compatible or history complete.
Driver exceptions/stacks/connection values are suppressed; failures expose only
safe operation codes. Inspect the named section's access/schema/metadata locally
if the generic `READ_OR_VALIDATION_FAILED` code appears.

## Offline comparison

Transfer the JSON files using the normal approved private mechanism, then run:

```bash
node scripts/ukair_bc/audit_bc_uv_compatibility.mjs compare --test work/bc-audit/test.json --live work/bc-audit/live.json --out work/bc-audit/comparison.md --json work/bc-audit/comparison.json
```

Comparison needs no credentials, database or R2 access. It accepts partial
inventories but labels unavailable evidence as unresolved; it never interprets
missing access as missing data. Different scopes withhold source comparison.
Invalid arguments/reports or local output failures exit 2; a successfully written
comparison exits 0, including one honestly reporting incomplete inventories.

Stable keys drive missing/extra/conflict comparisons. Numeric connector, network,
property, phenomenon, station and series IDs are reported separately. The JSON
retains detailed identities, gap ranges and per-day dependencies; Markdown
summarises metadata differences, station/property coverage and product provenance.

## Evidence and limits

The tool uses fixed SELECTs inside repeatable-read, read-only PostgreSQL
transactions, with session read-only defaults, timeouts and rollback. Core
metadata is re-read at the end to detect drift. It uses the project's R2 signing,
bounded GET, aggregate/canonical manifest validators, exact-leaf metadata reader,
publisher station selection and product/incremental validators.

It authenticates root → year → month → day → connector → pollutant membership and
hashes, reconciles child aliases, ties relevant scoped indexes to canonical source
manifest bytes, and validates pinned BC/UV exact leaves. It records canonical
content/file identities and metadata-backed per-series UTC ranges/counts.
Mutable ancestors/selectors and the derived latest body are rechecked before
the inventory is considered coherent. There is no mutation lock; a moving source
can cause an explicit failed inventory requiring a later rerun.

`latest.json` is validated against its byte-addressed immutable generation;
incremental provenance is checked against its own profiles, IDs and dependencies,
then compared with current local metadata/history. A changed source can mean a
legitimately older product. A valid legacy product without incremental provenance
is identified and cannot establish incremental reuse. TEST-to-LIVE checks compare
embedded connector/station/series IDs and day dependencies with LIVE prerequisites.

**No Parquet bodies are read.** Manifest/leaf presence, a row count of 24 or matching
file formats cannot certify valid values, exact hourly slots, P/R status, the
reporting summary's scientific correctness or accepted source coverage. Missing
day ranges may reflect source/property/station lifecycle. A result therefore does
not certify a complete LIVE bootstrap or authorise a TEST product copy. Accepted
LIVE source evidence and the publisher's canonical observation validation remain
necessary. Separate inventories also cannot prove a simultaneous TEST/LIVE state.

Hard bounds: 5,000 UTC days; 2,000 rows per metadata family; 120,000 R2 GETs including
the consistency fence; 1 GiB downloaded JSON; 8 MiB per metadata object; 32 MiB per
product; 30 minutes of R2 activity, with at most 30 seconds per GET. Exact-leaf
cache lifetime is one scope. Limits include the immutable product and rechecks;
failure does not silently truncate a successful inventory. No repeated polling
or automatic scheduled execution is added.

Each normal run uses eight metadata SELECTs plus transaction control, repeated once
for the final fence; optional mirror inspection uses six more SELECTs. There are
no per-station database calls or Gateway requests. This is manual diagnostic
traffic only; billed Supabase log bytes are unmeasured, not claimed as zero.

## Release decision

Prefer the existing official-source shared writer for missing/unaccepted LIVE BC
history from 2024 onwards, then bootstrap a LIVE-owned product. Skip historical
reconciliation only where accepted LIVE history already suffices. Verify the
LIVE API before Beta release, then accept/enable recurring daily refresh separately.
Consider a writer-mediated TEST import only if official acquisition is unavailable
or materially slower; that requires separate authority and LIVE identity remapping.
Never copy TEST parent manifests, indexes, latest pointers or embedded provenance
on the assumption that matching object formats imply portability.

No deployment or operational post-deployment check is needed for this addition.
Rollback is removal/reversion of the diagnostic files; no remote data changes
exist to undo. Existing contracts are preserved. The active BC/UV contract's
incremental acceptance status versus implemented TEST code is a separate
documentation handover, not resolved or rewritten by this diagnostic.
