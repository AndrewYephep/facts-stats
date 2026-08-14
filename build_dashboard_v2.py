#!/usr/bin/env python3
"""Grades Dashboard 2.0 - compact app-style dashboard builder."""

import argparse
import html
import json
import os
from datetime import datetime

from grades_analytics import (
    assignment_percent,
    below_threshold,
    build_dashboard_model,
    parse_number,
)
from grades_config import (
    ACADEMIC_YEAR,
    ATTENTION_PERCENT_THRESHOLD,
    CURRENT_TERM,
    GRADES_DASHBOARD_PATH,
    GRADES_HISTORY_PATH,
    GRADES_JSON_PATH,
)


SECTION_IDS = ("dashboard", "analytics", "watchlist", "grades")


def esc(value):
    return html.escape(str(value or ""))


def fmt_pct(value, digits=1):
    if value is None:
        return "N/A"
    return f"{value:.{digits}f}%"


def short_name(class_name):
    return (class_name or "Class").split("(")[0].strip()


def iso_to_readable(value):
    if not value:
        return "Last update unavailable"
    raw = str(value).replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(raw)
        return dt.strftime("%b %d, %Y %I:%M %p")
    except ValueError:
        return str(value)


def derive_output_path(base_path):
    root, ext = os.path.splitext(base_path)
    if not ext:
        ext = ".html"
    candidate = f"{root}_v2{ext}"
    directory = os.path.dirname(candidate)
    if directory and os.path.isdir(directory):
        return candidate
    return os.path.join(os.getcwd(), "grades_dashboard_v2.html")


def average(values):
    nums = [value for value in values if value is not None]
    if not nums:
        return None
    return round(sum(nums) / len(nums), 1)


def parse_weight(value):
  number = parse_number(value)
  if number is None or number <= 0:
    return None
  return float(number)


def status_for_grade(value):
  if value is None:
    return "unknown"
  if value < ATTENTION_PERCENT_THRESHOLD:
    return "attention"
  return "strong"


def parse_due_date(value):
  if not value:
    return None
  raw = str(value).strip()
  if not raw:
    return None

  for fmt in (
    "%m/%d/%Y",
    "%m/%d/%y",
    "%m-%d-%Y",
    "%m-%d-%y",
    "%Y-%m-%d",
    "%Y/%m/%d",
    "%b %d, %Y",
    "%B %d, %Y",
  ):
    try:
      parsed = datetime.strptime(raw, fmt)
      return parsed.date()
    except ValueError:
      continue

  start_year = int(str(payload_academic_year()).split("-")[0])
  for glue in ("/", "-"):
    try:
      month_str, day_str = raw.split(glue)
      month = int(month_str)
      day = int(day_str)
    except (ValueError, TypeError):
      continue

    inferred_year = start_year if month >= 7 else start_year + 1
    try:
      return datetime(inferred_year, month, day).date()
    except ValueError:
      continue

  try:
    return datetime.fromisoformat(raw).date()
  except ValueError:
    return None


def payload_academic_year():
  return str(ACADEMIC_YEAR)


def quarter_values(info):
  out = {}
  for term_key, quarter in (info.get("quarters") or {}).items():
    out[str(term_key)] = parse_number((quarter or {}).get("term_grade"))
  return out


def merge_category_records(category_lists):
  buckets = {}
  for categories in category_lists.values():
    for cat in categories:
      key = (cat.get("name") or "Category").strip().lower()
      bucket = buckets.setdefault(
        key,
        {
          "name": cat.get("name", "Category"),
          "averages": [],
          "assignment_count": 0,
          "latest_due": "",
        },
      )
      for assignment in cat.get("assignments") or []:
        bucket["averages"].append(assignment)
      bucket["assignment_count"] += cat.get("assignment_count", 0)
      if cat.get("latest_due") and cat["latest_due"] > bucket["latest_due"]:
        bucket["latest_due"] = cat["latest_due"]

  merged = []
  for bucket in buckets.values():
    earned = 0.0
    possible = 0.0
    for assignment in bucket["averages"]:
      pts = parse_number(assignment.get("score"))
      mx = parse_number(assignment.get("max"))
      if pts is None or mx in (None, 0):
        continue
      earned += pts
      possible += mx
    avg_value = round((earned / possible) * 100, 1) if possible else None
    merged.append({
      "name": bucket["name"],
      "average": avg_value,
      "status": status_for_grade(avg_value),
      "assignment_count": bucket["assignment_count"],
      "latest_due": bucket["latest_due"],
    })
  return sorted(merged, key=lambda item: (item["average"] is None, item["average"] or 999))


def align_class_timelines(records):
  all_dates = sorted({
    date
    for record in records
    for date in (record.get("timeline") or {}).get("labels", [])
  })
  if not all_dates:
    return {"labels": [], "average": [], "classes": [], "points": []}

  points_by_date = {date: [] for date in all_dates}
  class_series = []
  for record in records:
    timeline = record.get("timeline") or {}
    labels = timeline.get("labels", [])
    values = timeline.get("values", [])
    aligned_values = []
    source_idx = 0
    last_value = None

    for date in all_dates:
      while source_idx < len(labels) and labels[source_idx] <= date:
        if source_idx < len(values) and values[source_idx] is not None:
          last_value = values[source_idx]
        source_idx += 1
      aligned_values.append(last_value)

    class_series.append({
      "classid": record["classid"],
      "label": record["label"],
      "short_name": record["short_name"],
      "color": record["color"],
      "values": aligned_values,
    })

    timeline_points = (record.get("timeline") or {}).get("points") or []
    timeline_labels = (record.get("timeline") or {}).get("labels") or []
    for point_index, point_date in enumerate(timeline_labels):
      if point_index >= len(timeline_points):
        continue
      for assignment in timeline_points[point_index]:
        points_by_date.setdefault(point_date, []).append({
          **assignment,
          "class": record["short_name"],
          "classid": record["classid"],
          "class_color": record["color"],
        })

  averages = []
  for idx in range(len(all_dates)):
    nums = [series["values"][idx] for series in class_series if series["values"][idx] is not None]
    averages.append(round(sum(nums) / len(nums), 1) if nums else None)

  point_series = [points_by_date.get(date, []) for date in all_dates]
  return {"labels": all_dates, "average": averages, "classes": class_series, "points": point_series}


def collect_attention_groups(classes):
  groups = []
  category_rows = []

  for item in classes:
    attention_categories = [
      {
        "name": cat["name"],
        "average": cat["average"],
        "assignment_count": cat["assignment_count"],
        "status": cat["status"],
      }
      for cat in item["categories"]
      if cat["average"] is not None and below_threshold(cat["average"])
    ]

    class_is_low = below_threshold(item["term_grade"])
    if not class_is_low and not attention_categories:
      continue

    groups.append({
      "kind": "class",
      "classid": item["classid"],
      "title": item["short_name"],
      "name": item["name"],
      "subtitle": f"Current quarter {fmt_pct(item['term_grade'])}",
      "value": item["term_grade"],
      "reason": f"Class average is under {ATTENTION_PERCENT_THRESHOLD:.0f}%." if class_is_low else f"{len(attention_categories)} categories are under threshold.",
      "status": "attention" if class_is_low else "watch",
      "target": {"classid": item["classid"], "category": ""},
      "categories": attention_categories,
      "category_count": len(attention_categories),
      "priority": 0 if class_is_low else 1,
    })

    for cat in attention_categories:
      category_rows.append({
        "classid": item["classid"],
        "class_name": item["short_name"],
        "name": cat["name"],
        "average": cat["average"],
        "status": cat["status"],
      })

  groups.sort(key=lambda row: (row["priority"], row["value"] if row["value"] is not None else 999))
  category_rows.sort(key=lambda row: row["average"])
  return groups, category_rows


def compute_timeline_from_categories(category_sources):
    if not category_sources:
        return {"labels": [], "values": [], "points": []}

    unique_dates = sorted({
        asn["date"]
        for category in category_sources
        for asn in category["assignments"]
        if asn.get("date")
    })
    if not unique_dates:
        return {"labels": [], "values": [], "points": []}

    labels = []
    values = []
    points = []

    for target_date in unique_dates:
        day_items = []
        for category in category_sources:
            for asn in category["assignments"]:
                if asn.get("date") != target_date:
                    continue
                pts = parse_number(asn.get("pts"))
                mx = parse_number(asn.get("max"))
                pct = None
                if pts is not None and mx not in (None, 0):
                    pct = round((pts / mx) * 100, 1)
                day_items.append({
                    "category": category["name"],
                    "name": asn.get("name", "Assignment"),
                    "score": asn.get("pts"),
                    "max": asn.get("max"),
                    "percent": pct,
                })

        category_avgs = []
        weighted = []
        weighted_total = 0.0

        for category in category_sources:
            eligible = [asn for asn in category["assignments"] if asn["date"] <= target_date]
            if not eligible:
                continue

            earned = 0.0
            possible = 0.0
            for asn in eligible:
                pts = parse_number(asn.get("pts"))
                mx = parse_number(asn.get("max"))
                if pts is None or mx in (None, 0):
                    continue
                earned += pts
                possible += mx

            if not possible:
                continue

            category_avg = round((earned / possible) * 100, 1)
            category_avgs.append(category_avg)
            if category["weight"] is not None:
                weighted.append((category_avg, category["weight"]))
                weighted_total += category["weight"]

        if not category_avgs:
            continue

        if weighted and weighted_total > 0:
            class_avg = round(sum(avg * weight for avg, weight in weighted) / weighted_total, 1)
        else:
            class_avg = round(sum(category_avgs) / len(category_avgs), 1)

        labels.append(target_date)
        values.append(class_avg)
        points.append(day_items)

    return {"labels": labels, "values": values, "points": points}

def build_class_records(merged, current_term):
    classes = []
    ordered_items = sorted(
        merged.items(),
        key=lambda item: (
            parse_number((item[1].get("quarters") or {}).get(str(current_term), {}).get("term_grade")) is None,
            parse_number((item[1].get("quarters") or {}).get(str(current_term), {}).get("term_grade")) or 999,
            short_name(item[1].get("class_name", "")),
        ),
    )

    for index, (classid, info) in enumerate(ordered_items):
        class_name = info.get("class_name", "Class")
        quarters = info.get("quarters") or {}
        current = quarters.get(str(current_term), {})
        term_grade = parse_number(current.get("term_grade"))
        if term_grade is None:
            continue

        qvals = quarter_values(info)
        categories = []
        year_timeline_categories = []
        timeline_quarters = {}
        category_quarters = {}
        strongest_category = None
        weakest_category = None
        categories_below_count = 0

        for term_key, quarter in quarters.items():
            term_categories = []
            term_timeline_categories = []
            for cat in quarter.get("categories") or []:
                cat_name = cat.get("name", "Category")
                cat_avg = parse_number(cat.get("average"))
                cat_weight = parse_weight(cat.get("weight"))
                assignment_rows = []
                due_dates = []
                term_timeline_assignments = []

                for asn in cat.get("assignments") or []:
                    pct = assignment_percent(asn)
                    due_text = asn.get("due_date") or asn.get("due") or ""
                    due_date = parse_due_date(due_text)
                    row = {
                        "name": asn.get("name", "Assignment"),
                        "score": asn.get("pts"),
                        "max": asn.get("max"),
                        "percent": pct,
                        "due": due_text,
                        "due_sort": due_date.isoformat() if due_date else "",
                    }
                    assignment_rows.append(row)
                    if due_date:
                        term_timeline_assignments.append({
                            "date": due_date.isoformat(),
                            "name": asn.get("name", "Assignment"),
                            "pts": asn.get("pts"),
                            "max": asn.get("max"),
                        })
                        if pct is not None:
                            due_dates.append(due_date.isoformat())

                category_payload = {
                    "name": cat_name,
                    "average": cat_avg,
                    "status": status_for_grade(cat_avg),
                    "weight": cat.get("weight", ""),
                    "assignment_count": len(assignment_rows),
                    "assignments": sorted(
                        assignment_rows,
                        key=lambda row: (row["due_sort"] or "9999-99-99", row["name"]),
                        reverse=True,
                    ),
                    "latest_due": max(due_dates) if due_dates else "",
                }
                term_categories.append(category_payload)
                term_timeline_categories.append({
                    "name": cat_name,
                    "weight": cat_weight,
                    "assignments": term_timeline_assignments,
                })

                if str(term_key) == str(current_term):
                    categories.append(category_payload)
                    if cat_avg is not None:
                        if strongest_category is None or cat_avg > strongest_category["average"]:
                            strongest_category = {"name": cat_name, "average": cat_avg}
                        if weakest_category is None or cat_avg < weakest_category["average"]:
                            weakest_category = {"name": cat_name, "average": cat_avg}
                        if below_threshold(cat_avg):
                            categories_below_count += 1

            category_quarters[str(term_key)] = sorted(
                term_categories,
                key=lambda cat: (cat["average"] is None, cat["average"] or 999),
            )
            timeline_quarters[str(term_key)] = compute_timeline_from_categories(term_timeline_categories)
            year_timeline_categories.extend(term_timeline_categories)

        current_timeline = timeline_quarters.get(str(current_term), {"labels": [], "values": []})
        year_timeline = compute_timeline_from_categories(year_timeline_categories)
        year_categories = merge_category_records(category_quarters)

        classes.append({
            "classid": classid,
            "name": class_name,
            "short_name": short_name(class_name),
            "label": short_name(class_name),
            "color": f"hsl({(index * 47) % 360} 62% 44%)",
            "term_grade": term_grade,
            "term_letter": current.get("term_letter") or "",
            "status": status_for_grade(term_grade),
            "quarter_values": {f"Q{key}": val for key, val in sorted(qvals.items(), key=lambda item: int(item[0]))},
            "year_average": average(qvals.values()),
            "category_average": average([cat["average"] for cat in categories]),
            "category_count": len(categories),
            "assignment_count": sum(
              len(cat["assignments"])
              for quarter_categories in category_quarters.values()
              for cat in quarter_categories
            ),
            "categories_below_count": categories_below_count,
            "strongest_category": strongest_category,
            "weakest_category": weakest_category,
            "categories": sorted(categories, key=lambda cat: (cat["average"] is None, cat["average"] or 999)),
            "categories_by_term": category_quarters,
            "categories_year": year_categories,
            "timeline_quarters": timeline_quarters,
            "timeline_current": current_timeline,
            "timeline_year": year_timeline,
        })
    return sorted(classes, key=lambda item: item["term_grade"])


