# Managed JSONgen Stage 1 foundations

This directory is an **inactive Node ESM library**, independent of the experimental
`scripts/compressed_chart_history` publisher and its selector. There is no CLI,
workflow, writer trigger, regeneration, bootstrap, deployment or serving integration.
Do not invoke its R2 operations without separate operational authorisation.

## Implemented and deliberately blocked

Implemented: additive one-attempt conditional R2 PUT; strict runtime wire validators;
immutable complete-day receipt/bundle descriptors and row validation; monthly UUIDv4
pair descriptors; explicit failures; and CAS control initialization, receipt retention
and failure reporting. These modules import only Node built-ins, the existing R2
helper and existing AQI constants. They never read canonical Parquet, Integrity
SQLite/journals or index_v2 observations. They never write canonical history.

**Authenticated canonical-scope precedence, complete receipt coverage and
final-source authentication remain unresolved.**
`selectManagedPublications()` always fails with
`verified_event_ordering_unavailable`. No public mutator can set a selection,
change an applied dependency set, resolve canonical precedence, or declare absolute freshness.
This is an intentional Stage 1 boundary, not an operational publisher.
The retained error identifier denotes unverified canonical precedence/receipt
coverage; it does not require a numeric cross-writer event sequence.

`retain_receipt` retains a writer's syntactically valid final-verification attestation
and readback-authenticated immutable receipt bytes. It does **not** authenticate that
the bundle represents the writer's final canonical publication. Entries explicitly
carry `authentication_state: pending_writer_adapter`, `ordering_state: unresolved`
and `state: reconcile_required`. The field `registered_changes` is a durable intake
register, not an approved current-canonical dependency frontier. No event becomes eligible for
publication merely by entering it. Unknown/missing final evidence requires later
reconciliation, never a reconstructed empty source or Parquet fallback.

## Storage and configuration

The only mutable object is:

```text
bucket: uk-aq-chart-history-json-test
key:    managed/jsongen/v1/control/current.json
```

Other schema-defined paths are immutable (this stage does not upload them):

```text
managed/jsongen/v1/receipts/<SHA256>.json
managed/jsongen/v1/bundles/<compressed-SHA256>.ndjson.gz
managed/jsongen/v1/evidence/<SHA256>.json
managed/jsongen/v1/manifests/<SHA256>.json
managed/jsongen/v1/publications/connector_id=<N>/timeseries_id=<N>/station_id=<N>/pollutant=<code>/month_utc=<YYYY-MM>/<UUIDv4>/observations.<compressed-SHA256>.json.gz
managed/jsongen/v1/publications/connector_id=<N>/timeseries_id=<N>/station_id=<N>/pollutant=<code>/month_utc=<YYYY-MM>/<UUIDv4>/aqi.<compressed-SHA256>.json.gz
```

`N` is a canonical positive decimal ID; `<code>` is `pm25`, `pm10` or `no2`.
`publicationPrefix()` validates and constructs the shared immutable pair path.
`monthKey()` retains the separate colon-separated **in-control map key**; it is
never used as an R2 publication path.

Canonical JSON for managed control/receipt/manifest metadata sorts object keys,
preserves array order, uses compact UTF-8 JSON and one trailing newline.
`canonicalJson` produces these bytes. The current canonical observation hash
helper requires exact `YYYY-MM-DDTHH:mm:ss.SSSZ` strings for `observed_at_utc`.
Bundle rows must preserve those exact accepted canonical strings: never round,
truncate or regenerate a timestamp from a less precise input. Original finite
binary64 values, physical identity, multiplicity, source status and effective
P/R/null verification status remain unchanged. Validation does not sort,
deduplicate, interpolate or aggregate rows. The standard JSON negative-zero
representation follows the existing prototype. No observation schema is renamed.
Metadata timestamps also use canonical UTC milliseconds in this schema, but are
separate from observation identity; PM's 23-hour context is an AQI dependency
window, not an observation timestamp precision rule. If accepted canonical
observation precision later becomes finer, the bundle format must preserve it
through an authorised update or fail closed until it can.

