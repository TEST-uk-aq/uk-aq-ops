# Latest snapshot interfaces

## Purpose

This file protects the message, state, physical R2 object, manifest and HTTP interface shapes used by the latest-snapshot system.

The public request matrix contains five windows, while the physical R2 matrix contains only `window=all`. That distinction is part of the current interface contract.

## Pub/Sub observation message

The builder decodes a Base64 JSON object.

| Field | Type | Required for decode | Meaning |
|---|---|---:|---|
| `connector_id` | positive integer | Yes | Connector identity |
| `timeseries_id` | positive integer | Yes | Timeseries identity within connector scope |
| `observed_at` | timestamp string | Yes | Source observation timestamp |
| `value` | finite number or null | No | Raw source numeric value |
| `value_float8_hex` | string or null | No | Optional bit-exact float representation |
| `status` | string or null | No | Optional source status |

A structurally valid decoded value such as `-99` is handled and acknowledged but is not eligible for latest pollutant state.

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

The state schema remains version `1`.

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

## Physical snapshot object keys

Canonical physical pattern:

```text
latest_snapshots/v2/network_group={network_group}/pollutant={pollutant}/window=all.json
```

Current physical objects:

```text
latest_snapshots/v2/network_group=all/pollutant=pm25/window=all.json
latest_snapshots/v2/network_group=all/pollutant=pm10/window=all.json
latest_snapshots/v2/network_group=all/pollutant=no2/window=all.json
```

There are no current physical `3h`, `6h`, `1d` or `7d` products. Old finite objects may remain in R2 but are not current interfaces and are never fallbacks.

## Snapshot payload

The same v2 top-level shape is used for the stored `all` payload and derived finite responses.

| Field | Type/value | Finite response behaviour |
|---|---|---|
| `region` | `null` | Preserved |
| `pcon_code` | `null` | Preserved |
| `pollutant` | pollutant string | Preserved and validated against request |
| `window` | window string | Replaced with requested finite window |
| `since` | `null` | Preserved |
| `since_id` | `null` | Preserved |
| `next_since` | timestamp string or null | Recalculated from filtered rows |
| `next_since_id` | integer or null | Recalculated from filtered rows |
| `count` | integer | Recalculated from filtered rows |
| `data` | latest-row array | Filtered for finite windows |

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

State `observed_at` is exposed as `last_value_at`.

The v2 contract intentionally omits:

- `station_network_memberships`;
- `network_memberships`;
- `network_name`;
- `network_type`.

Derived finite responses MUST preserve the row shape exactly and MUST NOT add or remove fields.

## Manifest

Canonical key:

```text
latest_snapshots/v2/manifest.json
```

The manifest describes physical stored products only.

Top-level fields include:

- `schema_version`;
- `snapshot_family`, currently `latest`;
- `version`, currently `v2`;
- `generated_at`;
- `trigger_mode`;
- `source`;
- `matrix`;
- `build`;
- `snapshots`.

Current matrix contract:

```json
{
  "network_group": "all",
  "pollutants": ["pm25", "pm10", "no2"],
  "windows": ["all"]
}
```

A fully successful manifest contains three snapshot entries. Each entry includes:

- stable matrix `id`;
- `network_group`;
- `pollutant`;
- `window`, always `all`;
- `object_key`;
- content type and encoding;
- SHA-256 and ETag;
- row and byte counts;
- minimum and maximum observed timestamps;
- generation and build timing;
- previous hash;
- changed flag;
- error field.

Finite public responses are not represented as manifest entries.

## Private R2 API Worker

Endpoints:

```text
GET /v1/latest-snapshot
HEAD /v1/latest-snapshot
GET /v1/manifest
HEAD /v1/manifest
GET /v1/health
```

Accepted latest-snapshot query:

```text
GET /v1/latest-snapshot?pollutant=pm25&window=6h&network_group=all
```

Accepted aliases:

- `/` behaves as `/v1/latest-snapshot`;
- `scope=all` aliases `network_group=all`.

Accepted values:

- `pollutant`: `pm25`, `pm10`, `no2`;
- `window`: `3h`, `6h`, `1d`, `7d`, `all`;
- `network_group`: `all`.

If `window` is omitted, the current default remains `6h`.

## Source selection and finite derivation

Every accepted snapshot request reads:

```text
latest_snapshots/v2/network_group=all/pollutant={pollutant}/window=all.json
```

For a finite window:

- effective time is the start of the current UTC minute;
- the cutoff is effective time minus the requested duration;
- inclusion is `Date.parse(last_value_at) >= cutoff`;
- missing or unparseable timestamps are excluded;
- source row order is preserved;
- `window`, `count`, `next_since` and `next_since_id` are recalculated.

Cursor meaning remains:

- `next_since` is the greatest valid `last_value_at` in the returned rows;
- `next_since_id` is the greatest non-negative row `id` among rows sharing that timestamp;
- both are `null` when no returned row has a valid timestamp.

## ETags and conditional requests

For `window=all`, the response uses the physical object ETag.

For finite responses, the ETag is a SHA-256 identity derived from:

```text
physical source ETag
requested window
effective UTC minute
```

Matching `If-None-Match` on GET or HEAD returns `304` with the v2 contract marker.

Finite HEAD responses return the same representation headers as GET, including the derived ETag and recalculated content length, but no body.

## Errors

The Worker preserves the existing bounded errors, including:

- `invalid_pollutant`;
- `invalid_window`;
- `invalid_network_group`;
- `snapshot_not_found`;
- `invalid_snapshot_payload`;
- `invalid_v2_snapshot_config`;
- `method_not_allowed`;
- `not_found`.

A malformed physical payload fails closed. The Worker does not attempt an old finite or v1 fallback.

## Authentication and contract marker

All private read endpoints require:

```text
x-uk-aq-upstream-auth: <UK_AQ_EDGE_UPSTREAM_SECRET>
```

Successful canonical snapshot responses identify the contract with:

```text
X-UK-AQ-Snapshot-Contract: v2
```

## Cache-proxy route

External route:

```text
/api/aq/latest-snapshot
```

Upstream configuration:

```text
UK_AQ_LATEST_SNAPSHOT_R2_API_URL
```

The cache proxy continues forwarding the public query, validating the v2 marker, and preserving its current cache-key and error behaviour.

## Compatibility rule

A change to physical product ownership, finite-window derivation, ETag inputs, query values, response fields, row fields, manifest meaning or authentication requires an explicit contract and compatibility review.