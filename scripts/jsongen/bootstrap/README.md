# Manual TEST Dropbox historical bootstrap

This manually invoked tool produces **local/private observation/AQI candidates**.
It has no workflow, scheduler, uploader, managed selection or chart integration.
Imports are inert. The first real TEST operation requires separate authorisation
after code review. Development did not run a backfill or fetch Dropbox history.

Authoritative TEST system-docs were read at `main`
`bbc09c2da361136bf1dcbdea077f07014f84b668`, following the JSONgen, compressed-history,
precomputed-AQI, canonical observation hierarchy/schema/generation, verification,
station-history AQI and Dropbox checkpoint/pack routes. No authoritative docs or
plans were edited. This README describes implementation, not a replacement contract.

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

Generic connector support grants no public publication permission. Explicitly
review connector/physical-series/pollutant selection before operation. Other
networks, including Sensor.Community, must not be promoted by inference. Logical
continuity families are rejected in this physical-only version, rather than
silently combined or relabelled. Supported canonical physical authority is
schema 3/4; older schema-2 authority is rejected.

## Existing configuration and checkpoint pins

Use Node >=20, the repository's existing dependencies, and rclone. Reuse the
backup's `uk_aq_dropbox` remote, Dropbox application authentication and existing
`RCLONE_CONFIG`. No second OAuth client, credential discovery or explicit token
refresh implementation is added. Normal rclone refresh may update its existing
**local** config. `UK_AQ_R2_HISTORY_BACKUP_RCLONE_BIN` retains its existing meaning.
No new persistent environment variables/catalogue entries are introduced.

The only transport operation is exact `rclone cat` below the fixed source:

```text
uk_aq_dropbox:TEST/R2_history_backup
```

This is the workflow's `TEST/R2_history_backup` under the authorised application
root (`/Apps/github-uk-air-quality-networks/TEST/R2_history_backup/` in Dropbox UI).
There is no local Mac path or arbitrary remote, LIST, upload, deletion, restore,
database operation or R2 read/write. Existing auth/config was inspected in code;
real credentials and permissions were not exercised during development.

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

## Proposed seven-day command — do not execute during code review

Run from TEST ops only after separate authorisation. Set these local shell inputs
from reviewed operational evidence; they are not new repository environment keys:

```sh
# bootstrap_checkpoint_sha256=<exact completed root.json byte SHA-256>
# bootstrap_verification_modes=1=overlay_accepted
#   or 1=pre_overlay_accepted ONLY if established by accepted transition evidence
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

The existing `RCLONE_CONFIG`/remote must be available in the shell. No R2 or DB
credentials are needed. To narrow the first operation, add `--timeseries-ids 212`
and select only its authorised pollutant (`--pollutants pm25`). That is a separate,
smaller scope, not acceptance of every connector-1 series.

The command reads 5 October as hidden context and exposes observations only in
`[6 October 00:00, 13 October 00:00)` UTC. It explicitly claims no reconstruction
for 1–5 or 13–31 October. Measurements retain timestamps, binary64 precision,
negatives, nullable station IDs and multiplicity. Existing canonical JSON uses
round-trip numbers (canonical negative zero serialises as zero). Measurements
are never rounded, averaged, interpolated or deduplicated.

## Bounded processing and AQI

Whole UTC days are accepted. Ranges split at month boundaries and process one
connector/pollutant/month in memory. Each Parquet is decoded once for all selected
physical series. SHA-pinned local disk cache avoids repeat Dropbox downloads for
adjacent-month context/multiple series. Total source-byte budget bounds cache disk;
controlled completion/failure removes it. One binding range is cached in memory.

`--help` lists defaults and hard maxima for days, series across the invocation,
selected rows per month unit including context, decoded rows, rows/bytes per file,
metadata bytes per object, total source bytes, objects, read commands, output bytes
and wall time. Exceeding any bound fails; no selected source data is truncated.
Memory includes one decoded file, the month's rows, a binding range and JSON/gzip
buffers; the proposed Node heap cap adds a process guard. Use smaller explicit
series batches when needed. Limits are protective, not measured throughput claims.

Dropbox subprocesses have a 45-second deadline, bounded by the invocation's
remaining time, 15-second connect/30-second idle limits and one rclone attempt/
low-level retry setting. Progress prints every 15 seconds while the event loop
can run. Network bytes include context and metadata rechecks. Read commands are
counted; exact Dropbox API requests are `null` because rclone may perform extra
metadata/auth requests. CPU metrics cover Node, excluding child-rclone CPU;
decode time includes row validation/binding work.

Daily AQI batches reuse the existing `calculateMonthAqi()`,
`buildCalculatedHistory()` and `lib/aqi/aqi_levels.mjs`. Algorithm identity is
`aqilevels_hourly_v2`, with the imported PM window/minimum constants (24/18).
The shared implementation owns NO2 hourly DAQI, PM rolling DAQI, hourly EAQI,
invalid/missing inputs, independent index statuses and `(n-1h,n]` intervals.
Visible endpoints lie in the requested half-open range. The prior UTC day covers
the preceding partial hour plus 23-hour PM context, including June for July when
authenticated by the selected backup. Context is never duplicated as visible rows.

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
  daily batches, independent DAQI/EAQI completeness/availability and the shared
  station-history `aqi` response with per-hour statuses/missing reasons.
- `uk_aq_jsongen_bootstrap_monthly_pair_candidate`: common pins, paired object
  descriptors, proposed keys and explicit unresolved managed authority.
- `uk_aq_jsongen_dropbox_bootstrap_candidate_manifest`: all local pair descriptors,
  source completeness and AQI completeness. Never insert it into managed control.

`report.json` records requested/completed periods, selected/discovered identities,
successful/incomplete scopes, observation/AQI counts, exact source object hashes/
sizes, bytes/commands, read/decode CPU/wall, AQI time, JSON/gzip time/sizes, errors,
bounds and manual-review eligibility. Managed publication eligibility is always
false. Missing source coverage cannot produce a successful report. Diagnostic
report/reference lists and completion marker are outside the generated-product
byte cap; reference counts are bounded by object/series/range limits.

## Failure, restart and rollback

Exit 0 plus `COMPLETE.json` means complete local generation suitable for manual
review, **not operational acceptance**. Exit 2 means failed/incomplete generation;
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

## Later months and separate first-run authorisation

July/August/September are full-month requests when start/end are adjacent first-day
UTC midnights. October may stay partial. Dates are not hard-coded. The same pin
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
partial coverage, independent completeness, operator transition prerequisite and
unknown current authority. Link implementation files and the code PR. No schema
migration, persistent environment catalogue update, scheduler or deployment is
needed. Preserve missing writer/gate/receipt/managed-context authority and the
disabled managed selector. Add real TEST acceptance only after the separate
authorised operation, with its exact report. Authoritative docs/plans were not edited.