def build_watchlist(classes):
    items, _ = collect_attention_groups(classes)
    return items[:14]


def build_attention_summary(classes):
    attention_classes, category_rows = collect_attention_groups(classes)
    return {
        "attention_classes": attention_classes[:6],
        "attention_categories": category_rows[:8],
        "strong_classes": sorted(classes, key=lambda item: item["term_grade"], reverse=True)[:5],
    }


def build_analytics_payload(classes, current_term, quarter_avgs, year_avg):
    year_timeline = align_class_timelines([
        {
            "classid": item["classid"],
            "label": item["name"],
            "short_name": item["short_name"],
            "color": item["color"],
            "timeline": item["timeline_year"],
        }
        for item in classes
    ])

    quarter_timelines = {}
    for term in range(1, 5):
        quarter_timelines[str(term)] = align_class_timelines([
            {
                "classid": item["classid"],
                "label": item["name"],
                "short_name": item["short_name"],
                "color": item["color"],
                "timeline": item["timeline_quarters"].get(str(term), {"labels": [], "values": []}),
            }
            for item in classes
        ])

    class_category_rows = []
    for item in classes:
        for cat in item["categories"]:
            if cat["average"] is None:
                continue
            class_category_rows.append({
                "label": f"{cat['name']} ({item['short_name']})",
                "value": cat["average"],
                "classid": item["classid"],
                "category": cat["name"],
                "color": item["color"],
            })

    class_category_rows.sort(key=lambda row: row["value"])

    return {
        "yearly": {
            "timeline": year_timeline,
            "quarter_labels": [f"Q{idx}" for idx in range(1, 5)],
            "quarter_values": [quarter_avgs.get(str(idx)) for idx in range(1, 5)],
            "year_average": year_avg,
        },
        "quarterly": {
            "timeline": quarter_timelines[str(current_term)],
            "terms": quarter_timelines,
            "term": f"Q{current_term}",
            "current_term": str(current_term),
            "class_labels": [item["short_name"] for item in classes],
            "class_values": [item["term_grade"] for item in classes],
            "class_ids": [item["classid"] for item in classes],
            "class_statuses": [item["status"] for item in classes],
            "class_colors": [item["color"] for item in classes],
        },
        "classview": {
            "categories": class_category_rows,
        },
    }


def build_payload(model):
    current_term = str(model["current_term"] or CURRENT_TERM)
    classes = build_class_records(model["merged"], current_term)
    summary = build_attention_summary(classes)
    analytics = build_analytics_payload(classes, current_term, model["quarter_avgs"], model["year_avg"])

    return {
        "meta": {
            "year": model["academic_year"],
            "term": f"Q{current_term}",
            "updated": iso_to_readable(model.get("updated")),
            "threshold": ATTENTION_PERCENT_THRESHOLD,
            "quarter_average": model["quarter_avg"],
            "year_average": model["year_avg"],
            "tracked_classes": len(classes),
        },
        "overview": {
            "attention_count": len(summary["attention_classes"]),
            "strong_count": len([item for item in classes if item["status"] == "strong"]),
            "classes_above_threshold": len([item for item in classes if item["term_grade"] >= ATTENTION_PERCENT_THRESHOLD]),
            "classes_below_threshold": len([item for item in classes if item["term_grade"] < ATTENTION_PERCENT_THRESHOLD]),
        },
        "watchlist": build_watchlist(classes),
        "classes": classes,
        "analytics": analytics,
        "attention_summary": summary,
    }


def build_html(payload):
    template = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grades Dashboard 2.0</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
@import url('https://fonts.googleapis.com/css2?family=Sora:wght@600;700;800&display=swap');

