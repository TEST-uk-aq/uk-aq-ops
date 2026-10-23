# JSONgen managed-control ETag correction — 23 October 2026

Code-only TEST correction. No merge, deployment, service access, workflow dispatch,
retention or replay was performed. Real functional acceptance remains for TEST
after merge and separate operational authorisation.

## Authority and changed files

Read TEST system-docs at `5e46df3e34dc41f0c228792e470a6d0d7d32b200`:
`system_docs/SYSTEM_OVERVIEW.md` → `station_charts/README.md` →
`jsongen_prune_verification_handover_quick_reference.md`,
`compressed_history_json_verified_writer_regeneration_contract.md` (Stage 2
and CAS requirements), and the relevant signed-ingestion amendment boundaries.
Implementation base: TEST Ops `123b63dbd9ed87ebf93265224d8beec6c39a7910`.
Authoritative system docs were read only.

- `scripts/jsongen/control.mjs`: ordinary and shared-budget control GETs now
  explicitly request `Accept-Encoding: identity`.
- `workers/shared/r2_sigv4.mjs`: `r2GetObjectBounded()` adds
  `accept_encoding_identity = false`. Explicit true adds the signed request
  header and forwards the option to bounded adapters. Omitted/false preserves
  existing requests and adapter argument shape. One attempt, streamed byte and
  Content-Length validation, cancellation, deadlines, redirect policy and
  control budget/transfer accounting are unchanged.
- `archive/2026-10-23/workers/shared/r2_sigv4.mjs`: exact pre-change helper.
- This operator handover.

Today's existing `archive/2026-10-23/scripts/jsongen/control.mjs` is reused
unchanged, as required by AGENTS.md's once-per-day rule. It is today's original,
not a new snapshot of the later Stage 2 implementation. The new helper archive
is byte-identical to the pinned implementation base. Archives are reference only;
no active path imports or executes them. No LIVE archive was accessed or made.

## Strict acknowledgement and readback boundary

`isStrongR2Etag()` and conditional-write admission are unchanged. A weak
`W/"..."` response is never stripped, accepted as strong or converted into a
new validator. A conditional PUT with weak/missing acknowledgement ETag still
raises `R2_WRITE_AMBIGUOUS`; there is no new PUT retry or weakened admission.
PUT request/response handling did not need a behavior change: the existing
control caller resolves both acknowledged and ambiguous writes through
`readManagedControl()`, which now requests identity in both modes and still
requires valid exact body bytes and an authoritative strong ETag.

Exact attempted control SHA-256 and operation identity must match readback for
`written` / `confirmed_after_ambiguous_write`. The existing separately named
`registered_confirmed_in_newer_control` outcome requires a validated,
strong-ETag authoritative read whose complete registered descriptor, original
authority, event/group and receipt references match; it does not claim the
attempted operation won CAS. Missing, weak, invalid or unavailable control
readback stays fail-closed. A 412 still reloads/revalidates before bounded
rebasing; an ambiguous payload is never blindly repeated.

Descriptor v1, receipt v1/v2/v3, control v1/v2 and reconciliation v1–v4 wire
formats, hashes, identities and exact predecessor-byte ancestry are unchanged.
No environment variables, target literals, configuration, schemas, credentials,
workflow changes, scheduler, publisher or default-chart changes were added.
The manual read-only workflow keeps READ credentials only.
`selectManagedPublications()` remains unconditionally disabled.

## Supplied operational evidence, not re-executed here

The operator reports original authentication of 37 pollutants / 940 scopes /
22,540 rows, with one descriptor, six selected bundles and six v3 receipts
retained and independently verified. The operation stopped at
`control_registration` with `ambiguous_r2_write_outcome`; no event is registered.

Reported valid schema-v1 control: revision 0, zero registrations, 471 bytes,
SHA-256 `83184a0a7de9e9d9c7367334efaa3d5c9e9dfcf035c2ff22273b7e0058445f1f`.
Default GET returned weak ETag `W/"45cb9616602347c3b75ac30bb92d39bc"`;
identity GET/HEAD returned `"45cb9616602347c3b75ac30bb92d39bc"` with unchanged
body size/hash under both READ and WRITE credentials. This explains why
initialisation could have committed even though its readback was rejected.
It does not authorise resetting, replacing or deleting that control.

## Structural validation

