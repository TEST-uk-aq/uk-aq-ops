# WHO 2021 R2 relocation and legacy calculated-AQI retirement assessment

Assessment date: **1 November 2026**. Scope: **TEST investigation and planning only**. No implementation, migration, copy, deletion, deployment or operational run is authorised by this document.

## Decisions proposed for separate implementation approval

1. **WHO:** move the derived WHO dataset to **`who_2021/` in the existing configured history bucket** (`uk-aq-history-cic-test` for TEST). Introduce one shared, explicitly configured output-prefix resolver used by the publisher and summary reader, and pass that resolved prefix to the SQL Parquet-row RPC. Establish independent WHO dataset backup before migration. Seed and validate the new namespace while WHO writers are held, switch the reader to the seeded dataset, then resume the publisher at the new root. Retain the old objects for a bounded rollback period and retire them only through a later approved per-key operation. Permanent dual-path reads are unnecessary.
2. **AQI:** retire only demonstrably obsolete **persisted UK AQ calculated AQI history and its dedicated indexes** after closing every deployed/manual reader and writer. The supplied AQI index/latest estimate is **approximately 2,492 objects / 10.371 MiB**. It is an eventual saving, not an approved deletion set. Shared bindings, source observations, current calculation/display functionality, WHO, Core and recovery/control evidence remain protected.

These recommendations are independently actionable. WHO relocation does not require AQI retirement; AQI consumer closure does not require WHO relocation. Neither permits blanket deletion of `history/v2/` or `history/_index_v2/`. **The approved/executable deletion set from this investigation is empty: 0 objects, 0 bytes.**

## Evidence, authority and limits

### Source baseline and PR review

The report is based on the current TEST `main` sources fetched during this investigation:

| Repository | Pinned revision |
|---|---|
| [TEST Ops][ops] | `f4ebe87003742cc9be775f81dd797c3e32e9a3a8` |
| [Authoritative TEST system docs][contracts] | `81df5aeb3d90cd4fcf631587d46baa1b6e51d1d2` |
| [TEST schema][schema] | `ee8a5ab568e011587b3b8c8fd0def6b54669fdaa` |
| [TEST website][website] | `494a5fd66297d0442f3207c566e9a1e2c3ae5973` |

Read the Ops `AGENTS.md`, then authoritative `system_docs/SYSTEM_OVERVIEW.md` and the relevant `r2_history/`, `backup_and_recovery/`, `who_2021/`, `aqi-levels/` and `cache_proxy/` routers/contracts. Explicit side-by-side generation and website/Core/backup amendments override older logical-v2 examples. In particular, selected-v3 physical backup inventory is `history/_index_v3/backup_inventory_v2/`; the `v2` in its format name is not a storage-generation selector.

Relevant authority includes:

- [WHO scientific/publication contract][who-contract], source-selection, calendar-checkpoint, interfaces and operations contracts under `system_docs/who_2021/`;
- [WHO summary cache contract][who-cache] and `cache_proxy/who-daily-series-contract.md`;
- [AQI R2 retirement contract][aqi-retirement] and `aqi-levels/station-history-contract.md`;
- [complete observation-generation contract][generation-contract] and `r2_history/observation_history_v3_website_cutover_scope_amendment.md`;
- [history Dropbox backup contract][history-backup], its inventory/sync contracts and v3 backup amendment; and `backup_and_recovery/contract.md` for logical database dumps;
- `r2_history/contract.md` for shared binding ownership, and the existing observation-generation rollback/recovery boundaries.

The WHO publication and cache contracts currently require **`history/v2/who_2021/latest_who_2021.json`**. The proposed relocation deliberately changes that contract. The system-docs owner must amend it before implementation/deployment; this report does not silently supersede it. System docs were read only and remain unchanged.

Prior work reviewed:

