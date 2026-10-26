# Prune Daily backlog, limits and JSONgen-disabled LIVE promotion review

26 October 2026. **Non-authoritative, read-only review; no run or promotion approval.**

## Decision

| Question | Assessment |
|---|---|
| Genuine two-day TEST invocation | **Conditional yes:** eight consecutive completed UTC days, retention 6 and 48 hours select the oldest two days. Confirm actual dates, pending candidates, original-publication eligibility and row counts in the dry-run; the counts alone do not prove them. |
| Maximum hours | All of **48/72/96/144** parse successfully. **Start LIVE at 48**, using retention to bound actual Phase B eligibility. Consider 72 only after measured acceptance; 96 and especially 144 are unsuitable initial LIVE catch-up attempts. |
| JSONgen disabled | **Confirmed for this Prune producer's side effects** with explicit `UK_AQ_JSONGEN_PRUNE_PENDING_SOURCE_ENABLED=false`. Deployment remains conditional on the full import closure, neutral workflow identity and operator configuration review. This flag does not stop independent consumers. |
| Promote current TEST immediately | **Not ready for unconditional approval.** Two-day cache reuse is unaccepted, the workflow hard-codes TEST identity, and current LIVE lacks TEST's prior-history/one-shot first-deletion protections. Promote complete approved TEST files only after the bounded acceptance and compatibility correction below. |
| Backlog configuration | For ten consecutive full days, **retention 8 / 48 hours** is the preferred first two-day scope; retention 9 / 48 is a more conservative one-day scope. Then lower retention in separately reviewed stages. Retention 6 / 48 would publish four days and can prune older days through late cleanup: it is not a two-day work cap. |

**Material new evidence:** LIVE source deletion and a complete locked v3 backup have already occurred in newer GitHub logs. Do not repeat the older statement that both operations remain entirely unperformed. Formal acceptance/release records still need operator reconciliation; this review cannot establish current cloud state.

## Evidence boundary and pinned sources

Fetched GitHub `main` heads before analysis:

- TEST Ops: `0df7453c25889591633a1cdbe72647249aca6b9a`.
- LIVE Ops, comparison only: `daf9ba6660e3c415cb00581d2e1bae348ddaa4bf`.
- Authoritative TEST system docs: `1abdafcf56a53f11af896b61b45401ac950eacb9`.
- TEST Schema prerequisite reference: `74d673f186172c8574b118ccc370d921e9939de1`.

Read TEST Ops root and Prune `AGENTS.md`, system-docs `AGENTS.md` and routed contracts, and Schema `AGENTS.md`. LIVE has no root or Prune `AGENTS.md` at the inspected head. Archived instructions are not active authority. The runtime import closure, package files and Prune workflow at current TEST HEAD are **byte-identical to the corresponding files at the successful 24 October TEST run `098eafe`**. Later unrelated TEST work is not a reason to bulk-promote the repository.

The supplied **LIVE ten / TEST eight full days** are operator counts, not measurements made here. Date examples below assume consecutive completed days ending yesterday, no older partial rows and execution on 26 October UTC. They must be recalculated for the actual invocation. No database, R2, Dropbox, scheduler, maintenance endpoint or other operational resource was queried. GitHub source, run metadata and existing decoded job logs were read. No workflow was dispatched. Downloadable report artifacts and destination backup bytes were not independently inspected; do not conflate log evidence with that stronger check.

## 1. TEST two-day selection and acceptance

Let `T` be today's UTC midnight, `r` IngestDB retention days and `h` maximum hours:

```text
Phase B latest eligible UTC day = date(T) - (r + 1)
Phase B source eligibility      = observed_at < T - r days
Normal downstream window       = [T - r days - h hours, T - r days)
```

The extra one-day rule is applied to the **day's start date**: it makes the last selected day finish at the downstream cutoff. It does not subtract another completed day after applying `observed_at < cutoff`. Phase B has **no lower date bound from h**. [S1][S2]

With eight full days `T-8` through `T-1`, retention 6 admits `T-8` and `T-7`; 48 hours covers exactly these dates. On 26 October: **18 and 19 October**, downstream **18 October 00:00 to 20 October 00:00 UTC**. If “eight days” includes today's partial day, has gaps, or includes older sparse rows, this conclusion changes. The first invocation's Phase B timestamp and the later downstream window are computed separately: avoid crossing UTC midnight, or explicitly reassess a shifted deletion window. [S1][S2]

Keep Phase B enabled and selected generation **`UK_AQ_R2_HISTORY_VERSION=v3`**, with valid TEST database/canonical R2 configuration and the real globally supervised job entry point. Do not restore retired independent index-version selectors. No candidate-cap increase, source mutation, artificial recovery failure, writer selector or 24-hour batch change is needed. JSONgen may follow its separate acceptance plan; disabling it gives the cleanest cache-only benchmark. Preserve the currently accepted physical writer limits and snapshot bounds. [S3][S4]

Selection is by **connector-day**, not day count. Six active connectors per day in recent TEST samples imply approximately **12 candidates / two finalisations**; LIVE samples have seven and must not inherit that six-connector assumption. Discovery groups valid source rows through timeseries/phenomenon/property joins, rejects invalid property codes, preserves/revalidates matching completed candidates and persistently blocked scopes, and fetches pending candidates oldest day then connector, with a default **500** candidate cap (configurable 1–50,000). Completed candidates do not republish merely to satisfy a test. Changed content invalidates old evidence even when count/min/max are unchanged; an already committed historical connector-day, unproven legacy completion or consumed first-delete permission may block that scope. Partial source/checkpoint candidates and older rows can therefore alter the expected two-day work. [S5][S6][S7]

