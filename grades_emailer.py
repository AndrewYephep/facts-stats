"""Email notifications for grade changes, watchlist items, and errors."""

import html
import os
import re
import smtplib
import ssl
from email.message import EmailMessage
from datetime import datetime
import logging

from grades_analytics import assignment_percent, parse_number

log = logging.getLogger(__name__)


def _load_dotenv():
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if not os.path.isfile(env_path):
        return
    try:
        with open(env_path, encoding="utf-8") as handle:
            for raw_line in handle:
                line = raw_line.strip()
                if not line or line.startswith("#"):
                    continue
                if line.lower().startswith("export "):
                    line = line[7:].strip()
                key, sep, value = line.partition("=")
                if not sep:
                    continue
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
    except Exception as exc:
        log.warning("Could not load .env file: %s", exc)


def _normalize(text):
    text = "" if text is None else str(text)
    text = re.sub(r"\s+", " ", text.strip().lower())
    return text


def _assignment_key(classid, category_name, assignment):
    due = _normalize(assignment.get("due"))
    max_points = parse_number(assignment.get("max"))
    max_key = "" if max_points is None else f"{max_points:.3f}"
    return "|".join([
        str(classid),
        _normalize(category_name),
        _normalize(assignment.get("name")),
        due,
        max_key,
    ])


def _collect_assignments(data, term):
    assignments = {}
    for classid, info in (data.get("classes") or {}).items():
        class_name = info.get("class_name", "")
        quarter = (info.get("quarters") or {}).get(str(term), {})
        for cat in quarter.get("categories") or []:
            cat_name = cat.get("name", "Category")
            for assignment in cat.get("assignments") or []:
                key = _assignment_key(classid, cat_name, assignment)
                percent = assignment_percent(assignment)
                assignments[key] = {
                    "classid": classid,
                    "class_name": class_name,
                    "category": cat_name,
                    "assignment": assignment.get("name", ""),
                    "due": assignment.get("due", ""),
                    "pts": parse_number(assignment.get("pts")),
                    "max": parse_number(assignment.get("max")),
                    "percent": percent,
                }
    return assignments


def build_grade_changes(previous, current, term):
    prev_map = _collect_assignments(previous or {}, term)
    cur_map = _collect_assignments(current or {}, term)

    new_grades = []
    updated_grades = []

    for key, cur in cur_map.items():
        prev = prev_map.get(key)
        if not prev:
            if cur.get("percent") is not None:
                new_grades.append({"current": cur, "previous": None})
            continue

        prev_pct = prev.get("percent")
        cur_pct = cur.get("percent")
        if cur_pct is None and prev_pct is None:
            continue

        pts_changed = prev.get("pts") != cur.get("pts")
        max_changed = prev.get("max") != cur.get("max")
        pct_changed = prev_pct != cur_pct
        if pts_changed or max_changed or pct_changed:
            updated_grades.append({"current": cur, "previous": prev})

    new_grades.sort(key=lambda item: (
        item["current"].get("class_name", ""),
        item["current"].get("category", ""),
        item["current"].get("assignment", ""),
    ))
    updated_grades.sort(key=lambda item: (
        item["current"].get("class_name", ""),
        item["current"].get("category", ""),
        item["current"].get("assignment", ""),
    ))

    return {
        "new_grades": new_grades,
        "updated_grades": updated_grades,
    }


def _fmt_percent(value):
    if value is None:
        return ""
    return f"{value:.1f}%"


def _fmt_points(value):
    if value is None:
        return ""
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return f"{value:.1f}"


