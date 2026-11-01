# Manual TEST Dropbox historical bootstrap

This manually invoked tool produces **local/private observation/AQI candidates**.
It has no workflow, scheduler, uploader, managed selection or chart integration.
Imports are inert. The first real TEST operation requires separate authorisation
after code review. Development did not run a backfill or fetch Dropbox history.

For the 29 October reporting-boundary correction, authoritative TEST system-docs
were read at `main` `ca05b051829157a9d30ce4778485a067193c7fe6`, following the JSONgen, compressed-history,
precomputed-AQI, canonical observation hierarchy/schema/generation, verification,
station-history AQI and Dropbox checkpoint/pack routes. No authoritative docs or
plans were edited. This README describes implementation, not a replacement contract.

## Inclusive UTC month-range selection and Stage 2 shared processing

The selected-series manual generator now accepts `--months YYYY-MM:YYYY-MM`,
inclusive, or a single `--months YYYY-MM`. Use this **instead of** every legacy
period flag (`--month-utc`, `--start-utc`, `--end-utc`, `--partial-month-utc`,
`--completed-before-utc`); combining them is rejected. Existing manual modes keep
their original admission and date semantics. Select either explicit bounded
`--timeseries-ids` or the boolean opt-in `--all-eligible-timeseries`, alongside the existing connector/pollutant selection,
checkpoint byte/root pins, verification modes, configured Dropbox/R2/lock access
and a new private output directory. The new mode supports selected physical
PM2.5, PM10 and NO2 series; it does not inherit the old single-PM2.5-month limit.

For example, replace the period flags in an independently reviewed command with:

```sh
--months 2026-08:2026-11 --timeseries-ids 212,324
```

This fragment is illustrative, not run authorisation or a claim that these series
and dates are complete in any selected backup. All other required flags and
existing operator configuration still apply. Do not run a historical bootstrap
as part of code review. Implementation followed the 1 November 2026 month-range
and initial-bootstrap contracts at system-docs `main`
`d799c1daf5da84187c012c474694132a53e26aed`; authoritative documentation was read only.

The invocation captures the current **UTC** month once. Every earlier selected
month requests its entire calendar interval, including a historical last month.
Invalid, reversed, future or conflicting selections fail before source work.
The existing `--max-days` budget reserves the whole selected calendar envelope,
including all possible days of an included open month; defaults/hard maxima and
other invocation budgets remain unchanged. No fixed 90-day truncation is used.

After authenticating the explicitly pinned completed Dropbox v3 backup, the
planner walks the current month's days from day 1, stopping at the first day
without positive completion evidence. A reporting day requires authenticated
manifest membership and checkpoint `copied_at` at or after that timestamp-day's
end, no later than invocation time. Missing observations, parent omission and
elapsed wall time alone cannot establish day completion. The current UTC day
is never included. With the existing conservative terminal rule, a cutoff also
requires positive completion of its following timestamp-day, from the same
checkpoint. This can leave the last otherwise completed reporting day unselected
until terminal evidence exists. No new partial-day/exact-midnight proof is added.

The resulting exclusive UTC cutoff is fixed **before** initial R2 comparison.
It is never shortened to conceal a source/current hash mismatch. When no day
qualifies, the current-month scope is incomplete, with no fabricated empty pair;
eligible earlier months continue. On a month's first UTC day there are zero
completed reporting days. An ended month always requires full coverage on a
later invocation. A closed month's next-month terminal dependency may also be
pending independently of its sound raw-month hash.

Admitted periods feed the existing Dropbox reconstruction, PM predecessor,
terminal-midnight, shared AQI, SHA-256/gzip and private output pipeline. Raw rows
remain `[S,E)` and AQI endpoints remain `S < n <= E`. Both scoped R2 comparisons
retain the brief shared lock; Dropbox reads, decoding and original-byte rechecks
remain outside it. R2 supplies bounded authenticated comparison metadata only.
There is no R2 observation/index discovery, Parquet fallback, new checkpoint
selection, publication, selector or website integration.

Month-range mode now shares decoding across physical series. The legacy period
modes retain their existing processing and date meanings. All-series mode requires
`--months`, connector `1`, and a selected subset of `pm25,pm10,no2`; it cannot be
combined with `--timeseries-ids`. To select all three pollutants, replace the
selection fragment in a separately reviewed, fully pinned command with:

```sh
--months 2026-08:2026-11 --connector-ids 1 \
  --all-eligible-timeseries --pollutants pm25,pm10,no2 --max-series 1024
```

This example represents three previous complete months and a potentially partial
current month for an invocation during November 2026. The tool derives the actual
UTC boundary and source admission; this fragment is not run authorisation. All
checkpoint/root pins, verification modes, output and existing configuration remain
required. The default physical-series cap remains 256; an all-AURN operation may
need an explicitly reviewed larger bound, up to the existing 4096 hard maximum.

