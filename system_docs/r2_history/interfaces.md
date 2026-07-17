# Binding interfaces

The observations R2 API exposes authenticated `GET /v1/timeseries-binding?timeseries_id=<id>`.
It returns the immutable binding object without daily coverage.

Normal website timeseries v2 routing is: request `connector_id`, stable binding,
then bounded Supabase lookup. There is no cumulative R2 metadata route or
feature flag.
