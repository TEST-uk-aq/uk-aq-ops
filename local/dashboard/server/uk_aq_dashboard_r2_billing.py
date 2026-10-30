"""Verified R2 subscription periods; no locally calculated billing recurrence."""
from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import requests

PERIOD_SOURCE = "cloudflare_r2_subscription_v1"
_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$")
_OPS_VALUES = (
    "class_a_used_requests", "class_b_used_requests",
    "class_a_percent_of_free_tier", "class_b_percent_of_free_tier",
    "class_ops_unclassified_requests", "class_ops_window_start_utc", "class_ops_window_end_utc",
)


def timestamp(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not _TIMESTAMP.fullmatch(value):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except (ValueError, OverflowError):
        return None


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def configuration():
    account = str(os.getenv("UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID") or os.getenv("CLOUDFLARE_ACCOUNT_ID") or "").strip()
    subscription = str(os.getenv("UK_AQ_R2_BILLING_SUBSCRIPTION_ID") or "")
    if not re.fullmatch(r"[a-fA-F0-9]{32}", account):
        raise ValueError("R2 billing requires a valid configured R2 Cloudflare account ID")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", subscription):
        raise ValueError("Missing or invalid UK_AQ_R2_BILLING_SUBSCRIPTION_ID (verified R2 subscription required)")
    return account, subscription


def configuration_key() -> str:
    # Includes invalid values so a configuration change cannot reuse a prior response.
    return "|".join(str(os.getenv(key) or "") for key in (
        "UK_AQ_R2_CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID", "UK_AQ_R2_BILLING_SUBSCRIPTION_ID",
    ))


def configuration_valid() -> bool:
    try:
        configuration()
        return True
    except ValueError:
        return False


def period_error(usage: Any, now: Optional[datetime] = None) -> Optional[str]:
    now = now or datetime.now(timezone.utc)
    try:
        account, subscription = configuration()
    except ValueError as exc:
        return str(exc)
    if not isinstance(usage, dict):
        return "R2 billing period unavailable"
    if usage.get("billing_period_source") != PERIOD_SOURCE:
        return str(usage.get("billing_period_error") or "Verified R2 billing period missing")
    if (usage.get("billing_period_account_id") != account
            or usage.get("billing_period_subscription_id") != subscription):
        return "Verified R2 billing period missing or configuration changed"
    start = timestamp(usage.get("billing_period_start_utc"))
    end = timestamp(usage.get("billing_period_end_utc"))
    verified = timestamp(usage.get("billing_period_verified_at_utc"))
    if not start or not end or not verified or not start <= verified <= now or not start <= now < end:
        return "R2 billing period expired or invalid; authoritative subscription refresh required"
    return None


def operations_error(usage: Any, now: Optional[datetime] = None) -> Optional[str]:
    now = now or datetime.now(timezone.utc)
    error = period_error(usage, now)
    if error:
        return error
    start = timestamp(usage.get("billing_period_start_utc"))
    cutoff = timestamp(usage.get("class_ops_window_end_utc"))
    if timestamp(usage.get("class_ops_window_start_utc")) != start or not cutoff or not start <= cutoff <= now:
        return "R2 operations measurement does not match the verified billing period"
    return None


def guard_usage(usage: Any, now: Optional[datetime] = None):
    """Invalidate operations only. Storage payload and allowance display are preserved."""
    if not isinstance(usage, dict):
        return usage
    error = operations_error(usage, now)
    if not error:
        return usage
    result = dict(usage)
    for key in _OPS_VALUES:
        result[key] = None
    result["class_ops_unclassified_action_types"] = []
    result["billing_period_error"] = period_error(usage, now)
    result["class_ops_error"] = result["billing_period_error"] or usage.get("class_ops_error") or error
    return result


def _get(account: str, path: str, token: str):
    try:
        response = requests.get(
            f"https://api.cloudflare.com/client/v4/accounts/{account}/{path}",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"}, timeout=15,
        )
    except requests.RequestException as exc:
        raise ValueError(f"R2 billing metadata request failed ({exc.__class__.__name__})") from None
    if not response.ok:
        raise ValueError(f"R2 billing metadata HTTP {response.status_code}; Account Billing Read is required")
    try:
        body = response.json()
    except ValueError:
        raise ValueError("R2 billing metadata returned invalid JSON") from None
    if not isinstance(body, dict) or body.get("success") is not True or body.get("errors"):
        raise ValueError("Cloudflare R2 billing metadata request was unsuccessful")
    return body.get("result")


def fetch_period(account: str, analytics_token: str) -> Dict[str, Any]:
    configured_account, subscription = configuration()
    if account != configured_account:
        raise ValueError("R2 billing account does not match the metrics account")
    # Reuse the existing account read credential only when no dedicated token was supplied.
    dedicated = os.getenv("UK_AQ_R2_BILLING_API_TOKEN")
    token = dedicated.strip() if dedicated is not None else analytics_token
    if not token:
        raise ValueError("R2 billing requires an Account Billing Read token")
    result = _get(account, f"subscriptions/{subscription}", token)
    if (not isinstance(result, dict) or result.get("id") != subscription
            or result.get("frequency") != "monthly"
            or str(result.get("state")) not in {"Paid", "Provisioned", "Trial", "AwaitingPayment"}):
        raise ValueError("Configured R2 subscription is missing, inactive or not monthly")
    start = timestamp(result.get("current_period_start"))
    end = timestamp(result.get("current_period_end"))
    now = datetime.now(timezone.utc)
    if not start or not end or not start <= now < end:
        raise ValueError("Cloudflare subscription did not return valid current-period timestamps")
    # A generic subscription response alone does not establish that it belongs to R2.
    rows = _get(account, "billable-usage", token)
    r2_rows = [row for row in rows if isinstance(row, dict)
               and row.get("BillingAccountId") == account and row.get("SubscriptionId") == subscription
               and row.get("ServiceFamilyName") == "R2"] if isinstance(rows, list) else []
    if not r2_rows or any(timestamp(row.get("BillingPeriodStart")) != start for row in r2_rows):
        raise ValueError("R2 subscription/period could not be verified against current Billable Usage (data may lag)")
    period = {
        "billing_period_start_utc": iso(start), "billing_period_end_utc": iso(end),
        "billing_period_verified_at_utc": iso(datetime.now(timezone.utc)),
        "billing_period_source": PERIOD_SOURCE, "billing_period_account_id": account,
        "billing_period_subscription_id": subscription, "billing_period_error": None,
    }
    error = period_error(period)
    if error:
        raise ValueError(error)
    return period
