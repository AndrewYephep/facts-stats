#!/usr/bin/env python3
"""End-to-end test of the post-scrape pipeline without opening a browser.

Injects one fake assignment per class into the live grades_data.json, then runs
the exact same steps sis_login.py runs after a scrape: build_grade_changes,
_new_grades marker persistence, dashboard model, AI insights, and SMTP email.
"""
import copy
import json
import os
import sys

from grades_config import CURRENT_TERM, GRADES_HISTORY_PATH, GRADES_JSON_PATH, load_settings

FAKES = {
    "6608": {"category": "Homework", "name": "Worldview Essay 1", "pts": "18", "max": "20", "due": "9/8"},
    "6433": {"category": "Quizzes", "name": "Quiz 1: Lab Safety", "pts": "8", "max": "10", "due": "9/9"},
    "6513": {"category": "Participation", "name": "Rehearsal Participation", "pts": "20", "max": "20", "due": "9/10"},
    "6539": {"category": "Tests", "name": "Test 1: Lit Devices", "pts": "44", "max": "50", "due": "9/11"},
    "6445": {"category": "Music returned", "name": "Signed Slip 1", "pts": "3", "max": "3", "due": "9/12"},
    "6551": {"category": "Homework", "name": "Ministry Reflection 1", "pts": "27", "max": "30", "due": "9/13"},
    "6554": {"category": "Homework", "name": "HW 1.1 Limits", "pts": "12", "max": "15", "due": "9/14"},
    "6556": {"category": "Homework", "name": "College Essay Draft", "pts": "38", "max": "40", "due": "9/15"},
    "6557": {"category": "Project", "name": "Safety Project", "pts": "85", "max": "100", "due": "9/16"},
    "6440": {"category": "Homework", "name": "Constitution Notes", "pts": "17", "max": "20", "due": "9/17"},
}


def main():
    with open(GRADES_JSON_PATH, encoding="utf-8") as handle:
        result = json.load(handle)

    # Make the script idempotent: strip any previously injected fakes so a
    # re-run still diff-s against the true pre-fake state.
    fake_names = {fake["name"] for fake in FAKES.values()}
    stripped = 0
    for info in (result.get("classes") or {}).values():
        for q in (info.get("quarters") or {}).values():
            for cat in q.get("categories") or []:
                kept = [a for a in cat.get("assignments") or [] if a.get("name") not in fake_names]
                if len(kept) != len(cat.get("assignments") or []):
                    stripped += len(cat.get("assignments") or []) - len(kept)
                    cat["assignments"] = kept
    if stripped:
        print(f"Stripped {stripped} previously injected fake assignments.")
        with open(GRADES_JSON_PATH, "w", encoding="utf-8") as handle:
            json.dump(result, handle, indent=2)

    backup_path = os.path.join(os.path.dirname(GRADES_JSON_PATH), "data", "pre-fake-test-backup.json")
    os.makedirs(os.path.dirname(backup_path), exist_ok=True)
    with open(backup_path, "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=2)
    print("Backed up grades_data.json ->", backup_path)

    prior_live = copy.deepcopy(result)

    injected = 0
    for class_id, fake in FAKES.items():
        info = result.get("classes", {}).get(class_id)
        if not info:
            print("  !! class not found:", class_id)
            continue
        quarters = info.setdefault("quarters", {})
        term_data = quarters.setdefault(str(CURRENT_TERM), {})
        categories = term_data.setdefault("categories", [])
        category = next((c for c in categories if c.get("name") == fake["category"]), None)
        if category is None:
            categories.append({"name": fake["category"], "weight": "100.0", "assignments": [], "average": None})
            category = categories[-1]
        assignments = category.setdefault("assignments", [])
        percent = round(float(fake["pts"]) / float(fake["max"]) * 100, 1)
        assignments.append({
            "name": fake["name"],
            "pts": fake["pts"],
            "max": fake["max"],
            "avg": f"{percent}%",
            "status": "Valid",
            "due": fake["due"],
        })
        injected += 1
        print(f"  injected -> {info.get('class_name')} / {fake['category']} / {fake['name']} ({fake['pts']}/{fake['max']})")

    from datetime import datetime
    result["updated"] = datetime.now().isoformat(timespec="seconds")
    with open(GRADES_JSON_PATH, "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=2)
    print(f"Saved grades_data.json with {injected} fake assignments.")

    from grades_emailer import build_grade_changes, send_grade_email
    from sis_login import _write_new_grades_marker

    changes = build_grade_changes(prior_live, result, CURRENT_TERM)
    print("\n=== GRADE CHANGES ===")
    print("new:", len(changes["new_grades"]), "| updated:", len(changes["updated_grades"]))
    for g in changes["new_grades"]:
        c = g["current"]
        print(f"  NEW {c['class_name']:55s} | {c['category']:16s} | {c['assignment']:24s} | {c['pts']}/{c['max']} = {c['percent']}%")
    for g in changes["updated_grades"]:
        c = g["current"]
        print(f"  UPD {c['class_name']} | {c['category']} | {c['assignment']} | {c['pts']}/{c['max']} = {c['percent']}%")

    _write_new_grades_marker(changes)

    from grades_analytics import build_dashboard_model
    model = build_dashboard_model(GRADES_JSON_PATH, GRADES_HISTORY_PATH)
    watchlist = model.get("watchlist", [])
    print("\nwatchlist classes:", [(w.get("className") or w.get("class_name")) for w in watchlist])

    ai_status = "skipped (no changes)"
    if changes["new_grades"] or changes["updated_grades"]:
        from ai_insights import get_or_generate
        from compute_bridge import compute_derived_data, normalize_grades_data

        settings = load_settings()
        with open(GRADES_HISTORY_PATH, encoding="utf-8") as handle:
            history = json.load(handle)
        normalized = normalize_grades_data(result, history)
        computed = compute_derived_data(
            normalized,
            goal=int(settings.get("goal") or 90),
            tracked_class_ids=set(settings.get("trackedClassIds") or []) or None,
            per_class_goals=settings.get("perClassGoals") or {},
        )
        try:
            ai_result = get_or_generate(computed, settings)
            ai_status = ai_result.get("status")
        except Exception as exc:
            ai_status = f"failed: {exc}"
    print("AI insights status:", ai_status)

    print("\n=== SENDING EMAIL ===")
    if "--no-email" in sys.argv:
        print("Email skipped (--no-email).")
        sent = None
    else:
        sent = send_grade_email(
            changes,
            watchlist,
            {
                "updated": result.get("updated"),
                "academic_year": result.get("academic_year"),
                "term": result.get("current_term"),
            },
        )
    print("Email result:", "SENT" if sent else "FAILED/NOT SENT")

    marker_path = os.path.join(os.path.dirname(GRADES_JSON_PATH), "data", "new_grades.json")
    with open(marker_path, encoding="utf-8") as handle:
        marker = json.load(handle)
    print(f"\nMarker file ({marker_path}): {len(marker['new'])} new / {len(marker['updated'])} updated, savedAt={marker.get('savedAt')}")


if __name__ == "__main__":
    main()
