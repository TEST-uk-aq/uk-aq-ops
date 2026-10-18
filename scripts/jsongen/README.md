# Managed JSONgen foundations and pending Prune source

The [Prune-to-JSONgen first TEST acceptance readiness handover](prune-integration-readiness.md)
records current blockers, restricted-reader setup and the ordered manual
acceptance procedure. It documents the next TEST operation; it does not authorize
or execute it.

The manual read-only [Stage 3C currentness/coverage assessment](currentness-coverage-handover.md)
extends the existing reconciler with a key-derived budget and four-worker selected-v3
metadata inspection, physical-scope comparison, compact schema-3 reports and explicit original-event,
receipt/registration and missing writer-inventory coverage. Matching metadata
does not establish complete writer coverage or enable publication. The explicit
manual interface is `scripts/jsongen/reconcile-cli.mjs`; it has not been run
against operational TEST services. No schedule, generator or selector is enabled.
One invocation inspects at most 128 scopes and accounts for up to 1,024 without
omission. `--inspection-partition 0..7` selects a deterministic subset; other
scopes remain uninspected. Separate invocations cannot be merged as one coherent
snapshot. Full-event reports use lossless dictionaries under the unchanged 4 MiB
wire cap; report schemas 1/2 and verified receipt schemas 1/2 remain supported.
Admission requires the sourced `UK_AQ_ENV_NAME=TEST` and existing
`UK_AQ_GITHUB_REPO=OWNER/REPO`, plus `--execute-read-only`. Missing repository
configuration blocks before remote access. GitHub runs must match that configured
repository and use `workflow_dispatch`; the optional private reader shares this
check. The repository key is local-only in the environment target mapping.

The manual-only [independent Prune consumer](prune-consumer-handover.md) implements
Stage 3B for original TEST/AURN first publication: private outbox discovery/replay,
compressed original before/binding/final-authority authentication, strict version-2
VERIFIED receipts, immutable bundle/receipt retention and whole-event atomic
control registration with deterministic crash recovery. Read-only diagnostics
remain separate from explicit `--execute-retain`. This authenticates original
Prune changes; Stage 3C separately assesses current metadata and coverage gaps.
Monthly publication remains blocked.
No schedule or publication is activated. Run
`node scripts/jsongen/prune-consumer.mjs --help` for the explicit CLI.