`managedR2Config()` reuses the existing dedicated variables:

- `UK_AQ_ENV_NAME=TEST`
- `UK_AQ_COMPRESSED_CHART_R2_ENDPOINT`
- `UK_AQ_COMPRESSED_CHART_R2_ACCESS_KEY_ID`
- `UK_AQ_COMPRESSED_CHART_R2_SECRET_ACCESS_KEY`

It pins the existing Sleepercar TEST endpoint/account and private derived bucket,
uses region `auto`, and rejects reuse of a supplied canonical access key. There
are no new secrets, environment names, dependencies or infrastructure. Credentials
must eventually permit managed-prefix GET and conditional PutObject. Actual R2
conditional support **with the scoped TEST credential** is not verified here;
that requires the separately authorised targeted remote check. No such check was run.
The 4 MiB control admission cap is a protective library limit, not accepted scale
or retention policy; GET currently uses the existing buffered R2 client.

## R2 conditional operation

`r2PutObjectConditional({r2, key, body, if_match, if_none_match, content_type, sha256})`
requires exactly one strong quoted ETag or `if_none_match: '*'`. Conditions and the
body SHA-256 are signed by the existing SigV4 implementation. There is one PUT
attempt, with the existing timeout, and **no transport/status retry**.

| Result | Semantics |
| --- | --- |
| 2xx with strong ETag | Request acknowledged; managed control still reads back exact bytes/operation ID |
| 412 | `R2_PRECONDITION_FAILED`; no silent retry against that ETag |
| 409, timeout/transport, retryable status/5xx, missing success ETag, malformed result | `R2_WRITE_AMBIGUOUS`; caller must inspect authoritative state before deciding |
| Other service rejection | `R2_SERVICE_FAILURE`, with HTTP status |
| Invalid condition/digest or unsupported adapter | Local error before PUT |

Existing `r2PutObject`, GET, HEAD, copy, delete, listing, retry policies and adapter
methods are unchanged. A conditional adapter must explicitly implement
`putObjectConditional`, perform exactly one atomic request, and return
`{status, etag}`. It must return a 412 status for precondition failure; thrown
adapter failures are conservatively ambiguous. There is no fallback to
`adapter.putObject`. Strong ETags are passed unchanged, including quotes.

## Executable schemas

`schema.mjs` exports throwing `assert*` validators; unknown fields, unsupported
versions and inconsistent cross-references fail closed. Schema version is `1`.
These are contract structures, not authenticated proof by themselves.

| Validator | Required meaning |
| --- | --- |
| `assertIdentity` | Positive connector/timeseries/station IDs plus `pm25`, `pm10` or `no2`; physical identity only |
| `assertReference` | Explicit bucket/key, SHA-256, positive byte size; gzip also has uncompressed SHA-256 and size |
| `assertSource` | `index_generation: v3`, logical `history_version: v2`, separately pinned generation authority, observation root, v3 index authority, final publication, verification and binding authority, verification timestamp |
| `assertReceipt` | Stable change ID, generic writer/invocation identity, source, complete-day scopes, before/after authenticated membership references, affected months, rolling implications, immutable bundle, final-verification/provenance/completeness references, retained writer receipt authority |
| `assertBundleRecord(s)` | One complete-day NDJSON record per declared scope, exact identity/day, original rows and declared final row count; explicit `authoritative_empty` requires zero rows and an absence authority; omitted/duplicate scopes fail |
| `assertPublication` | One UUIDv4, physical identity/month, source, applied change-ID set, shared algorithm, coverage, immutable observation/AQI pair, evidence and PM context |
| `assertControl` | Control identity/revision/operation/predecessor digest, unresolved ordering, intake register, desired/applied sets, selected pair/manifest references, freshness/source-as-of, pending/failed/reconciliation states |