Discovery walks only authenticated Dropbox reporting-day canonical manifests.
A complete `timeseries_row_counts` map (positive counts summing to the canonical
row count) proves physical membership. If the map is absent, the same whole-file
decoder establishes bounded membership and saves its validated day partitions for
candidate generation. Missing/unproved source coverage records an incomplete
inventory scope; it is never treated as an empty station inventory. The selected
union receives a pair for **every selected reporting month**, including months
with authenticated natural gaps. Dependency-only identities are reported as
excluded from candidate selection, with a reason. Explicit identities and binding
failures are also reported. Inventory is never sliced to fit a processing cap.

Each needed day/connector/pollutant is decoded once in an invocation, including
shared monthly boundary days and discovery fallback. All canonical files in the
day are still authenticated and decoded, including files containing unselected
series. SHA-256, byte size, schema, millisecond timestamps, binary64 values, file
and physical-series counts, row/status identity and original source proof remain
required. The decoder partitions selected rows into private per-series/day JSONL
spools, flushing at each file. No source-day spool is admitted after a defective
shared file. Series binding/validity failures are isolated to that physical series.
Schema-2 binding packs may supply the physical member's own station and inclusive
valid-day bounds; logical members are never stitched or relabelled.

Only requested raw intervals, preceding 23-hour PM inputs and exact closing
midnights are retained. One physical series/month is loaded and hash-checked at a
time for the existing observation/AQI writer, then released. Negative and null
concentrations, timestamps, duplicate rows and status provenance stay in raw
output. A null concentration supplies no AQI sample. Shared DAQI/EAQI algorithms
are unchanged. Raw-day, PM and terminal failures have separate completeness
results; a failed PM/terminal dependency cannot mark an independently proved raw
month invalid. Unknown source coverage is not a natural measurement gap.

`--max-temp-mib` adds a CLI-only budget (default 2048 MiB, maximum 32768 MiB)
for the combined authenticated source cache and decoded spools in `--months` mode.
Legacy modes retain their source-byte cache cap unless this new flag is supplied. File/object/row
and all previous global limits remain. Spools are deleted after their last
month/pollutant consumer, keeping adjacent PM/terminal days for reuse. Source cache
bytes remain available for final original-byte proof. Controlled completion or
failure removes the work directory; a hard kill can leave that bounded directory.
A per-candidate selected-row breach reports that series/month incomplete; exhausted
global bytes/rows/objects/time/series/disk budgets stop the invocation. No output is
truncated. Diagnostic outputs and known pending candidates remain reported. A
smaller explicit follow-on batch requires fresh checkpoint and currentness proof;
there is no automatic resume or complete cross-batch claim.

Metrics distinguish unique content-authenticated Parquet files, successful Parquet
downloads, cached file reads, decoded-day spool reuse, actual Parquet decode passes per source
file (failed reads/metadata admission do not count as decoding), decoded rows, assigned rows, retained rows and transferred bytes (including
failed transfers). They also report bounded file-buffer rows/bytes, maximum
candidate rows, sampled RSS and process maximum RSS, combined temporary disk
peak, spool bytes written, output bytes/object counts, month/pollutant source and
candidate time, and completed/incomplete requested monthly candidates. These are
local process measurements, not estimates of every child process or HTTP overhead.
The existing 15-second progress includes discovery, current source dependency,
staged candidates, assigned rows and temporary bytes. No performance claim follows
from structural validation; see [the implementation handover](STAGE_2_HANDOVER.md).

`report.json.month_plan` and the private candidate manifest record the requested
range, captured UTC time, full calendar boundaries, resolved partial cutoff,
selected/completed days, terminal evidence, source proofs and per-month results.
Initial/final currentness and successful/incomplete scopes identify affected
months/days, connector/pollutant/physical series where known, failure phase,
safe reason, authenticated original/current hashes and independent raw/AQI
completeness. A failed initial raw-month gate avoids candidate construction (inventory discovery
may already have decoded a source lacking membership metadata). PM/terminal-only
failures preserve independently proved raw candidates and leave the pair incomplete.

Source-month planning failures, selected binding failures, currentness mismatches
and source/readback defects fail dependent scopes while independent work continues.
A shared defective Parquet or binding range fails every selected series relying
on it. Source revalidation and final-currentness failures preserve staged products
as incomplete diagnostics; a terminal/PM-only defect can leave raw output complete.
Scientific missing/insufficient-sample AQI outcomes keep the existing meanings.
Checkpoint/trust-root failure, lost lock, essential configuration/authentication
failure or exhausted global resource budget stops the invocation. Any incomplete
requested scope makes the invocation exit nonzero and omit global `COMPLETE.json`;
unaffected final-authenticated pairs remain separately reported for later review
and fresh revalidation, with no automatic resume or promotion.

Only syntax/import/help and diff checks were used for development. Separately
authorised real TEST operations must validate month rollover, positive day and
terminal admission, per-scope continuation, original/current hashes, raw/AQI
boundaries and fidelity, product/report hashes and resource costs. No persistent
configuration, database schema, schedule or deployment changes are required.
Rollback is to stop using this CLI mode/revert the implementation; dated original
code is preserved under `archive/2026-11-01/scripts/jsongen/bootstrap/` and is never
executed. No contract amendment was needed. ChatGPT should update implementation
status in the two routed bootstrap contracts and Station Charts README after code
review, keeping Stage 2 operational acceptance explicitly pending. See the
[Stage 2 handover](STAGE_2_HANDOVER.md) for the implemented changes and remaining gates.

