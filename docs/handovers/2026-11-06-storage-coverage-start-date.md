# Storage calendar committed-R2 start date — TEST handover

Status: local implementation and structural validation only, 6 November 2026.
All changes are uncommitted. No commit, push, PR, deploy, restart, database
operation or LIVE inspection/change was performed.

## Implementation and files

- `workers/uk_aq_dashboard_online_api_worker/src/lib/direct.ts`: calendar starts
  at the minimum validated `r2History.daySets.observations` date and ends on the
  current UTC day, inclusive. IngestDB/ObsAQIDB metrics, Dropbox dates and the
  90-day default no longer participate. All intervening UTC dates remain, even
  where R2 is absent. ObsAQIDB queries use only this range. Its summary read has
  a 15-second deadline and bounded source-specific failure diagnostics;
  missing summary dates stay null and now have an explicit completeness warning.
- `workers/uk_aq_dashboard_online_api_worker/src/lib/storage_day_presence.ts`:
  bounded diagnostics distinguish HTTP/authentication, timeout, invalid RPC,
  stale source timestamps and incomplete source dates. The authoritative RPC,
  366-day maximum per request, exact response validation, five-minute successful
  evidence cache, source/range identity and refresh revision guards remain.
- `workers/uk_aq_dashboard_online_api_worker/src/lib/r2_metrics_service.ts` and
  `storage_coverage_http_enrichment.ts`: do not enrich an unavailable empty
  calendar into apparent success or erase its range error. Nonempty-calendar
  independent-source enrichment remains unchanged.
- `local/dashboard/server/uk_aq_dashboard_api_core.py`: same committed-R2 UTC
  boundary; local IngestDB fingerprints and ObsAQIDB summary/fingerprint fallback
  reads are constrained to that range. Summary pages are bounded by the chosen
  range; malformed, duplicate, out-of-range or incomplete summary dates cannot
  become confirmed absence through the summary path. Missing/invalid committed
  R2 evidence raises before database day checks or in-memory calendar publication.
  The R2 API observation-day array is required and strictly checked rather than
  silently dropping malformed/duplicate/future dates.
- `local/dashboard/server/uk_aq_dashboard_direct_r2_patch.py`: keeps the original
  committed API observation set separately as `committed_observations` before
  physical intersection. Only that set chooses the range; physical verification
  continues to constrain R2 presence. A physical scan cannot move the first date.
- `local/dashboard/server/uk_aq_dashboard_api_patch.py`: the installed local
  fingerprint adapter receives the committed start date directly. Its per-day
  checks/partial-failure diagnostics remain; an empty candidate is not complete.
- `dashboard/index.html`: an unavailable/empty range uses the existing error/retry
  panel. Browser retention of newer source evidence cannot recreate dates outside
  an incoming authoritative range. Three visual positions, orange Dropbox badge,
  tooltips, navigation and Refresh controls are otherwise unchanged.
- This handover records deployment, validation and documentation requirements.

Today's existing archives were reused unchanged. The newly in-scope
`storage_day_presence.ts` was archived once under its relative path in
`archive/2026-11-06/`. Archives are reference only. `dashboard/assets/config.js`
was not changed; its bytes and existing archive bytes were checked against the
pre-change baseline. No schema, credentials, endpoints or environment settings
were added or changed. No authoritative system documentation was edited.

## Range, errors and cache implications

Both backends use the canonical stable-service generation descriptor and its
matching history-days result. The range is only a presentation/query boundary;
it does not establish database presence. IngestDB and R2 can both be true, or
either can be independently false/unknown. Dropbox checkpoint generation and
freshness checks, local physical R2 rules and retired calculated-AQI removal
remain in place.

