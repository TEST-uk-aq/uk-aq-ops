# LIVE WAQN v2 History Integrity source availability failure

**Investigation date:** 11 October 2026
**Scope:** investigation and proposed correction only; no runtime change or Integrity invocation
**Repository baseline:** TEST `uk-aq-ops` `main` at `786cc0bb9f1e6fc848b42f52991ecb6e911a10eb`
**Diagnostic input:** `logs4GH/uk-aq-integrity-diagnostics-live-20261011T184740Z.zip` (Git blob `f6edffc23d4e2ddda63f3d70f3669f50d9f502dc`)

## Conclusion

The suspected defect is confirmed in the TEST source corresponding to the failing traceback lines. `check_official_network_rdata()` constructs and stores `binding_ids_by_pollutant` but does not place `bindings` in the run context. `_official_rdata_partition_availability()` reads `context.get("bindings")`, silently obtains an empty binding set, and returns no available timeseries even when authenticated site-year files provide available windows. The coordinator consequently treats an actually **partially** unavailable pollutant as **wholly** unavailable. Its separate, correct whole-unavailability file check rejects the successful site-year source coverage and raises the observed `ValueError`.

The diagnostic bundle proves the acquisition/coordination contradiction and the error location. It does **not** contain the LIVE acquisition manifest or a byte copy/diff of the dirty LIVE Python script, so the exact runtime context contents and the first pollutant processed cannot be inspected directly. The local TEST source has the same traceback line locations and supplies the causal path. Treat correction of this mismatch as the proposed fix, subject to the stated TEST operational verification.

## Run evidence and failure boundary

The evidence below comes from the ZIP, primarily `dropbox/LIVE/uk-aq-history-integrity/logs/run-2026-10-11T184541Z.log`, `state/LIVE/tmp/run-2026-10-11T184541Z/run-state.json`, `state/LIVE/launchd/job-status.json`, and `project/git-state.txt` (paths relative to the ZIP root).

| Question | Verified diagnostic evidence |
| --- | --- |
| Selected invocation | Preflight at log line 10 records `LIVE`, `manual`, `waqn`, 2026-10-01, `dry_run=True`, `run_backfill=True`. Run state requests `no2`, `pm10`, `pm25`, uses `repair_dry_run` and the `generic_integrity` execution path. Connector 9 is recorded in acquisition and traceback scope. |
| Safety preflight | Log lines 4 and 6 report IngestDB boundary `allowed=true` for connector 9 and requested date before 2026-10-08. Line 8 reports checkpoint/live observations root identity match (`8bf7f19c...`), `allowed=true`, `status=current`. Line 9 reports Dropbox backup ready. These are recorded decisions, not an independent recheck of remote services. |
| Acquisition | Log line 30 reports 39 required files: 35 successful (one metadata plus 34 site-year), four authoritatively absent, zero indeterminate. It reports 1,361 canonical rows, six unavailable scopes, 6,534,508 downloaded bytes, and 2026 as the source year. The acquisition manifest path and SHA-256 (`b5a439f0...`) are logged, but the manifest itself is absent from the ZIP. |
| Acquisition classification | The same line reports `partially_source_unavailable` for each of `no2`, `pm10`, and `pm25` on 2026-10-01. This is stronger evidence than the aggregate file counts for each pollutant, because aggregate successes might theoretically belong to other pollutants. |
| Detection | Log lines 31-33 report one connector 9 `connector_dir_missing` observations gap, `checked_partitions=0`, and creation of a local repair overlay/run state. |
| Exact failed operation | At line 34 and traceback, `main` → `run_v2_integrity_repair_flow` (LIVE source line 30232) → `run_v2_gap_backfills` (19481) → `_official_rdata_wholly_unavailable_scope_authority` (15192), raising `ValueError: official RData wholly-unavailable file coverage is incomplete`. The traceback is reproduced in the appendix with only the personal checkout path prefix redacted; Python itself abbreviates two call-frame argument lists with `...<N lines>...`. The ZIP retains the exact original paths. |
| Final status | The run log ends with that exception. The selected launchd job is `not running`, ran once, and has `last_exit_code=1`. No current-run summary JSON or successful `planned` status is in the bundle. |
| Proposal and mutation | In run state, `coordinator=null`, `objects={}`, all three `changed_scopes` lists are empty, and `tombstones={}`/`tombstone_prefixes=[]`. Source code enters `_prepare_official_rdata_proposal()` later (line 19613); the failure at 19481 precedes it and final proposal validation. Dry-run mode and these artefacts indicate no LIVE R2 mutation by this invocation. The bundle cannot independently inspect remote R2 after the run or rule out unrelated external writes. |

