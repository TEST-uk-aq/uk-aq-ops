"""Stable coordinator stage boundaries shared by reports and orchestration."""

CANONICAL_REPAIR_STAGE_ORDER = (
    "observations_proposal",
    "observations_metadata_proposal",
    "aqi_proposal",
    "latest_snapshot_auth_preflight",
    "canonical_apply",
    "first_value_at_reconciliation",
    "final_verification",
    "timeseries_reconciliation",
    "latest_snapshot_reconciliation",
)
