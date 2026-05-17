# R2 history index rebuilder — idempotency tightening options

## 1. Root cause analysis

### Q1. Tree-unit selection scope

- The observations and aqilevels timeseries rebuilders enumerate **all day prefixes** under each domain and process each day unconditionally (`dayList` built from all `day_utc=*` prefixes). There is no input parameter or internal filter for "changed days only."  
- For each day, they resolve connector manifest targets from the day manifest and attempt to rebuild every `(day, connector)` tree unit for that day.  
- Therefore, the current selection model is **full-tree sweep by design** each run.

**By design vs incidental**
- **By design**: full enumeration and re-derivation of all tree units each run.
- **Incidental impact**: this is only cheap when downstream PUT dedupe always skips unchanged payloads.

### Q2. Tree-unit content stability

- Connector index payload `generated_at` is data-driven from `connectorManifest.backed_up_at_utc` (fallback: run-level `generatedAt`). This supports byte stability when source connector manifests do not change.  
- Files and array-like fields are normalized/sorted (`files.sort`, sorted pollutants, sorted connector results), reducing order churn risk.  
- Each connector payload includes `connector_manifest_hash` and `backed_up_at_utc`; if connector manifests change, this should legitimately change affected tree-unit payloads.

**Important finding from code**
- At call sites, every connector key is still rebuilt every run; skip behavior depends entirely on `r2PutObjectIfChanged` MD5 HEAD compare.
- The code path supports stable output for unchanged connector manifests, but it does not reduce compute/read scope before payload build.

**By design vs incidental**
- **By design**: payload includes source-manifest-derived fields (legitimate churn for changed connectors).
- **Incidental risk**: any source manifest rewrite that bumps `backed_up_at_utc`/`manifest_hash` without material file-range changes will still churn connector index bytes.

### Q3. Root-index files (4/4 reread)

- Both timeseries latest index files aggregate `daySummaries` across all listed days and include run-level `generated_at` from `generatedAt` argument directly (not max source timestamp), so they can churn per run if `generatedAt` differs.  
- Domain latest files (`observations_latest.json`, `aqilevels_latest.json`) are built via `buildDomainIndexPayload`, which normalizes `generated_at` from supplied `generatedAt` and sorted day summaries.

**Interpretation**
- Root latest files can be expected to rewrite whenever run-level `generatedAt` changes, even when underlying days are unchanged.
- This is **by design in current code**, and explains why inventory sees all four latest index files as changed in small-delta runs.

### Q4. Small-delta idempotency test coverage

- `tests/uk_aq_r2_history_index.test.mjs` covers helper/data-shape behaviors (day summary extraction, normalization lookback, key layout, config) but does **not** cover end-to-end small-delta rebuild behavior, PUT skip rates, or changed-days fanout limits.
- `tests/uk_aq_r2_history_backup_inventory.test.mjs` validates inventory/sync planning behavior (unchanged/changed/new, strict validation), but does not validate rebuilder side-effects (e.g., whether only affected tree units are rewritten).

**Conclusion**
- The test suite currently exercises **zero-change inventory planning correctness**, but misses the critical **small-targeted-change rebuilder idempotency** scenario.

## 2. Options

### Option A — Add changed-day / changed-connector targeting before rebuild

**Approach**
- Extend `rebuildR2HistoryObservationsTimeseriesIndexes` and `rebuildR2HistoryAqilevelsTimeseriesIndexes` to accept optional targeting input (e.g., explicit day set and/or `(day, connector)` set).
- For targeted runs (such as integrity), process only specified days/connectors; keep current full-sweep as default fallback.
- Optionally derive targets by comparing day-manifest and connector-manifest metadata/hash snapshots from existing latest files if explicit inputs are absent.

**Scope**
- Medium (~120–250 LOC across `workers/shared/uk_aq_r2_history_index.mjs`, script entrypoint plumbing, and tests).

**Behavioral contract**
- **Before**: all day prefixes listed and all tree units re-derived each run.
- **After**: targeted runs re-derive only affected units; full runs remain available.

**Risk surface**
- Inventory builder: compatible; fewer rewritten units means faster inventory/sync.
- `workers/uk_aq_prune_daily/server.mjs`: must pass target hints correctly where known.
- Consumer workers (`uk_aq_db_size_metrics_api_worker/worker.mjs`, `uk_aq_prune_daily/server.mjs` as producer/orchestrator): read paths unchanged; payload schema unchanged.