def _load_email_config():
    _load_dotenv()
    try:
        import config  # type: ignore
    except Exception:
        config = None

    def get(name, default=None):
        if config and hasattr(config, name):
            return getattr(config, name)
        return os.getenv(name, default)

    settings = {
        "SMTP_HOST": get("SMTP_HOST"),
        "SMTP_PORT": int(get("SMTP_PORT", "587")),
        "SMTP_USERNAME": get("SMTP_USERNAME"),
        "SMTP_PASSWORD": get("SMTP_PASSWORD"),
        "SMTP_FROM": get("SMTP_FROM"),
        "SMTP_TO": get("SMTP_TO"),
        "SMTP_USE_TLS": str(get("SMTP_USE_TLS", "true")).lower() == "true",
        "SMTP_USE_SSL": str(get("SMTP_USE_SSL", "false")).lower() == "true",
        "EMAIL_SUBJECT_PREFIX": get("EMAIL_SUBJECT_PREFIX", "Grades Update"),
    }

    if isinstance(settings["SMTP_TO"], str):
        settings["SMTP_TO"] = [s.strip() for s in settings["SMTP_TO"].split(",") if s.strip()]

    return settings


def _build_email_subject(prefix, meta, changes, classroom_payload=None):
    updated = meta.get("updated") or ""
    stamp = updated.replace("T", " ") if updated else datetime.now().strftime("%Y-%m-%d %H:%M")
    new_count = len(changes.get("new_grades", []))
    updated_count = len(changes.get("updated_grades", []))

    run_label = (classroom_payload or {}).get("run")
    prefix = {"morning": "Morning Report", "afternoon": "Afternoon Report"}.get(run_label, prefix)

    hw_count = sum(
        len(c.get("assignments", [])) for c in (classroom_payload or {}).get("classes", [])
    )
    hw_part = f", {hw_count} homework" if hw_count else ""

    return f"{prefix} - {new_count} new, {updated_count} updated{hw_part} ({stamp})"


def _render_table_rows(items, include_previous=False):
    rows = []
    for entry in items:
        cur = entry["current"]
        prev = entry.get("previous")
        grade = _fmt_percent(cur.get("percent"))
        pts = _fmt_points(cur.get("pts"))
        mx = _fmt_points(cur.get("max"))
        prev_grade = _fmt_percent(prev.get("percent")) if prev else ""

        change_cell = ""
        if include_previous and (prev_grade or grade):
            change_cell = (
                f"<div style=\"color:#6b7280;font-size:12px;\">"
                f"{prev_grade} -> {grade}"
                "</div>"
            )

        rows.append(
            "<tr>"
            "<td style=\"padding:10px 12px;border-bottom:1px solid #e5e7eb;\">"
            f"<div style=\"font-weight:600;color:#111827;\">{cur.get('assignment','')}</div>"
            f"<div style=\"color:#6b7280;font-size:12px;\">{cur.get('class_name','')} · {cur.get('category','')}</div>"
            f"<div style=\"color:#6b7280;font-size:12px;\">Due: {cur.get('due','')}</div>"
            "</td>"
            "<td style=\"padding:10px 12px;border-bottom:1px solid #e5e7eb;text-align:right;\">"
            f"<div style=\"font-weight:600;color:#111827;\">{pts}/{mx}</div>"
            f"<div style=\"color:#2563eb;font-weight:600;\">{grade}</div>"
            f"{change_cell}"
            "</td>"
            "</tr>"
        )
    return "".join(rows)


def _render_watchlist_rows(watchlist):
    rows = []
    for item in watchlist:
        label = item.get("label", "")
        value = _fmt_percent(item.get("value"))
        below = item.get("below_threshold")
        color = "#b91c1c" if below else "#c2410c"
        rows.append(
            "<tr>"
            "<td style=\"padding:10px 12px;border-bottom:1px solid #e5e7eb;\">"
            f"<div style=\"font-weight:600;color:#111827;\">{label}</div>"
            f"<div style=\"color:#6b7280;font-size:12px;\">{item.get('class_name','')}</div>"
            "</td>"
            "<td style=\"padding:10px 12px;border-bottom:1px solid #e5e7eb;text-align:right;\">"
            f"<div style=\"font-weight:700;color:{color};\">{value}</div>"
            "</td>"
            "</tr>"
        )
    return "".join(rows)


