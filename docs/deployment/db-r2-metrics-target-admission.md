# DB/R2 Metrics deployment admission

This runbook covers the existing Metrics deployment workflow only. The Worker
application, routes, authentication contract, data schemas and history authority
are unchanged. The Node runtime pin remains in separate draft PR #131.

## Admission boundary

Before either deployment or secret upload, the workflow:

1. requires exact `TEST` or `LIVE` directly in canonical `UK_AQ_ENV_NAME`;
2. requires existing `UK_AQ_GITHUB_REPO` to match Actions' `GITHUB_REPOSITORY`;
3. requires an explicitly configured, correctly formatted Cloudflare account ID
   and Worker name;
4. requires the selected `CLOUDFLARE_API_TOKEN` and all eleven upload inputs,
   including a nonblank `UK_AQ_DB_SIZE_API_TOKEN`, before any remote mutation;
5. uses that credential for one read-only GET of secret-name/type metadata at
   the selected account's exact Worker path. All eleven existing secret-text
   bindings must be present. Missing Worker/access/bindings, redirects, invalid
   responses and network failures stop the job before deployment.

There is no account, token, Worker-name or environment fallback. Resource names
have no environment suffix requirement. The read uses Cloudflare's provider API,
not an operator-supplied API origin; it never retrieves secret values. An active
token alone is insufficient: input checks must pass first, and the token must
read the existing Worker at that exact configured account/script endpoint. No Worker
creation or rename is an admission remedy.

The existing GitHub account variable and API token are the target-selection trust
boundary. The workflow cannot independently establish whether the configured
account is the intended TEST or LIVE account. The operator must verify those
values against actual Cloudflare account ownership before merging.

The metadata check establishes that the selected Worker exists and its required
bindings are present. It does not prove environment ownership, secret-value
compatibility, deployment-write permissions or the absence of LIVE consumers.
There is no secondary approval record, allow-list or duplicated environment
configuration. Metadata is a point-in-time check, not a lock against concurrent
cloud changes. Avoid concurrent target/configuration changes during rollout.

## Required configuration before merge

The corrective workflow file itself matches the existing main-push deployment
filter. Do not merge until an authorised operator has verified the applied
configuration, recovery evidence and deployment approval. This PR changes no
GitHub settings or credential values and performs no synchronisation.

Repository **variables**:

| Key | Required meaning |
| --- | --- |
| `UK_AQ_ENV_NAME` | Existing canonical environment, exactly `TEST` or `LIVE` |
| `UK_AQ_GITHUB_REPO` | Existing explicit repository, matching the running repository |
| `UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID` | Sole selected account variable, already used by Latest Snapshot R2 API; operator must verify actual account ownership |
| `UK_AQ_DB_R2_METRICS_API_WORKER_NAME` | Exact already-provisioned Worker in that account |
| `UK_AQ_R2_HISTORY_VERSION` | Existing authorised `v1`, `v2` or `v3`; do not change to pass admission |
| `SUPABASE_URL`, `OBS_AQIDB_SUPABASE_URL` | Existing intended project endpoints |
| `CFLARE_R2_ENDPOINT`, `CFLARE_R2_BUCKET`, `CFLARE_R2_REGION` | Existing intended R2 resource configuration; all nonblank |

Repository **secrets**, all nonblank:

- `CLOUDFLARE_API_TOKEN`: the sole selected deployment credential, already used
  by Blog Feed. It must read secret metadata and perform the existing Worker
  deployments and secret synchronisation for the exact selected account/Worker.
  Successful Blog Feed deployment alone does not establish those permissions.
- `SB_SECRET_KEY`, `OBS_AQIDB_SECRET_KEY`: existing keys for their matching projects.
- `CFLARE_R2_ACCESS_KEY_ID`, `CFLARE_R2_SECRET_ACCESS_KEY`: existing R2 credential pair.
- `UK_AQ_DB_SIZE_API_TOKEN`: existing authentication secret, compatible with the
  deployed Worker and its normal dashboard callers.

These are deliberate single-source selections, not fallback chains. Missing or
invalid selected inputs fail closed even if retired Metrics-specific settings,
other account IDs or other tokens exist. Do not rotate or copy credentials or
silently change accounts to satisfy admission. If `CLOUDFLARE_API_TOKEN` access
and required write permissions for this exact target cannot be established,
leave this PR blocked. Metadata access proves read access only; the operator must
verify the token's existing deployment and secret-write grants before merge.
No GitHub variable or secret value is created, edited, deleted or synchronised.
The three retired Metrics-specific selection keys are no longer consumed or
catalogued here; their historical archive references are preserved. Shared
catalogue entries used by other workflows remain intact.

Keep the existing private, ignored `env-vars-master.csv`, sourced configuration
and committed target catalogue aligned with these single-source settings. No new
approval variable or replacement allow-list is required. The existing sync
script skips empty variables and does not remove obsolete remote settings.
Inspect applied repository settings separately; the catalogue is not proof of
applied values. No sync or GitHub settings change was performed for this PR.

## Secret preservation and authentication

