# JSONgen Phase 1 TEST signer

This isolated Worker issues `POST /v1/upload-intents` for a Prune Daily v3
connector-day PENDING source or original-evidence bundle. The checked-in base
configuration defaults to `UK_AQ_JSONGEN_SIGNER_ENABLED=false`; the TEST
[manual deployment workflow](../../.github/workflows/uk_aq_jsongen_signer_deploy.yml)
renders a deployment-only config from required settings and always deploys
disabled. Read-only Cloudflare inspection on 20 October confirmed the existing
enabled pending-only version `f03ddafa-8003-4ef8-98c4-b339a84c287b` on the
TEST custom domain, with workers.dev and previews disabled. Recheck those
settings before replacement; this local file is not a live-status source.
It receives at most 4 KiB of metadata, never observation bytes. Prune's optional
caller remains default-off. An intent does not show that
R2 received bytes, verified a source, accepted final writer evidence or registered
a JSONgen change.

The request is JSON with exactly these fields:

```json
{
  "writer_identity": "prune_daily_v3",
  "invocation_id": "writer-generated-stable-id",
  "index_generation": "v3",
  "connector_id": 1,
  "day_utc": "2026-10-12",
  "object_type": "connector_day_observations_ndjson_gzip",
  "compressed_byte_size": 123,
  "compressed_sha256": "64 lowercase hexadecimal characters",
  "uncompressed_byte_size": 456,
  "uncompressed_sha256": "64 lowercase hexadecimal characters",
  "scope": { "kind": "connector_day", "connector_id": 1, "day_utc": "2026-10-12" }
}
```

The caller sends `Authorization: Bearer <writer token>` and
`Content-Type: application/json`. The token is a separate, revocable Worker
secret; the asserted `writer_identity` and invocation ID cannot authenticate a
caller. A later Integrity writer can use the same endpoint and key codec after
its own credential, allowlist and final-authority design are accepted. The
Prune token currently authorises only connector IDs in the explicit allowlist.
The invocation ID is validated and pins the key, but its final canonical
authority is not established by this API.

An evidence-bundle request additionally binds the invocation attempt, writer
Git SHA, source-evidence and source-identity digests, connector-manifest identity
and final-batch digest. The Worker derives a separate invocation-and-compressed-
digest key and returns signed PUT and GET URLs for that same object. Neither
object body passes through the Worker.

On success the response contains a deterministic opaque intent ID, a private
bucket/key and declared digest/size reference, `upload_url`, expiry, required
headers and `state: signed_upload_intent`. The ID is SHA-256 of a domain-tagged
JSON array containing the validated writer, invocation, generation, connector,
UTC day, object type, scope, both digests, **both declared byte lengths**, exact
bucket and key. Array positions, JSON types and escaping make the encoding
unambiguous. Identical metadata yields the same intent ID and key. Conflicting
lengths yield different IDs but currently the same digest-derived key; later
readback must reject incorrect lengths. A fresh 60-second URL may be issued
for that key; the signed `If-None-Match: *` should make a repeated PUT return
412 rather than overwrite it. The caller must use the exact returned headers.
The URL is a bearer capability and must not enter logs, artifacts or public
clients. `expires_at_utc` uses the exact second represented by signed
`X-Amz-Date` plus the 60-second URL lifetime. Future upload clients should
apply their own safety margin for network latency and clock differences; the
signer does not shorten the URL to provide that margin. Neither the ID nor key
is durable confirmation or canonical authority.

Bundle responses also include a short-lived `readback_url` and the validated
bundle identity. The Prune caller sends the compressed body directly to R2,
then reads it directly from R2 and compares exact bytes, length and SHA-256
before it records the pointer in PostgreSQL.

## Signing boundary

