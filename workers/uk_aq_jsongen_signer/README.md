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
headers and `state: signed_upload_intent`. Identical source metadata yields
the same key and intent ID. A fresh 60-second URL may be issued for that key;
the signed `If-None-Match: *` should make a repeated PUT return 412 rather than
overwrite it. The caller must use the exact returned headers. The URL is a
bearer capability and must not enter logs, artifacts or public clients.

## Signing boundary

The existing `workers/shared/r2_sigv4.mjs` uses Node crypto and signs immediate
requests. This Worker uses Web Crypto to construct S3 SigV4 query authentication
for `PUT` on the exact bucket/key at the fixed Sleepercar TEST R2 S3 endpoint.
The canonical signed headers are `host`, `content-type`, `if-none-match` and
`x-amz-checksum-sha256`. The checksum value is the declared compressed SHA-256
in S3 base64 form. SigV4 uses `UNSIGNED-PAYLOAD`; the checksum header's actual
R2 enforcement, conditional 412 semantics and URL expiry require separately
authorised real TEST checks. `Content-Length` is not signed. The future private
reader must independently verify stored compressed byte length and SHA-256,
decompress within bounds and verify uncompressed length and SHA-256. Neither a
matching object key, ETag, checksum assertion nor PUT response is a verified
source. This Phase 1 Worker performs no readback.

Errors contain only a bounded code: `disabled`, `invalid_endpoint`,
`invalid_signing_configuration`, `authentication_failed`, `rate_limited`,
`rate_limit_unavailable`, `request_too_large`, `invalid_request`,
`unauthorised_writer`, `invalid_generation`,
`invalid_scope_or_object_identity`, `unauthorised_scope` or `signing_failure`.

## Later manual TEST setup

No setup or deployment is performed by this change. A separate review must:

1. Confirm ownership of `uk-aq-chart-history-json-test` in the Sleepercar TEST
   Cloudflare account and provision a narrowly scoped R2 S3 credential able to
   `PutObject` only under `managed/jsongen/v1/pending/unverified/`. It must
   support conditional PUT and the checksum header. It must not be a canonical
   R2 writer credential.
2. Add the Worker secrets `UK_AQ_JSONGEN_SIGNER_R2_ACCESS_KEY_ID`,
   `UK_AQ_JSONGEN_SIGNER_R2_SECRET_ACCESS_KEY` and
   `UK_AQ_JSONGEN_PRUNE_WRITER_TOKEN` (at least 32 unpredictable characters).
   Rotate/revoke the writer token independently of the R2 signer credential.
3. Supply a reviewed deployment config with a bounded comma-separated
   `UK_AQ_JSONGEN_PRUNE_CONNECTOR_IDS` allowlist and set
   `UK_AQ_JSONGEN_SIGNER_ENABLED=true`. Keep `UK_AQ_ENV_NAME=TEST`. The checked-in
   allowlist is empty and enablement is false.
4. Retain the configured Cloudflare rate-limit binding and its 10 requests per
   10 seconds per writer rule. The Worker fails closed if the binding is absent
   or errors. Protect a TEST-only HTTPS route with Cloudflare Access Service
   Auth, using a service token separate from the Worker writer token. Do not
   enable workers.dev, preview URLs or browser CORS access. No route is present
   in this repository configuration.
5. Run separately authorised real TEST checks of signature headers, wrong-body
   checksum rejection, immutable repeated PUT/412, expiry, auth, rate limits,
   exact private readback and Worker CPU/`exceededCpu`. The service is not
   accepted as operational until those checks pass.

To roll back after a future deployment, disable the Worker enablement variable
or remove the protected route and revoke the writer token. Already issued URLs
remain usable until their short expiry; pending objects require separate
verified retention/cleanup rules. No canonical operation or JSONgen publication
is wired to this Worker in Phase 1.
