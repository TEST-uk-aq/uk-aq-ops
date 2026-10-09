"""Accepted, network-specific graph/RData timestamp and unit authority."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
from pathlib import Path
import re
from typing import Any, Mapping
from zoneinfo import ZoneInfo

from .official_network_rdata import NETWORKS, TIMESTAMP_MAPPING


CONTRACT = "uk_aq_official_rdata_timestamp_authority_v2"
HOUR_CONVENTION = "rdata_gmt_instant_equals_graph_canonical_utc"
UNIT_AUTHORITY = "accepted_matching_measurement_and_unit"
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_SITE = re.compile(r"[A-Za-z0-9]+\Z")
_POLLUTANTS = frozenset({"pm25", "pm10", "no2", "o3"})


def _instant(value: Any, *, source_gmt: bool = False) -> dt.datetime:
    text = str(value or "")
    try:
        parsed = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("official RData comparison timestamp is invalid") from exc
    if parsed.tzinfo is None:
        if not source_gmt:
            raise ValueError("official RData comparison timestamp lacks timezone")
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    instant = parsed.astimezone(dt.timezone.utc)
    if instant.minute or instant.second or instant.microsecond:
        raise ValueError("official RData comparison is not an exact UTC hour")
    return instant


def load_timestamp_authority(
    source_adapter: str, env: Mapping[str, str],
) -> tuple[Path, dict[str, Any]]:
    """Read accepted source comparisons and retain the exact artifact identity."""
    if source_adapter not in NETWORKS:
        raise ValueError("official RData network is invalid")
    raw_path = str(env.get("UK_AQ_OFFICIAL_RDATA_TIMESTAMP_AUTHORITY_FILE") or "").strip()
    if not raw_path:
        raise ValueError(
            "UK_AQ_OFFICIAL_RDATA_TIMESTAMP_AUTHORITY_FILE is required for "
            "official RData APPLY"
        )
    path = Path(raw_path)
    try:
        body = path.read_bytes()
        artifact = json.loads(body)
    except (OSError, ValueError) as exc:
        raise ValueError(
            "official RData timestamp authority artifact is unavailable or invalid"
        ) from exc
    if (
        not isinstance(artifact, dict)
        or set(artifact) != {
            "contract_version", "status", "source_adapter", "timestamp_mapping",
            "unit_authority", "comparisons",
        }
        or artifact["contract_version"] != CONTRACT
        or artifact["status"] != "accepted"
        or artifact["source_adapter"] != source_adapter
        or artifact["timestamp_mapping"] != TIMESTAMP_MAPPING
        or artifact["unit_authority"] != UNIT_AUTHORITY
        or not isinstance(artifact["comparisons"], list)
    ):
        raise ValueError("official RData timestamp and unit authority is not accepted")
    seasons: set[str] = set()
    for comparison in artifact["comparisons"]:
        if not isinstance(comparison, dict) or set(comparison) != {
            "source_adapter", "site_code", "pollutant_code", "graph", "rdata",
            "canonical", "europe_london_offset", "hour_convention",
        }:
            raise ValueError("official RData comparison shape is invalid")
        graph = comparison["graph"]
        rdata = comparison["rdata"]
        canonical = comparison["canonical"]
        site = comparison["site_code"]
        if (
            comparison["source_adapter"] != source_adapter
            or not isinstance(site, str) or not _SITE.fullmatch(site)
            or comparison["pollutant_code"] not in _POLLUTANTS
            or comparison["hour_convention"] != HOUR_CONVENTION
            or not isinstance(graph, dict) or set(graph) != {
                "original_timestamp", "interpreted_europe_london",
                "observed_at_utc", "value", "unit",
            }
            or not isinstance(rdata, dict) or set(rdata) != {
                "source_url", "source_file_sha256", "object_name",
                "original_timestamp", "source_timezone", "observed_at_utc",
                "value", "unit",
            }
            or not isinstance(canonical, dict) or set(canonical) != {
                "observed_at_utc", "value", "unit",
            }
        ):
            raise ValueError("official RData comparison identity is invalid")
        source_utc = _instant(rdata["observed_at_utc"])
        source_file = f"{site}_{source_utc.year}.RData"
        if (
            rdata["source_url"] != NETWORKS[source_adapter].base_url + source_file
            or rdata["object_name"] != source_file.removesuffix(".RData")
            or not isinstance(rdata["source_file_sha256"], str)
            or not _SHA256.fullmatch(rdata["source_file_sha256"])
            or rdata["source_timezone"] != "GMT"
            or not all(isinstance(item["value"], str) for item in (graph, rdata, canonical))
            or not all(isinstance(item["unit"], str) and item["unit"]
                       for item in (graph, rdata, canonical))
            or graph["unit"] != rdata["unit"]
            or graph["unit"] != canonical["unit"]
            or not graph["original_timestamp"]
        ):
            raise ValueError("official RData comparison source or unit is invalid")
        try:
            values = tuple(float(item["value"]) for item in (graph, rdata, canonical))
        except (TypeError, ValueError, OverflowError) as exc:
            raise ValueError("official RData comparison value is invalid") from exc
        if not all(math.isfinite(value) for value in values) or len(set(values)) != 1:
            raise ValueError("official RData comparison measurements disagree")
        canonical_utc = _instant(canonical["observed_at_utc"])
        if (
            _instant(graph["observed_at_utc"]) != canonical_utc
            or _instant(graph["interpreted_europe_london"]) != canonical_utc
            or _instant(rdata["original_timestamp"], source_gmt=True) != source_utc
            or source_utc != canonical_utc
        ):
            raise ValueError("official RData comparison timestamps disagree")
        offset = canonical_utc.astimezone(ZoneInfo("Europe/London")).utcoffset()
        expected_offset = "+01:00" if offset == dt.timedelta(hours=1) else "+00:00"
        if (
            comparison["europe_london_offset"] != expected_offset
            or not graph["interpreted_europe_london"].endswith(expected_offset)
        ):
            raise ValueError("official RData graph timezone comparison is invalid")
        seasons.add("bst" if expected_offset == "+01:00" else "gmt")
    if seasons != {"gmt", "bst"}:
        raise ValueError(
            "official RData network lacks accepted GMT and BST comparisons"
        )
    return path.resolve(), {
        **artifact,
        "artifact_sha256": hashlib.sha256(body).hexdigest(),
    }


def freeze_timestamp_authority(
    run_state: dict[str, Any], env: Mapping[str, str],
) -> dict[str, Any]:
    path, authority = load_timestamp_authority(
        str(run_state.get("official_rdata_source_adapter") or ""), env,
    )
    run_state["official_rdata_timestamp_authority_artifact_path"] = str(path)
    run_state["official_rdata_timestamp_authority"] = authority
    return authority


def require_frozen_timestamp_authority(
    run_state: Mapping[str, Any], env: Mapping[str, str],
) -> dict[str, Any]:
    path, authority = load_timestamp_authority(
        str(run_state.get("official_rdata_source_adapter") or ""), env,
    )
    if (
        run_state.get("official_rdata_timestamp_authority") != authority
        or run_state.get("official_rdata_timestamp_authority_artifact_path") != str(path)
    ):
        raise ValueError("official RData timestamp authority changed after proposal freeze")
    return authority
