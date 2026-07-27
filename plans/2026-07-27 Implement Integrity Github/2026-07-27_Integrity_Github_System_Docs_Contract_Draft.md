# Draft History Integrity runtime, shared state and GitHub execution contract

## Draft status

This file is a proposed future system-docs contract stored under `plans/` for review before implementation.

It is not active authority and does not override any file under `system_docs/`.

After implementation and real TEST acceptance, ChatGPT in Chat mode must reconcile this draft with the implemented code, applied schema and operational results before updating active `system_docs/`.

- Draft date: 27 July 2026
- Scope: CIC-Test design
- Logical task: `ops.history_integrity`
- Proposed executors: `integrity_local` and `integrity_github`

## 1. Authority and scope

This draft defines the proposed runtime, shared-state, concurrency, Dropbox-baseline, source-cache and recovery contract for running History Integrity from either the dedicated local Integrity machine or GitHub Actions.

It supplements the existing contracts for:

- Integrity source acquisition, detection, planning and repair;
- daily-profile date selection;
- observation-content hashing and verification status;
- v2 manifests and indexes;
- prune completion gates;
- repair ordering and final verification.

Those existing behavioural contracts remain unchanged unless an accepted implementation later requires a deliberate documented amendment.

## 2. Runtime identities

History Integrity has one logical task:

```text
ops.history_integrity
```

It may be executed by two separate runtime implementations:

```text
integrity_local
integrity_github
```

`integrity_local` is the implementation running from the dedicated Integrity machine.

`integrity_github` is the implementation running from a GitHub Actions runner.

The executors MUST have separate runtime paths, temporary directories, report metadata and executor identities. They MUST NOT create separate logical daily-task-health keys for the same Integrity responsibility.

Expected executor metadata values are:

```text
uk-aq-history-integrity-local
uk-aq-history-integrity-github
```

## 3. Core invariants

1. At most one History Integrity run MAY execute for one environment at one time.
2. The exclusion rule applies to every mode, including check-only, dry-run, manual, daily, weekly, monthly and repair.
3. Both executors MUST use the same deterministic source parsing, mapping, canonicalisation, comparison, observation-content-hash, manifest and verification implementations.
4. A separate executor MUST NOT maintain an independently copied Integrity algorithm.
5. Detection and repair planning MUST use a pinned completed Dropbox R2 backup as the R2 comparison baseline.
6. Routine Integrity comparison MUST NOT switch to live R2 merely because the executor is GitHub Actions.
7. Supabase MUST own shared facts required by both executors.
8. SQLite MAY own executor-local working and audit detail but MUST NOT override newer shared Supabase state.
9. Dropbox MUST own large source, backup, report and detailed evidence objects.
10. `integrity_github` MUST begin as check-only and manual.
11. Exactly one active daily scheduler MAY exist for the environment.
12. GitHub repair MUST remain disabled until a later accepted repair-authority contract is implemented.

## 4. Source-of-truth ownership

| State or object | Authority | Notes |
|---|---|---|
| Active execution ownership | Supabase execution lease | Shared by both executors |
| Factual daily-task run | `uk_aq_ops.daily_task_runs` | Uses `ops.history_integrity` |
| Shared Integrity run lifecycle | Supabase shared Integrity run state | Links executor and daily-task run |
| Daily-profile completion and catch-up | Supabase shared daily-profile state | Local SQLite may mirror it |
| Local expanded counts and joins | Local SQLite | Local working and audit data |
| GitHub expanded counts and joins | Temporary runner SQLite | Discarded after the run |
| Raw authoritative historical source bytes | Dropbox source cache or upstream source when not cached | Immutable cached objects |
| Derived selected-day source evidence | Dropbox derived cache | Rebuildable from raw source and fixed identities |
| Current source-file pointer metadata | Supabase plus Dropbox revisioned index | Supabase holds bounded shared metadata |
| R2 comparison data, manifests and indexes | Pinned completed Dropbox R2 backup | Not live R2 for normal comparison |
| Durable detailed reports and sidecars | Dropbox | Content identity recorded in Supabase |
| GitHub workflow artefacts | GitHub Actions artefacts | Convenience only, not durable authority |
| Canonical repaired R2 objects | Live R2 | Only for an authorised repair executor |

