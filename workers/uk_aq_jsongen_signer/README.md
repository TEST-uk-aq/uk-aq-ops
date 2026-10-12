# JSONgen Phase 1 TEST signer

This isolated Worker only issues `POST /v1/upload-intents` for a Prune Daily v3
connector-day pending source. It is **inactive**: `UK_AQ_JSONGEN_SIGNER_ENABLED`
defaults to `false`; workers.dev and preview URLs are off; no route, custom domain,
workflow or trigger is provided. It receives at most 4 KiB of metadata, never
observation bytes. No canonical writer calls it yet. An intent does not show that
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
clients. Neither the ID nor key is durable confirmation or canonical authority.

## Signing boundary

The existing `workers/shared/r2_sigv4.mjs` uses Node crypto and signs immediate
requests. This Worker uses Web Crypto to construct S3 SigV4 query authentication
for `PUT` on the exact bucket/key at the fixed Sleepercar TEST R2 S3 endpoint.
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

The 8 MiB compressed and 32 MiB uncompressed limits admit **declared metadata**.
This Worker never sees the PUT body. The signed checksum fixes a claimed digest,
subject to real R2 enforcement; it does not fix or prove byte length. The signer
does not include `Content-Length` in signed headers: Cloudflare's presigned URL
and S3 compatibility guidance does not establish that doing so would reliably
enforce the body size for this R2 request, and HTTP clients manage that header.
This is a deployment validation question, not an implied current guarantee.
The future private reader must independently verify stored compressed byte
length and SHA-256, decompress within bounds, and verify uncompressed byte
length and SHA-256. A matching key, ETag, caller checksum or PUT response is
not a verified source. This Phase 1 Worker performs no readback.

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
and the same ID and key share counters across Workers. The old `"1001"` value
was only an example; the checked-in config has no binding until the target
account owner allocates an unused namespace. This also makes accidental
enablement fail closed. No globally consistent quota is claimed in Phase 1.

Errors contain only a bounded code: `disabled`, `invalid_endpoint`,
`invalid_signing_configuration`, `authentication_failed`, `rate_limited`,
`rate_limit_unavailable`, `request_too_large`, `invalid_request`,
`unauthorised_writer`, `invalid_generation`,
`invalid_scope_or_object_identity`, `unauthorised_scope` or `signing_failure`.

## Later manual TEST setup

No setup or deployment is performed by this change. A separate review must:

1. Confirm ownership of `uk-aq-chart-history-json-test` in the Sleepercar TEST
   Cloudflare account. Select and approve a signer credential model: a separate
   standard R2 Object Read & Write token restricted to this bucket carries the
   broader bucket risk described above; an action/path-scoped temporary
   credential design needs separate implementation and session-token signing;
   a separate protected bucket changes storage ownership. Do not reuse a
   canonical R2 writer credential. Confirm the required S3 permission and
   account endpoint before adding secrets. This credential decision remains a
   deployment blocker.
2. Add the Worker secrets `UK_AQ_JSONGEN_SIGNER_R2_ACCESS_KEY_ID`,
   `UK_AQ_JSONGEN_SIGNER_R2_SECRET_ACCESS_KEY` and
   `UK_AQ_JSONGEN_PRUNE_WRITER_TOKEN` (at least 32 unpredictable characters).
   Rotate/revoke the writer token independently of the R2 signer credential.
3. Supply a reviewed deployment config with a bounded comma-separated
   `UK_AQ_JSONGEN_PRUNE_CONNECTOR_IDS` allowlist and set
   `UK_AQ_JSONGEN_SIGNER_ENABLED=true`. Keep `UK_AQ_ENV_NAME=TEST`. The checked-in
   allowlist is empty and enablement is false.
4. In an operator-only deployment config, add the documented Wrangler 4
   `[[ratelimits]]` binding named `UK_AQ_JSONGEN_SIGNER_RATE_LIMIT`, with
   `simple = { limit = 10, period = 10 }` and a `namespace_id` allocated and
   checked for uniqueness across the target account. The checked-in config
   deliberately has no ID or binding. Protect a TEST-only HTTPS route with
   Cloudflare Access Service Auth, using a service token separate from the
   Worker writer token. Do not enable workers.dev, preview URLs or browser
   CORS access. No route is present in this repository configuration.
5. Run separately authorised real TEST checks of signature headers, wrong-body
   checksum rejection, actual size mismatch, immutable repeated PUT/412,
   expiry, auth, per-location rate limits, exact private readback and Worker
   CPU/`exceededCpu`. The service is not accepted as operational until those
   checks pass.

To roll back after a future deployment, disable the Worker enablement variable
or remove the protected route and revoke the writer token. Already issued URLs
remain usable until their short expiry unless the dedicated R2 signing token is
also revoked; rotate that token for immediate URL invalidation. Pending objects
require separate verified retention/cleanup rules. No canonical operation or
JSONgen publication is wired to this Worker in Phase 1.
