#!/usr/bin/env python3
import json

from compute_bridge import compute_derived_data, normalize_grades_data
from grades_config import GRADES_HISTORY_PATH, GRADES_JSON_PATH, load_settings
from ai_insights import _class_payload

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
classes = _class_payload(computed, settings.get("perClassGoals") or {})
for c in classes:
    gm = c["gradeMath"]
    lines = [f"{c['name']} | overall={gm['overall']} gap={gm['gap']} goal={gm['goal']}"]
    for x in gm["categories"]:
        lines.append(
            f"   {x['name']}: avg={x['average']} w={x['weight']} n={x['gradedCount']} "
            f"impact/pt={x['impactPerOverallPoint']} | 2x100 -> cat={x['categoryAfterTwoPerfects']} overall={x['overallAfterTwoPerfects']} "
            f"| need-for-goal={x['categoryAverageNeededForGoal']}"
        )
    print("\n".join(lines))