def _status_color(status):
    return {
        "missing": "#ef4444",
        "due_tonight": "#f59e0b",
        "upcoming": "#2563eb",
        "done": "#10b981",
    }.get(status, "#6b7280")


def render_homework_section(classroom_payload):
    """Renders the Classroom homework block, or '' if no data available."""
    if not classroom_payload or not classroom_payload.get("classes"):
        return ""

    classes = classroom_payload["classes"]
    run_label = classroom_payload.get("run", "")
    heading = "Due tonight / coming up" if run_label == "afternoon" else "Homework"

    blocks = []
    for cls in classes:
        assignments = cls.get("assignments", [])
        if not assignments:
            continue
        accent = cls.get("color") or "#2563eb"

        rows = []
        for a in assignments:
            color = _status_color(a.get("status", "upcoming"))
            due_label = a.get("due_label") or a.get("due") or ""
            title = a.get("title", "")
            if a.get("link"):
                title_html = f'<a href="{a["link"]}" style="color:#111827;text-decoration:none;">{title}</a>'
            else:
                title_html = title
            rows.append(
                "<tr>"
                "<td style=\"padding:8px 12px;border-bottom:1px solid #eef2f7;\">"
                f"<div style=\"font-weight:600;color:#111827;\">{title_html}</div>"
                "</td>"
                "<td style=\"padding:8px 12px;border-bottom:1px solid #eef2f7;text-align:right;white-space:nowrap;\">"
                f"<div style=\"font-weight:700;color:{color};font-size:12px;\">{due_label}</div>"
                "</td>"
                "</tr>"
            )

        blocks.append(
            f"<div style=\"margin-top:12px;border:1px solid #e5e7eb;border-left:3px solid {accent};"
            "border-radius:12px;padding:12px;background:#f9fafb;\">"
            f"<div style=\"font-weight:700;color:#111827;\">{cls['name']}</div>"
            "<table style=\"width:100%;border-collapse:collapse;margin-top:6px;\">"
            + "".join(rows)
            + "</table></div>"
        )

    if not blocks:
        return ""

    return (
        f"<h2 style=\"margin:24px 0 8px;font-size:18px;color:#111827;\">{heading}</h2>"
        + "".join(blocks)
    )


def _group_watchlist(watchlist):
    groups = {}
    ordered = []
    seen = set()
    for item in watchlist:
        class_name = item.get("class_name") or "Class"
        groups.setdefault(class_name, []).append(item)
        if class_name not in seen:
            seen.add(class_name)
            ordered.append(class_name)
    return [(name, groups[name]) for name in ordered]


