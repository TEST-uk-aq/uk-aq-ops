# AURN Prune v3 writer handover

Implementation handover, 18 October 2026. Authoritative rules remain in the TEST
system-docs [quick reference](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/main/system_docs/station_charts/jsongen_prune_verification_handover_quick_reference.md)
and its linked contracts. This document describes repository code, not deployment
or real TEST acceptance. The operator reports the Actions pending-source flag is
already true and Prune scheduling paused. Neither setting is changed here.

The later [original-authority amendment](prune-original-authority-handover.md)
adds separately retained pre-PUT admitted absence and selected-v3 Core-owned
binding closure to a versioned extension of the same schema-1 final envelope.
It supersedes the earlier missing-before/binding capture boundary for eligible
new first-publication events only. Legacy/incomplete events remain blocked;
PR #112 still needs its independent extension decoder before receipt creation.

## Capacity and complete source

A physical scope is `(connector_id, timeseries_id, station_id, pollutant_code,
day_utc)`, containing every original observation and duplicate for that identity.
An hourly observation is a row, not a scope.

The existing reported bootstrap evidence comprises 433 paired **physical monthly
candidates** over seven days: 153 NO2, 134 PM10 and 146 PM2.5. The bootstrap code
groups by physical timeseries within connector/pollutant/month, including context.
Thus **433 is a conservative daily upper bound for that observed three-pollutant
population**, not a measured maximum on any individual day, and not 433/7 scopes
per day. The 71,704 visible observations are consistent with roughly 427 complete
24-hour series-days per day on average; that is a sizing indication, not a proof
excluding duplicates or missing hours. This evidence cannot justify keeping a
128-scope complete-connector source cap.

No current full-AURN daily physical inventory is retained in this workspace.
The historical 8 February ingest AURN register contains 201 distinct sites and no
populated pollutant lists; it cannot establish the number of active physical
timeseries or the maximum across all pollutants. No operational query, Prune,
signer, Dropbox or R2 request was used to fill that gap. Exact whole-AURN daily
maximum and measured metadata/CPU/memory distributions remain real TEST acceptance
items. Do not treat the partial bootstrap as full-connector operational capacity.

The pending connector-day envelope now admits up to **1,024 scopes** separately
from the unchanged Stage 1 receipt/general consumer cap of **128**. This admits
the observed 433-identity population with bounded additional scope capacity,
without expanding any byte, row, request, metadata or deadline limit:

| Boundary | Hard limit / behaviour |
| --- | --- |
| Complete pending source | 1,024 physical scopes, 100,000 rows including duplicates |
| Exact original / compressed source | 32 MiB NDJSON / 8 MiB gzip; existing signer and SQL caps agree |
| Reproducible source description | 1 MiB before signing |
| Original JSON metadata capture | 8 MiB raw, 4,096 objects, 1 MiB per object |
| Retained final evidence | 1 MiB total, including source membership and base64 metadata |
| Post-commit message | 4,096 bytes |
| Optional preparation + signer + PUT | Existing 15-second deadline and canonical headroom admission |
| General consumer budget | Unchanged 128 scopes, 200,000 total rows, 64 MiB total byte accounting |

For sizing only, 1,024 scopes at 24 hourly rows each is 24,576 rows. There is no
one-row-per-hour assumption in validation: duplicates count toward the separate
100,000-row ceiling, and actual byte sizes are checked. Source file size is
checked before loading; a known over-limit expected row count fails before file
loading. Complete source identity is checked before signing. No row, pollutant
or physical scope is dropped to satisfy a limit. Unsupported larger days fail
the whole OPTIONAL handover with `resource_limit` and a bounded capacity reason;
canonical Prune continues. Later consumers must account for the larger pending
source and, where necessary, form multiple independently authenticated complete
physical-scope receipts within the existing 128-scope receipt bound. They must
not truncate the connector-day source or its evidence.

Original metadata missing/overflow still yields `not_captured` and null final
bytea. It cannot be rescued by trimming metadata or a second canonical scan.
The 8 MiB capture cap is not a peak-process-memory measurement: Buffers, canonical
rows, encoded metadata and serialization coexist. No claim of accepted maximum
throughput or real 15-second performance is made by these structural caps.

## Original finalisation and COMMIT seam

`writeFrozenCandidateObservationsToV2` retains its normal frozen replay, prior
authority admission, canonical publisher and source cleanup. Its optional path
and `uploadPrunePendingSource` both guard the reviewed TEST connector list `[1]`.
The list is an implementation admission rule mirroring the existing signer,
not a new environment setting or permission to expand that signer. There is no
pollutant filter: all frozen AURN source rows must fit together.

