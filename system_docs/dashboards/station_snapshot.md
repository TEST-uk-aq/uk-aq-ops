# Station snapshot

## Purpose

The station snapshot provides a focused administrative view of station and timeseries data. It is delivered as static assets under `station_snapshot/` and is served through either the hosted dashboard API Worker or the local station snapshot backend.

## Hosted routes

The dashboard API Worker provides the active v2 station snapshot routes:

- `GET /api/station-snapshot-v2/search-stations`
- `GET /api/station-snapshot-v2/rows`

## Selection contract

Raw pollutant timeseries are selected through the canonical relationship:

```text
timeseries.observed_property_id -> observed_properties.code
```

Derived or index series without a canonical observed property MUST NOT be treated as raw pollutant timeseries.

Observation-history and AQI reads are independent. An unavailable observation-history source MUST NOT suppress otherwise valid AQI rows.

## Delivery

The hosted Pages workflow copies `station_snapshot/` into the deployed artefact at `/station_snapshot/`.

The local implementation lives under:

- `station_snapshot/`
- `local/station_snapshot/server/uk_aq_station_snapshot_local.py`

A local station snapshot command is supported only when its referenced script exists in the active checkout. Historical documentation must not advertise removed wrapper scripts.

## Compatibility

Changes to route names, selected-property semantics or returned field meanings are behavioural changes and require an update to this document and the relevant Worker-local README.
