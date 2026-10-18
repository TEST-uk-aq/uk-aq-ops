# Independent Prune consumer: Stage 3B

Implementation record, 18 October 2026. TEST/AURN code only; operational acceptance
is still required. Existing [Ops PR #112](https://github.com/TEST-uk-aq/uk-aq-ops/pull/112)
continues on `codex/jsongen-prune-independent-consumer`. Main includes merged
[PR #113](https://github.com/TEST-uk-aq/uk-aq-ops/pull/113), merge
`72de38e3676e6ccefb9f7d66c1c68e60cd453481`. The reconciliation uses main
`642c723f65bd80fb5cb85519b849b431d850553b`, preserving its producer implementation,
codec, required archives and unrelated committed changes.

The [authoritative quick reference](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/main/system_docs/station_charts/jsongen_prune_verification_handover_quick_reference.md)
and linked contracts govern this implementation. System documentation was read
without modification. Prune remains the authoritative verifier of canonical
observations. This consumer authenticates its original immutable attestation and
private pending source. It does not repeat Parquet verification, add a gate,
query current Core, scan canonical observations or require Prune to run again.

## Original authentication and eligibility

`prune-outbox-reader.mjs` retains the dedicated private PostgreSQL SELECT boundary:
verified TLS, read-only transactions, bounded statements, reader-group/RLS and
privilege checks, and the same TEST Supabase project. Writer/service-role,
superuser and gate-acceptance-capable credentials are rejected. The complete
immutable key is `(environment, writer_identity, run_id, attempt_id, day_utc,
connector_id)`, fixed to TEST, `prune_daily_v3`, connector 1. Module-private proof
tokens prevent caller rows, notifications or success flags from impersonating a
read. READY-to-CONSUMED does not change the immutable original event.

The final envelope stays schema 1. `prune-consumer-authentication.mjs` requires the
nested schema-2 `inline_original_metadata_gzip_v1` markers and reuses PR #113's
unchanged `decodePruneMetadataEvidence()`. Its schema-1
`canonical_json_gzip_v1` descriptor binds compressed bytes and exact canonical
JSON SHA-256/lengths. The decoder checks bounded decompression, both markers,
each retained object's canonical base64/size/SHA-256 and combined limits.
The retained bytea itself must match the original row's digest and length and
canonical outer encoding. Legacy incomplete evidence is ineligible.

Decoding alone grants no authority. Independent relationship checks bind the
original invocation, attempt, writer Git SHA, environment, generation, lock,
frozen source, pending preparation, original connector publication, required
final batch, original committed gate and deterministic post-COMMIT reference.
Final retained root/year/month/day/connector/pollutant manifests, exact-v3
roots/leaves/aligned shards and file references must form the original complete
publication and agree with source content, statuses, counts and membership.
Only retained metadata and the private pending gzip are read; canonical file
references do not cause canonical file GETs.

`prune-original-authority.mjs` authenticates these additional PR #113 authorities:

- **Before:** exact original root-to-absence hierarchy in selected v3, matching
  child identities/hashes, original global lock and invocation, genuinely absent
  AURN connector-day, original latest-registry corroboration and every affected
  physical scope. `scopes[].before` is `authoritative_empty`, zero rows, with the
  actual authenticated absence-parent reference. Missing evidence or a 404 does
  not establish absence. Previously committed historical scopes remain blocked.
- **Binding:** original Core-owned selected-v3 binding root, each applicable
  1,000-ID range and exact physical binding bytes, root/range/physical membership
  and hashes, original source-state and refresh-state completion, matching source
  fingerprint/root hash, complete source-table provenance and schema-2 continuity
  validation where applicable. `source.binding_authority` is this genuine root.
  It attests Core's completed snapshot; it does not assert Prune reconciled Core.

The private pending readback independently checks signing-intent identity, exact
key/bucket, compressed/uncompressed SHA-256 and lengths, original canonical
source hash and complete physical/pollutant membership. It preserves timestamps,
float64 values, duplicate order/multiplicity and effective P/R/null. A redundant
`observed_at` must equal `observed_at_utc`. Original AURN provider status remains
explicitly `original_source_status_unavailable`; bundle `source_status:null`
makes no original-provider claim. Only original schema-3 embedded effective
status is supported. Schema-4 without its actual original overlay/transition
authority, unsupported pollutants/identities, contradictory/missing evidence and
resource overflow fail the whole event before registration. No scope is dropped.

## Compatible strict receipts

`schema.mjs` adds schema-2 `uk_aq_jsongen_verified_change`; existing schema-1
receipts and schema-1 complete-scope bundles remain compatible. All existing
source/scope/row, affected-month and rolling-AQI checks remain. The adaptation
represents original PostgreSQL authority accurately rather than inventing an
R2 object for it. `origin.authority` has:

```text
schema_version: 1
kind: uk_aq_jsongen_prune_acceptance_authority
relation: uk_aq_ops.prune_jsongen_gate_acceptance_outbox
key: full immutable six-field primary key
event_id: SHA-256 of canonical primary key
writer_git_sha: original accepted writer SHA
final_evidence_sha256 / final_evidence_byte_size: original retained bytea
post_commit_reference_sha256: reconstructed original reference digest
```

`verification.provenance_authority`, `verification.scope_completeness_authority`
and `durability.retained_receipt_authority` must equal that typed original
PostgreSQL authority. The outbox remains the sole original gate authority; no
original-evidence copy is published or promoted to authority.

Genuine source mappings are:

| Receipt field | Authenticated original evidence |
| --- | --- |
| `generation_authority`, `index_authority` | Selected-v3 exact scoped pollutant manifest |
| `observations_root`, `final_publication`, `verification.authority` | Original final selected-v3 observations root |
| `verification_authority`, `scopes[].after.authority` | Original pollutant manifest with bound schema-3 effective status |
| `binding_authority` | Original completed Core selected-v3 binding root |
| `verified_at_utc` | Original gate completion timestamp |
| `scopes[].before.authority` | Original admitted absence parent |

`origin` additionally binds pending gzip, frozen source identity, unavailable
provider-status boundary, original lock, whole-source scope/row count and coverage
hash, complete partition descriptors, group digest and partition index. The
writer includes attempt and Git SHA. A receipt describes original
`canonical_final_verified`/`verified_pending` evidence; only successful independent
authentication can construct the branded group admitted by the new control path.
Schema validation by itself is never writer authentication. Stable `prune:`
change IDs remain separate from monthly UUID pubIDs.

## Complete partitions and immutable retention

`prune-consumer-partitions.mjs` now builds actual deterministic complete-scope
NDJSON gzip artifacts. It groups by pollutant, splits only between complete
physical scopes and covers all source rows/scopes exactly once. Maximum source
scope count stays 1,024; maximum per receipt/bundle stays 128. Existing 100,000-row,
8 MiB record/gzip, 32 MiB original bundle, 32 receipt-reference, 64 MiB combined
byte, 200,000 total-row and 60-second operation caps remain. An indivisible
oversized scope or event exceeding coupled limits fails closed. The original
1 MiB outbox, 8 MiB/4,096 retained metadata-object limits are unchanged.

`prune-receipts.mjs` constructs and validates the whole group before retention.
It uses existing conditional PUT/readback helpers and existing derived layout:

```text
managed/jsongen/v1/bundles/<gzip-sha256>.ndjson.gz
managed/jsongen/v1/receipts/<canonical-json-sha256>.json
```

Every PUT is immutable `If-None-Match:*`. Success, 412 and ambiguous outcomes
require exact bounded readback. Bundles are checked for exact gzip bytes and
uncompressed digest/length, with every complete record validated. Receipts require
exact canonical JSON/schema/readback and reauthentication against original event
and bundle. Conflicting existing bytes are never overwritten. Unconfirmed writes
remain reconciliation-required with deterministic expected references.

## Atomic registration and recovery

The existing `control.mjs` CAS framework adds `retain_prune_event`, admitted only
with a module-private token minted after **all** partitions have durable verified
bundle/receipt readbacks. Its command cannot carry caller-invented evidence.
Individual `retain_receipt` remains for schema 1 and rejects schema-2 Prune inputs.
`assertPruneReceiptGroup()` and `assertControl()` require the complete expected
set, unique indices/change IDs/scopes, matching original authority/group digest
and exact whole-event scope/row coverage. An arbitrary subset cannot be valid
registered state.

One CAS transition installs the whole group, preserving unrelated entries and
month dependencies. Existing stable IDs must have identical receipt bytes.
Conflicts reread fresh state and reapply only the bounded command. Revision,
operation ID and previous-byte hash fencing remain. Ambiguous control writes
require readback of the attempted state or a newer valid state containing the
identical complete event. Replay is idempotent and does not advance revision for
an already registered event. Control stays within its 4 MiB cap; event-mode
control reads/writes share the operation deadline and byte budget.

Original outbox plus private pending gzip are the crash-replay inputs. Reconstructing
the same event gives the same partition set, bundle/receipt references and change
IDs. Interrupted/partial retention leaves no registration; retained receipts
survive failed registration, missing initialization or CAS interruption. Replay
checks existing immutable bytes, completes missing retention and registers the
whole set. Conflicting or missing originals fail closed; no Prune rerun, mutable
original-authority store, source reconstruction or age-based cleanup is added.
`reconcilePruneAcceptance()` reuses the full event replay path, separate from the
existing 128-scope current-metadata inspector. That inspector can optionally
reauthenticate schema-2 receipts through the actual private reader; unavailable
recovery inputs remain reconciliation-required.

`handover_complete:true` is returned only after complete original-event durable
retention **and** confirmed atomic registration. It does not assert currentness.
Every result keeps `publication_eligible:false`, current canonical authority
uninspected and supersession unevaluated. Superseded originals may still be
recovered as original events; this never bypasses later precedence checks.

## Manual interface, discovery and prerequisites

No imports, diagnostics or CLI help execute writes. `--execute-read-only` remains;
`--execute-retain` is a separate explicit future operational mode. Optional
`--initialize-control` is retain-only; an absent control is otherwise a recoverable
registration failure. No workflow, schedule, public API, Queue or service is added.

Local help:

```sh
node scripts/jsongen/prune-consumer.mjs --help
```

For later separately authorised TEST operation, use the full original key:

```sh
node scripts/jsongen/prune-consumer.mjs --execute-read-only \
  --event-key-file work/original-event-key.json --output work/prune-read.json
node scripts/jsongen/prune-consumer.mjs --execute-retain \
  --event-key-file work/original-event-key.json --output work/prune-retain.json
```

Discovery remains explicit `--discover recent|resweep --from UTC --to UTC`, at most
seven days and 16 events/page (default 4). `--process` processes events and is
mandatory in retain discovery. Cursor files contain the previous page's complete
`next` tuple for the same mode/window. `accepted_at` is insertion time, never
commit order or canonical precedence. Repeat overlapping recent windows and
periodic historical resweeps from their beginnings to recover late visibility.
Discovery always reports incomplete world coverage; no one-way high-water mark,
acknowledgement, event counter or source-row update is introduced.

Detailed JSON requires an explicit local path and is atomically written mode0600.
Logs expose bounded counts, opaque IDs and safe failure codes, never credentials,
URLs, observations or evidence bytea. Exit 2 means incomplete/reconciliation-required;
help and confirmed registration exit successfully.

No new configuration name is added. Reuse
`UK_AQ_JSONGEN_PRUNE_READER_DB_URL`, `UK_AQ_ENV_NAME=TEST`, existing `SUPABASE_URL`
and `UK_AQ_COMPRESSED_CHART_R2_*`. PR #114's configuration review also requires
the existing sourced `UK_AQ_GITHUB_REPO=OWNER/REPO` before the private reader
connects. Missing or malformed repository configuration fails closed. Supplied
GitHub repository metadata must match; Actions execution additionally requires
that metadata and `workflow_dispatch`. Local operation may omit runtime metadata;
it cannot replace the configured repository. This shared admission is documented
in the [Stage 3C handover](currentness-coverage-handover.md#manual-operation-and-configuration).
Both repository identity and the reader key are local-only in
`config/uk_aq_github_env_targets.csv`; the operator-owned ignored
`env-vars-master.csv` is absent locally and requires its existing key definition
when separately provisioning. Derived credentials need existing namespace
GET/conditional PUT for retain mode. No credential is provisioned here.

[Schema PR #12](https://github.com/TEST-uk-aq/uk-aq-schema/pull/12) was reviewed:
NOLOGIN `uk_aq_jsongen_prune_reader`, schema USAGE, outbox SELECT and the
TEST/`prune_daily_v3`/connector-1 SELECT RLS policy match the consumer's checks.
No mismatch or additional schema change was identified. Its merge/apply status
is not assumed. Applying its migration and provisioning a restricted INHERIT
login with read-only defaults remain separate operational prerequisites.

## Validation, limits and Chat-mode handover

Targeted offline checks pass: seven consumer checks cover compressed original
authentication, 1,024 scopes/2,048 duplicate rows through eight receipts and full
registration, source/authority conflicts, late visibility, partial retention,
immutable conflict/readback, CAS/ambiguous outcomes and reconciliation loss of
original input. Six existing Stage 2 precision/membership/continuity/report/CAS
checks and the existing isolated private-reader check pass (14 total).

```sh
node --test --test-isolation=none --test-reporter=tap tests/jsongen_prune_consumer.test.mjs
node --test --test-isolation=none --test-reporter=tap --test-name-pattern='receipt and gzip identities|complete-scope membership|malformed provenance|CAS conflict rereads|valid original-byte report|schema-2 continuity accepts' tests/jsongen_stage2.test.mjs
node --test --test-isolation=none --test-reporter=tap --test-name-pattern='isolated private reader' tests/jsongen_prune_pending_source.test.mjs
```

Changed active Node modules pass `node --check`; CLI help and `git diff --check`
pass. Fixtures are local synthetic adapters, not TEST operational acceptance.
No broad suite, signer invocation, Prune run, operational DB/R2 access, write-mode
CLI operation, workflow dispatch, migration apply, deployment, credential or
scheduler change occurred. The enabled pending-source variable and paused Prune
scheduler remain untouched. LIVE was not accessed.

Existing dated archive copies are preserved without overwrite. Additional
pre-change active-code snapshots cover authority, schema, control, inputs,
reconcile/report validation and the three consumer modules; new modules need no
predecessor snapshot. PR #113's producer format and canonical safety stay intact.

Chat-mode system-documentation handover: record the original-only Stage 3B
consumer, schema-1 envelope/schema-2 markers/codec, schema-2 receipt's typed
PostgreSQL durability authority, exact first-publication before/binding mappings,
immutable layout, atomic whole-event CAS and deterministic crash replay, private
reader/migration prerequisites and explicit CLI modes. This is an implementation
capability with operational acceptance outstanding; no system docs were edited.

No mandatory original-authority or durability implementation gap remains for
the supported first-publication/schema-3 AURN path. Missing legacy/oversized
captures cannot be repaired by this consumer and remain ineligible. Next work
is authenticated current canonical scope/supersession, complete intervening-writer
coverage, authenticated monthly baselines and PM context, then paired monthly
observation/AQI generation and publication CAS. `selectManagedPublications()`
and chart/default serving remain disabled. After deployment, separately authorised
TEST checks must exercise real read/retain/replay, immutable permissions and CAS
readback before operational acceptance. Rollback is reverting consumer code and
schema-2 admission before operation; preserve durable originals, sources and any
retained receipts/bundles for reconciliation.