The base-deploy / secret-bulk / final-deploy sequence and three-attempt retry loop
are retained. The same eleven keys and nonempty-value JSON filter are retained.
Inputs are passed as step environment variables and quoted shell expansions,
rather than interpolating secret values into the shell programme. Admission and
upload use the same GitHub sources. The guard requires all eleven inputs and
all eleven existing secret-text bindings, so this protected deployment cannot
rely on omission to preserve an unknown stale credential or start with no auth
binding. Deployment of the existing protected service is intentionally stricter
than the application's optional-configuration behaviour.

Bulk upload still replaces supplied values and preserves unmentioned keys; it
does not remove obsolete secrets. Presence checks do not prove matching secret
values. The operator must verify existing Worker/GitHub/caller compatibility
without retrieving or disclosing values, using credential provenance and normal
authorised operations. Base deployment relies on Cloudflare preserving existing
secret bindings. Do not alter those bindings concurrently with the rollout.

The application still allows unauthenticated reads when its token is absent.
That code is not changed here. Any broader application authentication-contract
change requires its own authority review; this workflow now refuses such a state.

## Evidence and limitations

Previously supplied read-only evidence identifies TEST account `sleepercar.co.uk`,
Worker `uk-aq-db-r2-metrics-api`, serving version 205 at 100%, ID
`fc8f3576-70b3-4e26-9ae5-095c03f3bda9`, with existing Supabase, R2 and API-token
bindings. This is prior evidence, not a refreshed Cloudflare read for this PR.

Historical Actions run [40026276543](https://github.com/TEST-uk-aq/uk-aq-ops/actions/runs/40026276543)
at source `16743cee4da47540b37e6f2d95a28c2959298cfd` confirms `target_env=unset`,
masked account `41a8...e879`, the unsuffixed Worker, history `v3`, eleven successful
secret writes and the same final version ID. It explains the old guard bypass.
The current source workflow matches that successful workflow before this change.

Before merging in this TEST repository, the operator must verify canonical
`UK_AQ_ENV_NAME=TEST`, repository `TEST-uk-aq/uk-aq-ops`, and the selected full
account ID and existing Worker against actual Cloudflare ownership. Do not infer
ownership from these strings, the Worker suffix or the earlier successful
Latest Snapshot/Blog deployments. The masked historical ID cannot substitute for
the full account ID. If a resource serves both TEST and LIVE, flag the risk and
stop for separate explicit shared-impact authorisation.

No Cloudflare connection/credential is available in this task. GitHub's connector
does not expose repository-variable or secret APIs here. Current full account
ownership, resource isolation, applied variables, credential validity/permissions,
secret freshness and rollback eligibility therefore remain merge blockers.
No secret values were read. Refresh metadata and confirm that this Worker and its
upstreams do not serve LIVE before approving any TEST mutation. Shared resources
require separate explicit shared-impact authorisation.

The existing dynamic Wrangler-major selection remains a separate documented
policy gap against the dashboard operations lockfile-pinning contract. No
dependency/runtime pin is added to this safety correction.

## Safe rollout and recovery

1. Review this draft and independently verify TEST inventory, Worker bindings,
   version/traffic, account ID and all upstream/caller credential provenance.
2. An authorised operator reconciles the private master and applied variables,
   verifies the existing secrets and actual account/Worker ownership, captures the normal
   authenticated dashboard baseline and confirms an eligible recovery version.
   Do this before merge. If anything is unknown, leave both draft PRs unmerged.
3. Obtain explicit authorisation for the corrective merge and its automatic TEST
   deployment/secret writes. The workflow performs local admission and one
   read-only metadata request before its first deployment. Do not dispatch it
   manually for preflight evidence. Normal approval/review is required; no GitHub
   environment or settings change is introduced by this PR.
4. After the authorised corrective deployment, retain all stage/version IDs and
   inspect normal authenticated DB/schema/R2 trend, storage-coverage and connector
   count operations. Use the existing documented Metrics/dashboard requests and
   serving-descriptor-selected generation. Confirm expected TEST data, auth,
   unchanged errors/partial-unavailable semantics and no credential exposure.
5. Only after acceptance, refresh/reconcile PR #131 against the newly accepted
   main. Keep every safety correction and add only its Node setup step. Recheck
   exact triggers/diff, obtain separate merge/deployment authorisation, deploy
   through the normal merge and repeat bounded operational acceptance.

The exact changed-path trigger analysis belongs in the corrective PR assessment.
Unchanged push filters mean a later helper-only edit does not itself deploy; that
edit still needs admission review before the next authorised deployment.

Version 205 / `fc8f3576-70b3-4e26-9ae5-095c03f3bda9` is the known source-compatible
recovery candidate; current eligibility and binding/credential compatibility must
be refreshed. Older retained versions lack verified IDs/compatibility here.
Rollback requires separate authorisation and an explicit compatible version ID.
It restores versioned Worker state, not GitHub settings, external credentials,
caller settings or connected database/R2 state. The staged deployment is not
atomic and can leave an intermediate version serving after failure. Do not
blindly rerun it or revert to the unsafe guard as a recovery procedure.

System Docs handover for Chat mode: document configuration-driven admission,
operator ownership verification and pre-mutation binding checks; record TEST
acceptance only after it occurs. Authoritative `system_docs/` remains read-only.
