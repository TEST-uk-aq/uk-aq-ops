# Stage 3D Phase 1: private Prune registration coverage

Implementation handover, 30 October 2026. Code only in TEST Ops. Read the
authoritative [Prune handover](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/main/system_docs/station_charts/jsongen_prune_verification_handover_quick_reference.md)
and [verified-writer contract](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/main/system_docs/station_charts/compressed_history_json_verified_writer_regeneration_contract.md).
This file authorises no operation, deployment, scheduling change or publication.

## Implemented boundary

`reconcile-cli.mjs --execute-read-only --prune-registration` is a distinct manual
registration diagnostic. Ordinary Stage 3C and reconciliation reports 1–4 keep
their meanings. The new private report has kind
`uk_aq_jsongen_prune_registration_diagnostic`, `schema_version=1`, and its own
validator/artifact serializer. Old report-retention/control-writing functions
reject this separate format.

The path reuses restricted PostgreSQL discovery and primary-key replay, original
gate/PENDING/evidence authentication, complete original physical scope/status/
binding checks, selected coverage and deterministic receipt builders, immutable
readers and managed-control reader. No parallel source authentication, canonical
Parquet verification, current canonical metadata reads, listing, timestamp/arrival
ordering or count-only matching is added.

One exact strong-ETag control read is pinned before discovery. The report records
its byte hash/length, control/revision/operation identity and registered change IDs.
A local `REPORT.control.json` companion preserves those exact bytes, including
the event map; it is not a later R2 read. Registration requires the independently
reconstructed descriptor, authority, summary, entire ordered receipt-reference
group and exact receipt bodies/refs. Conflicting/unexpected same-event entries
require reconciliation. Missing/invalid/unreadable control is never an invented
empty revision.

Every returned event gets a result, including unavailable originals or over-limit
groups. Original authentication covers all original pollutants/scopes. Original,
selected and unsupported counts/digests, pending/evidence references and original
per-pollutant source-as-of metadata are retained. Expected selected partitions
record exact receipt/bundle references, whole physical scope keys, rows, source
metadata and separate registration/receipt-retention/bundle-retention states.
Unsupported observation bodies are not copied. Zero-selected events require the
authenticated descriptor and empty group, without dummy receipts or bundles.

Existing schema-2 events keep their original group identity. For wholly supported
originals without a selected control event, exact legacy receipt GETs also detect
partial/unregistered legacy retention, following the consumer's family rule.
Unavailable legacy probes leave family/group unresolved rather than inventing a
selected-v3 registration gap.
`group_sha256` is the actual chosen family's group digest. The separate coverage
summary retains the selected-policy planning hashes; its v3 planning-group hash
does not replace a legacy schema-2 group's digest. `admitted` counts include
legacy probes and selected scope/reference admissions across the whole page.

| Classification | Meaning within this read interval and pinned control |
| --- | --- |
| `registered_and_retained` | Fresh original authentication, complete exact registration and authenticated retained descriptor/selected objects. |
| `registered_no_selected_scopes` | Authenticated zero-selected event, retained descriptor and registered empty group. |
| `missing_registration` | A complete independently reconstructed required descriptor/member is absent from available exact control. Retention may remain unresolved. |
| `missing_retention` | An authenticated expected object returned HTTP 404 at its exact key. Registration may remain unresolved. |
| `missing_registration_and_retention` | Both positively identified gap types exist. |
| `unknown` | Original/group authority, control, readback, family or resources are unavailable/incomplete. |
| `reconciliation_required` | Rejected/contradictory evidence or conflicting group membership prevents safe classification. |

Per-object states preserve known gaps even when the event has conflicting evidence.
An original-source 404 means incomplete original authority, not missing JSONgen
receipt retention. An object 404 proves absence at the attempted read, not that
it was never retained. Error labels are fixed code-owned values; remote messages,
stacks, SQL, credentials/URLs and raw observations are excluded.
Unavailable restricted-reader access and incomplete original authority have
distinct safe reasons. A caught event failure also records its bounded stage
(outbox read, reference binding, original authentication, group construction,
legacy-family probe or complete-group admission/comparison).

## Bounds and preserved contracts

