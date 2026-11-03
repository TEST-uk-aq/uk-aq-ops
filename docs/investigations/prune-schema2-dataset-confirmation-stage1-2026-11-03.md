# Prune exact-only preparation and dataset confirmation: Stage 1

3 November 2026. TEST code only, based on Ops `main`
`2d820608e91a4f758f2071e8e3297d26342867ff` (including merged #157/#158),
against the authoritative system-docs `main`
`cd03bcc26d91e49544d410b22f1eb0fe11955fef` and its 3 November Prune decisions.
No merge, deployment, Prune invocation, configuration change, operational
R2/database action, conversion, retirement or LIVE work is authorised or performed.

## Structural viability and changes

- `workers/shared/uk_aq_observation_history_exact_only_verifier_v3.mjs`:
  completed-root acceptance can reuse the independent actual-byte inspection
  already held in its private WeakMap. The original context binds the scope,
  canonical child body, actual file SHA/size/ETag, inspector/profile and original
  operation assertion. It authenticates the completed root-to-pollutant chain,
  reads every stored selected leaf, reconciles complete membership/ranges against
  the original independently decoded metadata and rechecks pinned identities.
  Failed acceptance permanently invalidates that proof; a copied/serialized
  report cannot recreate it. Standalone verification still inspects actual files.
- `workers/shared/uk_aq_observation_history_exact_only_publication_v3.mjs`:
  the existing latent publisher uses that reuse at root acceptance. Selector,
  immutable-leaf, canonical hierarchy, compact latest and existing run-finalizer
  readbacks remain mandatory. Only successful finalisation plus fresh identity
  checks can expose an opaque transient completion for the original invocation.
  Any failed lifecycle/identity check invalidates completion. This module never
  uploads PENDING data, inserts an outbox row, writes a receipt or confirms a gate.
- `scripts/jsongen/prune-final-evidence.mjs`: the existing optional preparation
  accepts that opaque completion and matches complete frozen pollutant content,
  effective status, per-series counts, canonical bodies/files, exact selectors
  and every leaf against the original captured bytes. It adds only the versioned
  `original_final_batch.exact_only_completion` field for schema-2 evidence.
  It remains precommit/unverified. Schema-1 envelopes omit this field and retain
  their original structure/meaning. Existing compression, evidence bundle,
  1 MiB outbox pointer and bundle/final-batch hashes carry the extension unchanged.
- `tests/jsongen_prune_exact_only_completion.test.mjs`: six narrow local checks
  reuse the existing original-event fixture and real serialized Parquet to
  protect the new confirmation/identity boundary.
- This implementation handover and exact pre-change copies of the three active
  modules under `archive/2026-11-03/` complete the change. Archives are never run.

No separate publication pipeline, persistent cache, permanent proof tree,
check-history table, database migration or configuration key is introduced.

## One existing dataset identity

The signed PENDING object's **existing key** is the dataset identifier. It already
contains the connector/day, original invocation UUID and compressed/uncompressed
source SHA-256. It is retained verbatim as `pending.object.key` in original final
evidence, `pending_object_key` in the immutable optional outbox and
`message.pending.object.key` in the existing post-COMMIT reference. The small
schema-2 extension calls the identical key `dataset_id`; it does not mint an ID.
Existing source-content hash/version/count, pending intent and preparation/source
evidence digests supply the remaining exact correspondence.

The original mandatory finalisation validation, matched candidate/gate transaction,
SAVEPOINT-isolated optional insertion and acknowledged COMMIT remain unchanged.
Only the existing original committed outbox can provide durable acceptance;
prepared bytes/opaque completion alone cannot confirm PENDING. Missing/failed
optional preparation remains caught by the existing best-effort caller and cannot
block an otherwise valid canonical operation or deletion. Lost or ROLLBACK COMMIT
acknowledgements still cannot produce a successful post-COMMIT handover.

An index-only conversion has no event-producing route in the modified publisher.
A separate invocation cannot reuse an old PENDING source to prepare confirmation,
even with identical observations. Historical receipt bytes are never rewritten.
The conversion executor and any later current-selector equivalence handling are
outside this stage.

## Physical reads and preserved boundaries

With checksum-capable authenticated HEAD admitted **at initial preparation**, the
latent path performs **one full actual Parquet inspection per file**, replacing
its former two inspections. Completed-root acceptance reuses the original physical
result but still reads/reconciles actual current canonical/index JSON and checks
file SHA/size/current ETag. It does not treat footer/size checks as lossless data
comparison. Existing writer lossless source-to-final comparisons are untouched.

Without such HEAD capability, the same identity boundaries still GET/hash the
complete file bodies. These are identity checks, not repeated physical decoding.
The local one-scope check observes one full GET per file and eight checksum HEADs
through completion extraction; without HEAD it observes nine full identity GETs
per file and no HEADs. Before the new optional extraction, counts are one GET +
seven HEADs, or eight GETs without HEAD, compared with #157/#158's two GETs + seven
HEADs, or nine GETs without HEAD. Source decoding/writing and independently
required lossless writer comparison reads are separate and retained. These are
local adapter counts, not measured deployed R2 performance or storage savings.

Exact guards still preventing activation:

1. `OBSERVATION_HISTORY_EXACT_ONLY_PUBLICATION_ACTIVE_V3 = false` in the shared
   index finalizer, which rejects actual schema-2 bytes before mutation/evidence
   adapters; there is no caller/environment override.
2. The operational Prune connector verifier still invokes
   `rejectExactOnlyOriginalHandoverV3()` on schema-2 selection before READY/gating.
   No active writer is wired to the latent publisher or its completion handle.
3. Original final-evidence preparation still rejects schema 2 without a genuine
   completed operation handle. Copied JSON/flags are insufficient.
4. JSONgen's consumer and `authority.mjs:exact()` remain unchanged and fail closed
   for unsupported schema-2 original authority. Managed selection remains disabled.
5. The independent inspector still supports physical schema 3 / writer v3 /
   observation hash v1 only; schema-4/hash-v2 rebuild is not inferred from reading.

## Local validation

No external data services were accessed. Existing dependencies were installed
with `npm ci --ignore-scripts --no-audit --no-fund --cache work/npm-cache`.
For deterministic local JSONgen checks the command environment was:

```sh
export UK_AQ_ENV_NAME=TEST
export UK_AQ_JSONGEN_R2_BUCKET=local-derived-fixture
export UK_AQ_JSONGEN_R2_ENDPOINT=https://local-fixture.example
```

These are process-local fixture settings, not repository/deployment changes; all
new test reads/writes use in-memory adapters, never the fixture URL.

Final focused commands (31 passing checks, zero failures/skips):

```sh
node --test --test-isolation=none tests/jsongen_prune_exact_only_completion.test.mjs tests/uk_aq_observation_history_exact_leaf_writer_contract.test.mjs
# 9 pass: 6 new boundary checks and 3 existing writer/reader checks.
node --test --test-isolation=none --test-name-pattern='optional Prune outbox|optional evidence constraint|duplicate immutable|candidate mismatch|unrecoverable outbox|ambiguous COMMIT|failed COMMIT|v3 finalization|schema-2 committed' tests/uk_aq_prune_history_gate.test.mjs tests/uk_aq_prune_committed_history_guard.test.mjs
# 19 pass, including 10 finalisation-failure subchecks.
node --test --test-isolation=none --test-name-pattern='pre-commit final preparation|COMMIT acknowledgement|default-off Prune completion' tests/jsongen_prune_pending_source.test.mjs tests/uk_aq_prune_history_gate.test.mjs
# 3 pass: schema-1 preparation, default-off completion, lost/ROLLBACK COMMIT.
```

Every changed module and the new test passed `node --check`; direct module imports,
`git diff --check`, archive identity checks and the explicit inactive/configuration
boundaries were checked. Tests outside the named patterns were intentionally not
selected; no Python or broad repository suite was run, and no worker gate/control
flow was modified.

An exploratory run of the entire existing pending-source file returned **2 pass /
8 fail**. An isolated checkout of unchanged baseline `2d820608` reproduced the
**same eight test names/failures**: stale signer/config fixtures, changed diagnostic
expectations and missing explicit reader target setup. These unrelated failures
are not repaired here; the directly affected schema-1 preparation test passes.
An earlier combined run without complete fixture configuration was terminated by
the local runner; subsequent checks were bounded and explicitly configured.

## Stage 2 and documentation handover

Update JSONgen's existing independent consumer/original-evidence authentication
and current exact-selector inspection to understand this versioned schema-2
completion and the identical pending key, without a second canonical Parquet
scan. Preserve receipts 1–3, original event identity and index-only equivalence.
Then close the remaining compatible provider/reader/repair/reconstruction gates,
review the real owning-writer finalisation adapter and wire the original invocation
and completion handle into the existing optional Prune preparation. Do not remove
either activation guard just because the preparatory interfaces now exist.

Separately authorised deployment and real TEST Prune/consumer acceptance must
prove complete source-to-final scope, original finalisation and gate/COMMIT,
PENDING-to-CONFIRMED matching, optional-failure independence and bounded resource
behaviour. Managed monthly publication remains a separate gate. Integrity,
SOS-light, IFW, schema-1 conversion and storage retirement remain outside this task.
No functional acceptance is claimed.

There is no newly discovered authoritative contract conflict. ChatGPT may record
this TEST code milestone and its minimal versioned evidence field in system docs;
this task has not edited authoritative `system_docs/`. Before future activation,
rollback is a code revert only. Never roll back a future selected scope to stale
schema-1 authority or remove historical data/receipts as a code rollback.