:root {
  --bg: linear-gradient(140deg, #eef3f8 0%, #f7f9fc 60%, #edf2f7 100%);
  --panel: #ffffff;
  --panel-alt: #f6f8fb;
  --sidebar-bg: linear-gradient(180deg, #f9fbfe 0%, #f2f6fb 100%);
  --line: #d7dee8;
  --text: #132033;
  --muted: #56657a;
  --accent: #1e5aa5;
  --accent-soft: #e9f1fc;
  --accent-strong: #194884;
  --good: #1d6b4a;
  --warn: #9a6700;
  --danger: #b42318;
  --shadow: 0 10px 26px rgba(13, 26, 46, 0.08);
  --card-shadow: 0 8px 20px rgba(19, 39, 67, 0.08);
  --card-shadow-hover: 0 16px 30px rgba(19, 39, 67, 0.12);
  --radius: 14px;
  --sidebar-width: 280px;
  --sidebar-collapsed-width: 76px;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: "Segoe UI", Tahoma, sans-serif;
  color: var(--text);
  background: var(--bg);
}
.app {
  min-height: 100vh;
  padding: 14px;
}
.appbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 12px 14px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  margin-bottom: 12px;
}
.appbar-title {
  font-family: "Sora", "Segoe UI", Tahoma, sans-serif;
  font-size: 1.28rem;
  font-weight: 800;
  letter-spacing: 0.01em;
  background: linear-gradient(120deg, #163f76 0%, #1e5aa5 55%, #2a6fc4 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.appbar-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--muted);
  font-size: 0.9rem;
}
.chip {
  display: inline-flex;
  align-items: center;
  padding: 5px 9px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--panel-alt);
}
.dashboard-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 0 12px;
}
.layout {
  display: grid;
  grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
  gap: 12px;
  align-items: stretch;
  min-height: calc(100vh - 106px);
  transition: grid-template-columns 220ms ease;
}
body.sidebar-collapsed .layout {
  grid-template-columns: var(--sidebar-collapsed-width) minmax(0, 1fr);
}
.content {
  min-width: 0;
  order: 2;
}
.sidebar {
  background: var(--sidebar-bg);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  position: sticky;
  top: 14px;
  min-height: calc(100vh - 106px);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  transition: width 220ms ease, padding 220ms ease;
  order: 1;
}
body.sidebar-collapsed .sidebar {
  padding: 10px;
  align-items: center;
}
.sidebar-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 4px 4px 6px;
}
.sidebar-title {
  font-size: 0.82rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
  font-weight: 700;
}
.sidebar-nav {
  display: grid;
  gap: 2px;
}
body.sidebar-collapsed .sidebar-title,
body.sidebar-collapsed .tab-text,
body.sidebar-collapsed .sidebar-note {
  display: none;
}
body.sidebar-collapsed .sidebar-head {
  width: 100%;
  justify-content: center;
  margin: 4px 0 8px;
}
body.sidebar-collapsed .sidebar-nav {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  gap: 8px;
}
body.sidebar-collapsed .sidebar-nav > div {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
}
.sidebar-toggle {
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--panel-alt);
  color: var(--text);
  font: inherit;
  width: 32px;
  height: 32px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.sidebar-toggle:hover {
  box-shadow: 0 6px 14px rgba(28, 54, 89, 0.1);
}
.sidebar-toggle-icon {
  display: inline-flex;
  transition: transform 200ms ease;
}
.sidebar-toggle-icon svg {
  width: 14px;
  height: 14px;
  display: block;
}
body.sidebar-collapsed .sidebar-toggle-icon {
  transform: rotate(180deg);
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.stats-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}
.gauge-card {
  background: linear-gradient(180deg, #ffffff 0%, #ffffff 100%);
  border: 1px solid #d9e2ee;
  border-radius: var(--radius);
  padding: 14px;
  box-shadow: var(--card-shadow);
  overflow: hidden;
  transition: transform 180ms ease, box-shadow 200ms ease, border-color 180ms ease;
  position: relative;
}
.gauge-card:hover {
  transform: none;
  box-shadow: var(--card-shadow);
}
.gauge-card::before {
  content: "";
  position: absolute;
  inset: -20%;
  background: transparent;
  opacity: 0;
  pointer-events: none;
  animation: none;
}
.gauge-card::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.06) 0%, transparent 38%);
  pointer-events: none;
}
.gauge-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
  position: relative;
  z-index: 1;
  color: #24324a;
}
.gauge-head strong {
  font-size: 0.98rem;
  color: #24324a;
  font-weight: 800;
}
.gauge-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  position: relative;
  z-index: 1;
}
.gauge-canvas {
  display: block;
  width: min(100%, 300px);
  aspect-ratio: 1 / 1;
  animation: gauge-float 6.5s ease-in-out infinite alternate;
}
.gauge-side {
  min-width: 62px;
  text-align: center;
}
.gauge-side label {
  display: block;
  font-size: 0.72rem;
  color: var(--muted);
  margin-bottom: 4px;
  text-transform: uppercase;
}
.gauge-side strong {
  font-size: 1.05rem;
}
.gauge {
  --gauge-value: 50;
  --gauge-color: var(--accent);
  width: 210px;
  height: 120px;
  position: relative;
  transition: box-shadow 220ms ease;
}
.gauge-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.gauge-track {
  fill: none;
  stroke: #dadada;
  stroke-width: 18;
  stroke-linecap: round;
}
.gauge-progress {
  fill: none;
  stroke: var(--gauge-color);
  stroke-width: 18;
  stroke-linecap: round;
  stroke-dasharray: 251;
  stroke-dashoffset: 251;
  transition: stroke-dashoffset 1.2s cubic-bezier(0.22, 0.9, 0.24, 1);
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.14));
}
.gauge-segment {
  fill: none;
  stroke-width: 10;
  stroke-linecap: butt;
}
.gauge-segment.inactive {
  stroke: rgba(218, 224, 235, 0.16);
}
.gauge-segment.active {
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.14));
}
.gauge-segment.last-active {
  animation: gauge-segment-pulse 1.15s ease-in-out infinite alternate;
}
@keyframes gauge-segment-pulse {
  from { opacity: 0.72; }
  to { opacity: 1; }
}
@keyframes gauge-orb-float {
  from { transform: translate3d(-1.5%, -1%, 0) scale(1); }
  to { transform: translate3d(1.5%, 1%, 0) scale(1.02); }
}
@keyframes gauge-float {
  from { transform: translateY(0px); }
  to { transform: translateY(-3px); }
}
.gauge-face {
  fill: #ffffff;
  stroke: #d8e0eb;
  stroke-width: 1;
}
.gauge-tick {
  stroke: rgba(0, 0, 0, 0.08);
  stroke-linecap: round;
}
.gauge-tick.major {
  stroke: rgba(0, 0, 0, 0.14);
}
.gauge-label {
  fill: rgba(90, 90, 90, 0.92);
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-anchor: middle;
}
.gauge-aura {
  fill: none;
  stroke-width: 28;
  opacity: 0.14;
  stroke-linecap: round;
  filter: blur(8px);
}
.gauge-highlight {
  fill: none;
  stroke: rgba(255, 255, 255, 0.35);
  stroke-width: 3;
  stroke-linecap: round;
}
.gauge-end-dot {
  filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.22));
}
.threshold-meta {
  display: flex;
  justify-content: center;
  gap: 24px;
  margin-top: 8px;
}
.threshold-meta-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
.threshold-meta-item span {
  color: var(--muted);
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.threshold-meta-item strong {
  font-size: 1rem;
}
.gauge-center {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 4px;
  z-index: 1;
  text-align: center;
}
.gauge-center strong {
  display: block;
  font-size: 30px;
  font-weight: 700;
  color: var(--accent-strong);
  text-shadow: 0 1px 0 rgba(255, 255, 255, 0.7), 0 2px 4px rgba(0, 0, 0, 0.06);
  letter-spacing: 0;
}
.gauge-center span {
  display: none;
}
.tab {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.76);
  color: var(--text);
  padding: 10px 11px;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  transition: background 160ms ease, border-color 160ms ease, transform 160ms ease, box-shadow 160ms ease;
  position: relative;
}
.tab-badge {
  width: 24px;
  height: 24px;
  border-radius: 999px;
  background: #dde6f3;
  color: var(--accent-strong);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.78rem;
  font-weight: 700;
}
.tab-badge svg {
  width: 14px;
  height: 14px;
  display: block;
  flex-shrink: 0;
}
.tab-badge .stroke {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.tab.active {
  background: rgba(30, 90, 165, 0.14);
  border-color: #c9d8ec;
  color: var(--text);
  box-shadow: inset 0 0 0 1px rgba(30, 90, 165, 0.16);
}
.tab.active .tab-badge {
  background: rgba(30, 90, 165, 0.18);
  color: var(--accent-strong);
}
.tab:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 16px rgba(28, 54, 89, 0.12);
}
body.sidebar-collapsed .tab {
  width: 50px;
  height: 50px;
  margin-inline: auto;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0;
  border-radius: 12px;
}
body.sidebar-collapsed .tab-badge {
  width: 26px;
  height: 26px;
}
body.sidebar-collapsed .tab.active::before {
  display: none;
}
.section {
  display: none;
  animation: fadeInUp 220ms ease;
}
.section.active {
  display: block;
}
@keyframes fadeInUp {
  from { opacity: 0; transform: translateY(5px); }
  to { opacity: 1; transform: translateY(0); }
}
.section-head {
  display: flex;
  justify-content: space-between;
  align-items: end;
  gap: 12px;
  margin-bottom: 12px;
}
.section-head h2 {
  margin: 0;
  font-size: 1.35rem;
}
.section-head p {
  margin: 4px 0 0;
  color: var(--muted);
}
.panel {
  background: linear-gradient(180deg, #ffffff 0%, #f9fbff 100%);
  border: 1px solid #d9e2ee;
  border-radius: var(--radius);
  box-shadow: var(--card-shadow);
  padding: 14px;
  transition: transform 180ms ease, box-shadow 200ms ease, border-color 180ms ease;
}
.panel:hover {
  transform: translateY(-1px);
  box-shadow: var(--card-shadow-hover);
}
.panel h3 {
  margin: 0 0 10px;
  font-size: 1rem;
}
.analytics-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
.sidebar-note {
  margin: auto 4px 2px;
  padding-top: 10px;
  border-top: 1px solid #d8e1ed;
  color: var(--muted);
  font-size: 0.8rem;
  line-height: 1.4;
}
.subtab {
  border: 1px solid var(--line);
  border-radius: 10px;
  background: linear-gradient(180deg, #ffffff 0%, #f7faff 100%);
  padding: 8px 12px;
  font: inherit;
  cursor: pointer;
  transition: transform 160ms ease, box-shadow 180ms ease, border-color 160ms ease;
}
.subtab.active {
  background: rgba(30, 90, 165, 0.14);
  border-color: #c9d8ec;
  box-shadow: inset 0 0 0 1px rgba(30, 90, 165, 0.14);
}
.subtab:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 14px rgba(28, 54, 89, 0.1);
}
.analytics-view {
  display: none;
}
.analytics-view.active {
  display: block;
}
.grid-2 {
  display: grid;
  grid-template-columns: 1.45fr 1fr;
  gap: 12px;
}
.grid-3 {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.chart-wrap {
  position: relative;
  height: 320px;
}
.chart-wrap.tall {
  height: 420px;
}
.analytics-grid {
  display: grid;
  grid-template-columns: 1.4fr 0.9fr;
  gap: 12px;
}
.analytics-grid.bottom {
  margin-top: 12px;
}
.year-gauge {
  min-height: 320px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.gauge-large {
  width: 210px;
  height: 120px;
}
.gauge-large .gauge-center strong {
  font-size: 30px;
}
.gauge-large .gauge-center span {
  font-size: 0.78rem;
}
.gauge-context {
  margin-top: 12px;
  color: var(--muted);
  font-size: 0.88rem;
  text-align: center;
}
.quarter-nav {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.quarter-btn {
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--panel);
  padding: 8px 12px;
  font: inherit;
  cursor: pointer;
}
.quarter-btn.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.class-controls {
  display: grid;
  grid-template-columns: 1.4fr 0.8fr 1.2fr;
  gap: 8px;
  margin-bottom: 12px;
}
.control-group label {
  display: block;
  color: var(--muted);
  font-size: 0.76rem;
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.control-select {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #fff;
  padding: 10px 12px;
  font: inherit;
}
.click-note {
  color: var(--muted);
  font-size: 0.84rem;
  margin-top: 8px;
}
.timeline-point-popup {
  position: fixed;
  z-index: 1200;
  transform: translate(-50%, calc(-100% - 16px));
  width: min(340px, calc(100vw - 24px));
  pointer-events: none;
  opacity: 0;
  visibility: hidden;
  transition: opacity 140ms ease, visibility 140ms ease;
}
.timeline-point-popup.is-visible {
  pointer-events: auto;
  opacity: 1;
  visibility: visible;
}
.timeline-point-popup-card {
  background: #fff;
  border: 1px solid #d5dee9;
  border-radius: 14px;
  box-shadow: 0 14px 36px rgba(13, 26, 46, 0.16);
  overflow: hidden;
}
.timeline-point-popup-arrow {
  position: absolute;
  left: 50%;
  bottom: -7px;
  width: 14px;
  height: 14px;
  background: #fff;
  border-right: 1px solid #d5dee9;
  border-bottom: 1px solid #d5dee9;
  transform: translateX(-50%) rotate(45deg);
}
.timeline-point-popup-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px 10px;
  border-bottom: 1px solid #e8edf3;
  background: linear-gradient(180deg, #fbfcfe 0%, #f6f9fc 100%);
}
.timeline-point-popup-head strong {
  display: block;
  font-size: 0.95rem;
}
.timeline-point-popup-head span {
  display: block;
  margin-top: 3px;
  color: var(--muted);
  font-size: 0.8rem;
  line-height: 1.35;
}
.timeline-point-popup-close {
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 1.25rem;
  line-height: 1;
  padding: 2px 6px;
  cursor: pointer;
  border-radius: 8px;
}
.timeline-point-popup-close:hover {
  background: #e8edf3;
  color: var(--text);
}
.timeline-point-popup-body {
  max-height: 260px;
  overflow-y: auto;
  padding: 8px 10px 10px;
}
.timeline-point-popup-group + .timeline-point-popup-group {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #eef2f7;
}
.timeline-point-popup-class {
  font-size: 0.76rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--accent-strong);
  margin: 0 4px 6px;
}
.timeline-point-popup-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
}
.timeline-point-popup-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 10px;
  background: #f7f9fc;
  border: 1px solid #e8edf3;
}
.timeline-point-popup-row.attention {
  background: #fef6f5;
  border-color: #f0d4d1;
}
.timeline-point-popup-row.strong {
  background: #f4fbf7;
  border-color: #d3e8dc;
}
.timeline-point-popup-row-main {
  min-width: 0;
}
.timeline-point-popup-asn {
  display: block;
  font-size: 0.88rem;
  font-weight: 600;
  line-height: 1.3;
}
.timeline-point-popup-cat {
  display: block;
  margin-top: 2px;
  color: var(--muted);
  font-size: 0.76rem;
}
.timeline-point-popup-row strong {
  font-size: 0.9rem;
  white-space: nowrap;
}
.timeline-point-popup-empty {
  margin: 0;
  padding: 10px 6px;
  color: var(--muted);
  font-size: 0.88rem;
}
.list {
  display: grid;
  gap: 8px;
}
.row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: start;
  padding: 10px 12px;
  background: linear-gradient(180deg, #f9fbff 0%, #f4f8fd 100%);
  border: 1px solid #d8e2ef;
  border-radius: 10px;
  transition: transform 160ms ease, box-shadow 180ms ease, border-color 160ms ease;
}
.row:hover {
  transform: translateY(-1px);
  box-shadow: 0 7px 16px rgba(34, 59, 94, 0.1);
}
.row strong {
  display: block;
}
.row span {
  color: var(--muted);
  font-size: 0.88rem;
}
.tone-attention {
  color: var(--danger);
  font-weight: 700;
}
.tone-strong {
  color: var(--good);
  font-weight: 700;
}
.watch-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.watch-card {
  position: relative;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 16px;
  box-shadow: 0 2px 10px rgba(13, 26, 46, 0.05);
  padding: 16px 18px 16px 22px;
  cursor: pointer;
  overflow: hidden;
  transition: transform 180ms ease, box-shadow 200ms ease, border-color 180ms ease;
}
.watch-card::before {
  content: "";
  position: absolute;
  left: 0;
  top: 12px;
  bottom: 12px;
  width: 4px;
  border-radius: 0 4px 4px 0;
  background: var(--line);
}
.watch-card.attention {
  background: #fef9f8;
  border-color: #ecd9d6;
}
.watch-card.attention::before { background: var(--danger); }
.watch-card.watch {
  background: #fffdf6;
  border-color: #ebe2c8;
}
.watch-card.watch::before { background: var(--warn); }
.watch-card.strong {
  background: #f7fcf9;
  border-color: #d5e8de;
}
.watch-card.strong::before { background: var(--good); }
.watch-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 10px 24px rgba(13, 26, 46, 0.08);
}
.watch-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 14px;
}
.watch-head h3 {
  margin: 0 0 4px;
  font-size: 1.02rem;
  font-weight: 700;
}
.watch-subtitle {
  margin: 0;
  color: var(--muted);
  font-size: 0.88rem;
  line-height: 1.4;
}
.watch-reason {
  margin-top: 10px;
  color: var(--muted);
  font-size: 0.9rem;
  line-height: 1.45;
}
.watch-grade {
  min-width: 72px;
  text-align: right;
  font-weight: 700;
  font-size: 1.25rem;
  letter-spacing: -0.02em;
}
.watch-status {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 0.76rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
.watch-status.attention {
  color: #8f2218;
  background: rgba(180, 35, 24, 0.1);
}
.watch-status.watch {
  color: #7a5600;
  background: rgba(154, 103, 0, 0.12);
}
.watch-links {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
}
.watch-chip {
  border: 1px solid var(--line);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.85);
  padding: 6px 11px;
  font: inherit;
  font-size: 0.84rem;
  color: var(--text);
  cursor: pointer;
  transition: background 150ms ease, border-color 150ms ease;
}
.watch-chip:hover {
  border-color: #c5d3e4;
  background: #fff;
}
.watch-chip.attention {
  border-color: rgba(180, 35, 24, 0.22);
  color: #8f2218;
  background: rgba(180, 35, 24, 0.06);
}
.watch-chip.watch {
  border-color: rgba(154, 103, 0, 0.22);
  color: #7a5600;
  background: rgba(154, 103, 0, 0.08);
}
.watch-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid rgba(19, 39, 67, 0.06);
}
.btn {
  border: 1px solid var(--line);
  border-radius: 10px;
  background: linear-gradient(180deg, #fbfdff 0%, #f3f7fd 100%);
  padding: 9px 12px;
  font: inherit;
  cursor: pointer;
  transition: transform 150ms ease, box-shadow 160ms ease;
}
.btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 14px rgba(34, 59, 94, 0.12);
}
.grades-shell {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
}
.toolbar {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
.toolbar input, .toolbar select {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #fff;
  padding: 10px 12px;
  font: inherit;
}
.toolbar-meta {
  color: var(--muted);
  font-size: 0.88rem;
  margin-bottom: 10px;
}
.class-list {
  display: grid;
  gap: 8px;
  max-height: 980px;
  overflow: auto;
}
.grades-dropdown {
  max-height: 0;
  opacity: 0;
  overflow: hidden;
  transition: max-height 300ms ease, opacity 280ms ease;
  margin-top: 0;
}
.grades-dropdown.open {
  max-height: 420px;
  opacity: 1;
  margin-top: 8px;
}
.grades-class-list {
  display: grid;
  gap: 6px;
  max-height: 400px;
  overflow-y: auto;
}
.grades-class-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: linear-gradient(180deg, #f9fbff 0%, #f4f8fd 100%);
  border: 1px solid #d8e2ef;
  border-radius: 10px;
  cursor: pointer;
  transition: all 160ms ease;
  font-size: 0.92rem;
}
.grades-class-item:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 14px rgba(28, 54, 89, 0.1);
  background: linear-gradient(180deg, #eef3f8 0%, #e8f0f7 100%);
}
.grades-class-item.active {
  background: rgba(30, 90, 165, 0.14);
  border-color: #c9d8ec;
  box-shadow: inset 0 0 0 1px rgba(30, 90, 165, 0.16);
}
.grades-class-name {
  font-weight: 600;
  color: var(--text);
}
.grades-class-average {
  font-weight: 600;
  color: var(--muted);
  font-size: 0.88rem;
  min-width: 50px;
  text-align: right;
}
.grades-class-item.attention .grades-class-average {
  color: var(--danger);
}
.grades-class-item.strong .grades-class-average {
  color: var(--good);
}
.grades-search-wrap {
  display: none;
  width: 100%;
  gap: 6px;
}
.grades-search-wrap.visible {
  display: flex;
}
#gradesSearchInput {
  flex: 1;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #fff;
  padding: 8px 10px;
  font: inherit;
  font-size: 0.9rem;
  color: var(--text);
}
.class-card {
  background: linear-gradient(180deg, #ffffff 0%, #f7faff 100%);
  border: 1px solid #d9e3f0;
  border-left: 6px solid var(--line);
  border-radius: 12px;
  padding: 12px;
  cursor: pointer;
  box-shadow: 0 5px 14px rgba(34, 59, 94, 0.08);
  transition: transform 170ms ease, box-shadow 190ms ease, border-color 170ms ease;
}
.class-card.attention { border-left-color: var(--danger); }
.class-card.strong { border-left-color: var(--good); }
.class-card:hover {
  transform: translateY(-1px);
  box-shadow: 0 11px 22px rgba(34, 59, 94, 0.13);
}
.class-card.active {
  background: linear-gradient(180deg, #f6faff 0%, #eef4fb 100%);
  border-color: #d0deee;
  box-shadow: 0 10px 22px rgba(45, 93, 160, 0.12);
}
.class-card-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.class-grade {
  text-align: right;
  font-weight: 700;
}
.meta-line {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.tag {
  font-size: 0.78rem;
  padding: 4px 8px;
  border-radius: 999px;
  background: #e9eef5;
  color: var(--muted);
}
.grades-class-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 14px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line);
}
.grades-class-header h2 {
  margin: 0 0 8px;
  font-size: 1.2rem;
}
.grades-class-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.status-pill {
  display: inline-flex;
  align-items: center;
  padding: 5px 12px;
  border-radius: 999px;
  font-size: 0.88rem;
  font-weight: 700;
  background: var(--accent-soft);
  color: var(--accent-strong);
}
.status-pill.attention {
  background: rgba(180, 35, 24, 0.1);
  color: #8f2218;
}
.status-pill.strong {
  background: rgba(29, 107, 74, 0.1);
  color: var(--good);
}
.meta-chip {
  color: var(--muted);
  font-size: 0.86rem;
}
.class-insight {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}
.class-insight-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 14px;
}
.class-insight-name {
  margin: 0 0 4px;
  font-size: 1.1rem;
}
.class-insight-meta {
  margin: 0;
  color: var(--muted);
  font-size: 0.88rem;
}
.class-insight-hero {
  text-align: right;
  padding: 10px 14px;
  border-radius: 12px;
  background: var(--accent-soft);
  min-width: 108px;
}
.class-insight-hero.attention { background: rgba(180, 35, 24, 0.08); }
.class-insight-hero.strong { background: rgba(29, 107, 74, 0.08); }
.class-insight-hero-value {
  display: block;
  font-size: 1.45rem;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: -0.02em;
}
.class-insight-hero-label {
  display: block;
  margin-top: 4px;
  color: var(--muted);
  font-size: 0.76rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.class-insight-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 18px;
  margin-bottom: 14px;
}
.insight-metric {
  min-width: 140px;
}
.insight-metric span {
  display: block;
  color: var(--muted);
  font-size: 0.76rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 3px;
}
.insight-metric strong {
  font-size: 0.95rem;
  font-weight: 600;
}
.class-insight-chart-wrap {
  margin-top: 2px;
}
.class-insight-chart-label {
  display: block;
  color: var(--muted);
  font-size: 0.76rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 6px;
}
.class-insight-chart {
  position: relative;
  height: 118px;
  max-width: 380px;
}
.category-list {
  display: grid;
  gap: 10px;
}
.category-card {
  background: linear-gradient(180deg, #ffffff 0%, #f8fbff 100%);
  border: 1px solid #d8e2ef;
  border-left: 6px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 6px 16px rgba(35, 59, 93, 0.08);
  transition: transform 170ms ease, box-shadow 190ms ease, border-color 170ms ease;
}
.category-card.attention { border-left-color: var(--danger); }
.category-card.strong { border-left-color: var(--good); }
.category-card:hover {
  transform: translateY(-1px);
  box-shadow: 0 12px 24px rgba(35, 59, 93, 0.13);
}
.category-head {
  width: 100%;
  border: 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  background: linear-gradient(180deg, #fbfdff 0%, #f1f6fd 100%);
  padding: 12px;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.category-head:hover {
  box-shadow: inset 0 0 0 1px rgba(36, 65, 103, 0.08);
}
.category-title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.category-caret {
  display: inline-block;
  color: var(--muted);
  font-size: 0.9rem;
  transition: transform 180ms ease;
}
.category-card.open .category-caret {
  transform: rotate(90deg);
}
.category-body {
  max-height: 0;
  opacity: 0;
  overflow: hidden;
  transition: max-height 220ms ease, opacity 180ms ease;
}
.category-card.open .category-body {
  max-height: 360px;
  opacity: 1;
}
.assignment-scroll {
  max-height: 320px;
  overflow: auto;
  border-top: 1px solid var(--line);
}
.grades-table {
  width: 100%;
  border-collapse: collapse;
}
.grades-table th, .grades-table td {
  padding: 10px 12px;
  border-top: 1px solid var(--line);
  text-align: left;
  font-size: 0.9rem;
}
.grades-table thead th {
  position: sticky;
  top: 0;
  background: #fff;
  z-index: 1;
}
.grades-table th {
  color: var(--muted);
  font-size: 0.76rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.grades-table td.num {
  text-align: right;
}
.grades-table tr.low td {
  background: #fde9e7;
}
.empty {
  color: var(--muted);
  padding: 14px 0;
}
@media (max-width: 1180px) {
  .layout { grid-template-columns: 1fr; }
  .sidebar {
    position: static;
    order: -1;
    min-height: 0;
  }
  body.sidebar-collapsed .layout { grid-template-columns: 1fr; }
  body.sidebar-collapsed .sidebar-title,
  body.sidebar-collapsed .tab-text,
  body.sidebar-collapsed .sidebar-note {
    display: initial;
  }
  .stats-row { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .grid-2, .grades-shell, .watch-grid { grid-template-columns: 1fr; }
  .analytics-grid, .class-controls { grid-template-columns: 1fr; }
}
@media (max-width: 760px) {
  .stats-row, .grid-3, .watch-grid { grid-template-columns: 1fr; }
  .class-insight-chart { max-width: none; }
  .appbar, .section-head, .toolbar { flex-direction: column; align-items: stretch; }
}
</style>
</head>
<body>
<div class="app">
  <div class="appbar">
    <div>
      <div class="appbar-title">Grades Dashboard 2.0</div>
    </div>
  </div>

  <div class="layout">
  <main class="content">
  <section id="dashboard" class="section active">
    <div class="section-head">
      <div>
        <h2>Dashboard</h2>
        <p>Snapshot view of the current quarter and year so you can assess status at a glance.</p>
      </div>
    </div>
    <div class="dashboard-meta">
      <span class="chip">__META_YEAR__</span>
      <span class="chip">__META_TERM__</span>
      <span class="chip">Threshold __META_THRESHOLD__%</span>
      <span class="chip">Updated __META_UPDATED__</span>
    </div>
    <div class="stats-row">
      <div class="gauge-card" id="quarterGauge"></div>
      <div class="gauge-card" id="yearGauge"></div>
    </div>
    <div class="grid-2" style="margin-top:12px;">
      <div class="panel">
        <h3>Year summary</h3>
        <div class="list" id="dashboardHighlights"></div>
      </div>
      <div class="panel">
        <h3>Attention preview</h3>
        <div class="list" id="dashboardAttentionPreview"></div>
      </div>
    </div>
  </section>

  <section id="analytics" class="section">
    <div class="section-head">
      <div>
        <h2>Analytics</h2>
        <p>Use the timelines to see how averages moved over time based on assignment due dates, then use class and category views to find what actually needs work.</p>
      </div>
    </div>
    <div class="analytics-tabs">
      <button class="subtab active" data-view="yearly">Yearly</button>
      <button class="subtab" data-view="quarterly">Quarterly</button>
      <button class="subtab" data-view="classview">Class</button>
    </div>

    <div id="view-yearly" class="analytics-view active">
      <div class="analytics-grid">
        <div class="panel">
          <h3>Year timeline by due date</h3>
          <div class="chart-wrap"><canvas id="yearTimelineChart"></canvas></div>
        </div>
        <div class="panel year-gauge">
          <h3>Year hover gauge</h3>
          <div id="yearHoverGauge"></div>
          <div class="gauge-context" id="yearGaugeContext">Hover the year timeline to preview the selected period. Leave the graph to return to the current year average.</div>
        </div>
      </div>
      <div class="analytics-grid bottom">
        <div class="panel">
          <h3>Quarter summary</h3>
          <div class="chart-wrap"><canvas id="quarterSummaryChart"></canvas></div>
        </div>
        <div class="panel">
          <h3>Yearly notes</h3>
          <div class="list" id="yearlyNotes"></div>
        </div>
      </div>
    </div>

    <div id="view-quarterly" class="analytics-view">
      <div class="quarter-nav" id="quarterNav"></div>
      <div class="grid-2">
        <div class="panel">
          <h3>Quarter running average by due date</h3>
          <div class="chart-wrap"><canvas id="quarterTimelineChart"></canvas></div>
        </div>
        <div class="panel">
          <h3>Quarter class averages</h3>
          <div class="chart-wrap tall"><canvas id="classAverageChart"></canvas></div>
        </div>
      </div>
      <div class="grid-3" style="margin-top:12px;">
        <div class="panel">
          <h3>Classes needing attention</h3>
          <div class="list" id="attentionClassesList"></div>
        </div>
        <div class="panel">
          <h3>Categories needing attention</h3>
          <div class="list" id="attentionCategoriesList"></div>
        </div>
        <div class="panel">
          <h3>Strongest classes</h3>
          <div class="list" id="strongClassesList"></div>
        </div>
      </div>
    </div>

    <div id="view-classview" class="analytics-view">
      <div class="panel class-analytics-panel" style="margin-bottom:12px;">
        <div class="class-controls" style="margin-bottom:0;">
          <div class="control-group">
            <label for="analyticsClassSelect">Class</label>
            <select id="analyticsClassSelect" class="control-select"></select>
          </div>
          <div class="control-group">
            <label for="analyticsPeriodSelect">Period</label>
            <select id="analyticsPeriodSelect" class="control-select">
              <option value="1">Q1</option>
              <option value="2">Q2</option>
              <option value="3">Q3</option>
              <option value="4">Q4</option>
              <option value="year">Year</option>
            </select>
          </div>
          <div class="control-group">
            <label for="analyticsCategorySelect">Category</label>
            <select id="analyticsCategorySelect" class="control-select"></select>
          </div>
        </div>
        <div id="classInsightPanel" class="class-insight" aria-live="polite"></div>
        <div class="click-note">Click a timeline point to see assignments due that day. Click a category bar to open it in Grades.</div>
      </div>
      <div class="grid-2">
        <div class="panel">
          <h3>Selected class running average by due date</h3>
          <div class="chart-wrap"><canvas id="classTimelineChart"></canvas></div>
        </div>
        <div class="panel">
          <h3>Selected class category averages</h3>
          <div class="chart-wrap"><canvas id="classCategoryChart"></canvas></div>
        </div>
      </div>
    </div>
  </section>

  <section id="watchlist" class="section">
    <div class="section-head">
      <div>
        <h2>Watchlist</h2>
        <p>Only classes and categories are shown here, since those are the areas you can actually influence going forward.</p>
      </div>
    </div>
    <div class="watch-grid" id="watchlistGrid"></div>
  </section>

  <section id="grades" class="section">
    <div class="section-head">
      <div>
        <h2>Grades</h2>
        <p>Pick a class from the sidebar, then review categories and assignments. Trends and quarter breakdowns live in Analytics → Class.</p>
      </div>
    </div>
    <div class="grades-shell">
      <div class="panel">
        <div id="classDetail" class="empty">Select a class from the sidebar to inspect it.</div>
      </div>
    </div>
  </section>
  </main>

  <aside class="sidebar" id="sidebar" role="tablist" aria-label="Dashboard sections">
    <div class="sidebar-head">
      <div class="sidebar-title">Sections</div>
      <button id="sidebarToggle" class="sidebar-toggle" type="button" aria-label="Collapse sidebar" aria-expanded="true">
        <span class="sidebar-toggle-icon" aria-hidden="true">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path class="stroke" d="M10.5 3.2 6 8l4.5 4.8"></path>
          </svg>
        </span>
        <span class="visually-hidden">Toggle sidebar</span>
      </button>
    </div>
    <div class="sidebar-nav">
      <button class="tab active" data-section="dashboard" type="button"><span class="tab-badge"><svg viewBox="0 0 16 16" aria-hidden="true"><rect class="stroke" x="2.3" y="2.3" width="11.4" height="11.4" rx="2.2"></rect><path class="stroke" d="M5.2 9.6l2-2 1.6 1.6 2.2-2.2"></path></svg></span><span class="tab-text">Dashboard</span></button>
      <button class="tab" data-section="analytics" type="button"><span class="tab-badge"><svg viewBox="0 0 16 16" aria-hidden="true"><path class="stroke" d="M2.2 12.8h11.6"></path><rect class="stroke" x="3" y="7.8" width="2.2" height="5"></rect><rect class="stroke" x="6.9" y="5.1" width="2.2" height="7.7"></rect><rect class="stroke" x="10.8" y="3.4" width="2.2" height="9.4"></rect></svg></span><span class="tab-text">Analytics</span></button>
      <button class="tab" data-section="watchlist" type="button"><span class="tab-badge"><svg viewBox="0 0 16 16" aria-hidden="true"><path class="stroke" d="M8 2.4l1.7 3.3 3.7.5-2.7 2.6.7 3.7L8 10.8 4.6 12.5l.7-3.7-2.7-2.6 3.7-.5z"></path></svg></span><span class="tab-text">Watchlist</span></button>
      <div style="position:relative;">
        <button class="tab" data-section="grades" type="button"><span class="tab-badge"><svg viewBox="0 0 16 16" aria-hidden="true"><rect class="stroke" x="2.8" y="2.2" width="10.4" height="11.6" rx="1.8"></rect><path class="stroke" d="M5.1 5.4h5.8M5.1 8h5.8M5.1 10.6h4"></path></svg></span><span class="tab-text" id="gradesTabText">Grades</span></button>
        <div class="grades-search-wrap" id="gradesSearchWrap">
          <input id="gradesSearchInput" type="search" placeholder="Search classes..." autocomplete="off">
        </div>
        <div class="grades-dropdown" id="gradesDropdown">
          <div class="grades-class-list" id="gradesClassList"></div>
        </div>
      </div>
    </div>
    <p class="sidebar-note">Use Analytics for trends, Watchlist for priority areas, and Grades for class-level detail.</p>
  </aside>
  </div>
</div>

<div id="timelinePointPopup" class="timeline-point-popup" hidden aria-live="polite"></div>

<script>
const DATA = __PAYLOAD_JSON__;
const SECTION_IDS = __SECTION_IDS__;
const THRESHOLD = DATA.meta.threshold;
let activeClassId = DATA.classes[0] ? DATA.classes[0].classid : null;
let selectedQuarter = DATA.analytics.quarterly.current_term || '1';
let selectedPeriod = DATA.analytics.quarterly.current_term || '1';
let selectedGradesQuarter = DATA.analytics.quarterly.current_term || '1';
let selectedCategory = 'all';
let chartsReady = false;
let chartRefs = {};
let timelinePopupState = { chart: null, index: null, datasetIndex: null };
let timelinePopupScrollBound = false;
let yearGaugeHoverIndex = null;
let gaugeAnimFrame = null;
let gaugePulseFrame = null;
const animatedGaugeValues = new WeakMap();

function termLabel(value) {
  const raw = String(value || '').replace(/^Q/i, '');
  return `Q${raw}`;
}

function slug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';
}

function formatPct(value, digits = 1) {
  if (value === null || value === undefined) return 'N/A';
  return `${Number(value).toFixed(digits)}%`;
}

function toneClass(status) {
  if (status === 'attention') return 'tone-attention';
  if (status === 'strong') return 'tone-strong';
  return '';
}

function chartBounds(values) {
  const nums = values.filter((value) => value !== null && value !== undefined && !Number.isNaN(value));
  if (!nums.length) return { min: 0, max: 100 };
  const low = Math.min(...nums);
  const high = Math.max(...nums);
  const spread = Math.max(high - low, 2);
  const pad = Math.max(spread * 0.18, 1.2);
  return {
    min: Math.max(0, Math.floor((low - pad) * 10) / 10),
    max: Math.min(100, Math.ceil((high + pad) * 10) / 10),
  };
}

function flattenDatasetValues(datasets) {
  return datasets.flatMap((dataset) => dataset.data || []);
}

function findClass(classid) {
  return DATA.classes.find((item) => item.classid === classid);
}

function categoriesForGradesQuarter(item) {
  return (item.categories_by_term && item.categories_by_term[selectedGradesQuarter]) || [];
}

function gradeForGradesQuarter(item) {
  return item.quarter_values[termLabel(selectedGradesQuarter)];
}

function letterForGradesQuarter(item) {
  if (String(selectedGradesQuarter) === String(DATA.analytics.quarterly.current_term)) {
    return item.term_letter || '';
  }
  return '';
}

function categoriesBelowForQuarter(item) {
  return categoriesForGradesQuarter(item).filter((cat) => cat.status === 'attention').length;
}

function renderGaugeCard(hostId, title, percent, color, subtitle, centerText) {
  const clamped = Math.max(0, Math.min(100, percent || 0));
  document.getElementById(hostId).innerHTML = `
    <div class="gauge-head">
      <strong>${title}</strong>
      <span style="color:var(--muted); font-size:0.78rem; text-transform:uppercase; letter-spacing:0.05em;">${subtitle}</span>
    </div>
    <div class="gauge-wrap">
      ${buildSegmentedArcSvg(clamped, color, centerText, subtitle)}
    </div>
  `;
}

function renderYearHoverGauge(value, label, subtitle, contextLabel) {
  const host = document.getElementById('yearHoverGauge');
  if (!host) return;
  const safeValue = Math.max(0, Math.min(100, value || 0));
  if (host.dataset.shellReady !== '1') {
    host.dataset.shellReady = '1';
    host.innerHTML = `
      <div class="gauge-head">
        <strong>Year average</strong>
        <span class="year-gauge-label" style="color:var(--muted); font-size:0.78rem; text-transform:uppercase; letter-spacing:0.05em;">${label}</span>
      </div>
      <div class="gauge-wrap">
        ${buildSegmentedArcSvg(safeValue, '#204f9e', formatPct(safeValue), subtitle)}
      </div>
    `;
  } else {
    const labelEl = host.querySelector('.year-gauge-label');
    if (labelEl) labelEl.textContent = label;
    const canvas = host.querySelector('canvas.gauge-canvas');
    if (canvas) {
      canvas.dataset.gaugeValue = String(safeValue);
      canvas.dataset.gaugeCaption = formatPct(safeValue);
      canvas.dataset.gaugeLabel = subtitle || 'AVERAGE';
    }
  }
  const context = document.getElementById('yearGaugeContext');
  if (context) {
    context.textContent = contextLabel;
  }
}

function ensureYearHoverGaugeShell() {
  const host = document.getElementById('yearHoverGauge');
  if (!host || host.dataset.shellReady === '1') return;
  renderYearHoverGauge(
    DATA.meta.year_average || 0,
    'Current year',
    'Average across classes',
    'Hover the year timeline to preview the selected period. Leave the graph to return to the current year average.'
  );
}

function resetYearHoverGauge(animate = true) {
  yearGaugeHoverIndex = null;
  renderYearHoverGauge(
    DATA.meta.year_average || 0,
    'Current year',
    'Average across classes',
    'Hover the year timeline to preview the selected period. Leave the graph to return to the current year average.'
  );
}

function updateYearHoverGauge(value, label) {
  renderYearHoverGauge(value || 0, label, 'Average across classes', `Hovering ${label}.`);
}

function renderRowList(hostId, rows, emptyText, jumpMode = null) {
  const host = document.getElementById(hostId);
  if (!rows.length) {
    host.innerHTML = `<div class="empty">${emptyText}</div>`;
    return;
  }
  host.innerHTML = rows.map((row) => {
    const jumpAttrs = jumpMode === 'class'
      ? `data-jump-class="${row.classid}"`
      : jumpMode === 'category'
      ? `data-jump-class="${row.classid}" data-jump-category="${row.name || row.category}"`
      : '';
    return `
      <div class="row" ${jumpAttrs}>
        <div>
          <strong>${row.title || row.short_name || row.name}</strong>
          <span>${row.subtitle || row.class_name || ''}</span>
        </div>
        <div class="${toneClass(row.status)}">${formatPct(row.value !== undefined ? row.value : row.average)}</div>
      </div>
    `;
  }).join('');

  host.querySelectorAll('[data-jump-class]').forEach((node) => {
    node.style.cursor = 'pointer';
    node.addEventListener('click', () => {
      jumpToClass(node.dataset.jumpClass, node.dataset.jumpCategory || '');
    });
  });
}

function renderYearlyNotes() {
  const rows = [
    {
      title: 'Year timeline',
      subtitle: 'Each line shows one class. The dark line is the average across all tracked classes.',
      value: DATA.meta.year_average,
      status: 'strong',
    },
    {
      title: `Tracked classes: ${DATA.meta.tracked_classes}`,
      subtitle: `Current quarter average is ${formatPct(DATA.meta.quarter_average)}.`,
      value: DATA.meta.quarter_average,
      status: 'strong',
    },
    {
      title: `${DATA.overview.classes_below_threshold} classes are below threshold`,
      subtitle: 'Use Watchlist to jump directly to classes or categories that are under target.',
      value: THRESHOLD,
      status: 'attention',
    },
  ];
  renderRowList('yearlyNotes', rows, 'No yearly notes are available.');
}

function renderDashboardHighlights() {
  const highlights = [
    {
      title: 'Current quarter average',
      subtitle: `${DATA.meta.term} across ${DATA.meta.tracked_classes} tracked classes`,
      value: DATA.meta.quarter_average,
      status: DATA.meta.quarter_average < THRESHOLD ? 'attention' : 'strong',
    },
    {
      title: 'Current year average',
      subtitle: `${DATA.meta.year} running average`,
      value: DATA.meta.year_average,
      status: DATA.meta.year_average < THRESHOLD ? 'attention' : 'strong',
    },
    {
      title: `Classes below ${THRESHOLD}%`,
      subtitle: `${DATA.overview.classes_below_threshold} below target · ${DATA.overview.classes_above_threshold} on target`,
      value: DATA.overview.classes_below_threshold,
      status: DATA.overview.classes_below_threshold ? 'attention' : 'strong',
    },
  ];
  renderRowList('dashboardHighlights', highlights, 'No dashboard highlights are available.');

  const preview = DATA.attention_summary.attention_classes.slice(0, 4).map((item) => ({
    classid: item.classid,
    title: item.title,
    subtitle: item.reason,
    value: item.value,
    status: item.status,
  }));
  renderRowList(
    'dashboardAttentionPreview',
    preview,
    'No classes currently need attention.',
    'class'
  );
}

function renderStats() {
  renderGaugeCard('quarterGauge', 'Quarter average', DATA.meta.quarter_average || 0, '#204f9e', DATA.meta.term || 'Current term', formatPct(DATA.meta.quarter_average));
  renderGaugeCard('yearGauge', 'Year average', DATA.meta.year_average || 0, '#173b76', DATA.meta.year || 'School year', formatPct(DATA.meta.year_average));
}

function polarToCartesian(cx, cy, radius, angle) {
  return {
    x: cx + Math.cos(angle) * radius,
    y: cy + Math.sin(angle) * radius,
  };
}

function describeGaugeArc(cx, cy, radius, startAngle, endAngle) {
  const start = polarToCartesian(cx, cy, radius, startAngle);
  const end = polarToCartesian(cx, cy, radius, endAngle);
  const largeArcFlag = endAngle - startAngle > Math.PI ? 1 : 0;
  return `M ${start.x.toFixed(3)} ${start.y.toFixed(3)} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${end.x.toFixed(3)} ${end.y.toFixed(3)}`;
}

function buildSegmentedArcSvg(percent, color, caption = '', label = '') {
  const safeColor = color || '#204f9e';
  const clamped = Math.max(0, Math.min(100, percent || 0));
  const safeCaption = caption || `${Math.round(clamped)}%`;
  const safeLabel = label || 'AVERAGE';
  return `
    <canvas class="gauge-canvas" width="300" height="300" data-logical-width="300" data-logical-height="300" data-gauge-value="${clamped}" data-gauge-color="${safeColor}" data-gauge-caption="${safeCaption}" data-gauge-label="${safeLabel}" aria-hidden="true"></canvas>
  `;
}

function buildSpeedometerSvg(clamped, color) {
  return buildSegmentedArcSvg(clamped, color);
}

function safeGaugeId(value) {
  return String(value).replace(/[^a-z0-9_-]/gi, '_');
}

function colorForGauge(value) {
  return value >= 95 ? '#4caf50' : value >= 85 ? '#f59e0b' : '#ef4444';
}

function hexToRgb(hex) {
  const clean = String(hex).replace('#', '').trim();
  if (clean.length !== 6) return null;
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function hexToRgba(color, alpha = 0.15) {
  // Handle HSL colors: "hsl(h s% l%)" or "hsl(h, s%, l%)"
  if (String(color).toLowerCase().startsWith('hsl')) {
    // Convert "hsl(...)" to "hsla(.../ alpha)"
    const hslStr = String(color).trim();
    return hslStr.replace(/\\)$/, `/ ${alpha})`).replace('hsl(', 'hsla(');
  }
  
  // Handle hex colors: "#ffffff"
  const rgb = hexToRgb(color);
  if (!rgb) return color;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function tintColor(hex, amount) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const mix = (channel) => Math.round(channel + (255 - channel) * amount);
  return `rgb(${mix(rgb.r)}, ${mix(rgb.g)}, ${mix(rgb.b)})`;
}

function setGaugeNeedle(path, dot, percent) {
  if (!path || !dot) return;
  const length = path.getTotalLength();
  const visiblePercent = Math.max(0, Math.min(100, percent - 1.5));
  const offset = length - (visiblePercent / 100) * length;
  path.style.strokeDasharray = `${length}`;
  path.style.strokeDashoffset = `${offset}`;
  const point = path.getPointAtLength((visiblePercent / 100) * length);
  dot.setAttribute('cx', point.x);
  dot.setAttribute('cy', point.y);
}

function animateGaugeNeedle(path, dot, targetPercent, duration = 260) {
  if (!path || !dot) return;
  const length = path.getTotalLength();
  const targetOffset = length - (Math.max(0, Math.min(100, targetPercent - 1.5)) / 100) * length;
  const startOffset = parseFloat(path.style.strokeDashoffset);
  const from = Number.isFinite(startOffset) ? startOffset : length;

  if (gaugeAnimFrame) cancelAnimationFrame(gaugeAnimFrame);

  if (duration <= 0 || Math.abs(from - targetOffset) < 0.5) {
    setGaugeNeedle(path, dot, targetPercent);
    return;
  }

  const start = performance.now();
  function frame(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const current = from + (targetOffset - from) * eased;
    path.style.strokeDasharray = `${length}`;
    path.style.strokeDashoffset = `${current}`;
    const traveled = Math.max(0, Math.min(length, length - current));
    const point = path.getPointAtLength(traveled);
    dot.setAttribute('cx', point.x);
    dot.setAttribute('cy', point.y);
    if (t < 1) {
      gaugeAnimFrame = requestAnimationFrame(frame);
    } else {
      gaugeAnimFrame = null;
    }
  }
  gaugeAnimFrame = requestAnimationFrame(frame);
}

function applySpeedometerGauge(hostId, percent) {
  const host = document.getElementById(hostId);
  if (!host) return;
  const canvas = host.querySelector('canvas.gauge-canvas');
  if (!canvas || typeof canvas.getContext !== 'function') return;
  canvas.dataset.gaugeValue = String(percent);
  if (!animatedGaugeValues.has(canvas)) {
    animatedGaugeValues.set(canvas, 0);
  }
  drawSegmentedArcOnCanvas(canvas, animatedGaugeValues.get(canvas), canvas.dataset.gaugeColor || '#204f9e', performance.now() / 1000);
}

function drawSegmentedArcOnCanvas(canvas, percent, color, time = 0) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = Number(canvas.dataset.logicalWidth || 300);
  const h = Number(canvas.dataset.logicalHeight || 300);
  const scaledW = Math.round(w * dpr);
  const scaledH = Math.round(h * dpr);
  if (canvas.width !== scaledW) canvas.width = scaledW;
  if (canvas.height !== scaledH) canvas.height = scaledH;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) * 0.4;
  const startAngle = Math.PI * 0.75;
  const endAngle = Math.PI * 2.25;
  const totalArc = endAngle - startAngle;
  const majorPortion = 0.2;
  const majorValue = 60;
  const minorCount = 40;
  const majorEndAngle = startAngle + totalArc * majorPortion;
  const minorArc = (totalArc * (1 - majorPortion)) / minorCount;
  const majorGap = 0.02;
  const minorGap = 0.01;
  const safePercent = Math.max(0, Math.min(100, percent || 0));
  const valueColor = colorForGauge(safePercent);
  const baseColor = valueColor;
  const glowColor = valueColor;
  const lightColor = tintColor(baseColor, 0.28);
  const midColor = tintColor(baseColor, 0.12);


  function mapValueToVisual(value) {
    if (value <= majorValue) {
      return (value / majorValue) * (majorPortion * 100);
    }
    return (majorPortion * 100) + ((value - majorValue) / (100 - majorValue)) * ((1 - majorPortion) * 100);
  }

  function valueToAngle(value) {
    return startAngle + totalArc * (mapValueToVisual(value) / 100);
  }

  function drawArcSegment(segStart, segEnd, strokeWidth, strokeColor, alpha = 1, pulse = false, shadow = false) {
    ctx.beginPath();
    ctx.lineWidth = strokeWidth;
    ctx.lineCap = 'butt';
    ctx.strokeStyle = strokeColor;
    ctx.globalAlpha = alpha;
    if (shadow) {
      ctx.save();
      ctx.shadowColor = strokeColor;
      ctx.shadowBlur = 18;
    }
    ctx.arc(cx, cy, radius, segStart, segEnd);
    ctx.stroke();
    if (shadow) {
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function makeSegmentGradient() {
    const gradient = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
    gradient.addColorStop(0, lightColor);
    gradient.addColorStop(0.55, midColor);
    gradient.addColorStop(1, glowColor);
    return gradient;
  }

  // Draw inactive track first so the layout stays stable regardless of value.
  drawArcSegment(startAngle + majorGap / 2, majorEndAngle - majorGap / 2, 9, '#dbe5f2', 1);
  for (let i = 0; i < minorCount; i++) {
    const segStart = majorEndAngle + i * minorArc + minorGap / 2;
    const segEnd = majorEndAngle + (i + 1) * minorArc - minorGap / 2;
    drawArcSegment(segStart, segEnd, 8, '#dbe5f2', 1);
  }

  // Active fill for the major 0-60% block, compressed into the first 25% of the arc.
  const majorVisual = Math.min(safePercent, majorValue);
  const majorActiveEnd = valueToAngle(majorVisual);
  const majorPulse = safePercent > 0 && safePercent < majorValue;
  drawArcSegment(startAngle + majorGap / 2, majorActiveEnd, majorPulse ? 10 : 9, makeSegmentGradient(), majorPulse ? 0.55 + 0.45 * Math.sin(time * 3.5) : 1, majorPulse, majorPulse);

  // Active fill for the remaining 40 sections.
  if (safePercent > majorValue) {
    const minorProgress = (safePercent - majorValue) / (100 - majorValue);
    const filledMinorCount = Math.round(minorProgress * minorCount);
    for (let i = 0; i < minorCount; i++) {
      const segStart = majorEndAngle + i * minorArc + minorGap / 2;
      const segEnd = majorEndAngle + (i + 1) * minorArc - minorGap / 2;
      const isActive = i < filledMinorCount;
      const isPulse = i === filledMinorCount - 1 && filledMinorCount > 0;
      const intensity = 0.28 + 0.72 * (i / Math.max(1, minorCount - 1));
      if (isActive) {
        drawArcSegment(segStart, segEnd, isPulse ? 12 : 9, makeSegmentGradient(), isPulse ? 0.55 + 0.45 * Math.sin(time * 3.5) : intensity, isPulse, isPulse);
      }
    }
  }

  const aura = ctx.createRadialGradient(cx, cy, radius * 0.18, cx, cy, radius * 1.08);
  aura.addColorStop(0, hexToRgba(glowColor, 0.025));
  aura.addColorStop(0.42, hexToRgba(glowColor, 0.012));
  aura.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.save();
  ctx.fillStyle = aura;
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 1.05, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const faceGradient = ctx.createRadialGradient(cx, cy, radius * 0.05, cx, cy, radius * 0.52);
  faceGradient.addColorStop(0, 'rgba(255, 255, 255, 0)');
  faceGradient.addColorStop(0.7, 'rgba(255, 255, 255, 0)');
  faceGradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.52, 0, Math.PI * 2);
  ctx.fillStyle = faceGradient;
  ctx.shadowColor = 'rgba(0, 0, 0, 0)';
  ctx.shadowBlur = 0;
  ctx.fill();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = 'rgba(44, 61, 93, 0)';
  ctx.stroke();
  ctx.restore();

  [60, 70, 80, 90].forEach((threshold) => {
    const thresholdAngle = valueToAngle(threshold);
    const innerMark = radius - 18;
    const outerMark = radius + 14;

    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(thresholdAngle) * innerMark, cy + Math.sin(thresholdAngle) * innerMark);
    ctx.lineTo(cx + Math.cos(thresholdAngle) * outerMark, cy + Math.sin(thresholdAngle) * outerMark);
    ctx.strokeStyle = '#536782';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const labelR = radius + 24;
    ctx.fillStyle = '#536782';
    ctx.font = '500 10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(threshold), cx + Math.cos(thresholdAngle) * labelR, cy + Math.sin(thresholdAngle) * labelR);
  });

  const rawCaption = canvas.dataset.gaugeCaption || '';
  const percentCaptionMatch = rawCaption.trim().match(/^-?\\d+(?:\\.(\\d+))?%$/);
  const captionDecimals = percentCaptionMatch && percentCaptionMatch[1] ? percentCaptionMatch[1].length : 0;
  const displayCaption = percentCaptionMatch ? `${safePercent.toFixed(captionDecimals)}%` : (rawCaption || `${Math.round(safePercent)}%`);

  ctx.fillStyle = '#162033';
  ctx.font = '700 46px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(displayCaption, cx, cy + 2);

  ctx.fillStyle = hexToRgba(valueColor, 0.88);
  ctx.font = '400 11px "Space Grotesk", sans-serif';
  ctx.fillText(canvas.dataset.gaugeLabel || 'AVERAGE', cx, cy + 30);
  ctx.globalAlpha = 1;
}

function startGaugePulse() {
  if (gaugePulseFrame) return;

  const frame = (now) => {
    const time = now / 1000;
    document.querySelectorAll('canvas.gauge-canvas').forEach((canvas) => {
      const targetPercent = Math.max(0, Math.min(100, Number(canvas.dataset.gaugeValue || canvas.getAttribute('data-gauge') || 0)));
      const currentPercent = animatedGaugeValues.has(canvas) ? animatedGaugeValues.get(canvas) : 0;
      const diff = targetPercent - currentPercent;
      const nextPercent = Math.abs(diff) < 0.05 ? targetPercent : currentPercent + diff * 0.07;
      animatedGaugeValues.set(canvas, nextPercent);
      drawSegmentedArcOnCanvas(canvas, nextPercent, canvas.dataset.gaugeColor || '#204f9e', time);
    });
    gaugePulseFrame = requestAnimationFrame(frame);
  };

  gaugePulseFrame = requestAnimationFrame(frame);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startGaugePulse);
} else {
  startGaugePulse();
}

function populateQuarterNav() {
  const host = document.getElementById('quarterNav');
  host.innerHTML = [1, 2, 3, 4].map((term) => `
    <button class="quarter-btn ${String(term) === String(selectedQuarter) ? 'active' : ''}" data-term="${term}">Q${term}</button>
  `).join('');
  host.querySelectorAll('[data-term]').forEach((button) => {
    button.addEventListener('click', () => {
      selectedQuarter = String(button.dataset.term);
      updateQuarterView();
      if (selectedPeriod === 'quarter') {
        refreshClassAnalytics();
      }
    });
  });
}

function populateAnalyticsClassSelect() {
  const select = document.getElementById('analyticsClassSelect');
  select.innerHTML = DATA.classes.map((item) =>
    `<option value="${item.classid}">${item.short_name}</option>`
  ).join('');
  if (activeClassId) select.value = activeClassId;
}

function categorySourceForClass(item) {
  if (!item) return [];
  if (selectedPeriod === 'year') {
    return item.categories_year || [];
  }
  return (item.categories_by_term && item.categories_by_term[selectedPeriod]) || item.categories || [];
}

function timelineSourceForClass(item) {
  if (!item) return { labels: [], values: [] };
  if (selectedPeriod === 'year') {
    return item.timeline_year || { labels: [], values: [] };
  }
  return (item.timeline_quarters && item.timeline_quarters[selectedPeriod]) || item.timeline_current || { labels: [], values: [] };
}

function populateAnalyticsCategorySelect() {
  const item = findClass(activeClassId) || DATA.classes[0];
  const select = document.getElementById('analyticsCategorySelect');
  const categories = categorySourceForClass(item).filter((cat) => cat.average !== null);
  const optionValues = ['all', ...categories.map((cat) => slug(cat.name))];
  if (!optionValues.includes(selectedCategory)) {
    selectedCategory = 'all';
  }
  select.innerHTML = [`<option value="all">All categories</option>`]
    .concat(categories.map((cat) => `<option value="${slug(cat.name)}">${cat.name}</option>`))
    .join('');
  select.value = selectedCategory;
}

function classMatches(item, query, filter) {
  const quarterCategories = categoriesForGradesQuarter(item);
  const quarterGrade = gradeForGradesQuarter(item);
  const haystack = [
    item.short_name,
    item.name,
    ...quarterCategories.map((cat) => cat.name),
  ].join(' ').toLowerCase();
  const queryMatch = !query || haystack.includes(query);
  const filterMatch = filter === 'all' || statusForClientGrade(quarterGrade) === filter;
  return queryMatch && filterMatch;
}

function statusForClientGrade(value) {
  if (value === null || value === undefined) return 'unknown';
  return value < THRESHOLD ? 'attention' : 'strong';
}

function averageClient(values) {
  const nums = values.filter((value) => value !== null && value !== undefined);
  if (!nums.length) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function bindCategoryAccordions(host, openedCategory = '') {
  host.querySelectorAll('.category-head').forEach((button) => {
    const card = button.closest('.category-card');
    if (!card) return;
    if (!openedCategory && button.dataset.accordionTarget === '0') {
      card.classList.add('open');
    }
    button.addEventListener('click', () => {
      card.classList.toggle('open');
    });
  });
}

function renderClassList() {
  const host = document.getElementById('gradesClassList');
  const query = document.getElementById('gradesSearchInput').value.trim().toLowerCase();
  const filtered = DATA.classes.filter((item) => {
    const quarterGrade = gradeForGradesQuarter(item);
    const haystack = [item.short_name, item.name].join(' ').toLowerCase();
    return !query || haystack.includes(query);
  });

  if (!filtered.length) {
    host.innerHTML = '<div class="empty" style="padding:12px; color:var(--muted);">No classes match this search.</div>';
    return;
  }

  if (!filtered.some((item) => item.classid === activeClassId)) {
    activeClassId = filtered[0].classid;
  }

  host.innerHTML = filtered.map((item) => {
    const quarterGrade = gradeForGradesQuarter(item);
    const quarterStatus = statusForClientGrade(quarterGrade);
    return `
      <div class="grades-class-item ${quarterStatus} ${item.classid === activeClassId ? 'active' : ''}" data-classid="${item.classid}">
        <div class="grades-class-name">${item.short_name}</div>
        <div class="grades-class-average">${formatPct(quarterGrade)}</div>
      </div>
    `;
  }).join('');

  host.querySelectorAll('.grades-class-item').forEach((item) => {
    item.addEventListener('click', () => {
      activeClassId = item.dataset.classid;
      renderClassList();
      renderClassDetail();
    });
  });

  renderClassDetail();
}

function renderClassAnalyticsControls() {
  populateAnalyticsClassSelect();
  populateAnalyticsCategorySelect();
  document.getElementById('analyticsPeriodSelect').value = selectedPeriod;
}

function insightPeriodLabel() {
  return selectedPeriod === 'year' ? 'Year' : termLabel(selectedPeriod);
}

function quarterBarColor(value) {
  if (value === null || value === undefined) return '#c5d0de';
  if (value < THRESHOLD) return '#b42318';
  if (value >= 95) return '#1d6b4a';
  return '#204f9e';
}

function updateClassQuarterChart(item) {
  if (chartRefs.classQuarterInsight) {
    chartRefs.classQuarterInsight.destroy();
    chartRefs.classQuarterInsight = null;
  }
  const canvas = document.getElementById('classQuarterChart');
  if (!canvas || !item || typeof Chart === 'undefined') return;

  const labels = ['Q1', 'Q2', 'Q3', 'Q4'];
  const values = labels.map((label) => item.quarter_values[label]);
  const colors = values.map((value) => quarterBarColor(value));
  const currentQuarter = termLabel(DATA.analytics.quarterly.current_term);
  const bounds = chartBounds(values.filter((value) => value !== null && value !== undefined));

  chartRefs.classQuarterInsight = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: colors,
        borderColor: labels.map((label) => (label === currentQuarter ? '#132033' : 'transparent')),
        borderWidth: labels.map((label) => (label === currentQuarter ? 2 : 0)),
        borderRadius: 6,
        maxBarThickness: 44,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${formatPct(ctx.parsed.y)}`,
          },
        },
      },
      scales: {
        y: {
          min: bounds.min,
          max: bounds.max,
          grid: { color: '#e4eaf1' },
          ticks: {
            callback: (value) => `${value}%`,
            font: { size: 10 },
          },
        },
        x: {
          grid: { display: false },
          ticks: { font: { size: 11, weight: '600' } },
        },
      },
      onClick: (_, elements) => {
        if (!elements.length) return;
        const term = String(elements[0].index + 1);
        selectedPeriod = term;
        document.getElementById('analyticsPeriodSelect').value = term;
        renderClassAnalyticsControls();
        refreshClassAnalytics();
      },
    },
  });
}

function renderClassInsightPanel(item) {
  const host = document.getElementById('classInsightPanel');
  if (!host || !item) return;

  if (chartRefs.classQuarterInsight) {
    chartRefs.classQuarterInsight.destroy();
    chartRefs.classQuarterInsight = null;
  }

  const categories = categorySourceForClass(item).filter((cat) => cat.average !== null && cat.average !== undefined);
  const periodGrade = selectedPeriod === 'year'
    ? item.year_average
    : (item.quarter_values[termLabel(selectedPeriod)] ?? null);
  const periodStatus = statusForClientGrade(periodGrade);
  const strongestCategory = [...categories].sort((a, b) => b.average - a.average)[0];
  const weakestCategory = [...categories].sort((a, b) => a.average - b.average)[0];
  const belowCount = categories.filter((cat) => cat.status === 'attention').length;

  host.innerHTML = `
    <div class="class-insight-top">
      <div>
        <h3 class="class-insight-name">${item.short_name}</h3>
        <p class="class-insight-meta">${item.name}</p>
      </div>
      <div class="class-insight-hero ${periodStatus}">
        <span class="class-insight-hero-value ${toneClass(periodStatus)}">${formatPct(periodGrade)}</span>
        <span class="class-insight-hero-label">${insightPeriodLabel()} average</span>
      </div>
    </div>
    <div class="class-insight-metrics">
      <div class="insight-metric">
        <span>Year average</span>
        <strong class="${toneClass(statusForClientGrade(item.year_average))}">${formatPct(item.year_average)}</strong>
      </div>
      <div class="insight-metric">
        <span>Strongest category</span>
        <strong>${strongestCategory ? `${strongestCategory.name} · ${formatPct(strongestCategory.average)}` : 'N/A'}</strong>
      </div>
      <div class="insight-metric">
        <span>Weakest category</span>
        <strong>${weakestCategory ? `${weakestCategory.name} · ${formatPct(weakestCategory.average)}` : 'N/A'}</strong>
      </div>
      <div class="insight-metric">
        <span>Below ${THRESHOLD}%</span>
        <strong>${belowCount} categor${belowCount === 1 ? 'y' : 'ies'}</strong>
      </div>
    </div>
    <div class="class-insight-chart-wrap">
      <span class="class-insight-chart-label">Quarter averages</span>
      <div class="class-insight-chart"><canvas id="classQuarterChart" aria-label="Quarterly averages bar chart"></canvas></div>
    </div>
  `;

  updateClassQuarterChart(item);
}

function renderClassDetail(scrollCategory = '') {
  const item = findClass(activeClassId);
  const host = document.getElementById('classDetail');
  if (!item) {
    host.innerHTML = '<div class="empty">Select a class to inspect it.</div>';
    return;
  }
  const categories = categoriesForGradesQuarter(item);
  const quarterGrade = gradeForGradesQuarter(item);
  const quarterStatus = statusForClientGrade(quarterGrade);
  const letter = letterForGradesQuarter(item);

  host.innerHTML = `
    <div class="grades-class-header">
      <div>
        <h2>${item.name}</h2>
        <div class="grades-class-meta">
          <span class="status-pill ${quarterStatus}">${formatPct(quarterGrade)} · Q${selectedGradesQuarter}</span>
          ${letter ? `<span class="meta-chip">Letter ${letter}</span>` : ''}
        </div>
      </div>
      <button class="btn" id="openClassAnalytics" type="button">Trends &amp; breakdown</button>
    </div>

    <div class="category-list">
      ${categories.length ? categories.map((cat, index) => `
        <section class="category-card ${cat.status}" id="cat-${item.classid}-${slug(cat.name)}">
          <button class="category-head" type="button" data-accordion-target="${index}">
            <div class="category-title">
              <span class="category-caret">›</span>
              <div>
                <strong>${cat.name}</strong>
                <div style="color:var(--muted); font-size:0.86rem;">${cat.assignment_count} assignments</div>
              </div>
            </div>
            <div class="${toneClass(cat.status)}">${formatPct(cat.average)}</div>
          </button>
          <div class="category-body">
          ${cat.assignments.length ? `
            <div class="assignment-scroll">
            <table class="grades-table">
              <thead>
                <tr><th>Assignment</th><th>Pts</th><th>Max</th><th>%</th><th>Due</th></tr>
              </thead>
              <tbody>
                ${cat.assignments.map((asn) => `
                  <tr class="${asn.percent !== null && asn.percent < THRESHOLD ? 'low' : ''}">
                    <td>${asn.name}</td>
                    <td class="num">${asn.score ?? ''}</td>
                    <td class="num">${asn.max ?? ''}</td>
                    <td class="num">${formatPct(asn.percent)}</td>
                    <td>${asn.due || ''}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
            </div>
          ` : '<div class="empty" style="padding:12px;">No graded assignments yet.</div>'}
          </div>
        </section>
      `).join('') : `<div class="empty">No category data is available for this class in Q${selectedGradesQuarter}.</div>`}
    </div>
  `;

  document.getElementById('openClassAnalytics').addEventListener('click', () => {
    showSection('analytics');
    showView('classview');
    activeClassId = item.classid;
    selectedPeriod = String(selectedGradesQuarter);
    renderClassAnalyticsControls();
    refreshClassAnalytics();
  });

  if (scrollCategory) {
    const target = document.getElementById(`cat-${item.classid}-${slug(scrollCategory)}`);
    if (target) {
      target.classList.add('open');
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
  bindCategoryAccordions(host, scrollCategory);
}

function jumpToClass(classid, category = '') {
  activeClassId = classid;
  if (document.getElementById('analyticsClassSelect')) {
    document.getElementById('analyticsClassSelect').value = classid;
  }
  showSection('grades');
  renderClassList();
  renderClassDetail(category);
}

function showSection(sectionId) {
  SECTION_IDS.forEach((id) => {
    document.getElementById(id).classList.toggle('active', id === sectionId);
    document.querySelector(`.tab[data-section="${id}"]`).classList.toggle('active', id === sectionId);
  });
  
  const gradesDropdown = document.getElementById('gradesDropdown');
  const gradesSearch = document.getElementById('gradesSearchWrap');
  const gradesTabText = document.getElementById('gradesTabText');
  
  const sidebarToggle = document.getElementById('sidebarToggle');
  
  if (sectionId === 'grades') {
    // Auto-expand sidebar if collapsed to show the dropdown
    if (document.body.classList.contains('sidebar-collapsed')) {
      document.body.classList.remove('sidebar-collapsed');
      if (sidebarToggle) {
        sidebarToggle.setAttribute('aria-label', 'Collapse sidebar');
        sidebarToggle.setAttribute('aria-expanded', 'true');
      }
    }
    // Hide the toggle button while Grades is open
    if (sidebarToggle) {
      sidebarToggle.style.display = 'none';
    }
    gradesDropdown.classList.add('open');
    gradesSearch.classList.add('visible');
    renderClassList();
  } else {
    // Show the toggle button for other sections
    if (sidebarToggle) {
      sidebarToggle.style.display = '';
    }
    gradesDropdown.classList.remove('open');
    gradesSearch.classList.remove('visible');
  }
  
  if (sectionId === 'analytics') initCharts();
}

function showView(name, quarterOverride = null) {
  if (quarterOverride !== null && quarterOverride !== undefined) {
    selectedQuarter = String(quarterOverride);
  }
  document.querySelectorAll('.subtab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === name);
  });
  document.querySelectorAll('.analytics-view').forEach((view) => {
    view.classList.toggle('active', view.id === `view-${name}`);
  });
  if (name === 'quarterly') {
    updateQuarterView();
  }
  if (name === 'classview') {
    renderClassAnalyticsControls();
    refreshClassAnalytics();
  }
  if (name === 'yearly') {
    resetYearHoverGauge();
  }
}

function linePointStyle(color) {
  return {
    pointRadius: 0,
    pointHitRadius: 12,
    pointHoverRadius: 4,
    pointHoverBackgroundColor: color,
    pointHoverBorderColor: color,
    pointHoverBorderWidth: 0,
  };
}

function makeLineDatasets(series, averageLabel) {
  const datasets = [{
    label: averageLabel,
    data: series.average,
    borderColor: '#101828',
    backgroundColor: 'rgba(16, 24, 40, 0.15)',
    fill: 'origin',
    tension: 0.25,
    borderWidth: 3,
    ...linePointStyle('#101828'),
  }];
  series.classes.forEach((item) => {
    datasets.push({
      label: item.short_name,
      data: item.values,
      borderColor: item.color,
      backgroundColor: hexToRgba(item.color, 0.25),
      fill: 'origin',
      tension: 0.18,
      borderWidth: 2,
      hidden: true,
      ...linePointStyle(item.color),
    });
  });
  return datasets;
}

function attachLineChartMeta(chart, series) {
  if (!chart) return;
  chart.$timelinePoints = series && series.points ? series.points : null;
  chart.$classSeries = series && series.classes ? series.classes : [];
}

function formatTimelineDate(label) {
  if (!label) return 'Selected date';
  const raw = String(label);
  const dt = new Date(`${raw}T12:00:00`);
  if (Number.isNaN(dt.getTime())) return raw;
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function assignmentScoreLabel(asn) {
  if (asn.percent !== null && asn.percent !== undefined) return formatPct(asn.percent);
  if (asn.score != null && asn.max != null && asn.max !== '') return `${asn.score} / ${asn.max}`;
  return 'N/A';
}

function assignmentRowClass(asn) {
  if (asn.percent === null || asn.percent === undefined) return '';
  if (asn.percent < THRESHOLD) return 'attention';
  if (asn.percent >= 95) return 'strong';
  return '';
}

function hideTimelinePointPopup() {
  const popup = document.getElementById('timelinePointPopup');
  if (!popup) return;
  popup.classList.remove('is-visible');
  popup.hidden = true;
  popup.innerHTML = '';
  timelinePopupState = { chart: null, index: null, datasetIndex: null };
}

function bindTimelinePopupReposition() {
  if (timelinePopupScrollBound) return;
  timelinePopupScrollBound = true;
  const reposition = () => repositionTimelinePointPopup();
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);
}

function repositionTimelinePointPopup() {
  const { chart, index, datasetIndex } = timelinePopupState;
  const popup = document.getElementById('timelinePointPopup');
  if (!popup || popup.hidden || !chart || index === null || datasetIndex === null) return;

  const meta = chart.getDatasetMeta(datasetIndex);
  const point = meta && meta.data ? meta.data[index] : null;
  if (!point) return;

  const props = point.getProps(['x', 'y'], true);
  const canvasRect = chart.canvas.getBoundingClientRect();
  popup.style.left = `${canvasRect.left + props.x}px`;
  popup.style.top = `${canvasRect.top + props.y}px`;
}

function buildTimelinePopupRows(assignments) {
  if (!assignments.length) {
    return '<p class="timeline-popup-empty">No assignments were due on this date.</p>';
  }

  const grouped = {};
  assignments.forEach((asn) => {
    const key = asn.class || '';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(asn);
  });

  const groupKeys = Object.keys(grouped);
  const showClassHeaders = groupKeys.length > 1 || (groupKeys[0] && groupKeys[0] !== '');

  return groupKeys.map((className) => `
    <section class="timeline-popup-group">
      ${showClassHeaders && className ? `<div class="timeline-popup-class">${className}</div>` : ''}
      <ul class="timeline-popup-list">
        ${grouped[className].map((asn) => `
          <li class="timeline-popup-row ${assignmentRowClass(asn)}">
            <div class="timeline-popup-row-main">
              <span class="timeline-popup-asn">${asn.name}</span>
              <span class="timeline-popup-cat">${asn.category}</span>
            </div>
            <strong>${assignmentScoreLabel(asn)}</strong>
          </li>
        `).join('')}
      </ul>
    </section>
  `).join('');
}

function showTimelinePointPopup(chart, element) {
  const popup = document.getElementById('timelinePointPopup');
  if (!popup || !chart.$timelinePoints) return;

  const index = element.index;
  const datasetIndex = element.datasetIndex;
  let assignments = chart.$timelinePoints[index] || [];

  if (datasetIndex > 0 && chart.$classSeries && chart.$classSeries.length) {
    const classMeta = chart.$classSeries[datasetIndex - 1];
    if (classMeta) {
      assignments = assignments.filter((asn) => asn.classid === classMeta.classid);
    }
  }

  const dateLabel = chart.data.labels[index];
  const runningAverage = chart.data.datasets[datasetIndex].data[index];
  const seriesLabel = chart.data.datasets[datasetIndex].label;
  const avgText = runningAverage !== null && runningAverage !== undefined
    ? `${formatPct(runningAverage)} running avg`
    : 'Running average unavailable';

  popup.innerHTML = `
    <div class="timeline-point-popup-card">
      <div class="timeline-point-popup-arrow"></div>
      <header class="timeline-point-popup-head">
        <div>
          <strong>${formatTimelineDate(dateLabel)}</strong>
          <span>${seriesLabel} · ${avgText}</span>
        </div>
        <button type="button" class="timeline-point-popup-close" aria-label="Close">&times;</button>
      </header>
      <div class="timeline-point-popup-body">${buildTimelinePopupRows(assignments)}</div>
    </div>
  `;

  popup.hidden = false;
  popup.classList.add('is-visible');
  bindTimelinePopupReposition();
  timelinePopupState = { chart, index, datasetIndex };
  repositionTimelinePointPopup();

  popup.querySelector('.timeline-point-popup-close').addEventListener('click', (event) => {
    event.stopPropagation();
    hideTimelinePointPopup();
  });

}

function handleTimelinePointClick(event, elements, chart) {
  if (!elements.length) {
    hideTimelinePointPopup();
    return;
  }
  const element = elements[0];
  const samePoint = timelinePopupState.chart === chart
    && timelinePopupState.index === element.index
    && timelinePopupState.datasetIndex === element.datasetIndex;
  if (samePoint) {
    hideTimelinePointPopup();
    return;
  }
  showTimelinePointPopup(chart, element);
}

function makeLineChart(targetId, labels, datasets, options = {}) {
  const ctx = document.getElementById(targetId);
  const bounds = chartBounds(flattenDatasetValues(datasets));
  const chart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        filler: { propagate: true },
        legend: {
          display: options.legend !== false,
          position: 'bottom',
          onClick: (e, legendItem, legend) => {
            const index = legendItem.datasetIndex;
            const chart = legend.chart;
            const meta = chart.getDatasetMeta(index);
            meta.hidden = meta.hidden === null ? !chart.data.datasets[index].hidden : null;
            chart.update();
          },
        },
      },
      onClick: (event, _elements, chart) => {
        const hit = chart.getElementsAtEventForMode(event, 'nearest', { intersect: true }, false);
        handleTimelinePointClick(event, hit, chart);
        if (options.onClick) options.onClick(event, hit, chart);
      },
      onHover: options.onHover,
      scales: {
        y: {
          min: bounds.min,
          max: Math.max(bounds.max, 100),
          grid: { color: '#dbe3ee' },
        },
        x: {
          grid: { display: false },
          ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 },
        }
      }
    }
  });
  attachLineChartMeta(chart, {
    points: options.timelinePoints,
    classes: options.classSeries,
  });
  if (options.onLeave) {
    ctx.addEventListener('mouseleave', options.onLeave);
  }
  return chart;
}

function makeBarChart(targetId, labels, values, colors, horizontal = false, options = {}) {
  const ctx = document.getElementById(targetId);
  const bounds = chartBounds(values);
  return new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: colors,
        borderRadius: 6,
      }]
    },
    options: {
      indexAxis: horizontal ? 'y' : 'x',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      onClick: options.onClick,
      scales: horizontal ? {
        x: {
          min: bounds.min,
          max: bounds.max,
          grid: { color: '#dbe3ee' },
        },
        y: {
          grid: { display: false },
          ticks: { autoSkip: false },
        }
      } : {
        y: {
          min: bounds.min,
          max: bounds.max,
          grid: { color: '#dbe3ee' },
        },
        x: {
          grid: { display: false },
          ticks: { autoSkip: false, maxRotation: 45, minRotation: 0 },
        }
      }
    }
  });
}

