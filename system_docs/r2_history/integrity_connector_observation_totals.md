# Integrity connector observation totals

## Authority and scope

This document defines the authoritative reporting contract for connector-level observation totals produced by UK AQ R2 History Integrity.

It supplements [`integrity.md`](integrity.md), [`sos_historical_repair_contract.md`](sos_historical_repair_contract.md) and the normal JSON and Markdown Integrity reports.

The purpose is to let operational wrappers, including sequential monthly runners, print a simple per-connector summary without independently querying live R2, walking Dropbox manifests or rescanning Parquet.

## Reported scope

Connector totals MUST be limited to the exact requested Integrity scope:

```text
requested connector set
x
inclusive --from-day through --to-day
x
requested repair-pollutant set
```

Only connectors explicitly selected by the run are included.

For source-scoped runs, the selected connector set is the connector set resolved by that source. For example, an SOS-light run includes connector `1` only.

Integrity MUST NOT include:

- other connectors merely preserved from the Dropbox baseline;
- connectors present in a rebuilt day manifest but not selected by the request;
- pollutants outside the requested repair-pollutant set;
- rows excluded from canonical history because of warning-only missing bindings or another established exclusion;
- AQI rows or AQI debug rows.

## Required totals

For every selected connector in a successful real repair, the JSON report MUST expose:

```json
{
  "connector_observation_totals": {
    "1": {
      "total_observations_before": 152340,
      "total_observations_added": 159951,
      "total_observations_after": 159951
    }
  }
}
```

The connector key is the decimal connector ID represented as a JSON object key.

All totals are non-negative integers.

### Total observations before

`total_observations_before` is the number of canonical observation rows in the chosen Dropbox baseline for the selected connector, requested inclusive date range and requested pollutant set before the repair is applied.

The value MUST come from structurally validated baseline manifest or equivalent already-loaded Integrity evidence. It MUST NOT require a new live-R2 read or an additional broad Parquet scan solely for reporting.

### Total observations added

`total_observations_added` is the number of canonical observation rows successfully published by the current run for the selected connector and requested scope.

This is a written-row count, not a net increase calculation.

Rows that were planned but not successfully published and verified MUST NOT be counted as added.

For a generic partial repair, this may be lower than `total_observations_after` because valid unchanged partitions can remain in place.

### Total observations after

`total_observations_after` is the number of canonical observation rows in the final verified state for the selected connector and requested scope after the repair completes.

The value MUST be derived from final verified manifests or equivalent final verification evidence already produced by Integrity.

It MUST NOT be inferred merely from planned writes.

## SOS-light rule

SOS-light deletes the complete selected observation day prefix and uploads the complete assembled replacement day.

For the selected SOS connector and requested pollutant scope, every final canonical row is therefore published by that run. On a successful SOS-light repair:

```text
total_observations_added = total_observations_after
```

`total_observations_before` may be lower, higher or equal depending on the previous baseline content.

Other connectors carried into the assembled day from Dropbox are not included unless they were explicitly selected by the operator request.

## Failed, check-only and dry-run behaviour

A failed or interrupted run MUST NOT claim a completed `total_observations_after` value.

The monthly operational summary MUST print connector totals only for a successful real repair whose report contains completed final totals.

Check-only and dry-run modes do not publish completed before-added-after totals under this field. Planned totals may remain in existing planning evidence, but MUST NOT be labelled as completed `added` or `after` values.

The absence of connector totals from a failed, check-only or dry-run report is not itself a second Integrity failure.

## Data ownership and performance boundary

Integrity owns calculation of these totals because it already owns:

- requested connector and pollutant scope;
- the chosen Dropbox baseline;
- proposal row counts;
- publication completion evidence;
- final manifest verification.

Operational shell wrappers MUST consume the structured Integrity JSON report. They MUST NOT independently:

- query live R2;
- traverse the complete Dropbox history tree;
- open observation Parquet solely to reproduce the totals;
- infer totals by parsing human-readable log lines.

Adding these totals MUST reuse evidence already loaded or generated by the run. It MUST NOT add a second source acquisition, broad history scan or independent R2 verification pass.

## Human-readable summary

For each selected connector with completed totals, a monthly wrapper may append:

```text
Connector 1:
Total Observs before: 152,340
Total Observs added: 159,951
Total Observs after: 159,951
```

Connectors are printed in ascending numeric connector-ID order.

The labels above are the operator-facing monthly-summary wording. JSON field names remain the stable machine-readable interface.

If the monthly wrapper cannot read the report or the totals field is absent, it may print a concise `Connector observation totals unavailable` note. That reporting problem MUST NOT change a successful Integrity exit status or success marker.

## Audit requirements

The JSON report MUST also retain the scope needed to interpret the totals through existing run fields, including:

- environment;
- source;
- requested connector set or source-resolved connector set;
- requested inclusive date range;
- requested pollutant set;
- run mode and final status;
- report and run identity.

The Markdown report SHOULD show the same totals for successful real repairs, but the JSON report is the authoritative interface for wrappers.

## Minimal structural validation

Before deployment, perform only the smallest targeted structural check proving that:

1. only requested connectors are emitted;
2. the requested date and pollutant scope is used consistently for all three totals;
3. SOS-light reports `added = after`;
4. a generic partial repair may report `added < after`;
5. failed, check-only and dry-run reports do not claim completed after totals;
6. the wrapper reads the structured report rather than querying R2 or scanning Parquet;
7. missing optional totals do not change the underlying Integrity success result.

Do not add a broad speculative pre-deployment test suite.

## CIC-Test functional acceptance

After deployment, functional validation occurs through a normal real CIC-Test operation.

Acceptance requires:

- the successful Integrity JSON report contains totals for only the requested connectors;
- totals agree with the run's existing baseline, publication and final-verification evidence;
- an SOS-light run reports equal added and after totals;
- the monthly wrapper prints the three-line connector summary;
- no additional broad R2, Dropbox or Parquet scan is introduced.
