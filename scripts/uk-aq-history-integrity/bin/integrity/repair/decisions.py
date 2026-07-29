"""Pure, authoritative classification of observation Integrity findings."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Mapping


SUPPORTED_POLLUTANTS = frozenset({"pm25", "pm10", "no2", "o3"})
AQI_POLLUTANTS = frozenset({"pm25", "pm10", "no2"})

_POLLUTANT_MANIFEST_GAPS = frozenset({
    "data_manifest_file_count_mismatch",
    "data_manifest_listed_parquet_missing",
    "data_manifest_unlisted_parquet",
    "data_manifest_duplicate_file_key",
    "data_manifest_timeseries_row_count_mismatch",
    "data_manifest_total_bytes_mismatch",
    "data_manifest_row_count_mismatch",
})

_DATA_GAPS = frozenset({
    "day_dir_missing", "connector_dir_missing", "pollutant_dir_missing",
    "data_manifest_missing", "data_manifest_invalid_json",
    "data_manifest_schema_mismatch", "data_manifest_empty",
    "data_manifest_empty_timeseries_counts", "parquet_null_timeseries_id_rows",
    "data_partition_zero_rows", "parquet_missing",
    "parquet_empty_or_placeholder", "parquet_unreadable", "row_count_mismatch",
    "source_r2_timeseries_row_mismatch", "pollutant_missing",
    "orphan_parquet_without_manifest", "missing_pollutant_partitions",
    "unexpected_connector_level_part_file", "observation_content_hash_mismatch",
    "observation_content_hash_invalid_contract", "observation_content_hash_missing",
    *_POLLUTANT_MANIFEST_GAPS,
})

_SOURCE_REQUIRED_GAPS = _DATA_GAPS - _POLLUTANT_MANIFEST_GAPS


@dataclass(frozen=True)
class ObservationRepairDecision:
    """The single policy result consumed by reporting, planning and execution."""

    repair_kind: str
    data_changes_required: bool
    scope_grain: str
    day_utc: str | None
    connector_id: int | str | None
    pollutant_code: str | None
    requires_index_rebuild: bool
    source_evidence_required: bool
    operator_pollutant_permission_required: bool
    aqi_policy: str
    executability_policy: str
    reason: str

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def _scope(gap_type: str, pollutant_code: str | None) -> tuple[str, str | None]:
    if gap_type in {"day_dir_missing", "connector_dir_missing"}:
        return "connector_day_wildcard", None
    if pollutant_code in SUPPORTED_POLLUTANTS:
        return "exact_pollutant", pollutant_code
    return "ambiguous", None


def decide_observation_repair(
    gap: Mapping[str, Any],
    *,
    source_partition_unavailable: bool = False,
    reconstructible_manifest: bool = False,
) -> ObservationRepairDecision:
    """Classify detector facts without performing I/O or consulting runtime state."""
    gap_type = str(gap.get("gap_type") or "").strip()
    fault_class = str(gap.get("fault_class") or "").strip()
    pollutant = str(gap.get("pollutant_code") or "").strip().lower() or None
    day = str(gap.get("day_utc") or "").strip() or None
    connector = gap.get("connector_id")
    grain, scoped_pollutant = _scope(gap_type, pollutant)

    def result(
        kind: str,
        *,
        data: bool = False,
        index: bool = False,
        evidence: bool = False,
        permission: bool = False,
        aqi: str = "none",
        executable: str = "metadata_only",
        reason: str,
        result_grain: str | None = None,
        result_pollutant: str | None = scoped_pollutant,
    ) -> ObservationRepairDecision:
        return ObservationRepairDecision(
            repair_kind=kind,
            data_changes_required=data,
            scope_grain=result_grain or grain,
            day_utc=day,
            connector_id=connector,
            pollutant_code=result_pollutant,
            requires_index_rebuild=index,
            source_evidence_required=evidence,
            operator_pollutant_permission_required=permission,
            aqi_policy=aqi,
            executability_policy=executable,
            reason=reason,
        )

    if gap_type == "pollutant_dir_missing" and pollutant not in SUPPORTED_POLLUTANTS:
        return result(
            "unclassified", executable="fail_closed",
            reason="missing_pollutant_scope_is_ambiguous",
            result_grain="ambiguous", result_pollutant=None,
        )
    if gap_type.startswith("connector_manifest_"):
        return result(
            "observation_connector_manifest_repair",
            reason="connector_manifest_rebuild_from_children",
        )
    if gap_type.startswith("day_manifest_"):
        return result(
            "observation_day_manifest_repair",
            reason="day_manifest_rebuild_from_children",
            result_grain="day", result_pollutant=None,
        )
    if gap_type.startswith("index_") or gap_type.startswith("latest_index_"):
        return result(
            "observation_index_repair", index=True,
            reason="observation_index_metadata_gap",
        )
    if fault_class == "pollutant manifest-only fault":
        return result(
            "observation_pollutant_manifest_repair", index=True,
            reason="readable_parquet_manifest_only_fault",
        )
    if gap_type in _POLLUTANT_MANIFEST_GAPS:
        return result(
            "observation_pollutant_manifest_repair", index=True,
            reason="verified_content_manifest_mismatch",
        )
    if gap_type in {"observation_content_hash_missing", "observation_content_hash_invalid_contract"}:
        if gap.get("hash_content_verified") is True:
            return result(
                "observation_pollutant_manifest_repair", index=True,
                reason="verified_content_hash_metadata_gap",
            )
    if gap_type in _DATA_GAPS:
        if source_partition_unavailable and not reconstructible_manifest:
            return result(
                "source_mapping_issue", executable="operator_action_required",
                reason="authoritative_source_partition_unavailable",
            )
        aqi_policy = (
            "observation_dependency" if scoped_pollutant in AQI_POLLUTANTS
            else "requested_pollutants_only" if grain == "connector_day_wildcard"
            else "none"
        )
        return result(
            "observation_data_repair", data=True, index=True, evidence=True,
            permission=True, aqi=aqi_policy,
            executable="explicit_plan_and_pollutant_permission",
            reason="authoritative_source_data_repair_required",
        )
    return result(
        "unclassified", executable="fail_closed",
        reason="observation_gap_has_no_authorised_repair_policy",
    )


def suggested_repair_from_decision(
    decision: ObservationRepairDecision, *, sos_scope: bool,
) -> dict[str, Any]:
    """Render the established suggested-repair shape from the policy result."""
    public_kind = decision.repair_kind
    if public_kind == "observation_index_repair":
        public_kind = "rebuild_v2_observations_index_only"
    elif decision.data_changes_required:
        public_kind = (
            "uk_air_csv_to_v2_observations_backfill_required"
            if sos_scope else "source_to_v2_observations_backfill_required"
        )
    steps_by_kind = {
        "observation_connector_manifest_repair": [
            "Rebuild the connector manifest from the live pollutant child manifests.",
            "Keep any sibling pollutant partitions that are already present.",
        ],
        "observation_day_manifest_repair": [
            "Rebuild the day manifest from the live connector child manifests.",
            "Keep any sibling connector partitions that are already present.",
        ],
        "observation_pollutant_manifest_repair": [
            "Rebuild the pollutant manifest from the readable parquet files.",
        ],
        "observation_index_repair": [
            "Confirm the v2 observations data partition exists for the finding.",
            "Rebuild only the affected v2 observations _index_v2 manifest.",
        ],
        "observation_data_repair": [
            "Use authoritative connector source evidence for the selected pollutant scope.",
            "Write the affected v2 observation partition through the existing source-to-R2 writer.",
            "Rebuild affected manifests and indexes before final verification.",
        ],
    }
    return {
        "kind": public_kind,
        "requires_index_rebuild": decision.requires_index_rebuild,
        "commands": [],
        "executes": False,
        "operator_action_required": (
            decision.executability_policy == "operator_action_required"
        ),
        "write_risk": (
            "writes_to_r2_when_run_backfill_is_enabled"
            if decision.data_changes_required else "metadata_only"
        ),
        "steps": list(steps_by_kind.get(decision.repair_kind, [])),
        "notes": decision.reason,
    }
