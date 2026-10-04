#!/usr/bin/env python3
"""Acquire verification source evidence through active Integrity adapters.

This helper deliberately emits semantic candidate inputs separately from the
volatile acquisition audit consumed by the Node coordinator.
"""

from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import json
import logging
import os
from pathlib import Path
import sys
import time
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[3]
INTEGRITY_IMPL = (
    REPO_ROOT
    / "scripts/uk-aq-history-integrity/bin/uk-aq-history-integrity-sos-light-v3_impl.py"
)


def load_integrity() -> Any:
    bin_dir = str(INTEGRITY_IMPL.parent)
    if bin_dir not in sys.path:
        sys.path.insert(0, bin_dir)
    spec = importlib.util.spec_from_file_location(
        "uk_aq_integrity_verification_source", INTEGRITY_IMPL
    )
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load Integrity implementation: {INTEGRITY_IMPL}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def iso_days(first: str, last: str) -> list[str]:
    start = dt.date.fromisoformat(first)
    end = dt.date.fromisoformat(last)
    if start > end:
        raise ValueError("--from-day must not be after --to-day")
    return [
        (start + dt.timedelta(days=offset)).isoformat()
        for offset in range((end - start).days + 1)
    ]


def property_mappings(conn: Any) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT connector_id, source_label, source_uom, observed_property_id,
               observed_property_code, mapping_kind, is_aqi_eligible, is_active
        FROM core_observed_property_mappings_snapshot
        WHERE connector_id = 1
        ORDER BY source_label, id
        """
    ).fetchall()
    return [
        {
            "connector_id": int(row[0]),
            "source_label": str(row[1] or ""),
            "source_uom": row[2],
            "observed_property_id": int(row[3]) if row[3] is not None else None,
            "observed_property_code": row[4],
            "mapping_kind": str(row[5] or "unknown"),
            "is_aqi_eligible": bool(row[6]),
            "is_active": bool(row[7]),
        }
        for row in rows
    ]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, choices=("sos", "waqn", "saqn"))
    parser.add_argument("--env", required=True, choices=("TEST", "LIVE"))
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--from-day")
    parser.add_argument("--to-day")
    args = parser.parse_args()

    run_dir = Path(args.run_dir).resolve()
    run_dir.mkdir(parents=True, exist_ok=True)
    log = logging.getLogger("observation-verification-source")
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(levelname)s %(message)s")
    integrity = load_integrity()
    from integrity import official_network_rdata as official_rdata
    environment = dict(os.environ)
    environment.setdefault(
        "UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR", str(run_dir / "source-cache")
    )
    core_root = integrity.resolve_core_snapshot_root("v3", environment)
    if not core_root:
        raise RuntimeError(
            "generation-aware core root is unavailable; configure the existing "
            "UK_AQ_CORE_SNAPSHOT_DROPBOX_ROOT or R2 history local-root setting"
        )
    selected = integrity.select_latest_complete_core_snapshot(Path(core_root), log)
    conn = integrity.open_db(str(run_dir / "pinned-core.sqlite"))
    try:
        imported = integrity.import_core_snapshot(
            conn,
            args.env,
            core_root,
            False,
            False,
            log,
            selected_snapshot=selected,
        )
        if imported.get("status") not in {"imported", "reused"}:
            raise RuntimeError(
                f"pinned core import failed: status={imported.get('status')} "
                f"error={imported.get('error')}"
            )
        core_identity = imported.get("core_snapshot_identity")
        if not isinstance(core_identity, dict):
            raise RuntimeError("pinned core import returned no authenticated identity")

        if args.source in {"waqn", "saqn"}:
            config = integrity.OFFICIAL_RDATA_NETWORKS[args.source]
            bindings, mapping_hash, observed_property_hash, mapping_audit = (
                integrity._official_rdata_bindings(
                    conn,
                    source_key=args.source,
                    selected_pollutants=sorted(
                        set(integrity.RDATA_COLUMN_TO_POLLUTANT.values())
                    ),
                )
            )
            connector_ids = {
                int(row[0])
                for row in conn.execute(
                    "SELECT DISTINCT connector_id FROM source_station_timeseries_lookup "
                    "WHERE source_key = ?",
                    (args.source,),
                ).fetchall()
            }
            if connector_ids != {config.connector_id}:
                raise RuntimeError(
                    f"{args.source} connector mismatch: expected={config.connector_id} "
                    f"resolved={sorted(connector_ids)}"
                )
            metadata_url = config.base_url.rstrip("/") + "/" + config.metadata_filename
            metadata_path = run_dir / "source" / config.metadata_filename
            pinned = integrity.download_official_rdata_pinned(
                metadata_url, metadata_path
            )
            metadata_rows = integrity.extract_official_rdata_metadata(
                metadata_path, config=config
            )
            decoder = integrity.official_rdata_rscript_identity()
            candidate_rows: list[dict[str, Any]] = []
            boundaries: list[dict[str, Any]] = []
            for site_code, pollutant_bindings in sorted(bindings.items()):
                for pollutant_code, binding in sorted(pollutant_bindings.items()):
                    boundary, raw = official_rdata.metadata_boundary(
                        metadata_rows,
                        site_code=site_code,
                        pollutant_code=pollutant_code,
                    )
                    canonical_boundary = boundary.isoformat() if boundary else None
                    candidate_rows.append(
                        {
                            "connector_id": config.connector_id,
                            "station_id": int(binding["station_id"]),
                            "timeseries_id": int(binding["timeseries_id"]),
                            "pollutant_code": pollutant_code,
                            "site_id": site_code,
                            "parameter": official_rdata.POLLUTANT_TO_METADATA_PARAMETER[
                                pollutant_code
                            ],
                            "ratified_to": canonical_boundary,
                        }
                    )
                    boundaries.append(
                        {
                            "site_id": site_code,
                            "parameter": official_rdata.POLLUTANT_TO_METADATA_PARAMETER[
                                pollutant_code
                            ],
                            "timeseries_id": int(binding["timeseries_id"]),
                            "raw_ratified_to": raw,
                            "canonical_ratified_to": canonical_boundary,
                        }
                    )
            result = {
                "schema_version": 1,
                "source": args.source,
                "connector_id": config.connector_id,
                "core_identity": core_identity,
                "semantic_source_identity": {
                    "source_system": "official-network-rdata",
                    "network": args.source,
                    "connector_id": config.connector_id,
                    "metadata_url_family": metadata_url,
                    "metadata_object": config.metadata_object,
                    "verification_model": "ratification-boundary-v1",
                },
                "timeseries": candidate_rows,
                "coverage_readiness": {
                    "publishable": False,
                    "reason": (
                        f"{args.source} active core bindings do not prove the complete "
                        "retained canonical connector timeseries scope; first publication "
                        "requires an authenticated retained-scope inventory"
                    ),
                    "binding_scope": "active_generation_aware_core",
                },
                "acquisition_audit": {
                    "connector_id": config.connector_id,
                    "network": args.source,
                    "metadata_url": pinned["url"],
                    "retrieved_at_utc": dt.datetime.now(dt.timezone.utc).isoformat(),
                    "metadata_byte_size": pinned["bytes"],
                    "metadata_sha256": pinned["sha256"],
                    "etag": pinned.get("etag"),
                    "last_modified": pinned.get("last_modified"),
                    "temporary_path": pinned["path"],
                    "decoder_execution_identity": decoder,
                    "metadata_object": config.metadata_object,
                    "mapped_timeseries_count": len(candidate_rows),
                    "binding_mapping_sha256": mapping_hash,
                    "observed_property_mapping_sha256": observed_property_hash,
                    "mapping_diagnostics": mapping_audit,
                    "ratified_to_values": boundaries,
                    "pinned_core_identity": core_identity,
                },
            }
        else:
            if not args.from_day or not args.to_day:
                raise RuntimeError("SOS diagnostic build requires --from-day and --to-day")
            days = iso_days(args.from_day, args.to_day)
            limits = integrity.LimitTracker(None, None, time.monotonic())
            acquisition = integrity.check_sos_flat_files(
                conn,
                args.env,
                environment,
                args.from_day,
                args.to_day,
                selected_days=days,
                dry_run=False,
                run_backfill=False,
                limits=limits,
                log=log,
                concurrency=integrity.DEFAULT_CONCURRENCY,
                history_version="v3",
            )
            if not acquisition.get("ran") or acquisition.get("errors"):
                raise RuntimeError(
                    "SOS annual CSV acquisition did not complete: "
                    + json.dumps(acquisition, sort_keys=True)
                )
            bridge_path = run_dir / "source" / "sos-site-ref-bridge.json"
            registry_path = run_dir / "source" / "sos-source-label-registry.json"
            bridge = integrity.write_sos_site_ref_bridge_snapshot(
                conn=conn, connector_id=1, snapshot_path=bridge_path
            )
            registry = integrity.write_uk_air_source_label_registry_snapshot(
                conn=conn,
                connector_id=1,
                cache_root=Path(environment["UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR"])
                / "sos",
                snapshot_path=registry_path,
            )
            result = {
                "schema_version": 1,
                "source": "sos",
                "connector_id": 1,
                "core_identity": core_identity,
                "semantic_source_identity": {
                    "source_system": "uk-air-annual-csv",
                    "connector_id": 1,
                    "verification_model": "per-observation-status-v1",
                },
                "requested_days": days,
                "requested_pollutants": ["no2", "o3", "pm10", "pm25"],
                "source_root": str(
                    Path(environment["UK_AQ_HISTORY_INTEGRITY_SOURCE_CACHE_DIR"])
                    / "sos"
                ),
                "bridge_file": str(bridge_path),
                "registry_file": str(registry_path),
                "property_mappings": property_mappings(conn),
                "coverage_readiness": {
                    "publishable": False,
                    "reason": (
                        "connector-1 retained canonical history completeness cannot "
                        "yet be authenticated from an existing retained-scope index; "
                        "this range is diagnostic only"
                    ),
                    "selected_from_day": args.from_day,
                    "selected_to_day": args.to_day,
                },
                "acquisition_audit": {
                    "pinned_core_identity": core_identity,
                    "integrity_sos_acquisition": acquisition,
                    "bridge_snapshot": bridge,
                    "source_label_registry_snapshot": registry,
                },
            }
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