**Pros**
- Biggest reduction in unnecessary fetch/build/write work.
- Directly addresses root cause (selection scope).

**Cons**
- Needs reliable target derivation/source-of-truth.
- More branching complexity (targeted vs full).

### Option B — Keep full sweep, but make latest/root payload timestamps data-driven

**Approach**
- For `*_timeseries_latest.json` and domain `*_latest.json`, derive `generated_at` from max underlying source timestamps (e.g., max connector `backed_up_at_utc` / max day manifest generated time) instead of run wall-clock `generatedAt`.
- Preserve deterministic sorting and shape.

**Scope**
- Small/Medium (~60–140 LOC plus tests).

**Behavioral contract**
- **Before**: latest files can change each run due to wall-clock timestamp.
- **After**: latest files only change when source data changes.

**Risk surface**
- Consumer workers: generally safe if they treat `generated_at` as metadata; verify no strict assumption that it equals execution time.
- Inventory/sync: fewer latest-file rewrites, but tree-unit full sweep still costs reads/build CPU.

**Pros**
- Low risk, localized change.
- Removes obvious by-design churn for 4 root files.

**Cons**
- Does not solve full-tree unit re-derivation scope by itself.
- If connector manifests churn metadata without data change, unit churn still occurs.

### Option C — Introduce connector-manifest fingerprint gate per unit

**Approach**
- Before building connector unit payload, compare current connector manifest identity tuple (e.g., `manifest_hash` + `backed_up_at_utc` + file-count/size sentinel) against cached identity from prior tree-unit manifest (or sidecar map in latest file).
- If unchanged, skip fetching/building PUT attempt for that unit entirely.

**Scope**
- Medium/High (~180–320 LOC including cache read path + tests).

**Behavioral contract**
- **Before**: every unit rebuilt then deduped at PUT time.
- **After**: unchanged units are short-circuited pre-build.

**Risk surface**
- Requires reliable prior-state read and robust fallback when cache/missing/corrupt.
- More state coupling across runs.
- Consumer schemas unchanged if identity cache kept internal.

**Pros**
- Significant runtime reduction without requiring external changed-day input.
- Complements existing `r2PutObjectIfChanged`.

**Cons**
- Higher implementation complexity.
- Risk of false negatives if identity tuple is incomplete.

## 3. Recommendation

**Recommend Option A + Option B together (phased):**

1. **Implement Option B first** (quick, low-risk): eliminate by-design latest/root timestamp churn.
2. **Implement Option A next** for integrity/backfill-triggered runs: pass changed day/connectors so only affected tree units are processed.

Why this combination:
- Option B is a fast win that immediately reduces needless root-index churn.
- Option A addresses the core scalability issue (full-tree sweep) and aligns with observed small-delta workload behavior.
- Combined, they preserve existing output schema and consumer compatibility while materially reducing inventory reread cascades and Dropbox sync work.

## 4. Test coverage gap

### Currently covered
- Index helper/normalization and key layout behaviors (`tests/uk_aq_r2_history_index.test.mjs`).
- Inventory/sync planning semantics for unchanged/changed/new plus strict inventory validation (`tests/uk_aq_r2_history_backup_inventory.test.mjs`).

### Missing scenarios
- Rebuilder integration scenario: small targeted day-manifest change should only rewrite affected tree units.
- Verification of `put_skipped` ratios across: zero-change, small-delta, full-change cases.
- Latest/root file idempotency under repeated runs with identical source manifests.
- Contract test asserting consumer workers can parse payload after idempotency changes (especially any `generated_at` semantics shift).

## 5. Open questions for the user

1. For integrity/backfill runs, can we reliably provide the exact changed `(domain, day, connector)` set to the rebuilder (preferred), or must the rebuilder discover changes itself?
2. Is `generated_at` on latest/root indexes intended to mean **data freshness** or **job execution time**? (This determines whether Option B can change semantics.)
3. Should we preserve a periodic full-sweep mode (e.g., weekly) as a safety reconciliation pass even after targeted mode is added?
4. Is adding an internal state cache/fingerprint (Option C) acceptable operationally, or should we avoid new persisted coordination state?
