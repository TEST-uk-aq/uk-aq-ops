# Shelved index_v3 station-history continuation candidate

This archive preserves the higher-level encrypted `station_history`
continuation candidate and its TEST-only measurement material.

The design was created to bound one station-history invocation while still
allowing a browser or cache-proxy client to resume a large logical chart
chunk. It carried authenticated encrypted continuation state, including the
private low-level `physical_cursor`, rolling AQI state, identity bindings, and
cap 1/2/4/8 experiment controls. Focused local work established that the
design was structurally viable.

It is shelved because measured normal serving workloads are hourly, or about
five-minute cadence for current Sensor.Community ingest, and do not justify a
new public continuation protocol, token crypto, cache identity, and browser
state. Dense historical Sensor.Community archive imports remain a possible
future multi-invocation use case, but their cleansing and fixed five-minute
canonicalisation belong to later Integrity Factory work rather than this
station-history path.

The code is retained in case genuinely multi-invocation station-history
continuation is needed later. Nothing under this archive is an active runtime
or deployment source.

The low-level index_v3 `physical_cursor` is not shelved. It remains private
plumbing for walking one exact-leaf logical request inside station-history and
is distinct from the abandoned browser-visible `station_history`
continuation.
