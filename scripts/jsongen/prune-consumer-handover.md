# Independent Prune consumer: Stage 3B safe boundary

Implementation record, 18 October 2026. Code only; no operational acceptance.
The [authoritative quick reference](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/main/system_docs/station_charts/jsongen_prune_verification_handover_quick_reference.md)
and its linked contracts govern this implementation. System documentation was
read without modification. Prune, its paused scheduler, the enabled pending-source
flag, signer, existing configuration and LIVE were not operated or changed.

## Structural decision made before implementation

The merged PR #111 schema-1 envelope preserves original committed gate identity,
validated finalisation, source description, physical membership and exact original
metadata. Its capture groups are canonical manifests, exact observation indexes,
day manifests, aggregate manifests and latest-global indexes. It does **not**
capture either of these mandatory Stage 1 fields:

| Missing proof | Existing consumer requirement | Required resolution |
| --- | --- | --- |
| Original pre-replacement physical membership and count, with original authority | `scopes[].before` | Retain the actual admitted pre-publication membership, including genuine absence/removal authority, or accept an explicit versioned contract change. A source-present row does not prove previous absence. |
| Original selected-v3 binding authority/closure | `source.binding_authority` | Retain the original `history/_index_v3/timeseries_binding` authority and physical station/timeseries bindings under a reviewed writer contract. A station ID in source rows or an observation index is not this authority. |

No schema-1 event can meet the existing strict receipt contract. The implementation
therefore stops at the task's expressly permitted **safe consumer boundary**.
It does not add guessed before-membership, weaken `assertReceipt`, introduce an
alternative receipt store, or label a source/metadata checksum VERIFIED.
Source preservation and original accepted completion can be authenticated while
receipt eligibility remains false. This is **not a completed VERIFIED receipt
capability**. Receipt/bundle durable publication, partition registration and their
write-recovery path remain unimplemented until those original authorities are
available; adding them speculatively would not make this handover valid.

## Working interfaces and authority

- `prune-outbox-reader.mjs`: direct private PostgreSQL SELECT, with a dedicated
  restricted reader credential, verified TLS, five-second SQL timeout and explicit
  read-only transactions. No public RPC. It verifies reader-group membership,
  policy presence, SELECT access and absence of elevated role, outbox mutation
  and original acceptance-function privileges. The connection is tied to the
  existing TEST `SUPABASE_URL` project, including pooler project identity.
- Exact reads require the complete immutable key `(environment, writer_identity,
  run_id, attempt_id, day_utc, connector_id)`, fixed to TEST/AURN. They retrieve
  the exact original bytea (up to 1 MiB) and reconstruct PR #111's deterministic
  post-COMMIT reference. Module-private tokens prevent caller rows, success flags
  or notifications from being accepted as database-read evidence.
- `prune-consumer-authentication.mjs`: checks original event/envelope hashes,
  TEST/selected-v3/original Git SHA/run/attempt/day/connector, gate/source/manifest
  identities, the retained required-v3-finaliser boundary and pinned metadata
  groups. It binds the complete private source to original pollutant content,
  row/status counts, physical timeseries membership and original file identities.
  It authenticates Prune's retained original attestation; it does not recalculate
  canonical publication success. Missing original bytes fail closed.
- `verifyPrunePendingSource`: independently reads only the private derived
  pending object; checks exact key, deterministic signer-intent identity, bucket,
  invocation, compressed/uncompressed SHA-256 and size, bounded valid gzip, frozen
  source hash, complete source declaration, scopes and effective P/R/null. Strict
  canonical row admission rejects numeric coercion and timestamp rounding; the
  writer's redundant `observed_at` alias must exactly equal `observed_at_utc`.
  No deduplication, filling hours or status rewriting occurs. AURN original
  provider status remains explicitly `original_source_status_unavailable`.