The common [UK AQ JSONgen workflow](../../.github/workflows/uk_aq_jsongen.yml)
now has a **Stage A manual, local-only diagnostic**. See [Stage A operation](#stage-a-manual-diagnostic-operation)
below. It is executable code, but it is not an enabled managed monthly publisher.

The separate [manual Dropbox historical bootstrap](bootstrap/README.md) creates
bounded local/private monthly observation/AQI candidates from an explicitly pinned
completed TEST backup. Its versioned candidate evidence is not a managed writer
receipt/publication. It does not activate pending Prune source, managed selection
or chart serving; its first real TEST run requires separate operator authorisation.

## AURN Prune writer handover (code only; no operational acceptance)

Selected-v3 Prune can offer its exact frozen connector-day NDJSON before
canonical connector publication. Only connector `1` (AURN) is currently admitted;
other connectors retain canonical processing without requesting signing or an outbox.
The TEST-only flag
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
and 1,024 physical scopes per complete pending connector-day. Stage 1 receipt
and general consumer limits remain 128 scopes. No rows or pollutants are filtered
to make a source fit. See the [writer interface](prune-writer-handover.md) for
capacity evidence, all coupled limits, diagnostics and deterministic outbox replay.
Signer and PUT share a 15-second deadline; the optional stage
starts only with extra headroom reserved for canonical publication and v3 run
finalization. 2xx records `put_acknowledged_unverified`, not verified retention.
A 412 conditional conflict needs separate readback; 409, 5xx and transport
failures are ambiguous. No retry or source readback happens in Prune. The inactive `prune-pending-verification.mjs` helper can independently read
bounded private bytes, decompress and compare original byte and source
identities. It is not invoked by Prune and does not grant final writer authority.
Source cleanup and canonical deletion gates keep their existing rules. There
is no approved automatic expiry, complete-source receipt or publication
eligibility from an upload intent or PUT acknowledgment.

The writer does not issue VERIFIED receipts; the independent Stage 3B consumer
now supplies that boundary using merged PR #113 original authority. The compact source's
`status` is projected to effective `verification_status`; it is not authenticated
original provider status. The version-1 pending description classifies original
status as `original_source_status_unavailable`, with `source_status: null`
meaning no original-provider assertion. Historical authenticated canonical
null remains null. No age-based R inference or AURN default-P rewrite occurs;
the AURN presentation policy and ratified-R protection remain owned by canonical
authority, and no AURN-specific rule is applied to other connectors.

After the v3 batch finalizer passes and before the original protected candidate/gate
transaction begins, Prune can prepare a version-1 original-final evidence
envelope, including the full original pending-source description and physical
scope membership. It validates both source-description digests, exact signed
object identities and the frozen source identity used by the gate. It compares
the pending partition content hashes, counts and effective
statuses with the original canonical child manifests, and captures already-read
connector/child manifest byte identities, canonical file metadata, selected-v3
exact-scope references and final batch references. When bounded, its versioned
`original_metadata_snapshot` also stores exact bytes for the canonical
connector/pollutant manifests, published exact-v3 aligned shards/leaves/scoped
roots, every affected day manifest, affected aggregate ancestors and latest-global index.
These are selected from the writer's verified publication references, with
byte hashes and lengths checked against exact bytes observed in its existing
PUT/readback path. This adds no R2 request. The envelope explicitly
does not assert a successful gate commit before the transaction runs.
It adds no routine Parquet read and no derived R2 readback to canonical Prune.
When the TEST-only handover is enabled, the restricted function defined in merged
Schema PR #11 may retain the exact bounded preparation bytes with original
gate acceptance inside the same protected PostgreSQL transaction. A failed
optional insert can be rolled back to its savepoint while an otherwise valid
gate commits. A committed gate with no event yields `outbox_missing`, not a
discoverable receipt. An immutable-key conflict yields `outbox_unresolved`
until the existing row is independently compared. A retained row is append-only original gate evidence,
not independent final-publication authentication or current authority.
Mutable canonical keys and a later CONSUMED gate cannot reconstruct missing
original bytes. If any required byte is absent, the bounded capture or the
1 MiB database envelope limit is exceeded, a successful optional outbox insert
records `final_evidence_state=not_captured`; the run logs the coverage gap. The
8 MiB / 4,096-object transient capture ceiling prevents unbounded writer memory use. A
bounded snapshot remains `prepared_unverified` until a separate reader
authenticates its bytes, relationships, original source and canonical authority.
Merged PR #113 additionally retains original first-publication absence, Core-owned
selected-v3 binding completion and their original lock/source/publication relationships.
Its schema-1 outer envelope carries nested schema-2 markers and the bounded
`canonical_json_gzip_v1` metadata representation. The independent consumer decodes
and authenticates these bytes without changing the writer format. Strict version-2
receipts preserve Stage 1 source/scopes/bundles and represent original provenance,
scope completeness and durability with a typed immutable PostgreSQL outbox authority.
See the [original authority handover](prune-original-authority-handover.md) and
[consumer handover](prune-consumer-handover.md) for exact mappings and limits.
Current Prune finalisation returns verified aggregate/index/latest
control-flow evidence; the optional snapshot and outbox may now retain exact
writer-produced metadata, but do not independently authenticate it. PostgreSQL gate-only
recovery remains disabled by its own contract. The producer therefore does not
produce a bundle or receipt, promote `authenticateFinalPublication()`, mutate
managed control, dispatch JSONgen, or select monthly publication. After an explicit
PostgreSQL `COMMIT` command acknowledgement, a retained row can produce the small
version-1 post-commit reference described in the [writer interface](prune-writer-handover.md).
It can be reconstructed from the immutable original row after a crash. It is
`reference_prepared`, with delivery `not_attempted`, and never a VERIFIED receipt.
Stage 3B now independently authenticates the original outbox/private pending source,
constructs all complete-scope partitions (1,024 source scopes, 128 per receipt),
retains/readback-verifies immutable bundles and receipts, and registers their complete
set in one existing control CAS transition. Schema-2 receipts cannot register
individually. Replay recovers partial retention, missing registration, conditional
conflicts and ambiguous writes without a Prune rerun. This does not establish
current canonical precedence, supersession or all-writer coverage. Legacy incomplete
or oversized original metadata remains ineligible; any external overflow snapshot
needs its own reviewed authority. `selectManagedPublications()` remains disabled.
The [original gate durability review](../../docs/investigations/jsongen_prune_final_evidence_durability_boundary.md)
traces the mutable candidate/gate schema, READY-to-CONSUMED transition and
commit-to-delivery crash window. It identifies a separately reviewed
transactional acceptance/outbox schema as the prerequisite for durable trusted
final evidence; a post-commit upload cannot close that window.

The v2 Prune path does not enter this handover. Before any TEST activation,
perform a separately authorised controlled Prune run to verify dedicated
bucket permission, conditional PUT/readback, byte and row limits, source
cleanup, canonical finalisation, PostgreSQL gate behavior and restart review.
No such operational acceptance is implied by local checks.

The managed data operations in this directory remain an **inactive Node ESM
library**, independent of the experimental `scripts/compressed_chart_history`
publisher and its selector. Stage A only inspects local library availability;
the separate bootstrap is independently invoked. There is no managed writer
trigger, regeneration, publication or serving integration. Do not invoke its R2
operations without separate operational authorisation.

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

**Current canonical-scope precedence and complete intervening-writer receipt
coverage remain unresolved.** Original source/final-authority authentication is now
implemented for the supported AURN first-publication path; other writer adapters
remain fail closed.
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

The legacy Stage 2 per-operation admission bounds in `limits.mjs` are 1 MiB for a
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

Stage 3C retains those byte/row/time/report safeguards and the legacy budget API.
Its dedicated inspection profile derives requests from the selected deterministic
metadata keys: initial reads plus complete rechecks plus a closing root GET.
The dense synthetic 128-series case uses 541 GETs within a 543-GET plan. Four
workers share one deadline, byte reservations and an 8 MiB raw metadata cache.
The theoretical 3,337-GET profile ceiling is always lowered to the selected key
plan. A larger event is fully reported but only one 128-scope partition is
inspected per invocation. See the Stage 3C handover for schema-3 decoding,
resource accounting, source-as-of limits and remaining operational acceptance.

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
Beyond the Stage A manual diagnostic and the separate local bootstrap, managed
workflow generation/publication, automatic triggers, accepted baseline/rebuild,
broader identity allowlists and website/Refresh/open-month integration remain later work.

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

## Stage A manual diagnostic operation

Workflow: **UK AQ JSONgen**, `.github/workflows/uk_aq_jsongen.yml`.
Entry point: `scripts/jsongen/diagnose.mjs` (Node ESM, Node >=20, import-safe).
It uses the repository's `actions/checkout@v4`, `actions/setup-node@v4` and Node 20
conventions, including `npm ci --ignore-scripts`. The existing canonical-metadata
inspector transitively imports the repository's existing Arrow/Parquet packages;
availability inspection never invokes their readers, writers or WASM initialization.
No package or lockfile changes, new secret/variable names, GitHub environment setup
or settings are required.

This implements only the approved initial manual stage in the authoritative
[17 October contract](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/1c0e4affa8385eb2e6025bd3a029cebe53f9362b/system_docs/station_charts/compressed_history_json_verified_writer_regeneration_contract.md).
The reported 433 paired local Dropbox bootstrap candidates in 316 seconds are
separate seven-day partial-October operational evidence. They are not managed
writer receipts, an accepted September baseline, or current canonical authority.

### Admission and manual dispatch

After review and merge, obtain **separate authorisation for the first real
GitHub-hosted TEST operation**. Do not dispatch as part of implementation or PR
review. Once authorised, select TEST Ops → Actions → **UK AQ JSONgen** → Run
workflow → branch **main**, retaining exactly these single-choice inputs:

| Input | Only permitted value |
| --- | --- |
| `environment` | `TEST` |
| `connector_id` | `1` |
| `timeseries_id` | `212` |
| `pollutant` | `pm25` |
| `month_utc` | `2026-09` |

The equivalent command **only after that separate authorisation** is:

```sh
gh workflow run uk_aq_jsongen.yml --repo TEST-uk-aq/uk-aq-ops --ref main \
  -f environment=TEST -f connector_id=1 -f timeseries_id=212 \
  -f pollutant=pm25 -f month_utc=2026-09
```

There are no arbitrary path, bucket, credential, command, apply or publish inputs.
CLI admission independently rejects missing, duplicate, unknown or widened
arguments, even when bypassing the dispatch form. It does not infer a station ID
or accepted binding from the diagnostic timeseries identity. The job is restricted
to the exact TEST repository and `workflow_dispatch`, with fixed `UK_AQ_ENV_NAME=TEST`;
the CLI rechecks that context and the checked-out commit against `GITHUB_SHA`.
Local invocations also reject a supplied non-TEST `UK_AQ_ENV_NAME`.

For a local, non-operational availability check from the Ops repository:

```sh
npm ci --ignore-scripts
node scripts/jsongen/diagnose.mjs --environment TEST --connector-id 1 \
  --timeseries-id 212 --pollutant pm25 --month-utc 2026-09
```

### Report and success meaning

The CLI writes `tmp/jsongen-diagnostic/report.json` and `summary.md`, logs only
a compact outcome, and exits 0 on successful diagnostics or 1 on execution error.
The workflow appends the concise Markdown summary to the Actions job summary and
uploads only those two files as
`uk-aq-jsongen-diagnostic-<run_id>-<attempt>`, retained for 14 days. Both reporting
steps use `always()`. The JSON report is capped at **16 KiB**, with a closed runtime
schema in `diagnostic-report.mjs`, reusing managed `requireValid`, `same`, canonical
JSON encoding, selector blocker and resource limits. It is a distinct execution
report; the existing reconciliation schema requires authentic control/source
evidence that this stage does not have. No synthetic control snapshot or receipt
is supplied to make reconciliation run.

| Report fields | Meaning |
| --- | --- |
| `kind`, `schema_version`, `report_version` | `uk_aq_jsongen_stage_a_diagnostic`, version 1 / 1 |
| `environment`, `selection`, `invocation_mode` | TEST, admitted scope (null if rejected), `local_diagnostic` |
| `run` | GitHub run ID/attempt when valid and available; actual Git source commit SHA |
| `implementation` | Package/Node/managed schema/AQI version and SHA-256 inventory of installed libraries; null on incomplete inspection |
| `duration_ms`, `diagnostic_results` | CLI elapsed time and bounded passed/failed diagnostic codes |
| `capabilities` | Available local checks and explicitly unavailable managed operations |
| `authorities`, `authority_blockers` | Required authority states and reasons, all `not_established` in Stage A |
| `remote_access` | Per-service reads/writes, accounting scope and measurement boundary |
| `publication_eligible`, `selector` | Always false; disabled with existing blocker; current publication not inspected |
| `readiness`, `outcome`, `error_code` | Diagnostic success with publication blocked, or distinct execution failure |

Success establishes admission, Git/package/algorithm identity, and successful
imports/export availability of managed schema, immutable-input, canonical-authority,
control-snapshot, reconciliation-report validation, limit and writer-authentication
libraries. No reader or authentication operation is invoked. Control and
reconciliation modules are only read locally for installed-file hashes, not
imported. Import availability is not functional or operational acceptance.

Successful output has `outcome=success`,
`readiness=diagnostic_passed_publication_blocked`, and
`publication_eligible=false`. Expected missing remote authority does not fail this
diagnostic. All final writer, complete receipt/outbox coverage, current canonical
source/status/binding, full-month baseline, adjacent-month PM context, immutable
pair readback and conditional-publication protection authorities remain explicitly
unestablished. Schema PR #11 merging definitions does not establish migration
application, grants or operational acceptance. `verified_event_ordering_unavailable`
remains the selector blocker for unauthenticated canonical precedence/receipt
coverage; it does not call for a new global numeric event sequence.

### Remote, write and failure boundaries

The diagnostic makes **zero canonical R2, derived R2, Dropbox, PostgreSQL or Supabase
reads or writes** by construction: it invokes no remote client and receives no
data-service credentials. These counters cover the diagnostic process only.
GitHub checkout, Node/dependency setup and artifact transport use network access outside
that accounting and are explicitly **not measured**, rather than claimed as zero.
GitHub token permissions are `contents: read`, checkout credentials are not
persisted, and no application secrets or repository-variable destinations are read.
Only fixed diagnostic codes, validated run metadata, local version/hash evidence
and fixed authority classifications are reported; raw errors, arguments,
environment dumps and source contents are never serialized.

The workflow is manual-only on GitHub-hosted Ubuntu, has a 10-minute overall
timeout and a 60-second CLI timeout with five-second kill grace. Existing JSONgen
duration budgets apply within the CLI. A single TEST concurrency group with
`cancel-in-progress: false` serializes runs; GitHub may replace an older pending
run. This scheduling policy is not the future derived CAS protection mechanism.

Invalid admission/context, missing or incompatible local implementation, import
failure, invalid report or local output failure fail the step. Handled inspection
errors produce an error report; failures before module loading, hard timeout,
runner cancellation or setup failure can leave no report. The always-run summary
then states that no report exists, and artifact upload warns if files are missing;
the failed step stays failed. Do not interpret absent reports as diagnostic success.
Each hosted attempt starts in a fresh workspace and has a distinct artifact name.
An approved retry is another independent diagnostic; there is no state to resume,
receipt to replay, baseline to repair or publication to roll back. Local reruns
replace only the two local diagnostic output files. Rollback is reverting this PR;
no remote data or managed control rollback is needed.

This path never registers changes, manufactures writer bundles/receipts, creates a
monthly baseline, generates or uploads managed observation/AQI objects, mutates
managed control, invokes `retainReconciliationReport()`,
`recordReconciliationRequired()` or `selectManagedPublications()`, reads historical
Parquet, or changes Prune, Integrity, canonical status, chart serving or LIVE.
The existing managed selector implementation/blocker is unchanged. The bootstrap
candidate, verified writer change ID and selected monthly pubID remain distinct.

### Remaining stages and first-run review

Still requiring separately reviewed implementation and operational approval:

1. Authenticated complete final writer handover and durable verified receipt registration.
2. Bounded read-only reconciliation with complete receipt coverage/current scope authority.
3. Accepted initial full-month baseline and authenticated PM context (preceding 23 hours,
   with following-23-hour effects retained across month boundaries).
4. Incremental monthly observations and shared AQI calculation over that authenticated result.
5. Immutable paired upload/readback and conditional managed-selector advancement.
6. Automatic verified-event dispatch and scheduled reconciliation.
7. Opt-in chart serving, cache/pubID discovery and Refresh integration.

Do not guess unresolved handover or credential contracts. No ordinary Parquet or
Dropbox fallback is authorised. After the first separately authorised diagnostic
run, inspect its source SHA, admitted identity, summary and bounded artifact;
confirm successful local diagnostics, zero diagnostic service operations, all
authority blockers, false publication eligibility and disabled selector. Record
that as Stage A operational evidence only, not writer-handover, database,
monthly-generation, AQI parity, R2 CAS or publication acceptance.

For ChatGPT in Chat mode: after review, record the Stage A workflow/CLI and its
local-only boundary in the authoritative contract's implementation status. No
schema/configuration/deployment change is required; the approved authority
contract is preserved. Keep all later publication gates explicit. Coding agents
have not changed authoritative system documentation or plans.