Discovery remains one caller-selected page, at most seven UTC days / 16 events.
The entire page shares one existing **120-second / 192-MiB original-handover**
budget for control, original authentication, reconstruction and readbacks; it is
not restarted per event. Existing limits remain: 1,024 original scopes / 100,000
rows per source, 128 complete scopes per receipt, 32 inspected receipt references
including legacy probes, 1,024 distinct selected scopes per invocation, 200,000
total charged rows, per-object/decode/metadata-GET caps, 4-MiB control/report.
Ordinary Stage 3C retains its separate 60-second/64-MiB profile and 128 inspected
current scopes. No limit constants change. Charged bytes are not a heap measure.

Over-limit work stays unresolved. If final serialization cannot fit the shared
byte envelope, the CLI rejects without an oversized/truncated report. Narrow the
page/window with a fresh output; never raise caps or reuse another invocation's
authentication. Local files use atomic replacement with mode 0600. The exact
control companion (at most 4 MiB) is written before the report; filesystem failure
can leave a companion alone. Use a fresh private output name per invocation.

Receipt schemas 1/2/3, descriptor v1, control v1/v2, existing reconciliation codecs
and `affected_months` are unchanged. Terminal-midnight managed dependencies still
need a separate version/compatibility decision. No small-head/flat-page proposal,
configuration name, migration, service, adapter, retention policy or workflow is
introduced. `selectManagedPublications()` remains unchanged and disabled.

Every report keeps `state=reconciliation_required`, `writer_coverage=unknown`,
`freshness=unknown`, `complete_change_coverage=false`, `publication_eligible=false`
and `publication_selection=disabled`. No current canonical snapshot is asserted.
The optional AURN outbox can omit valid Prune gates; Integrity v3, SOS-light and
IFW coverage is unresolved. Missing events on a bounded page do not prove event
absence. `accepted_at` is insertion time, not a commit-order watermark. Separate
pages/inspections cannot form one coherent canonical freshness frontier.

## Future operator-controlled read-only TEST procedure

Do not execute during development. After review/merge and **separate explicit
authorisation for the real read-only TEST operation**:

1. Use the reviewed TEST Ops revision and existing approved credentials/config:
   `UK_AQ_ENV_NAME=TEST`, `UK_AQ_GITHUB_REPO=TEST-uk-aq/uk-aq-ops`, `SUPABASE_URL`,
   dedicated `UK_AQ_JSONGEN_PRUNE_READER_DB_URL` with verified TLS/approved CA,
   `UK_AQ_JSONGEN_R2_ENDPOINT`, `UK_AQ_JSONGEN_R2_BUCKET`, and existing
   `UK_AQ_JSONGEN_R2_READ_ACCESS_KEY_ID` / `UK_AQ_JSONGEN_R2_READ_SECRET_ACCESS_KEY`.
   Use locked installed dependencies including `pg`. Do not print/provision
   secrets or inject WRITE access. No canonical R2 credential, migration, Worker
   deployment or Actions invocation is needed.
2. From the repository, run the exact preserved 15 October event's acceptance
   **insertion** window below. Do not rerun Prune or the completed bootstrap pilot.

   ```bash
   umask 077
   mkdir -p work
   PRIVATE_REPORT_DIR=$(mktemp -d work/prune-registration.XXXXXX)
   REPORT="$PRIVATE_REPORT_DIR/prune-15.json"
   if node scripts/jsongen/reconcile-cli.mjs \
     --execute-read-only --prune-registration --discover resweep \
     --from 2026-10-21T14:53:00.000Z --to 2026-10-21T14:55:00.000Z \
     --limit 1 --output "$REPORT" > "$PRIVATE_REPORT_DIR/summary.json"; then
     diagnostic_exit=0
   else
     diagnostic_exit=$?
   fi
   test "$diagnostic_exit" -eq 2
   test -s "$REPORT"
   ```

   Exit 2 is intentional even for a registered original. It is not sufficient
   acceptance evidence: require the report, validator and integrity checks.