Unavailable, empty, malformed or future-dated committed R2 observation evidence
cannot select another generation, a database metric, Dropbox date or lookback.
Hosted responses have no calendar rows and retain an explicit R2 range/source
error. No IngestDB presence or ObsAQIDB summary request is made for that empty
range. Other existing metric reads are unaffected. Local range failure aborts
before day checks. The existing writer failure path records the failed attempt
without replacing the last successful MySQL payload/timestamps or marking the
manual Refresh request successful. No MySQL rebuild, clear, migration, permission
change or Refresh-correlation change is required.

For N selected calendar dates, an uncached hosted IngestDB read uses
`ceil(N / 366)` sequential RPC calls, each retaining its existing 15-second
deadline; 2,502 dates previously required seven. Successful evidence is cached
for at most five minutes from the oldest source check; failures retain the
existing 30-second cooldown. Explicit Refresh invalidates source evidence;
ordinary browser timestamp cache-busting does not. The actual minimum R2 date
and real request count have not been read from deployed TEST in this task.

The excessive range increases request count and cumulative latency. No evidence
from this local-only work proves it caused the reported IngestDB error. The
checked-in RPC JSON contract matches the strict consumer; no validation was
weakened. After deployment, the bounded error identifies whether auth/HTTP,
timeout, malformed/incomplete RPC data or source timestamp freshness still fails.

The ObsAQIDB check compares `recorded_at`, not historical `day_utc`, against the
existing three-hour freshness limit. The checked-in current observation-only
producer (`zz_2026-07-29_retire_persisted_aqilevels.sql` in TEST Schema) refreshes
`recorded_at` on every retained row on successful reconciliation. Thus an old
observation date is valid with current source evidence; old source timestamps
remain unavailable. There is no proven separate freshness defect warranting
replacement of this authority with the newest row's timestamp. Shortening the
range cannot repair a stale/failed producer, missing rows, or failed auth.
Incomplete returned summaries retain valid daily flags and explicitly identify
missing dates. If deployed producer semantics differ from the checked-in full
refresh, inspect that producer and its success watermark before changing the
consumer freshness rule; do not simply accept all historical rows via `max()`.

## Structural validation performed

- `npm --prefix workers/uk_aq_dashboard_online_api_worker run check` passed.
- Python AST syntax parsing passed for the three changed Python modules.
- Inline dashboard JavaScript parsed successfully; three-position layout remains.
- A small, nonpersistent check of the actual hosted/local range builders verified
  first/last UTC dates across midnight and an offset timezone, continuous date
  enumeration through R2 gaps, independent IngestDB flags, and failure on missing
  R2 boundary evidence. It also verified that a physical intersection removing
  the earliest committed day does not move the local start.
- `git diff --check` passed; configuration/archive hashes and Git status checked.

No speculative test suite was added. Real source, browser, cache-publication and
manual Refresh acceptance remain post-deployment work.

## Separately authorised TEST deployment

These are operator instructions, not operations performed by this task.
The workflows deploy a Git ref, not an uncommitted local working tree. First
review the diff and separately authorise getting the intended changes onto an
approved TEST ref; no Git operation is authorised or performed here. Then run
from the TEST Ops checkout, substituting that reviewed ref:

```bash
calendar_test_ref='<approved-TEST-ref-containing-these-changes>'
gh workflow run uk_aq_ops_dashboard_api_worker_deploy.yml \
  --repo TEST-uk-aq/uk-aq-ops --ref "$calendar_test_ref"
gh run list --repo TEST-uk-aq/uk-aq-ops \
  --workflow uk_aq_ops_dashboard_api_worker_deploy.yml --limit 1
gh run watch <API-run-id> --repo TEST-uk-aq/uk-aq-ops --exit-status
```

After API success, deploy the shared frontend from the same ref:

```bash
gh workflow run uk_aq_ops_dashboard_pages_deploy.yml \
  --repo TEST-uk-aq/uk-aq-ops --ref "$calendar_test_ref"
gh run list --repo TEST-uk-aq/uk-aq-ops \
  --workflow uk_aq_ops_dashboard_pages_deploy.yml --limit 1
gh run watch <Pages-run-id> --repo TEST-uk-aq/uk-aq-ops --exit-status
```

