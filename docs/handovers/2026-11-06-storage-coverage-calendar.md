# Storage Coverage Calendar — Stage 2 TEST handover

Status: local implementation only, 6 November 2026. No deployment, database
operation, migration, restart or Git mutation was run by this implementation.

## Behaviour and source authority

The shared calendar now has four fixed, independent observation sources:
IngestDB, ObsAQIDB observations, R2 observations and Dropbox observations.
A row flag is true (confirmed present), false (confirmed absent), or null
(unknown/unavailable). Missing fields are unknown. Source presence never hides
another source. Today retains monthly half-bar presentation and is excluded
from the complete-day year view.

Hosted IngestDB reads the already deployed
`uk_aq_public.uk_aq_rpc_observation_day_presence_v1(date,date)` through the
existing `SUPABASE_URL`, `SB_SECRET_KEY`, `UK_AQ_PUBLIC_SCHEMA` POST/auth/profile
helpers. No new environment settings or schema changes are required.
The Stage 1 RPC/migration are untouched.

The actual calendar's earliest through latest UTC dates are inspected.
Requests use inclusive/exclusive chunks of at most 366 days, including dates
older than one year; no historical cutoff is added. Every chunk must pass HTTP,
object/schema version, bounds, complete flag, exact count/order/coverage,
Boolean and UTC timestamp checks. Invalid/missing/duplicate dates, failed
requests or stale source timestamps make the entire IngestDB range unknown,
never all-false or continuously true. A boundary metric may select the range,
but cannot establish positive presence.

The common adapter covers direct compatibility and structured history routes.
Upstream mode applies it once after HTTP and service-binding enrichment.
Neither enrichment assigns IngestDB from retention metrics. Metrics bindings,
size panels, generation checks and Dropbox checkpoint authority remain enabled.
A complete published upstream snapshot retains its R2/Dropbox constraints:
HTTP enrichment skips it and binding enrichment does not undo its physical
intersection. Its original snapshot timestamp remains available.

Hosted ObsAQIDB observation flags use the existing
`uk_aq_obs_aqidb_day_counts_current` summary, already used by the local backend.
Only returned validated day counts produce Boolean flags; missing summary dates
are unknown. Its recorded source time is exposed; unavailable, malformed or
more-than-three-hour-old summaries do not become continuous-date positives.
This uses the existing ObsAQIDB connection, not IngestDB or local MySQL.

## Cache and failure semantics

IngestDB successful evidence is reused for at most five minutes, keyed by
source URL, schema, interface and exact requested range. The oldest chunk
timestamp is `ingest_coverage.checked_at_utc`; newest is
`checked_through_utc`. Failures have a short 30-second cooldown and null flags.
There is no silent stale fallback or success logging. IngestDB requests are
zero on a source-cache hit, otherwise ceil(requested dates / 366).
A continuously active single cache/range normally makes about 288 refreshes/day,
plus cold isolates, extra ranges and manual Refresh; no organisation-wide bound
or measured log-byte claim is made.

Ordinary browser timestamp query parameters bypass transport caches without
forcing the daily-source RPC. Explicit force/refresh/nocache controls bypass
source evidence caches. Refresh invalidates overlapping range evidence and
guards asynchronous cache publication against older completions. Whole payload
cache keys include the UTC date and selected history generation. Browser source
watermarks reject older evidence, label retained evidence stale, and preserve a
refreshed range when an older cached response omits dates.

Cloudflare caches and process caches are not globally coherent or globally
purged by this work. Source timestamps and browser guards make that limitation
explicit. The hosted dashboard remains independent of local MySQL.

The local backend retains its existing per-day IngestDB fingerprint checks and
inspection cadence. Failed dates become null and diagnostics remain visible.
The writer rejects failed, partial or non-Boolean storage candidates before
publishing, preserving the last successful MySQL snapshot and existing
request-correlated Refresh behaviour. No MySQL rebuild, schema change or data
cleanup is needed. The existing oldest-metric inspection boundary remains;
hosted/local comparisons must use comparable source times.

R2 committed days and configured successful physical-verification intersection
are preserved. A failed configured physical scan retains the permitted
committed API evidence with its warning; the failed refresh candidate cannot
replace the stored local snapshot. Generation-specific Dropbox checkpoint
identity and freshness/local-first/API-fallback behaviour remain intact.

## Retired calculated AQI

Calculated AQI fields, selectors, source indicators, legends and styles are
removed from calendar rows and its observation-count charts. ObsAQIDB
observations remain under the existing `obs_aqi_observs` field name.
Legacy `observs`/`r2` observation aliases remain locally where consumed.

The three old calendar patch assets were actually injected into generated
config.js by both hosted/local generators. Their wanted diagnostics are folded
into the inline implementation; their injection entries, generated copies and
obsolete source files are removed. Remaining generated configuration values and
unrelated patches are preserved; configuration was not regenerated from secrets.

