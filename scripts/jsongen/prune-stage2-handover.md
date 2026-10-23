# JSONgen Stage 2 implementation handover — 23 October 2026

This is TEST code for review, not operational acceptance or permission to run it.
Authority: `TEST-uk-aq/uk-aq-system-docs` commit
`5b4ddb3b256e612059cf1d2f7c4b77138bac6e68`, Station Charts verified-writer
regeneration contract, **23 October Stage 1 acceptance / Stage 2** section.
Final base TEST Ops main: `cbc0e207732861d0dd46a37739fb603e956c77fa`, including #120.
The implementation began at accepted `c49cd1b756e260b3b254fda183c41d5418503f07`
and rebased over two subsequent Node 24 workflow/runtime commits; no JSONgen
implementation file changed in that base update.
System docs were read only.

## Follow-up correction to reviewed head a75f696 — 23 October 2026

Unknown or malformed selected receipt inputs now fail with typed
`conflicting_selected_receipt` **before** partition artifact lookup. Exact receipt,
immutable reference, complete record and authenticated descriptor comparisons
and private capabilities are unchanged.

The shared original-event implementation is environment-independent. The same
complete approved files must eventually be promoted from TEST; LIVE must use
separate explicit configuration and receive separate operational authorisation.
No LIVE repository, configuration, deployment, credential or service was used.
Only the previously authenticated TEST 15 October event has real Stage 1
acceptance. No real Stage 2 retention or registration is accepted by this PR.

`environment.mjs` validates canonical environment names structurally:
`[A-Z][A-Z0-9_]{0,31}`. No default, coercion, case conversion or inferred identity
is allowed. `UK_AQ_ENV_NAME` selects execution identity, `UK_AQ_GITHUB_REPO` pins
repository identity, and GitHub metadata must match it. Consumer/inspection
entry points and the private original reader retain `workflow_dispatch` admission
in Actions. Shared R2 target configuration checks explicit environment/repository
identity without adding a manual-only gate to the original writer's existing
transport/scheduling; an R2 configuration alone never grants event authority.
READ/WRITE modes, explicit retain invocation, source capabilities and existing
credentials remain the operation boundary. No new environment variables exist.

The private reader captures execution environment before connecting; requested
primary keys, returned rows and discovery cursors must match it. Discovery now
binds environment as SQL `$1`, window `$2/$3`, limit `$4`, and resume tuple
`$5..$9`. Complete primary keys, source hashes, original insertion-time pagination,
restricted read-only role, RLS privilege checks and strict TLS/project binding
are preserved. Supabase and R2 hostnames select explicitly configured targets;
they never determine environment.

Pure acceptance, post-commit, evidence-bundle and receipt validators validate
historical labels structurally. Runtime authentication proves reader execution
identity = acceptance environment = handover/envelope environment = original
bundle identity = pending source environment = original before/Core binding
authority identity = configured R2 environment. R2 factories retain configured
identity privately in WeakMaps, outside immutable bytes. Retention, descriptor/
receipt/bundle reads, managed-control reads and registration also enforce this
agreement, so a caller cannot switch target context after authentication.

Shared pure source-description helpers accept an explicit historical environment
when reconstructing source evidence. New writer preparation uses explicit process
configuration; final envelopes and original-authority extensions preserve the
pending source's recorded environment. The shared signed-upload config helper
now uses generic configured admission without changing request/response fields,
signed bytes, original writer publication logic or the Worker protocol.

Historical TEST preservation was checked against a deterministic vector captured
twice **before editing a75f696**. The unchanged vector includes acceptance and
post-commit hashes, original source/evidence bytes, descriptor reference and all
canonical receipt bytes, partition/bundle identities and complete group hash.
Its SHA-256 remains
`2bee3bd8d5a83d67eb50fb896129c0ce48184eea60ad515888c481640b1717bc`.
Direct pre/post vector byte comparison also passes. This is a synthetic regression
and structural proof of unchanged TEST derivation; it does not claim a new read
of the private real event. No historical source is rewritten, re-signed or
migrated, and no runtime configuration fields enter the descriptor/receipt.
Descriptor v1, receipt v1/v2/v3, control v1/v2 and reconciliation v1–v4 retain
wire formats and existing meanings; no version bump is introduced here.

