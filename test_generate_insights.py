#!/usr/bin/env python3
import json
import shutil

from ai_insights import INSIGHTS_PATH, _read_saved, _save, get_or_generate
from compute_bridge import compute_derived_data, normalize_grades_data
from grades_config import GRADES_HISTORY_PATH, GRADES_JSON_PATH, load_settings

saved = _read_saved()
if saved:
    backup = INSIGHTS_PATH.replace(".json", ".backup.json")
    shutil.copy(INSIGHTS_PATH, backup)
    print("Backed up ai_insights.json ->", backup)
    saved.clear()
    _save(saved)
    print("Cleared daily gate so regeneration is allowed.")

raw = json.load(open(GRADES_JSON_PATH))
history = json.load(open(GRADES_HISTORY_PATH))
settings = load_settings()
normalized = normalize_grades_data(raw, history)
computed = compute_derived_data(
    normalized,
    goal=int(settings.get("goal") or 90),
    tracked_class_ids=set(settings.get("trackedClassIds") or []) or None,
    per_class_goals=settings.get("perClassGoals") or {},
)
res = get_or_generate(computed, settings)
print("\nstatus:", res.get("status"))
for i in res.get("insights", []):
    print("-", i["classId"], "|", i["icon"], "|", i["title"])
    print("   ", i["body"][:400])