No observations-history provider or schema deployment is needed for this change.
For the local dashboard, ensure the installed TEST processes use this updated
checkout, then restart both already-installed TEST processes:

```bash
launchctl kickstart -k "gui/$(id -u)/uk.co.ukaq.dashboard-cache.test"
launchctl kickstart -k "gui/$(id -u)/uk.co.ukaq.dashboard.test"
```

These exact labels were confirmed by a read-only `launchctl list` during this
task. The older `co.uk.chronicillnesschannel...` templates/examples do not identify
the installed processes. Do not install duplicate agents or restart the Tunnel.

## Minimum real TEST acceptance

1. Open hosted TEST `/ops` through Access and the existing local TEST Operations
   page. Press calendar Refresh on each; wait for each exact request to finish.
   Inspect each `/api/storage_coverage` response in the browser Network panel.
2. Compare `r2_history_read_version.version`, first/last row dates and row count.
   First must equal the minimum of `domains.observations.days` from the matching
   generation-selected history-days response; both calendars must agree. Last
   must be current UTC day and rows must enumerate every date through gaps.
   Neither should unexpectedly start in 2020. A 2020 start is valid only if the
   selected committed R2 observation set actually contains that earliest date.
3. Hosted `ingest_coverage.status` must be `ok`; `from_day_utc` must equal the
   first calendar date, and `to_day_utc_exclusive` must be tomorrow UTC. Check
   `checked_at_utc`/expiry and absence of `ingest_coverage_error`. Confirm at most
   366 days per RPC from safe existing telemetry if request tracing is needed.
4. If in range, 1 June and 15 September 2026 must have independently confirmed
   IngestDB absence as specified by the operator. An overlapping IngestDB/R2 day
   must show both red and orange, including when Dropbox backup is also present.
5. ObsAQIDB returned zero/nonzero rows must produce false/true respectively;
   naturally missing or stale evidence remains unknown with its bounded reason.
   No unwarranted historical unknowns should remain. If it still fails, use the
   reported category to investigate the existing TEST summary producer's last
   successful refresh, source stamps, coverage bounds/completeness or auth path.
   A schema/producer architecture change needs a separate bounded follow-up.
6. In month and year views retain exactly three visual positions. Check R2 gaps,
   independent blue/red markers, R2-only/backup-badged/backup-only orange states,
   tooltips, navigation, current-day treatment and Refresh responsiveness.
7. On a naturally failed or separately authorised controlled local rebuild,
   confirm the previous successful MySQL calendar payload and success/freshness
   timestamps remain unchanged, failure metadata advances, the correlated request
   fails and the visible prior calendar remains. Do not clear/rebuild MySQL.
8. After a successful explicit Refresh, source timestamps advance and subsequent
   ordinary loads do not restore older evidence or dates before the new boundary.

## Documentation handover and rollback

Chat-mode system-doc owner: update the dashboard data-source/local-cache contracts
with the committed-R2-only calendar/query boundary, preservation of raw committed
boundary across physical intersection, missing-range behaviour and bounded
source diagnostics. Replace the older Stage 2 handover's statement that oldest
metrics may choose the range. Also reconcile installed TEST cache-agent restart
labels in the older local-cache documentation with the observed `uk.co.ukaq...`
labels. There are no schema/configuration changes or LIVE acceptance claims.

Before deployment, reverse only this task's reviewed local diff, preserving all
Stage 2 backend fixes, three-position presentation and unrelated edits. Today's
archive can predate Stage 2; do not wholesale-copy it over active files. After
separately authorised deployment, restore the prior approved TEST API/Pages
release and the matching local code, then restart both installed TEST processes.
Existing successful MySQL snapshots remain available; no data rollback or schema
migration is needed. Reverting the boundary correction restores the old excessive
range, so retain the failure diagnostics if practical in a bounded follow-up.