Bounded remaining TEST restrictions are deliberately outside this consumer
path: Stage A `diagnose.mjs`/`diagnostic-report.mjs`, manual offline Dropbox
bootstrap, signer transport acceptance checks and the deployment-only Wrangler
renderer remain TEST-pinned. These are separate tools/contracts, not fallback
paths. The signer Worker and original Prune writer are unchanged; their later
LIVE promotion/source-environment setup remains a separate prerequisite. This
follow-up does not make those operational components LIVE-ready. In particular,
original writer acceptance/capture environment literals were observed in its
direct callers and left untouched as required by this task's writer boundary.
There is no blocker or contract conflict for the bounded consumer/pure-helper
correction; no end-to-end LIVE acceptance is implied.

Current checks: **24/24** directly relevant environment + Stage 2 + read-only
planning checks pass. Existing older consumer/Stage 2 fixtures improve from
**30 pass / 18 fail** to **35 pass / 13 fail** after explicit synthetic
configuration is installed before static imports and fixture targets use that
configuration. Only five obsolete environment/reference cases are resolved;
remaining failing names are a subset of the same baseline. Twelve still stop at
explicit READ/WRITE capability checks (one expects a later writer-authentication
diagnostic), and one expects an obsolete binding diagnostic.
Application credential/authority validation was not weakened to pass fixtures.
Syntax checks and side-effect-free module imports are recorded in the PR.

The future operator procedure below still applies **only to a separately
authorised TEST operation**. Source `UK_AQ_ENV_NAME=TEST` with the approved TEST
repository, database and private R2 settings before process startup. Never label
TEST evidence as another environment. Do not create a LIVE workflow or run any
LIVE command from this handover. For authoritative system-doc ownership, record
the configured/historical/operational identity distinction, generic shared-code
admission, exact historical digest preservation and unchanged wire versions;
keep TEST-only acceptance and every LIVE/publication gate explicit.

## Formats and proof boundary

The previously unused independent durable descriptor family starts at
`schema_version: 1`, kind `uk_aq_jsongen_authenticated_prune_event`. It contains
`writer` and `coverage`: the authenticated Stage 1 plan without the transient
`descriptor_preview` envelope. `prune-event-schema.mjs` strictly checks known
fields, original acceptance/invocation/Git SHA, full source/status identities,
original compressed evidence reference (or authenticated legacy inline evidence
bound by acceptance), before/final/Core authority references, original scope
ordering, policy/dispositions, counts and all coverage digests. Reusable scope
authorities are interned once. Unsupported observations and expanded original
metadata bodies are absent.

Canonical JSON is the existing recursive sorted-key UTF-8 encoding with terminal
newline. Its actual bytes determine size/SHA-256 and the private object key:
`managed/jsongen/v1/authenticated-events/<sha256>.json` (maximum 8 MiB).
Full original, selected and unsupported coverage retain the existing versioned,
domain-separated Stage 1 digests. The deterministic selected partition group
hash covers the full partition plan, including each record and immutable bundle
identity. Bundle/partition planning precedes descriptor hashing. Receipt hashing
comes last, so no digest depends on itself.

Verified-change receipt **v3** retains the existing complete-scope NDJSON gzip,
P/R/null, explicitly unavailable provider status, typed PostgreSQL authority and
monthly/PM dependency semantics. Its origin binds the descriptor reference, a
compact original/selected/unsupported summary, exact policy and group hashes,
and its own partition/index. Original source row counts always describe the full
event. A receipt contains only one selected pollutant (`pm25`, `pm10`, `no2`),
at most 128 complete physical UTC days; no unsupported receipt or invented AQI.
Schemas 1/2 keep their exact previous validation and wire meanings.

`buildSelectedPruneEvent()` requires the existing private authenticated-handover
capability. Each independent invocation reauthenticates original PostgreSQL,
PENDING bytes and original evidence before constructing selected objects.
All partitions use that invocation's same authenticated source, rather than
re-reading it six times. The original operation budget is bound to the private
handover and retained capability; replacing/restarting it rejects. Stage 1
previews still grant no bundle artifact or retained authority.

