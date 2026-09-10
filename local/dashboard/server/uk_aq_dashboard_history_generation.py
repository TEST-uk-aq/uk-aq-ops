"""Runtime authority client. Never select a generation from MySQL or dotenv."""
from __future__ import annotations
import os
import json
import copy
import threading
import time
from datetime import datetime
from urllib.parse import urlsplit, urlunsplit
import requests

_LOCK = threading.Lock()
_cached = None
_expires = 0.0
_failure_until = 0.0


def resolve_history_generation(*, force=False):
    global _cached, _expires, _failure_until
    with _LOCK:
        if not force and time.monotonic() < _failure_until:
            raise RuntimeError("Stable history generation authority unavailable")
        if not force and _cached is not None and time.monotonic() < _expires:
            return copy.deepcopy(_cached)
        _cached = None
        _expires = 0.0
        base = urlsplit(os.getenv("UK_AQ_OBSERVS_HISTORY_R2_API_URL", ""))
        token = os.getenv("UK_AQ_OBSERVS_HISTORY_R2_API_TOKEN") or os.getenv("UK_AQ_EDGE_UPSTREAM_SECRET", "")
        if base.scheme != "https" or not base.netloc or base.username or base.password or not token:
            raise RuntimeError("Stable observations-history HTTPS URL/token is required")
        url = urlunsplit((base.scheme, base.netloc, "/v1/history-generation", "", ""))
        try:
            with requests.get(url, headers={"x-uk-aq-upstream-auth": token, "Accept": "application/json"},
                              timeout=10, allow_redirects=False, stream=True) as response:
                if response.status_code != 200: raise ValueError("authority HTTP failure")
                body = bytearray()
                for chunk in response.iter_content(4096):
                    body.extend(chunk)
                    if len(body) > 16384: raise ValueError("descriptor exceeds 16 KiB")
                p = json.loads(body)
            version = p.get("read_version")
            if (p.get("ok") is not True or p.get("kind") != "uk_aq_observation_history_generation"
                    or p.get("schema_version") != 1 or version not in {"v2", "v3"}
                    or p.get("source") != "stable_observations_history_service"
                    or p.get("selector") != "UK_AQ_R2_HISTORY_VERSION"):
                raise ValueError("descriptor identity")
            datetime.fromisoformat(p["resolved_at"].replace("Z", "+00:00"))
            g = p["generation"]
            expected = {
                "version": version,
                "observations_prefix": f"history/{version}/observations",
                "observations_root_key": f"history/{version}/observations/_manifests/manifest.json",
                "observations_runs_prefix": f"history/{version}/_ops/observations/runs",
                "core_prefix": f"history/{version}/core",
                "timeseries_binding_index_prefix": f"history/_index_{version}/timeseries_binding",
                "timeseries_binding_pack_prefix": "history/_backup_packs_v1/timeseries_binding" + ("/generation=v3" if version == "v3" else ""),
                "index_root_prefix": f"history/_index_{version}",
                "observations_timeseries_index_prefix": f"history/_index_{version}/observations_timeseries",
                "observations_timeseries_latest_key": f"history/_index_{version}/observations_timeseries_latest.json",
                "backup_inventory_prefix": f"history/_index_{version}/backup_inventory_v2",
                "backup_state_prefix": "_ops/checkpoints/r2_history_backup_state_v2" + ("/generation=v3" if version == "v3" else ""),
            }
            if any(g.get(k) != value for k, value in expected.items()):
                raise ValueError("descriptor paths")
        except Exception:
            _failure_until = time.monotonic() + 15
            raise RuntimeError("Stable history generation authority unavailable or inconsistent") from None
        _cached = {"version": version, "label": f"R2_{version}", "source": p["source"], "valid": True,
                   "warning": None, "raw": version, "resolved_at": p["resolved_at"], "generation": {key: g[key] for key in expected}}
        _failure_until = 0.0
        _expires = time.monotonic() + 15
        return copy.deepcopy(_cached)
