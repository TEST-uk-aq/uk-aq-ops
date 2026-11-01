# WHO output-prefix cut-over

Authority: system-docs `4c873cf18260698cc42faf1123665059b878be06`,
`who_2021/r2_output_relocation_contract.md`. This is a future operator procedure;
no deployment, WHO run, R2 copy, configuration change or deletion is authorised here.

## Prepare compatible code at the old root

Set the existing repository variable `UK_AQ_WHO_2021_R2_PREFIX` explicitly to
`history/v2/who_2021/` before deploying the updated authenticated reader or allowing
Actions to use the updated publisher. Add that variable to the private
`env-vars-master.csv` through the existing configuration process; do not commit
the private master. There is no default prefix or cross-environment fallback.

Use the existing bucket, credentials, API routes, six-argument SQL RPC and normal
WHO workflow. **No schema apply or migration is needed. Schema PR #18 is
superseded and should be closed without merging.** That PR and the Schema
repository are unchanged by this simplification. Do not deploy its seven-argument
interface. If it has independently been applied, stop and resolve the actual RPC
state before deploying this six-argument caller.

The publisher validates SQL's legacy WHO Parquet key, extracts only its relative
path and maps it to the configured root. With the old root configured this is an
identity operation. The resulting destination key controls validation, PUT/HEAD,
logical hash and reporting. JSON uses the same configured root. The summary
reader includes its physical key in its existing validated-body cache identity.
Science, source routing, scheduling, concurrency, health and processing/report
uploads remain unchanged. No derived-dataset backup or restore system is added.

## Separately approved TEST cut-over

1. Confirm actual TEST R2 account, endpoint and exact configured bucket using the
   authorised operator configuration. Check effective publisher/reader variables,
   access/lifecycle policy and all scheduled/manual WHO writers. Do not alter or
   run Prune, JSONgen or their retained observations.
2. Hold admission of WHO writers for this window and drain scheduled/manual
   executions. This is an operator action, not an automatic deployment pause.
3. Refresh the complete old-prefix listing with the existing authorised R2 tools,
   following all pagination. Retain a reviewable per-key old-to-new mapping,
   integer sizes, identities, independent byte SHA-256, content types and relevant
   custom/HTTP metadata. The historical **92 objects / 773,057 bytes (15 Parquet,
   77 JSON)** are comparison evidence only; reconcile differences. Do not generate
   missing calendar partitions or historical days. Check any embedded WHO output
   references and stop for review if plain copying would leave invalid references.
4. Completely list `who_2021/` and require the destination to be available. Any
   collision or changed/unclassified source object requires review before writes.
5. Under separate copy approval, use the existing authenticated R2/S3 CopyObject
   facility, such as `workers/shared/r2_sigv4.mjs:r2CopyObject`, for each exact
   reviewed mapping in the same bucket. The helper alone is not an identity or
   collision verifier: recheck the held source and absent destination per key.
   Copy Parquet first, dated JSON next and stable latest last. Preserve bytes,
   content types and custom metadata. No move/delete operation or deployment-time
   copy. Stop on failed or ambiguous results; do not overwrite collisions on retry.
6. Independently GET/HEAD each destination and compare byte SHA-256, sizes and
   relevant metadata to the reviewed source. ETag is an opaque identity, not an
   assumed checksum. Verify source identities/inventory are unchanged and every
   mapped destination exists. A successful CopyObject status alone is insufficient.
   Preserve source and destination evidence before proceeding.
7. Once the full destination is verified and writers remain held, deploy the
   authenticated reader with prefix `who_2021/`. Check private authentication,
   public summary, cold and conditional ETag reads, equal-day updates and normal
   missing/invalid/stale behaviour. No new public route or old-root fallback.
8. Set the publisher to the same new prefix and resume only authorised WHO
   processing. Through real TEST operation verify daily/correction and rolling/
   calendar behaviour, output ordering, actual destination/report keys, summary
   freshness and no old-root writes. Leave `UK_AQ_R2_HISTORY_VERSION`, canonical
   observations and normal observation backups unchanged. The destination key
   participates in Parquet logical identity, so the first new-root publication can
   legitimately rewrite copied objects once without changing the science.
9. Retain original objects and evidence for an operator-owned rollback period.
   To return to the old root after new publications, hold writers and first
   reconcile newer accepted results; do not repoint to a stale frozen latest.
   Old-object retirement is a separate exact per-key decision requiring consumer
   closure and demonstrated historical regeneration inputs, or explicit acceptance
   of loss. Regeneration needs authoritative observations, hour-ending boundaries,
   guideline/configuration/calculation state and any necessary derived DB state;
   it is not automatically byte-identical restoration. No deletion commands are
   supplied here.

Existing Dropbox processing reports continue at their existing destination. They
are not dataset backups. No independent WHO snapshot, restore test, backup flag,
new schedule or retention job is a prerequisite. Real TEST cut-over acceptance is
pending separate approval; LIVE promotion requires its own approved operation
using identical application code and environment-specific configuration.