Retention uses shared configuration and conditional `If-None-Match: *` PUTs:
descriptor first, then each selected bundle and receipt. Every object receives
exact SHA-256/size/byte readback; descriptor and receipt canonical shape and
bundle decompression/complete records are independently checked as well.
Matching pre-existing bytes are idempotent. Conflicting bytes fail closed.
PUT acknowledgement alone cannot mint the WeakMap-held retained-event token.
The token binds the exact descriptor and entire group and exists only in this
invocation; caller JSON, subsets and copied token properties are rejected.
The consumer reports descriptor readback progress even if later retention fails.

## Atomic control, compatibility and reporting

Managed control **v2** adds `authenticated_events`, with compact descriptor
reference, original acceptance, coverage/policy summary and ordered selected
receipt references. It does not embed the descriptor. Existing
`registered_changes` retain their validated receipt/reference/lifecycle records;
selected receipts add only selected monthly desired dependencies.

The first selected event migrates a validated v1 state inside the **same CAS**
that adds the complete event, all receipts and all dependencies. Control ID,
existing receipts, months, desired/applied sets, selected references, failures,
freshness and ordering are preserved except for directly affected dependencies.
Revision advances once, with predecessor hash over the exact prior stored bytes.
No standalone migration clears or resets state. Unknown control versions reject;
old v1 readers reject v2 rather than interpreting it as v1.

Only `retain_selected_prune_event` plus the private retained-event capability
can register selected receipts. Standalone receipt registration remains schema-1
only, and the old schema-2 complete-event command remains intact. Registration
re-reads the descriptor and all receipts, validates full selected coverage, and
uses strong-ETag CAS with the existing default three conflicts (hard maximum
five). A 412 reloads and validates current control before rebasing. A successful
or ambiguous write requires exact readback, or a fully matching event proven in
a newer validated control. Ambiguity never blindly repeats the attempted PUT.
Changed descriptor/source/policy/group cannot replace the same event identity.

Existing registered schema-2 events replay schema 2. For a wholly supported
original event, deterministic receipt GETs also discover partially/unregistered
legacy retention and complete that original group; no bucket listing is needed.
Both registration commands reject an event already registered in the other
family, including a competing CAS winner. Original schema-2 full-event coverage
is never relabelled selected coverage.

A zero-selected original event retains and registers its descriptor with
`no_selected_scopes` and an empty selected group. No empty receipt, bundle,
month dependency or publication work is created. Report retention fields say
`not_applicable_no_selected_scopes`. Empty caller groups cannot bypass the
private retained capability.

Reconciliation **v4 is necessary** to report zero-receipt descriptors and
original versus selected coverage without changing schema-3 `original_events`
meaning. Its separate `authenticated_events` table records descriptor retention,
original authentication, selected receipt retention and complete registration.
Legacy complete-original groups remain in `stage3c.original_events`. Compact
encoding/strict validation dispatch supports both 3/4 and preserves reports 1/2.
Selected descriptors and original source are independently reread/reconstructed;
missing/corrupt proof produces unavailable/reconciliation-required states.
Current selected scope inspection still uses the existing **128-scope**
metadata-only limit and source-as-of rules. Separate inspections are never a
coherent full-event snapshot. Original authentication, retention, registration,
current canonical dominance, all-writer freshness and monthly eligibility remain
different states. `selectManagedPublications()` still always throws.

## Bounds, configuration and outstanding work

Unchanged limits: 1,024 original scopes, 100,000 original rows, 128 scopes per
receipt, 32 receipts per event, 1 MiB per receipt, 8 MiB bundle gzip / 32 MiB
NDJSON and 8 MiB record caps, 4 MiB control, and the shared **120 s / 192 MiB**
original handover allocation. Original authentication, planning/reconstruction,
canonical descriptor/receipt construction, immutable PUT payloads/readbacks and
control operations use the same event budget. PUT counts and attempted payload
bytes are recorded as `derived_puts` / `upload_bytes` once writes occur; they
are charged in `derived_bytes`, not added twice to the total. GET response bytes,
CPU, sampled heap and process RSS retain their distinct meanings. Report numbers
are not a measured/enforced process RAM limit. Overflow stops optional handover
without altering or deleting original evidence.

