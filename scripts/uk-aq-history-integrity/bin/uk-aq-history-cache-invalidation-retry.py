#!/usr/bin/env python3
"""Retry the original verified cache event; no repair/runtime module is loaded."""
import argparse
import json
import os
import shlex
from pathlib import Path
from integrity.history_cache import atomic_json, deliver, prepare_verified_event


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-state", type=Path, required=True)
    parser.add_argument("--max-batches", type=int, default=10, choices=range(1, 11))
    parser.add_argument("--env-file", type=Path, help="Trusted operator repository .env; read assignments without executing shell")
    args = parser.parse_args()
    settings = dict(os.environ)
    if args.env_file:
        allowed = {"UK_AQ_ENV_NAME"} | {f"UK_AQ_HISTORY_CACHE_{layer}_{field}"
                  for layer in ("READER", "PROXY") for field in ("ZONE_ID", "PURGE_TOKEN")}
        for line in args.env_file.read_text().splitlines():
            key, separator, value = line.strip().removeprefix("export ").partition("=")
            if separator and key.strip() in allowed:
                parts = shlex.split(value, comments=True)
                if len(parts) > 1:
                    parser.error("Operator cache settings must be single .env values")
                settings[key.strip()] = parts[0] if parts else ""
    if settings.get("UK_AQ_ENV_NAME") != "TEST":
        parser.error("Requires the authenticated operator's TEST repository environment")
    if "archive" in args.run_state.resolve().parts:
        parser.error("Archive execution is forbidden")
    state = json.loads(args.run_state.read_text())
    # Recover only event persistence, using the original frozen plan + verified final.
    reference = state.get("history_cache_invalidation") or {}
    if reference.get("status") == "pending" and not reference.get("event_path"):
        state["history_cache_invalidation"] = prepare_verified_event(
            state, final=state.get("history_cache_verified_final") or {},
            apply_result=state.get("history_cache_verified_apply") or {}, dry_run=False,
        )
        atomic_json(args.run_state, state)
    result = deliver(args.run_state, settings, max_batches=args.max_batches)
    print(json.dumps(result, sort_keys=True))
    return 0 if result["status"] in {"accepted", "not_required"} else 2


if __name__ == "__main__":
    raise SystemExit(main())
