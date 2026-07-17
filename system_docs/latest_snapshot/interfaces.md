# Latest snapshot interfaces

## Purpose

This file protects the message, durable-state, transient-cache, physical R2 object, manifest, run-report and HTTP interface shapes used by the latest-snapshot system.

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

## Container-local R2 cache interface

### Runtime settings

```text
UK_AQ_LATEST_SNAPSHOT_LOCAL_CACHE_ENABLED
UK_AQ_LATEST_SNAPSHOT_LOCAL_CACHE_DIR
```

Defaults:

```text
UK_AQ_LATEST_SNAPSHOT_LOCAL_CACHE_ENABLED=true
UK_AQ_LATEST_SNAPSHOT_LOCAL_CACHE_DIR=/tmp/uk-aq-latest-snapshot-cache
```

The enabled setting uses the repository's standard boolean forms. Disabling it returns all durable-object loads to the direct R2 path.

### Cached R2 keys

Only these durable objects use the local cache:

```text
latest_snapshots_state/v1/latest_state.json
latest_snapshots_state/v1/core_metadata_cache_v2.json
latest_snapshots/v2/manifest.json
```

### Local filename interface

The body and sidecar filenames use the lowercase hexadecimal SHA-256 of the complete R2 key as the filename stem:

```text
{cache_dir}/{sha256-of-r2-key}.bin
{cache_dir}/{sha256-of-r2-key}.json
```

R2 keys are not interpolated directly as local paths.

### Sidecar schema

```json
{
  "schema_version": 1,
  "key": "latest_snapshots_state/v1/latest_state.json",
  "etag": "<R2 ETag>",
  "sha256": "<64-character lowercase SHA-256 of body>"
}
```

A local entry is usable only when:

- the body and sidecar both exist;
- sidecar schema and field types are valid;
- `key` equals the requested full R2 key;
- the body parses as JSON;
- the body SHA-256 matches the sidecar;
- a current R2 HEAD says the object exists;
- the current R2 ETag is present and equals the sidecar ETag.

If any condition fails, the caller uses the normal R2 GET path.

Local body and sidecar files are written through temporary files and rename. Because the two files are separate, an interrupted pair update may leave a mismatched entry, which the validation rules treat as corrupt or stale and replace from R2.

### Cache statistics

The `local_cache` object in `latest_snapshot_job_summary` contains:

| Field | Meaning |
|---|---|
| `enabled` | Resolved cache switch |
| `cache_dir` | Resolved local directory |
| `disabled` | Read attempts bypassed because cache is disabled |
| `cold_miss` | Missing body or sidecar |
| `warm_hit` | Locally valid body whose R2 ETag still matches |
| `fingerprint_mismatch` | Missing R2 object/ETag or ETag mismatch |
| `corrupt` | Invalid sidecar, JSON body or local SHA-256 |
| `validation_error` | R2 fingerprint lookup failed |
| `write_failure` | Local body or sidecar write failed |
| `skipped_missing_etag` | Local store skipped because R2 returned no usable ETag |

These are operational counters. They are not public API fields.

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

The builder's local cache does not contain these pollutant snapshot objects.

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

## R2 run reports

Default prefix:

```text
latest_snapshots/v2/_runs
```

Timestamped key form remains:

```text
{runs_prefix}/{compact-finished-at}.json
```

A report that is written retains the existing fields:

| Field | Meaning |
|---|---|
| `ok` | Whether all physical matrix items succeeded |
| `trigger_mode` | Scheduler or manual mode resolved by the service |
| `manifest_key` | Physical manifest key |
| `reports_key` | This report's key |
| `duration_ms` | Build duration |
| `success_count` | Successful physical matrix item count |
| `failure_count` | Failed physical matrix item count |
| `changed_count` | Changed physical snapshots written |
| `skipped_unchanged_count` | Unchanged physical snapshot writes skipped |
| `warnings` | Bounded build warning strings |

### Report-mode settings

```text
UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_MODE
UK_AQ_LATEST_SNAPSHOT_RUN_REPORTS_ENABLED
```

Accepted new modes:

```text
all
failures
off
```

Resolution:

1. an explicit valid mode wins;
2. otherwise an explicit legacy boolean maps `true` to `all` and `false` to `off`;
3. otherwise the default is `failures`.

An explicit invalid mode is a configuration error.

### Report decision reasons

The structured job summary exposes:

```json
{
  "run_reports": {
    "mode": "failures",
    "source": "mode",
    "write": false,
    "reason": "scheduled_success"
  }
}
```

Current reason values are:

- `mode_off`;
- `mode_all`;
- `manual_invocation`;
- `completed_failure`;
- `scheduled_success`.

The `write` field indicates whether an R2 report key was actually produced. If the configured runs prefix is empty, a decision to write cannot create an object and `write` remains false.

Run reports are not manifest entries and are not required by the public API.

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

The ETags used by the Cloud Run local cache belong to state, metadata-cache and manifest R2 objects. They are independent of public finite-response ETag derivation.

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

A change to durable-object authority, local sidecar schema or validation, run-report modes, physical product ownership, finite-window derivation, public ETag inputs, query values, response fields, row fields, manifest meaning or authentication requires an explicit contract and compatibility review.
