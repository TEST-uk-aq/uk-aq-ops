# Managed JSONgen foundations and pending Prune source

## Stage 3A signed Prune source handover (code only; default off)

Selected-v3 Prune can offer its exact frozen connector-day NDJSON before
canonical connector publication. The TEST-only flag
`UK_AQ_JSONGEN_PRUNE_PENDING_SOURCE_ENABLED` defaults to false. The handover
uses the merged JSONgen signer `POST /v1/upload-intents` and the dedicated
writer bearer and Cloudflare Access client credentials described in the
[Prune README](../../workers/uk_aq_prune_daily/README.md). Prune never receives
R2 write credentials for this path. The signer selects an immutable private
`managed/jsongen/v1/pending/unverified/prune_daily_v3/...` key and returns a
60-second conditional PUT URL. Prune authenticates its metadata against the
frozen source and sends exactly the signed headers and gzip bytes. There is no
second descriptor object. A version-1 pending evidence description is prepared
from the frozen bytes and can be reproduced by the inactive private reader. It
names the TEST v3 Prune attempt, complete connector/day and physical scope,
source identity, exact NDJSON and gzip hashes and lengths, effective status
counts, signer intent, object reference and PUT disposition. The description
and its SHA-256 are transient writer data; the immutable gzip object is the
only derived object offered for retention.

The source keeps original row multiplicity, order, timestamp and numeric JSON
values. Preparation is bounded at 100,000 rows, 32 MiB original, 8 MiB gzip
and 128 scopes. Signer and PUT share a 15-second deadline; the optional stage
starts only with extra headroom reserved for canonical publication and v3 run
finalization. 2xx records `put_acknowledged_unverified`, not verified retention.
A 412 conditional conflict needs separate readback; 409, 5xx and transport
failures are ambiguous. No retry or source readback happens in Prune. The inactive `prune-pending-verification.mjs` helper can independently read
bounded private bytes, decompress and compare original byte and source
identities. It is not invoked by Prune and does not grant final writer authority.
Source cleanup and canonical deletion gates keep their existing rules. There
is no approved automatic expiry, complete-source receipt or publication
eligibility from an upload intent or PUT acknowledgment.

**Verified Stage 3A receipt creation is blocked.** The compact source's
`status` is projected to effective `verification_status`; it is not authenticated
original provider status. The version-1 pending description classifies original
status as `original_source_status_unavailable`, with `source_status: null`
meaning no original-provider assertion. Historical authenticated canonical
null remains null. No age-based R inference or AURN default-P rewrite occurs;
the AURN presentation policy and ratified-R protection remain owned by canonical
authority, and no AURN-specific rule is applied to other connectors.

After the v3 batch finalizer passes and the original protected candidate/gate
transaction returns, Prune can prepare a version-1 original-final evidence
envelope. It compares the pending partition content hashes, counts and effective
statuses with the original canonical child manifests, and captures already-read
connector/child manifest byte identities, canonical file metadata, selected-v3
exact-scope references, final batch references and the gate return boundary.
It adds no routine Parquet read and no derived R2 readback to canonical Prune.
The preparation is transient memory only, with an unretained/unverified authority
state. Mutable canonical keys and a later CONSUMED gate cannot reconstruct the
original publication; no independently authenticated gate transaction receipt
or immutable final snapshot is currently retained. The Stage 1 receipt
additionally requires independently meaningful before/after,
binding, provenance, scope-completeness and retained-receipt authority
references. Current Prune finalisation returns verified aggregate/index/latest
control-flow evidence but does not retain a byte-pinned, complete
source-to-final-publication proof across interruption. PostgreSQL gate-only
recovery remains disabled by its own contract. This code therefore does not
produce a bundle or receipt, promote `authenticateFinalPublication()`, mutate
managed control, dispatch JSONgen, or select monthly publication. Stage 3B
must define durable final writer evidence, gate-recovery ownership, missing
registration detection and an outbox/inventory before complete coverage can
be claimed. The existing `selectManagedPublications()` blocker remains.

The v2 Prune path does not enter this handover. Before any TEST activation,
perform a separately authorised controlled Prune run to verify dedicated
bucket permission, conditional PUT/readback, byte and row limits, source
cleanup, canonical finalisation, PostgreSQL gate behavior and restart review.
No such operational acceptance is implied by local checks.

This directory is an **inactive Node ESM library**, independent of the experimental
`scripts/compressed_chart_history` publisher and its selector. There is no CLI,
workflow, writer trigger, regeneration, bootstrap, deployment or serving integration.
Do not invoke its R2 operations without separate operational authorisation.