| PR | Relevance and limitation |
|---|---|
| [#152](https://github.com/TEST-uk-aq/uk-aq-ops/pull/152), merged | Original v2 retirement assessment; useful per-key/recovery methodology and protected namespaces. Its LIVE operational evidence and totals are not TEST evidence. No LIVE repository or service was inspected for this task. |
| [#154](https://github.com/TEST-uk-aq/uk-aq-ops/pull/154), merged | Staging retirement investigation. Current TEST Prune source no longer contains the obsolete staging cleaner/settings. That removes the former normal-code dependency; it does not prove old staging objects absent or disposable. |
| [#159](https://github.com/TEST-uk-aq/uk-aq-ops/pull/159), open draft, head `c48de7516c87e658e39e83fdd5feb5ca4d004c08` | TEST inventory assessment. No comments/listing attachments were returned by its discussion read. It lacked system-docs access at authoring; this investigation now has current authority. It is adjacent wider-retirement work, not an existing PR dedicated to this WHO/AQI investigation. Do not overwrite its separate assessment or treat it as deletion approval. |

### Supplied TEST inventory

These are **user-supplied inventory findings**, not independently current R2 measurements:

| Scope | Supplied objects | Supplied size | Evidence quality |
|---|---:|---:|---|
| `history/v2/` | 13,268 | 245.141 MiB | Aggregate only |
| `history/_index_v2/` | 9,906 | 19.869 MiB | Aggregate only |
| WHO 2021 subset | 92 | approximately 0.737 MiB | No per-key listing/metadata supplied |
| Legacy AQI timeseries index and latest subset | approximately 2,492 | approximately 10.371 MiB | No split between index tree/latest or exact bytes supplied |

The two top-level totals sum to **23,174 objects / 265.010 MiB** using the reported precision. WHO/AQI rows are subsets and must not be added again. Exact integer bytes cannot be recovered from rounded MiB. No per-key count, age, identity, completeness or backup status is established by these aggregates.

The underlying listings were not found among available workspace attachments/evidence or in #159's report/discussion. They were requested during this investigation. **Obtain them before finalising the migration or deletion manifests.** Required evidence is the original paginated LIST capture, bucket/account identity, capture time, completion/page continuity, and each key's integer size, LastModified and opaque ETag/available version. Reconcile disjoint family totals to the two supplied totals; explain differences rather than forcing agreement. HEAD/GET/checksum evidence is additionally needed for migration and recovery, and LIST alone does not establish it. Keep raw private evidence out of a public PR.

No R2 LIST/HEAD/GET, Dropbox inspection, Cloudflare configuration/traffic read or database query was performed here. The managed environment had no configured R2/Dropbox/database credentials. GitHub source, PR and bounded Actions-history reads succeeded. Consequently current bucket lifecycle/access policy, actual retained Dropbox bytes, installed/manual tools and current deployed Worker configuration remain operator-evidence requirements.

## WHO findings

### Current data flow

```text
Cloudflare Scheduler -> WHO GitHub Actions batch
  -> Obs AQI DB daily observations/readiness, or validated selected-generation R2 input
  -> WHO daily status -> rolling-year and calendar-year status -> summary RPC
  -> derived Parquet -> dated summary JSON -> stable latest summary JSON
  -> authenticated history Worker /v1/who-summary -> cache proxy -> homepage
  -> bounded processing report -> Dropbox report file + GitHub report artifact

WHO guidelines daily-series page -> cache-proxy RPC -> persisted WHO daily status
                                + selected observation-history provenance enrichment
```

1. **Source and science.** `.github/workflows/uk_aq_who_2021_daily.yml` invokes `workers/uk_aq_who_2021_daily/main.ts` as a direct Deno batch, not an HTTP server. Tracked Scheduler configuration enables `04:30` and `09:30` UTC daily (`30 4,9 * * *`); this is source configuration, not independently verified live scheduler state. Manual daily/backfill/dry-run inputs exist; none was invoked. The workflow serialises WHO invocations with `cancel-in-progress: false`.
2. **Daily calculation.** Normal calculation attempts yesterday and its correction day, using configured connector `1`, network `gov_uk_aurn`, pollutants PM2.5/PM10/NO2. The scientific WHO day is `(D 00:00, D+1 00:00]`, with at least 18 valid hours. Obs AQI DB is the normal source after per-pollutant final-six-hour readiness; the workflow readiness default is `0.5`. Validated R2 supplies authorised fallback/backfill, including independent next-midnight source selection. An absent initial top-level day manifest differs from corruption/missing children of an existing partition: integrity failure must not be disguised as source absence.
3. **Database state.** Canonical definitions are in schema `schemas/obs_aqi_db/uk_aq_who_2021_ops_schema.sql`, with duplicated definitions also present in `uk_aq_obs_aqi_db_schema.sql`. Private `uk_aq_ops` owns `who_guideline_values`, `who_2021_daily_status`, `who_2021_rolling_year_status`, `who_2021_calendar_year_status` and `who_2021_processing_runs`; calculation/summary/export RPCs are service-role interfaces under `uk_aq_public`. Daily/rolling/calendar rows are upserted and stale rows in refreshed scopes can be removed. Foreign-key cascades also preclude assuming indefinite immutable retention.
4. **Period products.** Rolling-year output covers 365 days and normally requires 274 valid daily results. Calendar output addresses the previous full year. Rolling status has no `is_final`; calendar status may. Authoritative calendar contracts additionally describe scoped source/calculation fingerprints and successful-refresh checkpoint advancement. The inspected batch and canonical WHO SQL contain no implementation of that checkpoint mechanism. This is pre-existing contract/implementation drift to reconcile with the owner, not evidence of an operational checkpoint or a reason to add checkpoint work to this relocation. Preserve existing science and source authority; record actual deployed behaviour before acceptance.
5. **R2 input generation is independent of WHO output.** `r2_observations.ts:observationHistoryPrefix()` calls `resolveObservationHistoryGeneration()` with `UK_AQ_R2_HISTORY_VERSION`. With `v3`, it reads `history/v3/observations`; the logical manifest `history_version="v2"` and report label `r2_v2` are not physical routing. Preserve this valid selected-v3 input, its hierarchy/hash/Parquet validation, and midnight/correction behaviour. Do not set the normal selector to v2, edit the observation-generation resolver, rename canonical observation manifests, or add cross-generation fallback for this move.
6. **Output producer and SQL key dependency.** `publishOutputs()` in `main.ts` calls `uk_aq_rpc_who_2021_r2_parquet_rows`, which returns `dataset`, **absolute `object_key`**, row count and JSON rows. The SQL constructs all three old-prefix Parquet paths. `who_2021_parquet.ts` enforces the old root through both `VALID_OBJECT_KEY_RE` and a dataset-prefix check, then emits ZSTD Parquet. `who_2021_daily_core.ts:buildR2PublishPlan()` separately constructs dated/latest JSON and diagnostic Parquet-prefix templates. A string edit in the publish plan alone would leave Parquet at the old root or fail validation.
7. **Publication/comparison.** Enabled Parquet is written before dated JSON, then latest JSON. JSON and Parquet flags are independently configurable; current values were not remotely verified. `r2_objects.ts` HEADs existing output, compares custom `x-amz-meta-uk-aq-logical-sha256`, may GET bytes for older objects lacking that metadata, and PUTs changed output with content type and logical hash. `main.ts` omits row creation/update timestamps from logical comparison, and omits summary generation time. **Parquet logical identity includes `object_key`.** Correction days and calendar refresh can overwrite deterministic keys; objects are not proven immutable. Timestamp-only logical equality can intentionally skip replacement.
8. **Output readers.** `workers/uk_aq_observs_history_r2_api_worker/who_summary_route.mjs` reads the fixed old latest key from `UK_AQ_HISTORY_BUCKET`, behind `/v1/who-summary` and the existing upstream secret. It validates JSON, conditionally checks R2 ETags on normal requests, owns the validated-body cache, and distinguishes missing, invalid and stale-on-error results. Its internal cache request currently includes a contract version, not the object key: include the resolved object key in cache identity at relocation to prevent old-root ETags/bodies being reused under a new source identity. Cache TTL is seven days, but revalidation rather than TTL controls normal freshness.
9. **Public consumers.** Cache proxy derives `/v1/who-summary` from the existing observation-history API origin; it has no direct R2 binding and no second WHO body cache. Website `index.html` uses `/api/aq/who-summary`; it does not need a new public URL. The WHO guidelines page uses `/api/aq/who-daily-series`; `who_daily_series_route.ts` reads `uk_aq_rpc_who_2021_daily_series` from Obs AQI DB and supplements provenance through the observation reader. It does **not** read the derived WHO Parquet root. Preserve its data/provenance behaviour. No current website direct old-root consumer was found in the active sources searched; historical/installed clients remain an evidence check.
10. **Reports and manual tooling.** Processing/report arrays carry absolute checked/updated/unchanged output keys. `report.ts` truncates those arrays to 50 entries; input-manifest evidence has a separate bound. They are diagnostics, not a complete dataset inventory. `scripts/who_2021/run_who_2021_months.py` dispatches the workflow in bounded chunks; its accompanying `run_who_2021_months_&_daily.txt` documents the old latest key. These are operational tools, not dataset backup/restore implementations, and were not run.

Current WHO publication emits **no WHO manifest tree or dataset-wide completion selector**; observation manifests are input authority. SQL output keys, report keys and any historical objects discovered in the listing must still be inspected for embedded absolute references. Do not assume historical objects follow only the current five families below.

### Proposed layout, configuration and ownership

Keep the existing dataset partition suffixes and public payload schemas:

```text
<configured existing bucket>/
  who_2021/
    daily_status/day_utc=YYYY-MM-DD/connector_id=N/pollutant_code=P/part-NNNNN.parquet
    rolling_year_status/as_of_day_utc=YYYY-MM-DD/connector_id=N/pollutant_code=P/part-NNNNN.parquet
    calendar_year_status/calendar_year=YYYY/period_type=complete_year/connector_id=N/pollutant_code=P/part-NNNNN.parquet
    summaries/as_of_day_utc=YYYY-MM-DD/who_2021_summary.json
    latest_who_2021.json
```

`who_2021/` is appropriate: it expresses the owning derived product/guideline edition rather than an observation-storage generation. Future WHO guideline editions should receive their own explicitly contracted sibling root (for example a future `who_<edition>/`), not share this edition's latest pointer. Internal file/schema/writer versions retain their own meanings.

Introduce **`UK_AQ_WHO_2021_R2_PREFIX`**, a non-secret root without a trailing slash, and a shared Ops module, provisionally `workers/shared/uk_aq_who_2021_storage.mjs`. No equivalent output-prefix setting was found. The existing `UK_AQ_R2_HISTORY_VERSION` controls observation input and cannot safely be reused. The shared resolver/key builders should:

- require explicit configuration for publisher and summary reader, normalise consistently and reject empty/traversal/URL/control-character roots;
- derive all output JSON/Parquet templates, dataset validators and the latest key from that one value; validate the complete relative dataset/partition/part shape, not merely `startsWith`;
- use the same code and root value in TEST and later LIVE; bucket/account/credentials remain existing environment-specific configuration;
- support the explicitly configured legacy WHO root during preparation/rollback, without probing both roots or falling back across buckets/environments.

The publisher must pass this resolved root as a **required named RPC parameter** (proposed `p_output_prefix`) so SQL constructs destination keys from it. Change the canonical function/signature and grants, its duplicate canonical definition, and an existing-database migration together. Eliminate the old ambiguous function overload during the controlled WHO writer hold, refresh PostgREST schema visibility, then deploy the matching caller before resuming. SQL must validate the root/returned keys; it must not independently choose an environment or carry another default root. This controlled signature transition avoids a permanent legacy-key rewrite adapter in the publisher. An additive/versioned RPC could reduce deployment coupling, but adds an interface to retire; use it only if a writer hold cannot be arranged.

Required preflight, currently unverified: a complete destination-root listing proving no collision (or an explicit reviewed disposition for every existing object); actual bucket lifecycle rules for both roots; bucket public/custom-domain exposure; S3 token and Worker binding scope; manual copy/restore roles; and ownership of any wildcard history cleaner. A new logical prefix does **not** grant separate ACLs or security isolation in a shared bucket. Reuse existing private Worker/API access; do not make the bucket public. No new bucket, public endpoint, database credential or cross-environment fallback is needed. Update prefix-scoped grants/rules only if actual deployed policy requires it. No repository-tracked WHO TTL/garbage collector establishes a safe deletion age.

### Dropbox coverage: reports, database backups and dataset bytes are different

| Mechanism | Actual traced payload / destination | Schedule and retention evidence | Recovery claim |
|---|---|---|---|
| WHO `upload_report.ts` | Reads one local bounded JSON report, adds upload result, uploads body to `<UK_AQ_DROPBOX_ROOT>/who_2021/uk_aq_who_2021_daily_report_<time>_<run-id>.json` | Workflow `always()` step; same WHO invocations. No report-retention cleaner found in this uploader. Actions retains its **report artifact** for 30 days. | **Run-report storage only.** It does not list/copy WHO R2 objects or preserve Parquet/dated JSON bodies. |
| Normal history inventory/sync | Explicit selected-generation observations, runs, Core, bindings/packed representation and compact observation latest; destination `<UK_AQ_DROPBOX_ROOT>/<UK_AQ_R2_HISTORY_DROPBOX_DIR>/...` | Tracked normal schedule `04:35` UTC and separate weekly forced observation-prune audit; actual deployed state/retained bytes not checked. | **No WHO dataset coverage.** Inventory whitelists these domains; WHO is outside that scope even while physically under `history/v2/`. Selected-v3 backup cannot accidentally cover it by sharing a bucket. |
| Logical Obs AQI DB dump | Roles/schema/data/cron gzip files beneath `<UK_AQ_DROPBOX_ROOT>/<UK_AQ_SUPABASE_DB_DUMP_BACKUP_DIR>/obs_aqidb/YYYY-MM-DD/` | Tracked schedule `00:55` UTC. Configurable retention, code default 7 days; same-date reruns overwrite. Current actual files/retention not inspected. | Code requests whole logical schema/data dumps without a WHO-specific exclusion; a complete successful dump is expected to include WHO tables, subject to the generated CLI dump scope and actual retained contents. **Indirect database recovery**, not exact published R2-object backup. Must verify actual dump inclusion/readability and reference state. |
| Independent historical/manual WHO dataset backup | No active writer, inventory, schedule, retention policy or restore consumer found in the bounded current TEST source search | No operator Dropbox evidence supplied | **Unestablished**, not proven absent from Dropbox. A report-upload success is no substitute. |

The history backup contract explicitly excludes retired AQI data/debug; WHO is excluded by its bounded required-domain scope rather than a named WHO exclusion rule. Its inventory/checkpoint roots must not be broadened just because WHO moves. The local history backup wrapper uses the same observation backup components; it does not establish another WHO backup owner. Generic history restore does not contain a WHO domain and is not a WHO restore procedure.

**Answer to the backup question:** tracked code backs WHO **reports** up separately; it does **not** demonstrate a complete or partial object-level WHO dataset backup to Dropbox. Logical DB dumps offer a separate, conditional source of reconstruction state. Actual historical Dropbox dataset coverage remains unknown until an operator supplies listings, manifests, checksums and a readable restore example.

### Required independent WHO backup design

Make the WHO publisher owner responsible for published WHO dataset backup and recovery. Keep history backup responsible for canonical observations and its existing domains; keep the DB-dump owner responsible for logical DB snapshots. None should prune another owner's storage.

Add a bounded WHO dataset snapshot writer, provisionally `scripts/who_2021/backup_dataset_to_dropbox.mjs`, plus a WHO-specific restore runbook. Reuse existing R2/Dropbox identities and `UK_AQ_DROPBOX_ROOT`; derive a fixed separate folder rather than another environment selector:

```text
<UK_AQ_DROPBOX_ROOT>/who_2021/
  <existing report files, unchanged>
  datasets/
    snapshots/<UTC-time-and-unique-run-id>/
      objects/<WHO-root-relative-key>
      manifest.json
    latest-complete.json
```

Required semantics:

1. A **bootstrap snapshot of the old root before relocation**, under separately authorised operation. Its R2 access is read-only, but Dropbox writes remain an operational mutation requiring separate approval. It must work without triggering calculation, database upserts or an existing WHO run merely to obtain a backup.
2. For normal operation, snapshot/checkpoint after each successful enabled WHO publication, before final successful workflow completion; include published backfills as well as daily runs. Use the existing workflow/concurrency owner, not a second independent schedule racing the publisher. A failed publication/backup must remain visible; retain the previous completed snapshot and do not label a partial copy complete. A report-upload success must never mark dataset backup successful.
3. List the complete configured WHO prefix, record exact relative/original keys, source bucket/root, sizes, SHA-256 of bytes, HTTP/custom metadata, publication identity and manifest hash. For mutable keys, take the snapshot while all WHO writers are excluded, or verify identities before/after and fail on change. GitHub concurrency alone does not exclude manually installed writers; inventory and close those paths first. Copy referenced data before dated/latest summaries; publish the backup completion manifest/selector last, only after destination-byte verification.
4. Separate object-byte SHA-256 from the publisher's logical hash and opaque ETag. Detect unchanged publications through a complete verified inventory/checkpoint, not the report's truncated key arrays. Backup files are versioned snapshots, not a destructive mirror of current R2 state.
5. **Initial retention proposal:** retain every pre-move snapshot and every snapshot during migration/acceptance; introduce no automatic deletion in the first implementation. Record ownership and a later explicit retention decision based on corrected historical-result and recovery needs. A 7-day DB dump default or 30-day Actions report retention is not WHO dataset retention authority. A later retention policy/cleaner is optional separately approved work.
6. Prove one bounded **isolated TEST restore**: verify manifest and bytes, restore data then dated summary then latest, preserve metadata, validate public payloads/Parquet and record hashes. Do not restore over normal serving data merely for the test. The restore procedure must explicitly select the same environment's bucket/root; no fallback to historical observation-generation roots. Bootstrap snapshot should be verified/restorable before moving the serving namespace.

At the reported 92-object scale, a complete immutable snapshot is simpler than integrating WHO into the hierarchical observation backup. Reassess snapshot cost from actual growth; do not invent a second observation-style hash hierarchy in advance. This new backup responsibility requires an authoritative WHO/backup contract addition before implementation.

### Handling the existing 92 objects and cut-over

The following is a proposed future procedure, **not executed**. Treat 92 as the supplied capture count; a fresh differing count is a stop-and-reconcile condition, not permission to omit newer objects.

1. Approve the contract, implementation and operational window separately. Inventory all WHO writers/readers, verify destination policy/collision status and record the planned JSONgen test's holds. Prepare/deploy configurable publisher/reader using the **old explicit WHO root** first, with no automatic cut-over. Stage all code before authorising operations; preserve rollback code and configuration.
2. Obtain an exclusive WHO publication hold: stop new WHO dispatch/admission, drain daily/backfill runs and manual writers, and ensure none can start during snapshot/copy/cut-over. This is a future authorised temporary change to WHO orchestration, not a request to change today's schedules. **Prune remains disabled; JSONgen and observation workflows are not run.** Avoid using observation migration as a namespace-copy tool.
3. Capture the complete source inventory and bytes/metadata; validate every expected Parquet and JSON body and classify unknown objects. Produce an immutable old-key -> new-key mapping by replacing only `history/v2/who_2021/` with `who_2021/`. All 92 captured objects need an explicit disposition; do not migrate only latest or only recently regenerated partitions. Missing/corrupt objects, unknown formats or changing identities block claiming a complete migration. Take and verify the independent pre-move Dropbox snapshot.
4. Apply the approved SQL signature migration while writers are held and install the matching publisher caller. SQL accepts the caller's root; it does not write R2. For preparation/rollback the caller may still pass the explicit old root. Validate signature, permissions and PostgREST resolution without processing WHO data.
5. Copy mapped objects within the same configured bucket, **without deleting or overwriting the old set**. Refuse unexpected destination collisions. Copy data first, then dated summaries and stable latest last. Validate byte lengths and independent byte SHA-256 for every mapped payload, Parquet schemas/rows, JSON schema/day/cards, and HTTP/custom metadata. R2 ETag/version/LastModified may change at the destination; equality of ETags is neither required nor sufficient for byte verification.
6. Preserve existing metadata and record it in the migration manifest. The copied Parquet logical-hash metadata is source-key-dependent because the old `object_key` participated in its computation; it is **not** a destination-independent content checksum. The next normal publisher recomputes identity from the new key and may legitimately rewrite those copied objects once. Validate/backup the resulting new publication; do not claim byte immutability after resumption. For any historical manifest or JSON containing absolute keys, inspect its actual schema and map its own WHO references explicitly, recomputing that schema's own hashes where required and retaining the original snapshot. Never rewrite canonical observation input references/hashes or silently copy dangling old references.
7. With the new set complete and writers still held, deploy the authenticated summary reader using the **new root** and source-key-aware cache identity. Verify the existing private/public summary routes against seeded data. This reader-first switch is safe because the dataset already exists; it does not require new public/browser URLs. Then deploy/configure the prepared publisher with the same new root and resume WHO admission. Independent deployments cannot be literally atomic, so the writer hold plus complete seeded dataset provides the practical cut-over boundary.
8. After separately authorised real TEST WHO operation, verify new publication and complete independent new-root backup. Compare old-root identities with the frozen inventory: there must be no renewed writes. Capture source and destination inventories, deployment/configuration versions and acceptance evidence. Do not infer completeness from a green report alone.
9. **Proposed rollback window: at least 14 days after accepted cut-over**, with two successful scheduled WHO cycles and one isolated restore already evidenced; longer if any owner/recovery issue remains. This is a proposed hold, not an existing retention contract. Keep the frozen old set and pre-/post-move backups throughout. If rolling back after new writes, first hold WHO again and copy/validate the accepted new-root changes back to the old root, latest last, before returning reader/publisher to it. Merely pointing to the frozen old latest would lose later corrections. SQL/root-parameter code can serve either explicit root; do not remove a caller's required RPC before restoring its matching caller.
10. Only after the hold, consumer closure, successful backup/restore, completed JSONgen hold disposition and separate destructive approval, retire **the exact old objects** through a reviewed immutable per-key manifest with fresh identity checks. Preserve migration manifests and backup evidence outside the deleted namespace. New-root storage remains; relocation itself saves **zero net dataset bytes** in the bucket, and temporarily duplicates approximately 0.737 MiB before later old-copy retirement.

**Alternative comparison:** temporary new-first/old-fallback reads can permit a rolling cut-over when writers cannot be held, but require bounded compatibility lifetime, explicit missing-versus-invalid semantics and anti-staleness rules; they can hide incomplete migration. Dual-writing also adds failure states. A reader/writer switch without pre-seeding and writer exclusion risks a missing latest object or split publication. Prefer the held-writer, complete-copy, reader-then-writer sequence above; no permanent fallback, redirect objects, dual writer or new bucket.

### WHO recovery and reconstruction limits

Exact published-history recovery requires verified object-byte snapshots. Existing DB rows plus the export RPC may reconstruct derived Parquet **if the required rows, reference identities, guideline/configuration and compatible writer remain available**, but updated timestamps, corrected input and overwritten calendar results can change bytes/results. Re-running summary RPCs is not proven to reproduce every previously published dated JSON. Recalculation from canonical observation backups additionally needs every required day, next-midnight boundary, eligibility/reference state and scientific version, and is an explicitly authorised processing/backfill operation. Current backfill chunks are bounded to 31 inclusive days; they are not a substitute for lossless migration. Protect canonical observation backups independently, without making WHO output depend on a retired v2 layout.

### Real TEST acceptance after separately authorised implementation/deployment

- Confirm configured TEST bucket and both producer/reader output roots; observation input remains selected-v3. Resolve every captured WHO object and embedded reference; confirm copy parity and complete verified backup inventory.
- Run an authorised ordinary WHO cycle only when the operator releases it: latest and correction days remain processed, the newest usable day determines publication, rolling/calendar content remains present, and Parquet/dated/latest ordering is preserved. Check actual processing ledger, bounded report and full dataset inventory separately.
- Confirm only `who_2021/` is updated by WHO output, no new old-root objects appear, and no v2/v3 observation input routing or source values changed. A legitimate first-run Parquet rewrite caused by key-dependent logical hashes is recorded rather than mistaken for migration loss.
- Use the existing summary API/homepage: cold read succeeds; unchanged reads validate ETag; a meaningful new publication, including an equal-day correction when naturally available, reaches the next normal request and can replace equal-day local fallback without a cache purge. Preserve 404/502/stale-on-error distinctions, `no-store`, auth and the absence of a direct public R2 binding.
- Confirm WHO daily-series page/RPC and supplementary AURN provenance still work; confirm representative observation-history and current DAQI/EAQI chart behaviour remains unchanged.
- Confirm dataset-backup failure is visible independently from report upload; verify completed snapshot bytes and the isolated restore result before old-root retirement. Do not manufacture failure machinery or a speculative fixture programme for this investigation.

These are future operational acceptance requirements. None has been executed here.

## Legacy calculated-AQI findings

### Product boundary to preserve

The active retirement contract permanently removes calculated `aqilevels` as a **canonical persisted R2 history product**. It does not retire UK AQ AQI:

| Data/function | Disposition |
|---|---|
| Old UK AQ calculated AQI Parquet/debug/manifests and dedicated historical indexes | Eventual retirement candidates after closure/recovery gates |
| Source-provided DAQI/index observations in canonical source data | **Preserve**, including legitimate observations whose values are indexes; do not classify by the string `aqi` or by units alone |
| Shared DAQI/EAQI calculation (`lib/aqi/aqi_levels.mjs`) and current server-side station-history calculation | **Preserve**; derives visible bands from the same authoritative observations as concentration charts |
| Website AQI rendering, charting, public response interfaces | **Preserve**; legacy backend dependency migration, if required, is a separate approved implementation with unchanged current behaviour |
| Separate derived chart JSON/JSONgen observation+AQI products and their control/evidence | **Preserve**; separate private derived product, not legacy canonical `aqilevels` and not a reason to run JSONgen |
| WHO derived assessments, guideline/reference state and legitimate database/R2 operational state | **Preserve**; a name containing AQI/WHO does not make it obsolete |

Do not delete AQI-related database objects in this storage retirement. Existing historical helper/views/diagnostics may have their own dependencies; their disposition requires a separate bounded schema/feature review.

### Producers and readers: active, historical and unknown

| Component | Source finding | Retirement implication |
|---|---|---|
| Normal Prune Phase B | `exportCandidateToR2()` dispatches observation export only; `runCandidateAqilevelsStage()` returns skipped unconditionally. Dormant AQI export/manifest/index helpers remain in the module. | Normal selected-v3 publication is not an active AQI producer. Do not run Prune to establish this. Dormant helper existence is not evidence of present objects or an authorised switch to recreate them. |
| `scripts/backup_r2/uk_aq_build_r2_history_index.mjs` and `workers/shared/uk_aq_r2_history_index.mjs` | Explicit v1/v2 targeted AQI builders remain; domain default includes both observations and `aqilevels`. | Inventory installed/manual use and constrain/retire AQI rebuild entry points before deletion; do not remove shared observation/binding helpers wholesale. |
| `workers/uk_aq_backfill_local/run_job.ts` | Retains AQI calculation/export branches; direct mutating historical modes including `r2_history_obs_to_aqilevels` have a shared-route guard. | Guarded/legacy capability, not proof it currently runs. Close manually installed workflows/proposal paths that could recreate retired keys; no backfill or reconstruction is authorised here. |
| Legacy AQI-history Worker | `workers/uk_aq_aqi_history_r2_api_worker/worker.mjs` serves authenticated `/v1/aqi-history` and `/`, reads v1/v2 persisted AQI, targeted indexes and v2 stable bindings; can also use Obs AQI DB hourly AQI or optional live-observation fallback. It is not just an index-listing service. | Its continued deployed existence/purpose must be established. Recent-gap/live fallback does not prove historical data/indexes unnecessary. |
| Cache proxy | Current source under selected-v3 returns **410 `legacy_history_route_retired_for_v3` before legacy AQI cache/upstream access**. v2 compatibility and URL configuration remain. | A strong repository boundary for normal v3 public traffic, not proof of current deployed guard or closure of direct/other callers. Do not restore the retired public path by changing the global selector. |
| Station-history Worker | Current normal calculated path uses observations; code still exposes private `/v1/aqi-history`, an older station-series AQI-head path and optional `aqi_validation.mjs` stored-AQI comparison. | Obtain actual route/feature/validation settings. Current contract disallows stored AQI as normal source/validator/fill. Close obsolete paths/validation through an approved change; preserve current calculations and interfaces. |
| Hosted operator dashboard | `workers/uk_aq_dashboard_online_api_worker/src/lib/station_snapshot_v2.ts` directly calls the configured AQI-history API with v2 identity and merges old AQI diagnostics, even though observation reads are generation-aware. | A concrete remaining diagnostic dependency, outside the public v3 guard. Retire that old diagnostic with owner agreement or migrate it to current observation-derived AQI; preserve normal website/chart output. |
| R2 metrics and local/hosted dashboard coverage | `workers/uk_aq_db_size_metrics_api_worker/worker.mjs` explicitly selects optional retired-v2 AQI latest even alongside v3 observations, reads it, and reports unavailable/rebuild warnings. Dashboard source retains historical AQI backup coverage fields; local `local/dashboard/server/uk_aq_dashboard_api_core.py` also handles AQI coverage. | Remove or represent retired diagnostics explicitly before deleting their source latest; avoid permanent alarming rebuild warnings and prevent a retirement from inducing an AQI rebuild. Keep valid observation/storage metrics and historical evidence. |
| Website compatibility client | Active-tree sensor/Hex Map adapters still supply AQI-history URL candidates to `shared/station-chart/station-history-compatibility-client.js`; normal contracts use calculated observation-based history. | Verify runtime selection and actual served assets. Their presence alone does not prove normal calls; a v3 HTTP 410 guard alone does not prove every caller is gone. No website calculation/rendering change is proposed here. |
| Manual readers and recovery tools | `scripts/r2_query/query_r2_v2_aqilevels.sh`, `query_r2_v2_observs_aqilevels.sh`, `query_r2_v2_observs_aqilevels_indexes.sh`, `query_r2_v2_day_snapshot.sh`; `scripts/aqi_gaps/check_r2_aqi_gaps.sh`; generic restore workflow/script still offer an AQI domain. `scripts/archive/AQI-levels-refactor-June-2026/` retains historical rebuild/delete tools. | Record operator ownership, installed copies and last legitimate use. Archive tools are historical references, never active execution/fallback. Generic restore is not proof of existing AQI backup coverage. Preserve needed historical read tooling with explicit archived-data inputs rather than normal serving dependency. |

The AQI Worker can consume the index tree **and** shared binding bytes independently of the current normal observation reader. Therefore `_index_v2` AQI indexes are historical in product authority, but **not proven unused by deployed code**. The compact latest file also has an explicit source-level metrics consumer.

### Deployment evidence actually obtained

Bounded GitHub Actions history for `.github/workflows/uk_aq_aqi_history_r2_api_worker_deploy.yml` returned:

- [8 October run `37846396562`](https://github.com/TEST-uk-aq/uk-aq-ops/actions/runs/37846396562), revision `43bee34fb10d86b9ad82841cb55b210a8bab3da4`, **failed**. Job `113548240788` logs show `UK_AQ_R2_HISTORY_VERSION: v3` and **`Invalid UK_AQ_R2_HISTORY_VERSION=v3; expected v1 or v2.`** It did not establish a new working v3 AQI deployment.
- [26 July run `30215757187`](https://github.com/TEST-uk-aq/uk-aq-ops/actions/runs/30215757187), revision `7f623a3870625e3ffc7878d343236828e13e3d46`, **success** in run/job metadata. Its logs were no longer available. Earlier July successes also appeared in that bounded history.

Current workflow still rejects v3 and injects v2 AQI-data/index/binding prefixes. A failed later deployment does **not** remove the previously deployed Worker. These facts establish a real legacy deployment history and current configuration incompatibility, not the present Cloudflare version, traffic or absence of service. No Cloudflare API/endpoint call was made. Do not fix the failure by changing the system-wide selector back to v2 or widening the AQI Worker parser as part of a documentation/storage retirement.

Required operator evidence before closure:

1. TEST account and exact deployed Worker name, active version/deployment IDs, code revision, R2 bucket binding, effective v1/v2 selector and all AQI/index/binding/fallback settings. Check workers.dev, custom-domain routes, service bindings and any version-specific URLs.
2. Current deployed cache/station-history versions and generation descriptor, effective calculated/continuity/legacy-routing and AQI-validation flags, hosted/local dashboard configuration, and website runtime compatibility selection. Configuration names in source are not current values.
3. Read-only route/access/traffic evidence covering representative scheduled and manual/operator use, plus owners' explicit disposition of every direct authenticated consumer. Zero traffic in a short window is insufficient to prove no legitimate manual client exists.
4. Installed local launchers/schedules/manual index/backfill/restore utilities, not just repository files. Confirm no mechanism will republish deleted AQI state. Record current TEST recovery/rollback obligations and any legal/operator hold on historical diagnostic data.

### Family classification and storage accounting

**A** below means eligible for *future* retirement after listed prerequisites; it is not a per-object deletion approval. **B** means retain for a legitimate dependency/out-of-scope responsibility. **C** means presence, ownership or disposition requires further evidence. All per-key identities remain unresolved until the raw listings are supplied. If an active legitimate reader is confirmed, the objects it requires are B until that reader is accepted as migrated/closed.

| Class / exact family | Present objects / bytes established here | Producer; reader/owner | Backup/reconstruction and prerequisites | Potential saving |
|---|---|---|---|---|
| **A, conditional:** `history/_index_v2/aqilevels_hourly_data_timeseries/` and expected dedicated latest `history/_index_v2/aqilevels_hourly_data_timeseries_latest.json` | User reports **approximately 2,492 / 10.371 MiB combined** for AQI timeseries index/latest. Exact matching keys, split, integer bytes and timestamps **not verified**. | Historical AQI index builders; legacy AQI Worker reads tree, R2 metrics reads latest. Ops owns closure with dashboard owner. | Not required normal v3 backup payload. An index may be rebuildable only with its actual retained AQI inputs and compatible builder; do not claim observations alone rebuild the same legacy index. Close readers/writers; choose verified historical snapshot or explicitly approved loss of exact historical bytes; reconcile keys first. | **approximately 10.371 MiB**, conditional, no double counting |
| **C -> A after evidence:** `history/v2/aqilevels/hourly/data/` including its Parquet and manifests | Existence/count/bytes **unknown**, not zero; no supplied family breakdown | Historical AQI writer/backfill; legacy Worker and manual queries/restore | Normal history backup explicitly excludes it. Require actual listing, all parent/child references, reader closure and exact archival-copy or accepted reconstruction/discard decision. | Unknown; **not included** in the 10.371 MiB estimate |
| **C -> A after evidence:** `history/v2/aqilevels/hourly/debug/` and other objects strictly owned by `history/v2/aqilevels/` (aggregate manifests, older layouts if found) | Existence/count/bytes unknown | Historical AQI publisher/debug tools; operational owner to identify | No current required backup. Separate debug/evidence retention from regenerable data; establish ownership and all cross-references. Do not assume all old-root objects are current-layout data. | Unknown |
| **C:** other AQI latest/index variants, including code-known `history/_index_v2/aqilevels_timeseries_latest.json` **if present**, or AQI-specific manifests/checkpoints elsewhere in the two candidate roots | Code-known names are **not inventory findings**; no count/bytes | Legacy generic helpers and manual/operator tooling; owner unresolved | Classify from actual keys and contents; require independent closure and evidence retention. Do not invent operational-state paths or delete by substring. | Unknown |
| **B:** all `history/_index_v2/timeseries_binding/`, including individual bindings, manifests and source/control evidence | Count/bytes unknown; **no AQI attribution proven** | Historical shared observation/binding publishers; legacy AQI can also read it; recovery/continuity owner | Binding identity is general observation/timeseries authority. Preserve historical individual/pack recovery and control evidence. Closing AQI removes one reader only; any later v2-binding retirement belongs to #159's separate evidence process. | **0 in this AQI proposal** |
| **B:** `history/_index_v2/observations_timeseries/`, `observations_timeseries_latest.json`, `backup_inventory_v2/`; `history/v2/observations/`, `core/` and observation `_ops/` evidence | Counts/bytes not allocated here | Historical canonical observation, Core, backup and recovery owners | Outside AQI retirement. Historical rebuild/backup/rollback disposition remains required. Do not delete inventory/checkpoint/control evidence as AQI or because a format contains `v2`. | 0 here |
| **B:** `history/v2/who_2021/` until the independent WHO move is accepted | Supplied 92 / approximately 0.737 MiB | WHO publisher/summary reader; WHO owner | Follow WHO copy/backup/hold plan, not AQI deletion. | 0 AQI saving |
| **C:** remaining unexpected keys in either candidate root | Unknown | Determine from listing, contents and references | Keep unresolved keys out of any deletion manifest. | Unknown |

At reported precision, **10.371 MiB ≈ 0.010128 GiB** is the only quantified eventual AQI saving. Do not claim the entire 19.869 MiB index namespace or the 245.141 MiB history namespace is AQI. Additional AQI-data/debug savings require actual evidence. Relocating WHO plus retiring the quantified AQI index subset would remove approximately **11.108 MiB from the old namespaces**, but only approximately **10.371 MiB net bucket storage** after WHO's replacement copy remains. Replacement metadata/backups and retention can affect actual cost; no measured monetary saving is claimed.

### AQI backup and recovery consequences

Normal selected-v3 history backup includes no retired AQI data/debug or AQI-specific index completion requirement. It neither proves those historical bytes backed up nor refreshes them. Legacy Dropbox folders, if found, need actual complete listing, readable bytes, manifests/checksums and retention protection; generic restore options and old success reports are insufficient. Preserve existing observation/Core/binding backups, historical checkpoint shards and migration/rollback evidence.

For each candidate family choose one explicit disposition before deletion:

- **Preserve exact history:** retain an immutable complete byte/metadata snapshot with all referenced AQI manifests/indexes and an isolated restore demonstration. This may be a one-off historical archive, not a resurrected recurring canonical-AQI backup pipeline. Keep old shared bindings as needed under their separate owner.
- **Reconstruct semantic AQI only:** prove the retained canonical observations, required rolling context, identity/eligibility and algorithm/configuration are available and approve a bounded reconstruction path. Current shared DAQI/EAQI calculation preserves current functionality, but does not establish byte-identical old Parquet/index/debug reproduction or old-algorithm equivalence. Any future rebuild is separately authorised.
- **Accept irreversible historical loss:** if exact old diagnostics/debug are unnecessary and no verified recovery exists, the owner must explicitly accept that loss for the exact keys. Never describe such deletion as safely backed up.

Do not add retired AQI to normal v3 backup merely to permit cleanup, or allow a backup mirror/pruner to erase the retained historical recovery set after source retirement. Generic history restore still advertises AQI, with legacy defaults; remove that normal selectable capability or clearly restrict it to approved historical recovery before final closure. Retain necessary archive evidence without making current operation depend on it.

### Proposed Worker/consumer closure and removal sequence

1. Obtain the listings and deployed/operator evidence above, and classify exact dependencies. Preserve historical backup/hold evidence before changing readers. If a consumer has a legitimate active need, retain its required keys and approve its migration separately.
2. Prepare the bounded caller changes: retire stored-AQI validation/old private compatibility paths; migrate or retire the dashboard's legacy diagnostic; make metrics treat retired AQI as a retired optional domain without suggesting rebuild; prevent manual builder/restore entry points from recreating it accidentally. Keep current station-history calculation, website AQI rendering and valid source AQI untouched. Do not remove the Worker first and silently leave callers failing.
3. Deploy those caller changes only after separate approval; establish real TEST public v3 410 guard, normal calculated AQI/observation serving and operator diagnostics acceptance. Preserve any public response surface still required; if an endpoint still serves a legitimate function, adapt its backend through a separately approved interface-preserving change or defer retirement. Source code and a green unrelated deployment are not evidence of acceptance.
4. Once callers are closed, prevent automated legacy Worker redeployment (retire its dedicated deploy workflow/targets in the approved implementation). Then, through separately authorised Cloudflare changes, detach remaining routes/service references and disable or retire the exact TEST Worker. Record what happens to workers.dev/custom-domain access and rollback. Confirm no callers or AQI-only writers remain. Worker deletion is destructive and requires separate approval; disabling the GitHub workflow alone leaves a Worker running.
5. Reclassify affected families A only after closure/backup or explicit loss acceptance, and after the coordinated JSONgen hold is released. Produce a private immutable sorted per-key proposal with bucket, inventory hash/time, integer bytes, identities, class/reason and recovery reference; unexpected/shared keys stay out. Current approved deletion remains 0/0.
6. Seek explicit approval for that concrete destructive manifest. Immediately before any later operation recheck source identities, no-writer state and retained recovery availability; changed/missing/unexpected identities stop the operation. Do not assume an S3/R2 deletion API supports the required conditional identity precondition without checking the actual capability. Delete only separately approved unchanged keys, retain the audit result, and verify remaining contents. Do not expand scope on errors.
7. Keep shared v2 bindings and broader observation retirement in #159. Archive historical utilities/code only after their installed consumers are closed; no permanent compatibility code is needed for a deliberately retired product.

## Implementation matrix for subsequent approved work

All rows are proposals. **This PR changes only this report.** Owners identify functional responsibility, not an assertion that a named individual has approved it. `Required` includes conditional rows only if the observed dependency exists; optional cleanups cannot block unrelated safe work.

| Priority | Exact file(s) / boundary | Required change and rationale | Owner | Dependencies |
|---|---|---|---|---|
| Required, WHO | New Ops `workers/shared/uk_aq_who_2021_storage.mjs` | One required output-root resolver and key/partition validators shared across producer/reader; no observation-generation coupling | WHO + API maintainers | Amended WHO/cache contract |
| Required, WHO | `workers/uk_aq_who_2021_daily/main.ts` | Resolve root once; pass RPC parameter; use root-derived plans/validators; preserve ordering, source selection, logical comparisons; integrate independent backup outcome | WHO maintainer | Shared module; SQL migration; backup module |
| Required, WHO | `workers/uk_aq_who_2021_daily/who_2021_daily_core.ts` | Replace every hard-coded summary/diagnostic Parquet root with shared configuration | WHO maintainer | Shared module |
| Required, WHO | `workers/uk_aq_who_2021_daily/who_2021_parquet.ts` | Replace old-root regex/dataset checks with shared root + strict relative-key validation; preserve schemas/writer | WHO maintainer | Shared module; matching SQL keys |
| Required, WHO schema | Schema `schemas/obs_aqi_db/uk_aq_who_2021_ops_schema.sql`, duplicate `schemas/obs_aqi_db/uk_aq_obs_aqi_db_schema.sql`, and new `schemas/migrations/<implementation-date>_<sequence>_obs_aqidb_who_output_prefix.sql` | Add required caller-supplied output root to Parquet RPC; update signature comments, revoke/grant signatures and canonical copies consistently; no WHO data-table migration required | Schema owner | Authoritative interface amendment; exclusive WHO writer hold during apply |
| Required, WHO reader | `workers/uk_aq_observs_history_r2_api_worker/who_summary_route.mjs` | Resolve latest key from shared root; key validated-body cache by physical source; preserve ETag/freshness/auth semantics | API maintainer | Seeded verified destination before new-root deployment |
| Required, WHO config | `.github/workflows/uk_aq_who_2021_daily.yml`; `.github/workflows/uk_aq_observs_history_r2_api_worker_deploy.yml`; `workers/uk_aq_observs_history_r2_api_worker/wrangler.toml` | Wire/validate `UK_AQ_WHO_2021_R2_PREFIX` consistently; retain bucket binding and v3 input selector; integrate backup without another schedule | Ops + WHO/API maintainers | Shared module and reviewed deployment order |
| Required, WHO catalogue | `config/uk_aq_github_env_targets.csv`, private `env-vars-master.csv` | Catalogue/target the new non-secret prefix for both runtimes. The private master is not tracked/available here; operator must update it | Configuration owner | Chosen configuration contract; TEST/LIVE values supplied per environment |
| Required, WHO backup | New `scripts/who_2021/backup_dataset_to_dropbox.mjs`; new WHO-specific backup/restore runbook (proposed `docs/runbooks/who-2021-dataset-backup-and-restore.md`) | Full immutable dataset snapshots, verified completion and explicit isolated restore; reuse configured Dropbox root and fixed dataset suffix | WHO backup owner | Backup contract, existing credentials/grants; bootstrap before copy |
| Required, WHO reporting | `workers/uk_aq_who_2021_daily/report.ts`; `main.ts`; `upload_report.ts` | Preserve existing report-upload path; explicitly separate dataset-backup status/root/count/hash/reference from report-upload result. Extend bounded-report allowlist so new fields survive; report is never full inventory | WHO maintainer | Backup interface and health policy |
| Required, WHO migration | New bounded operator utility/runbook under `scripts/who_2021/` / `docs/runbooks/` | Reviewable list/map/copy/verify/resume evidence; refuse collisions/change; latest last. Keep deletion a separate approved manifest, never an implicit move | WHO/Ops operator | Listings, snapshot, hold, approved operational window |
| Required, WHO documentation/check maintenance | `workers/uk_aq_who_2021_daily/README.md`; `workers/uk_aq_observs_history_r2_api_worker/README.md`; `scripts/who_2021/run_who_2021_months_&_daily.txt`; existing `who_2021_daily_core_test.ts`, `who_2021_parquet_test.ts` | Update active path references and existing deterministic expectations needed for structural viability; keep historical archives intact | WHO/API maintainers | Final key/RPC design |
| Preserve, WHO input/public UI | `workers/uk_aq_who_2021_daily/r2_observations.ts`, `r2_objects.ts`; cache-proxy summary/daily-series routes; website `index.html` and `who-guidelines/who-guidelines-data.js` | No root-routing implementation change expected here beyond any genuinely necessary shared metadata handling. Preserve source input/science, public paths and client behaviour | Respective maintainers | Acceptance checks; do not change v3 routing |
| Required, AQI closure | `workers/uk_aq_station_history/src/index.mjs`, `src/aqi_validation.mjs`; `.github/workflows/uk_aq_station_history_deploy.yml` | Close old persisted-AQI private/validation dependency and obsolete required URL check after deployed-use review; preserve calculated serving and current public interfaces | Station-history owner | Actual flags/routes and accepted consumer migration |
| Required, AQI diagnostics | `workers/uk_aq_dashboard_online_api_worker/src/lib/station_snapshot_v2.ts`, `src/lib/direct.ts`; `workers/uk_aq_db_size_metrics_api_worker/worker.mjs`; `local/dashboard/server/uk_aq_dashboard_api_core.py` | Disposition old AQI diagnostic/coverage reads and missing-index rebuild guidance; preserve unrelated storage/observation metrics and historical backup evidence | Dashboard/metrics owners | Owner-approved diagnostic migration/retirement |
| Required, AQI deployment closure | `.github/workflows/uk_aq_aqi_history_r2_api_worker_deploy.yml`; `workers/uk_aq_aqi_history_r2_api_worker/`; configuration targets | Retire deployment path, then exact deployed Worker/routes once callers closed; remove AQI-only config requirements without touching shared secrets | Ops/API operator | Deployed evidence; caller acceptance; separate disable/delete approval |
| Required if selectable, AQI compatibility | `workers/uk_aq_cache_proxy/src/index.ts`; `.github/workflows/uk_aq_cache_proxy_deploy.yml`; `.github/workflows/uk_aq_ops_dashboard_api_worker_deploy.yml` | Keep v3 fail-closed guard; remove obsolete legacy upstream wiring only after no legitimate consumer needs it | API/dashboard owners | Confirm deployed guard and all alternate callers |
| Required, AQI writer/recovery closure | `scripts/backup_r2/uk_aq_build_r2_history_index.mjs`; `workers/shared/uk_aq_r2_history_index.mjs`; `.github/workflows/uk_aq_r2_history_restore_from_dropbox.yml`; `scripts/backup_r2/restore_history_from_dropbox.mjs`; installed manual backfill/index launchers | Prevent new retired AQI publication/normal restore; preserve observation/binding paths and explicitly historical recovery capability where approved | History/recovery owners | Installed-use inventory and historical retention decision |
| Conditional, AQI website compatibility | Website `shared/station-chart/station-history-compatibility-client.js`, sensor/Hex Map adapters | If actual runtime selects legacy AQI, migrate that transport dependency before shutdown, preserving response/display semantics. Otherwise later dead compatibility cleanup is optional | Website owner | Runtime evidence; separate implementation approval |
| Optional, AQI dead code/docs | Dormant AQI helpers in Prune/backfill/shared profiles, old query/gap/seed tools and historical documentation | Archive/remove unused branches once their specific consumers are closed. Do not broaden into rewriting Prune or schemas merely for tidiness | Respective maintainers | Consumer/writer closure; nested instructions if future code edits occur |
| Preserve, all | Normal history inventory/sync, canonical observations/Core, shared bindings/packs/checkpoints, source-provided index observations, current AQI library/charts and JSONgen evidence | No expansion of deletion or backup ownership; protect separate recovery/test responsibilities | History + backup + test owners | #159's independent retirement assessment |

The schema migration filename above is a proposed naming pattern, not an existing file. Likewise new modules/runbooks are design targets, not files created in this PR. Later code changes must follow each repository/nested instruction, including any required pre-change archives and existing regression-sensitive requirements.

## Combined recommended order and interaction with #159

1. **Now, documentation/evidence:** review these two independent decisions; supply underlying TEST listings and deployment/backup evidence; have the system-doc owner resolve contract amendments/drift. Preserve raw inventory and recovery evidence. No operational run is needed to review this design.
2. **WHO implementation:** prepare shared configuration, SQL/caller transition, reader/cache update, independent backup and operator procedure. Keep observation inputs on v3. No AQI shutdown dependency.
3. **AQI implementation preparation in parallel as a separate change:** close identified caller/diagnostic/manual-writer dependencies while preserving normal calculated AQI and public interfaces. No WHO output dependency. This describes work ordering, not authorisation to run jobs or create implementation changes now.
4. **Authorised WHO operational window:** hold only WHO writers, bootstrap verified dataset backup, copy and validate, switch seeded reader then publisher, resume only approved WHO operation and complete real TEST acceptance/restore. Preserve the old set through the rollback window.
5. **Authorised AQI operational closure:** after caller acceptance, prevent redeployment and disable/retire the precise legacy Worker and its remaining routes. Preserve exact historical bytes or explicitly accept loss. Existing source-level public v3 guards are confirmed operationally, not inferred.
6. **JSONgen protection gate:** leave TEST Prune disabled throughout. Do not consume/change accumulated observations, retention, source data, canonical v3 history or private JSONgen evidence for retirement acceptance. Any coordinated Prune/JSONgen integration operation remains separately authorised. Schedule destructive legacy-object retirement after that test and its evidence preservation, or after the user explicitly releases the hold; unresolved test/recovery dependencies always block deletion. WHO/AQI code preparation can be reviewed before that gate.
7. **Separate destructive decisions:** approve old WHO per-key retirement after its hold; approve AQI per-key retirement after its own closure/recovery gates. Neither approval covers shared bindings, observation/Core data or backup/control evidence.
8. **Return evidence to #159:** record the exact WHO old->new mapping, accepted new serving/backup root and old-copy disposition; record exact AQI keys/bytes, Worker closure and retained recovery references. This removes WHO stranding and AQI-reader ambiguity from the wider v2 assessment. It does **not** establish historical v2 observations backed up, close shared binding/Core recovery, release rollback obligations, prove staging absent or permit deleting backup inventories. #159 must still classify every remaining object and preserve all required historical backup/recovery evidence.
9. **Later LIVE promotion:** promote the same accepted application/schema design using LIVE's own existing bucket/credentials and the same logical root. Independently inspect LIVE destination collisions, lifecycle/grants, dataset inventory, backups, consumers and holds; obtain explicit LIVE deployment/migration/deletion authorisation. TEST's 92/2,492 counts, history and acceptance are never LIVE evidence. No LIVE source inspection or operational action was performed here.

## Authoritative system-doc handover

System docs remain untouched. Ask their Chat-mode owner to make a bounded amendment before implementation:

- `who_2021/contract.md`, `interfaces.md`, `operations.md` and appropriate router links: independent output namespace and one explicit configuration authority; SQL root parameter/deployment dependency; mutable publication and old-root retirement/rollback; independent WHO dataset backup and reconstruction limits. Preserve science and source-selection integrity.
- `cache_proxy/who-summary-contract.md`: replace the fixed old physical key with the shared configured WHO output key; source-aware validated-body cache identity. Preserve `/api/aq/who-summary`, `/v1/who-summary`, ETag validation, equal-day correction behaviour, stale/error semantics and authentication.
- `backup_and_recovery/README.md` plus a focused WHO dataset backup/restore contract: owner, snapshot manifest/selector, completion, writer exclusion, retention hold and restore ordering; explicitly distinguish reports and DB dumps. Clarify that normal selected-generation observation backup does not own WHO. Do not broaden history inventories or relax existing observation backup guarantees.
- `r2_history/aqi_r2_retirement_contract.md` / `aqi-levels/station-history-contract.md` operational follow-up: recorded legacy Worker/caller closure and precise historical-object disposition. Their existing retirement/current-calculation boundary already supports the recommendation; a storage plan must not imply AQI display retirement. Dashboard/API contracts need a bounded amendment if their old diagnostic interface changes.
- Reconcile existing logical-v2 physical-path examples against side-by-side amendments, and the calendar-checkpoint contract/runtime discrepancy observed above. Do not report these as newly implemented or use this report to authorise an unrelated checkpoint project.

The handover's eventual validation evidence must be actual TEST deployment, copy/inventory/checksum, backup/restore and consumer-closure results. This investigation supplies design/source evidence only.

## Validation and authorisation boundary

Structural viability was checked by tracing the actual SQL absolute-key producer, strict Parquet validator, JSON key builder, summary cache identity, workflow configuration, selected-generation input and explicit backup domains. The design accounts for required schema/caller ordering and mutable-object consistency; it does not assume prefix substitution alone is sufficient. No speculative automated suite was created and no application/operational test was run for a documentation-only change. Report checks cover Markdown/link/path consistency, arithmetic and documentation-only scope; functional acceptance remains pending as listed above.

| Proposed later operation | Boundary |
|---|---|
| Code/config/schema implementation, catalogue amendment, new backup module | Separate implementation approval; no runtime work from this investigation |
| SQL apply, deployments, temporary WHO admission hold/resumption, Cloudflare route/Worker changes | Separate operational approval and TEST identity/configuration evidence |
| R2 copy/new publication, Dropbox bootstrap/snapshots/isolated restore, WHO processing/backfill | Operational mutations requiring separate approval, even where additive; never run to complete this investigation |
| Old WHO or AQI object deletion, Worker deletion, backup retention deletion | **Destructive**, require concrete per-key/resource approval, fresh identity/recovery checks and hold release |
| Prune, JSONgen and coordinated integration test | **Not run or enabled here**; preserve disabled Prune and accumulated source/test state until the separately authorised test |
| Broader v2 observations, bindings, Core, inventories/checkpoints or recovery evidence retirement | Outside these two recommendations; #159's separate evidence-based decision |

**Only this Markdown report is changed. No application code, configuration, workflows, schema or authoritative system docs were modified. Prune, JSONgen, WHO processing, backfills, migrations, backup jobs and other operational workflows were not run. R2, Dropbox, databases, Cloudflare, schedules, retention settings and source observations were untouched. No merge or deployment is part of delivery.**

[ops]: https://github.com/TEST-uk-aq/uk-aq-ops/tree/f4ebe87003742cc9be775f81dd797c3e32e9a3a8
[contracts]: https://github.com/TEST-uk-aq/uk-aq-system-docs/tree/81df5aeb3d90cd4fcf631587d46baa1b6e51d1d2/system_docs
[schema]: https://github.com/TEST-uk-aq/uk-aq-schema/tree/ee8a5ab568e011587b3b8c8fd0def6b54669fdaa
[website]: https://github.com/TEST-uk-aq/TEST-uk-aq.github.io/tree/494a5fd66297d0442f3207c566e9a1e2c3ae5973
[who-contract]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/81df5aeb3d90cd4fcf631587d46baa1b6e51d1d2/system_docs/who_2021/contract.md
[who-cache]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/81df5aeb3d90cd4fcf631587d46baa1b6e51d1d2/system_docs/cache_proxy/who-summary-contract.md
[aqi-retirement]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/81df5aeb3d90cd4fcf631587d46baa1b6e51d1d2/system_docs/r2_history/aqi_r2_retirement_contract.md
[generation-contract]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/81df5aeb3d90cd4fcf631587d46baa1b6e51d1d2/system_docs/r2_history/observation_history_v3_side_by_side_generation_contract.md
[history-backup]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/81df5aeb3d90cd4fcf631587d46baa1b6e51d1d2/system_docs/backup_and_recovery/r2_history_dropbox_backup_contract.md