function renderWatchlist() {
  const host = document.getElementById('watchlistGrid');
  if (!DATA.watchlist.length) {
    host.innerHTML = '<div class="empty">Nothing is on the watchlist right now.</div>';
    return;
  }
  host.innerHTML = DATA.watchlist.map((item) => `
    <div class="watch-card ${item.status}" data-jump-class="${item.classid}">
      <div class="watch-head">
        <div>
          <span class="watch-status ${item.status}">${item.status === 'attention' ? 'Needs attention' : 'Watch'}</span>
          <h3>${item.title}</h3>
          <div class="watch-subtitle">${item.subtitle}</div>
        </div>
        <div class="watch-grade ${toneClass(item.status)}">${formatPct(item.value)}</div>
      </div>
      <div class="watch-reason">${item.reason}</div>
      ${item.categories && item.categories.length ? `
        <div class="watch-links">
          ${item.categories.map((cat) => `
            <button type="button" class="watch-chip ${cat.status}" data-jump-class="${item.classid}" data-jump-category="${cat.name}">
              ${cat.name} · ${formatPct(cat.average)}
            </button>
          `).join('')}
        </div>
      ` : ''}
      <div class="watch-actions">
        <span class="meta-chip">Open gradebook</span>
        <button class="btn primary" type="button" data-jump-class="${item.classid}" data-jump-category="">Open</button>
      </div>
    </div>
  `).join('');
  host.querySelectorAll('.watch-card').forEach((card) => {
    card.addEventListener('click', () => jumpToClass(card.dataset.jumpClass, ''));
  });
  host.querySelectorAll('.watch-chip, .watch-actions .btn').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      jumpToClass(btn.dataset.jumpClass, btn.dataset.jumpCategory || '');
    });
  });
}