`finalizePublishedPhaseBConnectors` first runs the existing selected-v3 batch
finaliser and `validatePhaseBV3RunFinalizationResult`. Only then does it prepare
original evidence from writer-produced and already verified metadata. The final
envelope retains the complete reproducible source description, including physical
scope membership, per-pollutant content hashes/counts/status, original and gzip
byte identities and immutable pending reference. It checks both source evidence
digests and the frozen source identity that will be presented to the original
gate. Existing P/R/null values are preserved. The compact source still has no
authenticated raw provider status: `original_source_status_unavailable` is honest
provenance, not a provider null or an invented P/R value.

The exact protected sequence in `markCandidateAndConnectorGateComplete` is:

1. BEGIN on the retained original PostgreSQL client.
2. Update exactly the intended in-progress original candidate to READY and update
   its connector/day gate; validate the database-returned matching run, source,
   manifest, counts and completion identity.
3. SAVEPOINT around only `insert_prune_jsongen_gate_acceptance(...)`. The existing
   Schema PR #11 function captures database-returned identities with the same-XID
   guard. Retain complete final bytes only when capture fits.
4. Release the optional savepoint, or safely recover a supported evidence-only
   error with ROLLBACK TO SAVEPOINT and RELEASE.
5. Await `client.query('commit')` and require returned `command === 'COMMIT'`.
6. Only after that acknowledgement, prepare the small deterministic reference
   when this call retained its immutable outbox row.

An exception, lost acknowledgement or PostgreSQL `ROLLBACK` command cannot return
successful handover. Original gate state is reported `unconfirmed` at an uncertain
COMMIT. A row might actually have committed despite lost acknowledgement; later
authenticated discovery can find that original row, without the writer adopting
another attempt or claiming success. Post-commit projection/logging failure is
optional and cannot turn a confirmed gate into a failed gate.

No additional canonical R2 GET, Parquet read, observation comparison, verification
cycle, gate, network operation inside the transaction, lock or runtime reserve is
introduced. Prune remains the sole canonical observation verifier.

## Version-1 reference and replay

`preparePrunePostCommitHandover(acceptance)` in `prune-outbox.mjs` projects an
original committed row into canonical JSON. It returns the message, exact SHA-256
and size, `state=reference_prepared`, and `delivery_state=not_attempted`. Its stable
digest can be used for idempotent delivery later. It validates shape but does not
authenticate a caller or independently prove the pending upload.

The message names:

- TEST / selected v3 / original writer Git SHA, invocation and attempt;
- the existing immutable relation and its complete primary key
  `(environment, writer_identity, run_id, attempt_id, day_utc, connector_id)`;
- original gate completion time and READY-at-acceptance marker;
- frozen source identity and original connector manifest semantic/byte identity;
- pending disposition, signer intent and exact immutable private object;
- retained final-evidence state, digest and byte size;
- `ready_for_independent_authentication`, `incomplete_pending_source`, or
  `incomplete_original_evidence` readiness, always with authority requiring
  independent authentication.

The marker describes the immutable original acceptance, not a requirement that
the mutable current candidate remain READY. Later CONSUMED or Integrity replacement
does not rewrite this evidence and is not a reason to substitute a new attempt.

There is no existing final-evidence notification endpoint matching this authority:
the signer only supports upload intent admission. **No notification is delivered
by this implementation.** The original PostgreSQL outbox is the only durable
source of truth. A process crash between COMMIT and reference preparation/logging
loses no committed original event. Future authenticated discovery reconstructs
the same reference from the row using `preparePrunePostCommitHandover`, projecting
`octet_length(final_evidence_bytes) AS final_evidence_byte_size` in addition to the
typed columns and generated `final_evidence_sha256`. Reference timestamps normalize
to UTC milliseconds; the database retains its full original timestamp precision.

The later reader must use its own authenticated, reviewed, private SELECT authority.
The schema already grants SELECT separately from its restricted insert function;
no new public RPC or shared writer credential is introduced here. Fetch exact bytes
by the complete primary key, check their stored digest/size, and authenticate
source/evidence identity. For discovery, use the existing indexed tuple
`(accepted_at, run_id, attempt_id, day_utc, connector_id)` with bounded pages (for
example LIMIT 100), TEST/writer filtering and deterministic ordering. Select row
descriptors first; load final bytea by primary key within its 1 MiB cap.

`accepted_at` is insertion time, not commit order or canonical precedence. A single
ever-increasing high-water cursor can miss a transaction committed late with an
older insertion time. A later consumer must deduplicate original primary keys,
replay overlapping pages and periodically resweep retained events; it cannot use
a timestamp as finality or remove unresolved events solely by age. Discovery of
rows, receipt lifecycle, authentication and delivery retry remain consumer work,
not an activated scheduler in this change.

## Diagnostics and failure/recovery

`phase_b_jsongen_pending_source_outcome` reports whether the optional operation was
attempted, signer intent was accepted/rejected/ambiguous/invalid, and PUT was
unattempted/acknowledged/rejected/ambiguous. Disallowed connectors log
`connector_not_allowed` and continue canonical processing. Insufficient headroom,
signer configuration, transport, capacity and deadline failures have reason codes.
No credentials or presigned URL are logged.