**Mandatory future dry-run review:** confirm forced `dry_run=true`, repository/SHA/generation, effective runtime and JSONgen flag; latest eligible day and source cutoff; exact pending day/connector list and row totals; all populated versus limited pending candidates, complete/blocked/retry candidates and resume counts; planned v3 manifest paths; normal 24-hour batches; older late-arrival days and any discovery truncation; existing gate/identity blocks and mismatch classifications. Require exactly the intended two new publication days, enough pending candidates to exercise both finalisations and no unexpected old source scope. Inspect logs beyond the 25-item previews if necessary. [S5][S8]

**Dry-run limitations:** it returns before the actual publication-boundary prior-canonical guard and cannot prove a new publication will pass that admission or create future READY gates. Fresh unpublished candidates can legitimately appear blocked for downstream deletion in dry-run because their gates do not yet exist. Also, this implementation's dry-run is **not a database-read-only command**: candidate population/invalidation and active gate bookkeeping happen before the dry-run branch. It avoids canonical publication and source DELETE, but still needs separate operational authorisation; none was run here. [S5][S8]

### Required real-run evidence

- Day 1: `phase_b_history_v3_run_finalization_batch_start` with `finalization_batch_trigger=utc_day_boundary`, only its UTC day, followed by successful finalisation and candidate/gate completion **before any day-2 candidate start**. Day 2 uses the same finaliser at loop completion. Aggregate gates follow connector-gate handling; failed siblings gain no authority. [S9]
- In `phase_b_history_v3_run_finalization_complete`, retain `duration_ms`, `latest_global_dependency_count`, `latest_global_dependency_r2_get_count`, `accepted_same_run_evidence_reuse_count`, `evidence_invalidation_count`, `recovered_scoped_reference_count`, `maximum_active_verification_requests` and outcome. For an ordinary first batch, expect full dependency reads and reuse zero. The second should have **positive exact unchanged-reference reuse**, materially fewer origin GETs, and fresh verification of new/changed roots; do not demand a fabricated reuse percentage. Metrics concern the global scoped dependencies, not all R2 requests in the run. [S10]
- The compact cache is capped at **16,384 entries**, bound to the valid Prune owner/run/nonce/global-lock identity, with exact `{key,byte_size,sha256,verified,durable}` evidence only. Successful finalisation makes unchanged dependencies reusable; writes/identity changes invalidate keys. New/changed keys are fetched despite any previous entry. At most **eight concurrent dependency GETs** run in bounded batches. Cache exhaustion falls back to reads, not weaker verification. It is discarded on failure/end; no cross-run reuse. [S10]
- Every required canonical PUT/readback, manifest/parent/index publication and gate check remains mandatory. Genuine scoped-reference recovery authenticates current canonical authority and then strictly rereads the rebuilt complete dependency set without cache reuse. Recovery/invalidation need not occur in a normal two-day acceptance. Do not manufacture them. [S11]
- Protected candidate/gate completion records original matching run/manifest/source identity and **`PRUNE_FIRST_DELETE_READY:v1`**. The final whole-connector/day `REPEATABLE READ` deletion transaction rechecks source identity, complete hourly eligibility, exact scope/counts and full drain; it atomically records **CONSUMED and `history_done=false`** before commit. A false gate after deletion is correct consumption, not failed history publication. Rollback preserves genuine retry authority. Inspect committed versus rolled-back/blocked counts and retained rows, rather than only workflow success. [S7][S12]
- Controlled budget stop leaves unfinished work without deletion authority and attempts accumulated-batch finalisation only through its normal checks. Importantly, top-level `stopped_budget` **skips all downstream deletion**, even if an earlier day completed gates; Phase B failure also skips deletion. Already published/gated rows may remain for a genuine later retry. Isolated prior-history blocks instead produce attention-required scope isolation; global lock/authority/finalisation uncertainty remains fail-closed. [S13]

### Measured timing, not a completion guarantee

