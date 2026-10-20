# JSONgen Phase 1 TEST signer

This isolated Worker issues `POST /v1/upload-intents` for a Prune Daily v3
connector-day PENDING source or original-evidence bundle. It is **inactive**: `UK_AQ_JSONGEN_SIGNER_ENABLED`
defaults to `false`; workers.dev and preview URLs are off. The proposed custom
domain and [manual deployment workflow](../../.github/workflows/uk_aq_jsongen_signer_deploy.yml)
prepare a disabled TEST deployment only; neither has been applied by this change.
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
come from `UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID` and `UK_AQ_JSONGEN_R2_BUCKET` in the
Worker environment; the disabled deployment workflow supplies configured TEST
GitHub variables and the Worker has no code fallback.
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
can be restricted to the TEST bucket using Object Read & Write permission.
Cloudflare does not document a standard token restriction to this object prefix
or to `PutObject` alone. A bucket-scoped signing secret therefore retains
broader bucket object permissions if disclosed. The Worker code limits the
URLs it *issues* to PUT on one pending key, but that does not narrow the
permanent credential's own permissions or independently restrict a holder of
the credential. R2 must authenticate each issued URL and enforce its signed
method, key, expiry and headers; that combination remains to be proven in TEST.

[R2 temporary credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/)
can restrict bucket and paths. Local temporary-credential signing can also
specify an explicit `PutObject` action; the Temporary Credentials API currently
offers broader permission presets. Temporary credentials require an S3 session
token on every request. This Worker does **not** implement that protocol or
include a session token in its presigned URL. An approved design using such
credentials, or a separately protected bucket, is a later deployment option.
Until signer credential scope and the residual shared-bucket risk are reviewed
and accepted, deployment is blocked. Do not claim prefix-only or PUT-only
permissions for the current permanent credential.

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
deployment, C signer activation, D Prune PENDING/bundle handover activation, and E the
first authorised real TEST operation. Merging A authorises none of B–E.
The workflow has only `workflow_dispatch`, accepts only this TEST repository's
`main`, and always deploys with `UK_AQ_ENV_NAME=TEST` and
`UK_AQ_JSONGEN_SIGNER_ENABLED=false`. It has no enablement input or variable
override. Rerunning it after activation disables the signer again.

**Before merging:** the operator must confirm the repository pending-upload
variable is `false`. The cloud GitHub integration returned HTTP 403 when reading
that variable, so its current remote value has not been independently checked.

### A. Code preparation (this PR)

The signing implementation and protocol are unchanged: Web Crypto SigV4,
60-second PUT-only URLs, fixed private TEST bucket/account and pending prefix,
checksum and conditional headers, writer authentication and bounded admission.
Initial connector allowlist is exactly `1`. No R2 binding or canonical writer
credential is needed in this Worker. Native rate limiting remains 10 requests
per 10 seconds per writer key per Cloudflare location.

Prune's workflow now passes the existing optional handover settings, defaulting
`UK_AQ_JSONGEN_PRUNE_PENDING_SOURCE_ENABLED` to `false`. It also supplies the
exact `UK_AQ_ENV_NAME=TEST` required by `resolvePruneSignerConfig`; the existing
`UKAQ_ENV_NAME` remains in place. No Prune extraction, canonical R2 publication,
object/manifest verification, v3 finalisation, PostgreSQL gate or deletion code
is changed. No new confirmation/receipt endpoint or monthly publisher is added.

### B. Manual setup and deployment with signer disabled

Perform these steps only under separate operator authority, after merging:

1. Confirm account **sleepercar.co.uk**, ID
   `41a81f781d3bd7234fde0b25df51e879`, and ownership of private bucket
   `uk-aq-chart-history-json-test`. Keep public bucket access disabled. Approve
   the residual bucket-wide credential risk described above, including access
   to the existing experimental objects. Create a **dedicated standard R2 API
   token**, Object Read & Write, restricted to **this bucket only**. Retain its
   S3 Access Key ID and Secret Access Key securely. It is not a Cloudflare
   Workers deployment API token. It is compatible with the existing presigner;
   temporary session credentials are not. **A standard bucket-restricted token
   covers objects across the bucket, not just the pending prefix, and is not
   PUT-only.** If narrower credential-level scope is mandatory, stop: this
   implementation does not supply it. Do not substitute temporary credentials
   or reuse canonical/chart writer credentials.