A shared fact written to Supabase MUST NOT be replaced from a stale SQLite mirror.

Large payloads MUST NOT be placed in Supabase merely to make them accessible to both executors. Store them in Dropbox and store bounded identity and reference metadata in Supabase.

## 5. Shared execution lease

### 5.1 Lease identity

The lease is scoped by:

```text
environment + logical task
```

For CIC-Test the logical identity is equivalent to:

```text
CIC-Test + ops.history_integrity
```

The database MAY store a derived `lock_key`, but the underlying environment and task identity MUST remain explicit.

### 5.2 Atomic acquisition

Lease acquisition MUST be one atomic Supabase database transaction.

The acquire operation MUST:

1. validate the environment and executor identity;
2. reject a second acquisition while a valid lease exists;
3. reconcile an expired lease only according to the stale-run contract;
4. create the factual `Started` `daily_task_runs` row for `ops.history_integrity` in the same transaction;
5. create or update the shared Integrity run record;
6. return an unguessable lease token and the factual daily-task run ID.

A client-side sequence of:

```text
check for running row
then insert Started row
```

MUST NOT be used as the authoritative exclusion mechanism because two callers could pass the check concurrently.

### 5.3 Heartbeat

The current lease owner MUST heartbeat independently of long source downloads, parsing, comparison or report generation.

Target timings are:

```text
heartbeat every 60 seconds
lease expires after 15 minutes without a valid heartbeat
```

A heartbeat MUST include the matching lease token. A wrong or stale token MUST fail.

Loss of lease ownership MUST stop the executor before it performs further source-state publication, shared-state completion or any future destructive operation.

### 5.4 Finalisation

Success finalisation MUST atomically:

- verify the matching lease token;
- record the final shared run result;
- mark the factual daily-task run `Finished`;
- release the lease.

Failure finalisation MUST atomically:

- verify the matching lease token where it remains valid;
- record the shared run failure;
- mark the factual daily-task run `Failed`;
- release the lease.

A cancelled or abandoned run MUST NOT be marked `Finished` merely to unlock later work.

### 5.5 Expired lease recovery

When a lease expires:

- a later acquire operation MAY reconcile it;
- the abandoned factual `Started` run MUST become `Failed`;
- the failure reason MUST identify lease expiry or abandoned execution;
- the previous lease token MUST become permanently invalid;
- a new executor MAY acquire a new lease only after reconciliation completes.

Manual recovery, where required, MUST mark the abandoned run `Failed` and release or expire the lease. It MUST NOT invent a successful completion.

## 6. Daily-task-health integration

Both executors use:

```text
task_key = ops.history_integrity
```

Run metadata MUST distinguish:

- executor kind: `local` or `github`;
- executor identity;
- repository and revision;
- local run identity or GitHub Actions run ID;
- environment;
- logical run date;
- mode and scope summary;
- report reference.

The `daily_task_definitions` representation MUST explicitly support a hybrid or multi-executor task rather than falsely declaring that the logical task can run only on the MBPro or only on GitHub.

The factual run table remains factual. Manual calendar overrides MUST NOT be used to release execution ownership.

## 7. Shared run state

The shared Integrity run record MUST include enough bounded metadata to reconstruct the cross-runtime lifecycle without storing detailed source rows.

Required logical fields include:

- shared run ID;
- environment;
- logical task key;
- executor kind and identity;
- factual daily-task run ID;
- logical run date and its source;
- mode;
- profile;
- source, connector, date and pollutant scope summary;
- lease acquisition, heartbeat and finalisation timestamps;
- repository revision;
- platform run ID;
- pinned Dropbox baseline identity;
- source-cache index identity;
- report paths and hashes;
- final status;
- bounded error information.

The shared run state MUST NOT duplicate every detailed SQLite finding, source row or per-timeseries count.

## 8. Daily-profile state

### 8.1 Shared authority

After shared coordination is enabled, Supabase daily-profile state is authoritative for cross-run completion and catch-up decisions.