The run did not fail at the earlier `timeseries_row_counts` manifest validation boundary. The corrected JavaScript manifest validator is outside this proposal.

## Acquisition and context trace

`_official_rdata_bindings()` (source lines 15227-15400) joins active source-station/timeseries lookup, core timeseries and phenomena, and active observed-property mapping. It requires one unambiguous active binding for each selected site/pollutant group, rejects defective selected mappings, and produces mapping hashes. `check_official_network_rdata()` checks the connector identity against the source configuration (15436-15445), builds nonempty `binding_ids_by_pollutant` for every selected pollutant (15447-15462), then fetches the shared metadata and selected site-year files.

`download_pinned()` in `integrity/official_network_rdata.py` (617-690) validates the canonical/final provider URL, records a 200 response's byte count and SHA-256, and recognizes a validated HTTP 404 through `AuthoritativeSourceArtifactAbsent`. `acquire()` (15470-15665) records only that exception for site-year files as `authoritatively_absent`; metadata absence and other HTTP/transport/decode failures stop the run. Thus the four reported absences are not inferred from missing local files or a generic failed request. The bundle omits their individual URLs/404 records, so they cannot be independently reauthenticated here.

For each selected day, `required_by_day_pollutant` starts with the mandatory metadata key and adds only site-year file keys for sites bound to that pollutant (15695-15722). Successful files enter `identities_by_key`; authenticated 404s enter `absent_by_key`. `successful_by_day` and `absent_by_day` are intersections of those sets with the selected day's requirements (15857-15867). They are day wide, but `_official_rdata_wholly_unavailable_scope_authority()` intersects them with the **pollutant's** `required_by_day_pollutant`, so its file check is selected-scope isolated.

A 404 produces one unavailable scope per bound pollutant and day, carrying the site, source year/file key, timeseries ID, validated URL/status evidence, and canonical unavailable windows (15732-15759). A successfully decoded file marks its bound timeseries available for the intersecting day even if it yields zero canonical observations (15800-15808). Canonical rows are gathered separately (15809-15821). The context stores `available_timeseries_by_day`, `unavailable_scopes_by_day`, `binding_ids_by_pollutant`, required/successful/absent file sets, and mapping hashes (15842-15888). **It has no `bindings` field.** The acquisition summary determines partial/whole outcomes from `binding_ids_by_pollutant` intersected with `available_timeseries_by_day` and the unavailable scopes (15916-15937), which explains its three partial classifications.

For this selected UTC day, the year-2026 file covers the full day. A validated 200 file supplies an available window for each of its bound timeseries; a validated 404 supplies a full-day unavailable window for each. Thus the corrected window calculation should agree with `available_timeseries_by_day` intersected with the selected pollutant bindings.

The detector's `_v2_source_counts_for_partition` official-source branch (11518-11559) also reads `binding_ids_by_pollutant`. It requires selected IDs, complete disjoint required-file classification, and `selected_ids == available_ids | unavailable_ids`; it calls a pollutant partial when available and unavailable IDs coexist. This is internally consistent with the acquisition context and log summary. The run-state/ZIP does not retain the acquisition context or source file list, so the exact per-pollutant IDs and files cannot be enumerated from the bundle.

## Fault and caller consequences

At 15112-15117, `_official_rdata_partition_availability()` derives `binding_ids` from missing `context["bindings"]`. `dict(context.get("bindings") or {})` converts the missing field to an empty mapping. At 15118-15142 it still collects the selected pollutant's unavailable scopes and IDs. At 15143-15150 it computes available IDs only by iterating the empty binding set, so it **always returns no available IDs** for a normal acquisition context. The `canonical_day_has_available_window()` helper (official module 373-410) correctly asks whether any part of the UTC day lies outside the unavailable windows; it cannot help when no binding IDs are supplied. `unavailable_ids` intentionally can overlap `available_ids` when only part of a timeseries/day is unavailable; the full-window decision, not mere membership in `unavailable_ids`, distinguishes partial from whole.

All active callers in this file are:

