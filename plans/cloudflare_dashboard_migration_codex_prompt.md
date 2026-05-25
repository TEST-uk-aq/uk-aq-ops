# Codex Prompt: Investigate Moving UK AQ Dashboards to Cloudflare Pages + Separate API

You are working in the UK AQ ops repositories.

Repos:
- Test repo: https://github.com/ChronicChannel-test/uk-aq-ops
- Live repo: https://github.com/Chronic-Illness-Channel/uk-aq-ops

Current situation:
- The dashboard frontend appears to live under `dashboard/`.
- The current dashboard backend/API appears to live under `local/dashboard/server/`.
- The dashboard has been run from a local machine and exposed through a Cloudflare Tunnel.
- Test admin URL currently used: `https://cic-test-uk-aq-admin.chronicillnesschannel.co.uk/`
- The local machine needs to be avoided because it gets hot / needs to cool down.
- We do **not** want to move this to GCP if avoidable, because we are trying to avoid increased GCP cost.
- We want to investigate whether both the test and live dashboards can move to Cloudflare Pages for the frontend, with a separate Cloudflare-hosted API.

Important:
- Do **not** implement code changes yet.
- Do **not** change production/live behaviour.
- Do **not** delete or move existing files.
- This is an investigation and design task only.
- Please inspect the current code carefully before recommending anything.
- Please analyse Cloudflare costs carefully using current Cloudflare documentation/pricing, because cost avoidance is one of the main reasons for not using GCP.
- Please compare likely Cloudflare cost against the current local-machine + Cloudflare Tunnel setup and against a possible GCP Cloud Run setup, but the preferred direction is Cloudflare if technically sensible.
- Do not assume Cloudflare will be free; explicitly identify which plan/limits would apply and where paid features may be needed.

## Main question

Can the UK AQ admin dashboards, for both test and live, be moved to:

- Cloudflare Pages for static dashboard hosting
- A separate Cloudflare-hosted API layer, likely Cloudflare Workers / Pages Functions
- Existing custom admin hostnames, or equivalent Cloudflare-managed hostnames

without using GCP and without a large rewrite?

## Current architecture to investigate

Please inspect at least:

- `dashboard/`
- `dashboard/index.html`
- `dashboard/assets/config.js`
- `scripts/dashboard/`
- `local/dashboard/`
- `local/dashboard/README.md`
- `local/dashboard/server/`
- `local/dashboard/server/uk_aq_dashboard_api.py`
- `local/scripts/run_dashboard.sh`
- any dashboard-related GitHub Actions workflows, including archived ones
- any docs/plans/archive entries related to dashboard hosting, Cloudflare, Cloud Run, Pages, Workers, or tunnels
- any Cloudflare Worker/API code already present in the repo that could be reused
- any config/env docs that describe dashboard API secrets, URLs, tokens, or deployment

## Specific things to inventory

Create an inventory of dashboard frontend and API functionality.

For the frontend:
- What files make up the dashboard?
- Is it pure static HTML/CSS/JS?
- How is `dashboard/assets/config.js` generated?
- What API base URL does it expect?
- Does it assume same-origin `/api`?
- Would it work unchanged on Cloudflare Pages if the API existed at `/api/*`?
- Would test and live need separate builds/configs?

For the API:
- List every current API endpoint exposed by the local Python dashboard backend.
- For each endpoint, identify:
  - Route/path
  - Purpose
  - Data sources used
  - Required secrets/env vars
  - Whether it calls Supabase REST/RPC
  - Whether it calls Dropbox APIs
  - Whether it calls Cloudflare/R2 GraphQL APIs
  - Whether it calls existing UK AQ APIs
  - Whether it reads local filesystem / local Dropbox folders
  - Whether it uses Python-only libraries or normal HTTP fetches
  - Expected response size and frequency
  - Caching behaviour
  - Whether it is easy, medium, or hard to port to Cloudflare Workers
- Identify any API endpoints that cannot realistically run on Workers without redesign.

## Cloudflare hosting options to analyse

Please analyse these options at minimum.

### Option A — Cloudflare Pages frontend + Cloudflare Pages Functions API

- Static frontend deployed to Cloudflare Pages.
- API routes implemented as Pages Functions under `/api/*`.
- Test and live as separate Pages projects or separate branches/environments.

Assess:
- Fit for current dashboard.
- Required changes.
- Secret handling.
- Environment separation.
- Custom domain support.
- Limits and cost.
- Pros / cons / failure modes.
- Whether this is simpler than Workers static assets.

### Option B — Cloudflare Pages frontend + separate Cloudflare Worker API

- Static frontend deployed to Pages.
- Dedicated Worker handles `api.<domain>` or `/api/*`.
- Pages config points frontend at that API.

Assess:
- Fit for current dashboard.
- CORS implications if API is not same-origin.
- Whether same-origin routing can be achieved through Cloudflare routes.
- Secret handling.
- Environment separation.
- Limits and cost.
- Pros / cons / failure modes.

### Option C — Single Cloudflare Worker serving static assets and API

- Worker serves dashboard static assets.
- Same Worker handles `/api/*`.
- Static assets may be deployed using Workers static assets if suitable.

Assess:
- Fit for current dashboard.
- Whether this reduces routing/config complexity.
- Whether it makes test/live deployment easier or harder.
- Limits and cost.
- Pros / cons / failure modes.

### Option D — Keep frontend in existing repo, split API into new Cloudflare Worker repo

- Dashboard frontend stays where it is initially.
- API is ported into a new dedicated repo.
- Later optional split of frontend too.