A receipt's `bundle` has `schema_version`, `format: complete_scope_ndjson_gzip`,
`change_id`, `object`, `scope_count` and `row_count`. Its uncompressed digest fields
are named `json_sha256`/`json_byte_size`, as for the existing prototype, and refer
to the **entire NDJSON byte stream**. Each line has `{identity, day_utc, state, rows}`;
rows have `connector_id`, `timeseries_id`, nullable `station_id`, `pollutant_code`,
`observed_at_utc`, `value`, `source_status` and `verification_status`. The writer
must retain complete final rows and authenticated membership, including removals;
JSONgen does not reconstruct them from writer internals. The immutable receipt's
`durability.retained_receipt_authority` identifies separately retained writer
verification evidence, not a self-referential digest of that same receipt.

Receipt durability starts at `verified_pending`; mutable lifecycle values are
`verified_pending`, `dispatch_attempted`, `dispatch_accepted`, `dispatch_ambiguous`,
`generation_attempted`, `selected`, `failed_retryable`, `superseded`, and
`reconcile_required`. Stage 1 intake only records `reconcile_required`; no dispatch
or generation lifecycle driver is implemented.

Every monthly pair shares one pubID in both product descriptors. Both compressed
and uncompressed digests/sizes are mandatory. Source and dependency evidence are
shared by the pair manifest. `coverage` independently represents observation and
AQI completeness, row/missing-hour counts and reasons; required publication
**authority** must be complete even when hourly observations have legitimate gaps.
PM context pins the previous month's selected manifest, observations, pubID,
applied dependencies and preceding 23-hour interval. NO2 context is explicitly
empty. All use `aqilevels_hourly_v2`, with the shared PM 24-hour/18-valid-hour
constants. No AQI calculations were changed or duplicated.

`affectedMonths()` includes the following month for a PM complete-day replacement
on the final UTC day. Intake updates all those month entries in the same control
CAS. A future selector must publish an affected set atomically and authenticate
its context against current desired dependencies; that transition is blocked here.

## Control transitions and failure handling

`updateManagedControl({r2, command, maxConflicts})` only supports:

- `{type: 'initialize'}`: explicit empty-control initialization with `If-None-Match: *`.
- `{type: 'retain_receipt', receipt, receipt_object}`: verify immutable receipt
  readback, retain its evidence, union its change ID into every affected month's
  desired set, preserve all applied/selected/unrelated entries, mark reconciliation.
- `{type: 'record_failure', failure, month_key?, expected_desired_change_ids?, expected_pub_id?}`:
  preserve selections; scoped failure reporting requires exact expected dependencies.

Change-ID lists are sorted **sets**, never a cross-writer ordering rule. A repeated
change ID with different receipt/evidence is rejected. Every registered affected
month must exist and its desired set must contain exactly all retained required
changes. Existing selections must match their manifest digest, identity and applied
set. Control revisions protect the control only and are never canonical event order.

A 412 rereads the control, revalidates it, and reapplies only the bounded command
with a fresh operation ID/ETag, at most three conflicts by default. Unrelated
entries survive. Stale scoped failure commands are superseded. Successful or
ambiguous PUTs reread authoritative control and compare exact bytes and operation
identity. An indeterminate/newer state is returned as reconciliation-required,
without another PUT. Failures to inspect are also ambiguous. Ambiguity errors
must be retained by the future caller; a failed control write cannot safely
record its own failure through an unconditional replacement.

Explicit failure codes cover missing authenticated baseline, corrupt monthly JSON,
missing preceding context, invalid provenance, missing verified replacement bundle,
incomplete registration, conditional conflict, ambiguous write, superseded candidate
and the unresolved-precedence blocker. Failure states do not invoke recovery or reverse canonical
success. No automatic canonical GET or reconstruction exists in these modules.

## Canonical-state dominance and final-authority blockers

Inspected authority and code:

- `observations_run_exclusion_contract.md`: one session-level advisory lock
  serializes canonical operations and verification. Lock acquisition order is
  not a source-precedence rule.
