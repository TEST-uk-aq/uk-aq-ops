# Binding recovery

Do not construct bindings from observation or AQI manifests. Reconcile from the
chosen committed core snapshot using the dry-run command first, then explicit
`--write-r2` after review. Stale bindings are evidence only and must not be
deleted. A missing binding falls through to the existing Supabase connector
lookup; cumulative metadata is not a recovery path.