## Authority boundary and assumptions

This is a reconstruction of an explicitly selected completed backup. It is not
a historical Prune handover, writer attestation, original gate event, verified
change receipt, authenticated managed baseline or proof of current R2 authority.
The managed selector stays disabled and its schemas and safeguards are unchanged.
No contract conflict was identified within this local-only candidate boundary;
promotion into managed publication remains a separate authority/acceptance stage.

The contracts separate authorised initial bootstrap/manual rebuild from normal
managed regeneration. Dropbox excludes the exact-v3 observation index trees.
This offline consumer authenticates canonical manifests and whole Parquet files,
then uses physical row IDs and authenticated binding packs. It never restores or
rebuilds excluded indexes and never falls back to R2.

For each connector the operator must explicitly select `pre_overlay_accepted`
or `overlay_accepted`, based on existing accepted transition evidence **at the
selected backup**. This is recorded as an operator-supplied historical assumption,
not independently established current acceptance. A pointer alone cannot activate
an overlay. Its selection must agree with the mode and completed verification
checkpoint. Missing overlay checkpoint evidence is permitted only for explicitly
selected pre-overlay schema-3 history. Schema 4 requires authenticated overlay
authority. Age and raw provider-status absence never change P/R/null.

The confirmed 17 October 2026 backup evidence supplied by the cross-repository
review has `history/_index_v3/verification/latest.json` entries for connectors
**9 and 10, not connector 1 (AURN)**. The inspected AURN **PM2.5** manifests for
5, 6 and 12 October declare **history schema version 3**. These are the reviewed
scopes, not proof of every pollutant/day in the proposed operation. No new
Dropbox read was performed for this documentation correction.

For that selected backup, `1=pre_overlay_accepted` is the expected AURN mode
**only if supported by accepted connector-transition evidence**. Neither
connector 1's absence from the overlay pointer nor the inspected schema-3
manifests establishes that acceptance by itself. The operator must establish
the accepted AURN transition state before supplying the mode and running.
That backup-specific acceptance remains an **unresolved operational prerequisite**;
the example below is not an approval or an instruction to activate a transition.

