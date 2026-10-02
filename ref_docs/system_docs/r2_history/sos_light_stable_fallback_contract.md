# SOS-light stable fallback contract

## Status and authority

**Status: future implementation authority; not current runtime behaviour until the stable files are created and deployed.**

This contract defines the known-good connector `1` SOS-light v3 fallback that must exist before active Integrity is extended for WAQN connector `9` and SAQN connector `10`.

It supplements the current SOS-light contracts without changing their normal runtime behaviour.

The stable fallback is active executable fallback code. It is **not** an archive path and MUST NOT execute code from `archive/`.

## Purpose

The WAQN/SAQN historical Integrity change deliberately touches the active Integrity codebase around a mature SOS-light path.

Before that change begins, UK AQ must retain an explicit known-good SOS-light v3 route that can be invoked if the evolving active Integrity path breaks connector `1`.

The fallback is intentionally simple: preserve the current known-working SOS-light v3 implementation as a small frozen executable copy, with only the path/name edits needed to make the copy self-contained at its new location.

It is not a second evolving implementation.

## Pre-change archive order

The repository's normal code archive rule remains mandatory.

Before any active implementation file is changed for the WAQN/SAQN work:

1. archive every in-scope existing active implementation file under the repository's established `archive/YYYY-MM-DD/` convention, preserving relative paths where practical;
2. do not modify or execute the archive copy;
3. create the stable SOS-light fallback from the same known-good pre-change active source;
4. only then begin active WAQN/SAQN implementation changes.

The archive is historical rollback/reference evidence.

The stable fallback is the executable emergency route.

Those roles MUST NOT be conflated.

## Repository layout

The stable repository-owned SOS-light files MUST live outside the normal active `bin/` directory:

```text
scripts/uk-aq-history-integrity/
  bin/
    ...active Integrity files...

  stable-sos-light/
    uk-aq-history-integrity-sos-light-stable-v3.sh
    uk-aq-history-integrity-sos-light-stable-v3.py
    uk-aq-history-integrity-sos-light-stable-v3_impl.py

  deploy-bin/
    uk-aq-history-integrity-sos-light-local-wrapper-v3.sh
    uk-aq-history-integrity-sos-light-stable-local-wrapper-v3.sh
```

The `stable-sos-light/` directory is an active executable source directory and MUST NOT be treated as an archive directory.

## Frozen implementation copy

The file:

```text
uk-aq-history-integrity-sos-light-stable-v3_impl.py
```

MUST initially be a byte-for-byte copy of the known-working pre-change:

```text
bin/uk-aq-history-integrity-sos-light-v3_impl.py
```

No WAQN/SAQN refactor, cleanup, renaming or behaviour change may be introduced into the frozen implementation while creating it.

The stable Python entrypoint MUST be copied from the current v3 Python entrypoint and changed only as needed to execute its stable sibling implementation file:

```text
uk-aq-history-integrity-sos-light-stable-v3_impl.py
```

The stable repository shell runner MUST be copied from the current fixed-v3 SOS-light runner and changed only as needed for its stable identity/path, including making its Python entrypoint resolve to:

```text
scripts/uk-aq-history-integrity/stable-sos-light/
uk-aq-history-integrity-sos-light-stable-v3.py
```

The fixed-v3 history-generation semantics, safety gates, lock behaviour, Dropbox authority, source authority, reporting and repair behaviour MUST otherwise remain unchanged.

## Shared dependency boundary

The stable fallback intentionally contains only the three SOS-light files above.

Therefore the WAQN/SAQN implementation MUST NOT change the semantics of an existing shared dependency used by those frozen files merely to support connector `9` or connector `10`.

In particular, the existing fixed-v3 SOS-light backfill/repair bridge and established shared runtime contracts are protected from opportunistic generalisation by this task.

New WAQN/SAQN adapters and orchestration SHOULD be added alongside the existing SOS path.

If implementation proves that a shared SOS dependency must change, that is a change to the agreed fallback boundary. Work MUST stop and the contract/fallback copy set must be reconsidered before that dependency is modified.

