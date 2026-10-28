# Accounts & Subscriptions TEST repair handover

Implementation baseline: TEST Ops `main` at `106469b2` (query-string redaction).
No deployment, SQL, migration, remote setting, subscriber mutation, queue operation
or LIVE change was performed. Functional acceptance remains pending.

## Findings and changes

- **Hosted 502:** both subscriptions and delivery reads used `redirect: 'error'`.
  Cloudflare Workers supports `manual`/`follow`; the existing Media contract also
  records this runtime limitation. This is a confirmed code defect that can fail
  before Supabase receives an RPC. Both reads now use `manual` and reject every
  non-2xx response, including redirects, without forwarding credentials elsewhere.
  It still takes real TEST operation to establish whether this was the sole cause
  of the reported 502; no deployed request or log investigation was performed here.
- **Local 503:** hostname discovery excluded `http://localhost:<listener-port>`.
  It now accepts `localhost` alongside the existing two loopback literals. The Mac's
  installed config/dependencies were unavailable, so this is a compatibility fix,
  not a confirmed diagnosis of that operator's 503. Missing PyYAML, missing/invalid
  YAML, no matching port or multiple matches remain separate possible causes.
- **Tunnel mechanism:** the supported `local/scripts/run_cloudflared.sh` explicitly
  runs `tunnel --config "$HOME/.cloudflared/config.yml" run`. Reading that same file
  is compatible with the established deployment. A token-only remotely managed
  Tunnel, custom config path, or multiple ingress hostnames on one listener does
  not supply the unique trusted hostname through this mechanism. It remains
  unsupported/fail-closed; do not fabricate a YAML file disconnected from the
  running Tunnel, guess a hostname or trust Host/JWT claims. If the operator
  actually uses one of these arrangements, a separately agreed trusted existing
  configuration source is still needed. No new setting was introduced.
- **Media delivery:** inspected TEST Media `main` at `45a5308`, its README and
  `apps/media-admin/src/news-email-delivery.ts`. Both backends use the existing
  URL/token and authenticated `GET /admin/news-email/delivery`. Its documented
  `{available, summary, deliveries, outbox, pagination, window_days}` shape,
  boolean `retry_hold`, state/transport/error projections and pagination match
  both backends. The handler performs bounded D1 SELECTs only and never sends or
  enqueues email. No Media code/migration change is justified. Hosted transport,
  HTTP, parsing and validation failures now consistently return explicit
  `EMAIL_DELIVERY_UNAVAILABLE` (503); the local backend already rejects failures
  rather than returning an empty success.

Active files changed:

| File | Purpose |
| --- | --- |
| `workers/uk_aq_dashboard_online_api_worker/src/lib/direct.ts` | Correct Accounts RPC redirect mode; stage request creation, fetch, HTTP rejection and JSON parsing. Other direct adapters are unchanged. |
| `workers/uk_aq_dashboard_online_api_worker/src/lib/accounts_diagnostics.ts` | Accounts-only fixed diagnostic codes and shared 512 KiB bounded JSON reader; discards upstream exception text. |
| `workers/uk_aq_dashboard_online_api_worker/src/routes/accounts.ts` | Correct Media redirect mode; log configuration/response validation failures; preserve private browser envelopes and field projections. |
| `local/dashboard/server/uk_aq_dashboard_accounts_auth.py` | Accept configured localhost ingress and distinguish dependency/configuration/session failures in safe stderr diagnostics. |

The dated pre-change copies of routes/accounts.ts and the Python auth file are in
`archive/2026-10-28/` with their relative paths. The existing same-day direct.ts
archive is reused, as required; Git baseline `106469b2` is the exact immediate
pre-change source. Archives are reference-only and never execution paths.

## Request and privacy boundaries retained

Hosted Accounts routing runs before OPTIONS, compatibility caches and upstream
proxying. Cloudflare's trusted `ctx.access.getIdentity()` must provide a personal
identity; missing context and service-token-only identities remain denied. Local
authentication still sends the assertion to the configured application's HTTPS
get-identity endpoint with redirects disabled and validates a personal identity;
direct localhost gets no exemption. Neither backend trusts caller Host or decoded
unverified identity claims.

