"""R2 Billable Usage v1 starts and verified account-cycle ends; no recurrence math."""
from __future__ import annotations

import os
import re
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, Optional

import requests

PERIOD_SOURCE = "cloudflare_r2_billable_usage_v1"
END_SOURCE = "cloudflare_account_monthly_subscriptions_v1"
_USABLE_STATES = {"Paid", "Provisioned", "Trial", "AwaitingPayment"}
_RETIRED_STATES = {"Cancelled", "Expired", "Failed"}
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
    fresh_until = timestamp(usage.get("billing_period_fresh_until_utc"))
    anchor = timestamp(usage.get("billing_period_anchor_utc"))
    lifecycle = timestamp(usage.get("billing_period_subscription_start_utc"))
    if (not start or not anchor or not lifecycle or not anchor <= start or not lifecycle <= start
            or not verified or not fresh_until or not start <= verified <= now
            or not verified < fresh_until <= verified + timedelta(seconds=3600 if end else 300)
            or now >= fresh_until or now - start > timedelta(days=31)):
        return "R2 billing metadata stale or invalid; renewal refresh required"
    if end is None:
        return str(usage.get("billing_period_error") or "R2 end boundary unavailable; current operations withheld until renewal is verified")
    ids = usage.get("billing_period_end_subscription_ids")
    if (usage.get("billing_period_end_source") != END_SOURCE or not isinstance(ids, list) or not ids
            or any(not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", value) for value in ids)
            or len(set(ids)) != len(ids) or not start <= now < end
            or end - start > timedelta(days=31) or fresh_until > end):
        return "R2 billing end expired or unverified; renewal refresh required"
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
    deadline = timestamp(usage.get("billing_period_fresh_until_utc"))
    if deadline and (now or datetime.now(timezone.utc)) >= deadline:
        result["billing_period_status"] = "stale"
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
    # Both v1 routes are account-scoped. Info has no product-family field:
    # bind its exact subscription ID to R2 through the usage rows, never by position.
    info = _get(account, "billable-usage/info", token)
    subscriptions = info.get("subscriptions") if isinstance(info, dict) else None
    matches = [row for row in subscriptions if isinstance(row, dict) and row.get("id") == subscription] if isinstance(subscriptions, list) else []
    if not isinstance(info, dict) or info.get("covered") is not True or len(matches) != 1:
        raise ValueError("R2 Billable Usage coverage/subscription metadata missing or ambiguous")
    metadata = matches[0]
    lifecycle = timestamp(metadata.get("start_timestamp"))
    anchor = timestamp(metadata.get("billing_cycle_anchor_timestamp"))
    now = datetime.now(timezone.utc)
    if not lifecycle or not anchor or not lifecycle <= now or not anchor <= now or metadata.get("end_timestamp") is not None:
        raise ValueError("R2 Billable Usage subscription inactive or lifecycle/anchor metadata invalid")
    rows = _get(account, "billable-usage", token)
    starts = [timestamp(row.get("BillingPeriodStart")) for row in rows if isinstance(row, dict)
              and row.get("BillingAccountId") == account and row.get("SubscriptionId") == subscription
              and row.get("ServiceFamilyName") == "R2"] if isinstance(rows, list) else []
    starts = [value for value in starts if value and lifecycle <= value <= now and anchor <= value]
    if not starts:
        raise ValueError("R2 billing start missing for configured account/subscription and metadata")
    start = max(starts)  # Historical and current rows legitimately coexist.
    end = None
    end_ids = []
    end_error = "No unambiguous matching monthly account subscription period"
    try:
        account_rows = _get(account, "subscriptions", token)
        if not isinstance(account_rows, list) or not account_rows:
            raise ValueError(end_error)
        periods = []
        for row in account_rows:
            if not isinstance(row, dict):
                raise ValueError(end_error)
            if str(row.get("frequency")) in {"weekly", "quarterly", "yearly", "not-applicable"} or str(row.get("state")) in _RETIRED_STATES:
                continue
            # Do not pick the first match or ignore a conflicting usable monthly row.
            row_start = timestamp(row.get("current_period_start"))
            row_end = timestamp(row.get("current_period_end"))
            row_id = row.get("id")
            if (row.get("frequency") != "monthly" or str(row.get("state")) not in _USABLE_STATES
                    or not isinstance(row_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", row_id)
                    or row_start != start or not row_end or not start <= now < row_end
                    or row_end - start > timedelta(days=31)):
                raise ValueError(end_error)
            periods.append((row_id, row_end))
        if not periods or len({value for _, value in periods}) != 1 or len({key for key, _ in periods}) != len(periods):
            raise ValueError(end_error)
        end = periods[0][1]
        end_ids = sorted(key for key, _ in periods)
    except ValueError as exc:
        end_error = str(exc)  # End failure must not discard the R2-specific start.
    verified = datetime.now(timezone.utc)
    fresh_until = min(verified + timedelta(seconds=3600 if end else 300), start + timedelta(days=31))
    if end:
        fresh_until = min(fresh_until, end)
    period = {
        "billing_period_start_utc": iso(start), "billing_period_end_utc": iso(end) if end else None,
        "billing_period_verified_at_utc": iso(verified), "billing_period_fresh_until_utc": iso(fresh_until),
        "billing_period_source": PERIOD_SOURCE, "billing_period_account_id": account,
        "billing_period_subscription_id": subscription,
        "billing_period_anchor_utc": iso(anchor), "billing_period_subscription_start_utc": iso(lifecycle),
        "billing_period_end_source": END_SOURCE if end else None,
        "billing_period_end_subscription_ids": end_ids,
        "billing_period_status": "verified" if end else "start_only",
        "billing_period_error": None if end else f"R2 end/renewal unavailable; current operations withheld: {end_error}",
    }
    if verified >= fresh_until:
        period["billing_period_status"] = "stale"
        period["billing_period_error"] = "R2 billing metadata stale; renewal refresh required"
    return period