## Stable local wrapper

A separate repository-owned stable local wrapper MUST be added under:

```text
scripts/uk-aq-history-integrity/deploy-bin/
uk-aq-history-integrity-sos-light-stable-local-wrapper-v3.sh
```

When deployed locally it is expected to live alongside the normal wrapper under:

```text
/Users/mikehinford/uk-aq-history-integrity/bin/
```

The stable local wrapper follows the same environment-selection model as the current wrapper.

It reads only the small local selector file:

```text
/Users/mikehinford/uk-aq-history-integrity/env/TEST.env
/Users/mikehinford/uk-aq-history-integrity/env/LIVE.env
```

to obtain:

```text
UK_AQ_OPS_REPO_ROOT
```

The selector does not choose the runner filename.

The stable wrapper itself MUST explicitly resolve the stable repository runner:

```text
${UK_AQ_OPS_REPO_ROOT}/scripts/uk-aq-history-integrity/stable-sos-light/
uk-aq-history-integrity-sos-light-stable-v3.sh
```

The normal local wrapper continues to resolve the normal active runner.

## Environment ownership

There is no frozen stable copy of the repository root `.env`.

After the stable local wrapper selects the TEST or LIVE ops repository, the stable repository runner MUST load that selected repository's normal root `.env` in the same way as the current fixed-v3 runner.

Therefore:

- selector files continue to own only repository selection;
- the root `.env` continues to own current environment-specific credentials and paths;
- the stable code snapshot owns SOS-light program behaviour;
- credentials, bucket names, Dropbox roots and other environment configuration are not frozen into the stable source directory.

The stable path MUST preserve the same fail-closed environment-name and repository-root checks as the current runner.

## Normal and fallback routing

Creating the stable fallback MUST NOT automatically change the normal scheduled or operator default.

Normal SOS-light continues to use the active fixed-v3 path unless an operator deliberately invokes or deliberately switches to the stable wrapper.

The stable path exists for controlled fallback and comparison.

It MUST NOT be automatically selected after an active failure and MUST NOT silently fall back from active code to stable code inside one invocation.

## Immutability after creation

After creation and structural verification, the three files under `stable-sos-light/` are frozen.

Normal WAQN/SAQN implementation work MUST NOT edit them.

A later deliberate stable-baseline refresh requires:

1. explicit operator/user intent to replace the known-good baseline;
2. a new normal archive of the then-current implementation where required;
3. evidence that the proposed replacement SOS-light runtime has passed real TEST operational acceptance;
4. a deliberate update of the stable copy and this contract if its boundary changes.

The stable wrapper MAY receive a path-only correction if required to restore its ability to invoke the unchanged stable implementation, but such a correction must not silently alter SOS-light behaviour.

## Structural validation

Before WAQN/SAQN implementation begins, perform only the following structural checks:

1. the three stable files exist under `stable-sos-light/`;
2. the stable `_impl.py` content is byte-for-byte identical to the pre-change active `_impl.py` snapshot;
3. the stable Python wrapper resolves only the stable sibling `_impl.py`;
4. the stable shell runner resolves only the stable Python entrypoint;
5. the stable local wrapper resolves only the `stable-sos-light/` repository runner;
6. both normal and stable local wrappers still obtain only `UK_AQ_OPS_REPO_ROOT` from the local selector;
7. the stable repository runner still loads the selected repository root `.env`;
8. neither the stable wrapper nor stable runner resolves any `archive/` path.

These are structural checks only. Do not create a broad pre-implementation test suite.

## TEST operational acceptance

The stable fallback becomes an accepted executable fallback only after a real TEST invocation exercises the stable local wrapper through the stable repository runner and confirms the established SOS-light behaviour.

That operational acceptance SHOULD use a bounded, safe TEST SOS-light operation appropriate to the current environment and existing contracts.

The stable path MUST NOT be promoted as the LIVE emergency route solely because the files exist in Git.

Normal LIVE activation or use remains an explicit operator decision.
