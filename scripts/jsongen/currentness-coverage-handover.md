# Stage 3C current canonical metadata and writer coverage

Implementation handover, 18 October 2026. TEST code only. The authoritative
[verification boundary](https://github.com/TEST-uk-aq/uk-aq-system-docs/blob/main/system_docs/station_charts/jsongen_prune_verification_handover_quick_reference.md)
and its current contracts remain authoritative. No `system_docs` were edited.

## Implemented boundary and reuse

`reconcileManagedInputs()` now emits reconciliation schema 2, with a `stage3c`
assessment. It reuses the existing selected-generation descriptor, canonical
manifest hierarchy validators, exact-leaf daily metadata reader, aligned-index
validators, binding root/range validators, continuity validator and status reader.
It reuses the independent private PostgreSQL reader, original Prune handover
authentication, deterministic complete-event receipt group and separate immutable
derived receipt/bundle readbacks. There is no parallel canonical authority tree.

The original event remains historically authentic after metadata drift. The
immutable receipt is never rewritten, removed or demoted. Original PostgreSQL
acceptance stays typed database authority; it is not represented as an R2 object.
Receipt schema 1 and schema 2 and existing complete-scope bundle formats remain
unchanged. Report schema 1 remains supported with its earlier strict validation;
its positive-authentication restrictions are not relaxed. Control/CAS schemas,
registration semantics and the explicit selector blocker remain unchanged.

## Metadata authority and physical comparison

The inspector authenticates the selected **complete-v3** root, year, month, day,
connector and pollutant path, complete child aliases, exact scoped membership,
leaf and aligned shard, canonical file identities/counts and physical schema.
Observation latest/global remains discovery, not an authentication parent.
404s never prove empty physical membership; only a complete linked parent's
missing child or authenticated exact/canonical member sets establish absence.

Selected-v3 bindings require root/range/unit identity, exact physical
connector/timeseries/station/pollutant and continuity, plus matching Core-owned
source-state and refresh-state completion fingerprints/root identity. V2 physical
binding prefixes are rejected; their v2 payload semantics are retained.

Currentness compares a per-physical-scope digest of the authenticated exact leaf's
schema/writer/layout, count, interval, files and ordered segments, plus the exact
physical binding. The digest excludes replaceable parent/aligned-shard references.
An unrelated root/parent/sibling update cannot alone mark the scope replaced.
A changed shared physical file remains conservatively changed even if a future
writer might prove its selected rows unchanged; metadata is not a row rescan.

Current AURN schema-3 effective P/R/null stays bound to original writer evidence
and identical selected physical file authority. Missing future overlay latest
alone does not reject legitimate schema-3 evidence. Its absence is rechecked.
Stage 3C does **not** accept an overlay transition from a mode string, namespace
or pointer. A selected AURN overlay or schema-4 scope remains unresolved: an
independent connector-specific accepted-transition adapter and original/final
overlay writer evidence are still missing. The earlier Stage 2 reader retains
its existing separately accepted-mode API; Stage 3C does not promote that API's
caller strings into new transition authority. Original provider status remains
explicitly unavailable where not retained; no P/R/null value is manufactured.

## Shared source-as-of boundary and bounds

`readCanonicalScopePages()` partitions whole physical scopes at the existing
128-scope inspector cap, accounting for up to 1,024 scopes across the operation.
All pages use one first-read cache and one final recheck of every observed object,
including binding completion and status authority. Observed 404s are separately
rechecked; the root is checked again after the final recheck. No canonical lock
is acquired, and canonical writer ordering is unchanged.

The schema-2 inspection records the selected generation, all exact metadata
references, unavailable metadata keys, physical scope keys, a deterministic
SHA-256 of that boundary, start/end times and explicit consistency limitations.
Drift, disappearing/appearing metadata or exhaustion during recheck invalidates
the entire shared boundary and requires a fresh inspection. Report validation
rejects contradictory scope references, boundary digests or positive coverage.

Identical endpoint reads are **bounded observational evidence**, not a transaction
or proof that no intervening/ABA writer ran. No complete writer-owned freshness
fence exists here. Absolute latest-canonical freshness is never claimed.

The existing whole-operation 256 metadata GET, 64 MiB byte, 200,000 row, 60-second,
32 receipt-reference and 4 MiB report limits remain. Receipt/bundle caps remain
128 scopes each. A 1,024-scope event is completely accounted, not truncated to
128; it need not fit a successful currentness inspection under those caps.
When the GET/deadline/byte budget is exhausted, remaining scopes stay unresolved
and a successful coherent inspection is forbidden. Oversize reports cannot be
retained/output. Bounds are protective, not real full-AURN capacity acceptance.

## Classifications and supersession

`stage3c.scopes[]` separates `original_authentication`, `current_metadata_match`,
`authenticated_supersession`, `writer_coverage`, `registration_coverage`,
`source_as_of`, `freshness`, `reconciliation_state` and `publication_eligible`.
Diagnostics distinguish matching original physical authority, changed metadata
with unknown later writer, missing original authority and unavailable current
scope/status/binding. Canonical per-scope diagnostics retain the precise cause.

A genuine later supersession requires independently authenticated writer final
evidence, a different original event, an exact authenticated before-to-original-
after authority link, and a final scope matching current metadata. Multiple
contradictory candidates stay unresolved. Root changes, timestamps, accepted_at,
control revisions, run order and caller success flags cannot supply that proof.
The present authentic adapter admits only AURN **first publications**; it cannot
prove replacement/removal of an earlier present scope. Thus this stage truthfully
reports those later Integrity/SOS-light/IFW changes as **unproven**, rather than
claiming a new successful replacement adapter. A structured supersession result
does not grant any new writer permission or receipt format.

## Coverage accounting and precise missing contracts

Replaying one schema-2 receipt discovers its whole deterministic original event
group and separately reads every expected immutable receipt/bundle. The report
lists missing retention, missing registration, authenticated retained-but-
unregistered receipts, registered original groups, current scopes without matching
authenticated registered authority and discovered outbox events still awaiting
confirmed consumption. Missing partitions never turn into invented receipts.

Optional bounded private discovery remains one page per invocation, with its
window, continuation and explicit incomplete-coverage/repeat-overlap/resweep state.
`accepted_at` is insertion time; an exhausted page is not an inventory watermark.
Registered group completeness proves only that original connector-day handover.

All-writer coverage and freshness remain `unknown`, with exact writer seam gaps:

- Prune: optional original outbox insertion can fail after valid canonical work;
  it is AURN-only and provides no complete publication inventory or commit fence.
  Missing contract: durable writer-owned inventory covering every applicable
  completed publication, including missing handovers, with an independently
  authenticated scope/source-as-of completeness and freshness fence.
- Integrity/SOS-light: independent complete resolved final-source/status/binding,
  replacement/removal receipt authority and durable complete inventories/fences
  are missing. SQLite, local journals, raw overlays and logs are not replacements.
- IFW: accepted canonical repair publication/handover and equivalent durable
  inventory/fence remain unavailable.
- Accepted overlay transitions and later binding/status publications require
  their actual authority and relevant complete inventory; metadata observation
  alone cannot establish complete receipt coverage for those changes.

The report explicitly bounds known scope keys and the unknown intervening-
publication window, including original gate-completion/inspection timestamps
without promoting them to event order, and leaves outside-selected-scope coverage unassessed.
No numeric cross-writer sequence or new writer acknowledgement is introduced.

## Manual interface and configuration

`reconcile-cli.mjs` is an inert-on-import wrapper of the existing reconciler.
For later separately authorised TEST operation only:

```sh
node scripts/jsongen/reconcile-cli.mjs --execute-read-only \
  --scopes-file work/physical-scopes.json \
  --retained-receipts-file work/retained-references.json \
  --discover resweep --from 2026-10-10T00:00:00.000Z \
  --to 2026-10-11T00:00:00.000Z --limit 4 \
  --output work/currentness-report.json
```

Scope files contain an array of `{identity:{connector_id,timeseries_id,station_id,
pollutant_code},day_utc}`. Receipt files contain immutable receipt descriptors.
Both are optional; all receipts already in the bounded control are inspected.
Discovery and its cursor are optional and never acknowledge processing. The
output is atomically written locally mode 0600; logs expose only counts/codes.
Exit 2 denotes reconciliation required, even when known metadata matches.

Reuse `UK_AQ_ENV_NAME=TEST`, `UK_AQ_R2_HISTORY_VERSION=v3`, existing canonical
`CFLARE_R2_*`/`R2_*` configuration, `UK_AQ_COMPRESSED_CHART_R2_*`, and optional
`UK_AQ_JSONGEN_PRUNE_READER_DB_URL`/`SUPABASE_URL`. Use appropriately restricted
GET-only storage credentials and the existing restricted private reader. No new
configuration key or credential is introduced. An absent real control blocks;
the CLI does not initialize/synthesize control or write any remote object.
The manual interface was **not executed**, including help, during implementation.

## Validation, operational acceptance and next section

Targeted offline checks cover authenticated metadata matching, unrelated root/
aligned-parent changes, unproven later changes, mixed/stale snapshot rejection,
missing Core completion, appearing status metadata, shared partitions, complete
1,024-scope/eight-receipt accounting and explicit retention/registration/resource
gaps. Existing narrowly selected receipt precision/membership, report rejection,
original-byte retention and original PostgreSQL reauthentication checks remain.
These use synthetic adapters, not real SQL/R2 or operational acceptance.

The final bounded run passed **10 checks**: five Stage 3C checks, one existing
original PostgreSQL reauthentication check and four existing precision/membership/
report checks. The 1,024-scope detailed fixture also confirms that the unchanged
4 MiB report cap rejects oversized output instead of omitting scopes. Example
local-only checks (not the manual remote inspection interface):

```sh
node --test --test-isolation=none --test-reporter=tap tests/jsongen_currentness.test.mjs
node --check scripts/jsongen/reconcile-cli.mjs
git diff --check
```

Syntax and diff checks pass. No broad suite, operational metadata/Parquet read,
Prune/Integrity/signer run, migration, real control mutation, dispatch, schedule,
deployment, monthly JSON/AQI output or LIVE operation occurs. Existing dated
archive snapshots were reused without overwrite. The enabled pending-source
flag and operator-reported paused Prune schedule remain untouched.

Later authorised TEST acceptance must apply Schema #12/provision the restricted
reader separately, verify actual TLS/ACL/RLS and GET permissions, and exercise
real original authentication, read-consistent inspection/drift/replay and bounded
capacity. The task adds no operational authorization. Rollback is reverting the
Stage 3C reader/report code; preserve all original receipts, bundles and outbox.

Chat-mode system-doc handover: record schema-2 reconciliation and inspection,
metadata-only scope digest/binding/status checks, source-as-of limitations and
explicit inventory gaps. No receipt, SQL, environment-catalogue or deployment
schema changes are required. Monthly publication remains blocked by unsupported
later-writer/overlay authority, complete inventories/freshness fences, accepted
full-month baselines, adjacent-month PM context, paired generation/readback and
publication CAS/real TEST acceptance. Next implement those writer-owned authority
gaps and authenticated monthly baseline/context prerequisites before paired
monthly generation/selection. `selectManagedPublications()` remains disabled.
