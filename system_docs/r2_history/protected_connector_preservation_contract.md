# Protected connector contract for SOS-light

## Authority and scope

This document defines protected-connector behaviour inside the authoritative [`sos_light_model.md`](sos_light_model.md) contract.

Where earlier protected-preservation wording required Integrity to inspect, preserve or quarantine the existing live R2 graph, the SOS-light model is authoritative.

SOS-light does not preserve the existing live R2 day. It assembles a complete replacement day locally from SOS source and the chosen Dropbox baseline, deletes the existing R2 day, and uploads the assembled result.

## Current protected set

The current protected connector set is:

```text
connector_id=1  UK-AIR SOS
```

The resolved protected set MUST be explicit, deterministic and recorded in run state and reports.

A selected mutation connector MUST be protected. Invalid, absent or explicitly empty protected-connector configuration MUST fail before mutation.

## Meaning of protected

For connector `1`, protected means:

- fresh SOS source evidence is authoritative for selected pollutants;
- every selected source-built pollutant must be complete and reproducible;
- the final connector `1` parent must describe the complete final connector `1` child set in the locally assembled replacement day;
- any unresolved connector `1` source, child, parent or proposal inconsistency is blocking;
- the run must stop before deleting the R2 day when connector `1` is not correct.

The old Dropbox connector `1` parent is not the authority for the complete final child list.

For example:

```text
current run builds pm25, pm10, no2 and o3
-> final connector 1 parent lists pm25, pm10, no2 and o3
```

## Meaning of unprotected

For connectors outside the protected set:

- Dropbox is the only preservation authority;
- existing live R2 is not inspected or compared;
- usable Dropbox content is carried into the assembled replacement day on a best-effort basis;
- unusable or absent Dropbox content produces warnings;
- an unprotected connector problem must not block a valid connector `1` replacement.

SOS-light does not certify unprotected connectors as correct.

Where an unprotected connector parent is available in Dropbox, it may be carried into the assembled day without validating every descendant object.

Where Dropbox content is unusable, SOS-light may omit the smallest practical item or the complete connector from the rebuilt day parent and continue with a warning.

## No live-R2 preservation graph

SOS-light MUST NOT:

- GET existing live R2 observation manifests to decide what to preserve;
- use live R2 `404` responses as planning input;
- merge existing live R2 children into the replacement day;
- require an unprotected live R2 child to be readable;
- rebuild unprotected metadata from live R2 listings;
- allow an unprotected live R2 defect to veto connector `1`.

The existing selected R2 day is deleted as a whole after local source-plus-Dropbox assembly succeeds.

Permitted live R2 access is limited to deletion, upload, locking, bounded deletion verification and post-PUT verification as defined by [`sos_light_model.md`](sos_light_model.md).

## Connector 7 humidity example

The previously observed live R2 error:

```text
history/v2/observations/day_utc=2026-07-12/connector_id=7/pollutant_code=humidity/manifest.json
-> 404 NoSuchKey
```

is not a preservation decision in SOS-light.

Required behaviour is:

```text
if Dropbox contains the connector 7 humidity content
-> include the Dropbox version in the assembled day

if Dropbox does not contain usable connector 7 humidity content
-> warn and omit it as needed

in both cases
-> do not inspect old live R2 to decide
-> do not block connector 1
```

## Future expansion

Connectors `2` and `3` may later be added deliberately to the protected set.

Before that happens, a separate authoritative source and local assembly rule MUST define how each connector is rebuilt. Adding an ID to configuration alone is not sufficient.

Until then, connectors `2` and `3` remain Dropbox-backed, warning-only unprotected content in SOS-light.

## Audit

Every SOS-light run MUST report:

- protected connector IDs;
- selected mutation connector IDs;
- connector `1` validation status;
- final connector `1` child set per selected day;
- unprotected Dropbox warning and omission counts;
- final assembled connector set per selected day;
- confirmation that no live R2 body was used for preservation decisions.

A run may finish `status=ok` with warnings for unprotected Dropbox content only when connector `1`, the complete assembled day and required observation indexes are correct and verified.

## Minimal validation

The smallest required structural checks are:

1. a newly built connector `1` O3 child appears in the final connector `1` parent even if the old Dropbox parent omitted O3;
2. connector `1` parent body and dependency evidence use the same final child set;
3. an unusable unprotected Dropbox connector produces a warning and does not block connector `1`;
4. no existing live R2 body is read for preservation planning;
5. the selected complete day prefix is deleted only after local assembly passes.

Functional validation belongs in the real CIC-Test SOS-light run.