Shared legacy v2 R2 overlap/window metrics and unrelated DB/schema/domain byte
trends still have active consumers and retain their compatibility handling.
Source-provided DAQI/index observations and station-chart AQI are outside this
calendar task and are untouched. Remaining legacy calendar field identifiers in
hosted enrichment are deletion/sanitation of old upstream payloads, not serving
or rendering of calculated AQI.

## Files and archives

Active implementation changes:

Exact active changed-file inventory (including the three removed assets):

```text
dashboard/index.html
dashboard/assets/config.js
dashboard/assets/storage_coverage_patch.js (removed)
dashboard/assets/storage_coverage_missing_r2_hotfix.js (removed)
dashboard/assets/storage_coverage_backup_only_style_patch.js (removed)
scripts/dashboard/generate_dashboard_config.mjs
local/scripts/run_dashboard.sh
local/dashboard/server/uk_aq_dashboard_api_core.py
local/dashboard/server/uk_aq_dashboard_api_patch.py
local/dashboard/server/uk_aq_dashboard_direct_r2_patch.py
local/dashboard/server/uk_aq_dashboard_cache.py
workers/uk_aq_dashboard_online_api_worker/src/lib/storage_day_presence.ts
workers/uk_aq_dashboard_online_api_worker/src/lib/direct.ts
workers/uk_aq_dashboard_online_api_worker/src/lib/r2_metrics_service.ts
workers/uk_aq_dashboard_online_api_worker/src/lib/storage_coverage_http_enrichment.ts
workers/uk_aq_dashboard_online_api_worker/src/routes/compat.ts
workers/uk_aq_dashboard_online_api_worker/src/routes/status.ts
workers/uk_aq_dashboard_online_api_worker/README.md
tests/dashboard_storage_coverage_dropbox_version.test.mjs
docs/handovers/2026-11-06-storage-coverage-calendar.md
```

- `workers/uk_aq_dashboard_online_api_worker/src/lib/storage_day_presence.ts`:
  strict chunk validator, authoritative tri-state results, bounded evidence cache.
- `.../src/lib/direct.ts`: established connection adapter, range construction,
  observation summary, cache integration and retired calendar field cleanup.
- `.../src/lib/r2_metrics_service.ts`, `.../src/lib/storage_coverage_http_enrichment.ts`:
  remove ingest inference/AQI calendar processing; retain independent diagnostics.
- `.../src/routes/compat.ts`, `.../src/routes/status.ts`: cover upstream and
  structured routes with the common semantics and source diagnostics.
- `dashboard/index.html`: independent month/year slots, null handling, tooltips,
  keyboard access, observation-only counts and freshness guards.
- `dashboard/assets/config.js`: remove generated obsolete calendar patches only.
- Three removed assets: `storage_coverage_patch.js`,
  `storage_coverage_missing_r2_hotfix.js`,
  `storage_coverage_backup_only_style_patch.js`.
- `scripts/dashboard/generate_dashboard_config.mjs`,
  `local/scripts/run_dashboard.sh`: remove obsolete patch injection.
- `local/dashboard/server/uk_aq_dashboard_api_core.py`,
  `uk_aq_dashboard_api_patch.py`, `uk_aq_dashboard_direct_r2_patch.py`,
  `uk_aq_dashboard_cache.py`: observation-only calendar and safe failed publication.
- `tests/dashboard_storage_coverage_dropbox_version.test.mjs`: remove assertions
  requiring retired Dropbox AQI response fields; retain existing safety checks.
- `workers/uk_aq_dashboard_online_api_worker/README.md`: update the observation
  flags, unknown semantics and removed calendar fields; link this handover.
- This handover.

Existing changed implementation sources were archived once under
`archive/2026-11-06/<relative path>`. Generated config and tests are not archived.
Archives are reference only, never runtime fallbacks. Unrelated pre-existing
Prune/history work is outside this change.

## Local structural verification

Run from the TEST Ops root:

```bash
npm --prefix workers/uk_aq_dashboard_online_api_worker run check
node --test tests/dashboard_storage_coverage_dropbox_version.test.mjs
node --check scripts/dashboard/generate_dashboard_config.mjs
node --check dashboard/assets/config.js
bash -n local/scripts/run_dashboard.sh
git diff --check
git status --short
```

The Worker type check and six existing generation/Dropbox checks pass.
The changed Python modules were compiled from source without starting services
or writing pycache. The actual inline JavaScript was syntax-parsed separately.
No broad suite, mock integration framework, remote functional test or database
operation was run. Syntax/type checks do not establish real operational acceptance.

## Separately authorised deployment and real TEST acceptance

1. Review the complete local diff and separately authorise source promotion and
   deployment. These uncommitted files are not deployed by GitHub workflows.
   Do not deploy an unrelated or partly reviewed TEST ref.
