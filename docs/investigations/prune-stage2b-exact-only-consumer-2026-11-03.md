# Prune Stage 2B: dormant producer handoff and independent exact-only consumer

3 November 2026. TEST code only, based on current Ops main
`62152b4589e8446e491f2115d818574af247c415` (merged #167/#168), using authoritative
system-docs main `a7b587e62159dd1b6bb105eca50bde6279ef4ca6` and its 3 November
contracts. Authoritative `system_docs/` is unchanged. No operational service,
Prune, migration, conversion, deployment, merge or LIVE action was performed.

## Producer and the deliberate inactive boundary

The actual Phase B publication call passes its original coordinator capability
into the existing shared owning writer. A Prune-only preparation seam runs
between durable canonical child publication and exact-index publication **only
if genuine schema-2 artifacts are selected**. It inspects actual pinned physical
bytes through the existing verifier, matches the canonical child and the exact
prepared selector/leaf bytes, and returns the original opaque same-session
proofs. The writer forwards those handles in its connector result; Phase B
preserves them in its export result, so the existing #168 pre-gate batch adapter
and asynchronous final-evidence preparation can consume them. They are never
serialized into substitute capabilities. Schema-1 publication adds no physical
reads or extra original-session requests at this seam.

The existing mandatory source-to-final comparison and operational connector
verification, checked batch, parent/latest, candidate/source/READY and protected
original gate/outbox transaction remain distinct. The pre-gate completion reuses
the initial physical inspection; it does not decode Parquet again for handover.
Existing original-session assertions through protected COMMIT remain unchanged.
An optional preparation/upload/outbox failure does not invalidate otherwise-valid
canonical work; actual original-session loss remains mandatory/fatal. Failed,
ROLLBACK or ambiguous COMMIT cannot return successful original acceptance.

**No executable schema-2 producer is enabled by this PR.** The normal shared
partition builder still emits schema 1. The hard
`OBSERVATION_HISTORY_EXACT_ONLY_PUBLICATION_ACTIVE_V3 = false` and operational
Prune schema-2 rejection before READY are unchanged. In particular, the existing
split connector-publication/batch-finalisation writer is not granted the generic
publisher's complete schema-2 lifecycle merely by passing a proof. A future
producer activation must select the accepted schema-2 artifacts and supply the
accepted publication lifecycle across those phases, with original identity,
immutable-leaf/selector, completed-root and batch/latest checks, before lifting
any guard. The older generic run-artifact lifecycle is not reinterpreted as a
Prune checked-batch completion. This is the precise remaining producer execution
dependency; the safely dormant preparation/propagation and independent consumer
are reviewable without removing any activation guard.

## Exact matching and logical CONFIRMED

The immutable original PostgreSQL outbox is still the trust root. The existing
private reader authenticates its actual committed SELECT, original key/attempt,
source/candidate/gate and exact retained evidence bytes. The existing inline and
immutable gzip bundle codecs, signed intent identities, bundle shell identity,
original-before absence and original Core binding authentication remain.

For schema 2, the consumer explicitly requires the Prune-specific nested
`original_final_batch.exact_only_completion.schema_version = 2`; it never
reinterprets the older generic schema-1/run completion. It checks:

- `dataset_id == pending.object.key == original outbox.pending_object_key`,
  also bound by the reconstructed post-COMMIT reference, original invocation,
  source evidence digest and complete source identity;
- the versioned checked batch projection, exact affected-day metadata,
  canonical aggregate/latest references and complete batch latest membership;
- exactly the original connector/day pollutant set, accepted verifier/inspector
  and schema-3/writer-v3/hash-v1/decode-profile identity;
- exact root-to-day/connector/pollutant identities, direct canonical descriptor,
  selected selector and every immutable revision leaf; complete canonical files,
  groups, per-file/per-series membership and row totals;
- the unchanged private PENDING gzip/uncompressed size/SHA and complete NDJSON
  source/effective P/R/null status and applicable raw source-status provenance.

Only after **all** original authority and private source authentication succeeds
does the existing in-memory result include `dataset_state: CONFIRMED` and that
same signed dataset key. There is no second durable state machine, table, object
catalogue, receipt version or delivery endpoint. Retention failure can still leave
registration incomplete after original authentication; CONFIRMED is neither a
monthly pubID nor a later-currentness claim. Original missing/incomplete events
remain replayable by their existing original primary key.

All original AURN pollutants are authenticated before the unchanged selected
PM2.5/PM10/NO2 receipt policy. Unsupported pollutants are accounted explicitly.
Existing whole-event selected descriptor/receipt grouping, immutable retention,
partial recovery and managed-control CAS registration are reused. Historical
schema-1 evidence/results and receipt versions 1/2/3 retain their meanings and
bytes; schema-1 authentication emits no new dataset-state fields.

## Current exact metadata and index-only no-event handling

The canonical inspector recognises exact formats explicitly. Its schema-2 branch
reads **JSON metadata only**, authenticates the current root-to-pollutant chain,
direct canonical descriptor, complete selector/immutable leaf set, physical file
and row membership, accepted writer/hash/profile and revisions. Schema 4 and
unsupported observation hashes remain rejected. Missing, contradictory,
superseded or ambiguous metadata is a scope/currentness blocker, with no
canonical Parquet fallback.

Only selected, validated immutable leaf keys can expand the existing metadata
request plan. The original fixed GET/byte/cache/deadline/concurrency ceilings
remain; at most 1,024 leaf dependencies are admitted for the invocation. A
complete set that cannot fit is blocked rather than partially authenticated.
Report validation and lossless compact reports account for these dependencies;
existing schema-1 report shapes retain their original meaning.

For a changed schema-2 selector, historical original evidence is equivalent only
when the exact original canonical source bytes remain root-authenticated, the
new direct selector/leaf binding validates, the original physical digest agrees
and current binding/status checks pass. Unproven canonical equivalence returns
`unavailable`. This read-only path creates no upload, dataset event, receipt or
JSON regeneration and rewrites no historical receipt. No conversion executor is
implemented. Matching known original events still does not prove all later
writers, absolute freshness or canonical dominance.

## Changed files and reused interfaces

Active producer files:

- `workers/shared/uk_aq_observation_history_exact_only_publication_v3.mjs`
- `workers/shared/uk_aq_observation_history_steady_state_writer_v3.mjs`
- `workers/uk_aq_prune_daily/phase_b_history_r2.mjs`

Active consumer/metadata files:

- `scripts/jsongen/prune-consumer-authentication.mjs`, `prune-consumer.mjs`
- new `scripts/jsongen/prune-exact-only-authentication.mjs`
- new `scripts/jsongen/exact-only-metadata.mjs`
- `scripts/jsongen/authority.mjs`, `currentness.mjs`, `inspection-plan.mjs`,
  `limits.mjs`, `report-validation.mjs`

Tests: new `tests/jsongen_prune_exact_only_integration.test.mjs`, extended
`tests/jsongen_currentness.test.mjs` and existing shared
`tests/jsongen_prune_consumer_fixture.mjs`. Fixtures use actual serialized local
Parquet and in-memory/fully intercepted storage/PG; they do not execute an
operational schema-2 publication or confer functional TEST acceptance.

Eight newly in-scope existing implementation files have byte-exact pre-change
copies under `archive/2026-11-03/`. Existing same-day copies for publication and
Phase B are reused unchanged, per once-per-day policy. Archives are never
imported or run. The verifier, checked-batch module, final-evidence/bundle/outbox
interfaces, receipt schemas/builders and managed control implementation are
unchanged. No SQL or configuration name was introduced.

## Validation

All 12 changed/new active modules import successfully; all 15 active/test modules
pass `node --check`. `git diff --check` and exact new archive identity checks
pass. No Python suite was run. Process-local synthetic configuration is provided
by `node --import ./tests/jsongen_test_environment.mjs`; all tests below use local
adapters, not that synthetic endpoint.

Focused final commands:

```sh
node --import ./tests/jsongen_test_environment.mjs --test --test-isolation=none \
  tests/jsongen_prune_exact_only_completion.test.mjs \
  tests/jsongen_prune_exact_only_integration.test.mjs \
  tests/jsongen_currentness.test.mjs tests/jsongen_selected_event.test.mjs
# 31 pass / 0 fail / 0 skipped
node --import ./tests/jsongen_test_environment.mjs --test --test-isolation=none \
  tests/jsongen_prune_exact_only_completion.test.mjs \
  tests/jsongen_prune_exact_only_integration.test.mjs \
  tests/uk_aq_prune_original_operation.test.mjs \
  tests/uk_aq_observation_history_exact_leaf_writer_contract.test.mjs
# 20 pass / 0 fail / 0 skipped (12 overlap the prior command)
node --import ./tests/jsongen_test_environment.mjs --test --test-isolation=none \
  --test-name-pattern='original-session assertions|optional evidence constraint|COMMIT acknowledgement|default-off Prune completion|v3 finalization|pre-commit final preparation|schema-2 committed' \
  tests/uk_aq_prune_history_gate.test.mjs tests/jsongen_prune_pending_source.test.mjs \
  tests/uk_aq_prune_committed_history_guard.test.mjs
# 19 pass / 0 fail / 0 skipped, including 10 finalisation subchecks
```

These cover 58 distinct passing checks. Node's name filter excludes unrelated
checks; it reports zero skips. No operational acceptance is inferred.

The required complete local Node suite ran **once** after focused checks:

```sh
export UK_AQ_ENV_NAME=TEST UK_AQ_GITHUB_REPO=fixture-org/fixture-ops
export UK_AQ_JSONGEN_R2_BUCKET=fixture-derived-bucket
export UK_AQ_JSONGEN_R2_ENDPOINT=https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com
mapfile -t test_files < <(rg --files tests -g '*.test.mjs' | sort)
node --test --test-concurrency=1 --test-timeout=120000 --test-reporter=tap "${test_files[@]}"
```

Result: **128 file processes, 82 pass / 46 fail / 0 cancelled / 0 skipped**,
102.1 seconds, exit 1. The new integration and extended currentness test files pass. Earlier
Stage 2A recorded 127 file processes, 81 pass / 46 fail, with 38 established
pre-existing failing files and eight indeterminate/environment-dependent cases;
that historical evidence is not recast as a green suite.

Baseline comparison: all **46 of the same failing file processes reproduced**
on unchanged `62152b45`, using the identical process-local environment, Node
runner options, concurrency and per-file timeout, restricted to those 46 files:
**0 pass / 46 fail / 0 cancelled / 0 skipped**, 55.7 seconds. There is no newly
failing file in this comparison. This is file-level reproduction, not a claim of
identical individual failure sets inside every file. No full baseline suite was
rerun; the existing Stage 2A evidence and this selected-failure comparison remain
separate from the 58 passing focused checks.

The unchanged-main focused comparison additionally returned 29 pass / 6 fail
across the original completion, consumer, currentness and selected-event files.
All six are the legacy consumer fixture's missing operation-specific credential
mode, reproduced with the same six failing tests in the changed tree (3 pass /
6 fail in that file alone). The new end-to-end consumer regression uses the real
read/write configuration factories and fully intercepted HTTP, and passes.
No unrelated suite repair was attempted.

## ChatGPT documentation handover and remaining gates

ChatGPT in Chat mode may record this as inactive TEST producer-preparation and
independent schema-2 original-event/current-metadata support, including the
Prune checked-batch representation, exact same signed dataset key and logical
CONFIRMED result. Do not record deployed schema-2 Prune success, a new receipt
version, changed historical receipts or real functional acceptance.

The remaining gates are explicit:

1. Separately approved schema-2 owning-producer selection and complete publication
   lifecycle across connector/batch phases; the hard inactive constant and
   operational pre-READY rejection remain closed here.
2. Accepted compatible providers/readers/cursors, Prune verification, repair,
   reconstruction and backup support before any schema-2 scope is selected;
   unsupported guards and retained schema-1/_aligned/v2 data remain.
3. Separately authorised TEST deployment and real original-session Prune,
   signed upload, canonical source/index/parent/latest verification, protected
   gate/outbox COMMIT, independent reader, receipt recovery/registration and
   interruption/lock-loss/ambiguous-COMMIT acceptance. Local fixtures do not
   establish deployed resource budgets, credentials/rights or operational parity.
4. Independently proved later-writer coverage, coherent currentness/freshness,
   complete-month baseline/PM context, paired monthly publisher and CAS
   acceptance before enabling managed publication or chart cut-over.

Regular managed JSONgen takes no canonical PostgreSQL/global/month lock. Its
separate R2 CAS control and the manual Dropbox bootstrap's short original-lock
currentness checks are unchanged. Integrity/SOS-light/IFW, conversion execution,
old-object retirement and LIVE work remain out of scope. No deployment/apply/run
command is authorised for this stage. Before activation, rollback is a code
release revert; preserve canonical data, original outboxes and immutable receipts.