function renderAnalyticsLists() {
  const attentionHost = document.getElementById('attentionClassesList');
  if (!DATA.attention_summary.attention_classes.length) {
    attentionHost.innerHTML = '<div class="empty">No classes are below threshold right now.</div>';
  } else {
    attentionHost.innerHTML = DATA.attention_summary.attention_classes.map((item) => `
      <div class="watch-card ${item.status}" data-jump-class="${item.classid}">
        <div class="watch-head">
          <div>
            <span class="watch-status ${item.status}">Needs attention</span>
            <h3>${item.title}</h3>
            <div class="watch-subtitle">${item.category_count ? `${item.category_count} categories below threshold` : 'Class average below threshold'}</div>
          </div>
          <div class="watch-grade ${toneClass(item.status)}">${formatPct(item.value)}</div>
        </div>
        <div class="watch-reason">${item.reason}</div>
        ${item.categories && item.categories.length ? `
          <div class="watch-links">
            ${item.categories.map((cat) => `
              <button type="button" class="watch-chip ${cat.status}" data-jump-class="${item.classid}" data-jump-category="${cat.name}">
                ${cat.name} · ${formatPct(cat.average)}
              </button>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `).join('');
    attentionHost.querySelectorAll('[data-jump-class]').forEach((btn) => {
      btn.addEventListener('click', () => jumpToClass(btn.dataset.jumpClass, btn.dataset.jumpCategory || ''));
    });
  }

  renderRowList(
    'attentionCategoriesList',
    DATA.attention_summary.attention_categories.map((row) => ({
      classid: row.classid,
      title: row.name,
      subtitle: row.class_name,
      value: row.average,
      status: row.status,
      name: row.name,
    })),
    'No categories are below threshold right now.',
    'category'
  );

  renderRowList(
    'strongClassesList',
    DATA.attention_summary.strong_classes.map((item) => ({
      classid: item.classid,
      title: item.short_name,
      subtitle: item.strongest_category ? `Strongest: ${item.strongest_category.name}` : 'Consistent performance',
      value: item.term_grade,
      status: 'strong',
    })),
    'No strong classes are available yet.',
    'class'
  );
}

function updateQuarterView() {
  populateQuarterNav();
  const quarterData = DATA.analytics.quarterly.terms[String(selectedQuarter)] || DATA.analytics.quarterly.timeline;
  if (!chartRefs.quarterTimeline || !chartRefs.classAverage) return;

  chartRefs.quarterTimeline.data.labels = quarterData.labels || [];
  chartRefs.quarterTimeline.data.datasets = makeLineDatasets(quarterData, `Quarter ${selectedQuarter} average`);
  attachLineChartMeta(chartRefs.quarterTimeline, quarterData);
  chartRefs.quarterTimeline.update();

  const values = DATA.classes.map((item) => item.quarter_values[termLabel(selectedQuarter)]);
  chartRefs.classAverage.data.labels = DATA.classes.map((item) => item.short_name);
  chartRefs.classAverage.data.datasets[0].data = values;
  chartRefs.classAverage.data.datasets[0].backgroundColor = DATA.classes.map((item) => item.color);
  chartRefs.classAverage.options.onClick = (_, elements) => {
    if (!elements.length) return;
    const index = elements[0].index;
    const classid = DATA.analytics.quarterly.class_ids[index];
    if (classid) jumpToClass(classid);
  };
  chartRefs.classAverage.update();
  populateQuarterNav();
}

function refreshClassAnalytics() {
  const select = document.getElementById('analyticsClassSelect');
  const periodSelect = document.getElementById('analyticsPeriodSelect');
  const categorySelect = document.getElementById('analyticsCategorySelect');
  if (!select || !periodSelect || !categorySelect) return;

  activeClassId = select.value || activeClassId;
  selectedPeriod = periodSelect.value || selectedPeriod;
  const item = findClass(activeClassId) || DATA.classes[0];
  if (!item) return;
  renderClassInsightPanel(item);
  if (!chartRefs.classTimeline || !chartRefs.classCategory) return;

  const categories = categorySourceForClass(item).filter((cat) => cat.average !== null);
  if (selectedCategory !== 'all' && !categories.some((cat) => slug(cat.name) === selectedCategory)) {
    selectedCategory = 'all';
  }

  const categoryOptions = ['<option value="all">All categories</option>']
    .concat(categories.map((cat) => `<option value="${slug(cat.name)}">${cat.name}</option>`))
    .join('');
  categorySelect.innerHTML = categoryOptions;
  categorySelect.value = selectedCategory;

  const timeline = timelineSourceForClass(item);
  const timelineBounds = chartBounds(timeline.values || []);
  chartRefs.classTimeline.data.labels = timeline.labels || [];
  chartRefs.classTimeline.data.datasets[0].label = item.short_name;
  chartRefs.classTimeline.data.datasets[0].data = timeline.values || [];
  chartRefs.classTimeline.data.datasets[0].borderColor = item.color;
  chartRefs.classTimeline.data.datasets[0].backgroundColor = hexToRgba(item.color, 0.25);
  Object.assign(chartRefs.classTimeline.data.datasets[0], linePointStyle(item.color));
  chartRefs.classTimeline.options.scales.y.min = timelineBounds.min;
  chartRefs.classTimeline.options.scales.y.max = timelineBounds.max;
  attachLineChartMeta(chartRefs.classTimeline, { points: timeline.points, classes: [] });
  chartRefs.classTimeline.update();

  let visibleCategories = categories;
  if (selectedCategory !== 'all') {
    visibleCategories = categories.filter((cat) => slug(cat.name) === selectedCategory);
  }
  const categoryValues = visibleCategories.map((cat) => cat.average);
  const categoryBounds = chartBounds(categoryValues);
  chartRefs.classCategory.data.labels = visibleCategories.map((cat) => cat.name);
  chartRefs.classCategory.data.datasets[0].data = categoryValues;
  chartRefs.classCategory.data.datasets[0].backgroundColor = visibleCategories.map((cat) => {
    if (cat.status === 'attention') return '#b42318';
    if (cat.status === 'strong') return '#1d6b4a';
    return item.color;
  });
  chartRefs.classCategory.options.scales.x.min = categoryBounds.min;
  chartRefs.classCategory.options.scales.x.max = categoryBounds.max;
  chartRefs.classCategory.options.onClick = (_, elements) => {
    if (!elements.length) return;
    const index = elements[0].index;
    const categoryName = visibleCategories[index] ? visibleCategories[index].name : '';
    if (categoryName) jumpToClass(item.classid, categoryName);
  };
  chartRefs.classCategory.update();
  populateQuarterNav();
}

function initCharts() {
  if (chartsReady || typeof Chart === 'undefined') return;
  chartsReady = true;
  Chart.defaults.color = '#445266';
  Chart.defaults.font.family = '"Segoe UI", Tahoma, sans-serif';

  const yearly = DATA.analytics.yearly.timeline;
  chartRefs.yearTimeline = makeLineChart(
    'yearTimelineChart',
    yearly.labels,
    makeLineDatasets(yearly, 'Average across classes'),
    {
      timelinePoints: yearly.points,
      classSeries: yearly.classes,
      onHover: (_, elements, chart) => {
        if (!elements.length) return;
        const index = elements[0].index;
        if (index === yearGaugeHoverIndex) return;
        yearGaugeHoverIndex = index;
        const label = chart.data.labels[index];
        const value = chart.data.datasets[0].data[index];
        updateYearHoverGauge(value, label);
      },
      onLeave: () => resetYearHoverGauge(true),
    }
  );

  chartRefs.quarterSummary = makeBarChart(
    'quarterSummaryChart',
    DATA.analytics.yearly.quarter_labels,
    DATA.analytics.yearly.quarter_values,
    DATA.analytics.yearly.quarter_values.map((value) => value !== null && value < THRESHOLD ? '#b42318' : '#204f9e'),
    false,
    {
      onClick: (_, elements) => {
        if (!elements.length) return;
        const index = elements[0].index;
        const term = String(index + 1);
        selectedQuarter = term;
        showSection('analytics');
        showView('quarterly', term);
      },
    }
  );

  const initialQuarter = DATA.analytics.quarterly.terms[String(selectedQuarter)] || DATA.analytics.quarterly.timeline;
  chartRefs.quarterTimeline = makeLineChart(
    'quarterTimelineChart',
    initialQuarter.labels || [],
    makeLineDatasets(initialQuarter, `Quarter ${selectedQuarter} average`),
    {
      timelinePoints: initialQuarter.points,
      classSeries: initialQuarter.classes,
    }
  );

  chartRefs.classAverage = makeBarChart(
    'classAverageChart',
    DATA.classes.map((item) => item.short_name),
    DATA.classes.map((item) => item.quarter_values[termLabel(selectedQuarter)]),
    DATA.classes.map((item) => item.color),
    true,
    {
      onClick: (_, elements) => {
        if (!elements.length) return;
        const index = elements[0].index;
        const classid = DATA.analytics.quarterly.class_ids[index];
        if (classid) jumpToClass(classid);
      },
    }
  );

  updateQuarterView();

  chartRefs.classTimeline = makeLineChart('classTimelineChart', [], [{
    label: '',
    data: [],
    borderColor: '#204f9e',
    backgroundColor: hexToRgba('#204f9e', 0.25),
    fill: true,
    tension: 0.2,
    borderWidth: 3,
    ...linePointStyle('#204f9e'),
  }]);

  chartRefs.classCategory = makeBarChart('classCategoryChart', [], [], [], true);
  renderClassAnalyticsControls();
  refreshClassAnalytics();
  ensureYearHoverGaugeShell();
  resetYearHoverGauge(false);
}

function bindEvents() {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => showSection(btn.dataset.section));
  });
  const sidebarToggle = document.getElementById('sidebarToggle');
  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', () => {
      const collapsed = document.body.classList.toggle('sidebar-collapsed');
      sidebarToggle.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
      sidebarToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });
  }
  document.querySelectorAll('.subtab').forEach((btn) => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });
  
  document.getElementById('gradesSearchInput').addEventListener('input', renderClassList);
  
  document.getElementById('analyticsClassSelect').addEventListener('change', () => {
    activeClassId = document.getElementById('analyticsClassSelect').value;
    renderClassAnalyticsControls();
    refreshClassAnalytics();
  });
  document.getElementById('analyticsPeriodSelect').addEventListener('change', () => {
    selectedPeriod = document.getElementById('analyticsPeriodSelect').value;
    renderClassAnalyticsControls();
    refreshClassAnalytics();
  });
  document.getElementById('analyticsCategorySelect').addEventListener('change', () => {
    selectedCategory = document.getElementById('analyticsCategorySelect').value;
    refreshClassAnalytics();
  });

  document.addEventListener('click', (event) => {
    const popup = document.getElementById('timelinePointPopup');
    if (!popup || popup.hidden) return;
    if (popup.contains(event.target)) return;
    if (event.target.closest('canvas')) return;
    hideTimelinePointPopup();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideTimelinePointPopup();
  });
}

