#!/usr/bin/env python3
"""Read-only UTC Daily Task Health digest and optional Google Workspace SMTP delivery."""

from __future__ import annotations

import argparse
from datetime import date, datetime, time, timedelta, timezone
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid
import html
import json
import os
from pathlib import Path
import re
import smtplib
import ssl
import sys
import tomllib
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

UTC = timezone.utc
ROW_LIMIT = 1000
REPORT_DIR = Path("tmp/daily_task_health_email")
SMTP_RELAY_HOST = "smtp-relay.gmail.com"  # Shared Google Workspace provider host, same in TEST and LIVE
WHO_TASK_KEY = "ops.who_2021_daily"
WHO_SCHEDULER_JOB = "uk_aq_who_2021_daily"
SCHEDULER_MANIFEST = Path("cloudflare/scheduler/jobs.toml")
MAILBOX = re.compile(r"^[A-Za-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"Missing required configuration: {name}")
    return value


def utc_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        result = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return result.astimezone(UTC) if result.tzinfo else result.replace(tzinfo=UTC)


def summary_object(value: object) -> dict:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def fetch_rows(table: str, parameters: dict[str, str]) -> list[dict]:
    if table not in {"daily_task_definitions", "daily_task_runs_dashboard"}:
        raise ValueError("Invalid health read target")
    base = require_env("OBS_AQIDB_SUPABASE_URL").rstrip("/")
    if not base.startswith("https://"):
        raise ValueError("OBS_AQIDB_SUPABASE_URL must be HTTPS")
    secret = require_env("OBS_AQIDB_SECRET_KEY")
    schema = os.environ.get("UK_AQ_OPS_SCHEMA", "uk_aq_ops").strip()
    if not re.fullmatch(r"[a-z][a-z0-9_]*", schema):
        raise ValueError("Invalid UK_AQ_OPS_SCHEMA")
    query = dict(parameters)
    query["limit"] = str(ROW_LIMIT)
    url = f"{base}/rest/v1/{table}?{urlencode(query)}"
    req = Request(url, headers={
        "apikey": secret,
        "Authorization": f"Bearer {secret}",
        "Accept-Profile": schema,
        "Accept": "application/json",
    })
    try:
        with urlopen(req, timeout=25) as response:
            body = response.read(5_000_001)
    except (HTTPError, URLError, TimeoutError) as exc:
        raise RuntimeError(f"Daily Task Health read failed for {table}") from None
    if len(body) > 5_000_000:
        raise RuntimeError("Daily Task Health response exceeded size limit")
    try:
        data = json.loads(body)
    except (UnicodeError, json.JSONDecodeError):
        raise RuntimeError("Invalid Daily Task Health response") from None
    if not isinstance(data, list) or any(not isinstance(item, dict) for item in data):
        raise RuntimeError("Invalid Daily Task Health rows")
    if len(data) >= ROW_LIMIT:
        raise RuntimeError(f"Daily Task Health {table} reached row limit; refusing partial digest")
    return data


def clock(value: object) -> str:
    moment = utc_timestamp(value)
    return moment.strftime("%H:%M UTC") if moment else "time unavailable"


def label_time(row: dict) -> str:
    return clock(row.get("started_at") or row.get("finished_at")
                 or row.get("failed_at") or row.get("scheduled_at_utc"))


def run_time(row: dict, *, use_scheduled_fallback: bool) -> datetime | None:
    for name in ("started_at", "finished_at", "failed_at"):
        moment = utc_timestamp(row.get(name))
        if moment is not None:
            return moment
    return utc_timestamp(row.get("scheduled_at_utc")) if use_scheduled_fallback else None


def clean(value: object, limit: int = 200) -> str:
    if value is None:
        return ""
    return " ".join(str(value).split())[:limit]


def warning_reasons(summary: dict) -> list[str]:
    warnings = summary.get("warnings")
    if not isinstance(warnings, list):
        return []
    details = []
    for warning in warnings[:3]:
        if isinstance(warning, dict):
            text = warning.get("reason") or warning.get("message") or warning.get("code")
        else:
            text = warning
        if clean(text):
            details.append(clean(text))
    if len(warnings) > 3:
        details.append(f"+{len(warnings) - 3} additional warnings")
    return details


def make_entry(row: dict) -> dict:
    summary = summary_object(row.get("summary"))
    status = clean(row.get("raw_status"), 40).lower()
    name = clean(row.get("task_name") or row.get("task_key") or "Unknown task", 120)
    details = warning_reasons(summary)
    failed_count = 0
    if clean(row.get("task_key")) == "ops.history_integrity":
        for name_of_count in ("backfills_failed", "aqi_rebuilds_failed"):
            try:
                failed_count += max(0, int(summary.get(name_of_count) or 0))
            except (TypeError, ValueError):
                pass
    if row.get("failed_at") or status in {"failed", "error"}:
        group, state = "failed", "Failed"
        detail = clean(row.get("error_message") or
                       (summary.get("error") or {}).get("message")
                       if isinstance(summary.get("error"), dict)
                       else row.get("error_message"))
        detail = detail or "The task reported a failure"
    elif row.get("finished_at") or status in {"finished", "success", "ok", "completed"}:
        if failed_count:
            group, state = "warnings", "Finished with errors"
            detail = f"{failed_count} reported failed Integrity operations"
        elif isinstance(summary.get("warnings"), list) and summary["warnings"]:
            group, state = "warnings", "Finished with warnings"
            detail = "; ".join(details) or "Warnings in task summary"
        else:
            group, state, detail = "finished", "Finished", ""
    else:
        group, state = "warnings", "Not finished"
        detail = "The run has not reported successful completion"
    link = row.get("log_url")
    if not isinstance(link, str) or not re.fullmatch(r"https://[^\s<>\"']{1,1000}", link):
        link = None
    return {
        "group": group, "status": state, "task": name, "time": label_time(row),
        "detail": detail, "link": link, "run_id": clean(row.get("run_id"), 90),
    }


def time_value(value: object) -> time | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return time.fromisoformat(value.strip().removesuffix("Z"))
    except ValueError:
        return None


def expected_who_slots() -> list[time]:
    """Derive both daily WHO dispatch slots from the canonical UTC scheduler manifest.

    The DB task definition has only one scheduled_time_utc per task and cannot
    establish that TWO independent WHO runs are expected each day.
    """
    try:
        manifest = tomllib.loads(SCHEDULER_MANIFEST.read_text(encoding="utf-8"))
        job = manifest["jobs"][WHO_SCHEDULER_JOB]
        if job.get("enabled") is not True or job.get("dry_run") is True:
            raise ValueError("WHO scheduling is disabled or dry-run")
        if job.get("target_type") != "github_workflow":
            raise ValueError("WHO scheduler target type has changed")
        parts = str(job["cron_expr"]).split()
        if len(parts) != 5 or parts[2:] != ["*", "*", "*"]:
            raise ValueError("WHO requires a daily UTC cron expression")
        if not re.fullmatch(r"\d{1,2}", parts[0]):
            raise ValueError("Unsupported WHO cron minute")
        minute = int(parts[0])
        if minute > 59 or not re.fullmatch(r"\d{1,2}(?:,\d{1,2})*", parts[1]):
            raise ValueError("Unsupported WHO cron hour list")
        hours = [int(hour) for hour in parts[1].split(",")]
        if any(hour > 23 for hour in hours) or len(set(hours)) != len(hours):
            raise ValueError("Invalid WHO cron hour list")
        slots = sorted(time(hour, minute) for hour in hours)
        if (len(slots) != 2 or not time(0, 0) <= slots[0] < time(7, 0)
                or not time(7, 0) <= slots[1] < time(10, 0)):
            raise ValueError("WHO must have an early and a late daily slot")
        return slots
    except (OSError, KeyError, TypeError, tomllib.TOMLDecodeError, ValueError):
        raise RuntimeError("Invalid or unavailable canonical WHO 2021 schedule") from None


def build_period(day: date, start_hour: int, end_hour: int, rows: list[dict],
                 definitions: dict[str, dict], who_slots: list[time], *,
                 check_missing: bool, label: str) -> dict:
    start = datetime.combine(day, time(start_hour, 0), tzinfo=UTC)
    end = (datetime.combine(day + timedelta(days=1), time(0, 0), tzinfo=UTC)
           if end_hour == 24 else datetime.combine(day, time(end_hour, 0), tzinfo=UTC))
    selected = []
    for row in rows:
        task_key = row.get("task_key")
        if task_key not in definitions:
            continue
        instant = run_time(row, use_scheduled_fallback=check_missing)
        if instant is not None and start <= instant < end:
            selected.append((instant, make_entry(row), task_key))
    selected.sort(key=lambda item: (item[0], item[1]["task"].lower()))
    groups = {"failed": [], "warnings": [], "finished": []}
    seen = set()
    for instant, entry, task_key in selected:
        groups[entry["group"]].append(entry)
        seen.add(task_key)

    if check_missing:
        # WHO has two canonical dispatches but just one database task definition.
        # Match the two independent slots, not merely the presence of ANY WHO run.
        for slot in who_slots:
            slot_at = datetime.combine(day, slot, tzinfo=UTC)
            if not start <= slot_at < end:
                continue
            if any(task_key == WHO_TASK_KEY and slot_at <= instant < end
                   for instant, _, task_key in selected):
                continue
            groups["warnings"].append({
                "group": "warnings", "status": "Missing",
                "task": clean(definitions[WHO_TASK_KEY].get("task_name") or WHO_TASK_KEY, 120),
                "time": f"expected {slot.strftime('%H:%M')} UTC",
                "detail": "No recorded WHO 2021 run starting after this scheduled dispatch and before the report cutoff",
                "link": None, "run_id": "",
            })

        # Other tasks use the existing per-task due threshold. A later period
        # cannot mark an earlier period's completed run as missing.
        for task_key, definition in definitions.items():
            if task_key == WHO_TASK_KEY or task_key in seen:
                continue
            if not definition.get("include_in_daily_check"):
                continue
            due = time_value(definition.get("due_time_utc"))
            scheduled = time_value(definition.get("scheduled_time_utc"))
            if (due is None or scheduled is None
                    or not time(start_hour, 0) <= scheduled < time(end_hour, 0)
                    or not time(start_hour, 0) <= due < time(end_hour, 0)):
                continue
            groups["warnings"].append({
                "group": "warnings", "status": "Missing",
                "task": clean(definition.get("task_name") or task_key, 120),
                "time": f"due {due.strftime('%H:%M')} UTC",
                "detail": (f"No recorded run in the {start_hour:02d}:00–"
                           f"{end_hour:02d}:00 UTC window"),
                "link": None, "run_id": "",
            })
    for group in groups:
        groups[group].sort(key=lambda entry: (entry["task"].lower(), entry["time"]))
    return {"day": day, "start": start_hour, "end": end_hour,
            "groups": groups, "label": label}

def format_date(day: date) -> str:
    return day.strftime("%d/%m/%Y")


def period_title(period: dict) -> str:
    return (f"{period['label']}: "
            f"{format_date(period['day'])} | {period['start']:02d}:00–"
            f"{period['end']:02d}:00 UTC")


def plain_period(period: dict) -> str:
    lines = [period_title(period)]
    for group, title in (("failed", "FAILED"), ("warnings", "WARNINGS"), ("finished", "FINISHED")):
        entries = period["groups"][group]
        lines.append(f"\n{title} ({len(entries)})")
        if not entries:
            lines.append("None")
        for entry in entries:
            lines.append(f"- {entry['task']} | {entry['status']} | {entry['time']}")
            if entry["detail"]:
                lines.append(f"  {entry['detail']}")
            if entry["link"]:
                lines.append(f"  {entry['link']}")
    return "\n".join(lines)


def html_period(period: dict) -> str:
    colours = {"failed": "#b91c1c", "warnings": "#c2410c", "finished": "#15803d"}
    titles = {"failed": "Failed", "warnings": "Warnings", "finished": "Finished"}
    result = [f'<h2 style="font-size:19px;margin:28px 0 12px">{html.escape(period_title(period))}</h2>']
    for group in ("failed", "warnings", "finished"):
        entries = period["groups"][group]
        result.append(
            f'<table role="presentation" cellpadding="0" cellspacing="0" width="100%" '
            f'style="border-collapse:collapse;margin:0 0 14px;border:1px solid #e5e7eb">'
            f'<tr><th align="left" style="background:{colours[group]};color:#fff;'
            f'padding:10px 13px;font-size:15px">{titles[group]} ({len(entries)})</th></tr>'
        )
        if not entries:
            result.append('<tr><td style="padding:10px 13px;color:#6b7280">None</td></tr>')
        for entry in entries:
            task = html.escape(entry["task"])
            stamp = html.escape(entry["time"])
            state = html.escape(entry["status"])
            detail = html.escape(entry["detail"])
            anchor = (f' <a href="{html.escape(entry["link"], quote=True)}" '
                      f'style="color:#155e75">Run details</a>') if entry["link"] else ""
            result.append(
                f'<tr><td style="border-top:1px solid #e5e7eb;padding:10px 13px;'
                f'font-size:14px;line-height:1.5"><strong>{task}</strong>'
                f'<div style="color:#374151">{state} | {stamp}{anchor}</div>'
                + (f'<div style="color:#4b5563">{detail}</div>' if detail else "")
                + "</td></tr>"
            )
        result.append("</table>")
    return "".join(result)


def counts(period: dict) -> tuple[int, int, int]:
    return tuple(len(period["groups"][group]) for group in ("failed", "warnings", "finished"))


def render(report_day: date, periods: list[dict], report_type: str) -> tuple[str, str, str]:
    failures, warnings, finished = counts(periods[0])
    dispatch_hour = "07:00" if report_type == "morning" else "10:00"
    subject = (f"UK AQ Daily Health | {format_date(report_day)} {dispatch_hour} UTC | "
               f"{failures} failed, {warnings} warnings, {finished} finished")
    header = "UK AQ Daily Task Health\nAll dates and times UTC.\n"
    plain = header + "\n\n" + "\n\n".join(plain_period(p) for p in periods)
    body = (
        '<!doctype html><html><body style="margin:0;padding:18px;background:#f5f5f5;'
        'font-family:Arial,Helvetica,sans-serif;color:#111827">'
        '<main style="max-width:680px;margin:auto;background:#fff;padding:22px">'
        '<h1 style="font-size:24px;margin:0 0 6px">UK AQ Daily Task Health</h1>'
        '<p style="color:#4b5563;margin:0">All dates and times UTC.</p>'
        + "".join(html_period(p) for p in periods)
        + '<p style="font-size:12px;color:#6b7280">Generated from UK AQ Daily Task Health records.</p>'
        '</main></body></html>'
    )
    return subject, plain, body

def valid_mailbox(value: str, setting: str) -> str:
    if not MAILBOX.fullmatch(value) or ".." in value or len(value) > 254:
        raise ValueError(f"Invalid mailbox configuration: {setting}")
    return value


def oauth_token() -> str:
    credentials = {
        "grant_type": "refresh_token",
        "client_id": require_env("GOOGLE_OAUTH_CLIENT_ID"),
        "client_secret": require_env("GOOGLE_OAUTH_CLIENT_SECRET"),
        "refresh_token": require_env("GOOGLE_OAUTH_REFRESH_TOKEN"),
    }
    req = Request(
        "https://oauth2.googleapis.com/token",
        data=urlencode(credentials).encode("ascii"),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urlopen(req, timeout=15) as response:
            data = json.loads(response.read(16385))
    except (HTTPError, URLError, TimeoutError, ValueError):
        raise RuntimeError("Google OAuth token refresh failed") from None
    token = data.get("access_token") if isinstance(data, dict) else None
    if not isinstance(token, str) or not token or len(token) > 8192:
        raise RuntimeError("Google OAuth response lacks an access token")
    scopes = data.get("scope")
    if isinstance(scopes, str) and "https://mail.google.com/" not in scopes.split():
        raise RuntimeError("Google SMTP OAuth scope is invalid")
    return token


def send(subject: str, plain: str, body: str, report_day: date, report_type: str) -> None:
    if os.environ.get("UK_AQ_HEALTH_EMAIL_SEND_ENABLED", "").lower() != "true":
        raise ValueError("UK_AQ_HEALTH_EMAIL_SEND_ENABLED must explicitly be true")
    sender = valid_mailbox(require_env("UK_AQ_HEALTH_EMAIL_FROM"), "UK_AQ_HEALTH_EMAIL_FROM")
    recipient = valid_mailbox(require_env("UK_AQ_HEALTH_EMAIL_TO"), "UK_AQ_HEALTH_EMAIL_TO")
    username = valid_mailbox(require_env("GOOGLE_SMTP_USERNAME"), "GOOGLE_SMTP_USERNAME")
    token = oauth_token()
    msg = EmailMessage()
    msg["From"] = formataddr(("UK AQ Daily Task Health", sender))
    msg["To"] = recipient
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=False, usegmt=True)
    msg["Message-ID"] = make_msgid(idstring=f"daily-health-{report_type}-{report_day.isoformat()}",
                                   domain=sender.split("@", 1)[1])
    msg.set_content(plain)
    msg.add_alternative(body, subtype="html")
    try:
        with smtplib.SMTP(host=SMTP_RELAY_HOST, port=587, timeout=35) as connection:
            connection.ehlo()
            if not connection.has_extn("starttls"):
                raise RuntimeError("SMTP STARTTLS is unavailable")
            connection.starttls(context=ssl.create_default_context())
            connection.ehlo()
            if "XOAUTH2" not in connection.esmtp_features.get("auth", "").upper().split():
                raise RuntimeError("SMTP XOAUTH2 is unavailable")
            connection.auth(
                "XOAUTH2",
                lambda challenge=None: f"user={username}\x01auth=Bearer {token}\x01\x01",
                initial_response_ok=True,
            )
            connection.send_message(msg, from_addr=sender, to_addrs=[recipient])
    except (OSError, smtplib.SMTPException):
        raise RuntimeError("SMTP submission failed or has an uncertain result") from None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report-day", help="UTC day YYYY-MM-DD, preview only for historical days")
    parser.add_argument("--report-type", choices=("morning", "supplement"),
                        default="morning", help="07:00 digest or 10:00 supplement")
    parser.add_argument("--send", action="store_true", help="Send via authenticated Google Workspace SMTP")
    args = parser.parse_args()
    now = datetime.now(UTC)
    report_day = date.fromisoformat(args.report_day) if args.report_day else now.date()
    dispatch_hour = 7 if args.report_type == "morning" else 10
    if args.send and report_day != now.date():
        raise ValueError("Sending a historical UTC report requires a separate operator procedure")
    if args.send and now.time() < time(dispatch_hour, 0):
        raise ValueError(f"The {dispatch_hour:02d}:00 UTC report cannot be sent before its window closes")

    previous_day = report_day - timedelta(days=1)
    definitions_rows = fetch_rows("daily_task_definitions", {
        "select": "task_key,task_name,is_active,include_in_email,include_in_daily_check,due_time_utc,scheduled_time_utc",
        "is_active": "eq.true", "include_in_email": "eq.true",
    })
    definitions = {row["task_key"]: row for row in definitions_rows if isinstance(row.get("task_key"), str)}
    if not definitions:
        raise RuntimeError("No email-enabled daily tasks; refusing empty report")
    if WHO_TASK_KEY not in definitions or not definitions[WHO_TASK_KEY].get("include_in_daily_check"):
        raise RuntimeError("WHO 2021 daily task is not configured for email and daily health checking")
    who_slots = expected_who_slots()

    query = {
        "select": "run_id,task_key,task_name,scheduled_for_date,scheduled_at_utc,raw_status,started_at,finished_at,failed_at,summary,error_message,log_url,attempt",
        "order": "started_at.asc.nullslast,updated_at.asc",
    }
    today_rows = fetch_rows("daily_task_runs_dashboard", {
        **query, "scheduled_for_date": f"eq.{report_day.isoformat()}"
    })
    periods = []
    if args.report_type == "morning":
        yesterday_rows = fetch_rows("daily_task_runs_dashboard", {
            **query, "scheduled_for_date": f"eq.{previous_day.isoformat()}"
        })
        periods.append(build_period(report_day, 0, 7, today_rows, definitions,
                                    who_slots, check_missing=True, label="Today"))
        periods.append(build_period(previous_day, 7, 24, yesterday_rows, definitions,
                                    who_slots, check_missing=False, label="Yesterday"))
    else:
        periods.append(build_period(report_day, 7, 10, today_rows, definitions,
                                    who_slots, check_missing=True, label="Today"))

    subject, plain, body = render(report_day, periods, args.report_type)
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    (REPORT_DIR / "report.txt").write_text(plain + "\n", encoding="utf-8")
    (REPORT_DIR / "report.html").write_text(body + "\n", encoding="utf-8")
    print(f"Daily Task Health {args.report_type} UTC {report_day.isoformat()}: "
          + "; ".join(
              f"{p['label'].lower()} {p['start']:02d}–{p['end']:02d} "
              f"failed/warnings/finished={counts(p)}"
              for p in periods
          ))
    if args.send:
        send(subject, plain, body, report_day, args.report_type)
        print("Daily Task Health SMTP submission accepted")
    else:
        print("Preview only: no email sent")
    return 0

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, RuntimeError) as exc:
        # Never echo provider responses, access tokens, SMTP challenges or credentials.
        print(f"Daily Task Health report failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