No new environment variables, credentials, database DDL, signed-upload protocol,
workflow, scheduler or service are introduced. Reuse `UK_AQ_ENV_NAME`,
`UK_AQ_GITHUB_REPO`, `SUPABASE_URL`, `UK_AQ_JSONGEN_PRUNE_READER_DB_URL`, approved
Supabase CA/TLS, `UK_AQ_JSONGEN_R2_ENDPOINT`, `UK_AQ_JSONGEN_R2_BUCKET`, and the
operation-specific READ or WRITE access-key/secret pairs. See `r2-config.mjs` and
`prune-outbox-reader.mjs`. The writer/canonical credential cannot substitute for
the explicit derived WRITE credential. Missing target/credentials fail; no
environment fallback is added. The manual read-only Actions workflow is
unchanged and receives no WRITE credentials. The existing explicit CLI retain
mode is inert unless invoked deliberately; no retention workflow is added.

Real TEST write permissions/conditional behavior, actual 22,540-row retention
sizes/duration and end-to-end operational acceptance remain unproven in this PR.
Long-term control accumulation, compaction and retention/grace policy remain
unresolved. Control v2 still retains registered receipt metadata; the 4 MiB cap
will eventually require a further reviewed design. Nothing automatically deletes
unresolved original evidence, descriptors, bundles or receipts. JSONgen remains
outside canonical Dropbox backup. No new canonical database prerequisite was
identified. Other-writer/currentness/monthly-baseline/PM-context acceptance stays
separately blocked.

## Local validation

Node v24.19.0; no operational services or workflows were invoked. All fixture
HTTP requests are intercepted and restricted to in-memory private derived keys.

- Targeted Stage 2 + existing read-only planning: **18 pass / 0 fail**. Includes
  strict descriptor/reference/partial-group rejection, forged capability and
  restarted-budget rejection, immutable conflicts, incomplete retention recovery,
  zero selected, populated v1 migration, exact and legacy/orphan replay,
  CAS conflict/lost acknowledgement, selected/zero reconciliation and compact
  report validation, all-original unsupported authority and read-only isolation.
- A targeted 940-scope synthetic event has exactly 433 selected scopes, 507
  unsupported scopes, **1,880 synthetic rows** and six selected partitions.
  Measured descriptor **1,232,086 bytes**, control **739,612 bytes**, charged
  operation **23,203,774 bytes**, 14 attempted PUTs, about **3.4 seconds** processing.
  These are synthetic admission checks, not the real 22,540-row acceptance.
- Existing `jsongen_prune_consumer.test.mjs` + `jsongen_stage2.test.mjs`:
  **30 pass / 18 fail**, with exactly the same failing case names on unchanged
  base and implementation. Stale target/operation-specific credential fixtures
  and invalid legacy object references block those cases. They are not green.
- Syntax and whitespace/archive fidelity checks are recorded in the PR.
  No speculative broad suite or operational workflow was run.

## Future operator procedure — do not execute during this code task

1. Review/merge and separately authorise TEST deployment/retention. Keep the
   existing Prune pause and publication block. Use the reviewed TEST checkout,
   source the existing approved TEST configuration without printing secrets,
   install locked dependencies without install scripts, and configure strict
   Supabase CA verification. Do not provision/change credentials as part of a run.
2. Read and preserve the exact current control bytes/hash/strong ETag. If control
   is present, validate its identity/history and leave initialization off. If
   absent, obtain explicit permission for initialization; `--initialize-control`
   creates revision 0 separately before the complete event registration CAS.
3. The unchanged original acceptance discovery window is:
   `2026-10-21T14:53:00.000Z` through `2026-10-21T14:55:00.000Z`, resweep, limit 1.
   The existing read-only Action may confirm the event first with READ credentials.
   Never inject WRITE credentials into that workflow. Only after separate explicit
   write authorization use a protected operator session with derived WRITE mode:

   ```bash
   node scripts/jsongen/prune-consumer.mjs \
     --execute-retain --discover resweep \
     --from 2026-10-21T14:53:00.000Z --to 2026-10-21T14:55:00.000Z \
     --limit 1 --process --output "$PRIVATE_REPORT_DIR/stage2-first.json"
   ```

   `PRIVATE_REPORT_DIR` must already name an approved private location. No command
   above is an instruction to execute it now. Add `--initialize-control` only in
   the explicitly approved absent-control case; never reset existing control.