def render_email_html(changes, watchlist, meta, classroom_payload=None):
    new_grades = changes.get("new_grades", [])
    updated_grades = changes.get("updated_grades", [])
    term = meta.get("term", "")
    year = meta.get("academic_year", "")
    updated = meta.get("updated", "")

    homework_section = render_homework_section(classroom_payload)

    summary = (
        f"<div style=\"margin-top:10px;font-size:14px;color:#111827;font-weight:600;\">"
        f"New: {len(new_grades)} · Updated: {len(updated_grades)} · Watchlist: {len(watchlist)}"
        "</div>"
    )

    new_section = (
        "<h2 style=\"margin:24px 0 8px;font-size:18px;color:#111827;\">New grades</h2>"
        if new_grades else
        "<h2 style=\"margin:24px 0 8px;font-size:18px;color:#111827;\">New grades</h2>"
        "<div style=\"color:#6b7280;\">No new graded assignments since last scrape.</div>"
    )
    if new_grades:
        new_section += (
            "<table style=\"width:100%;border-collapse:collapse;margin-top:8px;\">"
            + _render_table_rows(new_grades)
            + "</table>"
        )

    updated_section = (
        "<h2 style=\"margin:24px 0 8px;font-size:18px;color:#111827;\">Updated grades</h2>"
        if updated_grades else
        "<h2 style=\"margin:24px 0 8px;font-size:18px;color:#111827;\">Updated grades</h2>"
        "<div style=\"color:#6b7280;\">No grade changes since last scrape.</div>"
    )
    if updated_grades:
        updated_section += (
            "<table style=\"width:100%;border-collapse:collapse;margin-top:8px;\">"
            + _render_table_rows(updated_grades, include_previous=True)
            + "</table>"
        )

    watchlist_section = (
        "<h2 style=\"margin:24px 0 8px;font-size:18px;color:#111827;\">Watchlist</h2>"
    )
    if watchlist:
        grouped = _group_watchlist(watchlist)
        blocks = []
        for class_name, items in grouped:
            rows = []
            for item in items:
                label = "Class average" if item.get("kind") == "lowest_class" else item.get("category") or item.get("label", "")
                value = _fmt_percent(item.get("value"))
                below = item.get("below_threshold")
                color = "#ef4444" if below else "#f59e0b"
                rows.append(
                    "<tr>"
                    "<td style=\"padding:10px 12px;border-bottom:1px solid #eef2f7;\">"
                    f"<div style=\"font-weight:600;color:#111827;\">{label}</div>"
                    "</td>"
                    "<td style=\"padding:10px 12px;border-bottom:1px solid #eef2f7;text-align:right;\">"
                    f"<div style=\"font-weight:700;color:{color};\">{value}</div>"
                    "</td>"
                    "</tr>"
                )
            blocks.append(
                "<div style=\"margin-top:12px;border:1px solid #e5e7eb;border-radius:12px;padding:12px;background:#f9fafb;\">"
                f"<div style=\"font-weight:700;color:#111827;\">{class_name}</div>"
                "<table style=\"width:100%;border-collapse:collapse;margin-top:6px;\">"
                + "".join(rows)
                + "</table>"
                "</div>"
            )
        watchlist_section += "".join(blocks)
    else:
        watchlist_section += "<div style=\"color:#6b7280;\">No watchlist items.</div>"

    run_label = (classroom_payload or {}).get("run")
    title = {"morning": "Morning Report", "afternoon": "Afternoon Report"}.get(run_label, "Grades Update")

    html = f"""
<!DOCTYPE html>
<html>
    <body style="margin:0;padding:0;background:#f5f7fb;font-family:Segoe UI, Arial, sans-serif;">
    <div style="max-width:720px;margin:0 auto;padding:24px;">
            <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;padding:22px;">
                <div style="font-size:22px;font-weight:700;color:#111827;">{title}</div>
                <div style="color:#6b7280;margin-top:6px;">Term {term} · {year}</div>
                <div style="color:#9ca3af;margin-top:4px;font-size:12px;">Last updated: {updated}</div>
        {summary}
      </div>
            <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;padding:20px;margin-top:16px;">
        {homework_section}
        {new_section}
        {updated_section}
        {watchlist_section}
      </div>
      <div style="color:#9ca3af;text-align:center;font-size:12px;margin-top:16px;">
        Generated by Facts Scraper
      </div>
    </div>
  </body>
</html>
"""
    return html