`phase_b_jsongen_handover_outcome` distinguishes original v3 finalisation,
original gate state, outbox insertion, metadata completeness, prepared reference
digest/acceptance key, delivery `not_attempted`, and readiness for later independent
authentication. It also reports failed/uncertain canonical finalisation or gate
without a success reference. Existing summary counters are supplemented with
prepared-reference, authentication-ready and incomplete-handover counts.

| Outcome | Canonical Prune / later handover |
| --- | --- |
| Signing/PUT fails, source exceeds caps | Canonical path continues; missing or ambiguous pending coverage remains explicit |
| Required v3 finalisation fails | Original gate and successful handover unavailable |
| Candidate/gate identity fails | Mandatory rollback/failure; no handover success |
| Supported evidence-only insert error | Recover savepoint; valid gate may commit; `outbox_missing` |
| Duplicate immutable event | Never UPSERT/adopt; `outbox_unresolved`, independently compare retained event later |
| Unsafe connection/transaction/savepoint failure | Original gate fails closed |
| Metadata absent/oversized | Optional gate-only event may commit; `not_captured`, incomplete handover |
| COMMIT ambiguous | No successful reference; discover any actually committed original row independently |
| COMMIT succeeds, reference preparation/logging fails | Canonical gate remains complete; durable original outbox remains replayable |
| Complete event and source acknowledged | Reference prepared, ready for later authentication; delivery not attempted, no VERIFIED receipt |

An absent event is not recoverable from this outbox. Do not invent original proof
from mutable gates or promise metadata can reconstruct missing source rows after
cleanup. Original gate-only recovery remains disabled; exceptional recovery or
bootstrap needs separate authorisation. Private 412/ambiguous uploads need later
independent readback and authentication; they are never treated as acknowledged
or overwritten by this writer.

## Remaining work and system-doc handover

No schema, migration, environment name/value, signer configuration, dependency,
deployment, scheduler or LIVE change is required. Schema PR #11 already supports
this envelope and replay projection. Its actual deployment/login trust and real
gate acceptance remain operational prerequisites, not established by code.

ChatGPT in Chat mode should record the writer interface, capacity boundaries,
full retained source membership, explicit COMMIT seam and replay behaviour in
the owning system contracts after review. Keep implementation and operational
acceptance separate; no authoritative `system_docs/` file was edited here.

The later independently authenticated consumer must confirm the **private** pending
gzip's exact bytes, authenticate the immutable original acceptance and retained
original metadata/source/status/physical membership/finalisation, and resolve
bounded current canonical metadata/status/binding authority. It must not repeat
canonical observation/Parquet verification or rerun Prune. Then implement VERIFIED
receipt durability, discovery/missing-event reconciliation and any delivery retry.
Monthly observation/AQI generation, publication/CAS, chart serving, triggers and
`selectManagedPublications()` remain inactive and out of this writer boundary.

## Structural validation record

Local Node v24.19.0; eight changed JavaScript modules passed `node --check`.
Capacity/admission/deadline assertions passed; all six dated source snapshots
matched the exact pre-change `origin/main` bytes; `git diff --check` passed.

Focused existing deterministic checks (mocked adapters only):

```sh
UK_AQ_R2_HISTORY_VERSION=v3 node --test --test-isolation=none --test-reporter=tap \
  --test-name-pattern='(optional Prune outbox|optional evidence constraint|duplicate immutable event|candidate mismatch|unrecoverable outbox|default-off Prune|lost or ROLLBACK|Phase B accepts the real v3|default-off v3|Phase B v3 finalization validation)' \
  tests/uk_aq_prune_history_gate.test.mjs

node --test --test-isolation=none --test-reporter=tap \
  --test-name-pattern='(pre-commit final preparation|mismatched signer metadata)' \
  tests/jsongen_prune_pending_source.test.mjs

node --test --test-isolation=none --test-reporter=tap \
  --test-name-pattern='(candidate and connector gate completion persist|default-off Prune completion)' \
  tests/uk_aq_prune_history_gate.test.mjs
```

Results respectively: **20/20**, **2/2**, **2/2** passed; zero failures,
cancellations or reported skips. Other tests were excluded by the targeted name
filters. `--test-isolation=none` was necessary for this local Node runtime to
apply the nested-test filter and expose individual results. An earlier direct
diagnostic invocation ran all ten pending-source checks successfully and exposed
the gate file's already-existing assertion that a valid `history/v3` day manifest
must be rejected. That unchanged assertion is outside these focused checks;
the whole gate file is not claimed green. Mock COMMIT responses in the affected
transaction checks were updated to the actual PostgreSQL command shape.

No complete suite or operational validation was run, following this task's
explicit targeted-validation boundary. No real database, signer, R2 or Prune
operation occurred. Real TEST acceptance after separately authorised deployment
must establish source/metadata sizes, runtime/memory, actual login privileges,
COMMIT/outbox durability and eventual independent consumer authentication.
