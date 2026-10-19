# Prune-to-JSONgen first TEST acceptance readiness

Status: **implementation is present; end-to-end TEST acceptance is not complete.**
This document is an operator handover only. No Prune run, consumer invocation,
Stage 3C inspection, SQL, migration, credential change, R2 request, deployment,
schedule change or feature-flag change was performed for this review.

## Scope and reviewed source state

This covers only the supported selected-v3 `prune_daily_v3` AURN
(`connector_id=1`) first-publication path. It does not enable monthly generation,
publication or serving. Integrity, SOS-light and IFW handovers remain deferred.

The local Ops checkout was on `main` at
`8e47125ebc52ffc50218eba6ab6d9747f47a45b8` (the supplied PR #114 merge), with a
clean working tree before this document was added. The merged #111/#113/#112/#114
implementation and package dependencies were present; Node.js and `pg` are
available locally. Relevant source archive snapshots dated 2026-10-18 are already
present. Since this change is documentation-only, no code archive was made.
The sibling TEST Schema checkout was clean on `main` at
`a6db0cf4ec5683e7f9f16c71438cfcf8b853401f`; the Schema #12 migration file is
present. No database state was queried. Per the task background, that migration
and the dedicated LOGIN are still pending.

The local Prune workflow is `workflow_dispatch` only. Its tracked external
scheduler manifest has `uk_aq_prune_daily` disabled. The operator reports that
the actual Prune schedule is paused; the remote Cloudflare D1/Worker state was
not inspected, so that state remains operator-reported, not independently
verified. The operator also reports
`UK_AQ_JSONGEN_PRUNE_PENDING_SOURCE_ENABLED=true`; it was not changed or checked
against live GitHub Actions settings.

Use these states distinctly:

| State | Finding |
| --- | --- |
| Implemented in source | Producer, restricted-reader consumer, receipt retention, whole-event registration and Stage 3C code are present in merged Ops main. |
| Structurally reviewed here | Code paths, contract alignment, local workflow/config wiring and local source revisions were inspected. No code defect requiring a correction was established. |
| Deployed/configured remotely | Not verified in this review. Worker deployment, GitHub settings/secrets, R2 permissions, PostgreSQL roles/policies and remote scheduler state must be checked by operators. |
| Operationally accepted | Not achieved. There is no real end-to-end TEST AURN VERIFIED event. |

## Blockers and readiness decision

There is **no confirmed application-code defect** in the supported path from
this structural review. An integration failure is not inferred from the absence
of a real run. The unresolved items below are prerequisites or evidence gaps;
they should be checked in TEST before authorizing the first non-dry-run Prune.

| Category | Location / requirement | Evidence and status | Can code safely resolve it? / next action |
| --- | --- | --- | --- |
| A. Application code | `workers/uk_aq_prune_daily/phase_b_history_r2.mjs`; optional path must not weaken mandatory selected-v3 verification, gate eligibility or deletion rules. | Source ordering and SAVEPOINT isolation are present; no defect established. | No change indicated. Confirm actual event and original Prune outcome during the separately authorized TEST run. |
| B. External configuration | `.github/workflows/uk_aq_prune_daily.yml`, signer Worker and local consumer environment. | The workflow wires existing variables/secrets. Current remote values and deployed code version are unverified. The operator-reported pending-source flag is preserved. Local `config/uk_aq_github_env_targets.csv` maps the existing reader/repository configuration, but the local `env-vars-master.csv` does not contain `UK_AQ_GITHUB_REPO` or `UK_AQ_JSONGEN_PRUNE_READER_DB_URL`; the current shell has no relevant TEST runtime variables sourced. No secret values were read or printed. | Existing settings, secret custody and deployment must be checked by the TEST operator. For manual consumer/3C work, update the existing private local variable catalogue through its normal process; no new variable name is required. |
| B. Prune dry-run selection | Workflow input `dry_run`, `INGESTDB_PRUNE_DRY_RUN` and `workers/uk_aq_prune_daily/job.mjs`. | Checking the input forces `true`; leaving it unchecked falls through to the repository variable. The workflow substitutes `'true'` if that variable is absent. Thus unchecked is not a request for a real run. | No code change indicated. Read the effective TEST Actions variable before a run. If it is true or absent, a non-dry-run operation requires a separately approved variable change. |
| B. Prune operation scope | Workflow and `UK_AQ_R2_HISTORY_MAX_CANDIDATES_PER_RUN`. | There is no workflow input that targets a named connector-day. Candidate count defaults to 500; a lower limit bounds work but does not name a candidate. Normal Prune can also delete eligible IngestDB data. | No code change indicated. Inspect the real queue order and complete operation effects. Do not run solely to create JSONgen evidence. |
| C. Database schema/permissions | Schema migration `20261018_001_ingest_prune_jsongen_private_reader.sql`; original outbox writer permissions. | Per task background, Schema #12 is unapplied and the dedicated LOGIN is not provisioned. The migration depends on the original outbox migration and must not be replayed blindly. The actual Prune database login's outbox EXECUTE/insert permission is unverified. | No code/schema edit here. Authorized DB operators must verify migration history and dependencies, apply only if needed, provision the restricted login, audit RLS/ACLs, and verify the existing Prune writer grant. |
| D. Deployment/version alignment | Prune workflow, signer Worker route and scripts in Ops. | Local code is at the requested PR #114 merge. Current remote workflow checkout SHA, signer deployment SHA/route, Access policy and rate-limit namespace are not verified. | No source change indicated. Confirm the workflow will run the intended TEST `main` SHA and the deployed TEST signer matches the reviewed contract before invoking it. |
| E. Operational acceptance | Full Prune → outbox → consumer → retention/registration → Stage 3C sequence. | No integrated TEST event has been accepted. The currentness workflow `uk_aq_jsongen_prune_stage_d_readiness.yml` is not a substitute: it expects the pending flag off and checks a different reader/config boundary. | Code changes do not establish remote acceptance. Follow the ordered runbook below after each required authorization. |
| E. Managed control | Derived TEST R2 control object. | Consumer retention and Stage 3C require existing managed control; Stage 3C never initializes it. Existence and current identity were not read. | If absent, stop. Control initialization is a separate explicit operation and authorization, not an automatic first-run step. |
| F. Unsupported inputs | `scripts/jsongen/prune-original-authority.mjs`, `prune-consumer-authentication.mjs` and writer admission. | Only AURN connector 1, selected-v3, embedded schema-3 effective P/R/null status and a genuine complete first publication are admitted. | Fail closed. Do not broaden support in this acceptance task. |

The code is structurally ready for a later controlled acceptance, but it is **not
ready to request approval for a real Prune run** until the remote version/config,
database access, candidate eligibility, effective dry-run setting, schedule state
and normal Prune deletion effects are reviewed. A non-dry-run run can delete
eligible IngestDB observations as part of its normal work. The Prune schedule and
pending-source flag stay as reported; neither is changed here.

## End-to-end implementation map

### A. Complete frozen source preparation

`workers/uk_aq_prune_daily/phase_b_history_r2.mjs` enters
`writeFrozenCandidateObservationsToV2()` for selected-v3 output and admits the
optional path only for connector 1 and a first publication. The pre-PUT
`committed_history_guard.mjs` checks the complete relevant hierarchy under the
global observation operation lock; a present committed scope is not treated as
first publication. `scripts/jsongen/prune-pending-source.mjs`, `prune-evidence.mjs`
and `limits.mjs` freeze and describe all selected rows and physical scopes.
Ordering, multiplicity, timestamps and numeric values are preserved. The
effective `verification_status` P/R/null is retained; raw original provider
`source_status` is explicitly unavailable and is not fabricated.

Limits are fail-closed: up to 1,024 physical scopes, 100,000 rows, 32 MiB
uncompressed source, 8 MiB gzip and a 1 MiB evidence envelope. Metadata capture
and receipt limits apply separately. No rows or scopes are silently removed to
fit. An optional-source failure does not authorize omission from mandatory
canonical Prune.

### B. Authenticated pending upload

`scripts/jsongen/prune-signed-upload.mjs` requests an object-scoped intent from
`workers/uk_aq_jsongen_signer/worker.mjs` and `sigv4.mjs`. The signer admits the
dedicated writer identity and connector 1, then returns an immutable
`managed/jsongen/v1/pending/unverified/prune_daily_v3/...` object reference with
a 60-second conditional PUT intent. The PUT binds gzip content type, SHA-256 and
`If-None-Match: *`; Prune validates the TEST R2 host, bucket, key, digest, size,
expiry and signed headers before sending bytes. The signing and PUT stage shares
a 15-second deadline and only starts with reserved finalization headroom.

A 2xx is `put_acknowledged_unverified`; it is not readback or a VERIFIED receipt.
412 is a conditional conflict; 409, 5xx and transport failures can be ambiguous.
Prune does not retry or independently read back this object. The signer uses
bucket-scoped R2 Read & Write credentials, not prefix-only/PUT-only credentials;
confirm that scope and accept the risk before first use. Verify actual
conditional-write behavior in the controlled TEST operation.

### C. Mandatory canonical finalization

The existing selected-v3 observation verifier/writer and
`finalizePublishedPhaseBConnectors()` in `phase_b_history_r2.mjs` remain
mandatory. `validatePhaseBV3RunFinalizationResult()` checks exact scopes, latest
registry references, parent relationships and aggregate evidence before the
protected candidate/gate transaction. The optional JSONgen path does not replace
canonical Parquet verification or finalization, and does not make a failed or
incomplete canonical publication eligible for JSONgen evidence.

### D. Original PostgreSQL gate and outbox

`markCandidateAndConnectorGateComplete()` in `phase_b_history_r2.mjs`, together
with `scripts/jsongen/prune-final-evidence.mjs`, `prune-original-metadata.mjs`,
`prune-metadata-codec.mjs` and `prune-outbox.mjs`, binds the frozen source and
before-authority evidence to the selected-v3 final publication. The final
evidence uses metadata already read/verified by the writer and bounded captures;
it does not add a routine canonical Parquet GET or derived-R2 readback.

The optional outbox insert is inside the existing protected transaction and an
isolating SAVEPOINT. Recoverable evidence-insert failures roll back to the
SAVEPOINT, allowing otherwise valid canonical Prune/gate behavior to continue.
The mandatory candidate/gate checks remain fail-closed. A retained event is not
assumed until PostgreSQL confirms the `COMMIT` command. Only after confirmed
commit can `preparePrunePostCommitHandover()` produce a small reference; delivery
is `not_attempted`. If the optional insert is missing or incomplete, there is no
later reconstruction from mutable candidate/gate rows. The consumer must find
the immutable original event and authenticate its exact retained bytes.

### E. Independent consumer and source verification

`scripts/jsongen/prune-consumer.mjs` invokes the restricted reader in
`prune-outbox-reader.mjs`, authenticates with `prune-consumer-authentication.mjs`
and `prune-original-authority.mjs`, and independently reads the private pending
gzip through `prune-pending-verification.mjs`. The consumer checks the complete
original event key, exact `final_evidence_bytes`, before-publication absence,
Core-owned selected-v3 binding authority, final physical-scope hierarchy,
source identity, gzip/uncompressed hashes and lengths, and effective P/R/null
semantics. It does not trust caller-declared success or repeat canonical Parquet
verification.

The reader requires the existing TEST project identity, verified TLS,
read-only connection/transaction behavior, effective membership in
`uk_aq_jsongen_prune_reader`, SELECT subject to its named AURN-only RLS policy,
and no outbox mutation or writer-function EXECUTE. The consumer self-check is a
guard, not a complete audit of policy predicate, RLS enablement, ownership or
other permissive grants; operators must inspect those independently.

### F–G. Complete VERIFIED receipt retention and registration

`prune-consumer-partitions.mjs` builds deterministic complete-scope partitions:
at most 128 physical scopes per receipt/bundle, up to 1,024 scopes per source
event, without partial scopes. `prune-receipts.mjs` constructs schema-2 VERIFIED
receipts with typed original PostgreSQL acceptance authority, conditionally
retains immutable gzip bundles and canonical receipt JSON, then exact-readbacks
and authenticates each. Existing schema-1 receipts remain compatible. Coupled
row, byte, receipt-count and time limits still apply; overflow or ambiguous
conflicting bytes fail closed.

`control.mjs` admits the private authenticated whole-event command only after
every partition has durable verified bundle and receipt readback. One CAS
transition registers the complete event and all partitions. Stale or ambiguous
control writes require readback/replay; a partial group cannot be marked
complete. `--initialize-control` is an explicit retain-only mode and is not an
automatic recovery action. Missing control blocks until separately authorized
setup. Retention/registration does not enable monthly selection.

### H. Stage 3C currentness and coverage boundary

`reconcile-cli.mjs`, `reconcile.mjs`, `currentness.mjs` and the inspection
budget/report modules provide an explicit manual read-only inspection. Each
source-as-of operation inspects at most 128 physical scopes using four workers
and a 60-second budget; it may account for up to 1,024 scopes, leaving as many
as 896 explicitly uninspected. Separate partitions have separate source-as-of
boundaries and must not be combined as one coherent snapshot. Current metadata
matches do not prove all intervening writer events were retained.

Keep `writer_coverage=unknown`, freshness unknown and
`publication_eligible=false` while required writer evidence is missing. Do not
call `selectManagedPublications()`; it remains deliberately disabled.

## TEST configuration inventory

This is a names-and-ownership checklist, not confirmation of remote values. Reuse
existing variables and secrets; do not print secret values into reports or logs.

| Component | Existing configuration to verify | Current review status |
| --- | --- | --- |
| Prune Actions | `UK_AQ_ENV_NAME=TEST`; `UK_AQ_R2_HISTORY_VERSION=v3`; operator-reported `UK_AQ_JSONGEN_PRUNE_PENDING_SOURCE_ENABLED=true`; `UK_AQ_JSONGEN_PRUNE_SIGNER_URL`; variables `UK_AQ_JSONGEN_R2_ENDPOINT`, `UK_AQ_JSONGEN_R2_BUCKET`; secrets `UK_AQ_JSONGEN_PRUNE_WRITER_TOKEN`, `UK_AQ_JSONGEN_SIGNER_ACCESS_CLIENT_ID`, `UK_AQ_JSONGEN_SIGNER_ACCESS_CLIENT_SECRET`; existing `SUPABASE_URL`, `SUPABASE_DB_URL`, canonical `CFLARE_R2_*`. | Names are wired by the local workflow. The derived endpoint and bucket are required only when the optional pending-source handover is enabled; Prune receives no JSONgen R2 API credentials. Actual remote values, secret presence and TEST target are unverified. Preserve the flag as reported. |
| Prune mode and scope | `INGESTDB_PRUNE_DRY_RUN`, workflow `dry_run`, `INGESTDB_RETENTION_DAYS`, `MAX_HOURS_PER_RUN`, delete batch/cap settings, Phase A/Phase B controls, `UK_AQ_R2_HISTORY_MAX_CANDIDATES_PER_RUN`. | No remote values inspected. The workflow checkbox can force dry-run only. An unchecked input uses the repo variable, defaulting to true when absent. |
| Signer Worker | Reviewed TEST `/v1/upload-intents` HTTPS route; writer bearer; Cloudflare Access service identity; connector-1 admission; TEST account/bucket; bucket-scoped signing key; unique rate-limit namespace (10 per writer per location per 10 seconds). | Source wiring reviewed; remote deployment, route, policy and namespace unverified. The credential scope needs explicit operator risk acceptance. |
| Private consumer and Stage 3C | Sourced `UK_AQ_ENV_NAME=TEST`; existing `UK_AQ_GITHUB_REPO=TEST-uk-aq/uk-aq-ops`; `UK_AQ_JSONGEN_PRUNE_READER_DB_URL`; existing `SUPABASE_URL`; variables `UK_AQ_JSONGEN_R2_ENDPOINT` and `UK_AQ_JSONGEN_R2_BUCKET`; secrets `UK_AQ_JSONGEN_R2_READ_ACCESS_KEY_ID` and `UK_AQ_JSONGEN_R2_READ_SECRET_ACCESS_KEY`. | Configuration names are mapped in `config/uk_aq_github_env_targets.csv`. Provide the explicit TEST target and read-only token through the existing private environment process before manual operation. The consumer and Stage 3C inspection need no WRITE credentials. |
| Derived JSONgen R2 | Explicit `UK_AQ_JSONGEN_R2_ENDPOINT` and `UK_AQ_JSONGEN_R2_BUCKET`; READ credentials for bounded private GETs; WRITE credentials only for explicitly requested immutable conditional PUT/readback and managed-control CAS. | Shared code checks the configured target and requires the credential pair for the selected operation. Actual endpoint, bucket, credential permissions and existing control object remain unverified. |

The Stage A diagnostic retains its existing repository-specific admission. The
managed JSONgen shared-storage code now reads its endpoint and bucket from the
explicit variables above and has no embedded account or bucket pin. Its manual
consumer and inspection entry points remain explicitly TEST-only. Do not add
cross-environment fallbacks or a LIVE activation path. The separate currentness
readiness workflow is stale for this acceptance and must not be used as a
substitute for the manual reader path.

## Restricted PostgreSQL reader operator checklist

Perform these only under separate DB operational authorization. No SQL was run
for this review.

1. Confirm the intended TEST IngestDB and server version through the approved
   administrative connection. Verify the base outbox migration
   `20261017_001_ingest_prune_jsongen_gate_acceptance_outbox.sql`, its `uk_aq_ops`
   schema/function, and migration history before Schema #12.
2. Inspect any existing `uk_aq_jsongen_prune_reader` role and named RLS policy.
   The Schema #12 migration is tracked and once-applied; it uses a policy name
   that must not be blindly replayed. If it is absent and dependencies/guards
   pass, apply only
   `../TEST-uk-aq-schema/schemas/migrations/20261018_001_ingest_prune_jsongen_private_reader.sql`
   from the Ops repository root. After the dependency/history review and
   authorization, the documented command shape is:

   ```sh
   psql --no-psqlrc --set=ON_ERROR_STOP=1 \
     --dbname='<reviewed TEST IngestDB admin connection>' \
     --file=../TEST-uk-aq-schema/schemas/migrations/20261018_001_ingest_prune_jsongen_private_reader.sql
   ```

   This command was not run. See
   `../TEST-uk-aq-schema/docs/jsongen-prune-private-reader.md` for the complete
   migration and rollback procedure.
3. Confirm the migration created a `NOLOGIN`, non-elevated reader group with only
   schema `USAGE`, outbox `SELECT`, and the exact TEST / `prune_daily_v3` /
   connector-1 RLS policy. Verify RLS is enabled, the predicate is exact, and no
   other applicable permissive policy broadens access. Audit ownership,
   unrelated grants, parent-role memberships and every effective `SET ROLE`
   route separately.
4. Provision a dedicated `LOGIN` with no object ownership and no writer,
   `service_role`, superuser, administrator or unrelated application-role
   memberships/grants. Give only required database `CONNECT` plus effective
   inherited membership in the reader group. On PostgreSQL 15 and earlier, use
   the appropriate INHERIT login membership. On PostgreSQL 16+, use the
   separately reviewed membership options `INHERIT TRUE, SET FALSE, ADMIN FALSE`.
   Set `default_transaction_read_only=on` on the LOGIN. Do not put passwords in
   source, chat, shell history, GitHub settings or run logs.
5. Verify as that login: `pg_has_role(current_user,
   'uk_aq_jsongen_prune_reader','USAGE')`, effective outbox SELECT, no INSERT /
   UPDATE / DELETE / TRUNCATE / TRIGGER, no acceptance-function EXECUTE,
   read-only transaction defaults and the RLS policy. Verify TLS certificate
   validation and the actual direct/pooler connection behavior.
6. Confirm the existing Prune writer login still has only its already-required
   outbox insertion function access; do not grant the writer to the reader or
   change canonical service grants as a shortcut.
7. Only after secret custody is arranged, source the TEST-only
   `UK_AQ_JSONGEN_PRUNE_READER_DB_URL` and existing `SUPABASE_URL` locally, then
   use consumer read-only mode for an actual outbox event. No synthetic event is
   needed to test access.

For details on version-specific membership, migration guards, the reader's
self-check limits and rollback, follow
`../TEST-uk-aq-schema/docs/jsongen-prune-private-reader.md`. Disabling later
means revoking reader membership/grants through reviewed procedures while
preserving the immutable original outbox; do not delete or rewrite original
evidence.

## Ordered first-operation runbook (not executed)

Each external read or write below must be performed by an authorized TEST
operator. The Prune data operation and Stage 3B retention are distinct approval
boundaries.

1. **Pin code:** confirm the intended TEST Ops `main` SHA is
   `8e47125ebc52ffc50218eba6ab6d9747f47a45b8` or a reviewed later SHA containing
   the same implementation. Confirm the GitHub workflow checkout SHA and deployed
   TEST signer version/route before any request. Do not assume a local SHA proves
   remote deployment.
2. **Confirm paused scheduling:** inspect the actual central Cloudflare
   scheduler/D1 record and Worker state. The repository's local disabled
   manifest is not proof of remote pause. Keep the scheduler paused for the
   acceptance; do not toggle it here.
3. **Confirm exact configuration:** verify the table above using the TEST
   Actions and Worker configuration views. Preserve the operator-reported
   pending-source flag and confirm selected history is `v3`. Confirm all R2,
   project, Access and signer targets identify TEST.
4. **Determine effective Prune mode:** inspect `INGESTDB_PRUNE_DRY_RUN` without
   exposing values in logs. Checking `dry_run` forces a dry run. Leaving it
   unchecked uses that repository variable, and missing variable falls back to
   `true`. Stop if the effective value is true; changing it to false needs
   separate authorization for a real Prune operation.
5. **Apply reader schema only if required:** follow the restricted-reader
   checklist and Schema #12 handover. Verify dependencies/migration history and
   actual policy before applying. The migration does not provision the LOGIN.
6. **Provision and accept reader access:** create the dedicated LOGIN through
   approved secret handling; validate role isolation, INHERIT semantics for the
   server version, RLS, ACLs, read-only defaults and verified TLS. Confirm the
   required Prune writer function permission independently.
7. **Confirm private R2 and signer:** verify current signer deployment, route,
   Access and dedicated writer identity; exact TEST account/bucket; signer
   bucket-scoped Read & Write credential; derived private bucket; conditional
   PUT and exact readback path; and rate-limit namespace. Explicitly accept the
   credential scope and test conditional behavior only during the approved
   controlled operation. Do not copy credentials into run artifacts.
8. **Find a genuine candidate without mutation:** under approved read-only
   operational review, identify a real AURN connector-day that is still a
   first publication in complete selected-v3 hierarchy, has valid completed
   Core-owned bindings, and has its complete source available within every cap.
   Confirm all affected physical scopes are genuinely absent; a historical
   correction or a 404 alone is not proof of absence. Review existing pending
   candidate ordering because the workflow has no named-day selector. A lower
   max-candidate limit does not target a particular connector-day. Do not seed,
   rewrite or reorder a candidate to force it through.
9. **Review the full Prune effect:** inspect the exact run window, normal
   IngestDB deletion candidates and counts, retention settings, delete caps,
   Phase A repairs, late-arrival handling, Phase B candidate set, READY/CONSUMED
   gates, global operation lock and Integrity/backup coordination. Establish
   what a real non-dry-run invocation could delete or repair. Do not treat
   candidate planning as no-effect: Phase B dry-run prepares candidate/control
   bookkeeping, while Prune dry-run can still run its repair pilot. Dry-run does
   not perform canonical selected-v3 publication/finalization or commit the
   JSONgen gate/outbox event.
10. **Request the operation approval:** present the selected candidate, code
    SHA, TEST targets, expected time window, effective non-dry-run setting,
    deletion/repair impact and rollback/restart plan for explicit authorization
    of that one real TEST workflow operation. Do not invoke Prune merely to
    create JSONgen evidence. If the workflow cannot safely isolate the intended
    operation, stop and resolve that operational constraint before approval.
11. **Run and observe Prune:** only after approval, invoke the existing
    `workflow_dispatch` with `dry_run` unchecked and verified repository
    variable false. Observe normal canonical v3 verification/finalization, then
    the original candidate/gate transaction and confirmed PostgreSQL COMMIT.
    Record finalization, outbox key, `final_evidence_state`, pending upload
    disposition and all deletion/reconciliation outcomes. A dry-run report,
    upload 2xx, prepared reference or log success alone is not acceptance.
12. **Read the original event first:** use the exact six-field immutable event
    key from the committed outbox row. In a separately approved, read-only
    manual consumer operation, use
    `node scripts/jsongen/prune-consumer.mjs --execute-read-only
    --event-key-file work/original-event-key.json --output
    work/prune-read.json`. Require successful independent original evidence and
    pending gzip authentication. A missing event, incomplete evidence or
    unsupported case stops the chain; do not synthesize or reconstruct it.
13. **Authorize retention separately:** after reviewing the read-only result,
    obtain explicit authorization for derived private R2 immutable bundle/receipt
    PUTs and managed control CAS. Then use the same event key with
    `--execute-retain` and a separate output path. Do not pass
    `--initialize-control` unless control is absent and its initialization has
    separately been reviewed and authorized.
14. **Verify receipt retention and registration:** require exact readback of
    every source bundle and schema-2 receipt, matching hashes/lengths, full
    complete-scope partition count and a confirmed one-transition whole-event
    registration. If any write or CAS is ambiguous, replay the same immutable
    event through the documented recovery path; do not overwrite or delete
    immutable objects. A partial partition set is not a complete event.
15. **Inspect Stage 3C separately:** after successful registration and separate
    authorization for private metadata reads, prepare the exact physical scopes
    and retained receipt descriptors from the registered event, then use the
    manual read-only interface, for example:

    ```sh
    node scripts/jsongen/reconcile-cli.mjs --execute-read-only \
      --scopes-file work/physical-scopes.json \
      --retained-receipts-file work/retained-references.json \
      --inspection-partition 0 \
      --output work/currentness-partition-0.json
    ```

    Each source-as-of inspection covers at most 128 scopes; do not combine
    partitions from separate invocations into a coherent snapshot. Keep all
    uninspected scopes explicit. This command was not run.
16. **Record the remaining boundary:** report writer coverage and freshness as
    unknown wherever evidence is missing; publication eligibility remains
    false. Do not activate managed selection, monthly generation, chart serving
    or other writers from matching metadata alone.
17. **Review restart and schedule recovery:** preserve the original event,
    pending gzip, retained bundles/receipts and control state. Reconcile any
    ambiguous transaction, missing outbox event, conditional-write conflict or
    partial retention before retrying. Never rerun a committed day to recreate
    missing original evidence. Review all remaining Prune backlog/deletion
    impact, service health, logs and pending objects; only then seek separate
    approval to resume normal scheduling.

### Failure and rollback handling

- **Optional signer/PUT failure:** the original canonical Prune path can still
  succeed, but there may be no discoverable JSONgen event. Preserve logs and
  any immutable pending object. Do not infer success from an ambiguous response,
  create a replacement event or delete the object. A later retry of a committed
  day cannot recreate lost original authority.
- **Canonical or mandatory gate failure:** no VERIFIED receipt is allowed. Keep
  the existing deletion safeguards and resolve/reconcile the original Prune
  result before any consumer action.
- **Outbox insert or COMMIT uncertainty:** fail closed and inspect the original
  immutable outbox using its exact key. A prepared post-COMMIT reference is not
  a receipt. If the committed event is missing or says `not_captured`, stop; do
  not reconstruct from mutable candidate/gate state.
- **Reader or authentication failure:** remain read-only and replay the same
  event after resolving the access/evidence issue. Never bypass independent
  source, before-authority or binding checks.
- **Conditional receipt/bundle write or CAS interruption:** preserve all
  immutable writes, reread exact bytes/control, and deterministically replay the
  same original event. Do not overwrite, delete or register a partial group.
- **Missing managed control:** Stage 3C blocks; retain mode may offer explicit
  initialization, but it is a distinct authorized action. No automatic empty
  control is created.
- **Disable/rollback:** if the optional path must be disabled, request a separate
  authorized change to its existing TEST flag. Preserve canonical Prune,
  outbox rows, pending evidence, bundles, receipts and control. Do not roll back
  original canonical history or deletion state as a response to a JSONgen-only
  failure. Do not resume the scheduler until the restart review is complete.

Full monthly publication additionally needs complete authenticated writer
inventories and precedence/currentness evidence for Prune and other writers,
freshness proof, monthly baselines/context and paired observations/AQI
generation. None is supplied by this first Prune event.

## Review performed

Reviewed the requested authoritative overview, Station Charts and R2 History
routers/contracts, additional Prune-specific active contracts, Schema #12
handover, and the existing Ops writer, original-authority, consumer and
currentness handovers. Inspected the in-scope implementation and local workflow
and configuration map. Confirmed local Git source state, package availability,
archive presence and migration-file presence. No code/configuration behavior was
changed. No test or operational command was run. After this documentation edit,
only `git diff --check` is appropriate as a structural check; it does not prove
remote configuration or functional TEST acceptance.

## Documentation handover

No authoritative `system_docs/` changes are needed for this readiness report.
If the operator discovers a contract/code mismatch during acceptance, report it
to the system-docs owner before changing the contract. This handover does not
supersede the active contracts or existing consumer and currentness handovers.
