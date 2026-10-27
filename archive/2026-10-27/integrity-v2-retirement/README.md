# Integrity v2 retirement snapshot (27 October 2026)

**Status: RETIRED / ARCHIVE ONLY. Do not execute, import, deploy, promote or configure any file in this archive as an active UK AQ runtime.**

This is an exact Git-object copy of 26 selected TEST v2 Integrity and SOS-light sources from TEST Ops main commit `52eedd1ecc239bbd6e0137a1fa5f60937216d6ae`. The original relative paths are retained under this archive directory, including the generic v2 coordinator, the fixed-v2 SOS-light runner, the older backfill wrapper and the complete stable-sos-light-v2 snapshot. Files retain their original Git blob identities; no content was rewritten for the archive.

**Reason:** UK AQ now uses fixed-v3 SOS-light/Integrity. Generic Integrity v2 and fixed-v2 SOS-light have been retired from intended operations. Do not use their historical launchers or revive scheduled v2 jobs.

**Important reactivation note:** If Integrity v2 is ever explicitly reactivated, review the authoritative TEST [SOS-light three-phase authority contract](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/main/system_docs/r2_history/sos_light_three_phase_authority_contract.md) and remove the now-redundant chronological 'Dropbox backup ran after last Prune/Integrity observation writer' requirement from the revived v2 code. Instead require a completed authenticated Dropbox checkpoint, matching locked Dropbox/live observations-root content hashes, reliable global exclusion and all independently applicable Core/binding/verification authority checks. Do not use `--allow-stale-dropbox` to circumvent those safeguards. Review any separate Daily Task Health readiness semantics before changing them.

**Archival boundary:** These copies preserve source history only. Existing active source paths are deliberately not deleted or rewired by this archival commit because their references and potential shared dependencies have not yet been exhaustively reviewed. Deprecation in contracts does not itself disable deployed local launchd wrappers. Audit/disable any existing v2 schedules and shared references before safely retiring active paths. This archive does not constitute a TEST deployment or a LIVE change.

**TEST-to-LIVE discipline:** Changes, if ever needed again, must be made and validated in TEST first. Never copy TEST archive directories into LIVE. Never modify LIVE code through this archive.