- `workers/shared/uk_aq_r2_history_writer.mjs`: lock identity, owner/run/nonce,
  session lifetime, health checks and release. These identify ownership, not
  a replayable source-precedence frontier.
- `finalizePublishedPhaseBConnectors` and its v3 result validator in
  `workers/uk_aq_prune_daily/phase_b_history_r2.mjs`: verified canonical aggregates,
  exact scopes and latest index, followed by existing prune gate completion.
- Current v3 Integrity APPLY persistence and final VERIFY/report paths: final
  object evidence and run-local progress exist, but the common authenticated
  complete-bundle handoff has not been implemented.

If A publishes during a derived outage, B later publishes the same scope and
registers first, A's delayed receipt must not override B. The future selector
must authenticate currently committed observation root/day/connector/pollutant
membership, including authoritative absence; applicable index_v3 exact/scoped
physical membership; and verification/status/binding authority. It must bind
each retained complete-scope bundle to its writer's final verified canonical
publication, reject superseded or unauthenticated receipts, preserve independent
still-current changes, and detect missing registrations. Missing or uncertain
coverage remains reconciliation-required. Index-v3 `latest` is discovery
metadata, not an authentication parent.

Receipt arrival order, workflow completion, control revision/CAS order, pubID,
timestamp, source hash and advisory-lock ownership do not establish canonical
precedence. **A new durable numeric cross-writer sequence is not required.**
The unresolved Stage 1 gate is the exact final-authority-to-bundle authentication
and current-scope/complete-receipt reconciliation seam. The retained ordering
error identifier means those proofs are missing; selection stays disabled.

Writer-specific adapters must also prove that complete bundle rows match final
verified publication, source/status/binding and absence authority. This stage
provides their common schema, not those adapters. No normal JSONgen component
may read their SQLite/journals or infer canonical physical paths from `v3`.

## Validation, remaining work and rollback

Local syntax/import checks and the existing focused `tests/r2_sigv4.test.mjs`
are appropriate here. No broad regressions, remote operations, benchmarks or
simulated integration programme are required. Actual credentials, conditional
R2 operations, overlaps, lost events, PM month boundaries and final source parity
still require separately authorised real TEST acceptance.

Before Stage 2: implement canonical-scope dominance, complete receipt reconciliation
and final-bundle authentication; approve
practical bundle/control limits and retention; implement authenticated immutable
pair/payload readback and current-scope-checked all-month selection; then implement the bounded
baseline/context regeneration path. Keep canonical writers non-blocking and
metadata-only reconciliation fail-closed. Workflow, triggers, bootstrap/rebuild,
identity allowlists and website/Refresh/open-month integration remain later work.

Rollback before deployment is to revert this code change. The original shared R2
module is preserved exactly under `archive/2026-10-11/workers/shared/r2_sigv4.mjs`.
Active code does not import it. Nothing was deployed or operationally accepted.
Normal station history, R2-first/ingestdb gap filling, the experimental selector,
canonical writers, deletion gates, backups and LIVE remain unchanged. No managed
JSONgen artefact enters Dropbox backup.

## ChatGPT system-documentation handover (do not apply from this repository)

Update the future JSONgen implementation status to distinguish these inactive
foundations from a working publisher. Record the managed field/path definitions,
conditional adapter/result protocol, explicit unresolved canonical precedence and pending
writer-authentication states, and disabled selection. Implement canonical-state
dominance, complete receipt coverage and the final-authority-to-bundle seam before describing registration as
publication-eligible. Record actual remote conditional-write acceptance only after
its separately authorised check. No workflow/deployment/default serving status
should change. Authoritative `uk-aq-system-docs` was not edited.

There is also an existing documentation routing discrepancy to reconcile: the
observation schema/current shared generation helper explicitly identify selected
physical v3 observation storage, while the backup umbrella retains logical-v2
path wording. This implementation neither resolves that discrepancy nor infers
physical keys: source descriptors retain explicit authority references unchanged.
