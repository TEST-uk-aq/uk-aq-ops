# BC/UV TEST/LIVE compatibility: read-only findings

Observed 17 November 2026 (UTC). No remote data mutations or workflow runs.

## Conclusion

The quickest supported route is the existing official-source BC/UV reconciliation
and LIVE-owned publisher, limited to missing/unaccepted history from 2024 onwards.
If a separately authenticated inventory establishes sufficient accepted LIVE
canonical history, skip historical reconciliation and bootstrap directly from it.
Deploy and accept the LIVE read path before releasing the Beta page; accept and
enable routine refresh separately. Do not add an importer merely to avoid running
the existing accepted source/writer path.

**LIVE data readiness remains unresolved.** This session has GitHub read access,
but no authorised IngestDB, ObsAQIDB or R2 connections/configuration for either
environment. No credentials were requested, borrowed from TEST or extracted from
GitHub secrets. An unavailable connection is not evidence that data is absent.

## Proven repository findings

GitHub Contents API checks against accessible LIVE repositories' `main` returned
404 for these paths:

| Repository | Missing implementation path |
|---|---|
| UK-AQ/uk-aq-ops | `scripts/ukair_bc/build_bc_uv_diurnal.mjs` |
| UK-AQ/uk-aq-ops | `scripts/ukair_bc/uk_aq_ukair_bc_observation_reconciler.mjs` |
| UK-AQ/uk-aq-ops | `.github/workflows/uk_aq_bc_uv_diurnal_publish.yml` |
| UK-AQ/uk-aq-ops | `.github/workflows/uk_aq_ukair_bc_observation_reconciliation.yml` |
| UK-AQ/uk-aq-ops | `.github/workflows/uk_aq_ukair_bc_daily.yml` |
| UK-AQ/uk-aq-ops | `workers/uk_aq_observs_history_r2_api_worker/bc_uv_diurnal_route.mjs` |
| UK-AQ/uk-aq-ops | `workers/uk_aq_cache_proxy/src/bc_uv_diurnal_route.ts` |
| UK-AQ/beta-uk-aq | `wood-burning/index.html` |

The LIVE Obs-history Worker entry point was readable (Git blob
`1cb16d3b90b5bafd58c26610a3ef18e4c13108d9`), as was the cache-proxy entry point
(`a9beef668ef322ec4e7977c22125074b71118535`); neither contains the BC diurnal route
integration. These establish source-tree readiness gaps, not deployed resource
state. No LIVE repository was modified. No Dropbox inspection was used.

TEST Ops inspection used `main` at `de5fab0f` and covered the BC reconciler and
locked shared-writer integration, publisher, product/incremental validators,
both BC Worker routes, all three BC workflows, generation selector, R2 signing,
manifest validators and exact-leaf metadata reader.

The existing TEST publisher validates its previous body/provenance and immutable
generation, resolves eligible metadata, derives from selected v3 canonical history,
rechecks metadata/source, then publishes immutable bytes before latest. Its
incremental derivation contains the numeric connector ID and station/timeseries
identities; monthly fingerprints include the following month's first UTC day.
Those identities cannot be assumed portable to another database or canonical root.

## Missing access and unanswered data questions

| Requested evidence | Result in this session |
|---|---|
| Canonical connector/network/property rows and public eligibility | Unread: no IngestDB SELECT connection |
| UKA references, classification, status, coordinates, numeric IDs and routes | Unread: no IngestDB SELECT connection |
| IngestDB-to-ObsAQIDB mirror alignment | Unread: no optional mirror connection |
| Selected deployed LIVE generation and authenticated BC/UV coverage since 2024 | Unread: no configured R2 access or generation selector |
| TEST/LIVE station/property coverage, dates, gaps and manifest/content identities | Unresolved |
| Current derived products, immutable hashes, source-through day and month coverage | Unread: no R2 access |
| Latest BC reporting summary, station count and provenance consistency | Unresolved |
| Whether accepted LIVE history already suffices for bootstrap | Unresolved |

The requested plan's earlier structural observation that TEST had a roughly
10.6 MB product and LIVE had none is **documented prior evidence**, not a fresh
authenticated R2 finding from this audit. It must not substitute for the inventories.

The diagnostic was invoked independently with TEST and LIVE labels and no data
configuration. Both wrote partial JSON reports and exited 1, explicitly reporting
`MISSING_INGESTDB_CONNECTION` and `MISSING_HISTORY_GENERATION_CONFIGURATION`.
The offline comparison rendered both as incomplete and left canonical/product
presence unresolved. This checks failure/reporting behaviour; it is not a data audit.

## Decisions requiring the independent inventory

1. Compare stable `ukair_bc`, `black_carbon`, UKA station refs and deterministic
   `<UKA>:bc` / `<UKA>:uv370` refs; keep numeric differences separate. Verify
   public eligibility and authoritative short-code routing before a source run.
2. Establish selected LIVE v3 canonical coverage using the diagnostic. Manifest
   membership and exact-leaf metadata identify available scopes and detectable
   gaps, but do not certify valid observation bodies, P/R or complete source coverage.
3. Use accepted LIVE source evidence and normal publisher validation to decide
   bootstrap sufficiency. A new historical reconciliation is necessary if LIVE
   lacks the required canonical history; otherwise reconcile only missing or
   unaccepted scopes, preserving unrelated data.
4. Reusing TEST's derived bytes without a new LIVE canonical publication is **not
   established**. The tool reports necessary numeric-identity and dependency
   matches; they still require accepted LIVE source/implementation evidence. The
   straightforward path is a LIVE-owned derivation, even if canonical histories match.
5. A writer-mediated TEST history import could help only if official acquisition
   is unavailable or demonstrably slower. No timing/access evidence establishes
   that advantage here. A new importer needs a separate TEST-first contract and
   acceptance, authenticated source coverage, LIVE identity remapping, selected
   scope and the existing locked writer/finaliser. Blind object copying is unsuitable.

See [usage and exact independent-run commands](../docs/bc_uv_compatibility_audit.md).
Run from a diagnostic checkout with the appropriate existing private profile;
no LIVE repository edits or simultaneous TEST/LIVE access are needed.

## Authority, validation and handover

Authoritative documentation was read from TEST system-docs, starting at
`SYSTEM_OVERVIEW.md` and following the relevant ingest, R2-history, cache-proxy,
website and low-log routes. Current `main` was fetched read-only; requested plan
and draft were read at `9b3df65`. The draft remains non-authoritative. Existing
active BC source/identity/history/product contracts retain precedence. The
16 November application configuration policy is preserved: no additional
repository/account/project/bucket identity guards or new configuration mechanisms.

Changed files are the new diagnostic, its usage document and this findings note.
No existing application code, workflow, schema or authoritative documentation changed.
Structural validation covers syntax/module loading, independent missing-access
inventories and offline comparison; populated authenticated inventories remain
unexecuted until scoped connections are available. No speculative tests were added.
The directly relevant existing incremental-validation file passed all six checks,
including adjacent midnight dependencies, historical P/R changes and malformed
provenance. This verifies the reused validator, not a populated audit integration.

No apply, migration or deploy command is required. No remote rollback is needed;
revert the diagnostic additions if desired. Post-deployment TEST validation does
not apply. A documentation handover remains for ChatGPT in Chat mode: reconcile
the active BC/UV contract's incremental status with accepted real TEST workflow
evidence before declaring incremental mode current runtime. This audit neither
changes that authority nor establishes new operational acceptance.