| Existing genuine run | Internal result and timing |
|---|---|
| [TEST #40125105670](https://github.com/TEST-uk-aq/uk-aq-ops/actions/runs/40125105670), 24 October, `483d333` | One day (16 October), six candidates, **52,474 published/deleted rows**, six atomic commits. Whole workflow **22m53s**; Phase B about **21m37s**. Finalisation **417,374 ms**; exact latest/global **397,298 ms**, **5,390 GETs**, peak 8, reuse 0. JSONgen pending preparation failed configuration admission, without blocking canonical work. |
| [TEST #40140416278](https://github.com/TEST-uk-aq/uk-aq-ops/actions/runs/40140416278), 24 October, `098eafe` | One day (17 October), six candidates, **48,851 published/deleted rows**, six atomic commits, no blocks/rollbacks/budget stop. Workflow **29m37s**; Phase B about **27m35s**. Finalisation **334,349 ms**; exact latest/global **310,230 ms**, **5,453 GETs**, peak 8, reuse 0. Producer JSONgen handover succeeded; independent consumer acceptance is separate. |
| [LIVE #40083506656](https://github.com/UK-AQ/uk-aq-ops/actions/runs/40083506656), 24 October, `daf9ba6` | Two days (12–13 October), **14 candidates / 144,516 rows**, all deleted in 14 atomic commits; no blocks/budget stop. Workflow **2h53m56s**. Per-day finalisations **4,133,927 / 2,906,902 ms** (68.9 / 48.4 minutes). Older serial verification, not evidence of the new cache. |
| [LIVE #40102606866](https://github.com/UK-AQ/uk-aq-ops/actions/runs/40102606866), 24 October, same head | Two days (14–15 October), **14 candidates / 145,456 published rows**, workflow **2h25m47s**, finalisations **2,973,656 / 2,507,192 ms**. Only **129,160 deleted**, 12 atomic commits, 48 blocked buckets and two unresolved SAQN hourly mismatches. A green workflow did not mean complete clearance. |
| [LIVE #40186865398](https://github.com/UK-AQ/uk-aq-ops/actions/runs/40186865398), 25 October | Retention **9**, 48 hours, selected v3. No new pending publication; **16,296 previously published rows** deleted in two atomic commits, zero remaining reported mismatch/blocks. Workflow **1m08s**. Not a publication benchmark. |

These are decoded job-log observations, with structured internal outcomes inspected. TEST timings agree with the [current runtime evidence record][D1]. The three-hour envelope is ample for a **supervised two-day TEST attempt** at recent source sizes, but not proof of completion. A rough additive two-day projection is **45–60 minutes** before cache savings; different day sizes, optional binding reads, contention or recovery can change it substantially. Four days might approach **90–120 minutes**, six **135–180 minutes** using those TEST samples alone; these are screening projections, not LIVE forecasts. LIVE's larger archive and seven connectors invalidate a simple TEST-to-LIVE extrapolation. Eight-way GET overlap is not a guaranteed eightfold speed-up.

## 2. Hours, independent bounds and retry behaviour

The workflow maps repository variable `INGESTDB_PRUNE_MAX_HOURS_PER_RUN` to runtime **`MAX_HOURS_PER_RUN`**. `maxHours` URL input can override it. Parsing uses `Number`, integer truncation and clamp **1–744 hours**; nonfinite values fall back to 48. Empty/null values can coerce to zero then clamp to one, so use explicit numbers. All four proposed values are within range; none changes the Phase B query. Retention is separately bounded and TEST rejects less than **2 UTC days**. [S2][S14]

| Scope | Effect of 48 → 72/96/144 |
|---|---|
| Phase B publication | No direct effect. All historical eligible source connector-days are discovered independently, then pending-candidate and budget limits apply. |
| Phase A recent repair checks | No effect: separate default recent **3-day** window, configurable 1–14 days, 24-hour batches; runs before Phase B. |
| Normal downstream pruning | Expands the window backwards from the fixed retention cutoff; produces 2/3/4/6 batches of at most **24 hours**. |
| Hour-oriented deletion batches | Does not change `DELETE_BATCH_SIZE=50,000` / default ten batches per hour; exact whole connector-day transaction remains the commit unit. Caps/incomplete drains roll back the entire connector-day. |
| Late-arrival cleanup | Moves its discovery boundary backwards, rather than limiting its total work: it searches rows **older than normal window start**. |
| Overall work | Not a total work, row, query, R2-operation or wall-time cap. |

Late discovery scans up to **100 × 1,000 rows**, reports truncation and selects at most **14 repair-eligible UTC days**. Older-than-ObsAQIDB-retention days use the separate direct-delete path, still requiring canonical source identity and gate/atomic authority; the 14-day repair limit is not a universal cleanup cap. Default ObsAQIDB retention remains **14 days**, separate from IngestDB retention. Thus days outside the normal window are **not necessarily untouched**: eligible already published days may be processed by late cleanup in the same invocation. Unseen/truncated, blocked or incomplete days remain stored; do not promise full catch-up from the configured h. [S15]

Default 500 pending connector-days is normally enough for 12/18/24/36 TEST or 14/21/28/42 LIVE candidates across 2/3/4/6 days, assuming the measured connector counts persist. However, discovery and completed-source revalidation cover the wider eligible source set **before** applying the pending cap. It is not a cheap bounded query just because the cap is 500. Each candidate freezes/scans source, serialises Parquet, writes/verifies parts and manifests/exact indexes, and the day boundary repeats canonical aggregate/latest finalisation over the archive's global references. Unchanged-root cache reuse saves later global GETs; it does not remove candidate source reads, new PUTs, fresh verification, full-day fingerprint checks or deletion transactions. [S5][S9][S10]

Other independent limits: per-connector/day frozen source defaults **250,000 rows / 256 MiB**; bounded cursor fetching and accepted aligned v3 writer/segment limits; R2 per-request retry/deadline admission; PostgreSQL Phase B control statement bound **600 seconds**, connection bound **15 seconds**, reduced to remaining usable budget. v3 candidate admission needs **555,500 ms** remaining, derived from the **375,500 ms** request-based finalisation allowance plus candidate work. This is admission, not reserved time or a guarantee that a large global scan fits. [S16]

Both **current TEST and current LIVE workflow files already specify** Phase B **10,740 s**, stop reserve **60 s**, shell **180m**, Actions **190m**: effective Phase B budget **10,680 s / 178m**. LIVE is not currently on the older 30-minute or normal 60-minute worker budget, despite the copied “TEST-only” comment. The normal contract remains **3,540 / 60 s**, shell **60m**, Actions **70m**; its newest evidence explicitly calls the extended envelope temporary. Preserve/review the temporary envelope for this supervised acceptance; do not permanently adopt it by inference. Phase B's clock starts after Phase A and it does not reserve substantial downstream deletion time inside the shell's total 180m. A near-limit Phase B completion can still leave insufficient process time for pruning/reporting. [S3][S16][D1][L1]

**Recommendation:** 48 initially; 72 is structurally allowed but requires a measured accepted wider run and enough time for downstream work. Do not start at 96 or 144. Multiple separately supervised short scopes are preferable to one six-day attempt, even though each new invocation must pay its first full dependency verification again. Increasing h alone cannot cap Phase B or clear all blockers. Keep complete gates and original source evidence for safe retries; never reset consumed/unproven candidates to manufacture permission. Partially published R2 work is not a completed gate; a real same-attempt continuation requires authenticated original-attempt evidence, and unproven gate-only recovery remains blocked. [S7][S11][S13]

## 3. JSONgen false: complete producer trace

`resolvePhaseBRuntimeConfig` constructs `enabled = generation === 'v3' && parseBoolean(flag,false)` and only resolves signer configuration inside that enabled branch. The workflow's JSONgen endpoint/bucket preflight is also conditional on literal `true`. Explicit literal **`false`** is the recommended LIVE setting. [S3][S17]

| JSONgen work | False-path behaviour |
|---|---|
| Frozen pending-source validation/compression; signer intent; conditional derived-R2 source PUT | Enabled-only branch skipped. The canonical frozen source still exists because the ordinary writer needs it. |
| Original-only before-state metadata and binding capture | Optional capture returns null unless enabled; its custom admission capture/read adapters and optional binding acquisition do not execute. Canonical prior-authority metadata reads remain required independently. |
| Additional canonical JSON metadata retention for JSONgen | Optional capture is null; connector JSONgen child snapshots are not assembled. Ordinary canonical verification continues. |
| Evidence bundle preparation, upload and private readback | Entire enabled-only final-evidence block skipped. |
| PostgreSQL JSONgen outbox insertion | `outbox=null`; no SAVEPOINT/function call. Mandatory candidate/gate transaction still commits. |
| Post-commit handover/notification | `outbox_state=disabled`; post-commit handover preparation is entered only after an inserted outbox. Even enabled operation currently prepares a reference with external delivery `not_attempted`; no hidden normal notification sender is invoked. |

The guards are at the actual candidate/finaliser/transaction call sites, not inferred from the setting name. `phase_b_jsongen_disabled` informational diagnostics and zero summary counters may still appear; they are not external JSONgen operations. [S18][S19][S20]

**Import caveat:** the JSONgen modules are unconditional ESM imports. They transitively pull in schema/event/coverage/consumer helper modules even when the producer is off. At the inspected HEAD their top-level work is declarations, compact in-memory structures and a bucket-string capture; target/credential validation, DB connection and external reads/writes are function calls, not mandatory module-start preflights. Missing files, incompatible exports or packages can nevertheless prevent startup before the flag is consulted. Ship the exact full closure below. No new JSONgen package, signer deployment, private bucket, credential, outbox table/function or reader migration is needed **for false-mode execution**. This confirms an operating mode, not immunity from broken packaging. [S21]

Existing outbox events/private pending objects are neither consumed, deleted nor revoked by this flag. A separately invoked consumer, signer or publisher can still operate under its own settings/credentials and authority. Keep independent LIVE JSONgen consumers/publication inactive if the operational objective is no JSONgen activity anywhere. The false producer flag alone is not a global kill switch. New canonical writes with JSONgen off also do not create recoverable original JSONgen handovers retrospectively. [D2]

**No extra runtime side-effect guard is required by this inspection.** Do not remove JSONgen code or create a LIVE fork. A separate TEST-first workflow identity correction is needed for environment-independent promotion.

## 4. Complete-file promotion scope and remaining blockers

Current LIVE has a functioning v3 writer/recovery stack, but it is older. It lacks `committed_history_guard.mjs`, `deletion_attempt_state.mjs`, the exact run-local reuse optimisation/bounded newer recovery verification, returned-row candidate/gate COMMIT checks, and READY→CONSUMED enforcement in deletion. Its successful older runs prove source publication/deletion occurred; **they do not prove the new one-shot permission lifecycle**. Legacy completed LIVE candidates lacking READY must remain unproven under promoted code; no permission backfill is approved. [S7][S11][S12][L2]

### Required TEST-first correction

The current workflow literally sets **`UK_AQ_ENV_NAME: TEST`**, while the distinct task-health label `UKAQ_ENV_NAME` comes from a repository variable and currently uses lowercase `live` in LIVE run logs. The JSONgen canonical identity validator requires uppercase and provides no inferred default. Simply promoting the workflow would mislabel the canonical environment; blindly copying the lowercase task-health value would also be invalid. [S3][S21]

Use the existing canonical name as an explicit repository/environment variable: **`UK_AQ_ENV_NAME: ${{ vars.UK_AQ_ENV_NAME }}`**, with validated uppercase canonical values and no TEST fallback. Keep `UKAQ_ENV_NAME` for its existing purpose, or deliberately map/validate it in TEST if the owner chooses consolidation. Align the existing private catalogue/target mapping during that correction, without adding a new name or embedding LIVE values in application files. Validate the exact corrected complete workflow in TEST before promotion. This review makes no correction. Any optional hard-coded TEST evidence fields remain unreachable in disabled LIVE mode; future enabled LIVE JSONgen needs its own reviewed contract/work, not silent activation. [S17][S20][S21]

### Runtime file manifest

The following appendix is the exact current **70-file local runtime dependency closure**, including the dynamically spawned child supervisor. Forty files differ or are missing in LIVE; 30 already match byte-for-byte and must remain present. In addition, promote the complete approved Prune workflow, `package.json` and `package-lock.json` (**43 currently differing/missing files total**). Recompute the manifest after the TEST-first correction and final accepted SHA. Do not promote fragments or archives.

| Complete file (pinned TEST bytes) | LIVE comparison |
|---|---|
| [scripts/jsongen/admission.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/jsongen/admission.mjs#L1) | missing |
| [scripts/jsongen/authority.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/jsongen/authority.mjs#L1) | missing |
| [scripts/jsongen/environment.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/jsongen/environment.mjs#L1) | missing |
| [scripts/jsongen/inputs.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/jsongen/inputs.mjs#L1) | missing |
| [scripts/jsongen/inspection-plan.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/jsongen/inspection-plan.mjs#L1) | missing |
| [scripts/jsongen/inspection-runtime.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/jsongen/inspection-runtime.mjs#L1) | missing |
| [scripts/jsongen/limits.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/jsongen/limits.mjs#L1) | missing |
| [scripts/jsongen/prune-consumer-authentication.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/jsongen/prune-consumer-authentication.mjs#L1) | missing |
| [scripts/jsongen/prune-consumer-partitions.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/jsongen/prune-consumer-partitions.mjs#L1) | missing |
| [scripts/jsongen/prune-coverage-plan.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/jsongen/prune-coverage-plan.mjs#L1) | missing |
| [scripts/jsongen/prune-event-schema.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/jsongen/prune-event-schema.mjs#L1) | missing |
| [scripts/jsongen/prune-evidence-bundle.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/jsongen/prune-evidence-bundle.mjs#L1) | missing |
| [scripts/jsongen/prune-evidence.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/jsongen/prune-evidence.mjs#L1) | missing |
| [scripts/jsongen/prune-final-evidence.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/jsongen/prune-final-evidence.mjs#L1) | missing |
| [scripts/jsongen/prune-metadata-codec.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/jsongen/prune-metadata-codec.mjs#L1) | missing |
| [scripts/jsongen/prune-original-authority.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/jsongen/prune-original-authority.mjs#L1) | missing |
| [scripts/jsongen/prune-original-identity.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/jsongen/prune-original-identity.mjs#L1) | missing |
| [scripts/jsongen/prune-original-metadata.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/jsongen/prune-original-metadata.mjs#L1) | missing |
| [scripts/jsongen/prune-outbox-reader.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/jsongen/prune-outbox-reader.mjs#L1) | missing |
| [scripts/jsongen/prune-outbox.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/jsongen/prune-outbox.mjs#L1) | missing |
| [scripts/jsongen/prune-pending-source.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/jsongen/prune-pending-source.mjs#L1) | missing |
| [scripts/jsongen/prune-pending-verification.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/jsongen/prune-pending-verification.mjs#L1) | missing |
| [scripts/jsongen/prune-signed-upload.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/jsongen/prune-signed-upload.mjs#L1) | missing |
| [scripts/jsongen/r2-config.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/jsongen/r2-config.mjs#L1) | missing |
| [scripts/jsongen/schema.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/jsongen/schema.mjs#L1) | missing |
| [scripts/jsongen/scope-authority.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/jsongen/scope-authority.mjs#L1) | missing |
| [workers/shared/r2_sigv4.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/r2_sigv4.mjs#L1) | changed |
| [workers/shared/uk_aq_connector_day_gate.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/uk_aq_connector_day_gate.mjs#L1) | changed |
| [workers/shared/uk_aq_observation_history_operational_writer_v3.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/uk_aq_observation_history_operational_writer_v3.mjs#L1) | changed |
| [workers/shared/uk_aq_observation_history_reader_v3.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/uk_aq_observation_history_reader_v3.mjs#L1) | changed |
| [workers/shared/uk_aq_observation_history_scoped_manifest_v3.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/uk_aq_observation_history_scoped_manifest_v3.mjs#L1) | changed |
| [workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs#L1) | changed |
| [workers/shared/uk_aq_r2_observations_global_finalizer.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/uk_aq_r2_observations_global_finalizer.mjs#L1) | changed |
| [workers/shared/uk_aq_r2_observations_manifest_hierarchy_finalizer.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/uk_aq_r2_observations_manifest_hierarchy_finalizer.mjs#L1) | changed |
| [workers/uk_aq_prune_daily/committed_history_guard.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/uk_aq_prune_daily/committed_history_guard.mjs#L1) | missing |
| [workers/uk_aq_prune_daily/deletion_attempt_state.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/uk_aq_prune_daily/deletion_attempt_state.mjs#L1) | missing |
| [workers/uk_aq_prune_daily/job.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/uk_aq_prune_daily/job.mjs#L1) | changed |
| [workers/uk_aq_prune_daily/phase_b_history_r2.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/uk_aq_prune_daily/phase_b_history_r2.mjs#L1) | changed |
| [workers/uk_aq_prune_daily/server.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/uk_aq_prune_daily/server.mjs#L1) | changed |
| [workers/uk_aq_prune_daily/source_identity_deletion.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/uk_aq_prune_daily/source_identity_deletion.mjs#L1) | changed |
| [lib/aqi/aqi_levels.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/lib/aqi/aqi_levels.mjs#L1) | identical |
| [scripts/backup_r2/lib/timeseries_binding_source_hierarchy_v2.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/backup_r2/lib/timeseries_binding_source_hierarchy_v2.mjs#L1) | identical |
| [scripts/backup_r2/lib/timeseries_binding_source_state_v2.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/backup_r2/lib/timeseries_binding_source_state_v2.mjs#L1) | identical |
| [scripts/backup_r2/lib/uk_aq_v2_observations_manifest_validation.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/backup_r2/lib/uk_aq_v2_observations_manifest_validation.mjs#L1) | identical |
| [scripts/operations/lib/uk_aq_sos_light_v2_lock_recovery.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/operations/lib/uk_aq_sos_light_v2_lock_recovery.mjs#L1) | identical |
| [scripts/operations/uk_aq_observations_global_operation_child_supervisor.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/operations/uk_aq_observations_global_operation_child_supervisor.mjs#L1) | identical |
| [scripts/operations/uk_aq_with_observations_global_operation_lock.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/operations/uk_aq_with_observations_global_operation_lock.mjs#L1) | identical |
| [workers/shared/daily_task_health.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/daily_task_health.mjs#L1) | identical |
| [workers/shared/uk_aq_observation_content_hash.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/uk_aq_observation_content_hash.mjs#L1) | identical |
| [workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/uk_aq_observation_history_exact_leaf_index_v3.mjs#L1) | identical |
| [workers/shared/uk_aq_observation_history_exact_leaf_reader_v3.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/uk_aq_observation_history_exact_leaf_reader_v3.mjs#L1) | identical |
| [workers/shared/uk_aq_observation_history_generation.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/uk_aq_observation_history_generation.mjs#L1) | identical |
| [workers/shared/uk_aq_observation_history_index_v3.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/uk_aq_observation_history_index_v3.mjs#L1) | identical |
| [workers/shared/uk_aq_observation_history_random_access_v3.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/uk_aq_observation_history_random_access_v3.mjs#L1) | identical |
| [workers/shared/uk_aq_observation_history_schema.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/uk_aq_observation_history_schema.mjs#L1) | identical |
| [workers/shared/uk_aq_observation_history_target_writer.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/uk_aq_observation_history_target_writer.mjs#L1) | identical |
| [workers/shared/uk_aq_observation_history_writer_limits_v3.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/uk_aq_observation_history_writer_limits_v3.mjs#L1) | identical |
| [workers/shared/uk_aq_observation_property_code.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/uk_aq_observation_property_code.mjs#L1) | identical |
| [workers/shared/uk_aq_observation_verification_overlay.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/uk_aq_observation_verification_overlay.mjs#L1) | identical |
| [workers/shared/uk_aq_prune_connector_source_identity.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/uk_aq_prune_connector_source_identity.mjs#L1) | identical |
| [workers/shared/uk_aq_r2_checksum_publication.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/uk_aq_r2_checksum_publication.mjs#L1) | identical |
| [workers/shared/uk_aq_r2_file_identity.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/uk_aq_r2_file_identity.mjs#L1) | identical |
| [workers/shared/uk_aq_r2_history_canonical.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/uk_aq_r2_history_canonical.mjs#L1) | identical |
| [workers/shared/uk_aq_r2_history_index.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/uk_aq_r2_history_index.mjs#L1) | identical |
| [workers/shared/uk_aq_r2_history_manifest_validation.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/uk_aq_r2_history_manifest_validation.mjs#L1) | identical |
| [workers/shared/uk_aq_r2_history_version.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/uk_aq_r2_history_version.mjs#L1) | identical |
| [workers/shared/uk_aq_r2_history_writer.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/uk_aq_r2_history_writer.mjs#L1) | identical |
| [workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/uk_aq_r2_observations_manifest_hierarchy.mjs#L1) | identical |
| [workers/uk_aq_prune_daily/fingerprint_recheck.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/uk_aq_prune_daily/fingerprint_recheck.mjs#L1) | identical |
| [workers/uk_aq_prune_daily/pg_source_egress_diagnostic.mjs](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/uk_aq_prune_daily/pg_source_egress_diagnostic.mjs#L1) | identical |
| [.github/workflows/uk_aq_prune_daily.yml](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/.github/workflows/uk_aq_prune_daily.yml#L1) | changed; workflow needs TEST-first identity correction |
| [package.json](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/package.json#L1) | changed |
| [package-lock.json](https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/package-lock.json#L1) | changed |

`package.json` and the lockfile contain the same dependency versions in TEST and LIVE: `@supabase/supabase-js`, `apache-arrow`, `hyparquet`, `hyparquet-compressors`, `parquet-wasm`, `pg`, `pg-cursor` (plus existing unrelated `proj4`). There is **no additional JSONgen npm package**. The metadata engine changes from `>=20` to **`>=22`**; TEST workflow pins **Node 24.22.1**, `checkout@v5`, `setup-node@v7`, `upload-artifact@v6`, versus LIVE Node 20 / v4 actions. Use the approved complete package/lock pair and `npm ci --ignore-scripts`, including the packaged `parquet_wasm_bg.wasm`; do not mix node_modules from old LIVE. The complete package also adds an unrelated dashboard-check npm script: it is not invoked by Prune and does not require broad dashboard promotion. [S3][S22][L1]

No consumer/signer deployment workflow, JSONgen scheduler, backup migration runner, archive, speculative test suite or whole-repository sync is part of this Prune promotion. The existing lock coordinator, its child supervisor and source/manifest helpers already match; leaving any out of a minimal deployment bundle would still break it. Shared-module promotion also affects other users of those modules and needs operator review of that exposure.

**Database prerequisites to establish from existing migration/acceptance records:** private `history_candidates` with resume/source-identity/run/manifest/error fields, connector-day and aggregate gates, the selected-v3 manifest constraint, required source extraction/fingerprint/repair/delete RPCs, and the actual role's permissions for transactional source SELECT/DELETE and candidate/gate updates. Relevant active migrations are `20260727_001_ingest_prune_connector_day_gates.sql`, `20260728_001_ingest_prune_connector_source_identity.sql`, `20260906_001_ingest_prune_side_by_side_generation_gates.sql`, and the separate IngestDB/ObsAQIDB `20260820_*_prune_fingerprint_statement_timeout.sql`. Existing successful LIVE v3 runs provide operational evidence for many prerequisites, not an independent current schema audit. READY/CONSUMED reuse existing fields: no new marker migration. The optional `20261017_001_ingest_prune_jsongen_gate_acceptance_outbox.sql` and restricted consumer reader migration are **not prerequisites with JSONgen false**. Do not apply them solely for this promotion. [M1][M2][M3]

**Global lock:** the job starts `scripts/operations/uk_aq_with_observations_global_operation_lock.mjs` against the environment's direct/session-stable **`SUPABASE_DB_URL`** (fallback `DATABASE_URL` for non-workflow callers), owner `prune_daily`, one generated UUID; 60-second acquisition timeout and 5-second heartbeat. It injects held owner/run/nonce/identity metadata and retains the owning session through publication, gates and deletion. Do not configure fabricated `UK_AQ_OBSERVATIONS_GLOBAL_OPERATION_LOCK_*` proof values as repository variables. All canonical writers/backups must use the same environment-local IngestDB lock database. Workflow concurrency alone does not exclude backups/manual writers. [S23][D3]

### LIVE completion and release status

The [21 October completion decision][D4] still records execution pending, retention **10** for its first bounded exercise, paused writers/maintenance, explicit v2 rollback-guarantee closure before first destructive deletion, then a full locked backup. It waives only the additional archive-wide post-write verifier for this particular LIVE completion; it does not waive normal Prune verification/gates or backup completeness. Do not treat it as a mandate to repeat already completed work or as approval to change retention now.

Newer logs establish source-deleting LIVE operations as shown above. [LIVE backup #40168669792](https://github.com/UK-AQ/uk-aq-ops/actions/runs/40168669792), **25 October 06:19–07:05 UTC**, reports `ok=true`, `complete=true`, generation v3, `dry_run=false`, observation copy **full**, `max_days_per_run=0`, held global lock from inventory through checkpoint publication. Its five changed days (11–15 October) were copied, with no incomplete months/years. Source and processed observation-root hashes both equal **`b4041ed8bcbbb534b27524b7ca78a8ae36dfa857d214a02db7a4ee4641caf75a`**. The compact latest summary was copied/verified; packed bindings report complete with matching source/processed binding roots. This is meaningful internal completion evidence, not merely Actions green.

That backup used **pack**, whereas the old decision cautioned against assuming TEST's pack default in LIVE. Operator must reconcile the actual approved transport/promotion and historical checkpoint lineage, accept the retained report/root/checkpoint identities, record the actual first accepted v3 backup identity and earlier rollback-closure timestamp, and resolve documentation status. This review does not independently re-read Dropbox or certify every destination byte. The later 25 October Prune deleted already-published source without new canonical publication, so its log does not itself imply a newer canonical root than that backup. Future source publications will advance it.

Committed LIVE `jobs.toml` still sets Prune disabled, but applied scheduler/maintenance state and operator acceptance are unverified here. Keep/re-establish supervised exclusion as required; reconcile the old special maintenance decision before any broad release. Do not infer scheduler release from successful manual runs. Do not rerun or repin the failed heavyweight verifier, claim a fabricated PASS, or assume a complete lossless return to pre-migration v2 after source deletion. [D4][D5]

## 5. Backlog choices and proposed operator sequence

For the reported ten consecutive full days, the model has source dates **16–25 October** on 26 October. Phase B would discover the dates below **only where rows remain**; pending publication excludes completed/blocked scopes. Each additional day costs one day finalisation and approximately seven LIVE connector-days, using recent LIVE observations rather than assuming all are pending.

| Retention | Eligible full dates / Phase B maximum modeled days | Matching normal window | Candidate/finalisation planning load | Assessment |
|---|---|---|---|---|
| 10 | None | 48h: 14–15 Oct | 0 new, assuming no older remnants | Old completion decision's former bounded setting; it no longer guarantees even one day from the supplied count. |
| 9 | 16 Oct (1) | 48h: 15–16 Oct | ~7 / 1 | Most cautious first scope; one nominal empty earlier day. Last observed LIVE retention was 9, not 6. |
| 8 | 16–17 Oct (2) | **48h: 16–17 Oct** | ~14 / 2 | Preferred initial two-day catch-up after TEST acceptance. |
| 7 | 16–18 Oct (3) | 72h: 16–18 Oct | ~21 / 3 | Conditional later wider run, not initial recommendation. |
| 6 | 16–19 Oct (4) | 96h: 16–19 Oct | ~28 / 4 | Aligned but larger publication and finalisation load. With 48h normal covers only 18–19; with 72h only 17–19. Older eligible days can still be pruned through late cleanup. |
| 5 | 16–20 Oct (5) | 144h: 15–20 Oct | ~35 / 5 | Covers all plus one nominal empty day; choose retention 5 only if approved as the desired policy, not because it is the source fallback. |
| 4 | 16–21 Oct (6) | 144h: 16–21 Oct | ~42 / 6 | Aligned six-day attempt; defer. Higher partial-completion/timeout exposure. |

For any of these retention values, choosing a wider h adds older normal-window coverage; choosing a narrower h leaves the earliest eligible dates outside that normal window **without preventing Phase B publication or subsequent late cleanup**. The formula in section 1 defines all 48/72/96/144 combinations. Retentions above ten publish none under this model; retentions 3 or 2 admit seven/eight days, exceeding even 144h normal coverage and the intended bounded catch-up. Sparse older rows invalidate the neat table and must be exposed by dry-run.

Recommended sequence, **operator-controlled and separately authorised at each operational boundary**:

1. Approve a real **TEST retention 6 / 48h**, explicit JSONgen mode and the existing **10,740/60-second, 180m/190m temporary** envelope. Inspect the mandatory dry-run first, then authorise a genuine two-day non-dry-run. No operation is authorised by this document.
2. Accept internal diagnostics: both day finalisations in order, positive second-day exact reuse, fresh changed roots, peak at most eight, complete canonical/gate evidence, exact source-matched atomic deletion and no hidden partial/budget/failure state. Do not force a recovery failure or mutate source for coverage.
3. Make the minimal **TEST-first workflow identity correction**, align its catalogue/target mapping and validate the exact final complete files in TEST. Keep JSONgen false-mode packaging and operation part of acceptance; an enabled JSONgen run alone does not operationally prove the disabled path. Resolve any genuine mismatch before promotion.
4. Operator reviews/promotes the exact approved complete-file manifest to LIVE; no archive copy, LIVE code patch or unrelated JSONgen deployment. Pin accepted SHA, Node/packages, credentials, selected v3 generation and actual DB/lock prerequisites.
5. Explicit LIVE JSONgen producer **false**; independently keep consumers/publication inactive. Reconcile the existing source-delete/backup/rollback-closure evidence with the old completion decision and actual maintenance/scheduler exclusion. Approve a new selection policy explicitly if it differs from that decision.
6. LIVE dry-run: first choose **retention 9 / 48h for one day**, or **8 / 48h for two** after the operator accepts the wider scope. Inspect dates, source rows, blocked legacy gates and all late cleanup. Initial maximum remains 48, not 144.
7. Only after separate operator authorisation, run the accepted supervised LIVE non-dry-run, retaining the temporary budget unless an accepted TEST-first workflow revision selects another. `dry_run=false` input does not override repository `INGESTDB_PRUNE_DRY_RUN=true`; both effective controls must deliberately permit deletion. Stop on new integrity uncertainty; report partial progress rather than assuming a green result means clearance.
8. Reconcile published source counts, final parent/latest identities, original READY then CONSUMED markers, committed deleted rows, zero remaining snapshot rows, rollbacks/mismatches and pending/blocked candidates. No invented READY for legacy candidates. For a target retention of **6**, after accepting the first 8/48 two-day scope, a later **6/48** scope can cover the next two remaining days **only if** older source was actually drained; otherwise Phase B/late cleanup can still exceed two days. Recompute for date rollover. If the desired final policy is 5, approve that separately and finish with another bounded scope.
9. Accept/reuse the genuine first backup evidence if valid; take the required later complete locked backup after new canonical publication, or complete any outstanding backup acceptance. Use selected v3/full/unlimited scope and the **actually approved LIVE binding mode**. Verify matching root/inventory/checkpoint/latest identities and no pending work. Then release only the separately authorised schedulers/maintenance under the governing contracts, normal schedules last; do not leave a temporary catch-up schedule unnoticed.

## 6. Safety blockers versus operational limits

**Safety/release blockers:** absent or lost global lock; unauthenticated prior-history/recovery authority; source/manifest/file/index mismatch; missing READY or consumed/unproven legacy permission; incomplete whole-day fingerprint eligibility, source drain or atomic marker consumption; missing import files; wrong environment/resource identity; unaccepted promotion or policy/rollback/backup release evidence. None is cured by increasing h or bypassing a gate.

**Performance/operational limits:** independent candidate count and snapshot caps, archive-wide first global scan, repeated per-day work, PostgreSQL/R2 latency and retries, late-arrival scan/repair limits, Phase A and downstream time outside Phase B's clock, cache capacity, UTC rollover and finite report previews. These justify smaller supervised stages and measured budgets. A controlled stop is retry-safe protection, not completed backlog clearance; no source retention or history correctness promise should depend on a six-day timing projection.

Only this review document is changed. No implementation, workflow, schema, environment or authoritative `system_docs/` file is changed; no tests, operational runs, deployment or merge are performed. Validation is limited to pinned-reference/file-manifest and documentation/whitespace checks. Chat-mode documentation owner handover: reconcile the newer LIVE run/backup evidence and chosen retention/release policy with the pending completion record, and record final TEST multi-day acceptance/temporary-budget disposition after it genuinely occurs.

## Pinned code and contract references

[S1]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/uk_aq_prune_daily/phase_b_history_r2.mjs#L6939-L6973
[S2]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/uk_aq_prune_daily/server.mjs#L475-L510
[S3]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/.github/workflows/uk_aq_prune_daily.yml#L22-L143
[S4]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/uk_aq_observation_history_generation.mjs#L1-L94
[S5]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/uk_aq_prune_daily/phase_b_history_r2.mjs#L1584-L1954
[S6]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/uk_aq_prune_daily/phase_b_history_r2.mjs#L1430-L1575
[S7]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/uk_aq_prune_daily/committed_history_guard.mjs#L1-L286
[S8]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/uk_aq_prune_daily/phase_b_history_r2.mjs#L7346-L7440
[S9]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/uk_aq_prune_daily/phase_b_history_r2.mjs#L7446-L7500
[S10]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs#L355-L585
[S11]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs#L2110-L2245
[S12]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/uk_aq_prune_daily/source_identity_deletion.mjs#L494-L780
[S13]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/uk_aq_prune_daily/server.mjs#L2880-L2945
[S14]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/uk_aq_prune_daily/server.mjs#L94-L121
[S15]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/uk_aq_prune_daily/server.mjs#L2458-L2764
[S16]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/uk_aq_prune_daily/phase_b_history_r2.mjs#L168-L201
[S17]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/uk_aq_prune_daily/phase_b_history_r2.mjs#L7023-L7040
[S18]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/uk_aq_prune_daily/phase_b_history_r2.mjs#L4187-L4348
[S19]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/uk_aq_prune_daily/phase_b_history_r2.mjs#L4596-L4702
[S20]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/workers/uk_aq_prune_daily/phase_b_history_r2.mjs#L2406-L2472
[S21]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/jsongen/schema.mjs#L1-L33
[S22]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/package.json#L1-L56
[S23]: https://github.com/TEST-uk-aq/uk-aq-ops/blob/0df7453c25889591633a1cdbe72647249aca6b9a/scripts/operations/uk_aq_with_observations_global_operation_lock.mjs#L182-L270
[D1]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/1abdafcf56a53f11af896b61b45401ac950eacb9/system_docs/r2_history/prune_daily_runtime_budget.md#L1-L20
[D2]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/1abdafcf56a53f11af896b61b45401ac950eacb9/system_docs/station_charts/jsongen_prune_verification_handover_quick_reference.md#L19-L40
[D3]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/1abdafcf56a53f11af896b61b45401ac950eacb9/system_docs/r2_history/observations_run_exclusion_contract.md#L25-L85
[D4]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/1abdafcf56a53f11af896b61b45401ac950eacb9/system_docs/r2_history/observation_history_v3_live_completion_decision_2026-10-21.md#L1-L79
[D5]: https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/1abdafcf56a53f11af896b61b45401ac950eacb9/system_docs/r2_history/phase6_operational_writer_freeze_contract.md#L14-L41
[L1]: https://github.com/UK-AQ/uk-aq-ops/blob/daf9ba6660e3c415cb00581d2e1bae348ddaa4bf/.github/workflows/uk_aq_prune_daily.yml#L22-L131
[L2]: https://github.com/UK-AQ/uk-aq-ops/blob/daf9ba6660e3c415cb00581d2e1bae348ddaa4bf/workers/uk_aq_prune_daily/source_identity_deletion.mjs#L260-L310
[M1]: https://github.com/TEST-uk-aq/uk-aq-schema/blob/74d673f186172c8574b118ccc370d921e9939de1/schemas/migrations/20260727_001_ingest_prune_connector_day_gates.sql#L1-L40
[M2]: https://github.com/TEST-uk-aq/uk-aq-schema/blob/74d673f186172c8574b118ccc370d921e9939de1/schemas/migrations/20260728_001_ingest_prune_connector_source_identity.sql#L1-L62
[M3]: https://github.com/TEST-uk-aq/uk-aq-schema/blob/74d673f186172c8574b118ccc370d921e9939de1/schemas/migrations/20260906_001_ingest_prune_side_by_side_generation_gates.sql#L1-L28