def render_email_text(changes, watchlist, meta, classroom_payload=None):
    lines = []
    lines.append("Grades Update")
    lines.append(f"Term {meta.get('term','')} - {meta.get('academic_year','')}")
    lines.append(f"Updated: {meta.get('updated','')}")
    lines.append("")

    if classroom_payload and classroom_payload.get("classes"):
        lines.append("Homework:")
        for cls in classroom_payload["classes"]:
            assignments = cls.get("assignments", [])
            if not assignments:
                continue
            lines.append(f"{cls['name']}:")
            for a in assignments:
                due = a.get("due_label") or a.get("due") or ""
                lines.append(f"- {a.get('title','')} ({due})")
        lines.append("")

    new_grades = changes.get("new_grades", [])
    updated_grades = changes.get("updated_grades", [])

    lines.append(f"New grades: {len(new_grades)}")
    for entry in new_grades:
        cur = entry["current"]
        lines.append(f"- {cur.get('class_name','')} / {cur.get('category','')}: {cur.get('assignment','')} { _fmt_percent(cur.get('percent')) }")

    lines.append("")
    lines.append(f"Updated grades: {len(updated_grades)}")
    for entry in updated_grades:
        cur = entry["current"]
        prev = entry.get("previous") or {}
        lines.append(
            f"- {cur.get('class_name','')} / {cur.get('category','')}: {cur.get('assignment','')} { _fmt_percent(prev.get('percent')) } -> { _fmt_percent(cur.get('percent')) }"
        )

    lines.append("")
    lines.append(f"Watchlist items: {len(watchlist)}")
    for class_name, items in _group_watchlist(watchlist):
        lines.append(f"{class_name}:")
        for item in items:
            label = "Class average" if item.get("kind") == "lowest_class" else item.get("category") or item.get("label", "")
            lines.append(f"- {label} ({ _fmt_percent(item.get('value')) })")

    return "\n".join(lines)


def send_grade_email(changes, watchlist, meta, classroom_payload=None):
    settings = _load_email_config()

    if not settings["SMTP_HOST"] or not settings["SMTP_TO"] or not settings["SMTP_FROM"]:
        log.warning("Email not configured; set SMTP_HOST, SMTP_FROM, and SMTP_TO to enable emailing.")
        return False

    subject = _build_email_subject(settings["EMAIL_SUBJECT_PREFIX"], meta, changes, classroom_payload)
    html_body = render_email_html(changes, watchlist, meta, classroom_payload)
    text_body = render_email_text(changes, watchlist, meta, classroom_payload)

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = settings["SMTP_FROM"]
    msg["To"] = ", ".join(settings["SMTP_TO"])
    msg.set_content(text_body)
    msg.add_alternative(html_body, subtype="html")

    context = ssl.create_default_context()
    try:
        if settings["SMTP_USE_SSL"]:
            with smtplib.SMTP_SSL(settings["SMTP_HOST"], settings["SMTP_PORT"], context=context) as server:
                if settings["SMTP_USERNAME"] and settings["SMTP_PASSWORD"]:
                    server.login(settings["SMTP_USERNAME"], settings["SMTP_PASSWORD"])
                server.send_message(msg)
        else:
            with smtplib.SMTP(settings["SMTP_HOST"], settings["SMTP_PORT"]) as server:
                if settings["SMTP_USE_TLS"]:
                    server.starttls(context=context)
                if settings["SMTP_USERNAME"] and settings["SMTP_PASSWORD"]:
                    server.login(settings["SMTP_USERNAME"], settings["SMTP_PASSWORD"])
                server.send_message(msg)
        log.info("Email sent to %s", ", ".join(settings["SMTP_TO"]))
        return True
    except Exception as exc:
        log.error("Email send failed: %s", exc)
        return False