The [verification-overlay contract's existing-seven-column, reader and cut-over
rules](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/bbc09c2da361136bf1dcbdea077f07014f84b668/system_docs/r2_history/observation_verification_overlay_contract.md#existing-seven-column-parquet)
support schema-3 embedded-status compatibility before accepted connector cut-over.
The [JSONgen AURN status decision](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/bbc09c2da361136bf1dcbdea077f07014f84b668/system_docs/station_charts/compressed_history_json_verified_writer_regeneration_contract.md#aurn-verification-status-and-unavailable-source-provenance-decision-17102026)
requires preservation of canonical P/R/null. These contracts support the code
path; they do not provide a backup-specific AURN acceptance record.

The existing validator requires an explicit mode; it does not infer acceptance
from a missing connector overlay. With the reviewed pointer, selecting an AURN
overlay mode fails because no authoritative connector-1 overlay is selected.
Conversely, a selected connector-1 overlay contradicts pre-overlay mode, and
schema 4 cannot use that mode. An unexpected verification transition must fail
closed and require review. Mode selection is **not an instruction to rewrite
observation status**: schema-3 embedded `P`, `R` and `null` remain unchanged;
JSONgen never infers ratification from age or fills stored null with `P`.

Generic connector support grants no public publication permission. Explicitly
review connector/physical-series/pollutant selection before operation. Other
networks, including Sensor.Community, must not be promoted by inference. Logical
continuity stitching is excluded. Legacy period modes reject continuity-bearing
bindings; month-range mode accepts only the requested physical member and checks
its own station/valid-day bounds, without combining or relabelling members. Supported canonical physical authority is
schema 3/4; older schema-2 authority is rejected.

## Existing configuration and checkpoint pins

Use Node >=20, the repository's existing dependencies, and rclone. Reuse the
backup's `uk_aq_dropbox` remote, Dropbox application authentication and existing
`RCLONE_CONFIG`. No second OAuth client, credential discovery or explicit token
refresh implementation is added. Normal rclone refresh may update its existing
**local** config. `UK_AQ_R2_HISTORY_BACKUP_RCLONE_BIN` retains its existing meaning.
No new persistent environment variables/catalogue entries are introduced.

The Dropbox transport is exact `rclone cat` below the root resolved by the
existing backup configuration (`UK_AQ_DROPBOX_ROOT` and
`UK_AQ_R2_HISTORY_DROPBOX_DIR`) on the `uk_aq_dropbox` remote. There is no local
Mac path or arbitrary remote, LIST, upload, deletion, restore, or database
operation. It also performs bounded read-only R2 hierarchy GETs and acquires the existing TEST
observations global operation lock for initial and final currentness checks.
Existing auth/config was inspected in code; credentials and permissions were
not exercised during development.

Supply two distinct pins:

1. `--checkpoint-sha256`: SHA-256 of the **exact selected completed checkpoint
   root.json bytes**. This pins observation, binding and verification state
   together, even when a later checkpoint has unchanged observation measurements.
2. `--observations-root-sha256`: its recorded
   `observations.processed_source_root_hash`. The known completed 17 October root
   is `05d3b404c9c6ab806d687509194d2d8878c12d8728091fa381fca1165b236366`.
   It is an example input, not a permanent implementation constant.

The explicitly supplied checkpoint path uses the real selected-v3 format:

```text
_ops/checkpoints/r2_history_backup_state_v2/observation_generation=v3/root.json
```

The raw checkpoint byte digest and accepted connector transition evidence were
intentionally **not fetched** during development. Obtain/review these in narrowly
scoped metadata preparation for the separately authorised real operation. Never
substitute the observation root hash for the checkpoint byte digest.

The checkpoint `root.json` is **mutable**: a later backup can replace its bytes.
The operator must obtain and pin the exact SHA-256 of the selected completed
root bytes, separately from the observation-root digest. A replaced checkpoint
must cause a mismatch at the initial read or final stability recheck, even if
the observation-root digest is unchanged. The tool must not implicitly switch
to the newer checkpoint/generation or substitute one digest for the other.

Checkpoint year/month completion and selected day state must agree with the
canonical root/year/month/day/connector/pollutant chain. Valid parent omission
proves absence; missing referenced objects fail. Every consumed Parquet file
must match canonical SHA-256, size, physical schema and row count, plus selected
series counts where supplied. Opaque ETags cannot authenticate Dropbox bytes and
are rejected. Finer timestamp precision is rejected before decoding, not truncated.

The generation descriptor selects the actual v3 pack namespace:

```text
history/_backup_packs_v1/timeseries_binding/generation=v3/
```

The adapter authenticates checkpoint/root/range/pack identities, reconstructs the
source-root/range hashes from complete membership and invokes the existing
closed-set validator for paths, base64, member hashes and sizes. Retained v2 packs
or individual files cannot satisfy v3 binding authority. Reconstructed manifests
are in-memory validation only. Matching Core publication is not independently
authenticated here; the evidence says so explicitly. Binding bytes/membership
are authenticated within the backup and corroborated by physical row station
identities, without claiming current binding/Core authority.
Verification has its own processed root, exact
latest and selected immutable connector manifests, checked against the checkpoint.
Existing status resolvers supply effective P/R/null. Genuine retained legacy
source status stays separate from embedded verification status. Unretained raw
status is explicitly `original_source_status_unavailable` for each row.

All consumed metadata, checkpoint last, is reread before finalisation. Changed,
missing or unreadable dependencies fail the run. Parquet is content-hash pinned
when consumed. This detects selected-backup changes; it is not a distributed lock
or current-R2 claim. Overwritten old backup bytes require recovery, not weaker pins.

The `--month-utc YYYY-MM` mode requests one complete UTC calendar month and
requires one explicit physical timeseries and PM2.5. Connector, physical series
and month remain operator inputs. The partial-month mode combines complete
calendar months with a final selected month cut off at an explicit UTC midnight:
`--start-utc YYYY-MM-01T00:00:00Z --partial-month-utc YYYY-MM
--completed-before-utc YYYY-MM-DDT00:00:00Z`. The cutoff day is exclusive.
Legacy range mode remains available and is compared as selected-day membership.

Currentness is proved per selected scope. Full calendar months compare the
authenticated Dropbox processed-month hash with the current canonical R2 month
hash, and both month identities must be established; matching missing months do
not count as current. Partial months compare each selected day manifest hash or
authenticated absence, with absence accepted only when both the selected Dropbox
completion evidence and canonical parent hierarchy authenticate it. PM2.5/PM10
pairs also compare the preceding full context day; NO2 does not depend on PM
context. Dropbox checkpoint, source ancestry and selected source proofs are
prepared from the exact supplied pin before acquiring the initial shared lock.
The initial and final lock callbacks contain only bounded canonical R2
root/year/month reads and scope comparisons. Dropbox selected-leaf checks and
local rehashing of the original cached source bytes happen outside those locks.
If the canonical state changes while source preparation is underway, the pinned
source proof is compared under the lock and the scope fails closed; no newer
Dropbox checkpoint is adopted.

Every represented period also has a distinct `terminal_days` scope at its exact
closing midnight, for all three pollutants. Initial and final comparisons use
that source day's manifest hash authenticated through the current root/year/month
chain. The whole following month's hash is not an equality gate: unrelated later
days can advance without invalidating the earlier AQI candidate. A changed closing
day fails derived AQI currentness independently of the requested raw month.

The original checkpoint and root/year ancestry remain pinned as provenance, but
their mutable global keys need not stay byte-identical. The tool records the
current checkpoint digest for diagnosis and never adopts it. Full-month scopes
revalidate their selected month manifest and completion shard; partial scopes
revalidate only selected day pollutant leaves, so later unselected days may
advance. Required selected binding and connector-verification objects are also
checked. Final canonical R2 comparison occurs under the shared lock, which
serializes against a backup or canonical writer holding that same lock. If the
selected source chain or a required dependency cannot be proved, only affected
scopes fail closed; a changed global checkpoint alone does not invalidate an
unchanged month.

Matching scoped currentness can make a **local private pair** ready when source,
AQI response and required context are complete. It does not establish matching
Core publication, independent verification-transition authority, writer
publication freshness or a managed baseline. Those remain explicit blockers to
managed publication, which is always disabled. A successful `COMPLETE.json`
means only that the local candidate set passed this bounded readiness gate and
is available for further manual review. It is omitted if any requested scope
fails, even when unaffected month pairs remain complete in the report. Regenerate
changed or unproved scopes only in a separate invocation with fresh pins; never
rebase an existing candidate onto a newer checkpoint.

## Proposed seven-day command — do not execute during code review

Run from TEST ops only after separate authorisation. Set these local shell inputs
from reviewed operational evidence; they are not new repository environment keys:

```sh
# bootstrap_checkpoint_sha256=<exact completed root.json byte SHA-256>
# bootstrap_verification_modes=1=pre_overlay_accepted
#   Set ONLY after establishing accepted AURN transition evidence for this backup.
#   That prerequisite remains unresolved; this example is not run authorisation.
# bootstrap_output_dir=/absolute/private/work/jsongen-october-seven-days-unique-run

UK_AQ_ENV_NAME=TEST node --max-old-space-size=4096 \
  scripts/jsongen/bootstrap/generate.mjs \
  --source dropbox-backup \
  --checkpoint-path _ops/checkpoints/r2_history_backup_state_v2/observation_generation=v3/root.json \
  --checkpoint-sha256 "${bootstrap_checkpoint_sha256:?set the reviewed checkpoint byte digest}" \
  --observations-root-sha256 05d3b404c9c6ab806d687509194d2d8878c12d8728091fa381fca1165b236366 \
  --start-utc 2026-10-06T00:00:00Z \
  --end-utc 2026-10-13T00:00:00Z \
  --connector-ids 1 \
  --pollutants pm25,pm10,no2 \
  --verification-modes "${bootstrap_verification_modes:?set the accepted connector transition mode}" \
  --max-series 2048 \
  --max-selected-rows 500000 \
  --max-source-mib 4096 \
  --output-dir "${bootstrap_output_dir:?set a new absolute private directory}"
```

The existing `RCLONE_CONFIG`/remote, TEST database URL and R2 read credentials
must be available in the shell. To narrow the first operation, add `--timeseries-ids 212`
and select only its authorised pollutant (`--pollutants pm25`). That is a separate,
smaller scope, not acceptance of every connector-1 series.

The command reads 5 October as hidden context and exposes observations only in
`[6 October 00:00, 13 October 00:00)` UTC. It explicitly claims no reconstruction
for 1–5 or 13–31 October. Measurements retain timestamps, binary64 precision,
negatives, nullable station IDs and multiplicity. Existing canonical JSON uses
round-trip numbers (canonical negative zero serialises as zero). Measurements
are never rounded, averaged, interpolated or deduplicated.

### Complete-month command shape

The supported first-scope shape uses one operator-supplied connector, one physical
timeseries, `pm25`, and one UTC month. Set the identity, month, checkpoint byte
digest, observation-root digest, accepted verification mode and private output
from independently reviewed operational evidence before any separately authorised
run. The invocation also requires the existing TEST database URL, R2 credentials,
Dropbox remote and configured source root for its shared lock and read-only
currentness checks.

```sh
UK_AQ_ENV_NAME=TEST node --max-old-space-size=4096 \
  scripts/jsongen/bootstrap/generate.mjs \
  --source dropbox-backup \
  --checkpoint-path _ops/checkpoints/r2_history_backup_state_v2/observation_generation=v3/root.json \
  --checkpoint-sha256 "${operator_checkpoint_sha256:?set reviewed exact checkpoint digest}" \
  --observations-root-sha256 "${operator_observations_root_sha256:?set reviewed processed root digest}" \
  --month-utc "${operator_month_utc:?set closed UTC month YYYY-MM}" \
  --connector-ids "${operator_connector_id:?set reviewed connector ID}" \
  --timeseries-ids "${operator_timeseries_id:?set reviewed physical timeseries ID}" \
  --pollutants pm25 \
  --verification-modes "${operator_verification_mode:?set independently justified mode}" \
  --output-dir "${operator_private_output:?set new private absolute directory}"
```

## Bounded processing and AQI

Whole UTC days are accepted. Full-month mode derives boundaries from the explicit
`YYYY-MM`, accounts for every selected UTC day separately from natural missing
measurements, and records preceding PM context days. Ranges split at month
boundaries. Legacy ranges process one connector/pollutant/month in memory and
decode each Parquet once for that unit. `--months` shares source-day decoding and
loads one series/month at a time as described above. SHA-pinned local disk cache
avoids repeat Dropbox downloads. Source bytes and the new combined temporary-byte
budget bound source cache plus spools; controlled completion/failure removes them.
One binding range is cached in memory. Temporary-byte metrics reserve payload bytes
and exclude filesystem allocation overhead. Operators still need adequate free disk.

`--help` lists defaults and hard maxima for days, series across the invocation,
selected rows per month unit including context, decoded rows, rows/bytes per file,
metadata bytes per object, total source bytes, objects, read commands, output bytes
temporary bytes and wall time. Exceeding any bound fails; no selected source data is truncated.
Memory includes one decoded file, the month's rows, a binding range and JSON/gzip
buffers; the proposed Node heap cap adds a process guard. Use smaller explicit
series batches when needed. Limits are protective, not measured throughput claims.

Each Dropbox subprocess has a 45-second deadline, bounded by the invocation's
remaining time, 15-second connect/30-second idle limits and unchanged
`--retries 1 --low-level-retries 1`. A read of the same admitted key may use at
most three sequential subprocess attempts, with 1-second then 3-second backoff
plus 0–200 ms jitter. Recognised network, timeout, rate-limit and server failures,
and otherwise unclassified nonzero exits, may retry. Known missing/path,
authentication/permission, configuration/start, interruption, integrity and
resource-limit failures stop. Exit codes 2 (syntax/usage), 6 (NoRetry) and 9 (no
files transferred) stop regardless of transient-looking stderr. Exit code 1
retains bounded retries unless a permanent-error diagnostic applies.
Successful transfer bytes still have to pass every existing source-identity,
stability and data-validation gate; those failures never
enter the transport retry loop. Failed-attempt buffers are discarded.

Every subprocess attempt counts against the read-command budget. All stdout
bytes, including failed-attempt bytes, count against source and Parquet/metadata
byte totals. Attempt time and backoff count in read wall time and the invocation
deadline; budgets are rechecked before sleeping and before each attempt. Dropbox
reads/retries remain outside the brief currentness locks, with no source fallback.
Progress prints every 15 seconds while the event loop can run. Exact Dropbox API
requests remain `null` because rclone may perform extra metadata/auth requests.
CPU metrics cover Node, excluding child-rclone CPU; decode time includes row
validation/binding work.

`report.metrics.transport_retry_attempts` counts additional attempts beyond the
first. `transport_retry_objects_recovered` counts distinct keys with a successful
transfer after retry, and `transport_retry_objects_exhausted` counts distinct keys
whose third attempt failed. First-attempt successes do not
increment either object counter. Recovery describes transport only, never source
validation or candidate eligibility. A budget stop, or a permanent failure before
the third attempt, is not retry exhaustion. `transport_failure_counts` records
failed attempts by fixed sanitised category. Errors retain only category,
attempt count and the safe relative source
key. Stderr is scanned internally in windows of at most 8 KiB and never logged,
persisted or attached to reported errors.

Daily AQI batches reuse the existing `calculateMonthAqi()`,
`buildCalculatedHistory()` and `lib/aqi/aqi_levels.mjs`. Algorithm identity is
`aqilevels_hourly_v2`, with the imported PM window/minimum constants (24/18).
The shared implementation owns NO2 hourly DAQI, PM rolling DAQI, hourly EAQI,
invalid/missing inputs, independent index statuses and `(n-1h,n]` intervals.
Raw observations retain `S <= observed_at_utc < E`. Derived AQI endpoints are
exactly `S < n <= E`: each reporting day owns 01:00 through the following 00:00.
September 2026 therefore owns 720 unique endpoints from 1 September 01:00 through
1 October 00:00. The adapter now passes `D` and `nextD` to the shared calculator;
previously it passed both bounds minus one hour and produced the displaced
`[S,E)` endpoint set. AQI `output_start_utc` is the represented start boundary `S`,
and `output_end_utc` is the included endpoint `E`. Each daily descriptor adds
`output_end_utc`, `first_endpoint_utc` and `last_endpoint_utc`. Its existing
`output_end_exclusive_utc` remains the calendar work-unit boundary, not the AQI
endpoint-membership rule. Requested raw range fields retain their existing meaning.

The prior UTC day supplies PM rolling context, including June for July when
authenticated by the selected backup. NO2 has no predecessor dependency. All three
pollutants independently authenticate the source day containing `E` under the
same original checkpoint. The existing root/year/month and copied-day proof,
day/connector/pollutant membership, every referenced Parquet SHA/size/schema/count,
physical binding and verification/status checks apply to this dependency too.
Whole admitted source objects are decoded/accounted for, including other physical
timeseries; only rows exactly at `E` are retained from the terminal day for
calculation. They never enter the raw observation candidate. No timestamps,
canonical partitions, source hashes or measurements are changed.

The supported conservative boundary proof requires authenticated terminal-day
membership with checkpoint `copied_at` at or after the end of that timestamp-day.
Once that proof is established, authenticated connector/pollutant omission or no
measurement at `E` can produce a normal evaluated blank. A missing day, a failed
manifest read, or a copy made before the timestamp-day closed cannot prove absence.
There is no new partial-day or exact-midnight authority. Such a dependency is
`pending_terminal_source_authority`, keeps the pair incomplete and omits `COMPLETE`.
This is an implementation limitation, not a semantic extra-day delay: the
represented period is eligible for finalisation at `E`, including for an explicit
partial-month cutoff, but source completeness still requires accepted proof.

Terminal source evidence and object roles are separate from raw days and PM
context in source evidence, calculation dependencies and completed-period reports.
Original terminal metadata/cache bytes and source Parquet are revalidated outside
the locks. Both locked callbacks compare bounded canonical metadata only; Dropbox
reads, Parquet decoding and the existing retry/backoff remain outside the locks.

Shared AQI may merge samples/calculate hourly means as its algorithm requires;
these operations never alter raw observation candidates. Conflicting duplicate
values or unresolved null station identity may make that shared path reject input.
Raw data remains intact, paired AQI is incomplete, exit is nonzero and no success
marker is written. Natural missing/insufficient-sample endpoints remain normal
evaluated outcomes. Per-index availability and evaluation completeness are separate
from source completeness. Unreadable/missing source context is never a natural gap.

## Candidate formats and expected output

New directories use mode 0700 and files 0600. Expected layout:

```text
report.json
COMPLETE.json                           # only complete local generation
candidate-manifest.<sha256>.json         # after final source stability check
evidence/source/<sha256>.json            # exact consumed source metadata bytes
evidence/source-evidence.<sha256>.json    # checkpoint/chain/pack/status/dependencies
candidates/managed/jsongen/v1/publications/
  connector_id=N/timeseries_id=N/station_id=N/pollutant=CODE/month_utc=YYYY-MM/UUID/
    observations.<compressed-sha256>.json.gz
    aqi.<compressed-sha256>.json.gz
    candidate.<sha256>.json
```

Each pair shares UUIDv4 proposed pubID, identity, pollutant, month, checkpoint,
canonical evidence and calculation dependencies. Existing managed path helpers
supply **proposed** future keys under local `candidates/` staging. No UUID is
selected in control and nothing is uploaded. Descriptors record raw JSON and
compressed SHA-256/size, counts, partial coverage and independent completeness.
Canonical JSON/level-9 gzip are deterministic for the same input/pubID/runtime;
gzip is round-tripped and written files read back. New invocations get new UUIDs,
so complete outputs are not promised byte-identical across proposed pubIDs or
Node/zlib versions.

Bootstrap `schema_version:1` formats are deliberately distinct from managed schemas:

- `uk_aq_jsongen_bootstrap_observations_candidate`: common pins/coverage, physical
  schemas, completeness, `row_columns` and raw tuples: timestamp, value, nullable
  physical station, genuine source status or null, effective status, embedded
  verification status and per-row source-status provenance. Multiplicity is kept.
- `uk_aq_jsongen_bootstrap_aqi_candidate`: identical common pins, algorithm/context,
  daily batches, exact endpoint/period/spacing/uniqueness and daily-ownership
  evidence, terminal dependency, independent DAQI/EAQI completeness/availability and the shared
  station-history `aqi` response with per-hour statuses/missing reasons.
  `terminal_source_inputs` retains original exact-`E` observations with physical
  identity, status and verification provenance as calculation-only dependencies.
- `uk_aq_jsongen_bootstrap_monthly_pair_candidate`: common pins, paired object
  descriptors, proposed keys and explicit unresolved managed authority. Additive
  `raw_observation_candidate_complete` and `derived_aqi_candidate_complete` fields
  separate raw-month authority from terminal/PM-dependent AQI authority. An
  unchanged authenticated raw candidate can remain complete when the derived
  candidate fails terminal currentness; the pair remains incomplete.
- `uk_aq_jsongen_dropbox_bootstrap_candidate_manifest`: all local pair descriptors,
  source completeness and AQI completeness. Never insert it into managed control.

`report.json` records requested/completed periods, selected/discovered identities,
successful/incomplete scopes, observation/AQI counts, exact source object hashes/
sizes, bytes/commands, read/decode CPU/wall, AQI time, JSON/gzip time/sizes, errors,
bounds and manual-review eligibility. Managed publication eligibility is always
false. Reports distinguish authenticated membership/absence from natural
measurement gaps and include PM-context accounting. Per-scope initial/final
hashes and canonical hierarchy references explain currentness. Missing source
coverage cannot produce a successful report. Diagnostic
report/reference lists and completion marker are outside the generated-product
byte cap; reference counts are bounded by object/series/range limits.

## Failure, restart and rollback

`COMPLETE.json` is written only when every requested local candidate passes
original source-proof, selected month/day, applicable PM context, terminal source,
exact hourly endpoint grid/canonical periods/daily ownership, AQI response
and initial/final currentness checks. It proves local private readiness and
report/candidate-chain integrity only; it does not grant managed-publication
eligibility. A failed month or PM dependency leaves its products as diagnostics
and does not discard independently complete month pairs. The invocation still
omits `COMPLETE.json` and exits 2. Exit 2
means failed/incomplete generation;
exit 1 covers admission/unhandled local errors. Missing `COMPLETE.json` always
means incomplete, including kill/power loss. Validate its report digest and final
manifest chain; a pair descriptor alone is insufficient. Reports are written on
controlled source/time/output failures and preserve prior successful scopes while
marking the invocation unsuccessful.

No resume/append/overwrite is allowed. Restart with reviewed pins into a new
directory. Partial private files remain unselected. A hard kill can leave the
bounded `work/source-cache`; preserve useful evidence then delete only that exact
unselected invocation if desired. Rollback is to stop invoking the tool/remove
private output. There are no deployed changes to undo.

The directly coupled experimental paired publisher now validates `(S,E]`, exact
canonical periods and daily ownership, and accepts evaluated
`missing_input/no_input_value` and
`insufficient_samples/insufficient_rolling_24h_hours` independently of availability.
It also requires matching terminal-day evidence. Bootstrap v1 candidates remain
distinct from that pilot's schemas and cannot be passed to its publisher. The old
R2 comparison extractor has no terminal-day acquisition path; its AQI result now
fails completeness at that boundary and paired publication preflight rejects it.
Extending that separate source transport is outside this Dropbox correction.
No existing immutable object or selected publication is rewritten.

No public/managed schema, receipt, control or selector meaning changes here.
Existing private candidates are not repaired in place; regenerate under new UUIDs
after review/merge and separate operator authorisation. Future managed
receipt/affected-month terminal dependencies still need their separately approved
version/compatibility decision; this implementation does not supply it.

## Post-merge private TEST acceptance handover

After separate operator authorisation, freshly re-pin the selected checkpoint and
run September 2026 connector-1 NO2 timeseries 525 (station 1358), PM2.5 timeseries
212 and 324, and PM10 timeseries 6 in bounded private operations. Use the existing
reviewed command forms and verification-mode admission; this README does not
authorise an invocation. Inspect each run for:

- Original checkpoint/generation, exact source byte hashes and selected-source
  stability evidence; separately authenticated 1 October terminal source day.
- Matching initial/final raw-month and terminal-day currentness; PM predecessor
  context retained, with no artificial NO2 predecessor scope.
- Exactly 720 unique endpoints, 1 September 01:00 through 1 October 00:00;
  zero missing/extra/duplicate endpoints, canonical hourly periods and 30 daily
  batches of 24, with midnight owned by the preceding reporting day.
- Raw September tuple/value/timestamp/status/multiplicity fidelity, preserving
  negative values and excluding terminal-only observations; independent evaluated
  completeness and available/unavailable DAQI/EAQI counts. Previous displaced
  output counts (including NO2 679/41) are not expected-value assertions.
- Candidate gzip/JSON/descriptor/manifest hashes and `COMPLETE.json` report digest;
  no incomplete scope or unsupported source-completeness claim.
- Source/row/read-command/memory/CPU/wall budgets and transport retry metrics.
  A normal first-attempt read does not prove retry recovery was exercised.

These checks establish only private bootstrap evidence. Managed publication,
writer freshness/Core/transition acceptance and website serving remain separate.

## Later months and separate first-run authorisation

Use `--month-utc YYYY-MM` to explicitly request a full calendar month, or the
partial-month cutoff form described above. Existing start/end range mode remains
for partial historical reconstruction. Dates are not
hard-coded. The same pin
can supply June context for July only when its chain authenticates those scopes.
Never fill missing dependencies from R2. One invocation reuses cached files at
month boundaries; separate batches have independent staging/UUIDs, and later
combination/promotion needs review.

Before the first real TEST run, authorise exact connector/series/pollutants/dates,
checkpoint byte/root pins, accepted verification modes, private output and bounds.
Confirm existing Dropbox credentials, available disk/memory and source usability.
Keep Integrity stopped under the operator's stated arrangement; this tool does not
control Integrity. Real TEST acceptance must then establish format/auth compatibility,
observation fidelity, empty/partial scope behaviour, context/AQI results and measured
performance from that operation's evidence. Development structural checks establish
only code readiness. No broad functional suite/backfill was performed. Derived-R2
publication, managed baseline acceptance and chart serving remain separate decisions.

## ChatGPT system-doc handover

Separately record this manual local-only Dropbox bootstrap in the routed JSONgen
bootstrap/manual-rebuild documentation. Cover version-1 candidates/evidence, real
generation-v3 pack path, canonical whole-file authentication, month units/bounds,
partial coverage, independent completeness, operator transition prerequisite,
scoped currentness proof and unresolved managed authority. Link implementation
files and the code PR. No schema
migration, persistent environment catalogue update, scheduler or deployment is
needed. Preserve missing writer/gate/receipt/managed-context authority and the
disabled managed selector. Add real TEST acceptance only after the separate
authorised operation, with its exact report. Authoritative docs/plans were not edited.