renderStats();
renderDashboardHighlights();
renderYearlyNotes();
populateQuarterNav();
renderAnalyticsLists();
renderWatchlist();
bindEvents();
renderClassList();
showSection('dashboard');
</script>
</body>
</html>
"""
    normalized = template.replace("__PAYLOAD_JSON__", json.dumps(payload))
    normalized = normalized.replace("__SECTION_IDS__", json.dumps(list(SECTION_IDS)))
    normalized = normalized.replace("__META_YEAR__", esc(payload["meta"]["year"]))
    normalized = normalized.replace("__META_TERM__", esc(payload["meta"]["term"]))
    normalized = normalized.replace("__META_UPDATED__", esc(payload["meta"]["updated"]))
    normalized = normalized.replace("__META_THRESHOLD__", f"{payload['meta']['threshold']:.0f}")
    return normalized


def build(json_path=GRADES_JSON_PATH, history_path=GRADES_HISTORY_PATH, html_path=None):
    target_html = html_path or derive_output_path(GRADES_DASHBOARD_PATH)
    model = build_dashboard_model(json_path, history_path)
    payload = build_payload(model)
    html_out = build_html(payload)
    target_dir = os.path.dirname(os.path.abspath(target_html))
    if target_dir:
        os.makedirs(target_dir, exist_ok=True)
    with open(target_html, "w", encoding="utf-8") as handle:
        handle.write(html_out)
    print(f"Dashboard 2.0 written to {target_html}")


def parse_args():
    parser = argparse.ArgumentParser(description="Build the single-file Grades Dashboard 2.0")
    parser.add_argument("--live", default=GRADES_JSON_PATH, help="Path to live grades JSON")
    parser.add_argument("--history", default=GRADES_HISTORY_PATH, help="Path to grade history JSON")
    parser.add_argument(
        "--html",
        default=derive_output_path(GRADES_DASHBOARD_PATH),
        help="Output HTML path for the new dashboard",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    build(json_path=args.live, history_path=args.history, html_path=args.html)

