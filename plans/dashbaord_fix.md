Please investigate and fix why the hosted online UK AQ dashboard at ukaq.co.uk / uk-aq-admin.ukaq.co.uk is not updating the Dispatcher Feed consistently, while the local dashboard is working correctly.

Do not archive files for this task. Make a targeted fix.

Context:

The dashboard frontend lives in:

text dashboard/index.html 

The hosted online API appears to live in the Cloudflare Worker:

text workers/uk_aq_dashboard_online_api_worker 

The Worker README says this is the Cloudflare Worker API for the hosted dashboard and preserves the existing /api/* contract used by the local UI.

Relevant online Worker files to inspect:

text workers/uk_aq_dashboard_online_api_worker/README.md workers/uk_aq_dashboard_online_api_worker/src/routes/status.ts workers/uk_aq_dashboard_online_api_worker/src/lib/direct.ts workers/uk_aq_dashboard_online_api_worker/src/index.ts workers/uk_aq_dashboard_online_api_worker/wrangler.toml 

Also inspect the local dashboard backend for parity:

text local/dashboard/server/uk_aq_dashboard_api.py 

Problem observed:

The local dashboard correctly shows recent Dispatcher Feed rows. Example from the local dashboard:

- Sensor.Community updated around 03/06/2026 18:18:09
- SOS updated around 03/06/2026 18:15:19
- Sensor.Community previous run around 03/06/2026 18:12:11

The hosted online dashboard does not show the same rows consistently. It sometimes shows only SOS, and sometimes only Sensor.Community, even when the lookback should include both. This suggests the online dashboard API is either using the wrong Supabase project, returning stale cached data, or not applying the Dispatcher Feed lookback/filter logic the same way as local.

Key things already seen in the code:

- dashboard/index.html has Dispatcher Feed filter state:
  - DISPATCH_CONNECTOR_OPTIONS
  - DISPATCH_LOOKBACK_OPTIONS
  - dispatchConnectorFilter
  - dispatchLookbackMinutes
  - dispatchCursor
- workers/uk_aq_dashboard_online_api_worker/src/routes/status.ts exposes:
  - /api/status/feeds
  - /api/status/history
  - /api/status/summary
- workers/uk_aq_dashboard_online_api_worker/src/lib/direct.ts builds direct dashboard payloads from Supabase.
- direct.ts has DASHBOARD_TTL_MS = 20_000.
- The Worker README says /api/dashboard is edge cached for 60 seconds, and that ?force=1, refresh=1, nocache=1, t=..., or ts=... should bypass cache.

Goal:

Make the hosted online dashboard show Dispatcher Feed rows with the same freshness and logic as the local dashboard.

Tasks:

1. Confirm which online route the frontend uses for Dispatcher Feed

   Inspect dashboard/index.html and determine whether Dispatcher Feed data comes from:

   - /api/dashboard
   - /api/status/feeds
   - /api/history/runs
   - another route

   Find the function that builds the API URL and confirm whether it includes:

   - connector filter
   - lookback minutes
   - dispatch cursor
   - cache buster or force refresh when appropriate

2. Compare local and online API logic

   Compare:

   text    local/dashboard/server/uk_aq_dashboard_api.py    

   with:

   text    workers/uk_aq_dashboard_online_api_worker/src/lib/direct.ts    

   Specifically compare the Dispatcher Feed query against uk_aq_ingest_runs.

   Check:

   - which Supabase URL is used
   - which schema is used
   - selected columns
   - date window / lookback window
   - ordering
   - limit
   - cursor logic
   - connector filter logic
   - handling of in-flight runs
   - whether rows are filtered client-side or server-side

3. Check for project/environment mismatch

   Verify that the hosted Worker is using the intended Supabase project for the dashboard being viewed.

   Inspect:

   text    wrangler.toml    

   and any docs or deploy scripts for:

   - SUPABASE_URL
   - SB_SECRET_KEY
   - OBS_AQIDB_SUPABASE_URL
   - DASHBOARD_UPSTREAM_BASE_URL
   - environment names such as live, test, cic-test, preview, production

   Add a safe diagnostic to the API response if useful:

   - project ref
   - generated_at
   - API mode, such as direct or upstream
   - cache status if available

   Do not expose secrets.

4. Check caching

   The hosted Worker may have multiple cache layers:

   - browser cache
   - Worker edge cache
   - Worker in-memory cache using DASHBOARD_TTL_MS
   - frontend local/session storage for filters and cursor

   Ensure Dispatcher Feed refreshes are not blocked by stale Worker cache.

   If the frontend is polling or manually refreshing Dispatcher Feed, ensure the request includes a cache buster, for example t=Date.now(), or force=1 when the user clicks Refresh.

   If /api/status/feeds is intended for live monitoring, consider excluding it from edge caching or giving it a very short TTL.

   Do not remove useful caching for heavyweight operations panels unless needed. Keep the change targeted to Dispatcher Feed freshness.

5. Fix lookback/filter handling

   Ensure the hosted API returns all Dispatcher Feed rows within the selected lookback window.

   The online Worker currently appears to use a hard-coded dispatcher fetch window in direct.ts:

   text    dispatchWindowMinutes = 240    

   Confirm whether the frontend’s selected lookback value is applied before render. If the frontend filters rows after receiving the full 240 minute set, make sure the online response includes enough fresh rows and does not rely on an old dispatchCursor.

   Check whether dispatchCursor from localStorage can accidentally cause the hosted dashboard to fetch only runs after an old cursor, or skip rows in the visible lookback window. If so, make cursor use safe:

   - do not let an old cursor override the selected lookback on a full dashboard load
   - reset or ignore cursor when lookback or connector filter changes
   - always include enough rows for the selected lookback window
   - do not persist a cursor that causes missing recent runs

6. Add a small online/local parity diagnostic

   Add or improve a simple diagnostic route or debug output that can confirm the hosted Worker sees the same latest uk_aq_ingest_runs rows as local.

   This could be a temporary or permanent safe endpoint such as:

   text    /api/status/feeds?lookback_mins=60&connector=all&force=1    

   It should return enough metadata to debug freshness:

   - generated_at
   - project_ref
   - dispatch_runs_count
   - newest run timestamp
   - oldest returned run timestamp
   - dispatch_cursor if used

   Do not expose service keys or secrets.

7. Tests and checks

   Add or update focused tests where the repo already has a test setup.

   At minimum, run the Worker checks:

   bash    cd workers/uk_aq_dashboard_online_api_worker    npm install    npm run check    

   Also run any existing dashboard/local API tests if present.

8. Deployment notes

   After fixing, output clear deployment instructions.

   Include:

   bash    cd workers/uk_aq_dashboard_online_api_worker    npx wrangler deploy    

   Also state whether any Cloudflare Worker environment variables need to be checked or changed in the dashboard.

Expected outcome:

- Online Dispatcher Feed shows the same recent rows as local for the same connector and lookback.
- Refresh actually fetches fresh Dispatcher Feed data.
- Cache does not hide recent dispatcher runs.
- Wrong Supabase project/environment is detected if that is the cause.
- No secrets are exposed.
- Changes are limited to the dashboard frontend and/or online dashboard Worker.