def send_error_email(subject, message, logs, details=None):
        settings = _load_email_config()

        if not settings["SMTP_HOST"] or not settings["SMTP_TO"] or not settings["SMTP_FROM"]:
                log.warning("Error email not configured; set SMTP_HOST, SMTP_FROM, and SMTP_TO to enable notifications.")
                return False

        safe_message = html.escape(str(message or "Unknown error"))
        safe_subject = str(subject or "GradeTrack Error")
        safe_details = html.escape(str(details or "")) if details else ""
        safe_logs = html.escape(str(logs or ""))

        html_body = f"""
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;background:#0a0a0f;color:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:760px;margin:0 auto;padding:24px;">
        <div style="background:#12121b;border:1px solid #22222e;border-radius:16px;padding:24px;">
            <div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#60a5fa;margin-bottom:8px;">GradeTrack Error</div>
            <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#fff;">{safe_subject}</h1>
            <div style="background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.18);border-radius:12px;padding:16px;margin-bottom:16px;">
                <div style="font-size:14px;color:#fecaca;font-weight:600;margin-bottom:6px;">Message</div>
                <div style="font-size:14px;line-height:1.6;color:#f3f4f6;white-space:pre-wrap;">{safe_message}</div>
            </div>
            {f'<div style="margin-bottom:16px;padding:14px;border:1px solid #2a2a36;border-radius:12px;background:#0a0a0f;color:#d1d5db;font-size:13px;line-height:1.6;white-space:pre-wrap;">{safe_details}</div>' if safe_details else ''}
            <div style="font-size:13px;font-weight:600;color:#cbd5e1;margin-bottom:8px;">Logs</div>
            <pre style="margin:0;padding:16px;border-radius:12px;background:#0a0a0f;border:1px solid #22222e;color:#d1d5db;font-size:12px;line-height:1.55;white-space:pre-wrap;overflow:auto;">{safe_logs}</pre>
        </div>
    </div>
</body>
</html>
"""

        text_body = f"{safe_subject}\n\nMessage:\n{message}\n\nDetails:\n{details or ''}\n\nLogs:\n{logs or ''}"

        msg = EmailMessage()
        msg["Subject"] = safe_subject
        msg["From"] = settings["SMTP_FROM"]
        msg["To"] = ", ".join(settings["SMTP_TO"])
        msg.set_content(text_body)
        msg.add_alternative(html_body, subtype="html")

        context = ssl.create_default_context()
        try:
                if settings["SMTP_USE_SSL"]:
                        with smtplib.SMTP_SSL(settings["SMTP_HOST"], settings["SMTP_PORT"], context=context) as server:
                                if settings["SMTP_USERNAME"] and settings["SMTP_PASSWORD"]:
                                        server.login(settings["SMTP_USERNAME"], settings["SMTP_PASSWORD"])
                                server.send_message(msg)
                else:
                        with smtplib.SMTP(settings["SMTP_HOST"], settings["SMTP_PORT"]) as server:
                                if settings["SMTP_USE_TLS"]:
                                        server.starttls(context=context)
                                if settings["SMTP_USERNAME"] and settings["SMTP_PASSWORD"]:
                                        server.login(settings["SMTP_USERNAME"], settings["SMTP_PASSWORD"])
                                server.send_message(msg)
                log.info("Error email sent to %s", ", ".join(settings["SMTP_TO"]))
                return True
        except Exception as exc:
                log.error("Error email send failed: %s", exc)
                return False


def _run_test_send():
    """python3 grades_emailer.py — sends a real test email using already-saved
    grades_data.json + whatever classroom data is currently posted, without
    scraping or logging into FACTS."""
    import json
    from grades_config import GRADES_JSON_PATH, GRADES_HISTORY_PATH, CURRENT_TERM

    with open(GRADES_JSON_PATH, encoding="utf-8") as f:
        result = json.load(f)

    changes = build_grade_changes(result, result, CURRENT_TERM)  # no-op diff, just for rendering

    try:
        from grades_analytics import build_dashboard_model
        model = build_dashboard_model(GRADES_JSON_PATH, GRADES_HISTORY_PATH)
        watchlist = model.get("watchlist", [])
    except Exception as exc:
        log.warning("Could not build watchlist (%s), sending with empty watchlist", exc)
        watchlist = []

    try:
        from classroom_client import fetch_classroom_payload
        classroom_payload = fetch_classroom_payload()
    except Exception as exc:
        log.warning("Could not fetch classroom payload (%s), sending without it", exc)
        classroom_payload = None

    sent = send_grade_email(
        changes,
        watchlist,
        {
            "updated": result.get("updated"),
            "academic_year": result.get("academic_year"),
            "term": result.get("current_term"),
        },
        classroom_payload,
    )
    print("Email sent." if sent else "Email NOT sent — check SMTP_HOST/FROM/TO config.")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    _run_test_send()