3. Verify local report/companion integrity and control relationships without
   another service read:

   ```bash
   node --input-type=module - "$REPORT" "$PRIVATE_REPORT_DIR/summary.json" <<'NODE'
   import fs from 'node:fs';
   import assert from 'node:assert/strict';
   import { sha256Hex } from './workers/shared/r2_sigv4.mjs';
   import { canonicalJson } from './scripts/jsongen/schema.mjs';
   import { assertPruneRegistrationReport } from './scripts/jsongen/prune-registration-report.mjs';
   const [filename, summaryFile] = process.argv.slice(2);
   const body = fs.readFileSync(filename), report = JSON.parse(body);
   const summary = JSON.parse(fs.readFileSync(summaryFile));
   assert.equal(sha256Hex(body), summary.report_sha256);
   assert.equal(body.length, summary.report_byte_size);
   assert.ok(canonicalJson(report).equals(body));
   let controlRead = null;
   if (report.control.state === 'available') {
     const bytes = fs.readFileSync(`${filename}.control.json`);
     assert.equal(bytes.length, report.control.object.byte_size);
     assert.equal(sha256Hex(bytes), report.control.object.sha256);
     controlRead = { body: bytes, control: JSON.parse(bytes),
       sha256: sha256Hex(bytes), etag: report.control.etag };
   }
   assertPruneRegistrationReport(report, { controlRead });
   console.log(JSON.stringify({ integrity: 'passed', control: report.control.state,
     discovery: report.discovery_state, events: report.events.map(e => ({
       event_id: e.event_id, original: e.original, family: e.family,
       classification: e.classification, summary: e.evidence?.summary,
       registration: e.registration, retention: e.retention,
       diagnostic: e.diagnostic, failure_stage: e.failure_stage })) }));
   NODE
   ```

   This is local integrity/relationship validation, not independent reauthentication
   of PostgreSQL/private R2. Preserve report, companion and stdout digest privately.
4. For the previously accepted 15 October event, if authority remains available,
   expect 37 pollutants / 940 original scopes / 22,540 rows; 433 selected scopes /
   10,382 rows; 507 unsupported / 12,158 rows; six partitions. Inspect original
   authentication, descriptor and every exact receipt/bundle reference/state,
   selected source identities and control snapshot. A complete result should be
   `registered_and_retained`; accept actual unknown/rejected evidence honestly
   instead of replacing it with this earlier acceptance. Eligibility stays false.
5. If separately authorised, inspect the 17 October event independently with
   `--from 2026-10-24T22:52:00.000Z --to 2026-10-24T23:23:00.000Z --limit 1`
   and a fresh output. Expected event ID:
   `66ba09a0a04043da0d68cb0cc76b24d0b48570747a469d067713fcbb616c6194`;
   37 pollutants / 919 original scopes / 19,301 rows; 433 selected / 9,496 rows;
   486 unsupported / 9,805 rows; six partitions, if still fully authenticated.
6. For separately approved broader windows, inspect every returned classification
   and per-object state. If `next` is non-null, save that exact object privately
   and pass `--cursor-file` with the same window/mode and a new output path.
   No automatic pagination/acknowledgment or completeness watermark is implied.
   Explicit overlapping windows/historical resweeps remain necessary. Empty pages
   are bounded discovery only; `no_intent`/`not_captured` originals may remain
   unresolved and must not become invented complete groups.
7. Inspect naturally occurring gaps if returned; do not delete objects, alter
   control or manufacture missing records for acceptance. Review charged resource
   usage/limit diagnostics. Repeated approved reads can observe different control
   bytes/intervals. Confirm no writes, retention changes, dispatch, monthly output,
   schedule/selector change or all-writer freshness claim.

## Review, rollback and authoritative-documentation handover

New implementation: `prune-registration.mjs`, `prune-registration-report.mjs`.
Changed implementation: `reconcile-cli.mjs`; exact pre-change original:
`archive/2026-10-30/scripts/jsongen/reconcile-cli.mjs` (reference only).
README and this handover are documentation and have no code-style archives.
Existing authentication, immutable schemas, control, currentness and selector
implementations are unchanged.

Structural checks: Node syntax/inert imports, CLI help, whitespace/diff and exact
archived-original hash checks; one existing deterministic selected-event report
check for selected/zero-selected compatibility. No new fixture programme or
functional suite, PostgreSQL/R2 operation, reconciliation execution, deployment
or operational workflow. These prove structural viability only; real TEST
classifications, timing/size and operational acceptance remain unproved.

Rollback is a reviewed code revert or omission of the new flag. There is no
remote-state rollback/migration/receipt downgrade; preserve local evidence under
existing operator policy. No automatic deletion or retention change is introduced.

ChatGPT in Chat mode should update the authoritative verified-writer contract
and relevant router/quick reference with this bounded diagnostic, separate
private v1 report, exact control companion, states and unchanged source-as-of/
all-writer/publication limits. Record code/structural evidence, **not operational
acceptance** until an authorised run is reviewed. No active immutable-receipt
amendment is needed here. Terminal-midnight compatibility, other writers,
coherent currentness, baselines and monthly publication remain separate gates.
Authoritative system docs were read-only throughout this task.
