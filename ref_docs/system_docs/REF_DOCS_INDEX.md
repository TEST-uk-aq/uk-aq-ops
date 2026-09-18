# UK AQ system-doc reference mirror

## Purpose

This directory is a read-only reference mirror of selected authoritative files from:

`TEST-uk-aq/uk-aq-system-docs/system_docs/`

It exists so single-repository Codex Cloud work in `TEST-uk-aq/uk-aq-ops` can read the contracts required for bounded ops tasks when the sibling system-doc repository is not present in the workspace.

The authoritative source remains `TEST-uk-aq/uk-aq-system-docs`. This mirror is not a second editable contract authority.

## Snapshot identity

Source repository:

`TEST-uk-aq/uk-aq-system-docs`

Source commit:

`550fc53d2c7bdb84dabecc6fe32984349994c026`

Snapshot date:

`18/09/2026`

## Reading rule

When `../TEST-uk-aq-system-docs/system_docs/` exists, coding agents should use that sibling authoritative tree.

When it is unavailable, use this mirror for the bounded task. Start at:

`ref_docs/system_docs/SYSTEM_OVERVIEW.md`

then follow the local mirrored route for the relevant R2-history / backup task.

If a routed contract is not present in this mirror, do not infer its contents. Report that the authoritative sibling file is unavailable.

## Mirrored scope

This snapshot intentionally contains the contracts needed for current TEST ops work around:

- History Integrity;
- SOS-light and SOS historical repair;
- observation-history index v3 and exact-leaf behaviour;
- Integrity writer/core/proposal/apply safety;
- direct selected-partition replacement and run exclusion;
- R2 history Dropbox backup, inventory, sync and v3 backup evidence.

It is intentionally not a complete copy of all UK AQ system documentation.

## Maintenance

Coding agents must not edit files under this mirror as a substitute for changing the authoritative system docs.

ChatGPT in Chat mode owns authoritative system-doc changes. When one of the mirrored source contracts changes, refresh the corresponding mirror file and update the source commit above in the same documentation task.

## Current v3 backup implementation gap

The authoritative contracts now require, under v3 observation-timeseries authority:

- the global `history/_index_v3/observations_timeseries_latest.json`;
- the exact scoped root `manifest.json` objects referenced by its `day_summaries[].scoped_roots[]`;

to be copied and byte/SHA verified in the pinned Dropbox backup generation.

The bulk scoped exact-index tree remains excluded.

As of this snapshot, the TEST backup implementation still copies the v3 global latest object but does not yet inventory/copy the referenced scoped-root manifests or record their checkpoint completeness. Treat this as an implementation gap, not as permission to weaken fixed-v3 Integrity dependency verification.