Subscriptions keep the existing HTTPS project-root `SUPABASE_URL`, `SB_SECRET_KEY`
and `UK_AQ_PUBLIC_SCHEMA`. The shared header builder still sets apikey and Bearer
authorization, plus Accept-Profile and Content-Profile for the RPC POST. The
bounded filters are in JSON `p_query`, not the Supabase URL. No evidence establishes
a key/schema/SQL defect; do not repeat either already successful migration.
Unexpected response shape, counts, fields or pagination are rejected. Only
allowlisted projections reach the browser. All Accounts replies retain no-store;
subscriber reads do not enter shared edge/MySQL caches or service-egress telemetry.

Normal/peak request counts are unchanged: one RPC per subscription list/detail
read and one Media GET per delivery read, on demand, with no new polling, retries,
success logs or Supabase diagnostic writes. The new failure event goes to Worker
logs or local stderr only, so it adds no Supabase requests/log ingestion.

## Configuration and structural validation

No new secrets, variables, dependencies, permission grants or workflow settings.
Retain existing query-string redaction and existing five backend settings named in
the task. PyYAML is already in `local/dashboard/server/requirements.txt`; an older
installed virtual environment may still need that existing requirements file.

Checks completed: Worker `npm run check` (`tsc --noEmit`); Python AST syntax parsing;
Wrangler TOML parsing with observability and query-string-redaction assertions;
`git diff --check`; bounded source review of routing, schema headers, auth,
projections and the TEST Media read endpoint. No functional tests, fixtures or new
test suite were created. These checks do not prove deployed success.

## Separately authorised TEST deployment

The exact existing Worker workflow is
`.github/workflows/uk_aq_ops_dashboard_api_worker_deploy.yml`
(**Deploy UK AQ Ops Dashboard API Worker**). After review and explicit deployment
authorisation, the operator can deploy this PR branch without merging:

```bash
gh workflow run uk_aq_ops_dashboard_api_worker_deploy.yml \
  --repo TEST-uk-aq/uk-aq-ops --ref codex/accounts-dashboard-repair
```

Review its deployment result and resolved Wrangler version. No Pages, Media or
observations-history redeployment is required for this change. Alternatively the
existing orchestrator can select only dashboard API (observations-history=false).
**Merging these Worker paths into main triggers that orchestrator automatically**;
merge must therefore wait for separate deployment authorisation too. This task
neither runs a workflow nor merges the PR.

## Local TEST update and setup

Run only from the operator's TEST Ops checkout, as the same macOS user that runs
the TEST dashboard/Tunnel. Preserve its `.env`, virtual environment and installed
Tunnel configuration; do not copy LIVE settings. With a clean checkout:

```bash
git fetch origin
git switch codex/accounts-dashboard-repair
git pull --ff-only
.venv/bin/python3 -m pip install -r local/dashboard/server/requirements.txt
.venv/bin/python3 -c 'import requests, yaml; print("Dashboard dependencies available")'
test -r "$HOME/.cloudflared/config.yml"
cloudflared tunnel --config "$HOME/.cloudflared/config.yml" ingress validate
launchctl kickstart -k "gui/$(id -u)/co.uk.chronicillnesschannel.aq.dashboard.test"
```

For an already reviewed/merged release, use its approved main revision instead.
For a foreground TEST server, stop only its existing process and start
`local/scripts/run_dashboard.sh` from the TEST checkout instead of kickstart.
The script loads the existing `.env`; verify its TEST PORT (default 8000) matches
the installed ingress's explicit HTTP loopback port. Exactly one valid protected
hostname must map to that port; configure TEST and LIVE on their separate ports.
The config must be readable by the dashboard service user, not just an interactive
shell. Do not print `.env`, the YAML credential contents or Access assertions.

If the installed YAML is absent, establish which Tunnel mechanism is actually
running before changing anything. For the established locally managed mechanism,
restore the operator's real installed configuration and its existing credentials
at the runner's documented path; never copy the placeholder repository template
over a real shared Tunnel. Do not restart/reconfigure the shared Tunnel as part of
an ordinary dashboard restart. Remote-managed/custom-path setups remain a concrete
configuration blocker requiring a separate agreed solution.

## Reading diagnostics

