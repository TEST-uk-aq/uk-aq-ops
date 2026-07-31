# Direct replacement contract

## Authority and scope

This document preserves the general rule that explicit operator scope selects what a write-enabled repair rebuilds. Gap detection is diagnostic and does not authorise or suppress an explicitly selected repair.

For the dedicated UK-AIR SOS path, the active implementation model is the authoritative [`sos_light_model.md`](sos_light_model.md) contract.

Where earlier wording described SOS as deleting and replacing only selected connector `1` pollutant prefixes while preserving the existing live R2 day, that wording is superseded.

The generic Integrity path, check-only mode, dry-run mode, Prune Daily and non-SOS paths remain unchanged until deliberately migrated.

## General selection principle

For an explicitly selected write-enabled repair:

```text
selection decides what to rebuild
source validation decides whether rebuilding is safe
diagnostics explain observed differences
```

A selected scope MUST NOT become a no-op merely because:

- Dropbox already matches authoritative source;
- a detector reports no difference;
- the scope was repaired previously;
- existing R2 appears complete;
- no gap object exists.

## SOS-light selection

For SOS-light, explicit dates and supported connector `1` pollutants select the source rebuild work:

```text
explicit --from-day through --to-day
x
connector_id=1
x
explicit --repair-pollutants
```

The executable source-built target set MUST NOT be filtered by gap indexes, mismatch classifications or source-versus-Dropbox comparison results.

## SOS-light destructive target

Although source work is selected by connector `1` pollutant, the destructive R2 replacement unit is the complete selected observations day:

```text
history/v2/observations/day_utc=<selected day>/
```

For each selected day:

1. assemble a complete local replacement day from SOS source plus the chosen Dropbox baseline;
2. require connector `1` and its final parent graph to be correct;
3. treat other-connector Dropbox problems as warnings;
4. delete the complete existing R2 observation day prefix;
5. upload the complete assembled replacement day;
6. rebuild affected observation indexes from the Dropbox baseline plus assembled day;
7. verify changed objects written by the current run.

Existing live R2 content is not merged into the replacement and is not a planning or preservation authority.

## Connector 1 final child set

The final connector `1` parent MUST be built from the complete final connector `1` child set actually present in the assembled replacement day.

This includes every current-run selected source-built child and any deliberately retained unselected connector `1` child from Dropbox.

The old Dropbox connector `1` parent list MUST NOT suppress a new staged child.

Example:

```text
old Dropbox connector 1 parent omits o3
current run builds valid o3
-> final connector 1 parent includes o3
```

A mismatch between the connector `1` parent body and its dependency evidence is blocking before deletion.

## Source outcomes

Each selected connector `1` pollutant reaches one of these outcomes:

### Complete replacement

Complete authoritative source evidence produces a complete source-built child in the assembled day.

### Authoritative no-data

Conclusive no-data evidence produces the valid empty source-built child representation.

### All rows excluded for missing authoritative bindings

Where source rows exist but every group is excluded only because no authoritative active timeseries binding exists, the selected pollutant is skipped under the established warning-only mapping rule. The complete-day assembly must then use the contractually defined connector `1` fallback or fail if connector `1` cannot remain correct.

### Blocked before mutation

Incomplete, ambiguous, contradictory or irreproducible connector `1` source evidence blocks the complete day before deletion.

## Reruns

A later SOS-light run of the same selected dates follows the same complete local assembly and complete-day replacement process.

It does not require a newly detected gap and does not compare against existing live R2 to decide whether to run.

## Minimal structural acceptance

Before real CIC-Test execution, the smallest targeted checks must prove:

- explicit scope is not filtered by gap detection;
- complete local day assembly finishes before deletion;
- the full selected day prefix is the destructive target;
- newly built connector `1` children are included in the final connector parent;
- no existing live R2 body is used for planning or preservation;
- other-connector Dropbox problems remain warning-only.

Functional acceptance is the real SOS-light CIC-Test run defined by [`sos_historical_repair_contract.md`](sos_historical_repair_contract.md).