Both executors MUST apply the existing UTC daily-profile selection contract without semantic change.

### 8.2 Local mirror

`integrity_local` MAY retain its existing SQLite `daily_profile_state` as a local mirror and audit cache.

The mirror MUST record the corresponding shared identity or version needed to detect stale data.

Mirror order is:

```text
write authoritative shared fact
then write local mirror
```

A local mirror failure after a successful shared write MUST stop dependent local work and be reported. It MUST NOT roll the shared fact back from stale local state.

### 8.3 Check-only completion

A check-only or dry GitHub run MUST NOT mark missed daily allocations complete or caught up when the current daily-profile contract requires a successful real repair run for completion.

The GitHub executor MAY record that it evaluated the selected dates, but that evaluation MUST remain distinct from completion authority.

## 9. Local SQLite contract

`integrity_local` retains persistent local SQLite for:

- expanded source-file and per-timeseries counts;
- imported core snapshot working tables;
- detailed findings and repair planning;
- local report construction;
- debugging and audit history;
- mirrored shared state required for local operation.

The complete SQLite database MUST NOT be uploaded to Supabase as the shared state mechanism.

The complete SQLite database MUST NOT be downloaded and uploaded by every GitHub run.

Existing diagnostic SQLite backup behaviour MAY remain unless deliberately retired by a later contract change.

## 10. GitHub temporary state

`integrity_github` MUST use runner-local temporary storage.

It MAY create a temporary SQLite database to reuse existing relational algorithms.

The temporary database MUST be hydrated only with the state and detailed sidecars needed for the selected run. It MUST NOT require the complete local SQLite history.

The temporary database is discarded after the run. Durable evidence MUST already exist in Supabase and Dropbox before finalisation is reported as successful.

## 11. Dropbox R2 backup baseline

### 11.1 Completed inventory

Each run MUST select one completed v2 Dropbox backup inventory before comparison.

The run MUST record at least:

- Dropbox inventory path;
- Dropbox revision;
- Dropbox content hash or equivalent immutable content identity;
- R2 backup run identity where available;
- backup completion time;
- history version;
- relevant prefix identities.

### 11.2 Pinned scope

The selected baseline identity remains fixed for the full run.

A run MUST NOT combine required objects from different backup inventories or silently switch to a newer backup part-way through.

Required objects MUST be verified against the pinned inventory or its deterministic child references.

### 11.3 Scoped download

`integrity_github` MUST download only the files needed for the explicit selected scope, including as required:

- the selected inventory;
- relevant v2 indexes;
- the selected core snapshot;
- selected-day manifests;
- relevant connector and pollutant manifests;
- selected Parquet objects;
- preserved out-of-scope child metadata required to evaluate or construct an authorised proposal.

A normal run MUST NOT download the complete Dropbox R2 mirror.

### 11.4 No live-R2 fallback

Missing, inconsistent or unavailable Dropbox baseline content MUST fail or block the affected scope according to the existing Integrity contract.

It MUST NOT cause a silent comparison fallback to live R2.

Future authorised repair writes and immediate post-write verification remain separate from the comparison baseline.

## 12. Dedicated Dropbox source cache

### 12.1 Namespace

The GitHub source cache is separate from the local source-cache filesystem.

The default CIC-Test namespace is:

```text
CIC-Test/uk-aq-history-integrity-github/source-cache-v1
```

Reports and run evidence SHOULD use sibling versioned paths under:

```text
CIC-Test/uk-aq-history-integrity-github/
```

### 12.2 Immutable raw objects

Raw source objects MUST be immutable and content-addressed.

A suitable path contract is:

```text
source-cache-v1/objects/sha256/<first-two-hex>/<sha256>.<encoding>
```

The object identity MUST be derived from the authoritative source-byte identity required by the current source adapter.

If a source supplies compressed bytes and current Integrity records or validates those bytes, the cached object MUST preserve them exactly.

Eligible plain-text files MAY be deterministically gzip-compressed individually.

Already compressed files MUST NOT be recompressed merely to standardise extensions.

One monolithic cache archive MUST NOT be used.

### 12.3 Logical source indexes