- `writer-authentication.mjs`: connects the authenticated AURN proof to the
  existing admission seam while reporting the exact remaining authorities.
  It still cannot return authenticated receipt admission. Integrity, SOS-light
  and IFW remain fail closed. Existing receipt validation, control CAS,
  reconciliation and the disabled publication selector are unchanged.

Only schema-3 embedded effective status is admitted at this boundary. A schema-4
event requires its original accepted overlay/transition evidence and fails with
the exact missing authority; neither a missing overlay pointer nor age invents
P/R/null. Current status/binding authority and later supersession are separate,
uninspected questions; original authentication never establishes monthly eligibility.

There are **zero canonical R2 GETs**, no Parquet reads, no candidate/gate queries,
no IngestDB deletion gate and no fallback source reconstruction. READY-to-CONSUMED
does not affect an authentic original immutable event. No Prune rerun is needed
for replay, and replay cannot recover genuinely missing original authority.

## Discovery and replay

Each page contains at most 16 events (default 4) and spans at most seven days.
Discovery uses the existing accepted-at/run/attempt/day/connector index, with the
complete tuple as a page cursor. PostgreSQL microseconds are preserved. Cursors
are bound to the same mode/window. No original row is updated or acknowledged.

`accepted_at` is insertion time, never commit order or canonical precedence.
Every result explicitly says `coverage_complete=false` and `replay_required`.
An operator must repeat overlapping recent windows from their beginning and
periodically resweep all historical windows in bounded pages, restarting passes
to find transactions that became visible behind a cursor. Neither one completed
pass nor an overlap horizon is a permanent completeness proof. There is no
stored one-way high-water mark, automatic schedule or inferred event frontier.
Event IDs hash the full immutable primary key; repeated discovery/replay gives
the same original event and deterministic source/partition identities.

## Complete-scope partition plans

`prune-consumer-partitions.mjs` consumes only independently authenticated source
proof. It constructs prospective Stage 1 `complete_scope_ndjson_gzip` records
with every original observation per physical UTC-day scope and explicit
unavailable-provider-status provenance in the source binding. It preserves
timestamps, numeric values, duplicates and effective statuses. It does not infer
empty replacements or removals. Unsupported identities/pollutants or unbound
station IDs fail the entire plan; none are filtered away.

Deterministic groups preserve the 128-scope receipt cap and existing 100,000-row,
8 MiB record/gzip and 32 MiB original bundle caps. Oversized groups split only
between complete scopes. An individual oversized scope fails closed. All source
scopes and row counts must be covered exactly once before a complete **source
plan** is reported. The 1,024-source-scope cap remains separate; other limits
were not increased. Shared operation budgets also apply (64 MiB, 200,000 total
rows, 60 seconds per event); sources that cannot fit coupled budgets fail whole.

Every partition is bound to the same original event, original final-evidence
digest, reconstructed reference, complete pending object, original scope/row
counts and its exact scopes. Prospective change IDs and content-addressed bundle
references are stable, distinct from monthly UUID pubIDs. They are **plans only**:
no object is written, no receipt is issued and `receipt_coverage_complete` and
`handover_complete` stay false even with full source partition coverage. There
is no crash point that can turn half a plan into a registered connector-day.

The immutable original PostgreSQL event and confirmed private pending gzip are
the surviving recovery inputs. Keep them; no age-based cleanup is introduced.
Missing or conflicting original bytes/source stop before any derived write.
After authority gaps are closed, implement existing conditional immutable
bundle/receipt PUT, exact compressed/uncompressed/schema readback and ambiguous
PUT/412 resolution, followed by full partition coverage registration through
existing control CAS. Receipt-retained/registration-interrupted recovery belongs
there; it is not claimed by the present read-only boundary.

## Configuration and explicit operation

There is no new workflow, schedule, automatic import execution or dispatch.
`prune-consumer.mjs --help` is local-only. Actual reads require the explicit
`--execute-read-only` flag and TEST environment. No operation was run here.

