"""Grade analytics: merge data, watchlist, threshold flags, chart payloads."""

import json
import os
import re

from grades_config import (
    ACADEMIC_YEAR,
    ATTENTION_PERCENT_THRESHOLD,
    CURRENT_TERM,
    GRADES_HISTORY_PATH,
    GRADES_JSON_PATH,
    WATCHLIST_BOTTOM_CATEGORIES,
    should_skip_class,
)


def parse_number(value):
    if value is None:
        return None
    m = re.search(r"-?\d+(?:\.\d+)?", str(value).strip())
    return float(m.group()) if m else None


def assignment_percent(assignment):
    pts = parse_number(assignment.get("pts"))
    mx = parse_number(assignment.get("max"))
    if pts is None or not mx:
        return None
    return round(pts / mx * 100, 1)


def below_threshold(value):
    return value is not None and value < ATTENTION_PERCENT_THRESHOLD


def load_json(path, default):
    if not os.path.isfile(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def load_history(path=GRADES_HISTORY_PATH):
    return load_json(path, {})


def load_live(path=GRADES_JSON_PATH):
    return load_json(path, {})


def normalize_live(data):
    if not data:
        return data
    if "classes" in data:
        return data
    year = data.get("academic_year", ACADEMIC_YEAR)
    term = str(data.get("current_term", CURRENT_TERM))
    classes = {}
    for cid, block in (data.get("grades_by_class") or {}).items():
        classes[cid] = {
            "class_name": block.get("class_name", ""),
            "quarters": {term: _quarter_slice(block)},
        }
    data["classes"] = classes
    return data


def _quarter_slice(block):
    return {
        "term_grade": block.get("term_grade"),
        "term_letter": block.get("term_letter"),
        "categories": block.get("categories", []),
    }


def short_name(class_name):
    return (class_name or "").split("(")[0].strip()


def merge_class_quarters(live, history, year=None):
    year = year or live.get("academic_year", ACADEMIC_YEAR)
    live = normalize_live(live)
    hist_year = (history or {}).get(year, {})

    merged = {}
    for cid, info in (live.get("classes") or {}).items():
        name = info.get("class_name", "")
        if should_skip_class(cid, name):
            continue
        merged[cid] = {"class_name": name, "quarters": dict(info.get("quarters") or {})}

    for term_key, term_classes in hist_year.items():
        for cid, block in (term_classes or {}).items():
            name = block.get("class_name", "")
            if should_skip_class(cid, name):
                continue
            if cid not in merged:
                merged[cid] = {"class_name": name, "quarters": {}}
            if term_key not in merged[cid]["quarters"]:
                merged[cid]["quarters"][str(term_key)] = _quarter_slice(block)

    return merged, year


def quarter_numeric_average(merged, term):
    grades = []
    for info in merged.values():
        q = (info.get("quarters") or {}).get(str(term), {})
        n = parse_number(q.get("term_grade"))
        if n is not None:
            grades.append(n)
    if not grades:
        return None
    return round(sum(grades) / len(grades), 1)


def year_numeric_average(merged):
    per_class = []
    for info in merged.values():
        nums = []
        for q in sorted((info.get("quarters") or {}).keys(), key=int):
            n = parse_number(info["quarters"][q].get("term_grade"))
            if n is not None:
                nums.append(n)
        if nums:
            per_class.append(sum(nums) / len(nums))
    if not per_class:
        return None
    return round(sum(per_class) / len(per_class), 1)


def _class_entries(merged, term):
    entries = []
    for classid, info in merged.items():
        q = (info.get("quarters") or {}).get(str(term), {})
        val = parse_number(q.get("term_grade"))
        if val is None:
            continue
        entries.append({
            "classid": classid,
            "class_name": info.get("class_name", ""),
            "short_name": short_name(info.get("class_name", "")),
            "value": val,
            "letter": q.get("term_letter"),
        })
    return entries


def _category_entries(merged, term):
    entries = []
    for classid, info in merged.items():
        q = (info.get("quarters") or {}).get(str(term), {})
        cname = info.get("class_name", "")
        for cat in q.get("categories") or []:
            val = parse_number(cat.get("average"))
            if val is None:
                continue
            cat_name = cat.get("name", "Category")
            entries.append({
                "classid": classid,
                "class_name": cname,
                "short_name": short_name(cname),
                "category": cat_name,
                "category_key": f"{classid}:{cat_name.lower()}",
                "value": val,
            })
    return entries


def build_watchlist(merged, term=None):
    """Lowest class + bottom N categories (always), regardless of threshold."""
    term = str(term or CURRENT_TERM)
    watchlist = []

    classes = sorted(_class_entries(merged, term), key=lambda x: x["value"])
    if classes:
        low = classes[0]
        watchlist.append({
            "kind": "lowest_class",
            "classid": low["classid"],
            "class_name": low["class_name"],
            "short_name": low["short_name"],
            "label": f"Lowest class · {low['short_name']}",
            "value": low["value"],
            "below_threshold": below_threshold(low["value"]),
        })

    cats = sorted(_category_entries(merged, term), key=lambda x: x["value"])
    for i, cat in enumerate(cats[:WATCHLIST_BOTTOM_CATEGORIES]):
        watchlist.append({
            "kind": "low_category",
            "rank": i + 1,
            "classid": cat["classid"],
            "class_name": cat["class_name"],
            "short_name": cat["short_name"],
            "category": cat["category"],
            "category_key": cat["category_key"],
            "label": f"{cat['category']} · {cat['short_name']}",
            "value": cat["value"],
            "below_threshold": below_threshold(cat["value"]),
        })

    return watchlist


def build_style_flags(merged, term=None):
    """
    Rendering flags — red only below threshold; orange for watchlist lows above threshold.
    """
    term = str(term or CURRENT_TERM)
    flags = {
        "classes_below": set(),
        "classes_watch": set(),
        "categories_below": set(),
        "categories_watch": set(),
    }

    watchlist = build_watchlist(merged, term)
    for item in watchlist:
        if item["kind"] == "lowest_class":
            if item["below_threshold"]:
                flags["classes_below"].add(item["classid"])
            else:
                flags["classes_watch"].add(item["classid"])
        elif item["kind"] == "low_category":
            key = item["category_key"]
            if item["below_threshold"]:
                flags["categories_below"].add(key)
            else:
                flags["categories_watch"].add(key)

    for classid, info in merged.items():
        q = (info.get("quarters") or {}).get(str(term), {})
        tg = parse_number(q.get("term_grade"))
        if below_threshold(tg):
            flags["classes_below"].add(classid)
        for cat in q.get("categories") or []:
            avg = parse_number(cat.get("average"))
            key = f"{classid}:{cat.get('name', '').lower()}"
            if below_threshold(avg):
                flags["categories_below"].add(key)

    return flags


def collect_below_threshold(merged, term=None):
    """Items strictly under ATTENTION_PERCENT_THRESHOLD only."""
    term = str(term or CURRENT_TERM)
    items = []

    for classid, info in merged.items():
        cname = info.get("class_name", "Unknown")
        short = short_name(cname)
        q = (info.get("quarters") or {}).get(term, {})
        tg = parse_number(q.get("term_grade"))

        if below_threshold(tg):
            items.append({
                "kind": "class",
                "classid": classid,
                "class_name": cname,
                "short_name": short,
                "label": f"Class average {tg}%",
                "value": tg,
            })

        for cat in q.get("categories") or []:
            cat_name = cat.get("name", "Category")
            avg = parse_number(cat.get("average"))
            if below_threshold(avg):
                items.append({
                    "kind": "category",
                    "classid": classid,
                    "class_name": cname,
                    "short_name": short,
                    "category": cat_name,
                    "category_key": f"{classid}:{cat_name.lower()}",
                    "label": f"{cat_name} · {avg}%",
                    "value": avg,
                })

            for asn in cat.get("assignments") or []:
                pct = assignment_percent(asn)
                if below_threshold(pct):
                    items.append({
                        "kind": "assignment",
                        "classid": classid,
                        "class_name": cname,
                        "short_name": short,
                        "category": cat_name,
                        "category_key": f"{classid}:{cat_name.lower()}",
                        "assignment": asn.get("name", ""),
                        "label": f"{asn.get('name', '')} · {pct}%",
                        "value": pct,
                    })

    items.sort(key=lambda x: x.get("value", 0))
    return items


def build_chart_data(merged, model, term=None):
    term = str(term or CURRENT_TERM)
    class_entries = sorted(_class_entries(merged, term), key=lambda x: x["value"])
    cat_entries = sorted(_category_entries(merged, term), key=lambda x: x["value"])

    return {
        "threshold": ATTENTION_PERCENT_THRESHOLD,
        "class_grades": {
            "labels": [e["short_name"] for e in class_entries],
            "values": [e["value"] for e in class_entries],
            "colors": [
                "#e85d5d" if below_threshold(e["value"])
                else "#e8a84a" if e["classid"] in {
                    w["classid"] for w in model["watchlist"] if w["kind"] == "lowest_class"
                } and not below_threshold(e["value"])
                else "#6b9fd4"
                for e in class_entries
            ],
        },
        "quarter_trend": {
            "labels": [f"Q{t}" for t in range(1, 5)],
            "values": [model["quarter_avgs"].get(str(t)) for t in range(1, 5)],
        },
        "category_grades": {
            "labels": [f"{e['category']} ({e['short_name']})" for e in cat_entries],
            "values": [e["value"] for e in cat_entries],
        },
        "category_by_name": _aggregate_category_names(cat_entries),
        "below_by_class": _below_count_by_class(merged, term),
    }


def _aggregate_category_names(cat_entries):
    buckets = {}
    for e in cat_entries:
        name = e["category"].lower()
        buckets.setdefault(name, []).append(e["value"])
    names = sorted(buckets.keys(), key=lambda n: sum(buckets[n]) / len(buckets[n]))
    return {
        "labels": [n.title() for n in names],
        "values": [round(sum(buckets[n]) / len(buckets[n]), 1) for n in names],
    }


def _below_count_by_class(merged, term):
    labels, values = [], []
    for classid, info in merged.items():
        q = (info.get("quarters") or {}).get(str(term), {})
        count = 0
        for cat in q.get("categories") or []:
            if below_threshold(parse_number(cat.get("average"))):
                count += 1
            for asn in cat.get("assignments") or []:
                if below_threshold(assignment_percent(asn)):
                    count += 1
        if count:
            labels.append(short_name(info.get("class_name", "")))
            values.append(count)
    return {"labels": labels, "values": values}


def build_dashboard_model(live_path=GRADES_JSON_PATH, history_path=GRADES_HISTORY_PATH):
    live = load_live(live_path)
    history = load_history(history_path)
    live = normalize_live(live)
    merged, year = merge_class_quarters(live, history)
    current_term = str(live.get("current_term", CURRENT_TERM))

    model = {
        "updated": live.get("updated"),
        "academic_year": year,
        "current_term": current_term,
        "threshold": ATTENTION_PERCENT_THRESHOLD,
        "merged": merged,
        "quarter_avg": quarter_numeric_average(merged, current_term),
        "year_avg": year_numeric_average(merged),
        "quarter_avgs": {str(t): quarter_numeric_average(merged, t) for t in range(1, 5)},
        "watchlist": build_watchlist(merged, current_term),
        "below_threshold": collect_below_threshold(merged, current_term),
        "flags": build_style_flags(merged, current_term),
    }
    model["charts"] = build_chart_data(merged, model, current_term)
    return model
