# System documentation maintenance contract

## Purpose

This document defines how authoritative UK AQ Ops system documentation is structured, interpreted and maintained.

Its purpose is to prevent implementation drift, accidental behaviour changes and conflicting sources of truth.

## Source of truth

Human-readable Markdown under `system_docs/` is the authoritative prose specification.

Coding agents MUST NOT create or rely on a separate hidden, compressed or non-human-readable behavioural specification.

Machine-readable schemas, fixtures and deterministic checks may accompany the prose contract, but they MUST implement the same rules and MUST NOT introduce a second behavioural authority.

## Behavioural language

Area contracts use the following meanings:

- **MUST**: required behaviour.
- **MUST NOT**: prohibited behaviour.
- **SHOULD**: expected behaviour unless a documented reason justifies an exception.
- **MAY**: optional behaviour that does not alter the required contract.

Examples and diagrams explain the contract but do not override an explicit MUST or MUST NOT statement.

## Documentation classes

### Authoritative system contract

Located in an active area under `system_docs/`.

Defines current required behaviour, interfaces, state transitions and invariants.

### Operational runbook

Defines commands and procedures for deployment, repair, recovery or inspection.

A runbook MUST link to the contract it operates and MUST NOT redefine the system's behaviour.

### Implementation plan

Defines proposed future work. It is not current behaviour until the relevant contract is updated and the implementation is accepted.

### Architecture Decision Record

Explains why a load-bearing decision was made, what alternatives were rejected and what consequences follow.

The area contract defines what the system does. The decision record explains why.

### Archive

Preserves retired files and historical decisions. Archive paths MUST NOT be used as active runtime or authoritative documentation paths.

## Required area structure

Each substantial system area SHOULD contain:

- `README.md`;
- `contract.md`;
- `data_flow.md`;
- `interfaces.md`;
- `operations.md`;
- `validation.md`;
- `decisions/`.

Add `state_model.md` when the area owns persistent or load-bearing transient state.

Add `recovery.md` when recovery is complex enough that combining it with operations would obscure the normal runtime contract.

Do not create empty files merely to satisfy this shape. A file should exist only when it has a clear, non-overlapping responsibility.

## No duplicate authority

A behavioural rule MUST have one authoritative home.

Other documents may summarise or link to it, but they MUST identify the authoritative source and MUST NOT copy a second editable version of the rule.

When an existing broad document is replaced:

1. preserve it in the required dated archive when applicable;
2. move its still-current content into the appropriate area files;
3. replace the original active document with a short redirect or remove it if no active references require the path;
4. record the migration in the area `README.md` or repository documentation index.

## Coding-agent change protocol

Before making changes, an agent MUST report:

- requested behaviour being changed;
- behaviour explicitly required to remain unchanged;
- authoritative documents read;
- implementation files in scope;
- files and systems explicitly out of scope;
- any conflict between code and documentation.

During implementation, an agent MUST NOT:

- perform unrelated refactors;
- rename public fields, routes, object keys or environment variables unless explicitly required;
- change scheduling, retry, caching, error or fallback behaviour merely to simplify code;
- broaden the task to adjacent services without reporting the need first;
- use archived code as a runtime fallback.

After implementation, the change report MUST include:

- files changed;
- contract sections changed, or a statement that the contract was preserved;
- deterministic checks run;
- manual deployment or apply steps;
- post-deployment TEST validation;
- rollback considerations.

## Contract update triggers

Update an area contract when any of the following changes intentionally:

- value eligibility or filtering;
- state identity or transition rules;
- API, message or object schema;
- field meaning;
- scheduling or ordering that affects observable behaviour;
- fallback or fail-open/fail-closed behaviour;
- retention, deletion or backup safety gates;
- source-of-truth ownership;
- cache key or cache validation contract;
- recovery semantics.

A code reorganisation that demonstrably preserves all of those does not require a contract rewrite.

## Validation policy

Pre-deployment validation should establish only that the implementation and configuration are structurally viable, plus any small deterministic contract check genuinely needed to prevent the known class of regression.

Functional validation is performed after deployment through real operation on the TEST system.

Broad speculative pre-implementation test programmes are not required.

## Review checklist

A reviewer should be able to answer:

1. What behaviour is intentionally changing?
2. Which contract authorises that change?
3. What behaviour is protected from change?
4. Are public interfaces byte- and field-compatible where required?
5. Are raw records, derived products and current-state records still clearly separated?
6. Does recovery rebuild the same state defined by the normal runtime contract?
7. Were the relevant system documents updated without creating duplicate authority?