4. Require exactly one original event: 37 pollutants, 940 scopes, 22,540 rows;
   selected 433 scopes / 10,382 rows; unsupported 507 / 12,158. Expected selected
   NO2: 153 / 3,669; PM10: 134 / 3,213; PM2.5: 146 / 3,500. Validate one canonical
   descriptor reference/actual size/hash, six complete bundles and six v3
   receipts (two per selected pollutant), exact object readback, and zero
   unsupported receipts. Inspect the single control predecessor/revision and
   complete event references/dependencies. No intermediate control revision may
   contain a partial selected group. Preserve timing/CPU/heap/RSS, GET/PUT and
   byte counters plus private report and exact control evidence.
5. Run the identical bounded command again to a distinct private report path.
   Require identical descriptor, bundle, receipt, policy and group identities,
   identical control revision/hash and `already_retained`. Existing immutable
   bytes must be confirmed, never overwritten. Keep all evidence for review.
6. If separately authorised, use the existing read-only reconciliation interface
   and approved original reader to inspect v4 event states and at most 128
   selected current scopes per pass. Registration alone proves neither current
   dominance nor a full monthly baseline. Do not combine partitions as one
   coherent current snapshot. Confirm selector disabled, no monthly products or
   jobs, unchanged default charts and no LIVE activity. Do not rerun Prune.

## Failure, rollback and system-doc maintainer handover

Before any writes, code rollback is an ordinary reviewed revert. After any
future retention, preserve all immutable/orphan objects for deterministic original
replay. A partial retention failure must leave control unchanged; after diagnosis,
replay authenticates the original again and confirms matching retained bytes.
For ambiguous control results preserve attempted operation identity and inspect
exact authoritative state before retrying. Do not manually splice receipts,
reset control, downgrade its version or rerun the original canonical writer.

After a v2 control exists, old readers intentionally reject it. A source-code
revert alone does not make old binaries v2-compatible. Prefer a reviewed forward
fix or pause derived work; any exceptional state restoration needs separate
operator review and must preserve later revisions/dependencies. Never restore
an older control blindly over concurrent state. Mandatory Prune/canonical data
and normal charts do not depend on JSONgen recovery.

For Chat-mode system-doc ownership: document the descriptor v1 namespace and
strict canonical format, selected receipt v3, token-bound shared budget,
complete-event control v2 CAS migration/replay (including legacy orphans), and
reconciliation v4's separate original/selected/zero-event states. Link this PR's
structural evidence and future operator procedure. Record **code implemented,
real retention/CAS not yet accepted**. Keep currentness, complete intervening
writer coverage, PM baselines, publication, default charts and LIVE gated.
No system-doc files were modified by this implementation.

## Exact implementation and archive inventory

- `scripts/jsongen/README.md`
- `scripts/jsongen/control.mjs`
- `scripts/jsongen/currentness.mjs`
- `scripts/jsongen/inputs.mjs`
- `scripts/jsongen/limits.mjs`
- `scripts/jsongen/prune-consumer-authentication.mjs`
- `scripts/jsongen/prune-consumer-measurements.mjs`
- `scripts/jsongen/prune-consumer-partitions.mjs`
- `scripts/jsongen/prune-consumer.mjs`
- `scripts/jsongen/prune-event-schema.mjs`
- `scripts/jsongen/prune-receipts.mjs`
- `scripts/jsongen/prune-selected-event.mjs`
- `scripts/jsongen/prune-stage2-handover.md`
- `scripts/jsongen/reconcile.mjs`
- `scripts/jsongen/report-codec.mjs`
- `scripts/jsongen/report-validation.mjs`
- `scripts/jsongen/schema.mjs`
- `scripts/jsongen/writer-authentication.mjs`
- `tests/jsongen_prune_readonly_planning.test.mjs`
- `tests/jsongen_selected_event.test.mjs`

Exact pre-change active code copies (reference/rollback only):

