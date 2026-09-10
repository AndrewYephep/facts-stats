"""Email notifications for grade changes, watchlist items, and errors."""

import html
import json
import os
import re
import smtplib
import ssl
import string
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


# ── Local data helpers (for reading data files directly) ──────────────────────

def _read_local_json(path):
    if not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


_MONTH_ORDER = {
    "January": 1, "February": 2, "March": 3, "April": 4, "May": 5, "June": 6,
    "July": 7, "August": 8, "September": 9, "October": 10, "November": 11, "December": 12,
}


def _load_school_events_local(path):
    raw = _read_local_json(path)
    if not raw or not raw.get("months"):
        return []
    out = []
    for month_block in raw.get("months") or []:
        year = int(month_block.get("year") or 0)
        for ev in month_block.get("events") or []:
            date_str = str(ev.get("date") or "").strip()
            name = str(ev.get("event") or "").strip()
            if not date_str or not name:
                continue
            m = re.match(r"([A-Za-z]+)\s+(\d{1,2})(?:\s*-\s*(\d{1,2}))?$", date_str)
            if not m:
                continue
            month = _MONTH_ORDER.get(m.group(1))
            if not month:
                continue
            start = int(m.group(2))
            end = int(m.group(3) or start)
            for day in range(start, end + 1):
                out.append({
                    "date": f"{year:04d}-{month:02d}-{day:02d}",
                    "name": name,
                    "category": ev.get("category"),
                    "uniformDay": bool(ev.get("uniformDay")),
                })
    out.sort(key=lambda e: e["date"])
    return out


def _load_email_theme():
    data_dir = os.path.join(os.path.dirname(__file__), "data")
    settings = _read_local_json(os.path.join(data_dir, "settings.json")) or {}
    theme = str(settings.get("theme") or "dark").strip().lower()
    return theme if theme in ("dark", "light") else "dark"


def _theme_colors(theme="dark"):
    if theme == "light":
        return {
            "bg": "#f5f7fb", "card": "#ffffff", "border": "#e5e7eb",
            "text": "#111827", "sub": "#6b7280", "muted": "#9ca3af",
            "blue": "#2563eb", "green": "#059669", "red": "#dc2626",
            "amber": "#d97706", "violet": "#7c3aed", "row_border": "#e5e7eb",
            "row_bg": "#f9fafb", "tag_bg": "#eef2ff", "tag_text": "#3730a3",
        }
    return {
        "bg": "#0a0a0f", "card": "#12121b", "border": "#22222e",
        "text": "#f5f5f7", "sub": "#9ca3af", "muted": "#6b7280",
        "blue": "#60a5fa", "green": "#34d399", "red": "#f87171",
        "amber": "#fbbf24", "violet": "#a78bfa", "row_border": "#22222e",
        "row_bg": "#0a0a0f", "tag_bg": "#1e1b4b", "tag_text": "#a5b4fc",
    }


# ── Combined classroom payload builder ───────────────────────────────────────