Small revisioned indexes map logical source-file identities to immutable objects.

An index entry MUST include enough metadata to validate reuse, including where available:

- connector and logical source key;
- source location or URL identity;
- source ETag, Last-Modified or equivalent metadata;
- original content hash;
- uncompressed content hash where the existing adapter requires it;
- stored object path and encoding;
- stored object hash;
- Dropbox revision;
- original and stored byte counts;
- first-seen and last-checked times;
- parser or cache schema version.

Index updates MUST use revision-aware compare-and-set semantics. A conflicting revision MUST not be silently overwritten.

### 12.4 Shared metadata

Supabase stores bounded current pointers and object identity. Dropbox stores the raw object and detailed index body.

The shared metadata MUST be sufficient for either executor to determine which immutable object is current without copying the source payload into Supabase.

### 12.5 Derived selected-day evidence

To avoid repeatedly parsing large annual or multi-day source files, the cache MAY store derived selected-day evidence.

Its identity MUST include:

```text
raw source object hash
parser contract version
mapping snapshot identity
selected UTC day
```

Derived evidence MAY include:

- canonical selected rows or a deterministic compact representation;
- total and selected source-row counts;
- per-timeseries counts;
- mapping outcomes;
- source content hashes;
- verification-status counts;
- detailed sidecar references.

Derived evidence is rebuildable. It MUST NOT replace the immutable raw source object as authoritative source evidence.

A parser or mapping identity change invalidates affected derived entries without deleting the raw object.

### 12.6 GitHub Actions cache

GitHub Actions cache MAY accelerate retrieval of immutable source objects or derived evidence.

It MUST NOT be authoritative. A cache miss, eviction or corruption MUST fall back to Dropbox and MUST NOT change Integrity semantics.

Mutable current-year state MUST NOT rely solely on GitHub Actions cache.

## 13. Source-cache migration

The initial cache seed from the local source cache MUST be non-destructive.

The migration process MUST support:

- inventory-only mode;
- dry-run plan;
- immutable object deduplication;
- resumable upload;
- revision-safe index publication;
- JSON reporting;
- no deletion or relocation of local source files.

Unknown source file classes, unclear source identity or incompatible existing hash semantics MUST stop migration for the affected scope.

## 14. Shared implementation boundary

The two executors MUST share deterministic implementation for:

- source timestamp normalisation;
- source parsing;
- mapping and binding resolution;
- supported pollutant selection;
- canonical observation rows;
- verification-status normalisation;
- source and R2 comparison;
- observation-content hashing;
- manifest and index validation;
- repair proposal validation;
- report field semantics shared across runtimes.

Executor-specific adapters MAY differ for:

- filesystem paths;
- persistent versus temporary SQLite;
- Dropbox access;
- shared Supabase access;
- heartbeat execution;
- platform metadata;
- report publication transport.

A runtime adapter MUST NOT change the meaning of the data supplied to the shared core.

## 15. Local executor contract

`integrity_local`:

- runs from the dedicated Integrity machine;
- uses a complete repository checkout;
- retains current local commands and profile meanings;
- retains persistent local SQLite;
- retains local source-cache behaviour unless separately migrated;
- acquires the shared Supabase lease before operational work once shared coordination is enabled;
- mirrors shared state locally;
- remains the only repair-capable executor during the initial GitHub implementation;
- fails closed when shared coordination is enabled but the lease cannot be acquired or retained.

A temporary compatibility feature gate MAY preserve current local behaviour during schema deployment. It MUST be explicit and MUST NOT permit `integrity_github` to run before shared coordination is active.

## 16. GitHub executor contract

`integrity_github`:

- runs from a complete checked-out `uk-aq-ops` repository;
- has a separate executable identity;
- uses `workflow_dispatch` only in the initial implementation;
- uses runner-local temporary paths and temporary SQLite;
- acquires the shared Supabase lease before source or Dropbox work;
- reads the pinned Dropbox backup baseline directly through the approved adapter;
- reads the dedicated Dropbox source cache;
- downloads only selected-scope data;
- enforces check-only in executable code;
- writes durable reports to the dedicated Dropbox evidence namespace;
- may upload bounded GitHub artefacts for convenience;
- finalises the shared run and lease on success or failure;
- does not receive live R2 repair credentials in the initial implementation;
- does not update prune completion gates;
- does not clear daily-profile catch-up state as a successful repair completion.