2. Create a separate revocable Prune writer authentication token, at least 32
   unpredictable characters. It must differ from the R2 secret, deployment API
   token and Access service token. Store it both as the GitHub secret below and
   (through the deployment workflow) the identically named Worker secret.
3. Allocate a rate-limit namespace in this account. Cloudflare's native rate
   limit binding uses an account-unique positive integer **chosen and managed
   by the account owner**, not an R2/KV namespace or an ID invented in code.
   Inventory existing Worker rate-limit bindings/configurations and the
   account's allocation register; reserve an unused positive integer for
   `uk-aq-jsongen-signer-test`, record its owner/purpose, and confirm it will
   not share counters with another Worker. If allocations cannot be established,
   stop and resolve with the account administrator. Put the allocated ID in
   `UK_AQ_JSONGEN_SIGNER_RATE_LIMIT_NAMESPACE_ID`. No `wrangler kv namespace
   create` or speculative numeric example is appropriate. The workflow rejects
   missing/non-positive/non-decimal values and appends:

   ```toml
   [[ratelimits]]
   name = "UK_AQ_JSONGEN_SIGNER_RATE_LIMIT"
   namespace_id = "<operator-allocated-positive-integer>"
   simple = { limit = 10, period = 10 }
   ```

   The placeholder is documentation only; never deploy it. Account-wide
   uniqueness requires the operator's inventory; syntax validation cannot prove it.
4. In Cloudflare Zero Trust, create a dedicated Access service token and a
   self-hosted application covering **all paths** of
   `jsongen-signer-test.sleepercar.co.uk`. Apply a **Service Auth** policy
   admitting only that service token; do not add bypass, public allow or
   interactive browser login as an alternate path. Keep the writer's
   `Authorization: Bearer` header independent: the existing client sends
   `CF-Access-Client-Id` and `CF-Access-Client-Secret` for Access. Verify policy
   coverage before deployment creates the custom domain. The Worker does not
   validate Access JWTs itself and relies on this edge protection. Keep
   workers.dev and preview URLs disabled and add no other route. Reserve the
   hostname in the Sleepercar zone and resolve any existing DNS/domain conflict;
   Wrangler's `custom_domain = true` config attaches the hostname on deployment.
5. Configure the **TEST Ops repository** GitHub values below. Reuse the existing
   R2-account deployment selectors; verify their token can edit Workers scripts
   in the exact account and manage the custom domain (including required zone/DNS
   permissions for `sleepercar.co.uk`). R2 object credentials alone cannot deploy
   Workers. If the existing deployment token lacks permissions, arrange a
   separately authorised appropriate credential; do not silently fall back to
   another account/token. Do not place secret values in code, docs or artifacts.

   | GitHub variable | Required value |
   |---|---|
   | `UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID` | `41a81f781d3bd7234fde0b25df51e879` |
   | `UK_AQ_JSONGEN_SIGNER_RATE_LIMIT_NAMESPACE_ID` | The operator-allocated ID |
   | `UK_AQ_JSONGEN_PRUNE_PENDING_SOURCE_ENABLED` | Explicitly `false` before merging/configuration; keep false throughout B/C |
   | `UK_AQ_JSONGEN_PRUNE_SIGNER_URL` | `https://jsongen-signer-test.sleepercar.co.uk/v1/upload-intents` |

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
   existing sync tooling. The ignored `env-vars-master.csv` is absent from this
   cloud checkout: update the operator's private catalogue with the same target
   classifications before any later sync; keep actual credentials private. No
   sync or GitHub setting change is performed by this PR. Before merging, confirm
   there is no pre-existing `true` pending-upload variable: newly wiring a latent
   true value would activate the optional path on a later Prune invocation.