In Cloudflare, select the TEST dashboard API Worker and open its Observability
logs. Perform one authorised failed read, then inspect the console JSON event
`accounts_read_failed`. It contains only `code` and, for HTTP rejection,
`upstream_status`. Codes are fixed `SUPABASE_` or `MEDIA_ADMIN_` plus
`CONFIGURATION`, `REQUEST_CONSTRUCTION`, `FETCH`, `HTTP_REJECTED`, `RESPONSE_PARSE`
or `RESPONSE_VALIDATION`. A fetch code means no HTTP response was available;
an HTTP code supplies its status; parsing includes body-read/size/JSON failures.
Do not enable raw request/response or credential logging to diagnose these codes.
Browser errors deliberately do not reveal these details.

For the existing TEST LaunchAgent:

```bash
tail -f logs/dashboard_test.log | grep accounts_access_failed
```

| Local diagnostic code | Meaning / safe next step |
| --- | --- |
| `ACCESS_DEPENDENCY_MISSING` | Install the existing requirements in this checkout's `.venv`; restart TEST. |
| `ACCESS_TUNNEL_CONFIG_MISSING` | No installed config at the service user's expected path; identify the real Tunnel mechanism. |
| `ACCESS_TUNNEL_CONFIG_INVALID` | Unreadable, oversized or malformed config/rule; inspect locally without sharing credentials. |
| `ACCESS_TUNNEL_INGRESS_NOT_UNIQUE` | No matching loopback listener port or multiple matches; compare TEST PORT and actual ingress. |
| `ACCESS_ASSERTION_INVALID` | Missing/malformed assertion; authenticate through Access. Direct requests must still fail. |
| `ACCESS_IDENTITY_FETCH` | Network/TLS/timeout before an identity response; not proof of an expired session. |
| `ACCESS_IDENTITY_HTTP_REJECTED` | Cloudflare rejected identity lookup; numeric upstream status only. Reauthenticate and inspect the existing app/policy if needed. |
| `ACCESS_IDENTITY_RESPONSE_INVALID` | Unexpected identity content or no personal identity, including service-token-only identity. |

Configuration/dependency failures remain browser 503 `ACCOUNTS_AUTH_NOT_CONFIGURED`;
invalid/unavailable personal authentication remains 401 `UNAUTHORIZED`.

## Real TEST acceptance after deployment authorisation

1. Use a permitted personal Access session at hosted `/accounts`. List subscriptions,
   search with an operator-controlled TEST address, filter each status/mode, change
   sort, page and open detail. Compare current authoritative counts (the supplied
   11/8/2/1/0 snapshot is historical, not a fixed expected future count).
2. Open hosted Email Delivery and bounded per-subscription history where available.
   Confirm actual authoritative data, pagination and explicit unavailable states.
   Empty success is valid only when the authoritative read succeeds and is empty.
   Accepted means SMTP acceptance, not inbox receipt. Reading must enqueue/send nothing.
3. Repeat listing/filter/detail/delivery on the local TEST hostname with its valid
   personal Access session. Confirm the installed port/config is resolved and that
   dependency/config/session failures can be distinguished using the fixed events.
4. Check denied/expired/unauthorised and service-token-only Access sessions. On the
   actual Accounts API routes, try direct listener/Worker access (where routable)
   without authentication, with forged Host/email/identity headers and a fabricated
   assertion. They must fail closed with no private response. Do not expose a new
   public Worker route just to test this. Missing local config remains 503 denial.
5. Inspect response headers for `Cache-Control: no-store`, safe generic errors and
   projected fields only. Verify no subscriber tokens/hashes/raw payloads appear in
   browser data, persistent storage, application logs or telemetry. Keep test
   addresses/assertions out of screenshots, copied request URLs and shared logs.
6. Confirm `/ingest`, `/ops`, `/media` and Station Snapshot still load and read their
   existing data; verify Accounts refresh and Back/Forward navigation too.

## Rollback and documentation ownership

If deployment causes a regression, use Cloudflare's existing Worker version rollback
to the recorded last working deployment; credentials and migrations need no rollback.
For local TEST, restore approved baseline `106469b2` (or the prior recorded local
revision) and restart only the TEST dashboard via the same kickstart/foreground path.
The baseline restores the original failures, so private reads may remain unavailable.
Do not execute archived code or alter subscriber/D1 data during rollback.

Authoritative system docs were read-only. ChatGPT Chat-mode handover: update the
Accounts/hosted/local operations documentation after real TEST evidence, recording
manual redirect rejection, the existing YAML/unique-port trust source including
localhost, safe diagnostic codes and unresolved remote-managed support. Their
current future/not-deployed status should only change with operational evidence.
