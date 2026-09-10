#!/usr/bin/env python3
"""Independent bounded product/refresher. No HTTP listener or upstream writes."""
from __future__ import annotations
import argparse
import concurrent.futures
import signal
import threading
import time
from datetime import datetime, timezone, timedelta
import uk_aq_dashboard_cache as cache
import uk_aq_dashboard_rolling_cache as rolling
from uk_aq_dashboard_direct_r2_patch import install
from uk_aq_dashboard_history_generation import resolve_history_generation

_STOP = threading.Event()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true", help="Refresh the fixed product set once (real upstream/MySQL operations)")
    args = parser.parse_args()
    cache._WRITER = True
    if not cache.enabled(): raise SystemExit("Dashboard MySQL cache must be enabled")
    cache.configuration("writer")
    core = install()
    import os
    key = os.getenv("SB_SECRET_KEY") or ""
    base = core._ensure_allowed_base_url(os.getenv("SUPABASE_URL", "").rstrip("/") + "/rest/v1")
    if not key: raise SystemExit("Missing dashboard upstream service credential")
    directory = cache.request_dir()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    import fcntl
    lock_file = (directory / "refresher.lock").open("a")
    try: fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError: raise SystemExit("Dashboard cache refresher already running")
    for sig in (signal.SIGTERM, signal.SIGINT): signal.signal(sig, lambda *_: _STOP.set())
    next_due = {name: 0.0 for name in cache.PRODUCT_SECONDS}
    active = {}; seen_markers = {}; generation = None; completed = set(); failed = set(); pending_refresh = set()
    pending_daily_day = None

    def refresh(product, expected, requested_daily_day=None):
        try:
            if product != "daily_task_runs":
                actual = core._ensure_history_generation()["version"]
                if actual != expected: raise RuntimeError("generation_changed")

            if product == "daily_task_runs":
                try:
                    rolling.sync_daily_task_runs(core, force_day=requested_daily_day)
                except Exception:
                    rolling.record_sync_failure("daily_task_runs")
                    raise
            elif product == "dashboard":
                try:
                    rolling.sync_ingest_runs(core, base_url=base, service_role_key=key)
                except Exception:
                    rolling.record_sync_failure("ingest_runs")
                    raise
            elif product == "metric_context":
                try:
                    rolling.sync_service_egress(core)
                except Exception:
                    rolling.record_sync_failure("service_egress_metrics_minute")
                    raise
                try:
                    rolling.sync_size_metrics(core, ingest_base=base, ingest_key=key)
                except Exception:
                    rolling.record_sync_failure("db_size_metrics_hourly")
                    rolling.record_sync_failure("schema_size_metrics_hourly")
                    raise

            payload = cache.build_product(core, product, base, key)
            resolution = None
            if product != "daily_task_runs":
                resolution = resolve_history_generation(force=True)
                if resolution["version"] != expected: raise RuntimeError("generation_changed")
            expires = cache.utcnow() + timedelta(seconds=cache.PRODUCT_SECONDS[product])
            if product == "storage_coverage":
                expires = core._next_storage_coverage_refresh(datetime.now(timezone.utc)).replace(tzinfo=None)
            if product != "daily_task_runs":
                payload["r2_history_read_version"] = resolution
            if product == "r2_metrics":
                try:
                    rolling.store_r2_usage(payload.get("r2_usage"))
                except Exception:
                    rolling.record_sync_failure("r2_usage_hourly")
                    raise
            cache.publish(product, expected, payload, expires)
            print(f"dashboard_cache_refresh product={product} generation={expected} status=success", flush=True)
            return max(1, (expires - cache.utcnow()).total_seconds()), True
        except Exception:
            try: cache.record_failure(product, expected)
            except Exception: pass
            print(f"dashboard_cache_refresh product={product} generation={expected} status=failed", flush=True)
            return max(60, min(300, cache.PRODUCT_SECONDS[product])), False
        finally:
            try: core._flush_dashboard_service_egress_metrics()
            except Exception: pass

    with concurrent.futures.ThreadPoolExecutor(max_workers=len(next_due)) as executor:
        while not _STOP.is_set():
            now = time.monotonic()
            try:
                selected = core._ensure_history_generation()["version"]
            except Exception:
                selected = None
            if selected and selected != generation:
                generation = selected
                for name in next_due:
                    if name != "daily_task_runs": next_due[name] = 0
            for name, (future, started_generation) in list(active.items()):
                if future.done():
                    try: delay, success = future.result()
                    except Exception: delay, success = 60, False
                    next_due[name] = now + delay
                    if success: failed.discard(name)
                    else: failed.add(name)
                    if (name != "daily_task_runs" and started_generation != selected) or name in pending_refresh:
                        next_due[name] = 0
                        pending_refresh.discard(name)
                    del active[name]; completed.add(name)
            for name in next_due:
                marker = directory / f"refresh-{name}"
                stamp = marker.stat().st_mtime_ns if marker.exists() else 0
                if stamp != seen_markers.get(name, 0):
                    if name == "daily_task_runs":
                        requested = cache.requested_daily_task_refresh_day()
                        if requested is not None:
                            pending_daily_day = requested
                    if name in active: pending_refresh.add(name)
                    else: next_due[name] = 0
                    seen_markers[name] = stamp
                if name in active or now < next_due[name] or (args.once and name in completed): continue
                if name != "daily_task_runs" and not selected: continue
                target = "none" if name == "daily_task_runs" else selected
                requested_day = pending_daily_day if name == "daily_task_runs" else None
                if name == "daily_task_runs":
                    pending_daily_day = None
                active[name] = (executor.submit(refresh, name, target, requested_day), target)
            if args.once and len(completed) == len(next_due): break
            if args.once and not selected and not active: raise SystemExit("History authority unavailable")
            _STOP.wait(2)
    lock_file.close()
    if args.once and failed: raise SystemExit(1)


if __name__ == "__main__":
    main()
