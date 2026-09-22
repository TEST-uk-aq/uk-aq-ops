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

`77ef0e55646beb2d50d70705b0c342e101a67429`

Snapshot date:

`22/09/2026`

## Reading rule

When `../TEST-uk-aq-system-docs/system_docs/` exists, coding agents should use that sibling authoritative tree.

When it is unavailable, use this mirror for the bounded task. Start at:

`ref_docs/system_docs/SYSTEM_OVERVIEW.md`

then follow the local mirrored route for the relevant bounded task.

If a routed contract is not present in this mirror, do not infer its contents. Report that the authoritative sibling file is unavailable.

## Mirrored scope

This snapshot intentionally contains the contracts needed for current TEST ops work around:

- History Integrity;
- SOS-light and SOS historical repair, including the load-bearing three-phase authority contract;
- observation-history index v3 and exact-leaf behaviour;
- Integrity writer/core/proposal/apply safety;
- direct selected-partition replacement and run exclusion;
- R2 history Dropbox backup, inventory, sync and v3 backup evidence;
- AURN validation-status behaviour;
- Media Bluesky publication behaviour;
- Media dashboard behaviour and article/Bluesky preview contracts;
- History Integrity v2/v3 dry-run reporting and Operations dashboard dry-run status presentation;
- GCP Cloud Logging analysis archive source/archive/redaction identity, quota-safe retrieval, publication, checkpoint and recovery behaviour;
- operator-execution progress, persistent run-log and structured-run-report behaviour for qualifying local scripts.

It is intentionally not a complete copy of all UK AQ system documentation.

## Maintenance

Coding agents must not edit files under this mirror as a substitute for changing the authoritative system docs.

ChatGPT in Chat mode owns authoritative system-doc changes. When one of the mirrored source contracts changes, refresh the corresponding mirror file and update the source commit above in the same documentation task.

## Current SOS-light / v3 authority

The authoritative SOS-light contract now requires:

- Step 0 hard currentness precheck:
  - request-level IngestDB boundary passes;
  - acquire the global observations operation lock;
  - while that lock is held, verify the Dropbox checkpoint is complete and valid;
  - require the successful Dropbox backup to have completed after the latest relevant completed R2 writer, including Prune Daily and Integrity/SOS-light;
  - read the Dropbox fully processed observations-root `content_hash`;
  - read the current live R2 observations-root `content_hash`;
  - require exact equality between those root hashes;
  - pin the Dropbox baseline only after all preceding checks succeed;
  - any failure before pinning stops immediately before DETECT;
- DETECT from the pinned Dropbox baseline plus authoritative current-run repair source;
- PROPOSE from a local Dropbox+repair overlay, rebuilding every affected derived v2/v3 index deterministically;
- APPLY only the frozen changed/removed set, then verify those R2 results;
- no pre-apply live-R2 observation/index dependency discovery beyond the single Step 0 observations-root hash comparison;
- no normal Dropbox backup expansion for v3 scoped-root dependency evidence.
- serial monthly SOS-light wrappers refresh Dropbox after every successful month, including the final month; correlate and wait for the exact backup run; wait for that backup generation to reach the local checkpoint; do not use `--allow-stale-dropbox`; stop on month/backup/sync failure; and do not use a fixed cooldown. The local checkpoint root alone is insufficient: refreshed files consumed by the next SOS-light baseline must also pass the exact-run local materialisation/authentication gate.

PR #69's scoped-root backup expansion was reverted. The normal v3 backup continues to carry the generation-selected compact `observations_timeseries_latest.json` but not the full derived scoped/exact index tree.