The one new local-only key is `UK_AQ_JSONGEN_PRUNE_READER_DB_URL`: a dedicated
private TLS PostgreSQL login for the existing TEST IngestDB project. Reusing
Prune's writer/service credentials would violate the independent read boundary.
`config/uk_aq_github_env_targets.csv` marks it `local`, so environment sync does
not create or change a GitHub secret/variable. The ignored `env-vars-master.csv`
is absent from this checkout; its operator-owned catalogue needs the same local
key definition when separately provisioning credentials. Existing
`UK_AQ_ENV_NAME`, `SUPABASE_URL` and `UK_AQ_COMPRESSED_CHART_R2_*` are reused.
The existing dedicated derived-bucket credential is used only for GET here.

The companion TEST Schema PR adds a NOLOGIN reader group, schema USAGE/table
SELECT and a TEST/AURN-only RLS SELECT policy. This is necessary because the
merged outbox currently grants SELECT only to `service_role` and provides no RLS
policy for an independent restricted reader. It changes neither rows nor writer
function authority. Applying the migration and provisioning a restricted INHERIT
login/member with read-only defaults require separate operational authorisation;
no login/password or membership is provisioned by this code. Do not use
`service_role`, a superuser, a role that can accept events, or the signing token.

Examples for a **later separately authorised** read operation:

```sh
node scripts/jsongen/prune-consumer.mjs --help
node scripts/jsongen/prune-consumer.mjs --execute-read-only \
  --event-key-file work/original-event-key.json --output work/prune-consumer-result.json
node scripts/jsongen/prune-consumer.mjs --execute-read-only --discover resweep \
  --from 2026-10-10T00:00:00.000Z --to 2026-10-11T00:00:00.000Z \
  --limit 4 --process --output work/prune-consumer-page.json
```

An event-key file has all six key fields; a cursor file contains the previous
result's complete `discovery.next`. Detailed reports require an explicit output
path and are atomically retained as mode 0600 local JSON.
Logs contain only bounded counts, opaque event IDs and safe failure codes. No
credential, presigned URL, source rows or final-evidence bytea is logged. Exit 2
means the handover is incomplete/reconciliation-required even if reads succeeded.

## Validation and Chat-mode system-documentation handover

Changed active Node modules pass syntax checks; CLI help imports without remote
operations. Three focused offline checks pass: complete 1,024-scope/2,048-row
partition coverage and deterministic identities; forged/missing/tampered authority
admission; and late-visibility resweep recovery. One existing private-source check
and two existing Stage 1 precision/multiplicity/membership checks also pass. The
local Node v24.19.0 runner requires `--test-isolation=none` to expose individual
checks; no broad suite was run. Companion SQL checks compare canonical/migration
definitions and restrict privileges/policy to SELECT; no SQL was executed.

Before-payload implementation archives cover the two changed active consumer
modules and the configuration mapping; schema has its own canonical SQL snapshot.
Existing PR #111 archives remain untouched. `git diff --check` passes.

Chat-mode handover: document this executable **read-only safe boundary**, private
outbox discovery/replay and source verification, prospective partition plans, new
reader role/configuration prerequisites, and the two precise original authority
gaps. **Do not describe Stage 3B VERIFIED receipt retention or registration as
complete.** No real outbox, pending R2 object, signer or Prune operation was read
or run. Structural checks are not integrated TEST acceptance. No system-doc edit,
deployment, migration apply, configuration change, workflow dispatch or LIVE work
occurred. Rollback is reverting these code/schema definitions before application;
do not delete durable original events or pending sources.

Remaining work: accepted original before/binding evidence or versioned contract;
strict receipt construction and immutable retention/readback; complete partition
CAS registration and write/crash recovery; later current canonical-scope
authority/supersession; authenticated monthly baselines and PM context; paired
observation/AQI generation and publication CAS; eventual explicitly authorised
chart integration. `selectManagedPublications()` and default serving stay disabled.