1. `_official_rdata_wholly_unavailable_scope_authority()` (15161): accepts the false empty available set, then checks selected file coverage. It correctly requires the metadata file to be the **only** successfully read file and every other required site-year file to be authenticated absent (15171-15194). For a genuinely wholly unavailable pollutant this is appropriate. Here at least one selected pollutant had an acquired, available file according to the acquisition classification; the first such pollutant routed here fails the file check. This is a classification defect, not evidence that 404s were misread or a reason to relax coverage.
2. `_prepare_official_rdata_proposal()` (15991): would publish an empty source-available ID/code set for a repairable scope, even with successful source files or rows. Its producer/evidence checks can reject the inconsistency; this run never reached it.
3. `run_v2_gap_backfills()` (19454): sends every pollutant having at least one unavailable scope to the preserved-only path because `available_ids` is false. The branch authenticates pinned baseline, records `source_artifact_unavailable_preserved`, creates no tombstone and removes that pollutant from repair work. It then calls the whole-unavailability file check at 19481, where this run stopped. A truly whole-unavailable pollutant belongs in this branch. A fully available pollutant has no unavailable IDs and remains nominally repairable, though subsequent proposal availability evidence is wrong.
4. `_authenticate_official_rdata_final_target()` (24507): recomputes availability and compares it with frozen evidence at 24513-24514. A valid nonempty available set can be falsely rejected if execution reaches final target authentication.

The code therefore affects both WAQN (connector 9) and SAQN (connector 10), since they share acquisition and this availability function. Partial source absence can suppress an independently repairable pollutant and falsely advertise preserved-only/no tombstone. Fully available and authenticated empty-source windows can retain a repair candidate but carry a false zero available-ID set into proposal/final authentication. Whole absence is classified correctly only by coincidence, and still needs 404/file-coverage and pinned-baseline proof. No current-path false deletion follows from this defect; fail-closed checks abort contradictory attempts. The main practical effect is blocked or missing repair plans and invalid proposal authority. It must be corrected before making any statement about final proposal success or APPLY eligibility.

The earlier `_derive_executable_observation_repair_pollutants()` and `_official_rdata_observation_repair_eligibility()` use detector evidence from `binding_ids_by_pollutant`; they can select a partial pollutant for repair correctly before the later caller reverses that decision. The eligible state itself cannot bypass final target, source evidence, transition, Python/Node proposal, lock, or APPLY safeguards.

## Minimal proposed correction (not implemented)

**One file/function:** `scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py`, `_official_rdata_partition_availability()`.

Replace the `context.get("bindings")` iteration with the existing per-pollutant binding-ID entry. Fail closed when that entry is missing or empty; never infer whole unavailability from a missing mapping. An illustrative replacement for lines 15112-15117 is:

```python
    binding_map = context.get("binding_ids_by_pollutant")
    if not isinstance(binding_map, Mapping) or pollutant_code not in binding_map:
        raise ValueError("official RData selected pollutant binding authority is missing")
    raw_binding_ids = binding_map[pollutant_code]
    if not isinstance(raw_binding_ids, list) or not raw_binding_ids:
        raise ValueError("official RData selected pollutant has no bound timeseries")
    binding_ids = {int(value) for value in raw_binding_ids}
```

The existing unavailable-window calculation and return shape remain intact. No acquisition context field needs adding: the required binding map is already built, checked nonempty, stored, and consumed by detection/eligibility. No caller signature or evidence schema changes. Do not add a fallback to `bindings` or alter the whole-unavailable file check. As a narrow defensive refinement within this same function, reject unavailable-scope timeseries IDs outside `binding_ids` if review finds a path by which an inconsistent run context could reach it; the current acquisition builder already derives both from the same authoritative bindings, so that assertion is not needed to correct this run.

| Source state | Expected corrected decision |
| --- | --- |
| Fully available 200 files, with rows | Bound IDs have available UTC windows; keep the pollutant repairable and propagate nonempty source availability into proposal/final checks. |
| Authenticated 200 files with zero rows | The acquired window is still available. Zero observations may become authenticated empty final-target authority only after the existing empty-target and pinned-baseline checks; it is not whole unavailability. |
| Partial authenticated 404 coverage | Use canonical unavailable windows to separate available and unavailable timeseries/time ranges. Reconstruct the complete final target from authenticated source rows plus exact pinned baseline rows in unavailable windows; retain pollutant-scoped repair eligibility and preservation proof. |
| All relevant site-year files authentically 404 | No available window; preserve the selected pollutant, require metadata-only successful coverage and complete 404 set, authenticate pinned hierarchy; grant no tombstone/deletion authority. |
| Missing/empty selected binding entry | Raise before classification, proposal, or mutation. Never treat the missing entry as all source-unavailable or as authoritative empty. |