## 17. Scheduling contract

Before a scheduling decision is accepted:

- `integrity_github` remains manual;
- the existing local schedule remains unchanged;
- no GitHub `schedule:` trigger is added;
- no Cloudflare Scheduler job is added for `integrity_github`.

When scheduling is later enabled:

1. the user MUST select one active daily executor;
2. the exact UTC time MUST be documented;
3. the old active scheduler MUST be disabled before the new scheduler is enabled;
4. the shared lease remains mandatory protection against manual overlap;
5. two active daily schedulers are prohibited even though the lease would reject overlap.

## 18. Check-only and repair authority

### 18.1 Initial authority

During the initial implementation:

```text
integrity_local: current check and repair capability
integrity_github: check-only
```

### 18.2 GitHub restrictions

The GitHub executor MUST reject any attempt to:

- run the backfill wrapper;
- write or delete live R2 objects;
- rebuild live R2 manifests or indexes;
- update connector-day or whole-day prune completion gates;
- queue AQI rebuild work;
- publish a repair completion state.

### 18.3 Future repair

GitHub repair requires a later contract and plan covering credentials, least privilege, backup gates, live writes, GET verification, prune gates, interrupted repair and single repair authority.

No hidden or dormant repair flag may bypass this decision gate.

## 19. Reporting and audit evidence

Both executors MUST record a common bounded run summary containing at least:

- shared run ID;
- factual daily-task run ID;
- executor kind and identity;
- environment;
- repository revision;
- platform run ID;
- logical run date;
- profile and mode;
- requested scope;
- selected dates and reasons;
- pinned Dropbox backup identity;
- source-cache index identity;
- source object identities used;
- temporary or local SQLite identity where useful without exposing paths as authority;
- findings and stage results;
- check-only versus planned versus completed operations;
- lease acquisition, heartbeat and release result;
- durable Dropbox report paths and hashes;
- final status and bounded error information.

Detailed source rows, secrets, access headers and complete connection strings MUST NOT appear in logs or shared summaries.

GitHub artefacts are not durable authority. Dropbox report paths and hashes are the durable large-object references.

## 20. Security

- Supabase state and lease RPCs require service-role access.
- Dropbox credentials are repository or environment secrets and MUST NOT be written to files retained as artefacts.
- Lease tokens MUST be unguessable and MUST NOT be printed in full. Logs MAY include a one-way fingerprint sufficient for correlation.
- The GitHub executor MUST receive only the credentials needed for check-only operation.
- Live R2 write/delete credentials MUST NOT be provided to the initial GitHub workflow.
- Dropbox paths MUST be normalised for the configured app-folder model.
- Cache indexes and reports MUST not expose secret query parameters or credentials from source URLs.

## 21. Failure and recovery

### 21.1 Supabase unavailable

When shared coordination is enabled, an executor unable to acquire the Supabase lease MUST fail before source acquisition or comparison work.

Local offline execution MUST NOT bypass the lease while `integrity_github` is available because that would break the no-overlap guarantee.

### 21.2 Dropbox baseline unavailable

The run fails or blocks the affected scope. It does not silently switch to live R2.

### 21.3 Source cache unavailable

The source adapter MAY fetch from the authoritative upstream source according to its existing contract. Uncertain empty or unavailable source results continue to fail closed.

A newly fetched source object is published to Dropbox only through the immutable object and revision-safe index contract.

### 21.4 Local mirror failure

If Supabase shared state succeeds and the local SQLite mirror fails, the shared fact remains authoritative. Local execution stops before dependent work and reports the mirror failure.

### 21.5 GitHub cancellation

The workflow attempts best-effort failure finalisation. If abrupt termination prevents it, the lease expires and the next acquisition reconciles the abandoned run to `Failed`.

### 21.6 Dropbox index conflict

