# Stage 2L current-object admission implementation plan

**Goal:** authenticate current R2 predecessors against independently validated Stage 2K v1 preparation, read-only under Stage 2J's original session.

**Architecture:** a dormant callable helper, using the existing original-session assertion directly and bounded identity-encoding GETs. Authenticate the complete frozen baseline first, independently reconstruct its physical/index graph from fresh bytes with the existing verifier, authenticate every selected derived object, then reread all identities and revalidate local preparation before final assertion. Return only bounded completed-call diagnostics; no executable or reusable proof handle.

**Spec:** the Stage 2L user request and authoritative TEST system-docs at `b1365bb9592fe39c34e6587bf687e3aaea599acf`, especially the accepted exact-only, exclusion, SOS three-phase and implementation safety contracts. Base TEST Ops `9e0872d66d5f2ae55b47b7d8b0e7c8bd99b4484f` (PR #185 verified merged).

## Constraints and structural decisions

- Preserve the entire v1 preparation/fingerprint and all existing mutation guards. No operational command, coordinator change, new IPC, writes, lock acquisition or configuration.
- Normal Python scheduling and both Node APPLY bridges reject preparation. The descriptor goes only to those selected children. Integration therefore remains a separate gap; a helper may be called within an already protected selected child but is not automatically reachable operationally.
- Use `assertOriginalIntegrityOperationHeld({ expectedRunId })` with the private original channel; bind frozen owner/run/nonce to inherited context and require stable session and advancing assertion sequence. Never accept an injected ownership callback.
- Use at most 220 distinct current objects and two GET passes, fitting below the existing 1,024-assertion lifetime ceiling (four assertions per object plus two per supported scope and initial/final assertions: at most 1,010). Exhausted lifetime still fails closed. Each GET uses exact expected size and the existing 30-second maximum.
- Reuse Stage 2K finite body/row/physical/memory admission and add current-object resource accounting before allocation/reconstruction. Require genuine strong response ETags; no metadata-derived validators.
- Unsupported absent/no-selector outcomes fail closed at this new boundary; no absence protocol is invented. Physical support remains Stage 2K schema 3 / writer v3 / hash v1 only.
- Repository AGENTS requires direct execution after this structural report, without design approval. The user's request overrides generic skill defaults: no speculative pre-implementation tests or broad suites. Only necessary focused checks after implementation.

## Tasks

- [x] Add `scripts/backup_r2/lib/schema2_current_object_admission.mjs`, consuming the same accepted request as `validateSchema2PreparationV1`, explicit `phase: "APPLY"`, R2 configuration and the existing private channel. Keep every result non-executable and permanently cancel the capability on failed admission.
- [x] Add minimal checks using existing preparation fixtures and actual inherited-descriptor client/server framing with local ownership/R2 substitutes. Cover successful mixed selected closure and distinct proposed replacement, current drift/missing/weak ETag, loss around reads/final assertion, local evidence changes and context-only rejection. Do not claim real PostgreSQL continuity.
- [x] Run syntax/import checks, the directly relevant preparation/admission checks and existing execution-guard checks. Review the bounded diff; record results and callable-only/remaining mutation blockers in a Chat-mode handover.
- Delivery after verification: commit, push working branch and create a TEST-main PR; attach it. Do not merge or deploy.

## Review focus

Preparation remains immutable; all fresh reads compare with prior rather than proposed identities. Full schema-1 aligned closure and schema-2 immutable leaf closure must be checked. No unbounded GET/HEAD/list or live planning discovery. Caller mutation, original-channel loss and current-object drift cannot produce a successful or reusable admission.

## Execution record

- Structural assessment completed before code. No unsupported operational entry point or contract was invented. No existing active non-test implementation file changed; no archive required.
- Implementation and four targeted Stage 2L groups completed; 14 combined focused checks pass. Syntax/import/diff checks pass. Full suites and real TEST operations were excluded as requested.
- Independent read-only review found one P2 pre-clone binary/Map allocation gap. A focused reproducer failed, plain-JSON preflight fixed it, and all 14 checks then passed. No other blocking findings or deferred minor issues.
- Ruling: precondition rejection before channel consumption is not an uncertain partially admitted operation; after channel consumption every failure permanently closes it. The review agreed. Cost if wrong: the outer run could retain its original channel after wholly local invalid-input rejection, but no current-object read or diagnostic is admitted.
- Ruling: preserve callable-only integration and reject current absence/no-selector cases rather than create a launch/absence protocol. Cost: those inputs and normal operational invocation remain unavailable pending separate authority.