Stage 2 adds bounded immutable input verification, committed-metadata inspection,
and explicit reconciliation reporting. It does **not** establish final-source
authentication, complete receipt coverage, or a publication-ready current scope.
All classifications that require those proofs remain reconciliation-required.

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
| `inspectSourceGeneration` | Separate selected-v3 namespace check for already retained Stage 1 receipts; a matching namespace is not current selector or final-writer proof |
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

## Stage 2 evidence readers and current limits

`inputs.mjs` reads only exact managed receipt and bundle keys from the private
derived bucket using `r2GetObjectBounded`. It checks the reference key against
the content SHA-256, exact compressed and uncompressed byte counts and digests,
canonical receipt JSON, Stage 1 schema, stable identity against a registered
receipt when supplied, and every NDJSON scope and row. A gzip input must contain
exactly one complete record per declared scope. Rows retain physical identity,
exact UTC millisecond timestamps, values, multiplicity, original source status,
effective verification status, and genuine missing values. Empty records must be
explicitly declared, with a declared absence authority. A declared authority is
not independent proof of final canonical absence. Integrity verification returns
`writer_authenticated: false`.

`writer-authentication.mjs` records the inspected finalisation boundaries for
Prune Daily v3, Integrity v3, SOS-light v3 and future IFW. Its interface always
returns a fail-closed result. Prune's final v3 batch validates parent/aggregate/
exact/latest metadata, but its frozen source temporary object is removed before
the final batch verification. Integrity/SOS final VERIFY checks the resolved
view, persistence and bindings; successful APPLY or an overlay file alone cannot
bind arbitrary bundle rows to that view. The installed Pro runner and retained
TEST verification evidence are unavailable here. IFW has no accepted canonical
repair publication. A writer-owned adapter must retain the complete final source
and prove its relationship to the bundle, original verified publication,
source/status/binding evidence and removals. No adapter claims to do so today.

The selected complete generation is the exact immutable shared
`getObservationHistoryGeneration('v3')` descriptor. Its canonical observations,
Core, exact observation index and binding roots are respectively
`history/v3/observations`, `history/v3/core`,
`history/_index_v3/observations_timeseries` and
`history/_index_v3/timeseries_binding`. Logical observation and binding payload
`history_version=v2`, binding object schemas 1/2, physical
`timeseries-aligned-v2`, and physical writer/schema 3 or future 4 retain separate
meanings. A supplied prefix that contradicts the shared descriptor fails closed;
the binding prefix defaults to that descriptor. No v2 binding or observation
prefix is a selected-v3 fallback.

Stage 1 receipt wire schema version 1 is unchanged. `assertSource` validates its
declared shape, while `inspectSourceGeneration` separately reports matching,
contradictory or unresolved v3 namespaces without rewriting retained receipts.
The immutable receipt and bundle readers authenticate exact bytes, size and SHA;
they do not prove that a supplied descriptor is the deployed current generation.
Current canonical authority needs an independently resolved accepted selector;
historical receipt identity, object existence and a stable metadata reread do not
provide it. Final writer publication and complete replacement/status evidence
need the still missing writer adapters. Reconciliation keeps each distinction
explicit and never promotes a consistent namespace to authenticated source.

`authority.mjs` follows the committed observation root through year, month, day,
connector and pollutant, using existing shared validators and hash/alias rules.
It distinguishes root-proven absence from failed or ambiguous metadata reads.
It inspects actual index_v3 exact/scoped/leaf metadata and aligned source
references, verification latest/manifest and physical binding metadata. It now
reads the selected aligned shard itself and checks its exact key, byte size,
SHA-256, canonical encoding, kind, source pollutant identity, range, timeseries
membership, row counts, segment file references and physical file identities.
The shared exact-leaf reader validates the leaf and its own segment coverage;
it does not read the aligned shard. This bounded shard link check adapts the
useful part of PR #95's `canonical.mjs`. Its v2 inspection fallback and positive
`SUPERSEDED` claim from supplied root metadata were not adopted. It uses
the caller's explicit canonical bucket and generation paths, not index_v3 latest
as a parent or a guessed physical storage path. Every metadata GET is size and
time bounded and its digest is rechecked before returning. `compareScopeMetadata`
can say two inspected scope snapshots match or differ, including an independent
scope; it cannot call a later snapshot an authenticated supersession without
writer origin, final rows and complete coverage. The authority reader therefore
sets `authority_complete: false` even for a consistent metadata read. The selected
v3 generation, verified identity of the root bytes read, internally linked
metadata, and an unchanged bounded reread are distinct facts. They do not prove
that this root was the latest committed canonical authority or create a locked
snapshot. The inspector retains each present scope's independently checked
physical schema/writer identity, so schema 3 and 4 may coexist across scopes.
It does not reconstruct status from Parquet or equate the distinct observation
and measurement content-hash versions.