6. After Access protection and credentials are ready, **separately authorise B**,
   then manually run:

   ```bash
   gh workflow run uk_aq_jsongen_signer_deploy.yml --repo TEST-uk-aq/uk-aq-ops --ref main
   ```

   The workflow copies the config, adds the allocated binding, runs a Wrangler
   4.130.0 package dry-run, deploys the disabled base, uploads only the three
   dedicated Worker secrets via stdin, and deploys the disabled final version.
   Base and final deployments remain disabled even if secret upload fails.
   Inspect deployment state: Worker name, exact account, protected hostname,
   allowlist `1`, native rate limit `10/10`, no alternate ingress and enablement
   `false`. An authenticated request through Access must return `503 disabled`;
   a caller without valid Access credentials must be stopped by Access. This
   does not validate signed PUT or R2 permission enforcement.

### C. Signer activation (separate decision)

After B is accepted, separately authorise activation with a reviewed operator
copy of the **rendered** `wrangler.deploy.toml`, changing only
`UK_AQ_JSONGEN_SIGNER_ENABLED` to `true`. Retain the exact account, binding,
protected route, TEST environment and connector `1`. The manual deployment
workflow intentionally cannot activate it; a dashboard-only edit is overwritten
by a later deployment. Keep Prune's pending-upload flag false. Activation is
not acceptance of signature enforcement, CPU capacity or writer handover.
Use a reviewed fresh TEST checkout; render the binding as in the workflow and
keep the deployment copy beside `worker.mjs` so its relative entry point resolves.
With the authorised deployment API token loaded securely as
`CLOUDFLARE_API_TOKEN`, the separate C deployment command, from that directory, is:

```bash
CLOUDFLARE_ACCOUNT_ID=41a81f781d3bd7234fde0b25df51e879 \
  npx --yes wrangler@4.130.0 deploy --config wrangler.deploy.toml --name uk-aq-jsongen-signer-test
```

Run it only after reviewing that copy's single enablement change and authorising C.

### D. Prune pending-upload activation (separate decision)

Before authorising D, confirm the actual PostgreSQL login used by Prune's
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
and bounded optional-operation headroom. The current local code uses a shared
15-second concurrent PENDING-upload/binding-capture window, then one shared
five-second post-finalisation bundle prepare/sign/PUT/readback window. It records
the PostgreSQL pointer only after exact direct R2 readback; JSONgen still must
independently authenticate the bundle and PENDING bytes. Only
then, with separate D authority, set repository variable
`UK_AQ_JSONGEN_PRUNE_PENDING_SOURCE_ENABLED=true`. This authorises the optional
path on the **next Prune invocation**, including any existing external scheduler;
coordinate the operational window before changing it. It does not itself run
Prune. Failure diagnostics and the best-effort outbox savepoint policy remain
unchanged. Bundle failures leave handover incomplete and do not reverse the
canonical Prune gate. No new scope selector is introduced:
the signer admits connector `1`, while any other connector receives no intent
and the optional handover fails without changing canonical Prune authority.

### E. First authorised real TEST operation (separate decision)

Authorise a bounded operation explicitly, including any R2 writes and any normal
Prune deletion. Validate real signed PUT plus required headers, wrong-body
checksum rejection, size mismatch detection by independent exact private
readback, immutable retry/412, URL expiry, writer/Access rejection, scope and
per-location rate limits, and Worker CPU/`exceededCpu`. Do not remove checksum
or conditional restrictions if the chosen R2 combination fails. Validate Prune
canonical verification/finalisation/gate/deletion behaviour and timing unchanged,
then inspect the first original acceptance/outbox event and evidence completeness.
No pending objects or original events were found in the prior investigation;
never fabricate/backfill them or run Prune merely to make a deployment check pass.

An upload acknowledgement remains **pending/unverified**. Independent full-source,
status/binding/final-authority authentication, durable receipt/registration and
reconciliation remain unresolved later gates. `prepared_unverified` or an outbox
row does not make a VERIFIED receipt. Stage A run `39064499471` accepted only the
manual diagnostic shell. Monthly publication, managed selection, automatic
JSONgen triggers and chart/LIVE activation remain outside all of B–E.

To roll back after a future deployment, first set Prune's pending-upload flag
back to `false`, then disable the Worker enablement variable
or remove the protected route and revoke the writer token. Already issued URLs
remain usable until their short expiry unless the dedicated R2 signing token is
also revoked; rotate that token for immediate URL invalidation. Pending objects
require separate verified retention/cleanup rules. No canonical verification or
deletion decision depends on this Worker; no JSONgen publication is wired to it.