This matches the active `system_docs/r2_history/official_network_rdata_historical_integrity_contract.md` rules on disjoint 200/404 coverage, pollutant isolation, preserved-only whole absence, and authenticated final targets (especially lines 44-52). The dry-run reporting contract requires a genuinely failed proposal to remain failed rather than claim `planned` (`integrity_dry_run_reporting_contract.md`, lines 131-161).

This change preserves strict station/timeseries/observed-property binding, authenticated 200 and 404 identities, canonical windows, pollutant/day isolation, preserved observations, pinned Dropbox hierarchy and checkpoint/live-root equality, fail-closed behaviour, existing proposal validation, and all APPLY safeguards. It changes only the source of `binding_ids` in a shared classification helper. No JavaScript, shell, environment, data, schema, or acquired-context change is indicated. A search of immediately related active generic functions found no other reference to the nonexistent `context["bindings"]`; the detector, eligibility, and acquisition code use `binding_ids_by_pollutant`. No additional concrete active-path defect is established by this bundle/code review.

## Minimum operational verification after a later implementation

After normal TEST deployment and prerequisite gates, run **one TEST v2 WAQN `--run-backfill --dry-run`** against a selected connector/day/pollutant scope known in TEST to have a structural repair finding and mixed authenticated 200/404 site-year coverage. The same 2026-10-01, `pm25,pm10,no2` selection is suitable only if TEST has that finding and coverage; this bundle cannot establish TEST's current state. Keep normal source, checkpoint, root, binding, proposal, and lock gates enabled. Do not proceed directly to LIVE APPLY.

Expected observable evidence: acquisition and coordinator agree on partial availability and nonempty bound available IDs; successful source files remain in the selected pollutant's coverage; unavailable windows remain preserved from the authenticated pinned baseline; no false whole-unavailable authority or `file coverage is incomplete` error; the applicable final target and local Python/Node proposal admission pass; a repair-needed dry run reports `status=planned`, `dry_run=true`, `repair_applied=false`, `proposed_state_status=ok`, and no R2 write. If TEST has no repair finding, a clean no-op does not exercise the corrected coordinator path and cannot serve as this verification.

## Remaining uncertainty

- The bundle excludes the run-scoped `acquisition-manifest.json`, RData bytes, SQLite, and env files. It proves aggregate counts and reported pollutant outcomes, not the exact 35 file identities, four 404 responses, bound timeseries lists, or per-pollutant row counts.
- `project/git-state.txt` records a dirty LIVE checkout at `f5301e83...`, including a modified Python implementation and several untracked helpers. The ZIP does not contain their diffs or the complete Python file. The traceback line positions match the current TEST code, but byte-for-byte LIVE/TEST source equivalence is unproven.
- The traceback formatter abbreviated parts of the `main` and `run_v2_integrity_repair_flow` call argument lists. No separate full frame-local dump is supplied.
- The ZIP contains no current-run final report or independent post-run LIVE R2 inventory. Local run state and launchd failure establish that this dry run stopped before proposal/APPLY; they do not audit other actors' remote writes.
- The exact first pollutant processed by the failing dictionary comprehension is not recorded in the traceback. The three acquisition classifications were all partial, so the diagnosis does not depend on its identity.

## Appendix: diagnostic traceback (personal checkout prefix redacted)

```text
Traceback (most recent call last):
  File "<LIVE ops checkout>/scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py", line 35867, in main
    repair_flow = run_v2_integrity_repair_flow(
    run_state=repair_overlay,
    ...<30 lines>...
        ),
    )
  File "<LIVE ops checkout>/scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py", line 30232, in run_v2_integrity_repair_flow
    observations = run_v2_gap_backfills(
        conn=conn, run_id=run_id, env_name=env_name, run_compact=run_compact,
    ...<5 lines>...
        proposal_staging=proposal_staging,
    )
  File "<LIVE ops checkout>/scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py", line 19481, in run_v2_gap_backfills
    _official_rdata_wholly_unavailable_scope_authority(
    ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~^
        context=official_context,
        ^^^^^^^^^^^^^^^^^^^^^^^^^
        day_utc=day_iso,
        ^^^^^^^^^^^^^^^^
        pollutant_code=pollutant_code,
        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    )
    ^
  File "<LIVE ops checkout>/scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity_impl.py", line 15192, in _official_rdata_wholly_unavailable_scope_authority
    raise ValueError(
        "official RData wholly-unavailable file coverage is incomplete"
    )
ValueError: official RData wholly-unavailable file coverage is incomplete
```
