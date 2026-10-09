"""Google Cloud identity-token configuration, acquisition and preflight."""

from __future__ import annotations

from dataclasses import dataclass
import subprocess
from typing import Mapping
from urllib.parse import urlparse


IDENTITY_TOKEN_TIMEOUT_SECONDS = 60
PRIVATE_RECONCILIATION_PATH = "/internal/integrity-reconcile"
LATEST_SNAPSHOT_POLLUTANTS = frozenset({"pm25", "pm10", "no2"})


@dataclass(frozen=True)
class LatestSnapshotAuthConfig:
    url: str
    audience: str
    timeout_seconds: int
    account: str | None
    impersonated_service_account: str | None


def should_preflight_latest_snapshot_auth(
    *,
    current_state_enabled: bool,
    selected_pollutants: set[str] | frozenset[str],
    canonical_mutation_planned: bool,
    proposals_validated: bool,
    check_only: bool,
    dry_run: bool,
) -> bool:
    """Return whether a real mutation must prove token capability first."""
    return bool(
        current_state_enabled
        and set(selected_pollutants) & LATEST_SNAPSHOT_POLLUTANTS
        and canonical_mutation_planned
        and proposals_validated
        and not check_only
        and not dry_run
    )


def validate_latest_snapshot_auth_config(
    settings: Mapping[str, str],
) -> LatestSnapshotAuthConfig:
    """Validate that route and token audience describe the same HTTPS service."""
    url = str(settings.get("UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_URL") or "").strip()
    audience = str(
        settings.get("UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_AUDIENCE") or ""
    ).strip()
    route = urlparse(url)
    origin = urlparse(audience)
    if (
        route.scheme != "https"
        or not route.netloc
        or route.path.rstrip("/") != PRIVATE_RECONCILIATION_PATH
        or route.params
        or route.query
        or route.fragment
    ):
        raise RuntimeError(
            "UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_URL must be the HTTPS "
            f"{PRIVATE_RECONCILIATION_PATH} route"
        )
    if (
        origin.scheme != "https"
        or not origin.netloc
        or origin.path not in {"", "/"}
        or origin.params
        or origin.query
        or origin.fragment
    ):
        raise RuntimeError(
            "UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_AUDIENCE must be the "
            "HTTPS Cloud Run service origin"
        )
    if (route.scheme, route.netloc) != (origin.scheme, origin.netloc):
        raise RuntimeError(
            "Latest Snapshot reconciliation URL and audience must use the same service origin"
        )
    try:
        timeout_seconds = int(str(settings.get(
            "UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_TIMEOUT_SECONDS", "300"
        )))
    except ValueError as exc:
        raise RuntimeError(
            "UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_TIMEOUT_SECONDS must be an integer"
        ) from exc
    if not 1 <= timeout_seconds <= 900:
        raise RuntimeError(
            "UK_AQ_INTEGRITY_LATEST_SNAPSHOT_RECONCILE_TIMEOUT_SECONDS must be between 1 and 900"
        )
    return LatestSnapshotAuthConfig(
        url=url,
        audience=audience.rstrip("/"),
        timeout_seconds=timeout_seconds,
        account=str(settings.get("CLOUDSDK_CORE_ACCOUNT") or "").strip() or None,
        impersonated_service_account=str(
            settings.get("CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT") or ""
        ).strip() or None,
    )


def build_identity_token_command(
    audience: str,
    *,
    account: str | None = None,
    impersonated_service_account: str | None = None,
) -> list[str]:
    resolved_audience = str(audience or "").strip()
    if not resolved_audience:
        raise RuntimeError(
            "Google Cloud identity token audience is required for Latest Snapshot invocation"
        )
    command = ["gcloud", "auth", "print-identity-token"]
    if account:
        command.append(f"--account={account}")
    if impersonated_service_account:
        command.append(
            f"--impersonate-service-account={impersonated_service_account}"
        )
    command.append(f"--audiences={resolved_audience}")
    return command


def _bounded_detail(value: object) -> str:
    detail = " ".join(str(value or "").split())
    return detail if len(detail) <= 500 else detail[:497].rstrip() + "..."


def acquire_identity_token(
    audience: str,
    *,
    settings: Mapping[str, str],
) -> str:
    """Acquire one audience-specific token with no identity fallback."""
    command = build_identity_token_command(
        audience,
        account=str(settings.get("CLOUDSDK_CORE_ACCOUNT") or "").strip() or None,
        impersonated_service_account=str(
            settings.get("CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT") or ""
        ).strip() or None,
    )
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
            timeout=IDENTITY_TOKEN_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        detail = _bounded_detail(exc)
        raise RuntimeError(
            "Google Cloud identity token acquisition could not run gcloud"
            + (f": {detail}" if detail else "")
        ) from exc
    stderr = _bounded_detail(completed.stderr)
    if completed.returncode != 0:
        raise RuntimeError(
            "Google Cloud identity token acquisition failed for Latest Snapshot "
            f"invocation (gcloud exit {completed.returncode})"
            + (f": {stderr}" if stderr else "")
        )
    token = str(completed.stdout or "").strip()
    if not token:
        raise RuntimeError(
            "Google Cloud identity token acquisition returned an empty token for "
            "Latest Snapshot invocation"
            + (f": {stderr}" if stderr else "")
        )
    return token


def preflight_latest_snapshot_auth(settings: Mapping[str, str]) -> dict[str, object]:
    """Prove token capability and immediately discard the acquired token."""
    config = validate_latest_snapshot_auth_config(settings)
    acquire_identity_token(config.audience, settings=settings)
    return {
        "required": True,
        "attempted": True,
        "status": "ok",
        "audience": config.audience,
        "token_retained": False,
    }