2. Stage 1 RPC is operator-confirmed deployed and accepted. This task adds no
   migration or secret. For a separately reviewed TEST ref available on GitHub,
   use the existing deployment workflows, API first, then Pages:

   ```bash
   gh workflow run uk_aq_ops_dashboard_api_worker_deploy.yml --repo TEST-uk-aq/uk-aq-ops --ref "$REVIEWED_TEST_REF"
   gh run list --repo TEST-uk-aq/uk-aq-ops --workflow uk_aq_ops_dashboard_api_worker_deploy.yml --limit 1
   ```

   Wait for and inspect that exact run's successful conclusion before:

   ```bash
   gh workflow run uk_aq_ops_dashboard_pages_deploy.yml --repo TEST-uk-aq/uk-aq-ops --ref "$REVIEWED_TEST_REF"
   gh run list --repo TEST-uk-aq/uk-aq-ops --workflow uk_aq_ops_dashboard_pages_deploy.yml --limit 1
   ```

   `REVIEWED_TEST_REF` is an operator shell placeholder, not a new application
   configuration variable. No history-provider redeploy is required.
3. For separately authorised local TEST activation, restart both existing TEST
   processes as required by the local-cache contract:

   ```bash
   launchctl kickstart -k "gui/$(id -u)/co.uk.chronicillnesschannel.aq.dashboard-cache.test"
   launchctl kickstart -k "gui/$(id -u)/co.uk.chronicillnesschannel.aq.dashboard.test"
   ```

   Do not rebuild MySQL. Verify the normal TEST refresher reports successful
   storage publication and that its source timestamp advances.
4. Open the protected hosted TEST Operations page. In the browser's authenticated
   same-origin developer console, make one explicit calendar refresh and inspect
   the returned source evidence:

   ```javascript
   const coverage = await fetch("/api/storage_coverage?force=1").then(r => {
     if (!r.ok) throw new Error("Coverage HTTP " + r.status);
     return r.json();
   });
   console.log(coverage.ingest_coverage, coverage.ingest_coverage_error);
   console.table(coverage.storage_coverage_days.filter(d =>
     ["2026-06-01", "2026-09-15", "2026-11-05", "2026-11-06"].includes(d.date)));
   console.table(coverage.storage_coverage_days.filter(d =>
     d.ingest === true && d.r2_observs === true).slice(-3));
   ```

   Expect source `uk_aq_rpc_observation_day_presence_v1`, status ok and a current
   source timestamp; June 1/September 15 false, November 5/6 true when observations
   remain present. Recheck against current source timestamps because pruning and
   inserts may legitimately change those results. Select one genuinely populated
   historical date and an actual overlapping date from current evidence, never
   invent a positive date. For execution after November 6, also inspect yesterday
   and today, not only these fixed comparison dates.
5. Use the shared UI Refresh button, then ordinary reloads: check source
   timestamps do not regress and the refreshed date range remains visible.
   Normal viewing must reuse source evidence within its five-minute lifetime.
   If no overlap exists in current data, record that real acceptance case as
   pending rather than manufacture observations or claim it passed.
6. On the protected local TEST page, use its existing Refresh button and await
   the correlated Updating → Refresh completion. Compare the same IngestDB dates
   at comparable hosted/local source times. Do not invoke the local refresh from
   a single long-lived console request; the UI uses the required short polling.
7. In both month and year modes, inspect the actual overlapping date, confirmed
   absence, recent complete day and current partial day. Confirm all independent
   sources appear, tooltips/keyboard focus identify them, four-slot legends
   match, navigation/mobile controls work, and no calculated AQI calendar or
   connector-count toggle remains. Confirm ObsAQIDB observations are preserved.
8. Compare generation, R2 presence and Dropbox checkpoint diagnostics before/after
   the IngestDB correction. A v2 legacy overlap metric may still exist outside
   the calendar; that is not an AQI calendar indicator.
9. If a failure occurs naturally, inspect explicit errors/null source markers,
   preserved independent flags, and retained stale MySQL snapshot/failed refresh
   state. Do not disrupt credentials, databases or services to induce a failure.

## Documentation handover and rollback

Chat-mode authoritative documentation updates belong in:

- `system_docs/dashboards/data_sources.md`: versioned RPC authority, four
  independent observation flags, true/false/null, no calculated AQI calendar.
- `system_docs/dashboards/hosted_dashboard.md`: shared chunked adapter, five-minute
  evidence timestamps, explicit-refresh/race handling and cache-scope limits.
- `system_docs/dashboards/local_dashboard.md` and `local_mysql_cache.md`: existing
  fingerprint delivery remains, failed candidate publication cannot overwrite a
  successful MySQL product, restart both processes after authorised activation.
- `system_docs/dashboards/architecture_contract.md`: shared four-source visual
  semantics and hosted/local delivery distinction, without changing authority.
- Schema-interface documentation should record Stage 1's operator-confirmed
  deployed acceptance separately from this Stage 2 implementation-only status.

Generation descriptor and Dropbox backup contracts are preserved, not rewritten.
Authoritative system docs were not edited.

Before deployment, rollback only this bounded working-tree change, preserving
unrelated work. After deployment, use a separately reviewed previous TEST
application revision and restart the local TEST processes if reverting Python.
No schema rollback, R2 mutation, MySQL rebuild or observation restoration is
required. Do not execute archived files or re-enable obsolete patch injection
alongside the new inline renderer; restore a coherent prior revision if needed.