Node v24.19.0; no dependency changes or new tests. Current pinned TEST module
dependencies were materialised in an isolated work directory because shell Git
fetch could not connect to the workspace proxy. Connected GitHub tools supply
the pinned base and publish only the four intended paths.

Passed:

```bash
node --check scripts/jsongen/control.mjs
node --check workers/shared/r2_sigv4.mjs
node --input-type=module -e "await import('./scripts/jsongen/control.mjs'); await import('./workers/shared/r2_sigv4.mjs'); console.log('Syntax/import validation passed');"
node --test --test-isolation=none --test-reporter=tap --test-name-pattern='bounded GET rejects' tests/jsongen_stage2.test.mjs
```

The existing deterministic bounded-GET check passed: 1 test, 0 failures.
Isolation was disabled to obtain the named test result; the default isolated
runner reported only a file-level result in this environment. No broad suite,
new fixture program or functional acceptance was attempted. Diff/whitespace
and exact helper-archive fidelity were also checked. Review confirms all
encoding changes are opt-in and no control validation/CAS code was relaxed.

## Safe TEST recovery after merge — operator only

These are future procedures, not commands executed by this change. Keep Prune
paused, publication disabled and the read-only Action unchanged.

1. Use the reviewed merged TEST checkout and existing approved TEST
   environment, repository, private database/TLS and private R2 configuration.
   Retain the failed run's private report, original acceptance and all immutable
   object identities. No credential or GitHub setting change is needed.
2. Before any write, use the corrected `readManagedControl()` with
   `managedR2ReadConfig()` in an approved read-only operator session. Preserve
   its exact body, SHA-256, strong ETag, control ID, operation ID, revision and
   registration maps. Compare to the supplied 471-byte fingerprint. A changed
   hash or revision requires reconciling the actual current state, not restoring
   the old fingerprint. Absence, weak ETag or invalid body is a stop condition.
   Do not initialise again: the reported control already exists.
3. Only after resolving current authoritative state and obtaining separate
   TEST write authorisation, use the existing bounded original-event replay
   with approved WRITE configuration. Do not rerun Prune. Do not add
   `--initialize-control`. The discovery window and command remain:

   ```bash
   node scripts/jsongen/prune-consumer.mjs \
     --execute-retain --discover resweep \
     --from 2026-10-21T14:53:00.000Z --to 2026-10-21T14:55:00.000Z \
     --limit 1 --process --output "$PRIVATE_REPORT_DIR/stage2-recovery.json"
   ```

   Use an approved private output directory and distinct report names.
   Each independent invocation reauthenticates original evidence and confirms
   existing immutable bytes; matching objects are reused, never overwritten.
4. Require original 37/940/22,540, selected 433 scopes / 10,382 rows and
   unsupported 507 / 12,158; exactly the same descriptor, six bundles and six
   v3 receipts with independent readback. If control is still the reported
   empty v1 revision 0, require one complete-event CAS to v2 revision 1 with
   predecessor SHA-256 equal to the preserved exact revision-0 bytes. The
   control ID must remain unchanged. No partial event is acceptable.
5. Preserve authoritative post-write control bytes/strong ETag and private
   report. After success, a separately authorised identical bounded replay
   must return `already_retained` with unchanged immutable identities and
   unchanged control revision/hash. Registration does not establish current
   canonical dominance, writer coverage, monthly baselines or publication.
6. If acknowledgement/readback remains ambiguous, stop and retain attempted
   identity plus exact current control evidence. Resolve authoritative state
   before another write. Never manually splice receipts, delete retained
   objects, reset control or restore stale bytes over newer revisions.

No apply/deploy command is needed for this library correction beyond the
reviewed checkout/dependency process described in `prune-stage2-handover.md`.
No deployment or operational action is authorised by this PR.

## Rollback and system-doc maintainer handover

A reviewed code revert can undo request-encoding changes. Preserve all retained
objects and current control; code rollback never authorises state rollback.
Once v2 control exists, v1-only readers cannot safely be restored. Prefer a pause
or reviewed forward fix rather than restoring an earlier control revision.

For Chat-mode documentation ownership: record the operator-supplied partial
Stage 2 retention, initialised revision-0 control and representation-specific
ETag failure separately from this code fix's structural acceptance. Link the
PR and later genuine TEST recovery evidence. No prose contract behavior,
schema or environment configuration amendment is required; real atomic
registration/replay acceptance remains pending.
