# Latest snapshot interfaces

## Purpose

This file protects the message, state, R2 object and HTTP interface shapes used by the latest-snapshot system.

The invalid-value state fix MUST NOT change these public or persisted shapes unless a separate contract change is approved.

## Pub/Sub observation message

The latest-snapshot builder decodes a Base64 JSON object.

Supported fields:

| Field | Type | Required for decode | Meaning |
|---|---|---:|---|
| `connector_id` | positive integer | Yes | Connector identity |
| `timeseries_id` | positive integer | Yes | Timeseries identity within connector scope |
| `observed_at` | timestamp string | Yes | Source observation timestamp |
| `value` | finite number or null | No | Raw source numeric value |
| `value_float8_hex` | string or null | No | Optional bit-exact float representation |
| `status` | string or null | No | Optional source status |

Example:

```json
{
  "connector_id": 1,
  "timeseries_id": 360,
  "observed_at": "2026-07-16T09:00:00Z",
  "value": -99,
  "value_float8_hex": null,
  "status": null
}
```

This example is structurally valid and decodable. It is not eligible for current pollutant state.

## Persisted latest-state object

Default key:

```text
latest_snapshots_state/v1/latest_state.json
```

Top-level contract:

| Field | Type | Meaning |
|---|---|---|
| `schema_version` | integer, currently `1` | State schema version |
| `updated_at` | timestamp string | Time the state object last changed |
| `entries` | array | Latest valid state entries |

Entry contract:

| Field | Type | Meaning |
|---|---|---|
| `connector_id` | positive integer | Connector identity |
| `timeseries_id` | positive integer | Timeseries identity |
| `observed_at` | timestamp string | Timestamp of retained valid observation |
| `value` | finite number | Retained valid current value |
| `value_float8_hex` | string or null | Optional bit-exact source representation |
| `status` | string or null | Preserved source status for retained row |
| `ingested_at` | timestamp string or null | State-ingest tie-break timestamp |

The shape remains schema version `1` for the invalid-value fix because the required change is eligibility and transition logic, not storage structure.

## Core metadata cache

Default key:

```text
latest_snapshots_state/v1/core_metadata_cache_v2.json
```

Top-level fields:

- `schema_version`, currently `2`;
- `generated_at`;
- `source_day_utc`;
- `connectors`;
- `stations`;
- `networks`;
- `timeseries`;
- `phenomena`;
- `observed_properties`.

The cache must provide the relationships required to resolve:

```text
timeseries
  -> phenomenon
      -> observed_property

timeseries
  -> station
      -> network

timeseries / station
  -> connector
```

## Snapshot object key

Canonical pattern:

```text
latest_snapshots/v2/network_group={network_group}/pollutant={pollutant}/window={window}.json
```

Current examples:

```text
latest_snapshots/v2/network_group=all/pollutant=pm25/window=3h.json
latest_snapshots/v2/network_group=all/pollutant=pm10/window=6h.json
latest_snapshots/v2/network_group=all/pollutant=no2/window=all.json
```

## Snapshot payload

Top-level fields:

| Field | Current type/value |
|---|---|
| `region` | `null` |
| `pcon_code` | `null` |
| `pollutant` | matrix pollutant string |
| `window` | matrix window string |
| `since` | `null` |
| `since_id` | `null` |
| `next_since` | timestamp string or null |
| `next_since_id` | integer or null |
| `count` | integer |
| `data` | array of latest rows |

No field may be removed, renamed or repurposed by the invalid-value fix.

## Latest row v2 contract

Each `data` row contains:

| Field | Type |
|---|---|
| `id` | integer or null |
| `last_value` | number or null |
| `last_value_at` | timestamp string or null |
| `connector_code` | string or null |
| `connector_label` | string or null |
| `station_id` | integer or null |
| `station_label` | string or null |
| `display_name` | string or null |
| `pcon_code` | string or null |
| `la_code` | string or null |
| `network_id` | integer or null |
| `network_code` | string or null |
| `network_label` | string or null |
| `phenomenon_label` | string or null |
| `pollutant_label` | string or null |
| `observed_property_code` | string or null |
| `uom_display` | string or null |

The v2 contract intentionally omits:

- `station_network_memberships`;
- `network_memberships`;
- `network_name`;
- `network_type`.

The invalid-value fix MUST NOT reintroduce those fields.

## Manifest

Canonical key:

```text
latest_snapshots/v2/manifest.json
```

Top-level contract includes:

- `schema_version`;
- `snapshot_family`, currently `latest`;
- `version`, currently `v2`;
- `generated_at`;
- `trigger_mode`;
- `source`;
- `matrix`;
- `build`;
- `snapshots`.

Each snapshot manifest entry includes:

- stable matrix `id`;
- `network_group`;
- `pollutant`;
- `window`;
- `object_key`;
- content type and encoding;
- SHA-256 and etag;
- row count and byte count;
- minimum and maximum observed timestamps;
- generation and build timing;
- previous hash;
- changed flag;
- error field.

## Private R2 API Worker

Endpoints:

```text
GET /v1/latest-snapshot
GET /v1/manifest
GET /v1/health
```

Accepted latest-snapshot query:

```text
GET /v1/latest-snapshot?pollutant=pm25&window=6h&network_group=all
```

Accepted aliases:

- `/` behaves as `/v1/latest-snapshot`;
- `scope=all` aliases `network_group=all`.

Accepted matrix values:

- `pollutant`: `pm25`, `pm10`, `no2`;
- `window`: `3h`, `6h`, `1d`, `7d`, `all`;
- `network_group`: `all`.

## Authentication and contract marker

All private read endpoints require:

```text
x-uk-aq-upstream-auth: <UK_AQ_EDGE_UPSTREAM_SECRET>
```

Successful canonical snapshot responses identify the contract with:

```text
X-UK-AQ-Snapshot-Contract: v2
```

The Worker must fail closed for non-canonical standard v1/v2 path configuration and must not fall back to v1 objects.

## Cache-proxy route

External route:

```text
/api/aq/latest-snapshot
```

Upstream configuration:

```text
UK_AQ_LATEST_SNAPSHOT_R2_API_URL
```

The cache proxy must continue validating the v2 contract marker and preserving its existing cache-key, cache-control and error behaviour.

## Compatibility rule

A change that modifies any interface in this file is not an implementation-only latest-state fix. It requires an explicit contract and compatibility review.
