# Prune Daily JSONgen pending source

The optional selected-v3 JSONgen source handover is disabled by default.
`UK_AQ_JSONGEN_PRUNE_PENDING_SOURCE_ENABLED=true` enables a private,
best-effort copy of each admitted frozen connector-day source before its
canonical connector write. It requires the existing dedicated
`UK_AQ_COMPRESSED_CHART_R2_*` TEST credentials. Missing configuration,
source limits or derived storage failures are logged as
`phase_b_jsongen_pending_source_unavailable`; canonical publication, source
cleanup, PostgreSQL gates and deletion eligibility keep their existing rules.

Successful retention logs `phase_b_jsongen_pending_source_retained` with the
immutable private source and pending descriptor references. Both are verified
by exact byte readback. They survive process exit, but the original local
temporary file follows normal cleanup. Pending evidence has no automatic
expiry and grants no JSONgen selection or receipt eligibility. Inspect the
JSONgen [README](../../scripts/jsongen/README.md) for the storage format,
limits, blocked final-authority seam and later recovery responsibility.

The v2 Prune path does not invoke this handover. No remote TEST acceptance,
deployment, managed control registration or monthly publication is provided
by this code change.