- `archive/2026-10-23/scripts/jsongen/control.mjs`
- `archive/2026-10-23/scripts/jsongen/currentness.mjs`
- `archive/2026-10-23/scripts/jsongen/inputs.mjs`
- `archive/2026-10-23/scripts/jsongen/limits.mjs`
- `archive/2026-10-23/scripts/jsongen/prune-consumer-authentication.mjs`
- `archive/2026-10-23/scripts/jsongen/prune-consumer-measurements.mjs`
- `archive/2026-10-23/scripts/jsongen/prune-consumer-partitions.mjs`
- `archive/2026-10-23/scripts/jsongen/prune-consumer.mjs`
- `archive/2026-10-23/scripts/jsongen/prune-receipts.mjs`
- `archive/2026-10-23/scripts/jsongen/reconcile.mjs`
- `archive/2026-10-23/scripts/jsongen/report-codec.mjs`
- `archive/2026-10-23/scripts/jsongen/report-validation.mjs`
- `archive/2026-10-23/scripts/jsongen/schema.mjs`
- `archive/2026-10-23/scripts/jsongen/writer-authentication.mjs`

## Follow-up file and archive inventory

- `scripts/jsongen/README.md` — documentation/test; no code archive
- `scripts/jsongen/admission.mjs` — new exact original: `archive/2026-10-23/scripts/jsongen/admission.mjs`
- `scripts/jsongen/control.mjs` — reuse: `archive/2026-10-23/scripts/jsongen/control.mjs`
- `scripts/jsongen/environment.mjs` — new implementation file; no pre-change original
- `scripts/jsongen/inputs.mjs` — reuse: `archive/2026-10-23/scripts/jsongen/inputs.mjs`
- `scripts/jsongen/prune-consumer-authentication.mjs` — reuse: `archive/2026-10-23/scripts/jsongen/prune-consumer-authentication.mjs`
- `scripts/jsongen/prune-consumer.mjs` — reuse: `archive/2026-10-23/scripts/jsongen/prune-consumer.mjs`
- `scripts/jsongen/prune-evidence-bundle.mjs` — new exact original: `archive/2026-10-23/scripts/jsongen/prune-evidence-bundle.mjs`
- `scripts/jsongen/prune-evidence.mjs` — new exact original: `archive/2026-10-23/scripts/jsongen/prune-evidence.mjs`
- `scripts/jsongen/prune-final-evidence.mjs` — new exact original: `archive/2026-10-23/scripts/jsongen/prune-final-evidence.mjs`
- `scripts/jsongen/prune-original-authority.mjs` — new exact original: `archive/2026-10-23/scripts/jsongen/prune-original-authority.mjs`
- `scripts/jsongen/prune-original-metadata.mjs` — new exact original: `archive/2026-10-23/scripts/jsongen/prune-original-metadata.mjs`
- `scripts/jsongen/prune-outbox-reader.mjs` — new exact original: `archive/2026-10-23/scripts/jsongen/prune-outbox-reader.mjs`
- `scripts/jsongen/prune-outbox.mjs` — new exact original: `archive/2026-10-23/scripts/jsongen/prune-outbox.mjs`
- `scripts/jsongen/prune-pending-verification.mjs` — new exact original: `archive/2026-10-23/scripts/jsongen/prune-pending-verification.mjs`
- `scripts/jsongen/prune-receipts.mjs` — reuse: `archive/2026-10-23/scripts/jsongen/prune-receipts.mjs`
- `scripts/jsongen/prune-selected-event.mjs` — new exact original: `archive/2026-10-23/scripts/jsongen/prune-selected-event.mjs`
- `scripts/jsongen/prune-signed-upload.mjs` — new exact original: `archive/2026-10-23/scripts/jsongen/prune-signed-upload.mjs`
- `scripts/jsongen/prune-stage2-handover.md` — documentation/test; no code archive
- `scripts/jsongen/r2-config.mjs` — new exact original: `archive/2026-10-23/scripts/jsongen/r2-config.mjs`
- `scripts/jsongen/reconcile-cli.mjs` — new exact original: `archive/2026-10-23/scripts/jsongen/reconcile-cli.mjs`
- `scripts/jsongen/schema.mjs` — reuse: `archive/2026-10-23/scripts/jsongen/schema.mjs`
- `tests/jsongen_environment.test.mjs` — documentation/test; no code archive
- `tests/jsongen_prune_consumer.test.mjs` — documentation/test; no code archive
- `tests/jsongen_prune_consumer_fixture.mjs` — documentation/test; no code archive
- `tests/jsongen_stage2.test.mjs` — documentation/test; no code archive
- `tests/jsongen_test_environment.mjs` — documentation/test; no code archive