Selected-v3 binding inspection retains logical `history_version=v2` and accepts
schema 1 exact bindings alongside schema 2 continuity bindings. Schema 2 is
checked as a complete physical family: unique positive members in deterministic
`valid_from_day_utc`, `timeseries_id` order, real UTC calendar dates, inclusive
validity intervals with no overlap or multiple open-ended members, and exact
top-level physical membership. Gaps remain gaps. The continuity key must match
connector, UK-AIR reference and pollutant; stable reference fields are checked.
The active shared producer currently requires a non-null `site_ref`, while the
continuity contract permits null and requires agreement only among non-null
values. The inspector accepts null as corroborating identity, never as a
substitute for `uk_air_ref`. The shared source-row builder sorts and materialises
families, so it cannot validate the ordering of an already published binding;
this bounded read validator rejects contradictory published payloads.

Verification mode is connector scoped. An independently accepted pre-overlay
mode with physical schema 3 reports `embedded_status_requires_writer_evidence`;
the embedded P/R/null values still require the original writer's final proof.
An accepted overlay mode requires a validated current `verification/latest.json`
selection and its exact immutable connector manifest, including physical
timeseries membership. It supersedes embedded schema-3 status. Schema 4 cannot
use embedded status and remains unresolved without selected accepted overlay
authority. A valid pointer or manifest alone is metadata, not operational
cut-over acceptance or bundle status authentication. Missing, failed, malformed,
contradictory or changed overlay authority fails closed. Without independently
established connector transition mode, the inspector reports unknown or
overlay-authoritative unresolved state, never silent embedded/null fallback.
`acceptedVerificationModes` is an explicit input for a later trusted acceptance
source; no such provider is wired into this inactive stage. Its caller must
establish that evidence outside JSONgen before supplying a mode.

For a scope whose complete parent membership proves current physical absence,
verification is `not_applicable_to_absent_scope`: there are no rows or physical
schema from which to select embedded or overlay status. Binding authority is
still inspected separately, and missing references or metadata drift do not
become authoritative absence. Current absence does not authenticate the
originating writer's final removal, complete replacement bundle, registration
coverage or supersession.

Report schema remains version 1 with existing diagnostic objects and an optional
per-scope physical identity. Historical receipts are not changed. Old reports
that claim an `_index_v2` binding prefix as selected-v3 authority now fail
validation; they remain immutable historical evidence. Metadata drift and
writer-authentication gaps remain unresolved diagnostics, not supersession.
Version-1 report validation accepts `not_applicable_to_absent_scope` only with
`physical.membership=authoritative_absent`, without selected overlay or embedded
status fields. Existing immutable diagnostic reports keep their historical
representation. Managed monthly publication selection remains disabled.

`reconcile.mjs` compares a bounded control snapshot, registered receipt references,
explicit retained references and requested canonical scopes. It preserves evidence
for each scope of a multi-scope change, including matching/different declared
metadata pins; it does not choose a winner by arrival or registration order.
Different physical scopes remain separate. It flags a retained receipt missing
from registration, a missing bundle, a requested current physical scope without
a registered receipt, unavailable canonical metadata and unknown global receipt
coverage. Metadata alone cannot identify every missing event; a durable verified
writer outbox or equivalent inventory is still needed. Every result has
`state: reconciliation_required`, `complete_change_coverage: false`, and
`freshness: unknown`. A matching pin is never promoted to current/authenticated;
a changed pin is never promoted to superseded. Explicit empty scopes also require
independent original writer absence proof. The report retains desired/applied and
selected monthly dependencies and PM rolling/adjacent-month effects; it does not
calculate AQI or alter the selected pair. `reconciliationArtifact` makes a
SHA-addressed immutable report, `retainReconciliationReport` conditionally stores
and reads it back, and an explicitly invoked `recordReconciliationRequired` can
record its reference via the existing CAS `record_failure` transition. There is
no schedule, dispatcher, or automatic remote operation.

