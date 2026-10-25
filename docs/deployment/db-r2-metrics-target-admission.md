# DB/R2 Metrics deployment admission

This runbook covers the existing Metrics deployment workflow only. The Worker
application, routes, authentication contract, data schemas and history authority
are unchanged. The Node runtime pin remains in separate draft PR #131.

## Admission boundary

Before either deployment or secret upload, the workflow:

1. requires exact `TEST` or `LIVE` in `UK_AQ_DB_R2_METRICS_TARGET_ENV`, matching
   the existing canonical `UK_AQ_ENV_NAME`;
2. requires existing `UK_AQ_GITHUB_REPO` to match Actions' `GITHUB_REPOSITORY`;
3. compares that environment/repository and the explicitly selected account and
   Worker with an independently reviewed approval record;
4. requires the Metrics-specific Cloudflare token and all eleven upload inputs,
   including a nonblank `UK_AQ_DB_SIZE_API_TOKEN`, before any remote mutation;
5. uses that credential for one read-only GET of secret-name/type metadata at
   the approved account's exact Worker path. All eleven existing secret-text
   bindings must be present. Missing Worker/access/bindings, redirects, invalid
   responses and network failures stop the job before deployment.

There is no account, token, Worker-name or environment fallback. Resource names
have no environment suffix requirement. The read uses Cloudflare's provider API,
not an operator-supplied API origin; it never retrieves secret values. An active
token alone is insufficient: the approved tuple must match first, and the token
must read the existing Worker at that exact account/script endpoint. No Worker
creation or rename is an admission remedy.

The approval is operator-managed configuration, not a discovery result generated
from the selected target. Whoever can change both the approval and selection can
change this trust boundary. Review them against independent Cloudflare inventory
and the approved repository/environment topology. Metadata proves existence and
binding names at check time, not secret validity, caller compatibility, exclusive
TEST use or future availability. It does not lock Cloudflare against concurrent
operator changes. Avoid concurrent deployments/configuration changes during the
authorised rollout.

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
| `UK_AQ_DB_R2_METRICS_TARGET_ENV` | Same canonical environment; no aliases or blank value |
| `UK_AQ_DB_R2_METRICS_CLOUDFLARE_ACCOUNT_ID` | Independently verified approved account ID; read from variables, as catalogued |
| `UK_AQ_DB_R2_METRICS_API_WORKER_NAME` | Exact already-provisioned Worker in that account |
| `UK_AQ_DB_R2_METRICS_APPROVED_TARGET` | New independent approval record described below |
| `UK_AQ_R2_HISTORY_VERSION` | Existing authorised `v1`, `v2` or `v3`; do not change to pass admission |
| `SUPABASE_URL`, `OBS_AQIDB_SUPABASE_URL` | Existing intended project endpoints |
| `CFLARE_R2_ENDPOINT`, `CFLARE_R2_BUCKET`, `CFLARE_R2_REGION` | Existing intended R2 resource configuration; all nonblank |

Repository **secrets**, all nonblank:

- `UK_AQ_DB_R2_METRICS_CLOUDFLARE_API_TOKEN`: the existing approved credential for
  this account/Worker, with Worker secret-metadata read and the already-required
  deployment/secret-write permissions. The generic token is no longer consulted.
- `SB_SECRET_KEY`, `OBS_AQIDB_SECRET_KEY`: existing keys for their matching projects.
- `CFLARE_R2_ACCESS_KEY_ID`, `CFLARE_R2_SECRET_ACCESS_KEY`: existing R2 credential pair.
- `UK_AQ_DB_SIZE_API_TOKEN`: existing authentication secret, compatible with the
  deployed Worker and its normal dashboard callers.

Do not create a new secret, copy generic credentials into the Metrics-specific
slot, rotate a value or silently change accounts to satisfy this checklist. If a
required existing secret is unavailable or its ownership cannot be established,
leave this PR unmerged and resolve that operational prerequisite separately.
The old Metrics account-ID secret and generic Cloudflare secrets are ignored by
this workflow; this PR neither edits nor deletes them, since others may use them.

`UK_AQ_DB_R2_METRICS_APPROVED_TARGET` is a JSON object with exactly four string
fields (shown as a schema template, not values to apply):

```json
{"environment":"<canonical environment>","repository":"<approved owner/repo>","account_id":"<verified 32-character account ID>","worker_name":"<existing approved Worker>"}
```

Duplicate fields, extra fields, malformed JSON, missing/whitespace values and any
tuple mismatch are rejected. This one new key is necessary because the existing
selection keys and terminal-only migration preflight do not store an independent
deployment approval. Existing `UK_AQ_ENV_NAME` and `UK_AQ_GITHUB_REPO` are reused.
No TEST/LIVE resource ID, hostname or name is embedded in executable code.

Register the new record as a variable in the existing private, ignored
`env-vars-master.csv` and the environment's sourced configuration, aligned with
the committed `config/uk_aq_github_env_targets.csv`. The existing sync script
routes by that CSV, skips empty variables and does not remove obsolete remote
secrets. Inspect the applied repository settings separately; the catalogue alone
is not proof of applied values. No sync was run for this PR.

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

For this TEST repository, the reviewed record must bind environment `TEST` and
repository `TEST-uk-aq/uk-aq-ops` to that existing Worker and its independently
verified full account ID. The masked historical ID cannot substitute for the
full ID, and the JSON schema template is not an approval to apply guessed values.

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
   verifies the required existing secrets and approved tuple, captures the normal
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

System Docs handover for Chat mode: document the approved account/Worker admission
record and pre-mutation protected-binding requirements, and record actual TEST
acceptance only after it occurs. Authoritative `system_docs/` remains read-only.