Assess:
- Whether this is a sensible low-risk migration path.
- How to avoid repo sprawl.
- How to manage shared config for test/live.
- Pros / cons / failure modes.

### Option E — New dedicated dashboard repo

- Create a new repo just for the admin dashboard.
- Could include both Pages frontend and Worker/Functions API.
- Existing repo remains source/reference until migrated.

Assess:
- Whether this would be simpler operationally.
- Whether moving code now creates unnecessary risk.
- How to keep test/live deployment clean.
- Pros / cons / failure modes.

## Cost analysis requirements

Please analyse Cloudflare costs carefully and explicitly.

Include:
- Cloudflare Pages limits and pricing relevant to this dashboard.
- Cloudflare Workers limits and pricing relevant to this dashboard.
- Pages Functions pricing/limits if different.
- Worker request volume assumptions for a low-use private admin dashboard.
- CPU time / duration limits and whether any endpoints might exceed them.
- Subrequest limits and whether API endpoints may exceed them.
- Environment variable / secret limits.
- Static asset limits/build minutes/deployment limits.
- Custom domain costs/requirements.
- Cloudflare Access costs if it is recommended for protecting the admin dashboard.
- Whether the dashboard can likely stay on free-tier Cloudflare.
- What usage patterns would push it into a paid Cloudflare plan.
- Whether Workers Paid is likely needed.
- Any R2/Cloudflare GraphQL/API cost implications.
- Any hidden costs or operational limits.

Also compare against:
- Existing local machine + Cloudflare Tunnel approach.
- Possible GCP Cloud Run backend approach, but only as a reference point. We do not want GCP if Cloudflare is viable due to cost.

## Security/auth requirements

The dashboard is an admin dashboard and should not become publicly accessible.

Please analyse:
- Whether Cloudflare Access should protect the dashboard.
- Whether existing Cloudflare Zero Trust setup can be reused.
- How test and live should be protected separately.
- How secrets should be stored in Cloudflare.
- Whether any currently server-side secrets would accidentally move into frontend JS.
- CORS risks if frontend and API are split.
- Whether API should require a bearer token, Access JWT, same-origin only, or another control.
- Whether browser clients should ever see Supabase service-role keys, Dropbox tokens, Cloudflare API tokens, or other private credentials. The expected answer is no, but analyse code paths to confirm.

## Test/live deployment design

Please recommend how to manage both dashboards:

- Test dashboard
- Live dashboard

Questions:
1. Should test and live be separate Cloudflare Pages projects?
2. Should test and live be separate Workers?
3. Should test/live be separate environments of one Worker/Pages project?
4. Should they use separate custom hostnames?
5. How should config generation work for test/live?
6. How should secrets be separated?
7. How should deployments be triggered from GitHub?
8. Is a new dashboard repo beneficial, or should this stay in `uk-aq-ops` initially?

## Migration approach

Please propose a phased migration plan.

A possible outline:

### Phase 0 — Inventory and feasibility
- Inventory current frontend/API/routes/secrets.
- Identify hard blockers.
- Identify Cloudflare limits/cost risks.

### Phase 1 — Static frontend proof of concept
- Deploy the existing `dashboard/` to Cloudflare Pages.
- Keep API pointing at the existing local/tunnel backend temporarily if needed.
- Confirm frontend routing/assets/config work.

### Phase 2 — Minimal Cloudflare API proof of concept
- Port a small subset of low-risk API endpoints to Workers/Pages Functions.
- Use proper Cloudflare secrets.
- Protect with Cloudflare Access or equivalent.
- Confirm same-origin `/api/*` routing.

### Phase 3 — Full API port
- Port remaining endpoints.
- Add caching where needed.
- Remove local-only filesystem dependencies or replace them with HTTP/API sources.
- Ensure test/live environment separation.

### Phase 4 — Cutover
- Point `cic-test-uk-aq-admin.chronicillnesschannel.co.uk` to Cloudflare-hosted dashboard/API.
- Then plan live cutover separately.
- Keep rollback path to local tunnel until stable.

Please refine this plan based on actual code findings.

## Key questions to answer

1. Is Cloudflare Pages + separate Cloudflare API technically viable for this dashboard?
2. Which API endpoints are easy to port?
3. Which API endpoints are hard or risky to port?
4. Is Pages Functions or a separate Worker better here?
5. Should static frontend and API live in the same Cloudflare project or separate ones?
6. Should we create a new dashboard repo?
7. What is the expected Cloudflare monthly cost for low-use test/live admin dashboards?
8. What usage or feature requirements would increase Cloudflare cost?
9. Would Cloudflare Access be needed, and would it add cost?
10. What would be the safest low-effort first step?
11. What files would likely need changing in a later implementation?
12. What secrets/env vars need to be created in Cloudflare?
13. Which local-machine assumptions need removing?
14. Are there any existing retired dashboard deployment workflows/docs that can be reused?
15. What should not be migrated yet?

## Deliverables

Please produce a Markdown investigation report containing:

1. Executive summary.
2. Current dashboard architecture.
3. Frontend inventory.
4. API endpoint inventory.
5. Data source and secret inventory.
6. Cloudflare hosting options.
7. Cloudflare cost analysis.
8. Security/auth analysis.
9. Test/live deployment recommendation.
10. Migration phases.
11. Risks and blockers.
12. Clear recommendation.
13. A list of files that would likely change in a future implementation.
14. A list of information still needed from Cloudflare/GitHub/local env before implementation.

Do not implement changes yet.