def build_combined_classroom_payload(settings=None):
    """Build the combined classroom + calendar + todos payload for the email.

    Reads directly from data files.  The calendar overrides (done status) are
    the source of truth: if a user marks an assignment done, it is done.
    Everything else is reported as a todo.

    Returns a dict with today / tomorrow / missing sections containing
    classroom assignments, user todos, and school calendar events.
    """
    from datetime import date, timedelta

    data_dir = os.path.join(os.path.dirname(__file__), "data")

    classroom = _read_local_json(os.path.join(data_dir, "classroom_assignments.json")) or {}
    raw_assignments = classroom.get("assignments") or []

    todos_data = _read_local_json(os.path.join(data_dir, "user_todos.json")) or {}
    todos = todos_data.get("todos") or []
    overrides = todos_data.get("overrides") or {}
    edits = todos_data.get("edits") or {}

    school_events = _load_school_events_local(
        os.path.join(data_dir, "school_calendar_26_67.json")
    )

    today = date.today()
    tomorrow = today + timedelta(days=1)
    today_str = today.isoformat()
    tomorrow_str = tomorrow.isoformat()

    due_today = []
    due_tomorrow = []
    missing = []

    for a in raw_assignments:
        aid = str(a.get("id") or "")
        due_date = (a.get("dueDate") or "")[:10]
        is_done = overrides.get(aid) is True
        if is_done:
            continue
        edit = edits.get(aid) or {}
        title = edit.get("title") or a.get("title") or ""
        link = edit.get("link") or a.get("alternateLink") or a.get("submissionLink") or ""
        item = {
            "id": aid, "title": title,
            "courseName": a.get("courseName") or "",
            "due": due_date, "link": link,
            "state": a.get("submissionState") or "",
        }
        if due_date and due_date < today_str:
            missing.append(item)
        elif due_date == today_str:
            due_today.append(item)
        elif due_date == tomorrow_str:
            due_tomorrow.append(item)

    user_today = []
    user_tomorrow = []
    for t in todos:
        if t.get("done"):
            continue
        t_date = t.get("date") or ""
        item = {
            "id": t.get("id"), "title": t.get("title") or "",
            "className": t.get("className") or "", "due": t_date,
            "link": t.get("link") or "",
        }
        if t_date == today_str:
            user_today.append(item)
        elif t_date == tomorrow_str:
            user_tomorrow.append(item)

    events_today = [e for e in school_events if e.get("date") == today_str]
    events_tomorrow = [e for e in school_events if e.get("date") == tomorrow_str]

    theme = _load_email_theme()

    return {
        "today": {"classroom": due_today, "todos": user_today, "events": events_today},
        "tomorrow": {"classroom": due_tomorrow, "todos": user_tomorrow, "events": events_tomorrow},
        "missing": missing,
        "theme": theme,
    }


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

    # Recipients (and their content scope) come from the dashboard settings when
    # present; the legacy SMTP_TO list remains as a "both" fallback.
    email_cfg = {}
    subject_prefix = None
    try:
        from grades_config import load_settings
        email_cfg = load_settings().get("email") or {}
        if isinstance(email_cfg, dict):
            subject_prefix = (email_cfg.get("subjectPrefix") or "").strip()
    except Exception:
        pass

    recipients = []
    raw_recipients = email_cfg.get("recipients") if isinstance(email_cfg, dict) else None
    if isinstance(raw_recipients, list) and raw_recipients:
        for item in raw_recipients:
            if isinstance(item, dict):
                email_addr = str(item.get("email") or "").strip()
                if not email_addr:
                    continue
                scope = str(item.get("scope") or "both").strip().lower()
                if scope not in {"grades", "assignments", "both"}:
                    scope = "both"
                recipients.append({"email": email_addr, "scope": scope})
    if not recipients:
        recipients = [{"email": e, "scope": "both"} for e in settings["SMTP_TO"]]

    settings["RECIPIENTS"] = recipients
    settings["SMTP_TO"] = [r["email"] for r in recipients]
    if subject_prefix:
        settings["EMAIL_SUBJECT_PREFIX"] = subject_prefix

    return settings


def _build_email_subject(prefix, meta, changes, classroom_payload=None, combined=None):
    updated = meta.get("updated") or ""
    stamp = updated.replace("T", " ") if updated else datetime.now().strftime("%Y-%m-%d %H:%M")
    new_count = len(changes.get("new_grades", []))
    updated_count = len(changes.get("updated_grades", []))

    run_label = (classroom_payload or {}).get("run") or (combined or {}).get("run")
    prefix = {"morning": "Morning Report", "afternoon": "Afternoon Report"}.get(run_label, prefix)

    hw_count = sum(
        len(c.get("assignments", [])) for c in (classroom_payload or {}).get("classes", [])
    )
    if not hw_count and combined:
        today = combined.get("today") or {}
        tomorrow = combined.get("tomorrow") or {}
        hw_count = len(today.get("classroom") or []) + len(today.get("todos") or []) \
                 + len(tomorrow.get("classroom") or []) + len(tomorrow.get("todos") or [])
    hw_part = f", {hw_count} homework" if hw_count else ""

    return f"{prefix} - {new_count} new, {updated_count} updated{hw_part} ({stamp})"


