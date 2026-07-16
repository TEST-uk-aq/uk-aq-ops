# UK AQ network contract v2

## Latest snapshots

Public latest objects live under `latest_snapshots/v2`; latest-observation state
may remain under `latest_snapshots_state/v1`. Rows contain scalar `network_id`,
`network_code`, and `network_label`, plus connector provenance where intended.
They omit membership arrays, `network_name`, and `network_type`.

The builder resolves metadata through `stations.network_id -> networks.id`,
skips disabled networks, and reports/skips missing station or network metadata
instead of deriving identity from a connector. Output remains deterministic
when source data is unchanged. A missing v2 object must never read or return a
v1 object: the R2 API returns its documented error, or an explicitly controlled
live Supabase path must still emit only contract v2.

## Core metadata snapshots

New deterministic core snapshots include `networks`. Retired network relations
are excluded from active manifests. The latest-snapshot metadata cache consumes
the canonical station relationship above.

## Cache proxy

`/api/aq/networks` routes to the public networks edge function with the
metadata cache profile. Stable URLs are required for normal network and latest traffic;
cache-buster parameters are for diagnostics or explicit refreshes only. The v2
latest route fails closed and never mixes v1 and v2 objects.

The catalogue returns `contract_version: 2`, enabled networks only, and includes
`network_type`. Public data rows use scalar network identity and retain connector
fields only as separate provenance. Connector filter parameters return HTTP 400.