A revision conflict stops publication of the affected index. The executor rereads current state and reports the conflict. It MUST NOT force-overwrite an unreviewed concurrent update.

## 22. Validation contract

### 22.1 Pre-deployment

Pre-deployment validation is limited to structural viability plus narrow deterministic checks genuinely required for load-bearing contracts:

- schema and RPC parsing;
- atomic lease exclusivity and token ownership;
- syntax/import checks;
- deterministic compression and object identity;
- revision-conflict behaviour using local fixtures or mocks;
- one tiny shared-core equivalence fixture.

Broad parity suites, exhaustive source fixtures, shadow schedules and soak tests are not required.

### 22.2 Real TEST validation

After deployment, validate through real CIC-Test operations:

1. one local check-only run using the shared lease;
2. one targeted cancellation/expiry recovery check because stale `Started` recovery is load-bearing;
3. one source-cache inventory and dry-run migration review;
4. one approved initial cache seed;
5. one manual GitHub check-only run;
6. one sequential local then GitHub comparison against the same pinned baseline and scope;
7. confirmation of no live R2 writes or prune-gate changes from GitHub.

Local and GitHub runs MUST be sequential, never concurrent.

### 22.3 Scheduling acceptance

Scheduling remains blocked until the sequential comparison has no unexplained semantic differences and the user selects the one active scheduler.

### 22.4 Repair acceptance

GitHub repair remains blocked until a separate repair plan is implemented and one real scoped TEST repair plus later Dropbox verification succeeds.

## 23. Deployment and transition order

The required order is:

1. implement canonical schema in source control;
2. implement shared clients and local compatibility gate;
3. implement Dropbox baseline and cache adapters;
4. implement shared core boundary and GitHub executor;
5. implement manual workflow;
6. review all code and operator commands;
7. apply schema to CIC-Test;
8. enable shared coordination for local Integrity;
9. validate local lease and cancellation recovery;
10. inventory and seed the Dropbox source cache;
11. manually run GitHub check-only;
12. compare local and GitHub sequential results;
13. make a separate scheduling decision;
14. update active system documentation through ChatGPT;
15. consider GitHub repair only through a later plan.

A later phase MUST NOT be enabled when an earlier authority or recovery check has failed.

## 24. Rollback contract

- Before shared coordination is enabled, code rollback leaves current local operation unchanged.
- Schema objects MAY remain unused or be removed through reviewed rollback SQL.
- Shared coordination MAY be disabled only when no active lease exists and `integrity_github` cannot run.
- A failed or abandoned run MUST remain factual and MUST NOT be converted to `Finished` for convenience.
- Namespaced immutable Dropbox cache objects MAY remain after workflow rollback.
- Index rollback uses a known previous revision, not an unverified overwrite.
- Disabling the GitHub workflow does not delete durable reports or source objects.
- Rollback MUST NOT rewrite R2 history.

## 25. Open deployment decisions

These decisions are intentionally not made by this draft and MUST stop the relevant later phase until the user decides:

1. Which executor becomes the active daily scheduler after GitHub acceptance.
2. The exact UTC schedule if GitHub becomes scheduled.
3. Whether the local schedule is retained as primary or disabled before GitHub scheduling.
4. Whether and when GitHub becomes repair-capable.
5. The final active `system_docs/` file split after implementation, avoiding duplicate authority.

Implementation details that preserve this contract, such as the exact internal module filenames or use of an existing compatible Dropbox helper, may be selected from repository evidence by Codex. Where the repository does not establish a safe choice, Codex MUST stop and ask for a decision.

## 26. Expected active documentation changes after acceptance

After implementation and TEST acceptance, ChatGPT is expected to update or add the smallest non-duplicative active documentation set covering:

- R2 History area index and required reading;
- Integrity runtime identities and shared implementation boundary;
- shared state and lease model;
- local and GitHub operations;
- daily-profile shared authority and local mirror;
- Dropbox baseline pinning;
- source-cache object and derived-cache contract;
- failure and recovery;
- validation and scheduling decision.

The final documentation structure MUST give each behavioural rule one authoritative home and link from related documents rather than copying editable rules into several files.
