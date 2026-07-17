# Stable v2 timeseries binding contract

The authoritative stable binding object is
`history/_index_v2/timeseries_binding/timeseries_id=<id>.json`. It is derived
only from a committed `history/v2/core/day_utc=<day>` snapshot after that
snapshot has been written and verified.

The object contains only identity/routing fields: `schema_version`,
`history_version`, `index_kind`, `timeseries_id`, `connector_id`,
`pollutant_code`, and optional positive `station_id`, `phenomenon_id` and
`observed_property_id`. It must contain no observation/AQI coverage, timestamps,
run IDs, generated-at values or other mutable state. Equivalent core input must
produce byte-identical JSON.

This is a direct TEST cutover. The retired cumulative
`history/_index_v2/timeseries/timeseries_id=<id>.json` object is not read,
written, backed up or exposed by active services. Binding reconciliation never
deletes stale binding objects; it reports them separately. A binding publish
failure must not invalidate an otherwise completed core snapshot.