The existing `workers/shared/r2_sigv4.mjs` uses Node crypto and signs immediate
requests. This Worker uses Web Crypto to construct S3 SigV4 query authentication
for `PUT` and bundle-only `GET` on exact bucket/keys. The account and bucket
come from `UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID` and `UK_AQ_JSONGEN_R2_BUCKET`; the
Worker name comes from `UK_AQ_JSONGEN_SIGNER_WORKER_NAME`, and the custom
hostname is derived from the existing `UK_AQ_JSONGEN_PRUNE_SIGNER_URL`. The
renderer requires these settings and checks the configured R2 endpoint against
the account used for signing. It has no account, bucket, name or hostname
fallback. The Worker checks the configured environment and requires bundle
metadata to match it; the TEST workflow fixes that environment to `TEST`.
The canonical signed headers are `host`, `content-type`, `if-none-match` and
`x-amz-checksum-sha256`. The checksum value is the declared compressed SHA-256
in S3 base64 form. SigV4 uses `UNSIGNED-PAYLOAD`. [R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
lists conditional `PutObject`, `Content-MD5`, and SHA-256 checksum capability;
its checksum table distinguishes `COMPOSITE` support from unsupported
`FULL_OBJECT` SHA-256. The [R2 release notes](https://developers.cloudflare.com/r2/platform/release-notes/)
also state that S3 `PutObject` supports SHA-256 checksums. These references
make the selected single PUT checksum plausible but do **not** establish that
R2 enforces this exact signed-header combination. Keep the checksum header and
require a wrong-body rejection check in real TEST.

Pending-source limits remain 8 MiB compressed and 32 MiB uncompressed. Bundles
are capped at 32 MiB compressed and 64 MiB canonical JSON, with a separate
32 MiB combined exact-metadata-body cap, 8,192 objects and 8 MiB per object.
These are **declared metadata** limits. This Worker never sees the PUT body. The signed checksum fixes a claimed digest,
subject to real R2 enforcement; it does not fix or prove byte length. The signer
does not include `Content-Length` in signed headers: Cloudflare's presigned URL
and S3 compatibility guidance does not establish that doing so would reliably
enforce the body size for this R2 request, and HTTP clients manage that header.
This is a deployment validation question, not an implied current guarantee.
The future private reader must independently verify stored compressed byte
length and SHA-256, decompress within bounds, and verify uncompressed byte
length and SHA-256. A matching key, ETag, caller checksum or PUT response is
not a verified source. The Worker only signs the bundle GET; Prune performs and
verifies the direct readback.

## Credential and rate-limit boundaries

[Standard R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/)
can be restricted to selected buckets with Object Read & Write permission.
That permission allows read, write and list operations across the selected
bucket; it is not prefix-only or PUT-only. The Worker limits the URLs it issues
to one exact object and method at a time (PENDING PUT; bundle PUT and exact-key
GET), but that does not narrow the permanent credential's own permissions or
independently restrict a holder of the key. The actual token scope is not
visible in this repository and must be verified by the operator. R2 must also
enforce each URL's signed method, key, expiry and headers; exact checksum and
conditional-write behavior remains to be proven in TEST.

[R2 temporary credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/)
can restrict a credential to a bucket and paths. Local signing can additionally
scope individual S3 actions; the Temporary Credentials API currently uses
permission presets. Temporary credentials require an S3 session token on every
request. This Worker does **not** implement that protocol or include a session
token in its presigned URLs. A dedicated bucket-scoped standard token is the
minimum compatible option, but retains bucket-wide object read/write/list
authority. Before deployment, verify that the token is dedicated to the private
TEST JSONgen bucket and explicitly accept that residual risk. If prefix-only or
method-only credential scope is required, stop: this Worker does not provide it.
Do not describe the current permanent credential as prefix-only or PUT-only.

[Workers native rate limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
uses a per-writer key here, after bearer authentication. The Worker fails closed
if the binding is missing, throws, or does not return success. Cloudflare counts
each key **per Cloudflare location**, with asynchronous local counter updates;
10 requests per 10 seconds is protective admission, not a globally consistent
or exact hard writer quota. A `namespace_id` is an account-wide positive integer
and the same ID and key share counters across Workers. The checked-in config
has no binding until the account owner allocates an unused namespace and the
manual workflow renders it into `wrangler.deploy.toml`. This also makes accidental
enablement fail closed. No globally consistent quota is claimed in Phase 1.

Errors contain only a bounded code: `disabled`, `invalid_endpoint`,
`invalid_signing_configuration`, `authentication_failed`, `rate_limited`,
`rate_limit_unavailable`, `request_too_large`, `invalid_request`,
`unauthorised_writer`, `invalid_generation`,
`invalid_scope_or_object_identity`, `unauthorised_scope` or `signing_failure`.

## Controlled operator handover

The following are **separate decisions**: A code preparation, B disabled
deployment, C signer activation, D Prune PENDING/bundle handover activation, and
E the first separately authorised real TEST operation. Local code changes
authorise none of B–E.
The workflow has only `workflow_dispatch`, accepts only this TEST repository's
`main`, and always deploys with `UK_AQ_ENV_NAME=TEST` and
`UK_AQ_JSONGEN_SIGNER_ENABLED=false`. It has no enablement input or variable
override. It obtains the account, bucket, Worker name and custom hostname from
required configuration and fails closed if a setting is absent or malformed.
Rerunning it after activation disables the signer again.

**Replacement impact:** the disabled deployment replaces the Worker version
that currently serves PENDING signing. PENDING and bundle signing both return
`503 disabled` until separate activation. Keep the Prune scheduler paused
throughout B and C, and complete C in the same planned window after B is
verified. Do not dispatch Prune during that interval.

The latest contract records an operator report that the pending-source flag is
enabled while the Prune Daily schedule is paused. Read-only GitHub inspection
confirmed the pending-source variable is `true`; the actual Cloud Scheduler
state remains unverified. Preserve the flag and independently confirm the
schedule is paused throughout B and C. Do not dispatch Prune during that interval.

### A. Local code preparation

The protocol is unchanged: Web Crypto SigV4, conditional checksum-bound PUT
URLs for PENDING and bundles, bundle-only exact-key GET readback, the private
bucket/prefix rules, separate writer authentication, and bounded admission.
Initial connector allowlist remains exactly `1`. The Worker does not receive
object bodies or canonical writer credentials. Native rate limiting remains
10 requests per 10 seconds per writer key per Cloudflare location.

Prune's workflow passes the existing optional handover settings, including
`UK_AQ_JSONGEN_PRUNE_PENDING_SOURCE_ENABLED`. It also supplies the
exact `UK_AQ_ENV_NAME=TEST` required by `resolvePruneSignerConfig`; the existing
`UKAQ_ENV_NAME` remains in place. No Prune extraction, canonical R2 publication,
object/manifest verification, v3 finalisation, PostgreSQL gate or deletion code
is changed. No new confirmation/receipt endpoint or monthly publisher is added.

### B. Manual setup and deployment with signer disabled

Perform these steps only under separate operator authority, after merging.
Before B, independently compare the configured Worker name, hostname, TEST
account and bucket with the current deployment and confirm that the Access
application protects that exact hostname. A syntactically valid setting does
not prove it names the existing TEST resource.

1. Confirm `UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID` is the TEST account and
   `UK_AQ_JSONGEN_R2_BUCKET` is the intended private TEST bucket. Keep public
   bucket access disabled. Verify that the existing signer credential is a
   **dedicated standard R2 API token**, Object Read & Write, restricted to
   **this bucket only**, and approve the residual bucket-wide credential risk,
   including access to the existing experimental objects. It is not a
   Cloudflare Workers deployment API token. It is compatible with the existing
   presigner; temporary session credentials are not. **A standard bucket-restricted token
   covers objects across the bucket, not just the pending prefix, and is not
   PUT-only.** If narrower credential-level scope is mandatory, stop: this
   implementation does not supply it. Do not substitute temporary credentials
   or reuse canonical/chart writer credentials.
2. Verify the existing separate revocable Prune writer authentication token is
   at least 32 unpredictable characters and differs from the R2 secret,
   deployment API token and Access service token. Its GitHub secret and Worker
   secret must be the intended pair; values cannot be read back for comparison.
3. Confirm the existing rate-limit namespace allocation in this account. Cloudflare's native rate
   limit binding uses an account-unique positive integer **chosen and managed
   by the account owner**, not an R2/KV namespace or an ID invented in code.
   Inventory existing Worker rate-limit bindings/configurations and the
   account's allocation register; confirm its positive integer is reserved for the
   configured signer Worker, record its owner/purpose, and confirm it will
   not share counters with another Worker. If allocations cannot be established,
   stop and resolve with the account administrator. Put the allocated ID in
   `UK_AQ_JSONGEN_SIGNER_RATE_LIMIT_NAMESPACE_ID`. No `wrangler kv namespace
   create` or speculative numeric example is appropriate. The workflow rejects
   missing/non-positive/non-decimal values and renders:

   ```toml
   [[ratelimits]]
   name = "UK_AQ_JSONGEN_SIGNER_RATE_LIMIT"
   namespace_id = "<operator-allocated-positive-integer>"
   simple = { limit = 10, period = 10 }
   ```

   The placeholder is documentation only; never deploy it. Account-wide
   uniqueness requires the operator's inventory; syntax validation cannot prove it.
4. Verify the existing dedicated Access service token and self-hosted
   application cover **all paths** of the configured signer hostname. Its
   **Service Auth** policy must admit only that service token; do not add bypass, public allow or
   interactive browser login as an alternate path. Keep the writer's
   `Authorization: Bearer` header independent: the existing client sends
   `CF-Access-Client-Id` and `CF-Access-Client-Secret` for Access. Verify policy
   coverage before deployment replaces the custom domain. The Worker does not
   validate Access JWTs itself and relies on this edge protection. Keep
   workers.dev and preview URLs disabled and add no other route. Confirm the
   hostname and custom domain in the TEST zone; the rendered Wrangler config
   attaches the existing custom domain.
5. Configure the **TEST Ops repository** GitHub values below. Reuse the existing
   R2-account deployment selectors; verify their token can edit Workers scripts
   in the exact account and manage the custom domain (including required zone/DNS
   permissions for the configured TEST zone). R2 object credentials alone cannot deploy
   Workers. If the existing deployment token lacks permissions, arrange a
   separately authorised appropriate credential; do not silently fall back to
   another account/token. Do not place secret values in code, docs or artifacts.

   | GitHub variable | Required setting |
   |---|---|
   | `UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID` | Confirmed TEST account ID |
   | `UK_AQ_JSONGEN_R2_BUCKET` | Confirmed private TEST JSONgen bucket |
   | `UK_AQ_JSONGEN_R2_ENDPOINT` | S3 origin matching the confirmed TEST account |
   | `UK_AQ_JSONGEN_SIGNER_WORKER_NAME` | Existing TEST Worker name to replace |
   | `UK_AQ_JSONGEN_SIGNER_RATE_LIMIT_NAMESPACE_ID` | Existing signer namespace ID; verify account-wide allocation ownership |
   | `UK_AQ_JSONGEN_PRUNE_PENDING_SOURCE_ENABLED` | Preserve the current value; independently verify it before a later Prune operation |
   | `UK_AQ_JSONGEN_PRUNE_SIGNER_URL` | `https://<configured-hostname>/v1/upload-intents` |

   | GitHub secret | Consumer |
   |---|---|
   | `UK_AQ_R2_CLOUDFLARE_API_TOKEN` | Wrangler deployment, separate from S3 credentials |
   | `UK_AQ_JSONGEN_SIGNER_R2_ACCESS_KEY_ID` | Signer Worker secret only |
   | `UK_AQ_JSONGEN_SIGNER_R2_SECRET_ACCESS_KEY` | Signer Worker secret only |
   | `UK_AQ_JSONGEN_PRUNE_WRITER_TOKEN` | Signer Worker secret and Prune caller |
   | `UK_AQ_JSONGEN_SIGNER_ACCESS_CLIENT_ID` | Prune's dedicated Access service token ID |
   | `UK_AQ_JSONGEN_SIGNER_ACCESS_CLIENT_SECRET` | Prune's dedicated Access service token secret |

   The signer does not receive the Access client secret or canonical R2 keys.
   The tracked `config/uk_aq_github_env_targets.csv` maps these settings for the
   existing sync tooling, including the new Worker-name variable.
   Update the operator-owned private catalogue through its normal process before
   a later sync; this task does not inspect or modify it. No GitHub setting is
   changed here. The pending-source flag and the Prune scheduler are separate
   controls. Preserve the current flag, keep the scheduler paused, and verify
   both before any separately authorised Prune operation.
6. After Access protection and credentials are ready, **separately authorise B**,
   then manually run:

   ```bash
   gh workflow run uk_aq_jsongen_signer_deploy.yml --repo TEST-uk-aq/uk-aq-ops --ref main
   ```

   The workflow renders `wrangler.deploy.toml`, runs the pinned Wrangler
   4.130.0 package dry-run, deploys the configured Worker disabled, uploads only
   the three dedicated Worker secrets via stdin, then deploys it disabled again.
   It cannot enable the Worker. If secret upload fails, the first deployment
   remains disabled. Verify the deployed version, Worker name, TEST account,
   private bucket, protected hostname, allowlist `1`, native rate limit `10/10`,
   disabled workers.dev/preview URLs and `enabled=false`. An authenticated
   Access request must receive `503 disabled`; a request without Access
   credentials must be stopped by Access. This does not validate signed PUT or
   R2 permission enforcement. Expect PENDING signing to be unavailable until C.

### C. Signer activation (separate decision)

After B is accepted, separately authorise activation. In a reviewed TEST
checkout, load the same verified nonsecret deployment settings as B and render
both copies locally; the CI-generated file is not automatically present in this
checkout. Use `UK_AQ_ENV_NAME=TEST`, the configured account, bucket, R2 endpoint,
Worker name, Prune signer URL and rate-limit namespace. Then render an enabled copy;
the only difference from the disabled copy must be
`UK_AQ_JSONGEN_SIGNER_ENABLED = "true"`:

```bash
UK_AQ_JSONGEN_SIGNER_ENABLED=false \
  node scripts/jsongen/render-signer-wrangler-config.mjs \
  workers/uk_aq_jsongen_signer/wrangler.deploy.toml
UK_AQ_JSONGEN_SIGNER_ENABLED=true \
  node scripts/jsongen/render-signer-wrangler-config.mjs \
  workers/uk_aq_jsongen_signer/wrangler.activate.toml
diff -u workers/uk_aq_jsongen_signer/wrangler.deploy.toml \
  workers/uk_aq_jsongen_signer/wrangler.activate.toml
```

The `diff` should show only the enablement value changing; its normal exit code
is `1` because the files intentionally differ.

From the Worker directory, with the deployment token loaded securely as
`CLOUDFLARE_API_TOKEN`, deploy only after reviewing the single-line diff and
authorising C:

```bash
cd workers/uk_aq_jsongen_signer
npx --yes wrangler@4.130.0 deploy --config wrangler.activate.toml
```

The rendered file carries the same account, bucket, Worker name, custom route,
rate binding and TEST environment as B. The workflow remains disabled-only; a
later workflow dispatch will disable the signer again. Keep the Prune scheduler
paused and the pending-source flag unchanged. After deployment, verify that
PENDING PUT signing and bundle PUT plus GET signing are present before any
separately authorised Prune operation. Do not log or retain returned signed
URLs. C does not prove R2 enforcement, capacity or writer handover.

### D. Prune pending-upload activation (separate decision)

Before any later Prune operation, confirm the actual PostgreSQL login used by Prune's
**`SUPABASE_DB_URL`**, not the REST `SB_SECRET_KEY` or an assumed `service_role`.
In an independently authorised read-only session using that same connection,
run `SELECT session_user, current_user;` and check the exact function privilege:

```sql
SELECT has_function_privilege(current_user,
  'uk_aq_ops.insert_prune_jsongen_gate_acceptance(date,integer,uuid,text,jsonb,bytea)',
  'EXECUTE');
```

Retain the non-secret role/grant result; never print the DSN. The investigation
reported the TEST outbox table/function present and `service_role` EXECUTE, but
that does not identify Prune's login or prove its permission. Verify required
schema access and the restricted function under the real login; if missing,
arrange separately reviewed schema-owned grants rather than broad table-write
access. No database query or grant is performed by this change.

Confirm selected complete-v3 Prune configuration (`UK_AQ_R2_HISTORY_VERSION=v3`),
all URL/Access/writer settings, configured TEST account and bucket variables,
the current pending-source flag value, and bounded optional-operation headroom.
The existing schedule must remain paused. The current local code uses a shared
15-second concurrent PENDING-upload/binding-capture window, then one shared
five-second post-finalisation bundle prepare/sign/PUT/readback window. It records
the PostgreSQL pointer only after exact direct R2 readback; JSONgen still must
independently authenticate the bundle and PENDING bytes. The latest contract
reports that `UK_AQ_JSONGEN_PRUNE_PENDING_SOURCE_ENABLED` is already true; do not
change it as part of this task. Any future change to that flag requires separate
authority and coordination with the paused scheduler. Failure diagnostics and
the best-effort outbox savepoint policy remain
unchanged. Bundle failures leave handover incomplete and do not reverse the
canonical Prune gate. No new scope selector is introduced:
the signer admits connector `1`, while any other connector receives no intent
and the optional handover fails without changing canonical Prune authority.

### E. First authorised real TEST operation (separate decision)

Keep the scheduler paused. A later bounded manual TEST operation requires
separate authority, including any R2 writes and any normal Prune deletion.
Validate real signed PUT plus required headers, wrong-body
checksum rejection, size mismatch detection by independent exact private
readback, immutable retry/412, URL expiry, writer/Access rejection, scope and
per-location rate limits, and Worker CPU/`exceededCpu`. Do not remove checksum
or conditional restrictions if the chosen R2 combination fails. Validate Prune
canonical verification/finalisation/gate/deletion behaviour and timing unchanged,
then inspect the original acceptance/outbox event and evidence completeness.
Never fabricate/backfill objects or run Prune merely to make a deployment check pass.

An upload acknowledgement remains **pending/unverified**. Independent full-source,
status/binding/final-authority authentication, durable receipt/registration and
reconciliation remain unresolved later gates. `prepared_unverified` or an outbox
row does not make a VERIFIED receipt. Monthly publication, managed selection, automatic
JSONgen triggers and chart/LIVE activation remain outside all of B–E.

If the new version fails after B, keep the Prune scheduler paused and preserve
the pending-source flag. A separately authorised rollback to the previous
pending-only Worker version restores PENDING signing but not bundle signing;
otherwise keep the replacement disabled until its configuration is corrected.
Already issued URLs remain usable until their short expiry unless the dedicated
R2 signing token is revoked. Pending objects require separate verified
retention/cleanup rules. No canonical verification or deletion decision depends
on this Worker; no JSONgen publication is wired to it.