def _render_table_rows(items, include_previous=False, c=None):
    c = c or _theme_colors("light")
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
                f"<div style=\"color:{c['sub']};font-size:12px;\">"
                f"{prev_grade} -> {grade}"
                "</div>"
            )

        rows.append(
            "<tr>"
            f"<td style=\"padding:10px 12px;border-bottom:1px solid {c['row_border']};\">"
            f"<div style=\"font-weight:600;color:{c['text']};\">{cur.get('assignment','')}</div>"
            f"<div style=\"color:{c['sub']};font-size:12px;\">{cur.get('class_name','')} · {cur.get('category','')}</div>"
            f"<div style=\"color:{c['sub']};font-size:12px;\">Due: {cur.get('due','')}</div>"
            "</td>"
            f"<td style=\"padding:10px 12px;border-bottom:1px solid {c['row_border']};text-align:right;\">"
            f"<div style=\"font-weight:600;color:{c['text']};\">{pts}/{mx}</div>"
            f"<div style=\"color:{c['blue']};font-weight:600;\">{grade}</div>"
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


def render_homework_section(classroom_payload, c=None):
    """Renders the Classroom homework block, or '' if no data available."""
    if not classroom_payload or not classroom_payload.get("classes"):
        return ""
    c = c or _theme_colors("light")

    classes = classroom_payload["classes"]
    run_label = classroom_payload.get("run", "")
    heading = "Due tonight / coming up" if run_label == "afternoon" else "Homework"

    blocks = []
    for cls in classes:
        assignments = cls.get("assignments", [])
        if not assignments:
            continue
        accent = cls.get("color") or c["blue"]

        rows = []
        for a in assignments:
            color = _status_color(a.get("status", "upcoming"))
            due_label = a.get("due_label") or a.get("due") or ""
            title = a.get("title", "")
            if a.get("link"):
                title_html = f'<a href="{a["link"]}" style="color:{c["blue"]};text-decoration:none;">{title}</a>'
            else:
                title_html = title
            rows.append(
                "<tr>"
                f"<td style=\"padding:8px 12px;border-bottom:1px solid {c['row_border']};\">"
                f"<div style=\"font-weight:600;color:{c['text']};\">{title_html}</div>"
                "</td>"
                f"<td style=\"padding:8px 12px;border-bottom:1px solid {c['row_border']};text-align:right;white-space:nowrap;\">"
                f"<div style=\"font-weight:700;color:{color};font-size:12px;\">{due_label}</div>"
                "</td>"
                "</tr>"
            )

        blocks.append(
            f"<div style=\"margin-top:12px;border:1px solid {c['border']};border-left:3px solid {accent};"
            f"border-radius:12px;padding:12px;background:{c['row_bg']};\">"
            f"<div style=\"font-weight:700;color:{c['text']};\">{cls['name']}</div>"
            "<table style=\"width:100%;border-collapse:collapse;margin-top:6px;\">"
            + "".join(rows)
            + "</table></div>"
        )

    if not blocks:
        return ""

    return (
        f"<h2 style=\"margin:24px 0 8px;font-size:18px;color:{c['text']};\">{heading}</h2>"
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


# ── Combined-section renderers (today / tomorrow / missing) ──────────────────

def _esc(s):
    return html.escape(str(s or ""))


def _render_class_assignments(items, c):
    """Render a list of classroom assignment items for one class block."""
    rows = []
    for a in items:
        title = _esc(a.get("title", ""))
        link = a.get("link", "")
        title_html = f'<a href="{_esc(link)}" style="color:{c["blue"]};text-decoration:none;font-weight:600;">{title}</a>' if link else f'<span style="font-weight:600;color:{c["text"]};">{title}</span>'
        rows.append(
            f'<tr>'
            f'<td style="padding:8px 12px;border-bottom:1px solid {c["row_border"]};">'
            f'{title_html}</td>'
            f'</tr>'
        )
    return "".join(rows)


def _render_todo_items(items, c):
    rows = []
    for t in items:
        title = _esc(t.get("title", ""))
        link = t.get("link", "")
        cls = _esc(t.get("className", ""))
        cls_html = f' <span style="color:{c["muted"]};font-size:12px;">· {cls}</span>' if cls else ""
        title_html = f'<a href="{_esc(link)}" style="color:{c["blue"]};text-decoration:none;font-weight:600;">{title}</a>' if link else f'<span style="font-weight:600;color:{c["text"]};">{title}</span>'
        rows.append(
            f'<tr>'
            f'<td style="padding:8px 12px;border-bottom:1px solid {c["row_border"]};">'
            f'{title_html}{cls_html}</td>'
            f'</tr>'
        )
    return "".join(rows)


def _render_event_items(events, c):
    rows = []
    for e in events:
        name = _esc(e.get("name", ""))
        uniform = ' <span style="font-size:11px;color:{0};">★ uniform</span>'.format(c["amber"]) if e.get("uniformDay") else ""
        rows.append(
            f'<tr>'
            f'<td style="padding:6px 12px;border-bottom:1px solid {c["row_border"]};">'
            f'<span style="color:{c["text"]};">{name}</span>{uniform}</td>'
            f'</tr>'
        )
    return "".join(rows)


def _render_section_block(label, accent, classroom_items, todo_items, event_items, c):
    """Render one 'due today' or 'due tomorrow' section with class groups + todos + events."""
    # Group classroom items by courseName
    class_groups = {}
    for a in classroom_items:
        cn = a.get("courseName") or "Other"
        class_groups.setdefault(cn, []).append(a)

    parts = []
    if class_groups:
        for cn, items in class_groups.items():
            rows = _render_class_assignments(items, c)
            parts.append(
                f'<div style="margin-top:10px;border:1px solid {c["border"]};'
                f'border-left:3px solid {accent};border-radius:12px;padding:12px;background:{c["row_bg"]};">'
                f'<div style="font-weight:700;color:{c["text"]};font-size:13px;">{_esc(cn)}</div>'
                f'<table style="width:100%;border-collapse:collapse;margin-top:4px;">{rows}</table></div>'
            )

    if todo_items:
        rows = _render_todo_items(todo_items, c)
        parts.append(
            f'<div style="margin-top:10px;border:1px solid {c["border"]};'
            f'border-left:3px solid {c["violet"]};border-radius:12px;padding:12px;background:{c["row_bg"]};">'
            f'<div style="font-weight:700;color:{c["text"]};font-size:13px;">Personal tasks</div>'
            f'<table style="width:100%;border-collapse:collapse;margin-top:4px;">{rows}</table></div>'
        )

    if event_items:
        rows = _render_event_items(event_items, c)
        parts.append(
            f'<div style="margin-top:10px;border:1px solid {c["border"]};'
            f'border-left:3px solid {c["amber"]};border-radius:12px;padding:12px;background:{c["row_bg"]};">'
            f'<div style="font-weight:700;color:{c["text"]};font-size:13px;">School calendar</div>'
            f'<table style="width:100%;border-collapse:collapse;margin-top:4px;">{rows}</table></div>'
        )

    if not parts:
        return ""

    total = len(classroom_items) + len(todo_items) + len(event_items)
    return (
        f'<div style="margin-top:20px;">'
        f'<h2 style="margin:0 0 6px;font-size:16px;color:{c["text"]};">'
        f'<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:{accent};margin-right:6px;vertical-align:middle;"></span>'
        f'{_esc(label)}'
        f' <span style="font-size:12px;color:{c["muted"]};font-weight:400;">({total})</span></h2>'
        + "".join(parts) +
        f'</div>'
    )


def _render_missing_section(missing_items, c):
    if not missing_items:
        return ""
    rows = []
    for a in missing_items:
        title = _esc(a.get("title", ""))
        cn = _esc(a.get("courseName", ""))
        due = _esc(a.get("due", ""))
        link = a.get("link", "")
        title_html = f'<a href="{_esc(link)}" style="color:{c["red"]};text-decoration:none;font-weight:600;">{title}</a>' if link else f'<span style="font-weight:600;color:{c["red"]};">{title}</span>'
        rows.append(
            f'<tr>'
            f'<td style="padding:8px 12px;border-bottom:1px solid {c["row_border"]};">'
            f'<div>{title_html}</div>'
            f'<div style="color:{c["muted"]};font-size:12px;">{cn} · due {due}</div>'
            f'</td>'
            f'</tr>'
        )
    return (
        f'<div style="margin-top:20px;">'
        f'<h2 style="margin:0 0 6px;font-size:16px;color:{c["red"]};">'
        f'<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:{c["red"]};margin-right:6px;vertical-align:middle;"></span>'
        f'Missing ({len(missing_items)})</h2>'
        f'<div style="border:1px solid {c["border"]};border-radius:12px;overflow:hidden;">'
        f'<table style="width:100%;border-collapse:collapse;">'
        + "".join(rows) +
        f'</table></div></div>'
    )


def render_combined_sections(combined):
    """Render the today / tomorrow / missing blocks for the combined email."""
    if not combined:
        return ""
    c = _theme_colors(combined.get("theme", "dark"))
    parts = []

    today = combined.get("today") or {}
    today_class = today.get("classroom") or []
    today_todos = today.get("todos") or []
    today_events = today.get("events") or []
    if today_class or today_todos or today_events:
        parts.append(_render_section_block("Due today", c["blue"], today_class, today_todos, today_events, c))

    tomorrow = combined.get("tomorrow") or {}
    tmrw_class = tomorrow.get("classroom") or []
    tmrw_todos = tomorrow.get("todos") or []
    tmrw_events = tomorrow.get("events") or []
    if tmrw_class or tmrw_todos or tmrw_events:
        parts.append(_render_section_block("Due tomorrow", c["green"], tmrw_class, tmrw_todos, tmrw_events, c))

    missing = combined.get("missing") or []
    if missing:
        parts.append(_render_missing_section(missing, c))

    return "".join(parts)


# Variables exposed to the editable HTML template. The email body is built by
# string.Template substitution, so unknown $NAMEs are left untouched while a
# template is being edited.
EMAIL_TEMPLATE_VARIABLES = [
    "TITLE",
    "TERM",
    "YEAR",
    "UPDATED",
    "SUMMARY",
    "COMBINED_SECTIONS",
    "NEW_GRADES",
    "UPDATED_GRADES",
    "WATCHLIST",
    "HOMEWORK",
    "STREAK",
    "REVIEW_PCT",
    "BG",
    "CARD",
    "BORDER",
    "TEXT",
    "SUB",
    "MUTED",
]

DEFAULT_EMAIL_TEMPLATE = """\
<!DOCTYPE html>
<html>
    <body style="margin:0;padding:0;background:$BG;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:720px;margin:0 auto;padding:24px;">
        <div style="background:$CARD;border:1px solid $BORDER;border-radius:16px;padding:22px;">
            <div style="font-size:22px;font-weight:700;color:$TEXT;">$TITLE</div>
            <div style="color:$SUB;margin-top:6px;">Term $TERM · $YEAR</div>
            <div style="color:$MUTED;margin-top:4px;font-size:12px;">Last updated: $UPDATED</div>
            $SUMMARY
            $STREAK
            $REVIEW_PCT
        </div>
        <div style="background:$CARD;border:1px solid $BORDER;border-radius:16px;padding:20px;margin-top:16px;">
            $COMBINED_SECTIONS
            $HOMEWORK
            $NEW_GRADES
            $UPDATED_GRADES
            $WATCHLIST
        </div>
        <div style="color:$MUTED;text-align:center;font-size:12px;margin-top:16px;">
            Generated by GradeTrack
        </div>
    </div>
  </body>
</html>
"""


def _email_template():
    try:
        from grades_config import load_settings
        tpl = (load_settings().get("emailHtml") or "").strip()
        return tpl or DEFAULT_EMAIL_TEMPLATE
    except Exception:
        return DEFAULT_EMAIL_TEMPLATE


def _scope_blocks(blocks, scope):
    scope = (scope or "both").strip().lower()
    if scope == "assignments":
        return {**blocks, "SUMMARY": "", "NEW_GRADES": "", "UPDATED_GRADES": "", "WATCHLIST": ""}
    if scope == "grades":
        return {**blocks, "HOMEWORK": "", "COMBINED_SECTIONS": ""}
    if scope == "review":
        return {**blocks, "SUMMARY": "", "NEW_GRADES": "", "UPDATED_GRADES": "", "WATCHLIST": "", "HOMEWORK": "", "COMBINED_SECTIONS": ""}
    if scope == "errors":
        return {**blocks, "SUMMARY": "", "NEW_GRADES": "", "UPDATED_GRADES": "", "WATCHLIST": "", "HOMEWORK": "", "COMBINED_SECTIONS": ""}
    return blocks


def _email_blocks(changes, watchlist, meta, classroom_payload=None, combined=None):
    new_grades = changes.get("new_grades", [])
    updated_grades = changes.get("updated_grades", [])
    term = meta.get("term", "")
    year = meta.get("academic_year", "")
    updated = meta.get("updated", "")

    run_label = (classroom_payload or {}).get("run") or (combined or {}).get("run")
    title = {"morning": "Morning Report", "afternoon": "Afternoon Report"}.get(run_label, "Grades Update")

    theme = (combined or {}).get("theme", "dark")
    c = _theme_colors(theme)

    summary = (
        f"<div style=\"margin-top:10px;font-size:14px;color:{c['text']};font-weight:600;\">"
        f"New: {len(new_grades)} · Updated: {len(updated_grades)} · Watchlist: {len(watchlist)}"
        "</div>"
    )

    new_section = (
        f"<h2 style=\"margin:24px 0 8px;font-size:18px;color:{c['text']};\">New grades</h2>"
    )
    if new_grades:
        new_section += (
            "<table style=\"width:100%;border-collapse:collapse;margin-top:8px;\">"
            + _render_table_rows(new_grades, c=c)
            + "</table>"
        )
    else:
        new_section += f"<div style=\"color:{c['muted']};\">No new graded assignments since last scrape.</div>"

    updated_section = (
        f"<h2 style=\"margin:24px 0 8px;font-size:18px;color:{c['text']};\">Updated grades</h2>"
    )
    if updated_grades:
        updated_section += (
            "<table style=\"width:100%;border-collapse:collapse;margin-top:8px;\">"
            + _render_table_rows(updated_grades, include_previous=True, c=c)
            + "</table>"
        )
    else:
        updated_section += f"<div style=\"color:{c['muted']};\">No grade changes since last scrape.</div>"

    watchlist_section = (
        f"<h2 style=\"margin:24px 0 8px;font-size:18px;color:{c['text']};\">Watchlist</h2>"
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
                color = c["red"] if below else c["amber"]
                rows.append(
                    f"<tr>"
                    f"<td style=\"padding:10px 12px;border-bottom:1px solid {c['row_border']};\">"
                    f"<div style=\"font-weight:600;color:{c['text']};\">{label}</div>"
                    "</td>"
                    f"<td style=\"padding:10px 12px;border-bottom:1px solid {c['row_border']};text-align:right;\">"
                    f"<div style=\"font-weight:700;color:{color};\">{value}</div>"
                    "</td>"
                    "</tr>"
                )
            blocks.append(
                f"<div style=\"margin-top:12px;border:1px solid {c['border']};border-radius:12px;padding:12px;background:{c['row_bg']};\">"
                f"<div style=\"font-weight:700;color:{c['text']};\">{class_name}</div>"
                "<table style=\"width:100%;border-collapse:collapse;margin-top:6px;\">"
                + "".join(rows)
                + "</table>"
                "</div>"
            )
        watchlist_section += "".join(blocks)
    else:
        watchlist_section += f"<div style=\"color:{c['muted']};\">No watchlist items.</div>"

    return {
        "TITLE": title,
        "TERM": str(term),
        "YEAR": str(year),
        "UPDATED": str(updated),
        "BG": c["bg"],
        "CARD": c["card"],
        "BORDER": c["border"],
        "TEXT": c["text"],
        "SUB": c["sub"],
        "MUTED": c["muted"],
        "SUMMARY": summary,
        "COMBINED_SECTIONS": render_combined_sections(combined),
        "NEW_GRADES": new_section,
        "UPDATED_GRADES": updated_section,
        "WATCHLIST": watchlist_section,
        "HOMEWORK": render_homework_section(classroom_payload, c),
        "STREAK": _render_review_block(meta, "streak", c),
        "REVIEW_PCT": _render_review_block(meta, "pct", c),
    }


def _render_review_block(meta, kind, c=None):
    """Render a small block for $STREAK and $REVIEW_PCT. Reads from meta if
    the daily run computed it, else returns an empty string (template
    substitutions are tolerant of missing values via safe_substitute)."""
    c = c or _theme_colors("light")
    if kind == "streak":
        streak = (meta or {}).get("noteQuizStreak")
        if streak is None:
            return ""
        return (
            "<div style=\"margin-top:12px;display:inline-block;padding:8px 14px;"
            f"border:1px solid {c['border']};border-radius:999px;background:{c['tag_bg']};"
            f"color:{c['tag_text']};font-size:13px;font-weight:600;\">"
            f"Note-quiz streak: {streak} day{'' if streak == 1 else 's'}"
            "</div>"
        )
    if kind == "pct":
        pct = (meta or {}).get("noteQuizCompletionPct")
        total = (meta or {}).get("noteQuizTotal")
        correct = (meta or {}).get("noteQuizCorrect")
        if pct is None:
            return ""
        detail = f" ({correct}/{total} correct)" if total is not None else ""
        return (
            "<div style=\"margin-top:8px;display:inline-block;padding:8px 14px;"
            f"border:1px solid {c['border']};border-radius:999px;background:{c['tag_bg']};"
            f"color:{c['tag_text']};font-size:13px;font-weight:600;\">"
            f"Reviews completed: {pct}%{detail}"
            "</div>"
        )
    return ""


def render_email_html(changes, watchlist, meta, classroom_payload=None, template=None, scope="both", combined=None):
    blocks = _scope_blocks(_email_blocks(changes, watchlist, meta, classroom_payload, combined), scope)
    tpl = template if template is not None else _email_template()
    return string.Template(tpl).safe_substitute(blocks)


def render_email_text(changes, watchlist, meta, classroom_payload=None, scope="both", combined=None):
    scope = (scope or "both").strip().lower()
    lines = []
    lines.append("Grades Update")
    lines.append(f"Term {meta.get('term','')} - {meta.get('academic_year','')}")
    lines.append(f"Updated: {meta.get('updated','')}")
    lines.append("")

    if scope != "grades" and combined:
        today = combined.get("today") or {}
        tomorrow = combined.get("tomorrow") or {}
        missing = combined.get("missing") or []
        if today.get("classroom") or today.get("todos"):
            lines.append("Due today:")
            for a in (today.get("classroom") or []):
                lines.append(f"- {a.get('courseName','')}: {a.get('title','')}")
            for t in (today.get("todos") or []):
                cn = t.get("className") or "Personal"
                lines.append(f"- {cn}: {t.get('title','')}")
            lines.append("")
        if tomorrow.get("classroom") or tomorrow.get("todos"):
            lines.append("Due tomorrow:")
            for a in (tomorrow.get("classroom") or []):
                lines.append(f"- {a.get('courseName','')}: {a.get('title','')}")
            for t in (tomorrow.get("todos") or []):
                cn = t.get("className") or "Personal"
                lines.append(f"- {cn}: {t.get('title','')}")
            lines.append("")
        if missing:
            lines.append("Missing:")
            for a in missing:
                lines.append(f"- {a.get('courseName','')}: {a.get('title','')} (due {a.get('due','')})")
            lines.append("")

    if scope != "grades" and classroom_payload and classroom_payload.get("classes"):
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

    if scope != "assignments":
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


def _smtp_send(settings, msg):
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
        return True
    except Exception as exc:
        log.error("Email send failed: %s", exc)
        return False


def send_grade_email(changes, watchlist, meta, classroom_payload=None, combined=None, run_label=None):
    settings = _load_email_config()

    if not settings["SMTP_HOST"] or not settings["SMTP_TO"] or not settings["SMTP_FROM"]:
        log.warning("Email not configured; set SMTP_HOST, SMTP_FROM, and SMTP_TO to enable emailing.")
        return False

    if combined is None:
        try:
            combined = build_combined_classroom_payload()
        except Exception as exc:
            log.warning("Could not build combined payload (%s), sending without it", exc)
    if combined is not None and run_label:
        combined["run"] = run_label

    subject = _build_email_subject(settings["EMAIL_SUBJECT_PREFIX"], meta, changes, classroom_payload, combined)
    template = _email_template()
    base_blocks = _email_blocks(changes, watchlist, meta, classroom_payload, combined)
    sent_any = False
    for recipient in settings.get("RECIPIENTS") or []:
        email_addr = str(recipient.get("email") or "").strip()
        if not email_addr:
            continue
        scope = str(recipient.get("scope") or "both").strip().lower()
        html_body = string.Template(template).safe_substitute(_scope_blocks(base_blocks, scope))
        text_body = render_email_text(changes, watchlist, meta, classroom_payload, scope=scope, combined=combined)

        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = settings["SMTP_FROM"]
        msg["To"] = email_addr
        msg.set_content(text_body)
        msg.add_alternative(html_body, subtype="html")

        if _smtp_send(settings, msg):
            log.info("Email sent to %s", email_addr)
            sent_any = True
        else:
            log.error("Email send failed for %s", email_addr)
    return sent_any


def send_daily_email(run_label=None):
    """Send the combined daily email (morning/afternoon report). Builds grade
    changes + watchlist live from the saved data files, then layers in the
    combined classroom/calendar/todo sections. Returns bool."""
    import json as _json
    from grades_config import GRADES_JSON_PATH, GRADES_HISTORY_PATH, CURRENT_TERM
    from grades_analytics import build_dashboard_model

    if run_label is None:
        run_label = "morning" if datetime.now().hour < 12 else "afternoon"

    changes = {"new_grades": [], "updated_grades": []}
    watchlist = []
    meta = {}
    try:
        with open(GRADES_JSON_PATH, encoding="utf-8") as f:
            result = _json.load(f)
        changes = build_grade_changes(result, result, CURRENT_TERM)  # no-op diff for rendering
        model = build_dashboard_model(GRADES_JSON_PATH, GRADES_HISTORY_PATH)
        watchlist = model.get("watchlist", [])
        meta = {
            "updated": result.get("updated"),
            "academic_year": result.get("academic_year"),
            "term": result.get("current_term"),
        }
    except Exception as exc:
        log.warning("Could not load grade data for email (%s)", exc)

    combined = build_combined_classroom_payload()
    combined["run"] = run_label
    return send_grade_email(changes, watchlist, meta, combined=combined)


def send_test_email(recipients=None):
    """Send a sample Grades Update using current config. `recipients` optionally
    overrides the saved recipient list (each is sent scope=both). Returns bool."""
    settings = _load_email_config()
    if not settings["SMTP_HOST"] or not settings["SMTP_FROM"]:
        log.warning("Email not configured; set SMTP_HOST and SMTP_FROM.")
        return False

    if recipients:
        target = [{"email": str(r).strip(), "scope": "both"} for r in recipients if str(r).strip()]
    else:
        target = settings.get("RECIPIENTS") or []
    if not target:
        log.warning("No email recipients configured.")
        return False

    meta = {"term": "4", "academic_year": "2025-26", "updated": datetime.now().strftime("%Y-%m-%d %H:%M")}
    changes = {
        "new_grades": [{"current": {"assignment": "Algebra Quiz 3", "class_name": "Algebra II", "category": "Quizzes", "pts": 9, "max": 10, "percent": 90.0, "due": "Aug 20"}}],
        "updated_grades": [{"current": {"assignment": "Essay 2", "class_name": "English 11", "category": "Essays", "pts": 17, "max": 20, "percent": 85.0, "due": "Aug 18"}, "previous": {"percent": 80.0}}],
    }
    watchlist = [{"kind": "lowest_class", "label": "Physics", "class_name": "Physics", "value": 78.5}]
    combined = None
    try:
        combined = build_combined_classroom_payload()
    except Exception:
        combined = None

    template = _email_template()
    base_blocks = _email_blocks(changes, watchlist, meta, combined=combined)
    subject = _build_email_subject(settings["EMAIL_SUBJECT_PREFIX"], meta, changes, combined=combined)
    sent_any = False
    for recipient in target:
        scope = str(recipient.get("scope") or "both").strip().lower()
        html_body = string.Template(template).safe_substitute(_scope_blocks(base_blocks, scope))
        text_body = render_email_text(changes, watchlist, meta, scope=scope, combined=combined)
        msg = EmailMessage()
        msg["Subject"] = subject + " (test)"
        msg["From"] = settings["SMTP_FROM"]
        msg["To"] = recipient["email"]
        msg.set_content(text_body)
        msg.add_alternative(html_body, subtype="html")
        if _smtp_send(settings, msg):
            log.info("Test email sent to %s", recipient["email"])
            sent_any = True
    return sent_any


def email_preview(template=None, scope="both"):
    """Render a sample Grades Update for the settings editor preview. Uses the
    real term/year metadata when available and sample rows so the layout is
    visible even when nothing has changed since the last scrape."""
    import json
    meta = {"term": "4", "academic_year": "2025-26", "updated": datetime.now().strftime("%Y-%m-%d %H:%M")}
    try:
        from grades_config import GRADES_JSON_PATH, GRADES_HISTORY_PATH
        from grades_analytics import build_dashboard_model
        model = build_dashboard_model(GRADES_JSON_PATH, GRADES_HISTORY_PATH)
        meta = (model.get("meta") or {}) or meta
    except Exception:
        pass

    changes = {
        "new_grades": [{"current": {"assignment": "Algebra Quiz 3", "class_name": "Algebra II", "category": "Quizzes", "pts": 9, "max": 10, "percent": 90.0, "due": "Aug 20"}}],
        "updated_grades": [{"current": {"assignment": "Essay 2", "class_name": "English 11", "category": "Essays", "pts": 17, "max": 20, "percent": 85.0, "due": "Aug 18"}, "previous": {"percent": 80.0}}],
    }
    watchlist = [{"kind": "lowest_class", "label": "Physics", "class_name": "Physics", "value": 78.5}]
    combined = None
    try:
        combined = build_combined_classroom_payload()
    except Exception:
        combined = None
    blocks = _email_blocks(changes, watchlist, meta, combined=combined)
    tpl = template if isinstance(template, str) and template.strip() else _email_template()
    return string.Template(tpl).safe_substitute(_scope_blocks(blocks, scope))


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


def send_error_email_to_scope(subject, message, logs, details=None):
        """Route an app error to recipients whose scope is 'errors'. Falls back
        to the legacy single-recipient SMTP_TO field if no scope='errors'
        recipient is configured."""
        settings = _load_email_config()
        if not settings["SMTP_HOST"] or not settings["SMTP_FROM"]:
                log.warning("Error email not configured; set SMTP_HOST and SMTP_FROM.")
                return False
        recipients = [
            r for r in (settings.get("RECIPIENTS") or [])
            if str(r.get("email") or "").strip() and str(r.get("scope") or "").strip().lower() == "errors"
        ]
        # Fallback to legacy single-recipient config.
        to_addrs = [str(r["email"]).strip() for r in recipients if str(r.get("email") or "").strip()]
        if not to_addrs and settings.get("SMTP_TO"):
                to_addrs = [a.strip() for a in str(settings["SMTP_TO"]).split(",") if a.strip()]
        if not to_addrs:
                log.warning("No 'errors'-scope recipients configured; skipping error email.")
                return False
        return send_error_email(subject, message, logs, details)


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