`control-snapshot.mjs` captures exact original-byte control identity, while
`report-validation.mjs` validates the version-1 reconciliation report before
any immutable retention or control mutation. It checks fail-closed states,
physical scopes, receipt references, registered/retained distinctions, canonical
metadata state, logical hash metadata, PM/NO2 affected months, selected/desired/
applied dependencies, resource counters and internally checkable links. Unknown
or positive authenticated claims fail. A report remains diagnostic evidence;
its SHA-256 and structural validity do not authenticate a writer or canonical
currentness. `reconcileManagedInputs` can accept the exact `readManagedControl`
result as `controlRead`; its raw body and digest are checked against the control
being inspected. Without that result, the report marks its control hash as a
`canonical_projection` and may be retained but cannot record a global failure.
For an exact read, `recordReconciliationRequired` retains the immutable report,
then supplies its control ID, revision, operation ID and original-byte SHA-256
as a precondition to Stage 1 `record_failure`. That precondition is rechecked
inside every CAS attempt. If control changed before or during recording, the
report survives, no stale failure is applied, and the result is
`stale_reconciliation_inspection` with `new_inspection_required: true`.

The provisional per-operation admission bounds in `limits.mjs` are 1 MiB for a
receipt, 8 MiB compressed and 32 MiB uncompressed per bundle, 8 MiB per NDJSON
record, 128 scopes, 100,000 rows per bundle, 32 receipt references, 256 canonical
metadata GETs of at most 8 MiB each, 64 MiB cumulative derived/metadata/decompressed bytes, 200,000
cumulative rows, 4 MiB per report and 60 seconds. Bounded GET uses one attempt
and a deadline; gzip output is capped before full materialisation. Exceeding a
bound fails closed; operations must be explicitly partitioned. These are safety
caps, not approved production capacity, control growth policy, writer-outbox
retention or an evidence garbage-collection rule. The Stage 1 4 MiB control cap
remains a protective admission limit. Future operating decisions must set actual
receipt/bundle size, throughput, retention, missing-request and failed-dispatch
policies before live use.

## Validation, remaining work and rollback

Run `node --test --test-isolation=none tests/jsongen_stage2.test.mjs
tests/r2_sigv4.test.mjs`, syntax checks and `git diff --check`. The narrow Stage 2
tests exercise bounded byte identity, complete scope membership, absence rules,
aligned-shard defects, metadata comparisons and drift, registration gaps,
stale-control/CAS fencing, report rejection and ambiguous retention readback,
unavailable writer evidence and the disabled selector. They do not simulate a
verified production writer.

Real TEST acceptance after separate deployment requires approved scoped credentials
and conditional PUT/readback checks; retained final Prune and Integrity/SOS writer
evidence; a writer-owned complete-source-to-bundle adapter verified against real
final publications and authoritative removals; overlapping/delayed and independent
scope checks; a missing-registration/outbox interruption; PM late-month and
following-month context checks; bounded large inputs and ambiguous writes. The
selected complete-v3 serving generation and each connector's accepted pre-overlay
or overlay cut-over mode also need independent operational evidence. A valid overlay
pointer, repository support or missing pointer does not supply that evidence. Keep
the selector disabled until those proofs, complete coverage, selected baseline and
all-month dependencies are independently authenticated.

Next: add a real writer-owned final-source handover and durable receipt coverage,
complete canonical-scope dominance, approve practical limits and retention,
implement authenticated immutable pair/payload readback and current-scope-checked
all-month selection, then the bounded baseline/context regeneration path. Keep
canonical writers non-blocking and metadata-only reconciliation fail-closed.
Workflow, triggers, bootstrap/rebuild,
identity allowlists and website/Refresh/open-month integration remain later work.

Rollback before deployment is to revert this code change. Existing same-day
JSONgen archive copies were reused and the exact immediate pre-change source
remains in the parent commit; active code does not import archive paths. Nothing
was deployed or operationally accepted.
Normal station history, R2-first/ingestdb gap filling, the experimental selector,
canonical writers, deletion gates, backups and LIVE remain unchanged. No managed
JSONgen artefact enters Dropbox backup.

## ChatGPT system-documentation handover (do not apply from this repository)

The authoritative 12 October contracts already resolve complete-v3 observations,
index and binding paths; no further contract edit was needed for this correction.
Record Stage 2.6 as a bounded, inactive diagnostic implementation after code review.
Its connector mode input still lacks an accepted runtime provider, final writer
adapters and complete receipt outbox; current selector and operational acceptance
remain unproven. Authoritative `uk-aq-system-docs` was not edited.
